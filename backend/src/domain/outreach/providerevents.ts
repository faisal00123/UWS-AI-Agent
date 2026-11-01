/**
 * Provider event ingestion (Section 3.6 / Phase 7).
 *
 * Every callback from a provider (Twilio status, Meta delivery receipt,
 * inbound WhatsApp message) enters through `ingestProviderEvent`:
 *
 *  - IDEMPOTENT: (provider, event_id) is UNIQUE in `provider_events`; a
 *    replayed webhook increments `duplicate_count` and changes nothing else,
 *    so a provider that retries can never double-apply a delivery receipt or
 *    double-count a suppression.
 *  - AUDITABLE: the raw payload is stored once, with the apply result, so a
 *    reconciliation question ("did Meta really report this as read?") has an
 *    answer.
 *  - CONSERVATIVE: an event that matches nothing (unknown call/message/sender)
 *    is recorded as `ignored` with a reason — never an error, never a guess.
 *
 * Opt-out handling lives here too: an inbound STOP-class message from a known
 * number suppresses the lead IMMEDIATELY (authoritative, append-only) before
 * anything else is recorded, so even a later crash cannot un-suppress them.
 */
import type { DB } from '../../db/index.ts';
import { tx } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { nowIso } from '../../core/time.ts';
import { recordInteraction } from '../pipeline/interactions.ts';
import { suppress } from '../eligibility/service.ts';
import { notify } from '../notifications/service.ts';

export type EventResult = 'applied' | 'duplicate' | 'ignored';

export interface ProviderEventInput {
  provider: string;
  /** Stable unique id for this event (provider-specific, dedupe key). */
  eventId: string;
  eventType: string;
  resourceType: 'call' | 'message' | 'unknown';
  resourceId: string | null;
  payload: unknown;
}

export interface IngestOutcome {
  result: EventResult;
  detail: string;
}

/**
 * Idempotently record an event and apply it. `apply` runs inside the same
 * transaction as the event row; returning null means "nothing matched" and is
 * stored as an ignored result.
 */
export function ingestProviderEvent(
  db: DB,
  input: ProviderEventInput,
  apply: (payload: unknown) => string | null,
): IngestOutcome {
  const at = nowIso();
  let eventId: number;
  try {
    const res = db
      .prepare(
        `INSERT INTO provider_events (provider, event_id, event_type, resource_type, resource_id, payload_json, received_at, processed_at, process_result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.provider,
        input.eventId,
        input.eventType,
        input.resourceType,
        input.resourceId,
        JSON.stringify(input.payload ?? null),
        at,
        at,
        'pending',
      );
    eventId = Number(res.lastInsertRowid);
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('UNIQUE') || msg.includes('ux_provider_events')) {
      db.prepare(
        `UPDATE provider_events SET duplicate_count = duplicate_count + 1
          WHERE provider = ? AND event_id = ?`,
      ).run(input.provider, input.eventId);
      return { result: 'duplicate', detail: 'Event already ingested; duplicate ignored' };
    }
    throw err;
  }

  const detail = tx(db, () => {
    const applied = apply(input.payload);
    const d = applied ?? 'No matching resource; event recorded but not applied';
    db.prepare(`UPDATE provider_events SET process_result = ? WHERE id = ?`).run(
      applied ? `applied: ${d}` : `ignored: ${d}`,
      eventId,
    );
    return d;
  });

  return detail.startsWith('No matching') || !detail
    ? { result: 'ignored', detail }
    : { result: 'applied', detail };
}

// --------------------------------------------------------------- applying ---

/** Twilio CallStatus -> our calls.status vocabulary. */
const TWILIO_CALL_STATUS: Record<string, string> = {
  queued: 'queued',
  initiated: 'queued',
  ringing: 'ringing',
  'in-progress': 'in_progress',
  in_progress: 'in_progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no_answer',
  no_answer: 'no_answer',
  failed: 'failed',
  canceled: 'cancelled',
  cancelled: 'cancelled',
};

export interface TwilioCallCallback {
  CallSid?: string;
  CallStatus?: string;
  CallDuration?: string;
  businessId?: string;
  attemptId?: string;
}

/** Apply one Twilio status callback. Returns detail, or null if unknown. */
export function applyCallStatusEvent(db: DB, payload: unknown): string | null {
  const p = (payload ?? {}) as TwilioCallCallback;
  if (!p.CallSid) return null;
  const call = db.prepare('SELECT id, status FROM calls WHERE provider_call_id = ?').get(p.CallSid) as
    | { id: string; status: string }
    | undefined;
  if (!call) return null;

  const mapped = p.CallStatus ? TWILIO_CALL_STATUS[p.CallStatus] : undefined;
  if (!mapped) return null;

  const at = nowIso();
  const duration = p.CallDuration ? Number.parseInt(p.CallDuration, 10) : null;
  const terminal = ['completed', 'busy', 'no_answer', 'failed', 'cancelled'].includes(mapped);

  // Outcome is only asserted from facts the provider reported.
  let outcome: string | null = null;
  if (mapped === 'completed') outcome = duration && duration > 0 ? 'answered' : 'unanswered';
  else if (mapped === 'busy' || mapped === 'no_answer' || mapped === 'cancelled') outcome = 'unanswered';
  else if (mapped === 'failed') outcome = 'failed';

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
  return `call ${p.CallSid} -> ${mapped}`;
}

export interface MetaMessageStatus {
  id?: string;
  status?: string;
  timestamp?: string;
  errors?: { code?: number; message?: string }[];
}

/** Apply one Meta delivery status. Returns detail, or null if unknown. */
export function applyMessageStatusEvent(db: DB, payload: unknown): string | null {
  const p = (payload ?? {}) as MetaMessageStatus;
  if (!p.id || !p.status) return null;
  const msg = db.prepare('SELECT id FROM messages WHERE provider_message_id = ?').get(p.id) as
    | { id: string }
    | undefined;
  if (!msg) return null;

  // Meta statuses map onto ours; unknown values are recorded as 'unknown'.
  const mapped = ['sent', 'delivered', 'read', 'failed', 'rejected', 'blocked'].includes(p.status)
    ? p.status
    : 'unknown';
  const err = p.errors?.[0];
  db.prepare(
    `UPDATE messages
        SET status = ?, status_source = 'provider_event', last_status_at = ?,
            error_code = COALESCE(?, error_code), error_detail = COALESCE(?, error_detail),
            updated_at = ?
      WHERE id = ?`,
  ).run(mapped, nowIso(), err?.code != null ? String(err.code) : null, err?.message ?? null, nowIso(), msg.id);
  return `message ${p.id} -> ${mapped}`;
}

/** Words that unambiguously mean "never contact me again". */
const OPT_OUT_WORDS = [
  'stop',
  'stop texting',
  'stop calling',
  'unsubscribe',
  'opt out',
  'optout',
  'remove me',
  'remove my number',
  'do not call',
  "don't call",
  'no messages',
  'band karo',
  'ruk jao',
];

/** Words that unambiguously mean "yes, you may contact me" (Phase 11A). */
const OPT_IN_WORDS = [
  'yes',
  'ok',
  'okay',
  'interested',
  'interested yes',
  'sure',
  'haan',
  'han',
  'bilkul',
  'theek hai',
  'chalo',
  'continue',
  'keep me updated',
  'send portfolio',
  'haan bhejo',
];

export function isOptOutText(body: string): boolean {
  const t = body.trim().toLowerCase().replace(/[.!?]+$/, '');
  return OPT_OUT_WORDS.includes(t);
}

/**
 * Opt-IN detection (Phase 11A): a known sender explicitly consenting to
 * contact. Policy:
 *  - records an inbound interaction + notifies the owner (dashboard/email);
 *  - does NOT automatically lift an existing suppression — suppression is
 *    append-only and only an owner action may remove it (kept for 11B where
 *    the owner reviews and approves unsuppression explicitly).
 */
export function isOptInText(body: string): boolean {
  const t = body.trim().toLowerCase().replace(/[.!?]+$/, '');
  return OPT_IN_WORDS.includes(t);
}

interface MetaInboundMessage {
  id?: string;
  from?: string;
  type?: string;
  timestamp?: string;
  text?: { body?: string };
}

interface MetaInboundPayload {
  value?: {
    messages?: MetaInboundMessage[];
  };
}

/**
 * Apply an inbound WhatsApp message for a known sender:
 *   1. opt-out words -> suppress FIRST (authoritative, survives everything)
 *   2. opt-in words  -> record consent + notify owner (does NOT auto-lift an
 *      existing suppression: that stays an explicit owner action, 11B)
 *   3. record an inbound interaction (real customer contact: direction
 *      'inbound', simulation 0)
 * Returns detail, or null when no lead matches the sender.
 */
export function applyInboundMessageEvent(db: DB, payload: unknown, cfg?: Config): string | null {
  const p = (payload ?? {}) as MetaInboundPayload;
  const msg = p.value?.messages?.[0];
  if (!msg?.from || !msg.id) return null;

  const raw = msg.from.trim();
  const e164 = raw.startsWith('+') ? raw : `+${raw}`;
  const lead = db
    .prepare(
      `SELECT id, display_name FROM businesses
        WHERE (whatsapp_e164 IS NOT NULL AND whatsapp_e164 = ?)
           OR (phone_e164 IS NOT NULL AND phone_e164 = ?)
        ORDER BY merged_into_id IS NULL DESC, created_at ASC LIMIT 1`,
    )
    .get(e164, e164) as { id: string; display_name: string } | undefined;
  if (!lead) return null;

  const body = msg.type === 'text' ? (msg.text?.body ?? '') : '';
  const optedOut = body.length > 0 && isOptOutText(body);
  const optedIn = !optedOut && body.length > 0 && isOptInText(body);

  // 1. Suppression first: append-only and authoritative.
  if (optedOut) {
    suppress(db, {
      businessId: lead.id,
      scope: 'business',
      reason: 'opt_out',
      source: 'message',
      evidence: `WhatsApp inbound "${body.slice(0, 60)}" (${msg.id})`,
      createdBy: null,
    });
  }

  // 2. Timeline entry. Preview truncated; full payload already in provider_events.
  const preview =
    msg.type === 'text'
      ? body.slice(0, 200)
      : `(non-text inbound: ${msg.type ?? 'unknown type'})`;
  recordInteraction(db, {
    businessId: lead.id,
    kind: 'whatsapp_message',
    direction: 'inbound',
    summary: optedOut
      ? `Inbound WhatsApp OPT-OUT: "${preview}"`
      : optedIn
        ? `Inbound WhatsApp OPT-IN: "${preview}"`
        : `Inbound WhatsApp: ${preview}`,
    outcome: optedOut ? 'opted_out' : optedIn ? 'opt_in_received' : 'inbound_received',
    evidence: { providerMessageId: msg.id, optOut: optedOut, optIn: optedIn, simulated: false },
    occurredAt: msg.timestamp ? new Date(Number(msg.timestamp) * 1000).toISOString() : null,
    simulation: false,
  });

  // 2b. Opt-in: notify the owner (dashboard/email per destinations). The
  //     suppression list is NOT modified — consent to contact does not by
  //     itself erase a prior STOP (append-only policy; owner approves any
  //     unsuppression explicitly in 11B).
  if (optedIn && cfg) {
    try {
      notify(db, cfg, {
        kind: 'whatsapp_opt_in',
        severity: 'info',
        title: `WhatsApp opt-in from ${lead.display_name}`,
        body:
          `Sender ${e164} replied with an opt-in message: "${body.slice(0, 120)}". ` +
          `Lead ${lead.id} may now be contacted — review any existing suppression before outreach.`,
        dedupeKey: `whatsapp_opt_in:${lead.id}:${msg.id}`,
        entityType: 'business',
        entityId: lead.id,
      });
    } catch {
      // notification failure must never break webhook processing
    }
  }

  if (optedOut) {
    return `inbound opt-out from ${e164} suppressed lead ${lead.id}`;
  }
  if (optedIn) {
    return `inbound opt-in from ${e164} recorded for lead ${lead.id} (owner notified)`;
  }
  return `inbound message from ${e164} recorded for lead ${lead.id}`;
}
