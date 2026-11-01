/**
 * Routes: operating mode, emergency stop, manual resume.
 *
 * STOP is available to owner and staff (stopping is always the safe direction).
 * RESUME and switching to LIVE are owner-only, CSRF-protected and require a
 * fresh password re-authentication.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireReauth, requireRole } from '../middleware/session.ts';
import {
  emergencyStop,
  evaluateResume,
  getOperatingState,
  latestActivation,
  resume,
  setMode,
  summarise,
} from '../../domain/state/service.ts';
import { hasRecentReauth } from '../../domain/auth/service.ts';
import { AppError } from '../../core/errors.ts';

export function stateRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    asyncRoute((req, res) => {
      const state = getOperatingState(req.ctx.deps.db);
      const summary = summarise(req.ctx.deps.db);
      const evaluation = evaluateResume(req.ctx.deps.db, req.ctx.deps.config);
      // Phase 11B: latest live activation record (which guardrail checks
      // passed when live mode was enabled, and when it was reverted).
      const activation = latestActivation(req.ctx.deps.db);
      res.json({ state, summary, resume: evaluation, activation });
    }),
  );

  router.post(
    '/emergency-stop',
    requireAuth,
    requireCsrf,
    asyncRoute((req, res) => {
      const body = z.object({ reason: z.string().min(3).max(500) }).parse(req.body);
      const state = emergencyStop(req.ctx.deps.db, body.reason, {
        userId: req.ctx.user!.id,
        label: req.ctx.user!.role,
        displayName: req.ctx.user!.displayName,
        ipHash: req.ctx.ipHash,
      });
      res.json({ state, summary: summarise(req.ctx.deps.db) });
    }),
  );

  router.post(
    '/resume',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    requireReauth,
    asyncRoute((req, res) => {
      const body = z
        .object({ clearEmergencyStop: z.boolean().default(true), acknowledgeChecks: z.boolean().optional() })
        .parse(req.body);
      const result = resume(req.ctx.deps.db, req.ctx.deps.config, {
        userId: req.ctx.user!.id,
        label: 'owner',
        displayName: req.ctx.user!.displayName,
        ipHash: req.ctx.ipHash,
      }, { clearEmergencyStop: body.clearEmergencyStop });
      res.json({
        state: result.state,
        evaluation: result.evaluation,
        summary: summarise(req.ctx.deps.db),
      });
    }),
  );

  // Switching to LIVE additionally requires the owner to explicitly confirm
  // by typing GO LIVE in the UI — the phrase must accompany the request so a
  // stray click, cached form or scripted POST cannot enable live outreach.
  // Fresh password re-authentication is checked next. Both guards run BEFORE
  // the domain switch (which itself verifies owner, configured telephony and
  // verified onboarding, and writes the live_activations record).
  const modeBody = z.object({
    mode: z.enum(['simulation', 'live']),
    confirmation: z.string().optional(),
  });

  router.post(
    '/mode',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    asyncRoute((req, res) => {
      const body = modeBody.parse(req.body);
      if (body.mode === 'live') {
        if (body.confirmation !== 'GO LIVE') {
          throw new AppError(
            'validation_failed',
            "Typed confirmation required to enable live outreach: send confirmation: \"GO LIVE\".",
          );
        }
        if (!hasRecentReauth(req.ctx.session!)) {
          throw new AppError('reauth_required', 'Confirm your password to enable live outreach', {
            windowMinutes: 5,
          });
        }
      }
      const state = setMode(req.ctx.deps.db, req.ctx.deps.config, body.mode, {
        userId: req.ctx.user!.id,
        label: 'owner',
        displayName: req.ctx.user!.displayName,
        ipHash: req.ctx.ipHash,
      });
      res.json({ state, summary: summarise(req.ctx.deps.db) });
    }),
  );

  return router;
}
