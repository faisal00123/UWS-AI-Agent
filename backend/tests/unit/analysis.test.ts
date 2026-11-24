import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeHtml, NOT_MEASURED } from '../../src/domain/analysis/parse.ts';

const BASE = 'https://example-clinic.pk/';

describe('website HTML analysis', () => {
  test('measures basic signals from markup', () => {
    const html = `
      <html><head>
        <title>Karachi Care Clinic</title>
        <meta name="description" content="Trusted family clinic in Karachi" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
      </head><body>
        <nav><a href="/about">About</a><a href="/contact">Contact</a></nav>
        <h1>Welcome</h1>
        <img src="a.jpg" alt="clinic" />
        <img src="b.jpg" />
        <a href="tel:+923001234567">Call us</a>
        <a href="mailto:info@example-clinic.pk">Email</a>
        <form></form>
        <a href="/portfolio">Our work</a>
      </body></html>`;
    const { signals } = analyzeHtml(html, BASE);

    assert.equal(signals.title, 'Karachi Care Clinic');
    assert.equal(signals.metaDescription, 'Trusted family clinic in Karachi');
    assert.equal(signals.hasViewportMeta, true);
    assert.equal(signals.hasHttps, true);
    assert.equal(signals.h1Count, 1);
    assert.equal(signals.imgCount, 2);
    assert.equal(signals.imgsMissingAlt, 1);
    assert.equal(signals.telLinks, 1);
    assert.equal(signals.mailtoLinks, 1);
    assert.equal(signals.forms, 1);
    assert.equal(signals.hasContactPage, true);
    assert.equal(signals.hasAboutPage, true);
    assert.equal(signals.hasPortfolioPage, true);
  });

  test('flags concrete opportunities with evidence', () => {
    const html = `<html><head><title></title></head><body><h1>a</h1><h1>b</h1></body></html>`;
    const { signals, opportunities } = analyzeHtml(html, 'http://insecure-site.com/');
    const codes = opportunities.map((o) => o.code);

    assert.ok(codes.includes('no_https'), 'http:// base must flag missing HTTPS');
    assert.ok(codes.includes('no_viewport_meta'));
    assert.ok(codes.includes('no_meta_description'));
    assert.ok(codes.includes('no_contact_page'));
    assert.ok(codes.includes('no_click_to_contact'));
    assert.ok(codes.includes('no_lead_form'));
    assert.equal(signals.hasHttps, false);

    // every opportunity must carry non-empty evidence
    for (const o of opportunities) {
      assert.ok(o.evidence.length > 0, `${o.code} needs evidence`);
      assert.ok(o.state === 'measured' || o.state === 'estimated');
    }
  });

  test('never claims it measured things it cannot', () => {
    const { notMeasured } = analyzeHtml('<html></html>', BASE);
    assert.deepEqual(notMeasured, NOT_MEASURED);
    assert.ok(notMeasured.some((n) => /Core Web Vitals|performance/i.test(n)));
    assert.ok(notMeasured.some((n) => /accessibility|WCAG/i.test(n)));
    assert.ok(notMeasured.some((n) => /JavaScript-rendered/i.test(n)));
  });

  test('empty title is flagged as weak, and decodes entities', () => {
    const { signals, opportunities } = analyzeHtml(
      `<html><head><title>Cafe &amp; Bistro &#233;</title></head><body></body></html>`,
      BASE,
    );
    assert.equal(signals.title, 'Cafe & Bistro é');
    // title is 16 chars -> not weak
    assert.ok(!opportunities.some((o) => o.code === 'weak_title'));
  });

  test('unparseable base URL does not throw', () => {
    const { signals } = analyzeHtml('<html><body><a href="/contact">c</a></body></html>', 'not-a-url');
    // internal-link scoping is impossible, so contact page cannot be confirmed
    assert.equal(signals.hasContactPage, false);
  });

  test('nav texts are extracted and de-duplicated', () => {
    const html = `<html><body><nav><a href="/a">Home</a><a href="/b">Services</a><a href="/a">Home</a></nav></body></html>`;
    const { signals } = analyzeHtml(html, BASE);
    assert.deepEqual(signals.navTexts, ['Home', 'Services']);
  });

  test('a clean, well-built page produces few or no opportunities', () => {
    const html = `
      <html><head><title>A Fully Optimised Clinic Website</title>
      <meta name="description" content="A complete description" />
      <meta name="viewport" content="width=device-width" /></head>
      <body>
        <nav><a href="/about">About</a><a href="/contact">Contact</a><a href="/privacy">Privacy</a></nav>
        <h1>One heading</h1>
        <img src="a.jpg" alt="a" /><img src="b.jpg" alt="b" />
        <a href="tel:+923001112223">Call</a>
        <form></form>
        <a href="/portfolio">Work</a>
      </body></html>`;
    const { opportunities } = analyzeHtml(html, BASE);
    assert.equal(opportunities.length, 0, JSON.stringify(opportunities, null, 2));
  });

  // ---- HIGH#2 regression: the tag/block/innerText/tag-strip regexes were ----
  // ---- QUADRATIC on unclosed runs (measured: tags 2.4 s @100 K, blocks ----
  // ---- 1.9 s @80 K, inner-text strips 1.5 s @140 K, `<[^>]+>` 5 s @64 K), ----
  // ---- and analysis runs on fetched pages up to the 1.5 MB cap.          ----

  /**
   * Doubling the input must not more-than-triple the runtime: linear code
   * measures ~1-10 ms here, while the old quadratic regexes measured seconds
   * at these sizes (bound = 3x + 100 ms of scheduler slack, so a reintroduced
   * quadratic fails loudly instead of hiding behind jitter).
   */
  function assertDoublesLinearly(label: string, make: (n: number) => string, n: number): void {
    const time = (size: number): number => {
      const html = make(size);
      const t = Date.now();
      analyzeHtml(html, BASE);
      return Date.now() - t;
    };
    const t1 = time(n);
    const t2 = time(n * 2);
    assert.ok(
      t2 <= t1 * 3 + 100,
      `${label}: doubling ${n}->${n * 2} took ${t1}ms -> ${t2}ms (quadratic growth)`,
    );
  }

  test('unclosed <a> runs (tags scanner) stay linear', () => {
    assertDoublesLinearly('tags <a', (n) => '<a'.repeat(n), 50_000);
  });

  test('unclosed <nav> runs (blocks scanner) stay linear', () => {
    assertDoublesLinearly('blocks <nav>', (n) => '<nav>'.repeat(n), 50_000);
  });

  test('unclosed <script> runs inside <title> (inner strips) stay linear', () => {
    assertDoublesLinearly('innerText <script', (n) => `<title>${'<script'.repeat(n)}</title>`, 50_000);
  });

  test('a run of lone "<" inside <title> (tag-strip) stays linear', () => {
    assertDoublesLinearly('stripTagRuns <', (n) => `<title>${'<'.repeat(n)}</title>`, 50_000);
  });

  test('a single oversized attribute tag stays linear', () => {
    assertDoublesLinearly(
      'long tag',
      (n) => `<html><head><title>t</title></head><body><a href="/x" data="${'y'.repeat(n)}">link</a></body></html>`,
      50_000,
    );
  });

  // ---- parity: the linear scanners must behave like the regexes they ----
  // ---- replaced (verified here against the old patterns on small input) ----

  test('title inner text keeps old semantics: nested tags, scripts, comments', () => {
    const title = (h: string): string | null => analyzeHtml(h, BASE).signals.title;
    assert.equal(title('<title>A <b>bold</b> &amp; nice</title>'), 'A bold & nice');
    assert.equal(title('<title>x<script>var a=1;</script>y</title>'), 'x y');
    assert.equal(title('<title>x<!-- note -->y</title>'), 'x y');
    assert.equal(title('<title>x<style>.a{}</style>y</title>'), 'x y');
    // close tag with whitespace before ">" (old `\s*`)
    assert.equal(title('<title>spaced</title >'), 'spaced');
    // case-insensitive like the old `i` flag
    assert.equal(title('<TITLE>Upper</TITLE>'), 'Upper');
    // `<titleX>` is not `<title\b`
    assert.equal(title('<titleX>nope</titleX>'), null);
    // missing open or close -> null, never a partial guess
    assert.equal(title('<div>nope</div>'), null);
    assert.equal(title('<title>unclosed'), null);
    // `<scripty>` has no `\b` after `script`, so it is NOT stripped as a block
    assert.equal(title('<title>a<scripty>b</scripty>c</title>'), 'a b c');
    // entity decoding still happens after tag stripping
    assert.equal(title('<title>&lt;tag&gt; &amp; more</title>'), '<tag> & more');
  });

  test('nav blocks keep old semantics including ">" inside attributes', () => {
    const navs = (h: string): string[] => analyzeHtml(h, BASE).signals.navTexts;
    assert.deepEqual(
      navs('<html><body><nav><a href="/c">Contact</a><a href="/a">About</a></nav></body></html>'),
      ['Contact', 'About'],
    );
    // unclosed <nav> means no block at all (old lazy pattern never matched)
    assert.deepEqual(navs('<html><body><nav><a href="/c">Contact</a></body></html>'), []);
    // menu-classed anchors with no <nav>: the fallback maps over tags() output
    // (the OPENING tag only — the old `<a\b([^>]*)>` regex ends at the first
    // ">"), strips it to '' and filters it out, so it has ALWAYS yielded [].
    // Pinned here as pre-existing behavior (new scanners match old exactly).
    assert.deepEqual(navs('<html><body><a class="menu-item" href="/x">Home</a></body></html>'), []);
    // case-insensitive open/close like the old /gi flags
    assert.deepEqual(navs('<html><body><NAV><A href="/c">Go</A></NAV></body></html>'), ['Go']);
  });
});
