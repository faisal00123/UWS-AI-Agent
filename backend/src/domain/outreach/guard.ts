/**
 * Outreach guard & attempt ledger (Section 3.2 / 3.4).
 *
 * This is the single authority consulted before ANY outbound action — a call,
 * a WhatsApp portfolio share, anything. Two responsibilities:
 *
 *  1. runGuard(): evaluates every safeguard in a fixed, documented order and
 *     produces an allow/block verdict with the full check list. Blocked is a
 *     first-class outcome, never an exception: the system must be able to
 *     record *why* it refused to act.
 *
 *  2. recordAttempt(): writes ONE outreach_attempts row per requested action,
 *     whether allowed or blocked. This is the audit answer to "why was this
 *     call made / not made", and it is idempotent per client-supplied key so a
 *     double-click can never place two calls.
 *
 * The guard itself never performs outreach and never talks to a provider. The
 * execution adapters (Phase 6 simulation, Phase 7 live providers) run only
 * after an `allowed` verdict, inside the same transaction that consumes the
 * daily counters — so the hard caps are enforced by the database atomically,
 * not by optimistic read-then-write code.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { getSetting } from '../settings/service.ts';
import { getOperatingState, type OperatingMode } from '../state/service.ts';
import { evaluateEligibility, type Channel, type EligibilityDecision } from '../eligibility/service.ts';
import { callingWindowFor, inCallingWindow } from '../pipeline/followups.ts';

/** Purposes allowed by the outreach_attempts schema. */
export const OUTREACH_PURPOSES = [
  'initial_outreach',
  'followup',
  'callback',
  'portfolio_share',
  'owner_notification',
] as const;
export type OutreachPurpose = (typeof OUTREACH_PURPOSES)[number];

/** Channels that create an outreach attempt (subset of eligibility channels). */
export type OutreachChannel = 'call' | 'whatsapp_call' | 'whatsapp_message';

export type GuardResult = 'pass' | 'fail' | 'skip';

export interface GuardCheck {
  code: string;
  label: string;
  result: GuardResult;
  detail: string;
}

export interface GuardVerdict {
  allowed: boolean;
  /** First failing check's code, or null when allowed. */
  blockedCode: string | null;
  blockedReason: string | null;
  checks: GuardCheck[];
  mode: OperatingMode;
  eligibility: EligibilityDecision | null;
}

export interface GuardInput {
  businessId: string;
  channel: OutreachChannel;
  purpose: OutreachPurpose;
  /** Apply the owner's calling window (voice only). Owner-initiated calls skip it. */
  respectWindow?: boolean;
  now?: Date;
}

const CHANNEL_PROVIDER_KEY: Record<OutreachChannel, string> = {
  call: 'telephony',
  whatsapp_call: 'whatsapp',
  whatsapp_message: 'whatsapp',
};

/** Voice channels consume the shared daily call counter. */
function isVoice(channel: OutreachChannel): boolean {
  return channel === 'call' || channel === 'whatsapp_call';
}

// ------------------------------------------------------------ usage rows ----

export interface UsageSnapshot {
  used: number;
  limit: number;
}

/**
 * Upsert today's usage row with the CURRENT effective limit (the owner may
 * have changed it since midnight) and return the snapshot. Keeping limit_value
 * fresh here means the atomic consume below always compares against the same
 * number the guard reported to the operator.
 */
export function usageSnapshot(db: DB, usageDate: string, metric: string, limit: number): UsageSnapshot {
  db.prepare(
    `INSERT INTO budget_usage (usage_date, metric, used_value, limit_value, state, updated_at)
     VALUES (?, ?, 0, ?, 'ok', ?)
     ON CONFLICT(usage_date, metric) DO UPDATE SET limit_value = excluded.limit_value, updated_at = excluded.updated_at`,
  ).run(usageDate, metric, limit, nowIso());
  const row = db
    .prepare('SELECT used_value, limit_value FROM budget_usage WHERE usage_date = ? AND metric = ?')
    .get(usageDate, metric) as { used_value: number; limit_value: number } | undefined;
  return { used: row?.used_value ?? 0, limit: row?.limit_value ?? limit };
}

/**
 * Atomically consume `amount` units of a metric. The comparison lives inside
 * the UPDATE so two concurrent requests can never both squeeze past the cap:
 * at most one receives `changes = 1`. Returns false when the cap is reached.
 */
export function tryConsumeUsage(db: DB, usageDate: string, metric: string, amount: number): boolean {
  const res = db
    .prepare(
      `UPDATE budget_usage SET used_value = used_value + ?, state = CASE
          WHEN used_value + ? >= limit_value THEN 'exhausted'
          WHEN used_value + ? >= limit_value * 0.8 THEN 'warning'
          ELSE 'ok' END,
          updated_at = ?
        WHERE usage_date = ? AND metric = ? AND used_value + ? <= limit_value`,
    )
    .run(amount, amount, amount, nowIso(), usageDate, metric, amount);
  return res.changes === 1;
}

/** Business-timezone day key for the budget counters. */
export function businessDayKey(cfg: Config, now: Date): string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.businessTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

/** Effective daily call ceiling: owner setting clamped by the compiled-in hard limit. */
export function effectiveCallLimit(db: DB, cfg: Config): number {
  const setting = getSetting<number>(db, 'daily_call_limit', cfg);
  return Math.max(1, Math.min(setting, cfg.hardDailyCallLimit));
}

/** Effective daily spend cap in minor units (0 = unlimited, mirroring resume checks). */
export function effectiveBudgetMinor(db: DB, cfg: Config): number {
  const setting = getSetting<{ limitMinor: number }>(db, 'daily_budget', cfg);
  return Math.min(setting.limitMinor, cfg.hardDailyBudgetMinor);
}

// ------------------------------------------------------------- guard --------

/**
 * Evaluate every safeguard for one requested outbound action. Never throws for
 * a normal "blocked" outcome; the caller records the verdict in the ledger.
 */
export function runGuard(db: DB, cfg: Config, input: GuardInput): GuardVerdict {
  const now = input.now ?? new Date();
  const checks: GuardCheck[] = [];
  const state = getOperatingState(db);
  const mode = state.mode;

  // 1. Emergency stop overrides everything.
  checks.push(
    state.emergencyStop
      ? {
          code: 'emergency_stop',
          label: 'Emergency stop',
          result: 'fail',
          detail: `Emergency stop is active (${state.emergencyStopReason ?? 'no reason recorded'}). It blocks every outbound action until the owner clears it.`,
        }
      : { code: 'emergency_stop', label: 'Emergency stop', result: 'pass', detail: 'No emergency stop is active.' },
  );

  // 2. Manual pause (set at restart; requires an owner resume).
  checks.push(
    state.paused
      ? {
          code: 'paused',
          label: 'Not paused',
          result: 'fail',
          detail: `Outreach is paused (${state.pauseReason ?? 'unspecified'}). A restart or manual pause never auto-resumes; the owner must resume explicitly.`,
        }
      : { code: 'paused', label: 'Not paused', result: 'pass', detail: 'The system is not paused.' },
  );

  // 3. Operating mode. Simulation is a fully supported mode (rehearsal); live
  //    additionally requires the channel's provider to be configured.
  if (mode === 'live') {
    const provider = cfg.providers.find((p) => p.key === CHANNEL_PROVIDER_KEY[input.channel]);
    if (provider && provider.state === 'configured') {
      checks.push({
        code: 'provider_ready',
        label: 'Provider configured for live mode',
        result: 'pass',
        detail: `Live mode: the ${provider.label} integration reports configured.`,
      });
    } else {
      checks.push({
        code: 'provider_ready',
        label: 'Provider configured for live mode',
        result: 'fail',
        detail: provider
          ? `The ${provider.label} integration is ${provider.state} (missing: ${provider.missing.join(', ') || 'n/a'}). Live outreach is impossible until it is configured.`
          : 'No provider is registered for this channel.',
      });
    }
  } else {
    checks.push({
      code: 'operating_mode',
      label: 'Operating mode',
      result: 'pass',
      detail: 'Simulation mode: the action will be rehearsed end-to-end but never contacts a real person.',
    });
  }

  // 4. Eligibility (consent, suppression, destination, channel switch). The
  //    blocked code mirrors the eligibility decision so the ledger can tell a
  //    hard "do not contact" apart from a "consent unconfirmed, needs review".
  const eligibility = evaluateEligibility(db, cfg, input.businessId, input.channel as Channel);
  const eligibilityCode =
    eligibility.decision === 'eligible' ? 'eligible' : eligibility.decision === 'ineligible' ? 'ineligible' : 'needs_review';
  checks.push({
    code: eligibilityCode,
    label: 'Contact eligibility',
    result: eligibility.decision === 'eligible' ? 'pass' : 'fail',
    detail:
      eligibility.decision === 'eligible'
        ? 'All eligibility checks passed.'
        : `${eligibility.decision}: ${eligibility.reasons.join(' | ')}`,
  });

  // 5. Daily volume. Voice channels share the single hard call counter so the
  //    100/day ceiling holds across call and WhatsApp-call alike.
  const dayKey = businessDayKey(cfg, now);
  const callLimit = effectiveCallLimit(db, cfg);
  if (isVoice(input.channel)) {
    const usage = usageSnapshot(db, dayKey, 'calls', callLimit);
    checks.push(
      usage.used < usage.limit
        ? {
            code: 'daily_call_limit',
            label: 'Daily call limit',
            result: 'pass',
            detail: `${usage.used}/${usage.limit} calls used in the current business day.`,
          }
        : {
            code: 'daily_call_limit',
            label: 'Daily call limit',
            result: 'fail',
            detail: `Daily call limit reached (${usage.used}/${usage.limit}). No further calls until the next business day.`,
          },
    );
  } else {
    // Messages keep their own counter, capped defensively at the same ceiling.
    const usage = usageSnapshot(db, dayKey, 'whatsapp_messages', callLimit);
    checks.push(
      usage.used < usage.limit
        ? {
            code: 'daily_message_limit',
            label: 'Daily message limit',
            result: 'pass',
            detail: `${usage.used}/${usage.limit} WhatsApp messages sent in the current business day.`,
          }
        : {
            code: 'daily_message_limit',
            label: 'Daily message limit',
            result: 'fail',
            detail: `Daily message limit reached (${usage.used}/${usage.limit}).`,
          },
    );
  }

  // 6. Daily budget. Simulation spends nothing, so this only bites in live
  //    mode — but it is evaluated uniformly so a mode flip mid-day is safe.
  const budgetLimit = effectiveBudgetMinor(db, cfg);
  const costRow = db
    .prepare(`SELECT used_value FROM budget_usage WHERE usage_date = ? AND metric = 'cost_minor'`)
    .get(dayKey) as { used_value: number } | undefined;
  const costUsed = costRow?.used_value ?? 0;
  const budgetExhausted = budgetLimit > 0 && costUsed >= budgetLimit;
  checks.push({
    code: 'daily_budget',
    label: 'Daily budget',
    result: budgetExhausted ? 'fail' : 'pass',
    detail: budgetExhausted
      ? `Daily budget exhausted (${costUsed}/${budgetLimit} minor units). Resume requires explicit owner approval of a budget increase.`
      : `Spent ${costUsed} of ${budgetLimit === 0 ? 'an unlimited' : budgetLimit} minor units today.`,
  });

  // 7. Calling window (voice only, and only for scheduled/automated outreach;
  //    an owner clicking "call now" is a conscious human action at that moment).
  if (isVoice(input.channel)) {
    if (input.respectWindow === false) {
      checks.push({
        code: 'calling_window',
        label: 'Calling window',
        result: 'skip',
        detail: 'Owner-initiated action: the calling window is recorded but not enforced.',
      });
    } else {
      const w = callingWindowFor(db, cfg, input.channel as Channel);
      const inWindow = inCallingWindow(now.toISOString(), w);
      checks.push({
        code: 'calling_window',
        label: 'Calling window',
        result: inWindow ? 'pass' : 'fail',
        detail: inWindow
          ? `Inside the configured calling window (${w.start}-${w.end}).`
          : `Outside the configured calling window (${w.start}-${w.end}). The action is refused rather than silently re-timed.`,
      });
    }
  } else {
    checks.push({
      code: 'calling_window',
      label: 'Calling window',
      result: 'skip',
      detail: 'The owner-configured calling window applies to voice only; messaging has no separate window yet.',
    });
  }

  const firstFail = checks.find((c) => c.result === 'fail');
  return {
    allowed: !firstFail,
    blockedCode: firstFail?.code ?? null,
    blockedReason: firstFail ? `${firstFail.label}: ${firstFail.detail}` : null,
    checks,
    mode,
    eligibility,
  };
}

// ------------------------------------------------------- attempt ledger -----

export interface RecordAttemptInput {
  businessId: string;
  channel: OutreachChannel;
  purpose: OutreachPurpose;
  taskId?: string | null;
  verdict: GuardVerdict;
  /** Client-supplied key making the request replay-safe. */
  idempotencyKey?: string | null;
  createdBy?: string | null;
}

export interface OutreachAttempt {
  id: string;
  businessId: string;
  channel: OutreachChannel;
  purpose: OutreachPurpose;
  taskId: string | null;
  decision: 'allowed' | 'blocked';
  blockedReason: string | null;
  blockedCode: string | null;
  checks: GuardCheck[];
  mode: OperatingMode;
  provider: string | null;
  callId: string | null;
  messageId: string | null;
  idempotencyKey: string | null;
  createdAt: string;
}

interface AttemptRow {
  id: string;
  business_id: string;
  channel: OutreachChannel;
  purpose: OutreachPurpose;
  task_id: string | null;
  decision: 'allowed' | 'blocked';
  blocked_reason: string | null;
  blocked_code: string | null;
  guard_results_json: string;
  mode: OperatingMode;
  provider: string | null;
  call_id: string | null;
  message_id: string | null;
  idempotency_key: string;
  created_at: string;
}

function toAttempt(r: AttemptRow): OutreachAttempt {
  let checks: GuardCheck[] = [];
  try {
    checks = JSON.parse(r.guard_results_json) as GuardCheck[];
  } catch {
    checks = [];
  }
  return {
    id: r.id,
    businessId: r.business_id,
    channel: r.channel,
    purpose: r.purpose,
    taskId: r.task_id,
    decision: r.decision,
    blockedReason: r.blocked_reason,
    blockedCode: r.blocked_code,
    checks,
    mode: r.mode,
    provider: r.provider,
    callId: r.call_id,
    messageId: r.message_id,
    idempotencyKey: r.idempotency_key,
    createdAt: r.created_at,
  };
}

export function getAttempt(db: DB, id: string): OutreachAttempt | null {
  const r = db.prepare('SELECT * FROM outreach_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
  return r ? toAttempt(r) : null;
}

export function findAttemptByKey(db: DB, key: string): OutreachAttempt | null {
  const r = db.prepare('SELECT * FROM outreach_attempts WHERE idempotency_key = ?').get(key) as
    | AttemptRow
    | undefined;
  return r ? toAttempt(r) : null;
}

export interface RecordedAttempt {
  attempt: OutreachAttempt;
  /** True when an existing attempt with the same idempotency key was returned. */
  replayed: boolean;
}

/**
 * Record one outreach request in the ledger. Every outbound action — allowed
 * or blocked — produces exactly one row; a repeated idempotency key returns the
 * original row instead of writing a second one.
 */
export function recordAttempt(db: DB, input: RecordAttemptInput): RecordedAttempt {
  const key = input.idempotencyKey?.trim() || newId('idem');
  const existing = findAttemptByKey(db, key);
  if (existing) return { attempt: existing, replayed: true };

  const id = newId('oat');
  const at = nowIso();
  const allowed = input.verdict.allowed;
  db.prepare(
    `INSERT INTO outreach_attempts (id, business_id, channel, purpose, task_id, decision, blocked_reason,
       blocked_code, guard_results_json, mode, provider, call_id, message_id, idempotency_key, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
  ).run(
    id,
    input.businessId,
    input.channel,
    input.purpose,
    input.taskId ?? null,
    allowed ? 'allowed' : 'blocked',
    input.verdict.blockedReason,
    input.verdict.blockedCode,
    JSON.stringify(input.verdict.checks),
    input.verdict.mode,
    // The provider column names who actually executed an allowed action. A
    // blocked attempt never reached a provider; a simulation runs on the
    // built-in simulator; live adapters fill the vendor key in Phase 7.
    allowed ? (input.verdict.mode === 'simulation' ? 'simulation' : null) : null,
    key,
    input.createdBy ?? null,
    at,
  );
  return { attempt: getAttempt(db, id) as OutreachAttempt, replayed: false };
}

/** Attach the created call/message (and the adapter that executed it) to its ledger row. */
export function linkAttemptResult(
  db: DB,
  attemptId: string,
  result: { callId?: string; messageId?: string; provider?: string },
): void {
  db.prepare('UPDATE outreach_attempts SET call_id = ?, message_id = ?, provider = COALESCE(?, provider) WHERE id = ?').run(
    result.callId ?? null,
    result.messageId ?? null,
    result.provider ?? null,
    attemptId,
  );
}

export interface AttemptQuery {
  businessId: string;
  decision?: 'allowed' | 'blocked';
  limit?: number;
}

export function listAttempts(db: DB, q: AttemptQuery): OutreachAttempt[] {
  const clauses: string[] = ['business_id = ?'];
  const params: SQLInputValue[] = [q.businessId];
  if (q.decision) {
    clauses.push('decision = ?');
    params.push(q.decision);
  }
  const rows = db
    .prepare(`SELECT * FROM outreach_attempts WHERE ${clauses.join(' AND ')} ORDER BY created_at DESC, rowid DESC LIMIT ?`)
    .all(...params, q.limit ?? 100) as unknown as AttemptRow[];
  return rows.map(toAttempt);
}
