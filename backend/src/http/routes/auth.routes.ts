/**
 * Route: authentication, users, re-authentication.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import {
  CSRF_COOKIE,
  clearSessionCookies,
  requireAuth,
  requireCsrf,
  requireRole,
  setSessionCookies,
} from '../middleware/session.ts';
import { createRateLimiter } from '../middleware/rateLimit.ts';
import {
  changePassword,
  createUser,
  csrfToken,
  destroyOtherSessions,
  destroySession,
  grantReauth,
  hasRecentReauth,
  listUsers,
  login,
} from '../../domain/auth/service.ts';
import { AppError } from '../../core/errors.ts';

const loginSchema = z.object({
  email: z.string().min(3).max(320),
  password: z.string().min(1).max(200),
});

const passwordSchema = z.string().min(1).max(200);

const createUserSchema = z.object({
  email: z.string().email().max(320),
  password: z.string().min(1).max(200),
  displayName: z.string().min(1).max(120),
  role: z.enum(['owner', 'staff']),
  mustChangePassword: z.boolean().optional(),
});

export function authRoutes(deps: AppDeps): Router {
  const router = Router();
  const loginLimiter = createRateLimiter({
    name: 'login',
    windowMs: deps.config.login.windowMinutes * 60_000,
    // Deliberately generous: the authoritative per-account lockout lives in the
    // database (survives restarts). This limiter is only a flood shield.
    max: deps.config.login.maxAttempts * 5,
    keySuffix: (req) => String((req.body as { email?: string } | undefined)?.email ?? '').toLowerCase(),
    message: 'Too many sign-in attempts from this address. Please wait and try again.',
  });

  router.post(
    '/login',
    loginLimiter.handler,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const body = loginSchema.parse(req.body);
      const result = await login(deps.db, deps.config, {
        email: body.email,
        password: body.password,
        ipHash: req.ctx.ipHash,
        userAgent: req.ctx.userAgent,
      });
      setSessionCookies(res, deps, result.session);
      res.json({
        user: result.user,
        csrfToken: result.session.csrfToken,
        expiresAt: result.session.expiresAt,
      });
    }),
  );

  router.post(
    '/logout',
    requireCsrf,
    asyncRoute((req, res) => {
      const cookies = req.headers.cookie ?? '';
      const match = /(?:^|;\s*)uws_session=([^;]+)/.exec(cookies);
      if (match) destroySession(deps.db, decodeURIComponent(match[1]!));
      clearSessionCookies(res, deps);
      res.json({ ok: true });
    }),
  );

  router.get(
    '/me',
    asyncRoute((req, res) => {
      const session = req.ctx.session;
      if (!req.ctx.user || !session) {
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Not signed in' } });
        return;
      }
      res.json({
        user: req.ctx.user,
        csrfToken: csrfToken(session.csrfSecret, session.id),
        reauthValid: hasRecentReauth(session),
        sessionExpiresAt: session.expiresAt,
      });
    }),
  );

  router.post(
    '/change-password',
    requireAuth,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const body = z
        .object({ currentPassword: passwordSchema, newPassword: passwordSchema })
        .parse(req.body);
      const result = await changePassword(
        deps.db,
        deps.config,
        req.ctx.user!.id,
        body.currentPassword,
        body.newPassword,
        req.ctx.session?.id ?? null,
      );
      res.json({ ok: true, revokedSessions: result.revokedSessions });
    }),
  );

  /**
   * Re-authentication for sensitive actions. Grants a 5-minute window during
   * which the session may perform live activation, budget/limit increases or
   * an emergency-stop resume.
   */
  router.post(
    '/reauth',
    loginLimiter.handler,
    requireAuth,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const body = z.object({ password: passwordSchema }).parse(req.body);
      const { verifyPassword } = await import('../../core/password.ts');
      const row = deps.db.prepare('SELECT password_hash FROM users WHERE id = ?').get(req.ctx.user!.id) as
        | { password_hash: string }
        | undefined;
      if (!row) throw new AppError('unauthenticated', 'User not found');
      const check = await verifyPassword(body.password, row.password_hash);
      if (!check.valid) throw new AppError('unauthenticated', 'Password verification failed');
      const until = grantReauth(deps.db, req.ctx.session!.id);
      res.json({ ok: true, validUntil: until });
    }),
  );

  // ----------------------------- user management (owner) --------------------
  router.get(
    '/users',
    requireAuth,
    requireRole('owner'),
    asyncRoute((_req, res) => {
      res.json({ users: listUsers(deps.db) });
    }),
  );

  router.post(
    '/users',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    asyncRoute(async (req, res) => {
      const body = createUserSchema.parse(req.body);
      const user = await createUser(deps.db, deps.config, body, {
        userId: req.ctx.user!.id,
        label: 'owner',
      });
      res.status(201).json({ user });
    }),
  );

  router.post(
    '/users/:id/revoke-sessions',
    requireAuth,
    requireRole('owner'),
    requireCsrf,
    asyncRoute((req, res) => {
      const id = z.string().min(1).parse(req.params.id);
      const revoked = destroyOtherSessions(deps.db, id);
      res.json({ ok: true, revokedSessions: revoked });
    }),
  );

  return router;
}

export { CSRF_COOKIE };
