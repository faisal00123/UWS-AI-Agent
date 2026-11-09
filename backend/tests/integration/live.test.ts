/**
 * Phase 7 integration tests: LIVE mode execution behind the same guard seam.
 *
 * Live mode is never the default, and these tests prove the safety chain
 * holds when it IS enabled (owner action + configured providers):
 *  - the adapter is called ONLY after the guard passed and the daily counter
 *    was consumed; the ledger row exists before any network I/O
 *  - a provider failure is ledgered as a failed call/message (it still counts
 *    toward the daily cap, like any retry) and the failure timeline entry can
 *    NEVER evidence a customer-facing stage change
 *  - simulation mode with adapters installed calls NOTHING — a configured
 *    provider cannot turn a rehearsal into a real dial
 *  - emergency stop blocks live outreach too
 *  - a second live call while one is in flight is blocked, not double-dialled
 *  - a missing template or missing adapter blocks BEFORE any counter is spent
 *
 * All network access goes through an injected fake fetch: no test can reach a
 * real provider.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { recordInteraction, hasContactEvidence } from '../../src/domain/pipeline/interactions.ts';
import { updateSettings } from '../../src/domain/settings/service.ts';
import { setMode, emergencyStop } from '../../src/domain/state/service.ts';
import { recordOnboardingVerification } from '../../src/domain/integrations/onboarding.ts';
import { businessDayKey, usageSnapshot, effectiveCallLimit } from '../../src/domain/outreach/guard.ts';
import { placeCall, sharePortfolio, type OutreachAdapters } from '../../src/domain/outreach/service.ts';
import { buildRegistry } from '../../src/adapters/registry.ts';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';
import { createPortfolioItem, verifyPortfolioItem, approvePortfolioItem } from '../../src/domain/outreach/portfolio.ts';

const LIVE_ENV = {
  TELEPHONY_PROVIDER: 'twilio',
  TELEPHONY_ACCOUNT_SID: 'AClive',
  TELEPHONY_AUTH_TOKEN: 'live-token',
  TELEPHONY_FROM_NUMBER: '+922111111111',
  WHATSAPP_PROVIDER: 'whatsapp_cloud',
  WHATSAPP_PHONE_NUMBER_ID: '998877',
  WHATSAPP_ACCESS_TOKEN: 'live-wa-token',
  WHATSAPP_APP_SECRET: 'live-app-secret',
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'live-verify',
  WHATSAPP_TEMPLATE_NAME_PORTFOLIO: 'portfolio_v1',
  WHATSAPP_TEMPLATE_LANGUAGE: 'en_US',
  WHATSAPP_BUSINESS_ACCOUNT_ID: '555666',
  PUBLIC_BASE_URL: 'https://uws.example',
};

interface FakeRoute {
  /** Substring or regex matched against the request URL. First match wins. */
  match: string | RegExp;
  status?: number;
  body?: unknown;
}

function fakeFetch(
  reply: { status?: number; body?: unknown; routes?: FakeRoute[] },
): { fetchImpl: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, init });
    const route = reply.routes?.find((r) =>
      typeof r.match === 'string' ? u.includes(r.match) : r.match.test(u),
    );
    const chosen = route ?? reply;
    return new Response(JSON.stringify(chosen.body ?? {}), {
      status: chosen.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

let db: DB;
let cfg: Config;
let fetchState: { fetchImpl: FetchLike; calls: { url: string; init: RequestInit }[] };
let adapters: OutreachAdapters;

const owner = { userId: null, label: 'owner' as const };

let seq = 0;
function makeLead(phone: string): string {
  const n = seq++;
  return createLead(db, { displayName: `Live Co ${n}`, city: 'Karachi', phone }, owner).id;
}

function enableChannels(): void {
  const res = updateSettings(
    db,
    cfg,
    {
      eligible_channels: { call: true, whatsappMessage: true, whatsappCall: false, email: false, sms: false },
    },
    owner,
  );
  if (res.rejected.length > 0) throw new Error(JSON.stringify(res.rejected));
}

function consentTo(bizId: string): void {
  recordInteraction(db, { businessId: bizId, kind: 'consent', summary: 'agreed to be contacted by phone and WhatsApp' });
}

function resetCounters(): void {
  db.prepare('DELETE FROM budget_usage').run();
}

function callsMetric(): number {
  const dayKey = businessDayKey(cfg, new Date());
  return usageSnapshot(db, dayKey, 'calls', effectiveCallLimit(db, cfg)).used;
}

describe('live mode execution', () => {
  before(async () => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:', ...LIVE_ENV });
    db = openDatabase(':memory:');
    runMigrations(db);
    // Phase 11B guardrail: entering live mode requires a VERIFIED telephony
    // onboarding (free connection probe), not merely present credentials.
    // The probe runs on its OWN fake fetch so it never pollutes the dial-call
    // assertions below (which count fetch invocations).
    const verifyFetch = fakeFetch({ body: { sid: 'AClive', status: 'active' } });
    const verifyRegistry = buildRegistry(cfg, LIVE_ENV, { fetchImpl: verifyFetch.fetchImpl });
    const verification = await recordOnboardingVerification(db, cfg, verifyRegistry, 'telephony', owner);
    assert.equal(verification.record.state, 'verified', verification.probe.detail);
    // Credential presence + verified onboarding are what allow the owner to
    // switch the operating mode to live at all.
    setMode(db, cfg, 'live', owner);
    enableChannels();
    fetchState = fakeFetch({ body: { sid: 'CALIVE1', status: 'queued' } });
    const registry = buildRegistry(cfg, LIVE_ENV, { fetchImpl: fetchState.fetchImpl });
    adapters = {
      telephony: registry.telephony,
      whatsapp: registry.whatsapp,
      portfolioTemplate: registry.portfolioTemplate,
      voiceAnswerUrl: registry.voiceAnswerUrl,
    };
    assert.ok(adapters.telephony && adapters.whatsapp, 'the registry must resolve both adapters from the env');
    assert.ok(adapters.voiceAnswerUrl?.endsWith('/api/webhooks/telephony/twilio/voice'));
    assert.equal(adapters.portfolioTemplate?.name, 'portfolio_v1');
  });
  after(() => db.close());

  test('a live call dials through the adapter and is labelled at every level', async () => {
    const biz = makeLead('03001110001');
    consentTo(biz);
    resetCounters();

    const result = await placeCall(db, cfg, { businessId: biz, actor: owner, adapters });

    assert.equal(result.decision, 'allowed');
    assert.ok(result.decision === 'allowed' && !result.simulated, 'a live call is not simulated');
    assert.ok(result.decision === 'allowed' && result.call.provider === 'twilio');
    assert.ok(result.decision === 'allowed' && result.call.scenario === null, 'live calls have no fabricated scenario');
    assert.equal(result.attempt.mode, 'live');
    assert.equal(result.attempt.provider, 'twilio');

    // Exactly one network call, to Twilio, with the right destination and the
    // status-callback URL the webhook router serves.
    assert.equal(fetchState.calls.length, 1);
    const call = fetchState.calls[0]!;
    assert.ok(call.url.includes('/2010-04-01/Accounts/AClive/Calls.json'));
    const body = new URLSearchParams(String(call.init.body));
    assert.equal(body.get('To'), '+923001110001');
    assert.equal(body.get('From'), '+922111111111');
    assert.equal(body.get('Url'), 'https://uws.example/api/webhooks/telephony/twilio/voice');
    assert.equal(body.get('StatusCallback'), 'https://uws.example/api/webhooks/telephony/twilio');

    const row = db.prepare('SELECT * FROM calls WHERE id = ?').get(result.decision === 'allowed' ? result.call.callId : '') as {
      provider: string;
      provider_call_id: string;
      status: string;
      simulation: number;
      counts_against_daily_limit: number;
      daily_bucket: string;
    };
    assert.equal(row.provider, 'twilio');
    assert.equal(row.provider_call_id, 'CALIVE1');
    assert.equal(row.status, 'queued');
    assert.equal(row.simulation, 0, 'a real dial must not carry the simulation flag');
    assert.equal(row.counts_against_daily_limit, 1);

    const inter = db.prepare(`SELECT simulation, outcome FROM interactions WHERE id = ?`).get(
      result.decision === 'allowed' ? result.interactionId : '',
    ) as { simulation: number; outcome: string };
    assert.equal(inter.simulation, 0);
    assert.equal(inter.outcome, 'unknown', 'the outcome is only known when the provider reports it');

    assert.equal(callsMetric(), 1, 'the daily counter was consumed');
  });

  test('a second live call to the same lead is blocked while one is in flight', async () => {
    const biz = db.prepare(`SELECT business_id FROM calls WHERE provider_call_id = 'CALIVE1'`).get() as { business_id: string };
    const before = fetchState.calls.length;

    const result = await placeCall(db, cfg, { businessId: biz.business_id, actor: owner, adapters });

    assert.equal(result.decision, 'blocked');
    assert.equal(result.attempt.blockedCode, 'call_in_progress');
    assert.equal(fetchState.calls.length, before, 'no second dial may happen');
    assert.equal(callsMetric(), 1, 'the daily slot was refunded');
  });

  test('a provider failure is ledgered as a failed call and still counts toward the cap', async () => {
    const biz = makeLead('03001110002');
    consentTo(biz);
    resetCounters();
    // A TelephonyPort fake that raises exactly what the real adapter raises
    // when the vendor rejects the call.
    const failingAdapters: OutreachAdapters = {
      ...adapters,
      telephony: {
        key: 'twilio_failing',
        label: 'Twilio (failing)',
        status: () => ({
          key: 'telephony',
          label: 'Telephony (calls)',
          implementation: 'twilio',
          state: 'configured' as const,
          features: [],
          lastError: null,
        }),
        createCall: async () => {
          throw new AdapterError('provider_error', 'Twilio responded 500: internal error', {
            providerStatus: 500,
            retryable: true,
          });
        },
      },
    };

    await assert.rejects(
      () => placeCall(db, cfg, { businessId: biz, actor: owner, adapters: failingAdapters }),
      (err: unknown) => {
        const e = err as { code?: string; details?: { attemptId?: string; callId?: string } };
        assert.equal(e.code, 'provider_unavailable');
        assert.ok(e.details?.attemptId, 'the failure must reference its ledger row');
        assert.ok(e.details?.callId, 'the failure must reference its failed call row');
        return true;
      },
    );

    const row = db.prepare('SELECT status, outcome, failure_code, simulation FROM calls WHERE business_id = ?').get(biz) as {
      status: string;
      outcome: string;
      failure_code: string;
      simulation: number;
    };
    assert.equal(row.status, 'failed');
    assert.equal(row.outcome, 'failed');
    assert.equal(row.failure_code, 'provider_error');
    assert.equal(row.simulation, 0);

    // The failed attempt is ledgered as allowed (it passed the guard) and the
    // slot is consumed — a retry is a new request, exactly as documented.
    const attempt = db.prepare(`SELECT decision, provider FROM outreach_attempts WHERE business_id = ?`).get(biz) as {
      decision: string;
      provider: string;
    };
    assert.equal(attempt.decision, 'allowed');
    assert.equal(attempt.provider, 'twilio_failing');
    assert.equal(callsMetric(), 1);

    // Safety: a provider rejection can never look like customer contact.
    assert.equal(hasContactEvidence(db, biz), false, 'a failed dial is not contact evidence');
    const inter = db.prepare(`SELECT kind, direction FROM interactions WHERE business_id = ?`).get(biz) as {
      kind: string;
      direction: string;
    };
    assert.equal(inter.kind, 'system');
    assert.equal(inter.direction, 'internal');
  });

  test('emergency stop blocks live outreach before the adapter is touched', async () => {
    const biz = makeLead('03001110003');
    consentTo(biz);
    const before = fetchState.calls.length;
    emergencyStop(db, 'test: stopping everything', owner);
    try {
      const result = await placeCall(db, cfg, { businessId: biz, actor: owner, adapters });
      assert.equal(result.decision, 'blocked');
      assert.equal(result.attempt.blockedCode, 'emergency_stop');
      assert.equal(fetchState.calls.length, before, 'the adapter must not be called under an emergency stop');
    } finally {
      // emergencyStop also pauses; clear both so later tests see a live system.
      db.prepare(
        `UPDATE operating_state SET emergency_stop = 0, emergency_stop_reason = NULL, emergency_stop_at = NULL,
           emergency_stop_by = NULL, paused = 0, pause_reason = NULL, paused_at = NULL WHERE id = 1`,
      ).run();
    }
  });

  test('live portfolio share sends the approved template, never free-form text', async () => {
    const biz = makeLead('03001110004');
    consentTo(biz);
    const item = createPortfolioItem(db, { title: 'Restaurant website', url: 'https://example.com/food' });
    verifyPortfolioItem(db, item.id, true, 'verified live');
    approvePortfolioItem(db, item.id, true);

    // Two calls now: (1) the read-only approval GET against the WABA's
    // message_templates, then (2) the actual template send — in that order.
    fetchState = fakeFetch({
      routes: [
        {
          match: '/message_templates',
          body: { data: [{ name: 'portfolio_v1', status: 'APPROVED', language: 'en_US' }] },
        },
        { match: '/messages', body: { messages: [{ id: 'wamid.LIVE1' }] } },
      ],
    });
    const registry = buildRegistry(cfg, LIVE_ENV, { fetchImpl: fetchState.fetchImpl });
    const waAdapters: OutreachAdapters = {
      telephony: null,
      whatsapp: registry.whatsapp,
      portfolioTemplate: registry.portfolioTemplate,
      voiceAnswerUrl: null,
    };

    const result = await sharePortfolio(db, cfg, { businessId: biz, actor: owner, adapters: waAdapters });

    assert.equal(result.decision, 'allowed');
    assert.ok(result.decision === 'allowed' && result.simulated === false);
    assert.equal(result.provider, 'whatsapp_cloud');

    assert.equal(fetchState.calls.length, 2, 'approval check first, send second');
    const [approvalCall, sendCall] = fetchState.calls;
    // (1) read-only approval verification against the CORRECT WABA.
    assert.equal(String(approvalCall!.init.method ?? '').toUpperCase(), 'GET');
    assert.ok(approvalCall!.url.includes('/v20.0/555666/message_templates'), approvalCall!.url);
    // (2) the template send itself.
    assert.equal(String(sendCall!.init.method ?? '').toUpperCase(), 'POST');
    assert.ok(sendCall!.url.includes('/v20.0/998877/messages'));
    const sent = JSON.parse(String(sendCall!.init.body)) as {
      type: string;
      template: { name: string; components: { parameters: { text: string }[] }[] };
    };
    assert.equal(sent.type, 'template');
    assert.equal(sent.template.name, 'portfolio_v1');
    // Only the business name is a template variable — the case study itself
    // lives in the Meta-approved template, not in free-form text.
    assert.equal(sent.template.components[0]!.parameters.length, 1);
    assert.ok(!sent.template.components[0]!.parameters[0]!.text.includes('Restaurant'), 'only the business name is a variable');

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(result.decision === 'allowed' ? result.messageId : '') as {
      provider: string;
      provider_message_id: string;
      status: string;
      status_source: string;
      template_key: string;
      simulation: number;
    };
    assert.equal(row.provider, 'whatsapp_cloud');
    assert.equal(row.provider_message_id, 'wamid.LIVE1');
    assert.equal(row.status, 'accepted');
    assert.equal(row.status_source, 'provider_event');
    assert.equal(row.template_key, 'portfolio_v1');
    assert.equal(row.simulation, 0);
  });

  test('a PENDING template blocks the send before any counter is spent', async () => {
    const biz = makeLead('03001110007');
    consentTo(biz);
    const item = createPortfolioItem(db, { title: 'Dentist website', url: 'https://example.com/dentist' });
    verifyPortfolioItem(db, item.id, true, 'verified live');
    approvePortfolioItem(db, item.id, true);

    fetchState = fakeFetch({
      routes: [
        {
          match: '/message_templates',
          body: { data: [{ name: 'portfolio_v1', status: 'PENDING', language: 'en_US' }] },
        },
        { match: '/messages', body: { messages: [{ id: 'wamid.MUST_NOT_HAPPEN' }] } },
      ],
    });
    const registry = buildRegistry(cfg, LIVE_ENV, { fetchImpl: fetchState.fetchImpl });
    const waAdapters: OutreachAdapters = {
      telephony: null,
      whatsapp: registry.whatsapp,
      portfolioTemplate: registry.portfolioTemplate,
      voiceAnswerUrl: null,
    };

    const dayKey = businessDayKey(cfg, new Date());
    const usedBefore = usageSnapshot(db, dayKey, 'whatsapp_messages', 100).used;
    const messagesBefore = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

    const result = await sharePortfolio(db, cfg, { businessId: biz, actor: owner, adapters: waAdapters });

    assert.equal(result.decision, 'blocked');
    assert.equal(result.attempt.blockedCode, 'template_not_approved');
    assert.ok(result.attempt.blockedReason?.includes('PENDING'), result.attempt.blockedReason ?? 'missing reason');

    // Exactly ONE call happened: the read-only approval GET. The send was
    // never attempted — there is no free-form fallback.
    assert.equal(fetchState.calls.length, 1, 'only the approval check may run');
    assert.ok(fetchState.calls[0]!.url.includes('/v20.0/555666/message_templates'));
    assert.ok(fetchState.calls.every((c) => !c.url.includes('/messages')), 'no send request may be made');

    // The blocked approval costs nothing: no daily slot, no message row.
    const usedAfter = usageSnapshot(db, dayKey, 'whatsapp_messages', 100).used;
    assert.equal(usedAfter, usedBefore, 'a PENDING template must not consume a daily slot');
    const messagesAfter = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.equal(messagesAfter, messagesBefore, 'no message row may be written');
    assert.equal(hasContactEvidence(db, biz), false, 'a blocked approval is not contact evidence');
  });

  test('an approval-check API failure blocks the send safely (UNVERIFIABLE)', async () => {
    const biz = makeLead('03001110008');
    consentTo(biz);
    const item = createPortfolioItem(db, { title: 'Law firm website', url: 'https://example.com/law' });
    verifyPortfolioItem(db, item.id, true, 'verified live');
    approvePortfolioItem(db, item.id, true);

    // The WABA endpoint itself fails: HTTP 500 with a Graph-style error body.
    fetchState = fakeFetch({
      routes: [
        {
          match: '/message_templates',
          status: 500,
          body: { error: { message: 'temporarily unavailable', code: 2, fbtrace_id: 'test-trace' } },
        },
        { match: '/messages', body: { messages: [{ id: 'wamid.MUST_NOT_HAPPEN' }] } },
      ],
    });
    const registry = buildRegistry(cfg, LIVE_ENV, { fetchImpl: fetchState.fetchImpl });
    const waAdapters: OutreachAdapters = {
      telephony: null,
      whatsapp: registry.whatsapp,
      portfolioTemplate: registry.portfolioTemplate,
      voiceAnswerUrl: null,
    };

    const dayKey = businessDayKey(cfg, new Date());
    const usedBefore = usageSnapshot(db, dayKey, 'whatsapp_messages', 100).used;
    const messagesBefore = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

    const result = await sharePortfolio(db, cfg, { businessId: biz, actor: owner, adapters: waAdapters });

    assert.equal(result.decision, 'blocked');
    assert.equal(result.attempt.blockedCode, 'template_not_approved');
    assert.ok(result.attempt.blockedReason?.includes('UNVERIFIABLE'), result.attempt.blockedReason ?? 'missing reason');

    // Fail-closed: the failed check alone blocks, nothing is sent, no slot
    // is spent, and no message row exists.
    assert.equal(fetchState.calls.length, 1, 'only the failing approval check may run');
    assert.ok(fetchState.calls.every((c) => !c.url.includes('/messages')), 'no send request may be made');
    const usedAfter = usageSnapshot(db, dayKey, 'whatsapp_messages', 100).used;
    assert.equal(usedAfter, usedBefore, 'a failed verification must not consume a daily slot');
    const messagesAfter = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.equal(messagesAfter, messagesBefore, 'no message row may be written');
  });

  test('a missing template blocks before any counter is spent', async () => {
    const biz = makeLead('03001110005');
    consentTo(biz);
    const item = createPortfolioItem(db, { title: 'Gym website', url: 'https://example.com/gym' });
    verifyPortfolioItem(db, item.id, true, 'verified live');
    approvePortfolioItem(db, item.id, true);

    const before = fetchState.calls.length;
    const dayKey = businessDayKey(cfg, new Date());
    const usedBefore = usageSnapshot(db, dayKey, 'whatsapp_messages', 100).used;

    const result = await sharePortfolio(db, cfg, {
      businessId: biz,
      actor: owner,
      adapters: { ...adapters, portfolioTemplate: null },
    });

    assert.equal(result.decision, 'blocked');
    assert.equal(result.attempt.blockedCode, 'provider_unavailable');
    assert.ok(result.attempt.blockedReason?.includes('template'));
    assert.equal(fetchState.calls.length, before, 'nothing may be sent without an approved template');
    const usedAfter = usageSnapshot(db, dayKey, 'whatsapp_messages', 100).used;
    assert.equal(usedAfter, usedBefore, 'a configuration gap must not consume a daily slot');
  });

  test('live mode with no installed adapter is blocked, not crashed, and refunds the slot', async () => {
    const biz = makeLead('03001110006');
    consentTo(biz);
    resetCounters();

    const result = await placeCall(db, cfg, {
      businessId: biz,
      actor: owner,
      adapters: { telephony: null, whatsapp: null, portfolioTemplate: null, voiceAnswerUrl: null },
    });

    assert.equal(result.decision, 'blocked');
    assert.equal(result.attempt.blockedCode, 'provider_unavailable');
    assert.equal(callsMetric(), 0, 'the daily slot was refunded');
  });

  test('a live call to a lead with no phone number is blocked before dialling', async () => {
    const n = seq++;
    const res = createLead(db, { displayName: `No Phone Co ${n}`, city: 'Islamabad' }, owner);
    consentTo(res.id);
    const before = fetchState.calls.length;

    const result = await placeCall(db, cfg, { businessId: res.id, actor: owner, adapters });

    assert.equal(result.decision, 'blocked');
    assert.equal(fetchState.calls.length, before);
  });
});

describe('simulation mode ignores installed adapters entirely', () => {
  let simDb: DB;
  let simCfg: Config;
  let simBiz: string;
  let simAdapters: OutreachAdapters;
  let calls: { url: string }[];

  before(() => {
    simCfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:', ...LIVE_ENV });
    simDb = openDatabase(':memory:');
    runMigrations(simDb);
    // NOTE: no setMode — the fresh database stays in simulation, the default.
    const state = simDb.prepare('SELECT mode, paused FROM operating_state WHERE id = 1').get() as { mode: string; paused: number };
    assert.equal(state.mode, 'simulation');
    calls = [];
    const fetchImpl: FetchLike = async (url, init) => {
      calls.push({ url: String(url) });
      void init;
      return new Response(JSON.stringify({ sid: 'CA_SHOULD_NOT_HAPPEN', status: 'queued' }), { status: 200 });
    };
    const registry = buildRegistry(simCfg, LIVE_ENV, { fetchImpl });
    simAdapters = {
      telephony: registry.telephony,
      whatsapp: registry.whatsapp,
      portfolioTemplate: registry.portfolioTemplate,
      voiceAnswerUrl: registry.voiceAnswerUrl,
    };
    assert.ok(simAdapters.telephony, 'adapters ARE installed — simulation must simply not use them');
    const res = updateSettings(
      simDb,
      simCfg,
      { eligible_channels: { call: true, whatsappMessage: true, whatsappCall: false, email: false, sms: false } },
      owner,
    );
    if (res.rejected.length > 0) throw new Error(JSON.stringify(res.rejected));
    simBiz = createLead(simDb, { displayName: 'Sim With Adapters', city: 'Karachi', phone: '03002220001' }, owner).id;
    recordInteraction(simDb, { businessId: simBiz, kind: 'consent', summary: 'agreed to be contacted' });
  });
  after(() => simDb.close());

  test('a rehearsal with fully configured providers never performs a network call', async () => {
    const result = await placeCall(simDb, simCfg, { businessId: simBiz, actor: owner, adapters: simAdapters });

    assert.equal(result.decision, 'allowed');
    assert.ok(result.decision === 'allowed' && result.simulated === true);
    assert.ok(result.decision === 'allowed' && result.call.scenario !== null);
    assert.equal(result.attempt.provider, 'simulation');
    assert.equal(calls.length, 0, 'a configured provider must never turn a rehearsal into a real dial');

    const row = simDb.prepare('SELECT provider, simulation FROM calls WHERE id = ?').get(
      result.decision === 'allowed' ? result.call.callId : '',
    ) as { provider: string; simulation: number };
    assert.equal(row.provider, 'simulation');
    assert.equal(row.simulation, 1);
  });
});
