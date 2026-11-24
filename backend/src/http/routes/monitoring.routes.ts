/**
 * Routes: backups & restore-test history (Phase 9) plus the Phase 10
 * monitoring report and the internal backup-cron trigger.
 *
 * OWNER ONLY: backup records expose filesystem paths and operational detail,
 * and the monitoring report exposes database size/connection numbers. The
 * dashboard uses backups to answer "when was the last backup, and was it
 * proven restorable?" — the two questions that actually matter in an incident.
 *
 * The internal trigger (POST /internal/backup/run) is NOT session-authenticated:
 * it is called by an external scheduler (Cloudflare Worker cron) with a bearer
 * secret. It can only ever run a backup — never outreach, never configuration.
 */
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../types.ts';
import { requireCsrf, requireRole } from '../middleware/session.ts';
import {
  latestBackup,
  latestRestoreTest,
  listBackups,
  listRestoreTests,
  runBackup,
  runRestoreTest,
} from '../../domain/backup/service.ts';
import { collectMetrics } from '../../domain/monitoring/service.ts';

/** Constant-time bearer comparison (length is compared first, then contents). */
function bearerMatches(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const prefix = 'Bearer ';
  if (!header.startsWith(prefix)) return false;
  const presented = Buffer.from(header.slice(prefix.length).trim(), 'utf8');
  const expected = Buffer.from(secret, 'utf8');
  if (presented.length !== expected.length) return false;
  return timingSafeEqual(presented, expected);
}

export function monitoringRoutes(): Router {
  const router = Router();

  router.get(
    '/backups',
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      const { db, config } = req.ctx.deps;
      res.json({
        enabled: config.backup.enabled,
        dir: config.backup.dir,
        retentionDays: config.backup.retentionDays,
        intervalHours: config.backup.intervalHours,
        restoreTestDays: config.backup.restoreTestDays,
        encryptionConfigured: Boolean(config.backup.passphrase),
        lastBackup: await latestBackup(db),
        lastRestoreTest: await latestRestoreTest(db),
        items: await listBackups(db),
        restoreTests: await listRestoreTests(db),
      });
    }),
  );

  // ------------------------------------------------------- monitoring -----
  // App-side resource report: DB size/connections/latency + backup
  // storage/failures/age against the 70/85/95% thresholds.
  router.get(
    '/monitoring',
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      const report = await collectMetrics(req.ctx.deps.db, req.ctx.deps.config);
      res.json(report);
    }),
  );

  // ------------------------------------------- internal backup trigger -----
  // Bearer-authenticated (BACKUP_TRIGGER_SECRET); no session/CSRF because the
  // caller is an external cron, not a browser. Empty secret = endpoint inert.
  // Backup-only by construction: this handler cannot reach any other domain.
  router.post(
    '/internal/backup/run',
    asyncRoute(async (req, res) => {
      const { db, config, logger } = req.ctx.deps;
      const secret = config.backup.triggerSecret;
      if (!secret) {
        // Not configured: behave as if the route does not exist.
        res.status(404).json({ error: { code: 'not_found', message: 'Not found' } });
        return;
      }
      const header = typeof req.headers.authorization === 'string' ? req.headers.authorization : null;
      if (!bearerMatches(header, secret)) {
        // Logs the IP hash only — never the presented token.
        logger.warn('backup.trigger.bad_auth', { ipHash: req.ctx.ipHash });
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid trigger credentials' } });
        return;
      }
      if (!config.backup.enabled) {
        res.status(409).json({
          error: { code: 'conflict', message: 'Backups are disabled (BACKUP_ENABLED=false)' },
        });
        return;
      }
      const record = await runBackup(db, config, { actor: { userId: null, label: 'scheduler' } });
      res.status(201).json({ backup: record });
    }),
  );

  // Trigger a restore test on demand (also runs automatically on schedule).
  router.post(
    '/backups/:id/restore-test',
    requireCsrf,
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).max(64).parse(req.params.id);
      const test = await runRestoreTest(req.ctx.deps.db, req.ctx.deps.config, {
        backupId: id,
        performedBy: req.ctx.user!.id,
      });
      res.status(201).json({ restoreTest: test });
    }),
  );

  return router;
}
