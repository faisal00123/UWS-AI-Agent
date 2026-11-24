/**
 * Application-side resource monitoring (Phase 10).
 *
 * Watches the four things that actually cause outages on free tiers:
 *   1. database size      vs the configured quota   (Supabase Free = 500 MB)
 *   2. database connections vs the server's max_connections
 *   3. database response time vs the configured latency budget
 *   4. backup storage / failures / age vs the configured storage quota
 *
 * Thresholds are evaluated IN THIS PROCESS (app-side only): 70% warn,
 * 85% urgent, 95% critical. No external monitoring service is used and
 * nothing here ever enables billing or contacts a vendor.
 *
 * Honesty rules:
 *   - a metric that cannot be measured reports level 'unknown' with the
 *     (sanitised) error in `detail` — never a fabricated 'ok'
 *   - a metric that does not apply to the current dialect (e.g. connection
 *     counts on SQLite) reports level 'ok' with percent null and says so
 *   - backup metrics report 'backups disabled by configuration' as an
 *     explicit ok, because disabling is an owner decision, not an incident
 *   - `overall` is the worst level across measured metrics only
 */
import { existsSync, statSync } from 'node:fs';
import type { DB, Dialect } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { nowIso } from '../../core/time.ts';

/** Threshold levels in ascending severity. */
export type ThresholdLevel = 'ok' | 'warn' | 'urgent' | 'critical';
/** 'unknown' = the metric could not be measured (see detail). */
export type MetricState = ThresholdLevel | 'unknown';

export const THRESHOLDS = { warn: 70, urgent: 85, critical: 95 } as const;

const LEVEL_RANK: Record<ThresholdLevel, number> = { ok: 0, warn: 1, urgent: 2, critical: 3 };

/** 70% warn / 85% urgent / 95% critical. A null percent measures as 'ok'. */
export function levelForPercent(percent: number | null): ThresholdLevel {
  if (percent === null || !Number.isFinite(percent)) return 'ok';
  if (percent >= THRESHOLDS.critical) return 'critical';
  if (percent >= THRESHOLDS.urgent) return 'urgent';
  if (percent >= THRESHOLDS.warn) return 'warn';
  return 'ok';
}

export type MetricUnit = 'bytes' | 'connections' | 'ms' | 'count' | 'hours';

export interface Metric {
  key: string;
  label: string;
  used: number | null;
  limit: number | null;
  unit: MetricUnit;
  percent: number | null;
  level: MetricState;
  detail: string;
}

export interface MonitoringReport {
  checkedAt: string;
  dialect: Dialect;
  thresholds: typeof THRESHOLDS;
  overall: ThresholdLevel;
  metrics: Metric[];
}

/** Backup attempts older than this do not count towards the failure ratio. */
const FAILURE_WINDOW_MS = 7 * 24 * 3_600_000;
/** Latency probes per collection (median of the three). */
const LATENCY_PROBES = 3;

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function pct(used: number, limit: number): number | null {
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return null;
  return round1((used / limit) * 100);
}

function errDetail(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // Never leak connection strings that may embed credentials.
  return msg.replace(/postgres(ql)?:\/\/\S+/gi, 'postgres://[redacted]').slice(0, 300);
}

async function measureLatencyMs(db: DB): Promise<number> {
  const samples: number[] = [];
  for (let i = 0; i < LATENCY_PROBES; i += 1) {
    const t0 = performance.now();
    await db.prepare('SELECT 1 AS ok').get();
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return samples[Math.floor(samples.length / 2)] ?? 0; // median
}

// ------------------------------------------------------------ db metrics ---

async function dbSizeMetric(db: DB, cfg: Config): Promise<Metric> {
  const limit = cfg.monitoring.dbSizeQuotaBytes;
  const base = { key: 'db.size', label: 'Database size', unit: 'bytes' as const, limit };
  try {
    let used: number;
    let detail: string;
    if (db.dialect === 'postgres') {
      const row = (await db.prepare('SELECT pg_database_size(current_database()) AS bytes').get()) as
        | { bytes: number | string }
        | undefined;
      used = Number(row?.bytes ?? 0);
      detail = `PostgreSQL pg_database_size; quota is the configured ${Math.round(limit / 1048576)} MB limit.`;
    } else {
      // SQLite: the database file itself (':memory:' has no file).
      used = cfg.databasePath === ':memory:' || !existsSync(cfg.databasePath) ? 0 : statSync(cfg.databasePath).size;
      detail =
        used === 0
          ? 'No on-disk database file (in-memory or not yet written).'
          : 'SQLite database file size; quota is the configured limit (soft).';
    }
    const percent = pct(used, limit);
    return { ...base, used, percent, level: levelForPercent(percent), detail };
  } catch (err) {
    return { ...base, used: null, percent: null, level: 'unknown', detail: `Could not measure: ${errDetail(err)}` };
  }
}

async function dbConnectionsMetric(db: DB): Promise<Metric> {
  const base = {
    key: 'db.connections',
    label: 'Database connections',
    unit: 'connections' as const,
    limit: null as number | null,
  };
  if (db.dialect !== 'postgres') {
    return {
      ...base,
      used: 1,
      percent: null,
      level: 'ok',
      detail: 'Not applicable on SQLite (single embedded connection).',
    };
  }
  try {
    const row = (await db
      .prepare(
        `SELECT (SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()) AS used,
                current_setting('max_connections')::int AS max`,
      )
      .get()) as { used: number | string; max: number | string } | undefined;
    const used = Number(row?.used ?? 0);
    const max = Number(row?.max ?? 0);
    const percent = pct(used, max);
    return {
      ...base,
      used,
      limit: max,
      percent,
      level: levelForPercent(percent),
      detail: 'Server-wide connections to this database vs max_connections (includes other clients).',
    };
  } catch (err) {
    return { ...base, used: null, percent: null, level: 'unknown', detail: `Could not measure: ${errDetail(err)}` };
  }
}

async function dbLatencyMetric(db: DB, cfg: Config): Promise<Metric> {
  const limit = cfg.monitoring.dbLatencyBudgetMs;
  const base = { key: 'db.latency', label: 'Database response time', unit: 'ms' as const, limit };
  try {
    const used = round1(await measureLatencyMs(db));
    const percent = pct(used, limit);
    return {
      ...base,
      used,
      percent,
      level: levelForPercent(percent),
      detail: `Median of ${LATENCY_PROBES} "SELECT 1" round trips vs a ${limit} ms budget.`,
    };
  } catch (err) {
    return { ...base, used: null, percent: null, level: 'unknown', detail: `Could not measure: ${errDetail(err)}` };
  }
}

// --------------------------------------------------------- backup metrics ---

async function backupStorageMetric(db: DB, cfg: Config): Promise<Metric> {
  const limit = cfg.monitoring.backupStorageQuotaBytes;
  const base = { key: 'backup.storage', label: 'Backup storage', unit: 'bytes' as const, limit };
  try {
    const row = (await db
      .prepare('SELECT COALESCE(SUM(size_bytes), 0) AS bytes FROM backups')
      .get()) as { bytes: number | string } | undefined;
    const used = Number(row?.bytes ?? 0);
    const percent = pct(used, limit);
    return {
      ...base,
      used,
      percent,
      level: levelForPercent(percent),
      detail: 'Sum of recorded backup sizes vs the configured off-site storage quota.',
    };
  } catch (err) {
    return { ...base, used: null, percent: null, level: 'unknown', detail: `Could not measure: ${errDetail(err)}` };
  }
}

async function backupFailuresMetric(db: DB): Promise<Metric> {
  const base = { key: 'backup.failures', label: 'Backup failures (7 days)', unit: 'count' as const, limit: null };
  try {
    const since = new Date(Date.now() - FAILURE_WINDOW_MS).toISOString();
    const row = (await db
      .prepare(
        `SELECT COUNT(*) AS total,
                COALESCE(SUM(CASE WHEN status = 'failed' OR error IS NOT NULL THEN 1 ELSE 0 END), 0) AS failed
           FROM backups WHERE created_at >= ?`,
      )
      .get(since)) as { total: number | string; failed: number | string } | undefined;
    const total = Number(row?.total ?? 0);
    const failed = Number(row?.failed ?? 0);
    if (total === 0) {
      return {
        ...base,
        used: 0,
        percent: 0,
        level: 'ok',
        detail: 'No backup attempts recorded in the last 7 days (see backup age for freshness).',
      };
    }
    const percent = pct(failed, total);
    return {
      ...base,
      used: failed,
      percent,
      level: levelForPercent(percent),
      detail: `${failed} of ${total} backup attempt(s) failed in the last 7 days (upload failures count as failures).`,
    };
  } catch (err) {
    return { ...base, used: null, percent: null, level: 'unknown', detail: `Could not measure: ${errDetail(err)}` };
  }
}

async function backupAgeMetric(db: DB, cfg: Config): Promise<Metric> {
  const base = { key: 'backup.age', label: 'Age of newest verified backup', unit: 'hours' as const, limit: null };
  if (!cfg.backup.enabled) {
    return {
      ...base,
      used: null,
      percent: null,
      level: 'ok',
      detail: 'Backups are disabled by configuration (BACKUP_ENABLED=false) — owner decision, not an incident.',
    };
  }
  try {
    const row = (await db
      .prepare(`SELECT verified_at FROM backups WHERE status = 'verified' ORDER BY verified_at DESC LIMIT 1`)
      .get()) as { verified_at: string | null } | undefined;
    if (!row?.verified_at) {
      return {
        ...base,
        used: null,
        percent: null,
        level: 'critical',
        detail: 'Backups are enabled but no verified backup has ever been produced.',
      };
    }
    // Allowed age = twice the backup interval: a single missed cycle already
    // reads >50%, two missed cycles approach critical (95%).
    const allowedMs = cfg.backup.intervalHours * 2 * 3_600_000;
    const ageMs = Date.now() - Date.parse(row.verified_at);
    const hours = round1(ageMs / 3_600_000);
    const percent = pct(ageMs, allowedMs);
    return {
      ...base,
      used: hours,
      limit: round1(allowedMs / 3_600_000),
      percent,
      level: levelForPercent(percent),
      detail: `Newest verified backup is ${hours}h old; allowed age is ${cfg.backup.intervalHours}h × 2 (one missed cycle = warning territory).`,
    };
  } catch (err) {
    return { ...base, used: null, percent: null, level: 'unknown', detail: `Could not measure: ${errDetail(err)}` };
  }
}

// ------------------------------------------------------------- collection ---

function overallLevel(metrics: Metric[]): ThresholdLevel {
  let worst: ThresholdLevel = 'ok';
  for (const m of metrics) {
    if (m.level === 'unknown') continue;
    if (LEVEL_RANK[m.level] > LEVEL_RANK[worst]) worst = m.level;
  }
  return worst;
}

/**
 * Collect every monitoring metric. Never throws: a failing probe becomes an
 * 'unknown' metric so one broken query cannot hide the rest of the report.
 */
export async function collectMetrics(db: DB, cfg: Config): Promise<MonitoringReport> {
  const metrics = await Promise.all([
    dbSizeMetric(db, cfg),
    dbConnectionsMetric(db),
    dbLatencyMetric(db, cfg),
    backupStorageMetric(db, cfg),
    backupFailuresMetric(db),
    backupAgeMetric(db, cfg),
  ]);
  return {
    checkedAt: nowIso(),
    dialect: db.dialect,
    thresholds: THRESHOLDS,
    overall: overallLevel(metrics),
    metrics,
  };
}
