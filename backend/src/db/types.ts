/**
 * Database abstraction shared by the SQLite and PostgreSQL drivers.
 *
 * The application previously used `node:sqlite`'s synchronous DatabaseSync
 * directly. PostgreSQL drivers are asynchronous by nature, so every data
 * access goes through this async interface: statements return Promises and
 * transactions are routed through AsyncLocalStorage (see db/txcontext.ts) so
 * the same repository code runs unchanged on both engines.
 *
 * SQL is written in the existing SQLite-flavoured dialect with `?`
 * placeholders; the PostgreSQL driver translates it at prepare() time
 * (see db/dialect.ts).
 */

/** Which engine a DB handle is bound to. */
export type Dialect = 'sqlite' | 'postgres';

/** Values accepted as bound parameters (normalized per driver). */
export type SqlParam = string | number | bigint | boolean | null | undefined | Uint8Array | Date;

/** Result of INSERT/UPDATE/DELETE. */
export interface RunResult {
  /** Rows affected. */
  changes: number;
  /**
   * INTEGER rowid of the inserted row when the statement exposes it
   * (SQLite: lastInsertRowid; PostgreSQL: requires `RETURNING id`).
   */
  lastInsertRowid: number;
}

/** A prepared statement. Methods are async on both drivers. */
export interface Stmt {
  get(...params: SqlParam[]): Promise<unknown>;
  all(...params: SqlParam[]): Promise<unknown[]>;
  run(...params: SqlParam[]): Promise<RunResult>;
}

/** Minimal query surface shared by pg.Pool clients and PGlite in tests. */
export interface PgResult {
  rows: unknown[];
  rowCount: number;
}

export interface PgConn {
  query(text: string, values?: unknown[]): Promise<PgResult>;
  /** Multi-statement script on this connection (no parameters). */
  exec(text: string): Promise<void>;
}

/**
 * Executor behind the PostgreSQL driver. Production uses a pg.Pool-backed
 * implementation; tests inject a PGlite-backed one (real Postgres, in
 * process) the same way AppDeps injects fake fetch adapters.
 */
export interface PgExecutor {
  /** Query on any pooled connection (outside an explicit transaction). */
  query(text: string, values?: unknown[]): Promise<PgResult>;
  /** Check out a dedicated connection for a transaction. */
  acquire(): Promise<PgConn>;
  /** Return a connection acquired with acquire(). */
  release(conn: PgConn): Promise<void>;
  /** Execute a multi-statement script (DDL/migrations), no parameters. */
  exec(text: string): Promise<void>;
  /** Close the executor (pool.end() / PGlite.close()). */
  end(): Promise<void>;
}

/** The application's database handle. */
export interface DB {
  readonly dialect: Dialect;
  /** Prepare a statement (SQL translation happens here for PostgreSQL). */
  prepare(sql: string): Stmt;
  /** Execute one or more statements with no parameters (DDL/scripts). */
  exec(sql: string): Promise<void>;
  /**
   * Run fn inside a transaction. Rolls back on throw. Statements issued
   * anywhere in the same async context route to the transaction's
   * connection automatically (AsyncLocalStorage), so fn may call existing
   * repository functions with the same db handle.
   *
   * Nested transaction() calls on the same handle become SAVEPOINTs.
   */
  transaction<T>(fn: () => T | Promise<T>): Promise<T>;
  /** Close the connection(s). Safe to call more than once. */
  close(): Promise<void>;
}
