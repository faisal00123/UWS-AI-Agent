/**
 * Outreach orchestration (Section 3.4 / Phases 6-7).
 *
 * The one place that performs an outbound action, always in this order:
 *
 *   1. guard      - evaluate every safeguard (blocked is a first-class result)
 *   2. ledger     - exactly ONE outreach_attempts row per request (idempotent)
 *   3. counters   - atomically consume the daily cap, so the hard limits are
 *                   enforced by SQLite, not optimism
 *   4. adapter    - simulation (default) or, in live mode ONLY, the provider
 *                   adapter resolved from the registry; never any provider
 *                   call before steps 1-3
 *   5. timeline   - an interaction carrying the simulation flag so rehearsals
 *                   can never evidence a stage change or complete a follow-up
 *
 * LIVE MODE (Phase 7): the provider adapter is called OUTSIDE any transaction
 * (network I/O inside BEGIN IMMEDIATE would stall every writer), after the
 * daily counter was already consumed — a provider failure therefore still
 * counts toward the daily limit, exactly like a retry. A failed live attempt
 * is ledgered as a failed call/message row, never silently dropped.
 *
 * Every artefact carries its simulation flag; nothing here can fabricate a
 * real customer outcome.
 */
import { tx, type DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { AdapterError, type TemplateApprovalCheck, type TelephonyPort, type WhatsAppPort } from '../../adapters/types.ts';
import { recordInteraction } from '../pipeline/interactions.ts';
import {
  runGuard,
  recordAttempt,
  linkAttemptResult,
  findAttemptByKey,
  tryConsumeUsage,
  businessDayKey,
  type GuardVerdict,
  type OutreachAttempt,
  type OutreachPurpose,
  type OutreachChannel,
} from './guard.ts';
import { placeSimulatedCall, simInteractionSummary, type SimCallRow, type SimScenario } from './simulation.ts';
import { resolveShareableItems, type PortfolioItem } from './portfolio.ts';

/**
 * The provider ports the live path may use. The registry supplies these; the
 * domain never constructs an adapter and simulation mode works with none.
 */
export interface OutreachAdapters {
  telephony: TelephonyPort | null;
  whatsapp: WhatsAppPort | null;
  /** Approved Meta template used for portfolio shares (null when unset). */
  portfolioTemplate: { name: string; language: string } | null;
  /** Public answer URL for outbound calls (null when telephony absent). */
  voiceAnswerUrl: string | null;
  /**
   * Provider-specific status-callback URL (Twilio's signed webhook, or the
   * gateway's signed event endpoint). Supplied by the registry so the domain
   * never hardcodes a vendor path. Optional only for hand-built adapter maps;
   * when absent the historical Twilio path is used as a compatibility
   * fallback, which is exactly what the registry would have provided anyway.
   */
  voiceStatusUrl?: string | null;
}

export interface OutreachActor {
  userId: string | null;
  label: 'owner' | 'staff' | 'system' | 'scheduler';
}

interface LeadRow {
  id: string;
  display_name: string;
  phone_e164: string | null;
  whatsapp_e164: string | null;
  merged_into_id: string | null;
}

function loadLead(db: DB, businessId: string): LeadRow {
  const lead = db
    .prepare('SELECT id, display_name, phone_e164, whatsapp_e164, merged_into_id FROM businesses WHERE id = ?')
    .get(businessId) as LeadRow | undefined;
  if (!lead) throw notFound('Lead');
  return lead;
}

// ------------------------------------------------------------- calls -------

export interface SimCallInfo {
  callId: string;
  provider: string;
  status: string;
  outcome: string;
  durationSeconds: number;
  conversationId: string | null;
  /** Simulated scenario key; null for live calls (no scenario exists there). */
  scenario: SimScenario['key'] | null;
  humanRequested: boolean;
  /** True when the built-in simulator executed this call. */
  simulated: boolean;
}

export type PlaceCallResult =
  | { decision: 'allowed'; simulated: boolean; attempt: OutreachAttempt; call: SimCallInfo; interactionId: string }
  | { decision: 'blocked'; attempt: OutreachAttempt };

export interface PlaceCallInput {
  businessId: string;
  purpose?: OutreachPurpose;
  /** Follow-up task this call fulfils (bookkeeping only; the task is completed by real contact). */
  taskId?: string | null;
  idempotencyKey?: string | null;
  actor: OutreachActor;
  now?: Date;
  /** Provider ports for live mode; ignored entirely in simulation. */
  adapters?: OutreachAdapters;
}

function toCallInfo(row: SimCallRow): SimCallInfo {
  return {
    callId: row.id,
    provider: 'simulation',
    status: row.status,
    outcome: row.outcome,
    durationSeconds: row.scenario.durationSeconds,
    conversationId: row.conversationId,
    scenario: row.scenario.key,
    humanRequested: row.scenario.humanRequested,
    simulated: true,
  };
}

/** Replay-safe lookup: rebuild the result from a previously recorded attempt. */
function replayCallResult(db: DB, attempt: OutreachAttempt): PlaceCallResult {
  if (attempt.decision === 'blocked') return { decision: 'blocked', attempt };
  const callRow = db
    .prepare('SELECT id, status, outcome, duration_seconds, simulation, provider FROM calls WHERE attempt_id = ?')
    .get(attempt.id) as
    | { id: string; status: string; outcome: string; duration_seconds: number | null; simulation: number; provider: string }
    | undefined;
  if (!callRow) {
    throw new AppError('conflict', 'Recorded call attempt has no call row; the data is inconsistent', {
      attemptId: attempt.id,
    });
  }
  const conv = db.prepare('SELECT id, human_requested FROM conversations WHERE call_id = ?').get(callRow.id) as
    | { id: string; human_requested: number }
    | undefined;
  const inter = db
    .prepare(`SELECT id FROM interactions WHERE business_id = ? AND json_extract(evidence_json, '$.callId') = ?`)
    .get(attempt.businessId, callRow.id) as { id: string } | undefined;
  // Recover the scenario key from the persisted outcome so a replay reports
  // what actually happened rather than a guess. Live rows carry no scenario.
  const simulated = callRow.simulation === 1;
  const scenario: SimScenario['key'] | null = simulated
    ? callRow.outcome === 'interested'
      ? 'interested'
      : callRow.outcome === 'not_interested'
        ? 'not_interested'
        : callRow.status === 'busy'
          ? 'busy'
          : 'no_answer'
    : null;
  return {
    decision: 'allowed',
    simulated,
    attempt,
    call: {
      callId: callRow.id,
      provider: callRow.provider,
      status: callRow.status,
      outcome: callRow.outcome,
      durationSeconds: callRow.duration_seconds ?? 0,
      conversationId: conv?.id ?? null,
      scenario,
      humanRequested: conv?.human_requested === 1,
      simulated,
    },
    interactionId: inter?.id ?? '',
  };
}

/** Build the blocked verdict used when the daily cap was reached mid-flight. */
function limitedVerdict(
  verdict: GuardVerdict,
  code: 'daily_call_limit' | 'daily_message_limit',
  label: string,
  detail: string,
): GuardVerdict {
  return {
    ...verdict,
    allowed: false,
    blockedCode: code,
    blockedReason: `${label}: the cap was reached by a concurrent request`,
    checks: [...verdict.checks, { code, label, result: 'fail', detail }],
  };
}

/** Give back one consumed unit when execution provably could not proceed. */
function refundUsage(db: DB, usageDate: string, metric: string, amount: number): void {
  db.prepare(
    `UPDATE budget_usage SET used_value = MAX(0, used_value - ?), updated_at = ?
      WHERE usage_date = ? AND metric = ?`,
  ).run(amount, nowIso(), usageDate, metric);
}

/** Provider status strings -> our calls.status vocabulary. */
const PROVIDER_CALL_STATUS: Record<string, string> = {
  queued: 'queued',
  initiated: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
};

function mapCallStatus(raw: string): string {
  return PROVIDER_CALL_STATUS[raw] ?? 'queued';
}

/**
 * Request an outbound call. In simulation (the default mode) this rehearses
 * the full pipeline without contacting anyone; in live mode the telephony
 * adapter dials a real number AFTER the guard, the ledger row and the daily
 * counter. A blocked request returns the ledger entry explaining why — it is
 * NOT an error. Provider failures in live mode are ledgered as failed call
 * rows and rethrown as `provider_unavailable`.
 */
export async function placeCall(db: DB, cfg: Config, input: PlaceCallInput): Promise<PlaceCallResult> {
  const lead = loadLead(db, input.businessId);
  const purpose: OutreachPurpose = input.purpose ?? 'callback';
  const channel: OutreachChannel = 'call';
  const now = input.now ?? new Date();

  if (input.taskId) {
    const task = db
      .prepare('SELECT id, business_id, status FROM followup_tasks WHERE id = ?')
      .get(input.taskId) as { id: string; business_id: string; status: string } | undefined;
    if (!task || task.business_id !== lead.id) throw notFound('Follow-up task');
    if (task.status !== 'due' && task.status !== 'scheduled') {
      throw new AppError('validation_failed', `Task is ${task.status}; only scheduled or due tasks can be called`, {
        taskId: task.id,
        status: task.status,
      });
    }
  }

  // Replay: the same idempotency key never places a second call.
  if (input.idempotencyKey?.trim()) {
    const existing = findAttemptByKey(db, input.idempotencyKey.trim());
    if (existing) return replayCallResult(db, existing);
  }

  // 1. Guard. Owner-initiated calls (callback purpose) skip the calling-window
  //    block — a human deciding to call now is not automated harassment.
  const respectWindow = purpose !== 'callback';
  const verdict = runGuard(db, cfg, {
    businessId: lead.id,
    channel,
    purpose,
    respectWindow,
    now,
  });

  if (!verdict.allowed) {
    const { attempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      taskId: input.taskId ?? null,
      verdict,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt };
  }

  const dayKey = businessDayKey(cfg, now);

  // Live mode needs a destination number before anything is dialled.
  if (verdict.mode === 'live' && !lead.phone_e164) {
    const { attempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      taskId: input.taskId ?? null,
      verdict: {
        ...verdict,
        allowed: false,
        blockedCode: 'ineligible',
        blockedReason: 'Live mode: this lead has no phone number, so no call can be placed',
      },
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt };
  }

  // 3. Atomic daily counter, consumed BEFORE any adapter runs (in its own
  //    short transaction — a provider call must never happen inside BEGIN
  //    IMMEDIATE). A provider failure keeps the consumption: a retry is a new
  //    request, exactly as the daily-limit setting documents.
  const consumed = tx(db, () => tryConsumeUsage(db, dayKey, 'calls', 1));
  if (!consumed) {
    const { attempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      taskId: input.taskId ?? null,
      verdict: limitedVerdict(
        verdict,
        'daily_call_limit',
        'Daily call limit',
        'The daily cap was reached between the guard check and execution.',
      ),
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt };
  }

  // 2. Ledger row. Simulation is executable here; live fills `provider` after
  //    the adapter returns.
  const { attempt } = recordAttempt(db, {
    businessId: lead.id,
    channel,
    purpose,
    taskId: input.taskId ?? null,
    verdict,
    idempotencyKey: input.idempotencyKey ?? null,
    createdBy: input.actor.userId,
  });

  if (verdict.mode === 'simulation') {
    return tx(db, (): PlaceCallResult => {
      const call = placeSimulatedCall(db, {
        businessId: lead.id,
        businessName: lead.display_name,
        toNumber: lead.phone_e164 ?? '(unknown)',
        attemptId: attempt.id,
        channel: 'call',
        dayKey,
        createdBy: input.actor.userId,
      });

      // 5. Timeline. simulation = 1 keeps this out of every honesty rule.
      const interaction = recordInteraction(db, {
        businessId: lead.id,
        kind: 'call',
        direction: 'outbound',
        summary: simInteractionSummary(call.scenario),
        outcome: call.outcome,
        evidence: {
          attemptId: attempt.id,
          callId: call.id,
          conversationId: call.conversationId,
          simulated: true,
          scenario: call.scenario.key,
        },
        simulation: true,
        createdBy: input.actor.userId,
      });

      linkAttemptResult(db, attempt.id, { callId: call.id, provider: 'simulation' });
      const stored = { ...attempt, callId: call.id, provider: 'simulation' };
      return { decision: 'allowed', simulated: true, attempt: stored, call: toCallInfo(call), interactionId: interaction.id };
    });
  }

  // ------------------------------- live ------------------------------------
  const telephony = input.adapters?.telephony ?? null;
  const answerUrl = input.adapters?.voiceAnswerUrl ?? null;
  // Provider-driven (registry) with a Twilio-path compatibility fallback for
  // hand-built adapter maps — never a vendor path invented by this layer.
  const statusUrl =
    input.adapters?.voiceStatusUrl ?? `${cfg.publicBaseUrl}/api/webhooks/telephony/twilio`;
  if (!telephony || !answerUrl) {
    // Config claims telephony is configured but no adapter is installed: the
    // counter is refunded and the request ledgerved as blocked. Nothing dialled.
    refundUsage(db, dayKey, 'calls', 1);
    const { attempt: blockedAttempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      taskId: input.taskId ?? null,
      verdict: {
        ...verdict,
        allowed: false,
        blockedCode: 'provider_unavailable',
        blockedReason: 'Live mode: the telephony integration is configured but no adapter is installed. Nothing was dialled.',
      },
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt: blockedAttempt };
  }

  // Mirror of the ux_calls_live_per_business index: at most one live outbound
  // call per lead may be in flight. Checked BEFORE dialling so a double-click
  // gets a first-class blocked result instead of a constraint error later.
  const inflight = db
    .prepare(
      `SELECT id FROM calls WHERE business_id = ? AND channel = 'call' AND direction = 'outbound'
         AND status IN ('queued','initiated','ringing','in_progress')`,
    )
    .get(lead.id) as { id: string } | undefined;
  if (inflight) {
    refundUsage(db, dayKey, 'calls', 1);
    const { attempt: blockedAttempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      taskId: input.taskId ?? null,
      verdict: {
        ...verdict,
        allowed: false,
        blockedCode: 'call_in_progress',
        blockedReason: 'A call to this lead is already in flight; the daily slot was refunded.',
      },
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt: blockedAttempt };
  }

  // 4. Adapter. Outside any transaction: this is real network I/O.
  try {
    const res = await telephony.createCall({
      to: lead.phone_e164 as string,
      answerUrl,
      statusCallbackUrl: statusUrl,
      metadata: { businessId: lead.id, attemptId: attempt.id },
    });
    return tx(db, (): PlaceCallResult => {
      const callId = newId('cal');
      const at = nowIso();
      db.prepare(
        `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status,
           outcome, to_number_e164, recording_enabled, recording_consent, started_at, simulation,
           counts_against_daily_limit, daily_bucket, cost_state, created_at, updated_at)
         VALUES (?, ?, ?, 'outbound', 'call', ?, ?, ?, 'unknown', ?, 0, 0, ?, 0, 1, ?, 'unavailable', ?, ?)`,
      ).run(
        callId,
        attempt.id,
        lead.id,
        telephony.key,
        res.providerCallId,
        mapCallStatus(res.status),
        lead.phone_e164 as string,
        at,
        dayKey,
        at,
        at,
      );
      const interaction = recordInteraction(db, {
        businessId: lead.id,
        kind: 'call',
        direction: 'outbound',
        summary: `Outbound call placed via ${telephony.label} (live)`,
        outcome: 'unknown',
        evidence: { attemptId: attempt.id, callId, providerCallId: res.providerCallId, simulated: false },
        simulation: false,
        createdBy: input.actor.userId,
      });
      linkAttemptResult(db, attempt.id, { callId, provider: telephony.key });
      const stored = { ...attempt, callId, provider: telephony.key };
      return {
        decision: 'allowed',
        simulated: false,
        attempt: stored,
        call: {
          callId,
          provider: telephony.key,
          status: mapCallStatus(res.status),
          outcome: 'unknown',
          durationSeconds: 0,
          conversationId: null,
          scenario: null,
          humanRequested: false,
          simulated: false,
        },
        interactionId: interaction.id,
      };
    });
  } catch (err) {
    if (err instanceof AppError) throw err; // e.g. the in-flight race mapped above
    // Provider rejected/failed AFTER the guard passed: ledger the failed
    // attempt honestly (counts toward the cap, timeline shows the failure),
    // then surface it. Nothing is fabricated — the outcome is 'failed'.
    const adapterErr = err instanceof AdapterError ? err : null;
    const detail = adapterErr ? adapterErr.message : err instanceof Error ? err.message : 'unknown provider failure';
    const failureCode = adapterErr ? adapterErr.code : 'provider_error';
    const callId = tx(db, (): string => {
      const id = newId('cal');
      const at = nowIso();
      db.prepare(
        `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status,
           outcome, to_number_e164, recording_enabled, recording_consent, started_at, failure_code, failure_detail,
           simulation, counts_against_daily_limit, daily_bucket, cost_state, created_at, updated_at)
         VALUES (?, ?, ?, 'outbound', 'call', ?, NULL, 'failed', 'failed', ?, 0, 0, ?, ?, ?, 0, 1, ?, 'unavailable', ?, ?)`,
      ).run(
        id,
        attempt.id,
        lead.id,
        telephony.key,
        lead.phone_e164 ?? '(unknown)',
        nowIso(),
        failureCode,
        detail,
        dayKey,
        at,
        at,
      );
      // A provider rejection is NOT contact: kind 'system'/'internal' keeps it
      // in the timeline while making sure it can never evidence a stage change.
      recordInteraction(db, {
        businessId: lead.id,
        kind: 'system',
        direction: 'internal',
        summary: `Outbound call failed at the provider (${failureCode}): ${detail}`,
        outcome: 'failed',
        evidence: { attemptId: attempt.id, callId: id, failureCode, simulated: false },
        simulation: false,
        createdBy: input.actor.userId,
      });
      linkAttemptResult(db, attempt.id, { callId: id, provider: telephony.key });
      return id;
    });
    throw new AppError('provider_unavailable', `The telephony provider rejected the call: ${detail}`, {
      attemptId: attempt.id,
      callId,
    });
  }
}

// -------------------------------------------------- portfolio sharing ------

export type SharePortfolioResult =
  | {
      decision: 'allowed';
      attempt: OutreachAttempt;
      messageId: string;
      interactionId: string;
      items: { id: string; title: string }[];
      numberUsed: string;
      provider: string;
      simulated: boolean;
    }
  | { decision: 'blocked'; attempt: OutreachAttempt };

export interface SharePortfolioInput {
  businessId: string;
  /** Explicit selection; null/empty shares the current approved set. */
  itemIds?: string[] | null;
  idempotencyKey?: string | null;
  actor: OutreachActor;
  now?: Date;
  /** Provider ports for live mode; ignored entirely in simulation. */
  adapters?: OutreachAdapters;
}

/**
 * Share the portfolio with a lead over WhatsApp. Only owner-verified AND
 * owner-approved items are ever included; the daily message counter and the
 * full guard apply exactly as for a call. In live mode the provider only ever
 * sends the owner-APPROVED template (free-form text to a prospect who has not
 * messaged us first is never permitted), and the template content lives at
 * Meta — our preview says which template ran, it does not invent a body.
 */
export async function sharePortfolio(db: DB, cfg: Config, input: SharePortfolioInput): Promise<SharePortfolioResult> {
  const lead = loadLead(db, input.businessId);
  const channel: OutreachChannel = 'whatsapp_message';
  const purpose: OutreachPurpose = 'portfolio_share';
  const now = input.now ?? new Date();

  // Selection errors are validation errors, not outreach requests: resolve
  // them BEFORE the guard so the ledger only ever holds real action requests.
  const items = resolveShareableItems(db, input.itemIds);

  if (input.idempotencyKey?.trim()) {
    const existing = findAttemptByKey(db, input.idempotencyKey.trim());
    if (existing) return replayShareResult(db, existing, items);
  }

  const verdict = runGuard(db, cfg, { businessId: lead.id, channel, purpose, respectWindow: false, now });

  if (!verdict.allowed) {
    const { attempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      verdict,
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt };
  }

  const numberUsed = lead.whatsapp_e164 ?? lead.phone_e164 ?? '(unknown)';
  const numberSource = lead.whatsapp_e164 ? 'provided_by_prospect' : 'same_as_call';
  const dayKey = businessDayKey(cfg, now);
  const whatsapp = verdict.mode === 'live' ? (input.adapters?.whatsapp ?? null) : null;
  const template = verdict.mode === 'live' ? (input.adapters?.portfolioTemplate ?? null) : null;

  // Live-mode prerequisites are checked BEFORE the counter is consumed, so a
  // configuration gap costs nothing and blocks with a first-class ledger row.
  if (verdict.mode === 'live') {
    const gap = !whatsapp
      ? 'the WhatsApp integration is configured but no adapter is installed'
      : !template
        ? 'no portfolio template is configured (WHATSAPP_TEMPLATE_NAME_PORTFOLIO) — Meta requires an approved template'
        : numberUsed === '(unknown)'
          ? 'this lead has no phone or WhatsApp number'
          : null;
    if (gap) {
      const { attempt: blockedAttempt } = recordAttempt(db, {
        businessId: lead.id,
        channel,
        purpose,
        verdict: {
          ...verdict,
          allowed: false,
          blockedCode: 'provider_unavailable',
          blockedReason: `Live mode: ${gap}. Nothing was sent.`,
        },
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.actor.userId,
      });
      return { decision: 'blocked', attempt: blockedAttempt };
    }

    // Mirror of ux_messages_live_per_business: at most one WhatsApp message in
    // flight per lead. Checked before dialling so a double-click gets a
    // first-class blocked result instead of a constraint error.
    const inflight = db
      .prepare(
        `SELECT id FROM messages WHERE business_id = ? AND channel = 'whatsapp_message'
           AND status IN ('queued','accepted','sent')`,
      )
      .get(lead.id) as { id: string } | undefined;
    if (inflight) {
      const { attempt: blockedAttempt } = recordAttempt(db, {
        businessId: lead.id,
        channel,
        purpose,
        verdict: {
          ...verdict,
          allowed: false,
          blockedCode: 'message_in_progress',
          blockedReason: 'A WhatsApp message to this lead is already in flight.',
        },
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.actor.userId,
      });
      return { decision: 'blocked', attempt: blockedAttempt };
    }

    // PRE-SEND TEMPLATE APPROVAL GATE (read-only GET against the WABA's
    // message_templates). Runs BEFORE the daily counter is consumed and
    // BEFORE any send: an unapproved (PENDING/REJECTED), missing or
    // language-mismatched template — or a verification request that fails
    // outright — blocks with a first-class ledger row and NOTHING is sent.
    // There is deliberately no free-form fallback: sendTemplate is the only
    // outbound WhatsApp primitive this domain can reach.
    const waLive = whatsapp as WhatsAppPort;
    const tplLive = template as { name: string; language: string };
    let approval: TemplateApprovalCheck;
    try {
      approval = waLive.verifyTemplate
        ? await waLive.verifyTemplate(tplLive.name, tplLive.language)
        : { ok: false, status: 'UNVERIFIABLE', detail: 'The installed WhatsApp adapter cannot verify template approval.' };
    } catch (err) {
      const detail = err instanceof Error ? err.message : 'unknown verification failure';
      approval = { ok: false, status: 'UNVERIFIABLE', detail: `Template approval check failed (${detail}).` };
    }
    if (!approval.ok) {
      const { attempt } = recordAttempt(db, {
        businessId: lead.id,
        channel,
        purpose,
        verdict: {
          ...verdict,
          allowed: false,
          blockedCode: 'template_not_approved',
          blockedReason: `Live mode: template '${tplLive.name}' failed approval verification (${approval.status}) — ${approval.detail} Nothing was sent.`,
        },
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: input.actor.userId,
      });
      return { decision: 'blocked', attempt };
    }
  }

  // Atomic daily counter, consumed BEFORE the adapter runs (own transaction).
  // A provider failure keeps the consumption: a retry is a new request.
  const consumed = tx(db, () => tryConsumeUsage(db, dayKey, 'whatsapp_messages', 1));
  if (!consumed) {
    const { attempt } = recordAttempt(db, {
      businessId: lead.id,
      channel,
      purpose,
      verdict: limitedVerdict(
        verdict,
        'daily_message_limit',
        'Daily message limit',
        'The daily message cap was reached between the guard check and execution.',
      ),
      idempotencyKey: input.idempotencyKey ?? null,
      createdBy: input.actor.userId,
    });
    return { decision: 'blocked', attempt };
  }

  const { attempt } = recordAttempt(db, {
    businessId: lead.id,
    channel,
    purpose,
    verdict,
    idempotencyKey: input.idempotencyKey ?? null,
    createdBy: input.actor.userId,
  });

  if (verdict.mode === 'simulation') {
    return tx(db, (): SharePortfolioResult => {
      const messageId = newId('msg');
      const at = nowIso();
      const preview = portfolioPreview(lead.display_name, items);
      db.prepare(
        `INSERT INTO messages (id, attempt_id, business_id, channel, provider, provider_message_id, template_key,
           purpose, number_used, number_source, body_preview, status, status_source, error_code, error_detail,
           simulation, counts_against_daily_limit, daily_bucket, cost_minor, cost_currency, cost_state,
           sent_at, last_status_at, created_at, updated_at)
         VALUES (?, ?, ?, 'whatsapp_message', 'simulation', NULL, NULL, ?, ?, ?, ?, 'sent', 'simulation', NULL, NULL,
           1, 1, ?, NULL, NULL, 'unavailable', ?, ?, ?, ?)`,
      ).run(
        messageId,
        attempt.id,
        lead.id,
        purpose,
        numberUsed,
        numberSource,
        preview,
        dayKey,
        at,
        at,
        at,
        at,
      );

      const interaction = recordInteraction(db, {
        businessId: lead.id,
        kind: 'whatsapp_message',
        direction: 'outbound',
        summary: `[SIMULATION] Rehearsal portfolio share (${items.length} item(s)) — no real message was sent`,
        outcome: 'sent_simulated',
        evidence: {
          attemptId: attempt.id,
          messageId,
          simulated: true,
          itemIds: items.map((i) => i.id),
        },
        simulation: true,
        createdBy: input.actor.userId,
      });

      linkAttemptResult(db, attempt.id, { messageId, provider: 'simulation' });
      return {
        decision: 'allowed',
        attempt: { ...attempt, messageId, provider: 'simulation' },
        messageId,
        interactionId: interaction.id,
        items: items.map((i) => ({ id: i.id, title: i.title })),
        numberUsed,
        provider: 'simulation',
        simulated: true,
      };
    });
  }

  // ------------------------------- live ------------------------------------
  // Narrowed once here; the gap check above already guaranteed both exist.
  const wa: WhatsAppPort = whatsapp as WhatsAppPort;
  const tpl = template as { name: string; language: string };

  // 4. Adapter. Outside any transaction: this is real network I/O.
  try {
    const res = await wa.sendTemplate({
      to: numberUsed,
      templateName: tpl.name,
      languageCode: tpl.language,
      bodyParams: [lead.display_name],
    });
    return tx(db, (): SharePortfolioResult => {
      const messageId = newId('msg');
      const at = nowIso();
      db.prepare(
        `INSERT INTO messages (id, attempt_id, business_id, channel, provider, provider_message_id, template_key,
           purpose, number_used, number_source, body_preview, status, status_source, error_code, error_detail,
           simulation, counts_against_daily_limit, daily_bucket, cost_minor, cost_currency, cost_state,
           sent_at, last_status_at, created_at, updated_at)
         VALUES (?, ?, ?, 'whatsapp_message', ?, ?, ?, ?, ?, ?, ?, 'accepted', 'provider_event', NULL, NULL,
           0, 1, ?, NULL, NULL, 'unavailable', ?, ?, ?, ?)`,
      ).run(
        messageId,
        attempt.id,
        lead.id,
        wa.key,
        res.providerMessageId,
        tpl.name,
        purpose,
        numberUsed,
        numberSource,
        livePortfolioPreview(tpl.name, lead.display_name, items.length),
        dayKey,
        at,
        at,
        at,
        at,
      );
      const interaction = recordInteraction(db, {
        businessId: lead.id,
        kind: 'whatsapp_message',
        direction: 'outbound',
        summary: `Portfolio template "${tpl.name}" sent via ${wa.label} (live)`,
        outcome: 'sent_live',
        evidence: {
          attemptId: attempt.id,
          messageId,
          providerMessageId: res.providerMessageId,
          templateName: tpl.name,
          itemCount: items.length,
          simulated: false,
        },
        simulation: false,
        createdBy: input.actor.userId,
      });
      linkAttemptResult(db, attempt.id, { messageId, provider: wa.key });
      return {
        decision: 'allowed',
        attempt: { ...attempt, messageId, provider: wa.key },
        messageId,
        interactionId: interaction.id,
        items: items.map((i) => ({ id: i.id, title: i.title })),
        numberUsed,
        provider: wa.key,
        simulated: false,
      };
    });
  } catch (err) {
    if (err instanceof AppError) throw err;
    const adapterErr = err instanceof AdapterError ? err : null;
    const detail = adapterErr ? adapterErr.message : err instanceof Error ? err.message : 'unknown provider failure';
    const failureCode = adapterErr ? adapterErr.code : 'provider_error';
    const messageId = tx(db, (): string => {
      const id = newId('msg');
      const at = nowIso();
      db.prepare(
        `INSERT INTO messages (id, attempt_id, business_id, channel, provider, provider_message_id, template_key,
           purpose, number_used, number_source, body_preview, status, status_source, error_code, error_detail,
           simulation, counts_against_daily_limit, daily_bucket, cost_minor, cost_currency, cost_state,
           sent_at, last_status_at, created_at, updated_at)
         VALUES (?, ?, ?, 'whatsapp_message', ?, NULL, ?, ?, ?, ?, ?, 'failed', 'none', ?, ?, 0, 1, ?,
           NULL, NULL, 'unavailable', NULL, NULL, ?, ?)`,
      ).run(
        id,
        attempt.id,
        lead.id,
        wa.key,
        tpl.name,
        purpose,
        numberUsed,
        numberSource,
        livePortfolioPreview(tpl.name, lead.display_name, items.length),
        failureCode,
        detail,
        dayKey,
        at,
        at,
      );
      // Nothing reached the customer: this is bookkeeping, never contact
      // evidence — kind 'system'/'internal' keeps it out of stage changes.
      recordInteraction(db, {
        businessId: lead.id,
        kind: 'system',
        direction: 'internal',
        summary: `Portfolio share failed at the provider (${failureCode}): ${detail}`,
        outcome: 'failed',
        evidence: { attemptId: attempt.id, messageId: id, failureCode, simulated: false },
        simulation: false,
        createdBy: input.actor.userId,
      });
      linkAttemptResult(db, attempt.id, { messageId: id, provider: wa.key });
      return id;
    });
    throw new AppError('provider_unavailable', `The WhatsApp provider rejected the message: ${detail}`, {
      attemptId: attempt.id,
      messageId,
    });
  }
}

function replayShareResult(db: DB, attempt: OutreachAttempt, items: PortfolioItem[]): SharePortfolioResult {
  if (attempt.decision === 'blocked') return { decision: 'blocked', attempt };
  const row = attempt.messageId
    ? (db.prepare('SELECT number_used, simulation FROM messages WHERE id = ?').get(attempt.messageId) as
        | { number_used: string | null; simulation: number }
        | undefined)
    : undefined;
  const inter = db
    .prepare(
      `SELECT id FROM interactions WHERE business_id = ? AND kind = 'whatsapp_message' AND json_extract(evidence_json, '$.attemptId') = ?`,
    )
    .get(attempt.businessId, attempt.id) as { id: string } | undefined;
  const simulated = row?.simulation === 1;
  return {
    decision: 'allowed',
    attempt,
    messageId: attempt.messageId ?? '',
    interactionId: inter?.id ?? '',
    items: items.map((i) => ({ id: i.id, title: i.title })),
    numberUsed: row?.number_used ?? '(unknown)',
    provider: attempt.provider ?? (simulated ? 'simulation' : 'unknown'),
    simulated,
  };
}

/** Redacted, truncated preview of what would be sent (never the full body). */
export function portfolioPreview(businessName: string, items: PortfolioItem[]): string {
  const lines = items.map((i) => `• ${i.title}${i.url ? ` — ${i.url}` : ''}`);
  let body = `[SIMULATION] UWS portfolio for ${businessName}:\n${lines.join('\n')}`;
  if (body.length > 500) body = `${body.slice(0, 497)}…`;
  return body;
}

/**
 * Live preview: which approved template ran and with which variables. The
 * template body itself lives at Meta (owner-approved there), so we record the
 * template name and variables — never a fabricated message body.
 */
export function livePortfolioPreview(templateName: string, businessName: string, itemCount: number): string {
  let body = `[template:${templateName}] to "${businessName}" — ${itemCount} portfolio item(s) in the approved template.`;
  if (body.length > 500) body = `${body.slice(0, 497)}…`;
  return body;
}

// ------------------------------------------------------------- listings ----

export interface CallSummary {
  id: string;
  attemptId: string | null;
  channel: string;
  status: string;
  outcome: string;
  durationSeconds: number | null;
  simulation: boolean;
  startedAt: string | null;
  endedAt: string | null;
}

export function listLeadCalls(db: DB, businessId: string, limit = 50): CallSummary[] {
  const rows = db
    .prepare(
      `SELECT id, attempt_id, channel, status, outcome, duration_seconds, simulation, started_at, ended_at
         FROM calls WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(businessId, limit) as unknown as {
    id: string;
    attempt_id: string | null;
    channel: string;
    status: string;
    outcome: string;
    duration_seconds: number | null;
    simulation: number;
    started_at: string | null;
    ended_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    attemptId: r.attempt_id,
    channel: r.channel,
    status: r.status,
    outcome: r.outcome,
    durationSeconds: r.duration_seconds,
    simulation: r.simulation === 1,
    startedAt: r.started_at,
    endedAt: r.ended_at,
  }));
}

export interface MessageSummary {
  id: string;
  attemptId: string | null;
  channel: string;
  purpose: string;
  status: string;
  statusSource: string;
  numberUsed: string | null;
  bodyPreview: string | null;
  simulation: boolean;
  sentAt: string | null;
}

export function listLeadMessages(db: DB, businessId: string, limit = 50): MessageSummary[] {
  const rows = db
    .prepare(
      `SELECT id, attempt_id, channel, purpose, status, status_source, number_used, body_preview, simulation, sent_at
         FROM messages WHERE business_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    )
    .all(businessId, limit) as unknown as {
    id: string;
    attempt_id: string | null;
    channel: string;
    purpose: string;
    status: string;
    status_source: string;
    number_used: string | null;
    body_preview: string | null;
    simulation: number;
    sent_at: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    attemptId: r.attempt_id,
    channel: r.channel,
    purpose: r.purpose,
    status: r.status,
    statusSource: r.status_source,
    numberUsed: r.number_used,
    bodyPreview: r.body_preview,
    simulation: r.simulation === 1,
    sentAt: r.sent_at,
  }));
}
