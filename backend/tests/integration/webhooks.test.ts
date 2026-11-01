/**
 * Phase 7 integration tests: provider webhooks.
 *
 * These are the only unauthenticated POST endpoints in the app, so the tests
 * focus on what keeps them safe:
 *  - every callback is SIGNATURE verified (Meta HMAC over the raw bytes, Twilio
 *    HMAC over URL + sorted params); a bad signature is 401 and touches nothing
 *  - ingestion is idempotent: a replayed webhook updates nothing twice and is
 *    counted in provider_events.duplicate_count
 *  - an inbound WhatsApp STOP suppresses the lead IMMEDIATELY (append-only)
 *  - unconfigured instances advertise nothing: webhooks 404 when the matching
 *    integration is absent
 *  - the TwiML answer endpoint serves the mandated AI disclosure only to
 *    correctly signed requests
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { startTestServer, seedOwner, loginAs, type TestServer } from '../helpers/app.ts';
import { createLead } from '../../src/domain/leads/repository.ts';
import { nowIso } from '../../src/core/time.ts';
import type { DB } from '../../src/db/index.ts';

const TWILIO_TOKEN = 'twilio-test-token';
const META_SECRET = 'meta-app-secret';

const PROVIDER_ENV = {
  TELEPHONY_PROVIDER: 'twilio',
  TELEPHONY_ACCOUNT_SID: 'ACtest',
  TELEPHONY_AUTH_TOKEN: TWILIO_TOKEN,
  TELEPHONY_FROM_NUMBER: '+922111111111',
  WHATSAPP_PROVIDER: 'whatsapp_cloud',
  WHATSAPP_PHONE_NUMBER_ID: '112233',
  WHATSAPP_ACCESS_TOKEN: 'wa-test-token',
  WHATSAPP_APP_SECRET: META_SECRET,
  WHATSAPP_WEBHOOK_VERIFY_TOKEN: 'owner-verify-token',
  WHATSAPP_TEMPLATE_NAME_PORTFOLIO: 'portfolio_v1',
};

function metaSig(raw: string): string {
  return `sha256=${createHmac('sha256', META_SECRET).update(raw).digest('hex')}`;
}

function twilioSig(url: string, params: Record<string, string>): string {
  const concat = Object.keys(params)
    .sort()
    .map((k) => k + params[k])
    .join('');
  return createHmac('sha1', TWILIO_TOKEN).update(url + concat).digest('base64');
}

let server: TestServer;
let db: DB;

const owner = { userId: null, label: 'owner' as const };

let seq = 0;
function makeLead(phone: string): string {
  const n = seq++;
  return createLead(db, { displayName: `Webhook Co ${n}`, city: 'Lahore', phone }, owner).id;
}

function insertMessage(id: string, bizId: string, providerMessageId: string, status: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO messages (id, attempt_id, business_id, channel, provider, provider_message_id, template_key,
       purpose, number_used, number_source, body_preview, status, status_source, simulation,
       counts_against_daily_limit, daily_bucket, cost_state, sent_at, created_at, updated_at)
     VALUES (?, NULL, ?, 'whatsapp_message', 'whatsapp_cloud', ?, 'portfolio_v1', 'portfolio_share',
       '+923000000000', 'provided_by_prospect', '[template:portfolio_v1]', ?, 'none', 0, 1, '2026-10-29',
       'unavailable', ?, ?, ?)`,
  ).run(id, bizId, providerMessageId, status, at, at, at);
}

function insertCall(id: string, bizId: string, providerCallId: string, status: string): void {
  const at = nowIso();
  db.prepare(
    `INSERT INTO calls (id, attempt_id, business_id, direction, channel, provider, provider_call_id, status,
       outcome, to_number_e164, recording_enabled, recording_consent, simulation, counts_against_daily_limit,
       daily_bucket, cost_state, created_at, updated_at)
     VALUES (?, NULL, ?, 'outbound', 'call', 'twilio', ?, ?, 'unknown', '+923000000000', 0, 0, 0, 1,
       '2026-10-29', 'unavailable', ?, ?)`,
  ).run(id, bizId, providerCallId, status, at, at);
}

function eventCount(dbx: DB): number {
  return (dbx.prepare('SELECT COUNT(*) c FROM provider_events').get() as { c: number }).c;
}

describe('provider webhooks', () => {
  before(async () => {
    server = await startTestServer(PROVIDER_ENV);
    db = server.db;
  });
  after(async () => server.close());

  test('meta subscription challenge echoes the challenge for the right token only', async () => {
    const client = server.client();
    const ok = await client.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=owner-verify-token&hub.challenge=12345');
    assert.equal(ok.status, 200);
    assert.equal(ok.raw, '12345');

    const bad = await client.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345');
    assert.equal(bad.status, 403);

    const wrongMode = await client.get('/api/webhooks/whatsapp?hub.mode=unsubscribe&hub.verify_token=owner-verify-token&hub.challenge=12345');
    assert.equal(wrongMode.status, 403);
  });

  test('a signed delivery receipt updates the message and is idempotent on replay', async () => {
    const biz = makeLead('03007650001');
    insertMessage('msg_hook_1', biz, 'wamid.DELIV1', 'sent');
    const before = eventCount(db);

    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                statuses: [{ id: 'wamid.DELIV1', status: 'delivered', timestamp: '1730000100', recipient_id: '923007650001' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const client = server.client();
    const res = await client.request('/api/webhooks/whatsapp', {
      method: 'POST',
      rawBody: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSig(raw) },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { received: true, applied: 1, ignored: 0, duplicate: 0 });

    const row = db.prepare('SELECT status, status_source, last_status_at FROM messages WHERE id = ?').get('msg_hook_1') as {
      status: string;
      status_source: string;
      last_status_at: string | null;
    };
    assert.equal(row.status, 'delivered');
    assert.equal(row.status_source, 'provider_event');
    assert.ok(row.last_status_at);
    assert.equal(eventCount(db), before + 1);

    // Replay: same bytes, same signature — nothing changes twice.
    const replay = await client.request('/api/webhooks/whatsapp', {
      method: 'POST',
      rawBody: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSig(raw) },
    });
    assert.equal(replay.status, 200);
    assert.deepEqual(replay.body, { received: true, applied: 0, ignored: 0, duplicate: 1 });
    const dupes = db.prepare('SELECT duplicate_count FROM provider_events WHERE provider = ? AND event_id = ?').get(
      'whatsapp_cloud',
      'wamid.DELIV1:delivered:1730000100',
    ) as { duplicate_count: number };
    assert.equal(dupes.duplicate_count, 1);
  });

  test('an inbound STOP suppresses the lead immediately and records the reply', async () => {
    const biz = makeLead('03007650002');
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ id: 'wamid.STOP1', from: '923007650002', type: 'text', text: { body: 'STOP' }, timestamp: '1730000200' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const client = server.client();
    const res = await client.request('/api/webhooks/whatsapp', {
      method: 'POST',
      rawBody: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSig(raw) },
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { applied: number }).applied, 1);

    const sup = db
      .prepare(`SELECT scope, reason, source, permanent, evidence FROM suppression_list WHERE business_id = ?`)
      .get(biz) as { scope: string; reason: string; source: string; permanent: number; evidence: string };
    assert.equal(sup.reason, 'opt_out');
    assert.equal(sup.scope, 'business');
    assert.equal(sup.permanent, 1);
    assert.ok(sup.evidence.includes('wamid.STOP1'));

    const inter = db
      .prepare(
        `SELECT direction, summary, simulation FROM interactions WHERE business_id = ? AND kind = 'whatsapp_message' ORDER BY rowid DESC LIMIT 1`,
      )
      .get(biz) as { direction: string; summary: string; simulation: number };
    assert.equal(inter.direction, 'inbound');
    assert.equal(inter.simulation, 0, 'a real inbound reply is real contact');
    assert.ok(inter.summary.includes('OPT-OUT'));
  });

  test('an inbound non-opt-out reply is recorded without suppressing', async () => {
    const biz = makeLead('03007650003');
    const payload = {
      entry: [
        {
          changes: [
            {
              value: {
                messages: [{ id: 'wamid.REPLY1', from: '923007650003', type: 'text', text: { body: 'Yes, send me details' }, timestamp: '1730000300' }],
              },
              field: 'messages',
            },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const client = server.client();
    const res = await client.request('/api/webhooks/whatsapp', {
      method: 'POST',
      rawBody: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSig(raw) },
    });
    assert.equal(res.status, 200);

    const sup = db.prepare('SELECT id FROM suppression_list WHERE business_id = ?').get(biz);
    assert.equal(sup, undefined, 'a friendly reply must not suppress');
    const inter = db
      .prepare(`SELECT summary FROM interactions WHERE business_id = ? AND kind = 'whatsapp_message'`)
      .get(biz) as { summary: string };
    assert.ok(inter.summary.includes('Yes, send me details'));
  });

  test('an inbound message from an unknown sender is ignored, not guessed at', async () => {
    const payload = {
      entry: [
        {
          changes: [
            { value: { messages: [{ id: 'wamid.UNKNOWN1', from: '923009999999', type: 'text', text: { body: 'hello' } }] }, field: 'messages' },
          ],
        },
      ],
    };
    const raw = JSON.stringify(payload);
    const client = server.client();
    const res = await client.request('/api/webhooks/whatsapp', {
      method: 'POST',
      rawBody: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': metaSig(raw) },
    });
    assert.equal(res.status, 200);
    assert.equal((res.body as { ignored: number }).ignored, 1);
    const sup = db.prepare(`SELECT id FROM suppression_list WHERE whatsapp_e164 = '+923009999999'`).get();
    assert.equal(sup, undefined);
  });

  test('an invalid signature is 401 and the payload is never touched', async () => {
    const biz = makeLead('03007650004');
    insertMessage('msg_hook_bad', biz, 'wamid.BAD1', 'sent');
    const before = eventCount(db);
    const raw = JSON.stringify({
      entry: [{ changes: [{ value: { statuses: [{ id: 'wamid.BAD1', status: 'read', timestamp: '1730000400' }] } }] }],
    });
    const client = server.client();
    const res = await client.request('/api/webhooks/whatsapp', {
      method: 'POST',
      rawBody: raw,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=deadbeef' },
    });
    assert.equal(res.status, 401);
    assert.equal(eventCount(db), before, 'an unverified payload must never reach the database');
    const row = db.prepare('SELECT status FROM messages WHERE id = ?').get('msg_hook_bad') as { status: string };
    assert.equal(row.status, 'sent');
  });

  test('a signed Twilio status callback advances the call row', async () => {
    const biz = makeLead('03007650005');
    insertCall('cal_hook_1', biz, 'CA77', 'ringing');
    const params = {
      CallSid: 'CA77',
      CallStatus: 'completed',
      CallDuration: '42',
      Timestamp: '1730000500',
      To: '+923007650005',
      From: '+922111111111',
    };
    const url = `${server.url}/api/webhooks/telephony/twilio`;
    const client = server.client();
    const body = new URLSearchParams(params).toString();
    const res = await client.request('/api/webhooks/telephony/twilio', {
      method: 'POST',
      rawBody: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSig(url, params) },
    });
    assert.equal(res.status, 204);

    const row = db.prepare('SELECT status, outcome, duration_seconds, ended_at FROM calls WHERE id = ?').get('cal_hook_1') as {
      status: string;
      outcome: string;
      duration_seconds: number;
      ended_at: string | null;
    };
    assert.equal(row.status, 'completed');
    assert.equal(row.outcome, 'answered', 'a 42-second completed call was answered');
    assert.equal(row.duration_seconds, 42);
    assert.ok(row.ended_at);
  });

  test('an unknown CallSid is acknowledged but ignored; a bad signature is 401', async () => {
    const params = { CallSid: 'CAGHOST', CallStatus: 'completed', Timestamp: '1730000600' };
    const url = `${server.url}/api/webhooks/telephony/twilio`;
    const client = server.client();
    const body = new URLSearchParams(params).toString();
    const res = await client.request('/api/webhooks/telephony/twilio', {
      method: 'POST',
      rawBody: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSig(url, params) },
    });
    assert.equal(res.status, 204, 'a valid-but-unmatched event must not trigger provider retries');

    const bad = await client.request('/api/webhooks/telephony/twilio', {
      method: 'POST',
      rawBody: body,
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'Zm9yZ2Vk' },
    });
    assert.equal(bad.status, 401);
  });

  test('the TwiML answer URL serves the AI disclosure only to signed requests', async () => {
    const url = `${server.url}/api/webhooks/telephony/twilio/voice`;
    const client = server.client();
    const ok = await client.request('/api/webhooks/telephony/twilio/voice', {
      method: 'GET',
      headers: { 'x-twilio-signature': twilioSig(url, {}) },
    });
    assert.equal(ok.status, 200);
    assert.ok((ok.headers.get('content-type') ?? '').includes('application/xml'));
    assert.ok(ok.raw.includes('artificial intelligence'), 'the disclosure must be in the greeting');
    assert.ok(ok.raw.includes('<Hangup/>'));
    assert.ok(!ok.raw.includes('<Record'), 'recording requires consent and is never enabled by default');

    const bad = await client.request('/api/webhooks/telephony/twilio/voice', {
      method: 'GET',
      headers: { 'x-twilio-signature': 'Zm9yZ2Vk' },
    });
    assert.equal(bad.status, 401);
  });

  test('the integrations status endpoint requires auth and leaks no secrets', async () => {
    const anon = server.client();
    const denied = await anon.get('/api/integrations');
    assert.equal(denied.status, 401);

    const ownerAcct = await seedOwner(server);
    const client = await loginAs(server, ownerAcct.email, ownerAcct.password);
    const res = await client.get<{ adapters: { key: string; state: string; lastError: string | null }[] }>('/api/integrations');
    assert.equal(res.status, 200);
    const telephony = res.body.adapters.find((a) => a.key === 'telephony');
    assert.equal(telephony?.state, 'configured');
    const discovery = res.body.adapters.find((a) => a.key === 'discovery');
    assert.equal(discovery?.state, 'unconfigured', 'no discovery vendor is chosen yet and the page must say so');
    const serialized = JSON.stringify(res.body);
    assert.ok(!serialized.includes('twilio-test-token'), 'tokens must never appear in API responses');
    assert.ok(!serialized.includes('wa-test-token'));
    assert.ok(!serialized.includes('meta-app-secret'));
  });
});

describe('webhooks when nothing is configured', () => {
  let bare: TestServer;
  before(async () => {
    bare = await startTestServer(); // no provider env at all
  });
  after(async () => bare.close());

  test('every webhook endpoint 404s — an unconfigured instance advertises nothing', async () => {
    const client = bare.client();
    const challenge = await client.get('/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=x&hub.challenge=1');
    assert.equal(challenge.status, 404);
    const post = await client.request('/api/webhooks/whatsapp', { method: 'POST', rawBody: '{}', headers: { 'content-type': 'application/json' } });
    assert.equal(post.status, 404);
    const voice = await client.get('/api/webhooks/telephony/twilio/voice');
    assert.equal(voice.status, 404);
  });
});
