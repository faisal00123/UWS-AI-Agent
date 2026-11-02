/**
 * Duplex live-call bridge — session logic (the seam that turns a Twilio
 * Media Stream into the conversation lifecycle).
 *
 * A call now runs as a real two-way conversation:
 *
 *   answer URL        greeting WITH the mandated AI disclosure, then
 *                     <Connect><Stream> into /api/media (signature-gated,
 *                     token-gated) — or the fixed greeting + hangup when the
 *                     bridge is off or the call cannot be attributed to a lead
 *   start             resolve the call row, open the conversation
 *   media frames      mu-law 8 kHz -> voice activity -> utterance -> STT ->
 *                     engine turn (disclosure + turn ceiling) -> TTS -> mu-law
 *                     frames paced back to the caller
 *   dtmf              digits are recorded as system transcript evidence; the
 *                     handoff digits ask for a human when the policy allows
 *   stop / close      finishConversation -> qualification, lead update,
 *                     opt-out suppression (append-only)
 *
 * Safety invariants carried over unchanged:
 *  - this bridge never dials and never enables live mode: it only serves a
 *    call that already exists (the outreach guard approved it, or the prospect
 *    called us);
 *  - no recording: <Record> is never emitted, audio frames are transient
 *    memory only and are never written to disk;
 *  - no fabrication: a missing STT/AI/TTS provider ends the call honestly
 *    (logged) instead of inventing speech;
 *  - the AI disclosure is spoken by the TwiML greeting AND enforced inside
 *    the engine, so it cannot be skipped here.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { DB } from '../../db/index.ts';
import type { Config } from '../../core/config.ts';
import type { Logger } from '../../core/logger.ts';
import { nowIso } from '../../core/time.ts';
import { newId } from '../../core/ids.ts';
import { AppError } from '../../core/errors.ts';
import type { ConversationPort, SpeechPort } from '../../adapters/types.ts';
import { AdapterError } from '../../adapters/types.ts';
import { loadConversationPolicy } from '../ai/engine.ts';
import {
  finishConversation,
  generateAgentReply,
  ingestProspectAudio,
  ingestSystemNote,
  startConversation,
} from './pipeline.ts';
import { ttsToUlaw, ulawToWavForStt } from './audio.ts';
import { UtteranceDetector } from './vad.ts';

// ---------------------------------------------------------------- tokens ---

const TOKEN_CONTEXT = 'uws-duplex-stream:v1';
const DEFAULT_TTL_MS = 5 * 60_000;

function signature(secret: string, callSid: string, expiresAt: number): string {
  const key = createHmac('sha256', secret).update(TOKEN_CONTEXT).digest();
  return createHmac('sha256', key).update(`${callSid}:${expiresAt}`).digest('base64url');
}

/**
 * Short-lived bearer token embedded in the TwiML stream URL. Twilio cannot
 * send headers on a WebSocket upgrade, so the URL carries a signature over
 * (callSid, expiry): a random client cannot mint one without SESSION_SECRET.
 */
export function mintStreamToken(secret: string, callSid: string, now = Date.now(), ttlMs = DEFAULT_TTL_MS): string {
  const expiresAt = now + ttlMs;
  return `${expiresAt}.${signature(secret, callSid, expiresAt)}`;
}

export function verifyStreamToken(secret: string, callSid: string, token: string, now = Date.now()): boolean {
  const dot = token.indexOf('.');
  if (dot <= 0) return false;
  const expiresAt = Number(token.slice(0, dot));
  if (!Number.isFinite(expiresAt) || expiresAt < now) return false;
  const expected = signature(secret, callSid, expiresAt);
  const given = token.slice(dot + 1);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given, 'utf8'), Buffer.from(expected, 'utf8'));
}

// ----------------------------------------------------------------- TwiML ---

/** Approved wording: the disclosure that must always be spoken first. */
export const AI_DISCLOSURE =
  'Hello, this is the artificial intelligence calling assistant from Universal Web Solutions. I am an AI, and I am disclosing that up front.';

/** Fixed greeting used when the duplex bridge cannot serve the call. */
export const GREETING_HANGUP = `${AI_DISCLOSURE} Our team will follow up with you shortly with more information. Thank you for your time. Goodbye.`;

/** Greeting used when the duplex stream opens right after it. */
export const GREETING_DUPLEX = `${AI_DISCLOSURE} I am ready to talk with you now. Please go ahead.`;

function escapeXml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** `https://host` -> `wss://host` (Twilio refuses ws:// in production). */
export function streamWsUrl(publicBaseUrl: string, callSid: string, token: string): string {
  const wsBase = publicBaseUrl
    .replace(/\/+$/, '')
    .replace(/^http:\/\//i, 'ws://')
    .replace(/^https:\/\//i, 'wss://');
  return `${wsBase}/api/media?callSid=${encodeURIComponent(callSid)}&token=${encodeURIComponent(token)}`;
}

/**
 * TwiML for a duplex call: disclosure first, then the media stream, then a
 * hangup for when the stream ends. Only the caller's inbound track is
 * streamed in (no echo of our own playback), and `codec`/`sampleRate` pin
 * the format this bridge actually speaks. Never contains <Record/>.
 */
export function duplexAnswerTwiml(wsUrl: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say language="en-US">${GREETING_DUPLEX}</Say>
  <Connect><Stream url="${escapeXml(wsUrl)}" track="inbound_track" codec="PCMU" sampleRate="8000"/></Connect>
  <Hangup/>
</Response>`;
}

// -------------------------------------------------- call attribution ------

export interface ResolvedCall {
  callId: string;
  businessId: string;
  /** true when this answer created the inbound call ledger row. */
  created: boolean;
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, '');
}

/**
 * Attribute an answered call to a lead before serving TwiML.
 *
 *  1. an outbound call we placed (row keyed by the provider's CallSid);
 *  2. otherwise an inbound call from a number on file (the prospect called
 *     us — a `calls` row is created for the ledger; outbound budgets and the
 *     outreach guard are NOT involved, this never dials).
 *
 * Returns null when the caller cannot be attributed — the fixed greeting is
 * served instead of opening a stream for a lead we do not have.
 *
 * Suppression is deliberately not consulted here: suppression governs who WE
 * may contact. A suppressed person who phones us still gets a real
 * conversation, and any opt-out they express is applied by
 * `finishConversation` exactly as it would be on an outbound call.
 */
export function resolveCallForAnswer(
  db: DB,
  input: { callSid: string; from?: string | null; to?: string | null },
): ResolvedCall | null {
  const existing = db
    .prepare('SELECT id, business_id FROM calls WHERE provider_call_id = ?')
    .get(input.callSid) as { id: string; business_id: string } | undefined;
  if (existing) return { callId: existing.id, businessId: existing.business_id, created: false };

  const from = (input.from ?? '').trim();
  const digits = digitsOnly(from);
  if (digits.length < 7) return null;

  const lead = db
    .prepare(
      `SELECT id FROM businesses
        WHERE (phone_e164 = ? OR phone_e164 = ?)
          AND merged_into_id IS NULL
        LIMIT 1`,
    )
    .get(`+${digits}`, digits) as { id: string } | undefined;
  if (!lead) return null;

  const at = nowIso();
  const id = newId('cal');
  try {
    db.prepare(
      `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status,
         outcome, to_number_e164, recording_enabled, recording_consent, started_at, answered_at, simulation,
         counts_against_daily_limit, daily_bucket, cost_state, created_at, updated_at)
       VALUES (?, NULL, ?, 'inbound', 'call', 'twilio', ?, 'in_progress', 'answered', ?, 0, 0, ?, ?, 0, 0, NULL,
         'unavailable', ?, ?)`,
    ).run(id, lead.id, input.callSid, from, at, at, at, at);
  } catch {
    // A racing status callback already registered this call — read it back.
    const raced = db
      .prepare('SELECT id, business_id FROM calls WHERE provider_call_id = ?')
      .get(input.callSid) as { id: string; business_id: string } | undefined;
    if (!raced) throw new AppError('conflict', 'Call registration raced with a provider event');
    return { callId: raced.id, businessId: raced.business_id, created: false };
  }
  return { callId: id, businessId: lead.id, created: true };
}

/**
 * True when a duplex conversation can actually be served: both ports exist
 * and neither is switched off in settings. Without them an instance serves
 * the fixed greeting and refuses the WebSocket upgrade — a stream that could
 * only produce silence or invented speech is never opened.
 */
export function duplexPorts(speech: SpeechPort | null, ai: ConversationPort | null): boolean {
  if (!speech || !ai) return false;
  if (speech.status().state === 'disabled') return false;
  if (ai.status().state === 'disabled') return false;
  return true;
}

// -------------------------------------------------------------- player ----

/** Paces mu-law bytes to the socket in real-time 20 ms (160 sample) frames. */
class UlawPlayer {
  private chunks: Uint8Array[] = [];
  private offset = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private waiters: (() => void)[] = [];
  private readonly send: (frame: Uint8Array) => void;

  constructor(send: (frame: Uint8Array) => void) {
    this.send = send;
  }

  get playing(): boolean {
    return this.chunks.length > 0;
  }

  enqueue(bytes: Uint8Array): void {
    if (bytes.byteLength === 0) return;
    this.chunks.push(bytes);
    if (!this.timer) {
      this.timer = setInterval(() => this.tick(), 20);
      this.timer.unref?.();
    }
  }

  /** Stop playback (barge-in or call end) and release anyone waiting. */
  stop(): void {
    const hadWork = this.chunks.length > 0;
    this.chunks = [];
    this.offset = 0;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (hadWork) this.release();
  }

  /** Resolves once playback has drained (or been stopped). */
  whenDrained(): Promise<void> {
    if (!this.playing) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  private tick(): void {
    const head = this.chunks[0];
    if (!head) {
      this.stop();
      return;
    }
    const take = Math.min(160, head.byteLength - this.offset);
    this.send(head.subarray(this.offset, this.offset + take));
    this.offset += take;
    if (this.offset >= head.byteLength) {
      this.chunks.shift();
      this.offset = 0;
      if (this.chunks.length === 0) this.stop();
    }
  }
}

// ------------------------------------------------------------- session ----

export interface DuplexTransport {
  /** One mu-law frame towards the caller (already telephony audio). */
  sendFrame(frame: Uint8Array): void;
  /** Close the media stream (Twilio then executes the trailing <Hangup/>). */
  close(reason: string): void;
}

export interface DuplexSessionOptions {
  db: DB;
  config: Config;
  logger: Logger;
  speech: SpeechPort | null;
  ai: ConversationPort | null;
  /** CallSid bound (by the signed upgrade URL) to this connection. */
  callSid: string;
  transport: DuplexTransport;
}

export interface DuplexSession {
  /** Handle one raw JSON text frame from Twilio. Never throws. */
  handle(raw: string): Promise<void>;
  /** Idempotent teardown: extract qualification, then close. */
  end(reason: string): Promise<void>;
  readonly conversationId: string | null;
  readonly ended: boolean;
}

export function createDuplexSession(opts: DuplexSessionOptions): DuplexSession {
  const { db, config, logger, speech, ai, callSid, transport } = opts;
  const detector = new UtteranceDetector({
    threshold: config.duplex.vadThreshold,
    silenceMs: config.duplex.silenceMs,
    minSpeechMs: 250,
    maxUtteranceMs: config.duplex.maxUtteranceMs,
  });
  const player = new UlawPlayer((frame) => transport.sendFrame(frame));

  let conversationId: string | null = null;
  let ended = false;
  let draining = false;
  let maxCallTimer: ReturnType<typeof setTimeout> | null = null;
  const pending: Uint8Array[] = [];

  function log(level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown> = {}): void {
    logger[level](msg, { callSid, conversationId, ...fields });
  }

  async function end(reason: string): Promise<void> {
    if (ended) return;
    ended = true;
    if (maxCallTimer) {
      clearTimeout(maxCallTimer);
      maxCallTimer = null;
    }
    player.stop();
    let segmentCount = 0;
    let suppressed = false;
    let humanRequested = false;
    if (conversationId) {
      try {
        const finished = await finishConversation(db, conversationId);
        segmentCount = finished.segmentCount;
        suppressed = finished.suppressed;
        humanRequested = finished.humanRequested;
      } catch (err) {
        log('error', 'duplex.finish_failed', { error: err instanceof Error ? err.message : String(err) });
      }
    }
    log('info', 'duplex.ended', { reason, segmentCount, suppressed, humanRequested });
    transport.close(reason);
  }

  function startMaxCallTimer(): void {
    maxCallTimer = setTimeout(() => {
      log('warn', 'duplex.max_call_duration', { seconds: config.duplex.maxCallSeconds });
      void end('max_duration');
    }, config.duplex.maxCallSeconds * 1000);
    maxCallTimer.unref?.();
  }

  function onStart(start: unknown): void {
    if (conversationId) return; // duplicate start on the same connection
    const payload = (start ?? {}) as Record<string, unknown>;
    const streamCallSid = typeof payload['callSid'] === 'string' ? payload['callSid'] : '';
    if (streamCallSid !== callSid) {
      log('warn', 'duplex.call_sid_mismatch');
      ended = true;
      transport.close('call_sid_mismatch');
      return;
    }
    const format = (payload['mediaFormat'] ?? null) as { encoding?: unknown; sampleRate?: unknown } | null;
    if (format && (format.encoding !== 'audio/x-mulaw' || Number(format.sampleRate) !== 8000)) {
      log('warn', 'duplex.unsupported_format', { encoding: String(format.encoding ?? '') });
      ended = true;
      transport.close('unsupported_format');
      return;
    }

    const call = db.prepare('SELECT id, business_id FROM calls WHERE provider_call_id = ?').get(callSid) as
      | { id: string; business_id: string }
      | undefined;
    if (!call) {
      log('warn', 'duplex.unknown_call');
      ended = true;
      transport.close('unknown_call');
      return;
    }

    conversationId = startConversation(db, config, { businessId: call.business_id, callId: call.id });
    startMaxCallTimer();
    log('info', 'duplex.started', { callId: call.id });
  }

  async function runTurn(audio: Uint8Array): Promise<void> {
    if (!conversationId) return;
    try {
      // 1. STT: transient buffer -> text segment (never fabricated).
      await ingestProspectAudio(db, { speech, ai }, conversationId, {
        audio: ulawToWavForStt(audio),
        mimeType: 'audio/wav',
        filename: 'live-turn.wav',
      });
      // 2. engine turn (disclosure + turn ceiling) -> TTS in telephony format.
      const reply = await generateAgentReply(db, config, { speech, ai }, conversationId, { speechFormat: 'pcm' });
      if (ended) return;
      if (reply.audio && reply.audio.byteLength > 0) {
        const frames = ttsToUlaw(reply.audio, reply.contentType ?? 'audio/mpeg', reply.sampleRate ?? undefined);
        if (frames && frames.byteLength > 0) {
          player.enqueue(frames);
        } else {
          // Honest failure: bytes we cannot decode are not played and not
          // guessed at. The reply text is already on the transcript.
          log('warn', 'duplex.tts_undecodable', { contentType: reply.contentType ?? 'unknown' });
        }
      }
    } catch (err) {
      if (ended) return;
      const missing =
        (err instanceof AppError && err.code === 'provider_unavailable') ||
        (err instanceof AdapterError && err.code === 'unconfigured');
      if (missing) {
        // A provider that disappeared mid-call (turned off in settings, or
        // credentials removed): the call cannot continue. End it honestly
        // instead of playing silence or inventing a reply.
        log('warn', 'duplex.provider_unavailable', { message: err instanceof Error ? err.message : String(err) });
        await end('provider_unavailable');
        return;
      }
      log('error', 'duplex.turn_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    try {
      while (pending.length > 0 && !ended) {
        const audio = pending.shift();
        if (audio) await runTurn(audio);
      }
    } finally {
      draining = false;
    }
  }

  function onMedia(media: unknown): void {
    if (!conversationId || ended) return;
    const payload = (media ?? {}) as { payload?: unknown };
    if (typeof payload['payload'] !== 'string' || payload['payload'].length === 0) return;
    const bytes = Buffer.from(payload['payload'], 'base64');
    if (bytes.byteLength === 0) return;

    const utterance = detector.push(bytes);
    if (!utterance) return;
    // Barge-in: the prospect finished speaking, so our playback stops.
    player.stop();
    pending.push(utterance);
    void drain();
  }

  async function onDtmf(body: unknown): Promise<void> {
    if (!conversationId || ended) return;
    const digit = (body ?? {}) as { digit?: unknown };
    if (typeof digit['digit'] !== 'string' || digit['digit'].length === 0) return;
    const value = digit['digit'];
    try {
      ingestSystemNote(db, conversationId, `DTMF ${value}`);
    } catch {
      return; // conversation already closed elsewhere
    }
    if (value !== '0' && value !== '1') return;
    if (!speech || speech.status().state === 'unconfigured') return;

    log('info', 'duplex.human_handoff_requested', { digit: value });
    try {
      if (!loadConversationPolicy(db, config).humanHandoffOnRequest) return;
      db.prepare('UPDATE conversations SET human_requested = 1 WHERE id = ?').run(conversationId);
      const farewell = 'Thank you. I will ask a member of our team to get back to you. Goodbye.';
      const synthesized = await speech.synthesize({ text: farewell, language: 'en', format: 'pcm' });
      const frames = ttsToUlaw(synthesized.audio, synthesized.contentType, synthesized.sampleRate);
      if (ended) return;
      if (frames) player.enqueue(frames);
      await player.whenDrained();
      await end('human_handoff');
    } catch (err) {
      log('error', 'duplex.handoff_failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }

  return {
    get conversationId(): string | null {
      return conversationId;
    },
    get ended(): boolean {
      return ended;
    },

    async handle(raw: string): Promise<void> {
      if (ended) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return; // not JSON: nothing to act on, never crash a call
      }
      const event = (msg as { event?: unknown } | null)?.event;
      if (typeof event !== 'string') return;
      const body = (msg as Record<string, unknown>)[event];
      switch (event) {
        case 'start':
          onStart(body);
          return;
        case 'media':
          onMedia(body);
          return;
        case 'clear':
          detector.reset();
          return;
        case 'dtmf':
          await onDtmf(body);
          return;
        case 'stop':
          await end('provider_stop');
          return;
        case 'connected':
        case 'mark':
          return; // handshake / ordering markers: acknowledged by definition
        default:
          logger.debug('duplex.ignored_event', { callSid, event });
      }
    },

    end,
  };
}
