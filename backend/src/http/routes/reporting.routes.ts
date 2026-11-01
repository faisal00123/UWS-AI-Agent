/**
 * Routes: notifications & daily reports (Phase 8).
 *
 * RBAC split follows the data:
 *  - notifications are day-to-day operational surfacing: owner + staff read,
 *    owner + staff may mark read
 *  - reports contain budget/spend figures and the reconciliation record:
 *    OWNER ONLY, including on-demand generation
 *
 * Generation is idempotent per date (one row per business day), so the
 * "generate now" button can never duplicate a report or re-spam the owner:
 * the report_ready notification is deduplicated per date.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../types.ts';
import { requireCsrf, requireRole } from '../middleware/session.ts';
import { recordAudit } from '../../domain/audit/service.ts';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  unreadCount,
} from '../../domain/notifications/service.ts';
import { generateDailyReport, listReports, requireReport } from '../../domain/reporting/report.ts';

const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD');

const listQuery = z.object({
  status: z.enum(['pending', 'sent', 'delivered', 'failed', 'skipped', 'read']).optional(),
  channel: z.enum(['in_app', 'email', 'whatsapp']).optional(),
  unread: z.coerce.boolean().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

const reportQuery = z.object({
  limit: z.coerce.number().int().min(1).max(120).optional(),
});

export function reportingRoutes(): Router {
  const router = Router();
  // NOTE: no router-level `use(requireAuth)` here — this router is mounted at
  // the shared `/api` prefix, and router-level middleware would intercept
  // EVERY /api request (including the public health endpoint and the
  // signature-authenticated webhooks) before their own routers run. Auth is
  // therefore applied per route below; requireRole already answers anonymous
  // requests with 401.

  // -------------------------------------------------------- notifications ---
  router.get(
    '/notifications',
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const q = listQuery.parse(req.query ?? {});
      const items = listNotifications(req.ctx.deps.db, {
        status: q.status,
        channel: q.channel,
        unreadOnly: q.unread,
        limit: q.limit,
      });
      res.json({ items, unread: unreadCount(req.ctx.deps.db) });
    }),
  );

  router.post(
    '/notifications/read-all',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const updated = markAllNotificationsRead(req.ctx.deps.db);
      res.json({ updated, unread: unreadCount(req.ctx.deps.db) });
    }),
  );

  router.post(
    '/notifications/:id/read',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = z.string().min(1).max(64).parse(req.params.id);
      const notification = markNotificationRead(req.ctx.deps.db, id);
      res.json({ notification, unread: unreadCount(req.ctx.deps.db) });
    }),
  );

  // ---------------------------------------------------------------- reports ---
  router.get(
    '/reports',
    requireRole('owner'),
    asyncRoute((req, res) => {
      const q = reportQuery.parse(req.query ?? {});
      res.json({ items: listReports(req.ctx.deps.db, q.limit ?? 30) });
    }),
  );

  router.get(
    '/reports/:date',
    requireRole('owner'),
    asyncRoute((req, res) => {
      const date = dateParam.parse(req.params.date);
      res.json({ report: requireReport(req.ctx.deps.db, date) });
    }),
  );

  router.post(
    '/reports/:date/generate',
    requireCsrf,
    requireRole('owner'),
    asyncRoute((req, res) => {
      const date = dateParam.parse(req.params.date);
      const report = generateDailyReport(req.ctx.deps.db, req.ctx.deps.config, {
        reportDate: date,
        generatedBy: req.ctx.user!.id,
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'report.generate',
        entityType: 'daily_report',
        entityId: date,
        summary: `Daily report ${date} generated (${report.status})`,
        details: {
          status: report.status,
          attempts: report.totals.attempts.total,
          discrepancies: report.discrepanciesCount,
        },
      });
      res.status(201).json({ report });
    }),
  );

  return router;
}
