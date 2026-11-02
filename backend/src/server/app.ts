/**
 * Express application factory.
 *
 * Middleware order matters:
 *   security headers -> body parsing -> request context (session) -> logging
 *   -> rate limiting -> API routers -> SPA static assets -> 404 -> errors
 */
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppDeps } from '../http/types.ts';
import { createContext } from '../http/middleware/session.ts';
import { createRateLimiter } from '../http/middleware/rateLimit.ts';
import { errorHandler, notFoundHandler } from '../http/middleware/errors.ts';
import { authRoutes } from '../http/routes/auth.routes.ts';
import { stateRoutes } from '../http/routes/state.routes.ts';
import { settingsRoutes } from '../http/routes/settings.routes.ts';
import { healthRoutes } from '../http/routes/health.routes.ts';
import { leadsRoutes } from '../http/routes/leads.routes.ts';
import { analysisRoutes } from '../http/routes/analysis.routes.ts';
import { pipelineRoutes, followupRoutes } from '../http/routes/pipeline.routes.ts';
import { duplicateRoutes } from '../http/routes/duplicates.routes.ts';
import { outreachRoutes, portfolioRoutes } from '../http/routes/outreach.routes.ts';
import { webhookRoutes } from '../http/routes/webhooks.routes.ts';
import { gatewayRoutes } from '../http/routes/gateway.routes.ts';
import { reportingRoutes } from '../http/routes/reporting.routes.ts';
import { monitoringRoutes } from '../http/routes/monitoring.routes.ts';
import { reviewRoutes } from '../http/routes/review.routes.ts';
import { mediaRoutes } from '../http/routes/media.routes.ts';
import { discoveryRoutes } from '../http/routes/discovery.routes.ts';
import { buildRegistry } from '../adapters/registry.ts';
import { isIntegrationEnabled, recordAdapterUsage } from '../domain/integrations/service.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
// Phase 13 restructure: the SPA lives in its own top-level `frontend/` folder
// (repo layout: backend/ + frontend/). app.ts sits at backend/src/server/, so
// ascend server -> src -> backend -> repo root, then into frontend/.
const WEB_ROOT = join(HERE, '..', '..', '..', 'frontend');

export function createApp(deps: AppDeps): Express {
  const app = express();
  const { config, logger } = deps;

  // Adapters default to a registry built from the process environment; in
  // tests an absent registry is EMPTY (never process.env), so a developer's
  // local credentials can never be exercised by the test suite. Tests inject
  // fakes (including a fake fetch) through deps.adapters. The non-test
  // fallback (only reached when createApp is called without a registry)
  // wires the same db-backed toggle/usage hooks as server/index.ts.
  const full: AppDeps = {
    ...deps,
    adapters:
      deps.adapters ??
      (config.nodeEnv === 'test'
        ? buildRegistry(config, {}, {})
        : buildRegistry(config, process.env, {
            isEnabled: (key) => isIntegrationEnabled(deps.db, config, key),
            onUsage: (event) =>
              recordAdapterUsage(deps.db, {
                integration: event.integration,
                operation: event.operation,
                outcome: event.outcome,
                errorCode: event.errorCode ?? null,
                durationMs: event.durationMs,
                retries: event.retries,
                occurredAt: event.occurredAt,
              }),
          })),
  };

  app.set('trust proxy', 1); // correct client IP behind a reverse proxy
  app.disable('x-powered-by');
  app.set('etag', false);

  const https = config.publicBaseUrl.startsWith('https://');
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
          // Styles: 'unsafe-inline' only (inline style attributes in the SPA).
          // No inline <script> is ever allowed.
          'style-src': ["'self'", "'unsafe-inline'"],
          'img-src': ["'self'", 'data:', 'https:'],
          'font-src': ["'self'", 'data:'],
          'connect-src': ["'self'"],
          'object-src': ["'none'"],
          'frame-ancestors': ["'none'"],
          'form-action': ["'self'"],
          'base-uri': ["'self'"],
          ...(https ? { 'upgrade-insecure-requests': [] } : {}),
        },
      },
      crossOriginResourcePolicy: { policy: 'same-origin' },
      crossOriginOpenerPolicy: { policy: 'same-origin' },
      referrerPolicy: { policy: 'no-referrer' },
      frameguard: { action: 'deny' },
      noSniff: true,
      xssFilter: true,
      hsts: https ? { maxAge: 15552000, includeSubDomains: true } : false,
    }),
  );
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
    next();
  });

  // Keep the RAW body bytes for webhook signature verification (Meta signs
  // the exact bytes; re-serialized JSON would break the HMAC).
  app.use(
    express.json({
      limit: '256kb',
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = Buffer.from(buf);
      },
    }),
  );
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));

  app.use(createContext(full));

  // Structured access log (redaction happens in the logger).
  app.use((req: Request, res: Response, next: NextFunction) => {
    res.on('finish', () => {
      const ms = Date.now() - (req.ctx?.startedAt ?? Date.now());
      const line = {
        method: req.method,
        path: req.path.split('?')[0],
        status: res.statusCode,
        ms,
        userId: req.ctx?.user?.id ?? null,
      };
      if (req.path.startsWith('/api/')) logger.info('http.request', line);
      else logger.debug('http.static', line);
    });
    next();
  });

  const apiLimiter = createRateLimiter({
    name: 'api',
    windowMs: 60_000,
    max: 600,
    message: 'Too many requests. Please slow down.',
  });
  app.use('/api', apiLimiter.handler);

  // ------------------------------- API routers -----------------------------
  app.use('/api/auth', authRoutes(full));
  app.use('/api/state', stateRoutes(full));
  app.use('/api/settings', settingsRoutes(full));
  app.use('/api/leads', leadsRoutes(full));
  app.use('/api/leads', analysisRoutes(full));
  app.use('/api/leads', pipelineRoutes());
  app.use('/api/leads', outreachRoutes());
  app.use('/api/followups', followupRoutes());
  app.use('/api/duplicates', duplicateRoutes(full));
  app.use('/api/portfolio', portfolioRoutes());
  // Notifications & daily reports (Phase 8): reads deps via req.ctx.deps.
  app.use('/api', reportingRoutes());
  // Backups & restore tests (Phase 9): owner-only monitoring surface.
  app.use('/api', monitoringRoutes());
  // Provider callbacks: signature-authenticated, no session (see webhooks).
  app.use('/api/webhooks', webhookRoutes());
  // CloudyVoice gateway callbacks: bearer/HMAC-authenticated, no session.
  app.use('/api/webhooks', gatewayRoutes());
  // Phase 11B: opt-in unsuppression review (owner-only queue + decisions).
  app.use('/api/suppression', reviewRoutes(full));
  // Phase 11B: live media pipeline (conversation/segment ingestion, no dial).
  app.use('/api/conversations', mediaRoutes(full));
  // Phase 12: lead discovery (OpenStreetMap/Overpass research runs).
  app.use('/api/discovery', discoveryRoutes(full));
  app.use('/api', healthRoutes(full));

  // ------------------------------ SPA + static -----------------------------
  if (existsSync(WEB_ROOT)) {
    app.use(
      express.static(WEB_ROOT, {
        index: false,
        etag: true,
        maxAge: '1h',
        setHeaders: (res, path) => {
          // Hashed/immutable assets could be cached longer; HTML never is.
          if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
        },
      }),
    );
  }

  // Unknown API paths must 404 as JSON, never fall through to the SPA.
  app.use('/api', notFoundHandler());

  // SPA fallback (Express 5: no bare "*" patterns).
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next();
      return;
    }
    if (req.path.startsWith('/api/')) {
      next();
      return;
    }
    const indexFile = join(WEB_ROOT, 'index.html');
    if (!existsSync(indexFile)) {
      res.status(404).type('text/plain').send('UI not built yet. API is available under /api.');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexFile);
  });

  app.use(errorHandler(deps));
  return app;
}
