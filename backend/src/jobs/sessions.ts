/**
 * Session hygiene: delete expired session rows.
 *
 * Expired sessions already fail at load time (loadSession deletes the row it
 * is handed), but a session nobody ever presents again would otherwise sit in
 * the table forever — accumulating hashed tokens, CSRF secrets and IP hashes.
 * This job removes them in bulk once a day.
 *
 * Silent when there is nothing to purge (no `job_runs` churn); a run only
 * records detail when rows were actually deleted.
 */
import { registerJob, type JobDefinition } from './scheduler.ts';
import { purgeExpiredSessions } from '../domain/auth/service.ts';

export const SESSION_PURGE_INTERVAL_MS = 24 * 60 * 60_000;

export const sessionPurgeJob: JobDefinition = {
  name: 'session_purge',
  intervalMs: SESSION_PURGE_INTERVAL_MS,
  async run(ctx) {
    const purged = await purgeExpiredSessions(ctx.db);
    return purged > 0 ? { detail: `${purged} expired session(s) purged` } : undefined;
  },
};

/** Register session-hygiene jobs. Called once at boot. */
export function registerSessionJobs(): void {
  registerJob(sessionPurgeJob);
}
