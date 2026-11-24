/**
 * MED#5 regression: the fetcher's timeout must cover the BODY-READ phase.
 *
 * Before the fix the per-hop timer was cleared the moment response headers
 * arrived, so a server that answered quickly and then never sent a byte of
 * body held the analysis job open indefinitely (the reader awaited forever).
 * The stubs below deliberately IGNORE `signal` — proving the read races the
 * abort itself and does not depend on transport cooperation.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fetchForAnalysis } from '../../src/domain/analysis/fetcher.ts';

const PUBLIC_DNS = async () => [{ address: '93.184.216.34' }];

/** A body stream that never yields a chunk and never closes. */
function hangingBody(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start() {
      /* intentionally never enqueue or close */
    },
  });
}

describe('fetcher body-phase deadline', () => {
  test('a stalled body hits the timeout instead of hanging forever', async () => {
    const fetchImpl = (async () =>
      new Response(hangingBody(), {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })) as unknown as typeof fetch;

    const started = Date.now();
    const outcome = await fetchForAnalysis('https://stalled.example/', {
      timeoutMs: 80,
      fetchImpl,
      dnsLookup: PUBLIC_DNS,
    });
    const elapsed = Date.now() - started;

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.equal(outcome.status, 'unreachable');
    assert.match(outcome.message, /Timed out after 80ms/);
    // The read raced the abort: bounded well under a second (a hang would
    // never return at all; generous headroom for slow CI).
    assert.ok(elapsed < 2000, `expected a bounded timeout, took ${elapsed}ms`);
  });

  test('a healthy body still reads to completion', async () => {
    const html = '<html><head><title>Fast</title></head><body>ok</body></html>';
    const fetchImpl = (async () =>
      new Response(html, {
        status: 200,
        headers: { 'content-type': 'text/html' },
      })) as unknown as typeof fetch;

    const outcome = await fetchForAnalysis('https://fast.example/', {
      timeoutMs: 2000,
      fetchImpl,
      dnsLookup: PUBLIC_DNS,
    });
    assert.equal(outcome.ok, true);
    if (!outcome.ok) return;
    assert.equal(outcome.html, html);
    assert.equal(outcome.truncated, false);
  });

  test('a body that trickles one byte stays bounded by the same timer', async () => {
    // One byte per interval far longer than the timeout: without a body-phase
    // deadline this would take ~1.5 MB * interval to finish (or forever if it
    // stops after the first byte). The interval is kept short so the abandoned
    // in-flight pull does not hold the test process open.
    const fetchImpl = (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          async pull(controller) {
            await new Promise((r) => setTimeout(r, 300));
            controller.enqueue(new Uint8Array([0x61]));
            // never closes
          },
        }),
        { status: 200, headers: { 'content-type': 'text/html' } },
      )) as unknown as typeof fetch;

    const started = Date.now();
    const outcome = await fetchForAnalysis('https://trickle.example/', {
      timeoutMs: 100,
      fetchImpl,
      dnsLookup: PUBLIC_DNS,
    });
    const elapsed = Date.now() - started;

    assert.equal(outcome.ok, false);
    if (outcome.ok) return;
    assert.match(outcome.message, /Timed out after 100ms/);
    assert.ok(elapsed < 2000, `expected a bounded timeout, took ${elapsed}ms`);
  });
});
