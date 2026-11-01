/**
 * API acceptance tests for Phase 4: website analysis, explainable scoring,
 * contact eligibility, and the suppression list.
 *
 * The analysis endpoints are exercised against non-existent test hostnames, so
 * the fetcher's DNS resolution fails and the result is honestly recorded as
 * `unreachable`/`blocked` — never as a fabricated page. This also proves the
 * SSRF guard refuses private hosts before any request is made.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface AnalysisBody {
  id: string;
  status: string;
  title: string | null;
  notMeasured: string[];
  opportunities: { code: string; evidence: string }[];
}
interface ScoreBody {
  score: number;
  band: string;
  summary: string;
  factors: { code: string; label: string; points: number; state: string; evidence: string | null }[];
}
interface EligibilityBody {
  decision: string;
  checks: { code: string; result: string }[];
  reasons: string[];
}
interface LeadRef {
  id: string;
}

let server: TestServer;
let ownerClient: TestClient;
let staffClient: TestClient;
let anonymous: TestClient;
let csrfToken: string;

/** Create a lead directly and return its id. */
async function makeLead(overrides: Record<string, unknown> = {}): Promise<string> {
  const res = await ownerClient.post<LeadRef>('/api/leads', {
    displayName: 'API Test Business',
    city: 'Karachi',
    phone: '03001234567',
    ...overrides,
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

describe('phase 4 API', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@phase4.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);
    csrfToken = ownerClient.csrfToken ?? '';

    const { createUser } = await import('../../src/domain/auth/service.ts');
    await createUser(
      server.db,
      server.config,
      { email: 'staff@phase4.test', password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: seeded.user.id, label: 'owner' },
    );
    staffClient = await loginAs(server, 'staff@phase4.test', 'Staff-Password-123!');
    anonymous = server.client();
  });
  after(async () => {
    await server.close();
  });

  test('analysis requires authentication', async () => {
    const res = await anonymous.post<ErrorBody>('/api/leads/does-not-exist/analyze', {});
    assert.equal(res.status, 401);
  });

  test('analysing a lead with no website returns no_website, not an error', async () => {
    const id = await makeLead({ displayName: 'No Site Co', websiteUrl: null });
    const res = await ownerClient.post<AnalysisBody>(`/api/leads/${id}/analyze`, {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.status, 'no_website');
    assert.ok(res.body.notMeasured.length > 0, 'the honesty list must be returned');
  });

  test('analysing an unreachable host records unreachable, never a fabricated page', async () => {
    const id = await makeLead({ displayName: 'Down Site Co', websiteUrl: 'https://nonexistent-host-xyz.invalid' });
    const res = await ownerClient.post<AnalysisBody>(`/api/leads/${id}/analyze`, {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.status, 'unreachable');
    assert.equal(res.body.title, null, 'no title may be invented for an unreachable host');
  });

  test('a private host is blocked before any request is made (SSRF guard)', async () => {
    const id = await makeLead({ displayName: 'Internal Co', websiteUrl: 'http://127.0.0.1:9200/_cat/indices' });
    const res = await ownerClient.post<AnalysisBody>(`/api/leads/${id}/analyze`, {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.status, 'blocked');
  });

  test('scoring returns six explainable factors and projects onto the lead', async () => {
    const id = await makeLead({ displayName: 'Scored Co', websiteUrl: null });
    const res = await ownerClient.post<ScoreBody>(`/api/leads/${id}/score`, {});
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.body.score >= 0 && res.body.score <= 100);
    assert.equal(res.body.factors.length, 6);
    for (const f of res.body.factors) {
      assert.ok(f.code && f.label, 'each factor needs a code and label');
      assert.ok(['measured', 'stated', 'estimated', 'unknown'].includes(f.state));
    }
    // an unknown budget must be marked unknown, not scored
    const budget = res.body.factors.find((f) => f.code === 'budget');
    assert.ok(budget);
    assert.equal(budget.state, 'unknown');
    assert.equal(budget.points, 0);
  });

  test('a published phone alone does NOT authorise outreach (eligibility)', async () => {
    const id = await makeLead({ displayName: 'Consent Unknown Co', phone: '03001112223' });
    const res = await ownerClient.post<EligibilityBody>(`/api/leads/${id}/eligibility`, { channel: 'call' });
    assert.equal(res.status, 200, res.raw);
    assert.notEqual(res.body.decision, 'eligible', 'public contact details alone must not grant permission');
    const consent = res.body.checks.find((c) => c.code === 'consent_recorded');
    assert.ok(consent);
    assert.equal(consent.result, 'unknown');
  });

  test('an owner-added suppression blocks a channel and is audited', async () => {
    const id = await makeLead({ displayName: 'Suppressed Co', phone: '03009998887' });
    const sup = await ownerClient.post<{ id: string; deduped: boolean }>(`/api/leads/${id}/suppression`, {
      scope: 'business',
      reason: 'opt_out',
      evidence: 'said stop on the call',
    });
    assert.equal(sup.status, 201, sup.raw);
    assert.equal(sup.body.deduped, false);

    const d = await ownerClient.post<EligibilityBody>(`/api/leads/${id}/eligibility`, { channel: 'call' });
    assert.equal(d.body.decision, 'ineligible');
    const check = d.body.checks.find((c) => c.code === 'not_suppressed');
    assert.ok(check);
    assert.equal(check.result, 'fail');

    const again = await ownerClient.post<{ deduped: boolean }>(`/api/leads/${id}/suppression`, {
      scope: 'business',
      reason: 'opt_out',
    });
    assert.equal(again.body.deduped, true, 'suppression is idempotent per (business, reason)');
  });

  test('staff cannot add a suppression record (owner-only)', async () => {
    const id = await makeLead({ displayName: 'Staff Suppression Co', phone: '03005556667' });
    const res = await staffClient.post<ErrorBody>(`/api/leads/${id}/suppression`, {
      scope: 'business',
      reason: 'do_not_contact',
    });
    assert.equal(res.status, 403);
  });

  test('state-changing phase 4 endpoints require CSRF', async () => {
    const id = await makeLead({ displayName: 'CSRF Co' });
    const res = await ownerClient.request<ErrorBody>(`/api/leads/${id}/analyze`, {
      method: 'POST',
      body: {},
      csrf: false,
      headers: { 'x-csrf-token': '' },
    });
    assert.equal(res.status, 403);
  });

  test('eligibility for a channel with no usable destination is ineligible', async () => {
    const id = await makeLead({ displayName: 'No Email Co', email: null });
    const res = await ownerClient.post<EligibilityBody>(`/api/leads/${id}/eligibility`, { channel: 'email' });
    assert.equal(res.body.decision, 'ineligible');
    const dest = res.body.checks.find((c) => c.code === 'has_destination');
    assert.ok(dest);
    assert.equal(dest.result, 'fail');
  });

  test('analysis and score are readable back for a lead', async () => {
    const id = await makeLead({ displayName: 'Readback Co', websiteUrl: null });
    await ownerClient.post(`/api/leads/${id}/score`, {});
    const score = await ownerClient.get<{ latest: ScoreBody | null }>(`/api/leads/${id}/score`);
    assert.equal(score.status, 200);
    assert.ok(score.body.latest, 'a stored score must be readable');

    const analysis = await ownerClient.get<{ latest: AnalysisBody | null; history: AnalysisBody[] }>(
      `/api/leads/${id}/analysis`,
    );
    assert.equal(analysis.status, 200);
    // no analysis run yet -> both null/empty, not fabricated
    assert.equal(analysis.body.latest, null);
    assert.deepEqual(analysis.body.history, []);
  });

  test('csrfToken is available for the suite', () => {
    assert.ok(csrfToken.length > 0);
  });
});
