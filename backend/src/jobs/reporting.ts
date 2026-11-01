/**
 * Reporting & notification jobs (Phase 8).
 *
 * Design rules inherited from the scheduler:
 *  - jobs never perform outreach; they only read the ledger, write reports
 *    and raise notifications (all of which work while outreach is paused —
 *    the owner must hear about an emergency stop even while stopped)
 *  - a silent no-op returns no detail and is NOT written to job_runs, so a
 *    60-second watcher cannot churn the bounded run history; failures are
 *    always recorded (and raise an incident)
 *  - every notification is deduplicated by an event-scoped key, so re-running
 *    a job after a restart can never re-spam the owner
 */
import { registerJob, type JobDefinition } from './scheduler.ts';
import { getOperatingState } from '../domain/state/service.ts';
import { notify, deliverPendingNotifications } from '../domain/notifications/service.ts';
import { generateDailyReport } from '../domain/reporting/report.ts';
import { businessDayUtcRange, pastBusinessDayKeys, previousBusinessDayKey } from '../domain/reporting/reconcile.ts';
import { businessDayKey } from '../core/time.ts';

/**
 * Generate the daily report for every business day that needs one:
 *  - yesterday always (a zero-activity day still gets an honest zero report)
 *  - older days (up to 7 back) only when they had outreach activity or an
 *    existing draft to finalize — a fresh install does not backfill noise
 */
export const dailyReportJob: JobDefinition = {
  name: 'daily_report',
  intervalMs: 60 * 60 * 1000, // hourly: soon after business-day midnight
  run(ctx) {
    const { db, config, now } = ctx;
    const yesterday = previousBusinessDayKey(now, config.businessTimezone);
    const candidates = pastBusinessDayKeys(now, config.businessTimezone, 7);
    let generated = 0;
    for (const reportDate of candidates) {
      if (reportDate !== yesterday) {
        const existing = db.prepare('SELECT status FROM daily_reports WHERE report_date = ?').get(reportDate) as
          | { status: string }
          | undefined;
        if (existing?.status === 'final') continue; // already finalized
        if (!existing) {
          const { start, end } = businessDayUtcRange(config, reportDate);
          const activity = db
            .prepare(`SELECT COUNT(*) c FROM outreach_attempts WHERE created_at >= ? AND created_at < ?`)
            .get(start.toISOString(), end.toISOString()) as { c: number };
          if (activity.c === 0) continue; // nothing happened, nothing to report
        }
      }
      generateDailyReport(db, config, { reportDate, generatedBy: null, now });
      generated += 1;
    }
    return generated > 0 ? { detail: `generated/refreshed ${generated} report(s)` } : undefined;
  },
};

/** Deliver queued email notifications; WhatsApp is honestly skipped (template policy). */
export const notificationDeliveryJob: JobDefinition = {
  name: 'notification_delivery',
  intervalMs: 60_000,
  async run(ctx) {
    const res = await deliverPendingNotifications(ctx.db, ctx.config, {
      email: ctx.adapters?.email ?? null,
    });
    if (res.sent + res.failed + res.skipped > 0) {
      return { detail: `sent ${res.sent}, failed ${res.failed}, skipped ${res.skipped}` };
    }
    return undefined; // queue empty: silent no-op, no job_runs churn
  },
};

/**
 * Raise owner notifications for safeguard states that must not be missed:
 * an active emergency stop, and daily budget caps at warning/exhaustion.
 * Dedupe keys are event-scoped (stop timestamp / date+metric+state), so the
 * watcher can run forever without repeating itself.
 */
export const safeguardWatchJob: JobDefinition = {
  name: 'safeguard_notifications',
  intervalMs: 5 * 60_000,
  run(ctx) {
    const { db, config, now } = ctx;
    let raised = 0;

    const state = getOperatingState(db);
    if (state.emergencyStop && state.emergencyStopAt) {
      const res = notify(db, config, {
        kind: 'emergency_stop',
        severity: 'critical',
        title: 'Emergency stop is ACTIVE',
        body: `All outreach is stopped${state.emergencyStopReason ? `: ${state.emergencyStopReason}` : ''} (since ${state.emergencyStopAt}). Resuming requires the owner.`,
        dedupeKey: `emergency_stop:${state.emergencyStopAt}`,
        entityType: 'operating_state',
        entityId: '1',
      });
      raised += res.created.length;
    }

    const date = businessDayKey(now, config.businessTimezone);
    const rows = db
      .prepare(
        `SELECT metric, used_value, limit_value, state FROM budget_usage
          WHERE usage_date = ? AND state IN ('warning','exhausted')`,
      )
      .all(date) as { metric: string; used_value: number; limit_value: number; state: string }[];
    for (const row of rows) {
      const pct = row.limit_value > 0 ? Math.round((row.used_value / row.limit_value) * 100) : 100;
      const exhausted = row.state === 'exhausted';
      const res = notify(db, config, {
        kind: 'budget',
        severity: exhausted ? 'critical' : 'warning',
        title: exhausted ? `Daily ${row.metric} limit reached` : `Daily ${row.metric} at ${pct}%`,
        body: exhausted
          ? `${row.metric}: ${row.used_value}/${row.limit_value} used for ${date}. Paid outreach stops at the cap until the owner raises it.`
          : `${row.metric}: ${row.used_value}/${row.limit_value} used for ${date} (${pct}%).`,
        dedupeKey: `budget:${date}:${row.metric}:${row.state}`,
        entityType: 'budget_usage',
        entityId: `${date}:${row.metric}`,
      });
      raised += res.created.length;
    }

    return raised > 0 ? { detail: `raised ${raised} notification(s)` } : undefined;
  },
};

/** Idempotent: registerJob replaces by name, so re-registration is safe. */
export function registerReportingJobs(): void {
  registerJob(dailyReportJob);
  registerJob(notificationDeliveryJob);
  registerJob(safeguardWatchJob);
}
