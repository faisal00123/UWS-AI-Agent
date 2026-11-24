/**
 * H2 (SSRF) + M1 (bounded streaming) hardening of the verify homepage fetch
 * (backend/src/adapters/discovery/website.ts).
 *
 * Every test runs through INJECTED transports: no request ever leaves the
 * process and no real DNS lookup is performed (the `.invalid` RFC 2606 host
 * test would fail if a real resolver were consulted).
 *
 * Covered:
 *  - literal loopback / private / link-local / CGNAT / metadata addresses
 *    are refused BEFORE any request;
 *  - a hostname that RESOLVES to a private address is refused post-DNS;
 *  - redirects are manual and every hop is revalidated (the internal hop is
 *    never requested);
 *  - a normal public URL succeeds with contacts parsed;
 *  - non-HTML content types fail closed;
 *  - DNS failure is an honest retryable network error;
 *  - M1: oversized bodies are cut at the byte cap with the upstream stream
 *    cancelled, normal bodies are read fully, an interrupted stream surfaces
 *    as a retryable error (no hang), and a stalled body hits the deadline
 *    with resources released.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';
import { discoverFromWebsite } from '../../src/adapters/discovery/website.ts';

/** Public stand-in used whenever a test supplies its own resolver. */
const PUBLIC_DNS = async (): Promise<{ address: string }[]> => [{ address: '93.184.216.34' }];

interface FetchLog {
  fetchImpl: FetchLike;
  calls: { url: string; init: RequestInit }[];
}

/** A transport that answers 200 text/html and records every call. */
function htmlFetch(html: string, opts: { status?: number; contentType?: string } = {}): FetchLog {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(html, {
      status: opts.status ?? 200,
      headers: { 'content-type': opts.contentType ?? 'text/html' },
    });
  };
  return { fetchImpl, calls };
}

describe('H2: SSRF guard on the verify homepage fetch', () => {
  test('loopback, private, link-local, CGNAT and metadata literals are refused before any request', async () => {
    const blockedUrls = [
      'http://127.0.0.1:8080/admin', // loopback
      'http://10.1.2.3/', // RFC1918 private
      'http://192.168.1.10/router', // RFC1918 private
      'http://169.254.169.254/latest/meta-data/', // link-local + cloud metadata
      'http://100.64.0.1/', // CGNAT
    ];
    for (const url of blockedUrls) {
      const { fetchImpl, calls } = htmlFetch('<html><title>x</title></html>');
      await assert.rejects(
        discoverFromWebsite(url, { fetchImpl, dnsLookup: PUBLIC_DNS }),
        (err: unknown) =>
          err instanceof AdapterError &&
          err.code === 'invalid_destination' &&
          /private or reserved/i.test(err.message),
        `${url} must be refused as invalid_destination`,
      );
      assert.equal(calls.length, 0, `${url} must never be requested`);
    }
  });

  test('a hostname that RESOLVES to a private address is refused after DNS, before the request', async () => {
    const { fetchImpl, calls } = htmlFetch('<html><title>x</title></html>');
    await assert.rejects(
      discoverFromWebsite('https://internal.corp.pk/', {
        fetchImpl,
        dnsLookup: async () => [{ address: '10.0.0.5' }],
      }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );
    assert.equal(calls.length, 0, 'the resolved private address is never requested');
  });

  test('redirects are manual and every hop is revalidated — the internal hop is never requested', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url, init });
      assert.equal(init.redirect, 'manual', 'fetch must never follow redirects on its own');
      return new Response(null, { status: 302, headers: { location: 'http://192.168.1.10/admin' } });
    };
    await assert.rejects(
      discoverFromWebsite('https://public-hop.pk/start', { fetchImpl, dnsLookup: PUBLIC_DNS }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );
    assert.equal(calls.length, 1, 'only the first (public) hop is requested');
    assert.equal(calls[0]!.url, 'https://public-hop.pk/start');
  });

  test('a normal public URL succeeds: contacts parsed, manual redirect mode, final URL returned', async () => {
    const html = `<html><head><title>  Ahmed Grill House — Best BBQ </title></head>
      <body><p>Call +92 300 1234567</p><p>orders@ahmedgrill.pk</p></body></html>`;
    const { fetchImpl, calls } = htmlFetch(html);
    const found = await discoverFromWebsite('https://ahmedgrill.pk/', { fetchImpl, dnsLookup: PUBLIC_DNS });
    assert.equal(found.title, 'Ahmed Grill House — Best BBQ');
    assert.ok(found.emails.includes('orders@ahmedgrill.pk'));
    assert.ok(found.phones.some((p) => p.includes('923001234567')));
    assert.equal(found.finalUrl, 'https://ahmedgrill.pk/');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.init.redirect, 'manual', 'manual redirects even on the happy path');
  });

  test('non-HTML content types fail closed (never parsed as a homepage)', async () => {
    const { fetchImpl, calls } = htmlFetch('{"json":true}', { contentType: 'application/json' });
    await assert.rejects(
      discoverFromWebsite('https://json-only.pk/', { fetchImpl, dnsLookup: PUBLIC_DNS }),
      (err: unknown) =>
        err instanceof AdapterError && err.code === 'provider_error' && /not an HTML document/i.test(err.message),
    );
    assert.equal(calls.length, 1, 'the response was fetched, then refused');
  });

  test('DNS failure is an honest retryable network error (and nothing is requested)', async () => {
    const { fetchImpl, calls } = htmlFetch('<html></html>');
    await assert.rejects(
      discoverFromWebsite('https://nx-domain.pk/', {
        fetchImpl,
        dnsLookup: async () => {
          throw new Error('ENOTFOUND');
        },
      }),
      (err: unknown) => err instanceof AdapterError && err.code === 'network' && err.retryable,
    );
    assert.equal(calls.length, 0, 'no request is sent when DNS cannot vouch for the host');
  });

  test('an injected transport never performs a real DNS lookup (.invalid host succeeds)', async () => {
    // RFC 2606: `.invalid` can NEVER resolve. If a real resolver were
    // consulted, this call would fail with a DNS error instead of succeeding.
    const { fetchImpl } = htmlFetch('<html><head><title>Stub</title></head><body>ok@stub.invalid</body></html>');
    const found = await discoverFromWebsite('https://probe.invalid/', { fetchImpl });
    assert.equal(found.title, 'Stub');
    assert.ok(found.emails.includes('ok@stub.invalid'));
  });

  test('literal private addresses are still refused even with an injected transport (no resolver involved)', async () => {
    const { fetchImpl, calls } = htmlFetch('<html></html>');
    await assert.rejects(
      discoverFromWebsite('http://127.0.0.1/', { fetchImpl }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );
    assert.equal(calls.length, 0);
  });
});

describe('M1: bounded streaming response limit', () => {
  const CAP = 512 * 1024; // must match website.ts MAX_BYTES

  test('an oversized body is cut at the byte cap and the upstream stream is cancelled', async () => {
    const head = '<html><head><title>Big Page</title></head><body>';
    // Word TOKENS rather than one solid 600 K run of word characters: more
    // realistic page text. (The quadratic EMAIL_RE backtracking this fixture
    // used to dodge was fixed in core/contacts.ts — see tests/unit/contacts.test.ts.)
    const filler = 'ipsum dolor sit amet '.repeat(30_000); // pushes the tail beyond the cap
    const tail = 'beyond-cap@evil.pk</body></html>';
    const bytes = new TextEncoder().encode(head + filler + tail);
    assert.ok(bytes.byteLength > CAP, 'fixture really exceeds the cap');

    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // One chunk, stream left OPEN — a real oversized response still has
        // data pending, and an open stream is the only state in which
        // reader.cancel() at the byte cap actually invokes cancel() (a
        // closed stream ignores cancel). No `pull`: the stream simply has
        // nothing more to give until it is cancelled.
        controller.enqueue(bytes);
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetchImpl: FetchLike = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });

    const found = await discoverFromWebsite('https://big-page.pk/', { fetchImpl, dnsLookup: PUBLIC_DNS });

    assert.equal(found.title, 'Big Page', 'content inside the cap is still parsed');
    assert.ok(!found.emails.includes('beyond-cap@evil.pk'), 'content beyond the cap is never buffered or parsed');
    assert.equal(found.emails.length, 0);
    assert.ok(cancelled, 'the upstream stream is cancelled at the cap (reader.cancel)');
  });

  test('a normal-sized body is read completely', async () => {
    const html = '<html><head><title>Small</title></head><body>reach me at info@small.pk</body></html>';
    const { fetchImpl } = htmlFetch(html);
    const found = await discoverFromWebsite('https://small.pk/', { fetchImpl, dnsLookup: PUBLIC_DNS });
    assert.equal(found.title, 'Small');
    assert.deepEqual(found.emails, ['info@small.pk']);
  });

  test('an interrupted response surfaces as a retryable network error — no hang, no unhandled rejection', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><title>Part'));
      },
      pull() {
        throw new Error('socket hang up');
      },
    });
    const fetchImpl: FetchLike = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });

    await assert.rejects(
      discoverFromWebsite('https://dropped.pk/', { fetchImpl, dnsLookup: PUBLIC_DNS }),
      (err: unknown) =>
        err instanceof AdapterError &&
        err.code === 'network' &&
        err.retryable &&
        /socket hang up/.test(err.message),
    );
  });

  test('a stalled body hits the total deadline and releases the stream', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('<html><title>Slow'));
      },
      pull() {
        return new Promise<never>(() => {
          /* never yields another byte */
        });
      },
    });
    const fetchImpl: FetchLike = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/html' } });

    const began = Date.now();
    await assert.rejects(
      discoverFromWebsite('https://slow.pk/', { fetchImpl, dnsLookup: PUBLIC_DNS, timeoutMs: 80 }),
      (err: unknown) => {
        if (!(err instanceof AdapterError) || err.code !== 'network') return false;
        const m = /Timed out after (\d+)ms reading the response body/.exec(err.message);
        if (!m) return false;
        // The body deadline is the REMAINING part of the 80 ms total budget,
        // i.e. 80 ms minus whatever elapsed while setting up the request — so
        // assert the range, not an exact figure (an exact "80ms" is flaky).
        const reported = Number(m[1]);
        return reported >= 1 && reported <= 80;
      },
    );
    const elapsed = Date.now() - began;
    assert.ok(elapsed >= 70 && elapsed < 3_000, `deadline enforced (took ${elapsed}ms)`);
  });
});
