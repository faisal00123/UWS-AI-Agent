/**
 * PostgreSQL driver (Supabase) for the shared DB interface.
 *
 * - SQL stays in the SQLite dialect in application code; prepare() runs it
 *   through the translator (db/dialect.ts) exactly once per statement.
 * - Transactions pin one pooled connection via AsyncLocalStorage so every
 *   statement issued inside the callback lands on that connection.
 * - Parameter and result shapes are normalized to the node:sqlite behaviour
 *   this codebase was written against: booleans bind as 0/1 (columns are
 *   INTEGER), Dates bind as ISO-8601 TEXT, and int8/numeric results come
 *   back as JS numbers (COUNT(*), SUM(...)).
 * - Connection failures throw; there is deliberately NO fallback to a local
 *   database. An unreachable expected database must fail loudly (see
 *   db/identity.ts).
 */
import { Pool, types } from 'pg';
import { toPostgres } from './dialect.ts';
import { inTxOn, txStore } from './txcontext.ts';
import type { DB, PgConn, PgExecutor, PgResult, RunResult, SqlParam, Stmt } from './types.ts';

// node-postgres returns int8 (COUNT(*), ...) and numeric (SUM(...)) as
// strings by default. Every value in this application fits in a JS number.
types.setTypeParser(20, (v: string) => Number(v));
types.setTypeParser(1700, (v: string) => Number(v));

function normalizeParams(params: SqlParam[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p === null) return null;
    if (typeof p === 'boolean') return p ? 1 : 0;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'bigint') return Number(p);
    if (p instanceof Uint8Array && !Buffer.isBuffer(p)) return Buffer.from(p);
    return p;
  });
}

interface ReleasableConn extends PgConn {
  release(): void;
}

class PgStmt implements Stmt {
  private readonly db: PostgresDb;
  private readonly sql: string;

  constructor(db: PostgresDb, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  private async exec(params: SqlParam[]): Promise<PgResult> {
    const values = normalizeParams(params);
    const pinned = inTxOn(this.db);
    if (pinned?.client) return pinned.client.query(this.sql, values);
    return this.db.executor.query(this.sql, values);
  }

  async get(...params: SqlParam[]): Promise<unknown> {
    const res = await this.exec(params);
    return res.rows[0];
  }

  async all(...params: SqlParam[]): Promise<unknown[]> {
    const res = await this.exec(params);
    return res.rows;
  }

  async run(...params: SqlParam[]): Promise<RunResult> {
    const res = await this.exec(params);
    const first = res.rows[0] as Record<string, unknown> | undefined;
    const rowid =
      first && first.id !== undefined && first.id !== null
        ? Number(first.id)
        : 0;
    return { changes: res.rowCount, lastInsertRowid: rowid };
  }
}

export class PostgresDb implements DB {
  readonly dialect = 'postgres' as const;
  readonly executor: PgExecutor;

  constructor(executor: PgExecutor) {
    this.executor = executor;
  }

  prepare(sql: string): Stmt {
    return new PgStmt(this, toPostgres(sql));
  }

  async exec(sql: string): Promise<void> {
    const translated = toPostgres(sql);
    const pinned = inTxOn(this);
    if (pinned?.client) {
      await pinned.client.exec(translated);
      return;
    }
    await this.executor.exec(translated);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const existing = inTxOn(this);
    if (existing?.client) {
      // Nested transaction on the pinned connection -> savepoint.
      const name = `sp_${existing.depth + 1}`;
      await existing.client.query(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        await existing.client.query(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        try {
          await existing.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
          await existing.client.query(`RELEASE SAVEPOINT ${name}`);
        } catch {
          /* rollback failure must not mask the original error */
        }
        throw err;
      }
    }
    const conn = await this.executor.acquire();
    try {
      await conn.query('BEGIN');
      try {
        const result = await txStore.run({ db: this, client: conn, depth: 0 }, fn);
        await conn.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await conn.query('ROLLBACK');
        } catch {
          /* rollback failure must not mask the original error */
        }
        throw err;
      }
    } finally {
      await this.executor.release(conn);
    }
  }

  async close(): Promise<void> {
    await this.executor.end();
  }
}

export interface PoolOptions {
  /** Max pooled connections (kept small: free tiers count every connection). */
  max?: number;
  /** Application name shown in pg_stat_activity. */
  applicationName?: string;
  /** Server-side statement timeout (ms); 0 disables. */
  statementTimeoutMs?: number;
}

/** pg.Pool-backed executor used in production. */
export class PoolExecutor implements PgExecutor {
  private readonly pool: Pool;

  constructor(connectionString: string, opts: PoolOptions = {}) {
    this.pool = new Pool({
      connectionString,
      max: opts.max ?? 5,
      connectionTimeoutMillis: 10_000,
      idleTimeoutMillis: 30_000,
      application_name: opts.applicationName ?? 'uws-ai-agent',
    });
    // Idle-client errors must never crash the process; the next checkout
    // transparently gets a fresh connection.
    this.pool.on('error', (err: Error) => {
      process.stderr.write(`[pg] idle connection error: ${err.message}\n`);
    });
    if (opts.statementTimeoutMs && opts.statementTimeoutMs > 0) {
      const ms = Math.floor(opts.statementTimeoutMs);
      this.pool.on('connect', (client) => {
        void client.query(`SET statement_timeout = ${ms}`).catch(() => {
          /* best effort */
        });
      });
    }
  }

  async query(text: string, values?: unknown[]): Promise<PgResult> {
    const res = await this.pool.query(text, values);
    return { rows: res.rows as unknown[], rowCount: res.rowCount ?? 0 };
  }

  async acquire(): Promise<PgConn> {
    const client = await this.pool.connect();
    return {
      query: async (text: string, values?: unknown[]) => {
        const res = await client.query(text, values);
        return { rows: res.rows as unknown[], rowCount: res.rowCount ?? 0 };
      },
      exec: async (text: string) => {
        await client.query(text);
      },
      release: () => client.release(),
    } as ReleasableConn;
  }

  async release(conn: PgConn): Promise<void> {
    (conn as ReleasableConn).release();
  }

  async exec(text: string): Promise<void> {
    // No parameters: node-postgres uses the simple-query protocol, which
    // executes every statement in the script (required for migrations).
    await this.pool.query(text);
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Open a PostgreSQL database from a connection string (DATABASE_URL).
 * Throws on failure — callers must treat that as fatal; there is no
 * silent fallback to SQLite anywhere in this codebase.
 */
export function openPostgres(connectionString: string, opts: PoolOptions = {}): DB {
  if (!connectionString) throw new Error('openPostgres requires a connection string');
  return new PostgresDb(new PoolExecutor(connectionString, opts));
}
