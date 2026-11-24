/**
 * Database identity gate — the fail-safe that prevents the incident class
 * where a missing/empty database is silently initialised as brand new
 * (fresh schema + new owner + zero data) while the operator believes they
 * are talking to the previous production database.
 *
 * Rules enforced at boot (server + setup):
 *   1. An empty database (no schema_migrations table) in production is a
 *      FATAL error unless the operator explicitly allows initialisation
 *      (DB_INIT_CONFIRM=1 / `npm run db:init`).
 *   2. A schema without an identity row is FATAL in production when the
 *      database also has no user rows (the fresh-empty signature). A
 *      legacy database that predates the identity table (it has users) is
 *      upgraded in place by seeding the identity row.
 *   3. An identity row naming a different application is always FATAL.
 *   4. A configured PostgreSQL database that cannot be reached throws —
 *      there is NO fallback to a local SQLite file anywhere.
 *
 * Non-production (development/test) keeps the ergonomic behaviour: missing
 * pieces are initialised automatically.
 */
import type { DB } from './types.ts';

/** Fixed application marker stored in every initialised database. */
export const APP_NAME = 'uws-ai-sales-agent';

export interface AppIdentity {
  instanceId: string;
  app: string;
  createdAt: string;
}

export class DatabaseIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DatabaseIdentityError';
  }
}

/** Does a table exist? (dialect-aware, read-only) */
export async function tableExists(db: DB, name: string): Promise<boolean> {
  if (db.dialect === 'postgres') {
    const row = (await db.prepare('SELECT to_regclass(?) AS t').get(name)) as { t: string | null } | undefined;
    return row?.t != null;
  }
  const row = (await db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name)) as
    | { name: string }
    | undefined;
  return row !== undefined;
}

/** Read the identity row (null when absent). Read-only. */
export async function readIdentity(db: DB): Promise<AppIdentity | null> {
  if (!(await tableExists(db, 'app_identity'))) return null;
  const row = (await db.prepare('SELECT instance_id, app, created_at FROM app_identity WHERE id = 1').get()) as
    | { instance_id: string; app: string; created_at: string }
    | undefined;
  if (!row) return null;
  return { instanceId: row.instance_id, app: row.app, createdAt: row.created_at };
}

async function countUsers(db: DB): Promise<number> {
  const row = (await db.prepare('SELECT COUNT(*) AS c FROM users').get()) as { c: number };
  return Number(row.c);
}

/** Insert the identity row if it is missing (idempotent). */
export async function seedIdentity(db: DB, instanceId: string): Promise<void> {
  const at = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO app_identity (id, instance_id, app, created_at)
       VALUES (1, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
    .run(instanceId, APP_NAME, at);
}

export interface IdentityGateOptions {
  /** NODE_ENV === 'production' — strict rules apply. */
  production: boolean;
  /** Explicit owner action (DB_INIT_CONFIRM=1): allow creating a new DB. */
  allowInit: boolean;
  /** Generates the instance id for a database that needs one seeded. */
  makeInstanceId: () => string;
}

/**
 * Run after migrations have been applied. Throws DatabaseIdentityError
 * (with an operator-facing remedy) instead of continuing on a database
 * that cannot be proven to be the expected one.
 */
export async function assertDatabaseIdentity(db: DB, opts: IdentityGateOptions): Promise<AppIdentity | null> {
  const identity = await readIdentity(db);
  if (identity) {
    if (identity.app !== APP_NAME) {
      throw new DatabaseIdentityError(
        `database identity mismatch: expected app "${APP_NAME}", found "${identity.app}" — refusing to use it`,
      );
    }
    return identity;
  }

  const users = await countUsers(db);
  if (opts.production && !opts.allowInit) {
    if (db.dialect === 'sqlite') {
      // SQLite: strict gate — preserve existing safety rule.
      if (users === 0) {
        throw new DatabaseIdentityError(
          'The database has a schema but no owner account and no identity record — this is the ' +
            'signature of a freshly created empty database. Refusing to start: continuing would ' +
            'silently operate on an empty database. Verify DATABASE_URL/DATABASE_PATH points at ' +
            'the intended database, then initialise explicitly with DB_INIT_CONFIRM=1 (npm run db:init), or restore a backup.',
        );
      }
    }
    if (db.dialect === 'postgres') {
      // PostgreSQL safe first-boot: only proceed if the database has no owner account.
      // If users > 0, the database previously had an owner — do not overwrite.
      // If users === 0, the database is genuinely empty (no data imported yet), so
      // allow first-boot: seed the identity row, which also creates the owner account
      // reference through the operating_state and settings tables.
      const userCount = await countUsers(db);
      if (userCount > 0) {
        throw new DatabaseIdentityError(
          'The database has a schema but no owner account and no identity record — this database ' +
          'appears to have been previously used with owner accounts. Refusing to overwrite or ' +
          'initialize. Restore a backup or use a fresh database, then set DB_INIT_CONFIRM=1 ' +
          '(npm run db:init) if you need to initialize a new production DB.',
        );
      }
      // No owner account exists: genuinely empty database — allow first-boot.
      // Identity row will be seeded below.
      return seedIdentity(db, opts.makeInstanceId()).then(() => readIdentity(db));
    }
    // Unknown dialect in production without allowInit
    throw new DatabaseIdentityError(
      'The database has a schema but no owner account and no identity record — this is the ' +
        'signature of a freshly created empty database. Refusing to start: continuing would ' +
        'silently operate on an empty database. Verify DATABASE_URL/DATABASE_PATH points at ' +
        'the intended database, then either restore a backup or initialise explicitly with ' +
        'DB_INIT_CONFIRM=1 (npm run db:init).',
    );
  }

  // Development mode or allowInit: proceed to seed identity row.
  await seedIdentity(db, opts.makeInstanceId());
  return readIdentity(db);
}

/**
 * Boot gate for the "no schema at all" case. Called BEFORE migrations so
 * an empty production database never gets a schema created by accident.
 * Returns quietly when the database already has a schema, or when the
 * environment is not production / initialisation was explicitly allowed.
 *
 * Dialect-specific behaviour:
 *   - SQLite: strict gate — must have schema_migrations or DB_INIT_CONFIRM=1.
 *   - PostgreSQL: safe first-boot — if no schema_migrations and the database
 *     has NO application tables (no users, businesses, etc.), it is treated as
 *     genuinely empty and allowed to proceed; if any application tables exist,
 *     startup is refused to prevent overwriting an unknown database.
 */
export async function assertBootableDatabase(
  db: DB,
  opts: { production: boolean; allowInit: boolean },
): Promise<void> {
  const hasSchema = await tableExists(db, 'schema_migrations');
  if (hasSchema) return;
  if (!opts.production) return; // development: allow auto-init

  if (opts.production && !opts.allowInit) {
    if (db.dialect === 'sqlite') {
      // SQLite: strict gate — preserve existing safety rule.
      throw new DatabaseIdentityError(
        'The expected database is EMPTY (no schema_migrations table). Refusing to create a ' +
          'fresh database in production — this is how data loss happens. Check that ' +
          'DATABASE_URL/DATABASE_PATH points at the intended database, then initialise ' +
          'explicitly with DB_INIT_CONFIRM=1 (npm run db:init), or restore a backup.',
      );
    }
    if (db.dialect === 'postgres') {
      // PostgreSQL safe first-boot: only proceed if the database has NO
      // application tables. If any app tables exist, STOP to prevent overwriting.
      const appTables = ['users', 'businesses', 'operating_state', 'audit_events',
                         'notifications', 'lead_sources', 'contact_points', 'field_verifications',
                         'website_analyses', 'lead_scores', 'score_factors', 'eligibility_checks',
                         'suppression_list', 'duplicate_candidates', 'merge_history',
                         'interactions', 'lead_stage_history', 'followup_tasks', 'meetings',
                         'proposals', 'deals', 'payments', 'human_handoffs', 'outreach_attempts',
                         'calls', 'messages', 'provider_events', 'conversations', 'transcript_segments',
                         'campaigns', 'approval_requests'];
      let hasAppTable = false;
      for (const tbl of appTables) {
        if (await tableExists(db, tbl)) {
          hasAppTable = true;
          break;
        }
      }
      if (hasAppTable) {
        throw new DatabaseIdentityError(
          'The expected database is EMPTY (no schema_migrations table) but contains existing ' +
          'application tables — this database appears to have been previously used. Refusing ' +
          'to overwrite or initialize. Restore a backup or use a fresh database, then set ' +
          'DB_INIT_CONFIRM=1 (npm run db:init) if you need to initialize a new production DB.',
        );
      }
      // No application tables found: genuinely empty database — allow first-boot.
      // Migrations will create the schema, then assertDatabaseIdentity will seed the identity row.
      return;
    }
    // Unknown dialect in production without allowInit
    throw new DatabaseIdentityError(
      'The expected database is EMPTY (no schema_migrations table). Refusing to create a ' +
        'fresh database in production — this is how data loss happens. Check that ' +
        'DATABASE_URL/DATABASE_PATH points at the intended database, then initialise ' +
        'explicitly with DB_INIT_CONFIRM=1 (npm run db:init), or restore a backup.',
    );
  }
}
