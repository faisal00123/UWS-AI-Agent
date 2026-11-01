/**
 * Application entry point.
 *
 * Boot order (each step fails fast with a clear message):
 *   1. load + validate environment configuration
 *   2. open database and run pending migrations
 *   3. build the HTTP app (security middleware, routes, SPA)
 *   4. start the background scheduler (reads safeguards from the DB every tick)
 *   5. listen
 *
 * Nothing in this file performs outbound actions: the operating mode defaults
 * to simulation and live outreach always requires an explicit owner action.
 */
import { loadConfig } from '../core/config.ts';
import { createLogger } from '../core/logger.ts';
import { openDatabase } from '../db/index.ts';
import { runMigrations } from '../db/migrate.ts';
import { markApplicationStart } from '../domain/state/service.ts';
import { buildRegistry, type AdapterUsageEvent } from '../adapters/registry.ts';
import { isIntegrationEnabled, recordAdapterUsage } from '../domain/integrations/service.ts';
import { createApp } from './app.ts';
import { registerReportingJobs } from '../jobs/reporting.ts';
import { registerBackupJobs } from '../jobs/backup.ts';
import { registerHealthJobs } from '../jobs/health.ts';
import { startScheduler, type Scheduler } from '../jobs/scheduler.ts';

const config = loadConfig();
const logger = createLogger(config.logLevel, config.logRedact);

async function main(): Promise<void> {
  const db = openDatabase(config.databasePath);
  const migration = runMigrations(db);
  if (migration.applied.length > 0) {
    logger.info('database.migrations.applied', {
      applied: migration.applied.join(', '),
    });
  }

  // Restart safety: outreach is paused on every start and must be resumed
  // manually by the owner (Section 3.5).
  const bootState = markApplicationStart(db);
  if (bootState.paused) {
    logger.warn('outreach.paused_after_start', {
      reason: bootState.pauseReason,
      mode: bootState.mode,
    });
  }

  // One adapter registry is built from the process environment and shared by
  // the HTTP layer (outreach seam, webhooks) and background jobs (notification
  // delivery). `buildRegistry` returns all-unconfigured when no credentials
  // are present — statuses stay honest without env vars.
  //
  // Phase 11A: two db-backed callbacks are wired in:
  //   isEnabled — honors the owner's per-integration enable/disable toggle;
  //   onUsage   — persists one `adapter_usage` row per operation.
  // Both are read-only for isEnabled and append-only for usage.
  const adapters = buildRegistry(config, process.env, {
    isEnabled: (key) => isIntegrationEnabled(db, config, key),
    onUsage: (event: AdapterUsageEvent) =>
      recordAdapterUsage(db, {
        integration: event.integration,
        operation: event.operation,
        outcome: event.outcome,
        errorCode: event.errorCode ?? null,
        durationMs: event.durationMs,
        retries: event.retries,
        occurredAt: event.occurredAt,
      }),
  });

  const app = createApp({ config, db, logger, adapters });
  const server = app.listen(config.port);
  server.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `\n[FATAL] Port ${config.port} is already in use.` +
          `\n        Free the port or start with a different one, e.g.` +
          `\n        cmd:  set PORT=3101 && npm start\n\n`,
      );
    } else {
      process.stderr.write(`\n[FATAL] server error: ${err.message}\n\n`);
    }
    process.exit(1);
  });
  server.on('listening', () => {
    logger.info('server.listening', {
      port: config.port,
      mode: bootState.mode,
      env: config.nodeEnv,
    });
    // The banner is intentionally explicit about the operating mode so that a
    // developer can never mistake simulation for live outreach.
    process.stdout.write(
      `\n  UWS AI Sales Agent  |  mode: ${bootState.mode.toUpperCase()}` +
        `${bootState.mode === 'simulation' ? ' (no real outreach possible)' : ''}` +
        `  |  paused: ${bootState.paused ? 'YES (resume from dashboard)' : 'no'}` +
        `  |  http://localhost:${config.port}\n\n`,
    );
  });

  registerReportingJobs();
  registerBackupJobs();
  // Phase 11B: 30-minute free health probes for every integration. Runs even
  // in simulation/outreach-disabled state — health is always observable.
  registerHealthJobs();
  const scheduler: Scheduler = startScheduler({ config, db, logger, adapters });

  const shutdown = (signal: string): void => {
    logger.info('server.shutdown', { signal });
    scheduler.stop();
    server.close(() => {
      db.close();
      process.exit(0);
    });
    // Hard exit if providers/jobs hang.
    setTimeout(() => process.exit(1), 8000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandledRejection', { reason: String(reason) });
  });
}

main().catch((err: unknown) => {
  process.stderr.write(`\n[FATAL] failed to start: ${String(err)}\n`);
  if (err instanceof Error && err.stack) process.stderr.write(err.stack + '\n');
  process.exit(1);
});
