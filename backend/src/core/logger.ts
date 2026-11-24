/**
 * Structured logger with redaction.
 *
 * Phone numbers, emails, tokens and session ids are never written to logs in
 * clear text when LOG_REDACT is enabled (the default).
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: 100,
};

const SECRET_KEY_RE =
  /(password|passwd|secret|token|api[_-]?key|authorization|cookie|csrf|passphrase|sid|session)/i;
const PHONE_RE = /(?:\+?\d[\d\s()-]{7,}\d)/g;

// Character classes for the LINEAR email masker below (same `\w` semantics
// as the quadratic regex these replace — `\w` is ASCII word chars).
const EMAIL_LOCAL_CH = /[\w.+-]/;
const EMAIL_LABEL_CH = /[\w-]/;
const EMAIL_TAIL_CH = /[\w.-]/;

// --- value-side rules for free-text fields (error/message/detail) that do
// --- NOT match SECRET_KEY_RE. All patterns are single-pass class repeats
// --- (linear): they must never become a ReDoS vector themselves.

/** `Bearer <token>` anywhere in free text. */
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Well-known provider key shapes (OpenAI/Google/GitHub/Slack). */
const PROVIDER_KEY_RE =
  /(?:\bsk|pk|rk)-(?:proj-)?[A-Za-z0-9_-]{16,}|\bAIza[0-9A-Za-z_-]{20,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[baprs]-[A-Za-z0-9-]{10,}/g;
/**
 * `key=value` / `key: value` pairs inside free text whose key looks
 * sensitive. The leading `\b` is deliberately absent so `access_token=…`
 * matches (the separator requirement keeps `tokenizer=…` from matching).
 */
const KV_SECRET_RE =
  /(api[_-]?key|apikey|secret|token|password|passwd|passphrase|authorization|private[_-]?key|access[_-]?key|session[_-]?id|sid)(["']?\s*[:=]\s*["']?)([^\s"',;&)}\]]{6,})/gi;

/**
 * Linear replacement for the old `/[\w.+-]+@[\w-]+\.[\w.-]+/g`.
 *
 * That pattern was QUADRATIC on adversarial input: a long unbroken word run
 * followed by `@` made every start position re-backtrack the whole run
 * (measured: 100 K chars ≈ 16.6 s), and the logger redacts the request PATH
 * on every 404/error — an unauthenticated caller could burn CPU per request.
 *
 * The pattern can only ever match AT an `@`, so anchoring there and walking
 * outwards visits each character a constant number of times — O(n).
 * Match boundaries reproduce the old engine: maximal local run left of the
 * `@`, a non-empty `[\w-]` label right of it, a `.`, then a non-empty
 * `[\w.-]` tail.
 */
function maskEmails(s: string): string {
  let out = '';
  let copied = 0;
  let at = s.indexOf('@');
  while (at !== -1) {
    let start = at;
    while (start > 0 && EMAIL_LOCAL_CH.test(s[start - 1]!)) start--;
    let label = at + 1;
    while (label < s.length && EMAIL_LABEL_CH.test(s[label]!)) label++;
    if (label > at + 1 && label < s.length && s[label] === '.') {
      let tail = label + 1;
      while (tail < s.length && EMAIL_TAIL_CH.test(s[tail]!)) tail++;
      if (tail > label + 1) {
        // The old engine scanned from the END of the previous match, so a
        // local run reaching back past it is clamped to that boundary —
        // reproduces the old match exactly while never re-emitting
        // already-consumed text.
        const from = Math.max(start, copied);
        if (from < at) {
          out += s.slice(copied, from) + '[email]';
          copied = tail;
          at = s.indexOf('@', tail);
          continue;
        }
      }
    }
    at = s.indexOf('@', at + 1);
  }
  return out + s.slice(copied);
}

export function redactValue(key: string, value: unknown, enabled: boolean): unknown {
  if (!enabled) return value;
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, enabled));
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>, enabled);
  return value;
}

export function redactString(s: string): string {
  // Secrets first (most specific), then PII. Every step is linear-time.
  return maskEmails(
    s
      .replace(BEARER_RE, 'Bearer [redacted]')
      .replace(PROVIDER_KEY_RE, '[redacted]')
      .replace(KV_SECRET_RE, (_m, k: string, sep: string) => `${k}${sep}[redacted]`),
  ).replace(PHONE_RE, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 8) return m;
    return `${'*'.repeat(Math.max(0, digits.length - 4))}${digits.slice(-4)}`;
  });
}

function redactObject(obj: Record<string, unknown>, enabled: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!enabled) {
      out[k] = v;
    } else if (SECRET_KEY_RE.test(k)) {
      out[k] = '[redacted]';
    } else if (typeof v === 'string') {
      out[k] = redactString(v);
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        item && typeof item === 'object' ? redactObject(item as Record<string, unknown>, enabled) : redactString(String(item)),
      );
    } else if (v && typeof v === 'object') {
      out[k] = redactObject(v as Record<string, unknown>, enabled);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
  readonly redact: boolean;
}

export function createLogger(level: LogLevel, redact = true, bindings: Record<string, unknown> = {}): Logger {
  const threshold = ORDER[level];
  const emit = (lvl: Exclude<LogLevel, 'silent'>, msg: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < threshold) return;
    const payload = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: redact ? redactString(msg) : msg,
      ...bindings,
      ...(fields ? (redactObject(fields, redact) as Record<string, unknown>) : {}),
    };
    const line = JSON.stringify(payload);
    if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    redact,
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => emit('error', m, f),
    child: (extra) => createLogger(level, redact, { ...bindings, ...extra }),
  };
}

/** A logger that records nothing - used by tests. */
export const nullLogger: Logger = {
  redact: false,
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => nullLogger,
};
