/**
 * Application error taxonomy.
 *
 * Domain code throws typed errors; the HTTP layer maps them to status codes so
 * internal details never leak to clients by accident.
 */
export type ErrorCode =
  | 'validation_failed'
  | 'unauthenticated'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'rate_limited'
  | 'blocked_by_safeguard'
  | 'emergency_stop'
  | 'mode_is_simulation'
  | 'budget_exhausted'
  | 'limit_reached'
  | 'ineligible_contact'
  | 'reauth_required'
  | 'provider_unavailable'
  | 'internal_error';

const STATUS: Record<ErrorCode, number> = {
  validation_failed: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  blocked_by_safeguard: 403,
  emergency_stop: 403,
  mode_is_simulation: 403,
  budget_exhausted: 429,
  limit_reached: 429,
  ineligible_contact: 403,
  reauth_required: 401,
  provider_unavailable: 503,
  internal_error: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;
  readonly expose: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    details?: Record<string, unknown>,
    options?: { cause?: unknown; expose?: boolean },
  ) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
    this.expose = options?.expose ?? code !== 'internal_error';
  }
}

export const validationError = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('validation_failed', message, details);
export const notFound = (what: string): AppError =>
  new AppError('not_found', `${what} not found`);
export const forbidden = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('forbidden', message, details);
export const unauthenticated = (message = 'Authentication required'): AppError =>
  new AppError('unauthenticated', message);
export const conflict = (message: string, details?: Record<string, unknown>): AppError =>
  new AppError('conflict', message, details);

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
