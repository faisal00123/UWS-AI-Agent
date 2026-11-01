/**
 * Routes: pipeline (Phase 5) — interaction timeline, evidence-backed stage
 * advancement, and follow-up task scheduling/execution.
 *
 * These are the CRM surfaces behind the lead timeline and the follow-up board.
 * The integrity rules live in the domain layer and are surfaced here as 4xx:
 *   - a customer-facing stage change must cite a real contact interaction
 *   - only the owner may confirm a conversion (won)
 *   - completing a follow-up requires a customer-contact interaction
 *   - scheduling respects the owner's calling window
 *
 * State-changing routes are CSRF-protected and role-gated; every meaningful
 * transition writes an audit event.
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { AppError, notFound } from '../../core/errors.ts';
import { LEAD_STAGES } from '../../domain/leads/repository.ts';
import {
  INTERACTION_KINDS,
  INTERACTION_DIRECTIONS,
  recordInteraction,
  listInteractions,
} from '../../domain/pipeline/interactions.ts';
import {
  FOLLOWUP_TYPES,
  FOLLOWUP_STATUSES,
  scheduleFollowup,
  scheduleSequence,
  listTasks,
  getTask,
  completeTask,
  cancelTask,
  evaluateDueTasks,
} from '../../domain/pipeline/followups.ts';
import { advanceStage, timeline, interactionCounts } from '../../domain/pipeline/service.ts';
import { recordAudit } from '../../domain/audit/service.ts';

const idParam = z.string().min(1);

const interactionSchema = z.object({
  kind: z.enum(INTERACTION_KINDS),
  direction: z.enum(INTERACTION_DIRECTIONS).nullish(),
  summary: z
    .string()
    .max(2000)
    // Whitespace-only summaries are empty; catch them here so this is a 400
    // rather than a 500 from the domain layer.
    .refine((s) => s.trim().length > 0, { message: 'summary must not be empty' }),
  outcome: z.string().max(200).nullish(),
  evidence: z.record(z.string(), z.unknown()).nullish(),
});

const advanceSchema = z
  .object({
    toStage: z.enum(LEAD_STAGES),
    reason: z.string().min(3).max(500),
    interaction: interactionSchema.nullish(),
    evidenceInteractionId: z.string().max(60).nullish(),
    autoSchedule: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.interaction ?? v.evidenceInteractionId), {
    message: 'either interaction or evidenceInteractionId is required',
    path: ['interaction'],
  });

const scheduleSchema = z.object({
  type: z.enum(FOLLOWUP_TYPES),
  title: z.string().min(1).max(200),
  notes: z.string().max(2000).nullish(),
  scheduledFor: z.string().min(4).max(40),
  channel: z.enum(['call', 'whatsapp_message', 'whatsapp_call', 'email', 'manual']).nullish(),
  requestedByCustomer: z.boolean().optional(),
  /** Skip calling-window adjustment (customer-requested times, meetings). */
  respectWindow: z.boolean().optional(),
});

const sequenceSchema = z.object({
  title: z.string().min(1).max(200),
  offsetsDays: z.array(z.number().int().min(0).max(365)).min(1).max(10),
  channel: z.enum(['call', 'whatsapp_message', 'whatsapp_call', 'email']).nullish(),
  type: z.enum(FOLLOWUP_TYPES).optional(),
  startFrom: z.string().min(4).max(40).optional(),
});

const completeSchema = z.object({ interactionId: z.string().min(1) });
const cancelSchema = z.object({ reason: z.string().min(3).max(500) });

export function pipelineRoutes(): Router {
  // Lead-scoped pipeline routes. Mounted at /api/leads so requireAuth applies
  // only to lead endpoints — mounting this at /api would also swallow
  // /api/health (public) and unknown routes (JSON 404).
  const router = Router();
  router.use(requireAuth);

  // ----------------------------------------------------------- timeline --
  router.get(
    '/:id/timeline',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      res.json({
        interactions: timeline(req.ctx.deps.db, id),
        counts: interactionCounts(req.ctx.deps.db, id),
      });
    }),
  );

  router.get(
    '/:id/interactions',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const kind = req.query.kind ? z.enum(INTERACTION_KINDS).parse(req.query.kind) : undefined;
      const order = req.query.order === 'asc' ? 'asc' : 'desc';
      res.json({ items: listInteractions(req.ctx.deps.db, { businessId: id, kind, order }) });
    }),
  );

  // Any recorded interaction is timeline bookkeeping; staff may log a note or a
  // call that happened off-platform.
  router.post(
    '/:id/interactions',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = interactionSchema.parse(req.body);
      const exists = req.ctx.deps.db.prepare('SELECT id FROM businesses WHERE id = ?').get(id);
      if (!exists) throw notFound('Lead');

      const inter = recordInteraction(req.ctx.deps.db, {
        businessId: id,
        kind: body.kind,
        direction: body.direction ?? null,
        summary: body.summary,
        outcome: body.outcome ?? null,
        evidence: body.evidence ?? null,
        createdBy: req.ctx.user!.id,
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'interaction.record',
        entityType: 'business',
        entityId: id,
        summary: `Recorded ${body.kind} interaction`,
        details: { interactionId: inter.id, kind: body.kind },
      });
      res.status(201).json(inter);
    }),
  );

  // ------------------------------------------------- stage advancement --
  // Evidence rules (contact-gated stages, owner-only won) are enforced in
  // advanceStage; failures surface as 400/403 with the reason.
  router.post(
    '/:id/advance',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = advanceSchema.parse(req.body);
      const result = advanceStage(req.ctx.deps.db, req.ctx.deps.config, {
        businessId: id,
        toStage: body.toStage,
        reason: body.reason,
        interaction: body.interaction
          ? { ...body.interaction, businessId: id, createdBy: req.ctx.user!.id }
          : null,
        evidenceInteractionId: body.evidenceInteractionId ?? null,
        autoSchedule: body.autoSchedule,
        actor: { userId: req.ctx.user!.id, label: req.ctx.user!.role },
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'lead.stage_advanced',
        entityType: 'business',
        entityId: id,
        summary: `Stage ${result.from} -> ${result.to}`,
        details: {
          from: result.from,
          to: result.to,
          interactionId: result.interactionId,
          scheduled: result.scheduled.length,
          reason: body.reason,
        },
      });
      res.json(result);
    }),
  );

  // ---------------------------------------------------------- follow-ups --
  router.get(
    '/:id/followups',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const status = req.query.status
        ? z
            .enum(['scheduled', 'due', 'running', 'completed', 'cancelled', 'blocked', 'failed', 'missed'])
            .parse(req.query.status)
        : undefined;
      res.json({ items: listTasks(req.ctx.deps.db, { businessId: id, status }) });
    }),
  );

  router.post(
    '/:id/followups',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = scheduleSchema.parse(req.body);
      const task = scheduleFollowup(req.ctx.deps.db, req.ctx.deps.config, {
        businessId: id,
        type: body.type,
        title: body.title,
        notes: body.notes ?? null,
        scheduledFor: body.scheduledFor,
        channel: body.channel ?? null,
        requestedByCustomer: body.requestedByCustomer ?? false,
        respectWindow: body.respectWindow,
        createdBy: req.ctx.user!.id,
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'followup.schedule',
        entityType: 'followup_task',
        entityId: task.id,
        summary: `Scheduled ${task.type} for ${task.scheduledFor}`,
        details: { businessId: id, type: task.type, scheduledFor: task.scheduledFor },
      });
      res.status(201).json(task);
    }),
  );

  router.post(
    '/:id/followups/sequence',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = sequenceSchema.parse(req.body);
      const tasks = scheduleSequence(req.ctx.deps.db, req.ctx.deps.config, {
        businessId: id,
        title: body.title,
        offsetsDays: body.offsetsDays,
        channel: body.channel ?? null,
        type: body.type,
        startFrom: body.startFrom,
        createdBy: req.ctx.user!.id,
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'followup.sequence',
        entityType: 'business',
        entityId: id,
        summary: `Scheduled a ${tasks.length}-step follow-up sequence`,
        details: { offsetsDays: body.offsetsDays, taskIds: tasks.map((t) => t.id) },
      });
      res.status(201).json({ items: tasks });
    }),
  );

  return router;
}

/**
 * Task-scoped follow-up routes (fetch, complete, cancel, evaluate-due).
 * Separate router mounted at /api/followups so the lead router's prefix does
 * not apply, and so requireAuth here cannot intercept unrelated /api paths.
 */
export function followupRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  // Global follow-up board across all leads (the dashboard's pipeline view).
  // Read-only; per-lead scheduling/execution stays under /api/leads/:id.
  router.get(
    '/',
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const q = z
        .object({
          status: z.enum(FOLLOWUP_STATUSES).optional(),
          dueBefore: z.string().min(4).max(40).optional(),
          limit: z.coerce.number().int().min(1).max(500).optional(),
        })
        .parse(req.query ?? {});
      res.json({ items: listTasks(req.ctx.deps.db, q) });
    }),
  );

  // Re-check every due task: blocked ones record why, reviewable ones stay
  // pending. Returns the decisions without performing any outreach.
  router.post(
    '/evaluate-due',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const body = z
        .object({ dueBefore: z.string().min(4).max(40).optional() })
        .parse(req.body ?? {});
      const dueBefore = body.dueBefore ?? new Date(Date.now() + 86_400_000).toISOString();
      const evaluations = evaluateDueTasks(req.ctx.deps.db, req.ctx.deps.config, dueBefore);
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'followup.evaluate_due',
        entityType: 'followup_task',
        entityId: 'batch',
        summary: `Evaluated ${evaluations.length} due task(s)`,
        details: {
          eligible: evaluations.filter((e) => e.decision === 'eligible').length,
          needsReview: evaluations.filter((e) => e.decision === 'needs_review').length,
          ineligible: evaluations.filter((e) => e.decision === 'ineligible').length,
        },
      });
      res.json({ items: evaluations });
    }),
  );

  router.get(
    '/:id',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const task = getTask(req.ctx.deps.db, id);
      if (!task) throw notFound('Follow-up task');
      res.json(task);
    }),
  );

  router.post(
    '/:id/complete',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = completeSchema.parse(req.body);
      const task = completeTask(req.ctx.deps.db, {
        taskId: id,
        interactionId: body.interactionId,
        actor: { userId: req.ctx.user!.id, label: req.ctx.user!.role },
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'followup.complete',
        entityType: 'followup_task',
        entityId: id,
        summary: `Follow-up completed with interaction ${body.interactionId}`,
        details: { businessId: task.businessId, interactionId: body.interactionId },
      });
      res.json(task);
    }),
  );

  router.post(
    '/:id/cancel',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = cancelSchema.parse(req.body);
      const task = cancelTask(req.ctx.deps.db, id, body.reason);
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'followup.cancel',
        entityType: 'followup_task',
        entityId: id,
        summary: `Follow-up cancelled: ${body.reason}`,
        details: { reason: body.reason, status: task.status },
      });
      res.json(task);
    }),
  );

  // Guard: reject unknown follow-up actions with a clear message rather than
  // falling through to the SPA/404 handler.
  router.use((_req, _res, next) => {
    next(new AppError('not_found', 'No route for this follow-up action'));
  });

  return router;
}
