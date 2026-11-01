/**
 * Routes: live media pipeline (Phase 11B).
 *
 * Write-side seam for a call's conversation lifecycle. These endpoints NEVER
 * dial, never enable live mode and never send anything — they only process
 * media/text for a conversation that already exists (the telephony layer
 * creates the call; this layer runs STT -> engine -> TTS -> qualification).
 *
 *   POST /api/conversations                  — open a conversation for a call
 *   POST /api/conversations/:id/prospect     — ingest prospect text (typed)
 *                                              or audio (base64, STT)
 *   POST /api/conversations/:id/agent-reply  — engine turn + TTS synthesis
 *   POST /api/conversations/:id/finish       — extract qualification, update
 *                                              the lead, honour opt-outs
 *
 * Safety properties:
 *  - no fabrication: a missing speech/AI provider returns 503 with an honest
 *    message instead of invented text;
 *  - no recording: nothing here requests or stores call audio beyond the
 *    chunk being transcribed (recording stays consent-gated at the calls row);
 *  - auth + CSRF on every mutation (staff may operate; media is not an
 *    owner-only concern, but cross-site requests cannot drive it).
 */
import { Router } from 'express';
import { z } from 'zod';
import { asyncRoute, type AppDeps } from '../types.ts';
import { requireAuth, requireCsrf } from '../middleware/session.ts';
import type { ConversationPort, SpeechPort } from '../../adapters/types.ts';
import {
  finishConversation,
  generateAgentReply,
  ingestProspectAudio,
  ingestProspectText,
  startConversation,
} from '../../domain/media/pipeline.ts';

const idParam = z.string().min(1).max(60);

const startBody = z.object({
  businessId: z.string().min(1).max(60),
  callId: z.string().min(1).max(60).nullish(),
  language: z.enum(['ur', 'roman_ur', 'en', 'mixed', 'unknown']).optional(),
});

const prospectTextBody = z.object({ text: z.string().min(1).max(4000) });

// ~190KB of binary fits the 256kb JSON body limit once base64-encoded (+33%).
const MAX_AUDIO_B64 = 200_000;
const prospectAudioBody = z.object({
  audioBase64: z.string().min(1).max(MAX_AUDIO_B64),
  mimeType: z.string().max(80).optional(),
  filename: z.string().max(120).optional(),
});

function mediaDeps(ctx: { deps: AppDeps }): { speech: SpeechPort | null; ai: ConversationPort | null } {
  const registry = ctx.deps.adapters;
  return { speech: registry?.speech ?? null, ai: registry?.ai ?? null };
}

export function mediaRoutes(_deps: AppDeps): Router {
  const router = Router();

  // Open a conversation (language defaults from the conversation policy).
  router.post(
    '/',
    requireAuth,
    requireCsrf,
    asyncRoute((req, res) => {
      const body = startBody.parse(req.body);
      const conversationId = startConversation(req.ctx.deps.db, req.ctx.deps.config, {
        businessId: body.businessId,
        callId: body.callId ?? null,
        ...(body.language !== undefined ? { language: body.language } : {}),
      });
      res.status(201).json({ conversationId });
    }),
  );

  // Ingest one prospect turn: typed text, or audio transcribed via STT.
  router.post(
    '/:id/prospect',
    requireAuth,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const id = idParam.parse(req.params['id']);
      const raw = req.body as Record<string, unknown> | undefined;

      if (raw && typeof raw['audioBase64'] === 'string') {
        const parsed = prospectAudioBody.safeParse(raw);
        if (!parsed.success) {
          res.status(400).json({
            error: { code: 'validation_failed', message: 'audioBase64 (<=200KB) is required' },
          });
          return;
        }
        const audio = new Uint8Array(Buffer.from(parsed.data.audioBase64, 'base64'));
        const turn = await ingestProspectAudio(req.ctx.deps.db, mediaDeps(req.ctx), id, {
          audio,
          ...(parsed.data.mimeType !== undefined ? { mimeType: parsed.data.mimeType } : {}),
          ...(parsed.data.filename !== undefined ? { filename: parsed.data.filename } : {}),
        });
        res.json({ turn });
        return;
      }

      const parsedText = prospectTextBody.safeParse(raw);
      if (!parsedText.success) {
        res.status(400).json({
          error: { code: 'validation_failed', message: 'Provide text (1-4000 chars) or audioBase64' },
        });
        return;
      }
      const turn = ingestProspectText(req.ctx.deps.db, id, parsedText.data.text);
      res.json({ turn });
    }),
  );

  // Engine reply + optional TTS audio for playback.
  router.post(
    '/:id/agent-reply',
    requireAuth,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const id = idParam.parse(req.params['id']);
      const turn = await generateAgentReply(
        req.ctx.deps.db,
        req.ctx.deps.config,
        mediaDeps(req.ctx),
        id,
      );
      res.json({
        turn: {
          segmentSeq: turn.segmentSeq,
          text: turn.text,
          model: turn.model,
          // Audio is handed back as base64 only when TTS ran; null means no
          // speech provider was available (the caller falls back to text).
          audioBase64: turn.audio ? Buffer.from(turn.audio).toString('base64') : null,
          contentType: turn.contentType,
        },
      });
    }),
  );

  // Close the conversation: qualification extraction + lead update.
  router.post(
    '/:id/finish',
    requireAuth,
    requireCsrf,
    asyncRoute(async (req, res) => {
      const id = idParam.parse(req.params['id']);
      const result = await finishConversation(req.ctx.deps.db, id);
      res.json({ result });
    }),
  );

  return router;
}
