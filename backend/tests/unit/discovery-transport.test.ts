/**
 * Unit tests for the sanitized transport-error classifier (Phase 12 hardening).
 *
 * Proves:
 *  - every whitelisted Node/libuv/undici error code maps to the right
 *    category (timeout / dns / tls / refused / reset);
 *  - error NAME takes precedence where a name is decisive (TimeoutError,
 *    AbortError), and nested `cause` chains are walked (undici wraps most
 *    failures as `TypeError: fetch failed` + cause);
 *  - unknown codes, non-Error values, null/undefined and hostile objects
 *    fall back to the closed-set `unknown` category;
 *  - message TEXT is never consulted (a crafted message cannot influence
 *    the category) and the input error is never mutated.
 *
 * Pure functions only: no network, no adapter, no filesystem.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyTransportError,
  type TransportCategory,
} from '../../src/adapters/discovery/transport.ts';

interface FakeError {
  name?: string;
  code?: string;
  message?: string;
  cause?: unknown;
}

function err(props: FakeError): FakeError {
  return { name: 'Error', ...props };
}

describe('classifyTransportError: whitelisted codes', () => {
  const cases: [string, TransportCategory][] = [
    // timeouts
    ['ETIMEDOUT', 'timeout'],
    ['UND_ERR_CONNECT_TIMEOUT', 'timeout'],
    ['UND_ERR_HEADERS_TIMEOUT', 'timeout'],
    ['UND_ERR_BODY_TIMEOUT', 'timeout'],
    // DNS
    ['ENOTFOUND', 'dns'],
    ['EAI_AGAIN', 'dns'],
    ['EAI_FAIL', 'dns'],
    ['EAI_NONAME', 'dns'],
    ['EAI_NODATA', 'dns'],
    // refused / reset
    ['ECONNREFUSED', 'refused'],
    ['ECONNRESET', 'reset'],
    ['ECONNABORTED', 'reset'],
    ['EPIPE', 'reset'],
    // TLS / certificates
    ['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'tls'],
    ['UNABLE_TO_GET_ISSUER_CERT', 'tls'],
    ['UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'tls'],
    ['DEPTH_ZERO_SELF_SIGNED_CERT', 'tls'],
    ['SELF_SIGNED_CERT_IN_CHAIN', 'tls'],
    ['CERT_HAS_EXPIRED', 'tls'],
    ['CERT_NOT_YET_VALID', 'tls'],
    ['CERT_REVOKED', 'tls'],
    ['ERR_TLS_CERT_ALTNAME_INVALID', 'tls'],
    ['HOSTNAME_MISMATCH', 'tls'],
    ['EPROTO', 'tls'],
  ];

  for (const [code, category] of cases) {
    test(`code ${code} -> ${category}`, () => {
      assert.equal(classifyTransportError(err({ code })), category);
    });
  }

  test('ERR_TLS_ and ERR_SSL_ prefixes classify as tls', () => {
    assert.equal(classifyTransportError(err({ code: 'ERR_TLS_VERSION_MISMATCH' })), 'tls');
    assert.equal(classifyTransportError(err({ code: 'ERR_SSL_WRONG_VERSION_NUMBER' })), 'tls');
  });
});

describe('classifyTransportError: names and cause chains', () => {
  test('TimeoutError name -> timeout even without a code', () => {
    assert.equal(classifyTransportError({ name: 'TimeoutError', message: 'op timed out' }), 'timeout');
  });

  test('AbortError name -> timeout (abort-with-deadline paths)', () => {
    assert.equal(classifyTransportError({ name: 'AbortError' }), 'timeout');
  });

  test('name is decisive when both name and code are present', () => {
    // A TimeoutError carrying a non-timeout code must still be a timeout.
    assert.equal(classifyTransportError(err({ name: 'TimeoutError', code: 'ECONNRESET' })), 'timeout');
  });

  test('nested cause chain is walked (undici TypeError wrapping)', () => {
    const undiciStyle = {
      name: 'TypeError',
      message: 'fetch failed',
      cause: err({ code: 'ECONNREFUSED', message: 'connect ECONNREFUSED 1.2.3.4:443' }),
    };
    assert.equal(classifyTransportError(undiciStyle), 'refused');
  });

  test('depth is bounded: a chain longer than 5 links ends as unknown', () => {
    let deep: unknown = err({ code: 'ECONNREFUSED' });
    for (let i = 0; i < 8; i++) deep = err({ message: `link ${i}`, cause: deep });
    assert.equal(classifyTransportError(deep), 'unknown', 'beyond the bound nothing is trusted');
  });

  test('cause links are classified, outer wrappers ignored', () => {
    const chain = err({ message: 'outer', cause: err({ code: 'ENOTFOUND' }) });
    assert.equal(classifyTransportError(chain), 'dns');
  });
});

describe('classifyTransportError: hostile / unknown inputs', () => {
  test('unrecognized code -> unknown', () => {
    assert.equal(classifyTransportError(err({ code: 'SOMETHING_ELSE' })), 'unknown');
  });

  test('message text is never consulted', () => {
    // A message that LOOKS like a refused connection must not be classified
    // as refused: only whitelisted name/code fields count.
    const hostile = { name: 'Error', message: 'connect ECONNREFUSED 10.0.0.1:443' };
    assert.equal(classifyTransportError(hostile), 'unknown');
    const hostile2 = { message: 'getaddrinfo ENOTFOUND evil.example' };
    assert.equal(classifyTransportError(hostile2), 'unknown');
  });

  test('null / undefined / primitives -> unknown, no throw', () => {
    assert.equal(classifyTransportError(null), 'unknown');
    assert.equal(classifyTransportError(undefined), 'unknown');
    assert.equal(classifyTransportError('boom'), 'unknown');
    assert.equal(classifyTransportError(42), 'unknown');
    assert.equal(classifyTransportError(true), 'unknown');
  });

  test('a string code field on an object is still whitelisted-checked', () => {
    assert.equal(classifyTransportError({ code: 'ENOTFOUND' }), 'dns');
    assert.equal(classifyTransportError({ code: 1234 }), 'unknown', 'non-string codes are ignored');
  });

  test('the input error is never mutated', () => {
    const original = err({ code: 'ETIMEDOUT', message: 'original' });
    const snapshot = JSON.stringify(original);
    classifyTransportError(original);
    assert.equal(JSON.stringify(original), snapshot, 'classifier must be read-only');
  });

  test('category is always a member of the closed set', () => {
    const allowed: TransportCategory[] = ['timeout', 'dns', 'tls', 'refused', 'reset', 'unknown'];
    const inputs: unknown[] = [
      null,
      undefined,
      'x',
      err({ code: 'ENOTFOUND' }),
      { name: 'TimeoutError' },
      err({}),
    ];
    for (const input of inputs) {
      assert.ok(
        allowed.includes(classifyTransportError(input)),
        `unexpected category for ${String(input)}`,
      );
    }
  });
});
