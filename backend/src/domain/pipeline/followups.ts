/**
 * Follow-up scheduling (Section 1.9 / 3.3).
 *
 * A follow-up is a promise to act later, and this module is the engine that
 * keeps those promises honest:
 *
 *  - Sequence-based scheduling: a cadence (e.g. 3 steps: 2d, 5d, 10d) expands
 *    into concrete tasks, each aware of its position so a reply can stop the
 *    rest.
 *  - Time-window safety: tasks are only placed inside owner-configured calling
 *    hours and never on configured quiet days. Anything that would fall inside
 *    a quiet window is pushed to the next allowed slot rather than dropped.
 *  - Eligibility is re-checked when a task becomes due. If the lead has since
 *    opted out, been suppressed, or the channel was disabled, the task is
 *    marked `blocked` with a reason — it is never silently executed.
 *  - One active task per (lead, type, time): enforced by a partial unique index
 *    and caught here so a duplicate schedule is a clean conflict, not a crash.
 *
 * Nothing here performs outreach; it only produces due work and records state.
 */
import type { SQLInputValue } from 'node:sqlite';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { getSetting } from '../settings/service.ts';
import { evaluateEligibility, type Channel } from '../eligibility/service.ts';

export const FOLLOWUP_TYPES = [
  'callback',
  'meeting',
  'followup_call',
  'followup_message',
  'task',
  'human_handoff',
] as const;
export type FollowupType = (typeof FOLLOWUP_TYPES)[number];

export const FOLLOWUP_STATUSES = [
  'scheduled',
  'due',
  'running',
  'completed',
  'cancelled',
  'blocked',
  'failed',
  'missed',
] as const;
export type FollowupStatus = (typeof FOLLOWUP_STATUSES)[number];

/** Statuses that count against the one-active-task-per-slot rule. */
const ACTIVE_STATUSES = ['scheduled', 'due', 'running'];

export interface FollowupTask {
  id: string;
  businessId: string;
  type: FollowupType;
  title: string;
  notes: string | null;
  scheduledFor: string;
  timezone: string;
  channel: Channel | 'manual' | null;
  followupSequence: number;
  status: FollowupStatus;
  blockedReason: string | null;
  requestedByCustomer: boolean;
  completedAt: string | null;
  completedInteractionId: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Row {
  id: string;
  business_id: string;
  type: FollowupType;
  title: string;
  notes: string | null;
  scheduled_for: string;
  timezone: string;
  channel: Channel | 'manual' | null;
  followup_sequence: number;
  status: FollowupStatus;
  blocked_reason: string | null;
  requested_by_customer: number;
  completed_at: string | null;
  completed_interaction_id: string | null;
  cancel_reason: string | null;
  created_at: string;
  updated_at: string;
}

function toTask(r: Row): FollowupTask {
  return {
    id: r.id,
    businessId: r.business_id,
    type: r.type,
    title: r.title,
    notes: r.notes,
    scheduledFor: r.scheduled_for,
    timezone: r.timezone,
    channel: r.channel,
    followupSequence: r.followup_sequence,
    status: r.status,
    blockedReason: r.blocked_reason,
    requestedByCustomer: r.requested_by_customer === 1,
    completedAt: r.completed_at,
    completedInteractionId: r.completed_interaction_id,
    cancelReason: r.cancel_reason,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function parseTime(v: string): number {
  const t = Date.parse(v);
  if (Number.isNaN(t)) throw new AppError('validation_failed', `Invalid time "${v}"`);
  return t;
}

/** Minutes since midnight for a timestamp interpreted in the given offset. */
function minutesOfDay(iso: string, offsetMinutes: number): number {
  const local = new Date(parseTime(iso) + offsetMinutes * 60_000);
  return local.getUTCHours() * 60 + local.getUTCMinutes();
}

/** Day of week (0=Sun..6=Sat) for a timestamp in the given offset. */
function dayOfWeek(iso: string, offsetMinutes: number): number {
  return new Date(parseTime(iso) + offsetMinutes * 60_000).getUTCDay();
}

function offsetMinutesFor(timezone: string): number {
  try {
    // En-CA gives YYYY-MM-DD; the offset format gives +05:00.
    const dtf = new Intl.DateTimeFormat('en-CA', {
      timeZone: timezone,
      timeZoneName: 'longOffset',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
    const parts = dtf.formatToParts(new Date());
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '';
    const date = `${get('year')}-${get('month')}-${get('day')}`;
    const time = `${get('hour')}:${get('minute')}:${get('second')}`;
    const base = Date.parse(`${date}T${time}Z`);
    const actual = Date.parse(new Date().toISOString());
    return Math.round((base - actual) / 60_000);
  } catch {
    return 0; // fall back to UTC rather than guess
  }
}

export interface WindowConfig {
  start: string;
  end: string;
  days: number[];
  offsetMinutes: number;
}

/**
 * Load the owner's calling window, mapped onto a timezone offset. The channel
 * argument is accepted for future per-channel windows but is currently unused:
 * the owner sets one global calling schedule.
 */
export function callingWindowFor(db: DB, cfg: Config, _channel: Channel): WindowConfig {
  const raw = getSetting<{ startTime: string; endTime: string; days: number[]; timezone: string }>(
    db,
    'calling_schedule',
    cfg,
  );
  return {
    start: raw.startTime,
    end: raw.endTime,
    days: raw.days,
    offsetMinutes: offsetMinutesFor(raw.timezone || cfg.businessTimezone),
  };
}

/** True when `iso` falls inside the allowed calling window. */
export function inCallingWindow(iso: string, w: WindowConfig): boolean {
  const dow = dayOfWeek(iso, w.offsetMinutes);
  if (!w.days.includes(dow)) return false;
  const [sh, sm] = w.start.split(':').map(Number) as [number, number];
  const [eh, em] = w.end.split(':').map(Number) as [number, number];
  const startMin = sh * 60 + sm;
  const endMin = eh * 60 + em;
  const cur = minutesOfDay(iso, w.offsetMinutes);
  // Overnight windows (end <= start) wrap past midnight.
  return endMin > startMin ? cur >= startMin && cur < endMin : cur >= startMin || cur < endMin;
}

/**
 * Advance `iso` to the next moment inside the calling window. If it already
 * qualifies it is returned unchanged.
 */
export function nextAllowedSlot(iso: string, w: WindowConfig): string {
  if (inCallingWindow(iso, w)) return iso;
  const [sh, sm] = w.start.split(':').map(Number) as [number, number];
  let t = parseTime(iso);
  const dayMs = 86_400_000;
  for (let i = 0; i < 8; i++) {
    const candidate = t + i * dayMs;
    const isoCand = new Date(candidate).toISOString();
    const dow = dayOfWeek(isoCand, w.offsetMinutes);
    if (!w.days.includes(dow)) continue;
    const cur = minutesOfDay(isoCand, w.offsetMinutes);
    const startMin = sh * 60 + sm;
    if (cur < startMin) {
      // push to today's start
      const push = (startMin - cur) * 60_000;
      return new Date(candidate + push).toISOString();
    }
    return isoCand;
  }
  // No allowed day within a week (misconfigured window) — return as-is.
  t += dayMs;
  return new Date(t).toISOString();
}

export interface ScheduleFollowupInput {
  businessId: string;
  type: FollowupType;
  title: string;
  notes?: string | null;
  /** When the first task should fire. */
  scheduledFor: string;
  channel?: Channel | 'manual' | null;
  followupSequence?: number;
  requestedByCustomer?: boolean;
  createdBy?: string | null;
  /** Skip the calling-window adjustment (customer-requested times, meetings). */
  respectWindow?: boolean;
}

/**
 * Create a single follow-up task. Throws a `conflict` error if an active task
 * of the same type already exists at that exact time for the lead.
 */
export function scheduleFollowup(db: DB, cfg: Config, input: ScheduleFollowupInput): FollowupTask {
  const lead = db.prepare('SELECT id FROM businesses WHERE id = ?').get(input.businessId);
  if (!lead) throw notFound('Lead');

  let scheduledFor = input.scheduledFor;
  if (input.respectWindow !== false) {
    // 'manual' and unset channels still have to respect the calling window, so
    // fall back to the voice channel's window for placement.
    const windowChannel: Channel = input.channel && input.channel !== 'manual' ? input.channel : 'call';
    const w = callingWindowFor(db, cfg, windowChannel);
    scheduledFor = nextAllowedSlot(scheduledFor, w);
  }

  const id = newId('fup');
  const at = nowIso();
  try {
    db.prepare(
      `INSERT INTO followup_tasks (id, business_id, type, title, notes, scheduled_for, timezone, channel,
         followup_sequence, status, requested_by_customer, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
    ).run(
      id,
      input.businessId,
      input.type,
      input.title.trim(),
      input.notes ?? null,
      scheduledFor,
      cfg.businessTimezone,
      input.channel ?? null,
      input.followupSequence ?? 1,
      input.requestedByCustomer ? 1 : 0,
      input.createdBy ?? null,
      at,
      at,
    );
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('UNIQUE') || msg.includes('ux_followup_active')) {
      throw new AppError('conflict', 'An active follow-up of this type already exists at that time for this lead', {
        businessId: input.businessId,
        type: input.type,
        scheduledFor,
      });
    }
    throw err;
  }
  return getTask(db, id) as FollowupTask;
}

/**
 * Expand a cadence of offset-days into concrete follow-up tasks, numbered by
 * sequence. Returns the created tasks in sequence order.
 */
export function scheduleSequence(
  db: DB,
  cfg: Config,
  input: {
    businessId: string;
    title: string;
    offsetsDays: number[];
    channel?: Channel | null;
    type?: FollowupType;
    startFrom?: string;
    createdBy?: string | null;
  },
): FollowupTask[] {
  const base = input.startFrom ? parseTime(input.startFrom) : Date.now();
  const out: FollowupTask[] = [];
  input.offsetsDays.forEach((days, i) => {
    out.push(
      scheduleFollowup(db, cfg, {
        businessId: input.businessId,
        type: input.type ?? 'followup_call',
        title: input.title,
        scheduledFor: new Date(base + days * 86_400_000).toISOString(),
        channel: input.channel ?? null,
        followupSequence: i + 1,
        createdBy: input.createdBy ?? null,
      }),
    );
  });
  return out;
}

export function getTask(db: DB, id: string): FollowupTask | null {
  const r = db.prepare('SELECT * FROM followup_tasks WHERE id = ?').get(id) as Row | undefined;
  return r ? toTask(r) : null;
}

export interface TaskQuery {
  businessId?: string;
  status?: FollowupStatus;
  /** Only tasks scheduled at or before this instant. */
  dueBefore?: string;
  limit?: number;
}

export function listTasks(db: DB, q: TaskQuery): FollowupTask[] {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (q.businessId) {
    clauses.push('business_id = ?');
    params.push(q.businessId);
  }
  if (q.status) {
    clauses.push('status = ?');
    params.push(q.status);
  }
  if (q.dueBefore) {
    clauses.push('scheduled_for <= ?');
    params.push(q.dueBefore);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const limit = q.limit ?? 200;
  const rows = db
    .prepare(`SELECT * FROM followup_tasks ${where} ORDER BY scheduled_for ASC LIMIT ?`)
    .all(...params, limit) as unknown as Row[];
  return rows.map(toTask);
}

/**
 * Transition a scheduled/due task to `due`. Kept separate from execution so a
 * scheduler tick can simply mark work that has arrived.
 */
export function markDue(db: DB, id: string): FollowupTask | null {
  const t = getTask(db, id);
  if (!t) return null;
  if (t.status !== 'scheduled' && t.status !== 'due') return t;
  const at = nowIso();
  db.prepare(`UPDATE followup_tasks SET status = 'due', updated_at = ? WHERE id = ?`).run(at, id);
  return getTask(db, id);
}

export interface CompleteInput {
  taskId: string;
  interactionId: string;
  actor: { userId: string | null; label: 'owner' | 'staff' | 'system' | 'scheduler' };
}

/**
 * Complete a follow-up with the interaction that evidences it. If the task
 * required evidence and the interaction is not real customer contact, this
 * refuses — a completed follow-up must have a real outcome on record.
 */
export function completeTask(db: DB, input: CompleteInput): FollowupTask {
  const t = getTask(db, input.taskId);
  if (!t) throw notFound('Follow-up task');
  if (t.status === 'completed') return t;

  const inter = db.prepare('SELECT id, kind, business_id, simulation FROM interactions WHERE id = ?').get(input.interactionId) as
    | { id: string; kind: string; business_id: string; simulation: number }
    | undefined;
  if (!inter) throw new AppError('validation_failed', 'Completion interaction not found');
  if (inter.business_id !== t.businessId) {
    throw new AppError('validation_failed', 'Completion interaction belongs to a different lead');
  }
  // A simulated (rehearsal) call never reached a real person, so it cannot
  // close a follow-up that promised real contact. The owner completes the task
  // once a real interaction is on record.
  if (inter.simulation === 1) {
    throw new AppError(
      'validation_failed',
      'Simulated interactions cannot complete a follow-up: no real customer contact occurred. Record the real call outcome, then complete the task.',
      { taskId: t.id, interactionId: input.interactionId },
    );
  }

  const contactKinds = ['call', 'whatsapp_message', 'whatsapp_call', 'email', 'meeting'];
  if (!contactKinds.includes(inter.kind)) {
    throw new AppError(
      'validation_failed',
      'Completing a follow-up requires a customer-contact interaction (call, message, email or meeting)',
      { taskId: t.id, got: inter.kind },
    );
  }

  const at = nowIso();
  db.prepare(
    `UPDATE followup_tasks SET status = 'completed', completed_at = ?, completed_interaction_id = ?, updated_at = ? WHERE id = ?`,
  ).run(at, input.interactionId, at, t.id);
  return getTask(db, input.taskId) as FollowupTask;
}

/** Cancel a pending task with a reason. Completed tasks cannot be cancelled. */
export function cancelTask(db: DB, taskId: string, reason: string): FollowupTask {
  const t = getTask(db, taskId);
  if (!t) throw notFound('Follow-up task');
  if (t.status === 'completed') {
    throw new AppError('validation_failed', 'A completed follow-up cannot be cancelled');
  }
  const at = nowIso();
  db.prepare(
    `UPDATE followup_tasks SET status = 'cancelled', cancel_reason = ?, updated_at = ? WHERE id = ?`,
  ).run(reason.trim(), at, taskId);
  return getTask(db, taskId) as FollowupTask;
}

export interface DueEvaluation {
  taskId: string;
  decision: 'eligible' | 'ineligible' | 'needs_review';
  blockedReason: string | null;
}

/**
 * Re-check eligibility for every due task before any execution step, so a
 * suppression that happened after scheduling still stops the outreach.
 *
 * Three outcomes:
 *  - eligible       -> task stays 'due' and may be executed.
 *  - needs_review   -> consent is merely unconfirmed. The task stays pending
 *                      and is flagged via blocked_reason; a human records
 *                      consent and it can proceed. It is NOT cancelled.
 *  - ineligible     -> suppressed / no destination / channel disabled. The task
 *                      is moved to 'blocked' and will not run.
 */
export function evaluateDueTasks(db: DB, cfg: Config, dueBefore: string): DueEvaluation[] {
  // Promote first: a scheduled task whose time has arrived becomes 'due'. The
  // engine used to only read 'due' rows, so nothing scheduled could ever be
  // reached (nothing else performs the promotion). The partial unique index
  // treats scheduled and due alike, so this cannot create a duplicate.
  const at = nowIso();
  db.prepare(
    `UPDATE followup_tasks SET status = 'due', updated_at = ?
     WHERE status = 'scheduled' AND scheduled_for <= ?`,
  ).run(at, dueBefore);

  const due = listTasks(db, { status: 'due', dueBefore, limit: 500 });
  const out: DueEvaluation[] = [];
  for (const task of due) {
    if (!task.channel || task.channel === 'manual') {
      out.push({ taskId: task.id, decision: 'eligible', blockedReason: null });
      continue;
    }
    const decision = evaluateEligibility(db, cfg, task.businessId, task.channel as Channel);
    if (decision.decision === 'eligible') {
      out.push({ taskId: task.id, decision: 'eligible', blockedReason: null });
      continue;
    }

    const at = nowIso();
    if (decision.decision === 'needs_review') {
      // "Needs review" is NOT a hard block: consent is merely unconfirmed. We
      // flag the task for a human instead of cancelling the pending work, so
      // the owner can record consent and let the follow-up proceed. The task
      // is not executed until that happens (the executor re-checks).
      const reason = `needs_review: ${decision.reasons[0] ?? 'consent unconfirmed'}`;
      db.prepare(
        `UPDATE followup_tasks SET blocked_reason = ?, updated_at = ? WHERE id = ? AND status = 'due'`,
      ).run(reason, at, task.id);
      out.push({ taskId: task.id, decision: 'needs_review', blockedReason: reason });
      continue;
    }

    // A hard 'ineligible' (suppressed, no destination, channel disabled) stops
    // the task outright.
    const reason = `ineligible: ${decision.reasons[0] ?? 'not eligible'}`;
    db.prepare(
      `UPDATE followup_tasks SET status = 'blocked', blocked_reason = ?, updated_at = ? WHERE id = ?`,
    ).run(reason, at, task.id);
    out.push({ taskId: task.id, decision: 'ineligible', blockedReason: reason });
  }
  return out;
}
