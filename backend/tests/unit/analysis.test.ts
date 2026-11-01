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
});
