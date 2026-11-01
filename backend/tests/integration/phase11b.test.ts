/**
 * Phase 11B integration tests: provider onboarding, live-mode guardrails,
 * opt-in unsuppression review, the live media pipeline and the scheduled
 * health job.
 *
 * Safety properties proven here:
 *  - live mode CANNOT be enabled until the telephony integration is verified
 *    through a free probe; every activation writes an auditable record and
 *    returning to simulation stamps the revert;
 *  - onboarding records outcomes only — never credentials — and an
 *    unconfigured/disabled integration stays `pending` (no network, no fake
 *    success);
 *  - suppression lifting is owner-only, reason-mandatory, append-only
 *    (the row and evidence survive; eligibility ignores it) and a lifted row
 *    never swallows a later genuine opt-out;
 *  - the media pipeline refuses to fabricate: no speech provider => no
 *    transcript, no AI provider => no reply; opt-out transcripts suppress;
 *  - the health job probes every integration for free and stays silent when
 *    healthy.
 *
 * All provider access goes through mock adapters or an injected fake fetch:
 * no test can reach a real network.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { recordInteraction } from '../../src/domain/pipeline/interactions.ts';
import {
  suppress,
  suppressionCount,
  isSuppressedPhone,
  listSuppression,
} from '../../src/domain/eligibility/service.ts';
import { listLiftCandidates, reviewSuppression, listSuppressionReviews } from '../../src/domain/eligibility/unsuppress.ts';
import { getOnboarding, getOnboardingState, recordOnboardingVerification } from '../../src/domain/integrations/onboarding.ts';
import { setMode, getOperatingState, latestActivation, summarise } from '../../src/domain/state/service.ts';
import {
  startConversation,
  ingestProspectAudio,
  ingestProspectText,
  generateAgentReply,
  finishConversation,
} from '../../src/domain/media/pipeline.ts';
import { healthCheckJob } from '../../src/jobs/health.ts';
import { buildRegistry, type AdapterRegistry } from '../../src/adapters/registry.ts';
import type { FetchLike } from '../../src/adapters/types.ts';

const MOCK_ENV = {
  TELEPHONY_PROVIDER: 'mock',
  // Credential presence is presence-based: all four vars must be set for the
  // provider to report `configured`. Values are obviously fake test strings;
  // the mock adapter itself performs zero network regardless.
  TELEPHONY_ACCOUNT_SID: 'mock-account-sid',
  TELEPHONY_AUTH_TOKEN: 'mock-auth-token-11b',
  TELEPHONY_FROM_NUMBER: '+92213334455',
  WHATSAPP_PROVIDER: 'mock',
  AI_PROVIDER: 'mock',
  STT_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock',
  EMAIL_PROVIDER: 'mock',
  DISCOVERY_PROVIDER: 'mock',
};

const owner = { userId: null, label: 'owner' as const };
const staff = { userId: null, label: 'staff' as const };

let db: DB;
let cfg: Config;
let registry: AdapterRegistry;

function makeLead(phone: string): string {
  return createLead(db, { displayName: `11B Co ${phone}`, city: 'Karachi', phone }, owner).id;
}

describe('Phase 11B: onboarding, guardrails, unsuppression, media, health', () => {
  before(() => {
    cfg = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(48, '0'),
      DATABASE_PATH: ':memory:',
      ...MOCK_ENV,
    });
    db = openDatabase(':memory:');
    runMigrations(db);
    registry = buildRegistry(cfg, MOCK_ENV);
  });
  after(() => db.close());

  // ------------------------------------------------------------ onboarding --

  test('all six integrations start as pending onboarding', () => {
    const state = getOnboardingState(db);
    assert.deepEqual(Object.keys(state).sort(), ['ai', 'discovery', 'email', 'speech', 'telephony', 'whatsapp']);
    for (const rec of Object.values(state)) {
      assert.equal(rec.state, 'pending', `${rec.integration} must start pending`);
      assert.equal(rec.verifiedAt, null);
    }
  });

  test('a free probe records verified onboarding — outcome only, no credentials', async () => {
    const { record, probe } = await recordOnboardingVerification(db, cfg, registry, 'telephony', owner);
    assert.equal(probe.ok, true);
    assert.equal(record.state, 'verified');
    assert.equal(record.provider, 'mock');
    assert.ok(record.verifiedAt, 'verified_at must be stamped');

    // The persisted row must never contain anything credential-like.
    const row = db.prepare('SELECT * FROM provider_onboardings WHERE integration = ?').get('telephony') as Record<string, unknown>;
    const serialized = JSON.stringify(row);
    assert.ok(!/token|secret|password|authorization/i.test(serialized), `no credential material: ${serialized}`);

    // Audited: who verified, when, which integration.
    const audit = db
      .prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'integration.onboarded' AND entity_id = 'telephony'`)
      .get() as { c: number };
    assert.equal(audit.c, 1);
  });

  test('an unconfigured integration stays pending — no fake verification, no network', async () => {
    const bareCfg = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(48, '0'),
      DATABASE_PATH: ':memory:',
      // no provider env at all
    });
    const bare = buildRegistry(bareCfg, {});
    const { record, probe } = await recordOnboardingVerification(db, bareCfg, bare, 'whatsapp', owner);
    assert.equal(probe.ok, false);
    assert.equal(probe.state, 'unconfigured');
    assert.equal(record.state, 'pending', 'not configured is "not yet", not a failure');
  });

  test('rejected credentials record a failed onboarding (fake fetch, no network)', async () => {
    const reject401: FetchLike = async () =>
      new Response(JSON.stringify({ message: 'Authentication failed' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    const env = {
      TELEPHONY_PROVIDER: 'twilio',
      TELEPHONY_ACCOUNT_SID: 'ACrejected',
      TELEPHONY_AUTH_TOKEN: 'rejected-token',
      TELEPHONY_FROM_NUMBER: '+922111111111',
    };
    const badCfg = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(48, '0'),
      DATABASE_PATH: ':memory:',
      ...env,
    });
    const bad = buildRegistry(badCfg, env, { fetchImpl: reject401 });
    const { record, probe } = await recordOnboardingVerification(db, badCfg, bad, 'telephony', {
      userId: null,
      label: 'owner',
    });
    assert.equal(probe.ok, false);
    assert.equal(record.state, 'failed', 'presented-but-rejected credentials are a failure');
    // Still no secrets persisted.
    const row = db.prepare('SELECT detail FROM provider_onboardings WHERE integration = ?').get('telephony') as { detail: string };
    assert.ok(!row.detail.includes('rejected-token'), 'the auth token must never be persisted');
  });

  // ---------------------------------------------------------- live gating ---

  test('live mode is blocked until telephony onboarding is verified', async () => {
    // Reset onboarding to pending for this scenario.
    db.prepare(`UPDATE provider_onboardings SET state = 'pending' WHERE integration = 'telephony'`).run();
    assert.equal(getOnboarding(db, 'telephony').state, 'pending');

    const telephonyCfg = { ...cfg }; // mock telephony => "configured"
    assert.throws(
      () => setMode(db, telephonyCfg, 'live', owner),
      (err: { code?: string }) => err.code === 'blocked_by_safeguard',
      'unverified telephony must block live mode',
    );
    assert.equal(getOperatingState(db).mode, 'simulation', 'mode must stay simulation');

    // Verify through the real onboarding path, then live works.
    await recordOnboardingVerification(db, cfg, registry, 'telephony', owner);
    const state = setMode(db, telephonyCfg, 'live', owner);
    assert.equal(state.mode, 'live');

    // The activation record captures the checks that passed.
    const activation = latestActivation(db);
    assert.ok(activation, 'live activation must be recorded');
    assert.equal(activation.checks['telephonyVerified'], true);
    assert.equal(activation.checks['ownerRole'], true);
    assert.equal(activation.revertedAt, null);

    // Returning to simulation stamps the revert (append-only, row kept).
    const back = setMode(db, telephonyCfg, 'simulation', owner);
    assert.equal(back.mode, 'simulation');
    const reverted = latestActivation(db);
    assert.ok(reverted?.revertedAt, 'revert must be stamped');
    assert.equal(reverted.id, activation.id, 'the same record is stamped, not replaced');
  });

  test('staff can never enable live mode', () => {
    assert.throws(
      () => setMode(db, cfg, 'live', staff),
      (err: { code?: string }) => err.code === 'forbidden',
    );
    assert.equal(getOperatingState(db).mode, 'simulation');
  });

  // ---------------------------------------------------------- unsuppression --

  test('lift candidates need BOTH an active suppression and inbound opt-in evidence', () => {
    const optedOut = makeLead('03001112201');
    const noEvidence = makeLead('03001112202');
    suppress(db, { businessId: optedOut, scope: 'business', reason: 'opt_out', source: 'message', evidence: 'STOP' });
    suppress(db, { businessId: noEvidence, scope: 'business', reason: 'opt_out', source: 'message', evidence: 'no evidence' });

    // No opt-in yet: neither is a candidate.
    assert.equal(listLiftCandidates(db).length, 0);

    // Inbound opt-in arrives: only the opted-out lead qualifies.
    recordInteraction(db, {
      businessId: optedOut,
      kind: 'whatsapp_message',
      direction: 'inbound',
      summary: 'Inbound WhatsApp OPT-IN: "please call me again"',
      outcome: 'opt_in_received',
      evidence: { optIn: true },
    });
    const candidates = listLiftCandidates(db);
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]!.businessId, optedOut);
    assert.ok(candidates[0]!.optInSummary.includes('OPT-IN'));

    // A consent interaction also counts as evidence.
    recordInteraction(db, {
      businessId: noEvidence,
      kind: 'consent',
      direction: 'inbound',
      summary: 'agreed to be contacted by phone',
    });
    assert.equal(listLiftCandidates(db).length, 2);
  });

  test('review decisions are owner-only, reason-mandatory and append-only', () => {
    const bizId = makeLead('03001112203');
    const sup = suppress(db, { businessId: bizId, scope: 'business', reason: 'opt_out', source: 'message', evidence: 'STOP calling' });
    assert.equal(sup.deduped, false);

    // Staff cannot review.
    assert.throws(
      () => reviewSuppression(db, sup.id, 'lifted', 'opt-in received later', staff),
      (err: { code?: string }) => err.code === 'forbidden',
    );
    // A real reason is mandatory.
    assert.throws(
      () => reviewSuppression(db, sup.id, 'lifted', 'no', owner),
      (err: { code?: string }) => err.code === 'validation_failed',
    );
    // Unknown suppression -> 404.
    assert.throws(
      () => reviewSuppression(db, 'sup_missing', 'lifted', 'some reason', owner),
      (err: { code?: string }) => err.code === 'not_found',
    );

    const before = suppressionCount(db);

    // Owner lifts with a reason.
    const review = reviewSuppression(db, sup.id, 'lifted', 'Prospect sent explicit opt-in on WhatsApp', owner);
    assert.equal(review.decision, 'lifted');

    // Append-only: the row and its evidence SURVIVE.
    const rows = listSuppression(db, bizId);
    assert.equal(rows.length, 1, 'the suppression row must never be deleted');
    assert.equal(rows[0]!.evidence, 'STOP calling', 'evidence must be preserved');
    assert.ok(rows[0]!.lifted_at, 'the row is marked, not removed');

    // Eligibility now ignores it.
    assert.equal(isSuppressedPhone(db, '03001112203'), false, 'lifted suppression must not gate');
    assert.equal(suppressionCount(db), before - 1, 'active count drops by one');

    // Audited + review history.
    const audit = db
      .prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'suppression.lifted' AND entity_id = ?`)
      .get(sup.id) as { c: number };
    assert.equal(audit.c, 1);
    assert.equal(listSuppressionReviews(db).length, 1);

    // Double-lift is refused (already reviewed).
    assert.throws(
      () => reviewSuppression(db, sup.id, 'lifted', 'again', owner),
      (err: { code?: string }) => err.code === 'conflict',
    );
  });

  test('a lifted suppression never swallows a later genuine opt-out', () => {
    const bizId = makeLead('03001112204');
    const first = suppress(db, { businessId: bizId, scope: 'business', reason: 'opt_out', source: 'message', evidence: 'stop' });
    reviewSuppression(db, first.id, 'lifted', 'opted back in', owner);
    assert.equal(isSuppressedPhone(db, '03001112204'), false);

    // The prospect opts out AGAIN: a NEW active row must be created.
    const second = suppress(db, { businessId: bizId, scope: 'business', reason: 'opt_out', source: 'message', evidence: 'stop again' });
    assert.equal(second.deduped, false, 'a lifted row must not dedupe a fresh opt-out');
    assert.notEqual(second.id, first.id);
    assert.equal(isSuppressedPhone(db, '03001112204'), true, 'the new opt-out is active');

    // Both rows still exist (append-only history).
    const rows = listSuppression(db, bizId);
    assert.equal(rows.length, 2);
  });

  test('keeping a suppression records the decision without touching the row', () => {
    const bizId = makeLead('03001112205');
    const sup = suppress(db, { businessId: bizId, scope: 'business', reason: 'do_not_contact', source: 'owner', evidence: 'manual' });
    const review = reviewSuppression(db, sup.id, 'kept', 'Do-not-contact outranks a casual opt-in', owner);
    assert.equal(review.decision, 'kept');
    const rows = listSuppression(db, bizId);
    assert.equal(rows[0]!.lifted_at ?? null, null, 'kept rows stay active');
    assert.equal(isSuppressedPhone(db, '03001112205'), true);
  });

  // --------------------------------------------------------- media pipeline --

  test('media pipeline runs a full conversation lifecycle with honest segments', async () => {
    const bizId = makeLead('03001112206');
    const deps = { speech: registry.speech, ai: registry.ai };

    const conversationId = startConversation(db, cfg, { businessId: bizId });
    const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as {
      language: string;
      ai_identity_disclosed: number;
      transcript_state: string;
    };
    assert.equal(conv.ai_identity_disclosed, 1, 'AI disclosure is on by default');
    assert.ok(['ur', 'roman_ur', 'en', 'mixed', 'unknown'].includes(conv.language));
    assert.equal(conv.transcript_state, 'none');

    // Prospect audio -> STT segment (source 'stt').
    const audio = new Uint8Array([1, 2, 3, 4, 5]);
    const spoken = await ingestProspectAudio(db, deps, conversationId, { audio, mimeType: 'audio/wav' });
    assert.ok(spoken.text.length > 0);
    let seg = db.prepare(`SELECT * FROM transcript_segments WHERE conversation_id = ? AND speaker = 'prospect'`).get(conversationId) as {
      source: string;
      text: string;
    };
    assert.equal(seg.source, 'stt');

    // Typed prospect turn also works (source 'typed').
    ingestProspectText(db, conversationId, 'We are interested in a new website');
    const partial = db.prepare('SELECT transcript_state FROM conversations WHERE id = ?').get(conversationId) as {
      transcript_state: string;
    };
    assert.equal(partial.transcript_state, 'partial', 'segments move the transcript to partial');

    // Agent reply: engine turn + TTS audio (mock speech synthesises WAV bytes).
    const reply = await generateAgentReply(db, cfg, deps, conversationId);
    assert.ok(reply.text.length > 0);
    assert.equal(reply.model, 'mock-model');
    assert.ok(reply.audio && reply.audio.byteLength > 0, 'TTS audio must be produced when speech is wired');
    assert.equal(reply.contentType, 'audio/wav');
    const agentSeg = db.prepare(`SELECT source FROM transcript_segments WHERE conversation_id = ? AND speaker = 'agent'`).get(
      conversationId,
    ) as { source: string };
    assert.equal(agentSeg.source, 'typed', 'generated replies are text, not transcribed speech');

    // Finish: qualification extracted, transcript closed, lead updated.
    const result = await finishConversation(db, conversationId);
    assert.ok(result.segmentCount >= 3, `expected at least 3 segments, got ${result.segmentCount}`);
    assert.equal(result.qualification.qualification, 'needs_review', 'mock reply carries needs_review');
    const finished = db.prepare('SELECT * FROM conversations WHERE id = ?').get(conversationId) as {
      transcript_state: string;
      extracted_json: string;
      summary: string;
      ended_at: string | null;
    };
    assert.equal(finished.transcript_state, 'complete');
    assert.ok(finished.ended_at);
    assert.ok(finished.summary.includes('Live conversation'));
    const extracted = JSON.parse(finished.extracted_json) as { simulated: boolean; qualification: string };
    assert.equal(extracted.simulated, false, 'live conversations are never labelled simulated');
    const lead = db.prepare('SELECT qualification_status FROM businesses WHERE id = ?').get(bizId) as {
      qualification_status: string;
    };
    assert.equal(lead.qualification_status, 'needs_review');

    // A finished conversation refuses further turns.
    await assert.rejects(
      () => generateAgentReply(db, cfg, deps, conversationId),
      (err: { code?: string }) => err.code === 'conflict',
    );
  });

  test('missing speech/AI providers refuse honestly — nothing is fabricated', async () => {
    const bizId = makeLead('03001112207');
    const conversationId = startConversation(db, cfg, { businessId: bizId });
    const empty = { speech: null, ai: null };

    await assert.rejects(
      () => ingestProspectAudio(db, empty, conversationId, { audio: new Uint8Array([9]) }),
      (err: { code?: string }) => err.code === 'provider_unavailable',
      'no speech provider must not invent transcript text',
    );
    await assert.rejects(
      () => generateAgentReply(db, cfg, empty, conversationId),
      (err: { code?: string }) => err.code === 'provider_unavailable',
      'no AI provider must not invent a reply',
    );
    const segs = db.prepare('SELECT COUNT(*) c FROM transcript_segments WHERE conversation_id = ?').get(conversationId) as {
      c: number;
    };
    assert.equal(segs.c, 0, 'failed operations leave no phantom segments');
  });

  test('an opt-out expressed on the call suppresses the lead (append-only)', async () => {
    const bizId = makeLead('03001112208');
    const conversationId = startConversation(db, cfg, { businessId: bizId });
    ingestProspectText(db, conversationId, 'STOP calling me, do not call this number again');

    const before = suppressionCount(db);
    const result = await finishConversation(db, conversationId);
    assert.equal(result.qualification.interestLevel, 'opted_out');
    assert.equal(result.suppressed, true, 'the opt-out must create a suppression');
    assert.equal(suppressionCount(db), before + 1);
    assert.equal(isSuppressedPhone(db, '03001112208'), true);
  });

  test('a prospect asking for a human is flagged for handoff', async () => {
    const bizId = makeLead('03001112209');
    const conversationId = startConversation(db, cfg, { businessId: bizId });
    ingestProspectText(db, conversationId, 'Please have a human from your team call me back');
    const result = await finishConversation(db, conversationId);
    assert.equal(result.humanRequested, true, 'human handoff request must be recorded');
    const conv = db.prepare('SELECT human_requested FROM conversations WHERE id = ?').get(conversationId) as {
      human_requested: number;
    };
    assert.equal(conv.human_requested, 1);
  });

  // --------------------------------------------------------------- health ----

  test('the health job probes every integration and stays silent when healthy', async () => {
    const run = (await healthCheckJob.run({
      db,
      config: cfg,
      logger: nullLogger,
      guard: summarise(db),
      now: new Date(),
      adapters: registry,
    })) as { detail?: string } | undefined;
    assert.equal(run, undefined, 'a fully healthy run records no job_runs detail (no churn)');

    // Every integration got a persisted health record from the free probes.
    const rows = db.prepare('SELECT integration, ok FROM integration_health').all() as {
      integration: string;
      ok: number;
    }[];
    assert.equal(rows.length, 6, 'all six integrations were probed');
    assert.ok(
      rows.every((r) => r.ok === 1),
      'mock probes are honest successes',
    );
  });

  test('the health job runs without outreach being enabled (simulation default)', () => {
    // The job definition must NOT require outreach: health is always observable.
    assert.equal('requiresOutreachEnabled' in healthCheckJob ? healthCheckJob.requiresOutreachEnabled : false, false);
    assert.ok(healthCheckJob.intervalMs >= 60_000, 'probes are not more frequent than once a minute');
  });

  test('the health job reports configured-integration failures with detail', async () => {
    const failing = buildRegistry(cfg, {
      ...MOCK_ENV,
      TELEPHONY_PROVIDER: 'twilio',
      TELEPHONY_ACCOUNT_SID: 'ACfailing',
      TELEPHONY_AUTH_TOKEN: 'failing-token',
      TELEPHONY_FROM_NUMBER: '+922111111111',
    }, {
      fetchImpl: async () =>
        new Response(JSON.stringify({ message: 'boom' }), { status: 401, headers: { 'content-type': 'application/json' } }),
    });
    const run = (await healthCheckJob.run({
      db,
      config: cfg,
      logger: nullLogger,
      guard: summarise(db),
      now: new Date(),
      adapters: failing,
    })) as { detail?: string } | undefined;
    assert.ok(run?.detail, 'a failing configured integration must be reported');
    assert.match(run!.detail!, /telephony/);
  });
});
