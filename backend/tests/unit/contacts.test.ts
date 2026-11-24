/**
 * Contact extraction — behaviour, security and performance.
 *
 * Three concerns, all over ATTACKER-CONTROLLED page bodies:
 *
 *  1. BEHAVIOUR  — the linear scanners in core/contacts.ts must produce
 *     exactly what the regexes they replaced produced (a differential test
 *     runs the original pipeline side by side).
 *  2. SECURITY   — script/style/comment content is never a contact, and a
 *     long unbroken run can never yield a fabricated or truncated address.
 *  3. PERFORMANCE — the three inputs that used to be O(n²) must stay O(n),
 *     proven both by an absolute bound at the real 1.5 MB fetcher cap and by
 *     a doubling comparison (quadratic growth is ~4x, linear is ~2x).
 *
 * Synthetic fixtures only. No network, no database, no real leads.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { extractContacts } from '../../src/core/contacts.ts';
import { normalizeEmail, isMachineMailbox } from '../../src/domain/leads/normalize.ts';

/**
 * The ORIGINAL implementation, verbatim, as the reference oracle. Small
 * fixtures only — this is the quadratic code we are replacing, so it must
 * never be handed adversarial input.
 */
function referenceExtract(html: string): { emails: string[]; phones: string[] } {
  const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
  const PHONE_RE = /(?:\+?\d[\d\s().-]{7,}\d)/g;
  const withoutNoise = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');
  const hrefTarget = (value: string, prefixLen: number): string => {
    let target = value.slice(prefixLen);
    const cut = target.search(/[?#,]/);
    if (cut !== -1) target = target.slice(0, cut);
    try {
      target = decodeURIComponent(target);
    } catch {
      /* keep raw */
    }
    return target.trim();
  };
  const emails: string[] = [];
  const phones: string[] = [];
  const seenEmails = new Set<string>();
  const seenPhones = new Set<string>();
  const addEmail = (raw: string): void => {
    const value = raw.trim().toLowerCase();
    if (value === '' || emails.length >= 10 || seenEmails.has(value)) return;
    seenEmails.add(value);
    emails.push(value);
  };
  const addPhone = (raw: string): void => {
    const value = raw.trim();
    if (value === '' || phones.length >= 10 || seenPhones.has(value)) return;
    seenPhones.add(value);
    phones.push(value);
  };
  for (const m of withoutNoise.matchAll(/href\s*=\s*["']([^"']*)["']/gi)) {
    const href = m[1] ?? '';
    const lower = href.toLowerCase();
    if (lower.startsWith('mailto:')) addEmail(hrefTarget(href, 7));
    else if (lower.startsWith('tel:')) addPhone(hrefTarget(href, 4));
  }
  const visible = withoutNoise.replace(/<[^>]+>/g, ' ');
  for (const m of visible.matchAll(EMAIL_RE)) addEmail(m[0]);
  for (const m of visible.matchAll(PHONE_RE)) addPhone(m[0]);
  return { emails, phones };
}

// ------------------------------------------------------------------ behaviour ---

describe('contacts: valid email extraction', () => {
  test('an ordinary valid address is extracted', () => {
    assert.deepEqual(extractContacts('<p>info@alphaclinic.pk</p>').emails, ['info@alphaclinic.pk']);
  });

  test('multiple valid addresses in one input are all extracted, in order', () => {
    const found = extractContacts('a@one.pk b@two.pk c@three.pk');
    assert.deepEqual(found.emails, ['a@one.pk', 'b@two.pk', 'c@three.pk']);
  });

  test('supported formats: subdomains, long TLDs, +, %, -, _ and dots in the local part', () => {
    const input = [
      'user@mail.deep.sub.example.museum',
      'first.last+tag@sub.example.co.uk',
      'pct%variety@example.org',
      'hyphen-part@example.io',
      'under_score@example.net',
      'dotted.local@example.com',
      'UPPER@CASE.PK', // normalised to lower case by the extractor
    ].join(' ');
    assert.deepEqual(extractContacts(input).emails, [
      'user@mail.deep.sub.example.museum',
      'first.last+tag@sub.example.co.uk',
      'pct%variety@example.org',
      'hyphen-part@example.io',
      'under_score@example.net',
      'dotted.local@example.com',
      'upper@case.pk',
    ]);
  });

  test('invalid addresses are not extracted (no TLD, short TLD, missing parts)', () => {
    const found = extractContacts(
      ['a@b', 'a@b.c', 'trail@tld.k', 'trail@tld.2', '@nolocal.pk', 'nodomain@', 'plain text'].join(' '),
    );
    assert.deepEqual(found.emails, []);
  });

  test('mailto/tel hrefs win, visible text follows, script/style/comment noise is skipped', () => {
    const html =
      '<a href="mailto:Info@AlphaClinic.pk?subject=hi">mail</a>' +
      '<a href="tel:+923001112233">call</a>' +
      '<script>hidden@example.com</script>' +
      '<style>sty@le.pk</style>' +
      '<!-- com@ment.pk -->' +
      '<p>appointments@alphaclinic.pk and 0321-4445566</p>';
    const found = extractContacts(html);
    assert.deepEqual(found.emails, ['info@alphaclinic.pk', 'appointments@alphaclinic.pk']);
    assert.deepEqual(found.phones, ['+923001112233', '0321-4445566']);
  });

  test('output stays de-duplicated and capped at 10 per field', () => {
    const many = Array.from({ length: 15 }, (_, i) => `<a href="mailto:user${i}@cap.pk">x</a>`).join('');
    const found = extractContacts(many);
    assert.equal(found.emails.length, 10);
    assert.equal(new Set(found.emails).size, 10);

    const dup = extractContacts('<a href="mailto:Same@Dup.pk">a</a><p>same@dup.pk again</p>');
    assert.deepEqual(dup.emails, ['same@dup.pk'], 'case-insensitive dedupe, first occurrence kept');
  });
});

describe('contacts: differential against the original regex pipeline', () => {
  // Small/medium fixtures only: the oracle is the quadratic code.
  const CORPUS: string[] = [
    '',
    '   ',
    'no email here',
    'a@b',
    'a@b.c',
    'a@b.cd',
    'user@host.example.com',
    'Contact info@alphaclinic.pk or appointments@alphaclinic.pk today',
    'weird+tag%fmt-1_2@sub.domain.co.uk',
    'dots..in@local.part.pk',
    'a@b@c.pk',
    '@nolocal.pk',
    'spaces in@local.pk',
    'x..y@a.b',
    '.lead@a.b',
    'lead.@a.b',
    'mail me at foo@bar.pk.',
    '(see foo@bar.pk)',
    '<foo@bar.pk>',
    'foo@bar.pk,',
    'foo@bar.pk;',
    'foo@bar.pk-',
    'foo@bar.pk...',
    'a.b@c.d.e.f',
    'user@a.b.cd-frag',
    'x@a.b.cccccccccccc',
    '<p>info@alphaclinic.pk</p>',
    '<a href="mailto:Same@Dup.pk">x</a><p>same@dup.pk again</p>',
    '<SCRIPT>hidden@example.com</SCRIPT><script>also@hidden.pk</script>',
    '<script src="x.js"></script>vis@ible.pk<STYLE>sty@le.pk</STYLE>',
    '<!-- com@ment.pk -->txt@after.pk',
    '<!-->unusual<!-->post@comment.pk',
    '<>weird<>',
    'a<>b',
    '<<>',
    '<a<b>c',
    '<unclosed tag here',
    'text with < alone',
    'mailto:a@b.pk?subject=hi',
    'tel:+923001112233',
    'href = "mailto:x@y.pk"',
    "href='tel:+923219998877'",
    'mailto:%41%42@c.pk',
    'mailto:bad%zz@c.pk',
    '03001111111 and +92 321 4445566',
    '+923001234567',
    'noreply@clinic.pk',
    'ünïcode@exämple.pk',
    'İstanbul@Shop.pk',
    '<sKript>kel@vin.pk</sKript>', // non-ASCII case fold of a script tag
    'x'.repeat(200) + '@edge.pk', // at the 254-char cap: 200+1+9 = 210
    'name@' + 'f'.repeat(240) + '.com', // 5+1+244 = 250
    'name@' + 'g'.repeat(244) + '.com', // 5+244+4 = 253 — just under the cap
  ];

  test('every fixture produces byte-identical output to the original pipeline', () => {
    for (const html of CORPUS) {
      assert.deepEqual(
        extractContacts(html),
        referenceExtract(html),
        `divergence for ${JSON.stringify(html.slice(0, 70))}`,
      );
    }
  });

  test('emails at or under the 254-char cap are extracted exactly as before', () => {
    const atCap = 'name@' + 'g'.repeat(244) + '.com'; // 5+244+4 = 253 chars total
    assert.equal(atCap.length, 253);
    assert.deepEqual(extractContacts(atCap).emails, referenceExtract(atCap).emails);
    assert.equal(extractContacts(atCap).emails[0], atCap);
  });
});

// ------------------------------------------------------------ the length cap ---

describe('contacts: candidate-length limit (254, RFC 5321)', () => {
  test('an address of exactly 254 characters is kept', () => {
    const local = 'n'.repeat(249); // 249 + '@' + 4 = 254
    const value = `${local}@a.bb`;
    assert.equal(value.length, 254);
    assert.deepEqual(extractContacts(value).emails, [value]);
    assert.equal(normalizeEmail(value).valid, true, 'still valid downstream');
  });

  test('an address of 255 characters is skipped, never truncated to a shorter fake', () => {
    const value = `${'n'.repeat(250)}@a.bb`; // 255 chars
    assert.equal(value.length, 255);
    const found = extractContacts(value);
    // Nothing shorter was invented in its place (checked before the empty
    // assertion, which would narrow the array to never[] for TypeScript).
    assert.ok(found.emails.every((e) => e.length <= 254), 'never truncated to a shorter fake');
    assert.deepEqual(found.emails, [], 'over-long candidate is dropped whole');
    // The old pipeline would have produced this, and normalizeEmail rejects
    // it anyway — so the end result for enrichment is identical.
    assert.equal(referenceExtract(value).emails[0], value, 'oracle did produce it');
    assert.deepEqual(normalizeEmail(value), {
      email: null,
      valid: false,
      reason: 'too_long',
    });
  });

  test('an over-long LOCAL part is skipped rather than cut mid-address', () => {
    const value = `${'y'.repeat(300)}@toolong.pk`;
    assert.deepEqual(extractContacts(value).emails, []);
    assert.equal(normalizeEmail(value).reason, 'too_long');
  });

  test('an over-long DOMAIN is skipped rather than cut mid-address', () => {
    const value = `z@${'d'.repeat(300)}.pk`;
    assert.deepEqual(extractContacts(value).emails, []);
    assert.equal(normalizeEmail(value).reason, 'too_long');
  });

  test('machine-mailbox filtering is untouched (it happens downstream, in enrich)', () => {
    // extractContacts only extracts; normalize/isMachineMailbox still decide.
    const found = extractContacts('<p>noreply@clinic.pk abuse@site.pk</p>');
    assert.deepEqual(found.emails, ['noreply@clinic.pk', 'abuse@site.pk']);
    assert.equal(isMachineMailbox(found.emails[0]), true);
    assert.equal(normalizeEmail(found.emails[0]).valid, true, 'format is fine; filtering is separate');
  });
});

// --------------------------------------------------- adversarial + performance ---

describe('contacts: adversarial input stays bounded', () => {
  test('a 1.5 MB solid word run (the analysis fetcher cap) completes quickly', () => {
    const html = `<p>${'x'.repeat(1_500_000)}</p>`;
    const began = Date.now();
    const found = extractContacts(html);
    const ms = Date.now() - began;
    assert.deepEqual(found.emails, []);
    assert.deepEqual(found.phones, []);
    assert.ok(ms < 1500, `expected linear time, took ${ms}ms`);
  });

  test('a 1.5 MB run of lone "<" (the tag-stripper vector) completes quickly', () => {
    const html = '<'.repeat(1_500_000);
    const began = Date.now();
    const found = extractContacts(html);
    const ms = Date.now() - began;
    assert.deepEqual(found.emails, []);
    assert.ok(ms < 1500, `expected linear time, took ${ms}ms`);
  });

  test('1.5 MB of unclosed "<script>" blocks (the stripNoise vector) completes quickly', () => {
    const html = '<script>'.repeat(166_666); // ~1.5 MB, no closing tag anywhere
    const began = Date.now();
    const found = extractContacts(html);
    const ms = Date.now() - began;
    assert.deepEqual(found.emails, []);
    assert.ok(ms < 1500, `expected linear time, took ${ms}ms`);
  });

  test('a valid address near the START of a long word run is found', () => {
    const html = `first@lead.pk ${'x'.repeat(200_000)}`;
    const found = extractContacts(html);
    assert.deepEqual(found.emails, ['first@lead.pk']);
  });

  test('a valid address near the END of a long word run is found', () => {
    const html = `${'x'.repeat(200_000)} last@tail.pk`;
    const found = extractContacts(html);
    assert.deepEqual(found.emails, ['last@tail.pk']);
  });

  test('repeated punctuation and malformed email-like strings yield nothing', () => {
    const malformed = [
      '....@@@@....',
      '!!@@!!',
      '@@@@',
      'a@@b.pk',
      'a@.pk',
      'a@-pk',
      'a@pk..',
      '<a@b',
      'a@b>',
    ].join(' ');
    assert.deepEqual(extractContacts(malformed).emails, []);
  });

  test('junk that the ORIGINAL regex also matched is matched identically (no new false positives)', () => {
    // Deliberately includes strings that DO match the old pattern — the
    // property under test is "never extract something the old code would not",
    // not "extract nothing from punctuation".
    const junk = [
      '(((a@b.pk)))',
      '...a@b..pk..',
      '...a@b..pk',
      'a@b.pk',
      '....@@@@....',
      'a@@b.pk',
      'a@.pk',
      'a@-pk',
      'a@pk..',
      '<a@b',
      'a@b>',
    ].join(' ');
    assert.deepEqual(extractContacts(junk), referenceExtract(junk));
  });

  test('empty input is handled (the API takes a string; null is not part of it)', () => {
    assert.deepEqual(extractContacts(''), { emails: [], phones: [] });
    assert.deepEqual(extractContacts('   \n\t  '), { emails: [], phones: [] });
  });

  /**
   * Doubling comparison: linear work doubles (~2x), quadratic work quadruples
   * (~4x). The bound sits at 3x plus 100 ms of scheduler slack, so:
   *   - linear (measured ~1-5 ms) always passes comfortably, and
   *   - the old quadratic code (measured 1 s / 4 s at 25 K / 50 K) fails.
   * Each vector uses an input with no other trigger present, so the measured
   * cost belongs to the scanner under test.
   */
  function assertDoublesLinearly(label: string, make: (n: number) => string, n: number): void {
    const time = (size: number): number => {
      const html = make(size);
      const t = Date.now();
      extractContacts(html);
      return Date.now() - t;
    };
    const t1 = time(n);
    const t2 = time(n * 2);
    assert.ok(
      t2 <= t1 * 3 + 100,
      `${label}: doubling ${n}->${n * 2} took ${t1}ms -> ${t2}ms (quadratic growth)`,
    );
  }

  test('doubling a solid word run does not cause quadratic growth', () => {
    assertDoublesLinearly('EMAIL_RE vector', (n) => 'x'.repeat(n), 25_000);
  });

  test('doubling a run of lone "<" does not cause quadratic growth', () => {
    assertDoublesLinearly('tag-stripper vector', (n) => '<'.repeat(n), 16_000);
  });

  test('doubling unclosed "<script>" blocks does not cause quadratic growth', () => {
    assertDoublesLinearly('stripNoise vector', (n) => '<script>'.repeat(n / 8), 64_000);
  });
});
