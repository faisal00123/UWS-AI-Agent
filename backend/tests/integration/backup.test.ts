/**
 * Phase 9 integration tests: verified backups, encryption, retention,
 * restore tests (including a corrupted backup), the backup/restore jobs,
 * the owner-only monitoring routes and the restore helpers.
 *
 * Determinism / isolation rules:
 *  - every test uses an in-memory (or explicit temp-file) database and its
 *    own mkdtemp backup directory, removed afterwards - nothing is written
 *    into the project tree and no test can touch another's files
 *  - backups are pointed at the temp dir via BACKUP_DIR; the live database
 *    path is only used by the applyRestore test (also inside mkdtemp)
 *  - a failed restore test is provoked by CORRUPTING a real backup file, so
 *    the failure path is exercised end to end without stubbing internals
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { nowIso } from '../../src/core/time.ts';
import { newId } from '../../src/core/ids.ts';
import { AppError } from '../../src/core/errors.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { createUser } from '../../src/domain/auth/service.ts';
import { summarise } from '../../src/domain/state/service.ts';
import {
  latestRestoreTest,
  listBackups,
  pruneBackups,
  runBackup,
  runRestoreTest,
  verifyBackupFile,
} from '../../src/domain/backup/service.ts';
import {
  applyRestore,
  applyRestoredSuppressions,
  capturePostBackupSuppressions,
  probeExclusiveAccess,
  restoreBackupTo,
} from '../../src/domain/backup/restore.ts';
import { decryptBuffer } from '../../src/domain/backup/crypto.ts';
import { backupJob, restoreTestJob } from '../../src/jobs/backup.ts';
import type { JobContext } from '../../src/jobs/scheduler.ts';
import {
  TEST_ENV,
  loginAs,
  seedOwner,
  startTestServer,
  type TestServer,
} from '../helpers/app.ts';

const owner = { userId: null, label: 'owner' as const };

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uws-backup-'));
  tempDirs.push(dir);
  return dir;
}

function cfgWith(dir: string, extra: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...TEST_ENV, BACKUP_ENABLED: 'true', BACKUP_DIR: dir, ...extra });
}

function freshDb(cfg: Config): DB {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

async function seedOwnerIn(db: DB, cfg: Config): Promise<void> {
  await createUser(
    db,
    cfg,
    { email: `owner-${newId('u')}@uws.test`, password: 'Owner-Password-123!', displayName: 'Owner', role: 'owner' },
    { userId: null, label: 'system' },
  );
}

let phoneSeq = 0;
function addLead(db: DB, name: string): string {
  phoneSeq += 1;
  return createLead(db, { displayName: name, city: 'Karachi', phone: `+9230077${String(phoneSeq).padStart(5, '0')}` }, owner).id;
}

function addSuppression(db: DB, bizId: string | null, at = nowIso(), reason = 'opt_out'): string {
  const id = newId('sup');
  db.prepare(
    `INSERT INTO suppression_list (id, business_id, scope, phone_e164, whatsapp_e164, email,
       reason, source, evidence, permanent, created_by, created_at)
     VALUES (?, ?, 'business', NULL, NULL, NULL, ?, 'manual', NULL, 1, NULL, ?)`,
  ).run(id, bizId, reason, at);
  return id;
}

function notificationsOf(db: DB, kind: string): { id: string; severity: string; title: string }[] {
  return db
    .prepare('SELECT id, severity, title FROM notifications WHERE kind = ? ORDER BY created_at')
    .all(kind) as unknown as { id: string; severity: string; title: string }[];
}

function ctxFor(db: DB, cfg: Config): JobContext {
  return { db, config: cfg, logger: nullLogger, guard: summarise(db), now: new Date() };
}

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

after(() => {
  for (const dir of tempDirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
});

// ===================================================================== 1. ===
describe('runBackup', () => {
  test('a verified backup snapshots the data, hashes the file and records a manifest', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    const bizId = addLead(db, 'Alpha Traders');
    addSuppression(db, bizId);

    const record = await runBackup(db, cfg, { actor: owner });

    assert.equal(record.status, 'verified');
    assert.equal(record.encrypted, false);
    assert.ok(record.sizeBytes && record.sizeBytes > 0);
    assert.ok(existsSync(record.path), 'backup file exists on disk');
    assert.ok(record.path.startsWith(dir), 'file lives in the configured backup dir');

    // sha256 matches the bytes on disk.
    assert.equal(record.sha256, sha256(readFileSync(record.path)));

    // The manifest captures the snapshot's table counts...
    const counts = record.verifyResult?.counts ?? {};
    assert.equal(counts.businesses, 1);
    assert.equal(counts.suppression_list, 1);
    assert.ok((counts.users ?? 0) >= 1, 'owner is in the snapshot');
    // ...and every check passed.
    assert.ok(record.verifyResult?.ok);
    assert.ok(record.verifyResult?.checks.every((c) => c.passed));

    // The snapshot itself is readable and contains the lead.
    const snap = new DatabaseSync(record.path, { readOnly: true, enableForeignKeyConstraints: false });
    try {
      const row = snap.prepare('SELECT COUNT(*) c FROM businesses').get() as { c: number };
      assert.equal(row.c, 1);
    } finally {
      snap.close();
    }

    // Audit trail records the creation.
    const audit = db
      .prepare(`SELECT 1 FROM audit_events WHERE action = 'backup.created' AND entity_id = ?`)
      .get(record.id);
    assert.ok(audit, 'backup.created audit row exists');

    db.close();
  });

  test('with a passphrase the stored file is AES-encrypted and useless without it', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir, { BACKUP_PASSPHRASE: 'test-pass-phrase-42' });
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    addLead(db, 'SECRET_MARKER_LEAD');

    const record = await runBackup(db, cfg, { actor: owner });
    assert.equal(record.status, 'verified');
    assert.equal(record.encrypted, true);
    assert.ok(record.path.endsWith('.enc'), 'encrypted backups get the .enc suffix');

    // The stored bytes must not contain the plaintext marker...
    const raw = readFileSync(record.path);
    assert.equal(raw.includes(Buffer.from('SECRET_MARKER_LEAD', 'utf8')), false, 'no plaintext in stored file');
    // ...and the marker reappears only after decryption.
    const plain = decryptBuffer(raw, 'test-pass-phrase-42');
    assert.ok(plain.includes(Buffer.from('SECRET_MARKER_LEAD', 'utf8')));

    // Verification succeeds only with the right passphrase.
    assert.equal(verifyBackupFile(record.path, { passphrase: 'test-pass-phrase-42' }).ok, true);
    const wrong = verifyBackupFile(record.path, { passphrase: 'wrong-passphrase' });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.checks.find((c) => c.code === 'encryption')?.passed, false);

    db.close();
  });

  test('a failure is recorded on the row, notified and rethrown', async () => {
    const dir = tmpDir();
    // A FILE where the backup directory should be -> mkdirSync fails inside
    // the guarded section, after the running row exists.
    const blocked = join(dir, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const cfg = cfgWith(join(blocked, 'backups'));
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);

    await assert.rejects(() => runBackup(db, cfg, { actor: owner }));

    const row = db.prepare('SELECT status, error FROM backups').get() as { status: string; error: string };
    assert.equal(row.status, 'failed');
    assert.ok(row.error && row.error.length > 0, 'failure reason recorded');

    const notes = notificationsOf(db, 'backup');
    assert.equal(notes.length, 1);
    assert.equal(notes[0]!.severity, 'critical');

    const audit = db.prepare(`SELECT 1 FROM audit_events WHERE action = 'backup.failed'`).get();
    assert.ok(audit, 'backup.failed audit row exists');

    // A second failure the same day (the job retries hourly): a second failed
    // ROW and audit event are recorded, but the alert is throttled to one per
    // day so a persistently broken backup cannot spam the owner.
    await assert.rejects(() => runBackup(db, cfg, { actor: owner }));
    const rows = db.prepare('SELECT COUNT(*) c FROM backups WHERE status = ?').get('failed') as { c: number };
    assert.equal(rows.c, 2, 'every failed attempt is recorded');
    const audits = db
      .prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'backup.failed'`)
      .get() as { c: number };
    assert.equal(audits.c, 2, 'every failed attempt is audited');
    assert.equal(notificationsOf(db, 'backup').length, 1, 'alert deduped for the day');

    db.close();
  });
});

// ===================================================================== 2. ===
describe('retention', () => {
  test('prunes backups older than the window but never the newest', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir); // retention 30 days default
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);

    // Two old backups with files on disk (well past the 30-day window).
    const oldStamp = '2026-01-01T00:00:00.000Z';
    for (const key of ['old1', 'old2']) {
      const path = join(dir, `uws-old-${key}.sqlite`);
      writeFileSync(path, 'placeholder');
      db.prepare(
        `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, error, retention_until, created_at, verified_at)
         VALUES (?, ?, 11, 'x', 0, 'verified', NULL, ?, ?, ?)`,
      ).run(`bkp_${key}`, path, oldStamp, oldStamp, oldStamp);
    }
    // A restore test attached to an old backup (must cascade away with it).
    db.prepare(
      `INSERT INTO restore_tests (id, backup_id, started_at, status, checks_json, performed_by)
       VALUES ('rtst_old', 'bkp_old1', ?, 'passed', '[]', NULL)`,
    ).run(oldStamp);

    // The NEWEST backup is also past the window - it must still survive
    // (deleting the only remaining copy would be indefensible).
    const newestPath = join(dir, 'uws-old-newest.sqlite');
    writeFileSync(newestPath, 'placeholder');
    db.prepare(
      `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, error, retention_until, created_at, verified_at)
       VALUES ('bkp_newest', ?, 11, 'x', 0, 'verified', NULL, ?, ?, ?)`,
    ).run(newestPath, oldStamp, '2026-01-02T00:00:00.000Z', oldStamp);

    const result = pruneBackups(db, cfg);
    assert.equal(result.deleted, 2);
    assert.equal(existsSync(join(dir, 'uws-old-old1.sqlite')), false, 'old file removed');
    assert.equal(existsSync(join(dir, 'uws-old-old2.sqlite')), false, 'old file removed');
    assert.equal(existsSync(newestPath), true, 'newest file kept');

    const ids = (db.prepare('SELECT id FROM backups').all() as unknown as { id: string }[]).map((r) => r.id);
    assert.deepEqual(ids, ['bkp_newest']);

    // The restore test row followed its deleted backup (FK cascade).
    const remaining = db.prepare('SELECT COUNT(*) c FROM restore_tests').get() as { c: number };
    assert.equal(remaining.c, 0, 'restore_tests cascade with their backup');

    db.close();
  });
});

// ===================================================================== 3. ===
describe('restore tests', () => {
  test('a restore test passes on a good backup and proves opt-outs survived', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    const bizId = addLead(db, 'Beta Traders');
    addSuppression(db, bizId);
    const backup = await runBackup(db, cfg, { actor: owner });

    const result = runRestoreTest(db, cfg, { backupId: backup.id });
    assert.equal(result.status, 'passed');
    assert.equal(result.backupId, backup.id);
    const codes = result.checks.map((c) => c.code);
    for (const required of ['opens', 'integrity_check', 'foreign_key_check', 'schema_tables', 'manifest_match']) {
      assert.ok(codes.includes(required), `check ${required} present`);
    }
    assert.ok(result.checks.every((c) => c.passed), 'all checks pass');

    // The manifest proves the snapshot still holds the opt-out row.
    assert.equal(backup.verifyResult?.counts.suppression_list, 1);

    // Audit trail records the restore test.
    const audit = db.prepare(`SELECT 1 FROM audit_events WHERE action = 'backup.restore_test'`).get();
    assert.ok(audit);

    db.close();
  });

  test('a corrupted backup fails its restore test and raises a critical notification', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    addLead(db, 'Gamma Traders');
    const backup = await runBackup(db, cfg, { actor: owner });

    // Corrupt the stored file: keep only the first 200 bytes and fill the
    // rest with junk - SQLite cannot make sense of it.
    const good = readFileSync(backup.path);
    const junk = Buffer.concat([good.subarray(0, 200), Buffer.alloc(good.length - 200, 0xde)]);
    writeFileSync(backup.path, junk);

    const result = runRestoreTest(db, cfg, { backupId: backup.id });
    assert.equal(result.status, 'failed');
    assert.ok(result.error && result.error.startsWith('failed checks:'), 'failure reason names the failed checks');
    assert.ok(result.checks.some((c) => !c.passed), 'at least one check is red');

    const notes = notificationsOf(db, 'restore_test');
    assert.equal(notes.length, 1, 'exactly one alert');
    assert.equal(notes[0]!.severity, 'critical');

    // The row is queryable for the dashboard.
    const stored = latestRestoreTest(db);
    assert.equal(stored?.status, 'failed');

    db.close();
  });

  test('testing an unknown or unverified backup is refused with a clear error', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);

    assert.throws(
      () => runRestoreTest(db, cfg, { backupId: 'bkp_missing' }),
      (err: unknown) => err instanceof AppError && err.code === 'not_found',
    );

    // A 'running' (not yet verified) backup cannot be tested.
    db.prepare(
      `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, error, created_at)
       VALUES ('bkp_running', '/tmp/x', NULL, NULL, 0, 'running', NULL, ?)`,
    ).run(nowIso());
    assert.throws(
      () => runRestoreTest(db, cfg, { backupId: 'bkp_running' }),
      (err: unknown) => err instanceof AppError && err.code === 'validation_failed',
    );
    assert.equal(latestRestoreTest(db), null);

    db.close();
  });
});

// ===================================================================== 4. ===
describe('restore helpers', () => {
  test('restoreBackupTo refuses a corrupt backup with an explanation', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    addLead(db, 'Delta Traders');
    const backup = await runBackup(db, cfg, { actor: owner });

    writeFileSync(backup.path, Buffer.alloc(512, 0xab));
    assert.throws(
      () => restoreBackupTo(backup.path, join(dir, 'restored.sqlite'), {}),
      (err: unknown) =>
        err instanceof AppError && err.code === 'validation_failed' && /cannot be restored/.test(err.message),
    );
    assert.equal(existsSync(join(dir, 'restored.sqlite')), false, 'no half-written copy left behind');

    db.close();
  });

  test('late opt-outs are captured from the live DB and re-applied onto the restored copy (idempotent)', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    const bizId = addLead(db, 'Echo Traders');
    addSuppression(db, bizId);

    const backup = await runBackup(db, cfg, { actor: owner });

    // An opt-out recorded AFTER the snapshot (distinct reason: a business may
    // carry several opt-outs, but only one per reason - ux_suppression_business_reason).
    const lateAt = new Date(Date.now() + 60_000).toISOString();
    const lateId = addSuppression(db, bizId, lateAt, 'do_not_contact');

    const late = capturePostBackupSuppressions(db, backup.createdAt);
    assert.equal(late.length, 1, 'only the post-backup opt-out is late');
    assert.equal(late[0]!.id, lateId);

    // Materialise the restored copy (unencrypted source).
    const target = join(dir, 'restored.sqlite');
    restoreBackupTo(backup.path, target, {});
    const restored = openDatabase(target);
    try {
      // The snapshot has the ORIGINAL opt-out only.
      const beforeCount = (restored.prepare('SELECT COUNT(*) c FROM suppression_list').get() as { c: number }).c;
      assert.equal(beforeCount, 1);

      const first = applyRestoredSuppressions(restored, late);
      assert.equal(first.applied, 1);
      assert.equal(first.skipped, 0);
      const afterFirst = (restored.prepare('SELECT COUNT(*) c FROM suppression_list').get() as { c: number }).c;
      assert.equal(afterFirst, 2, 'late opt-out re-applied - a restore never resurrects a suppressed business');

      // Re-running the merge must be a no-op.
      const second = applyRestoredSuppressions(restored, late);
      assert.equal(second.applied, 0);
      assert.equal(second.skipped, 1);
      const afterSecond = (restored.prepare('SELECT COUNT(*) c FROM suppression_list').get() as { c: number }).c;
      assert.equal(afterSecond, 2);
    } finally {
      restored.close();
      db.close();
    }
  });

  test('probeExclusiveAccess reports a database held by another connection', () => {
    const dir = tmpDir();
    const path = join(dir, 'probe.sqlite');
    const holder = new DatabaseSync(path, { enableForeignKeyConstraints: false });
    try {
      holder.exec('PRAGMA busy_timeout = 50');
      holder.exec('BEGIN EXCLUSIVE');
      const busy = probeExclusiveAccess(path);
      assert.equal(busy.free, false);
      assert.ok(/in use/.test(busy.detail));
      holder.exec('ROLLBACK');
      const free = probeExclusiveAccess(path);
      assert.equal(free.free, true);
    } finally {
      holder.close();
    }
  });

  test('applyRestore refuses in-memory databases and a database in use; then restores with opt-out merge', async () => {
    const dir = tmpDir();
    const livePath = join(dir, 'live.sqlite');
    const cfg = cfgWith(dir, { DATABASE_PATH: livePath });
    const db = openDatabase(livePath);
    runMigrations(db);
    await seedOwnerIn(db, cfg);
    const bizId = addLead(db, 'Foxtrot Traders');
    addSuppression(db, bizId);

    const backup = await runBackup(db, cfg, { actor: owner });

    // In-memory databases can never be swapped.
    const memoryCfg = cfgWith(dir, { DATABASE_PATH: ':memory:' });
    assert.throws(
      () => applyRestore(memoryCfg, { path: backup.path, createdAt: backup.createdAt }, {}),
      (err: unknown) => err instanceof AppError && err.code === 'validation_failed',
    );

    // While the live database is held exclusively, applyRestore refuses.
    db.exec('BEGIN EXCLUSIVE');
    assert.throws(
      () => applyRestore(cfg, { path: backup.path, createdAt: backup.createdAt }, {}),
      (err: unknown) => err instanceof AppError && err.code === 'conflict',
    );
    db.exec('ROLLBACK');

    // An opt-out lands after the snapshot (distinct reason - see unique index).
    const lateAt = new Date(Date.now() + 60_000).toISOString();
    addSuppression(db, bizId, lateAt, 'do_not_contact');

    db.close();
    const result = applyRestore(cfg, { path: backup.path, createdAt: backup.createdAt }, {});
    assert.equal(result.lateSuppressions.applied, 1, 'post-backup opt-out re-applied');
    assert.ok(existsSync(result.preserved.database), 'pre-restore database preserved, not deleted');
    assert.ok(result.verification.ok, 'live file verifies after the swap');

    // The live database now holds the snapshot data PLUS the late opt-out.
    const reopened = openDatabase(livePath);
    try {
      const leads = (reopened.prepare('SELECT COUNT(*) c FROM businesses').get() as { c: number }).c;
      assert.equal(leads, 1);
      const suppressions = (reopened.prepare('SELECT COUNT(*) c FROM suppression_list').get() as { c: number }).c;
      assert.equal(suppressions, 2, 'snapshot opt-out + late opt-out');
    } finally {
      reopened.close();
    }
  });
});

// ===================================================================== 5. ===
describe('backup jobs', () => {
  test('backup_job is silent when disabled, acts when due, and is silent while fresh', async () => {
    // Disabled (default env): no-op.
    const disabledCfg = loadConfig(TEST_ENV);
    const disabledDb = freshDb(disabledCfg);
    assert.equal(await backupJob.run(ctxFor(disabledDb, disabledCfg)), undefined);
    disabledDb.close();

    // Enabled with no prior backup: takes one.
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);
    const first = await backupJob.run(ctxFor(db, cfg));
    assert.ok(first?.detail?.includes('verified'), `detail reports verification: ${first?.detail}`);
    assert.equal(listBackups(db).length, 1);

    // Immediately again: fresh within BACKUP_INTERVAL_HOURS -> silent.
    assert.equal(await backupJob.run(ctxFor(db, cfg)), undefined);
    assert.equal(listBackups(db).length, 1);

    db.close();
  });

  test('restore_test_job runs once per interval against the newest verified backup', async () => {
    const dir = tmpDir();
    const cfg = cfgWith(dir);
    const db = freshDb(cfg);
    await seedOwnerIn(db, cfg);

    // Nothing to test yet.
    assert.equal(restoreTestJob.run(ctxFor(db, cfg)), undefined);

    await runBackup(db, cfg, { actor: owner });
    const first = restoreTestJob.run(ctxFor(db, cfg)) as { detail?: string };
    assert.ok(first?.detail?.includes('passed'), `detail reports pass: ${first?.detail}`);

    // Fresh test -> silent.
    assert.equal(restoreTestJob.run(ctxFor(db, cfg)), undefined);

    db.close();
  });
});

// ===================================================================== 6. ===
describe('monitoring routes', () => {
  let server: TestServer;
  let backupId: string;
  let ownerEmail: string;
  const ownerPassword = 'Owner-Password-123!';

  before(async () => {
    const dir = tmpDir();
    server = await startTestServer({ BACKUP_ENABLED: 'true', BACKUP_DIR: dir });
    const seeded = await seedOwner(server, { password: ownerPassword });
    ownerEmail = seeded.email;
    const record = await runBackup(server.db, server.config, { actor: owner });
    backupId = record.id;
  });

  after(async () => {
    await server.close();
  });

  test('GET /api/backups is owner-only and lists backups plus restore tests', async () => {
    const anon = server.client();
    assert.equal((await anon.get('/api/backups')).status, 401);

    const ownerClient = await loginAs(server, ownerEmail, ownerPassword);
    const res = await ownerClient.get<{
      enabled: boolean;
      encryptionConfigured: boolean;
      lastBackup: { id: string; status: string };
      items: { id: string }[];
      restoreTests: unknown[];
    }>('/api/backups');
    assert.equal(res.status, 200);
    assert.equal(res.body.enabled, true);
    assert.equal(res.body.encryptionConfigured, false);
    assert.equal(res.body.lastBackup.id, backupId);
    assert.equal(res.body.lastBackup.status, 'verified');
    assert.ok(res.body.items.some((b) => b.id === backupId));
    assert.ok(Array.isArray(res.body.restoreTests));
  });

  test('staff cannot read backups; a triggered restore test runs and needs CSRF', async () => {
    // Staff creation requires an owner actor.
    const ownerRow = server.db.prepare(`SELECT id FROM users WHERE role = 'owner' LIMIT 1`).get() as { id: string };
    const staffEmail = `staff-${Date.now()}@uws.test`;
    await createUser(
      server.db,
      server.config,
      { email: staffEmail, password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: ownerRow.id, label: 'owner' },
    );
    const staff = await loginAs(server, staffEmail, 'Staff-Password-123!');
    const forbidden = await staff.get<{ error: { code: string } }>('/api/backups');
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.error.code, 'forbidden');

    // Owner can trigger a restore test on demand.
    const ownerClient = await loginAs(server, ownerEmail, ownerPassword);
    const noCsrf = await ownerClient.request(`/api/backups/${backupId}/restore-test`, {
      method: 'POST',
      csrf: false,
    });
    assert.equal(noCsrf.status, 403, 'CSRF required');

    const res = await ownerClient.post<{ restoreTest: { status: string; backupId: string } }>(
      `/api/backups/${backupId}/restore-test`,
    );
    assert.equal(res.status, 201);
    assert.equal(res.body.restoreTest.status, 'passed');
    assert.equal(res.body.restoreTest.backupId, backupId);

    // Unknown backup -> 404.
    const missing = await ownerClient.post('/api/backups/bkp_nope/restore-test');
    assert.equal(missing.status, 404);
  });

  test('/api/system reports the backup summary for the dashboard', async () => {
    const ownerClient = await loginAs(server, ownerEmail, ownerPassword);
    const res = await ownerClient.get<{
      backups: { enabled: boolean; last: { id: string; status: string } | null };
    }>('/api/system');
    assert.equal(res.status, 200);
    assert.equal(res.body.backups.enabled, true);
    assert.equal(res.body.backups.last?.id, backupId);
  });
});
