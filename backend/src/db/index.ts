/**
 * SQLite connection + transaction helpers.
 *
 * Integrity configuration is applied on every connection:
 *   - foreign_keys ON  : relationships are enforced by the database
 *   - journal_mode WAL : concurrent readers during writes
 *   - busy_timeout     : writers wait instead of failing under load
 *   - synchronous NORMAL: durable enough for WAL, fast enough for our volume
 */
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { nowIso } from '../core/time.ts';

export type DB = DatabaseSync;

let openCount = 0;

export function openDatabase(path: string): DB {
  const isMemory = path === ':memory:' || path.startsWith('file::memory:');
  if (!isMemory) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }
  const db = new DatabaseSync(path, { enableForeignKeyConstraints: true });
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA temp_store = MEMORY;');
  openCount += 1;
  return db;
}

export function closeDatabase(db: DB): void {
  try {
    db.exec('PRAGMA optimize;');
  } catch {
    /* best effort */
  }
  db.close();
  openCount -= 1;
}

export function openDatabaseCount(): number {
  return openCount;
}

/** Run `fn` inside an IMMEDIATE transaction; rolls back on any throw. */
export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* rollback failure must not mask the original error */
    }
    throw err;
  }
}

/** Convenience: first row or undefined. */
export function one<T>(stmt: StatementSync, ...params: unknown[]): T | undefined {
  return stmt.get(...(params as never[])) as T | undefined;
}

export function all<T>(stmt: StatementSync, ...params: unknown[]): T[] {
  return stmt.all(...(params as never[])) as T[];
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
