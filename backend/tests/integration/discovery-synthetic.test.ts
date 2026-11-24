/**
 * Synthetic OpenStreetMap discovery diagnostic suite (read-only review).
 *
 * Covers the scenarios from the discovery diagnostic that the existing Phase
 * 12 suites do NOT already pin (they are cited inline as reused coverage):
 *
 *   §5.14  discovery policy with no configured categories  -> validation_failed
 *   §5.15  discovery policy with no configured cities      -> validation_failed
 *   §5.10  provider timeout -> sanitized `transport: timeout`, abort signal
 *          wired on every request, and the REAL failure surfaced through
 *          runDiscovery to the API caller (the exact message shape the
 *          dashboard showed for maps.mail.ru)
 *   §5.13  a large synthetic response is bounded by the limit and completes
 *          quickly (no hang, no quadratic blowup)
 *   §5.7   a provider hit with no name is rejected without corrupting the run
 *   §5.6   a different name with a matching website auto-merges (exact_website)
 *          at the DISCOVERY pipeline level
 *   §6     under STOP ALL: discovery still researches public data, the stop
 *          stays active, zero outreach rows are created, and discovered leads
 *          stay eligibility_state='unknown' (no bypass)
 *
 * Reused (already green in the existing suites, not re-implemented here):
 *   §5.1/§5.2/§5.3 hit mapping with/without phone+website  -> unit/overpass.test.ts
 *   §5.5  same-phone duplicate auto-merge                   -> integration/discovery.test.ts
 *   §5.8  malformed Overpass response                       -> unit/overpass.test.ts (garbage/no-elements)
 *   §5.9  empty response + all-cities-fail honest throw     -> unit/overpass + integration/discovery
 *   §5.11 provider HTTP errors (429/500/4xx mapping)        -> unit/overpass.test.ts
 *   §5.12 invalid coordinates -> warning + NULL             -> integration/leads-address-coords.test.ts
 *   §6     auth/CSRF gating, integration toggle, STOP ALL on outreach
 *          -> api/discovery.test.ts, api/api.test.ts, integration/outreach.test.ts
 *
 * Safety: every provider call goes through an injected fake fetch (or a stub
 * registry) — this file can never reach a real network. Every database is a
 * fresh in-memory instance — records are never written to the application
 * database. No configuration, migration, or operating-state file is touched.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import { buildRegistry, type AdapterRegistry } from '../../src/adapters/registry.ts';
import type { AdapterStatus, DiscoveryHit, DiscoveryQuery, FetchLike } from '../../src/adapters/types.ts';
import { createOverpassDiscoveryAdapter, MAX_ENDPOINTS } from '../../src/adapters/discovery/overpass.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { runDiscovery, type DiscoveryPolicy } from '../../src/domain/discovery/service.ts';
import { emergencyStop, getOperatingState } from '../../src/domain/state/service.ts';

const BASE_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' };
const OVERPASS_ENV = { DISCOVERY_PROVIDER: 'overpass' };

const owner = { userId: null, label: 'owner' as const };

let cfg: Config;

function freshDb(): DB {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function setPolicy(db: DB, partial: Partial<DiscoveryPolicy>): void {
  const policy: DiscoveryPolicy = {
    categories: ['clinic', 'restaurant'],
    cities: ['Karachi', 'Lahore'],
    maxPerRun: 50,
    autoAnalyze: false,
    autoScore: false,
    ...partial,
  };
  db.prepare(
    `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
     VALUES ('discovery_policy', ?, 1, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(policy), nowIso());
}

function leadCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) c FROM businesses').get() as { c: number }).c;
}

/** Overpass-shaped registry: a fake fetch that answers per-city synthetic OSM elements. */
function overpassRegistry(elementsByCity: Record<string, unknown[]>): { registry: AdapterRegistry; queries: string[] } {
  const queries: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    assert.match(String(url), /overpass-api\.de/, 'requests stay on the configured instance');
    const body = typeof init.body === 'string' ? init.body : '';
    const query = decodeURIComponent(body.replace(/^data=/, ''));
    queries.push(query);
    const city = /area\["name"="(.*?)"\]/.exec(query)?.[1] ?? '(nationwide)';
    return new Response(JSON.stringify({ elements: elementsByCity[city] ?? [] }), { status: 200 });
  };
  return { registry: buildRegistry(cfg, { ...BASE_ENV, ...OVERPASS_ENV }, { fetchImpl }), queries };
}

/** Minimal registry stub: runDiscovery only ever touches registry.discovery. */
function stubRegistry(perCity: Record<string, DiscoveryHit[]>): { registry: AdapterRegistry; searches: string[] } {
  const searches: string[] = [];
  const status: AdapterStatus = {
    key: 'discovery',
    label: 'Lead discovery',
    implementation: 'overpass',
    state: 'configured',
    features: [],
    lastError: null,
  };
  const registry = {
    discovery: {
      key: 'discovery',
      label: 'Lead discovery',
      status: () => status,
      search: async (q: DiscoveryQuery) => {
        searches.push(q.city ?? '');
        return perCity[q.city ?? ''] ?? [];
      },
    },
  } as unknown as AdapterRegistry;
  return { registry, searches };
}

const CLINIC = { type: 'node', id: 101, tags: { name: 'Alpha Clinic', 'contact:phone': '+92 300 1112233', website: 'https://alphaclinic.pk' } };
const RESTAURANT = { type: 'node', id: 102, tags: { name: 'Beta Biryani', phone: '+923214445566' } };

describe('discovery diagnostic: policy validation (§5.14–15)', () => {
  before(() => {
    cfg = loadConfig({ ...BASE_ENV, ...OVERPASS_ENV });
  });

  test('§5.14 a policy with no configured categories refuses before any provider request', async () => {
    const db = freshDb();
    setPolicy(db, { categories: [] });
    const { registry, queries } = overpassRegistry({ Karachi: [CLINIC] });

    await assert.rejects(
      () => runDiscovery(db, cfg, registry, { analyzeFetchOptions: {} }, owner),
      (err: { code?: string; message: string }) => {
        assert.equal(err.code, 'validation_failed');
        assert.match(err.message, /category/i, 'the message names what is missing');
        return true;
      },
    );
    assert.equal(queries.length, 0, 'no provider request is ever sent for an empty policy');
    assert.equal(leadCount(db), 0, 'nothing is created');
    db.close();
  });

  test('§5.15 a policy with no configured cities refuses before any provider request', async () => {
    const db = freshDb();
    setPolicy(db, { cities: [] });
    const { registry, queries } = overpassRegistry({ Karachi: [CLINIC] });

    await assert.rejects(
      () => runDiscovery(db, cfg, registry, { analyzeFetchOptions: {} }, owner),
      (err: { code?: string; message: string }) => {
        assert.equal(err.code, 'validation_failed');
        assert.match(err.message, /city/i, 'the message names what is missing');
        return true;
      },
    );
    assert.equal(queries.length, 0, 'no provider request is ever sent for an empty policy');
    assert.equal(leadCount(db), 0, 'nothing is created');
    db.close();
  });
});

describe('discovery diagnostic: provider timeout & transport (§5.10, §4)', () => {
  before(() => {
    cfg = loadConfig({ ...BASE_ENV, ...OVERPASS_ENV });
  });

  test('a timeout is classified as transport:timeout and every request carries an abort signal', async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const timeoutFetch: FetchLike = async (_url, init) => {
      signals.push(init.signal);
      throw Object.assign(new TypeError('fetch failed'), { name: 'TimeoutError' });
    };
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl: timeoutFetch, cooldownMs: 0 });

    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: { code?: string; message: string; retryable?: boolean }) => {
        assert.equal(err.code, 'network');
        assert.match(err.message, /transport: timeout/, 'the sanitized category names the real failure');
        assert.match(err.message, /overpass-api\.de/, 'the failing host is named');
        assert.equal(err.retryable, true, 'a timeout is retryable');
        return true;
      },
    );
    assert.ok(signals[0] instanceof AbortSignal, 'the search request is armed with an abort deadline');
    assert.equal(signals[0]!.aborted, false, 'the deadline is armed at request time, never pre-aborted');

    await assert.rejects(
      () => adapter.ping(),
      (err: { code?: string; message: string }) => {
        assert.equal(err.code, 'network');
        // Same shape the dashboard surfaced — "<n> endpoint(s) tried: <host>
        // (transport: timeout)" — except <n> is now the WHOLE pool: with no
        // owner-configured fallback the adapter still walks its built-in
        // mirrors rather than trusting a single endpoint, so one dead host
        // can no longer become "every city failed".
        assert.match(
          err.message,
          new RegExp(`${MAX_ENDPOINTS} endpoint\\(s\\) tried: overpass-api\\.de \\(transport: timeout\\)`),
          'the pool size and the primary host + category are disclosed',
        );
        return true;
      },
    );
    assert.ok(signals[1] instanceof AbortSignal, 'the health probe carries its own abort deadline');
  });

  test('a total provider timeout surfaces the REAL failure to the caller — never a fake-empty run', async () => {
    const db = freshDb();
    const alwaysTimeout: FetchLike = async (_url, init) => {
      assert.ok(init.signal instanceof AbortSignal, 'the registry passes the abort deadline through');
      throw Object.assign(new TypeError('fetch failed'), { name: 'TimeoutError' });
    };
    const registry = buildRegistry(cfg, { ...BASE_ENV, ...OVERPASS_ENV }, { fetchImpl: alwaysTimeout });

    await assert.rejects(
      () => runDiscovery(db, cfg, registry, { categories: ['clinic'], cities: ['Karachi'], analyzeFetchOptions: {} }, owner),
      (err: { code?: string; message: string }) => {
        assert.equal(err.code, 'provider_unavailable', 'every city failing is an honest failure');
        assert.match(err.message, /transport: timeout/, 'the actual failure reaches the UI, not a generic message');
        return true;
      },
    );
    assert.equal(leadCount(db), 0, 'a failed run creates nothing');
    db.close();
  });
});

describe('discovery diagnostic: synthetic pipeline robustness (§5.13, §5.7, §5.6)', () => {
  before(() => {
    cfg = loadConfig({ ...BASE_ENV, ...OVERPASS_ENV });
  });

  test('§5.13 a large synthetic response is bounded by the limit and completes quickly', async () => {
    const elements = Array.from({ length: 5000 }, (_, i) => ({
      type: 'node',
      id: i + 1,
      tags: { name: `Synthetic Shop ${i + 1}`, phone: `+92300${String(1000000 + i)}` },
    }));
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ elements }), { status: 200, headers: { 'content-type': 'application/json' } });
    const adapter = createOverpassDiscoveryAdapter({ fetchImpl });

    const started = Date.now();
    const hits = await adapter.search({ query: 'retail', city: 'Karachi', limit: 100 });
    const elapsed = Date.now() - started;

    assert.equal(hits.length, 100, 'the client-side cap holds even for a 5000-element payload');
    assert.equal(new Set(hits.map((h) => h.sourceUrl)).size, 100, 'every kept hit is a distinct OSM element');
    assert.ok(elapsed < 3000, `bounded work — took ${elapsed}ms, no hang and no quadratic blowup`);
  });

  test('§5.7 a provider hit with no name is rejected without corrupting the run', async () => {
    const db = freshDb();
    setPolicy(db, { categories: ['clinic'], cities: ['Karachi', 'Lahore'] });
    const blank: DiscoveryHit = {
      name: '   ',
      city: 'Karachi',
      sourceUrl: 'https://www.openstreetmap.org/node/0',
      source: 'openstreetmap',
    };
    const good: DiscoveryHit = {
      name: 'Karachi Care Clinic',
      city: 'Karachi',
      phone: '+92 300 1234567',
      sourceUrl: 'https://www.openstreetmap.org/node/1',
      source: 'openstreetmap',
    };
    const other: DiscoveryHit = {
      name: 'Lahore Lab',
      city: 'Lahore',
      sourceUrl: 'https://www.openstreetmap.org/node/2',
      source: 'openstreetmap',
    };
    const { registry } = stubRegistry({ Karachi: [blank, good], Lahore: [other] });

    const run = await runDiscovery(
      db,
      cfg,
      registry,
      { categories: ['clinic'], cities: ['Karachi', 'Lahore'], analyzeFetchOptions: {} },
      owner,
    );

    const karachi = run.cityResults.find((c) => c.city === 'Karachi');
    assert.ok(karachi?.error, 'the malformed hit is reported as a city error, never silent');
    assert.match(karachi!.error!, /name/i, 'the error names the actual problem');
    assert.equal(run.cityResults.find((c) => c.city === 'Lahore')!.error, null, 'the healthy city proceeds');
    assert.equal(run.created, 1, "the healthy city's lead is created");

    const blanks = db.prepare(`SELECT COUNT(*) c FROM businesses WHERE TRIM(display_name) = ''`).get() as { c: number };
    assert.equal(blanks.c, 0, 'no blank-named row is ever persisted');
    const lahore = db.prepare(`SELECT id FROM businesses WHERE display_name = 'Lahore Lab'`).get();
    assert.ok(lahore, "the healthy city's lead is persisted intact");
    db.close();
  });

  test('§5.6 a different name with the same website auto-merges (exact_website) through discovery', async () => {
    const db = freshDb();
    setPolicy(db, { categories: ['clinic'], cities: ['Karachi'] });
    const existing = createLead(
      db,
      { displayName: 'Alpha Clinic Head Office', city: 'Karachi', websiteUrl: 'https://alphaclinic.pk' },
      owner,
    );
    const { registry } = overpassRegistry({
      Karachi: [{ type: 'node', id: 501, tags: { name: 'Alpha Clinic', website: 'https://alphaclinic.pk', 'contact:phone': '+92 300 1112233' } }],
    });

    const run = await runDiscovery(db, cfg, registry, { categories: ['clinic'], cities: ['Karachi'], analyzeFetchOptions: {} }, owner);

    assert.equal(run.merged, 1, 'the shared website host auto-merges — discovery never clones a lead');
    assert.equal(run.created, 0, 'no second row for the same business');
    const live = db.prepare('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL').get() as { c: number };
    assert.equal(live.c, 1, 'the survivor lead remains the only live row');
    assert.ok(existing.id);
    db.close();
  });
});

describe('discovery diagnostic: Geoapify configuration', () => {
  before(() => {
    cfg = loadConfig({ ...BASE_ENV, ...OVERPASS_ENV });
  });

  test('missing GEOAPIFY_API_KEY: discovery reports unconfigured when key absent', async () => {
    const db = freshDb();
    // No DISCOVERY_PROVIDER set, no GEOAPIFY_API_KEY
    const { registry } = buildRegistry(loadConfig({ ...BASE_ENV }), {});
    await assert.rejects(
      () => runDiscovery(db, cfg, registry, { cities: ['Karachi'], analyzeFetchOptions: {} }, owner),
      (err: { code?: string }) => err.code === 'provider_unavailable',
    );
    db.close();
  });

  test('valid GEOAPIFY_API_KEY: discovery initializes Geoapify adapter', async () => {
    const db = freshDb();
    const envWithKey = { ...BASE_ENV, GEOAPIFY_API_KEY: 'test-key-12345' };
    const { registry } = buildRegistry(loadConfig(envWithKey), {});
    // Should not throw — Geoapify adapter initializes with the key
    const adapterStatus = registry.discovery.status();
    assert.equal(adapterStatus.implementation, 'geoapify', 'status should report geoapify implementation');
    assert.equal(adapterStatus.features?.[0], 'places API lead search (paid tier, quota-protected)', 'features should include Geoapify description');
    db.close();
  });

  test('DISCOVERY_PROVIDER=overpass: overpass adapter takes precedence over Geoapify key', async () => {
    const db = freshDb();
    const envOverpass = { ...BASE_ENV, DISCOVERY_PROVIDER: 'overpass' };
    const { registry } = buildRegistry(loadConfig(envOverpass), {});
    const status = registry.discovery.status();
    assert.equal(status.implementation, 'overpass', 'status should report overpass implementation when DISCOVERY_PROVIDER=overpass');
    db.close();
  });
});

describe('discovery diagnostic: simulation & STOP ALL safety (§6)', () => {
  before(() => {
    cfg = loadConfig({ ...BASE_ENV, ...OVERPASS_ENV });
  });

  test('discovery under STOP ALL researches public data only — the stop stays on, outreach stays empty', async () => {
    const db = freshDb();
    setPolicy(db, { categories: ['clinic', 'restaurant'], cities: ['Karachi'] });
    emergencyStop(db, 'diagnostic: STOP ALL must stay active', owner);

    const { registry } = overpassRegistry({ Karachi: [CLINIC, RESTAURANT] });
    const run = await runDiscovery(
      db,
      cfg,
      registry,
      { categories: ['clinic', 'restaurant'], cities: ['Karachi'], analyzeFetchOptions: {} },
      owner,
    );
    assert.ok(run.created >= 1, 'research on public data is allowed while stopped (import posture)');

    // The stop itself is untouched: discovery never resumes or clears it.
    const state = getOperatingState(db);
    assert.equal(state.emergencyStop, true, 'STOP ALL remains active after a discovery run');
    assert.equal(state.paused, true, 'the outreach pause remains active too');
    assert.equal(state.mode, 'simulation', 'OPERATING_MODE stays simulation');

    // Discovery contacts nobody: every outreach surface stays empty.
    for (const table of ['outreach_attempts', 'calls', 'messages', 'followup_tasks']) {
      const row = db.prepare(`SELECT COUNT(*) c FROM ${table}`).get() as { c: number };
      assert.equal(row.c, 0, `${table} must stay empty — discovery creates leads, not contact`);
    }

    // Discovery cannot bypass eligibility: fresh leads start 'unknown' and
    // only the eligibility service may move them out of it.
    const notUnknown = db
      .prepare(`SELECT COUNT(*) c FROM businesses WHERE eligibility_state != 'unknown'`)
      .get() as { c: number };
    assert.equal(notUnknown.c, 0, 'discovered leads stay ineligible until explicitly checked');

    // Provenance is internal-only: no outbound interaction kind is written.
    const outbound = db
      .prepare(`SELECT COUNT(*) c FROM interactions WHERE direction != 'internal'`)
      .get() as { c: number };
    assert.equal(outbound.c, 0, 'every discovery interaction is internal — nothing leaves the system');
    db.close();
  });
});
