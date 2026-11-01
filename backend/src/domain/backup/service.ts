/**
 * Backups, verification and restore tests (Phase 9).
 *
 * Design rules:
 *  - backups use SQLite's `VACUUM INTO`, which takes a consistent snapshot of
 *    a live WAL database without blocking writers
 *  - every backup is VERIFIED before it counts: the snapshot is reopened and
 *    integrity_check + foreign_key_check + schema/owner checks must pass, and
 *    per-table row counts are recorded as a manifest in `verify_result`
 *  - when BACKUP_PASSPHRASE is set the stored file is AES-256-GCM encrypted
 *    (see crypto.ts); without a passphrase the file is stored as-is and the
 *    row honestly records `encrypted = 0`
 *  - a restore test re-opens the STORED backup (decrypting if needed), runs
 *    the same checks and compares the manifest counts — proving the backup is
 *    still restorable, not merely present
 *  - opt-outs (`suppression_list`) are inside every snapshot; restore tooling
 *    additionally re-applies opt-outs recorded AFTER the snapshot (restore.ts)
 *  - failures raise a notification (and, via the job, a scheduler incident);
 *    success is visible in the dashboard/doctor without daily email noise
 *  - retention prunes by age but NEVER deletes the newest backup
 */
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdirSync, existsSync, statSync, unlinkSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { recordAudit } from '../audit/service.ts';
import { notify } from '../notifications/service.ts';
import { decryptBuffer, encryptBuffer, isEncryptedBuffer } from './crypto.ts';

// --------------------------------------------------------------- verify -----

export interface VerifyCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  checks: VerifyCheck[];
  counts: Record<string, number>;
}

/** Tables whose presence a restorable snapshot must prove. */
const REQUIRED_TABLES = [
  'users',
  'businesses',
  'suppression_list',
  'interactions',
  'outreach_attempts',
  'calls',
  'messages',
  'audit_events',
  'daily_reports',
];

/** Tables whose row counts are captured as the backup manifest. */
const COUNTED_TABLES = [
  ...REQUIRED_TABLES,
  'followup_tasks',
  'portfolio_items',
  'budget_usage',
  'provider_events',
];

function countTables(db: DB): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const t of COUNTED_TABLES) {
    try {
      const row = db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get() as { c: number };
      counts[t] = row.c;
    } catch {
      // A missing table is captured as -1 so the manifest shows it honestly.
      counts[t] = -1;
    }
  }
  return counts;
}

export interface VerifyBackupOptions {
  passphrase?: string;
}

/**
 * Opens a backup file (decrypting to memory if it is encrypted) and runs the
 * full restorability check set. Never throws for a bad file: the failure is
 * reported through the returned checks so it can be recorded and alerted on.
 */
export function verifyBackupFile(path: string, opts: VerifyBackupOptions = {}): VerifyResult {
  const checks: VerifyCheck[] = [];
  let snapshotPath = path;
  let tempPath: string | null = null;

  const cleanup = (): void => {
    if (tempPath && existsSync(tempPath)) {
      try {
        unlinkSync(tempPath);
      } catch {
        /* best effort */
      }
    }
  };

  try {
    if (!existsSync(path)) {
      checks.push({ code: 'file_present', label: 'Backup file exists', passed: false, detail: `Missing: ${path}` });
      return { ok: false, checks, counts: {} };
    }

    // Decrypt an encrypted backup into a temporary file for SQLite to read.
    const raw = readFileSync(path);
    if (isEncryptedBuffer(raw)) {
      checks.push({
        code: 'encryption',
        label: 'Encrypted backup decrypts',
        passed: false,
        detail: 'pending decryption',
      });
      try {
        const plain = decryptBuffer(raw, opts.passphrase ?? '');
        tempPath = `${path}.decrypt-${process.pid}-${Date.now()}`;
        writeFileSync(tempPath, plain);
        snapshotPath = tempPath;
        const encCheck = checks.find((c) => c.code === 'encryption')!;
        encCheck.passed = true;
        encCheck.detail = 'AES-256-GCM decryption succeeded.';
      } catch (err) {
        const encCheck = checks.find((c) => c.code === 'encryption')!;
        encCheck.passed = false;
        encCheck.detail = err instanceof Error ? err.message : String(err);
        return { ok: false, checks, counts: {} };
      }
    } else if (opts.passphrase) {
      checks.push({
        code: 'encryption',
        label: 'Encrypted backup decrypts',
        passed: false,
        detail: 'A passphrase is configured but this backup file is not encrypted.',
      });
      return { ok: false, checks, counts: {} };
    }

    let snap: DatabaseSync;
    try {
      snap = new DatabaseSync(snapshotPath, { readOnly: true, enableForeignKeyConstraints: false });
    } catch (err) {
      checks.push({
        code: 'opens',
        label: 'Opens as a SQLite database',
        passed: false,
        detail: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, checks, counts: {} };
    }

    try {
      checks.push({ code: 'opens', label: 'Opens as a SQLite database', passed: true, detail: 'OK' });

      // A corrupt file makes SQLite RAISE from these pragmas rather than
      // return a sad value: catch per check so verification always reports
      // through the checks array and never throws.
      try {
        const integrity = snap.prepare('PRAGMA integrity_check').get() as { integrity_check?: string } | undefined;
        checks.push({
          code: 'integrity_check',
          label: 'PRAGMA integrity_check',
          passed: integrity?.integrity_check === 'ok',
          detail: integrity?.integrity_check ?? 'no result',
        });
      } catch (err) {
        checks.push({
          code: 'integrity_check',
          label: 'PRAGMA integrity_check',
          passed: false,
          detail: `SQLite error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      try {
        const fkRows = snap.prepare('PRAGMA foreign_key_check').all() as unknown[];
        checks.push({
          code: 'foreign_key_check',
          label: 'PRAGMA foreign_key_check',
          passed: fkRows.length === 0,
          detail: fkRows.length === 0 ? 'No violations.' : `${fkRows.length} violation(s).`,
        });
      } catch (err) {
        checks.push({
          code: 'foreign_key_check',
          label: 'PRAGMA foreign_key_check',
          passed: false,
          detail: `SQLite error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      let missing: string[] = REQUIRED_TABLES;
      try {
        const present = snap
          .prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${REQUIRED_TABLES.map(() => '?').join(',')})`,
          )
          .all(...REQUIRED_TABLES) as { name: string }[];
        missing = REQUIRED_TABLES.filter((t) => !present.some((p) => p.name === t));
      } catch (err) {
        checks.push({
          code: 'schema_tables',
          label: 'Required tables present',
          passed: false,
          detail: `SQLite error: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
      if (checks.every((c) => c.code !== 'schema_tables')) {
        checks.push({
          code: 'schema_tables',
          label: 'Required tables present',
          passed: missing.length === 0,
          detail: missing.length === 0 ? `All ${REQUIRED_TABLES.length} tables present.` : `Missing: ${missing.join(', ')}`,
        });
      }

      let ownerCount = -1;
      try {
        ownerCount = (snap.prepare(`SELECT COUNT(*) c FROM users WHERE role = 'owner'`).get() as { c: number }).c;
      } catch {
        /* captured as -1 below */
      }
      checks.push({
        code: 'owner_account',
        label: 'Owner account exists',
        passed: ownerCount >= 1,
        detail: ownerCount >= 1 ? `${ownerCount} owner account(s).` : 'No owner account in this snapshot.',
      });

      const counts = countTables(snap as unknown as DB);
      return { ok: checks.every((c) => c.passed), checks, counts };
    } finally {
      snap.close();
    }
  } finally {
    cleanup();
  }
}

// --------------------------------------------------------------- backup -----

export interface BackupRecord {
  id: string;
  path: string;
  sizeBytes: number | null;
  sha256: string | null;
  encrypted: boolean;
  status: 'running' | 'completed' | 'verified' | 'failed';
  verifyResult: VerifyResult | null;
  error: string | null;
  retentionUntil: string | null;
  createdAt: string;
  verifiedAt: string | null;
}

interface BackupRow {
  id: string;
  path: string;
  size_bytes: number | null;
  sha256: string | null;
  encrypted: number;
  status: BackupRecord['status'];
  verify_result: string | null;
  error: string | null;
  retention_until: string | null;
  created_at: string;
  verified_at: string | null;
}

function toBackupRecord(row: BackupRow): BackupRecord {
  let verifyResult: VerifyResult | null = null;
  if (row.verify_result) {
    try {
      verifyResult = JSON.parse(row.verify_result) as VerifyResult;
    } catch {
      verifyResult = null;
    }
  }
  return {
    id: row.id,
    path: row.path,
    sizeBytes: row.size_bytes,
    sha256: row.sha256,
    encrypted: row.encrypted === 1,
    status: row.status,
    verifyResult,
    error: row.error,
    retentionUntil: row.retention_until,
    createdAt: row.created_at,
    verifiedAt: row.verified_at,
  };
}

async function sha256File(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    createReadStream(path)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolvePromise(hash.digest('hex')))
      .on('error', rejectPromise);
  });
}

function stamp(now: Date): string {
  const iso = now.toISOString();
  return `${iso.slice(0, 10).replace(/-/g, '')}-${iso.slice(11, 19).replace(/:/g, '')}`;
}

export interface RunBackupOptions {
  /** Audit actor; omitted = scheduler/system. */
  actor?: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' };
  /** Skip the "is a fresh backup due?" check (manual runs). */
  force?: boolean;
}

/**
 * Takes a verified snapshot of the live database.
 *
 * On failure the `backups` row records the error, a critical notification is
 * raised and the error is rethrown so background scheduling (or the CLI)
 * reports it; the caller never has to inspect the row to learn of failure.
 */
export async function runBackup(db: DB, cfg: Config, opts: RunBackupOptions = {}): Promise<BackupRecord> {
  const now = new Date();
  const id = newId('bkp');
  const dir = resolve(cfg.backup.dir);

  const plainName = `uws-${stamp(now)}-${id.slice(-6)}.sqlite`;
  const plainPath = join(dir, plainName);
  const finalPath = plainPath + (cfg.backup.passphrase ? '.enc' : '');

  // The row exists from the very first moment so even a failure as mundane as
  // an uncreatable directory is RECORDED, notified and auditable.
  db.prepare(
    `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, error, created_at)
     VALUES (?, ?, NULL, NULL, ?, 'running', NULL, ?)`,
  ).run(id, finalPath, cfg.backup.passphrase ? 1 : 0, nowIso());

  const fail = (err: unknown): never => {
    const message = err instanceof Error ? err.message : String(err);
    db.prepare(`UPDATE backups SET status = 'failed', error = ? WHERE id = ?`).run(message.slice(0, 500), id);
    // One alert per DAY: the job retries hourly on a broken backup, so keying
    // the alert by attempt id would email-spam the owner. The failed row and
    // audit event are still written for every attempt; if the message differs
    // later the same day, the row still shows it.
    notify(db, cfg, {
      kind: 'backup',
      severity: 'critical',
      title: 'Backup FAILED',
      body: `The scheduled/manual backup could not be completed: ${message.slice(0, 300)}\nThe previous backups are untouched; check the backup directory and disk space.`,
      dedupeKey: `backup_failed:${new Date().toISOString().slice(0, 10)}`,
      entityType: 'backups',
      entityId: id,
    });
    recordAudit(db, {
      actorUserId: opts.actor?.userId ?? null,
      actorLabel: opts.actor?.label ?? 'scheduler',
      action: 'backup.failed',
      entityType: 'backups',
      entityId: id,
      summary: `Backup failed: ${message.slice(0, 200)}`,
      details: null,
    });
    throw err;
  };

  try {
    // 0. Create the backup directory only now that the row can record failure.
    mkdirSync(dir, { recursive: true });

    // 1. Consistent snapshot of the live WAL database (parameterised path).
    db.prepare('VACUUM INTO ?').run(plainPath);

    // 2. Optional encryption: read plaintext, write encrypted, remove plaintext.
    let storedPath = plainPath;
    if (cfg.backup.passphrase) {
      const plain = readFileSync(plainPath);
      writeFileSync(finalPath, encryptBuffer(plain, cfg.backup.passphrase));
      unlinkSync(plainPath);
      storedPath = finalPath;
    }

    // 3. Hash and stat the file that actually remains on disk.
    const sha256 = await sha256File(storedPath);
    const sizeBytes = statSync(storedPath).size;

    // 4. Verify restorability of the STORED file (decrypting if needed).
    const verification = verifyBackupFile(storedPath, { passphrase: cfg.backup.passphrase });
    if (!verification.ok) {
      const failed = verification.checks.filter((c) => !c.passed).map((c) => c.code).join(', ');
      throw new Error(`backup verification failed: ${failed}`);
    }

    // 5. Record the verified backup.
    const retentionUntil = new Date(now.getTime() + cfg.backup.retentionDays * 86_400_000).toISOString();
    db.prepare(
      `UPDATE backups SET size_bytes = ?, sha256 = ?, status = 'verified', verify_result = ?,
         retention_until = ?, verified_at = ? WHERE id = ?`,
    ).run(sizeBytes, sha256, JSON.stringify(verification), retentionUntil, nowIso(), id);

    recordAudit(db, {
      actorUserId: opts.actor?.userId ?? null,
      actorLabel: opts.actor?.label ?? 'scheduler',
      action: 'backup.created',
      entityType: 'backups',
      entityId: id,
      summary: `Backup verified (${sizeBytes} bytes${cfg.backup.passphrase ? ', encrypted' : ''})`,
      details: { sizeBytes, encrypted: Boolean(cfg.backup.passphrase), retentionUntil },
    });

    // 6. Age-based pruning (never deletes the newest backup).
    pruneBackups(db, cfg);

    const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as unknown as BackupRow;
    return toBackupRecord(row);
  } catch (err) {
    // Clean up any half-written files so the directory only holds real backups.
    for (const f of [plainPath, finalPath]) {
      try {
        if (existsSync(f)) unlinkSync(f);
      } catch {
        /* best effort */
      }
    }
    return fail(err);
  }
}

/** Deletes backups older than the retention window; the newest is always kept. */
export function pruneBackups(db: DB, cfg: Config): { deleted: number } {
  const cutoff = new Date(Date.now() - cfg.backup.retentionDays * 86_400_000).toISOString();
  const keepNewest = db.prepare('SELECT id FROM backups ORDER BY created_at DESC LIMIT 1').get() as
    | { id: string }
    | undefined;
  const rows = db
    .prepare('SELECT id, path FROM backups WHERE created_at < ? AND id <> ?')
    .all(cutoff, keepNewest?.id ?? '') as unknown as { id: string; path: string }[];
  let deleted = 0;
  for (const row of rows) {
    try {
      if (existsSync(row.path)) unlinkSync(row.path);
    } catch {
      /* file may already be gone */
    }
    db.prepare('DELETE FROM backups WHERE id = ?').run(row.id);
    deleted += 1;
  }
  return { deleted };
}

export function listBackups(db: DB, limit = 30): BackupRecord[] {
  const rows = db
    .prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 120)) as unknown as BackupRow[];
  return rows.map(toBackupRecord);
}

export function getBackup(db: DB, id: string): BackupRecord | null {
  const row = db.prepare('SELECT * FROM backups WHERE id = ?').get(id) as unknown as BackupRow | undefined;
  return row ? toBackupRecord(row) : null;
}

export function latestBackup(db: DB): BackupRecord | null {
  const row = db.prepare('SELECT * FROM backups ORDER BY created_at DESC LIMIT 1').get() as unknown as
    | BackupRow
    | undefined;
  return row ? toBackupRecord(row) : null;
}

/** The newest backup that passed verification — the only one worth testing. */
export function latestVerifiedBackup(db: DB): BackupRecord | null {
  const row = db
    .prepare(`SELECT * FROM backups WHERE status = 'verified' ORDER BY created_at DESC LIMIT 1`)
    .get() as unknown as BackupRow | undefined;
  return row ? toBackupRecord(row) : null;
}

// ---------------------------------------------------------- restore test ----

export interface RestoreTestRecord {
  id: string;
  backupId: string;
  startedAt: string;
  finishedAt: string | null;
  status: 'running' | 'passed' | 'failed';
  checks: VerifyCheck[];
  error: string | null;
  performedBy: string | null;
}

interface RestoreTestRow {
  id: string;
  backup_id: string;
  started_at: string;
  finished_at: string | null;
  status: RestoreTestRecord['status'];
  checks_json: string;
  error: string | null;
  performed_by: string | null;
}

function toRestoreTest(row: RestoreTestRow): RestoreTestRecord {
  let checks: VerifyCheck[] = [];
  try {
    checks = JSON.parse(row.checks_json) as VerifyCheck[];
  } catch {
    checks = [];
  }
  return {
    id: row.id,
    backupId: row.backup_id,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    status: row.status,
    checks,
    error: row.error,
    performedBy: row.performed_by,
  };
}

export function listRestoreTests(db: DB, limit = 20): RestoreTestRecord[] {
  const rows = db
    .prepare('SELECT * FROM restore_tests ORDER BY started_at DESC LIMIT ?')
    .all(Math.min(Math.max(limit, 1), 100)) as unknown as RestoreTestRow[];
  return rows.map(toRestoreTest);
}

export function latestRestoreTest(db: DB): RestoreTestRecord | null {
  const row = db.prepare('SELECT * FROM restore_tests ORDER BY started_at DESC LIMIT 1').get() as unknown as
    | RestoreTestRow
    | undefined;
  return row ? toRestoreTest(row) : null;
}

export interface RestoreTestOptions {
  /** Explicit backup; defaults to the newest verified one. */
  backupId?: string;
  performedBy?: string | null;
}

/**
 * Proves a stored backup is still RESTORABLE: decrypts it, opens it, runs the
 * full check set and compares the per-table manifest captured at backup time.
 * A failed restore test raises a critical notification — a backup that cannot
 * be restored is worse than no backup, because it breeds false confidence.
 */
export function runRestoreTest(db: DB, cfg: Config, opts: RestoreTestOptions = {}): RestoreTestRecord {
  const backup = opts.backupId ? getBackup(db, opts.backupId) : latestVerifiedBackup(db);
  if (!backup) {
    throw new AppError('not_found', opts.backupId ? `Backup ${opts.backupId} not found` : 'No verified backup to test');
  }
  if (backup.status !== 'verified') {
    throw new AppError('validation_failed', `Backup ${backup.id} is not in verified state (status: ${backup.status})`);
  }

  const id = newId('rtst');
  db.prepare(
    `INSERT INTO restore_tests (id, backup_id, started_at, status, checks_json, performed_by)
     VALUES (?, ?, ?, 'running', '[]', ?)`,
  ).run(id, backup.id, nowIso(), opts.performedBy ?? null);

  const finish = (status: 'passed' | 'failed', checks: VerifyCheck[], error: string | null): RestoreTestRecord => {
    db.prepare(`UPDATE restore_tests SET finished_at = ?, status = ?, checks_json = ?, error = ? WHERE id = ?`).run(
      nowIso(),
      status,
      JSON.stringify(checks),
      error,
      id,
    );
    if (status === 'failed') {
      notify(db, cfg, {
        kind: 'restore_test',
        severity: 'critical',
        title: 'Restore test FAILED',
        body: `Backup ${backup.id} (${backup.path}) failed its restore test: ${error ?? 'checks failed'}.\nThis backup cannot be trusted — take a fresh backup and investigate disk corruption.`,
        dedupeKey: `restore_test_failed:${id}`,
        entityType: 'restore_tests',
        entityId: id,
      });
    }
    recordAudit(db, {
      actorUserId: opts.performedBy ?? null,
      actorLabel: opts.performedBy ? 'owner' : 'scheduler',
      action: 'backup.restore_test',
      entityType: 'restore_tests',
      entityId: id,
      summary: `Restore test ${status} for backup ${backup.id}`,
      details: { backupId: backup.id, status },
    });
    const row = db.prepare('SELECT * FROM restore_tests WHERE id = ?').get(id) as unknown as RestoreTestRow;
    return toRestoreTest(row);
  };

  try {
    const verification = verifyBackupFile(backup.path, { passphrase: cfg.backup.passphrase });
    const checks = [...verification.checks];

    if (verification.ok) {
      // The manifest captured at backup time must match a fresh recount of the
      // very same file: this catches silent drift that "file opens" would miss.
      const manifest = backup.verifyResult?.counts;
      if (!manifest) {
        checks.push({
          code: 'manifest_present',
          label: 'Backup manifest recorded',
          passed: false,
          detail: 'verify_result has no counts manifest.',
        });
      } else {
        const mismatches = Object.entries(manifest).filter(([t, n]) => verification.counts[t] !== n);
        checks.push({
          code: 'manifest_match',
          label: 'Row counts match the backup manifest',
          passed: mismatches.length === 0,
          detail:
            mismatches.length === 0
              ? `All ${Object.keys(manifest).length} table counts match.`
              : mismatches.map(([t, n]) => `${t}: manifest=${n}, actual=${verification.counts[t]}`).join('; '),
        });
      }
    }

    const ok = checks.every((c) => c.passed);
    const failed = checks.filter((c) => !c.passed).map((c) => c.code).join(', ');
    return finish(ok ? 'passed' : 'failed', checks, ok ? null : `failed checks: ${failed}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return finish('failed', [], message.slice(0, 500));
  }
}
