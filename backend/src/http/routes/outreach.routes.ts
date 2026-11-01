/**
 * Routes: outreach (Phases 6-7) — calling, conversations/transcripts, and
 * WhatsApp portfolio sharing.
 *
 * Every action here passes the outreach guard, which records a ledger entry
 * whether it allows or blocks. A blocked request is a normal 200 response with
 * `decision: 'blocked'` and the reasons — not an HTTP error, because refusing
 * to contact someone is a successful safety outcome.
 *
 * Simulation is the default; live mode additionally requires configured
 * providers AND the owner to have switched the operating mode. Responses
 * always carry `simulated` so no operator can mistake a rehearsal for real
 * contact — and, in live mode, the adapters come from the registry that was
 * built at bootstrap (tests inject fakes; nothing here constructs one).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf, requireRole } from '../middleware/session.ts';
import { notFound } from '../../core/errors.ts';
import { OUTREACH_PURPOSES, listAttempts } from '../../domain/outreach/guard.ts';
import {
  placeCall,
  sharePortfolio,
  listLeadCalls,
  listLeadMessages,
  type OutreachAdapters,
} from '../../domain/outreach/service.ts';
import { listConversations, getConversation } from '../../domain/outreach/conversations.ts';
import {
  listPortfolio,
  createPortfolioItem,
  verifyPortfolioItem,
  approvePortfolioItem,
  isShareable,
  getPortfolioItem,
} from '../../domain/outreach/portfolio.ts';
import { recordAudit } from '../../domain/audit/service.ts';

const idParam = z.string().min(1);

const callSchema = z.object({
  /** Default 'callback': owner-initiated, so the calling window is recorded but not enforced. */
  purpose: z.enum(OUTREACH_PURPOSES).optional(),
  taskId: z.string().max(60).nullish(),
  idempotencyKey: z.string().min(8).max(120).nullish(),
});

const shareSchema = z.object({
  itemIds: z.array(z.string().min(1).max(60)).max(10).nullish(),
  idempotencyKey: z.string().min(8).max(120).nullish(),
});

const createItemSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(4000).nullish(),
  serviceKey: z.string().max(60).nullish(),
  url: z.string().max(500).nullish(),
  imageUrl: z.string().max(500).nullish(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
});

const verifySchema = z.object({
  verified: z.boolean(),
  note: z.string().max(1000).nullish(),
});

const approveSchema = z.object({ approved: z.boolean() });

/**
 * Lead-scoped outreach routes, mounted at /api/leads (same convention as the
 * pipeline router so requireAuth covers only lead endpoints).
 */
/**
 * Pull the live provider ports out of the app's registry. Simulation mode
 * never touches these; live mode refuses (blocked/503) when they are absent.
 */
function adaptersFromDeps(deps: AppDeps): OutreachAdapters {
  const reg = deps.adapters;
  return {
    telephony: reg?.telephony ?? null,
    whatsapp: reg?.whatsapp ?? null,
    portfolioTemplate: reg?.portfolioTemplate ?? null,
    voiceAnswerUrl: reg?.voiceAnswerUrl ?? null,
  };
}

export function outreachRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  // ------------------------------------------------------------ calls ----
  // Request an outbound call. Guard + ledger + simulation happen in the
  // domain layer; the response is 201 when a (simulated) call ran, 200 with
  // decision 'blocked' when a safeguard refused it.
  router.post(
    '/:id/call',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const id = idParam.parse(req.params.id);
      const body = callSchema.parse(req.body ?? {});
      const result = await placeCall(req.ctx.deps.db, req.ctx.deps.config, {
        businessId: id,
        purpose: body.purpose,
        taskId: body.taskId ?? null,
        idempotencyKey: body.idempotencyKey ?? null,
        actor: { userId: req.ctx.user!.id, label: req.ctx.user!.role },
        adapters: adaptersFromDeps(req.ctx.deps),
      });

      if (result.decision === 'allowed') {
        recordAudit(req.ctx.deps.db, {
          actorUserId: req.ctx.user!.id,
          actorLabel: req.ctx.user!.role,
          action: result.attempt.mode === 'simulation' ? 'outreach.call_simulated' : 'outreach.call_placed',
          entityType: 'business',
          entityId: id,
          summary:
            result.attempt.mode === 'simulation'
              ? `Simulated call (${result.call.scenario}) — no real contact`
              : `Call placed via ${result.call.provider}`,
          details: {
            attemptId: result.attempt.id,
            callId: result.call.callId,
            outcome: result.call.outcome,
            conversationId: result.call.conversationId,
            humanRequested: result.call.humanRequested,
          },
        });
        res.status(201).json(result);
        return;
      }
      res.json(result);
    }),
  );

  // --------------------------------------------------- portfolio share ----
  router.post(
    '/:id/portfolio/share',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute(async (req, res) => {
      const id = idParam.parse(req.params.id);
      const body = shareSchema.parse(req.body ?? {});
      const result = await sharePortfolio(req.ctx.deps.db, req.ctx.deps.config, {
        businessId: id,
        itemIds: body.itemIds ?? null,
        idempotencyKey: body.idempotencyKey ?? null,
        actor: { userId: req.ctx.user!.id, label: req.ctx.user!.role },
        adapters: adaptersFromDeps(req.ctx.deps),
      });

      if (result.decision === 'allowed') {
        recordAudit(req.ctx.deps.db, {
          actorUserId: req.ctx.user!.id,
          actorLabel: req.ctx.user!.role,
          action: result.simulated ? 'outreach.portfolio_rehearsed' : 'outreach.portfolio_shared',
          entityType: 'business',
          entityId: id,
          summary: result.simulated
            ? `Portfolio share rehearsed (${result.items.length} item(s)) — no real message sent`
            : `Portfolio template sent via ${result.provider} (${result.items.length} item(s))`,
          details: {
            attemptId: result.attempt.id,
            messageId: result.messageId,
            itemIds: result.items.map((i) => i.id),
            numberUsed: result.numberUsed,
            simulated: result.simulated,
          },
        });
        res.status(201).json(result);
        return;
      }
      res.json(result);
    }),
  );

  // ----------------------------------------------------------- ledger ----
  router.get(
    '/:id/outreach',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const decision = req.query.decision === 'allowed' || req.query.decision === 'blocked' ? req.query.decision : undefined;
      res.json({
        attempts: listAttempts(req.ctx.deps.db, { businessId: id, decision }),
        calls: listLeadCalls(req.ctx.deps.db, id),
        messages: listLeadMessages(req.ctx.deps.db, id),
      });
    }),
  );

  // ----------------------------------------------------- conversations ----
  router.get(
    '/:id/conversations',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      res.json({ items: listConversations(req.ctx.deps.db, id) });
    }),
  );

  router.get(
    '/:id/conversations/:conversationId',
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const conversation = getConversation(req.ctx.deps.db, idParam.parse(req.params.conversationId));
      if (!conversation || conversation.businessId !== id) throw notFound('Conversation');
      res.json(conversation);
    }),
  );

  return router;
}

/**
 * Portfolio management, mounted at /api/portfolio. Creating an item is
 * bookkeeping (owner/staff); the trust keys — verify and approve — are
 * owner-only, because the two-key rule is what keeps fabricated case studies
 * out of prospect-facing messages.
 */
export function portfolioRoutes(): Router {
  const router = Router();
  router.use(requireAuth);

  router.get(
    '/',
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const shareableOnly = req.query.shareable === 'true';
      res.json({ items: listPortfolio(req.ctx.deps.db, { shareableOnly }) });
    }),
  );

  router.post(
    '/',
    requireCsrf,
    requireRole('owner', 'staff'),
    asyncRoute((req, res) => {
      const body = createItemSchema.parse(req.body);
      const item = createPortfolioItem(req.ctx.deps.db, {
        title: body.title,
        description: body.description ?? null,
        serviceKey: body.serviceKey ?? null,
        url: body.url ?? null,
        imageUrl: body.imageUrl ?? null,
        sortOrder: body.sortOrder,
        createdBy: req.ctx.user!.id,
      });
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: 'portfolio.create',
        entityType: 'portfolio_item',
        entityId: item.id,
        summary: `Created portfolio item "${item.title}" (unverified, unapproved)`,
        details: { title: item.title, url: item.url },
      });
      res.status(201).json(item);
    }),
  );

  router.get(
    '/:id',
    asyncRoute((req, res) => {
      const item = getPortfolioItem(req.ctx.deps.db, idParam.parse(req.params.id));
      if (!item) throw notFound('Portfolio item');
      res.json({ ...item, shareable: isShareable(item) });
    }),
  );

  router.post(
    '/:id/verify',
    requireCsrf,
    requireRole('owner'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = verifySchema.parse(req.body);
      const item = verifyPortfolioItem(req.ctx.deps.db, id, body.verified, body.note ?? null);
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: body.verified ? 'portfolio.verify' : 'portfolio.unverify',
        entityType: 'portfolio_item',
        entityId: item.id,
        summary: body.verified
          ? `Verified portfolio item "${item.title}": ${body.note}`
          : `Removed verification from "${item.title}" (approval also revoked)`,
        details: { verified: item.verified, isApproved: item.isApproved, note: body.note ?? null },
      });
      res.json(item);
    }),
  );

  router.post(
    '/:id/approve',
    requireCsrf,
    requireRole('owner'),
    asyncRoute((req, res) => {
      const id = idParam.parse(req.params.id);
      const body = approveSchema.parse(req.body);
      const item = approvePortfolioItem(req.ctx.deps.db, id, body.approved);
      recordAudit(req.ctx.deps.db, {
        actorUserId: req.ctx.user!.id,
        actorLabel: req.ctx.user!.role,
        action: body.approved ? 'portfolio.approve' : 'portfolio.unapprove',
        entityType: 'portfolio_item',
        entityId: item.id,
        summary: body.approved
          ? `Approved portfolio item "${item.title}" for outreach`
          : `Withdrew approval for "${item.title}"`,
        details: { verified: item.verified, isApproved: item.isApproved },
      });
      res.json(item);
    }),
  );

  return router;
}
