/**
 * Scheduled integration health checks (Phase 11B).
 *
 * Runs the FREE `ping()` probe for every integration on a 30-minute interval
 * and persists each result (integration_health), so the dashboard's "last
 * health check" stays fresh without anyone clicking "Test connection".
 *
 * Deliberate behaviours:
 *  - NO `requiresOutreachEnabled`: health must be observable even while
 *    outreach is paused / in simulation (which is the default state);
 *  - probes are free by adapter contract — an unconfigured or disabled
 *    integration performs NO network I/O (honest state, no fabricated OK);
 *  - silent when everything is healthy (no job_runs churn); a run records
 *    detail ONLY when a configured integration's probe actually fails
 *    (state 'error') — expected 'unconfigured'/'disabled' states are not
 *    failures and do not spam the run history.
 */
import { registerJob, type JobDefinition } from './scheduler.ts';
import { INTEGRATION_KEYS, type AdapterRegistry } from '../adapters/registry.ts';
import { runHealthCheck } from '../domain/integrations/service.ts';

export const HEALTH_CHECK_INTERVAL_MS = 30 * 60_000;

export const healthCheckJob: JobDefinition = {
  name: 'health_check',
  intervalMs: HEALTH_CHECK_INTERVAL_MS,
  async run(ctx) {
    const registry: AdapterRegistry | undefined = ctx.adapters;
    if (!registry) return undefined; // no registry in this context: nothing to probe

    let healthy = 0;
    const failures: string[] = [];
    for (const key of INTEGRATION_KEYS) {
      try {
        const res = await runHealthCheck(ctx.db, ctx.config, registry, key);
        if (res.ok) {
          healthy += 1;
        } else if (res.state === 'error') {
          // Only real probe failures are worth a job_runs entry; expected
          // unconfigured/disabled states are silent.
          failures.push(`${key} (${res.detail.slice(0, 80)})`);
        }
      } catch (err) {
        failures.push(`${key} (${err instanceof Error ? err.message.slice(0, 80) : 'probe error'})`);
      }
    }

    if (failures.length > 0) {
      return { detail: `${healthy}/${INTEGRATION_KEYS.length} healthy — failing: ${failures.join('; ')}` };
    }
    return undefined; // all healthy (or honestly unconfigured): silent
  },
};

/** Register Phase 11B background jobs. Called once at boot. */
export function registerHealthJobs(): void {
  registerJob(healthCheckJob);
}
