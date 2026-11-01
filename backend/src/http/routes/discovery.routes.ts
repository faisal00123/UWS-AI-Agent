/**
 * Routes: lead discovery (Phase 12).
 *
 *   GET  /api/discovery/status  — honest capability summary (which provider,
 *                                 policy size, simulated or real). Never
 *                                 exposes configuration secrets (there are
 *                                 none for Overpass: it is keyless).
 *   POST /api/discovery/run     — run one discovery pass now (owner + staff,
 *                                 CSRF). Same role posture as CSV import:
 *                                 discovery is research on public data and
 *                                 contacts no customer, so it is allowed in
 *                                 simulation mode too.
 *
 * The run passes through the domain service, which enforces the integration
 * toggle, the configured-provider check, the policy caps and per-city error
 * handling. Blocked/refused outcomes are AppErrors mapped by the shared
 * error middleware (blocked_by_safeguard -> 403, provider_unavailable -> 503).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf } from '../middleware/session.ts';
import { isIntegrationEnabled } from '../../domain/integrations/service.ts';
import { loadDiscoveryPolicy, runDiscovery } from '../../domain/discovery/service.ts';

const stringList = z.array(z.string().trim().min(1).max(80)).max(40).optional();

const runBody = z.object({
  categories: stringList,
  cities: stringList,
});

export function discoveryRoutes(_deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/status',
    requireAuth,
    asyncRoute((req, res) => {
      const { db, config, adapters } = req.ctx.deps;
      const status = adapters?.discovery.status() ?? null;
      const policy = loadDiscoveryPolicy(db, config);
      res.json({
        provider: status?.implementation ?? null,
        state: status?.state ?? 'unconfigured',
        simulated: status?.simulated === true,
        enabled: isIntegrationEnabled(db, config, 'discovery'),
        policy: {
          categories: policy.categories,
          cities: policy.cities,
          maxPerRun: policy.maxPerRun,
          autoAnalyze: policy.autoAnalyze,
          autoScore: policy.autoScore,
        },
      });
    }),
  );

  router.post(
    '/run',
    requireAuth,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const body = runBody.parse(req.body ?? {});
      const adapters = req.ctx.deps.adapters;
      if (!adapters) {
        res.status(503).json({
          error: { code: 'provider_unavailable', message: 'Adapter registry is not available in this context' },
        });
        return;
      }
      const run = await runDiscovery(
        req.ctx.deps.db,
        req.ctx.deps.config,
        adapters,
        {
          ...(body.categories !== undefined ? { categories: body.categories } : {}),
          ...(body.cities !== undefined ? { cities: body.cities } : {}),
        },
        {
          userId: req.ctx.user!.id,
          label: req.ctx.user!.role,
          displayName: req.ctx.user!.displayName,
          ipHash: req.ctx.ipHash,
        },
      );
      res.json({ run });
    }),
  );

  return router;
}
