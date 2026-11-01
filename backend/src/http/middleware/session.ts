/**
 * Session attachment, authentication, RBAC and CSRF protection.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { AppError } from '../../core/errors.ts';
import { parseCookies, serializeCookie } from '../cookies.ts';
import {
  hasRecentReauth,
  hashIp,
  loadSession,
  verifyCsrfToken,
  type PublicUser,
} from '../../domain/auth/service.ts';
import type { AppDeps } from '../types.ts';

export const SESSION_COOKIE = 'uws_session';
export const CSRF_COOKIE = 'uws_csrf';

export function clientIp(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? 'unknown';
}

/** Attaches `req.ctx` and, when a valid session cookie exists, the user. */
export function createContext(deps: AppDeps): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    req.ctx = {
      deps,
      ip: clientIp(req),
      ipHash: hashIp(clientIp(req), deps.config.sessionSecret),
      userAgent: req.get('user-agent') ?? null,
      startedAt: Date.now(),
    };

    const cookies = parseCookies(req.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    if (token) {
      const loaded = loadSession(deps.db, token);
      if (loaded) {
        req.ctx.user = loaded.user;
        req.ctx.session = loaded.session;
      } else {
        // Stale/invalid cookie: clear it so the browser stops sending it.
        res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { maxAgeSeconds: 0, path: '/' }));
      }
    }
    next();
  };
}

export const requireAuth: RequestHandler = (req, _res, next) => {
  if (!req.ctx?.user) {
    next(new AppError('unauthenticated', 'Sign in required'));
    return;
  }
  next();
};

export function requireRole(...roles: PublicUser['role'][]): RequestHandler {
  return (req, _res, next) => {
    const user = req.ctx?.user;
    if (!user) {
      next(new AppError('unauthenticated', 'Sign in required'));
      return;
    }
    if (!roles.includes(user.role)) {
      next(
        new AppError('forbidden', `You do not have permission to perform this action (requires: ${roles.join(' or ')})`, {
          requiredRoles: roles,
        }),
      );
      return;
    }
    next();
  };
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Requires a successful password re-entry within the last 5 minutes.
 * Used for live activation, budget/limit increases and emergency resume.
 */
export const requireReauth: RequestHandler = (req, _res, next) => {
  const session = req.ctx?.session;
  if (!session) {
    next(new AppError('unauthenticated', 'Sign in required'));
    return;
  }
  if (!hasRecentReauth(session)) {
    next(
      new AppError('reauth_required', 'Confirm your password to perform this action', {
        windowMinutes: 5,
      }),
    );
    return;
  }
  next();
};

/**
 * Double-submit CSRF: the token is an HMAC of the session id keyed by a secret
 * that only the server and the JS-readable cookie holder can produce.
 */
export const requireCsrf: RequestHandler = (req, _res, next) => {
  if (SAFE_METHODS.has(req.method)) {
    next();
    return;
  }
  // Sign-in has no session yet; it is protected by SameSite=Strict + rate limit.
  if (!req.ctx?.session) {
    next();
    return;
  }
  const header = req.get('x-csrf-token') ?? undefined;
  const cookies = parseCookies(req.headers.cookie);
  const fromCookie = cookies[CSRF_COOKIE];
  if (!verifyCsrfToken(req.ctx.session, header) || header !== fromCookie) {
    next(new AppError('forbidden', 'Invalid or missing CSRF token'));
    return;
  }
  next();
};

/**
 * Re-authentication gate for sensitive actions (live activation, budget
 * changes, emergency resume). The session records a short-lived grant after the
 * owner re-enters their password.
 */
export const REAUTH_HEADER = 'x-reauth-token';

export function setSessionCookies(
  res: Response,
  deps: AppDeps,
  tokens: { token: string; csrfToken: string; expiresAt: string },
): void {
  const secure = deps.config.publicBaseUrl.startsWith('https://');
  const maxAge = Math.max(1, Math.floor((Date.parse(tokens.expiresAt) - Date.now()) / 1000));
  res.append(
    'Set-Cookie',
    serializeCookie(SESSION_COOKIE, tokens.token, {
      httpOnly: true,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAgeSeconds: maxAge,
    }),
  );
  // Readable by the SPA on purpose: it is sent back in X-CSRF-Token.
  res.append(
    'Set-Cookie',
    serializeCookie(CSRF_COOKIE, tokens.csrfToken, {
      httpOnly: false,
      secure,
      sameSite: 'Strict',
      path: '/',
      maxAgeSeconds: maxAge,
    }),
  );
}

export function clearSessionCookies(res: Response, deps: AppDeps): void {
  const secure = deps.config.publicBaseUrl.startsWith('https://');
  res.append('Set-Cookie', serializeCookie(SESSION_COOKIE, '', { httpOnly: true, secure, path: '/', maxAgeSeconds: 0, sameSite: 'Strict' }));
  res.append('Set-Cookie', serializeCookie(CSRF_COOKIE, '', { httpOnly: false, secure, path: '/', maxAgeSeconds: 0, sameSite: 'Strict' }));
}
