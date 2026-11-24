/**
 * Phase 6: scoring stays in step with free enrichment and analysis.
 *
 * The score is only ever a projection of current evidence — but two free
 * actions change that evidence AFTER a score was stored:
 *   - lead verify  -> contact enrichment fills phone/email (contactability)
 *   - analyse      -> a fresh analysis supersedes the website-gap evidence
 * Both routes therefore REFRESH an existing score (a new lead_scores row,
 * history preserved) and never CREATE one: creating a score remains the
 * explicit Score action. Every fetch goes through the injected transport —
 * zero real network.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import type { FetchLike } from '../../src/adapters/http.ts';

interface ScoreFactor {
  code: string;
  label: string;
  points: number;
  rawValue: string;
  state: string;
  evidence: string | null;
}
interface ScoreBody {
  id: string;
  score: number;
  band: string;
  factors: ScoreFactor[];
}
interface ScoreEnvelope {
  latest: ScoreBody | null;
}

const RICH_PAGE = `<html><head><title>Phase 6 Clinic</title></head><body>
  <a href="mailto:info@phase6clinic.pk">Email us</a>
  <a href="tel:+923001112233">Call</a>
</body></html>`;

/**
 * URL-aware fake: a hard failure for "down-site", otherwise RICH_PAGE with
 * contact details made UNIQUE per fetch — two live leads may not share a
 * phone (partial unique index), which is exactly how the real world works:
 * each business publishes its own number.
 */
let fetchSeq = 0;
const fetchImpl: FetchLike = (async (input: unknown) => {
  const url = String(input instanceof Request ? input.url : input);
  if (url.includes('down-site')) throw new Error('network down');
  fetchSeq += 1;
  const page = RICH_PAGE.replace('info@phase6clinic.pk', `info${fetchSeq}@phase6clinic.pk`).replace(
    '+923001112233',
    `+9230011122${String(fetchSeq).padStart(2, '0')}`,
  );
  return new Response(page, { status: 200, headers: { 'content-type': 'text/html' } });
}) as unknown as FetchLike;

function factor(score: ScoreBody, code: string): ScoreFactor {
  const f = score.factors.find((x) => x.code === code);
  assert.ok(f, `factor ${code} present`);
  return f;
}

let server: TestServer;
let ownerClient: TestClient;
const owner = { userId: null, label: 'owner' as const };

describe('Phase 6: score refresh on free evidence changes', () => {
  before(async () => {
    server = await startTestServer({}, { fetchImpl });
    const seeded = await seedOwner(server, { email: 'owner@phase6.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);
  });
  after(async () => {
    await server.close();
  });

  test('verify enrichment refreshes an existing score: contactability catches up', async () => {
    // Distinct website host per test: createLead dedupes by website_host.
    const lead = createLead(
      server.db,
      { displayName: 'Phase6 Refresh Co', city: 'Karachi', websiteUrl: 'https://refresh-co.pk' },
      owner,
    );

    const first = await ownerClient.post<ScoreBody>(`/api/leads/${lead.id}/score`, {});
    assert.equal(first.status, 200, first.raw);
    const before = factor(first.body, 'contactability');
    assert.equal(before.points, 0, 'no contact detail on the lead yet');
    assert.equal(before.rawValue, 'none');
    assert.equal(before.state, 'measured');

    const verify = await ownerClient.post<{ enrichment: { emailFilled: boolean; phoneFilled: boolean } }>(
      `/api/leads/${lead.id}/verify`,
      {},
    );
    assert.equal(verify.status, 200, verify.raw);
    assert.equal(verify.body.enrichment.emailFilled, true, 'email filled from the page');
    assert.equal(verify.body.enrichment.phoneFilled, true, 'phone filled from the page');

    const readback = await ownerClient.get<ScoreEnvelope>(`/api/leads/${lead.id}/score`);
    const latest = readback.body.latest;
    assert.ok(latest, 'the refreshed score is readable');
    assert.notEqual(latest.id, first.body.id, 'a fresh score row supersedes the stale one (history kept)');

    const after = factor(latest, 'contactability');
    assert.equal(after.rawValue, 'phone,email', 'both enriched channels are counted');
    assert.equal(after.points, 15, 'two channels = full contactability weight (0.15 -> 15)');
    assert.equal(latest.score, first.body.score + 15, 'exactly the contactability gain — no other factor moved');
    assert.equal(latest.factors.length, 6, 'still the six explainable factors');
  });

  test('verify never CREATES a score (the Score action owns that)', async () => {
    const lead = createLead(
      server.db,
      { displayName: 'Phase6 No Score Co', city: 'Karachi', websiteUrl: 'https://noscore-co.pk' },
      owner,
    );

    const verify = await ownerClient.post<{ enrichment: { emailFilled: boolean; phoneFilled: boolean } }>(
      `/api/leads/${lead.id}/verify`,
      {},
    );
    assert.equal(verify.status, 200, verify.raw);
    assert.equal(verify.body.enrichment.emailFilled, true, 'enrichment really happened');

    const score = await ownerClient.get<ScoreEnvelope>(`/api/leads/${lead.id}/score`);
    assert.equal(score.body.latest, null, 'no score may appear as a side effect of verifying');
  });

  test('a FAILED verify leaves the stored score untouched', async () => {
    const lead = createLead(
      server.db,
      { displayName: 'Phase6 Down Site Co', city: 'Karachi', websiteUrl: 'https://down-site.pk' },
      owner,
    );
    const first = await ownerClient.post<ScoreBody>(`/api/leads/${lead.id}/score`, {});
    assert.equal(first.status, 200, first.raw);

    const verify = await ownerClient.post<{ ok: boolean }>(`/api/leads/${lead.id}/verify`, {});
    assert.equal(verify.status, 200, verify.raw);
    assert.equal(verify.body.ok, false, 'the fetch failed honestly');

    const readback = await ownerClient.get<ScoreEnvelope>(`/api/leads/${lead.id}/score`);
    assert.equal(readback.body.latest?.id, first.body.id, 'no evidence changed -> no new score');
  });

  test('analysing refreshes a stored score: website-gap evidence catches up', async () => {
    // `.invalid` never resolves (offline-safe): the analysis records an
    // honest `unreachable`, which still supersedes "no analysis yet".
    const lead = createLead(
      server.db,
      { displayName: 'Phase6 Analyze Co', city: 'Karachi', websiteUrl: 'https://score-refresh-site.invalid' },
      owner,
    );
    const first = await ownerClient.post<ScoreBody>(`/api/leads/${lead.id}/score`, {});
    assert.equal(first.status, 200, first.raw);
    const gapBefore = factor(first.body, 'website_gap');
    assert.equal(gapBefore.state, 'unknown');
    assert.match(gapBefore.evidence ?? '', /no analysis has been run/);

    const analysis = await ownerClient.post<{ status: string }>(`/api/leads/${lead.id}/analyze`, {});
    assert.equal(analysis.status, 200, analysis.raw);
    assert.equal(analysis.body.status, 'unreachable', 'no page was fabricated for an unreachable host');

    const readback = await ownerClient.get<ScoreEnvelope>(`/api/leads/${lead.id}/score`);
    const latest = readback.body.latest;
    assert.ok(latest, 'the refreshed score is readable');
    assert.notEqual(latest.id, first.body.id, 'analysis evidence supersedes the stored score');

    const gapAfter = factor(latest, 'website_gap');
    assert.equal(gapAfter.state, 'unknown', 'an unreachable site still yields no conclusion');
    assert.match(gapAfter.evidence ?? '', /could not be analysed \(status: unreachable\)/);
    assert.equal(gapAfter.points, 0, 'points unchanged — only the evidence text moved');
    assert.equal(latest.score, first.body.score, 'no other factor changed');
  });

  test('analysing does not create a score either', async () => {
    const lead = createLead(
      server.db,
      { displayName: 'Phase6 Analyze No Score Co', city: 'Karachi', websiteUrl: 'https://analyze-noscore.invalid' },
      owner,
    );
    const analysis = await ownerClient.post<{ status: string }>(`/api/leads/${lead.id}/analyze`, {});
    assert.equal(analysis.status, 200, analysis.raw);
    const score = await ownerClient.get<ScoreEnvelope>(`/api/leads/${lead.id}/score`);
    assert.equal(score.body.latest, null, 'analysis alone never mints a score');
  });
});
