/**
 * Pipeline orchestration (Section 1.9).
 *
 * Ties interactions, stage transitions and follow-ups together and enforces
 * the CRM's integrity rules:
 *
 *  - Every customer-facing stage change cites a real contact interaction as
 *    evidence. `system`/`score` interactions are bookkeeping and never count.
 *  - Only the owner can confirm a conversion (`won`). A `won` stage change
 *    without owner confirmation is refused, because revenue and win-rate
 *    reporting are derived from confirmed deals.
 *  - Moving to `interested`/`qualified` without prior contact is refused, so a
 *    lead cannot skip the funnel by editing a field.
 *  - Each automated transition optionally schedules the next follow-up so the
 *    cadence continues without manual bookkeeping.
 */
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import { AppError } from '../../core/errors.ts';
import { changeStage, type LeadStage } from '../leads/repository.ts';
import {
  recordInteraction,
  listInteractions,
  hasContactEvidence,
  type RecordInteractionInput,
} from './interactions.ts';
import { scheduleFollowup, type FollowupTask, type FollowupType } from './followups.ts';

export interface PipelineActor {
  userId: string | null;
  label: 'owner' | 'staff' | 'system' | 'scheduler';
}

/** Stages that may not be reached without a prior real customer contact. */
const STAGES_NEEDING_CONTACT: LeadStage[] = ['contacted', 'interested', 'qualified'];

/** Default cadence used when a stage should auto-schedule a next touch. */
const DEFAULT_CADENCE_DAYS: Record<string, number[]> = {
  contacted: [3, 7, 14],
  interested: [2, 5],
  qualified: [1, 4],
};

export interface AdvanceResult {
  from: string;
  to: LeadStage;
  interactionId: string;
  scheduled: FollowupTask[];
}

export interface AdvanceInput {
  businessId: string;
  toStage: LeadStage;
  reason: string;
  /** Real-contact interaction backing the move. Created if `interaction` given. */
  interaction?: RecordInteractionInput | null;
  evidenceInteractionId?: string | null;
  /** Schedule the next follow-up cadence for the new stage (default true). */
  autoSchedule?: boolean;
  actor: PipelineActor;
}

/**
 * Advance a lead through the pipeline with a supporting interaction.
 *
 * Either pass an existing `evidenceInteractionId` or an `interaction` object to
 * record in the same step; both paths end with a persisted interaction that the
 * stage history references.
 */
export function advanceStage(db: DB, cfg: Config, input: AdvanceInput): AdvanceResult {
  const current = db.prepare('SELECT stage FROM businesses WHERE id = ?').get(input.businessId) as
    | { stage: LeadStage }
    | undefined;
  if (!current) throw new AppError('not_found', 'Lead not found');
  const from = current.stage;

  // Record the interaction first so we have an id to cite as evidence.
  let interactionId: string;
  if (input.interaction) {
    const created = recordInteraction(db, {
      ...input.interaction,
      businessId: input.businessId,
      createdBy: input.interaction.createdBy ?? input.actor.userId,
    });
    interactionId = created.id;
  } else if (input.evidenceInteractionId) {
    interactionId = input.evidenceInteractionId;
  } else {
    throw new AppError(
      'validation_failed',
      'A stage change requires either a recorded interaction or an existing evidence interaction id',
      { toStage: input.toStage },
    );
  }

  // Guard: contact-gated stages need prior real contact evidence.
  if (STAGES_NEEDING_CONTACT.includes(input.toStage) && !hasContactEvidence(db, input.businessId)) {
    throw new AppError(
      'validation_failed',
      `Moving to "${input.toStage}" requires at least one real customer contact on record`,
      { toStage: input.toStage },
    );
  }

  // Guard: only the owner may confirm a conversion.
  if (input.toStage === 'won' && input.actor.label !== 'owner') {
    throw new AppError('forbidden', 'Only the owner can confirm a conversion (won)', { toStage: 'won' });
  }

  const result = changeStage(db, input.businessId, input.toStage, {
    reason: input.reason,
    evidenceInteractionId: interactionId,
    actor: input.actor,
  });

  const scheduled: FollowupTask[] = [];
  if (input.autoSchedule !== false) {
    const cadence = DEFAULT_CADENCE_DAYS[input.toStage];
    if (cadence) {
      const now = Date.now();
      cadence.forEach((days, i) => {
        scheduled.push(
          scheduleFollowup(db, cfg, {
            businessId: input.businessId,
            type: (i === 0 ? 'followup_call' : 'followup_message') as FollowupType,
            title: `Follow-up ${i + 1} after ${input.toStage}`,
            scheduledFor: new Date(now + days * 86_400_000).toISOString(),
            followupSequence: i + 1,
            createdBy: input.actor.userId,
          }),
        );
      });
    }
  }

  return { from, to: input.toStage, interactionId, scheduled };
}

/** Full timeline for a lead, newest first. */
export function timeline(db: DB, businessId: string, limit = 200) {
  return listInteractions(db, { businessId, limit });
}

/** Count of interactions by kind, used by the pipeline summary. */
export function interactionCounts(db: DB, businessId: string): Record<string, number> {
  const rows = db
    .prepare('SELECT kind, COUNT(*) c FROM interactions WHERE business_id = ? GROUP BY kind')
    .all(businessId) as unknown as { kind: string; c: number }[];
  const out: Record<string, number> = {};
  for (const r of rows) out[r.kind] = r.c;
  return out;
}
