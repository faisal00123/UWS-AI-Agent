/**
 * Website analysis — pure HTML signal extraction.
 *
 * This module is intentionally I/O-free and deterministic: given an HTML string
 * it returns the signals we can honestly *measure* from the markup. Fetching is
 * handled separately (see fetcher.ts) so this stays exhaustively unit-testable.
 *
 * Honesty rules (Section 1.4):
 *  - Every value here is MEASURED from the fetched markup - never guessed.
 *  - We do NOT claim a technical SEO, accessibility or performance audit.
 *    Anything we cannot measure from a single HTML response is listed
 *    explicitly in `notMeasured` so the dashboard can show what is missing
 *    rather than implying a clean bill of health.
 *  - A page that loads does not prove the business has no problems; a page
 *    that fails to load is recorded as unreachable, never as "no website".
 */

export const ENGINE_VERSION = 'uws-analysis-1.0.0';

/** Signals measured directly from markup. */
export interface MeasuredSignals {
  title: string | null;
  metaDescription: string | null;
  hasViewportMeta: boolean;
  hasHttps: boolean;
  h1Count: number;
  imgCount: number;
  imgsMissingAlt: number;
  internalLinks: number;
  forms: number;
  telLinks: number;
  mailtoLinks: number;
  whatsappLinks: number;
  hasContactPage: boolean;
  hasAboutPage: boolean;
  hasPrivacyPage: boolean;
  hasPortfolioPage: boolean;
  navTexts: string[];
  /** Relative link targets that look like key pages, for evidence display. */
  pageEvidence: { contact: string | null; about: string | null; privacy: string | null; portfolio: string | null };
}

/** An opportunity we can point to with concrete evidence from the markup. */
export interface Opportunity {
  code: string;
  label: string;
  /** 'measured' = derived from markup; 'estimated' = heuristic inference. */
  state: 'measured' | 'estimated';
  evidence: string;
}

/**
 * Things a single-HTML-response check genuinely cannot establish. Listed
 * explicitly so nothing here is ever presented as audited.
 */
export const NOT_MEASURED: string[] = [
  'Core Web Vitals / real performance (Lighthouse, field data)',
  'JavaScript-rendered content (we analyse static HTML only)',
  'Mobile usability on a real device/emulation',
  'HTTP accessibility audit (headers, HSTS, cache policy)',
  'Technical SEO crawl (canonical tags, sitemaps, robots.txt, structured data)',
  'WCAG accessibility conformance',
  'Rankings, backlinks, traffic, or ad-spend data',
];

/** Used for a `no_website` result: no page was fetched, so no site exists to audit. */
export const NO_WEBSITE_NOT_MEASURED: string[] = [
  'No website was found on record, so no page-level analysis was possible',
  'Everything a website audit would cover (design, content, technical health) is therefore unknown',
];

const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_m, code: string) => {
      const n = Number(code);
      return n >= 32 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
    });
}

function collapseWs(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

/** Extract the value of an attribute from a raw tag string. */
function attr(tag: string, name: string): string | null {
  const re = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'=<>` + '`' + `]+))`, 'i');
  const m = re.exec(tag);
  if (!m) return null;
  const v = m[1] ?? m[2] ?? m[3] ?? '';
  return decodeEntities(v).trim();
}

// ------------------------------------------------------------- linear scans ---
// The regexes these helpers replace were O(n²) on adversarial markup: a run of
// lone `<` made `<[^>]+>` take ~5 s at 64 K chars (~45 min at the 1.5 MB fetch
// cap), and unclosed `<script` / `<nav` / `<a` runs made the lazy `[\s\S]*?`
// patterns rescan the tail from every opening position. Each helper below is a
// single forward pass that never re-scans a suffix.

/** ASCII case fold of one UTF-16 code unit (what the old `/i` flags did). */
function fold(c: number): number {
  return c >= 0x41 && c <= 0x5a ? c + 0x20 : c;
}

/** Word character per `\w` — the class behind the old `\b` boundaries. */
function isWordCh(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9_]/.test(ch);
}

/** Whitespace per `\s` — the old `\s*` inside close tags. */
function isWsCh(ch: string | undefined): boolean {
  return ch !== undefined && /\s/.test(ch);
}

/** Case-insensitive `indexOf` over ASCII (the `/i` of the old patterns). */
function indexOfCI(hay: string, needle: string, from: number): number {
  const m = needle.length;
  outer: for (let i = from; i + m <= hay.length; i++) {
    for (let k = 0; k < m; k++) {
      if (fold(hay.charCodeAt(i + k)) !== fold(needle.charCodeAt(k))) continue outer;
    }
    return i;
  }
  return -1;
}

/**
 * Index of the next `<tag` opening that satisfies the old `\b` after the tag
 * name (so `<area>` is not an `<a>`), ASCII case-insensitive; -1 if none.
 */
function findTagOpen(html: string, tag: string, from: number): number {
  let i = from;
  for (;;) {
    const lt = indexOfCI(html, `<${tag}`, i);
    if (lt === -1) return -1;
    if (!isWordCh(html[lt + 1 + tag.length])) return lt;
    i = lt + 1;
  }
}

/**
 * First close pattern at or after `from`, as start/end index, or null.
 *  - `wsThenGt`: `</tag` + optional whitespace + `>` (the old `<\/tag\s*>`);
 *  - otherwise: the literal `close` itself (the comment's `-->`).
 */
function findClose(
  s: string,
  close: string,
  from: number,
  wsThenGt: boolean,
): { start: number; end: number } | null {
  let i = from;
  for (;;) {
    const at = indexOfCI(s, close, i);
    if (at === -1) return null;
    if (!wsThenGt) return { start: at, end: at + close.length };
    let p = at + close.length;
    while (isWsCh(s[p])) p++;
    if (s[p] === '>') return { start: at, end: p + 1 };
    i = at + 1;
  }
}

/** All `<tag ...>` occurrences, as raw tag strings (old `<tag\b([^>]*)>`). */
function tags(html: string, tag: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const lt = findTagOpen(html, tag, from);
    if (lt === -1) break;
    const gt = html.indexOf('>', lt + 1 + tag.length);
    // No `>` anywhere ahead — no later `<tag` can end either, so stop.
    if (gt === -1) break;
    out.push(html.slice(lt, gt + 1));
    from = gt + 1;
  }
  return out;
}

/** Full `<tag ...>inner</tag>` blocks (opening tag + inner markup). */
function blocks(html: string, tag: string): string[] {
  const out: string[] = [];
  let from = 0;
  for (;;) {
    const lt = findTagOpen(html, tag, from);
    if (lt === -1) break;
    const openEnd = html.indexOf('>', lt + 1 + tag.length);
    if (openEnd === -1) break;
    const close = findClose(html, `</${tag}`, openEnd + 1, true);
    // Opening tags only move forward, so a missing close here means no later
    // block could find one either — stop instead of rescanning the tail.
    if (close === null) break;
    out.push(html.slice(lt, close.end));
    from = close.end;
  }
  return out;
}

/** Inner text of `<tag ...>text</tag>`, tolerating nesting-free content. */
function innerText(html: string, tag: string): string | null {
  const lt = findTagOpen(html, tag, 0);
  if (lt === -1) return null;
  const openEnd = html.indexOf('>', lt + 1 + tag.length);
  if (openEnd === -1) return null;
  const close = findClose(html, `</${tag}`, openEnd + 1, true);
  if (close === null) return null;
  const raw = stripInnerNoise(html.slice(openEnd + 1, close.start));
  return collapseWs(decodeEntities(raw)) || null;
}

/**
 * Clean inner markup the way the old `innerText` did: script blocks, style
 * blocks, comments, then any remaining tags — each replaced by one space.
 */
function stripInnerNoise(raw: string): string {
  const noScript = stripBlocks(raw, '<script', '</script', true);
  const noStyle = stripBlocks(noScript, '<style', '</style', true);
  const noComment = stripBlocks(noStyle, '<!--', '-->', false);
  return stripTagRuns(noComment);
}

/**
 * Linear equivalent of `.replace(new RegExp(open + '[\\s\\S]*?' + close, 'gi'),
 * ' ')` — used for `<script>`, `<style>` and `<!-- … -->`.
 *
 * Semantics preserved exactly:
 *  - the close pattern is the FIRST one at or after the open, which is what
 *    the lazy `[\s\S]*?` selected;
 *  - `\b` applies when the open ends in a word character (`<script\b`,
 *    `<style\b`); `<!--` ends in `-`, so — as in the old pattern — it does not;
 *  - when no close exists ahead, nothing further is replaced and no later open
 *    can match either (a later position only searches a suffix of the same
 *    range), so we stop instead of retrying from every open — that retry is
 *    exactly where the O(n²) came from.
 */
function stripBlocks(s: string, open: string, close: string, wsThenGt: boolean): string {
  let out = '';
  let from = 0; // end of the last emitted region
  let search = 0; // next position to look for an open
  for (;;) {
    const st = indexOfCI(s, open, search);
    if (st === -1) break;
    if (isWordCh(open[open.length - 1]) && isWordCh(s[st + open.length])) {
      search = st + 1; // e.g. `<scripty` is not `<script\b`
      continue;
    }
    const c = findClose(s, close, st + open.length, wsThenGt);
    if (c === null) break;
    out += s.slice(from, st) + ' ';
    from = c.end;
    search = c.end;
  }
  return out + s.slice(from);
}

/**
 * Linear equivalent of `.replace(/<[^>]+>/g, ' ')`.
 *
 * A `<` with no `>` anywhere ahead can never match — and neither can any later
 * `<`, since it would search a suffix of the same range — so the scan stops;
 * the old engine instead retried from every `<`, which is where the O(n²) on a
 * run of lone `<` came from.
 */
function stripTagRuns(s: string): string {
  let out = '';
  let from = 0;
  let search = 0;
  for (;;) {
    const lt = s.indexOf('<', search);
    if (lt === -1) break;
    const gt = s.indexOf('>', lt + 1);
    if (gt === -1) break;
    if (gt === lt + 1) {
      search = lt + 1; // `<>`: `[^>]+` needs at least one character
      continue;
    }
    out += s.slice(from, lt) + ' ';
    from = gt + 1;
    search = gt + 1;
  }
  return out + s.slice(from);
}

function absolutize(href: string, base: URL): { path: string; host: string } | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { path: u.pathname.toLowerCase().replace(/\/+$/, ''), host: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

function hasPageLink(hrefs: { path: string; host: string }[], base: URL, needles: string[]): { found: boolean; evidence: string | null } {
  for (const h of hrefs) {
    if (h.host !== base.hostname.toLowerCase()) continue;
    if (needles.some((n) => h.path.includes(n))) return { found: true, evidence: h.path || '/' };
  }
  return { found: false, evidence: null };
}

/**
 * Analyse static HTML for measurable signals and the opportunities they imply.
 * `baseUrl` is the final URL after redirects (used to scope "internal" links).
 */
export function analyzeHtml(html: string, baseUrl: string): {
  signals: MeasuredSignals;
  opportunities: Opportunity[];
  notMeasured: string[];
} {
  let base: URL;
  let baseValid = true;
  try {
    base = new URL(baseUrl);
  } catch {
    // A non-URL base should not crash analysis; scope internal links to nothing
    // so we never *confirm* a page we cannot actually attribute to this host.
    baseValid = false;
    base = new URL('https://invalid.invalid');
  }

  const title = innerText(html, 'title');

  const metaDescTag = tags(html, 'meta').find((t) => (attr(t, 'name') ?? '').toLowerCase() === 'description');
  const metaDescription = metaDescTag ? attr(metaDescTag, 'content') : null;

  const hasViewportMeta = tags(html, 'meta').some(
    (t) => (attr(t, 'name') ?? '').toLowerCase() === 'viewport' && (attr(t, 'content') ?? '').toLowerCase().includes('width='),
  );

  const imgs = tags(html, 'img');
  const imgsMissingAlt = imgs.filter((t) => attr(t, 'alt') === null || (attr(t, 'alt') ?? '').trim() === '').length;

  const anchors = tags(html, 'a');
  const hrefs: { path: string; host: string }[] = [];
  let telLinks = 0;
  let mailtoLinks = 0;
  let whatsappLinks = 0;
  for (const a of anchors) {
    const href = (attr(a, 'href') ?? '').trim();
    if (href === '') continue;
    const lower = href.toLowerCase();
    if (lower.startsWith('tel:')) telLinks++;
    else if (lower.startsWith('mailto:')) mailtoLinks++;
    else if (lower.includes('wa.me') || lower.includes('whatsapp.com')) whatsappLinks++;
    else {
      // With an unusable base URL we cannot attribute a link to this host, so
      // internal pages are never recorded as "confirmed".
      if (!baseValid) continue;
      const abs = absolutize(href, base);
      if (abs) hrefs.push(abs);
    }
  }
  const internalLinks = baseValid ? hrefs.filter((h) => h.host === base.hostname.toLowerCase()).length : 0;

  const contact = hasPageLink(hrefs, base, ['/contact', '/reach', '/get-in-touch']);
  const about = hasPageLink(hrefs, base, ['/about', '/who-we-are', '/our-story']);
  const privacy = hasPageLink(hrefs, base, ['/privacy', '/privacy-policy', '/terms']);
  const portfolio = hasPageLink(hrefs, base, ['/portfolio', '/work', '/projects', '/case-stud', '/gallery']);

  // Nav text: links inside <nav>, falling back to anchors classed as a menu.
  const navTexts = (() => {
    const navBlocks = blocks(html, 'nav');
    const source = navBlocks.length > 0 ? navBlocks.join(' ') : null;
    if (source === null) {
      const asMenu = anchors.filter((a) => /menu|nav/i.test(attr(a, 'class') ?? '') || /menu|nav/i.test(attr(a, 'id') ?? ''));
      const texts = asMenu.map((a) => collapseWs(stripTagRuns(a))).filter((t) => t !== '' && t.length <= 40);
      return [...new Set(texts)].slice(0, 20);
    }
    const texts = source
      .split(/<a\b/i)
      .slice(1)
      .map((chunk) => {
        const inner = chunk.replace(/^[^>]*>/, '').replace(/<[\s\S]*$/, ' ');
        return collapseWs(decodeEntities(stripTagRuns(inner)));
      })
      .filter((t) => t !== '' && t.length <= 40);
    return [...new Set(texts)].slice(0, 20);
  })();

  const signals: MeasuredSignals = {
    title,
    metaDescription,
    hasViewportMeta,
    hasHttps: base.protocol === 'https:',
    h1Count: tags(html, 'h1').length,
    imgCount: imgs.length,
    imgsMissingAlt,
    internalLinks,
    forms: tags(html, 'form').length,
    telLinks,
    mailtoLinks,
    whatsappLinks,
    hasContactPage: contact.found,
    hasAboutPage: about.found,
    hasPrivacyPage: privacy.found,
    hasPortfolioPage: portfolio.found,
    navTexts,
    pageEvidence: {
      contact: contact.evidence,
      about: about.evidence,
      privacy: privacy.evidence,
      portfolio: portfolio.evidence,
    },
  };

  return { signals, opportunities: deriveOpportunities(signals, base), notMeasured: NOT_MEASURED };
}

/** Translate measured signals into evidence-backed opportunities. */
function deriveOpportunities(s: MeasuredSignals, base: URL): Opportunity[] {
  const out: Opportunity[] = [];

  if (!s.hasHttps) {
    out.push({
      code: 'no_https',
      label: 'Site is not served over HTTPS',
      state: 'measured',
      evidence: `Fetched over ${base.protocol.replace(':', '')}. HTTPS builds visitor trust and is required for secure forms.`,
    });
  }
  if (!s.hasViewportMeta) {
    out.push({
      code: 'no_viewport_meta',
      label: 'No responsive viewport meta tag',
      state: 'measured',
      evidence: 'The <meta name="viewport"> tag is absent, so the layout will render zoomed-out on phones.',
    });
  }
  if (s.imgCount > 0 && s.imgsMissingAlt > 0) {
    out.push({
      code: 'images_missing_alt',
      label: `${s.imgsMissingAlt} of ${s.imgCount} images have no alt text`,
      state: 'measured',
      evidence: 'Missing alt text hurts accessibility and image search visibility.',
    });
  }
  if (s.imgCount >= 5 && s.imgsMissingAlt === 0) {
    // nothing to flag - images are labelled
  }
  if (!s.metaDescription) {
    out.push({
      code: 'no_meta_description',
      label: 'Missing meta description',
      state: 'measured',
      evidence: 'No <meta name="description"> tag found; search results will auto-generate snippet text.',
    });
  }
  if (!s.title || s.title.length < 10) {
    out.push({
      code: 'weak_title',
      label: s.title ? 'Page title is very short' : 'Missing page title',
      state: 'measured',
      evidence: s.title ? `Title is "${s.title}" (${s.title.length} chars).` : 'No <title> element found.',
    });
  }
  if (s.h1Count === 0) {
    out.push({
      code: 'no_h1',
      label: 'No top-level heading (H1)',
      state: 'measured',
      evidence: 'Zero <h1> elements found on the page.',
    });
  } else if (s.h1Count > 1) {
    out.push({
      code: 'multiple_h1',
      label: `${s.h1Count} competing H1 headings`,
      state: 'estimated',
      evidence: 'Multiple H1s can dilute the page topic; a single descriptive H1 is usually clearer.',
    });
  }
  if (!s.hasContactPage) {
    out.push({
      code: 'no_contact_page',
      label: 'No discoverable contact page',
      state: 'measured',
      evidence: 'No internal link matching /contact was found in the navigation.',
    });
  }
  if (s.telLinks === 0 && s.whatsappLinks === 0 && s.mailtoLinks === 0) {
    out.push({
      code: 'no_click_to_contact',
      label: 'No click-to-contact links',
      state: 'measured',
      evidence: 'No tel:, wa.me or mailto: links found - visitors cannot reach the business in one tap.',
    });
  }
  if (!s.hasPortfolioPage) {
    out.push({
      code: 'no_portfolio_page',
      label: 'No portfolio / work showcase linked',
      state: 'measured',
      evidence: 'No internal link matching /portfolio, /work or /projects was found.',
    });
  }
  if (s.internalLinks < 3) {
    out.push({
      code: 'thin_navigation',
      label: 'Very few internal links',
      state: 'estimated',
      evidence: `Only ${s.internalLinks} internal link(s) found; the site may be a single page with limited depth.`,
    });
  }
  if (s.forms === 0) {
    out.push({
      code: 'no_lead_form',
      label: 'No lead-capture form',
      state: 'measured',
      evidence: 'No <form> element found on the page.',
    });
  }

  return out;
}
