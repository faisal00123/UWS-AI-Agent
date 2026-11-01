/**
 * Phase 4 integration tests: website analysis persistence, explainable lead
 * scoring, and the contact-eligibility gate.
 *
 * No real network is used: the fetcher accepts an injected transport, and the
 * SSRF guard still runs because it happens before the transport is called.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { analyzeWebsite, latestAnalysis } from '../../src/domain/analysis/service.ts';
import { isPrivateAddress } from '../../src/domain/analysis/fetcher.ts';
import { recordScore, latestScore } from '../../src/domain/scoring/service.ts';
import { evaluateEligibility, suppress, isSuppressedPhone, listSuppression } from '../../src/domain/eligibility/service.ts';
import { createLead } from '../../src/domain/leads/repository.ts';

let db: DB;
let cfg: Config;

function makeLead(overrides: Record<string, unknown> = {}): string {
  const res = createLead(
    db,
    {
      displayName: 'Test Business',
      city: 'Karachi',
      phone: '03001234567',
      ...(overrides as Record<string, string | null>),
    },
    { userId: null, label: 'owner' },
  );
  return res.id;
}

/** Build a fetch stub returning a fixed HTML page. */
function htmlFetch(html: string, contentType = 'text/html'): typeof fetch {
  return (async () =>
    new Response(html, {
      status: 200,
      headers: { 'content-type': contentType },
    })) as unknown as typeof fetch;
}

/** A DNS stub resolving any hostname to a public address (93.184.216.34). */
const publicDns = async (): Promise<{ address: string }[]> => [{ address: '93.184.216.34' }];

describe('website analysis', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  after(() => db.close());

  test('a lead with no website is recorded as no_website, not as an error', async () => {
    const id = makeLead({ websiteUrl: null });
    const rec = await analyzeWebsite(db, { businessId: id, websiteUrl: null });
    assert.equal(rec.status, 'no_website');
    assert.ok(rec.errorMessage);
    assert.deepEqual(rec.opportunities, []);
  });

  test('a reachable page stores measured signals and never claims a full audit', async () => {
    const id = makeLead({ websiteUrl: 'https://example-clinic.pk' });
    const rec = await analyzeWebsite(
      db,
      { businessId: id, websiteUrl: 'https://example-clinic.pk' },
      { fetchImpl: htmlFetch('<html><head><title>Clinic</title></head><body><h1>Hi</h1></body></html>'), dnsLookup: publicDns },
    );
    assert.equal(rec.status, 'reachable');
    assert.equal(rec.httpStatus, 200);
    assert.equal(rec.title, 'Clinic');
    assert.equal(rec.h1Count, 1);
    // the honesty list must be persisted so the UI cannot imply an audit
    assert.ok(rec.notMeasured.length > 0);
    assert.ok(rec.notMeasured.some((n) => /performance|Core Web Vitals/i.test(n)));

    const stored = latestAnalysis(db, id);
    assert.equal(stored?.status, 'reachable');
  });

  test('an unreachable site is recorded as unreachable, never as "no website"', async () => {
    const id = makeLead({ websiteUrl: 'https://down-site.pk' });
    const failing = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const rec = await analyzeWebsite(db, { businessId: id, websiteUrl: 'https://down-site.pk' }, { fetchImpl: failing, dnsLookup: publicDns });
    assert.equal(rec.status, 'unreachable');
    assert.equal(rec.title, null);
    assert.ok(rec.errorMessage);
  });

  test('a non-HTML response is blocked rather than parsed as a page', async () => {
    const id = makeLead({ websiteUrl: 'https://binary-file.pk' });
    const rec = await analyzeWebsite(
      db,
      { businessId: id, websiteUrl: 'https://binary-file.pk' },
      { fetchImpl: htmlFetch('{"json":true}', 'application/json'), dnsLookup: publicDns },
    );
    assert.equal(rec.status, 'blocked');
  });

  test('private and reserved addresses are refused (SSRF guard)', () => {
    for (const ip of ['127.0.0.1', '10.0.0.5', '192.168.1.1', '172.16.0.1', '169.254.169.254', '0.0.0.0', '::1', 'fe80::1', 'fd00::1']) {
      assert.equal(isPrivateAddress(ip), true, `${ip} must be treated as private`);
    }
    for (const ip of ['8.8.8.8', '1.1.1.1', '93.184.216.34']) {
      assert.equal(isPrivateAddress(ip), false, `${ip} is a public address`);
    }
  });

  test('a private host is blocked before any request is made', async () => {
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('<html></html>', { status: 200 });
    }) as unknown as typeof fetch;
    const id = makeLead({ websiteUrl: 'http://127.0.0.1:8080/admin' });
    const rec = await analyzeWebsite(db, { businessId: id, websiteUrl: 'http://127.0.0.1:8080/admin' }, { fetchImpl: spy });
    assert.equal(rec.status, 'blocked');
    assert.equal(called, false, 'the transport must never be invoked for a private host');
  });
});

describe('explainable lead scoring', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  after(() => db.close());

  test('every factor is stored with code, label, weight, points, state and evidence', () => {
    const id = makeLead({ websiteUrl: null });
    const scored = recordScore(db, cfg, { businessId: id });

    assert.ok(scored.score >= 0 && scored.score <= 100);
    assert.equal(scored.factors.length, 6);
    for (const f of scored.factors) {
      assert.ok(f.code && f.label, 'factor needs a code and label');
      assert.ok(typeof f.weight === 'number' && f.weight >= 0);
      assert.ok(typeof f.points === 'number');
      assert.ok(['measured', 'stated', 'estimated', 'unknown'].includes(f.state));
    }

    const stored = latestScore(db, id);
    assert.ok(stored, 'score must be persisted');
    assert.equal(stored.factors.length, 6);
    assert.ok(stored.summary.length > 0);
  });

  test('missing evidence scores 0 and is marked unknown, never guessed', () => {
    // A bare lead: no website, no budget, no timeline, no interactions.
    const id = makeLead({ displayName: 'Bare Lead', websiteUrl: null });
    const scored = recordScore(db, cfg, { businessId: id });
    const budget = scored.factors.find((f) => f.code === 'budget');
    const timeline = scored.factors.find((f) => f.code === 'timeline');
    assert.ok(budget, 'budget factor must exist');
    assert.ok(timeline, 'timeline factor must exist');

    assert.equal(budget.state, 'unknown');
    assert.equal(budget.points, 0, 'an unknown budget must contribute nothing');
    assert.equal(timeline.state, 'unknown');
    assert.equal(timeline.points, 0);
  });

  test('a lead with no website scores higher on website gap than one with a clean site', () => {
    const noSite = makeLead({ displayName: 'No Site Co', websiteUrl: null });
    const cleanSite = makeLead({ displayName: 'Clean Site Co', websiteUrl: 'https://clean-site.pk' });

    const a = recordScore(db, cfg, { businessId: noSite });
    const b = recordScore(db, cfg, { businessId: cleanSite });

    const gapA = a.factors.find((f) => f.code === 'website_gap');
    const gapB = b.factors.find((f) => f.code === 'website_gap');
    assert.ok(gapA, 'no-site lead must have a website_gap factor');
    assert.ok(gapB, 'clean-site lead must have a website_gap factor');
    assert.equal(gapA.state, 'measured');
    assert.ok(gapA.points > gapB.points, `no-site gap ${gapA.points} should exceed clean-site gap ${gapB.points}`);
  });

  test('the score is projected onto the lead row for cheap sorting', () => {
    const id = makeLead({ displayName: 'Projection Co', websiteUrl: null });
    recordScore(db, cfg, { businessId: id });
    const row = db.prepare('SELECT score, score_band, score_updated_at FROM businesses WHERE id = ?').get(id) as {
      score: number;
      score_band: string;
      score_updated_at: string;
    };
    assert.ok(row.score !== null);
    assert.ok(['low', 'medium', 'high', 'very_high'].includes(row.score_band));
    assert.ok(row.score_updated_at);
  });
});

describe('contact eligibility gate', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  after(() => db.close());

  test('a published phone number alone does NOT authorise outreach', () => {
    const id = makeLead({ displayName: 'Consent Unknown Co' });
    const d = evaluateEligibility(db, cfg, id, 'call');

    // consent is unknown => never eligible
    assert.notEqual(d.decision, 'eligible', 'public contact details alone must not grant permission');
    const consent = d.checks.find((c) => c.code === 'consent_recorded');
    assert.ok(consent, 'consent sub-check must be present');
    assert.equal(consent.result, 'unknown');
    assert.ok(d.reasons.length > 0);
  });

  test('an opt-out blocks every channel regardless of other signals', () => {
    const id = makeLead({ displayName: 'Opted Out Co', phone: '03009998887' });
    suppress(db, { businessId: id, scope: 'business', reason: 'opt_out', source: 'call', evidence: 'said stop' });

    for (const ch of ['call', 'whatsapp_message', 'email'] as const) {
      const d = evaluateEligibility(db, cfg, id, ch);
      assert.equal(d.decision, 'ineligible', `${ch} must be blocked after an opt-out`);
      const sup = d.checks.find((c) => c.code === 'not_suppressed');
      assert.ok(sup, 'suppression sub-check must be present');
      assert.equal(sup.result, 'fail');
    }
    assert.equal(isSuppressedPhone(db, '03009998887'), true);
  });

  test('a channel the owner has disabled is ineligible', () => {
    const id = makeLead({ displayName: 'Disabled Channel Co' });
    const d = evaluateEligibility(db, cfg, id, 'email');
    const check = d.checks.find((c) => c.code === 'channel_enabled');
    assert.ok(check, 'channel_enabled sub-check must be present');
    assert.equal(check.result, 'fail', 'email is disabled by default');
    assert.equal(d.decision, 'ineligible');
  });

  test('a lead with no usable phone is ineligible for a call', () => {
    const id = makeLead({ displayName: 'No Phone Co', phone: 'not-a-number' });
    const d = evaluateEligibility(db, cfg, id, 'call');
    const dest = d.checks.find((c) => c.code === 'has_destination');
    assert.ok(dest, 'has_destination sub-check must be present');
    assert.equal(dest.result, 'fail');
    assert.equal(d.decision, 'ineligible');
  });

  test('every decision is persisted with its full check set', () => {
    const id = makeLead({ displayName: 'Persisted Decision Co' });
    evaluateEligibility(db, cfg, id, 'call');
    const row = db
      .prepare('SELECT decision, checks_json, reasons_json FROM eligibility_checks WHERE business_id = ? ORDER BY rowid DESC LIMIT 1')
      .get(id) as { decision: string; checks_json: string; reasons_json: string };
    assert.ok(row.decision);
    const checks = JSON.parse(row.checks_json) as unknown[];
    assert.ok(checks.length >= 4, 'all sub-checks must be recorded');
    assert.ok(JSON.parse(row.reasons_json).length >= 1);
  });

  test('suppression is idempotent per (business, reason)', () => {
    const id = makeLead({ displayName: 'Idempotent Sup Co', phone: '03001112223' });
    const first = suppress(db, { businessId: id, scope: 'business', reason: 'do_not_contact', source: 'owner' });
    const second = suppress(db, { businessId: id, scope: 'business', reason: 'do_not_contact', source: 'owner' });
    assert.equal(first.deduped, false);
    assert.equal(second.deduped, true);
    assert.equal(listSuppression(db, id).length, 1);
  });

  test('a merged duplicate record is never eligible for outreach', () => {
    const survivor = makeLead({ displayName: 'Survivor Co', phone: '03005556667' });
    const dup = createLead(
      db,
      { displayName: 'Survivor Co Branch', phone: '+92 300 5556667' },
      { userId: null, label: 'owner' },
    );
    assert.ok(dup.mergedIntoId, 'same phone must merge');
    const d = evaluateEligibility(db, cfg, dup.id, 'call');
    const live = d.checks.find((c) => c.code === 'is_live_record');
    assert.ok(live, 'is_live_record sub-check must be present');
    assert.equal(live.result, 'fail');
    assert.notEqual(d.decision, 'eligible');
    assert.ok(survivor);
  });
});
