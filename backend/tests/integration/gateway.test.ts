/**
 * CloudyVoice SIP gateway integration tests (real server, real WebSocket,
 * fake gateway — zero network, zero carrier, zero spend).
 *
 * Proves the whole backend half of the SIP bridge end to end:
 *  1. the registry selects GATEWAY webhook URLs (Twilio's stay byte-identical);
 *  2. originate posts our documented control request with the bearer token;
 *  3. the signed answer route returns `bridge` (with a signed media URL) for a
 *     call we can attribute, and `hangup` + fixed disclosure otherwise — it
 *     never dials and never enables live mode;
 *  4. over /api/gateway/media the gateway's dialect is translated into the
 *     EXISTING session dialect, so a SIP call runs the same conversation
 *     lifecycle (STT -> engine -> TTS -> transcript -> qualification);
 *  5. signed lifecycle events are applied idempotently and a tampered
 *     signature changes nothing;
 *  6. an unknown WebSocket path still 404s (two bridges share one server).
 *
 * Safety: TELEPHONY_PROVIDER=cloudyvoice is configured but OPERATING_MODE is
 * never switched, no call is placed by any assertion, and every credential
 * here is an obviously fake test value.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { WebSocket } from 'ws';
import { startTestServer, type TestServer } from '../helpers/app.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { nowIso } from '../../src/core/time.ts';
import { pcm16ToUlaw } from '../../src/domain/media/audio.ts';
import { AI_DISCLOSURE, mintStreamToken } from '../../src/domain/media/duplex.ts';
import { normaliseGatewayEvent, GATEWAY_MEDIA_PATH } from '../../src/server/gatewaymedia.ts';
import { buildRegistry } from '../../src/adapters/registry.ts';
import { loadConfig } from '../../src/core/config.ts';
import type { FetchLike } from '../../src/adapters/types.ts';
import type { DB } from '../../src/db/index.ts';

const GW_TOKEN = 'gw-control-token-test';
const GW_EVENT_SECRET = 'gw-event-secret-test';

const GATEWAY_ENV = {
  TELEPHONY_PROVIDER: 'cloudyvoice',
  SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089',
  SIP_GATEWAY_API_TOKEN: GW_TOKEN,
  SIP_GATEWAY_EVENT_SECRET: GW_EVENT_SECRET,
  TELEPHONY_FROM_NUMBER: '+922111111111',
  // Mock providers: the full STT -> engine -> TTS path with no credentials
  // and no network.
  AI_PROVIDER: 'mock',
  AI_API_KEY: 'mock-ai-key',
  AI_MODEL: 'mock-model',
  STT_PROVIDER: 'mock',
  TTS_PROVIDER: 'mock',
  STT_API_KEY: 'mock-stt-key',
  PUBLIC_BASE_URL: 'https://gw.example.com',
};

const ANSWER_PATH = '/api/webhooks/telephony/gateway/answer';
const EVENTS_PATH = '/api/webhooks/telephony/gateway/events';

const owner = { userId: null, label: 'owner' as const };

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

function sign(raw: string): string {
  return createHmac('sha256', GW_EVENT_SECRET).update(raw).digest('hex');
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

/** Rewrite the advertised wss URL onto the local test server. */
function localWsUrl(advertised: string, server: TestServer): string {
  const url = new URL(advertised);
  return `ws://127.0.0.1:${portOf(server.url)}${url.pathname}${url.search}`;
}

function insertCall(db: DB, id: string, businessId: string, providerCallId: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status,
       outcome, to_number_e164, recording_enabled, recording_consent, simulation, counts_against_daily_limit,
       daily_bucket, cost_state, created_at, updated_at)
     VALUES (?, NULL, ?, 'outbound', 'call', 'cloudyvoice', ?, 'ringing', 'unknown', ?, 0, 0, 0, 1,
       '2026-11-01', 'unavailable', ?, ?)`,
  ).run(id, businessId, providerCallId, '+923007654321', at, at);
}

describe('gateway media dialect translation', () => {
  test('start accepts callId/omitted format and normalises pcmu aliases', () => {
    const open = JSON.parse(normaliseGatewayEvent(JSON.stringify({ event: 'open', callId: 'gw-1' }), 'gw-1')!) as {
      event: string;
      start: { callSid: string; mediaFormat: { encoding: string; sampleRate: number } };
    };
    assert.equal(open.event, 'start');
    assert.equal(open.start.callSid, 'gw-1', 'callId is the gateway spelling of callSid');
    assert.equal(open.start.mediaFormat.encoding, 'audio/x-mulaw', 'an absent format means the contract is honoured');
    assert.equal(open.start.mediaFormat.sampleRate, 8000);

    const alias = JSON.parse(
      normaliseGatewayEvent(
        JSON.stringify({ event: 'start', callSid: 'gw-2', mediaFormat: { encoding: 'pcmu', sampleRate: '8000' } }),
        'gw-2',
      )!,
    ) as { start: { mediaFormat: { encoding: string; sampleRate: number } } };
    assert.equal(alias.start.mediaFormat.encoding, 'audio/x-mulaw');
    assert.equal(alias.start.mediaFormat.sampleRate, 8000);

    // A genuinely different codec is passed through untouched so the session
    // can refuse it honestly instead of pretending it is mu-law.
    const other = JSON.parse(
      normaliseGatewayEvent(JSON.stringify({ event: 'start', callSid: 'gw-3', mediaFormat: { encoding: 'opus' } }), 'gw-3')!,
    ) as { start: { mediaFormat: { encoding: string } } };
    assert.equal(other.start.mediaFormat.encoding, 'opus');
  });

  test('a mismatched call id still reaches the session so it can refuse it', () => {
    const out = JSON.parse(normaliseGatewayEvent(JSON.stringify({ event: 'start', callSid: 'OTHER' }), 'gw-1')!) as {
      start: { callSid: string };
    };
    assert.equal(out.start.callSid, 'OTHER', 'the mismatch check must still see the claimed id');
  });

  test('media accepts nested and top-level payloads; dtmf and hangup alias', () => {
    const nested = JSON.parse(normaliseGatewayEvent(JSON.stringify({ event: 'media', media: { payload: 'AAAA' } }), 'c')!) as {
      media: { payload: string };
    };
    assert.equal(nested.media.payload, 'AAAA');

    const top = JSON.parse(normaliseGatewayEvent(JSON.stringify({ event: 'audio', payload: 'BBBB' }), 'c')!) as {
      media: { payload: string };
    };
    assert.equal(top.media.payload, 'BBBB');

    const digit = JSON.parse(normaliseGatewayEvent(JSON.stringify({ event: 'digit', digit: '5' }), 'c')!) as {
      dtmf: { digit: string };
    };
    assert.equal(digit.dtmf.digit, '5');

    const hangup = JSON.parse(normaliseGatewayEvent(JSON.stringify({ event: 'hangup', callId: 'gw-9' }), 'gw-1')!) as {
      stop: { callSid: string };
    };
    assert.equal(hangup.stop.callSid, 'gw-9');
  });

  test('unusable frames are ignored, never thrown', () => {
    assert.equal(normaliseGatewayEvent('not json', 'c'), null);
    assert.equal(normaliseGatewayEvent('null', 'c'), null);
    assert.equal(normaliseGatewayEvent(JSON.stringify({ nope: 1 }), 'c'), null, 'an event field is required');
    assert.equal(normaliseGatewayEvent(JSON.stringify({ event: 'mystery' }), 'c'), null, 'unknown events are dropped');
    assert.equal(normaliseGatewayEvent(JSON.stringify({ event: 'media', payload: '' }), 'c'), null, 'empty media dropped');
    assert.equal(normaliseGatewayEvent(JSON.stringify({ event: 'dtmf' }), 'c'), null, 'digit-less dtmf dropped');
    // Handshake/marker frames stay recognised so the session can ignore them.
    assert.ok(normaliseGatewayEvent(JSON.stringify({ event: 'mark', mark: { name: 'x' } }), 'c'));
  });
});

describe('cloudyvoice gateway integration', () => {
  let server: TestServer;
  let db: DB;

  before(async () => {
    server = await startTestServer(GATEWAY_ENV);
    db = server.db;
  });
  after(async () => server.close());

  test('the registry selects gateway webhook URLs and originate posts our control request', async () => {
    const cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(64, '0'), DATABASE_PATH: ':memory:', ...GATEWAY_ENV });
    const sent: { url: string; init: RequestInit }[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      sent.push({ url, init });
      return new Response(JSON.stringify({ callId: 'gw-call-orig-1', status: 'queued' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const reg = buildRegistry(cfg, { ...GATEWAY_ENV }, { fetchImpl });

    assert.equal(reg.voiceAnswerUrl, 'https://gw.example.com/api/webhooks/telephony/gateway/answer');
    assert.equal(reg.voiceStatusUrl, 'https://gw.example.com/api/webhooks/telephony/gateway/events');
    assert.ok(reg.telephony, 'the gateway telephony port must resolve');

    const res = await reg.telephony!.createCall({
      to: '+923001110001',
      answerUrl: reg.voiceAnswerUrl!,
      statusCallbackUrl: reg.voiceStatusUrl!,
      metadata: { businessId: 'biz1', attemptId: 'att1' },
    });

    assert.equal(res.providerCallId, 'gw-call-orig-1');
    assert.equal(sent.length, 1);
    assert.equal(sent[0]!.url, 'http://127.0.0.1:8089/v1/calls');
    const headers = (sent[0]!.init.headers ?? {}) as Record<string, string>;
    assert.equal(headers['authorization'], `Bearer ${GW_TOKEN}`);
    const body = JSON.parse(String(sent[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body['answerUrl'], 'https://gw.example.com/api/webhooks/telephony/gateway/answer');
    assert.equal(body['statusCallbackUrl'], 'https://gw.example.com/api/webhooks/telephony/gateway/events');
    assert.equal(body['record'], undefined, 'recording is never requested');
  });

  test('the answer route bridges an attributable call and hangs up an unknown one', async () => {
    const lead = createLead(db, { displayName: 'Gateway Traders', city: 'Karachi', phone: '+923007654321' }, owner);
    insertCall(db, 'cal_gw_main', lead.id, 'gw-call-ans-1');

    const ok = await server.client().request<{
      action: string;
      mediaUrl: string;
      greeting: string;
      mediaFormat: { encoding: string; sampleRate: number };
    }>(`${ANSWER_PATH}?callId=gw-call-ans-1&from=%2B923007654321`, {
      method: 'GET',
      headers: { authorization: `Bearer ${GW_TOKEN}` },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.action, 'bridge');
    assert.ok(ok.body.greeting.startsWith(AI_DISCLOSURE), 'the disclosure still leads the greeting');
    assert.equal(ok.body.mediaFormat.encoding, 'audio/x-mulaw');
    assert.equal(ok.body.mediaFormat.sampleRate, 8000);
    assert.ok(
      ok.body.mediaUrl.startsWith(`wss://gw.example.com${GATEWAY_MEDIA_PATH}?callSid=`),
      `gateway media URL, got ${ok.body.mediaUrl}`,
    );

    // An unknown caller gets the fixed approved greeting, never a stream.
    const unknown = await server.client().request<{ action: string; greeting: string; mediaUrl?: string }>(
      `${ANSWER_PATH}?callId=gw-call-unknown-1&from=%2B923000000000`,
      { method: 'GET', headers: { authorization: `Bearer ${GW_TOKEN}` } },
    );
    assert.equal(unknown.status, 200);
    assert.equal(unknown.body.action, 'hangup');
    assert.ok(unknown.body.greeting.includes(AI_DISCLOSURE));
    assert.equal(unknown.body.mediaUrl, undefined, 'no stream is offered to an unattributable call');
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM calls WHERE provider_call_id = 'gw-call-unknown-1'").get() as { c: number }).c,
      0,
      'an unattributable answer creates no ledger row',
    );
  });

  test('an inbound gateway caller on file gets a ledger row labelled cloudyvoice', async () => {
    const inbound = '+923009998877';
    createLead(db, { displayName: 'Inbound Gateway Ltd', city: 'Lahore', phone: inbound }, owner);
    const res = await server.client().request<{ action: string }>(
      `${ANSWER_PATH}?callId=gw-inbound-1&from=${encodeURIComponent(inbound)}&to=%2B922111111111`,
      { method: 'GET', headers: { authorization: `Bearer ${GW_TOKEN}` } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.action, 'bridge');
    const row = db
      .prepare('SELECT business_id, provider, direction, recording_enabled FROM calls WHERE provider_call_id = ?')
      .get('gw-inbound-1') as { business_id: string; provider: string; direction: string; recording_enabled: number };
    assert.equal(row.direction, 'inbound');
    assert.equal(row.provider, 'cloudyvoice', 'the ledger records who actually carried the call');
    assert.equal(row.recording_enabled, 0, 'never recorded without consent');
  });

  test('the answer route refuses anyone without the gateway bearer token', async () => {
    const attempts: Record<string, string>[] = [
      {},
      { authorization: 'Bearer wrong-token' },
      { authorization: GW_TOKEN },
    ];
    for (const headers of attempts) {
      const res = await server.client().request<{ action?: string }>(`${ANSWER_PATH}?callId=gw-call-ans-1`, {
        method: 'GET',
        headers,
      });
      assert.equal(res.status, 401, `headers ${JSON.stringify(headers)} must be refused`);
      // The scheme is part of the secret comparison, so a bare token fails too.
      assert.ok(!res.body.action, 'no instruction is rendered for an unauthenticated caller');
    }
  });

  test('a SIP call runs the full conversation over the gateway dialect', async () => {
    const token = mintStreamToken(server.config.sessionSecret, 'gw-call-ans-1');
    const wsUrl = `ws://127.0.0.1:${portOf(server.url)}${GATEWAY_MEDIA_PATH}?callSid=gw-call-ans-1&token=${encodeURIComponent(token)}`;
    const ws = await connect(wsUrl);
    const received: { event: string; media?: { payload?: string } }[] = [];
    ws.on('message', (data) => received.push(JSON.parse(data.toString()) as { event: string; media?: { payload?: string } }));

    // Gateway dialect: 'open' + callId, then 'audio' with a TOP-LEVEL payload.
    ws.send(JSON.stringify({ event: 'open', callId: 'gw-call-ans-1', mediaFormat: { encoding: 'pcmu', sampleRate: 8000 } }));
    for (let i = 0; i < 20; i++) ws.send(JSON.stringify({ event: 'audio', payload: speechFrame().toString('base64') }));
    for (let i = 0; i < 35 && received.filter((m) => m.event === 'media').length === 0; i++) {
      ws.send(JSON.stringify({ event: 'audio', payload: silenceFrame().toString('base64') }));
      await sleep(5);
    }
    await waitFor(() => received.some((m) => m.event === 'media'), 'the agent audio frames to come back');

    const conversation = db
      .prepare('SELECT id, business_id, ended_at, transcript_state FROM conversations WHERE call_id = ?')
      .get('cal_gw_main') as { id: string; business_id: string; ended_at: string | null; transcript_state: string } | undefined;
    assert.ok(conversation, 'the gateway stream must open the SAME conversation lifecycle');
    assert.equal(conversation.ended_at, null);

    const segments = db
      .prepare('SELECT speaker, text, source FROM transcript_segments WHERE conversation_id = ? ORDER BY seq')
      .all(conversation.id) as unknown as { speaker: string; text: string; source: string }[];
    const prospect = segments.find((s) => s.speaker === 'prospect');
    assert.ok(prospect, 'the utterance must be on the transcript');
    assert.equal(prospect.source, 'stt', 'SIP audio is transcribed, not typed');
    assert.ok(segments.some((s) => s.speaker === 'agent'), 'the engine must have replied');

    const payloads = received.filter((m) => m.event === 'media').map((m) => m.media?.payload ?? '');
    const decoded = Buffer.concat(payloads.map((p) => Buffer.from(p, 'base64')));
    assert.ok(decoded.byteLength >= 160 && decoded.byteLength % 160 === 0, 'whole mu-law frames only');

    // DTMF in the gateway dialect lands as transcript evidence.
    ws.send(JSON.stringify({ event: 'digit', digit: '2' }));
    await waitFor(
      () =>
        (
          db.prepare('SELECT COUNT(*) c FROM transcript_segments WHERE conversation_id = ? AND text LIKE ?').get(
            conversation.id,
            '%DTMF 2%',
          ) as { c: number }
        ).c > 0,
      'the DTMF digit to reach the transcript',
    );

    ws.send(JSON.stringify({ event: 'hangup', callId: 'gw-call-ans-1' }));
    await waitFor(
      () =>
        (
          ((db.prepare('SELECT ended_at FROM conversations WHERE id = ?').get(conversation.id) ?? null) as
            | { ended_at: string | null }
            | null)?.ended_at ?? null
        ) !== null,
      'the conversation to finish on gateway hangup',
    );

    const finished = db
      .prepare('SELECT transcript_state, extracted_json FROM conversations WHERE id = ?')
      .get(conversation.id) as { transcript_state: string; extracted_json: string };
    assert.equal(finished.transcript_state, 'complete');
    assert.ok(JSON.parse(finished.extracted_json).qualification, 'qualification is extracted on SIP calls too');

    const call = db.prepare('SELECT recording_enabled, recording_consent FROM calls WHERE id = ?').get('cal_gw_main') as {
      recording_enabled: number;
      recording_consent: number;
    };
    assert.equal(call.recording_enabled, 0, 'the bridge never enables recording');
    assert.equal(call.recording_consent, 0);

    await new Promise<void>((resolve) => {
      if (ws.readyState === WebSocket.CLOSED) resolve();
      else {
        ws.once('close', () => resolve());
        ws.close();
      }
    });
  });

  test('signed lifecycle events apply, replay as duplicates and refuse tampering', async () => {
    const client = server.client();
    const post = (raw: string, signature: string | null): Promise<{ status: number }> =>
      client.request(EVENTS_PATH, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(signature ? { 'x-uws-gateway-signature': signature } : {}),
        },
        rawBody: raw,
      });

    const answeredRaw = JSON.stringify({
      eventId: 'ev-gw-1',
      callId: 'gw-call-ans-1',
      status: 'answered',
      timestamp: '2026-11-03T10:00:00Z',
    });
    const okRes = await post(answeredRaw, sign(answeredRaw));
    assert.equal(okRes.status, 204, `expected 204, got ${okRes.status}`);

    const afterAnswer = db.prepare('SELECT status, answered_at FROM calls WHERE id = ?').get('cal_gw_main') as {
      status: string;
      answered_at: string | null;
    };
    assert.equal(afterAnswer.status, 'in_progress');
    assert.ok(afterAnswer.answered_at, 'answering stamps answered_at');

    // A replay with the same eventId changes nothing (idempotent by design).
    await post(answeredRaw, sign(answeredRaw));
    const dup = db
      .prepare("SELECT COUNT(*) c, MAX(duplicate_count) d FROM provider_events WHERE provider = 'cloudyvoice' AND event_id = 'ev-gw-1'")
      .get() as { c: number; d: number };
    assert.equal(dup.c, 1, 'exactly one event row exists');
    assert.equal(dup.d, 1, 'the replay only bumped the duplicate counter');

    // Terminal event carrying a SIP release cause -> duration-derived outcome.
    const completedRaw = JSON.stringify({
      eventId: 'ev-gw-2',
      callId: 'gw-call-ans-1',
      sipCause: 16,
      durationSeconds: 42,
    });
    await post(completedRaw, sign(completedRaw));
    const done = db.prepare('SELECT status, outcome, duration_seconds, ended_at FROM calls WHERE id = ?').get('cal_gw_main') as {
      status: string;
      outcome: string;
      duration_seconds: number;
      ended_at: string | null;
    };
    assert.equal(done.status, 'completed');
    assert.equal(done.outcome, 'answered', 'a normal clearing after 42s IS an answered call');
    assert.equal(done.duration_seconds, 42);
    assert.ok(done.ended_at);

    // A tampered signature is refused and the ledger is untouched.
    const before = (db.prepare('SELECT status FROM calls WHERE id = ?').get('cal_gw_main') as { status: string }).status;
    const tamperedRaw = JSON.stringify({ eventId: 'ev-gw-3', callId: 'gw-call-ans-1', status: 'failed' });
    const badSig = sign(tamperedRaw).replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    const refused = await post(tamperedRaw, badSig);
    assert.equal(refused.status, 401);
    assert.equal(
      (db.prepare('SELECT status FROM calls WHERE id = ?').get('cal_gw_main') as { status: string }).status,
      before,
      'a refused event must not touch the ledger',
    );
    assert.equal(
      (db.prepare("SELECT COUNT(*) c FROM provider_events WHERE provider = 'cloudyvoice' AND event_id = 'ev-gw-3'").get() as { c: number }).c,
      0,
      'an unauthenticated payload is never even recorded',
    );

    // No signature at all is refused too.
    const unsigned = await post(JSON.stringify({ eventId: 'ev-gw-4', callId: 'gw-call-ans-1', status: 'failed' }), null);
    assert.equal(unsigned.status, 401);
  });

  test('an unattributable lifecycle event is recorded but applied to nothing', async () => {
    const raw = JSON.stringify({ eventId: 'ev-gw-orphan', callId: 'gw-never-existed', status: 'completed' });
    const res = await server.client().request(EVENTS_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-uws-gateway-signature': sign(raw) },
      rawBody: raw,
    });
    assert.equal(res.status, 204, 'an authentic event must never trigger gateway retries');
    const row = db
      .prepare("SELECT process_result FROM provider_events WHERE provider = 'cloudyvoice' AND event_id = 'ev-gw-orphan'")
      .get() as { process_result: string } | undefined;
    assert.ok(row);
    assert.ok(row.process_result.startsWith('ignored'), `expected ignored, got ${row.process_result}`);
  });

  test('the gateway media upgrade is gated exactly like the Twilio bridge', async () => {
    const badToken = `ws://127.0.0.1:${portOf(server.url)}${GATEWAY_MEDIA_PATH}?callSid=gw-call-ans-1&token=1.forged`;
    await expectUpgradeFailure(badToken, 401, 'forged gateway token');

    const unknownCall = `ws://127.0.0.1:${portOf(server.url)}${GATEWAY_MEDIA_PATH}?callSid=gw-never-placed&token=${encodeURIComponent(
      mintStreamToken(server.config.sessionSecret, 'gw-never-placed'),
    )}`;
    await expectUpgradeFailure(unknownCall, 404, 'unknown gateway call');

    const noToken = `ws://127.0.0.1:${portOf(server.url)}${GATEWAY_MEDIA_PATH}?callSid=gw-call-ans-1`;
    await expectUpgradeFailure(noToken, 401, 'missing gateway token');
  });

  test('two bridges share one server and an unknown path still 404s', async () => {
    // /api/media is claimed by the TWILIO bridge: a bad token there is a 401
    // from that bridge, not the fallback's 404 — proving both paths are routed.
    await expectUpgradeFailure(
      `ws://127.0.0.1:${portOf(server.url)}/api/media?callSid=gw-call-ans-1&token=1.forged`,
      401,
      'twilio path still claims its own upgrades',
    );
    // The gateway path likewise answers its own upgrades (401, not 404).
    await expectUpgradeFailure(
      `ws://127.0.0.1:${portOf(server.url)}${GATEWAY_MEDIA_PATH}?callSid=gw-call-ans-1&token=1.forged`,
      401,
      'gateway path still claims its own upgrades',
    );
    // An unclaimed path is closed by the fallback listener rather than hanging.
    await expectUpgradeFailure(`ws://127.0.0.1:${portOf(server.url)}/api/nope`, 404, 'unknown upgrade path');
  });

  test('the Twilio answer route is untouched and still signature-gated', async () => {
    const res = await server.client().request('/api/webhooks/telephony/twilio/voice?CallSid=CAX1', { method: 'GET' });
    assert.equal(res.status, 401, 'Twilio answer URL still demands an X-Twilio-Signature');
  });
});
