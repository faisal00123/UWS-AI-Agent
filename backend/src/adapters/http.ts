/**
 * Shared HTTP transport for adapters.
 *
 * - accepts an injectable `fetchImpl` (tests never touch the network, and a
 *   unit test cannot accidentally reach a real provider)
 * - enforces a timeout on every call
 * - maps failures to `AdapterError` with a message that may name the endpoint
 *   but NEVER includes credentials or auth headers
 */
import { AdapterError, type FetchLike } from './types.ts';

export type { FetchLike };

const DEFAULT_TIMEOUT_MS = 15_000;

export interface JsonRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  /** Object is JSON-encoded; a string is sent as-is (form bodies pass their own content-type). */
  body?: unknown;
  timeoutMs?: number;
}

/**
 * Perform an HTTP request and decode a JSON response. Non-2xx responses map
 * to AdapterError; `mapStatus` lets a caller translate provider-specific
 * status codes (Twilio's 21211, etc.) into a precise code.
 */
export async function requestJson<T>(
  fetchImpl: FetchLike,
  url: string,
  opts: JsonRequestOptions = {},
  mapStatus?: (status: number, body: unknown) => AdapterError | null,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let res: Response;
  try {
    const isPlainObject = typeof opts.body === 'object' && opts.body !== null && !Buffer.isBuffer(opts.body);
    res = await fetchImpl(url, {
      method: opts.method ?? 'POST',
      headers: {
        accept: 'application/json',
        // JSON only for plain objects; strings/Buffers carry their own type.
        ...(isPlainObject ? { 'content-type': 'application/json' } : {}),
        ...(opts.headers ?? {}),
      },
      body:
        opts.body === undefined
          ? undefined
          : typeof opts.body === 'string'
            ? opts.body
            : Buffer.isBuffer(opts.body)
              ? new Uint8Array(opts.body)
              : JSON.stringify(opts.body),
      signal: controller.signal,
    });
  } catch (err) {
    const timedOut = controller.signal.aborted;
    throw new AdapterError(
      'network',
      timedOut
        ? `Request to ${hostOf(url)} timed out`
        : `Could not reach ${hostOf(url)} (${(err as Error).name})`,
      { retryable: true, cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  let body: unknown = null;
  const text = await res.text().catch(() => '');
  if (text) {
    try {
      body = JSON.parse(text) as unknown;
    } catch {
      body = text;
    }
  }

  if (!res.ok) {
    const mapped = mapStatus?.(res.status, body);
    if (mapped) throw mapped;
    throw new AdapterError(
      res.status === 429 ? 'rate_limited' : 'provider_error',
      `${hostOf(url)} responded ${res.status}${providerMessage(body) ? `: ${providerMessage(body)}` : ''}`,
      { retryable: res.status === 429 || res.status >= 500, providerStatus: res.status },
    );
  }
  return body as T;
}

/** Best-effort human message from a provider error body (no secrets there). */
function providerMessage(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null;
  const b = body as { error?: { message?: unknown }; message?: unknown };
  const msg = typeof b.error?.message === 'string' ? b.error.message : typeof b.message === 'string' ? b.message : null;
  if (!msg) return null;
  // Provider errors sometimes echo the destination number; keep previews short.
  return msg.length > 200 ? `${msg.slice(0, 197)}…` : msg;
}

/** Host only — never the full URL, which may carry query credentials. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'provider';
  }
}

/** application/x-www-form-urlencoded body builder (Twilio-style APIs). */
export function formBody(fields: Record<string, string | undefined>): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(fields)) {
    if (v !== undefined) params.set(k, v);
  }
  return params.toString();
}
