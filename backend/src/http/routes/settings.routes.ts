/**
 * Routes: owner settings (calling hours, budgets, follow-up rules, retention…).
 *
 * Reads require sign-in; writes require the owner role, CSRF protection and a
 * fresh password re-authentication when the setting is marked sensitive.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { hasRecentReauth } from '../../domain/auth/service.ts';
import {
  SETTING_DEFINITIONS,
  getAllSettings,
  resetSetting,
  updateSettings,
} from '../../domain/settings/service.ts';
import { AppError } from '../../core/errors.ts';

export function settingsRoutes(deps: AppDeps): Router {
  const router = Router();

  router.get(
    '/',
    requireAuth,
    asyncRoute((req, res) => {
      res.json({
        settings: getAllSettings(req.ctx.deps.db, req.ctx.deps.config),
        hardCeilings: {
          dailyCallLimit: req.ctx.deps.config.hardDailyCallLimit,
          dailyBudgetMinor: req.ctx.deps.config.hardDailyBudgetMinor,
        },
      });
    }),
  );

  router.get(
    '/definitions',
    requireAuth,
    asyncRoute((_req, res) => {
      res.json({
        definitions: SETTING_DEFINITIONS.map((d) => ({
          key: d.key,
          label: d.label,
          description: d.description,
          sensitive: d.sensitive ?? false,
        })),
      });
    }),
  );

  router.put(
    '/',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    asyncRoute((req, res) => {
      const body = z.object({ updates: z.record(z.string(), z.unknown()) }).parse(req.body);
      const keys = Object.keys(body.updates);
      if (keys.length === 0) throw new AppError('validation_failed', 'No settings provided');

      const sensitiveTouched = keys.some((k) => {
        const def = SETTING_DEFINITIONS.find((d) => d.key === k);
        return def?.sensitive === true;
      });

      const proceed = (): void => {
        const result = updateSettings(req.ctx.deps.db, req.ctx.deps.config, body.updates, {
          userId: req.ctx.user!.id,
          label: 'owner',
          ipHash: req.ctx.ipHash,
        });
        if (result.applied.length === 0 && result.rejected.length > 0) {
          res.status(400).json({
            error: {
              code: 'validation_failed',
              message: 'No setting was applied',
              details: { rejected: result.rejected },
            },
          });
          return;
        }
        res.json({
          applied: result.applied,
          rejected: result.rejected,
          configVersion: result.configVersion,
          settings: getAllSettings(req.ctx.deps.db, req.ctx.deps.config),
        });
      };

      if (sensitiveTouched && !hasRecentReauth(req.ctx.session!)) {
        throw new AppError(
          'reauth_required',
          'Confirm your password to change safety-sensitive settings',
          { windowMinutes: 5, keys },
        );
      }
      proceed();
    }),
  );

  // Reset a single setting to its compiled-in default (audited).
  router.delete(
    '/:key',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    asyncRoute((req, res) => {
      const key = z.string().min(1).max(60).parse(req.params.key);
      // Resetting a sensitive setting loosens/tightens policy too, so it takes
      // the same fresh-reauth path as an update.
      const def = SETTING_DEFINITIONS.find((d) => d.key === key);
      if (!def) throw new AppError('not_found', `Unknown setting: ${key}`);
      if (def.sensitive === true && !hasRecentReauth(req.ctx.session!)) {
        throw new AppError('reauth_required', 'Confirm your password to reset this setting', {
          windowMinutes: 5,
        });
      }
      const result = resetSetting(req.ctx.deps.db, key, {
        userId: req.ctx.user!.id,
        label: 'owner',
        ipHash: req.ctx.ipHash,
      });
      res.json({ ...result, settings: getAllSettings(req.ctx.deps.db, req.ctx.deps.config) });
    }),
  );

  return router;
}
