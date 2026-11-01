/**
 * Routes: duplicate review queue.
 *
 * High-confidence matches are merged automatically at import time; uncertain
 * matches land here for an explicit owner/staff decision. Neither decision
 * deletes data - merging records a merge_history entry with every conflict.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { resolveDuplicate } from '../../domain/leads/dedupe.ts';
import { notFound } from '../../core/errors.ts';

export function duplicateRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    asyncRoute((req, res) => {
      const q = z
        .object({
          status: z.enum(['pending', 'merged', 'rejected', 'reviewed_not_duplicate']).optional(),
          page: z.coerce.number().int().min(1).default(1),
          pageSize: z.coerce.number().int().min(1).max(100).default(25),
        })
        .parse(req.query);
      const status = q.status ?? 'pending';
      const total = (
        req.ctx.deps.db.prepare('SELECT COUNT(*) c FROM duplicate_candidates WHERE status = ?').get(status) as {
          c: number;
        }
      ).c;
      const rows = req.ctx.deps.db
        .prepare(
          `SELECT d.*,
                  a.display_name AS name_a, a.merged_into_id AS merged_a, a.discovered_at AS discovered_a,
                  b.display_name AS name_b, b.merged_into_id AS merged_b, b.discovered_at AS discovered_b
             FROM duplicate_candidates d
             JOIN businesses a ON a.id = d.business_id_a
             JOIN businesses b ON b.id = d.business_id_b
            WHERE d.status = ?
            ORDER BY d.match_score DESC, d.created_at ASC
            LIMIT ? OFFSET ?`,
        )
        .all(status, q.pageSize, (q.page - 1) * q.pageSize) as unknown as Record<string, unknown>[];
      res.json({ items: rows, total, page: q.page, pageSize: q.pageSize });
    }),
  );

  router.post(
    '/:id/decision',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const body = z
        .object({
          decision: z.enum(['merge', 'not_duplicate']),
          note: z.string().max(500).optional(),
        })
        .parse(req.body);

      const row = req.ctx.deps.db.prepare('SELECT id FROM duplicate_candidates WHERE id = ?').get(id);
      if (!row) throw notFound('Duplicate candidate');

      let result: { survivorId: string; mergedId: string | null };
      try {
        result = resolveDuplicate(
          req.ctx.deps.db,
          id,
          body.decision,
          { userId: req.ctx.user!.id, label: req.ctx.user!.role },
          body.note,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes('not found')) throw notFound('Duplicate candidate');
        throw err;
      }
      res.json({ ok: true, ...result });
    }),
  );

  return router;
}
