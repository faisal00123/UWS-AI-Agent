/**
 * Daily report generation (Phase 8).
 *
 * One row per business day in `daily_reports` (UNIQUE report_date), holding
 * the full totals snapshot, the reconciliation result and any missing-data
 * notes. Properties:
 *
 *  - idempotent: regenerating a date updates the single row, never duplicates
 *  - status: a past business day is always `final`; today (a preview the
 *    owner asked for) is `draft`
 *  - honest: costs come only from `cost_records`; with no provider billing
 *    feed the total is 0 AND the missing-data note says why. Counts are
 *    computed from the ledger, never from what we hope happened.
 *  - a final report raises ONE owner notification (deduped per date), whose
 *    email body is a plain-text summary of the same numbers.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { newId } from '../../core/ids.ts';
import { businessDayKey, nowIso } from '../../core/time.ts';
import { getOperatingState } from '../state/service.ts';
import { notify } from '../notifications/service.ts';
import {
  businessDayUtcRange,
  reconcileDay,
  type Reconciliation,
} from './reconcile.ts';

export interface BudgetUsageView {
  metric: string;
  used: number;
  limit: number;
  state: string;
}

export interface ReportTotals {
  window: { start: string; end: string };
  leads: { created: number; byStage: Record<string, number> };
  attempts: {
    total: number;
    allowed: number;
    blocked: number;
    blockedByCode: Record<string, number>;
    byChannel: Record<string, number>;
  };
  calls: {
    total: number;
    simulated: number;
    live: number;
    byStatus: Record<string, number>;
    byOutcome: Record<string, number>;
    totalDurationSeconds: number;
  };
  messages: {
    total: number;
    simulated: number;
    live: number;
    byStatus: Record<string, number>;
  };
  optOuts: number;
  interactions: { total: number; inbound: number; contactEvidence: number };
  followups: { created: number; completed: number; dueNow: number };
  budget: { date: string; usage: BudgetUsageView[] };
  costs: { byState: Record<string, number>; totalMinor: number; currency: string };
  /** Operating mode at generation time — a live report is visibly live. */
  mode: 'simulation' | 'live';
}

export interface DailyReport {
  id: string;
  reportDate: string;
  generatedAt: string;
  generatedBy: string | null;
  status: 'draft' | 'final';
  discrepanciesCount: number;
  totals: ReportTotals;
  reconciliation: Reconciliation;
  missingData: string[];
}

function bump(map: Record<string, number>, key: string, by = 1): void {
  map[key] = (map[key] ?? 0) + by;
}

function buildTotals(db: DB, cfg: Config, reportDate: string): ReportTotals {
  const { start, end } = businessDayUtcRange(cfg, reportDate);
  const s = start.toISOString();
  const e = end.toISOString();

  const leadRows = db
    .prepare('SELECT stage, COUNT(*) c FROM businesses WHERE created_at >= ? AND created_at < ? GROUP BY stage')
    .all(s, e) as { stage: string; c: number }[];
  const leadsCreated = leadRows.reduce((sum, r) => sum + r.c, 0);
  const byStage: Record<string, number> = {};
  for (const r of leadRows) byStage[r.stage] = r.c;

  const attemptRows = db
    .prepare(
      `SELECT decision, channel, blocked_code, COUNT(*) c FROM outreach_attempts
        WHERE created_at >= ? AND created_at < ? GROUP BY decision, channel, blocked_code`,
    )
    .all(s, e) as { decision: string; channel: string; blocked_code: string | null; c: number }[];
  const attempts = {
    total: 0,
    allowed: 0,
    blocked: 0,
    blockedByCode: {} as Record<string, number>,
    byChannel: {} as Record<string, number>,
  };
  for (const r of attemptRows) {
    attempts.total += r.c;
    bump(attempts.byChannel, r.channel, r.c);
    if (r.decision === 'allowed') attempts.allowed += r.c;
    else {
      attempts.blocked += r.c;
      bump(attempts.blockedByCode, r.blocked_code ?? 'unspecified', r.c);
    }
  }

  const callRows = db
    .prepare('SELECT status, outcome, duration_seconds, simulation FROM calls WHERE created_at >= ? AND created_at < ?')
    .all(s, e) as { status: string; outcome: string; duration_seconds: number | null; simulation: number }[];
  const calls = {
    total: callRows.length,
    simulated: 0,
    live: 0,
    byStatus: {} as Record<string, number>,
    byOutcome: {} as Record<string, number>,
    totalDurationSeconds: 0,
  };
  for (const r of callRows) {
    if (r.simulation === 1) calls.simulated += 1;
    else calls.live += 1;
    bump(calls.byStatus, r.status);
    bump(calls.byOutcome, r.outcome);
    calls.totalDurationSeconds += r.duration_seconds ?? 0;
  }

  const msgRows = db
    .prepare('SELECT status, simulation FROM messages WHERE created_at >= ? AND created_at < ?')
    .all(s, e) as { status: string; simulation: number }[];
  const messages = { total: msgRows.length, simulated: 0, live: 0, byStatus: {} as Record<string, number> };
  for (const r of msgRows) {
    if (r.simulation === 1) messages.simulated += 1;
    else messages.live += 1;
    bump(messages.byStatus, r.status);
  }

  const optOuts = (
    db.prepare('SELECT COUNT(*) c FROM suppression_list WHERE created_at >= ? AND created_at < ?').get(s, e) as { c: number }
  ).c;

  const interRow = db
    .prepare(
      `SELECT COUNT(*) total,
              SUM(CASE WHEN direction = 'inbound' THEN 1 ELSE 0 END) inbound,
              SUM(CASE WHEN simulation = 0 AND kind IN ('call','whatsapp_message','whatsapp_call','email','meeting') THEN 1 ELSE 0 END) contact
         FROM interactions WHERE occurred_at >= ? AND occurred_at < ?`,
    )
    .get(s, e) as { total: number; inbound: number | null; contact: number | null };

  const followCreated = (
    db.prepare('SELECT COUNT(*) c FROM followup_tasks WHERE created_at >= ? AND created_at < ?').get(s, e) as { c: number }
  ).c;
  const followCompleted = (
    db.prepare('SELECT COUNT(*) c FROM followup_tasks WHERE completed_at >= ? AND completed_at < ?').get(s, e) as { c: number }
  ).c;
  const followDue = (db.prepare(`SELECT COUNT(*) c FROM followup_tasks WHERE status = 'due'`).get() as { c: number }).c;

  const budgetRows = db
    .prepare('SELECT metric, used_value, limit_value, state FROM budget_usage WHERE usage_date = ? ORDER BY metric')
    .all(reportDate) as { metric: string; used_value: number; limit_value: number; state: string }[];

  const costRows = db
    .prepare('SELECT state, currency, SUM(amount_minor) total FROM cost_records WHERE usage_date = ? GROUP BY state, currency')
    .all(reportDate) as { state: string; currency: string; total: number }[];
  const byState: Record<string, number> = {};
  let totalMinor = 0;
  let currency = 'USD';
  for (const r of costRows) {
    byState[r.state] = (byState[r.state] ?? 0) + r.total;
    totalMinor += r.total;
    currency = r.currency;
  }

  return {
    window: { start: s, end: e },
    leads: { created: leadsCreated, byStage },
    attempts,
    calls,
    messages,
    optOuts,
    interactions: {
      total: interRow.total ?? 0,
      inbound: interRow.inbound ?? 0,
      contactEvidence: interRow.contact ?? 0,
    },
    followups: { created: followCreated, completed: followCompleted, dueNow: followDue },
    budget: {
      date: reportDate,
      usage: budgetRows.map((r) => ({
        metric: r.metric,
        used: r.used_value,
        limit: r.limit_value,
        state: r.state,
      })),
    },
    costs: { byState, totalMinor, currency },
    mode: getOperatingState(db).mode,
  };
}

function summaryText(reportDate: string, status: string, totals: ReportTotals, recon: Reconciliation): string {
  const budget =
    totals.budget.usage.length > 0
      ? totals.budget.usage.map((u) => `${u.metric} ${u.used}/${u.limit} (${u.state})`).join(', ')
      : 'no usage';
  const material = recon.discrepancies.filter((d) => d.severity !== 'info');
  const lines = [
    `UWS daily report — ${reportDate} (${status})`,
    `Attempts: ${totals.attempts.total} requested, ${totals.attempts.allowed} allowed, ${totals.attempts.blocked} blocked`,
    `Calls: ${totals.calls.simulated} simulated / ${totals.calls.live} live · Messages: ${totals.messages.simulated} simulated / ${totals.messages.live} live`,
    `Leads created: ${totals.leads.created} · Opt-outs received: ${totals.optOuts} · Follow-ups completed: ${totals.followups.completed}`,
    `Budget: ${budget}`,
    `Costs: ${totals.costs.totalMinor} ${totals.costs.currency} minor units`,
    material.length === 0
      ? 'Reconciliation: all checks passed'
      : `Reconciliation: ${material.length} discrepancy(ies) — ${material.map((d) => `${d.code} ×${d.count}`).join(', ')}`,
  ];
  if (recon.missingData.length > 0) lines.push(`Missing data: ${recon.missingData.join('; ')}`);
  return lines.join('\n');
}

export interface GenerateReportOptions {
  reportDate: string;
  /** NULL = scheduler-generated. */
  generatedBy?: string | null;
  now?: Date;
  /** Raise the owner notification for a final report (default true). */
  notifyOwner?: boolean;
}

/**
 * Generate (or regenerate) the report for one business day. The date may not
 * be in the future: today's report exists only as a preview draft.
 */
export function generateDailyReport(db: DB, cfg: Config, opts: GenerateReportOptions): DailyReport {
  const now = opts.now ?? new Date();
  const todayKey = businessDayKey(now, cfg.businessTimezone);
  if (opts.reportDate > todayKey) {
    throw new AppError('validation_failed', `Cannot generate a report for the future date ${opts.reportDate}`);
  }

  const totals = buildTotals(db, cfg, opts.reportDate);
  const reconciliation = reconcileDay(db, cfg, opts.reportDate, now);
  const status: 'draft' | 'final' = opts.reportDate < todayKey ? 'final' : 'draft';
  const discrepanciesCount = reconciliation.discrepancies.filter((d) => d.severity !== 'info').length;
  const generatedAt = nowIso();
  // The stored row keeps its original id across regenerations (the upsert
  // only refreshes content), so reuse it and the return value matches the DB.
  const existing = db
    .prepare('SELECT id FROM daily_reports WHERE report_date = ?')
    .get(opts.reportDate) as { id: string } | undefined;
  const id = existing?.id ?? newId('rpt');

  db.prepare(
    `INSERT INTO daily_reports (id, report_date, generated_at, generated_by, status, totals_json,
       reconciliation_json, discrepancies_count, missing_data_json, payload_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(report_date) DO UPDATE SET
       generated_at = excluded.generated_at,
       generated_by = excluded.generated_by,
       status = excluded.status,
       totals_json = excluded.totals_json,
       reconciliation_json = excluded.reconciliation_json,
       discrepancies_count = excluded.discrepancies_count,
       missing_data_json = excluded.missing_data_json,
       payload_json = excluded.payload_json`,
  ).run(
    id,
    opts.reportDate,
    generatedAt,
    opts.generatedBy ?? null,
    status,
    JSON.stringify(totals),
    JSON.stringify(reconciliation),
    discrepanciesCount,
    JSON.stringify(reconciliation.missingData),
    JSON.stringify({ version: 1, totals, reconciliation, missingData: reconciliation.missingData }),
  );

  if (status === 'final' && opts.notifyOwner !== false) {
    notify(db, cfg, {
      kind: 'daily_report',
      severity: discrepanciesCount > 0 ? 'warning' : 'info',
      title: `Daily report ${opts.reportDate} ready`,
      body: summaryText(opts.reportDate, status, totals, reconciliation),
      dedupeKey: `report_ready:${opts.reportDate}`,
      entityType: 'daily_report',
      entityId: opts.reportDate,
    });
  }

  return {
    id,
    reportDate: opts.reportDate,
    generatedAt,
    generatedBy: opts.generatedBy ?? null,
    status,
    discrepanciesCount,
    totals,
    reconciliation,
    missingData: reconciliation.missingData,
  };
}

function parseReport(row: Record<string, unknown>): DailyReport {
  return {
    id: row['id'] as string,
    reportDate: row['report_date'] as string,
    generatedAt: row['generated_at'] as string,
    generatedBy: (row['generated_by'] as string | null) ?? null,
    status: row['status'] as 'draft' | 'final',
    discrepanciesCount: row['discrepancies_count'] as number,
    totals: JSON.parse(row['totals_json'] as string) as ReportTotals,
    reconciliation: JSON.parse(row['reconciliation_json'] as string) as Reconciliation,
    missingData: JSON.parse(row['missing_data_json'] as string) as string[],
  };
}

export function getReport(db: DB, reportDate: string): DailyReport | null {
  const row = db.prepare('SELECT * FROM daily_reports WHERE report_date = ?').get(reportDate) as
    | Record<string, unknown>
    | undefined;
  return row ? parseReport(row) : null;
}

export function requireReport(db: DB, reportDate: string): DailyReport {
  const report = getReport(db, reportDate);
  if (!report) throw notFound('Daily report');
  return report;
}

export interface ReportSummary {
  reportDate: string;
  generatedAt: string;
  generatedBy: string | null;
  status: 'draft' | 'final';
  discrepanciesCount: number;
}

export function listReports(db: DB, limit = 30): ReportSummary[] {
  const rows = db
    .prepare(
      `SELECT report_date, generated_at, generated_by, status, discrepancies_count
         FROM daily_reports ORDER BY report_date DESC LIMIT ?`,
    )
    .all(Math.min(Math.max(limit, 1), 120)) as {
    report_date: string;
    generated_at: string;
    generated_by: string | null;
    status: 'draft' | 'final';
    discrepancies_count: number;
  }[];
  return rows.map((r) => ({
    reportDate: r.report_date,
    generatedAt: r.generated_at,
    generatedBy: r.generated_by,
    status: r.status,
    discrepanciesCount: r.discrepancies_count,
  }));
}
