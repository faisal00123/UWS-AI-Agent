/**
 * Phase 3 integration: discovery runs end-to-end against a LOCAL dataset.
 *
 * Proves, with zero network (no fetch is injected and autoAnalyze is off):
 *  - a configured osm_local registry reports `configured` and passes the
 *    free local "Test connection" health probe;
 *  - runDiscovery streams the NDJSON dataset, creates real leads, and
 *    persists the full provenance (category/address/lat/lon/email + OSM
 *    element identity) — exactly what the extractor recorded, nothing more;
 *  - a missing dataset fails honestly (`provider_unavailable` with the
 *    actionable reason) and creates ZERO leads.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import { buildRegistry, type AdapterRegistry } from '../../src/adapters/registry.ts';
import { runDiscovery, type DiscoveryPolicy } from '../../src/domain/discovery/service.ts';
import { runHealthCheck } from '../../src/domain/integrations/service.ts';

const BASE_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' };
const owner = { userId: null, label: 'owner' as const };

let tmpDir: string;
let dataset: string;

before(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), 'osm-local-int-'));
  dataset = path.join(tmpDir, 'osm-leads.ndjson');
  const records = [
    {
      osmType: 'node',
      osmId: 101,
      name: 'Alpha Clinic',
      category: 'clinic',
      city: 'Karachi',
      citySource: 'addr',
      phone: '+92 300 1112233',
      website: 'https://alphaclinic.pk',
      email: 'info@alphaclinic.pk',
      address: 'Block 13, Gulshan-e-Iqbal, Karachi',
      lat: 24.9136,
      lon: 67.0822,
      source: 'openstreetmap',
      sourceUrl: 'https://www.openstreetmap.org/node/101',
      extractedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      osmType: 'way',
      osmId: 102,
      name: 'Beta Biryani',
      category: 'restaurant',
      city: 'Karachi',
      citySource: 'bbox',
      phone: '+923214445566',
      address: 'Razzaqabad, Karachi',
      lat: 24.8607,
      lon: 67.0011,
      source: 'openstreetmap',
      sourceUrl: 'https://www.openstreetmap.org/way/102',
      extractedAt: '2026-01-01T00:00:00.000Z',
    },
    {
      osmType: 'node',
      osmId: 103,
      name: 'Gamma Clinic',
      category: 'clinic',
      city: 'Lahore',
      citySource: 'addr',
      phone: '+92 42 35778899',
      address: 'Johar Town, Lahore',
      lat: 31.5204,
      lon: 74.3587,
      source: 'openstreetmap',
      sourceUrl: 'https://www.openstreetmap.org/node/103',
      extractedAt: '2026-01-01T00:00:00.000Z',
    },
  ];
  writeFileSync(dataset, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
});

after(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function freshDb(): DB {
  const db = openDatabase(':memory:');
  await runMigrations(db);
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

function registryFor(env: Record<string, string | undefined>): { cfg: Config; registry: AdapterRegistry } {
  const cfg = loadConfig({ ...BASE_ENV, DISCOVERY_PROVIDER: 'osm_local' });
  const registry = buildRegistry(cfg, { DISCOVERY_PROVIDER: 'osm_local', ...env }, {});
  return { cfg, registry };
}

interface BusinessRow {
  display_name: string;
  category: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  email: string | null;
  city: string;
}

describe('osm_local discovery integration', () => {
  test('status + free health probe are honest about the local dataset', async () => {
    const db = freshDb();
    try {
      const { cfg, registry } = registryFor({ OSM_LOCAL_DATASET: dataset });
      const status = registry.discovery.status();
      assert.equal(status.state, 'configured');
      assert.equal(status.implementation, 'osm_local');

      const health = await runHealthCheck(db, cfg, registry, 'discovery');
      assert.equal(health.ok, true, 'the local probe succeeds without any network');
      assert.match(health.detail, /Local dataset OK: \d+ byte\(s\)/);
      assert.equal(health.state, 'configured');
    } finally {
      db.close();
    }
  });

  test('runDiscovery creates leads from the dataset with full provenance', async () => {
    const db = freshDb();
    try {
      setPolicy(db, {});
      const { cfg, registry } = registryFor({ OSM_LOCAL_DATASET: dataset });

      const run = await runDiscovery(db, cfg, registry, { analyzeFetchOptions: {} }, owner);
      assert.equal(run.provider, 'osm_local');
      assert.equal(run.simulated, false, 'local files are real data, not simulation');
      assert.equal(run.hits, 3, 'Karachi x2 + Lahore x1');
      assert.equal(run.created, 3);
      assert.equal(run.analyzed, 0, 'autoAnalyze is off — no fetch was attempted');
      assert.deepEqual(
        run.cityResults.map((c) => [c.city, c.hits, c.error]),
        [
          ['Karachi', 2, null],
          ['Lahore', 1, null],
        ],
      );

      const rows = db
        .prepare('SELECT * FROM businesses ORDER BY display_name')
        .all() as unknown as BusinessRow[];
      assert.equal(rows.length, 3);

      const alpha = rows.find((r) => r.display_name === 'Alpha Clinic');
      assert.ok(alpha, 'lead stored');
      assert.equal(alpha.category, 'clinic');
      assert.equal(alpha.email, 'info@alphaclinic.pk');
      assert.equal(alpha.address, 'Block 13, Gulshan-e-Iqbal, Karachi');
      assert.equal(alpha.latitude, 24.9136, 'coordinates persisted verbatim');
      assert.equal(alpha.longitude, 67.0822);
      assert.equal(alpha.city, 'Karachi');

      const beta = rows.find((r) => r.display_name === 'Beta Biryani');
      assert.ok(beta);
      assert.equal(beta.category, 'restaurant');
      assert.equal(beta.latitude, 24.8607);

      // Provenance interaction names the actual provider and carries the
      // OSM element identity for audit back to the source record.
      const interactions = db
        .prepare(
          `SELECT summary, evidence_json FROM interactions
           WHERE kind = 'import' AND summary LIKE 'Discovered via OpenStreetMap%'
           ORDER BY id`,
        )
        .all() as { summary: string; evidence_json: string }[];
      assert.equal(interactions.length, 3, 'one provenance interaction per lead');
      const parsed = interactions.map((i) => ({
        summary: i.summary,
        evidence: JSON.parse(i.evidence_json) as {
          provider?: string;
          osmType?: string;
          osmId?: number;
          sourceUrl?: string;
        },
      }));
      assert.ok(
        parsed.every((p) => p.summary.includes('(osm_local)')),
        `summary names the real provider: ${parsed.map((p) => p.summary).join(' | ')}`,
      );
      const alphaEvidence = parsed.find((p) => p.evidence.sourceUrl === 'https://www.openstreetmap.org/node/101');
      assert.ok(alphaEvidence, 'provenance for the Alpha Clinic element exists');
      assert.equal(alphaEvidence.evidence.provider, 'osm_local');
      assert.equal(alphaEvidence.evidence.osmType, 'node');
      assert.equal(alphaEvidence.evidence.osmId, 101);
    } finally {
      db.close();
    }
  });

  test('a missing dataset fails honestly and creates ZERO leads', async () => {
    const db = freshDb();
    try {
      setPolicy(db, {});
      const { cfg, registry } = registryFor({ OSM_LOCAL_DATASET: path.join(tmpDir, 'absent.ndjson') });

      await assert.rejects(
        () => runDiscovery(db, cfg, registry, { analyzeFetchOptions: {} }, owner),
        (err: { code?: string; message: string }) => {
          assert.equal(err.code, 'provider_unavailable');
          assert.match(err.message, /Local dataset not found/, 'the actionable reason reaches the owner');
          return true;
        },
      );
      const count = db.prepare('SELECT COUNT(*) c FROM businesses').get() as { c: number };
      assert.equal(count.c, 0, 'no lead may be invented without a dataset');
    } finally {
      db.close();
    }
  });
});
