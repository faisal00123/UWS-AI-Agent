/**
 * Central error handling.
 *
 * - AppError  -> documented status + stable machine-readable code
 * - zod       -> 400 validation_failed with field problems
 * - everything else -> 500 with a generic message; full detail is logged,
 *   never returned to the client (no stack traces / SQL in responses).
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AppError, isAppError } from '../../core/errors.ts';
import { redactString } from '../../core/logger.ts';
import type { AppDeps } from '../types.ts';

export function notFoundHandler(): RequestHandler {
  return (req, _res, next) => {
    next(new AppError('not_found', `No route for ${req.method} ${req.path}`));
  };
}

interface BodyParserError extends Error {
  status?: number;
  statusCode?: number;
  type?: string;
  expose?: boolean;
}

export function errorHandler(deps: AppDeps): (err: unknown, req: Request, res: Response, next: NextFunction) => void {
  return (err, req, res, _next) => {
    if (res.headersSent) {
      deps.logger.error('http.response_already_sent', { err: String(err) });
      res.end();
      return;
    }

    let status = 500;
    let code = 'internal_error';
    let message = 'An unexpected error occurred';
    let details: Record<string, unknown> | undefined;

    if (isAppError(err)) {
      status = err.status;
      code = err.code;
      message = err.message;
      details = err.details;
    } else if (err instanceof ZodError) {
      status = 400;
      code = 'validation_failed';
      message = 'Request validation failed';
      details = {
        problems: err.issues.map((i) => ({
          path: i.path.join('.'),
          message: i.message,
        })),
      };
    } else {
      const e = err as BodyParserError;
      const st = e.status ?? e.statusCode;
      if (e.type === 'entity.parse.failed' && st === 400) {
        status = 400;
        code = 'validation_failed';
        message = 'Malformed JSON body';
      } else if (e.type === 'entity.too.large') {
        status = 413;
        code = 'validation_failed';
        message = 'Request body too large';
      } else if (typeof st === 'number' && st >= 400 && st < 500) {
        status = st;
        code = 'validation_failed';
        message = e.expose ? e.message : 'Request could not be processed';
      }
    }

    const logFields = {
      method: req.method,
      path: req.path,
      status,
      code,
      userId: req.ctx?.user?.id ?? null,
      err: status >= 500 ? redactString(String(err instanceof Error ? (err.stack ?? err.message) : err)) : undefined,
      message: err instanceof Error ? err.message : String(err),
    };
    if (status >= 500) deps.logger.error('http.error', logFields);
    else deps.logger.warn('http.client_error', logFields);

    res.status(status).json({
      error: {
        code,
        message: status >= 500 ? message : message,
        ...(details ? { details } : {}),
      },
    });
  };
}
