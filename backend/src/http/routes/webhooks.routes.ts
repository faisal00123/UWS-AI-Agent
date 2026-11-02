/**
 * Routes: provider webhooks (Phase 7).
 *
 * These are the ONLY unauthenticated POST endpoints in the application, and
 * they are authenticated by SIGNATURE instead of session:
 *
 *   - Meta (WhatsApp): X-Hub-Signature-256 = HMAC-SHA256(app secret, RAW body)
 *     verified against `req.rawBody` — never against re-serialized JSON, which
 *     would let a re-encoded body pass.
 *   - Twilio: X-Twilio-Signature = HMAC-SHA1(token, absolute URL + sorted
 *     params), verified over the parsed form params.
 *
 * Both paths are IDEMPOTENT: events land in `provider_events` under a unique
 * (provider, event_id) key, so a provider's retries update nothing twice.
 * A bad signature is 401 and the payload is never touched.
 *
 * The GET routes are the Meta subscription challenge and Twilio's TwiML
 * answer URL; both are signature/token gated and 404 when the corresponding
 * integration is not configured, so an unconfigured instance advertises
 * nothing.
 *
 * The answer URL serves the duplex variant (AI disclosure greeting, then
 * <Connect><Stream> into /api/media) whenever the bridge is enabled, both
 * speech and AI ports exist, and the call can be attributed to a lead.
 * Otherwise it serves the fixed greeting + hangup — a call is never opened
 * into a stream that could only produce silence or invented speech.
 */
import { Router } from 'express';
import { asyncRoute } from '../types.ts';
import { AppError } from '../../core/errors.ts';
import {
  duplexAnswerTwiml,
  duplexPorts,
  GREETING_HANGUP,
  mintStreamToken,
  resolveCallForAnswer,
  streamWsUrl,
} from '../../domain/media/duplex.ts';
import {
  ingestProviderEvent,
  applyCallStatusEvent,
  applyMessageStatusEvent,
  applyInboundMessageEvent,
} from '../../domain/outreach/providerevents.ts';

function absoluteUrl(req: { protocol: string; get(name: string): string | undefined; originalUrl: string }): string {
  const host = req.get('host') ?? '';
  return `${req.protocol}://${host}${req.originalUrl}`;
}

function strParams(body: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (body && typeof body === 'object') {
    for (const [k, v] of Object.entries(body as Record<string, unknown>)) {
      if (typeof v === 'string') out[k] = v;
    }
  }
  return out;
}

/** Twilio's status payload IS the params map (form-encoded). */
function callBackPayload(params: Record<string, string>): Record<string, string> {
  return params;
}

/** Greeting served when a live call connects but no duplex stream applies.
 *  Fixed approved wording (disclosure + hangup). */
const ANSWER_TWIML = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">${GREETING_HANGUP}</Say>
  <Hangup/>
</Response>`;

export function webhookRoutes(): Router {
  const router = Router();

  // ------------------------------------------------- Meta (WhatsApp) -------

  // Subscription challenge (Meta GET). Refused outright when no verify token
  // is configured — an unconfigured instance must not advertise the endpoint.
  router.get(
    '/whatsapp',
    asyncRoute((req, res) => {
      const adapters = req.ctx.deps.adapters;
      const token = adapters?.whatsappVerifyToken ?? null;
      if (!token) throw new AppError('not_found', 'WhatsApp webhooks are not configured');
      const mode = typeof req.query['hub.mode'] === 'string' ? req.query['hub.mode'] : '';
      const challenge = typeof req.query['hub.challenge'] === 'string' ? req.query['hub.challenge'] : '';
      const provided = typeof req.query['hub.verify_token'] === 'string' ? req.query['hub.verify_token'] : '';
      if (mode !== 'subscribe' || !timingSafeStringEqual(provided, token)) {
        res.status(403).type('text/plain').send('Verification failed');
        return;
      }
      res.status(200).type('text/plain').send(challenge);
    }),
  );

  router.post(
    '/whatsapp',
    asyncRoute((req, res) => {
      const adapters = req.ctx.deps.adapters;
      if (!adapters?.whatsapp) {
        throw new AppError('not_found', 'WhatsApp webhooks are not configured');
      }
      const signature = typeof req.headers['x-hub-signature-256'] === 'string' ? req.headers['x-hub-signature-256'] : null;
      const raw = req.rawBody;
      if (!raw || !adapters.verifyWhatsAppSignature(raw, signature)) {
        req.ctx.deps.logger.warn('webhook.whatsapp.bad_signature', {
          hasSignature: Boolean(signature),
          ipHash: req.ctx.ipHash,
        });
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid webhook signature' } });
        return;
      }

      const counts = { applied: 0, ignored: 0, duplicate: 0 };
      const body = (req.body ?? {}) as {
        entry?: { changes?: { value?: Record<string, unknown> }[] }[];
      };
      for (const entry of body.entry ?? []) {
        for (const change of entry.changes ?? []) {
          const value = change.value ?? {};
          const statuses = (value['statuses'] ?? []) as Record<string, unknown>[];
          for (const status of statuses) {
            const id = typeof status['id'] === 'string' ? status['id'] : 'unknown';
            const st = typeof status['status'] === 'string' ? status['status'] : 'unknown';
            const ts = typeof status['timestamp'] === 'string' ? status['timestamp'] : hourBucket();
            const outcome = ingestProviderEvent(
              req.ctx.deps.db,
              {
                provider: 'whatsapp_cloud',
                eventId: `${id}:${st}:${ts}`,
                eventType: 'message.status',
                resourceType: 'message',
                resourceId: id,
                payload: status,
              },
              (payload) => applyMessageStatusEvent(req.ctx.deps.db, payload),
            );
            counts[outcome.result] += 1;
          }
          const messages = (value['messages'] ?? []) as Record<string, unknown>[];
          for (const m of messages) {
            const id = typeof m['id'] === 'string' ? m['id'] : 'unknown';
            const outcome = ingestProviderEvent(
              req.ctx.deps.db,
              {
                provider: 'whatsapp_cloud',
                eventId: `inbound:${id}`,
                eventType: 'message.inbound',
                resourceType: 'message',
                resourceId: id,
                payload: { value: { messages: [m] } },
              },
              (payload) => applyInboundMessageEvent(req.ctx.deps.db, payload, req.ctx.deps.config),
            );
            counts[outcome.result] += 1;
          }
        }
      }
      // Always 2xx: an unmatchable-but-authentic event must not trigger retries.
      res.status(200).json({ received: true, ...counts });
    }),
  );

  // --------------------------------------------------- Twilio (voice) ------

  // Status callbacks (Twilio POST, form-encoded, signed).
  router.post(
    '/telephony/twilio',
    asyncRoute((req, res) => {
      const adapters = req.ctx.deps.adapters;
      if (!adapters?.telephony) throw new AppError('not_found', 'Telephony webhooks are not configured');
      const params = strParams(req.body);
      const signature = typeof req.headers['x-twilio-signature'] === 'string' ? req.headers['x-twilio-signature'] : null;
      if (!adapters.verifyTwilioSignature(absoluteUrl(req), params, signature)) {
        req.ctx.deps.logger.warn('webhook.twilio.bad_signature', { ipHash: req.ctx.ipHash });
        res.status(401).json({ error: { code: 'unauthenticated', message: 'Invalid webhook signature' } });
        return;
      }

      const sid = params['CallSid'];
      const status = params['CallStatus'] ?? 'unknown';
      if (!sid) {
        res.status(204).end();
        return;
      }
      // Timestamp is provider-supplied; without it an hour bucket keeps
      // repeats of the same status idempotent without inventing precision.
      const ts = params['Timestamp'] ?? hourBucket();
      const outcome = ingestProviderEvent(
        req.ctx.deps.db,
        {
          provider: 'twilio',
          eventId: `${sid}:${status}:${ts}`,
          eventType: 'call.status',
          resourceType: 'call',
          resourceId: sid,
          payload: callBackPayload(params),
        },
        (payload) => applyCallStatusEvent(req.ctx.deps.db, payload),
      );
      req.ctx.deps.logger.info('webhook.twilio.status', { sid, status, result: outcome.result });
      res.status(204).end();
    }),
  );

  // Answer URL: Twilio fetches this (GET) when the callee picks up. Returns
  // TwiML with the mandated AI disclosure. Signature-checked; 404 when the
  // integration is absent.
  //
  // Duplex variant: when the bridge is enabled with STT+AI present and the
  // call belongs to a lead, the greeting is followed by <Connect><Stream> so
  // the conversation lifecycle runs over live audio. The stream URL carries a
  // signed, expiring token bound to this CallSid (the WebSocket upgrade cannot
  // carry a Twilio signature header). Anything else gets the fixed greeting.
  router.get(
    '/telephony/twilio/voice',
    asyncRoute((req, res) => {
      const { adapters, config, db, logger } = req.ctx.deps;
      if (!adapters?.telephony || !adapters.voiceAnswerUrl) {
        throw new AppError('not_found', 'Telephony voice endpoint is not configured');
      }
      const signature = typeof req.headers['x-twilio-signature'] === 'string' ? req.headers['x-twilio-signature'] : null;
      if (!adapters.verifyTwilioSignature(absoluteUrl(req), {}, signature)) {
        res.status(401).type('text/plain').send('Invalid signature');
        return;
      }

      const query = (name: string): string | null => {
        const value = req.query[name];
        return typeof value === 'string' && value.length > 0 ? value : null;
      };
      const callSid = query('CallSid');
      const duplexReady =
        config.duplex.enabled && duplexPorts(adapters.speech, adapters.ai) && callSid !== null;

      if (duplexReady && callSid) {
        try {
          const resolved = resolveCallForAnswer(db, {
            callSid,
            from: query('From'),
            to: query('To'),
          });
          if (resolved) {
            const token = mintStreamToken(config.sessionSecret, callSid);
            logger.info('webhook.twilio.answer.duplex', { createdInboundCall: resolved.created });
            res
              .status(200)
              .type('application/xml')
              .send(duplexAnswerTwiml(streamWsUrl(config.publicBaseUrl, callSid, token)));
            return;
          }
          logger.info('webhook.twilio.answer.unattributed', {});
        } catch (err) {
          logger.error('webhook.twilio.answer.failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      res.status(200).type('application/xml').send(ANSWER_TWIML);
    }),
  );

  return router;
}

function hourBucket(): string {
  return new Date().toISOString().slice(0, 13); // YYYY-MM-DDTHH
}

/** Constant-time compare for the owner-configured webhook verify token. */
function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
