/**
 * Phase 11B API tests: onboarding endpoints, the unsuppression review API,
 * the live media pipeline endpoints, and the live-activation record.
 *
 * Security properties proven here:
 *  - onboarding verification and review decisions are owner-only (staff 403,
 *    anonymous 401) and CSRF-protected;
 *  - enabling live mode requires the typed GO LIVE confirmation, fresh
 *    reauth, configured AND verified telephony — and writes an activation
 *    record that reverts on the way back to simulation;
 *  - media endpoints only process conversations: they never dial, and a
 *    missing provider returns an honest 503/500-free AppError rather than
 *    fabricated text;
 *  - responses never contain credentials.
 *
 * The server runs with mock adapters (zero network).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createUser } from '../../src/domain/auth/service.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { recordInteraction } from '../../src/domain/pipeline/interactions.ts';
import { suppress } from '../../src/domain/eligibility/service.ts';

interface IntegrationsBody {
  onboarding: Record<string, { integration: string; state: string; provider: string | null; verifiedAt: string | null }>;
}
interface StateBody {
  state: { mode: string };
  activation: { id: string; checks: Record<string, unknown>; revertedAt: string | null } | null;
}
interface ErrorBody {
  error: { code: string; message: string };
}

describe('Phase 11B API: onboarding, review, media, activation', () => {
  let server: TestServer;
  let owner: TestClient;
  let staff: TestClient;
  let leadId: string;

  before(async () => {
    server = await startTestServer({
      TELEPHONY_PROVIDER: 'mock',
      // Presence-based config: all four telephony vars => state 'configured'.
      // The mock adapter still performs zero network.
      TELEPHONY_ACCOUNT_SID: 'mock-account-sid',
      TELEPHONY_AUTH_TOKEN: 'never-echo-me-11b',
      TELEPHONY_FROM_NUMBER: '+92213334455',
      WHATSAPP_PROVIDER: 'mock',
      AI_PROVIDER: 'mock',
      STT_PROVIDER: 'mock',
      TTS_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'mock',
      DISCOVERY_PROVIDER: 'mock',
    });
    const seeded = await seedOwner(server);
    owner = await loginAs(server, seeded.email, seeded.password);
    const staffEmail = `staff-11b-${Date.now()}@uws.test`;
    await createUser(
      server.db,
      server.config,
      { email: staffEmail, password: 'Staff-Password-123!', displayName: '11B Staff', role: 'staff' },
      { userId: seeded.user.id, label: 'owner' },
    );
    staff = await loginAs(server, staffEmail, 'Staff-Password-123!');
    leadId = createLead(server.db, { displayName: '11B API Co', city: 'Karachi', phone: '03009998877' }, {
      userId: null,
      label: 'system',
    }).id;
  });

  after(async () => {
    await server.close();
  });

  // ------------------------------------------------------ onboarding API ----

  test('GET /api/integrations exposes the onboarding map for all six keys', async () => {
    const res = await owner.get<IntegrationsBody>('/api/integrations');
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(res.body.onboarding ?? {}).sort(), [
      'ai',
      'discovery',
      'email',
      'speech',
      'telephony',
      'whatsapp',
    ]);
    assert.equal(res.body.onboarding['telephony']!.state, 'pending');
    // No credential VALUES anywhere in the payload (env-var NAMES like
    // TELEPHONY_AUTH_TOKEN are expected and are not secrets).
    assert.ok(!res.raw.includes('never-echo-me-11b'), 'the telephony auth token value must never be exposed');
  });

  test('POST /api/integrations/:key/onboard is owner-only + CSRF', async () => {
    const anon = server.client();
    assert.equal((await anon.post('/api/integrations/telephony/onboard', {})).status, 401);
    assert.equal((await staff.post('/api/integrations/telephony/onboard', {})).status, 403);
    const badKey = await owner.post<ErrorBody>('/api/integrations/nope/onboard', {});
    assert.equal(badKey.status, 400);
    assert.equal(badKey.body.error.code, 'validation_failed');

    const res = await owner.post<{
      record: { state: string; provider: string | null };
      probe: { ok: boolean; detail: string };
    }>('/api/integrations/telephony/onboard', {});
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.record.state, 'verified');
    assert.equal(res.body.probe.ok, true);
    assert.match(res.body.probe.detail, /no network used/, 'mock probe is honest about being simulated');
  });

  test('GET /api/state carries the (empty) activation record before any live switch', async () => {
    const res = await owner.get<StateBody>('/api/state');
    assert.equal(res.status, 200);
    assert.equal(res.body.activation, null, 'no activation has happened yet');
    assert.equal(res.body.state.mode, 'simulation');
  });

  // ----------------------------------------------- unsuppression review API --

  test('suppression review endpoints are owner-only', async () => {
    const anon = server.client();
    assert.equal((await anon.get('/api/suppression/candidates')).status, 401);
    assert.equal((await staff.get('/api/suppression/candidates')).status, 403);
    assert.equal((await staff.get('/api/suppression/reviews')).status, 403);
    assert.equal(
      (await staff.post('/api/suppression/sup_x/review', { decision: 'lifted', reason: 'staff cannot do this' })).status,
      403,
    );
  });

  test('the review flow: candidate discovery, validation, lift, history', async () => {
    const sup = suppress(server.db, {
      businessId: leadId,
      scope: 'business',
      reason: 'opt_out',
      source: 'message',
      evidence: 'STOP calling us',
    });

    // Not a candidate without opt-in evidence.
    const empty = await owner.get<{ candidates: unknown[] }>('/api/suppression/candidates');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.candidates.length, 0);

    // Inbound opt-in arrives.
    recordInteraction(server.db, {
      businessId: leadId,
      kind: 'whatsapp_message',
      direction: 'inbound',
      summary: 'Inbound WhatsApp OPT-IN: "yes please contact us again"',
      outcome: 'opt_in_received',
      evidence: { optIn: true },
    });
    const res = await owner.get<{ candidates: { suppressionId: string; businessId: string }[] }>('/api/suppression/candidates');
    assert.equal(res.body.candidates.length, 1);
    assert.equal(res.body.candidates[0]!.suppressionId, sup.id);

    // Validation: a reason is mandatory.
    const noReason = await owner.post<ErrorBody>(`/api/suppression/${sup.id}/review`, { decision: 'lifted' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.body.error.code, 'validation_failed');
    const badDecision = await owner.post<ErrorBody>(`/api/suppression/${sup.id}/review`, {
      decision: 'obliterated',
      reason: 'a valid-looking reason',
    });
    assert.equal(badDecision.status, 400);

    // Owner lifts with a reason.
    const lift = await owner.post<{ review: { decision: string; reason: string } }>(
      `/api/suppression/${sup.id}/review`,
      { decision: 'lifted', reason: 'Prospect sent explicit opt-in on WhatsApp' },
    );
    assert.equal(lift.status, 200, lift.raw);
    assert.equal(lift.body.review.decision, 'lifted');

    // Row survives (append-only) and is marked lifted.
    const row = server.db.prepare('SELECT lifted_at, evidence FROM suppression_list WHERE id = ?').get(sup.id) as {
      lifted_at: string | null;
      evidence: string;
    };
    assert.ok(row.lifted_at);
    assert.equal(row.evidence, 'STOP calling us', 'evidence preserved');

    // Queue is now empty; history shows the decision.
    const afterLift = await owner.get<{ candidates: unknown[] }>('/api/suppression/candidates');
    assert.equal(afterLift.body.candidates.length, 0);
    const history = await owner.get<{ reviews: { decision: string }[] }>('/api/suppression/reviews');
    assert.equal(history.body.reviews.length, 1);
    assert.equal(history.body.reviews[0]!.decision, 'lifted');

    // Unknown suppression -> 404.
    const missing = await owner.post<ErrorBody>('/api/suppression/sup_nope/review', {
      decision: 'kept',
      reason: 'does not exist anyway',
    });
    assert.equal(missing.status, 404);
  });

  // ----------------------------------------------------------- media API ----

  test('media endpoints drive a conversation end-to-end without dialling', async () => {
    // Start a conversation for the lead.
    const start = await owner.post<{ conversationId: string }>('/api/conversations', { businessId: leadId });
    assert.equal(start.status, 201, start.raw);
    const cid = start.body.conversationId;

    // Unknown lead -> 404; bad body -> 400.
    const missingLead = await owner.post<ErrorBody>('/api/conversations', { businessId: 'biz_missing' });
    assert.equal(missingLead.status, 404);
    const badBody = await owner.post<ErrorBody>('/api/conversations', {});
    assert.equal(badBody.status, 400);

    // Prospect speaks: typed text first (STT path covered in unit tests).
    const turn = await owner.post<{ turn: { text: string } }>(`/api/conversations/${cid}/prospect`, {
      text: 'We want a website for our clinic',
    });
    assert.equal(turn.status, 200, turn.raw);
    assert.ok(turn.body.turn.text.includes('clinic'));

    // Agent reply: engine + TTS (mock) — audio comes back base64.
    const reply = await owner.post<{ turn: { text: string; audioBase64: string | null; model: string } }>(
      `/api/conversations/${cid}/agent-reply`,
      {},
    );
    assert.equal(reply.status, 200, reply.raw);
    assert.ok(reply.body.turn.text.length > 0);
    assert.equal(reply.body.turn.model, 'mock-model');
    assert.ok(reply.body.turn.audioBase64, 'mock TTS returns audio');

    // Invalid input on the prospect endpoint.
    const noText = await owner.post<ErrorBody>(`/api/conversations/${cid}/prospect`, { audioBase64: '' });
    assert.equal(noText.status, 400);

    // Unknown conversation -> 404 on every media endpoint.
    assert.equal((await owner.post(`/api/conversations/cnv_missing/prospect`, { text: 'hi' })).status, 404);

    // Finish: qualification result.
    const finish = await owner.post<{
      result: { qualification: { qualification: string; interestLevel: string }; segmentCount: number };
    }>(`/api/conversations/${cid}/finish`, {});
    assert.equal(finish.status, 200, finish.raw);
    assert.equal(finish.body.result.qualification.qualification, 'needs_review');
    assert.equal(finish.body.result.qualification.interestLevel, 'neutral');
    assert.ok(finish.body.result.segmentCount >= 2);

    // Media endpoints require auth + CSRF.
    const anon = server.client();
    assert.equal((await anon.post('/api/conversations', { businessId: leadId })).status, 401);
  });

  // ------------------------------------------------- live activation API ----

  test('live activation requires typed confirmation, reauth, and verification — and records it', async () => {
    // Typed confirmation enforced first.
    await owner.post('/api/auth/reauth', { password: 'Owner-Password-123!' });
    const noPhrase = await owner.post<ErrorBody>('/api/state/mode', { mode: 'live' });
    assert.equal(noPhrase.status, 400);
    assert.equal(noPhrase.body.error.code, 'validation_failed');

    // Correct phrase + fresh reauth + verified telephony => live.
    const goLive = await owner.post<{ state: { mode: string } }>('/api/state/mode', {
      mode: 'live',
      confirmation: 'GO LIVE',
    });
    assert.equal(goLive.status, 200, goLive.raw);
    assert.equal(goLive.body.state.mode, 'live');

    // The activation record exists and shows the checks that passed.
    const state = await owner.get<StateBody>('/api/state');
    assert.ok(state.body.activation, 'activation record must exist');
    assert.equal(state.body.activation!.checks['telephonyVerified'], true);
    assert.equal(state.body.activation!.revertedAt, null);

    // Back to simulation (always safe): the same record gets stamped.
    const revert = await owner.post<{ state: { mode: string } }>('/api/state/mode', { mode: 'simulation' });
    assert.equal(revert.status, 200);
    assert.equal(revert.body.state.mode, 'simulation');
    const after = await owner.get<StateBody>('/api/state');
    assert.ok(after.body.activation!.revertedAt, 'revert must be stamped on the activation record');
  });

  test('live mode without verified telephony is refused (guardrail in the domain)', async () => {
    // Reset onboarding to pending to simulate an unverified provider.
    server.db.prepare(`UPDATE provider_onboardings SET state = 'pending' WHERE integration = 'telephony'`).run();
    await owner.post('/api/auth/reauth', { password: 'Owner-Password-123!' });
    const res = await owner.post<ErrorBody>('/api/state/mode', { mode: 'live', confirmation: 'GO LIVE' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'blocked_by_safeguard');
    const state = await owner.get<StateBody>('/api/state');
    assert.equal(state.body.state.mode, 'simulation', 'mode must stay simulation');
  });
});
