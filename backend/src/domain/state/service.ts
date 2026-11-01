/**
 * Operating state: simulation/live mode, emergency stop, pause & manual resume.
 *
 * This is the single authoritative record consulted by the outreach guard and
 * by the scheduler on every tick. Rules implemented here:
 *   - default mode is simulation
 *   - emergency stop overrides mode, schedules, retries and campaign automation
 *   - after a restart the system is paused and requires an owner resume
 *     (Section 3.5: restart must never auto-resume outbound activity)
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { nowIso } from '../../core/time.ts';
import { recordAudit } from '../audit/service.ts';
import { getSetting } from '../settings/service.ts';
import { getOnboarding } from '../integrations/onboarding.ts';

export type OperatingMode = 'simulation' | 'live';

export interface OperatingState {
  mode: OperatingMode;
  emergencyStop: boolean;
  emergencyStopReason: string | null;
  emergencyStopAt: string | null;
  emergencyStopBy: string | null;
  paused: boolean;
  pauseReason: string | null;
  pausedAt: string | null;
  resumedAt: string | null;
  resumedBy: string | null;
  restartCount: number;
  updatedAt: string;
}

interface Row {
  mode: OperatingMode;
  emergency_stop: number;
  emergency_stop_reason: string | null;
  emergency_stop_at: string | null;
  emergency_stop_by: string | null;
  paused: number;
  pause_reason: string | null;
  paused_at: string | null;
  resumed_at: string | null;
  resumed_by: string | null;
  restart_count: number;
  updated_at: string;
}

const SELECT = 'SELECT * FROM operating_state WHERE id = 1';

export function getOperatingState(db: DB): OperatingState {
  const r = db.prepare(SELECT).get() as Row | undefined;
  if (!r) throw new AppError('internal_error', 'operating_state row missing');
  return {
    mode: r.mode,
    emergencyStop: r.emergency_stop === 1,
    emergencyStopReason: r.emergency_stop_reason,
    emergencyStopAt: r.emergency_stop_at,
    emergencyStopBy: r.emergency_stop_by,
    paused: r.paused === 1,
    pauseReason: r.pause_reason,
    pausedAt: r.paused_at,
    resumedAt: r.resumed_at,
    resumedBy: r.resumed_by,
    restartCount: r.restart_count,
    updatedAt: r.updated_at,
  };
}

/**
 * Called once at application start.
 * Increments the restart counter and forces `paused = 1` so no outbound work
 * can resume automatically after a crash/restart/redeploy.
 */
export function markApplicationStart(db: DB, reason = 'application_restart'): OperatingState {
  db.prepare(
    `UPDATE operating_state
        SET paused = 1,
            pause_reason = ?,
            paused_at = ?,
            restart_count = restart_count + 1,
            updated_at = ?
      WHERE id = 1`,
  ).run(reason, nowIso(), nowIso());
  const state = getOperatingState(db);
  recordAudit(db, {
    actorLabel: 'system',
    action: 'system.start',
    entityType: 'operating_state',
    entityId: '1',
    summary: `Application started in ${state.mode} mode; outreach paused pending manual resume`,
    details: { mode: state.mode, restartCount: state.restartCount, pauseReason: reason },
  });
  return state;
}

export interface Actor {
  userId: string | null;
  label: 'owner' | 'staff' | 'system' | 'scheduler';
  displayName?: string;
  ipHash?: string | null;
}

export function emergencyStop(db: DB, reason: string, actor: Actor): OperatingState {
  if (!reason.trim()) throw new AppError('validation_failed', 'A reason is required to stop outreach');
  const at = nowIso();
  db.prepare(
    `UPDATE operating_state
        SET emergency_stop = 1,
            emergency_stop_reason = ?,
            emergency_stop_at = ?,
            emergency_stop_by = ?,
            paused = 1,
            pause_reason = 'emergency_stop',
            paused_at = ?,
            updated_at = ?
      WHERE id = 1`,
  ).run(reason, at, actor.userId, at, at);

  // Any task still queued/running is blocked rather than silently dropped.
  const blocked = db
    .prepare(
      `UPDATE followup_tasks
          SET status = 'blocked',
              blocked_reason = 'emergency_stop',
              updated_at = ?
        WHERE status IN ('scheduled','due','running')`,
    )
    .run(at);

  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: 'emergency.stop',
    entityType: 'operating_state',
    entityId: '1',
    summary: `EMERGENCY STOP activated: ${reason}`,
    details: { reason, blockedTasks: Number(blocked.changes) },
    ipHash: actor.ipHash ?? null,
  });
  return getOperatingState(db);
}

export interface ResumeCheck {
  key: string;
  label: string;
  ok: boolean;
  required: boolean;
  detail: string;
}

export interface ResumeEvaluation {
  canResume: boolean;
  checks: ResumeCheck[];
}

/**
 * Pre-resume verification: budgets, limits, open critical incidents and
 * emergency-stop state are re-checked before outreach may continue.
 *
 * @param opts.ignoreEmergencyStop  set when the owner explicitly asked to clear
 *        the stop in the same action - otherwise an active stop blocks resume.
 */
export function evaluateResume(
  db: DB,
  cfg: Config,
  opts: { ignoreEmergencyStop?: boolean } = {},
  now = new Date(),
): ResumeEvaluation {
  const checks: ResumeCheck[] = [];
  const state = getOperatingState(db);
  const businessDayKey = dayKeyFor(cfg, now);
  const dailyLimit = getSetting<number>(db, 'daily_call_limit', cfg);
  const budget = getSetting<{ limitMinor: number }>(db, 'daily_budget', cfg);

  const callRow = db
    .prepare(`SELECT used_value FROM budget_usage WHERE usage_date = ? AND metric = 'calls'`)
    .get(businessDayKey) as { used_value: number } | undefined;
  const usedCalls = callRow?.used_value ?? 0;
  // Reaching the daily limit does not forbid *resuming*; it only means new
  // calls stay blocked until the next business day. Informational only.
  checks.push({
    key: 'daily_call_limit',
    label: 'Daily call limit',
    ok: usedCalls < dailyLimit,
    required: false,
    detail:
      usedCalls < dailyLimit
        ? `${usedCalls}/${dailyLimit} calls used today`
        : `Daily limit reached (${usedCalls}/${dailyLimit}) - new calls stay blocked until the next business day`,
  });

  const costRow = db
    .prepare(`SELECT used_value FROM budget_usage WHERE usage_date = ? AND metric = 'cost_minor'`)
    .get(businessDayKey) as { used_value: number } | undefined;
  const usedCost = costRow?.used_value ?? 0;
  checks.push({
    key: 'daily_budget',
    label: 'Daily budget',
    ok: usedCost < budget.limitMinor || budget.limitMinor === 0,
    required: usedCost >= budget.limitMinor && budget.limitMinor > 0,
    detail:
      usedCost >= budget.limitMinor && budget.limitMinor > 0
        ? `Budget exhausted (${usedCost}/${budget.limitMinor} minor units). Resume requires explicit owner approval of a budget increase.`
        : `Spent ${usedCost} of ${budget.limitMinor} minor units today`,
  });

  const criticalOpen = (
    db
      .prepare(`SELECT COUNT(*) c FROM incidents WHERE severity = 'critical' AND status IN ('open','investigating')`)
      .get() as { c: number }
  ).c;
  checks.push({
    key: 'open_incidents',
    label: 'Critical incidents',
    ok: criticalOpen === 0,
    required: false,
    detail: criticalOpen === 0 ? 'No open critical incidents' : `${criticalOpen} open critical incident(s)`,
  });

  checks.push({
    key: 'emergency_stop',
    label: 'Emergency stop',
    ok: !state.emergencyStop || opts.ignoreEmergencyStop === true,
    required: true,
    detail: state.emergencyStop
      ? opts.ignoreEmergencyStop
        ? 'Emergency stop is active and is being cleared by this owner action'
        : 'Emergency stop is active and must be cleared explicitly by the owner'
      : 'Emergency stop is not active',
  });

  const canResume = checks.every((c) => !c.required || c.ok);
  return { canResume, checks };
}

function dayKeyFor(cfg: Config, now: Date): string {
  // Imported lazily to keep this module free of cycles.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: cfg.businessTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

export interface ResumeResult {
  state: OperatingState;
  evaluation: ResumeEvaluation;
}

/** Owner-initiated resume. Clears pause AND emergency stop in one audited action. */
export function resume(db: DB, cfg: Config, actor: Actor, options: { clearEmergencyStop: boolean }): ResumeResult {
  const evaluation = evaluateResume(db, cfg, { ignoreEmergencyStop: options.clearEmergencyStop });
  if (!evaluation.canResume) {
    throw new AppError(
      'blocked_by_safeguard',
      'Resume blocked by safeguard checks',
      { checks: evaluation.checks },
    );
  }
  if (options.clearEmergencyStop) {
    const state = getOperatingState(db);
    if (state.emergencyStop && actor.label !== 'owner') {
      throw new AppError('forbidden', 'Only the owner may clear an emergency stop');
    }
  }
  const at = nowIso();
  const state = getOperatingState(db);
  db.prepare(
    `UPDATE operating_state
        SET paused = 0,
            pause_reason = NULL,
            paused_at = NULL,
            resumed_at = ?,
            resumed_by = ?,
            emergency_stop = CASE WHEN ? = 1 AND emergency_stop = 1 THEN 0 ELSE emergency_stop END,
            emergency_stop_reason = CASE WHEN ? = 1 AND emergency_stop = 1 THEN NULL ELSE emergency_stop_reason END,
            emergency_stop_at = CASE WHEN ? = 1 AND emergency_stop = 1 THEN NULL ELSE emergency_stop_at END,
            emergency_stop_by = CASE WHEN ? = 1 AND emergency_stop = 1 THEN NULL ELSE emergency_stop_by END,
            updated_at = ?
      WHERE id = 1`,
  ).run(at, actor.userId, options.clearEmergencyStop ? 1 : 0, options.clearEmergencyStop ? 1 : 0, options.clearEmergencyStop ? 1 : 0, options.clearEmergencyStop ? 1 : 0, at);

  // Tasks blocked by the emergency stop return to 'scheduled' so queues survive.
  if (options.clearEmergencyStop) {
    db.prepare(
      `UPDATE followup_tasks
          SET status = 'scheduled', blocked_reason = NULL, updated_at = ?
        WHERE status = 'blocked' AND blocked_reason = 'emergency_stop'`,
    ).run(at);
  }

  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: 'system.resume',
    entityType: 'operating_state',
    entityId: '1',
    summary: `System resumed by ${actor.displayName ?? actor.label}; emergency stop ${options.clearEmergencyStop ? 'cleared' : 'left active'}`,
    details: { checks: evaluation.checks, clearedEmergencyStop: options.clearEmergencyStop, previousMode: state.mode },
    ipHash: actor.ipHash ?? null,
  });
  return { state: getOperatingState(db), evaluation };
}

/**
 * Switch between simulation and live.
 * - 'live' requires telephony credentials to be present (provider setup) and
 *   is always audited; it never cancels an active emergency stop.
 */
/**
 * Switch the operating mode.
 *
 * Phase 11B guardrails for entering LIVE mode (all must hold, in order):
 *  1. a telephony provider is CONFIGURED (credentials present),
 *  2. the actor is the OWNER (route additionally enforces CSRF + fresh reauth),
 *  3. the telephony integration is ONBOARD-VERIFIED (`provider_onboardings`
 *     state = 'verified', proven by a free ping() probe — credentials having
 *     merely *worked once* is not enough; the owner must verify them),
 *  4. an explicit `live_activations` record is written with the checks that
 *     passed — so every period of live operation is attributable.
 *
 * Switching back to SIMULATION closes any active activation record
 * (`reverted_at`) — simulation is always available and always safe.
 */
export function setMode(db: DB, cfg: Config, mode: OperatingMode, actor: Actor): OperatingState {
  if (mode === 'live') {
    const telephony = cfg.providers.find((p) => p.key === 'telephony');
    if (!telephony || telephony.state !== 'configured') {
      throw new AppError(
        'provider_unavailable',
        'Cannot enable live mode: no telephony provider is configured. Add credentials to .env, restart, and configure channels first.',
        { provider: telephony ? { key: telephony.key, state: telephony.state, missing: telephony.missing } : null },
      );
    }
    if (actor.label !== 'owner') {
      throw new AppError('forbidden', 'Only the owner may enable live outreach');
    }

    // Phase 11B: the telephony credentials must be VERIFIED via onboarding,
    // not merely present. This is the guardrail that stops a half-configured
    // or rejected credential set from ever reaching a real call.
    const onboarding = getOnboarding(db, 'telephony');
    if (onboarding.state !== 'verified') {
      throw new AppError(
        'blocked_by_safeguard',
        'Cannot enable live mode: the telephony provider has not been verified. Run provider onboarding (free connection test) first.',
        { integration: 'telephony', onboarding: onboarding.state, lastDetail: onboarding.detail },
      );
    }
  }

  const at = nowIso();
  const current = getOperatingState(db);

  if (mode === 'live' && current.mode !== 'live') {
    // Explicit activation record: which guardrail checks actually passed.
    const activationId = `lact_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const onboarding = getOnboarding(db, 'telephony');
    db.prepare(
      `INSERT INTO live_activations (id, activated_at, activated_by, checks_json, detail)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      activationId,
      at,
      actor.userId,
      JSON.stringify({
        telephonyConfigured: true,
        telephonyVerified: true,
        telephonyProvider: onboarding.provider,
        onboardingVerifiedAt: onboarding.verifiedAt,
        ownerRole: true,
        // Fresh password re-authentication is enforced at the HTTP layer
        // (requireReauth on POST /api/state/mode) — recorded here by reference.
        reauthRequiredByRoute: true,
      }),
      'Owner activated live mode after telephony onboarding verification',
    );
  }

  if (mode === 'simulation') {
    // Revert: close any active activation record (append-only — rows are
    // never deleted, only stamped).
    db.prepare(
      `UPDATE live_activations SET reverted_at = ?, reverted_by = ? WHERE reverted_at IS NULL`,
    ).run(at, actor.userId);
  }

  db.prepare('UPDATE operating_state SET mode = ?, updated_at = ? WHERE id = 1').run(mode, at);
  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: mode === 'live' ? 'mode.live_enabled' : 'mode.simulation_enabled',
    entityType: 'operating_state',
    entityId: '1',
    summary:
      mode === 'live'
        ? 'Operating mode changed to LIVE (real outreach permitted subject to safeguards)'
        : 'Operating mode changed to SIMULATION (no real outreach possible)',
    details: { mode },
    ipHash: actor.ipHash ?? null,
  });
  return getOperatingState(db);
}

export interface LiveActivation {
  id: string;
  activatedAt: string;
  activatedBy: string | null;
  checks: Record<string, unknown>;
  detail: string | null;
  revertedAt: string | null;
  revertedBy: string | null;
}

/** Latest live activation record (active or reverted), for dashboards. */
export function latestActivation(db: DB): LiveActivation | null {
  const row = db.prepare('SELECT * FROM live_activations ORDER BY activated_at DESC, id DESC LIMIT 1').get() as
    | {
        id: string;
        activated_at: string;
        activated_by: string | null;
        checks_json: string;
        detail: string | null;
        reverted_at: string | null;
        reverted_by: string | null;
      }
    | undefined;
  if (!row) return null;
  let checks: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(row.checks_json);
    if (parsed && typeof parsed === 'object') checks = parsed as Record<string, unknown>;
  } catch {
    /* corrupt json: expose empty checks rather than throwing */
  }
  return {
    id: row.id,
    activatedAt: row.activated_at,
    activatedBy: row.activated_by,
    checks,
    detail: row.detail,
    revertedAt: row.reverted_at,
    revertedBy: row.reverted_by,
  };
}

export interface GuardStateSummary {
  mode: OperatingMode;
  emergencyStop: boolean;
  paused: boolean;
  /** True only when outbound work may be attempted at all. */
  outreachEnabled: boolean;
  reason: string;
}

export function summarise(db: DB): GuardStateSummary {
  const s = getOperatingState(db);
  if (s.emergencyStop) {
    return {
      mode: s.mode,
      emergencyStop: true,
      paused: s.paused,
      outreachEnabled: false,
      reason: `Emergency stop active: ${s.emergencyStopReason ?? 'no reason recorded'}`,
    };
  }
  if (s.paused) {
    return {
      mode: s.mode,
      emergencyStop: false,
      paused: true,
      outreachEnabled: false,
      reason: `Outreach paused (${s.pauseReason ?? 'unspecified'}) - manual owner resume required`,
    };
  }
  if (s.mode === 'simulation') {
    return {
      mode: s.mode,
      emergencyStop: false,
      paused: false,
      outreachEnabled: true,
      reason: 'Simulation mode: actions are simulated and never contact real customers',
    };
  }
  return { mode: s.mode, emergencyStop: false, paused: false, outreachEnabled: true, reason: 'Live mode' };
}
