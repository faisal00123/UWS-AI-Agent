/**
 * Phase 1: offline OSM PBF extractor tests.
 *
 * Runs the real extractor against a locally-generated PBF fixture — no
 * downloads, no network, no database. Pins: gate order (category → name →
 * city → filter → dedupe → limit), evidence-based city resolution with the
 * documented Islamabad/Rawalpindi split, Overpass category parity, ODbL
 * sidecar attribution, interruption cleanup and CLI usage errors.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  buildFixturePbf,
  type FixturePbf,
} from '../helpers/pbf-fixture.ts';
import {
  CITY_BOXES,
  ODBL_ATTRIBUTION,
  ODBL_URL,
  POLICY_CATEGORIES,
  UsageError,
  classifyTags,
  parseCliArgs,
  resolveCity,
  runExtract,
  type ExtractedRecord,
} from '../../scripts/extract-osm.ts';
import { buildOverpassQuery } from '../../src/adapters/discovery/overpass.ts';
import { SETTING_DEFINITIONS } from '../../src/domain/settings/service.ts';
import type { Config } from '../../src/core/config.ts';

let fixture: FixturePbf;
let outDir: string;

before(async () => {
  fixture = await buildFixturePbf();
  outDir = await fs.mkdtemp(path.join(process.env.TEMP ?? '/tmp', 'uws-extract-out-'));
});

after(async () => {
  await fs.rm(fixture.dir, { recursive: true, force: true });
  await fs.rm(outDir, { recursive: true, force: true });
});

function outPath(name: string): string {
  return path.join(outDir, name);
}

async function readRecords(file: string): Promise<ExtractedRecord[]> {
  const text = await fs.readFile(file, 'utf8');
  return text
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ExtractedRecord);
}

test('default run: full gate model, provenance and city evidence', async () => {
  const output = outPath('default.ndjson');
  const stats = await runExtract({ input: fixture.file, output });

  assert.equal(stats.written, 8);
  assert.equal(stats.deduped, 1, 'exact duplicate place collapses');
  assert.equal(stats.truncated, 0);
  assert.equal(stats.aborted, false);
  assert.equal(stats.dryRun, false);
  assert.deepEqual(stats.parsed, { nodes: 18, ways: 4, relations: 1, untagged: 9 });

  assert.equal(stats.matched.total, 11);
  assert.deepEqual(stats.matched.byCategory, {
    clinic: 4,
    restaurant: 2,
    school: 2,
    real_estate: 1,
    retail: 1,
    ecommerce: 0,
    professional_services: 1,
  });

  assert.deepEqual(stats.skipped, {
    category: 1,
    name: 1,
    city: 1,
    coords: 1,
    too_large: 0,
    relation: 1,
  });
  assert.equal(stats.filtered.city, 0);

  assert.deepEqual(stats.cities.bySource, { addr: 5, bbox: 3, none: 0 });
  assert.deepEqual(stats.cities.byCity, {
    Karachi: 1,
    Islamabad: 2,
    Lahore: 2,
    Rawalpindi: 1,
    Sialkot: 1,
    Faisalabad: 1,
  });

  const records = await readRecords(output);
  assert.equal(records.length, 8);
  assert.deepEqual(
    records.map((r) => r.osmId).sort((a, b) => a - b),
    [1001, 1002, 1003, 1004, 1007, 2001, 2002, 2003],
    'expected records survive every gate',
  );

  const clinic = records.find((r) => r.osmId === 1001);
  assert.ok(clinic);
  assert.equal(clinic.name, 'Fixture Health Clinic');
  assert.equal(clinic.category, 'clinic');
  assert.equal(clinic.city, 'Karachi');
  assert.equal(clinic.citySource, 'addr');
  assert.equal(clinic.phone, '+92 21 111 000 111');
  assert.equal(clinic.website, 'https://clinic.example');
  assert.equal(clinic.email, 'desk@clinic.example');
  assert.equal(clinic.address, '12 Shahrah-e-Faisal, Karachi');
  assert.equal(clinic.source, 'openstreetmap');
  assert.equal(clinic.sourceUrl, 'https://www.openstreetmap.org/node/1001');
  assert.ok(!Number.isNaN(Date.parse(clinic.extractedAt)), 'extractedAt is ISO');

  const school = records.find((r) => r.osmId === 1002);
  assert.ok(school);
  assert.equal(school.city, 'Islamabad');
  assert.equal(school.citySource, 'bbox', 'no addr:city → bbox fallback');

  const mart = records.find((r) => r.osmId === 1003);
  assert.ok(mart);
  assert.equal(mart.category, 'retail', 'shop=* → retail under default order');
  assert.equal(mart.city, 'Lahore');
  assert.equal(mart.citySource, 'bbox');
  assert.equal(mart.phone, '+92 42 111 222 333', 'contact:phone honoured');

  const sialkot = records.find((r) => r.osmId === 1007);
  assert.ok(sialkot);
  assert.equal(sialkot.city, 'Sialkot', 'addr:city evidence outside the eight cities is kept');

  const way = records.find((r) => r.osmId === 2001);
  assert.ok(way);
  assert.equal(way.osmType, 'way');
  assert.equal(way.category, 'restaurant');
  assert.equal(way.city, 'Lahore');
  assert.equal(way.lat, 31.5205, 'way centroid = average of resolved refs');
  assert.equal(way.lon, 74.3587);
  assert.equal(way.sourceUrl, 'https://www.openstreetmap.org/way/2001');

  const legal = records.find((r) => r.osmId === 2002);
  assert.ok(legal);
  assert.equal(legal.category, 'professional_services', 'office=lawyer is not estate_agent');

  const estates = records.find((r) => r.osmId === 2003);
  assert.ok(estates);
  assert.equal(estates.category, 'real_estate');
  assert.equal(estates.city, 'Faisalabad');
  assert.equal(estates.citySource, 'bbox');

  // No records leaked past their gates.
  assert.ok(!records.some((r) => r.osmId === 1009), 'duplicate never written');
  assert.ok(!records.some((r) => r.osmId === 1008), 'cityless record never written');
  assert.ok(!records.some((r) => r.osmId === 2004), 'way without coords never written');

  // Failure samples are capped and named.
  assert.ok(stats.sampleFailures.length <= 20);
  assert.ok(stats.sampleFailures.some((s) => s.reason === 'city' && s.osmId === 1008));
  assert.ok(stats.sampleFailures.some((s) => s.reason === 'coords' && s.osmId === 2004));
});

test('sidecar carries verbatim ODbL attribution and the full report', async () => {
  const output = outPath('meta.ndjson');
  await runExtract({ input: fixture.file, output });
  const meta = JSON.parse(await fs.readFile(`${output}.meta.json`, 'utf8'));
  assert.equal(meta.license, 'ODbL');
  assert.equal(meta.attribution, ODBL_ATTRIBUTION);
  assert.equal(
    meta.attribution,
    '© OpenStreetMap contributors — Data available under the Open Database License (ODbL).',
  );
  assert.equal(meta.attributionUrl, ODBL_URL);
  assert.equal(meta.source, 'openstreetmap');
  assert.equal(meta.stats.written, 8);
});

test('dry-run reports stats but writes no files', async () => {
  const output = outPath('dryrun.ndjson');
  const stats = await runExtract({ input: fixture.file, output, dryRun: true });
  assert.equal(stats.dryRun, true);
  assert.equal(stats.output, null);
  assert.equal(stats.written, 8);
  await assert.rejects(fs.stat(output), 'dataset not written');
  await assert.rejects(fs.stat(`${output}.meta.json`), 'sidecar not written');
});

test('--city filter keeps only matching resolved cities', async () => {
  const output = outPath('lahore.ndjson');
  const stats = await runExtract({ input: fixture.file, output, cities: ['lahore'] });
  const records = await readRecords(output);
  assert.equal(stats.written, 2);
  assert.equal(stats.filtered.city, 7);
  assert.equal(stats.deduped, 0, 'filtered-out duplicates never reach dedupe');
  assert.deepEqual(
    records.map((r) => r.osmId).sort((a, b) => a - b),
    [1003, 2001],
  );
  assert.ok(records.every((r) => r.city === 'Lahore'));
});

test('--category filter narrows classification', async () => {
  const output = outPath('clinic.ndjson');
  const stats = await runExtract({ input: fixture.file, output, categories: ['clinic'] });
  const records = await readRecords(output);
  assert.equal(stats.written, 2);
  assert.equal(stats.deduped, 1, '1009 still dedupes against 1001');
  assert.deepEqual(stats.matched.byCategory, { clinic: 4 });
  assert.equal(stats.skipped.category, 9, 'everything non-clinic is category-skipped');
  assert.deepEqual(
    records.map((r) => r.osmId).sort((a, b) => a - b),
    [1001, 1007],
  );
  assert.ok(records.every((r) => r.category === 'clinic'));
});

test('--keep-uncity keeps the cityless record with honest nulls', async () => {
  const output = outPath('uncity.ndjson');
  const stats = await runExtract({ input: fixture.file, output, keepUncity: true });
  const records = await readRecords(output);
  assert.equal(stats.written, 9);
  assert.equal(stats.skipped.city, 0);
  assert.equal(stats.cities.bySource.none, 1);
  const rural = records.find((r) => r.osmId === 1008);
  assert.ok(rural);
  assert.equal(rural.city, null);
  assert.equal(rural.citySource, 'none');
});

test('--limit caps written records', async () => {
  const output = outPath('limited.ndjson');
  const stats = await runExtract({ input: fixture.file, output, limit: 3 });
  const records = await readRecords(output);
  assert.equal(stats.written, 3);
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => r.osmId),
    [1001, 1002, 1003],
    'file order preserved for nodes',
  );
});

test('pre-aborted signal returns aborted stats and removes partial output', async () => {
  const output = outPath('aborted.ndjson');
  const controller = new AbortController();
  controller.abort();
  const stats = await runExtract({
    input: fixture.file,
    output,
    signal: controller.signal,
  });
  assert.equal(stats.aborted, true);
  assert.equal(stats.written, 0);
  await assert.rejects(fs.stat(output), 'no dataset left behind');
  await assert.rejects(fs.stat(`${output}.tmp`), 'no temp file left behind');
});

test('classifyTags mirrors Overpass CATEGORY_FILTERS', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['clinic', { amenity: 'clinic' }, '["amenity"="clinic"]'],
    ['clinic', { healthcare: 'clinic' }, '["healthcare"="clinic"]'],
    ['restaurant', { amenity: 'cafe' }, '["amenity"="cafe"]'],
    ['restaurant', { amenity: 'fast_food' }, '["amenity"="fast_food"]'],
    ['school', { amenity: 'school' }, '["amenity"="school"]'],
    ['real_estate', { office: 'estate_agent' }, '["office"="estate_agent"]'],
    ['retail', { shop: 'bakery' }, 'node["shop"](area.pk)'],
    ['ecommerce', { shop: 'bakery' }, 'node["shop"](area.pk)'],
    // professional_services = ANY office tag (no value), like Overpass's ['office','*'].
    ['professional_services', { office: 'lawyer' }, 'node["office"](area.pk)'],
  ];
  for (const [category, tags, ql] of cases) {
    assert.equal(classifyTags(tags, [category]), category, `${JSON.stringify(tags)} → ${category}`);
    const query = buildOverpassQuery([category], undefined, 10);
    assert.ok(query.includes(ql), `Overpass QL for ${category} includes ${ql}`);
  }

  // First requested match wins where Overpass filters overlap.
  assert.equal(classifyTags({ shop: 'bakery' }, ['retail', 'ecommerce']), 'retail');
  assert.equal(classifyTags({ office: 'estate_agent' }, ['real_estate', 'professional_services']), 'real_estate');
  assert.equal(classifyTags({ highway: 'residential' }, [...POLICY_CATEGORIES]), null);
});

test('resolveCity prefers addr:city and splits Islamabad/Rawalpindi by latitude', () => {
  // Evidence wins even outside every box.
  assert.deepEqual(resolveCity({ 'addr:city': 'Quetta' }, 0, 0), { city: 'Quetta', source: 'addr' });
  // Bbox fallback for the adjacent pair (documented heuristic).
  assert.deepEqual(resolveCity({}, 33.7, 73.1), { city: 'Islamabad', source: 'bbox' });
  assert.deepEqual(resolveCity({}, 33.6, 73.04), { city: 'Rawalpindi', source: 'bbox' });
  // No evidence, no box → honest null.
  assert.deepEqual(resolveCity({}, 30, 70), { city: null, source: 'none' });
});

test('extractor stays in sync with the discovery policy defaults', () => {
  const policy = SETTING_DEFINITIONS.find((d) => d.key === 'discovery_policy');
  assert.ok(policy, 'discovery_policy setting exists');
  // discovery_policy's default ignores cfg (hardcoded lists), so a cast stub
  // is safe here — the assertion below pins exactly what it returns.
  const def = policy.default({} as Config) as { categories: string[]; cities: string[] };
  assert.deepEqual(
    [...def.categories].sort(),
    [...POLICY_CATEGORIES].sort(),
    'extractor categories must match discovery_policy default',
  );
  assert.deepEqual(
    [...def.cities].sort(),
    CITY_BOXES.map((b) => b.city).sort(),
    'bbox cities must match discovery_policy default cities',
  );
});

test('parseCliArgs parses flags and rejects bad usage', () => {
  const args = parseCliArgs([
    '--input', 'in.osm.pbf',
    '--output', 'out.ndjson',
    '--city', 'Karachi',
    '--city', 'Lahore',
    '--category', 'clinic',
    '--limit', '25',
    '--keep-uncity',
    '--dry-run',
  ]);
  assert.equal(args.input, 'in.osm.pbf');
  assert.equal(args.output, 'out.ndjson');
  assert.deepEqual(args.cities, ['Karachi', 'Lahore']);
  assert.deepEqual(args.categories, ['clinic']);
  assert.equal(args.limit, 25);
  assert.equal(args.keepUncity, true);
  assert.equal(args.dryRun, true);
  assert.equal(args.help, false);

  assert.equal(parseCliArgs(['--help']).help, true);
  assert.throws(() => parseCliArgs(['--bogus']), UsageError);
  assert.throws(() => parseCliArgs(['--input']), UsageError, 'missing value');
  assert.throws(() => parseCliArgs(['--input', 'x', '--limit', '-1']), UsageError, 'bad limit');
});

test('runExtract rejects unsafe/invalid options before touching disk', async () => {
  await assert.rejects(
    runExtract({ input: path.join(outDir, 'missing.pbf'), dryRun: true }),
    UsageError,
    'missing input',
  );
  await assert.rejects(runExtract({ input: fixture.file }), UsageError, 'output required');
  await assert.rejects(
    runExtract({ input: fixture.file, output: fixture.file }),
    UsageError,
    'output must not clobber input',
  );
  await assert.rejects(
    runExtract({ input: fixture.file, dryRun: true, categories: ['coffee'] }),
    UsageError,
    'unknown category',
  );
});
