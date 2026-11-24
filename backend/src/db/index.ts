/**
 * Database entry points.
 *
 * Two engines share one interface (db/types.ts):
 *   - SQLite  (node:sqlite)  : local development and the existing test suite
 *   - PostgreSQL (pg)        : production via Supabase (DATABASE_URL)
 *
 * Selection is explicit: when config.databaseUrl is set the PostgreSQL
 * driver is used and there is NO fallback to a local file if it fails —
 * a missing expected database must fail loudly (db/identity.ts).
 *
 * Integrity configuration for SQLite is applied on every connection:
 *   - foreign_keys ON  : relationships are enforced by the database
 *   - journal_mode WAL : concurrent readers during writes
 *   - busy_timeout     : writers wait instead of failing under load
 *   - synchronous NORMAL: durable enough for WAL, fast enough for our volume
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nowIso } from '../core/time.ts';
import { SqliteDb } from './sqlite.ts';
import { openPostgres } from './postgres.ts';
import type { DB } from './types.ts';

export type { DB, Stmt, RunResult, Dialect, SqlParam, PgExecutor, PgConn, PgResult } from './types.ts';
export { SqliteDb } from './sqlite.ts';
export { PostgresDb, PoolExecutor, openPostgres } from './postgres.ts';
export { Mutex } from './mutex.ts';
export { toPostgres, clearDialectCache } from './dialect.ts';
export {
  APP_NAME,
  DatabaseIdentityError,
  assertBootableDatabase,
  assertDatabaseIdentity,
  readIdentity,
  seedIdentity,
  tableExists,
} from './identity.ts';
export type { AppIdentity } from './identity.ts';

let openCount = 0;

export function openDatabase(path: string): DB {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');
  if (!isMemory) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const raw = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  raw.exec('PRAGMA journal_mode = WAL;');
  raw.exec('PRAGMA synchronous = NORMAL;');
  raw.exec('PRAGMA busy_timeout = 5000;');
  raw.exec('PRAGMA foreign_keys = ON;');
  raw.exec('PRAGMA temp_store = MEMORY;');
  openCount += 1;
  return new SqliteDb(raw);
}

/**
 * Open the database selected by configuration:
 *   - databaseUrl set  -> PostgreSQL (Supabase); failures throw
 *   - otherwise        -> SQLite at databasePath
 */
export function openFromConfig(config: {
  databaseUrl: string;
  databasePath: string;
  dbPoolMax: number;
  dbStatementTimeoutMs: number;
}): DB {
  if (config.databaseUrl) {
    return openPostgres(config.databaseUrl, {
      max: config.dbPoolMax,
      applicationName: 'uws-ai-agent',
      statementTimeoutMs: config.dbStatementTimeoutMs,
    });
  }
  return openDatabase(config.databasePath);
}

export async function closeDatabase(db: DB): Promise<void> {
  await db.close();
  openCount = Math.max(0, openCount - 1);
}

export function openDatabaseCount(): number {
  return openCount;
}

/**
 * Run `fn` inside a transaction; rolls back on any throw.
 * Statements issued inside `fn` route to the transaction's connection
 * automatically (AsyncLocalStorage), so the same `db` handle can be passed
 * to repository functions unchanged.
 */
export async function tx<T>(db: DB, fn: () => T | Promise<T>): Promise<T> {
  return db.transaction(fn);
}

/** SQLite has no boolean type: 0/1 in, boolean out. */
export function bool(v: unknown): boolean {
  return v === 1 || v === true;
}
export function bit(v: boolean | undefined | null): number {
  return v ? 1 : 0;
}

/** ISO timestamp for "now" used consistently across the schema. */
export function now(): string {
  return nowIso();
}

/**
 * JSON column helper - never throws on read so a corrupt row cannot take down
 * a list endpoint; returns the fallback and is visible in logs by the caller.
 */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
