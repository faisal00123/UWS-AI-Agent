/**
 * Routes: opt-in unsuppression review (Phase 11B).
 *
 * A prospect's later opt-in / consent message never removes a suppression by
 * itself — it only lands in this REVIEW QUEUE. Every decision here is
 * owner-only, CSRF-protected, reason-mandatory and audited; lifting marks the
 * existing row `lifted_at` (append-only — evidence is never deleted).
 *
 *   GET  /api/suppression/candidates  — active suppressions with inbound
 *                                       opt-in/consent evidence attached
 *   GET  /api/suppression/reviews     — decision history (audit trail view)
 *   POST /api/suppression/:id/review  — owner decision: { decision, reason }
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { listLiftCandidates, listSuppressionReviews, reviewSuppression } from '../../domain/eligibility/unsuppress.ts';

export function reviewRoutes(_deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/candidates',
    requireAuth,
    requireRole('owner'),
    asyncRoute((_req, res) => {
      res.json({ candidates: listLiftCandidates(_req.ctx.deps.db) });
    }),
  );

  router.get(
    '/reviews',
    requireAuth,
    requireRole('owner'),
    asyncRoute((_req, res) => {
      res.json({ reviews: listSuppressionReviews(_req.ctx.deps.db) });
    }),
  );

  const reviewBody = z.object({
    decision: z.enum(['lifted', 'kept']),
    reason: z.string().min(3).max(500),
  });

  router.post(
    '/:id/review',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    asyncRoute((req, res) => {
      const parsed = reviewBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: { code: 'validation_failed', message: 'decision (lifted|kept) and a reason (3-500 chars) are required' },
        });
        return;
      }
      const review = reviewSuppression(
        req.ctx.deps.db,
        z.string().min(1).parse(req.params['id']),
        parsed.data.decision,
        parsed.data.reason,
        {
          userId: req.ctx.user!.id,
          label: 'owner',
          displayName: req.ctx.user!.displayName,
          ipHash: req.ctx.ipHash,
        },
      );
      res.json({ review });
    }),
  );

  return router;
}
