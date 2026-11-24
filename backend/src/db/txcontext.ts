/**
 * Transaction context propagation.
 *
 * A transaction pins one connection for the duration of its callback. Every
 * statement issued in the same async context (AsyncLocalStorage) must use
 * that connection — otherwise a pooled driver would silently run parts of
 * the transaction on other connections.
 *
 * The store also tells the SQLite driver which statements are already
 * inside its (mutex-held) transaction so they do not deadlock waiting for
 * the mutex they already own.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DB, PgConn } from './types.ts';

export interface TxState {
  /** The handle whose transaction is active. */
  db: DB;
  /** Pinned connection (PostgreSQL); null for SQLite (single connection). */
  client: PgConn | null;
  /** Nesting depth (0 = real transaction, >0 = savepoint). */
  depth: number;
}

export const txStore = new AsyncLocalStorage<TxState>();

/** True when the current async context is inside a transaction on `db`. */
export function inTxOn(db: DB): TxState | undefined {
  const state = txStore.getStore();
  return state && state.db === db ? state : undefined;
}
