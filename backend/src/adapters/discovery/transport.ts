/**
 * Sanitized transport-error classification for the discovery adapter.
 *
 * A raw fetch failure carries OS-level detail (libuv codes, syscall names,
 * target addresses, certificate subjects, stack text). The dashboard needs to
 * say WHY a request never produced an HTTP response — timeout, DNS, TLS,
 * connection refused, connection reset — without ever surfacing raw messages
 * or any other unvetted text.
 *
 * Rules encoded here:
 *  - only a WHITELIST of well-known Node/libuv/undici error `code` and
 *    `name` fields is read; free-form message text is never inspected, so a
 *    hostile or accidental message can never become the reported category;
 *  - the result is a closed set of categories; anything unrecognized is
 *    honestly `unknown`;
 *  - nested `cause` chains (undici wraps most failures as
 *    `TypeError: fetch failed` + `cause`) are walked to a bounded depth;
 *  - the original error object is never modified — it stays attached to the
 *    AdapterError as `cause` (in-process only; never serialized into API
 *    responses).
 *
 * HTTP-level failures are NOT classified here: when a response exists, its
 * status number is reported verbatim by the adapter's mapHttpError
 * (`HTTP 429`, `HTTP 503`, ...). This module only explains the absence of a
 * response.
 */

/** Why a request never produced an HTTP response (sanitized, whitelisted). */
export type TransportCategory = 'timeout' | 'dns' | 'tls' | 'refused' | 'reset' | 'unknown';

/** Whitelisted Node/libuv/undici error codes -> category. */
const CODE_CATEGORIES: Record<string, TransportCategory> = {
  // timeouts
  ETIMEDOUT: 'timeout',
  UND_ERR_CONNECT_TIMEOUT: 'timeout',
  UND_ERR_HEADERS_TIMEOUT: 'timeout',
  UND_ERR_BODY_TIMEOUT: 'timeout',
  // name resolution
  ENOTFOUND: 'dns',
  EAI_AGAIN: 'dns',
  EAI_FAIL: 'dns',
  EAI_NONAME: 'dns',
  EAI_NODATA: 'dns',
  // connection refused / reset
  ECONNREFUSED: 'refused',
  ECONNRESET: 'reset',
  ECONNABORTED: 'reset',
  EPIPE: 'reset',
  // TLS / certificate problems
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'tls',
  UNABLE_TO_GET_ISSUER_CERT: 'tls',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'tls',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'tls',
  SELF_SIGNED_CERT_IN_CHAIN: 'tls',
  CERT_HAS_EXPIRED: 'tls',
  CERT_NOT_YET_VALID: 'tls',
  CERT_REVOKED: 'tls',
  ERR_TLS_CERT_ALTNAME_INVALID: 'tls',
  HOSTNAME_MISMATCH: 'tls',
  EPROTO: 'tls',
};

/** Error names that identify a timeout regardless of any attached code. */
const NAME_CATEGORIES: Record<string, TransportCategory> = {
  TimeoutError: 'timeout',
  // AbortSignal.timeout() surfaces as TimeoutError on modern Node; some
  // paths still report AbortError for the same abort-with-deadline cause.
  AbortError: 'timeout',
};

/** Code prefixes too broad for exact entries. */
const CODE_PREFIXES: [string, TransportCategory][] = [
  ['ERR_TLS_', 'tls'],
  ['ERR_SSL_', 'tls'],
];

/** Bound on the `cause` chain walk (undici adds at most a couple of links). */
const MAX_CAUSE_DEPTH = 5;

/**
 * Classify a fetch/network failure into a sanitized transport category.
 * Reads only whitelisted `name`/`code` fields; never message text.
 */
export function classifyTransportError(err: unknown): TransportCategory {
  let current: unknown = err;
  for (let depth = 0; current !== null && typeof current === 'object' && depth < MAX_CAUSE_DEPTH; depth++) {
    const e = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof e.name === 'string') {
      const byName = NAME_CATEGORIES[e.name];
      if (byName) return byName;
    }
    if (typeof e.code === 'string') {
      const byCode = CODE_CATEGORIES[e.code];
      if (byCode) return byCode;
      for (const [prefix, category] of CODE_PREFIXES) {
        if (e.code.startsWith(prefix)) return category;
      }
    }
    current = e.cause;
  }
  return 'unknown';
}
