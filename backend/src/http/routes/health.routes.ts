/**
 * Routes: system health (public, minimal) and detailed system status (auth).
 *
 * The public endpoint deliberately exposes nothing but liveness so an
 * unscanner cannot learn configuration details.
 *
 * Phase 11A: `GET /api/integrations` is extended with per-integration health,
 * usage and toggles; `POST /api/integrations/:key/test` runs a FREE health
 * probe (owner + CSRF only). Neither endpoint ever returns a secret: statuses
 * carry env-var NAMES via credentialPresence and redacted details only.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { hasPendingMigrations } from '../../db/migrate.ts';
import { getOperatingState, summarise } from '../../domain/state/service.ts';
import { latestBackup, latestRestoreTest } from '../../domain/backup/service.ts';
import { listJobRuns } from '../../jobs/scheduler.ts';
import {
  assertIntegrationKey,
  getToggles,
  lastHealthChecks,
  runHealthCheck,
  usageSummary,
} from '../../domain/integrations/service.ts';
import { getOnboardingState, recordOnboardingVerification } from '../../domain/integrations/onboarding.ts';

export function healthRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/health',
    asyncRoute((_req, res) => {
      let dbOk = true;
      try {
        deps.db.prepare('SELECT 1').get();
      } catch {
        dbOk = false;
      }
      res.status(dbOk ? 200 : 503).json({
        status: dbOk ? 'ok' : 'degraded',
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString(),
      });
    }),
  );

  router.get(
    '/system',
    requireAuth,
    asyncRoute((_req, res) => {
      let dbOk = true;
      let pendingMigrations = false;
      try {
        deps.db.prepare('SELECT 1').get();
        pendingMigrations = hasPendingMigrations(deps.db);
      } catch {
        dbOk = false;
      }
      const state = getOperatingState(deps.db);
      const summary = summarise(deps.db);
      const lastBackup = latestBackup(deps.db);
      const lastRestoreTest = latestRestoreTest(deps.db);
      const incidents = deps.db
        .prepare(
          `SELECT id, component, severity, title, status, detected_at
             FROM incidents
            WHERE status IN ('open','investigating','mitigated')
            ORDER BY detected_at DESC LIMIT 20`,
        )
        .all();
      res.json({
        status: dbOk && !pendingMigrations ? 'ok' : 'degraded',
        node: process.version,
        uptimeSeconds: Math.round(process.uptime()),
        database: { ok: dbOk, pendingMigrations, path: deps.config.databasePath },
        operatingState: state,
        summary,
        providers: deps.config.providers,
        backups: {
          enabled: deps.config.backup.enabled,
          encryptionConfigured: Boolean(deps.config.backup.passphrase),
          last: lastBackup
            ? {
                id: lastBackup.id,
                status: lastBackup.status,
                createdAt: lastBackup.createdAt,
                encrypted: lastBackup.encrypted,
                sizeBytes: lastBackup.sizeBytes,
                error: lastBackup.error,
              }
            : null,
          lastRestoreTest: lastRestoreTest
            ? { id: lastRestoreTest.id, status: lastRestoreTest.status, startedAt: lastRestoreTest.startedAt, backupId: lastRestoreTest.backupId }
            : null,
        },
        incidents,
        recentJobs: listJobRuns(deps.db, 10),
        ephemeralSessionSecret: deps.config.ephemeralSessionSecret,
        timestamp: new Date().toISOString(),
      });
    }),
  );

  // Adapter-level integration status: which implementation would actually
  // serve each port right now, plus the last (redacted) adapter error. Secret
  // values never leave the registry.
  //
  // Phase 11A extension: health (last probe), usage aggregates, toggles,
  // portfolio template presence, and the email notification queue depth —
  // everything the Integrations dashboard needs in ONE authed call. Still
  // zero secrets: details are redacted at write time, template names are not
  // secrets, and credentialPresence lists env-var NAMES only.
  router.get(
    '/integrations',
    requireAuth,
    asyncRoute((req, res) => {
      const adapters = req.ctx.deps.adapters;
      const db = req.ctx.deps.db;
      const cfg = req.ctx.deps.config;

      let emailQueue = { pending: 0, failed: 0, sent: 0 };
      try {
        const row = db
          .prepare(
            `SELECT
               SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
               SUM(CASE WHEN status = 'failed'  THEN 1 ELSE 0 END) AS failed,
               SUM(CASE WHEN status = 'sent'    THEN 1 ELSE 0 END) AS sent
             FROM notifications WHERE channel = 'email'`,
          )
          .get() as { pending: number | null; failed: number | null; sent: number | null };
        emailQueue = { pending: row.pending ?? 0, failed: row.failed ?? 0, sent: row.sent ?? 0 };
      } catch {
        /* table missing (fresh dev db): report zeros */
      }

      res.json({
        adapters: adapters ? adapters.statuses() : [],
        credentialPresence: cfg.providers,
        operatingMode: getOperatingState(db).mode,
        // Phase 11A fields:
        health: lastHealthChecks(db),
        usage: usageSummary(db, 7),
        toggles: getToggles(db, cfg),
        // Phase 11B fields: onboarding verification state per integration
        // (pending|verified|failed — never credentials, only outcomes).
        onboarding: getOnboardingState(db),
        portfolioTemplate: adapters?.portfolioTemplate
          ? { name: adapters.portfolioTemplate.name, language: adapters.portfolioTemplate.language }
          : null,
        emailQueue,
        resilience: { retryAttempts: cfg.adapter.retryAttempts, ratePerMinute: cfg.adapter.ratePerMinute },
        speechDefaults: { language: cfg.speech.language, voiceConfigured: Boolean(cfg.speech.voice), voiceUrConfigured: Boolean(cfg.speech.voiceUr) },
      });
    }),
  );

  // "Test connection" — runs the FREE ping() probe for one integration and
  // persists the result as the new "last health check". Owner + CSRF only.
  // A disabled or unconfigured integration returns ok=false with an honest
  // state and performs NO network I/O.
  const testBody = z.object({ key: z.string() });

  router.post(
    '/integrations/:key/test',
    requireAuth,
    requireCsrf,
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      const parsedKey = testBody.safeParse({ key: req.params['key'] });
      if (!parsedKey.success) {
        res.status(400).json({ error: { code: 'validation_failed', message: 'Integration key is required' } });
        return;
      }
      const key = assertIntegrationKey(parsedKey.data.key);
      const registry = req.ctx.deps.adapters;
      if (!registry) {
        res.status(503).json({
          error: { code: 'provider_unavailable', message: 'Adapter registry is not available in this context' },
        });
        return;
      }
      const result = await runHealthCheck(req.ctx.deps.db, req.ctx.deps.config, registry, key);
      res.json({ result });
    }),
  );

  // "Verify provider" (Phase 11B) — runs the FREE connection probe and
  // records the onboarding outcome (pending -> verified / failed) for this
  // integration. Owner + CSRF only. Live mode cannot be enabled until the
  // telephony integration is verified through this path. Credentials are
  // never echoed, stored or logged — only the redacted probe summary.
  router.post(
    '/integrations/:key/onboard',
    requireAuth,
    requireCsrf,
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      const parsedKey = testBody.safeParse({ key: req.params['key'] });
      if (!parsedKey.success) {
        res.status(400).json({ error: { code: 'validation_failed', message: 'Integration key is required' } });
        return;
      }
      const key = assertIntegrationKey(parsedKey.data.key);
      const registry = req.ctx.deps.adapters;
      if (!registry) {
        res.status(503).json({
          error: { code: 'provider_unavailable', message: 'Adapter registry is not available in this context' },
        });
        return;
      }
      const result = await recordOnboardingVerification(req.ctx.deps.db, req.ctx.deps.config, registry, key, {
        userId: req.ctx.user!.id,
        label: 'owner',
      });
      res.json(result);
    }),
  );

  return router;
}
