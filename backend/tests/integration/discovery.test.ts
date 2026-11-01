/**
 * Phase 12 integration tests: the discovery run service (OpenStreetMap).
 *
 * Proves:
 *  - a run turns public OSM hits into leads through the SAME createLead path
 *    as manual entry: normalisation, duplicate detection and auto-merge all
 *    apply, and every non-merged lead carries auditable provenance (source
 *    permalink + timeline interaction + one run-level audit event);
 *  - the policy bounds hold: maxPerRun caps creation, in-run dedupe skips
 *    repeats, ANALYZE_CAP_PER_RUN bounds autoAnalyze;
 *  - autoAnalyze/autoScore from the discovery policy are honoured (website
 *    analysis + score persisted) with an injected fetch — never real network;
 *  - partial failures are honest: a busy city is reported as an error while
 *    other cities proceed; if EVERY city fails the run throws
 *    provider_unavailable instead of a fake-empty success;
 *  - the integration toggle is authoritative (blocked_by_safeguard) and an
 *    unconfigured provider refuses (provider_unavailable, no invented leads);
 *  - the mock provider runs are labelled simulated: true.
 *
 * All provider access goes through an injected fake fetch: no test can ever
 * reach a real network.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import { buildRegistry, type AdapterRegistry } from '../../src/adapters/registry.ts';
import type { FetchLike } from '../../src/adapters/types.ts';
import type { FetchOptions as AnalyzeFetchOptions } from '../../src/domain/analysis/fetcher.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { runDiscovery, type DiscoveryPolicy } from '../../src/domain/discovery/service.ts';

const BASE_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' };
const OVERPASS_ENV = { DISCOVERY_PROVIDER: 'overpass' };

const owner = { userId: null, label: 'owner' as const };

let cfg: Config;

function freshDb(): DB {
  const db = openDatabase(':memory:');
  runMigrations(db);
  return db;
}

function overpassRegistry(responses: Record<string, unknown[]>, opts: { fail?: Record<string, number> } = {}): {
  registry: AdapterRegistry;
  queries: string[];
} {
  const queries: string[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    assert.match(String(url), /overpass-api\.de/, 'requests stay on the configured instance');
    const body = typeof init.body === 'string' ? init.body : '';
    const query = decodeURIComponent(body.replace(/^data=/, ''));
    queries.push(query);
    const city = /area\["name"="(.*?)"\]/.exec(query)?.[1] ?? '(nationwide)';
    const status = opts.fail?.[city];
    if (status !== undefined) return new Response('busy', { status });
    return new Response(JSON.stringify({ elements: responses[city] ?? [] }), { status: 200 });
  };
  return { registry: buildRegistry(cfg, { ...BASE_ENV, ...OVERPASS_ENV }, { fetchImpl }), queries };
}

function setPolicy(db: DB, partial: Partial<DiscoveryPolicy>): void {
  const policy: DiscoveryPolicy = {
    categories: ['clinic', 'restaurant', 'school'],
    cities: ['Karachi', 'Lahore', 'Quetta'],
    maxPerRun: 50,
    autoAnalyze: true,
    autoScore: true,
    ...partial,
  };
  db.prepare(
    `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
     VALUES ('discovery_policy', ?, 1, NULL, ?)
     ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
  ).run(JSON.stringify(policy), nowIso());
}

const CLINIC = { type: 'node', id: 101, tags: { name: 'Alpha Clinic', 'contact:phone': '+92 300 1112233', website: 'https://alphaclinic.pk' } };
const RESTAURANT = { type: 'node', id: 102, tags: { name: 'Beta Biryani', phone: '+923214445566' } };
const SCHOOL = { type: 'way', id: 103, tags: { name: 'Gamma School', 'contact:phone': '+923007778899' } };
const CLINIC_DUP = { type: 'node', id: 999, tags: { name: 'Alpha Clinic', 'contact:phone': '+92 300 1112233' } };

/** Default auto-analyze transport for runs whose hits may carry a website.
 *  Both fetch AND dns are stubbed: the SSRF guard resolves DNS before the
 *  fetch call, so a dnsLookup stub is required for zero-network guarantees. */
const NO_NETWORK_ANALYZE = {
  fetchImpl: async () =>
    new Response('<html><head><title>Clinic</title></head><body>ok</body></html>', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    }),
  dnsLookup: async () => [{ address: '93.184.216.34' }],
};

describe('Phase 12: discovery runs (OpenStreetMap)', () => {
  before(() => {
    cfg = loadConfig({ ...BASE_ENV, ...OVERPASS_ENV });
  });

  test('a two-city run creates leads with provenance, dedupe and audit', async () => {
    const db = freshDb();
    const { registry } = overpassRegistry({
      Karachi: [CLINIC, RESTAURANT],
      Lahore: [SCHOOL, CLINIC_DUP], // CLINIC_DUP = same business identity, other city response
    });
    // Website analysis in this run must go through a stub — never real network.
    const analyzeFetchOptions = NO_NETWORK_ANALYZE;

    const run = await runDiscovery(
      db,
      cfg,
      registry,
      { categories: ['clinic', 'restaurant', 'school'], cities: ['Karachi', 'Lahore'], analyzeFetchOptions },
      owner,
    );

    assert.equal(run.provider, 'overpass');
    assert.equal(run.simulated, false, 'real data source is not simulated');
    assert.equal(run.hits, 4);
    assert.equal(run.created, 3, 'three unique businesses');
    assert.equal(run.skipped, 1, 'the cross-city repeat is skipped, not double-imported');
    assert.equal(run.merged, 0);
    assert.equal(run.analyzeFailures, 0);
    assert.deepEqual(
      run.cityResults.map((c) => c.error),
      [null, null],
    );

    // Leads are tagged with the schema's 'directory' source type and carry
    // the OSM permalink.
    const leads = db
      .prepare(`SELECT display_name, city, source_type, source_url FROM businesses WHERE source_type = 'directory' ORDER BY display_name`)
      .all() as { display_name: string; city: string; source_url: string }[];
    assert.equal(leads.length, 3);
    assert.equal(leads[0]!.display_name, 'Alpha Clinic');
    assert.equal(leads[0]!.source_url, 'https://www.openstreetmap.org/node/101');
    assert.equal(leads[0]!.city, 'Karachi');
    assert.ok(leads.every((l) => l.source_url.startsWith('https://www.openstreetmap.org/')), 'every lead is auditable to OSM');

    // Provenance interactions + one run-level audit event.
    const interactions = db
      .prepare(`SELECT COUNT(*) c FROM interactions WHERE kind = 'import' AND summary LIKE 'Discovered via OpenStreetMap%'`)
      .get() as { c: number };
    assert.equal(interactions.c, 3, 'one provenance interaction per non-merged lead');
    const audit = db.prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'discovery.run'`).get() as { c: number };
    assert.equal(audit.c, 1);

    // autoAnalyze/autoScore honored: every lead got an analysis (website via
    // the injected stub, no-website leads as an honest `no_website` finding)
    // and a score — all inside this run, with zero real network.
    const analyses = db.prepare('SELECT COUNT(*) c FROM website_analyses').get() as { c: number };
    assert.equal(analyses.c, 3, 'autoAnalyze recorded an analysis per lead');
    const noWebsite = db
      .prepare(`SELECT COUNT(*) c FROM website_analyses WHERE status = 'no_website'`)
      .get() as { c: number };
    assert.equal(noWebsite.c, 2, 'leads without a website are an honest finding, not a fetch');
    const scores = db.prepare('SELECT COUNT(*) c FROM lead_scores').get() as { c: number };
    assert.equal(scores.c, 3, 'autoScore recorded a score per lead');
    db.close();
  });

  test('autoAnalyze fetches a lead website only through the injected transport', async () => {
    const db = freshDb();
    const { registry } = overpassRegistry({ Karachi: [CLINIC] });
    const fetched: string[] = [];
    const analyzeFetchOptions: AnalyzeFetchOptions = {
      fetchImpl: async (url) => {
        fetched.push(String(url));
        return new Response('<html><head><title>Alpha Clinic</title></head><body>Call +92 300 1112233</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        });
      },
      dnsLookup: async () => [{ address: '93.184.216.34' }],
    };

    await runDiscovery(db, cfg, registry, { cities: ['Karachi'], analyzeFetchOptions }, owner);

    assert.equal(fetched.length, 1, 'exactly one page fetch for the one lead with a website');
    assert.match(fetched[0]!, /alphaclinic\.pk/, 'the fetch targets the discovered website');
    const analyses = db.prepare(`SELECT status, target_url FROM website_analyses ORDER BY id`).all() as {
      status: string;
      target_url: string;
    }[];
    assert.equal(analyses.length, 1);
    assert.equal(analyses[0]!.status, 'reachable', 'the analysis completed through the stub');
    db.close();
  });

  test('a busy city is reported while other cities proceed; all-fail throws honestly', async () => {
    const db = freshDb();
    const partial = overpassRegistry({ Karachi: [RESTAURANT] }, { fail: { Quetta: 429 } });
    const run = await runDiscovery(
      db,
      cfg,
      partial.registry,
      { cities: ['Karachi', 'Quetta'], analyzeFetchOptions: {} },
      owner,
    );
    assert.equal(run.created, 1, 'Karachi still produced its lead');
    const quetta = run.cityResults.find((c) => c.city === 'Quetta');
    assert.match(quetta?.error ?? '', /busy/i, 'the busy city carries the provider message');
    assert.ok(run.analyzeFailures === 0);

    // Every city failing = honest failure, never a fake-empty success.
    const total = overpassRegistry({}, { fail: { Karachi: 500, Lahore: 500 } });
    await assert.rejects(
      () => runDiscovery(db, cfg, total.registry, { cities: ['Karachi', 'Lahore'], analyzeFetchOptions: {} }, owner),
      (err: { code?: string }) => err.code === 'provider_unavailable',
    );
    db.close();
  });

  test('maxPerRun caps creation and the surplus is skipped, not silently dropped', async () => {
    const db = freshDb();
    setPolicy(db, { maxPerRun: 2 });
    // Two cities, three unique hits, budget of two: the later city's hit is
    // skipped (the run cap is enforced, and the surplus is counted honestly).
    const { registry } = overpassRegistry({ Karachi: [CLINIC, RESTAURANT], Lahore: [SCHOOL] });
    const run = await runDiscovery(
      db,
      cfg,
      registry,
      { cities: ['Karachi', 'Lahore'], analyzeFetchOptions: NO_NETWORK_ANALYZE },
      owner,
    );
    assert.equal(run.created, 2);
    assert.equal(run.skipped, 1);
    db.close();
  });

  test('an existing identical phone auto-merges — discovery never clones a lead', async () => {
    const db = freshDb();
    const existing = createLead(
      db,
      { displayName: 'Beta Biryani Head Office', city: 'Karachi', phone: '+923214445566' },
      owner,
    );
    const { registry } = overpassRegistry({ Karachi: [RESTAURANT] });
    const run = await runDiscovery(db, cfg, registry, { cities: ['Karachi'], analyzeFetchOptions: {} }, owner);
    assert.equal(run.merged, 1, 'exact phone duplicate auto-merges');
    assert.equal(run.created, 0);
    const total = db.prepare('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL').get() as { c: number };
    assert.equal(total.c, 1, 'the survivor lead remains the only live row');
    assert.ok(existing.id);
    db.close();
  });

  test('the integration toggle is authoritative', async () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
       VALUES ('integration_toggles', ?, 1, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify({ discovery: false }), nowIso());
    const { registry } = overpassRegistry({ Karachi: [CLINIC] });
    await assert.rejects(
      () => runDiscovery(db, cfg, registry, { cities: ['Karachi'], analyzeFetchOptions: {} }, owner),
      (err: { code?: string }) => err.code === 'blocked_by_safeguard',
    );
    assert.equal((db.prepare('SELECT COUNT(*) c FROM businesses').get() as { c: number }).c, 0, 'nothing was created');
    db.close();
  });

  test('an unconfigured provider refuses instead of inventing leads', async () => {
    const db = freshDb();
    const bare = buildRegistry(loadConfig({ ...BASE_ENV }), {});
    await assert.rejects(
      () => runDiscovery(db, cfg, bare, { cities: ['Karachi'], analyzeFetchOptions: {} }, owner),
      (err: { code?: string }) => err.code === 'provider_unavailable',
    );
    db.close();
  });

  test('mock-provider runs are labelled simulated', async () => {
    const db = freshDb();
    const mock = buildRegistry(loadConfig({ ...BASE_ENV, DISCOVERY_PROVIDER: 'mock' }), {
      ...BASE_ENV,
      DISCOVERY_PROVIDER: 'mock',
    });
    const run = await runDiscovery(
      db,
      cfg,
      mock,
      { categories: ['salon'], cities: ['Karachi'], analyzeFetchOptions: {} },
      owner,
    );
    assert.equal(run.simulated, true, 'rehearsal data must announce itself');
    assert.equal(run.created, 1, 'Sample Salon Studio matches "salon"');
    db.close();
  });
});
