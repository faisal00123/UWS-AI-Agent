/**
 * Contact extraction from an already-fetched public HTML page (Phase 4:
 * free-first contact enrichment).
 *
 * PURE function over HTML the analysis fetcher already downloaded — it never
 * performs network I/O of its own, so enrichment costs nothing extra and
 * stays inside the existing timeout/size-cap/SSRF bounds.
 *
 * Precision rules:
 *  - structured `mailto:` / `tel:` hrefs are collected first (highest
 *    precision — the business published these deliberately);
 *  - then plain text on the page, with `<script>`/`<style>`/comments removed
 *    so JS payloads and JSON blobs never become "contact details";
 *  - output is de-duplicated, order-preserving and capped (10 each) so one
 *    hostile page cannot make the caller write unbounded rows.
 *
 * Validation (format, E.164, PK shapes) happens in `domain/leads/enrich.ts`
 * — this module only extracts candidates and never invents values.
 *
 * PERFORMANCE (this is a security property, not a micro-optimisation): the
 * input is an ATTACKER-CONTROLLED page body of up to the fetcher's 1.5 MB
 * (analysis) / 512 KB (discovery) caps, so every pass below must be O(n).
 * Three regexes that used to live here were quadratic on adversarial input:
 *   - EMAIL_RE on a long unbroken word run: 15.8 s at 100 K chars (~59 min
 *     at 1.5 MB), because every start position re-backtracked the whole run;
 *   - `/<[^>]+>/g` on a run of lone `<`: 4.8 s at 64 K chars (~44 min at
 *     1.5 MB) — the same restart-per-position pattern;
 *   - `stripNoise`'s lazy `<script[\s\S]*?<\/script>` when a page has many
 *     unclosed `<script` (287 ms at 64 K, ~2.6 min at 1.5 MB).
 * Each is now a linear scan with identical match semantics (locked in by the
 * differential tests in tests/unit/contacts.test.ts). `PHONE_RE` and the
 * `href` scan were measured linear and are unchanged.
 */

/** Dedup/cap applied to each output list — one hostile page cannot flood rows. */
const MAX_EACH = 10;

/**
 * Hard cap on ONE extracted email candidate: the RFC 5321 limit on the total
 * length of an address, and exactly the number `normalizeEmail` rejects with
 * `too_long`. A candidate that would exceed it is SKIPPED, never truncated —
 * a truncated address would be a value the page never published (requirement:
 * no fabricated or incomplete email addresses).
 */
const MAX_EMAIL_LEN = 254;

/** Kept verbatim: measured linear (a digit run matches at the first start). */
const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;

export interface ExtractedContacts {
  emails: string[];
  phones: string[];
}

/** Remove executable/embedded content that must never be parsed for contacts. */
function stripNoise(html: string): string {
  return stripBlocks(
    stripBlocks(stripBlocks(html, '<script', '</script>'), '<style', '</style>'),
    '<!--',
    '-->',
  );
}

/** `mailto:`/`tel:` target without query/fragment (values cannot contain them). */
function hrefTarget(value: string, prefixLen: number): string {
  let target = value.slice(prefixLen);
  const cut = target.search(/[?#,]/);
  if (cut !== -1) target = target.slice(0, cut);
  try {
    target = decodeURIComponent(target);
  } catch {
    /* malformed percent-encoding: keep the raw value, validation comes later */
  }
  return target.trim();
}

// ------------------------------------------------------------------ linear scans ---
// Helpers below are O(n) with a small constant. They exist because the
// regexes they replace were quadratic on adversarial input (see file header).

/** ASCII case fold of a UTF-16 code unit — arithmetic, allocation-free. */
function fold(code: number): number {
  return code >= 0x41 && code <= 0x5a ? code + 0x20 : code;
}

/**
 * Case-insensitive character equality (what the old `/gi` flags did).
 * ASCII is folded with arithmetic so the hot path never allocates; anything
 * non-ASCII goes through `toLowerCase()` so single-character folds such as
 * U+212A KELVIN SIGN -> 'k' still behave like the `/i` flag. A real script
 * tag must keep being recognised whatever its case, or its contents would
 * leak into the contact lists.
 */
function sameFold(hay: string, hi: number, needle: string, ni: number): boolean {
  const a = hay.charCodeAt(hi);
  const b = needle.charCodeAt(ni);
  if (a === b) return true;
  if (a < 128 && b < 128) return fold(a) === fold(b);
  return hay[hi]!.toLowerCase() === needle[ni]!.toLowerCase();
}

/**
 * Case-insensitive literal search.
 *
 * Deliberately NOT implemented by lowercasing the whole haystack:
 * `String.prototype.toLowerCase()` can CHANGE a string's length
 * (`'İ'.toLowerCase()` is two code units), which would shift every index and
 * make `slice()` return garbled, fabricated spans. Searching in place keeps
 * all indices referring to the original string.
 */
function indexOfCI(hay: string, needle: string, from: number): number {
  const n = needle.length;
  if (n === 0) return from;
  const last = hay.length - n;
  for (let i = from; i <= last; i++) {
    let j = 0;
    while (j < n && sameFold(hay, i + j, needle, j)) j++;
    if (j === n) return i;
  }
  return -1;
}

/**
 * Replace every `open … close` block with a single space — the linear
 * equivalent of `.replace(/<script[\s\S]*?<\/script>/gi, ' ')` and friends.
 *
 * Semantics preserved exactly:
 *  - both tags match case-insensitively (the old `/gi`);
 *  - the close tag is the FIRST one at or after the end of `open`, which is
 *    what the lazy `[\s\S]*?` selected;
 *  - when no close tag exists ahead, nothing is replaced — and no later
 *    `open` can match either (a later position only searches a suffix of
 *    the same range), so we stop instead of retrying from every `open`,
 *    which is precisely where the O(n²) came from.
 */
function stripBlocks(html: string, open: string, close: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const s = indexOfCI(html, open, from);
    if (s === -1) break;
    const e = indexOfCI(html, close, s + open.length);
    if (e === -1) break;
    out += html.slice(from, s) + ' ';
    from = e + close.length;
  }
  return out + html.slice(from);
}

/**
 * Replace every `<…>` run with a single space — the linear equivalent of
 * `.replace(/<[^>]+>/g, ' ')`.
 *
 * `[^>]+` can never cross a `>`, so a match always ends at the FIRST `>` after
 * the `<`; and a `<` with no `>` ahead matches nothing at all (there is then
 * no later `<` that could match either, so we stop). `<>` is not a match
 * because `[^>]+` needs at least one character.
 */
function stripTags(html: string): string {
  let out = '';
  let from = 0;
  for (;;) {
    const lt = html.indexOf('<', from);
    if (lt === -1) break;
    const gt = html.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      out += html.slice(from, lt + 1); // keep `<>`: not a tag, not consumed
      from = lt + 1;
      continue;
    }
    out += html.slice(from, lt) + ' ';
    from = gt + 1;
  }
  return out + html.slice(from);
}

/** Local-part characters of the replaced pattern: `[A-Za-z0-9._%+-]`. */
function isLocalChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '.' ||
    c === '_' ||
    c === '%' ||
    c === '+' ||
    c === '-'
  );
}

/** Domain characters of the replaced pattern: `[A-Za-z0-9.-]`. */
function isDomainChar(c: string): boolean {
  return (
    (c >= 'a' && c <= 'z') ||
    (c >= 'A' && c <= 'Z') ||
    (c >= '0' && c <= '9') ||
    c === '.' ||
    c === '-'
  );
}

function isAsciiLetter(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
}

/**
 * Linear replacement for
 * `text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g)`.
 *
 * The old pattern could only ever match AT an `@` (neither the local part nor
 * the domain may contain one), so anchoring on each `@` and walking outwards
 * visits every character a constant number of times — O(n) instead of the
 * old O(n²) restart-and-backtrack from every position.
 *
 * Match boundaries reproduce the old engine exactly:
 *  - the local part is the maximal run of local characters immediately left
 *    of the `@` (the leftmost start the engine settled on), and must be at
 *    least one character;
 *  - the domain is the maximal run of domain characters after the `@`;
 *  - the engine then backtracked that greedy run from its END, so the match
 *    ends at the LAST `.` in it that is followed by at least two letters,
 *    with at least one domain character before that `.`.
 */
function scanEmails(text: string): string[] {
  const out: string[] = [];
  let at = text.indexOf('@');
  while (at !== -1) {
    // Local part: maximal run left of '@', bounded so one '@' cannot make us
    // walk an unbounded run more than MAX_EMAIL_LEN characters.
    let start = at;
    while (start > 0 && at - start < MAX_EMAIL_LEN && isLocalChar(text[start - 1]!)) start--;
    if (start === at || (start > 0 && isLocalChar(text[start - 1]!))) {
      // Either there is no local part, or the local part alone already meets
      // the 254-char cap — in both cases no valid address can start here, and
      // we skip rather than truncate (truncation would invent an address).
      at = text.indexOf('@', at + 1);
      continue;
    }

    // Domain: maximal run of domain characters after the '@'.
    let end = at + 1;
    while (end < text.length && isDomainChar(text[end]!)) end++;

    // Backtrack the greedy domain from its end, as the old engine did.
    let q = -1;
    for (let p = end - 1; p > at + 1; p--) {
      if (text[p] !== '.') continue;
      let e = p + 1;
      while (e < end && isAsciiLetter(text[e]!)) e++;
      if (e - p - 1 >= 2) {
        q = e;
        break;
      }
    }
    if (q === -1 || q - start > MAX_EMAIL_LEN) {
      // No `.<letters{2,}>` tail, or the address would exceed 254 chars.
      // `normalizeEmail` rejects both; skipping keeps us from emitting a
      // value that could never be used.
      at = text.indexOf('@', at + 1);
      continue;
    }

    out.push(text.slice(start, q));
    // Neither side of a match can contain '@', so the next anchor is never
    // before q — advancing to the next '@' cannot skip a candidate.
    at = text.indexOf('@', at + 1);
  }
  return out;
}

export function extractContacts(html: string): ExtractedContacts {
  const withoutNoise = stripNoise(html);
  const emails: string[] = [];
  const phones: string[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();

  const addEmail = (raw: string): void => {
    const value = raw.trim().toLowerCase();
    if (value === '' || emails.length >= MAX_EACH || seenEmails.has(value)) return;
    seenEmails.add(value);
    emails.push(value);
  };
  const addPhone = (raw: string): void => {
    const value = raw.trim();
    if (value === '' || phones.length >= MAX_EACH || seenPhones.has(value)) return;
    seenPhones.add(value);
    phones.push(value);
  };

  // 1. Structured hrefs first — the deliberate, published contact points.
  //    (Measured linear: each `href="` supplies the closing quote the next
  //    one needs, so the scans between quotes sum to the input length.)
  for (const m of withoutNoise.matchAll(/href\s*=\s*["']([^"']*)["']/gi)) {
    const href = m[1] ?? '';
    const lower = href.toLowerCase();
    if (lower.startsWith('mailto:')) addEmail(hrefTarget(href, 7));
    else if (lower.startsWith('tel:')) addPhone(hrefTarget(href, 4));
  }

  // 2. Plain text (scripts/styles/comments already stripped).
  const visible = stripTags(withoutNoise);
  for (const email of scanEmails(visible)) addEmail(email);
  for (const m of visible.matchAll(PHONE_RE)) addPhone(m[0]);

  return { emails, phones };
}
