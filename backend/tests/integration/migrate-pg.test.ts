/**
 * Phase 11 tests: SQLite -> PostgreSQL migration CLI (src/cli/migrate-pg.ts).
 *
 * Determinism / isolation rules:
 *  - the SOURCE is a real SQLite database built in a mkdtemp directory and
 *    seeded with users/businesses/suppression/sessions/audit/settings plus a
 *    PAUSED operating_state (the safety-critical row) — removed afterwards
 *  - the TARGET is PGlite (real PostgreSQL, in-process, no network); every
 *    test gets a fresh instance and closes it
 *  - no production connection of any kind: migratePg() takes the target DB
 *    as an injected handle (DATABASE_URL handling is config-level only)
 *  - the source file is hash-compared before/after to prove it is never
 *    modified (read-only open + sha256 equality)
 */
import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { migratePg, formatReport, type MigratePgReport } from '../../src/cli/migrate-pg.ts';
import { AppError } from '../../src/core/errors.ts';
import { openPgliteDatabase, countOf, type PgliteHandle } from '../helpers/pglite.ts';

let dir: string;
let sourcePath: string;

function shaFile(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

async function seedSource(path: string): Promise<void> {
  const db = openDatabase(path);
  try {
    await runMigrations(db);
    const run = async (sql: string, ...params: unknown[]): Promise<void> => {
      await db.prepare(sql).run(...(params as never[]));
    };
    await run(
      `INSERT INTO users (id, email, display_name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'u1', 'owner@uws.test', 'Owner One', 'owner', 'scrypt$1$1$1$salt$hash',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    );
    await run(
      `INSERT INTO users (id, email, display_name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      'u2', 'staff@uws.test', 'Staff Two', 'staff', 'scrypt$1$1$1$salt$hash',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z',
    );
    await run(
      `INSERT INTO businesses (id, display_name, normalized_name, city, source_type, discovered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'b1', 'Alpha Traders', 'alpha traders', 'Karachi', 'directory',
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
    );
    await run(
      `INSERT INTO businesses (id, display_name, normalized_name, city, source_type, discovered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      'b2', 'Beta Foods', 'beta foods', 'Lahore', 'web_search',
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z',
    );
    // Self-referencing FK (businesses.merged_into_id) — exercises the
    // self-edge handling in topological ordering and the orphan check.
    await run(
      `UPDATE businesses SET merged_into_id = ?, stage_change_reason = ? WHERE id = ?`,
      'b1', 'merged during test seed', 'b2',
    );
    await run(
      `INSERT INTO suppression_list (id, business_id, scope, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'sup1', 'b1', 'business', 'opt_out', 'manual', '2026-01-03T00:00:00.000Z',
    );
    await run(
      `INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      'sess1', 'u1', 'csrf-secret', '2026-01-04T00:00:00.000Z', '2026-02-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z',
    );
    await run(
      `INSERT INTO login_attempts (email, ip_hash, succeeded, created_at) VALUES (?, ?, ?, ?)`,
      'owner@uws.test', 'iphash1', 1, '2026-01-04T01:00:00.000Z',
    );
    await run(
      `INSERT INTO audit_events (occurred_at, actor_user_id, actor_label, action, entity_type, entity_id, summary)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      '2026-01-04T02:00:00.000Z', 'u1', 'owner', 'settings.update', 'settings', 'demo.setting',
      'seeded for migration test',
    );
    await run(
      `INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)`,
      'demo.setting', '{"a":1}', '2026-01-04T03:00:00.000Z',
    );
    // Owner pause state: the migration MUST carry this to the target
    // (a fresh target only has the migration's placeholder row).
    await run(
      `UPDATE operating_state SET paused = 1, pause_reason = ?, paused_at = ?, updated_at = ? WHERE id = 1`,
      'owner paused for review', '2026-01-05T00:00:00.000Z', '2026-01-05T00:00:00.000Z',
    );
  } finally {
    await db.close();
  }
}

async function withDest(migrate: boolean, fn: (h: PgliteHandle) => Promise<void>): Promise<void> {
  const handle = await openPgliteDatabase({ migrate });
  try {
    await fn(handle);
  } finally {
    await handle.db.close();
  }
}

function table(report: MigratePgReport, name: string) {
  const entry = report.tables.find((t) => t.table === name);
  assert.ok(entry, `report missing table ${name}`);
  return entry;
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'migrate-pg-'));
  sourcePath = join(dir, 'source.db');
  await seedSource(sourcePath);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('migrate-pg: dry-run', () => {
  test('writes nothing to the target, plans every table, leaves the source byte-identical', async () => {
    const sourceHash = shaFile(sourcePath);
    const sourceStat = statSync(sourcePath);
    await withDest(false, async ({ db }) => {
      const report = await migratePg({ sourcePath, dest: db, confirm: false });

      assert.equal(report.mode, 'dry-run');
      assert.equal(report.ok, true, `dry-run should be clean: ${JSON.stringify(report.conflicts)}`);
      assert.equal(report.conflicts.length, 0);
      assert.equal(report.migrationsApplied, 0);
      assert.equal(report.aborted, false);

      // Every table is planned; nothing was copied because nothing exists yet.
      assert.ok(report.tables.length >= 8, `expected the seeded tables, got ${report.tables.length}`);
      for (const t of report.tables) {
        assert.equal(t.status, 'planned', `${t.table} should be planned in a dry-run`);
      }

      // Target untouched: no schema, no tables, no migration bookkeeping.
      const publicTables = await countOf(db, `SELECT COUNT(*) AS c FROM pg_tables WHERE schemaname = 'public'`);
      assert.equal(publicTables, 0, 'dry-run must not create the target schema');
      const migrationRows = await countOf(
        db,
        `SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = 'schema_migrations'`,
      );
      assert.equal(migrationRows, 0);

      // Report is printable and self-describing.
      const text = formatReport(report);
      assert.match(text, /DRY-RUN/);
      assert.match(text, /RESULT: OK/);
      assert.match(text, /--confirm/);
    });

    // Source proof: identical bytes and identical file metadata.
    assert.equal(shaFile(sourcePath), sourceHash, 'source bytes must not change');
    const after = statSync(sourcePath);
    assert.equal(after.size, sourceStat.size);
    assert.equal(after.mtimeMs, sourceStat.mtimeMs);
  });
});

describe('migrate-pg: apply', () => {
  test('copies every table in FK order, verifies counts/relationships, preserves the owner pause state', async () => {
    const sourceHash = shaFile(sourcePath);
    await withDest(false, async ({ db }) => {
      const report = await migratePg({ sourcePath, dest: db, confirm: true });

      assert.equal(report.mode, 'apply');
      assert.equal(report.ok, true, `apply must verify clean: ${JSON.stringify({ c: report.conflicts, m: report.countMismatches, r: report.relationshipIssues, s: report.sequenceIssues, f: report.tables.filter((t) => t.status === 'failed') })}`);
      assert.ok(report.migrationsApplied > 0, 'target migrations must run before copying');
      assert.equal(report.conflicts.length, 0);
      assert.equal(report.countMismatches.length, 0);
      assert.equal(report.relationshipIssues.length, 0);
      assert.equal(report.sequenceIssues.length, 0);
      assert.equal(report.sourceUntouched, true);

      // Statuses: rows were written (copy) or rewritten (the seeded
      // singleton); tables empty on both sides are legitimately skipped.
      for (const t of report.tables) {
        if (t.sourceRows === 0) {
          assert.equal(t.status, 'skipped', `${t.table} is empty on both sides and should be skipped`);
        } else {
          assert.ok(t.status === 'copied' || t.status === 'replaced', `${t.table} has unexpected status ${t.status}`);
        }
      }
      assert.equal(table(report, 'operating_state').status, 'replaced');

      // Row counts land exactly.
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM users'), 2);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM businesses'), 2);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM suppression_list'), 1);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM sessions'), 1);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM audit_events'), 1);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM settings'), 1);

      // Safety-critical: the source's PAUSED state replaced the migration
      // placeholder (the placeholder would say paused=0).
      const state = (await db.prepare('SELECT paused, pause_reason FROM operating_state WHERE id = 1').get()) as {
        paused: number;
        pause_reason: string;
      };
      assert.equal(state.paused, 1, 'owner pause state must survive the migration');
      assert.equal(state.pause_reason, 'owner paused for review');

      // Identity sequences were advanced (table + column recorded).
      assert.ok(report.identitiesAdvanced.includes('login_attempts.id'), `identities: ${report.identitiesAdvanced.join(',')}`);
      assert.ok(report.identitiesAdvanced.length >= 1);
    });
    assert.equal(shaFile(sourcePath), sourceHash, 'source bytes must not change');
  });

  test('a second run is a no-op: every table skipped, no duplicates, still verified', async () => {
    await withDest(false, async ({ db }) => {
      const first = await migratePg({ sourcePath, dest: db, confirm: true });
      assert.equal(first.ok, true);

      const second = await migratePg({ sourcePath, dest: db, confirm: true });
      assert.equal(second.ok, true, JSON.stringify(second));
      for (const t of second.tables) {
        assert.equal(t.status, 'skipped', `${t.table} should be skipped on re-run, got ${t.status}`);
      }
      // Idempotency: row counts unchanged (no duplicate inserts).
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM users'), 2);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM businesses'), 2);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM operating_state'), 1);
    });
  });

  test('identity sequences accept new rows without colliding with copied ids', async () => {
    await withDest(false, async ({ db }) => {
      const report = await migratePg({ sourcePath, dest: db, confirm: true });
      assert.equal(report.ok, true);

      // Source login_attempts contains id=1; setval must make the next id 2.
      const inserted = await db
        .prepare(`INSERT INTO login_attempts (email, ip_hash, succeeded, created_at) VALUES (?, ?, ?, ?) RETURNING id`)
        .run('new@uws.test', 'iphash2', 1, '2026-01-06T00:00:00.000Z');
      assert.equal(inserted.lastInsertRowid, 2, 'sequence must resume after the copied max id');
    });
  });
});

describe('migrate-pg: conflict and failure handling', () => {
  test('partial target data aborts BEFORE any write and is reported as a conflict', async () => {
    const sourceHash = shaFile(sourcePath);
    await withDest(true, async ({ db }) => {
      // Simulate a previous partial/foreign run: target already has ONE user.
      await db
        .prepare(
          `INSERT INTO users (id, email, display_name, role, password_hash, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('u3', 'other@uws.test', 'Other', 'staff', 'scrypt$1$1$1$s$h',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');

      const report = await migratePg({ sourcePath, dest: db, confirm: true });

      assert.equal(report.ok, false);
      assert.equal(report.aborted, true, 'conflicts must abort before data writes');
      assert.ok(report.conflicts.some((c) => c.startsWith('users:')), report.conflicts.join(' | '));

      // Nothing was written: the partial users row is untouched and no other
      // table received rows.
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM users'), 1);
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM businesses'), 0);
      assert.equal(table(report, 'users').status, 'conflict');
      assert.equal(table(report, 'businesses').status, 'planned');
      assert.match(table(report, 'businesses').note ?? '', /aborted/);
    });
    assert.equal(shaFile(sourcePath), sourceHash);
  });

  test('a table that fails to copy rolls back to zero rows and is reported as failed', async () => {
    await withDest(true, async ({ db }) => {
      // Break ONLY the target schema for one column: the users INSERT lists
      // updated_at, so the copy must fail and roll back completely.
      await db.exec('ALTER TABLE users DROP COLUMN updated_at');

      const report = await migratePg({ sourcePath, dest: db, confirm: true });

      assert.equal(report.ok, false);
      const users = table(report, 'users');
      assert.equal(users.status, 'failed');
      assert.match(users.error ?? '', /updated_at/);
      // Rollback proof: the target still has ZERO users (no partial rows).
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM users'), 0);
      // The failure surfaced in verification too (row counts differ).
      assert.ok(report.countMismatches.some((m) => m.startsWith('users:')), report.countMismatches.join(' | '));
      // Tables independent of users still land (per-table transactions).
      assert.equal(table(report, 'businesses').status, 'copied');
      assert.equal(await countOf(db, 'SELECT COUNT(*) AS c FROM businesses'), 2);
    });
  });

  test('a missing source file fails loudly (no silent empty database)', async () => {
    await withDest(false, async ({ db }) => {
      await assert.rejects(
        () => migratePg({ sourcePath: join(dir, 'does-not-exist.db'), dest: db, confirm: false }),
        (err: unknown) => err instanceof AppError && err.code === 'not_found' && /Source SQLite database not found/.test((err as Error).message),
      );
      await assert.rejects(
        () => migratePg({ sourcePath: join(dir, 'does-not-exist.db'), dest: db, confirm: true }),
        (err: unknown) => err instanceof AppError && err.code === 'not_found',
      );
    });
  });
});
