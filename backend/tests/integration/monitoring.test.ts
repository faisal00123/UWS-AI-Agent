/**
 * Phase 10 tests: the app-side monitoring report (70/85/95% thresholds) and
 * the internal backup-cron trigger endpoint.
 *
 * Determinism / isolation rules:
 *  - every test uses an in-memory database and its own mkdtemp backup
 *    directory, removed afterwards - nothing is written into the project tree
 *  - no test can reach a real network: the trigger endpoint only ever runs
 *    the local backup writer, and R2 credentials are never configured here
 *  - the bearer secret is a test-only literal, never a production value
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import {
  collectMetrics,
  levelForPercent,
  THRESHOLDS,
} from '../../src/domain/monitoring/service.ts';
import { createUser } from '../../src/domain/auth/service.ts';
import {
  TEST_ENV,
  loginAs,
  seedOwner,
  startTestServer,
  type TestServer,
} from '../helpers/app.ts';

const TRIGGER_SECRET = 'test-backup-trigger-secret-0123456789';

const tempDirs: string[] = [];
function tmpDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'uws-monitoring-'));
  tempDirs.push(dir);
  return dir;
}

async function freshDb(): Promise<DB> {
  const db = openDatabase(':memory:');
  await runMigrations(db);
  return db;
}

function cfgWith(extra: Record<string, string | undefined> = {}): Config {
  return loadConfig({ ...TEST_ENV, ...extra });
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
describe('monitoring thresholds', () => {
  test('70/85/95 boundaries map to warn/urgent/critical', () => {
    assert.equal(THRESHOLDS.warn, 70);
    assert.equal(THRESHOLDS.urgent, 85);
    assert.equal(THRESHOLDS.critical, 95);

    assert.equal(levelForPercent(0), 'ok');
    assert.equal(levelForPercent(69.9), 'ok');
    assert.equal(levelForPercent(70), 'warn');
    assert.equal(levelForPercent(84.9), 'warn');
    assert.equal(levelForPercent(85), 'urgent');
    assert.equal(levelForPercent(94.9), 'urgent');
    assert.equal(levelForPercent(95), 'critical');
    assert.equal(levelForPercent(150), 'critical');
    // A metric with no measurable limit is honestly 'ok', not fabricated.
    assert.equal(levelForPercent(null), 'ok');
    assert.equal(levelForPercent(Number.NaN), 'ok');
  });
});

// ===================================================================== 2. ===
describe('collectMetrics', () => {
  test('reports every metric with a valid level on a fresh database', async () => {
    const db = await freshDb();
    try {
      const report = await collectMetrics(db, cfgWith());
      const keys = report.metrics.map((m) => m.key).sort();
      assert.deepEqual(keys, [
        'backup.age',
        'backup.failures',
        'backup.storage',
        'db.connections',
        'db.latency',
        'db.size',
      ]);
      assert.equal(report.dialect, 'sqlite');
      assert.deepEqual(report.thresholds, THRESHOLDS);
      assert.ok(Date.parse(report.checkedAt) > 0, 'checkedAt is a real timestamp');

      for (const m of report.metrics) {
        assert.ok(
          ['ok', 'warn', 'urgent', 'critical', 'unknown'].includes(m.level),
          `unexpected level ${m.level} for ${m.key}`,
        );
        assert.ok(m.detail.length > 0, `${m.key} must explain itself`);
        if (m.percent !== null) {
          assert.ok(m.percent >= 0, `${m.key} percent must be non-negative`);
        }
      }

      // overall is the worst measured level ('unknown' never hides a real one).
      const worst = report.metrics
        .filter((m) => m.level !== 'unknown')
        .map((m) => m.level)
        .sort((a, b) => rank(b) - rank(a))[0];
      assert.equal(report.overall, worst ?? 'ok');
    } finally {
      db.close();
    }
  });

  test('disabled backups are an explicit owner decision, not an incident', async () => {
    const db = await freshDb();
    try {
      const report = await collectMetrics(db, cfgWith({ BACKUP_ENABLED: 'false' }));
      const age = report.metrics.find((m) => m.key === 'backup.age')!;
      assert.equal(age.level, 'ok');
      assert.match(age.detail, /disabled by configuration/);
      assert.equal(report.overall, 'ok');
    } finally {
      db.close();
    }
  });

  test('enabled backups with no verified backup is critical, never silently ok', async () => {
    const db = await freshDb();
    try {
      const report = await collectMetrics(db, cfgWith({ BACKUP_ENABLED: 'true' }));
      const age = report.metrics.find((m) => m.key === 'backup.age')!;
      assert.equal(age.level, 'critical');
      assert.match(age.detail, /no verified backup/);
      assert.equal(report.overall, 'critical');
    } finally {
      db.close();
    }
  });

  test('a fresh verified backup reads ok; an old one crosses thresholds', async () => {
    const db = await freshDb();
    const cfg = cfgWith({ BACKUP_ENABLED: 'true', BACKUP_INTERVAL_HOURS: '24' });
    try {
      await db
        .prepare(
          `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, created_at, verified_at)
           VALUES (?, ?, ?, ?, 0, 'verified', ?, ?)`,
        )
        .run('bkp_fresh', '/tmp/fresh.sqlite', 1024, 'abc', nowIso(), nowIso());

      const fresh = await collectMetrics(db, cfg);
      const freshAge = fresh.metrics.find((m) => m.key === 'backup.age')!;
      assert.equal(freshAge.level, 'ok');
      assert.ok(freshAge.percent !== null && freshAge.percent < 70);

      // Age it to 43h: 43/48 = 89.6% of the allowed window -> urgent.
      const old = new Date(Date.now() - 43 * 3_600_000).toISOString();
      await db.prepare(`UPDATE backups SET verified_at = ? WHERE id = 'bkp_fresh'`).run(old);
      const aged = await collectMetrics(db, cfg);
      const agedAge = aged.metrics.find((m) => m.key === 'backup.age')!;
      assert.equal(agedAge.level, 'urgent');
      assert.ok(agedAge.percent !== null && agedAge.percent >= 85 && agedAge.percent < 95);

      // 47h: 47/48 = 97.9% -> critical.
      const older = new Date(Date.now() - 47 * 3_600_000).toISOString();
      await db.prepare(`UPDATE backups SET verified_at = ? WHERE id = 'bkp_fresh'`).run(older);
      const oldest = await collectMetrics(db, cfg);
      const oldestAge = oldest.metrics.find((m) => m.key === 'backup.age')!;
      assert.equal(oldestAge.level, 'critical');
    } finally {
      db.close();
    }
  });

  test('backup failures and storage report real numbers', async () => {
    const db = await freshDb();
    try {
      // Two attempts in the window, one failed (error set) -> 50% -> ok band.
      await db
        .prepare(
          `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, error, created_at, verified_at)
           VALUES ('bkp_a', '/tmp/a', 500, 'a', 0, 'verified', NULL, ?, ?)`,
        )
        .run(nowIso(), nowIso());
      await db
        .prepare(
          `INSERT INTO backups (id, path, size_bytes, sha256, encrypted, status, error, created_at)
           VALUES ('bkp_b', '/tmp/b', NULL, NULL, 0, 'failed', 'disk full', ?)`,
        )
        .run(nowIso());

      const report = await collectMetrics(db, cfgWith({ BACKUP_ENABLED: 'true' }));
      const failures = report.metrics.find((m) => m.key === 'backup.failures')!;
      assert.equal(failures.used, 1);
      assert.equal(failures.percent, 50);
      assert.equal(failures.level, 'ok');

      const storage = report.metrics.find((m) => m.key === 'backup.storage')!;
      assert.equal(storage.used, 500, 'sums recorded sizes only');
      assert.ok(storage.percent !== null && storage.percent >= 0);
    } finally {
      db.close();
    }
  });

  test('a metric that cannot be measured reports unknown, never a fake ok', async () => {
    // A database with the backups table dropped makes the backup probes fail.
    const db = await freshDb();
    try {
      db.exec('DROP TABLE backups');
      const report = await collectMetrics(db, cfgWith({ BACKUP_ENABLED: 'true' }));
      const storage = report.metrics.find((m) => m.key === 'backup.storage')!;
      assert.equal(storage.level, 'unknown');
      assert.match(storage.detail, /Could not measure/);
      // The db metrics still report: one broken probe must not hide the rest.
      assert.ok(report.metrics.some((m) => m.key === 'db.latency' && m.level === 'ok'));
      // 'unknown' never inflates the overall level.
      assert.notEqual(report.overall, 'unknown');
    } finally {
      db.close();
    }
  });

  test('SQLite reports connection metric as honestly not applicable', async () => {
    const db = await freshDb();
    try {
      const report = await collectMetrics(db, cfgWith());
      const conns = report.metrics.find((m) => m.key === 'db.connections')!;
      assert.equal(conns.level, 'ok');
      assert.equal(conns.percent, null);
      assert.match(conns.detail, /Not applicable on SQLite/);
    } finally {
      db.close();
    }
  });
});

function rank(level: string): number {
  return { ok: 0, unknown: 0, warn: 1, urgent: 2, critical: 3 }[level] ?? 0;
}

// ===================================================================== 3. ===
describe('GET /api/monitoring', () => {
  let server: TestServer;
  let ownerEmail: string;
  const ownerPassword = 'Owner-Password-123!';

  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { password: ownerPassword });
    ownerEmail = seeded.email;
  });

  after(async () => {
    await server.close();
  });

  test('is owner-only and returns the full report shape', async () => {
    const anon = server.client();
    assert.equal((await anon.get('/api/monitoring')).status, 401);

    const ownerClient = await loginAs(server, ownerEmail, ownerPassword);
    const res = await ownerClient.get<{
      dialect: string;
      overall: string;
      thresholds: { warn: number; urgent: number; critical: number };
      metrics: { key: string; level: string }[];
    }>('/api/monitoring');
    assert.equal(res.status, 200);
    assert.equal(res.body.dialect, 'sqlite');
    assert.deepEqual(res.body.thresholds, { warn: 70, urgent: 85, critical: 95 });
    assert.ok(res.body.metrics.length >= 6);
    assert.ok(res.body.metrics.every((m) => typeof m.key === 'string' && typeof m.level === 'string'));
    assert.ok(['ok', 'warn', 'urgent', 'critical'].includes(res.body.overall));
  });

  test('staff are forbidden', async () => {
    const ownerRow = (await server.db.prepare(`SELECT id FROM users WHERE role = 'owner' LIMIT 1`).get()) as { id: string };
    const staffEmail = `staff-${Date.now()}@uws.test`;
    await createUser(
      server.db,
      server.config,
      { email: staffEmail, password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: ownerRow.id, label: 'owner' },
    );
    const staff = await loginAs(server, staffEmail, 'Staff-Password-123!');
    const res = await staff.get<{ error: { code: string } }>('/api/monitoring');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });
});

// ===================================================================== 4. ===
describe('POST /api/internal/backup/run', () => {
  test('is inert (404) when no trigger secret is configured', async () => {
    const server = await startTestServer({ BACKUP_ENABLED: 'true', BACKUP_DIR: tmpDir() });
    try {
      const res = await server.client().post('/api/internal/backup/run');
      assert.equal(res.status, 404);
      // No secret configured means no hint that the route exists.
      assert.equal((res.body as { error?: { code?: string } }).error?.code, 'not_found');
    } finally {
      await server.close();
    }
  });

  test('rejects missing, malformed and wrong bearer tokens (401)', async () => {
    const server = await startTestServer({
      BACKUP_ENABLED: 'true',
      BACKUP_DIR: tmpDir(),
      BACKUP_TRIGGER_SECRET: TRIGGER_SECRET,
    });
    try {
      const client = server.client();
      const noAuth = await client.post('/api/internal/backup/run');
      assert.equal(noAuth.status, 401);

      const wrongScheme = await client.request('/api/internal/backup/run', {
        method: 'POST',
        headers: { authorization: `Basic ${TRIGGER_SECRET}` },
      });
      assert.equal(wrongScheme.status, 401);

      const wrongValue = await client.request('/api/internal/backup/run', {
        method: 'POST',
        headers: { authorization: 'Bearer definitely-the-wrong-secret' },
      });
      assert.equal(wrongValue.status, 401);

      // Nothing was created by any rejected attempt.
      const count = (await server.db.prepare('SELECT COUNT(*) AS c FROM backups').get()) as { c: number };
      assert.equal(count.c, 0);
    } finally {
      await server.close();
    }
  });

  test('a valid bearer runs a backup without any session or CSRF', async () => {
    const server = await startTestServer({
      BACKUP_ENABLED: 'true',
      BACKUP_DIR: tmpDir(),
      BACKUP_TRIGGER_SECRET: TRIGGER_SECRET,
    });
    try {
      // Backup verification requires an owner account to exist.
      await seedOwner(server, { password: 'Owner-Password-123!' });
      const res = await server.client().request<{ backup: { id: string; status: string } }>(
        '/api/internal/backup/run',
        {
          method: 'POST',
          headers: { authorization: `Bearer ${TRIGGER_SECRET}` },
          csrf: false,
        },
      );
      assert.equal(res.status, 201);
      assert.ok(res.body.backup.id.startsWith('bkp_'));
      assert.ok(['verified', 'completed'].includes(res.body.backup.status));

      // Recorded in the database like any other backup.
      const row = (await server.db.prepare('SELECT id FROM backups WHERE id = ?').get(res.body.backup.id)) as
        | { id: string }
        | undefined;
      assert.equal(row?.id, res.body.backup.id);
    } finally {
      await server.close();
    }
  });

  test('reports 409 when backups are disabled, even with a valid secret', async () => {
    const server = await startTestServer({
      BACKUP_ENABLED: 'false',
      BACKUP_DIR: tmpDir(),
      BACKUP_TRIGGER_SECRET: TRIGGER_SECRET,
    });
    try {
      const res = await server.client().request<{ error: { code: string } }>('/api/internal/backup/run', {
        method: 'POST',
        headers: { authorization: `Bearer ${TRIGGER_SECRET}` },
      });
      assert.equal(res.status, 409);
      assert.equal(res.body.error.code, 'conflict');
      const count = (await server.db.prepare('SELECT COUNT(*) AS c FROM backups').get()) as { c: number };
      assert.equal(count.c, 0);
    } finally {
      await server.close();
    }
  });
});
