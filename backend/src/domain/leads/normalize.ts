/**
 * Normalisation helpers used by import, deduplication and display.
 *
 * Everything here is deterministic and side-effect free so it can be unit
 * tested exhaustively. Normalised values are the dedupe keys; raw values are
 * always preserved on the record.
 */

export interface PhoneNormalization {
  /** Normalised international number, e.g. +923001234567 (null when invalid). */
  e164: string | null;
  valid: boolean;
  /** Machine-readable reason when invalid/uncertain. */
  reason?: string;
  original: string;
  country: 'PK' | 'intl' | 'unknown';
}

const PK_MOBILE = /^\+923\d{9}$/; // +92 3XX XXXXXXX (11 digits after +92)
const PK_LANDLINE = /^\+92\d{2,3}\d{7,8}$/; // +92 21 / 42 …
const E164 = /^\+[1-9]\d{6,14}$/;

/**
 * Normalise Pakistani and international phone numbers to E.164.
 * Accepted inputs: 03001234567, 3001234567, 923001234567, +92 300-1234567,
 * +1 415 555 2671, 0092…
 */
export function normalizePhone(raw: string | null | undefined): PhoneNormalization {
  const original = (raw ?? '').trim();
  if (original === '') {
    return { e164: null, valid: false, reason: 'empty', original, country: 'unknown' };
  }
  const hasPlus = original.startsWith('+');
  let digits = original.replace(/\D/g, '');
  if (digits === '') {
    return { e164: null, valid: false, reason: 'no_digits', original, country: 'unknown' };
  }
  // Strip international prefix 00
  if (!hasPlus && digits.startsWith('00')) digits = digits.slice(2);

  // Set when the input looked like a Pakistani national number and we added
  // the country code ourselves. Such numbers must then match a real PK shape -
  // we must not let a malformed national number fall through and pass as a
  // valid international one (e.g. "030012" must not become "+9230012").
  let assumedPk = false;

  if (!hasPlus) {
    if (digits.startsWith('92') && digits.length >= 12) {
      // already carries the PK country code: 923001234567
    } else if (digits.startsWith('0') && digits.length >= 10) {
      // national trunk prefix: 03001234567 (mobile), 02134567890 (landline)
      digits = `92${digits.slice(1)}`;
      assumedPk = true;
    } else if (digits.length === 10 && digits.startsWith('3')) {
      // bare mobile without trunk prefix: 3001234567
      digits = `92${digits}`;
      assumedPk = true;
    }
  }

  const candidate = `+${digits}`;
  if (PK_MOBILE.test(candidate)) {
    return { e164: candidate, valid: true, original, country: 'PK' };
  }
  if (PK_LANDLINE.test(candidate) && digits.startsWith('92')) {
    return { e164: candidate, valid: true, original, country: 'PK' };
  }
  if (assumedPk) {
    // Looked Pakistani but does not match a valid PK mobile/landline shape.
    return {
      e164: null,
      valid: false,
      reason: digits.length < 7 ? 'too_short' : 'not_a_valid_pk_number',
      original,
      country: 'unknown',
    };
  }
  if (E164.test(candidate)) {
    return { e164: candidate, valid: true, original, country: 'intl' };
  }
  return {
    e164: null,
    valid: false,
    reason:
      digits.length < 7 ? 'too_short' : digits.length > 15 ? 'too_long' : 'not_a_valid_e164_number',
    original,
    country: 'unknown',
  };
}

export interface WebsiteNormalization {
  /** Canonical URL for display (https + host + path). */
  url: string | null;
  /** Lowercase host without www, used as a dedupe key. */
  host: string | null;
  valid: boolean;
  reason?: string;
  original: string;
}

export function normalizeWebsite(raw: string | null | undefined): WebsiteNormalization {
  const original = (raw ?? '').trim();
  if (original === '') return { url: null, host: null, valid: false, reason: 'empty', original };
  const withScheme = /^https?:\/\//i.test(original) ? original : `https://${original}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { url: null, host: null, valid: false, reason: 'unparseable_url', original };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: null, host: null, valid: false, reason: 'unsupported_protocol', original };
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, '');
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) {
    return { url: null, host: null, valid: false, reason: 'invalid_hostname', original };
  }
  const url = `${parsed.protocol}//${parsed.host}${parsed.pathname}${parsed.search}`;
  return { url: url.replace(/\/$/, parsed.pathname === '/' ? '' : '/'), host, valid: true, original };
}

const LEGAL_SUFFIXES = [
  /\(pvt\)\s*ltd\b\.?/gi,
  /\bpvt\.?\s*ltd\b\.?/gi,
  /\blimited\b\.?/gi,
  /\bltd\b\.?/gi,
  /\bllc\b\.?/gi,
  /\binc\b\.?/gi,
  /\bcorp\b\.?/gi,
  /\bcompany\b\.?/gi,
  /\bco\b\.?/gi,
];

export function normalizeName(raw: string | null | undefined): string {
  let s = (raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (const re of LEGAL_SUFFIXES) s = s.replace(re, ' ');
  return s.replace(/\s+/g, ' ').trim();
}

export function normalizeCity(raw: string | null | undefined): string {
  return (raw ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeEmail(raw: string | null | undefined): { email: string | null; valid: boolean; reason?: string } {
  const email = (raw ?? '').trim().toLowerCase();
  if (email === '') return { email: null, valid: false, reason: 'empty' };
  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    return { email: null, valid: false, reason: 'invalid_format' };
  }
  if (email.length > 254) return { email: null, valid: false, reason: 'too_long' };
  return { email, valid: true };
}

/**
 * Damerau-free Levenshtein similarity in [0,1] - used for *flagging*
 * uncertain duplicates only (never for automatic merging).
 */
export function nameSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (a === '' || b === '') return 0;
  const m = a.length;
  const n = b.length;
  if (Math.abs(m - n) > Math.max(m, n) * 0.6) return 0;
  let prev = new Array<number>(n + 1);
  let cur = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    cur[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(cur[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost);
    }
    const tmp = prev;
    prev = cur;
    cur = tmp;
  }
  const dist = prev[n]!;
  return 1 - dist / Math.max(m, n);
}
