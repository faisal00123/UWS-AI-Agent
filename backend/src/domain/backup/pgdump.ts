/**
 * PostgreSQL logical backup format (JSONL + manifest).
 *
 * A PG database cannot be snapshotted with SQLite's `VACUUM INTO`, so the
 * PostgreSQL backup path dumps every public table to a portable JSONL file:
 *
 *   line 1   manifest  {"uws_dump":1,"dialect":"postgres","created_at":"...",
 *                       "tables":[{"name","columns","count","sha256"}, ...]}
 *   line 2+  row lines {"t":"<table>","r":{col:value, ...}}
 *
 * Design rules:
 *   - `schema_migrations` is EXCLUDED: it is runner bookkeeping, recreated by
 *     the migration runner on restore, never application data.
 *   - row lines are sorted within each table before hashing, so the per-table
 *     sha256 is independent of physical row order (heap order can differ
 *     between the source and a restored schema).
 *   - values are normalised to JSON-safe primitives; bytea becomes {"$b64"}.
 *   - the manifest sha256 covers exactly the row lines of that table, so a
 *     restore test can re-serialize restored rows the same way and prove
 *     byte-level content equality — not just "the file opens".
 *
 * Restore target: an ISOLATED schema in the SAME database (never the live
 * `public` schema). The app's own PG migrations are re-run inside that schema
 * (so restored DDL is always the app's real DDL), rows are inserted in FK
 * topological order, counts + content hashes are re-verified, and the schema
 * is dropped afterwards. The live schema is never touched.
 */
import type { DB, SqlParam } from '../../db/index.ts';
import { tx } from '../../db/index.ts';
import { runMigrations, hasPendingMigrations } from '../../db/migrate.ts';
import { nowIso } from '../../core/time.ts';
import { AppError } from '../../core/errors.ts';
import {
  COUNTED_TABLES,
  REQUIRED_TABLES,
  sha256Hex,
  type VerifyCheck,
  type VerifyResult,
} from './format.ts';

export const DUMP_FORMAT_VERSION = 1;

export interface DumpTableEntry {
  name: string;
  columns: string[];
  count: number;
  sha256: string;
}

export interface DumpManifest {
  uws_dump: number;
  dialect: string;
  created_at: string;
  tables: DumpTableEntry[];
}

/** Tables excluded from every dump (runner bookkeeping, not application data). */
const EXCLUDED_TABLES = new Set(['schema_migrations']);

function normValue(v: unknown): unknown {
  if (v === null || v === undefined) return null;
  const t = typeof v;
  if (t === 'string' || t === 'boolean') return v;
  if (t === 'number') return Number.isFinite(v as number) ? v : String(v);
  if (t === 'bigint') return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Buffer.isBuffer(v)) return { $b64: v.toString('base64') };
  if (v instanceof Uint8Array) return { $b64: Buffer.from(v).toString('base64') };
  return String(v);
}

function denormValue(v: unknown): unknown {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    const o = v as Record<string, unknown>;
    if (typeof o['$b64'] === 'string') return Buffer.from(o['$b64'], 'base64');
  }
  return v;
}

async function listTables(db: DB): Promise<string[]> {
  const rows = (await db
    .prepare(`SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`)
    .all()) as { tablename: string }[];
  return rows.map((r) => r.tablename).filter((t) => !EXCLUDED_TABLES.has(t));
}

async function tableColumns(db: DB, table: string): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = ?
        ORDER BY ordinal_position`,
    )
    .all(table)) as { column_name: string }[];
  if (rows.length === 0) throw new AppError('internal_error', `Dump: table "${table}" has no columns`);
  return rows.map((r) => r.column_name);
}

function rowLine(table: string, columns: string[], row: Record<string, unknown>): string {
  const ordered: Record<string, unknown> = {};
  for (const c of columns) ordered[c] = normValue(row[c]);
  return JSON.stringify({ t: table, r: ordered });
}

/** Hash of a table's (sorted) row lines — the manifest content digest. */
export function hashLines(lines: string[]): string {
  return sha256Hex([...lines].sort().join('\n'));
}

export interface DumpResult {
  data: Buffer;
  manifest: DumpManifest;
  counts: Record<string, number>;
}

/**
 * Dumps every public table of a PostgreSQL database to the JSONL format.
 * Read-only with respect to the source: only SELECTs are issued.
 */
export async function dumpDatabase(db: DB): Promise<DumpResult> {
  if (db.dialect !== 'postgres') {
    throw new AppError('internal_error', 'dumpDatabase requires the postgres dialect');
  }
  const tables = await listTables(db);
  const manifestTables: DumpTableEntry[] = [];
  const rowLines: string[] = [];
  const counts: Record<string, number> = {};

  for (const table of tables) {
    const columns = await tableColumns(db, table);
    const rows = (await db.prepare(`SELECT * FROM "${table}"`).all()) as Record<string, unknown>[];
    const lines = rows.map((r) => rowLine(table, columns, r));
    manifestTables.push({ name: table, columns, count: rows.length, sha256: hashLines(lines) });
    rowLines.push(...lines);
    if (COUNTED_TABLES.includes(table)) counts[table] = rows.length;
  }
  // COUNTED_TABLES entries missing from the live database are recorded as -1
  // (same honest convention as the SQLite verifier).
  for (const t of COUNTED_TABLES) if (!(t in counts)) counts[t] = -1;

  const manifest: DumpManifest = {
    uws_dump: DUMP_FORMAT_VERSION,
    dialect: 'postgres',
    created_at: nowIso(),
    tables: manifestTables,
  };
  const data = Buffer.from([JSON.stringify(manifest), ...rowLines].join('\n') + '\n', 'utf8');
  return { data, manifest, counts };
}

export function parseManifest(firstLine: string): DumpManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(firstLine);
  } catch {
    throw new AppError('validation_failed', 'Backup manifest line is not valid JSON');
  }
  const m = parsed as Partial<DumpManifest>;
  if (m.uws_dump !== DUMP_FORMAT_VERSION || !Array.isArray(m.tables)) {
    throw new AppError('validation_failed', 'Backup manifest is not a supported uws_dump document');
  }
  for (const t of m.tables) {
    if (typeof t?.name !== 'string' || !Array.isArray(t.columns) || typeof t.count !== 'number' || typeof t.sha256 !== 'string') {
      throw new AppError('validation_failed', 'Backup manifest has a malformed table entry');
    }
  }
  return m as DumpManifest;
}

/** Splits dump bytes into the manifest and the table -> row-lines map. */
function splitDump(bytes: Buffer): { manifest: DumpManifest; byTable: Map<string, string[]> } {
  const text = bytes.toString('utf8');
  const lines = text.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length === 0) throw new AppError('validation_failed', 'Backup dump is empty');
  const manifest = parseManifest(lines[0]!);
  const byTable = new Map<string, string[]>();
  for (const line of lines.slice(1)) {
    let parsed: { t?: unknown; r?: unknown };
    try {
      parsed = JSON.parse(line) as { t?: unknown; r?: unknown };
    } catch {
      throw new AppError('validation_failed', 'Backup dump contains a malformed row line');
    }
    if (typeof parsed.t !== 'string' || typeof parsed.r !== 'object' || parsed.r === null) {
      throw new AppError('validation_failed', 'Backup dump contains a malformed row line');
    }
    const arr = byTable.get(parsed.t) ?? [];
    arr.push(line);
    byTable.set(parsed.t, arr);
  }
  return { manifest, byTable };
}

/**
 * File-level verification of a logical dump (no database needed): parses the
 * manifest, recomputes every per-table content hash and row count from the
 * file itself, and proves every required table is present.
 */
export function verifyDumpBuffer(bytes: Buffer): VerifyResult {
  const checks: VerifyCheck[] = [];
  const counts: Record<string, number> = {};
  try {
    const { manifest, byTable } = splitDump(bytes);
    checks.push({
      code: 'opens',
      label: 'Parses as a logical JSONL dump',
      passed: true,
      detail: `${manifest.tables.length} table(s), format v${manifest.uws_dump}.`,
    });

    const mismatches: string[] = [];
    for (const t of manifest.tables) {
      const lines = byTable.get(t.name) ?? [];
      const actualCount = lines.length;
      const actualHash = hashLines(lines);
      if (actualCount !== t.count) mismatches.push(`${t.name}: count manifest=${t.count} file=${actualCount}`);
      else if (actualHash !== t.sha256) mismatches.push(`${t.name}: sha256 mismatch`);
      if (COUNTED_TABLES.includes(t.name)) counts[t.name] = actualCount;
    }
    checks.push({
      code: 'manifest_checksums',
      label: 'Manifest row counts and sha256 digests match the file',
      passed: mismatches.length === 0,
      detail:
        mismatches.length === 0
          ? `All ${manifest.tables.length} table digests match.`
          : mismatches.slice(0, 5).join('; '),
    });

    const present = new Set(manifest.tables.map((t) => t.name));
    const missing = REQUIRED_TABLES.filter((t) => !present.has(t));
    checks.push({
      code: 'required_tables',
      label: 'All required tables are present in the dump',
      passed: missing.length === 0,
      detail: missing.length === 0 ? 'OK' : `Missing: ${missing.join(', ')}`,
    });

    for (const t of COUNTED_TABLES) if (!(t in counts)) counts[t] = -1;
    return { ok: checks.every((c) => c.passed), checks, counts };
  } catch (err) {
    checks.push({
      code: 'opens',
      label: 'Parses as a logical JSONL dump',
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, checks, counts: {} };
  }
}

// ------------------------------------------------------- isolated restore ---

export interface IsolatedRestoreResult {
  schema: string;
  ok: boolean;
  checks: VerifyCheck[];
  counts: Record<string, number>;
}

async function fkTopoOrder(db: DB): Promise<string[]> {
  const edges = (await db
    .prepare(
      `SELECT child.relname AS child, parent.relname AS parent
         FROM pg_constraint c
         JOIN pg_class child   ON child.oid  = c.conrelid
         JOIN pg_class parent  ON parent.oid = c.confrelid
         JOIN pg_namespace n   ON n.oid = child.relnamespace
        WHERE c.contype = 'f' AND n.nspname = current_schema()`,
    )
    .all()) as { child: string; parent: string }[];

  const nodes = new Map<string, Set<string>>(); // table -> tables it depends on
  const ensure = (t: string): Set<string> => {
    let s = nodes.get(t);
    if (!s) {
      s = new Set();
      nodes.set(t, s);
    }
    return s;
  };
  for (const e of edges) {
    if (e.child === e.parent) continue; // self-reference: insert after itself is impossible; FK is deferred by our own row order? (none in schema)
    ensure(e.child).add(e.parent);
    ensure(e.parent);
  }
  // Every manifest table participates even with no edges.
  const ordered: string[] = [];
  const emitted = new Set<string>();
  let progress = true;
  const pending = (): string[] => [...nodes.keys()].filter((n) => !emitted.has(n));
  while (progress) {
    progress = false;
    for (const n of pending()) {
      const deps = [...(nodes.get(n) ?? [])].filter((d) => !emitted.has(d));
      if (deps.length === 0) {
        emitted.add(n);
        ordered.push(n);
        progress = true;
      }
    }
  }
  const cyclic = pending();
  if (cyclic.length > 0) {
    throw new AppError('validation_failed', `Foreign-key cycle between tables: ${cyclic.join(', ')}`);
  }
  return ordered;
}

/** Identity (GENERATED ... AS IDENTITY) columns of a table — used to advance sequences after a copy/restore. */
export async function identityColumns(db: DB, table: string): Promise<string[]> {
  const rows = (await db
    .prepare(
      `SELECT a.attname AS col
         FROM pg_attribute a
         JOIN pg_class c      ON c.oid = a.attrelid
         JOIN pg_namespace n  ON n.oid = c.relnamespace
        WHERE n.nspname = current_schema()
          AND c.relname = ?
          AND a.attnum > 0
          AND NOT a.attisdropped
          AND a.attidentity IN ('a', 'd')`,
    )
    .all(table)) as { col: string }[];
  return rows.map((r) => r.col);
}

/**
 * Restores a logical dump into a FRESH, ISOLATED schema of the same database
 * and verifies it (row counts + byte-level content digests), then drops the
 * schema again. The live schema is never read from or written to beyond the
 * catalog queries used to build the restore.
 *
 * Never throws for a data problem: every failure is reported through the
 * returned checks so the caller can record it (matching the SQLite restore
 * test's honest-reporting convention). Structural problems (unparsable dump)
 * return ok=false without creating anything.
 */
export async function restoreDumpIntoIsolatedSchema(db: DB, dump: Buffer): Promise<IsolatedRestoreResult> {
  const checks: VerifyCheck[] = [];
  const counts: Record<string, number> = {};
  const schema = `restore_test_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

  // 0. File-level verification first: never create a schema from a bad file.
  const fileVerify = verifyDumpBuffer(dump);
  checks.push(...fileVerify.checks);
  if (!fileVerify.ok) {
    return { schema, ok: false, checks, counts };
  }
  const manifest = parseManifest(dump.toString('utf8').split(/\r?\n/).find((l) => l.length > 0)!);
  const byTable = new Map<string, Record<string, unknown>[]>();
  {
    const split = splitDump(dump);
    for (const t of manifest.tables) {
      const lines = split.byTable.get(t.name) ?? [];
      byTable.set(
        t.name,
        lines.map((l) => (JSON.parse(l) as { r: Record<string, unknown> }).r),
      );
    }
  }

  let created = false;
  try {
    await tx(db, async () => {
      // 1. Isolated schema + search_path. SET LOCAL scopes the path to this
      //    transaction only — the live search_path is untouched afterwards.
      await db.exec(`CREATE SCHEMA "${schema}"`);
      created = true;
      await db.exec(`SET LOCAL search_path TO "${schema}", public`);
      // Pre-create the bookkeeping table IN THE NEW SCHEMA: without it the
      // runner's `IF NOT EXISTS` would find public.schema_migrations via the
      // search path, skip creation, and then read public's applied list —
      // silently applying zero migrations into the isolated schema.
      await db.exec(
        `CREATE TABLE "${schema}".schema_migrations (
           name TEXT PRIMARY KEY, checksum TEXT NOT NULL,
           applied_at TEXT NOT NULL, duration_ms INTEGER NOT NULL DEFAULT 0)`,
      );
      checks.push({ code: 'schema_created', label: 'Isolated schema created', passed: true, detail: schema });

      // 2. The app's own PG migrations build the DDL inside the schema.
      const migration = await runMigrations(db);
      const pending = await hasPendingMigrations(db);
      checks.push({
        code: 'migrations',
        label: 'App migrations apply inside the isolated schema',
        passed: !pending && migration.applied.length > 0,
        detail: `applied=${migration.applied.length} pending=${pending ? 'yes' : 'no'}`,
      });
      if (pending) throw new AppError('validation_failed', 'Migrations pending after run inside isolated schema');

      // 3. Insert every table's rows in FK dependency order.
      const order = await fkTopoOrder(db);
      const wanted = manifest.tables.map((t) => t.name);
      // `order` covers tables that participate in FK edges; append the rest
      // (edgeless tables) so every dumped table is still inserted.
      const insertOrder = [...order, ...wanted.filter((t) => !order.includes(t))];
      const unknownTables = insertOrder.filter((t) => !wanted.includes(t));
      if (unknownTables.length > 0) {
        checks.push({
          code: 'tables_present',
          label: 'Every dumped table exists after migrations',
          passed: false,
          detail: `Not created by migrations: ${unknownTables.join(', ')}`,
        });
        throw new AppError('validation_failed', `Dump references tables the migrations do not create: ${unknownTables.join(', ')}`);
      }

      // Migrations may seed rows (001 inserts the operating_state
      // placeholder with id=1). The dump is the source of truth for this
      // schema: clear any pre-existing rows first, children before parents
      // (reverse FK order) so NO ACTION constraints never block the
      // delete — otherwise the seeded singleton collides with the restored
      // row on its primary key.
      for (const table of [...insertOrder].reverse()) {
        await db.exec(`DELETE FROM "${table}"`);
      }

      let inserted = 0;
      for (const table of insertOrder) {
        const entry = manifest.tables.find((t) => t.name === table);
        if (!entry) continue;
        const rows = byTable.get(table) ?? [];
        if (rows.length === 0) continue;
        const placeholders = entry.columns.map(() => '?').join(', ');
        const quoted = entry.columns.map((c) => `"${c}"`).join(', ');
        const stmt = db.prepare(`INSERT INTO "${table}" (${quoted}) VALUES (${placeholders})`);
        for (const row of rows) {
          const values = entry.columns.map((c) => denormValue(row[c])) as SqlParam[];
          await stmt.run(...values);
          inserted += 1;
        }
      }
      const expectedTotal = manifest.tables.reduce((s, t) => s + t.count, 0);
      checks.push({
        code: 'row_insert',
        label: 'Every dumped row inserted',
        passed: inserted === expectedTotal,
        detail: `inserted=${inserted} expected=${expectedTotal}`,
      });

      // 4. Recount + re-hash every table from the RESTORED rows. Row lines
      //    are rebuilt with the manifest's column order and sorted, exactly
      //    as the dump hashed them, so this is a byte-level content proof.
      const countMismatches: string[] = [];
      const hashMismatches: string[] = [];
      for (const entry of manifest.tables) {
        const rows = (await db.prepare(`SELECT * FROM "${entry.name}"`).all()) as Record<string, unknown>[];
        counts[entry.name] = rows.length;
        if (rows.length !== entry.count) {
          countMismatches.push(`${entry.name}: manifest=${entry.count} restored=${rows.length}`);
          continue;
        }
        const lines = rows.map((r) => rowLine(entry.name, entry.columns, r));
        if (hashLines(lines) !== entry.sha256) hashMismatches.push(entry.name);
      }
      checks.push({
        code: 'counts_match',
        label: 'Restored row counts match the manifest',
        passed: countMismatches.length === 0,
        detail: countMismatches.length === 0 ? `All ${manifest.tables.length} match.` : countMismatches.slice(0, 5).join('; '),
      });
      checks.push({
        code: 'content_hash_match',
        label: 'Restored row content matches the manifest digests',
        passed: hashMismatches.length === 0,
        detail:
          hashMismatches.length === 0
            ? `All ${manifest.tables.length} digests match.`
            : `Digest mismatch: ${hashMismatches.slice(0, 5).join(', ')}`,
      });

      // 5. Advance identity sequences so post-restore inserts cannot collide
      //    with re-inserted original ids.
      for (const entry of manifest.tables) {
        for (const col of await identityColumns(db, entry.name)) {
          await db.exec(
            `SELECT setval(pg_get_serial_sequence('"${entry.name}"', '${col}')::regclass,
                           COALESCE(MAX("${col}"), 1), MAX("${col}") IS NOT NULL)
               FROM "${entry.name}"`,
          );
        }
      }
    });
  } catch (err) {
    checks.push({
      code: 'restore_execution',
      label: 'Isolated restore completed without error',
      passed: false,
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    // The transaction rolled back on failure (schema never persisted) or
    // committed on success (schema must be dropped now). Either way, a
    // qualified best-effort drop leaves no residue.
    try {
      await db.exec(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } catch {
      /* best effort — a leftover empty schema is harmless and visible */
    }
    void created;
  }

  return { schema, ok: checks.every((c) => c.passed), checks, counts };
}
