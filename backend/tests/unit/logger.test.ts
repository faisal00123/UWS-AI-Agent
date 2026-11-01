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
});
