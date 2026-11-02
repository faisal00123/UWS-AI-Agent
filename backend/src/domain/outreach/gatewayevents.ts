/**
 * Gateway (CloudyVoice/SIP) call-lifecycle events.
 *
 * The gateway is OUR process, so the vocabulary below is OUR contract (see
 * `deploy/sip/contract.md`) — nothing here is asserted about CloudyVoice's own
 * API, which does not exist for call placement (it is a SIP carrier). The
 * gateway observes SIP signalling and posts signed JSON to
 * `/api/webhooks/telephony/gateway/events`; this module turns that into the
 * exact same `calls` ledger transitions Twilio's status webhook produces.
 *
 * Two independent facts can arrive:
 *
 *   status    the gateway's own lifecycle word (contract-defined)
 *   sipCause  the Q.850 / RFC 4499 release cause from the network
 *
 * An unknown status never guesses: if a numeric cause is present it is mapped
 * through `sipCauseToStatus`, and if neither is recognised the event is
 * recorded but applied to NOTHING (the route reports `ignored`). Outcomes are
 * only ever asserted from facts actually reported — duration decides whether a
 * `completed` call was answered, exactly as `applyCallStatusEvent` does.
 */
import type { DB } from '../../db/index.ts';
import { nowIso } from '../../core/time.ts';

/** Gateway lifecycle status -> our `calls.status` vocabulary. */
export const GATEWAY_CALL_STATUS: Record<string, string> = {
  queued: 'queued',
  initiating: 'queued',
  trying: 'queued',
  routing: 'queued',
  ringing: 'ringing',
  early_media: 'ringing',
  answered: 'in_progress',
  active: 'in_progress',
  bridged: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  no_answer: 'no_answer',
  timeout: 'no_answer',
  failed: 'failed',
  rejected: 'failed',
  error: 'failed',
  cancelled: 'cancelled',
  canceled: 'cancelled',
};

export interface GatewayStatusFact {
  status: string;
  /** Outcome to force, or null to derive it from the reported duration. */
  outcome: string | null;
}

/**
 * Q.850 cause -> our status/outcome. Only causes with an unambiguous reading
 * are listed; anything else maps to a plain `failed` (never a guess at
 * `answered`). `outcome: null` means "derive from duration" (normal clearing).
 */
const SIP_CAUSES: Record<number, GatewayStatusFact> = {
  1: { status: 'completed', outcome: null }, // normal call clearing
  16: { status: 'completed', outcome: null }, // normal call clearing
  17: { status: 'busy', outcome: 'unanswered' }, // user busy
  18: { status: 'no_answer', outcome: 'unanswered' }, // no user responding
  19: { status: 'no_answer', outcome: 'unanswered' }, // no answer on ringing
  20: { status: 'no_answer', outcome: 'unanswered' }, // absent subscriber
  21: { status: 'failed', outcome: 'failed' }, // call rejected
  22: { status: 'failed', outcome: 'wrong_number' }, // number changed
  27: { status: 'failed', outcome: 'failed' }, // destination out of order
  28: { status: 'failed', outcome: 'wrong_number' }, // invalid number format
  34: { status: 'failed', outcome: 'failed' }, // no circuit/channel available
  38: { status: 'failed', outcome: 'failed' }, // network out of order
  41: { status: 'failed', outcome: 'failed' }, // temporary failure
  42: { status: 'failed', outcome: 'failed' }, // switching equipment congestion
  47: { status: 'failed', outcome: 'failed' }, // resource unavailable
  50: { status: 'failed', outcome: 'failed' }, // requested facility not subscribed
  55: { status: 'failed', outcome: 'failed' }, // incoming calls barred
  58: { status: 'failed', outcome: 'failed' }, // bearer capability not implemented
  86: { status: 'failed', outcome: 'failed' }, // bearer capability not authorised
};

/** Map a SIP release cause to our status vocabulary (never guesses). */
export function sipCauseToStatus(cause: number): GatewayStatusFact {
  return SIP_CAUSES[cause] ?? { status: 'failed', outcome: 'failed' };
}

export interface GatewayCallEvent {
  /** Stable dedupe id minted by the gateway (required by the route). */
  eventId?: string;
  /** Our/gateway call id — matches `calls.provider_call_id`. */
  callId?: string;
  status?: string;
  sipCause?: number;
  durationSeconds?: number;
  timestamp?: string;
}

const TERMINAL = ['completed', 'busy', 'no_answer', 'failed', 'cancelled'];

/**
 * Apply one gateway lifecycle event. Returns detail, or null when nothing
 * matched (unknown call, or neither the status nor the cause recognised).
 */
export function applyGatewayCallEvent(db: DB, payload: unknown): string | null {
  const p = (payload ?? {}) as GatewayCallEvent;
  if (!p.callId) return null;
  const call = db.prepare('SELECT id, status FROM calls WHERE provider_call_id = ?').get(p.callId) as
    | { id: string; status: string }
    | undefined;
  if (!call) return null;

  // 1. The gateway's own word wins when we recognise it.
  let mapped = typeof p.status === 'string' ? GATEWAY_CALL_STATUS[p.status] : undefined;
  let forcedOutcome: string | null = null;
  // 2. Otherwise fall back to the network's release cause (a fact, not a guess).
  if (!mapped && typeof p.sipCause === 'number' && Number.isFinite(p.sipCause)) {
    const fact = sipCauseToStatus(p.sipCause);
    mapped = fact.status;
    forcedOutcome = fact.outcome;
  }
  if (!mapped) return null;

  const at = nowIso();
  const duration =
    typeof p.durationSeconds === 'number' && Number.isFinite(p.durationSeconds) && p.durationSeconds >= 0
      ? Math.floor(p.durationSeconds)
      : null;
  const terminal = TERMINAL.includes(mapped);

  // Outcome is only asserted from facts the gateway reported.
  let outcome: string | null = forcedOutcome;
  if (outcome === null) {
    if (mapped === 'completed') outcome = duration && duration > 0 ? 'answered' : 'unanswered';
    else if (mapped === 'busy' || mapped === 'no_answer' || mapped === 'cancelled') outcome = 'unanswered';
    else if (mapped === 'failed') outcome = 'failed';
  }

  db.prepare(
    `UPDATE calls
        SET status = ?,
            answered_at = CASE WHEN ? = 1 AND answered_at IS NULL THEN ? ELSE answered_at END,
            ended_at = CASE WHEN ? = 1 THEN ? ELSE ended_at END,
            duration_seconds = CASE WHEN ? = 1 AND ? IS NOT NULL THEN ? ELSE duration_seconds END,
            outcome = COALESCE(?, outcome),
            updated_at = ?
      WHERE id = ?`,
  ).run(
    mapped,
    mapped === 'in_progress' ? 1 : 0,
    at,
    terminal ? 1 : 0,
    at,
    terminal ? 1 : 0,
    duration,
    duration,
    outcome,
    at,
    call.id,
  );
  return `call ${p.callId} -> ${mapped}`;
}
