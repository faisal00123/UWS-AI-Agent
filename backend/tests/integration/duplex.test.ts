/**
 * Duplex live-call bridge integration tests (real WebSocket, real server,
 * mock providers — zero network).
 *
 * Proves the whole two-way call path that the fixed greeting used to replace:
 *  1. a SIGNED answer URL attributes the call to a lead and serves TwiML that
 *     opens <Connect><Stream> (disclosure first, never <Record/>);
 *  2. over that stream a prospect utterance becomes an STT transcript segment,
 *     the engine produces the agent turn (mock AI), TTS audio is converted to
 *     mu-law frames and paced back to the caller;
 *  3. stopping the stream finishes the conversation (qualification extracted,
 *     transcript marked complete) without touching recording flags;
 *  4. an inbound caller on file gets a stream AND a ledger row; an unknown
 *     caller gets the fixed greeting instead of an unattributable stream;
 *  5. the upgrade itself is gated: bad token 401, unknown call 404, disabled
 *     bridge 503, missing speech/AI 503.
 *
 * Safety: no test dials, nothing is recorded, and every provider here is a
 * mock adapter — no request leaves the process.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startTestServer, type TestServer } from '../helpers/app.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { nowIso } from '../../src/core/time.ts';
import { pcm16ToUlaw } from '../../src/domain/media/audio.ts';
import { mintStreamToken } from '../../src/domain/media/duplex.ts';
import type { DB } from '../../src/db/index.ts';

const TWILIO_TOKEN = 'twilio-duplex-token';
const CALL_SID = 'CAduplex00011111111111111111111';
const LEAD_PHONE = '+923007654321';

const DUPLEX_ENV = {
  TELEPHONY_PROVIDER: 'twilio',
  TELEPHONY_ACCOUNT_SID: 'ACduplex',
  TELEPHONY_AUTH_TOKEN: TWILIO_TOKEN,
  TELEPHONY_FROM_NUMBER: '+922111111111',
  // Mock providers: the full STT -> engine -> TTS path with no credentials
  // and no network.
  AI_PROVIDER: 'mock',
  AI_API_KEY: 'mock-ai-key',
  AI_MODEL: 'mock-model',
  STT_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock',
  STT_API_KEY: 'mock-stt-key',
  PUBLIC_BASE_URL: 'https://duplex.example.com',
};

function twilioSig(url: string, params: Record<string, string> = {}): string {
  const concat = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHmac('sha1', TWILIO_TOKEN).update(url + concat).digest('base64');
}

function portOf(url: string): number {
  return Number(new URL(url).port);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, label: string, timeoutMs = 6_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for: ${label}`);
    await sleep(15);
  }
}

function speechFrame(amplitude = 6_000, bytes = 160): Buffer {
  return Buffer.from(pcm16ToUlaw(new Int16Array(bytes).fill(amplitude)));
}
const silenceFrame = (): Buffer => Buffer.from(new Uint8Array(160).fill(0xff));

interface StreamMessage {
  event: string;
  media?: { payload?: string };
}

/** Connect and fail the upgrade with a specific HTTP status. */
function expectUpgradeFailure(wsUrl: string, status: number, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error(`no rejection for: ${label}`)), 4_000);
    ws.on('open', () => {
      clearTimeout(timer);
      ws.close();
      reject(new Error(`upgrade unexpectedly succeeded: ${label}`));
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      const match = /(\d{3})/.exec(err.message);
      const actual = match ? Number(match[1]) : -1;
      if (actual === status) resolve();
      else reject(new Error(`${label}: expected ${status}, got ${actual} (${err.message})`));
    });
  });
}

function connect(wsUrl: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const timer = setTimeout(() => reject(new Error('websocket did not open')), 4_000);
    ws.on('open', () => {
      clearTimeout(timer);
      resolve(ws);
    });
    ws.on('error', (err: Error) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/** Ask the signed answer URL for TwiML and return the stream URL inside it. */
async function fetchAnswerTwiml(
  server: TestServer,
  query: { callSid: string; from?: string; to?: string },
): Promise<{ status: number; raw: string; streamUrl: string | null }> {
  const parts = [`CallSid=${encodeURIComponent(query.callSid)}`];
  if (query.from) parts.push(`From=${encodeURIComponent(query.from)}`);
  if (query.to) parts.push(`To=${encodeURIComponent(query.to)}`);
  const path = `/api/webhooks/telephony/twilio/voice?${parts.join('&')}`;
  const res = await server.client().request(path, {
    method: 'GET',
    headers: { 'x-twilio-signature': twilioSig(server.url + path) },
  });
  const match = /url="([^"]+)"/.exec(res.raw);
  return { status: res.status, raw: res.raw, streamUrl: match ? match[1]!.replace(/&amp;/g, '&') : null };
}

/** Rewrite the advertised wss URL onto the local test server. */
function localStreamUrl(streamUrl: string, server: TestServer): string {
  const url = new URL(streamUrl);
  return `ws://127.0.0.1:${portOf(server.url)}${url.pathname}${url.search}`;
}

const owner = { userId: null, label: 'owner' as const };

function insertCall(db: DB, id: string, businessId: string, providerCallId: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status,
       outcome, to_number_e164, recording_enabled, recording_consent, simulation, counts_against_daily_limit,
       daily_bucket, cost_state, created_at, updated_at)
     VALUES (?, NULL, ?, 'outbound', 'call', 'twilio', ?, 'in_progress', 'unknown', ?, 0, 0, 0, 1,
       '2026-11-01', 'unavailable', ?, ?)`,
  ).run(id, businessId, providerCallId, LEAD_PHONE, at, at);
}

describe('duplex live-call bridge', () => {
  let server: TestServer;
  let db: DB;

  before(async () => {
    server = await startTestServer(DUPLEX_ENV);
    db = server.db;
  });
  after(async () => server.close());

  test('a signed answer URL opens a stream and the call runs a full conversation', async () => {
    const lead = createLead(db, { displayName: 'Duplex Traders', city: 'Karachi', phone: LEAD_PHONE }, owner);
    insertCall(db, 'cal_duplex_main', lead.id, CALL_SID);

    // 1. TwiML: disclosure first, then the stream, never a recorder.
    const answer = await fetchAnswerTwiml(server, { callSid: CALL_SID, from: LEAD_PHONE });
    assert.equal(answer.status, 200);
    assert.ok(answer.raw.includes('<Connect><Stream'), 'the duplex variant must be served');
    assert.ok(answer.raw.indexOf('artificial intelligence') < answer.raw.indexOf('<Connect>'), 'disclosure spoken first');
    assert.ok(answer.raw.includes('<Hangup/>'));
    assert.ok(!answer.raw.includes('<Record'), 'recording requires consent and is never enabled');
    assert.ok(answer.streamUrl, 'the TwiML must carry the stream url');
    assert.ok(answer.streamUrl.startsWith('wss://duplex.example.com/api/media?callSid='), answer.streamUrl);

    // 2. Connect to the local server with the advertised parameters.
    const ws = await connect(localStreamUrl(answer.streamUrl, server));
    const received: StreamMessage[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString()) as StreamMessage));

    ws.send(
      JSON.stringify({
        event: 'start',
        start: {
          streamSid: 'MZduplexstream01',
          callSid: CALL_SID,
          mediaFormat: { encoding: 'audio/x-mulaw', sampleRate: 8000, channels: 1 },
        },
      }),
    );

    // 3. A prospect speaks (400 ms) and then pauses (700 ms).
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ event: 'media', media: { payload: speechFrame().toString('base64') } }));
    for (let i = 0; i < 35 && received.filter((m) => m.event === 'media').length === 0; i++) {
      ws.send(JSON.stringify({ event: 'media', media: { payload: silenceFrame().toString('base64') } }));
      await sleep(5);
    }

    await waitFor(
      () => received.some((m) => m.event === 'media'),
      'the agent audio frames to come back over the socket',
    );

    // 4. The conversation exists with BOTH sides on the transcript.
    const conversation = db
      .prepare('SELECT id, call_id, business_id, ended_at, transcript_state FROM conversations WHERE call_id = ?')
      .get('cal_duplex_main') as
      | { id: string; call_id: string; business_id: string; ended_at: string | null; transcript_state: string }
      | undefined;
    assert.ok(conversation, 'the stream must open a conversation for the call');
    assert.equal(conversation.business_id, lead.id);
    assert.equal(conversation.ended_at, null, 'the conversation is still live');
    assert.equal(conversation.transcript_state, 'partial');

    const segments = db
      .prepare('SELECT speaker, text, source FROM transcript_segments WHERE conversation_id = ? ORDER BY seq')
      .all(conversation.id) as unknown as { speaker: string; text: string; source: string }[];
    const prospect = segments.find((s) => s.speaker === 'prospect');
    const agent = segments.find((s) => s.speaker === 'agent');
    assert.ok(prospect, 'the utterance must be on the transcript');
    assert.ok(prospect.text.includes('simulated transcript'), 'STT produced the text (mock provider)');
    assert.equal(prospect.source, 'stt', 'prospect speech is marked as transcribed');
    assert.ok(agent, 'the engine must have replied');
    assert.equal(agent.source, 'typed', 'agent replies are generated text, not transcribed speech');

    // 5. The frames that came back are playable telephony audio.
    const payloads = received.filter((m) => m.event === 'media').map((m) => m.media?.payload ?? '');
    assert.ok(payloads.length >= 1);
    const decoded = Buffer.concat(payloads.map((p) => Buffer.from(p, 'base64')));
    assert.ok(decoded.byteLength >= 160 && decoded.byteLength % 160 === 0, `whole frames only (${decoded.byteLength})`);

    // 6. Stop the stream: the conversation is extracted and closed.
    ws.send(JSON.stringify({ event: 'stop', stop: { callSid: CALL_SID } }));
    await waitFor(() => received.length >= 1 && (conversation.ended_at = readEnded(db, conversation.id)) !== null, 'the conversation to finish');

    const finished = db
      .prepare('SELECT ended_at, transcript_state, extracted_json FROM conversations WHERE id = ?')
      .get(conversation.id) as { ended_at: string; transcript_state: string; extracted_json: string };
    assert.ok(finished.ended_at, 'the conversation must be closed');
    assert.equal(finished.transcript_state, 'complete');
    const extracted = JSON.parse(finished.extracted_json) as { qualification: string; interestLevel: string };
    assert.ok(['qualified', 'needs_review', 'unqualified', 'disqualified'].includes(extracted.qualification));
    assert.equal(extracted.interestLevel, 'neutral', 'the mock assessment is parsed end to end');

    // 7. Nothing was recorded and no phone number was dialled by the bridge.
    const call = db
      .prepare('SELECT recording_enabled, recording_consent, direction FROM calls WHERE id = ?')
      .get('cal_duplex_main') as { recording_enabled: number; recording_consent: number; direction: string };
    assert.equal(call.recording_enabled, 0, 'the bridge never enables recording');
    assert.equal(call.recording_consent, 0);
    assert.equal(call.direction, 'outbound', 'the bridge does not create or replace the call');

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else {
        ws.once('close', () => resolve());
        ws.close();
      }
    });
  });

  test('a duplicate connection for the same call is refused', async () => {
    // The call ledger row from the first test still exists, so a valid token
    // upgrades cleanly — until a session for it is already active, which is
    // exactly what the second (concurrent) connection must be refused for.
    const token = mintStreamToken(server.config.sessionSecret, CALL_SID);
    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}/api/media?callSid=${CALL_SID}&token=${encodeURIComponent(token)}`;
    const first = await connect(wsUrl);
    try {
      await expectUpgradeFailure(wsUrl, 409, 'second connection while the first is live');
    } finally {
      await new Promise<void>((resolve) => {
        if (first.readyState === WebSocket.CLOSED) resolve();
        else {
          first.once('close', () => resolve());
          first.close();
        }
      });
    }
  });

  test('a forged token is refused at the upgrade', async () => {
    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}/api/media?callSid=${CALL_SID}&token=123.forged`;
    await expectUpgradeFailure(wsUrl, 401, 'forged token');
  });

  test('a missing token is refused', async () => {
    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}/api/media?callSid=${CALL_SID}`;
    await expectUpgradeFailure(wsUrl, 401, 'missing token');
  });

  test('an unknown call is refused even with a valid token', async () => {
    const token = mintStreamToken(server.config.sessionSecret, 'CAneverplaced');
    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}/api/media?callSid=CAneverplaced&token=${encodeURIComponent(token)}`;
    await expectUpgradeFailure(wsUrl, 404, 'unknown call');
  });

  test('an unattributable caller gets the fixed greeting, not a stream', async () => {
    const answer = await fetchAnswerTwiml(server, {
      callSid: 'CAunknowncaller0000000000000000001',
      from: '+923000000000',
    });
    assert.equal(answer.status, 200);
    assert.ok(!answer.raw.includes('<Connect'), 'no stream for a caller with no lead');
    assert.ok(answer.raw.includes('<Hangup/>'));
    assert.ok(answer.raw.includes('artificial intelligence'), 'the disclosure is still spoken');
    assert.equal(answer.streamUrl, null);
  });

  test('an inbound caller on file gets a stream and a ledger row', async () => {
    const inboundPhone = '+923009998877';
    const lead = createLead(db, { displayName: 'Inbound Caller Ltd', city: 'Lahore', phone: inboundPhone }, owner);
    const before = (db.prepare("SELECT COUNT(*) c FROM calls WHERE direction = 'inbound'").get() as { c: number }).c;

    const answer = await fetchAnswerTwiml(server, {
      callSid: 'CAinbound00000000000000000000001',
      from: inboundPhone,
      to: '+922111111111',
    });
    assert.equal(answer.status, 200);
    assert.ok(answer.raw.includes('<Connect><Stream'), 'a known caller gets the duplex variant');

    const rows = db
      .prepare("SELECT id, business_id, direction, provider_call_id, recording_enabled FROM calls WHERE direction = 'inbound'")
      .all() as unknown as { id: string; business_id: string; direction: string; provider_call_id: string; recording_enabled: number }[];
    assert.equal(rows.length, before + 1, 'the inbound call is recorded in the ledger');
    const row = rows.find((r) => r.provider_call_id === 'CAinbound00000000000000000000001');
    assert.ok(row);
    assert.equal(row.business_id, lead.id, 'the call is attributed to the lead on file');
    assert.equal(row.recording_enabled, 0);
  });

  test('the bridge refuses to upgrade when speech/AI are missing', async () => {
    const bare = await startTestServer({
      TELEPHONY_PROVIDER: 'twilio',
      TELEPHONY_ACCOUNT_SID: 'ACduplex',
      TELEPHONY_AUTH_TOKEN: TWILIO_TOKEN,
      TELEPHONY_FROM_NUMBER: '+922111111111',
      PUBLIC_BASE_URL: 'https://duplex.example.com',
    });
    try {
      const lead = createLead(bare.db, { displayName: 'No Speech Co', city: 'Islamabad', phone: '+923001112233' }, owner);
      insertCall(bare.db, 'cal_bare', lead.id, 'CAbare00000000000000000000000001');
      const answer = await fetchAnswerTwiml(bare, { callSid: 'CAbare00000000000000000000000001' });
      assert.ok(!answer.raw.includes('<Connect'), 'without speech/AI the fixed greeting is served');
      assert.ok(answer.raw.includes('<Hangup/>'));

      const token = mintStreamToken(bare.config.sessionSecret, 'CAbare00000000000000000000000001');
      const wsUrl = `ws://127.0.0.1:${portOf(bare.url)}/api/media?callSid=CAbare00000000000000000000000001&token=${encodeURIComponent(token)}`;
      await expectUpgradeFailure(wsUrl, 503, 'speech/AI not configured');
    } finally {
      await bare.close();
    }
  });

  test('the bridge refuses to upgrade when disabled by configuration', async () => {
    const off = await startTestServer({ ...DUPLEX_ENV, DUPLEX_ENABLED: 'false' });
    try {
      const lead = createLead(off.db, { displayName: 'Disabled Bridge Co', city: 'Peshawar', phone: '+923005556677' }, owner);
      insertCall(off.db, 'cal_off', lead.id, 'CAoff000000000000000000000000001');
      const answer = await fetchAnswerTwiml(off, { callSid: 'CAoff000000000000000000000000001', from: LEAD_PHONE });
      assert.ok(!answer.raw.includes('<Connect'), 'a disabled bridge serves the fixed greeting');

      const token = mintStreamToken(off.config.sessionSecret, 'CAoff000000000000000000000000001');
      const wsUrl = `ws://127.0.0.1:${portOf(off.url)}/api/media?callSid=CAoff000000000000000000000000001&token=${encodeURIComponent(token)}`;
      await expectUpgradeFailure(wsUrl, 503, 'duplex disabled');
    } finally {
      await off.close();
    }
  });
});

/** Poll helper for the finish assertion (reads ended_at as it changes). */
function readEnded(db: DB, conversationId: string): string | null {
  const row = db.prepare('SELECT ended_at FROM conversations WHERE id = ?').get(conversationId) as
    | { ended_at: string | null }
    | undefined;
  return row?.ended_at ?? null;
}
