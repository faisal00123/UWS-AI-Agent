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
const EMAIL_RE = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const PHONE_RE = /(?:\+?\d[\d\s()-]{7,}\d)/g;

export function redactValue(key: string, value: unknown, enabled: boolean): unknown {
  if (!enabled) return value;
  if (SECRET_KEY_RE.test(key)) return '[redacted]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((v) => redactValue(key, v, enabled));
  if (value && typeof value === 'object') return redactObject(value as Record<string, unknown>, enabled);
  return value;
}

export function redactString(s: string): string {
  return s.replace(EMAIL_RE, '[email]').replace(PHONE_RE, (m) => {
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
