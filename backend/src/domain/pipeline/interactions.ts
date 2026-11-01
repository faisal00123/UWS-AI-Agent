/**
 * Interaction timeline (Section 1.9).
 *
 * Interactions are the evidence layer of the pipeline: every meaningful
 * customer contact is recorded here once, and every stage change or
 * follow-up completion references an interaction so the CRM can show *why* a
 * lead is where it is.
 *
 * Two rules keep this trustworthy:
 *  - A `system`/`score` interaction is NOT customer contact. Automation may
 *    write those, but they can never serve as evidence for a customer-facing
 *    stage like `contacted`/`interested`/`qualified`.
 *  - Direction is recorded explicitly so an inbound reply from the prospect
 *    is distinguishable from an outbound attempt we made.
 */
import type { DB } from '../../db/index.ts';
import { AppError } from '../../core/errors.ts';
import { newId } from '../../core/ids.ts';
import { nowIso } from '../../core/time.ts';

export const INTERACTION_KINDS = [
  'call',
  'whatsapp_message',
  'whatsapp_call',
  'email',
  'meeting',
  'note',
  'followup',
  'import',
  'analysis',
  'system',
  'score',
  'consent',
] as const;
export type InteractionKind = (typeof INTERACTION_KINDS)[number];

export const INTERACTION_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type InteractionDirection = (typeof INTERACTION_DIRECTIONS)[number];

/**
 * Kinds that represent real contact with the customer and may therefore back a
 * customer-facing stage change. Everything else (system, score, import,
 * analysis, plain note) is bookkeeping and cannot be used as evidence.
 */
export const CONTACT_EVIDENCE_KINDS: InteractionKind[] = ['call', 'whatsapp_message', 'whatsapp_call', 'email', 'meeting'];

export interface RecordInteractionInput {
  businessId: string;
  kind: InteractionKind;
  direction?: InteractionDirection | null;
  summary: string;
  outcome?: string | null;
  evidence?: Record<string, unknown> | null;
  occurredAt?: string | null;
  createdBy?: string | null;
  /**
   * True for simulated (rehearsal) contact written by the simulation adapter.
   * Simulated rows are excluded from every honesty rule: they cannot evidence
   * a customer-facing stage change nor complete a follow-up.
   */
  simulation?: boolean;
}

export interface Interaction {
  id: string;
  businessId: string;
  kind: InteractionKind;
  direction: InteractionDirection | null;
  summary: string;
  outcome: string | null;
  evidence: Record<string, unknown> | null;
  occurredAt: string;
  createdBy: string | null;
  simulation: boolean;
}

interface Row {
  id: string;
  business_id: string;
  kind: InteractionKind;
  direction: InteractionDirection | null;
  summary: string;
  outcome: string | null;
  evidence_json: string | null;
  occurred_at: string;
  created_by: string | null;
  simulation: number;
}

function toInteraction(r: Row): Interaction {
  let evidence: Record<string, unknown> | null = null;
  if (r.evidence_json) {
    try {
      evidence = JSON.parse(r.evidence_json) as Record<string, unknown>;
    } catch {
      evidence = null;
    }
  }
  return {
    id: r.id,
    businessId: r.business_id,
    kind: r.kind,
    direction: r.direction,
    summary: r.summary,
    outcome: r.outcome,
    evidence,
    occurredAt: r.occurred_at,
    createdBy: r.created_by,
    simulation: r.simulation === 1,
  };
}

/** Record one interaction and return it. */
export function recordInteraction(db: DB, input: RecordInteractionInput): Interaction {
  const id = newId('int');
  const occurredAt = input.occurredAt ?? nowIso();
  const summary = input.summary.trim();
  if (summary.length === 0) {
    // A validation_failed AppError maps to 400, not a generic 500.
    throw new AppError('validation_failed', 'Interaction summary must not be empty');
  }
  db.prepare(
    `INSERT INTO interactions (id, business_id, kind, direction, summary, outcome, evidence_json, occurred_at, created_by, simulation)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.businessId,
    input.kind,
    input.direction ?? null,
    summary,
    input.outcome ?? null,
    input.evidence ? JSON.stringify(input.evidence) : null,
    occurredAt,
    input.createdBy ?? null,
    input.simulation ? 1 : 0,
  );
  return getInteraction(db, id) as Interaction;
}

export function getInteraction(db: DB, id: string): Interaction | null {
  const r = db.prepare('SELECT * FROM interactions WHERE id = ?').get(id) as Row | undefined;
  return r ? toInteraction(r) : null;
}

export interface InteractionQuery {
  businessId: string;
  kind?: InteractionKind;
  limit?: number;
  /** Ascending (oldest first) — used by conversation reconstruction. */
  order?: 'asc' | 'desc';
}

/** Timeline for a lead, newest first by default. */
export function listInteractions(db: DB, q: InteractionQuery): Interaction[] {
  const limit = q.limit ?? 100;
  const order = q.order === 'asc' ? 'ASC' : 'DESC';
  const rows = (
    q.kind
      ? db
          .prepare(`SELECT * FROM interactions WHERE business_id = ? AND kind = ? ORDER BY occurred_at ${order}, rowid ${order} LIMIT ?`)
          .all(q.businessId, q.kind, limit)
      : db
          .prepare(`SELECT * FROM interactions WHERE business_id = ? ORDER BY occurred_at ${order}, rowid ${order} LIMIT ?`)
          .all(q.businessId, limit)
  ) as unknown as Row[];
  return rows.map(toInteraction);
}

/**
 * True when the lead has at least one interaction that may serve as evidence
 * for a customer-facing stage change (real contact, not bookkeeping).
 *
 * Simulated (rehearsal) contact is excluded: nothing was said to a real
 * person, so it cannot move a lead to `contacted` or beyond.
 */
export function hasContactEvidence(db: DB, businessId: string): boolean {
  const placeholders = CONTACT_EVIDENCE_KINDS.map(() => '?').join(',');
  const row = db
    .prepare(
      `SELECT COUNT(*) c FROM interactions
        WHERE business_id = ? AND kind IN (${placeholders}) AND simulation = 0`,
    )
    .get(businessId, ...CONTACT_EVIDENCE_KINDS) as { c: number };
  return row.c > 0;
}
