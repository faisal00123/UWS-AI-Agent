/**
 * SQLite -> PostgreSQL data migration CLI (one-time cutover tool).
 *
 *   cmd:  npm run migrate:pg                 dry-run (DEFAULT): plan, count,
 *                                             compare and report — writes NOTHING
 *   cmd:  npm run migrate:pg -- --confirm    apply: run target migrations, copy
 *                                             in FK order, verify, report
 *   opt:  --source <path>                    SQLite source (default: config)
 *   opt:  --help                             usage
 *
 * Safety rules (this tool exists to make a production cutover boring):
 *   - The source is opened READ-ONLY (node:sqlite `readOnly: true` — a write
 *     attempt fails with "attempt to write a readonly database"), and the
 *     report proves the file was untouched (size + mtime unchanged).
 *   - The target comes from DATABASE_URL only. No URL -> hard error; there is
 *     deliberately no SQLite fallback anywhere in this codebase.
 *   - Nothing is written without --confirm. Dry-run is the default.
 *   - Per-table transactions: a table either lands completely or not at all
 *     (rollback leaves the target at 0 rows for that table), so the tool is
 *     resumable — re-running skips tables that already match.
 *   - Pre-flight conflict detection aborts BEFORE any data write when the
 *     target already holds partial/different rows (never overwrite silently).
 *   - After copying: identity sequences are advanced (setval), every table's
 *     row count is re-verified against the source, and every foreign key is
 *     checked for orphaned rows. Any mismatch -> RESULT: FAILED, exit 1.
 *
 * Exit code 0 = verified success, 1 = failure (see report). Never runs
 * unattended: the operator must pass --confirm explicitly.
 */
import { DatabaseSync } from 'node:sqlite';
import { existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../core/config.ts';
import { AppError } from '../core/errors.ts';
import { openPostgres, type DB, type SqlParam } from '../db/index.ts';
import { runMigrations } from '../db/migrate.ts';
import { identityColumns } from '../domain/backup/pgdump.ts';
import { sha256Hex } from '../domain/backup/format.ts';

// ------------------------------------------------------------------ types ---

export type TableStatus = 'planned' | 'copied' | 'replaced' | 'skipped' | 'conflict' | 'failed';

export interface TableReport {
  table: string;
  sourceRows: number;
  /** Target rows after the run; -1 when the target table does not exist. */
  destRows: number;
  status: TableStatus;
  note?: string;
  error?: string;
}

export interface MigratePgReport {
  mode: 'dry-run' | 'apply';
  sourcePath: string;
  /** True when the source file's size+mtime did not change (read-only proof). */
  sourceUntouched: boolean;
  /** Migrations applied to the target during this run (0 in dry-run). */
  migrationsApplied: number;
  tables: TableReport[];
  /** "table.column" identity sequences advanced via setval. */
  identitiesAdvanced: string[];
  sequenceIssues: string[];
  countMismatches: string[];
  relationshipIssues: string[];
  conflicts: string[];
  /** True when conflicts aborted the run before any data write. */
  aborted: boolean;
  ok: boolean;
}

export interface MigratePgOptions {
  sourcePath: string;
  dest: DB;
  /** false (default) = dry-run: no writes at all. */
  confirm: boolean;
}

/**
 * Tables the migrations auto-seed with a placeholder row: a fresh target
 * already has exactly one row, so plain count-equality would "skip" it and
 * silently keep the placeholder instead of the source's real state. For
 * these the SOURCE content always wins — operating_state carries the
 * owner's pause / emergency-stop, which must survive a cutover.
 */
const MIGRATION_SEEDED_SINGLETONS = new Set(['operating_state']);

type Intent = 'copy' | 'replace' | 'skip' | 'conflict' | 'planned';

interface Classification {
  table: string;
  sourceRows: number;
  destRows: number;
  intent: Intent;
  note?: string;
}

interface FkEdge {
  child: string;
  childCol: string;
  parent: string;
  parentCol: string;
  self: boolean;
}

// ---------------------------------------------------------------- helpers ---

/** Quote an identifier for SQLite (source) — also valid PostgreSQL SQL. */
function qi(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** Single-quoted string literal for SQL. */
function qs(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function countSync(src: DatabaseSync, table: string): number {
  const row = src.prepare(`SELECT COUNT(*) AS c FROM ${qi(table)}`).get() as { c: number | bigint };
  return Number(row.c);
}

function sourceColumns(src: DatabaseSync, table: string): string[] {
  const rows = src.prepare(`PRAGMA table_info(${qi(table)})`).all() as { name: string }[];
  return rows.map((r) => r.name);
}

function listSourceTables(src: DatabaseSync): string[] {
  const rows = src
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name NOT GLOB 'sqlite_*' AND name <> 'schema_migrations'
        ORDER BY name`,
    )
    .all() as { name: string }[];
  return rows.map((r) => r.name);
}

function readSourceFks(src: DatabaseSync, tables: string[]): FkEdge[] {
  const known = new Set(tables);
  const edges: FkEdge[] = [];
  for (const table of tables) {
    const rows = src.prepare(`PRAGMA foreign_key_list(${qi(table)})`).all() as {
      table: string;
      from: string;
      to: string;
    }[];
    for (const r of rows) {
      if (!r.table || !r.from || !r.to) continue;
      edges.push({
        child: table,
        childCol: r.from,
        parent: r.table,
        parentCol: r.to,
        self: r.table === table,
      });
      if (!known.has(r.table)) {
        throw new AppError(
          'validation_failed',
          `Source table "${table}" references "${r.table}", which is not a copyable table (schema drift inside the source).`,
        );
      }
    }
  }
  return edges;
}

/**
 * Foreign-key topological order (parents before children). Self-references
 * are ignored for ordering (a row can only validate against itself after
 * insert; cycles among tables are a hard error before any write).
 */
function topoOrder(tables: string[], edges: FkEdge[]): string[] {
  const deps = new Map<string, Set<string>>();
  for (const t of tables) deps.set(t, new Set());
  for (const e of edges) {
    if (e.self) continue;
    deps.get(e.child)?.add(e.parent);
  }
  const ordered: string[] = [];
  const emitted = new Set<string>();
  let progress = true;
  while (progress) {
    progress = false;
    for (const t of tables) {
      if (emitted.has(t)) continue;
      const d = deps.get(t);
      if (d && [...d].every((p) => emitted.has(p))) {
        emitted.add(t);
        ordered.push(t);
        progress = true;
      }
    }
  }
  if (ordered.length !== tables.length) {
    const cycle = tables.filter((t) => !emitted.has(t));
    throw new AppError(
      'validation_failed',
      `Foreign-key cycle between source tables: ${cycle.join(', ')}. Copy order cannot be computed; nothing was written.`,
    );
  }
  return ordered;
}

// Content digests: prove "same row count" also means "same rows". Values are
// normalised so SQLite and PostgreSQL driver output (bigint/int8, bytea vs
// BLOB, Date vs ISO text) compare equal when the stored data is equal.
function canonValue(v: unknown): unknown {
  if (v === undefined || v === null) return null;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Uint8Array) return Buffer.from(v).toString('base64');
  return v;
}

function canonRow(row: Record<string, unknown>): string {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(row).sort()) out[key] = canonValue(row[key]);
  return JSON.stringify(out);
}

function rowDigest(rows: Record<string, unknown>[]): string {
  return sha256Hex(rows.map(canonRow).sort().join('\n'));
}

async function destTableExists(dest: DB, table: string): Promise<boolean> {
  const row = (await dest
    .prepare(`SELECT COUNT(*) AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name = ?`)
    .get(table)) as { c: number };
  return Number(row.c) > 0;
}

async function destCount(dest: DB, table: string): Promise<number> {
  const row = (await dest.prepare(`SELECT COUNT(*) AS c FROM ${qi(table)}`).get()) as { c: number };
  return Number(row.c);
}

async function destSchemaReady(dest: DB): Promise<boolean> {
  return destTableExists(dest, 'schema_migrations');
}

async function digestsMatch(
  src: DatabaseSync,
  dest: DB,
  table: string,
): Promise<{ equal: boolean; error?: string }> {
  try {
    const srcRows = src.prepare(`SELECT * FROM ${qi(table)}`).all() as Record<string, unknown>[];
    const destRows = (await dest.prepare(`SELECT * FROM ${qi(table)}`).all()) as Record<string, unknown>[];
    return { equal: rowDigest(srcRows) === rowDigest(destRows) };
  } catch (err) {
    return { equal: false, error: errText(err) };
  }
}

// ----------------------------------------------------------- classification ---

async function classifyTable(
  src: DatabaseSync,
  dest: DB,
  table: string,
  destReady: boolean,
): Promise<Classification> {
  const sourceRows = countSync(src, table);
  const exists = await destTableExists(dest, table);
  if (!exists) {
    if (!destReady) {
      return {
        table,
        sourceRows,
        destRows: -1,
        intent: 'planned',
        note: 'target schema not initialised (applies with --confirm)',
      };
    }
    return {
      table,
      sourceRows,
      destRows: -1,
      intent: 'conflict',
      note: 'table missing in target schema (schema drift between source and target migrations)',
    };
  }
  const destRows = await destCount(dest, table);
  if (destRows === sourceRows) {
    if (sourceRows === 0) return { table, sourceRows, destRows, intent: 'skip', note: 'empty on both sides' };
    const cmp = await digestsMatch(src, dest, table);
    if (cmp.equal) return { table, sourceRows, destRows, intent: 'skip', note: 'identical content' };
    if (MIGRATION_SEEDED_SINGLETONS.has(table)) {
      return {
        table,
        sourceRows,
        destRows,
        intent: 'replace',
        note: 'migration-seeded placeholder differs; source content wins (owner pause/stop state must survive)',
      };
    }
    return {
      table,
      sourceRows,
      destRows,
      intent: 'conflict',
      note: cmp.error
        ? `content comparison failed: ${cmp.error}`
        : 'same row count but different content — target rows would be overwritten',
    };
  }
  if (destRows === 0) return { table, sourceRows, destRows, intent: 'copy', note: 'target empty' };
  return {
    table,
    sourceRows,
    destRows,
    intent: 'conflict',
    note: `row count differs (source=${sourceRows}, target=${destRows}) — possible partial data in target`,
  };
}

// ------------------------------------------------------------------ copying ---

async function copyTable(src: DatabaseSync, dest: DB, table: string, replace: boolean): Promise<number> {
  const columns = sourceColumns(src, table);
  if (columns.length === 0) throw new AppError('validation_failed', `Source table "${table}" has no columns`);
  const rows = src.prepare(`SELECT * FROM ${qi(table)}`).all() as Record<string, unknown>[];
  const columnList = columns.map(qi).join(', ');
  const placeholders = columns.map(() => '?').join(', ');
  // One transaction per table: commit = fully copied, throw = fully rolled
  // back (target stays at its pre-run rows for this table).
  await dest.transaction(async () => {
    if (replace) await dest.exec(`DELETE FROM ${qi(table)}`);
    const stmt = dest.prepare(`INSERT INTO ${qi(table)} (${columnList}) VALUES (${placeholders})`);
    for (const row of rows) {
      await stmt.run(...columns.map((c) => row[c] as SqlParam));
    }
  });
  return rows.length;
}

async function advanceIdentitySequences(dest: DB, tables: string[], report: MigratePgReport): Promise<void> {
  for (const table of tables) {
    let cols: string[];
    try {
      cols = await identityColumns(dest, table);
    } catch (err) {
      report.sequenceIssues.push(`${table}: cannot read identity columns (${errText(err)})`);
      continue;
    }
    for (const col of cols) {
      try {
        await dest.exec(
          `SELECT setval(pg_get_serial_sequence(${qs(qi(table))}, ${qs(col)})::regclass,
                         COALESCE(MAX(${qi(col)}), 1), MAX(${qi(col)}) IS NOT NULL)
             FROM ${qi(table)}`,
        );
        report.identitiesAdvanced.push(`${table}.${col}`);
      } catch (err) {
        report.sequenceIssues.push(`${table}.${col}: ${errText(err)}`);
      }
    }
  }
}

// ------------------------------------------------------------- verification ---

async function verifyCounts(
  src: DatabaseSync,
  dest: DB,
  tables: string[],
  report: MigratePgReport,
): Promise<void> {
  const byName = new Map(report.tables.map((t) => [t.table, t]));
  for (const table of tables) {
    const sourceRows = countSync(src, table);
    const exists = await destTableExists(dest, table);
    const destRows = exists ? await destCount(dest, table) : -1;
    const entry = byName.get(table);
    if (entry) entry.destRows = destRows;
    if (sourceRows !== destRows) {
      report.countMismatches.push(`${table}: source=${sourceRows} target=${destRows}`);
    }
  }
}

async function verifyRelationships(dest: DB, edges: FkEdge[], report: MigratePgReport): Promise<void> {
  for (const e of edges) {
    try {
      const row = (await dest
        .prepare(
          `SELECT COUNT(*) AS c
             FROM ${qi(e.child)} AS ch
             LEFT JOIN ${qi(e.parent)} AS pr ON ch.${qi(e.childCol)} = pr.${qi(e.parentCol)}
            WHERE ch.${qi(e.childCol)} IS NOT NULL AND pr.${qi(e.parentCol)} IS NULL`,
        )
        .get()) as { c: number };
      const orphans = Number(row.c);
      if (orphans > 0) {
        report.relationshipIssues.push(
          `${e.child}.${e.childCol} -> ${e.parent}.${e.parentCol}: ${orphans} orphaned row(s)`,
        );
      }
    } catch (err) {
      report.relationshipIssues.push(
        `cannot verify ${e.child}.${e.childCol} -> ${e.parent}.${e.parentCol}: ${errText(err)}`,
      );
    }
  }
}

// ------------------------------------------------------------------ report ---

function seal(report: MigratePgReport): void {
  const failed = report.tables.filter((t) => t.status === 'failed');
  report.ok =
    !report.aborted &&
    report.conflicts.length === 0 &&
    failed.length === 0 &&
    report.countMismatches.length === 0 &&
    report.relationshipIssues.length === 0 &&
    report.sequenceIssues.length === 0 &&
    report.sourceUntouched;
}

export function formatReport(r: MigratePgReport): string {
  const lines: string[] = [];
  lines.push(
    r.mode === 'apply'
      ? 'SQLite -> PostgreSQL migration (APPLY)'
      : 'SQLite -> PostgreSQL migration (DRY-RUN — no data was written)',
  );
  lines.push(`Source:  ${r.sourcePath} (opened read-only)`);
  if (r.mode === 'apply') lines.push(`Target migrations applied this run: ${r.migrationsApplied}`);
  if (r.aborted) lines.push('ABORTED: conflicts detected — NO data was written to the target.');
  lines.push('');

  const width = Math.max(5, ...r.tables.map((t) => t.table.length));
  lines.push(`  ${'table'.padEnd(width)}  ${'source'.padStart(8)}  ${'target'.padStart(8)}  status`);
  for (const t of r.tables) {
    const target = t.destRows < 0 ? 'n/a' : String(t.destRows);
    const detail = t.error ? ` — ${t.error}` : t.note ? ` — ${t.note}` : '';
    lines.push(
      `  ${t.table.padEnd(width)}  ${String(t.sourceRows).padStart(8)}  ${target.padStart(8)}  ${t.status}${detail}`,
    );
  }
  lines.push('');

  if (r.identitiesAdvanced.length > 0) {
    lines.push(`Identity sequences advanced: ${r.identitiesAdvanced.join(', ')}`);
  }
  for (const s of r.sequenceIssues) lines.push(`  sequence issue: ${s}`);

  if (r.mode === 'apply' && !r.aborted) {
    if (r.countMismatches.length > 0) {
      lines.push('Row-count verification FAILED:');
      for (const m of r.countMismatches) lines.push(`  ${m}`);
    } else {
      lines.push(`Row-count verification: OK (${r.tables.length} tables match the source)`);
    }
    if (r.relationshipIssues.length > 0) {
      lines.push('Relationship verification FAILED:');
      for (const m of r.relationshipIssues) lines.push(`  ${m}`);
    } else {
      lines.push('Relationship verification: OK (no orphaned rows)');
    }
  }
  for (const c of r.conflicts) lines.push(`CONFLICT: ${c}`);

  lines.push(`Source file untouched: ${r.sourceUntouched ? 'yes' : 'NO — STOP and investigate'}`);
  lines.push(`RESULT: ${r.ok ? 'OK' : 'FAILED'}`);
  if (r.mode === 'dry-run' && r.ok) {
    lines.push('Next step: re-run with --confirm to apply (the only way data is written).');
  }
  return `${lines.join('\n')}\n`;
}

// -------------------------------------------------------------------- main ---

/**
 * Run the migration (exported for tests; the CLI wrapper below adds
 * config/env handling and process exit codes).
 *
 * Dry-run performs only reads against both databases. Apply runs target
 * migrations first, re-checks for conflicts, and only then writes data.
 */
export async function migratePg(opts: MigratePgOptions): Promise<MigratePgReport> {
  const { sourcePath, dest, confirm } = opts;
  const report: MigratePgReport = {
    mode: confirm ? 'apply' : 'dry-run',
    sourcePath,
    sourceUntouched: true,
    migrationsApplied: 0,
    tables: [],
    identitiesAdvanced: [],
    sequenceIssues: [],
    countMismatches: [],
    relationshipIssues: [],
    conflicts: [],
    aborted: false,
    ok: true,
  };

  if (dest.dialect !== 'postgres') {
    throw new AppError('internal_error', 'migrate-pg requires a PostgreSQL target (dialect=postgres)');
  }
  if (!existsSync(sourcePath)) {
    throw new AppError(
      'not_found',
      `Source SQLite database not found at ${sourcePath}. If this is a Render deployment the disk is ephemeral — take an off-platform snapshot first; the data cannot be recovered otherwise.`,
    );
  }

  const before = statSync(sourcePath);
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  try {
    let tables: string[];
    try {
      tables = listSourceTables(src);
    } catch (err) {
      throw new AppError('validation_failed', `Source is not a readable SQLite database: ${errText(err)}`);
    }
    if (tables.length === 0) {
      throw new AppError('validation_failed', `Source ${sourcePath} contains no application tables (not a UWS database?)`);
    }
    const edges = readSourceFks(src, tables);
    const order = topoOrder(tables, edges); // throws before any write

    if (confirm) {
      report.migrationsApplied = (await runMigrations(dest)).applied.length;
    }
    const destReady = confirm ? true : await destSchemaReady(dest);

    // Read-only pre-flight classification of every table.
    const plan: Classification[] = [];
    for (const table of order) plan.push(await classifyTable(src, dest, table, destReady));
    report.conflicts = plan.filter((p) => p.intent === 'conflict').map((p) => `${p.table}: ${p.note}`);

    const dryRunStatus = (intent: Intent): TableStatus =>
      intent === 'conflict' ? 'conflict' : intent === 'skip' ? 'skipped' : 'planned';

    if (!confirm || report.conflicts.length > 0) {
      // Dry-run, or apply aborted BEFORE any data write.
      report.aborted = confirm && report.conflicts.length > 0;
      for (const p of plan) {
        report.tables.push({
          table: p.table,
          sourceRows: p.sourceRows,
          destRows: p.destRows,
          status: dryRunStatus(p.intent),
          note: report.aborted && p.intent !== 'conflict' && p.intent !== 'skip'
            ? 'not written (aborted by conflicts)'
            : p.note,
        });
      }
      return report;
    }

    // ---- APPLY: no conflicts. Copy in FK order, one transaction per table. ----
    for (const p of plan) {
      const entry: TableReport = {
        table: p.table,
        sourceRows: p.sourceRows,
        destRows: p.destRows,
        status: 'skipped',
        note: p.note,
      };
      report.tables.push(entry);
      if (p.intent === 'skip') continue;
      try {
        const written = await copyTable(src, dest, p.table, p.intent === 'replace');
        entry.status = p.intent === 'replace' ? 'replaced' : 'copied';
        entry.note = `${p.note ? `${p.note}; ` : ''}${written} row(s) ${p.intent === 'replace' ? 'rewritten' : 'copied'}`;
      } catch (err) {
        // Per-table rollback already happened: target keeps its prior rows.
        entry.status = 'failed';
        entry.error = errText(err);
      }
    }

    await advanceIdentitySequences(dest, tables, report);
    await verifyCounts(src, dest, tables, report);
    await verifyRelationships(dest, edges, report);
    return report;
  } finally {
    try {
      src.close();
    } catch {
      /* close failure must not mask the original error */
    }
    const after = statSync(sourcePath);
    report.sourceUntouched = after.size === before.size && after.mtimeMs === before.mtimeMs;
    seal(report);
  }
}

// -------------------------------------------------------------------- CLI ---

function arg(name: string): string | undefined {
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 ? process.argv[idx + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

/** True only when this file is executed directly (not imported by tests). */
function invokedDirectly(): boolean {
  const meta = import.meta as unknown as { main?: boolean };
  if (typeof meta.main === 'boolean') return meta.main;
  const argv1 = process.argv[1];
  return argv1 !== undefined && resolve(argv1) === fileURLToPath(import.meta.url);
}

const USAGE = `Usage:
  npm run migrate:pg                 dry-run (default): plan, count, compare - writes nothing
  npm run migrate:pg -- --confirm    apply: migrate target schema, copy, verify
Options:
  --source <path>    SQLite source file (default: configured DATABASE_PATH)
  --help             show this help
`;

async function main(): Promise<void> {
  if (flag('help')) {
    process.stdout.write(USAGE);
    return;
  }
  const config = loadConfig();
  const sourcePath = arg('source') ?? config.databasePath;
  const confirm = flag('confirm');

  if (!config.databaseUrl) {
    throw new AppError(
      'validation_failed',
      'DATABASE_URL is not set. migrate-pg writes to PostgreSQL only; refusing to guess a target (there is no SQLite fallback). Set DATABASE_URL to the target database connection string.',
    );
  }
  const dest = openPostgres(config.databaseUrl, {
    max: config.dbPoolMax,
    applicationName: 'uws-migrate-pg',
    statementTimeoutMs: config.dbStatementTimeoutMs,
  });
  try {
    const report = await migratePg({ sourcePath, dest, confirm });
    process.stdout.write(formatReport(report));
    if (!report.ok) process.exitCode = 1;
  } finally {
    await dest.close();
  }
}

if (invokedDirectly()) {
  main().catch((err: unknown) => {
    process.stderr.write(`migrate-pg failed: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
