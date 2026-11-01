/**
 * Routes: backups & restore-test history (Phase 9, monitoring surface).
 *
 * OWNER ONLY: backup records expose filesystem paths and operational detail.
 * The dashboard uses this to show "when was the last backup, and was it
 * proven restorable?" — the two questions that actually matter in an incident.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../types.ts';
import { requireCsrf, requireRole } from '../middleware/session.ts';
import {
  latestBackup,
  latestRestoreTest,
  listBackups,
  listRestoreTests,
  runRestoreTest,
} from '../../domain/backup/service.ts';

export function monitoringRoutes(): Router {
  const router = Router();

  router.get(
    '/backups',
    requireRole('owner'),
    asyncRoute((req, res) => {
      const { db, config } = req.ctx.deps;
      res.json({
        enabled: config.backup.enabled,
        dir: config.backup.dir,
        retentionDays: config.backup.retentionDays,
        intervalHours: config.backup.intervalHours,
        restoreTestDays: config.backup.restoreTestDays,
        encryptionConfigured: Boolean(config.backup.passphrase),
        lastBackup: latestBackup(db),
        lastRestoreTest: latestRestoreTest(db),
        items: listBackups(db),
        restoreTests: listRestoreTests(db),
      });
    }),
  );

  // Trigger a restore test on demand (also runs automatically on schedule).
  router.post(
    '/backups/:id/restore-test',
    requireCsrf,
    requireRole('owner'),
    asyncRoute((req, res) => {
      const id = z.string().min(1).max(64).parse(req.params.id);
      const test = runRestoreTest(req.ctx.deps.db, req.ctx.deps.config, {
        backupId: id,
        performedBy: req.ctx.user!.id,
      });
      res.status(201).json({ restoreTest: test });
    }),
  );

  return router;
}
