/**
 * Phase 4: free-first contact enrichment.
 *
 * Proves, with zero real network (every fetch is injected):
 *  - extractContacts() pulls mailto/tel hrefs and visible contacts from
 *    already-fetched HTML, skips script/style junk, dedupes and caps;
 *  - analyzeWebsite() gap-fills a lead that is MISSING email/phone from the
 *    SAME fetch (fetch called exactly once), records every valid candidate
 *    in field_verifications with the page URL as evidence, and writes a
 *    `system` timeline entry only when a field was actually filled;
 *  - existing contact details are NEVER overwritten (gap-fill only) — the
 *    observed values are still recorded as evidence;
 *  - invalid candidates are never applied: machine mailboxes (noreply) and
 *    bare digit strings (dates, order numbers) are rejected, nothing written;
 *  - discovery autoAnalyze enriches a freshly discovered lead end to end;
 *  - the /api/leads/:id/verify endpoint applies the same enrichment through
 *    the injected transport (the route can no longer reach a real network).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import { createLead, type CreateLeadInput } from '../../src/domain/leads/repository.ts';
import { analyzeWebsite } from '../../src/domain/analysis/service.ts';
import { extractContacts } from '../../src/core/contacts.ts';
import { enrichLeadContacts, type EnrichmentResult } from '../../src/domain/leads/enrich.ts';
import { runDiscovery, type DiscoveryPolicy } from '../../src/domain/discovery/service.ts';
import type { AdapterRegistry } from '../../src/adapters/registry.ts';
import type { AdapterStatus, DiscoveryHit, DiscoveryQuery } from '../../src/adapters/types.ts';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';

const BASE_ENV = { NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' };
const owner = { userId: null, label: 'owner' as const };

let db: DB;
let cfg: Config;

before(() => {
  cfg = loadConfig(BASE_ENV);
  db = openDatabase(':memory:');
  await runMigrations(db);
});

after(() => {
  db.close();
});

/** Build a fetch stub returning a fixed HTML page, counting the calls. */
function countingFetch(html: string, counter: { calls: number }): typeof fetch {
  return (async () => {
    counter.calls += 1;
    return new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });
  }) as unknown as typeof fetch;
}

const publicDns = async (): Promise<{ address: string }[]> => [{ address: '93.184.216.34' }];

/** Page with two deliberate contacts, one junk contact, and script noise. */
const RICH_PAGE = `<html><head><title>Alpha Clinic</title></head><body>
  <a href="mailto:info@alphaclinic.pk?subject=Hello">Email us</a>
  <a href="tel:+923001112233">Call</a>
  <p>Reach us at appointments@alphaclinic.pk or 0321-4445566</p>
  <script>var spam = "hidden@example.com"; var num = "03009998877";</script>
</body></html>`;

function makeLead(overrides: Partial<CreateLeadInput> = {}): string {
  const res = createLead(db, { displayName: 'Enrichment Target', city: 'Karachi', ...overrides }, owner);
  return res.id;
}

function businessRow(id: string): { email: string | null; phone_e164: string | null; phone_raw: string | null } {
  return db.prepare('SELECT email, phone_e164, phone_raw FROM businesses WHERE id = ?').get(id) as {
    email: string | null;
    phone_e164: string | null;
    phone_raw: string | null;
  };
}

function verifications(id: string, field: string): { value: string; state: string; method: string; evidence: string | null }[] {
  return db
    .prepare('SELECT value, state, method, evidence FROM field_verifications WHERE business_id = ? AND field = ?')
    .all(id, field) as unknown as { value: string; state: string; method: string; evidence: string | null }[];
}

function enrichedInteractions(id: string): { summary: string; evidence_json: string | null }[] {
  return db
    .prepare(
      `SELECT summary, evidence_json FROM interactions
       WHERE business_id = ? AND kind = 'system' AND summary LIKE 'Contact enriched%'`,
    )
    .all(id) as unknown as { summary: string; evidence_json: string | null }[];
}

describe('Phase 4: contact extraction (pure)', () => {
  test('mailto/tel hrefs win, visible text follows, script noise is skipped', () => {
    const found = extractContacts(RICH_PAGE);
    assert.deepEqual(found.emails, ['info@alphaclinic.pk', 'appointments@alphaclinic.pk']);
    // mailto query string stripped; script values never appear.
    assert.deepEqual(found.phones, ['+923001112233', '0321-4445566']);
    assert.ok(!found.emails.includes('hidden@example.com'), 'script content is never a contact');
    assert.ok(!found.phones.includes('03009998877'), 'script content is never a contact');
  });

  test('output is deduplicated and capped at 10 per field', () => {
    const many = Array.from({ length: 15 }, (_, i) => `<a href="mailto:user${i}@cap.pk">x</a>`).join('');
    const found = extractContacts(many);
    assert.equal(found.emails.length, 10, 'capped at 10');
    assert.equal(new Set(found.emails).size, 10, 'no duplicates');

    const dup = extractContacts('<a href="mailto:Same@Dup.pk">a</a><p>same@dup.pk again</p>');
    assert.deepEqual(dup.emails, ['same@dup.pk'], 'case-insensitive dedupe, first occurrence kept');
  });
});

describe('Phase 4: enrichment through website analysis', () => {
  test('a lead missing contact details is enriched from the SAME fetch', async () => {
    const id = makeLead({ websiteUrl: 'https://alphaclinic.pk' });
    const counter = { calls: 0 };
    const rec = await analyzeWebsite(
      db,
      { businessId: id, websiteUrl: 'https://alphaclinic.pk' },
      { fetchImpl: countingFetch(RICH_PAGE, counter), dnsLookup: publicDns },
    );
    assert.equal(rec.status, 'reachable');
    assert.equal(counter.calls, 1, 'enrichment never triggers an extra fetch');

    const row = businessRow(id);
    assert.equal(row.email, 'info@alphaclinic.pk', 'first valid mailto filled');
    assert.equal(row.phone_e164, '+923001112233', 'first valid tel filled');
    assert.equal(row.phone_raw, '+923001112233');

    // Evidence BEFORE fill: every valid candidate is recorded, with the page.
    const emailRows = verifications(id, 'email');
    const phoneRows = verifications(id, 'phone');
    assert.deepEqual(
      emailRows.map((r) => r.value).sort(),
      ['appointments@alphaclinic.pk', 'info@alphaclinic.pk'],
    );
    assert.deepEqual(
      phoneRows.map((r) => r.value).sort(),
      ['+923001112233', '+923214445566'],
    );
    for (const r of [...emailRows, ...phoneRows]) {
      assert.equal(r.state, 'verified');
      assert.equal(r.method, 'website_analysis');
      assert.equal(r.evidence, rec.finalUrl, 'evidence is the page the value came from');
    }

    // Timeline entry only because a field was actually filled.
    const events = enrichedInteractions(id);
    assert.equal(events.length, 1);
    assert.match(events[0]!.summary, /filled email \+ phone/);
    const evidence = JSON.parse(events[0]!.evidence_json ?? '{}') as { method?: string; filled?: string[] };
    assert.equal(evidence.method, 'website_analysis');
    assert.deepEqual(evidence.filled, ['email', 'phone']);
  });

  test('existing contact details are never overwritten (gap-fill only)', async () => {
    const id = makeLead({
      websiteUrl: 'https://alphaclinic.pk',
      email: 'owner@existing.pk',
      phone: '03001112223',
    });
    const before = businessRow(id);
    const counter = { calls: 0 };
    const rec = await analyzeWebsite(
      db,
      { businessId: id, websiteUrl: 'https://alphaclinic.pk' },
      { fetchImpl: countingFetch(RICH_PAGE, counter), dnsLookup: publicDns },
    );
    assert.equal(rec.status, 'reachable');

    const after = businessRow(id);
    assert.equal(after.email, before.email, 'email untouched');
    assert.equal(after.phone_e164, before.phone_e164, 'phone untouched');

    // The observed candidates are still recorded as evidence (observed != applied).
    assert.ok(verifications(id, 'email').some((r) => r.value === 'info@alphaclinic.pk'));
    assert.ok(verifications(id, 'phone').some((r) => r.value === '+923001112233'));

    // Nothing was filled => no "enriched" timeline entry.
    assert.equal(enrichedInteractions(id).length, 0);
  });

  test('invalid candidates are never applied (noreply, dates, order numbers)', async () => {
    const id = makeLead({ websiteUrl: 'https://junk.pk' });
    const junkPage = `<html><body>
      <a href="mailto:noreply@junk.pk">auto</a>
      <a href="tel:12345">x</a>
      <p>Ordered 2026-01-01, ref 123456789012</p>
    </body></html>`;
    const result = enrichLeadContacts(db, {
      businessId: id,
      ...extractContacts(junkPage),
      evidenceUrl: 'https://junk.pk/',
      method: 'website_analysis',
    });
    assert.equal(result.emailCandidates, 0, 'noreply is a machine mailbox');
    assert.equal(result.phoneCandidates, 0, 'bare digit strings are not phones');
    assert.equal(result.recorded, 0, 'no evidence rows for unusable values');
    assert.equal(result.emailFilled, false);
    assert.equal(result.phoneFilled, false);

    const row = businessRow(id);
    assert.equal(row.email, null, 'nothing invented');
    assert.equal(row.phone_e164, null, 'nothing invented');
    assert.equal(verifications(id, 'email').length, 0);
    assert.equal(verifications(id, 'phone').length, 0);
    assert.equal(enrichedInteractions(id).length, 0);
  });

  test('enrichLeadContacts reports honestly for a missing lead', () => {
    assert.throws(
      () =>
        enrichLeadContacts(db, {
          businessId: 'biz_does_not_exist',
          emails: ['x@y.pk'],
          phones: [],
          evidenceUrl: 'https://x.pk',
          method: 'http_fetch',
        }),
      /not found/i,
    );
  });
});

describe('Phase 4: enrichment during discovery (autoAnalyze)', () => {
  test('a discovered lead gains contact details from its own website', async () => {
    // Fresh settings: one city, auto-analyze ON, no auto-score, no network
    // beyond the injected fixture transport.
    const policy: DiscoveryPolicy = {
      categories: ['clinic'],
      cities: ['Karachi'],
      maxPerRun: 10,
      autoAnalyze: true,
      autoScore: false,
    };
    db.prepare(
      `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
       VALUES ('discovery_policy', ?, 1, NULL, ?)
       ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
    ).run(JSON.stringify(policy), nowIso());

    const hit: DiscoveryHit = {
      name: 'Discovered Clinic',
      city: 'Karachi',
      phone: '+923219998877',
      website: 'https://discovered-clinic.pk',
      sourceUrl: 'https://www.openstreetmap.org/node/555',
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
    const registry = {
      discovery: {
        key: 'discovery',
        label: 'Lead discovery',
        status: () => status,
        search: async (_q: DiscoveryQuery) => [hit],
      },
    } as unknown as AdapterRegistry;

    const counter = { calls: 0 };
    const run = await runDiscovery(
      db,
      cfg,
      registry,
      { categories: ['clinic'], cities: ['Karachi'], analyzeFetchOptions: { fetchImpl: countingFetch(RICH_PAGE, counter), dnsLookup: publicDns } },
      owner,
    );
    assert.equal(run.created, 1);
    assert.equal(run.analyzed, 1);
    assert.equal(counter.calls, 1, 'one fetch: analysis and enrichment share it');

    const created = db.prepare("SELECT id FROM businesses WHERE display_name = 'Discovered Clinic'").get() as { id: string };
    const row = businessRow(created.id);
    assert.equal(row.email, 'info@alphaclinic.pk', 'OSM lead without email gained one from its site');
    assert.equal(row.phone_e164, '+923219998877', 'the OSM phone wins — enrichment never overwrites');
    assert.ok(verifications(created.id, 'email').some((r) => r.method === 'website_analysis'));
  });
});

describe('Phase 4: enrichment through the verify endpoint', () => {
  let server: TestServer;
  let ownerClient: TestClient;

  before(async () => {
    server = await startTestServer({}, { fetchImpl: countingFetch(RICH_PAGE, { calls: 0 }) });
    const seeded = await seedOwner(server, { email: 'owner@enrich.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);
  });

  after(async () => {
    await server.close();
  });

  test('POST /api/leads/:id/verify applies enrichment (injected transport)', async () => {
    const created = createLead(
      server.db,
      { displayName: 'Verify Me Clinic', city: 'Karachi', websiteUrl: 'https://alphaclinic.pk' },
      owner,
    );

    const res = await ownerClient.request<{
      ok: boolean;
      state: string;
      emails: string[];
      phones: string[];
      enrichment: { emailFilled: boolean; phoneFilled: boolean; recorded: number };
    }>(`/api/leads/${created.id}/verify`, { method: 'POST', body: {} });

    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.state, 'verified');
    assert.ok(res.body.emails.includes('info@alphaclinic.pk'));
    assert.equal(res.body.enrichment.emailFilled, true, 'lead had no email — it is now filled');
    assert.equal(res.body.enrichment.phoneFilled, true, 'lead had no phone — it is now filled');
    assert.equal(res.body.enrichment.recorded, 4, '4 valid candidates recorded as evidence');

    const row = server.db
      .prepare('SELECT email, phone_e164 FROM businesses WHERE id = ?')
      .get(created.id) as { email: string | null; phone_e164: string | null };
    assert.equal(row.email, 'info@alphaclinic.pk');
    assert.equal(row.phone_e164, '+923001112233');

    // Second verify: everything already set => evidence re-recorded, no overwrite.
    const again = await ownerClient.request<{ enrichment: { emailFilled: boolean; phoneFilled: boolean } }>(
      `/api/leads/${created.id}/verify`,
      { method: 'POST', body: {} },
    );
    assert.equal(again.status, 200, again.raw);
    assert.equal(again.body.enrichment.emailFilled, false, 'gap-fill only on repeat runs');
    const after = server.db.prepare('SELECT email FROM businesses WHERE id = ?').get(created.id) as { email: string };
    assert.equal(after.email, 'info@alphaclinic.pk', 'value unchanged');
  });
});
