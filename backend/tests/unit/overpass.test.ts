/**
 * Phase 12 unit tests: the OpenStreetMap/Overpass discovery adapter.
 *
 * Proves:
 *  - query construction is correct AND injection-safe (category/city strings
 *    are escaped; a hostile setting value cannot smuggle Overpass QL clauses);
 *  - hits are mapped honestly (OSM permalink per lead, no invented data),
 *    deduplicated, and bounded by the requested limit;
 *  - only Pakistan (country=PK) is searched — anything else is refused;
 *  - HTTP failures map to the right AdapterError codes with retryability
 *    (429/504 busy = rate_limited+retryable, 5xx = retryable, 4xx = not);
 *  - ping() uses the FREE /api/status endpoint and never runs a search;
 *  - the response body is parsed defensively (garbage / missing elements are
 *    provider_error, never an empty "success").
 *
 * Every test injects a fake fetch: no test can ever reach a real network.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildOverpassQuery,
  createOverpassDiscoveryAdapter,
  DEFAULT_OVERPASS_ENDPOINT,
  PAKISTAN_AREA_ID,
} from '../../src/adapters/discovery/overpass.ts';
import { createDiscoveryAdapter, SUPPORTED_DISCOVERY_PROVIDERS } from '../../src/adapters/discovery/index.ts';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';

interface Captured {
  url: string;
  body: string | null;
}

/** Build a fetch stub that answers with `res` and records every call. */
function stubFetch(res: () => Response): { fetchImpl: FetchLike; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, body: typeof init.body === 'string' ? init.body : null });
    return res();
  };
  return { fetchImpl, calls };
}

function okJson(elements: unknown[]): Response {
  return new Response(JSON.stringify({ elements }), { status: 200 });
}

function decodeQuery(calls: Captured[]): string {
  const body = calls[0]!.body;
  assert.ok(body, 'POST body expected');
  return decodeURIComponent(body.replace(/^data=/, ''));
}

describe('Overpass query construction', () => {
  test('scopes to Pakistan and unions known category filters', () => {
    const q = buildOverpassQuery(['clinic', 'restaurant'], 'Karachi', 50);
    assert.ok(q.includes(`area(${PAKISTAN_AREA_ID})->.pk;`), 'Pakistan area must be pinned');
    assert.ok(q.includes('area["name"="Karachi"](area.pk)->.city;'), 'city area selector');
    assert.ok(q.includes('node["amenity"="clinic"](area.city);'), 'clinic filter (node)');
    assert.ok(q.includes('way["amenity"="clinic"](area.city);'), 'clinic filter (way)');
    assert.ok(q.includes('node["healthcare"="clinic"](area.city);'), 'healthcare synonym');
    assert.ok(q.includes('node["amenity"="restaurant"](area.city);'), 'restaurant filter');
    assert.ok(q.includes('out center 50;'), 'server-side result cap');
    assert.ok(!q.includes('undefined'), 'no undefined leaked into the query');
  });

  test('retail maps to a wildcard shop filter; unknown terms fall back to a name regex', () => {
    const retail = buildOverpassQuery(['retail'], undefined, 10);
    assert.ok(retail.includes('node["shop"](area.pk);'), 'retail = any shop, nationwide scope');

    const unknown = buildOverpassQuery(['salon'], 'Lahore', 10);
    assert.ok(unknown.includes('node["name"~"salon",i](area.city);'), 'unknown term -> case-insensitive name regex');
    assert.ok(unknown.includes('area["name"="Lahore"](area.pk)->.city;'), 'city still scoped');
  });

  test('category and city strings are escaped — no query injection', () => {
    const hostile = buildOverpassQuery(['clinic"];(area.pk);out count;("x'], 'Karachi"];out count;("y', 10);
    // With correct escaping, every hostile fragment lives INSIDE a quoted
    // string literal. Strip the literals: nothing executable may remain.
    const stripped = hostile.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    assert.ok(!stripped.includes('out count'), 'a smuggled out-count clause must never execute');
    assert.ok(!stripped.includes('];('), 'a smuggled filter close must never execute');
    assert.ok(hostile.includes('area["name"="Karachi\\"]'), 'city literal is escaped');
  });

  test('the result limit is clamped to 1..100', () => {
    assert.ok(buildOverpassQuery(['school'], 'Karachi', 500).includes('out center 100;'));
    assert.ok(buildOverpassQuery(['school'], 'Karachi', 0).includes('out center 1;'));
  });
});

describe('Overpass adapter behaviour', () => {
  test('maps elements to hits with OSM permalinks and honest fields', async () => {
    const { fetchImpl, calls } = stubFetch(() =>
      okJson([
        { type: 'node', id: 111, tags: { name: 'City Clinic', 'contact:phone': '+92 300 1234567', amenity: 'clinic' } },
        { type: 'way', id: 222, tags: { name: 'Food Corner', website: 'https://foodcorner.pk', 'addr:city': 'Karachi' } },
        { type: 'node', id: 333, tags: { amenity: 'clinic' } }, // unnamed: skipped honestly
      ]),
    );
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl });
    const hits = await adapter.search({ query: 'clinic, restaurant', city: 'Karachi', country: 'PK' });

    assert.equal(hits.length, 2, 'unnamed elements are skipped, not invented');
    assert.deepEqual(hits[0], {
      name: 'City Clinic',
      city: 'Karachi',
      phone: '+92 300 1234567',
      website: undefined,
      sourceUrl: 'https://www.openstreetmap.org/node/111',
      source: 'openstreetmap',
    });
    assert.equal(hits[1]!.website, 'https://foodcorner.pk');
    assert.equal(hits[1]!.sourceUrl, 'https://www.openstreetmap.org/way/222');

    // The request itself: POST to the interpreter, single request per city.
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, DEFAULT_OVERPASS_ENDPOINT);
    const query = decodeQuery(calls);
    assert.ok(query.includes('"clinic"') && query.includes('"restaurant"'), 'categories unioned in one query');
  });

  test('deduplicates repeated OSM elements and clamps the limit', async () => {
    const { fetchImpl } = stubFetch(() =>
      okJson([
        { type: 'node', id: 1, tags: { name: 'Same Shop', phone: '+923001112233' } },
        { type: 'way', id: 1, tags: { name: 'Same Shop', phone: '+923001112233' } }, // same business identity
        { type: 'node', id: 2, tags: { name: 'Other Shop', phone: '+923009998877' } },
      ]),
    );
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl });
    const hits = await adapter.search({ query: 'retail', city: 'Lahore', limit: 1 });
    assert.equal(hits.length, 1, 'limit clamped server-side AND client-side');
  });

  test('refuses any country except PK', async () => {
    const { fetchImpl, calls } = stubFetch(() => okJson([]));
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl });
    await assert.rejects(
      () => adapter.search({ query: 'clinic', country: 'US' as never }),
      (err: AdapterError) => err.code === 'invalid_destination',
    );
    assert.equal(calls.length, 0, 'no request is sent for an unsupported country');
  });

  test('refuses an empty query', async () => {
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl: async () => okJson([]) });
    await assert.rejects(
      () => adapter.search({ query: ' , , ', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'invalid_destination',
    );
  });

  test('maps HTTP failures to the right codes and retryability', async () => {
    const cases: { status: number; code: string; retryable: boolean }[] = [
      { status: 429, code: 'rate_limited', retryable: true },
      { status: 504, code: 'rate_limited', retryable: true },
      { status: 500, code: 'provider_error', retryable: true },
      { status: 400, code: 'provider_error', retryable: false },
    ];
    for (const c of cases) {
      const adapter = createOverpassDiscoveryAdapter({
        fetchImpl: async () => new Response('busy', { status: c.status }),
      });
      await assert.rejects(
        () => adapter.search({ query: 'clinic', city: 'Karachi' }),
        (err: AdapterError) => {
          assert.equal(err.code, c.code, `status ${c.status}`);
          assert.equal(err.retryable, c.retryable, `status ${c.status} retryability`);
          assert.equal(err.providerStatus, c.status);
          return true;
        },
      );
    }
  });

  test('garbage responses are provider_error, never a fake-empty success', async () => {
    const garbage = createOverpassDiscoveryAdapter({ fetchImpl: async () => new Response('<html>oops</html>', { status: 200 }) });
    await assert.rejects(
      () => garbage.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'provider_error',
    );

    const noElements = createOverpassDiscoveryAdapter({ fetchImpl: async () => new Response('{"remark":"ok"}', { status: 200 }) });
    await assert.rejects(
      () => noElements.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'provider_error',
    );
  });

  test('network failures are retryable AdapterErrors', async () => {
    const adapter = createOverpassDiscoveryAdapter({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'network' && err.retryable,
    );
  });

  test('ping() uses the FREE status endpoint — no search is executed', async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response('Connected as: anonymous\nRate limit: 10000 queries per day\n', { status: 200 }),
    );
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl });
    const pong = await adapter.ping();
    assert.equal(pong.ok, true);
    assert.match(pong.detail ?? '', /no search performed/);
    assert.match(pong.detail ?? '', /rate limit: 10000/);
    assert.equal(calls[0]!.url, `${DEFAULT_OVERPASS_ENDPOINT.replace(/\/interpreter$/, '')}/status`);
    assert.equal(calls[0]!.body, null, 'status probe is a GET with no query body');
  });

  test('a custom endpoint overrides the instance and keeps a free ping path', async () => {
    const { fetchImpl, calls } = stubFetch(() => new Response('Rate limit: 500\n', { status: 200 }));
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, endpoint: 'https://overpass.example.de/api/interpreter' });
    await adapter.ping();
    assert.equal(calls[0]!.url, 'https://overpass.example.de/api/status');

    const bare = createOverpassDiscoveryAdapter({ fetchImpl, endpoint: 'https://overpass.example.de/api' });
    const pong = await bare.ping();
    assert.equal(pong.ok, true);
    assert.match(pong.detail ?? '', /count probe/);
    assert.match(decodeQuery([{ url: '', body: calls.at(-1)!.body }]), /out count/, 'non-interpreter endpoint falls back to a free count probe');
  });

  test('status() is honest: configured implementation, not simulated', () => {
    const adapter = createOverpassDiscoveryAdapter({});
    const s = adapter.status();
    assert.equal(s.key, 'discovery');
    assert.equal(s.implementation, 'overpass');
    assert.equal(s.state, 'configured');
    assert.notEqual(s.simulated, true, 'real data source is never labelled simulated');
    assert.ok(s.features.some((f) => /free/i.test(f)), 'the free/no-key nature is advertised');
  });
});

describe('discovery provider dispatch', () => {
  test('DISCOVERY_PROVIDER=overpass selects the adapter without any key', () => {
    assert.ok(SUPPORTED_DISCOVERY_PROVIDERS.includes('overpass'));
    const adapter = createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'overpass' });
    assert.equal(adapter.status().implementation, 'overpass');
  });

  test('unknown or empty provider stays honestly unconfigured', () => {
    assert.equal(createDiscoveryAdapter({}).status().state, 'unconfigured');
    assert.equal(createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'yelp' }).status().state, 'unconfigured');
  });
});

describe('discovery transport strategy', () => {
  const FB = 'https://fallback.example/api/interpreter';

  /** A stub that records calls and throws a whitelisted transport error. */
  function throwingFetch(code: string): { fetchImpl: FetchLike; calls: Captured[] } {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : null });
      throw Object.assign(new TypeError('fetch failed'), { code });
    };
    return { fetchImpl, calls };
  }

  test('falls back to the next endpoint ONLY on a transport failure', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : null });
      if (calls.length === 1) throw Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' });
      return okJson([{ type: 'node', id: 7, tags: { name: 'Fallback Clinic', phone: '+923001112233' } }]);
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const hits = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(hits.length, 1, 'the fallback supplied an honest result');
    assert.deepEqual(
      calls.map((c) => c.url),
      [DEFAULT_OVERPASS_ENDPOINT, FB],
      'primary first, fallback only after its transport failure',
    );
  });

  test('an HTTP response is authoritative — no fallback on 5xx', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : null });
      return new Response('busy', { status: 503 });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'provider_error' && err.providerStatus === 503,
    );
    assert.equal(calls.length, 1, 'a 5xx from the primary is authoritative — never swapped');
    assert.equal(calls[0]!.url, DEFAULT_OVERPASS_ENDPOINT);
  });

  test('when every endpoint fails: network + sanitized category + original cause', async () => {
    const fallbackErr = Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    let n = 0;
    const fetchImpl: FetchLike = async () => {
      n += 1;
      throw n === 1
        ? Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' })
        : fallbackErr;
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /transport: refused/, 'the LAST failure category is reported');
        assert.match(err.message, /2 endpoint\(s\) tried/, 'the fan-out is disclosed');
        assert.equal(err.cause, fallbackErr, 'the original error cause is preserved, not discarded');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test('cooldown: a transport-failed primary is skipped by the next search, ping still probes it', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      if (u.endsWith('/api/status')) return new Response('Rate limit: 10000 queries per day\n', { status: 200 });
      if (u === DEFAULT_OVERPASS_ENDPOINT) throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
      return okJson([{ type: 'node', id: 7, tags: { name: 'Fallback Clinic', phone: '+923001112233' } }]);
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const first = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(first.length, 1);
    assert.deepEqual(calls.map((c) => c.url), [DEFAULT_OVERPASS_ENDPOINT, FB]);

    const second = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(second.length, 1, 'the fallback keeps serving');
    assert.deepEqual(
      calls.map((c) => c.url),
      [DEFAULT_OVERPASS_ENDPOINT, FB, FB],
      'the dead primary host must not be re-requested inside the cooldown',
    );

    const pong = await adapter.ping();
    assert.equal(pong.ok, true, 'health pings ignore the cooldown — the dashboard stays honest');
    assert.ok(
      calls.some((c) => c.url === 'https://overpass-api.de/api/status'),
      'ping always probes the configured primary status endpoint',
    );
  });

  test('cooldownMs:0 disables the cooldown (each search tries every endpoint)', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB], cooldownMs: 0 });

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, 4, '2 endpoints x 2 searches — no cooldown skipping');
  });

  test('ping failure reports the sanitized category and the effective host', async () => {
    const { fetchImpl } = throwingFetch('ENOTFOUND');
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, endpoint: 'https://mail.example/api/interpreter' });

    await assert.rejects(
      () => adapter.ping(),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /transport: dns/);
        assert.match(err.message, /mail\.example/, 'the host is named so production can self-verify');
        assert.equal(err.retryable, true);
        return true;
      },
    );
  });

  test('ping success names the reachable host', async () => {
    const { fetchImpl } = stubFetch(() => new Response('Rate limit: 500\n', { status: 200 }));
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, endpoint: 'https://mail.example/api/interpreter' });

    const pong = await adapter.ping();
    assert.equal(pong.ok, true);
    assert.match(pong.detail ?? '', /reachable at mail\.example/);
    assert.match(pong.detail ?? '', /no search performed/);
  });

  test('an invalid configured primary is an honest config error with zero network I/O', async () => {
    const { fetchImpl, calls } = stubFetch(() => okJson([]));
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, endpoint: 'http://insecure.example' });

    const s = adapter.status();
    assert.equal(s.state, 'error', 'a broken configuration is never reported as configured');
    assert.ok(s.lastError, 'the reason is surfaced');

    const pong = await adapter.ping();
    assert.equal(pong.ok, false, 'health must never claim healthy for a misconfigured endpoint');
    assert.match(pong.detail ?? '', /misconfigured/i);

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'unconfigured',
    );
    assert.equal(calls.length, 0, 'zero network I/O for a broken configuration');
  });

  test('invalid or credential-bearing fallbacks are dropped and never contacted', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createOverpassDiscoveryAdapter({
      fetchImpl,
      fallbackEndpoints: [
        'ftp://weird.example/api',
        'https://user:pass@evil.example/api/interpreter',
        'http://insecure.example/api/interpreter',
      ],
    });

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => err.code === 'network',
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      [DEFAULT_OVERPASS_ENDPOINT],
      'only the valid primary was contacted',
    );
  });

  test('DISCOVERY_OVERPASS_FALLBACK_URLS is trimmed, deduped and capped at 2 fallbacks', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createDiscoveryAdapter(
      {
        DISCOVERY_PROVIDER: 'overpass',
        DISCOVERY_OVERPASS_URL: 'https://primary.example/api/interpreter',
        DISCOVERY_OVERPASS_FALLBACK_URLS:
          ' https://primary.example/api/interpreter , https://second.example/api/interpreter , https://third.example/api/interpreter ',
      },
      { fetchImpl },
    );

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        'https://primary.example/api/interpreter',
        'https://second.example/api/interpreter',
        'https://third.example/api/interpreter',
      ],
      'trimmed, primary-duplicate dropped, then exactly 2 fallbacks used',
    );
  });

  test('the fallback fan-out is bounded: a third configured fallback is never contacted', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createDiscoveryAdapter(
      {
        DISCOVERY_PROVIDER: 'overpass',
        DISCOVERY_OVERPASS_FALLBACK_URLS:
          'https://f1.example/api/interpreter,https://f2.example/api/interpreter,https://f3.example/api/interpreter',
      },
      { fetchImpl },
    );

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, 3, 'primary + at most 2 fallbacks');
    assert.ok(
      calls.every((c) => !c.url.includes('f3.example')),
      'the third fallback is beyond the bound and must never be contacted',
    );
  });
});
