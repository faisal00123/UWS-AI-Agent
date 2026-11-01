/**
 * Opt-in unsuppression review (Phase 11B).
 *
 * A prospect who previously opted out (or was otherwise suppressed) may later
 * send an explicit opt-in / consent message. That inbound evidence NEVER
 * lifts the suppression automatically — it only enters a REVIEW QUEUE that
 * the owner must act on explicitly (append-only policy: the suppression row
 * is never deleted or rewritten, only marked `lifted_at` with a reason, and
 * every decision is recorded in `suppression_reviews` + the audit trail).
 *
 * Security invariants:
 *  - lifting is owner-only (enforced here AND at the route layer);
 *  - a non-empty reason is mandatory for every decision;
 *  - evidence rows are preserved: lifting sets lifted_at/lifted_by/
 *    lifted_reason on the SAME row — nothing is deleted;
 *  - eligibility ignores lifted rows, so a lift immediately (and only)
 *    removes that one suppression from the gate.
 */
import { tx, type DB } from '../../db/index.ts';
import { nowIso } from '../../core/time.ts';
import { AppError } from '../../core/errors.ts';
import { recordAudit } from '../audit/service.ts';
import type { Actor } from '../state/service.ts';

export type ReviewDecision = 'lifted' | 'kept';

export interface LiftCandidate {
  suppressionId: string;
  businessId: string;
  displayName: string;
  scope: string;
  reason: string;
  permanent: boolean;
  evidence: string | null;
  suppressedAt: string;
  /** The inbound evidence that made this suppression a lift candidate. */
  optInInteractionId: string;
  optInSummary: string;
  optInAt: string;
}

interface CandidateRow {
  suppression_id: string;
  business_id: string;
  display_name: string;
  scope: string;
  reason: string;
  permanent: number;
  evidence: string | null;
  suppressed_at: string;
  interaction_id: string;
  interaction_summary: string;
  interaction_at: string;
}

/**
 * Active (not lifted) suppressions whose lead has since sent explicit
 * opt-in evidence: an inbound interaction with outcome `opt_in_received`,
 * or an audited `kind='consent'` interaction. Ordered newest evidence first.
 *
 * This is a REVIEW QUEUE, not an automatic lift — the caller must still run
 * `reviewSuppression` with an owner decision.
 */
export function listLiftCandidates(db: DB): LiftCandidate[] {
  const rows = db
    .prepare(
      `SELECT s.id                AS suppression_id,
              s.business_id       AS business_id,
              b.display_name      AS display_name,
              s.scope             AS scope,
              s.reason            AS reason,
              s.permanent         AS permanent,
              s.evidence          AS evidence,
              s.created_at        AS suppressed_at,
              i.id                AS interaction_id,
              i.summary           AS interaction_summary,
              i.occurred_at       AS interaction_at
         FROM suppression_list s
         JOIN businesses b  ON b.id = s.business_id
         JOIN interactions i
           ON i.business_id = s.business_id
          AND i.direction = 'inbound'
          AND (i.outcome = 'opt_in_received' OR i.kind = 'consent')
        WHERE s.lifted_at IS NULL
          AND b.merged_into_id IS NULL
        ORDER BY i.occurred_at DESC
        LIMIT 200`,
    )
    .all() as unknown as CandidateRow[];

  return rows.map((r) => ({
    suppressionId: r.suppression_id,
    businessId: r.business_id,
    displayName: r.display_name,
    scope: r.scope,
    reason: r.reason,
    permanent: r.permanent === 1,
    evidence: r.evidence,
    suppressedAt: r.suppressed_at,
    optInInteractionId: r.interaction_id,
    optInSummary: r.interaction_summary,
    optInAt: r.interaction_at,
  }));
}

export interface SuppressionReview {
  id: string;
  suppressionId: string;
  businessId: string | null;
  decision: ReviewDecision;
  reason: string;
  reviewedBy: string | null;
  reviewedAt: string;
}

/**
 * Record the owner's review decision for one suppression.
 *
 *  - `lifted`: sets lifted_at/lifted_by/lifted_reason on the suppression row
 *    (append-only — the row and its evidence stay) and eligibility starts
 *    treating it as absent;
 *  - `kept`: the suppression stays active, only the decision is recorded.
 *
 * Owner-only; the reason is mandatory. Audited either way.
 */
export function reviewSuppression(
  db: DB,
  suppressionId: string,
  decision: ReviewDecision,
  reason: string,
  actor: Actor,
): SuppressionReview {
  if (actor.label !== 'owner') {
    throw new AppError('forbidden', 'Only the owner may review suppression lift requests');
  }
  const trimmed = reason.trim();
  if (trimmed.length < 3) {
    throw new AppError('validation_failed', 'A reason of at least 3 characters is required for the review decision');
  }
  if (decision !== 'lifted' && decision !== 'kept') {
    throw new AppError('validation_failed', `Unknown review decision: ${String(decision)}`);
  }

  const row = db
    .prepare('SELECT id, business_id, lifted_at FROM suppression_list WHERE id = ?')
    .get(suppressionId) as { id: string; business_id: string | null; lifted_at: string | null } | undefined;
  if (!row) throw new AppError('not_found', 'Suppression not found');
  if (row.lifted_at) {
    throw new AppError('conflict', 'This suppression has already been reviewed and lifted');
  }

  const at = nowIso();
  const reviewId = `srev_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  tx(db, () => {
    if (decision === 'lifted') {
      db.prepare(
        `UPDATE suppression_list
            SET lifted_at = ?, lifted_by = ?, lifted_reason = ?
          WHERE id = ? AND lifted_at IS NULL`,
      ).run(at, actor.userId, trimmed, suppressionId);
    }
    db.prepare(
      `INSERT INTO suppression_reviews (id, suppression_id, business_id, decision, reason, reviewed_by, reviewed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(reviewId, suppressionId, row.business_id, decision, trimmed, actor.userId, at);
  });

  recordAudit(db, {
    actorUserId: actor.userId,
    actorLabel: actor.label,
    action: decision === 'lifted' ? 'suppression.lifted' : 'suppression.kept',
    entityType: 'suppression_list',
    entityId: suppressionId,
    summary:
      decision === 'lifted'
        ? `Owner lifted suppression ${suppressionId} after opt-in review`
        : `Owner kept suppression ${suppressionId} active after review`,
    details: { decision, reason: trimmed, businessId: row.business_id },
  });

  return {
    id: reviewId,
    suppressionId,
    businessId: row.business_id,
    decision,
    reason: trimmed,
    reviewedBy: actor.userId,
    reviewedAt: at,
  };
}

/** Review history (newest first) for the dashboard / audit views. */
export function listSuppressionReviews(db: DB, limit = 50): SuppressionReview[] {
  const rows = db
    .prepare(
      `SELECT id, suppression_id, business_id, decision, reason, reviewed_by, reviewed_at
         FROM suppression_reviews
        ORDER BY reviewed_at DESC
        LIMIT ?`,
    )
    .all(Math.max(1, Math.min(500, limit))) as unknown as {
    id: string;
    suppression_id: string;
    business_id: string | null;
    decision: ReviewDecision;
    reason: string;
    reviewed_by: string | null;
    reviewed_at: string;
  }[];
  return rows.map((r) => ({
    id: r.id,
    suppressionId: r.suppression_id,
    businessId: r.business_id,
    decision: r.decision,
    reason: r.reason,
    reviewedBy: r.reviewed_by,
    reviewedAt: r.reviewed_at,
  }));
}
