/**
 * Phase 11 tests: the PostgreSQL restore branch (src/cli/restore.ts) and the
 * isolated-schema restore it delegates to (restoreDumpIntoIsolatedSchema).
 *
 * Determinism / isolation rules:
 *  - every restore happens in a DISPOSABLE `restore_test_*` schema inside a
 *    PGlite database (real PostgreSQL, in-process, no network) and is dropped
 *    again — the live `public` schema is never written to by these tests
 *  - failure tests prove the transaction ROLLS BACK: no leftover schema, no
 *    partial rows, live data untouched
 *  - the --apply refusal is a pure function test: no database needed
 *  - no production connection, no deployment, no secrets
 */
import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPgliteDatabase, countOf, type PgliteHandle } from '../helpers/pglite.ts';
import {
  dumpDatabase,
  hashLines,
  restoreDumpIntoIsolatedSchema,
} from '../../src/domain/backup/pgdump.ts';
import { assertRestoreTarget, loadDumpBytes } from '../../src/cli/restore.ts';
import { encryptBuffer } from '../../src/domain/backup/crypto.ts';
import { AppError } from '../../src/core/errors.ts';

const dirs: string[] = [];

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'restore-pg-'));
  dirs.push(d);
  return d;
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

async function withDest(migrate: boolean, fn: (h: PgliteHandle) => Promise<void>): Promise<void> {
  const handle = await openPgliteDatabase({ migrate });
  try {
    await fn(handle);
  } finally {
    await handle.db.close();
  }
}

/** Minimal realistic dataset with an FK chain (users -> sessions). */
async function seed(handle: PgliteHandle): Promise<void> {
  const db = handle.db;
  await db
    .prepare(
      `INSERT INTO users (id, email, display_name, role, password_hash, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('u1', 'owner@uws.test', 'Owner', 'owner', 'scrypt$1$1$1$s$h',
      '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
  await db
    .prepare(
      `INSERT INTO businesses (id, display_name, normalized_name, source_type, discovered_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('b1', 'Alpha Traders', 'alpha traders', 'directory',
      '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2026-01-02T00:00:00.000Z');
  await db
    .prepare(
      `INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('sess1', 'u1', 'csrf', '2026-01-04T00:00:00.000Z',
      '2026-02-04T00:00:00.000Z', '2026-01-04T00:00:00.000Z');
}

/** True when any restore_test_* schema survives (must always be 0). */
async function leftoverSchemas(handle: PgliteHandle): Promise<number> {
  const res = await handle.raw.query<{ c: number }>(
    `SELECT COUNT(*)::int AS c FROM pg_namespace WHERE starts_with(nspname, 'restore_test_')`,
  );
  return Number(res.rows[0]?.c ?? -1);
}

/**
 * Craft a dump that passes FILE verification (manifest hashes recomputed)
 * but violates the sessions -> users foreign key at insert time, proving the
 * restore transaction rolls back instead of leaving a half-restored schema.
 */
function tamperSessionFK(dump: Buffer): Buffer {
  const lines = dump.toString('utf8').split('\n').filter((l) => l.length > 0);
  assert.ok(lines.length > 1, 'dump must contain row lines');
  const manifest = JSON.parse(lines[0]!) as {
    tables: { name: string; columns: string[]; count: number; sha256: string }[];
  };
  const entry = manifest.tables.find((t) => t.name === 'sessions');
  assert.ok(entry, 'dump must contain the sessions table');

  const out: string[] = [lines[0]!];
  const newSessionLines: string[] = [];
  for (const line of lines.slice(1)) {
    const parsed = JSON.parse(line) as { t: string; r: Record<string, unknown> };
    if (parsed.t === 'sessions') {
      parsed.r['user_id'] = 'ghost-user'; // breaks the FK to users.id
      const rewritten = JSON.stringify(parsed);
      newSessionLines.push(rewritten);
      out.push(rewritten);
    } else {
      out.push(line);
    }
  }
  assert.equal(newSessionLines.length, entry.count, 'tamper keeps the row count (only content changes)');
  entry.sha256 = hashLines(newSessionLines); // keep the manifest self-consistent
  out[0] = JSON.stringify(manifest);
  return Buffer.from(`${out.join('\n')}\n`, 'utf8');
}

describe('restore-pg: isolated-schema restore integrity', () => {
  test('a valid dump restores fully into restore_test_* and the schema is dropped again', async () => {
    await withDest(true, async (handle) => {
      await seed(handle);
      const dump = await dumpDatabase(handle.db);
      assert.ok(dump.data.length > 0);

      const result = await restoreDumpIntoIsolatedSchema(handle.db, dump.data);

      const byCode = (code: string) => result.checks.find((c) => c.code === code);
      assert.equal(result.ok, true, `restore must pass: ${JSON.stringify(result.checks.filter((c) => !c.passed))}`);
      assert.equal(byCode('opens')?.passed, true);
      assert.equal(byCode('manifest_checksums')?.passed, true, 'file-level verification must pass first');
      assert.equal(byCode('schema_created')?.passed, true);
      assert.equal(byCode('migrations')?.passed, true, 'app migrations must apply inside the isolated schema');
      assert.equal(byCode('row_insert')?.passed, true);
      assert.equal(byCode('counts_match')?.passed, true);
      assert.equal(byCode('content_hash_match')?.passed, true, 'byte-level content equality must be proven');

      // Restored counts match the seeded dataset.
      assert.equal(result.counts['users'], 1);
      assert.equal(result.counts['businesses'], 1);
      assert.equal(result.counts['sessions'], 1);

      // The disposable schema is gone and the live schema is untouched.
      assert.equal(await leftoverSchemas(handle), 0, 'restore_test_* schema must be dropped');
      assert.equal(await countOf(handle.db, 'SELECT COUNT(*) AS c FROM users'), 1);
      assert.equal(await countOf(handle.db, 'SELECT COUNT(*) AS c FROM sessions'), 1);
    });
  });

  test('a file-level corrupt dump is rejected before any schema is created', async () => {
    await withDest(false, async (handle) => {
      const garbage = Buffer.from('SQLite format 3\0 this is not a logical dump at all', 'utf8');
      const result = await restoreDumpIntoIsolatedSchema(handle.db, garbage);
      assert.equal(result.ok, false);
      const opens = result.checks.find((c) => c.code === 'opens');
      assert.equal(opens?.passed, false, 'structural failure must be reported');
      assert.equal(await leftoverSchemas(handle), 0, 'no schema may be created from a bad file');
    });
  });
});

describe('restore-pg: failure handling and rollback', () => {
  test('an FK-violating dump rolls back completely: no schema, no partial rows, live data intact', async () => {
    await withDest(true, async (handle) => {
      await seed(handle);
      const dump = await dumpDatabase(handle.db);
      const tampered = tamperSessionFK(dump.data);

      // The tampered file still PASSES file verification (hashes recomputed),
      // so the failure can only happen during execution -> true rollback path.
      const result = await restoreDumpIntoIsolatedSchema(handle.db, tampered);

      const manifestCheck = result.checks.find((c) => c.code === 'manifest_checksums');
      assert.equal(manifestCheck?.passed, true, 'file-level verify must pass so execution is actually reached');

      const execution = result.checks.find((c) => c.code === 'restore_execution');
      assert.ok(execution, 'execution failure must be recorded');
      assert.equal(execution.passed, false);
      assert.match(execution.detail, /violates foreign key|FOREIGN KEY|violates/i);

      assert.equal(result.ok, false);
      // Rollback proof: the transactional schema never persisted.
      assert.equal(await leftoverSchemas(handle), 0, 'failed restore must leave no restore_test_* schema');
      // Live data was never modified.
      assert.equal(await countOf(handle.db, 'SELECT COUNT(*) AS c FROM users'), 1);
      assert.equal(await countOf(handle.db, 'SELECT COUNT(*) AS c FROM sessions'), 1);
      // And a good dump still restores afterwards (nothing poisoned).
      const good = await restoreDumpIntoIsolatedSchema(handle.db, dump.data);
      assert.equal(good.ok, true, JSON.stringify(good.checks.filter((c) => !c.passed)));
      assert.equal(await leftoverSchemas(handle), 0);
    });
  });
});

describe('restore-pg: --apply refusal in PostgreSQL mode', () => {
  test('--apply with DATABASE_URL set throws validation_failed naming the isolated-schema path', () => {
    assert.throws(
      () => assertRestoreTarget('postgresql://user:pass@db.example/uws', true),
      (err: unknown) =>
        err instanceof AppError &&
        err.code === 'validation_failed' &&
        /isolated/i.test(err.message) &&
        /owner approval/i.test(err.message),
    );
  });

  test('SQLite mode (no DATABASE_URL) still allows --apply', () => {
    assert.doesNotThrow(() => assertRestoreTarget('', true));
  });

  test('PostgreSQL mode without --apply (restore-test path) is allowed', () => {
    assert.doesNotThrow(() => assertRestoreTarget('postgresql://user:pass@db.example/uws', false));
  });
});

describe('restore-pg: loadDumpBytes (plain and encrypted dumps)', () => {
  test('plain dumps are returned unchanged', () => {
    const dir = tempDir();
    const path = join(dir, 'plain.jsonl');
    const original = Buffer.from('{"uws_dump":1,"dialect":"postgres","created_at":"x","tables":[]}\n', 'utf8');
    writeFileSync(path, original);
    const loaded = loadDumpBytes(path, '');
    assert.equal(Buffer.compare(loaded, original), 0);
  });

  test('encrypted dumps decrypt with the right passphrase', () => {
    const dir = tempDir();
    const path = join(dir, 'enc.jsonl');
    const original = Buffer.from('{"uws_dump":1,"tables":[]}\n', 'utf8');
    writeFileSync(path, encryptBuffer(original, 'test-passphrase'));
    const loaded = loadDumpBytes(path, 'test-passphrase');
    assert.equal(Buffer.compare(loaded, original), 0);
  });

  test('encrypted dump without a passphrase fails loudly (never guesses)', () => {
    const dir = tempDir();
    const path = join(dir, 'enc2.jsonl');
    writeFileSync(path, encryptBuffer(Buffer.from('x'), 'pw'));
    assert.throws(
      () => loadDumpBytes(path, ''),
      (err: unknown) => err instanceof AppError && err.code === 'validation_failed' && /BACKUP_PASSPHRASE/.test(err.message),
    );
  });

  test('encrypted dump with a wrong passphrase fails (GCM tag check)', () => {
    const dir = tempDir();
    const path = join(dir, 'enc3.jsonl');
    writeFileSync(path, encryptBuffer(Buffer.from('x'), 'right-pw'));
    assert.throws(() => loadDumpBytes(path, 'wrong-pw'));
  });
});
