/**
 * Routes: CloudyVoice SIP gateway callbacks.
 *
 * These are the gateway-side counterparts of `webhooks.routes.ts`. The gateway
 * is OUR process (Asterisk/FreeSWITCH + a thin bridge — see `backend/deploy/sip/`), so
 * the contract below is ours too; CloudyVoice itself only ever sees SIP/RTP.
 *
 *   GET  /api/webhooks/telephony/gateway/answer
 *        The gateway fetches this when the callee answers (it carries the
 *        bearer token it was configured with — a WebSocket upgrade cannot carry
 *        a signature header, and the gateway already holds this secret).
 *        Returns JSON instructions: `bridge` (with a signed, expiring media
 *        URL) or `hangup` (fixed approved greeting) — the exact same decision
 *        the Twilio answer URL makes, expressed as JSON instead of TwiML.
 *
 *   POST /api/webhooks/telephony/gateway/events
 *        Signed lifecycle callbacks (answered / completed / duration / cause).
 *        Authenticated by HMAC-SHA256 over the RAW body with
 *        SIP_GATEWAY_EVENT_SECRET, then idempotently ingested under
 *        provider='cloudyvoice' so a gateway retry changes nothing twice.
 *
 * Safety properties carried over from the Twilio routes:
 *  - unauthenticated / unconfigured instances answer 401/404 and touch nothing;
 *  - the answer route NEVER dials, NEVER enables live mode and NEVER records —
 *    it only serves a call that already exists in the ledger;
 *  - a call that cannot be attributed to a lead gets the fixed greeting and
 *    `hangup`, never a stream that could only produce invented speech;
 *  - no secret is ever logged (auth failures log only the client IP hash).
 */
import { Router } from 'express';
import { asyncRoute } from '../types.ts';
import { AppError } from '../../core/errors.ts';
import {
  duplexPorts,
  GREETING_DUPLEX,
  GREETING_HANGUP,
  mintStreamToken,
  resolveCallForAnswer,
  streamWsUrl,
} from '../../domain/media/duplex.ts';
import { ingestProviderEvent } from '../../domain/outreach/providerevents.ts';
import { applyGatewayCallEvent } from '../../domain/outreach/gatewayevents.ts';

/** Provider key used for every gateway-sourced row and event. */
export const GATEWAY_PROVIDER = 'cloudyvoice';

export function gatewayRoutes(): Router {
  const router = Router();

  // ------------------------------------------------------- answer fetch -----
  router.get(
    '/telephony/gateway/answer',
    asyncRoute((req, res) => {
      const { adapters, config, db, logger } = req.ctx.deps;
      if (!adapters?.telephony) throw new AppError('not_found', 'Telephony webhooks are not configured');

      const header = typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null;
      if (!adapters.verifyGatewayControlAuth(header)) {
        // Logs the IP hash only — never the presented token.
        logger.warn('webhook.gateway.bad_auth', { ipHash: req.ctx.ipHash });
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid gateway credentials' } });
        return;
      }

      const query = (name: string): string | null => {
        const value = req.query[name];
        return typeof value === 'string' && value.length > 0 ? value : null;
      };
      const callId = query('callId');
      const duplexReady =
        config.duplex.enabled && duplexPorts(adapters.speech, adapters.ai) && callId !== null;

      if (duplexReady && callId) {
        try {
          const resolved = resolveCallForAnswer(db, {
            callSid: callId,
            from: query('from'),
            to: query('to'),
            provider: GATEWAY_PROVIDER,
          });
          if (resolved) {
            const token = mintStreamToken(config.sessionSecret, callId);
            logger.info('webhook.gateway.answer.bridge', { createdInboundCall: resolved.created });
            res.status(200).json({
              action: 'bridge',
              mediaUrl: streamWsUrl(config.publicBaseUrl, callId, token, '/api/gateway/media'),
              greeting: GREETING_DUPLEX,
              // The ONLY media format this pipeline speaks end to end
              // (G.711 mu-law 8 kHz). The gateway must transcode to it or
              // refuse — it is never silently assumed to be something else.
              mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
            });
            return;
          }
          logger.info('webhook.gateway.answer.unattributed', {});
        } catch (err) {
          logger.error('webhook.gateway.answer.failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.status(200).json({ action: 'hangup', greeting: GREETING_HANGUP });
    }),
  );

  // ---------------------------------------------------- lifecycle events ----
  router.post(
    '/telephony/gateway/events',
    asyncRoute((req, res) => {
      const adapters = req.ctx.deps.adapters;
      if (!adapters?.telephony) throw new AppError('not_found', 'Telephony webhooks are not configured');

      const signature =
        typeof req.headers['x-uws-gateway-signature'] === 'string'
          ? req.headers['x-uws-gateway-signature']
          : null;
      if (!adapters.verifyGatewayEventSignature(req.rawBody, signature)) {
        req.ctx.deps.logger.warn('webhook.gateway.bad_signature', { ipHash: req.ctx.ipHash });
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid gateway signature' } });
        return;
      }

      const body = (req.body ?? {}) as {
        eventId?: unknown;
        callId?: unknown;
        status?: unknown;
      };
      const callId = typeof body.callId === 'string' ? body.callId : null;
      const eventId = typeof body.eventId === 'string' ? body.eventId : null;
      // Without an id there is nothing idempotent to record; a204 keeps the
      // gateway from retrying a payload it can never make useful.
      if (!callId || !eventId) {
        res.status(204).end();
        return;
      }
      const status = typeof body.status === 'string' ? body.status : 'unknown';
      const outcome = ingestProviderEvent(
        req.ctx.deps.db,
        {
          provider: GATEWAY_PROVIDER,
          eventId,
          eventType: 'call.status',
          resourceType: 'call',
          resourceId: callId,
          payload: req.body,
        },
        (payload) => applyGatewayCallEvent(req.ctx.deps.db, payload),
      );
      req.ctx.deps.logger.info('webhook.gateway.status', { callId, status, result: outcome.result });
      res.status(204).end();
    }),
  );

  return router;
}
