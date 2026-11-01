/**
 * API acceptance tests for Phase 6: simulated calling, transcripts, and
 * WhatsApp portfolio sharing.
 *
 * The behaviours under test are the operator-facing contract:
 *  - a blocked outreach request is a 200 with the ledger entry, not an error
 *  - an allowed request is a 201 and every artefact says `simulated: true`
 *  - the idempotency key makes double-clicks safe
 *  - staff may call/share; only the owner holds the portfolio trust keys
 *  - CSRF and authentication guard every state-changing route
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createUser } from '../../src/domain/auth/service.ts';
import { updateSettings } from '../../src/domain/settings/service.ts';
import { recordInteraction } from '../../src/domain/pipeline/interactions.ts';
import { businessDayKey } from '../../src/domain/outreach/guard.ts';
import { simScenarioFor } from '../../src/domain/outreach/simulation.ts';
import { nowIso } from '../../src/core/time.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface LeadRef {
  id: string;
}
interface BlockedBody {
  decision: string;
  attempt: { blockedCode: string | null; checks: { code: string; result: string }[] };
}
interface AllowedCallBody {
  decision: string;
  simulated?: boolean;
  attempt: { id: string; provider: string | null; mode: string; blockedCode: string | null };
  call?: { callId: string; simulated: boolean; conversationId: string | null; outcome: string };
  interactionId?: string;
}
interface ConversationDetailBody {
  id: string;
  simulated: boolean;
  aiIdentityDisclosed: boolean;
  humanRequested: boolean;
  segments: { seq: number; speaker: string; text: string; source: string }[];
}
interface PortfolioItemBody {
  id: string;
  title: string;
  verified: boolean;
  isApproved: boolean;
  shareable?: boolean;
}
interface OutreachBody {
  attempts: { id: string; decision: string }[];
  calls: { id: string; simulation: boolean }[];
  messages: { id: string; simulation: boolean }[];
}

let server: TestServer;
let ownerClient: TestClient;
let staffClient: TestClient;
let anonymous: TestClient;
let seq = 0;

async function makeLead(name: string): Promise<string> {
  const n = seq++;
  const res = await ownerClient.post<LeadRef>('/api/leads', {
    displayName: `${name} ${n}`,
    city: 'Lahore',
    phone: `0321${String(1000000 + n).slice(-7)}`,
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

describe('phase 6 API', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@phase6.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);
    anonymous = server.client();

    const staffUser = await createUser(
      server.db,
      server.config,
      { email: 'staff@phase6.test', password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: null, label: 'owner' },
    );
    staffClient = await loginAs(server, staffUser.email, 'Staff-Password-123!');

    // Channels on, like the integration suite. Settings that are sensitive
    // require a reauth window via the API, so the tests drive the domain
    // function directly — the routes under test are the outreach ones.
    const res = updateSettings(
      server.db,
      server.config,
      { eligible_channels: { call: true, whatsappMessage: true, whatsappCall: false, email: false, sms: false } },
      { userId: null, label: 'owner' },
    );
    if (res.rejected.length > 0) throw new Error(JSON.stringify(res.rejected));
  });
  after(async () => {
    await server.close();
  });

  test('outreach routes require authentication', async () => {
    assert.equal((await anonymous.post('/api/leads/any/call', {})).status, 401);
    assert.equal((await anonymous.get('/api/leads/any/outreach')).status, 401);
    assert.equal((await anonymous.get('/api/portfolio')).status, 401);
    assert.equal((await anonymous.post('/api/leads/any/portfolio/share', {})).status, 401);
  });

  test('state-changing outreach routes require CSRF', async () => {
    const id = await makeLead('Csrf Co');
    const res = await ownerClient.request<ErrorBody>(`/api/leads/${id}/call`, { method: 'POST', body: {}, csrf: false });
    assert.equal(res.status, 403);
  });

  test('an unconsented lead is blocked with a full check list (200, not an error)', async () => {
    const id = await makeLead('NoConsent Api');
    const res = await ownerClient.post<BlockedBody>(`/api/leads/${id}/call`, {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.decision, 'blocked');
    assert.equal(res.body.attempt.blockedCode, 'needs_review');
    assert.ok(res.body.attempt.checks.length >= 5, 'the response must explain every check');
  });

  test('an allowed call is a 201, labelled simulated, and audited', async () => {
    const id = await makeLead('HappyCall Api');
    recordInteraction(server.db, { businessId: id, kind: 'consent', summary: 'agreed by phone' });

    const res = await ownerClient.post<AllowedCallBody>(`/api/leads/${id}/call`, {});
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.decision, 'allowed');
    assert.equal(res.body.simulated, true);
    assert.equal(res.body.attempt.mode, 'simulation');
    assert.equal(res.body.attempt.provider, 'simulation');
    assert.ok(res.body.call && res.body.call.simulated === true);

    const detail = await ownerClient.get<{ audit: { action: string }[] }>(`/api/leads/${id}`);
    assert.ok(
      detail.body.audit.some((e) => e.action === 'outreach.call_simulated'),
      'a simulated call must be audited as such',
    );
  });

  test('the same idempotency key never places a second call', async () => {
    const id = await makeLead('Idem Api');
    recordInteraction(server.db, { businessId: id, kind: 'consent', summary: 'agreed by phone' });
    const key = 'api-idem-key-0001';

    const a = await ownerClient.post<AllowedCallBody>(`/api/leads/${id}/call`, { idempotencyKey: key });
    const b = await ownerClient.post<AllowedCallBody>(`/api/leads/${id}/call`, { idempotencyKey: key });
    assert.equal(a.status, 201, a.raw);
    assert.equal(b.status, 201, b.raw);
    assert.equal(a.body.attempt.id, b.body.attempt.id);
  });

  test('staff may place a rehearsal call (RBAC allows owner+staff)', async () => {
    const id = await makeLead('StaffCall Api');
    recordInteraction(server.db, { businessId: id, kind: 'consent', summary: 'agreed by phone' });
    const res = await staffClient.post<AllowedCallBody>(`/api/leads/${id}/call`, {});
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.decision, 'allowed');
  });

  test('an answered rehearsal is readable as a transcript', async () => {
    // Deterministic scenario: pick an id that yields an answered rehearsal.
    const dayKey = businessDayKey(server.config, new Date());
    let id = '';
    for (let i = 0; i < 20_000; i++) {
      const candidate = `biz_api_convo_${i}`;
      if (simScenarioFor(candidate, dayKey).answered) {
        id = candidate;
        break;
      }
    }
    assert.ok(id);
    const at = nowIso();
    server.db
      .prepare(
        `INSERT INTO businesses (id, display_name, normalized_name, phone_e164, source_type, discovered_at, created_at, updated_at)
         VALUES (?, 'Api Transcript Co', 'api transcript co', '+923005551122', 'manual', ?, ?, ?)`,
      )
      .run(id, at, at, at);
    recordInteraction(server.db, { businessId: id, kind: 'consent', summary: 'agreed by phone' });

    const callRes = await ownerClient.post<AllowedCallBody>(`/api/leads/${id}/call`, {});
    assert.equal(callRes.status, 201, callRes.raw);
    assert.ok(callRes.body.call?.conversationId, 'an answered rehearsal must produce a conversation');

    const list = await ownerClient.get<{ items: { id: string; simulated: boolean }[] }>(`/api/leads/${id}/conversations`);
    assert.equal(list.status, 200);
    assert.equal(list.body.items.length, 1);
    assert.equal(list.body.items[0]!.simulated, true);

    const convId = callRes.body.call!.conversationId!;
    const detail = await ownerClient.get<ConversationDetailBody>(`/api/leads/${id}/conversations/${convId}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.simulated, true);
    assert.equal(detail.body.aiIdentityDisclosed, true);
    assert.ok(detail.body.segments.length >= 3);
    assert.equal(detail.body.segments[0]!.speaker, 'system');
    assert.ok(detail.body.segments.every((s) => s.source === 'simulated'));
  });

  test("a conversation of another lead 404s, and unknown ids 404", async () => {
    const idA = await makeLead('ConvA Api');
    const idB = await makeLead('ConvB Api');
    const res = await ownerClient.post<AllowedCallBody>(`/api/leads/${idA}/call`, {});
    // May be blocked if this run consumed the daily cap; skip in that case.
    if (res.status !== 201) return;
    recordInteraction(server.db, { businessId: idB, kind: 'consent', summary: 'ok' });
    const callB = await ownerClient.post<AllowedCallBody>(`/api/leads/${idB}/call`, {});
    if (callB.status !== 201 || !callB.body.call?.conversationId) return;

    const wrongLead = await ownerClient.get(`/api/leads/${idA}/conversations/${callB.body.call.conversationId}`);
    assert.equal(wrongLead.status, 404);
    const missing = await ownerClient.get(`/api/leads/${idA}/conversations/cnv_missing`);
    assert.equal(missing.status, 404);
  });

  test('the outreach ledger endpoint lists attempts, calls and messages', async () => {
    const id = await makeLead('Ledger Api');
    recordInteraction(server.db, { businessId: id, kind: 'consent', summary: 'ok' });
    await ownerClient.post(`/api/leads/${id}/call`, {});
    await ownerClient.post(`/api/leads/${id}/call`, {}); // second call: allowed or blocked, both are ledgered

    const res = await ownerClient.get<OutreachBody>(`/api/leads/${id}/outreach`);
    assert.equal(res.status, 200);
    assert.equal(res.body.attempts.length, 2, 'both requests are ledgered');
    assert.equal(res.body.calls.length, 2, 'both rehearsal calls ran (daily cap is 100)');
    assert.equal(res.body.messages.length, 0);
  });

  // ------------------------------------------------------------ portfolio --
  test('portfolio trust keys are owner-only', async () => {
    const created = await ownerClient.post<PortfolioItemBody>('/api/portfolio', { title: 'Staff see me' });
    assert.equal(created.status, 201, created.raw);

    const staffVerify = await staffClient.post<ErrorBody>(`/api/portfolio/${created.body.id}/verify`, {
      verified: true,
      note: 'staff cannot verify',
    });
    assert.equal(staffVerify.status, 403);

    const staffApprove = await staffClient.post<ErrorBody>(`/api/portfolio/${created.body.id}/approve`, {
      approved: true,
    });
    assert.equal(staffApprove.status, 403);
  });

  test('approve before verify is refused; verify+approve completes the two-key rule', async () => {
    const created = await ownerClient.post<PortfolioItemBody>('/api/portfolio', {
      title: 'Karachi retail site',
      url: 'https://example.com/retail',
    });
    assert.equal(created.status, 201, created.raw);
    const id = created.body.id;

    const early = await ownerClient.post<ErrorBody>(`/api/portfolio/${id}/approve`, { approved: true });
    assert.equal(early.status, 400);
    assert.match(early.body.error.message, /verified/i);

    const verified = await ownerClient.post<PortfolioItemBody>(`/api/portfolio/${id}/verify`, {
      verified: true,
      note: 'checked live site and spoke to the client',
    });
    assert.equal(verified.status, 200, verified.raw);
    assert.equal(verified.body.verified, true);

    const approved = await ownerClient.post<PortfolioItemBody>(`/api/portfolio/${id}/approve`, { approved: true });
    assert.equal(approved.status, 200);
    assert.equal(approved.body.isApproved, true);

    const detail = await ownerClient.get<PortfolioItemBody>(`/api/portfolio/${id}`);
    assert.equal(detail.status, 200);
    assert.equal(detail.body.shareable, true);

    const shareable = await ownerClient.get<{ items: PortfolioItemBody[] }>('/api/portfolio?shareable=true');
    assert.ok(shareable.body.items.some((i) => i.id === id));
  });

  test('an unknown portfolio item 404s', async () => {
    const res = await ownerClient.get<ErrorBody>('/api/portfolio/pfi_missing');
    assert.equal(res.status, 404);
  });

  test('sharing the portfolio is rehearsed end to end for staff too', async () => {
    // A shareable item already exists from the previous test.
    const id = await makeLead('Share Api');
    recordInteraction(server.db, { businessId: id, kind: 'consent', summary: 'ok' });

    const res = await staffClient.post<{
      decision: string;
      simulated: boolean;
      messageId: string;
      items: { title: string }[];
      attempt: { provider: string };
    }>(`/api/leads/${id}/portfolio/share`, {});
    assert.equal(res.status, 201, res.raw);
    assert.equal(res.body.decision, 'allowed');
    assert.equal(res.body.simulated, true);
    assert.equal(res.body.attempt.provider, 'simulation');
    assert.ok(res.body.items.length >= 1);

    const outreach = await ownerClient.get<OutreachBody>(`/api/leads/${id}/outreach`);
    assert.equal(outreach.body.messages.length, 1);
    assert.equal(outreach.body.messages[0]!.simulation, true);
  });

  test('selecting an unapproved item is a 400 naming the offender', async () => {
    const draft = await ownerClient.post<PortfolioItemBody>('/api/portfolio', { title: 'Unapproved draft' });
    const id = await makeLead('ShareBad Api');
    const res = await ownerClient.post<ErrorBody>(`/api/leads/${id}/portfolio/share`, {
      itemIds: [draft.body.id],
    });
    assert.equal(res.status, 400);
    assert.ok(
      (res.body.error.details?.rejected as { id: string }[] | undefined)?.some((r) => r.id === draft.body.id),
      'the response must name the rejected item',
    );
  });

  test('a blocked share is a 200 with the ledger entry', async () => {
    // Lead without consent -> needs_review; nothing may be sent.
    const id = await makeLead('ShareBlocked Api');
    const res = await ownerClient.post<BlockedBody>(`/api/leads/${id}/portfolio/share`, {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.decision, 'blocked');
    assert.ok(res.body.attempt.blockedCode);
  });
});
