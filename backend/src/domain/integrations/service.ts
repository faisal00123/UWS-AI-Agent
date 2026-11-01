/**
 * Integration domain service (Phase 11A, Task 7/8).
 *
 * Responsibilities:
 *  - enable/disable toggles per integration (stored as the
 *    `integration_toggles` setting — owner-editable, NOT sensitive);
 *  - persist adapter usage records (`adapter_usage`) from the registry's
 *    `onUsage` hook;
 *  - persist + read connection health checks (`integration_health`) shown as
 *    "last health check" on the Integrations dashboard;
 *  - run a health check for one integration by calling the adapter's FREE
 *    `ping()` probe — with NO network at all when the integration is
 *    unconfigured or disabled (honest state, no fabricated success).
 *
 * Security invariants:
 *  - no secret ever enters this module (only integration keys and redacted
 *    AdapterError messages);
 *  - the persisted health `detail` is capped and redacted by the caller
 *    (registry ping() details are already redacted by contract).
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { nowIso } from '../../core/time.ts';
import { AppError } from '../../core/errors.ts';
import { getSetting } from '../settings/service.ts';
import { AdapterError } from '../../adapters/types.ts';
import type { AdapterRegistry, IntegrationKey } from '../../adapters/registry.ts';

// --------------------------------------------------------------- toggles ---

export interface IntegrationToggles {
  telephony: boolean;
  whatsapp: boolean;
  ai: boolean;
  speech: boolean;
  email: boolean;
  discovery: boolean;
}

export const DEFAULT_TOGGLES: IntegrationToggles = {
  telephony: true,
  whatsapp: true,
  ai: true,
  speech: true,
  email: true,
  discovery: true,
};

/**
 * Read current toggles. Missing/corrupt setting => all enabled (safe default
 * matching the definition's default). Unknown keys are ignored.
 */
export function getToggles(db: DB, cfg: Config): IntegrationToggles {
  let raw: unknown;
  try {
    raw = getSetting<Partial<IntegrationToggles>>(db, 'integration_toggles', cfg);
  } catch {
    return { ...DEFAULT_TOGGLES };
  }
  const out = { ...DEFAULT_TOGGLES };
  if (raw && typeof raw === 'object') {
    for (const key of Object.keys(DEFAULT_TOGGLES) as (keyof IntegrationToggles)[]) {
      const v = (raw as Record<string, unknown>)[key];
      if (typeof v === 'boolean') out[key] = v;
    }
  }
  return out;
}

/** True when the owner has not disabled this integration. */
export function isIntegrationEnabled(db: DB, cfg: Config, key: IntegrationKey): boolean {
  return getToggles(db, cfg)[key] !== false;
}

// --------------------------------------------------------------- usage -----

export interface UsageRow {
  integration: string;
  operation: string;
  outcome: 'ok' | 'error' | 'rate_limited' | 'disabled';
  errorCode: string | null;
  durationMs: number;
  retries: number;
  occurredAt: Date;
}

/**
 * Persist one adapter usage record. Never throws (usage accounting must not
 * break an operation) and never stores payloads/credentials.
 */
export function recordAdapterUsage(db: DB, event: UsageRow): void {
  try {
    db.prepare(
      `INSERT INTO adapter_usage (integration, operation, outcome, error_code, duration_ms, retries, occurred_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.integration,
      event.operation,
      event.outcome,
      event.errorCode ?? null,
      Math.max(0, Math.round(event.durationMs)),
      Math.max(0, Math.round(event.retries)),
      (event.occurredAt ?? new Date()).toISOString(),
    );
  } catch {
    /* swallow: observability must never break the caller */
  }
}

/**
 * Record a probe that was refused before any network (disabled or
 * unconfigured). Kept separate from recordAdapterUsage only in name — same
 * table, so the dashboard's usage panel shows WHY nothing was sent.
 */
function recordRefusedProbe(
  db: DB,
  key: IntegrationKey,
  operation: string,
  outcome: 'disabled' | 'error',
  durationMs: number,
): void {
  recordAdapterUsage(db, {
    integration: key,
    operation,
    outcome,
    errorCode: outcome,
    durationMs,
    retries: 0,
    occurredAt: new Date(),
  });
}

export interface UsageSummaryEntry {
  integration: string;
  total: number;
  ok: number;
  error: number;
  rateLimited: number;
  disabled: number;
  avgDurationMs: number;
}

/** Aggregate usage per integration for the dashboard (last N days). */
export function usageSummary(db: DB, days = 7): UsageSummaryEntry[] {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = db
    .prepare(
      `SELECT integration,
              COUNT(*) AS total,
              SUM(CASE WHEN outcome = 'ok' THEN 1 ELSE 0 END) AS ok,
              SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error,
              SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited,
              SUM(CASE WHEN outcome = 'disabled' THEN 1 ELSE 0 END) AS disabled,
              COALESCE(AVG(duration_ms), 0) AS avg_duration
         FROM adapter_usage
        WHERE occurred_at >= ?
        GROUP BY integration
        ORDER BY integration`,
    )
    .all(since) as {
    integration: string;
    total: number;
    ok: number;
    error: number;
    rate_limited: number;
    disabled: number;
    avg_duration: number;
  }[];
  return rows.map((r) => ({
    integration: r.integration,
    total: r.total,
    ok: r.ok ?? 0,
    error: r.error ?? 0,
    rateLimited: r.rate_limited ?? 0,
    disabled: r.disabled ?? 0,
    avgDurationMs: Math.round(r.avg_duration ?? 0),
  }));
}

// -------------------------------------------------------------- health -----

export interface HealthRecord {
  integration: string;
  checkedAt: string;
  ok: boolean;
  state: string;
  detail: string | null;
  durationMs: number;
}

const MAX_DETAIL = 300;

/** Strip anything that could look like a credential from a detail string. */
function redactDetail(detail: string | null | undefined): string | null {
  if (!detail) return null;
  const cleaned = detail
    .replace(/\b(Bearer|Basic|Token|key|secret|password|pass|token)\s*[=:]\s*\S+/gi, '$1=[redacted]')
    .replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
    .trim();
  return cleaned.slice(0, MAX_DETAIL);
}

/** Persist the latest health probe for one integration. */
export function saveHealthCheck(db: DB, record: HealthRecord): void {
  db.prepare(
    `INSERT INTO integration_health (integration, checked_at, ok, state, detail, duration_ms)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(integration) DO UPDATE SET
       checked_at = excluded.checked_at,
       ok         = excluded.ok,
       state      = excluded.state,
       detail     = excluded.detail,
       duration_ms= excluded.duration_ms`,
  ).run(
    record.integration,
    record.checkedAt,
    record.ok ? 1 : 0,
    record.state,
    redactDetail(record.detail),
    Math.max(0, Math.round(record.durationMs)),
  );
}

export interface HealthView extends HealthRecord {
  ok: boolean;
}

/** Latest health record per integration (missing => never checked). */
export function lastHealthChecks(db: DB): Record<string, HealthView | null> {
  const rows = db
    .prepare('SELECT * FROM integration_health')
    .all() as {
    integration: string;
    checked_at: string;
    ok: number;
    state: string;
    detail: string | null;
    duration_ms: number;
  }[];
  const out: Record<string, HealthView | null> = {};
  for (const r of rows) {
    out[r.integration] = {
      integration: r.integration,
      checkedAt: r.checked_at,
      ok: r.ok === 1,
      state: r.state,
      detail: r.detail,
      durationMs: r.duration_ms,
    };
  }
  return out;
}

export interface HealthCheckResult {
  integration: IntegrationKey;
  ok: boolean;
  state: 'configured' | 'unconfigured' | 'disabled' | 'error';
  detail: string;
  durationMs: number;
  checkedAt: string;
}

/**
 * Run a FREE health probe for one integration.
 *
 *  - disabled            -> ok=false, state 'disabled', NO network;
 *  - unconfigured        -> ok=false, state 'unconfigured', NO network;
 *  - configured (mock)   -> ping() (simulated, still no network);
 *  - configured (vendor) -> ping() (free endpoint only by adapter contract).
 *
 * The result is persisted so the dashboard's "last health check" survives.
 */
export async function runHealthCheck(
  db: DB,
  cfg: Config,
  registry: AdapterRegistry,
  key: IntegrationKey,
): Promise<HealthCheckResult> {
  const started = Date.now();
  const checkedAt = new Date().toISOString();

  // Disabled beats everything: no network, honest state.
  const toggles = getToggles(db, cfg);
  if (toggles[key] === false) {
    const res: HealthCheckResult = {
      integration: key,
      ok: false,
      state: 'disabled',
      detail: 'Integration is disabled in settings — no probe performed.',
      durationMs: Date.now() - started,
      checkedAt,
    };
    saveHealthCheck(db, res);
    recordRefusedProbe(db, key, 'ping', 'disabled', res.durationMs);
    return res;
  }

  // Locate the (decorated) port. Discovery is always present.
  const port =
    key === 'telephony'
      ? registry.telephony
      : key === 'whatsapp'
        ? registry.whatsapp
        : key === 'ai'
          ? registry.ai
          : key === 'speech'
            ? registry.speech
            : key === 'email'
              ? registry.email
              : registry.discovery;

  if (!port) {
    const res: HealthCheckResult = {
      integration: key,
      ok: false,
      state: 'unconfigured',
      detail: 'No provider configured — set the provider + credentials in .env.',
      durationMs: Date.now() - started,
      checkedAt,
    };
    saveHealthCheck(db, res);
    recordRefusedProbe(db, key, 'ping', 'disabled', res.durationMs);
    return res;
  }

  const status = port.status();
  if (status.state === 'unconfigured') {
    const res: HealthCheckResult = {
      integration: key,
      ok: false,
      state: 'unconfigured',
      detail: status.implementation
        ? `Provider "${status.implementation}" selected but credentials are incomplete.`
        : 'No provider configured.',
      durationMs: Date.now() - started,
      checkedAt,
    };
    saveHealthCheck(db, res);
    return res;
  }

  const ping = port.ping;
  if (typeof ping !== 'function') {
    const res: HealthCheckResult = {
      integration: key,
      ok: false,
      state: 'error',
      detail: 'This adapter does not expose a health probe.',
      durationMs: Date.now() - started,
      checkedAt,
    };
    saveHealthCheck(db, res);
    return res;
  }

  try {
    const result = await ping.call(port);
    const res: HealthCheckResult = {
      integration: key,
      ok: result.ok,
      state: result.ok ? (status.state as 'configured') : 'error',
      detail: result.detail ?? (result.ok ? 'Probe OK.' : 'Probe reported failure.'),
      durationMs: Date.now() - started,
      checkedAt,
    };
    saveHealthCheck(db, res);
    return res;
  } catch (err) {
    const detail =
      err instanceof AdapterError
        ? `${err.code}: ${err.message}`
        : 'Health probe failed with an unexpected error.';
    const res: HealthCheckResult = {
      integration: key,
      ok: false,
      state: 'error',
      detail,
      durationMs: Date.now() - started,
      checkedAt,
    };
    saveHealthCheck(db, res);
    return res;
  }
}

/** Guard used by routes: validate an integration key from user input. */
export function assertIntegrationKey(value: string): IntegrationKey {
  const allowed: IntegrationKey[] = ['telephony', 'whatsapp', 'ai', 'speech', 'email', 'discovery'];
  if (!allowed.includes(value as IntegrationKey)) {
    throw new AppError('validation_failed', `Unknown integration: ${value}`);
  }
  return value as IntegrationKey;
}

/** Convenience for `nowIso()` parity with the rest of the domain. */
export { nowIso };
