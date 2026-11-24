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
 *    (429 = rate_limited+retryable, other 5xx = retryable, 4xx = not), and a
 *    gateway failure (502/503/504) FAILS OVER to the next configured endpoint
 *    instead of being reported as rate limiting;
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
  DEFAULT_FALLBACK_ENDPOINTS,
  DEFAULT_OVERPASS_ENDPOINT,
  MAX_ENDPOINTS,
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
    // City areas are named in the LOCAL script in OSM (Karachi = "ضلع کراچی"),
    // so the selector must union the exact local name with an English-name
    // prefix — an exact `name` match alone resolves to 0 areas (verified live).
    assert.ok(q.includes('area["name"="Karachi"](area.pk);'), 'exact local-name city selector');
    assert.ok(
      q.includes('area["name:en"~"^Karachi",i](area.pk);'),
      'English-name prefix selector (name is Urdu in OSM)',
    );
    assert.ok(q.includes(')->.city;'), 'both selectors union into .city');
    assert.ok(q.indexOf('area["name"="Karachi"](area.pk);') < q.indexOf(')->.city;'), 'union closes after both');
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
    assert.ok(unknown.includes('area["name"="Lahore"](area.pk);'), 'exact local-name city still scoped');
    assert.ok(
      unknown.includes('area["name:en"~"^Lahore",i](area.pk);'),
      'English-name fallback keeps the city scope when the local name differs',
    );
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

  test('a whitespace-only city behaves like no city — never an empty selector', () => {
    // An empty exact match would silently select nothing; an empty regex `^`
    // would match every area in Pakistan. Both are wrong: normalize to
    // nationwide scope instead.
    const blank = buildOverpassQuery(['clinic'], '   ', 10);
    const none = buildOverpassQuery(['clinic'], undefined, 10);
    assert.equal(blank, none, 'blank city must produce the exact nationwide query');
    assert.ok(blank.includes('node["amenity"="clinic"](area.pk);'), 'scope is Pakistan-wide');
    assert.ok(!blank.includes('->.city'), 'no city set is built at all');

    // A city with real content still gets both selectors.
    const real = buildOverpassQuery(['clinic'], '  Karachi  ', 10);
    assert.ok(real.includes('area["name"="Karachi"](area.pk);'), 'city is trimmed before use');
    assert.ok(real.includes('area.city'), 'scope is the city set');
  });

  test('the result limit is clamped to 1..100', () => {
    assert.ok(buildOverpassQuery(['school'], 'Karachi', 500).includes('out center 100;'));
    assert.ok(buildOverpassQuery(['school'], 'Karachi', 0).includes('out center 1;'));
  });

  test('city scope survives a local-script OSM name — exact `name` alone resolves to 0 areas', async () => {
    // PRODUCTION BUG GUARD: in OSM, Pakistan's city areas are named in Urdu
    // (Karachi = "ضلع کراچی", Lahore = "لاہور"). A query scoped only by
    // area["name"="Karachi"] therefore selected ZERO areas and every city
    // returned an honest-but-empty result: discovery "worked" and produced
    // no leads at all. Verified live against the public Overpass API:
    //   exact `name` selector -> total 0 (Karachi AND Lahore)
    //   union with `name:en` prefix -> total 9 (both cities)
    const q = buildOverpassQuery(['restaurant'], 'Karachi', 5);
    assert.ok(q.includes('area["name"="Karachi"](area.pk);'), 'exact local name kept for English-named cities');
    assert.ok(
      q.includes('area["name:en"~"^Karachi",i](area.pk);'),
      'English-name prefix selector added — this is what matches "Karachi District"',
    );
    assert.ok(q.includes(')->.city;'), 'both selectors feed the same .city set');

    // A city whose local name differs entirely from its English name must be
    // handled the same way (Lahore: "لاہور" in OSM).
    const lahore = buildOverpassQuery(['clinic'], 'Lahore', 5);
    assert.ok(lahore.includes('area["name:en"~"^Lahore",i](area.pk);'), 'English-name fallback present for Lahore');

    // The regex is anchored, so a city name cannot accidentally match every
    // area, and it stays inside Pakistan via (area.pk).
    assert.ok(q.includes('area["name:en"~"^Karachi",i](area.pk);'), 'anchored AND constrained to Pakistan');
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
    // Only statuses that are a genuine ANSWER from a working endpoint reach
    // the status mapper. Gateway failures (502/503/504) are intercepted by the
    // endpoint walk and fail over instead — see the transport strategy tests —
    // so 504 is deliberately absent here and is never rate limiting.
    const cases: { status: number; code: string; retryable: boolean }[] = [
      { status: 429, code: 'rate_limited', retryable: true },
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

  test('HTTP 504 is never reported as rate limiting', async () => {
    const adapter = createOverpassDiscoveryAdapter({
      fetchImpl: async () => new Response('gateway timeout', { status: 504 }),
    });
    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => {
        assert.notEqual(err.code, 'rate_limited', 'a gateway timeout is not proof of rate limiting');
        assert.match(err.message, /HTTP 504/, 'the real status is disclosed');
        assert.ok(!/busy|try again shortly/i.test(err.message), 'the "busy — try again shortly" wording is gone');
        return true;
      },
    );
    await assert.rejects(
      () => adapter.ping(),
      (err: AdapterError) => {
        assert.equal(err.code, 'network', 'a gateway timeout is an endpoint failure, not rate limiting');
        assert.match(err.message, /overpass-api\.de \(HTTP 504\)/, 'host + real status disclosed');
        return true;
      },
    );
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

  test('status() is honest: configured implementation, not simulated', async () => {
    const adapter = createOverpassDiscoveryAdapter({});
    const s = await adapter.status();
    assert.equal(s.key, 'discovery');
    assert.equal(s.implementation, 'overpass');
    assert.equal(s.state, 'configured');
    assert.notEqual(s.simulated, true, 'real data source is never labelled simulated');
    assert.ok(s.features.some((f) => /free/i.test(f)), 'the free/no-key nature is advertised');
  });

  test('status() and ping() disclose the endpoint pool as HOSTNAMES only — never a full URL', async () => {
    const adapter = createOverpassDiscoveryAdapter({
      endpoint: 'https://primary.example/api/interpreter?token=SECRETQUERY',
      fallbackEndpoints: ['https://second.example/api/interpreter?sig=ALSOSSECRET'],
    });

    const s = await adapter.status();
    const pool = s.features.find((f) => f.startsWith('endpoint pool:'));
    assert.ok(pool, 'the effective configured pool is exposed as non-secret config status');
    assert.match(pool!, /endpoint pool: 2 configured \(primary\.example, second\.example\)/, 'count + distinct hosts');
    assert.ok(!pool!.includes('https://'), 'no scheme / full URL is exposed');
    assert.ok(!pool!.includes('/api/interpreter'), 'no path is exposed');
    assert.ok(!pool!.includes('SECRETQUERY') && !pool!.includes('ALSOSSECRET'), 'no query parameter is exposed');

    const { fetchImpl } = stubFetch(() => new Response('Rate limit: 500\n', { status: 200 }));
    const pong = await createOverpassDiscoveryAdapter({
      fetchImpl,
      endpoint: 'https://primary.example/api/interpreter',
      fallbackEndpoints: ['https://second.example/api/interpreter'],
    }).ping();
    assert.match(pong.detail ?? '', /endpoint pool: 2 configured/, 'the dashboard health cell shows the pool too');
  });
});

describe('discovery provider dispatch', () => {
  test('DISCOVERY_PROVIDER=overpass selects the adapter without any key', async () => {
    assert.ok(SUPPORTED_DISCOVERY_PROVIDERS.includes('overpass'));
    const adapter = createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'overpass' });
    assert.equal((await adapter.status()).implementation, 'overpass');
  });

  test('unknown or empty provider stays honestly unconfigured', async () => {
    assert.equal((await createDiscoveryAdapter({}).status()).state, 'unconfigured');
    assert.equal((await createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'yelp' }).status()).state, 'unconfigured');
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

  test('an authoritative HTTP answer is never swapped — no fallback on 400/429/500', async () => {
    // These statuses come from a WORKING endpoint: it answered. Swapping to a
    // second host would repeat a genuinely bad request and would dodge a real
    // rate limit, so the walk must stop at the primary.
    for (const status of [400, 429, 500]) {
      const calls: Captured[] = [];
      const fetchImpl: FetchLike = async (url, init) => {
        calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : null });
        return new Response('answer', { status });
      };
      const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

      await assert.rejects(
        () => adapter.search({ query: 'clinic', city: 'Karachi' }),
        (err: AdapterError) => err.providerStatus === status,
      );
      assert.equal(calls.length, 1, `HTTP ${status} is an answer — never swapped for another host`);
      assert.equal(calls[0]!.url, DEFAULT_OVERPASS_ENDPOINT);
    }
  });

  test('search: HTTP 504 fails that endpoint and the configured fallback answers', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      if (u === DEFAULT_OVERPASS_ENDPOINT) return new Response('gateway timeout', { status: 504 });
      return okJson([{ type: 'node', id: 7, tags: { name: 'Fallback Clinic', phone: '+923001112233' } }]);
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const hits = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(hits.length, 1, 'the fallback supplied an honest result');
    assert.deepEqual(
      calls.map((c) => c.url),
      [DEFAULT_OVERPASS_ENDPOINT, FB],
      'the 504 primary fails over to the configured fallback',
    );
  });

  test('search: a 504 primary and a healthy fallback still deduplicate — no duplicate leads', async () => {
    const fetchImpl: FetchLike = async (url) => {
      if (String(url) === DEFAULT_OVERPASS_ENDPOINT) return new Response('gateway timeout', { status: 504 });
      return okJson([
        { type: 'node', id: 1, tags: { name: 'Same Shop', phone: '+923001112233' } },
        { type: 'way', id: 1, tags: { name: 'Same Shop', phone: '+923001112233' } }, // same business identity
        { type: 'node', id: 2, tags: { name: 'Other Shop', phone: '+923009998877' } },
      ]);
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const hits = await adapter.search({ query: 'retail', city: 'Lahore' });
    assert.equal(hits.length, 2, 'failover leaves the duplicate-prevention path untouched');
    assert.equal(new Set(hits.map((h) => h.sourceUrl)).size, 2, 'one lead per distinct OSM element');
  });

  test('search: every endpoint answering 504 is disclosed — count, host and HTTP category', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url), body: typeof init.body === 'string' ? init.body : null });
      return new Response('gateway timeout', { status: 504 });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /2 endpoint\(s\) tried/, 'the attempted count is disclosed');
        assert.match(err.message, /overpass-api\.de \(HTTP 504\)/, 'first attempt: host + category');
        assert.match(err.message, /fallback\.example \(HTTP 504\)/, 'second attempt: host + category');
        assert.ok(!/busy|try again shortly/i.test(err.message), '504 is never sold as rate limiting');
        return true;
      },
    );
    assert.equal(calls.length, 2, 'exactly one request per configured endpoint — no retry loop');
  });

  test('search: a mixed HTTP + transport failure still discloses every attempt', async () => {
    // The primary answers 502 (capacity) on every BOUNDED attempt: the
    // provider's own response body asks callers to retry with exponential
    // backoff, so those retries stay on the same host. Only once the bound is
    // exhausted does the walk reach the fallback, which fails at transport
    // level. The final error still names both hosts and both categories.
    let n = 0;
    const delays: number[] = [];
    const fetchImpl: FetchLike = async () => {
      n += 1;
      if (n <= 3) return new Response('bad gateway', { status: 502 });
      throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
    };
    const adapter = createOverpassDiscoveryAdapter({
      fetchImpl,
      fallbackEndpoints: [FB],
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    });

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /2 endpoint\(s\) tried/);
        assert.match(err.message, /overpass-api\.de \(HTTP 502\)/, 'HTTP category kept');
        assert.match(err.message, /fallback\.example \(transport: refused\)/, 'transport category kept');
        assert.ok(err.cause, 'the original transport cause is preserved, not discarded');
        assert.equal(err.retryable, true);
        return true;
      },
    );
    assert.deepEqual(delays, [500, 1000], 'the backoff doubles between the bounded retries');
    assert.equal(n, 4, '3 bounded attempts on the primary, then exactly one on the fallback');
  });

  test('a capacity 502 is retried in place, then the healthy fallback answers — no host skipped', async () => {
    const calls: Captured[] = [];
    const delays: number[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      if (u === DEFAULT_OVERPASS_ENDPOINT) return new Response('at capacity', { status: 502 });
      return okJson([{ type: 'node', id: 7, tags: { name: 'Fallback Clinic', phone: '+923001112233' } }]);
    };
    const adapter = createOverpassDiscoveryAdapter({
      fetchImpl,
      fallbackEndpoints: [FB],
      sleepImpl: async (ms) => {
        delays.push(ms);
      },
    });

    const hits = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(hits.length, 1, 'the fallback supplied an honest result after the capacity retries');
    assert.deepEqual(
      calls.map((c) => c.url),
      [DEFAULT_OVERPASS_ENDPOINT, DEFAULT_OVERPASS_ENDPOINT, DEFAULT_OVERPASS_ENDPOINT, FB],
      'every retry stays on the failing host before the walk moves on',
    );
    assert.deepEqual(delays, [500, 1000], 'bounded exponential backoff — not a tight retry loop');
  });

  test('a 504 and a transport timeout are never retried in place — each host is asked once', async () => {
    // Retrying either would repeat a wait that has ALREADY been paid (the
    // upstream deadline / our own timeout), which is exactly how a single
    // dead endpoint turns into a request storm.
    const cases: { name: string; run: (url: string) => Promise<Response> }[] = [
      {
        name: '504',
        run: async () => new Response('gateway timeout', { status: 504 }),
      },
      {
        name: 'transport timeout',
        run: async () => {
          throw Object.assign(new TypeError('fetch failed'), { code: 'ETIMEDOUT' });
        },
      },
    ];
    for (const c of cases) {
      const calls: string[] = [];
      const delays: number[] = [];
      const fetchImpl: FetchLike = async (url) => {
        calls.push(String(url));
        return c.run(String(url));
      };
      const adapter = createOverpassDiscoveryAdapter({
        fetchImpl,
        fallbackEndpoints: [FB],
        sleepImpl: async (ms) => {
          delays.push(ms);
        },
      });

      await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
      assert.deepEqual(
        calls,
        [DEFAULT_OVERPASS_ENDPOINT, FB],
        `${c.name}: exactly one request per endpoint — no in-place retry, no storm`,
      );
      assert.deepEqual(delays, [], `${c.name}: nothing to back off from — the host is abandoned instead`);
    }
  });

  test('ping: HTTP 504 is not authoritative — the fallback is probed and health stays green', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      calls.push({ url: u, body: null });
      if (u.startsWith('https://overpass-api.de')) return new Response('gateway timeout', { status: 504 });
      return new Response('Rate limit: 500\n', { status: 200 });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const pong = await adapter.ping();
    assert.equal(pong.ok, true, 'health is green because a CONFIGURED endpoint answers');
    assert.match(pong.detail ?? '', /reachable at fallback\.example/);
    assert.match(pong.detail ?? '', /no search performed/);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://overpass-api.de/api/status', 'https://fallback.example/api/status'],
      'primary first, then the fallback — the 504 did not stop the walk',
    );
    assert.ok(calls.every((c) => c.body === null), 'both probes stay read-only status GETs');
  });

  test('ping: mixed HTTP + transport failures disclose both attempts', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url) => {
      const u = String(url);
      calls.push({ url: u, body: null });
      if (u.startsWith('https://overpass-api.de')) return new Response('bad gateway', { status: 502 });
      throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNRESET' });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    await assert.rejects(
      () => adapter.ping(),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /2 endpoint\(s\) tried/);
        assert.match(err.message, /overpass-api\.de \(HTTP 502\)/);
        assert.match(err.message, /fallback\.example \(transport: reset\)/);
        assert.ok(err.cause, 'the original transport cause is preserved');
        return true;
      },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://overpass-api.de/api/status', 'https://fallback.example/api/status'],
      'each configured endpoint is probed exactly once',
    );
  });

  test('cooldown: a 504 primary is marked DOWN, skipped by the next search, ping still probes it', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      if (u === DEFAULT_OVERPASS_ENDPOINT) return new Response('gateway timeout', { status: 504 });
      if (u.endsWith('/api/status')) return new Response('Rate limit: 10000 queries per day\n', { status: 200 });
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
      'the 504 host is NOT healthy: it must not be re-requested inside the cooldown',
    );

    const pong = await adapter.ping();
    assert.equal(pong.ok, true, 'health pings ignore the cooldown — the dashboard stays honest');
    assert.ok(
      calls.some((c) => c.url === 'https://overpass-api.de/api/status'),
      'ping always probes the configured primary status endpoint',
    );
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

    const s = await adapter.status();
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

  // --------------------------------------------------------- ping() pool ---

  test('ping: primary success stops the walk — the fallback is never contacted', async () => {
    const { fetchImpl, calls } = stubFetch(
      () => new Response('Rate limit: 10000 queries per day\n', { status: 200 }),
    );
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const pong = await adapter.ping();
    assert.equal(pong.ok, true);
    assert.match(pong.detail ?? '', /reachable at overpass-api\.de/);
    assert.match(pong.detail ?? '', /no search performed/);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://overpass-api.de/api/status'],
      'only the primary status probe runs when the primary answers',
    );
    assert.ok(calls.every((c) => c.body === null), 'the health probe is a body-less GET');
  });

  test('ping: a transport failure of the primary falls back to the configured fallback', async () => {
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      if (u.startsWith('https://overpass-api.de')) {
        throw Object.assign(new TypeError('fetch failed'), { code: 'ENOTFOUND' });
      }
      return new Response('Rate limit: 500\n', { status: 200 });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const pong = await adapter.ping();
    assert.equal(pong.ok, true, 'health is green because a CONFIGURED endpoint answers');
    assert.match(pong.detail ?? '', /reachable at fallback\.example/);
    assert.match(pong.detail ?? '', /no search performed/);
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://overpass-api.de/api/status', 'https://fallback.example/api/status'],
      'primary first, fallback only after the primary transport failure',
    );
    assert.ok(calls.every((c) => c.body === null), 'both probes are body-less GETs');
  });

  test('ping: when every configured endpoint fails, the error names each attempt and its category', async () => {
    const codes: Record<string, string> = {
      'https://overpass-api.de/api/status': 'ENOTFOUND',
      'https://fallback.example/api/status': 'ECONNREFUSED',
    };
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      throw Object.assign(new TypeError('fetch failed'), { code: codes[u] ?? 'ECONNREFUSED' });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    await assert.rejects(
      () => adapter.ping(),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /2 endpoint\(s\) tried/, 'the fan-out is disclosed');
        assert.match(err.message, /overpass-api\.de \(transport: dns\)/, 'each attempt carries its host + category');
        assert.match(err.message, /fallback\.example \(transport: refused\)/);
        assert.equal(err.retryable, true);
        assert.ok(err.cause, 'the original failure cause is preserved, not discarded');
        return true;
      },
    );
    assert.deepEqual(
      calls.map((c) => c.url),
      ['https://overpass-api.de/api/status', 'https://fallback.example/api/status'],
      'every configured endpoint was probed exactly once, in order',
    );
    assert.ok(calls.every((c) => c.body === null), 'failed probes were still body-less GETs');
  });

  test('ping: only configured endpoints are contacted — a capped-out fallback never is', async () => {
    const { fetchImpl, calls } = throwingFetch('ENOTFOUND');
    const adapter = createDiscoveryAdapter(
      {
        DISCOVERY_PROVIDER: 'overpass',
        DISCOVERY_OVERPASS_FALLBACK_URLS:
          'https://f1.example/api/interpreter,https://f2.example/api/interpreter,https://f3.example/api/interpreter',
      },
      { fetchImpl },
    );

    await assert.rejects(() => adapter.ping!());
    assert.deepEqual(
      calls.map((c) => c.url),
      [
        'https://overpass-api.de/api/status',
        'https://f1.example/api/status',
        'https://f2.example/api/status',
      ],
      'primary + at most 2 configured fallbacks, each via its free status path',
    );
    assert.ok(
      calls.every((c) => !c.url.includes('f3.example')),
      'the third fallback is beyond the bound and must never be contacted',
    );
    assert.ok(
      calls.every((c) => c.url.endsWith('/status')),
      'health probes are read-only status GETs — never the interpreter',
    );
  });
});

/** Small async delay for cooldown-window tests (real timers, generous margins). */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('Overpass outage behaviour (production incident guards)', () => {
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

  test('built-in fallback pool: a pool of one is never shipped — defaults are validated https mirrors', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    // No endpoint and no fallbackEndpoints given: the adapter must still run
    // with more than one candidate, because "one endpoint + cooldown" is what
    // turned a single transport failure into "every city failed".
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl });

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, MAX_ENDPOINTS, 'primary + built-in mirrors, bounded by MAX_ENDPOINTS');
    assert.equal(calls[0]!.url, DEFAULT_OVERPASS_ENDPOINT, 'the configured primary always goes first');
    for (const fb of DEFAULT_FALLBACK_ENDPOINTS) {
      assert.ok(calls.some((c) => c.url === fb), `built-in mirror ${fb} must be part of the pool`);
      assert.ok(fb.startsWith('https://'), 'built-in mirrors are https only');
      assert.ok(!fb.includes('@'), 'no credentials can be embedded in a built-in mirror');
    }

    const s = await adapter.status();
    assert.ok(
      s.features.some((f) => f.includes(`endpoint pool: ${MAX_ENDPOINTS} configured`)),
      'the dashboard sees the real pool size without reading any env file',
    );
  });

  test('an owner-configured fallback list replaces the built-in mirrors entirely', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.deepEqual(
      calls.map((c) => c.url),
      [DEFAULT_OVERPASS_ENDPOINT, FB],
      'exactly the configured pair — no built-in mirror is contacted',
    );
  });

  test('no request storm: after the pool fails once, further searches make ZERO network calls', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    for (let i = 0; i < 5; i += 1) {
      await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    }
    assert.equal(
      calls.length,
      2,
      'exactly one attempt per endpoint on the first search; the next four fail fast with no I/O',
    );
  });

  test('fail-fast diagnostics name the host, pool size and cooldown — and leak no secrets', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB], cooldownMs: 60_000 });

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    const before = calls.length;

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /transport: refused/, 'the sanitized failure category stays visible');
        assert.match(err.message, /pool of 2/, 'the pool size is disclosed');
        assert.match(err.message, /overpass-api\.de/, 'the failing endpoint host is named');
        assert.match(err.message, /fallback\.example/, 'every cooling host is named, not just the first');
        assert.match(err.message, /retry in \d+s/, 'the operator can see how long until recovery');
        assert.equal(err.retryable, true);
        // Nothing beyond hostnames may appear: no query body, no URL path,
        // no userinfo, no percent-encoded payload.
        assert.ok(!err.message.includes('data='), 'no query body leaks into diagnostics');
        assert.ok(!err.message.includes('/api/interpreter'), 'no endpoint path leaks');
        assert.ok(!/https?:\/\/\S+@\S+/.test(err.message), 'no credentialed URL leaks');
        assert.ok(!/%[0-9A-Fa-f]{2}/.test(err.message), 'no percent-encoded payload leaks');
        return true;
      },
    );
    assert.equal(calls.length, before, 'the diagnostic itself costs zero extra requests');
  });

  test('cooldown recovery: once the window passes, the endpoint is retried and can serve again', async () => {
    let primaryUp = false;
    const calls: Captured[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      const u = String(url);
      calls.push({ url: u, body: typeof init.body === 'string' ? init.body : null });
      if (u === DEFAULT_OVERPASS_ENDPOINT && !primaryUp) {
        throw Object.assign(new TypeError('fetch failed'), { code: 'ECONNREFUSED' });
      }
      if (u.endsWith('/api/status')) return new Response('Rate limit: 500\n', { status: 200 });
      return okJson([{ type: 'node', id: 42, tags: { name: 'Recovered Clinic', phone: '+923001112233' } }]);
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB], cooldownMs: 120 });

    const first = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(first.length, 1, 'the fallback carries the search while the primary is down');

    primaryUp = true;
    await sleep(200); // past the 120ms cooldown (and its first backoff step)
    const second = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.equal(second.length, 1, 'discovery recovers on its own — no restart needed');
    assert.ok(
      calls.some((c) => c.url === DEFAULT_OVERPASS_ENDPOINT),
      'the previously failed primary is retried after the cooldown instead of staying dead forever',
    );
  });

  test('repeated failures back off exponentially (1x → 2x, capped) rather than hammering a dead host', async () => {
    const { fetchImpl, calls } = throwingFetch('ECONNREFUSED');
    // An invalid fallback is dropped, leaving a pool of one so the backoff of
    // that single host is directly observable.
    const adapter = createOverpassDiscoveryAdapter({
      fetchImpl,
      fallbackEndpoints: ['ftp://dropped.example/api'],
      cooldownMs: 300,
    });

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, 1, 'first failure: one attempt');

    await sleep(360); // past the 1x window (300ms)
    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, 2, 'the host is retried only after its window closes');

    await sleep(360); // 360ms into the 2x window (600ms) — still cooling
    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, 2, 'second failure doubles the wait: no re-request inside it');

    await sleep(320); // now past 600ms
    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));
    assert.equal(calls.length, 3, 'after the backed-off window the endpoint is tried again');
  });

  test('status() stops claiming Ready while the whole pool is cooling down', async () => {
    const { fetchImpl } = throwingFetch('ECONNREFUSED');
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB], cooldownMs: 60_000 });

    const before = await adapter.status();
    assert.equal(before.state, 'configured', 'healthy pool before any failure');

    await assert.rejects(() => adapter.search({ query: 'clinic', city: 'Karachi' }));

    const after = await adapter.status();
    assert.equal(after.state, 'error', 'a pool-wide outage is a runtime error, not "configured/Ready"');
    assert.match(after.lastError ?? '', /cooling down/i, 'the reason is surfaced to the dashboard');
    assert.match(after.lastError ?? '', /overpass-api\.de/, 'the named host(s) appear in lastError');
    assert.match(after.lastError ?? '', /~60s|59s/, 'the remaining wait is disclosed');
    assert.ok(
      after.features.some((f) => f.includes('2/2 endpoints cooling')),
      'the feature list states the pool-wide cooldown explicitly',
    );

    // A ping still probes (health stays honest) and, because the pool really
    // is down, must not claim healthy: it reports the failure, never green.
    await assert.rejects(
      () => adapter.ping(),
      (err: AdapterError) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /overpass-api\.de/, 'the failed probe names the host');
        return true;
      },
    );
  });

  test('a healthy pool keeps reporting configured — the degraded state only trips on real cooldown', async () => {
    const { fetchImpl } = stubFetch(() => new Response('Rate limit: 500\n', { status: 200 }));
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl, fallbackEndpoints: [FB] });

    const s = await adapter.status();
    assert.equal(s.state, 'configured');
    assert.equal(s.lastError ?? null, null, 'no phantom error on a healthy pool');
  });
});
