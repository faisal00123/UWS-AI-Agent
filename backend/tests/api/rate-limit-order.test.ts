/**
 * MED#4 regression: the /api rate limiter must run BEFORE the body parsers.
 *
 * If the limiter sits behind express.json, every over-limit request still
 * pays a full JSON parse first — an attacker can burn CPU past the limit
 * (and oversized bodies would answer 413 instead of 429, proving the order).
 * An isolated TestServer is used because the limiter counts every /api
 * request for the whole server lifetime.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';

let server: TestServer;
let client: TestClient;

describe('api rate limiter ordering', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@ratelimit.test' });
    client = await loginAs(server, seeded.email, seeded.password);
  });
  after(async () => {
    await server.close();
  });

  test('over-limit requests are rejected before the body is parsed', async () => {
    // Exhaust the 600/min window (login requests count too, so loop until
    // the limiter trips rather than assuming an exact starting count).
    let sawLimit = false;
    for (let i = 0; i < 610; i++) {
      const res = await client.get('/api/leads');
      if (res.status === 429) {
        sawLimit = true;
        break;
      }
      assert.ok(res.status < 500, `unexpected ${res.status} while exhausting the limiter`);
    }
    assert.ok(sawLimit, 'expected the api limiter to trip within 610 requests');

    // Past the limit, an oversized body must still answer 429 — NOT the body
    // parser's 413 — proving the limiter runs first.
    const oversized = JSON.stringify({ pad: 'x'.repeat(300 * 1024) });
    const res = await client.request<{ error: { code: string } }>('/api/leads', {
      method: 'POST',
      rawBody: oversized,
      headers: { 'content-type': 'application/json' },
    });
    assert.equal(res.status, 429, `expected 429 from the limiter, got ${res.status} (${res.raw})`);
    assert.equal(res.body.error.code, 'rate_limited');
  });
});
