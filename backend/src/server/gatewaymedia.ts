/**
 * Gateway media bridge — WebSocket transport for SIP-delivered calls.
 *
 * The sibling of `server/duplex.ts`: that file speaks Twilio's Media Streams
 * wire format, this one speaks OUR gateway dialect and translates it into the
 * exact event shape `createDuplexSession` already consumes
 * (`start` / `media` / `dtmf` / `clear` / `stop`). The session core, VAD,
 * OpenAI STT/TTS, transcript, qualification and opt-out suppression therefore
 * run UNCHANGED for SIP calls — no second conversation pipeline exists.
 *
 *   GET wss://<public>/api/gateway/media?callSid=..&token=..   (upgrade)
 *
 * The upgrade is rejected with a real HTTP status unless ALL of these hold,
 * so an unconfigured instance exposes nothing:
 *
 *   1. the duplex bridge is enabled;
 *   2. both an STT/TTS port and a conversation port exist;
 *   3. the signed, expiring token matches this call id (minted by the gateway
 *      answer URL — the gateway cannot attach headers to an upgrade);
 *   4. that call id belongs to a call in the ledger;
 *   5. no other connection is already serving the same call.
 *
 * Outbound frames keep Twilio's media shape (`{event:'media', media:{payload}}`)
 * on purpose: a gateway can then be built by adapting a Twilio Media Streams
 * client instead of inventing a second dialect (see deploy/sip/contract.md).
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppDeps } from '../http/types.ts';
import { createDuplexSession, duplexPorts, verifyStreamToken, type DuplexSession } from '../domain/media/duplex.ts';
import { rejectUpgrade, markUpgradeClaimed } from './upgrade.ts';

export const GATEWAY_MEDIA_PATH = '/api/gateway/media';

/** Media format this pipeline speaks end to end (G.711 mu-law, 8 kHz). */
const SUPPORTED_FORMAT = { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 } as const;

/** Encoding aliases that are the SAME codec under a different name. */
const MULAW_ALIASES = new Set(['pcmu', 'pcmu8', 'ulaw', 'mulaw', 'g711u', 'audio/pcmu', 'audio/x-mulaw', 'audio/ulaw']);

export interface GatewayMediaBridge {
  close(): Promise<void>;
  readonly activeSessions: number;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function normaliseFormat(raw: unknown): Record<string, unknown> {
  const fmt = asObject(raw);
  // Absent format = the gateway is honouring the contract; say so explicitly
  // rather than leaving the session to guess.
  if (Object.keys(fmt).length === 0) return { ...SUPPORTED_FORMAT };
  const encoding = typeof fmt['encoding'] === 'string' ? fmt['encoding'].trim().toLowerCase() : '';
  const sampleRate = Number(fmt['sampleRate'] ?? SUPPORTED_FORMAT.sampleRate);
  return {
    ...fmt,
    // Same codec, other spelling -> the name the session checks for.
    encoding: MULAW_ALIASES.has(encoding) ? SUPPORTED_FORMAT.encoding : (fmt['encoding'] ?? encoding),
    sampleRate: Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : SUPPORTED_FORMAT.sampleRate,
    channels: 1,
  };
}

/**
 * Translate one gateway JSON frame into the session dialect.
 *
 * Returns the normalised JSON string, or null when the frame carries nothing
 * to act on (unparseable, unknown event, missing media payload) — a gateway
 * frame never crashes a call, it is simply ignored.
 *
 * Accepted gateway dialect:
 *   {event:'start'|'open',  callId|callSid, mediaFormat?}
 *   {event:'media'|'audio', payload | media:{payload}}
 *   {event:'dtmf'|'digit',  digit | dtmf:{digit}}
 *   {event:'clear'}
 *   {event:'hangup'|'end'|'bye'|'stop'}
 */
export function normaliseGatewayEvent(raw: string, callSid: string): string | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!msg || typeof msg !== 'object') return null;
  const root = msg as Record<string, unknown>;
  const event = root['event'];
  if (typeof event !== 'string') return null;

  switch (event) {
    case 'start':
    case 'open': {
      const body = asObject(root['start'] ?? root);
      const claimed =
        typeof body['callSid'] === 'string' && body['callSid']
          ? body['callSid']
          : typeof body['callId'] === 'string' && body['callId']
            ? body['callId']
            : callSid;
      return JSON.stringify({
        event: 'start',
        start: {
          ...body,
          callSid: claimed,
          mediaFormat: normaliseFormat(body['mediaFormat']),
        },
      });
    }
    case 'media':
    case 'audio': {
      const nested = root['media'];
      const payload =
        typeof nested === 'string'
          ? nested
          : typeof asObject(nested)['payload'] === 'string'
            ? (asObject(nested)['payload'] as string)
            : typeof root['payload'] === 'string'
              ? (root['payload'] as string)
              : null;
      if (!payload) return null;
      return JSON.stringify({ event: 'media', media: { payload } });
    }
    case 'dtmf':
    case 'digit': {
      const body = asObject(root['dtmf'] ?? root);
      const digit = typeof body['digit'] === 'string' ? body['digit'] : typeof body['value'] === 'string' ? body['value'] : null;
      if (!digit) return null;
      return JSON.stringify({ event: 'dtmf', dtmf: { digit } });
    }
    case 'clear':
      return JSON.stringify({ event: 'clear' });
    case 'hangup':
    case 'end':
    case 'bye':
    case 'stop': {
      const body = asObject(root['stop'] ?? root);
      // Same dual spelling as `start`: the gateway says callId, Twilio says callSid.
      const claimed =
        typeof body['callSid'] === 'string' && body['callSid']
          ? body['callSid']
          : typeof body['callId'] === 'string' && body['callId']
            ? body['callId']
            : callSid;
      return JSON.stringify({ event: 'stop', stop: { callSid: claimed } });
    }
    case 'connected':
    case 'mark':
    case 'ack':
      return JSON.stringify({ event });
    default:
      return null;
  }
}

export function attachGatewayMediaBridge(server: Server, deps: AppDeps): GatewayMediaBridge {
  const { config, db, logger, adapters } = deps;
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  const active = new Map<string, DuplexSession>();

  server.on('upgrade', (req, socket, head) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      rejectUpgrade(socket, 400, 'Bad Request');
      return;
    }
    if (url.pathname !== GATEWAY_MEDIA_PATH) {
      // Not our path: another bridge (or the fallback) answers this upgrade.
      return;
    }
    markUpgradeClaimed(req);

    const fail = (status: number, reason: string): void => {
      logger.debug('gateway_media.upgrade_rejected', { status, reason });
      rejectUpgrade(socket, status, reason);
    };

    if (!config.duplex.enabled) return fail(503, 'Duplex Disabled');
    if (!adapters || !duplexPorts(adapters.speech, adapters.ai)) return fail(503, 'Speech Or AI Not Configured');

    const callSid = url.searchParams.get('callSid') ?? '';
    const token = url.searchParams.get('token') ?? '';
    if (!callSid || !token) return fail(401, 'Unauthorized');
    if (!verifyStreamToken(config.sessionSecret, callSid, token)) return fail(401, 'Unauthorized');

    const call = db.prepare('SELECT id FROM calls WHERE provider_call_id = ?').get(callSid);
    if (!call) return fail(404, 'Unknown Call');
    if (active.has(callSid)) return fail(409, 'Call Already Streaming');

    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      const session = createDuplexSession({
        db,
        config,
        logger,
        speech: adapters.speech,
        ai: adapters.ai,
        callSid,
        transport: {
          sendFrame(frame) {
            if (ws.readyState !== ws.OPEN) return;
            ws.send(JSON.stringify({ event: 'media', media: { payload: Buffer.from(frame).toString('base64') } }));
          },
          close(reason) {
            if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) {
              ws.close(1000, reason.slice(0, 120));
            }
          },
        },
      });
      active.set(callSid, session);

      ws.on('message', (data: Buffer | Buffer[] | ArrayBuffer) => {
        const raw = Buffer.isBuffer(data)
          ? data.toString('utf8')
          : Array.isArray(data)
            ? Buffer.concat(data).toString('utf8')
            : Buffer.from(data).toString('utf8');
        if (raw.length === 0) return;
        const normalised = normaliseGatewayEvent(raw, callSid);
        if (normalised === null) {
          logger.debug('gateway_media.ignored_event', { callSid });
          return;
        }
        void session.handle(normalised);
      });
      ws.on('close', () => {
        if (active.get(callSid) === session) active.delete(callSid);
        void session.end('socket_closed');
      });
      ws.on('error', (err: Error) => {
        logger.warn('gateway_media.socket_error', { error: err.message });
      });
    });
  });

  return {
    get activeSessions(): number {
      return active.size;
    },
    async close(): Promise<void> {
      active.clear();
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}
