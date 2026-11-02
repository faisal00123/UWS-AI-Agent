/**
 * Duplex live-call bridge — WebSocket transport.
 *
 * Attaches a Twilio Media Streams endpoint to the existing HTTP server:
 *
 *   GET wss://<public>/api/media?callSid=..&token=..   (WebSocket upgrade)
 *
 * The upgrade is rejected with a real HTTP status unless ALL of these hold,
 * so an unconfigured or misconfigured instance exposes nothing:
 *
 *   1. the bridge is enabled in configuration;
 *   2. both an STT/TTS port and a conversation port exist (a duplex call
 *      without them could only produce silence or invented text);
 *   3. the signed, expiring token matches this CallSid (minted by the answer
 *      URL — Twilio cannot attach headers to a WebSocket upgrade);
 *   4. that CallSid belongs to a call in the ledger;
 *   5. no other connection is already serving the same call.
 *
 * Everything downstream is the domain session (`createDuplexSession`), which
 * drives the SAME conversation lifecycle as the HTTP media seam.
 */
import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AppDeps } from '../http/types.ts';
import { createDuplexSession, duplexPorts, verifyStreamToken, type DuplexSession } from '../domain/media/duplex.ts';
import { rejectUpgrade, markUpgradeClaimed } from './upgrade.ts';

export const DUPLEX_PATH = '/api/media';

export interface DuplexBridge {
  /** Terminate every live stream (used on shutdown and by test teardown). */
  close(): Promise<void>;
  readonly activeSessions: number;
}

export function attachDuplexBridge(server: Server, deps: AppDeps): DuplexBridge {
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
    if (url.pathname !== DUPLEX_PATH) {
      // Not our path: another bridge (or the fallback) answers this upgrade.
      return;
    }
    markUpgradeClaimed(req);

    const fail = (status: number, reason: string): void => {
      logger.debug('duplex.upgrade_rejected', { status, reason });
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
        if (raw.length > 0) void session.handle(raw);
      });
      ws.on('close', () => {
        if (active.get(callSid) === session) active.delete(callSid);
        void session.end('socket_closed');
      });
      ws.on('error', (err: Error) => {
        logger.warn('duplex.socket_error', { error: err.message });
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
