import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redactString, type Logger } from '../../src/core/logger.ts';

interface Captured {
  lines: string[];
  logger: Logger;
  restore(): void;
}

function capture(level: 'debug' | 'info' | 'warn' | 'error' = 'info', redact = true): Captured {
  const lines: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  const sink = (chunk: unknown): boolean => {
    lines.push(String(chunk));
    return true;
  };
  process.stdout.write = sink as typeof process.stdout.write;
  process.stderr.write = sink as typeof process.stderr.write;
  return {
    lines,
    logger: createLogger(level, redact),
    restore() {
      process.stdout.write = origOut;
      process.stderr.write = origErr;
    },
  };
}

describe('log redaction', () => {
  test('masks phone numbers and emails', () => {
    const maskedPhone = redactString('call +92 300 1234567 now');
    assert.ok(!maskedPhone.includes('1234567'), 'full number must not appear');
    assert.ok(maskedPhone.includes('4567'), 'last 4 digits stay readable');
    const maskedMail = redactString('owner@universalwebsolutions.it.com');
    assert.ok(!maskedMail.includes('owner@'));
    assert.ok(maskedMail.includes('[email]'));
  });

  test('secret-like keys are replaced entirely', () => {
    const c = capture('info');
    try {
      c.logger.info('test', {
        apiToken: 'abc123secret',
        password: 'hunter2',
        nested: { authorization: 'Bearer xyz', note: 'safe' },
        phone: '+923001234567',
      });
    } finally {
      c.restore();
    }
    const text = c.lines.join('');
    assert.ok(!text.includes('abc123secret'), 'api token leaked');
    assert.ok(!text.includes('hunter2'), 'password leaked');
    assert.ok(!text.includes('Bearer xyz'), 'authorization header leaked');
    assert.ok(!text.includes('1234567'), 'phone leaked');
    assert.ok(text.includes('safe'), 'non-sensitive fields survive');
  });

  test('redaction can be disabled explicitly', () => {
    const c = capture('info', false);
    try {
      c.logger.info('msg', { phone: '+923001234567' });
    } finally {
      c.restore();
    }
    assert.ok(c.lines.join('').includes('+923001234567'));
  });

  test('level filtering suppresses lower levels', () => {
    const c = capture('warn', false);
    try {
      c.logger.debug('nope-debug');
      c.logger.info('nope-info');
      c.logger.warn('yes-warn');
    } finally {
      c.restore();
    }
    const text = c.lines.join('');
    assert.ok(!text.includes('nope-debug'));
    assert.ok(!text.includes('nope-info'));
    assert.ok(text.includes('yes-warn'));
  });

  test('silent level emits nothing', () => {
    const c = capture('info');
    try {
      const silent = createLogger('silent', true);
      silent.error('nothing should be written');
      silent.info('nothing either');
    } finally {
      c.restore();
    }
    assert.equal(c.lines.length, 0);
  });

  // ---- HIGH#1 regression: the old EMAIL_RE was QUADRATIC on a long ----
  // ---- unbroken word run (100 K chars ≈ 16.6 s) and the logger masks ----
  // ---- req.path on every 404/error — unauthenticated CPU burn.       ----

  test('a 100 K-char adversarial word run redacts in linear time', () => {
    // The measured quadratic shape for the old EMAIL_RE (100 K ≈ 16.6 s):
    // a long unbroken word run ending in a dangling @ (no domain follows).
    const hostile = `${'a'.repeat(100_000)}@`;
    const started = Date.now();
    const out = redactString(hostile);
    const elapsed = Date.now() - started;
    // Linear scan: well under a second. The quadratic version took ~16 s.
    assert.ok(elapsed < 1_000, `redaction took ${elapsed} ms — must be linear`);
    assert.equal(out, hostile, 'no domain after the @ — nothing to mask (same as old engine)');

    // Same run WITH a valid address at the end: masked, still linear.
    const withAddr = `${'b'.repeat(100_000)}@x.com`;
    const t2 = Date.now();
    const out2 = redactString(withAddr);
    assert.ok(Date.now() - t2 < 1_000, 'long local run + address must be linear');
    assert.equal(out2, '[email]');
  });

  test('email masking survives long surrounding runs', () => {
    const head = `owner@example.com ${'x'.repeat(50_000)}`;
    const out = redactString(head);
    assert.ok(out.startsWith('[email] '), 'address at start masked, boundary kept');
    assert.ok(out.includes('xxxx'), 'trailing word run preserved');

    // A long word run forming the local part is swallowed by the match —
    // exactly like the old greedy `[\w.+-]+@…` engine.
    assert.equal(redactString(`${'y'.repeat(50_000)}@domain.example`), '[email]');

    // A boundary character splits the run: prefix preserved, address masked.
    const split = `${'z'.repeat(50_000)}!owner@example.com`;
    const out2 = redactString(split);
    assert.ok(out2.startsWith('zzzz'), 'leading run preserved');
    assert.ok(out2.endsWith('![email]'), 'address after boundary masked');

    // Adjacent addresses (old engine resumes scanning after the previous match).
    assert.equal(redactString('a@b.c d@e.f'), '[email] [email]');
    // A second @ inside the first match's tail must not double-mask.
    assert.equal(redactString('a@b.comx@y.z'), '[email]@y.z');
  });

  test('unicode local parts behave like the old \\w-based pattern', () => {
    // \w is ASCII-only, so the old regex (and this scanner) starts the
    // local run after the non-ASCII character.
    assert.equal(redactString('üser@example.com'), 'ü[email]');
    assert.equal(redactString('naïve@ex.com'), 'naï[email]');
    // ...and an address fully inside \w is masked whole.
    assert.equal(redactString('owner@example.com'), '[email]');
    // Non-addresses are untouched.
    assert.equal(redactString('not-an-email @ nope'), 'not-an-email @ nope');
    assert.equal(redactString('a@b'), 'a@b');
    assert.equal(redactString('a@b.'), 'a@b.');
  });

  test('free-text secrets (Bearer / provider keys / key=value) are redacted', () => {
    const line =
      'failed with Authorization: Bearer sk-live-abcdefghijklmnop ' +
      'key=AIzaSyAAAAAAAAAAAAAAAAAAAAAAAA token=abcdef123456 and ghp_ABCDEFGHIJKLMNOPQRSTUV123456';
    const out = redactString(line);
    assert.ok(!out.includes('sk-live-abcdefghijklmnop'), 'bearer token leaked');
    assert.ok(!out.includes('AIzaSy'), 'google key leaked');
    assert.ok(!out.includes('abcdef123456'), 'kv token leaked');
    assert.ok(!out.includes('ghp_ABCDEFGHIJKLMNOPQRSTUV123456'), 'github key leaked');
    assert.ok(out.includes('failed with'), 'surrounding text survives');
    // access_token=… must match (no word-boundary before the key).
    const kv = redactString('the access_token=zz9988776655443322 value');
    assert.ok(!kv.includes('zz9988776655443322'), 'access_token value leaked');
    // A key-looking word WITHOUT a separator must not be mangled.
    assert.equal(redactString('tokenizer is fine'), 'tokenizer is fine');
  });
});
