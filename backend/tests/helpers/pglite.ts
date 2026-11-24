/**
 * PGlite-backed test database: a REAL PostgreSQL server compiled to WASM,
 * running in-process with no network and no external services.
 *
 * It implements the app's PgExecutor interface, so tests exercise the exact
 * production driver (src/db/postgres.ts — SQL dialect translation, AsyncLocal-
 * Storage transactions/savepoints, parameter normalisation) instead of a mock.
 *
 * The citext extension is registered up front because the app's PG migrations
 * run `CREATE EXTENSION IF NOT EXISTS citext` (case-insensitive email columns).
 * Tests must `await runMigrations(db)` before any citext-dependent query —
 * the extension type only exists after migration 001 runs.
 *
 * One PGlite instance = one in-memory Postgres. Always close it in `after()`.
 */
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import { PostgresDb } from '../../src/db/postgres.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import type { DB, PgConn, PgExecutor, PgResult } from '../../src/db/types.ts';

/**
 * PgExecutor over a single PGlite connection. PGlite is single-connection by
 * nature: acquire()/release() are no-ops because every query already lands on
 * the same backend, which is exactly what a transaction needs.
 */
export class PgliteExecutor implements PgExecutor {
  private readonly pglite: PGlite;

  constructor(pglite: PGlite) {
    this.pglite = pglite;
  }

  async query(text: string, values?: unknown[]): Promise<PgResult> {
    const res = await this.pglite.query(text, values);
    // SELECTs report rowCount from the command tag; fall back defensively.
    const rowCount = res.rowCount ?? res.affectedRows ?? res.rows.length;
    return { rows: res.rows as unknown[], rowCount };
  }

  async acquire(): Promise<PgConn> {
    return {
      query: (text: string, values?: unknown[]): Promise<PgResult> => this.query(text, values),
      exec: async (text: string): Promise<void> => {
        await this.pglite.exec(text);
      },
    };
  }

  async release(): Promise<void> {
    /* single shared connection — nothing to return */
  }

  async exec(text: string): Promise<void> {
    await this.pglite.exec(text);
  }

  async end(): Promise<void> {
    await this.pglite.close();
  }
}

export interface PgliteHandle {
  /** The app's DB handle (postgres dialect) — pass this to services. */
  db: DB;
  /** Raw PGlite instance, for direct catalog/inspection queries. */
  raw: PGlite;
}

/**
 * Boot an in-memory Postgres with citext registered.
 * `migrate: false` leaves the schema empty (for testing migration/dry-run
 * behaviour); the default runs the app's PG migrations 001..012.
 */
export async function openPgliteDatabase(opts: { migrate?: boolean } = {}): Promise<PgliteHandle> {
  const raw = new PGlite({ extensions: { citext } });
  await raw.waitReady;
  const db = new PostgresDb(new PgliteExecutor(raw));
  if (opts.migrate !== false) {
    await runMigrations(db);
  }
  return { db, raw };
}

/** COUNT(*) helper that works on any row shape (string keys are not assumed). */
export async function countOf(db: DB, sql: string): Promise<number> {
  const row = (await db.prepare(sql).get()) as Record<string, unknown>;
  const value = Object.values(row)[0];
  return Number(value);
}
