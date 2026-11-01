import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeEmail,
  normalizeName,
  normalizePhone,
  normalizeWebsite,
  nameSimilarity,
} from '../../src/domain/leads/normalize.ts';

describe('phone normalisation', () => {
  test('Pakistani mobile formats all converge to +923XXXXXXXXX', () => {
    const inputs = ['03001234567', '3001234567', '923001234567', '+92 300 1234567', '+92-300-1234567', '00923001234567', '0092 300 1234567'];
    for (const i of inputs) {
      const r = normalizePhone(i);
      assert.equal(r.valid, true, `${i} should be valid (${r.reason})`);
      assert.equal(r.e164, '+923001234567', `${i} normalisation mismatch`);
      assert.equal(r.country, 'PK');
    }
  });

  test('valid international numbers are kept as E.164', () => {
    const r = normalizePhone('+1 415 555 2671');
    assert.equal(r.valid, true);
    assert.equal(r.e164, '+14155552671');
    assert.equal(r.country, 'intl');
  });

  test('invalid numbers are rejected with a reason', () => {
    for (const bad of ['', 'abc', '123', '030012', '+92300123456789012345', 'not-a-number']) {
      const r = normalizePhone(bad);
      assert.equal(r.valid, false, `${bad} must be invalid`);
      assert.equal(r.e164, null);
      assert.ok(r.reason, `${bad} must carry a reason`);
    }
  });

  test('original value is preserved for audit', () => {
    const r = normalizePhone('+92 (300) 123-4567');
    assert.equal(r.original, '+92 (300) 123-4567');
  });
});

describe('website normalisation', () => {
  test('adds a scheme, lowercases and strips www for the dedupe key', () => {
    const r = normalizeWebsite('WWW.Example.COM.PK/path');
    assert.equal(r.valid, true);
    assert.equal(r.host, 'example.com.pk');
    assert.ok(r.url?.startsWith('https://'));
  });

  test('protocol is preserved when supplied', () => {
    assert.equal(normalizeWebsite('http://example.com').url?.startsWith('http://'), true);
  });

  test('invalid hosts are rejected', () => {
    for (const bad of ['not a url', 'javascript:alert(1)', 'http://', 'localhost']) {
      const r = normalizeWebsite(bad);
      assert.equal(r.valid, false, `${bad} must be invalid`);
    }
  });

  test('same business on http/https/www gives the same dedupe host', () => {
    const a = normalizeWebsite('https://www.Example.com');
    const b = normalizeWebsite('http://example.com/');
    assert.equal(a.host, b.host);
  });
});

describe('name / email normalisation', () => {
  test('legal suffixes and punctuation are ignored for dedupe', () => {
    assert.equal(normalizeName('Karachi Clinic (Pvt) Ltd.'), 'karachi clinic');
    assert.equal(normalizeName('  ABC   School  '), 'abc school');
    assert.equal(normalizeName('Al-Noor Traders'), 'al noor traders');
  });

  test('emails are validated and lowercased', () => {
    assert.deepEqual(normalizeEmail('  Owner@Example.COM '), { email: 'owner@example.com', valid: true });
    assert.equal(normalizeEmail('nope').valid, false);
    assert.equal(normalizeEmail('').valid, false);
  });
});

describe('name similarity', () => {
  test('identical names score 1 and unrelated names score low', () => {
    assert.equal(nameSimilarity('karachi clinic', 'karachi clinic'), 1);
    assert.ok(nameSimilarity('karachi clinic', 'karachi clinics') > 0.85);
    assert.ok(nameSimilarity('karachi clinic', 'lahore restaurant') < 0.5);
  });
});
