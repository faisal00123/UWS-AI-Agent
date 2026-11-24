/**
 * Phase 3: the offline `osm_local` discovery provider.
 *
 * Proves:
 *  - dispatch selects the adapter (and it is advertised as supported);
 *  - a missing/empty dataset is an honest ERROR with an actionable reason:
 *    status=error, search refuses (never fabricated hits), ping fails;
 *  - a raw `.pbf` path is refused before any read (the PBF parser is a
 *    dev-only dependency of the extractor and must never load here);
 *  - search() semantics mirror the Overpass adapter: PK-only, comma terms,
 *    limit clamped 1..100, known category terms match the record's category
 *    only, unknown terms fall back to a case-insensitive name substring,
 *    dedupe by sourceUrl + name/contact identity;
 *  - provenance (category/address/lat/lon/email/osm element) passes through
 *    verbatim from the dataset — nothing invented, nothing coerced;
 *  - malformed/binary content aborts with the line number instead of
 *    silently skipping data the owner believes is there;
 *  - the category list never drifts from the extractor's POLICY_CATEGORIES.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { AdapterError } from '../../src/adapters/types.ts';
import type { DiscoveryHit } from '../../src/adapters/types.ts';
import {
  createOsmLocalDiscoveryAdapter,
  osmLocalDatasetProblem,
  resolveOsmLocalDataset,
  OSM_LOCAL_CATEGORIES,
  DEFAULT_OSM_LOCAL_DATASET,
} from '../../src/adapters/discovery/osm-local.ts';
import { createDiscoveryAdapter, SUPPORTED_DISCOVERY_PROVIDERS } from '../../src/adapters/discovery/index.ts';
import { POLICY_CATEGORIES } from '../../scripts/extract-osm.ts';

let tmpDir: string;

before(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'osm-local-'));
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

/** One dataset line with the extractor's default record shape. */
function rec(over: Record<string, unknown>): string {
  return JSON.stringify({
    osmType: 'node',
    osmId: 1,
    name: 'Sample Business',
    category: 'clinic',
    city: 'Karachi',
    citySource: 'addr',
    lat: 24.9,
    lon: 67.0,
    source: 'openstreetmap',
    sourceUrl: 'https://www.openstreetmap.org/node/1',
    extractedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });
}

function writeDataset(name: string, lines: string[]): string {
  const file = path.join(tmpDir, name);
  writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

/**
 * The canonical fixture: ordered exactly as written to disk. Covers both
 * dedupe rules (records 7 and 8), the city/category filters, the null-city
 * record, and the known-vs-unknown term distinction (record 4).
 */
function mainDataset(): string {
  return writeDataset('main.ndjson', [
    // 1. full provenance — the hit every assertion below keys on
    rec({
      osmType: 'node',
      osmId: 101,
      name: 'Alpha Clinic',
      category: 'clinic',
      city: 'Karachi',
      phone: '+92 300 1112233',
      website: 'https://alphaclinic.pk',
      email: 'info@alphaclinic.pk',
      address: 'Block 13, Gulshan-e-Iqbal, Karachi',
      lat: 24.9136,
      lon: 67.0822,
      sourceUrl: 'https://www.openstreetmap.org/node/101',
    }),
    // 2. other city + other category
    rec({
      osmType: 'way',
      osmId: 102,
      name: 'Beta Biryani',
      category: 'restaurant',
      city: 'Karachi',
      phone: '+923214445566',
      lat: 24.8607,
      lon: 67.0011,
      sourceUrl: 'https://www.openstreetmap.org/way/102',
    }),
    // 3. clinic but Lahore
    rec({
      osmId: 103,
      name: 'Gamma Clinic',
      category: 'clinic',
      city: 'Lahore',
      phone: '+92 42 35778899',
      lat: 31.5204,
      lon: 74.3587,
      sourceUrl: 'https://www.openstreetmap.org/node/103',
    }),
    // 4. retail named like a clinic — known term "clinic" must NOT match it
    rec({
      osmId: 104,
      name: 'Clinic Supplies',
      category: 'retail',
      city: 'Karachi',
      sourceUrl: 'https://www.openstreetmap.org/node/104',
    }),
    // 5. no city on record — passes only when no city filter is requested
    rec({
      osmId: 105,
      name: 'Delta Clinic',
      category: 'clinic',
      city: null,
      citySource: 'none',
      sourceUrl: 'https://www.openstreetmap.org/node/105',
    }),
    // 6. retail whose NAME carries an unknown search term
    rec({
      osmId: 106,
      name: 'Dental Mart',
      category: 'retail',
      city: 'Karachi',
      sourceUrl: 'https://www.openstreetmap.org/node/106',
    }),
    // 7. same name+phone as record 1 (different element) — identity dedupe
    rec({
      osmId: 999,
      name: 'Alpha Clinic',
      category: 'clinic',
      city: 'Karachi',
      phone: '+92 300 1112233',
      sourceUrl: 'https://www.openstreetmap.org/node/999',
    }),
    // 8. same sourceUrl as record 1 but a DIFFERENT identity — only the
    //    sourceUrl rule can dedupe this one
    rec({
      osmId: 101,
      name: 'Alpha Clinic Renamed',
      category: 'clinic',
      city: 'Karachi',
      phone: '+92 300 99998888',
      sourceUrl: 'https://www.openstreetmap.org/node/101',
    }),
  ]);
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (err: unknown) => {
    assert.ok(err instanceof AdapterError, `expected AdapterError, got: ${String(err)}`);
    assert.equal(err.code, code);
    return true;
  });
}

describe('osm_local discovery provider', () => {
  // ------------------------------------------------------------ dispatch --

  test('DISCOVERY_PROVIDER=osm_local selects the offline adapter', () => {
    assert.ok(SUPPORTED_DISCOVERY_PROVIDERS.includes('osm_local'));
    const adapter = createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'osm_local' });
    const status = adapter.status();
    assert.equal(status.implementation, 'osm_local');
    assert.equal(status.key, 'discovery');
    assert.equal(adapter.key, 'osm_local_discovery');
  });

  test('other providers are untouched', () => {
    assert.equal(createDiscoveryAdapter({}).status().implementation, null);
    assert.equal(createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'overpass' }).status().implementation, 'overpass');
    assert.equal(createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'nope' }).status().implementation, null);
  });

  // ----------------------------------------------------- category parity --

  test('category list matches the extractor POLICY_CATEGORIES exactly', () => {
    assert.deepEqual([...OSM_LOCAL_CATEGORIES], [...POLICY_CATEGORIES]);
  });

  // -------------------------------------------------------- missing file --

  test('a missing dataset is an honest error: status/search/ping all say so', async () => {
    const missing = path.join(tmpDir, 'does-not-exist.ndjson');
    const env = { DISCOVERY_PROVIDER: 'osm_local', OSM_LOCAL_DATASET: missing };
    const adapter = createOsmLocalDiscoveryAdapter(env);

    const status = adapter.status();
    assert.equal(status.implementation, 'osm_local');
    assert.equal(status.state, 'error', 'missing dataset is an error, not unconfigured');
    assert.ok(status.lastError?.includes('Local dataset not found'), `actionable lastError, got: ${status.lastError}`);
    assert.ok(status.lastError?.includes('extract:osm'), 'lastError tells the owner how to fix it');

    // search refuses instead of inventing leads — same honest reason.
    await expectCode(adapter.search({ query: 'clinic', city: 'Karachi' }), 'unconfigured');

    const ping = await adapter.ping();
    assert.equal(ping.ok, false);
    assert.ok(ping.detail?.includes('Local dataset not found'));

    const problem = osmLocalDatasetProblem(env);
    assert.equal(problem?.code, 'unconfigured');
    assert.equal(resolveOsmLocalDataset(env), missing);
    assert.equal(resolveOsmLocalDataset({}), DEFAULT_OSM_LOCAL_DATASET);
  });

  test('an empty dataset is refused too (never a silent 0-hit search)', async () => {
    const file = path.join(tmpDir, 'empty.ndjson');
    writeFileSync(file, '', 'utf8');
    const env = { DISCOVERY_PROVIDER: 'osm_local', OSM_LOCAL_DATASET: file };
    const adapter = createOsmLocalDiscoveryAdapter(env);
    assert.equal(adapter.status().state, 'error');
    assert.ok(adapter.status().lastError?.includes('empty'));
    await expectCode(adapter.search({ query: 'clinic', city: 'Karachi' }), 'unconfigured');
    const ping = await adapter.ping();
    assert.equal(ping.ok, false);
  });

  // -------------------------------------------------------- .pbf refusal --

  test('a raw .pbf path is refused before any read (parser never loads)', async () => {
    const env = { DISCOVERY_PROVIDER: 'osm_local', OSM_LOCAL_DATASET: path.join(tmpDir, 'pakistan-latest.osm.pbf') };
    const adapter = createOsmLocalDiscoveryAdapter(env);

    const status = adapter.status();
    assert.equal(status.state, 'error');
    assert.ok(status.lastError?.includes('.pbf'), 'explains the PBF refusal');
    assert.ok(status.lastError?.includes('.ndjson'), 'points at the NDJSON output instead');

    await expectCode(adapter.search({ query: 'clinic', city: 'Karachi' }), 'provider_error');
    const ping = await adapter.ping();
    assert.equal(ping.ok, false);
    assert.ok(ping.detail?.includes('.pbf'));
  });

  // ------------------------------------------------------------- search --

  test('search filters by city + category and passes provenance through', async () => {
    const file = mainDataset();
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: file });
    const hits = await adapter.search({ query: 'clinic', city: 'Karachi', country: 'PK', limit: 50 });

    // Records 4 (retail), 5 (null city), 7+8 (dedupe) are all excluded.
    assert.equal(hits.length, 1, 'exactly one Karachi clinic');
    const hit = hits[0] as DiscoveryHit;
    assert.equal(hit.name, 'Alpha Clinic');
    assert.equal(hit.city, 'Karachi');
    assert.equal(hit.category, 'clinic');
    assert.equal(hit.phone, '+92 300 1112233');
    assert.equal(hit.website, 'https://alphaclinic.pk');
    assert.equal(hit.email, 'info@alphaclinic.pk');
    assert.equal(hit.address, 'Block 13, Gulshan-e-Iqbal, Karachi');
    assert.equal(hit.lat, 24.9136, 'coordinates verbatim from the dataset');
    assert.equal(hit.lon, 67.0822);
    assert.equal(hit.osmType, 'node');
    assert.equal(hit.osmId, 101, 'element identity for audit back to OSM');
    assert.equal(hit.source, 'openstreetmap');
    assert.equal(hit.sourceUrl, 'https://www.openstreetmap.org/node/101');
  });

  test('without a city filter null-city records are included, dedupe still holds', async () => {
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: mainDataset() });
    const hits = await adapter.search({ query: 'clinic', country: 'PK' });
    // 1 (Alpha), 3 (Gamma), 5 (Delta, city=null) — 7 identity-deduped,
    // 8 sourceUrl-deduped, 4 not a clinic.
    assert.deepEqual(
      hits.map((h) => h.name),
      ['Alpha Clinic', 'Gamma Clinic', 'Delta Clinic'],
    );
    const delta = hits.find((h) => h.name === 'Delta Clinic');
    assert.equal(delta?.city, undefined, 'no city invented for a null-city record');
  });

  test('limit is clamped (default 50, floor 1) with early exit', async () => {
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: mainDataset() });

    const one = await adapter.search({ query: 'clinic', limit: 1 });
    assert.equal(one.length, 1, 'limit: 1 returns a single hit');
    assert.equal(one[0]?.name, 'Alpha Clinic', 'first match in file order');

    const zero = await adapter.search({ query: 'clinic', limit: 0 });
    assert.equal(zero.length, 1, 'limit: 0 clamps up to 1, never 0 hits');

    const negative = await adapter.search({ query: 'clinic', limit: -5 });
    assert.equal(negative.length, 1, 'negative limit clamps to 1');

    const huge = await adapter.search({ query: 'clinic', limit: 10_000 });
    assert.equal(huge.length, 3, 'limit: 10_000 clamps to 100; fixture only has 3 clinics');

    const noLimit = await adapter.search({ query: 'clinic' });
    assert.equal(noLimit.length, 3, 'default limit 50 covers the fixture');
  });

  test('known terms match category only; unknown terms fall back to the name', async () => {
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: mainDataset() });

    // Known term: "Clinic Supplies" (retail) must NOT match on its name —
    // identical to the Overpass tag-filter semantics.
    const known = await adapter.search({ query: 'clinic', city: 'Karachi' });
    assert.deepEqual(known.map((h) => h.name), ['Alpha Clinic']);

    // Unknown term: case-insensitive name substring.
    const freeText = await adapter.search({ query: 'dental', city: 'Karachi' });
    assert.deepEqual(freeText.map((h) => h.name), ['Dental Mart']);

    const spaced = await adapter.search({ query: 'clinic supplies', city: 'Karachi' });
    assert.deepEqual(spaced.map((h) => h.name), ['Clinic Supplies']);

    // Case-insensitive term matching too.
    const upper = await adapter.search({ query: 'DENTAL', city: 'Karachi' });
    assert.equal(upper.length, 1);
  });

  test('city matching is case-insensitive (Karachi = karachi)', async () => {
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: mainDataset() });
    const hits = await adapter.search({ query: 'restaurant', city: 'karachi' });
    assert.deepEqual(hits.map((h) => h.name), ['Beta Biryani']);
    assert.equal(hits[0]?.city, 'Karachi', 'the dataset spelling is preserved on the hit');
  });

  test('guard rails: PK-only, at least one category', async () => {
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: mainDataset() });
    await expectCode(
      adapter.search({ query: 'clinic', city: 'Karachi', country: 'US' as 'PK' }),
      'invalid_destination',
    );
    await expectCode(adapter.search({ query: ' , ', city: 'Karachi' }), 'invalid_destination');
  });

  // -------------------------------------------------- corrupt input paths --

  test('a malformed JSON line aborts with its line number', async () => {
    const file = writeDataset('malformed.ndjson', [rec({ osmId: 1 }), '{"name": broken']);
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: file });
    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, 'provider_error');
        assert.match(err.message, /line 2/);
        return true;
      },
    );
  });

  test('content that is not NDJSON is refused on the first line', async () => {
    const file = writeDataset('binary.ndjson', ['GIF89a not a dataset', rec({})]);
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: file });
    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, 'provider_error');
        assert.match(err.message, /not an NDJSON dataset/);
        return true;
      },
    );
  });

  test('a record that violates the extractor schema aborts (nothing coerced)', async () => {
    const file = writeDataset('schema-violation.ndjson', [
      JSON.stringify({ osmType: 'node', osmId: 7, name: 'No Coords Clinic', category: 'clinic', city: 'Karachi', sourceUrl: 'https://www.openstreetmap.org/node/7' }),
    ]);
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: file });
    await assert.rejects(
      () => adapter.search({ query: 'clinic', city: 'Karachi' }),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, 'provider_error');
        assert.match(err.message, /line 1/);
        assert.match(err.message, /lat/);
        return true;
      },
    );
  });

  // --------------------------------------------------------------- ping --

  test('ping is free, local and honest about a healthy dataset', async () => {
    const file = mainDataset();
    const adapter = createOsmLocalDiscoveryAdapter({ OSM_LOCAL_DATASET: file });
    const ping = await adapter.ping();
    assert.equal(ping.ok, true);
    assert.match(ping.detail ?? '', /Local dataset OK: \d+ byte\(s\)/);
    assert.ok(!/https?:/i.test(ping.detail ?? ''), 'no network detail in a local probe');
  });
});
