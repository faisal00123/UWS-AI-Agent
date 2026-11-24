/**
 * Phase 2: address + coordinates as first-class lead evidence.
 *
 * Proves:
 *  - migration 011 adds `address`, `latitude`, `longitude` additively with
 *    database-level range CHECKs (existing rows keep NULL, no backfill);
 *  - CSV import carries Address/Lat/Lon columns through analysis into the
 *    stored lead, and malformed/out-of-range coordinates become honest
 *    warnings + NULL — never coerced, never invented;
 *  - createLead validates coordinates the same way (warning + NULL);
 *  - `address` is editable through the audited update path while
 *    latitude/longitude are NOT (source evidence, not free text);
 *  - a discovery run passes the provider's hit provenance
 *    (category/email/address/lat/lon + OSM element identity) into the lead
 *    and the provenance interaction, only when the provider has it.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import type { AdapterRegistry } from '../../src/adapters/registry.ts';
import type { AdapterStatus, DiscoveryHit, DiscoveryQuery } from '../../src/adapters/types.ts';
import { importCsvText, type ImportMeta } from '../../src/domain/leads/import.ts';
import { createLead, updateLead } from '../../src/domain/leads/repository.ts';
import { runDiscovery, type DiscoveryPolicy } from '../../src/domain/discovery/service.ts';

const BASE_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' };
const owner = { userId: null, label: 'owner' as const };

const META: ImportMeta = {
  sourceType: 'csv_import',
  sourceLabel: 'phase2.csv',
  sourceUrl: null,
  importedBy: { userId: null, label: 'system' },
};

let db: DB;
let cfg: Config;

before(async () => {
  cfg = loadConfig(BASE_ENV);
  db = openDatabase(':memory:');
  await runMigrations(db);
});

after(() => {
  db.close();
});

interface BusinessRow {
  display_name: string;
  category: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  email: string | null;
}

function businessByName(name: string): BusinessRow | undefined {
  return db.prepare('SELECT * FROM businesses WHERE display_name = ?').get(name) as BusinessRow | undefined;
}

describe('Phase 2: address + coordinates', () => {
  test('migration 011 adds the columns with range CHECKs, no backfill', () => {
    const cols = db
      .prepare(`SELECT name FROM pragma_table_info('businesses')`)
      .all() as { name: string }[];
    const names = cols.map((c) => c.name);
    assert.ok(names.includes('address'), 'address column exists');
    assert.ok(names.includes('latitude'), 'latitude column exists');
    assert.ok(names.includes('longitude'), 'longitude column exists');

    // Existing rows keep NULL — nothing is backfilled or invented.
    const nulls = (await db.prepare('SELECT COUNT(*) c FROM businesses WHERE address IS NULL AND latitude IS NULL AND longitude IS NULL').get()) as { c: number };
    const total = (await db.prepare('SELECT COUNT(*) c FROM businesses').get()) as { c: number };
    assert.equal(nulls.c, total.c, 'pre-existing rows are untouched by the migration');

    // Database-level CHECK: garbage can never be persisted even if a future
    // code path bypasses application validation.
    assert.throws(
      () => db.prepare('INSERT INTO businesses (id, display_name, normalized_name, country, latitude) VALUES (?, ?, ?, ?, ?)').run(
        'biz_check_test', 'Check Co', 'check co', 'PK', 91,
      ),
      /CHECK|constraint/i,
      'latitude 91 is rejected by the schema',
    );
    assert.throws(
      () => db.prepare('INSERT INTO businesses (id, display_name, normalized_name, country, longitude) VALUES (?, ?, ?, ?, ?)').run(
        'biz_check_test2', 'Check Co 2', 'check co 2', 'PK', -181,
      ),
      /CHECK|constraint/i,
      'longitude -181 is rejected by the schema',
    );
  });

  test('CSV import persists Address/Lat/Lon from the file', () => {
    const csv = [
      'Name,Phone,City,Category,Address,Lat,Lon',
      'Karachi Dental Care,+92 21 34567890,Karachi,clinic,"Plot 4, Block 7, Gulshan-e-Iqbal",24.9167,67.0666',
    ].join('\n');
    const summary = importCsvText(db, cfg, csv, META);
    assert.equal(summary.imported + summary.needsReview + summary.merged, 1, 'row committed');

    const row = businessByName('Karachi Dental Care');
    assert.ok(row, 'lead stored');
    assert.equal(row.address, 'Plot 4, Block 7, Gulshan-e-Iqbal');
    assert.equal(row.latitude, 24.9167);
    assert.equal(row.longitude, 67.0666);
  });

  test('invalid coordinates become warnings + NULL, never garbage', () => {
    const csv = [
      'Name,Phone,City,Address,Lat,Lon',
      'BadCoords Cafe,+92 42 11122334,Lahore,Main Boulevard,999,not-a-number',
    ].join('\n');
    const summary = importCsvText(db, cfg, csv, META);
    const row = summary.rows.find((r) => r.candidate?.displayName === 'BadCoords Cafe');
    assert.ok(row, 'row analyzed');
    const problems = row.problems.map((p) => `${p.field}:${p.severity}`);
    assert.ok(problems.includes('latitude:warning'), 'bad latitude is a warning, not silent');
    assert.ok(problems.includes('longitude:warning'), 'bad longitude is a warning, not silent');
    // Warnings never reject the row — it imports as needs_review.
    assert.equal(row.status, 'needs_review');

    const stored = businessByName('BadCoords Cafe');
    assert.ok(stored, 'row still imported');
    assert.equal(stored.latitude, null, 'invalid latitude stored as NULL');
    assert.equal(stored.longitude, null, 'invalid longitude stored as NULL');
    assert.equal(stored.address, 'Main Boulevard', 'address evidence still kept');
  });

  test('createLead validates coordinates: valid evidence persists, bad evidence warns', () => {
    const good = createLead(
      db,
      {
        displayName: 'Evidence Clinic',
        city: 'Islamabad',
        category: 'clinic',
        address: 'Street 12, F-7 Markaz',
        latitude: 33.72,
        longitude: 73.05,
        email: 'info@evidence.example',
      },
      owner,
    );
    assert.deepEqual(good.problems, [], 'clean evidence produces no problems');
    const goodRow = businessByName('Evidence Clinic');
    assert.ok(goodRow);
    assert.equal(goodRow.address, 'Street 12, F-7 Markaz');
    assert.equal(goodRow.latitude, 33.72);
    assert.equal(goodRow.longitude, 73.05);
    assert.equal(goodRow.category, 'clinic');
    assert.equal(goodRow.email, 'info@evidence.example');

    const bad = createLead(
      db,
      { displayName: 'Bad Evidence Clinic', latitude: 91, longitude: 500 },
      owner,
    );
    const fields = bad.problems.map((p) => p.field);
    assert.ok(fields.includes('latitude'), 'out-of-range latitude is reported');
    assert.ok(fields.includes('longitude'), 'out-of-range longitude is reported');
    const badRow = businessByName('Bad Evidence Clinic');
    assert.ok(badRow);
    assert.equal(badRow.latitude, null, 'bad latitude never persisted');
    assert.equal(badRow.longitude, null, 'bad longitude never persisted');
    assert.equal(badRow.address, null);
  });

  test('address is editable; coordinates are source evidence (not editable)', () => {
    const created = createLead(db, { displayName: 'Editable Address Co', address: 'Old line' }, owner);
    const updated = updateLead(db, created.id, [{ field: 'address', value: 'New line, Karachi' }], owner);
    assert.equal((updated.business as BusinessRow).address, 'New line, Karachi');

    // latitude/longitude are excluded from EDITABLE_FIELDS: editing them
    // would break the audit back to the source record (OSM/CSV evidence).
    assert.throws(
      () => updateLead(db, created.id, [{ field: 'latitude', value: 24.86 }], owner),
      /not editable/,
    );
    assert.throws(
      () => updateLead(db, created.id, [{ field: 'longitude', value: 67.01 }], owner),
      /not editable/,
    );
  });

  test('discovery runs pass hit provenance into the lead + interaction', async () => {
    // Fresh settings for an isolated run (policy bounds + no auto network).
    const policy: DiscoveryPolicy = {
      categories: ['clinic'],
      cities: ['Karachi'],
      maxPerRun: 10,
      autoAnalyze: false,
      autoScore: false,
    };
    db.prepare(
      `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
       VALUES ('discovery_policy', ?, 1, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(policy), nowIso());

    const hit: DiscoveryHit = {
      name: 'OSM Evidence Clinic',
      city: 'Karachi',
      phone: '+92 300 1234567',
      email: 'osm@clinic.example',
      category: 'clinic',
      address: 'Block 13, Gulshan-e-Iqbal, Karachi',
      lat: 24.9136,
      lon: 67.0822,
      osmType: 'node',
      osmId: 123456789,
      sourceUrl: 'https://www.openstreetmap.org/node/123456789',
      source: 'openstreetmap',
    };
    const status: AdapterStatus = {
      key: 'discovery',
      label: 'Lead discovery',
      implementation: 'osm_local',
      state: 'configured',
      features: [],
      lastError: null,
    };
    // runDiscovery only ever touches registry.discovery — a minimal stub
    // proves the service's passthrough without any network or provider.
    const registry = {
      discovery: {
        key: 'discovery',
        label: 'Lead discovery',
        status: () => status,
        search: async (_q: DiscoveryQuery) => [hit],
      },
    } as unknown as AdapterRegistry;

    const run = await runDiscovery(db, cfg, registry, { categories: ['clinic'], cities: ['Karachi'] }, owner);
    assert.equal(run.created, 1, 'one lead created');
    assert.equal(run.analyzed, 0, 'autoAnalyze disabled — no fetch at all');

    const row = businessByName('OSM Evidence Clinic');
    assert.ok(row, 'lead stored');
    assert.equal(row.category, 'clinic', 'hit.category carried through');
    assert.equal(row.email, 'osm@clinic.example', 'hit.email carried through');
    assert.equal(row.address, 'Block 13, Gulshan-e-Iqbal, Karachi', 'hit.address carried through');
    assert.equal(row.latitude, 24.9136, 'hit.lat carried through');
    assert.equal(row.longitude, 67.0822, 'hit.lon carried through');

    // Provenance interaction carries the OSM element identity for audit.
    const interaction = db
      .prepare(
        `SELECT evidence_json FROM interactions
         WHERE kind = 'import' AND summary LIKE 'Discovered via OpenStreetMap%'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { evidence_json: string };
    const evidence = JSON.parse(interaction.evidence_json) as {
      osmType?: string;
      osmId?: number;
      sourceUrl?: string;
    };
    assert.equal(evidence.osmType, 'node', 'element type in provenance');
    assert.equal(evidence.osmId, 123456789, 'element id in provenance');
    assert.equal(evidence.sourceUrl, 'https://www.openstreetmap.org/node/123456789');
  });

  test('hits without the extended fields stay valid (nothing invented)', async () => {
    const policy: DiscoveryPolicy = {
      categories: ['clinic'],
      cities: ['Lahore'],
      maxPerRun: 10,
      autoAnalyze: false,
      autoScore: false,
    };
    db.prepare(
      `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
       VALUES ('discovery_policy', ?, 1, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(policy), nowIso());

    // Minimal hit — exactly what every existing adapter (mock/unconfigured/
    // Overpass) can produce: no category/email/address/lat/lon at all.
    const hit: DiscoveryHit = {
      name: 'Plain Legacy Clinic',
      city: 'Lahore',
      sourceUrl: 'https://www.openstreetmap.org/node/42',
      source: 'openstreetmap',
    };
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
        search: async (_q: DiscoveryQuery) => [hit],
      },
    } as unknown as AdapterRegistry;

    const run = await runDiscovery(db, cfg, registry, { categories: ['clinic'], cities: ['Lahore'] }, owner);
    assert.equal(run.created, 1);

    const row = businessByName('Plain Legacy Clinic');
    assert.ok(row);
    assert.equal(row.category, null, 'no category invented');
    assert.equal(row.email, null, 'no email invented');
    assert.equal(row.address, null, 'no address invented');
    assert.equal(row.latitude, null, 'no latitude invented');
    assert.equal(row.longitude, null, 'no longitude invented');

    // No OSM element identity in the provenance evidence either.
    const interaction = db
      .prepare(
        `SELECT evidence_json FROM interactions
         WHERE kind = 'import' AND summary LIKE 'Discovered via OpenStreetMap%'
         ORDER BY id DESC LIMIT 1`,
      )
      .get() as { evidence_json: string };
    const evidence = JSON.parse(interaction.evidence_json) as { osmType?: string; osmId?: number };
    assert.equal(evidence.osmType, undefined, 'no element type fabricated');
    assert.equal(evidence.osmId, undefined, 'no element id fabricated');
  });
});
