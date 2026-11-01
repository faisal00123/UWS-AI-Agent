/** Shared HTTP types: request context and Express augmentation. */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import type { DB } from '../db/index.ts';
import type { Config } from '../core/config.ts';
import type { Logger } from '../core/logger.ts';
import type { PublicUser, SessionInfo } from '../domain/auth/service.ts';
import type { AdapterRegistry } from '../adapters/registry.ts';

export interface AppDeps {
  config: Config;
  db: DB;
  logger: Logger;
  /**
   * Provider adapters. Optional: createApp builds a default registry from the
   * process environment when absent, and tests inject fakes (including a fake
   * fetch) so no test can reach a real provider.
   */
  adapters?: AdapterRegistry;
}

export interface RequestContext {
  deps: AppDeps;
  ip: string;
  ipHash: string;
  userAgent: string | null;
  user?: PublicUser;
  session?: SessionInfo;
  startedAt: number;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      ctx: RequestContext;
      /** Raw request body bytes, captured for webhook signature verification. */
      rawBody?: Buffer;
    }
  }
}

/** Express 5 already forwards rejected promises; this helper documents intent. */
export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown> | unknown,
): RequestHandler {
  return (req, res, next) => {
    void Promise.resolve(handler(req, res, next)).catch(next);
  };
}
