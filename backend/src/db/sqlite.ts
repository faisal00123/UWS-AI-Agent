/**
 * SQLite driver: async wrapper over node:sqlite's synchronous DatabaseSync.
 *
 * Why a mutex: the synchronous engine executed whole service functions
 * atomically (no interleaving). Once those functions contain `await`, two
 * concurrent flows could interleave statements — worst case one flow's
 * statements would join another flow's open transaction. The mutex is held
 * for the duration of a transaction, and statements issued inside the
 * transaction's own async context bypass it (they already own it), which
 * also keeps nested helpers deadlock-free.
 */
import { DatabaseSync } from 'node:sqlite';
import type { DB, RunResult, SqlParam, Stmt } from './types.ts';
import { inTxOn, txStore } from './txcontext.ts';
import { Mutex } from './mutex.ts';

function toParams(params: SqlParam[]): unknown[] {
  return params.map((p) => {
    if (p === undefined) return null;
    if (p instanceof Date) return p.toISOString();
    if (typeof p === 'boolean') return p ? 1 : 0;
    return p;
  });
}

class SqliteStmt implements Stmt {
  private readonly db: SqliteDb;
  private readonly sql: string;

  constructor(db: SqliteDb, sql: string) {
    this.db = db;
    this.sql = sql;
  }

  private execSync<T>(fn: () => T): Promise<T> {
    // Inside our own transaction: already serialized by the tx holder.
    if (inTxOn(this.db)) return Promise.resolve(fn());
    return this.db.mutex.run(fn);
  }

  async get(...params: SqlParam[]): Promise<unknown> {
    return this.execSync(() => this.db.raw.prepare(this.sql).get(...(toParams(params) as never[])));
  }

  async all(...params: SqlParam[]): Promise<unknown[]> {
    return this.execSync(() => this.db.raw.prepare(this.sql).all(...(toParams(params) as never[])) as unknown[]);
  }

  async run(...params: SqlParam[]): Promise<RunResult> {
    return this.execSync(() => {
      const res = this.db.raw.prepare(this.sql).run(...(toParams(params) as never[]));
      const rowid = typeof res.lastInsertRowid === 'bigint' ? Number(res.lastInsertRowid) : res.lastInsertRowid;
      return { changes: Number(res.changes), lastInsertRowid: Number(rowid ?? 0) };
    });
  }
}

export class SqliteDb implements DB {
  readonly dialect = 'sqlite' as const;
  readonly mutex = new Mutex();
  private closed = false;
  readonly raw: DatabaseSync;

  constructor(raw: DatabaseSync) {
    this.raw = raw;
  }

  prepare(sql: string): Stmt {
    return new SqliteStmt(this, sql);
  }

  async exec(sql: string): Promise<void> {
    const run = () => {
      if (this.closed) throw new Error('database is closed');
      this.raw.exec(sql);
    };
    if (inTxOn(this)) run();
    else await this.mutex.run(run);
  }

  async transaction<T>(fn: () => T | Promise<T>): Promise<T> {
    const existing = inTxOn(this);
    if (existing) {
      // Nested transaction on the same handle -> savepoint.
      const depth = existing.depth + 1;
      const name = `sp_${depth}`;
      this.raw.exec(`SAVEPOINT ${name}`);
      try {
        const result = await fn();
        this.raw.exec(`RELEASE ${name}`);
        return result;
      } catch (err) {
        try {
          this.raw.exec(`ROLLBACK TO ${name}`);
          this.raw.exec(`RELEASE ${name}`);
        } catch {
          /* rollback failure must not mask the original error */
        }
        throw err;
      }
    }
    return this.mutex.run(async () => {
      this.raw.exec('BEGIN IMMEDIATE');
      try {
        const result = await txStore.run({ db: this, client: null, depth: 0 }, fn);
        this.raw.exec('COMMIT');
        return result;
      } catch (err) {
        try {
          this.raw.exec('ROLLBACK');
        } catch {
          /* rollback failure must not mask the original error */
        }
        throw err;
      }
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.mutex.run(() => {
      if (this.closed) return;
      try {
        this.raw.exec('PRAGMA optimize;');
      } catch {
        /* best effort */
      }
      this.raw.close();
      this.closed = true;
    });
  }
}
