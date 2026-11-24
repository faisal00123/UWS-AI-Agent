/**
 * Migration runner.
 *
 * - Plain SQL files applied in filename order:
 *     SQLite      -> ./migrations/*.sql
 *     PostgreSQL  -> ./migrations/pg/*.sql   (same numbering/checksums model)
 * - Each file runs inside its own transaction: a failing migration leaves the
 *   database untouched.
 * - Applied files are checksummed; editing an already-applied migration is a
 *   hard error (schema drift cannot happen silently).
 * - Foreign-key toggling/`PRAGMA foreign_key_check` are SQLite-only; the
 *   PostgreSQL schema relies on correct creation order and immediate FK
 *   enforcement (verified by the test suite).
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './types.ts';
import { nowIso } from '../core/time.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
export const MIGRATIONS_DIR = join(HERE, 'migrations');

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/** Directory holding the migration files for this dialect. */
export function migrationsDirFor(db: DB): string {
  return db.dialect === 'postgres' ? join(MIGRATIONS_DIR, 'pg') : MIGRATIONS_DIR;
}

async function ensureMigrationsTable(db: DB): Promise<void> {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name        TEXT PRIMARY KEY,
      checksum    TEXT NOT NULL,
      applied_at  TEXT NOT NULL,
      duration_ms INTEGER NOT NULL DEFAULT 0
    );
  `);
}

export function listMigrationFiles(dir = MIGRATIONS_DIR): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));
}

export async function runMigrations(db: DB, dir?: string): Promise<MigrationResult> {
  const target = dir ?? migrationsDirFor(db);
  await ensureMigrationsTable(db);
  const files = listMigrationFiles(target);
  const rows = (await db.prepare('SELECT name, checksum FROM schema_migrations').all()) as {
    name: string;
    checksum: string;
  }[];
  const applied = new Map(rows.map((r) => [r.name, r.checksum]));

  const result: MigrationResult = { applied: [], skipped: [] };
  const isSqlite = db.dialect === 'sqlite';

  // Rebuilding a table (e.g. to change a CHECK constraint, as 007 does) drops
  // the old table. With foreign keys enforced, that drop fires ON DELETE
  // actions on every child row and would silently null their references.
  // SQLite also ignores PRAGMA foreign_keys *inside* a transaction, so the
  // toggle has to happen around the migration run, never within it.
  // PostgreSQL has no equivalent problem (drop order is enforced by the
  // server) — and no portable way to disable FKs without superuser rights.
  let fkBefore = false;
  if (isSqlite) {
    fkBefore = ((await db.prepare('PRAGMA foreign_keys').get()) as { foreign_keys: number }).foreign_keys === 1;
    await db.exec('PRAGMA foreign_keys = OFF');
    const stillOn = ((await db.prepare('PRAGMA foreign_keys').get()) as { foreign_keys: number }).foreign_keys === 1;
    if (stillOn) {
      throw new Error('Could not disable foreign_keys — a transaction is open. Run migrations outside a transaction.');
    }
  }

  try {
    for (const file of files) {
      const sql = readFileSync(join(target, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex').slice(0, 32);
      const previous = applied.get(file);
      if (previous !== undefined) {
        if (previous !== checksum) {
          throw new Error(
            `Migration "${file}" was modified after it was applied ` +
              `(recorded ${previous}, actual ${checksum}). ` +
              `Create a new migration instead of editing an applied one.`,
          );
        }
        result.skipped.push(file);
        continue;
      }
      const started = Date.now();
      try {
        await db.transaction(async () => {
          await db.exec(sql);
          await db
            .prepare('INSERT INTO schema_migrations (name, checksum, applied_at, duration_ms) VALUES (?, ?, ?, ?)')
            .run(file, checksum, nowIso(), Date.now() - started);
        });
      } catch (err) {
        throw new Error(`Migration "${file}" failed: ${err instanceof Error ? err.message : String(err)}`, {
          cause: err,
        });
      }
      result.applied.push(file);
    }
  } finally {
    if (isSqlite) {
      await db.exec(fkBefore ? 'PRAGMA foreign_keys = ON' : 'PRAGMA foreign_keys = OFF');
    }
  }

  // Rebuilds can leave dangling references if something was missed; surface
  // that here rather than at a random later delete. (SQLite-only: PostgreSQL
  // enforces referential integrity on every statement.)
  if (isSqlite) {
    const violations = (await db.prepare('PRAGMA foreign_key_check').all()) as unknown[];
    if (violations.length > 0) {
      throw new Error(
        `Migration foreign_key_check failed: ${violations.length} dangling reference(s). ` +
          `First: ${JSON.stringify(violations[0])}`,
      );
    }
  }
  return result;
}

/** Migration files not yet applied, in order. Used by health checks/doctor. */
export async function pendingMigrationFiles(db: DB, dir?: string): Promise<string[]> {
  const target = dir ?? migrationsDirFor(db);
  await ensureMigrationsTable(db);
  const files = listMigrationFiles(target);
  const rows = (await db.prepare('SELECT name FROM schema_migrations').all()) as { name: string }[];
  const appliedSet = new Set(rows.map((r) => r.name));
  return files.filter((f) => !appliedSet.has(f));
}

/** True when pending migrations exist (i.e. the schema is behind). Used by health checks/tests. */
export async function hasPendingMigrations(db: DB, dir?: string): Promise<boolean> {
  return (await pendingMigrationFiles(db, dir)).length > 0;
}
