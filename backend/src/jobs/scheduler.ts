/**
 * Background scheduler.
 *
 * Design rules:
 *   - every tick re-reads operating state from the database, so an emergency
 *     stop or a restart-pause immediately blocks all scheduled work
 *   - each job run is recorded in `job_runs` (health visibility)
 *   - a failing job records an incident instead of crashing the process
 *   - the scheduler never performs outreach itself; it calls domain services
 *     which evaluate the full safeguard stack before doing anything
 */
import type { DB } from '../db/index.ts';
import type { Config } from '../core/config.ts';
import type { Logger } from '../core/logger.ts';
import type { AdapterRegistry } from '../adapters/registry.ts';
import { nowIso } from '../core/time.ts';
import { summarise } from '../domain/state/service.ts';
import { recordAudit } from '../domain/audit/service.ts';

export interface JobContext {
  db: DB;
  config: Config;
  logger: Logger;
  /** Snapshot of operating state at tick start (re-read every tick). */
  guard: ReturnType<typeof summarise>;
  now: Date;
  /** Provider registry for jobs that deliver (e.g. notification email). */
  adapters?: AdapterRegistry;
}

export interface JobDefinition {
  name: string;
  /** milliseconds between runs */
  intervalMs: number;
  /** When false the job is skipped (but still logged) this tick. */
  requiresOutreachEnabled?: boolean;
  run(ctx: JobContext): Promise<{ detail?: string } | void> | { detail?: string } | void;
}

export interface Scheduler {
  stop(): void;
  /** Run one tick immediately (used by tests and by "run now" buttons). */
  tick(now?: Date): Promise<void>;
  isRunning(): boolean;
}

const JOB_REGISTRY: JobDefinition[] = [];

export function registerJob(job: JobDefinition): void {
  const existing = JOB_REGISTRY.findIndex((j) => j.name === job.name);
  if (existing >= 0) JOB_REGISTRY[existing] = job;
  else JOB_REGISTRY.push(job);
}

export function listJobs(): { name: string; intervalMs: number }[] {
  return JOB_REGISTRY.map((j) => ({ name: j.name, intervalMs: j.intervalMs }));
}

export function listJobRuns(db: DB, limit = 20): unknown[] {
  return db
    .prepare('SELECT id, job_name, started_at, finished_at, status, detail, error FROM job_runs ORDER BY id DESC LIMIT ?')
    .all(limit);
}

interface LastRun {
  lastRunAt: number;
}

export function startScheduler(opts: {
  config: Config;
  db: DB;
  logger: Logger;
  adapters?: AdapterRegistry;
}): Scheduler {
  const { config, db, logger } = opts;
  const lastRuns = new Map<string, LastRun>();
  let stopped = false;
  let ticking = false;

  const recordRun = (
    name: string,
    startedAt: string,
    status: 'success' | 'failed' | 'skipped',
    detail: string | null,
    error: string | null,
  ): void => {
    db.prepare(
      `INSERT INTO job_runs (job_name, started_at, finished_at, status, detail, error)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(name, startedAt, nowIso(), status, detail, error);
    // Keep the run history bounded.
    db.prepare(
      `DELETE FROM job_runs WHERE id NOT IN (SELECT id FROM job_runs ORDER BY id DESC LIMIT 500)`,
    ).run();
  };

  const runJob = async (job: JobDefinition, now: Date): Promise<void> => {
    const startedAt = nowIso();
    try {
      const guard = summarise(db);
      if (job.requiresOutreachEnabled && !guard.outreachEnabled) {
        recordRun(job.name, startedAt, 'skipped', `Outreach blocked: ${guard.reason}`, null);
        logger.debug('job.skipped', { job: job.name, reason: guard.reason });
        return;
      }
      const result = await job.run({ db, config, logger, guard, now, adapters: opts.adapters });
      // Silent no-op successes are not written to job_runs: a 60-second
      // watcher would churn the bounded run history (500 rows) and bury real
      // failures. Anything WITH a detail message, plus every failure/skip, is
      // always recorded (failures additionally raise an incident).
      if (result?.detail) recordRun(job.name, startedAt, 'success', result.detail, null);
      logger.debug('job.ok', { job: job.name, detail: result?.detail ?? null });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordRun(job.name, startedAt, 'failed', null, message);
      logger.error('job.failed', { job: job.name, error: message });
      try {
        db.prepare(
          `INSERT INTO incidents (id, component, severity, title, detail, status, detected_at, last_error)
           VALUES (?, ?, 'warning', ?, ?, 'open', ?, ?)`,
        ).run(
          `inc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
          'scheduler',
          `Background job "${job.name}" failed`,
          message,
          nowIso(),
          message,
        );
      } catch {
        /* incident recording must never throw out of the scheduler */
      }
    }
  };

  const tick = async (now = new Date()): Promise<void> => {
    if (ticking) return; // never overlap ticks
    ticking = true;
    try {
      for (const job of JOB_REGISTRY) {
        if (stopped) break;
        const last = lastRuns.get(job.name);
        if (last && now.getTime() - last.lastRunAt < job.intervalMs) continue;
        lastRuns.set(job.name, { lastRunAt: now.getTime() });
        await runJob(job, now);
      }
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick(new Date());
  }, 5_000);
  timer.unref?.();

  logger.info('scheduler.started', { jobs: JOB_REGISTRY.length });
  if (JOB_REGISTRY.length === 0) {
    // Not an error: jobs are registered by their feature modules as they land.
    logger.debug('scheduler.no_jobs_registered', {});
  }

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
      logger.info('scheduler.stopped', {});
    },
    tick,
    isRunning() {
      return !stopped;
    },
  };
}

/** Convenience for jobs that need an audit entry. */
export function auditSystem(
  db: DB,
  action: string,
  summary: string,
  details?: Record<string, unknown>,
): void {
  recordAudit(db, {
    actorLabel: 'scheduler',
    action,
    entityType: 'system',
    entityId: null,
    summary,
    details: details ?? null,
  });
}
