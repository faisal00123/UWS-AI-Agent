/**
 * Routes: website analysis, explainable lead scoring, contact eligibility,
 * and the suppression (do-not-contact) list.
 *
 * These are the read/decision surfaces behind the "Analyse", "Score" and
 * "Can we contact this?" actions in the dashboard. Every action that changes
 * state is CSRF-protected and role-gated; analysis and scoring write audit
 * events through their domain services.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { analyzeWebsite, latestAnalysis, analysisHistory } from '../../domain/analysis/service.ts';
import { recordScore, latestScore } from '../../domain/scoring/service.ts';
import {
  evaluateEligibility,
  latestEligibility,
  suppress,
  listSuppression,
  type Channel,
} from '../../domain/eligibility/service.ts';
import { recordAudit } from '../../domain/audit/service.ts';
import { notFound } from '../../core/errors.ts';

const CHANNELS = ['call', 'whatsapp_message', 'whatsapp_call', 'email'] as const;
const channelSchema = z.enum(CHANNELS);

const suppressSchema = z.object({
  scope: z.enum(['business', 'phone', 'whatsapp', 'email']).default('business'),
  reason: z.enum([
    'opt_out',
    'do_not_contact',
    'refused',
    'invalid_number',
    'legal',
    'customer_request',
    'owner_manual',
    'unreachable_permanent',
  ]),
  evidence: z.string().max(1000).nullish(),
  permanent: z.boolean().default(true),
});

export function analysisRoutes(deps: AppDeps): Router {
  const router = Router();
  router.use(requireAuth);

  // ------------------------------------------------------------- analysis --
  // Run a fresh website analysis for a lead. Always returns a persisted
  // record: an unreachable/blocked/no-website outcome is a real finding.
  router.post(
    '/:id/analyze',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const lead = (await req.ctx.deps.db.prepare('SELECT website_url FROM businesses WHERE id = ?').get(id)) as
        | { website_url: string | null }
        | undefined;
      if (!lead) throw notFound('Lead');

      const record = await analyzeWebsite(
        req.ctx.deps.db,
        {
          businessId: id,
          websiteUrl: lead.website_url,
        },
        // Test-injected transport (same one the verify route uses): in
        // production deps.fetchImpl is absent and this stays the real fetch.
        // The adapter wrapper bridges FetchLike (string URL) to the
        // fetcher's standard `typeof fetch` signature.
        req.ctx.deps.fetchImpl
          ? { fetchImpl: (url: string | URL | Request, init?: RequestInit) => req.ctx.deps.fetchImpl!(String(url), init ?? {}) }
          : {},
      );
      // Phase 6: a fresh analysis (plus any contact enrichment it performed
      // from the same page) supersedes the evidence a stored score was
      // computed from — refresh it when one exists. A score is never
      // CREATED here: the Score action owns that decision.
      if ((await latestScore(req.ctx.deps.db, id)) !== null) {
        await recordScore(req.ctx.deps.db, req.ctx.deps.config, { businessId: id });
      }
      await recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'lead.analyze',
        entityType: 'business',
        entityId: id,
        summary: `Website analysis completed: ${record.status}`,
        details: { analysisId: record.id, status: record.status },
      });
      res.json(record);
    }),
  );

  router.get(
    '/:id/analysis',
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      res.json({
        latest: await latestAnalysis(req.ctx.deps.db, id),
        history: await analysisHistory(req.ctx.deps.db, id),
      });
    }),
  );

  // -------------------------------------------------------------- scoring --
  router.post(
    '/:id/score',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const result = await recordScore(req.ctx.deps.db, req.ctx.deps.config, { businessId: id });
      res.json(result);
    }),
  );

  router.get(
    '/:id/score',
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      res.json({ latest: await latestScore(req.ctx.deps.db, id) });
    }),
  );

  // ----------------------------------------------------------- eligibility --
  // Evaluate now (persists the decision) or read the latest stored decision.
  router.post(
    '/:id/eligibility',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const channel = channelSchema.parse((req.body as { channel?: string } | undefined)?.channel ?? 'call');
      res.json(await evaluateEligibility(req.ctx.deps.db, req.ctx.deps.config, id, channel));
    }),
  );

  router.get(
    '/:id/eligibility',
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const channel = channelSchema.parse(req.query.channel ?? 'call');
      res.json({ latest: await latestEligibility(req.ctx.deps.db, id, channel as Channel) });
    }),
  );

  // ----------------------------------------------------------- suppression --
  router.get(
    '/:id/suppression',
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      res.json({ items: await listSuppression(req.ctx.deps.db, id) });
    }),
  );

  // Owner-only: adding a do-not-contact record is a high-consequence action.
  router.post(
    '/:id/suppression',
    requireCsrf,
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const body = suppressSchema.parse(req.body);
      const result = await suppress(req.ctx.deps.db, {
        businessId: id,
        scope: body.scope,
        reason: body.reason,
        source: 'owner',
        evidence: body.evidence ?? null,
        permanent: body.permanent,
        createdBy: req.ctx.user!.id,
      });
      await recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'lead.suppress',
        entityType: 'business',
        entityId: id,
        summary: `Suppression added (${body.reason}, scope ${body.scope})`,
        details: { ...result, ...body },
      });
      res.status(result.deduped ? 200 : 201).json(result);
    }),
  );

  return router;
}
