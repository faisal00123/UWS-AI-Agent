/**
 * Phase 6 integration tests: the outreach guard/ledger, simulation-mode
 * calling with transcripts, and WhatsApp portfolio sharing.
 *
 * The properties under test are the ones that keep outreach honest:
 *  - every requested outbound action writes exactly one ledger row, allowed
 *    or blocked, with the full check list (why was this call made / not made)
 *  - a simulated call rehearses the whole pipeline but is labelled at every
 *    level and can NEVER evidence a stage change or complete a follow-up
 *  - the daily call cap is enforced by the database, so a second call past
 *    the limit is blocked rather than squeezed through
 *  - an idempotency key can never place two calls
 *  - only owner-verified AND owner-approved portfolio items may be shared
 *  - the calling window blocks automated voice outreach but not an owner's
 *    explicit "call now"
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nowIso } from '../../src/core/time.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { recordInteraction, hasContactEvidence } from '../../src/domain/pipeline/interactions.ts';
import { scheduleFollowup, completeTask } from '../../src/domain/pipeline/followups.ts';
import { advanceStage } from '../../src/domain/pipeline/service.ts';
import { suppress } from '../../src/domain/eligibility/service.ts';
import { updateSettings } from '../../src/domain/settings/service.ts';
import { emergencyStop, resume } from '../../src/domain/state/service.ts';
import {
  runGuard,
  recordAttempt,
  listAttempts,
  usageSnapshot,
  businessDayKey,
  effectiveCallLimit,
  type GuardVerdict,
} from '../../src/domain/outreach/guard.ts';
import { placeCall, sharePortfolio, listLeadCalls, listLeadMessages } from '../../src/domain/outreach/service.ts';
import { simScenarioFor, type SimScenario } from '../../src/domain/outreach/simulation.ts';
import { listConversations, getConversation } from '../../src/domain/outreach/conversations.ts';
import {
  createPortfolioItem,
  verifyPortfolioItem,
  approvePortfolioItem,
  resolveShareableItems,
} from '../../src/domain/outreach/portfolio.ts';

let db: DB;
let cfg: Config;

const owner = { userId: null, label: 'owner' as const };
const actor = { userId: null, label: 'owner' as const };

let leadSeq = 0;
function makeLead(name = 'Outreach Co'): string {
  const seq = leadSeq++;
  const phone = `0300${String(3000000 + seq).slice(-7)}`;
  const res = createLead(db, { displayName: `${name} ${seq}`, city: 'Karachi', phone }, owner);
  return res.id;
}

/** Enable a channel; throws if the settings engine rejects the shape. */
function enableChannels(ch: { call?: boolean; whatsappMessage?: boolean }): void {
  const res = updateSettings(
    db,
    cfg,
    {
      eligible_channels: {
        call: ch.call ?? false,
        whatsappMessage: ch.whatsappMessage ?? false,
        whatsappCall: false,
        email: false,
        sms: false,
      },
    },
    actor,
  );
  if (res.rejected.length > 0) throw new Error(`setting rejected: ${JSON.stringify(res.rejected)}`);
}

/** Make a lead eligible: consent on file + channel on. */
function consentTo(bizId: string): void {
  recordInteraction(db, { businessId: bizId, kind: 'consent', summary: 'agreed to be contacted by phone' });
}

function resetOperatingState(): void {
  db.prepare(
    `UPDATE operating_state SET emergency_stop = 0, emergency_stop_reason = NULL, emergency_stop_at = NULL,
       emergency_stop_by = NULL, paused = 0, pause_reason = NULL, paused_at = NULL WHERE id = 1`,
  ).run();
}

/**
 * Deterministic answered-scenario lead: the simulator derives its scenario from
 * (businessId, day), so we search for an id that yields the wanted scenario and
 * insert the lead under that id. This keeps the transcript assertions exact
 * instead of probabilistic.
 */
function leadIdWithScenario(prefix: string, want: SimScenario['key']): string {
  const dayKey = businessDayKey(cfg, new Date());
  for (let i = 0; i < 10_000; i++) {
    const id = `${prefix}_${want}_${i}`;
    if (simScenarioFor(id, dayKey).key === want) return id;
  }
  throw new Error(`no ${want} scenario id found`);
}

function insertRawLead(id: string, name: string, phone: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO businesses (id, display_name, normalized_name, phone_e164, source_type, discovered_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'manual', ?, ?, ?)`,
  ).run(id, name, name.toLowerCase(), phone, at, at, at);
}

function verdictOfBlocked(result: { decision: string; attempt: { blockedCode: string | null; checks: unknown[] } }): void {
  assert.equal(result.decision, 'blocked');
  assert.ok(result.attempt.blockedCode, 'a blocked attempt must carry a code');
  assert.ok(result.attempt.checks.length >= 5, 'the ledger must keep the full check list');
}

describe('outreach guard & ledger', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
    enableChannels({ call: true, whatsappMessage: true });
  });
  after(() => db.close());

  test('a paused system blocks every call and records why', async () => {
    const id = makeLead('Paused Co');
    consentTo(id);
    db.prepare(`UPDATE operating_state SET paused = 1, pause_reason = 'application_restart' WHERE id = 1`).run();

    const result = await placeCall(db, cfg, { businessId: id, actor });
    verdictOfBlocked(result);
    assert.equal(result.decision === 'blocked' && result.attempt.blockedCode, 'paused');

    // Exactly one ledger row, and it explains itself.
    const attempts = listAttempts(db, { businessId: id });
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]!.decision, 'blocked');
    assert.match(attempts[0]!.blockedReason ?? '', /paused/i);
    resetOperatingState();
  });

  test('emergency stop outranks everything and blocks the call', async () => {
    const id = makeLead('Stopped Co');
    consentTo(id);
    emergencyStop(db, 'test harness stop', owner);

    const result = await placeCall(db, cfg, { businessId: id, actor });
    verdictOfBlocked(result);
    assert.equal(result.decision === 'blocked' && result.attempt.blockedCode, 'emergency_stop');

    // Clearing via the owner resume path restores outreach.
    resume(db, cfg, owner, { clearEmergencyStop: true });
    const after = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(after.decision, 'allowed', after.decision === 'blocked' ? after.attempt.blockedReason ?? '' : '');
  });

  test('unconfirmed consent blocks with needs_review, not a silent send', async () => {
    const id = makeLead('NoConsent Co'); // channel enabled, but no consent interaction
    const result = await placeCall(db, cfg, { businessId: id, actor });
    verdictOfBlocked(result);
    assert.equal(result.decision === 'blocked' && result.attempt.blockedCode, 'needs_review');
    assert.equal(listLeadCalls(db, id).length, 0, 'a blocked request must not create a call');
  });

  test('suppression dominates and blocks with ineligible', async () => {
    const id = makeLead('OptedOut Co');
    consentTo(id);
    suppress(db, { businessId: id, scope: 'business', reason: 'opt_out', source: 'manual' });

    const result = await placeCall(db, cfg, { businessId: id, actor });
    verdictOfBlocked(result);
    assert.equal(result.decision === 'blocked' && result.attempt.blockedCode, 'ineligible');
  });

  test('a disabled channel blocks even an otherwise perfect lead', async () => {
    enableChannels({ call: false, whatsappMessage: true });
    const id = makeLead('ChanOff Co');
    consentTo(id);
    const result = await placeCall(db, cfg, { businessId: id, actor });
    verdictOfBlocked(result);
    assert.equal(result.decision === 'blocked' && result.attempt.blockedCode, 'ineligible');
    enableChannels({ call: true, whatsappMessage: true });
  });

  test('the daily call cap is enforced: the second call of the day is blocked', async () => {
    // Earlier tests in this suite already consumed today's counter; reset it
    // so the limit of 1 means exactly one allowed call from here.
    db.prepare(`DELETE FROM budget_usage WHERE metric = 'calls'`).run();
    const res = updateSettings(db, cfg, { daily_call_limit: 1 }, actor);
    if (res.rejected.length > 0) throw new Error(JSON.stringify(res.rejected));

    const id = makeLead('Capped Co');
    consentTo(id);
    const first = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(first.decision, 'allowed', first.decision === 'blocked' ? first.attempt.blockedReason ?? '' : '');

    const second = await placeCall(db, cfg, { businessId: id, actor });
    verdictOfBlocked(second);
    assert.equal(second.decision === 'blocked' && second.attempt.blockedCode, 'daily_call_limit');

    const dayKey = businessDayKey(cfg, new Date());
    const usage = usageSnapshot(db, dayKey, 'calls', effectiveCallLimit(db, cfg));
    assert.equal(usage.used, 1, 'only the allowed call may consume the counter');

    // Restore the ceiling for the remaining tests.
    updateSettings(db, cfg, { daily_call_limit: 100 }, actor);
  });

  test('an idempotency key can never place two calls', async () => {
    const id = makeLead('DoubleClick Co');
    consentTo(id);
    const key = 'idem-double-click-1';
    const a = await placeCall(db, cfg, { businessId: id, actor, idempotencyKey: key });
    const b = await placeCall(db, cfg, { businessId: id, actor, idempotencyKey: key });
    assert.equal(a.decision, 'allowed');
    assert.equal(b.decision, 'allowed');
    assert.equal(a.decision === 'allowed' && a.attempt.id, b.decision === 'allowed' && b.attempt.id, 'same attempt');
    assert.equal(listLeadCalls(db, id).length, 1, 'exactly one call row for two requests');
    assert.equal(listAttempts(db, { businessId: id }).length, 1, 'exactly one ledger row');
  });

  test('the calling window blocks automated outreach but not an owner "call now"', async () => {
    const id = makeLead('Window Co');
    consentTo(id);
    // 2026-10-31 is a Saturday: outside Mon-Fri 09:00-18:00 Pakistan time.
    const saturday = new Date('2026-10-31T08:00:00.000Z');

    const automated = await placeCall(db, cfg, { businessId: id, actor, purpose: 'followup', now: saturday });
    verdictOfBlocked(automated);
    assert.equal(automated.decision === 'blocked' && automated.attempt.blockedCode, 'calling_window');

    const manual = await placeCall(db, cfg, { businessId: id, actor, purpose: 'callback', now: saturday });
    assert.equal(manual.decision, 'allowed', manual.decision === 'blocked' ? manual.attempt.blockedReason ?? '' : '');
  });

  test('runGuard is pure about its verdict shape and never throws', async () => {
    const id = makeLead('Verdict Co');
    const v: GuardVerdict = runGuard(db, cfg, { businessId: id, channel: 'call', purpose: 'callback' });
    assert.equal(v.allowed, false, 'no consent -> blocked');
    assert.ok(v.checks.some((c) => c.code === 'emergency_stop' && c.result === 'pass'));
    assert.ok(v.checks.some((c) => c.code === 'paused' && c.result === 'pass'));
    assert.equal(v.eligibility?.businessId, id);
  });

  test('a blocked attempt is recorded even when requested through recordAttempt directly', async () => {
    const id = makeLead('Ledger Co');
    const verdict: GuardVerdict = {
      allowed: false,
      blockedCode: 'emergency_stop',
      blockedReason: 'Emergency stop: harness',
      checks: [{ code: 'emergency_stop', label: 'Emergency stop', result: 'fail', detail: 'harness' }],
      mode: 'simulation',
      eligibility: null,
    };
    const rec = recordAttempt(db, {
      businessId: id,
      channel: 'call',
      purpose: 'initial_outreach',
      verdict,
      idempotencyKey: 'direct-blocked-1',
      createdBy: null,
    });
    assert.equal(rec.attempt.decision, 'blocked');
    assert.equal(rec.replayed, false);
    const replay = recordAttempt(db, {
      businessId: id,
      channel: 'call',
      purpose: 'initial_outreach',
      verdict,
      idempotencyKey: 'direct-blocked-1',
      createdBy: null,
    });
    assert.equal(replay.replayed, true);
    assert.equal(replay.attempt.id, rec.attempt.id);
  });
});

describe('simulation calling & transcripts', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
    enableChannels({ call: true, whatsappMessage: true });
  });
  after(() => db.close());

  test('simScenarioFor is deterministic per (lead, day)', async () => {
    const a = simScenarioFor('stable-lead-1', '2026-10-29');
    const b = simScenarioFor('stable-lead-1', '2026-10-29');
    assert.deepEqual(a, b);
    const c = simScenarioFor('stable-lead-1', '2026-10-30');
    assert.ok(['interested', 'not_interested', 'no_answer', 'busy'].includes(c.key));
  });

  test('an allowed call writes a labelled simulation row and ledger link', async () => {
    const id = makeLead('SimCall Co');
    consentTo(id);
    const result = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(result.decision, 'allowed', result.decision === 'blocked' ? result.attempt.blockedReason ?? '' : '');
    if (result.decision !== 'allowed') return;

    assert.equal(result.call.simulated, true);
    assert.equal(result.attempt.mode, 'simulation');
    assert.equal(result.attempt.provider, 'simulation');
    assert.equal(result.attempt.callId, result.call.callId);

    const row = db.prepare('SELECT provider, simulation, counts_against_daily_limit, daily_bucket FROM calls WHERE id = ?').get(result.call.callId) as
      { provider: string; simulation: number; counts_against_daily_limit: number; daily_bucket: string | null };
    assert.equal(row.provider, 'simulation');
    assert.equal(row.simulation, 1);
    assert.equal(row.counts_against_daily_limit, 1);
    assert.equal(row.daily_bucket, businessDayKey(cfg, new Date()));

    // The timeline interaction is simulation-flagged.
    const inter = db.prepare('SELECT simulation, summary FROM interactions WHERE id = ?').get(result.interactionId) as
      { simulation: number; summary: string };
    assert.equal(inter.simulation, 1);
    assert.match(inter.summary, /^\[SIMULATION\]/);
    assert.equal(hasContactEvidence(db, id), false, 'a rehearsal is not customer contact');
  });

  test('an answered rehearsal carries a transcript that declares itself simulated', async () => {
    const id = leadIdWithScenario('biz_transcript', 'interested');
    insertRawLead(id, 'Transcript Co', '+923001112233');
    consentTo(id);
    const result = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(result.decision, 'allowed');
    if (result.decision !== 'allowed' || !result.call.conversationId) {
      throw new Error('expected an answered scenario with a conversation');
    }

    const conv = getConversation(db, result.call.conversationId)!;
    assert.equal(conv.simulated, true);
    assert.equal(conv.aiIdentityDisclosed, true, 'the agent must always disclose it is an AI');
    assert.equal(conv.transcriptState, 'complete');
    assert.ok(conv.segments.length >= 3);
    assert.equal(conv.segments[0]!.speaker, 'system');
    assert.match(conv.segments[0]!.text, /simulation/i);
    assert.ok(conv.segments.every((s) => s.source === 'simulated'));
    // The prospect turn is an explicit placeholder, never an invented quote.
    assert.ok(conv.segments.some((s) => s.speaker === 'prospect' && s.text.startsWith('[simulated]')));
    assert.ok(conv.extracted && conv.extracted.simulated === true);
  });

  test('a no-answer rehearsal has no conversation but still logs the attempt', async () => {
    const id = leadIdWithScenario('biz_noanswer', 'no_answer');
    insertRawLead(id, 'NoAnswer Co', '+923001112244');
    consentTo(id);
    const result = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(result.decision, 'allowed');
    if (result.decision !== 'allowed') return;
    assert.equal(result.call.outcome, 'unanswered');
    assert.equal(result.call.conversationId, null);
    assert.equal(listConversations(db, id).length, 0);
    assert.equal(listLeadCalls(db, id)[0]!.status, 'no_answer');
  });

  test('a human-request in the rehearsal is surfaced for follow-up', async () => {
    // Find a lead whose answered rehearsal also flags the scripted handoff.
    const dayKey = businessDayKey(cfg, new Date());
    let id = '';
    for (let i = 0; i < 20_000; i++) {
      const candidate = `biz_handoff_${i}`;
      const s = simScenarioFor(candidate, dayKey);
      if (s.answered && s.humanRequested) {
        id = candidate;
        break;
      }
    }
    assert.ok(id, 'expected to find a handoff scenario');
    insertRawLead(id, 'Handoff Co', '+923001112255');
    consentTo(id);
    const result = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(result.decision, 'allowed');
    if (result.decision !== 'allowed' || !result.call.conversationId) throw new Error('expected conversation');
    assert.equal(result.call.humanRequested, true);
    const conv = getConversation(db, result.call.conversationId)!;
    assert.equal(conv.humanRequested, true);
  });

  test('a rehearsal can NEVER evidence a customer-facing stage change', async () => {
    const id = makeLead('StageGate Co');
    consentTo(id);
    const result = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(result.decision, 'allowed');

    assert.throws(
      () =>
        advanceStage(db, cfg, {
          businessId: id,
          toStage: 'contacted',
          reason: 'the rehearsal said interested',
          evidenceInteractionId: result.decision === 'allowed' ? result.interactionId : '',
          actor,
        }),
      /real customer contact/i,
    );
  });

  test('a rehearsal can NEVER complete a follow-up; a real interaction can', async () => {
    const id = makeLead('FupGate Co');
    consentTo(id);
    const task = scheduleFollowup(db, cfg, {
      businessId: id,
      type: 'followup_call',
      title: 'Confirm the quote',
      scheduledFor: new Date(Date.now() + 3600_000).toISOString(),
      channel: 'call',
      respectWindow: false,
    });
    const sim = await placeCall(db, cfg, { businessId: id, actor });
    assert.equal(sim.decision, 'allowed');
    if (sim.decision !== 'allowed') return;

    assert.throws(
      () => completeTask(db, { taskId: task.id, interactionId: sim.interactionId, actor }),
      /simulated/i,
    );

    // A real (manually recorded) interaction completes it.
    const real = recordInteraction(db, { businessId: id, kind: 'call', summary: 'spoke to the owner for real' });
    const done = completeTask(db, { taskId: task.id, interactionId: real.id, actor });
    assert.equal(done.status, 'completed');
  });

  test('the ledger lists every attempt with its checks', async () => {
    const id = makeLead('Audit Co');
    consentTo(id);
    await placeCall(db, cfg, { businessId: id, actor });
    await placeCall(db, cfg, { businessId: id, actor, idempotencyKey: 'audit-repeat-1' });
    const attempts = listAttempts(db, { businessId: id });
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0]!.decision, 'allowed');
    assert.ok(attempts[0]!.checks.length >= 5);
  });
});

describe('portfolio sharing', () => {
  before(() => {
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
    db = openDatabase(':memory:');
    runMigrations(db);
    enableChannels({ call: true, whatsappMessage: true });
  });
  after(() => db.close());

  test('the two-key rule: approve before verify is refused, unverify revokes approval', async () => {
    const item = createPortfolioItem(db, { title: 'Clinic website', url: 'https://example.com/clinic' });
    assert.equal(item.verified, false);
    assert.equal(item.isApproved, false);

    assert.throws(() => approvePortfolioItem(db, item.id, true), /verified/i);

    const verified = verifyPortfolioItem(db, item.id, true, 'checked the live site and the client reference');
    assert.equal(verified.verified, true);
    const approved = approvePortfolioItem(db, item.id, true);
    assert.equal(approved.isApproved, true);

    // Un-verifying must also revoke approval, or unverified material would
    // stay shareable behind a stale flag.
    const unverified = verifyPortfolioItem(db, item.id, false, null);
    assert.equal(unverified.verified, false);
    assert.equal(unverified.isApproved, false);
  });

  test('sharing with nothing shareable is a clear validation error', async () => {
    assert.throws(() => resolveShareableItems(db, null), /not shareable|No shareable/i);
  });

  test('selecting an unapproved item is refused, naming the offender', async () => {
    const draft = createPortfolioItem(db, { title: 'Draft case study' });
    const good = createPortfolioItem(db, { title: 'Approved case study', url: 'https://example.com/good' });
    verifyPortfolioItem(db, good.id, true, 'verified live');
    approvePortfolioItem(db, good.id, true);

    assert.throws(
      () => resolveShareableItems(db, [good.id, draft.id]),
      (err: unknown) => {
        const e = err as { code?: string; details?: { rejected?: { id: string }[] } };
        assert.equal(e.code, 'validation_failed');
        assert.equal(e.details?.rejected?.[0]?.id, draft.id);
        return true;
      },
    );
  });

  test('a share is rehearsed end to end and labelled at every level', async () => {
    const good = createPortfolioItem(db, { title: 'E-commerce build', url: 'https://example.com/shop' });
    verifyPortfolioItem(db, good.id, true, 'verified live');
    approvePortfolioItem(db, good.id, true);

    const id = makeLead('Share Co');
    consentTo(id);
    const result = await sharePortfolio(db, cfg, { businessId: id, actor });
    assert.equal(result.decision, 'allowed', result.decision === 'blocked' ? (result.attempt.blockedReason ?? '') : '');
    if (result.decision !== 'allowed') return;

    assert.equal(result.simulated, true);
    // The default selection is the current approved set (earlier tests left
    // their approved items in place) — this one must be part of it.
    assert.ok(result.items.some((i) => i.title === 'E-commerce build'));
    assert.equal(result.attempt.provider, 'simulation');
    assert.equal(result.attempt.messageId, result.messageId);

    const msg = db
      .prepare('SELECT provider, simulation, status, status_source, purpose, body_preview, number_source FROM messages WHERE id = ?')
      .get(result.messageId) as {
      provider: string;
      simulation: number;
      status: string;
      status_source: string;
      purpose: string;
      body_preview: string;
      number_source: string;
    };
    assert.equal(msg.provider, 'simulation');
    assert.equal(msg.simulation, 1);
    assert.equal(msg.status, 'sent');
    assert.equal(msg.status_source, 'simulation');
    assert.equal(msg.purpose, 'portfolio_share');
    assert.match(msg.body_preview, /^\[SIMULATION\]/);
    assert.ok(msg.body_preview.includes('E-commerce build'));

    const inter = db.prepare('SELECT simulation FROM interactions WHERE id = ?').get(result.interactionId) as {
      simulation: number;
    };
    assert.equal(inter.simulation, 1);
    assert.equal(hasContactEvidence(db, id), false);

    const dayKey = businessDayKey(cfg, new Date());
    const usage = usageSnapshot(db, dayKey, 'whatsapp_messages', 100);
    assert.equal(usage.used, 1);

    // The share is listed on the lead's outreach view.
    const messages = listLeadMessages(db, id);
    assert.equal(messages.length, 1);
    assert.equal(messages[0]!.simulation, true);
    assert.equal(messages[0]!.purpose, 'portfolio_share');
  });

  test('sharing is blocked (and ledgered) when the WhatsApp channel is off', async () => {
    const good = createPortfolioItem(db, { title: 'Portfolio ready item' });
    verifyPortfolioItem(db, good.id, true, 'verified live');
    approvePortfolioItem(db, good.id, true);

    enableChannels({ call: true, whatsappMessage: false });
    const id = makeLead('ShareOff Co');
    consentTo(id);
    const result = await sharePortfolio(db, cfg, { businessId: id, actor });
    verdictOfBlocked(result);
    assert.equal(listLeadMessages(db, id).length, 0, 'nothing may be sent on a disabled channel');
    enableChannels({ call: true, whatsappMessage: true });
  });

  test('an idempotency key never sends the portfolio twice', async () => {
    const id = makeLead('ShareOnce Co');
    consentTo(id);
    const key = 'share-once-key-1';
    const a = await sharePortfolio(db, cfg, { businessId: id, actor, idempotencyKey: key });
    const b = await sharePortfolio(db, cfg, { businessId: id, actor, idempotencyKey: key });
    assert.equal(a.decision, 'allowed');
    assert.equal(b.decision, 'allowed');
    assert.equal(a.decision === 'allowed' && a.messageId, b.decision === 'allowed' && b.messageId);
    assert.equal(listLeadMessages(db, id).length, 1);
  });
});
