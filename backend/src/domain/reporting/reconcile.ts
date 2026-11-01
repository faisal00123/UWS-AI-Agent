/**
 * Provider/day reconciliation (Phase 8).
 *
 * Compares what the outreach ledger SAYS happened against what actually got
 * executed and what the provider callbacks reported, for one business day.
 * Discrepancies are conflicts between our own records; missingData lists
 * inputs that simply do not exist yet (e.g. a provider billing feed). Nothing
 * here ever estimates a value it does not have — a gap stays a gap.
 *
 * Checks (each with sample refs so the owner can jump to the rows):
 *  - missing_execution: an ALLOWED attempt with no call/message row means the
 *    execution layer lost track of an action the guard approved (critical)
 *  - counter_drift: budget_usage.used_value must equal the number of allowed
 *    attempts for that metric — drift means the hard caps could be wrong
 *    (critical)
 *  - call_without_provider_callback: a live call still non-terminal long
 *    after placement means a webhook was missed (warning)
 *  - message_without_provider_callback: same for live messages (warning)
 *  - cost_data_unavailable: activity happened but no provider cost feed
 *    exists, so costs are reported as unavailable, never invented (info)
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import {
  businessDayKey,
  localWallClockToDate,
  nowIso,
  partsInZone,
} from '../../core/time.ts';

export type DiscrepancySeverity = 'info' | 'warning' | 'critical';

export interface ReconciliationDiscrepancy {
  code: string;
  severity: DiscrepancySeverity;
  count: number;
  detail: string;
  /** Sample row ids (max 10) so the owner can inspect the offenders. */
  refs: string[];
}

export interface ReconciliationCheck {
  code: string;
  label: string;
  passed: boolean;
  detail: string;
}

export interface Reconciliation {
  reportDate: string;
  checkedAt: string;
  windowStartUtc: string;
  windowEndUtc: string;
  checks: ReconciliationCheck[];
  discrepancies: ReconciliationDiscrepancy[];
  missingData: string[];
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** UTC half-open window [start, end) covering one business-timezone day. */
export function businessDayUtcRange(cfg: Config, reportDate: string): { start: Date; end: Date } {
  const m = DATE_RE.exec(reportDate);
  if (!m) throw new AppError('validation_failed', 'reportDate must be YYYY-MM-DD');
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AppError('validation_failed', `Invalid date: ${reportDate}`);
  }
  const start = localWallClockToDate(year, month, day, 0, cfg.businessTimezone);
  const end = localWallClockToDate(year, month, day, 1440, cfg.businessTimezone);
  return { start, end };
}

/** Business-day key of the day before `now` in the business timezone. */
export function previousBusinessDayKey(now: Date, timeZone: string): string {
  const p = partsInZone(now, timeZone);
  const midnightUtc = new Date(Date.UTC(p.year, p.month - 1, p.day));
  return businessDayKey(new Date(midnightUtc.getTime() - 86_400_000), timeZone);
}

/** The `n` business-day keys ending with yesterday (oldest first). */
export function pastBusinessDayKeys(now: Date, timeZone: string, n: number): string[] {
  const p = partsInZone(now, timeZone);
  const out: string[] = [];
  for (let i = n; i >= 1; i--) {
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day) - i * 86_400_000);
    out.push(businessDayKey(d, timeZone));
  }
  return out;
}

/** A live call/message still in flight longer than this is "without callback". */
const STUCK_GRACE_MS = 15 * 60 * 1000;
const MAX_REFS = 10;

interface RefRows {
  id: string;
}

function refsFor(db: DB, sql: string, ...params: (string | number)[]): string[] {
  const rows = db.prepare(`${sql} LIMIT ${MAX_REFS}`).all(...params) as unknown as RefRows[];
  return rows.map((r) => r.id);
}

function countFor(db: DB, sql: string, ...params: (string | number)[]): number {
  const row = db.prepare(sql).get(...params) as { c: number };
  return row.c;
}

/** Channels whose allowed attempts consume the given budget metric. */
const METRIC_CHANNELS: { metric: string; channel: string; label: string }[] = [
  { metric: 'calls', channel: 'call', label: 'calls' },
  { metric: 'whatsapp_messages', channel: 'whatsapp_message', label: 'WhatsApp messages' },
  { metric: 'whatsapp_calls', channel: 'whatsapp_call', label: 'WhatsApp calls' },
];

export function reconcileDay(db: DB, cfg: Config, reportDate: string, now: Date = new Date()): Reconciliation {
  const { start, end } = businessDayUtcRange(cfg, reportDate);
  const s = start.toISOString();
  const e = end.toISOString();
  const graceCutoff = new Date(now.getTime() - STUCK_GRACE_MS).toISOString();

  const checks: ReconciliationCheck[] = [];
  const discrepancies: ReconciliationDiscrepancy[] = [];
  const missingData: string[] = [];

  // 1. Every approved attempt must have produced exactly one execution row.
  const missingSql = `SELECT id FROM outreach_attempts
    WHERE created_at >= ? AND created_at < ? AND decision = 'allowed'
      AND ((channel IN ('call','whatsapp_call') AND call_id IS NULL)
        OR (channel = 'whatsapp_message' AND message_id IS NULL))`;
  const missingCount = countFor(db, `SELECT COUNT(*) c FROM (${missingSql})`, s, e);
  checks.push({
    code: 'missing_execution',
    label: 'Allowed attempts have execution rows',
    passed: missingCount === 0,
    detail:
      missingCount === 0
        ? 'Every allowed attempt has a call/message row.'
        : `${missingCount} allowed attempt(s) have no call/message row — the guard approved an action that never executed.`,
  });
  if (missingCount > 0) {
    discrepancies.push({
      code: 'missing_execution',
      severity: 'critical',
      count: missingCount,
      detail: 'Allowed outreach attempt(s) without a corresponding call/message row.',
      refs: refsFor(db, missingSql, s, e),
    });
  }

  // 2. Daily counters must equal the number of allowed attempts they metered.
  let driftCount = 0;
  const driftRefs: string[] = [];
  const driftDetails: string[] = [];
  for (const m of METRIC_CHANNELS) {
    const allowed = countFor(
      db,
      `SELECT COUNT(*) c FROM outreach_attempts WHERE created_at >= ? AND created_at < ? AND decision = 'allowed' AND channel = ?`,
      s,
      e,
      m.channel,
    );
    const usage = db
      .prepare('SELECT used_value FROM budget_usage WHERE usage_date = ? AND metric = ?')
      .get(reportDate, m.metric) as { used_value: number } | undefined;
    const used = usage?.used_value ?? 0;
    if (allowed === 0 && !usage) continue; // nothing metered, nothing to compare
    if (allowed !== used) {
      driftCount += 1;
      driftDetails.push(`${m.metric}: counter=${used}, allowed attempts=${allowed}`);
      driftRefs.push(`${m.metric}@${reportDate}`);
    }
  }
  checks.push({
    code: 'counter_drift',
    label: 'Budget counters match the ledger',
    passed: driftCount === 0,
    detail:
      driftCount === 0
        ? 'budget_usage counters equal the allowed-attempt counts.'
        : `Counter drift detected — ${driftDetails.join('; ')}.`,
  });
  if (driftCount > 0) {
    discrepancies.push({
      code: 'counter_drift',
      severity: 'critical',
      count: driftCount,
      detail: `budget_usage disagrees with the outreach ledger (${driftDetails.join('; ')}).`,
      refs: driftRefs,
    });
  }

  // 3. Live calls must reach a terminal state via provider callbacks.
  const stuckCallSql = `SELECT id FROM calls
    WHERE created_at >= ? AND created_at < ? AND created_at < ?
      AND simulation = 0 AND status IN ('queued','initiated','ringing','in_progress')`;
  const stuckCalls = countFor(db, `SELECT COUNT(*) c FROM (${stuckCallSql})`, s, e, graceCutoff);
  checks.push({
    code: 'call_without_provider_callback',
    label: 'Live calls reached a terminal status',
    passed: stuckCalls === 0,
    detail:
      stuckCalls === 0
        ? 'No live call is stuck waiting for a provider status callback.'
        : `${stuckCalls} live call(s) have been non-terminal for over ${STUCK_GRACE_MS / 60_000} minutes — a webhook may be missing.`,
  });
  if (stuckCalls > 0) {
    discrepancies.push({
      code: 'call_without_provider_callback',
      severity: 'warning',
      count: stuckCalls,
      detail: 'Live call(s) still non-terminal well after placement; check the telephony webhook.',
      refs: refsFor(db, stuckCallSql, s, e, graceCutoff),
    });
  }

  // 4. Live messages must reach a terminal state via provider callbacks.
  const stuckMsgSql = `SELECT id FROM messages
    WHERE created_at >= ? AND created_at < ? AND created_at < ?
      AND simulation = 0 AND status IN ('queued','accepted','sent')`;
  const stuckMsgs = countFor(db, `SELECT COUNT(*) c FROM (${stuckMsgSql})`, s, e, graceCutoff);
  checks.push({
    code: 'message_without_provider_callback',
    label: 'Live messages reached a terminal status',
    passed: stuckMsgs === 0,
    detail:
      stuckMsgs === 0
        ? 'No live message is stuck waiting for a provider status callback.'
        : `${stuckMsgs} live message(s) have been non-terminal for over ${STUCK_GRACE_MS / 60_000} minutes — a webhook may be missing.`,
  });
  if (stuckMsgs > 0) {
    discrepancies.push({
      code: 'message_without_provider_callback',
      severity: 'warning',
      count: stuckMsgs,
      detail: 'Live message(s) still non-terminal well after sending; check the WhatsApp webhook.',
      refs: refsFor(db, stuckMsgSql, s, e, graceCutoff),
    });
  }

  // 5. Costs exist or are explicitly reported missing — never estimated.
  const allowedTotal = countFor(
    db,
    `SELECT COUNT(*) c FROM outreach_attempts WHERE created_at >= ? AND created_at < ? AND decision = 'allowed'`,
    s,
    e,
  );
  const costRows = countFor(db, `SELECT COUNT(*) c FROM cost_records WHERE usage_date = ?`, reportDate);
  const costMissing = allowedTotal > 0 && costRows === 0;
  checks.push({
    code: 'cost_data_available',
    label: 'Cost data present for activity',
    passed: !costMissing,
    detail: costMissing
      ? 'Outreach happened but no provider billing data exists; costs are reported as unavailable.'
      : costRows > 0
        ? `${costRows} cost record(s) present.`
        : 'No paid activity to cost.',
  });
  if (costMissing) {
    discrepancies.push({
      code: 'cost_data_unavailable',
      severity: 'info',
      count: allowedTotal,
      detail: 'No provider cost records for this day; spend totals are reported as 0 with an explicit missing-data note, never estimated.',
      refs: [],
    });
    missingData.push('Provider cost data (no billing integration connected) — spend is reported as unavailable, not estimated.');
  }

  return {
    reportDate,
    checkedAt: nowIso(),
    windowStartUtc: s,
    windowEndUtc: e,
    checks,
    discrepancies,
    missingData,
  };
}
