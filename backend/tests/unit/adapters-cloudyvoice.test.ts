/**
 * CloudyVoice SIP gateway adapter unit tests.
 *
 * Everything runs through an INJECTED fetch, so the real request construction
 * (URL, bearer auth, JSON body shape), the error mapping and the registry's
 * webhook selection are verified without any network access — a unit test can
 * never reach a gateway (or a carrier) by accident.
 *
 * Safety properties under test:
 *  - the gateway token never appears in thrown errors or status payloads;
 *  - an incomplete/malformed gateway config yields `null` (unconfigured),
 *    never a dial attempt;
 *  - TWILIO behaviour is untouched: its URLs, secrets and dispatch are
 *    byte-identical whether or not the gateway code exists;
 *  - gateway webhook verification refuses everything when the gateway provider
 *    is not the selected one (a Twilio-mode instance accepts no gateway traffic).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';
import { createCloudyVoiceAdapter } from '../../src/adapters/telephony/cloudyvoice.ts';
import { createTelephonyAdapter, gatewayEnvFrom, SUPPORTED_TELEPHONY_PROVIDERS } from '../../src/adapters/telephony/index.ts';
import { buildRegistry } from '../../src/adapters/registry.ts';
import { loadConfig } from '../../src/core/config.ts';
import {
  GATEWAY_CALL_STATUS,
  sipCauseToStatus,
} from '../../src/domain/outreach/gatewayevents.ts';

function fakeFetch(
  reply: { status?: number; body?: unknown },
): { fetchImpl: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply.body ?? {}), {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function bearer(init: RequestInit): string {
  const h = (init.headers ?? {}) as Record<string, string>;
  return h['authorization'] ?? '';
}

const GW = {
  baseUrl: 'http://127.0.0.1:8089',
  apiToken: 'gw-control-token',
  fromNumber: '+922111111111',
};

const cfg = () =>
  loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(64, '0'), DATABASE_PATH: ':memory:' });

describe('cloudyvoice adapter (gateway control API)', () => {
  test('createCall posts our documented JSON control request with a bearer token', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { callId: 'gw-call-1', status: 'queued' } });
    const gw = createCloudyVoiceAdapter({ ...GW, fetchImpl });

    const res = await gw.createCall({
      to: '+923001234567',
      answerUrl: 'https://uws.example/api/webhooks/telephony/gateway/answer',
      statusCallbackUrl: 'https://uws.example/api/webhooks/telephony/gateway/events',
      metadata: { businessId: 'biz1', attemptId: 'att1' },
    });

    assert.equal(res.providerCallId, 'gw-call-1');
    assert.equal(res.status, 'queued');
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:8089/v1/calls');
    assert.equal(bearer(calls[0]!.init), 'Bearer gw-control-token');

    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body['to'], '+923001234567');
    assert.equal(body['from'], '+922111111111');
    assert.equal(body['answerUrl'], 'https://uws.example/api/webhooks/telephony/gateway/answer');
    assert.equal(body['statusCallbackUrl'], 'https://uws.example/api/webhooks/telephony/gateway/events');
    const meta = body['metadata'] as { businessId: string; attemptId: string };
    assert.equal(meta.businessId, 'biz1');
    assert.equal(meta.attemptId, 'att1');
    // Never request a recording: consent is the domain's decision alone.
    assert.equal(body['record'], undefined);
  });

  test('gateway auth failures map to provider_error and never leak the token', async () => {
    const { fetchImpl } = fakeFetch({ status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } });
    const gw = createCloudyVoiceAdapter({ ...GW, fetchImpl });
    await assert.rejects(
      () =>
        gw.createCall({
          to: '+1',
          answerUrl: 'https://x/answer',
          statusCallbackUrl: 'https://x/events',
          metadata: { businessId: 'b', attemptId: 'a' },
        }),
      (err: unknown) => {
        assert.ok(err instanceof AdapterError);
        assert.equal(err.code, 'provider_error');
        assert.ok(!err.message.includes('gw-control-token'), 'error text must never contain the gateway token');
        return true;
      },
    );
    assert.equal(gw.status().state, 'error', 'the failure is reported honestly');
  });

  test('invalid destination and rate limit keep their own semantics', async () => {
    const bad = fakeFetch({ status: 400, body: { error: { code: 'invalid_destination' } } });
    const gw = createCloudyVoiceAdapter({ ...GW, fetchImpl: bad.fetchImpl });
    await assert.rejects(
      () =>
        gw.createCall({
          to: 'x',
          answerUrl: 'https://x/a',
          statusCallbackUrl: 'https://x/e',
          metadata: { businessId: 'b', attemptId: 'a' },
        }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );

    const limited = fakeFetch({ status: 429, body: { message: 'slow down' } });
    const gw2 = createCloudyVoiceAdapter({ ...GW, fetchImpl: limited.fetchImpl });
    await assert.rejects(
      () =>
        gw2.createCall({
          to: 'x',
          answerUrl: 'https://x/a',
          statusCallbackUrl: 'https://x/e',
          metadata: { businessId: 'b', attemptId: 'a' },
        }),
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited' && err.retryable === true,
    );
  });

  test('a call accepted without a call id is a provider_error, not a silent success', async () => {
    const { fetchImpl } = fakeFetch({ body: { status: 'queued' } });
    const gw = createCloudyVoiceAdapter({ ...GW, fetchImpl });
    await assert.rejects(
      () =>
        gw.createCall({
          to: '+923001110001',
          answerUrl: 'https://x/a',
          statusCallbackUrl: 'https://x/e',
          metadata: { businessId: 'b', attemptId: 'a' },
        }),
      (err: unknown) => err instanceof AdapterError && err.code === 'provider_error',
    );
  });

  test('ping is a FREE health fetch that never originates a call', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { ok: true, sip: { registered: true } } });
    const gw = createCloudyVoiceAdapter({ ...GW, fetchImpl });
    const res = await gw.ping!();
    assert.equal(res.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'http://127.0.0.1:8089/v1/health');
    assert.equal(calls[0]!.init.method, 'GET');
    assert.equal(bearer(calls[0]!.init), 'Bearer gw-control-token');
    assert.ok(res.detail?.includes('registered'));
    assert.ok(res.detail?.includes('no call placed'));
    assert.ok(!res.detail?.includes('gw-control-token'), 'the probe detail must never carry the token');
    assert.equal(gw.status().state, 'configured');
  });

  test('an unreachable gateway fails honestly instead of reporting verified', async () => {
    const failing: FetchLike = () => Promise.reject(new TypeError('fetch failed'));
    const gw = createCloudyVoiceAdapter({ ...GW, fetchImpl: failing });
    const res = await gw.ping!();
    assert.equal(res.ok, false);
    assert.equal(gw.status().state, 'error');
    assert.ok(!String(gw.status().lastError).includes('gw-control-token'));
  });

  test('status is unconfigured when any control setting is absent', () => {
    assert.equal(createCloudyVoiceAdapter({ baseUrl: '', apiToken: 't', fromNumber: '+1' }).status().state, 'unconfigured');
    assert.equal(createCloudyVoiceAdapter({ baseUrl: 'http://x', apiToken: '', fromNumber: '+1' }).status().state, 'unconfigured');
    assert.equal(createCloudyVoiceAdapter({ baseUrl: 'http://x', apiToken: 't', fromNumber: '' }).status().state, 'unconfigured');
    assert.equal(createCloudyVoiceAdapter(GW).status().implementation, 'cloudyvoice');
  });
});

describe('telephony dispatch (twilio preserved, cloudyvoice added)', () => {
  test('cloudyvoice resolves only with a complete gateway control config', () => {
    assert.equal(createTelephonyAdapter({ TELEPHONY_PROVIDER: 'cloudyvoice' }), null, 'no gateway URL -> unconfigured');
    assert.equal(
      createTelephonyAdapter({ TELEPHONY_PROVIDER: 'cloudyvoice', SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089' }),
      null,
      'no token -> unconfigured',
    );
    assert.equal(
      createTelephonyAdapter({
        TELEPHONY_PROVIDER: 'cloudyvoice',
        SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089',
        SIP_GATEWAY_API_TOKEN: 'tok',
      }),
      null,
      'no caller ID -> unconfigured',
    );
    const ok = createTelephonyAdapter({
      TELEPHONY_PROVIDER: 'cloudyvoice',
      SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089/',
      SIP_GATEWAY_API_TOKEN: 'tok',
      TELEPHONY_FROM_NUMBER: '+922111111111',
    });
    assert.ok(ok);
    assert.equal(ok.key, 'cloudyvoice');
    assert.equal(ok.label, 'CloudyVoice (SIP via gateway)');
  });

  test('twilio dispatch is unchanged and unknown providers still yield null', () => {
    assert.equal(createTelephonyAdapter({ TELEPHONY_PROVIDER: 'nokia' }), null);
    assert.equal(
      createTelephonyAdapter({ TELEPHONY_PROVIDER: 'twilio', TELEPHONY_ACCOUNT_SID: 'AC1', TELEPHONY_AUTH_TOKEN: 't' }),
      null,
      'twilio still needs its own credentials + caller ID',
    );
    const twilio = createTelephonyAdapter({
      TELEPHONY_PROVIDER: 'twilio',
      TELEPHONY_ACCOUNT_SID: 'AC1',
      TELEPHONY_AUTH_TOKEN: 't',
      TELEPHONY_FROM_NUMBER: '+1',
    });
    assert.ok(twilio);
    assert.equal(twilio.key, 'twilio');
    // Gateway variables must not leak into the Twilio adapter's config.
    assert.equal(
      createTelephonyAdapter({
        TELEPHONY_PROVIDER: 'twilio',
        TELEPHONY_ACCOUNT_SID: 'AC1',
        TELEPHONY_AUTH_TOKEN: 't',
        TELEPHONY_FROM_NUMBER: '+1',
        SIP_GATEWAY_BASE_URL: 'http://nope',
      })?.key,
      'twilio',
    );
    assert.equal(createTelephonyAdapter({ TELEPHONY_PROVIDER: 'mock' })?.key, 'mock_telephony');
    assert.deepEqual([...SUPPORTED_TELEPHONY_PROVIDERS], ['twilio', 'cloudyvoice', 'mock']);
  });

  test('gatewayEnvFrom rejects a non-http base URL and applies sane timeouts', () => {
    assert.equal(gatewayEnvFrom({}), null, 'absent config is unconfigured');
    assert.equal(gatewayEnvFrom({ SIP_GATEWAY_BASE_URL: 'ftp://gw.local', SIP_GATEWAY_API_TOKEN: 't' }), null, 'only http(s)');
    assert.equal(gatewayEnvFrom({ SIP_GATEWAY_BASE_URL: 'http://gw.local', SIP_GATEWAY_API_TOKEN: '' }), null, 'token required');

    const defaults = gatewayEnvFrom({ SIP_GATEWAY_BASE_URL: 'http://gw.local/', SIP_GATEWAY_API_TOKEN: 't' });
    assert.equal(defaults?.baseUrl, 'http://gw.local', 'a trailing slash is normalised away');
    assert.equal(defaults?.timeoutMs, 10_000, 'an absent/invalid timeout falls back to the default');

    const custom = gatewayEnvFrom({
      SIP_GATEWAY_BASE_URL: 'https://gw.local',
      SIP_GATEWAY_API_TOKEN: 't',
      SIP_GATEWAY_TIMEOUT_MS: '4500',
    });
    assert.equal(custom?.timeoutMs, 4500);

    const outOfRange = gatewayEnvFrom({
      SIP_GATEWAY_BASE_URL: 'https://gw.local',
      SIP_GATEWAY_API_TOKEN: 't',
      SIP_GATEWAY_TIMEOUT_MS: '999999',
    });
    assert.equal(outOfRange?.timeoutMs, 10_000, 'an out-of-range timeout is clamped, never trusted');
  });
});

describe('registry webhook selection (provider-driven, twilio byte-identical)', () => {
  // `buildRegistry` builds URLs from CONFIG, so the config and the env map it
  // is built from must agree — same source, exactly as bootstrap does.
  const setup = (extra: Record<string, string | undefined>) => {
    const env = {
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(64, '0'),
      DATABASE_PATH: ':memory:',
      PUBLIC_BASE_URL: 'https://uws.example',
      ...extra,
    };
    return { env, config: loadConfig(env) };
  };

  test('twilio keeps its exact historical URLs', () => {
    const { env, config } = setup({
      TELEPHONY_PROVIDER: 'twilio',
      TELEPHONY_ACCOUNT_SID: 'AC1',
      TELEPHONY_AUTH_TOKEN: 'tok',
      TELEPHONY_FROM_NUMBER: '+1',
    });
    const reg = buildRegistry(config, env);
    assert.equal(reg.voiceAnswerUrl, 'https://uws.example/api/webhooks/telephony/twilio/voice');
    assert.equal(reg.voiceStatusUrl, 'https://uws.example/api/webhooks/telephony/twilio');
  });

  test('cloudyvoice points both URLs at the gateway routes', () => {
    const { env, config } = setup({
      TELEPHONY_PROVIDER: 'cloudyvoice',
      SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089',
      SIP_GATEWAY_API_TOKEN: 'tok',
      SIP_GATEWAY_EVENT_SECRET: 'event-secret',
      TELEPHONY_FROM_NUMBER: '+922111111111',
    });
    const reg = buildRegistry(config, env);
    assert.equal(reg.voiceAnswerUrl, 'https://uws.example/api/webhooks/telephony/gateway/answer');
    assert.equal(reg.voiceStatusUrl, 'https://uws.example/api/webhooks/telephony/gateway/events');
    assert.equal(reg.telephony?.key, 'cloudyvoice');
  });

  test('with no telephony configured both URLs are null', () => {
    const { env, config } = setup({});
    const reg = buildRegistry(config, env);
    assert.equal(reg.voiceAnswerUrl, null);
    assert.equal(reg.voiceStatusUrl, null);
  });

  test('mock mode still answers with the Twilio paths (unchanged legacy behaviour)', () => {
    const { env, config } = setup({ TELEPHONY_PROVIDER: 'mock' });
    const reg = buildRegistry(config, env);
    assert.equal(reg.voiceAnswerUrl, 'https://uws.example/api/webhooks/telephony/twilio/voice');
    assert.equal(reg.voiceStatusUrl, 'https://uws.example/api/webhooks/telephony/twilio');
  });
});

describe('registry gateway verification (timing-safe, mode-gated)', () => {
  const gatewayEnv = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test'.padEnd(64, '0'),
    DATABASE_PATH: ':memory:',
    TELEPHONY_PROVIDER: 'cloudyvoice',
    SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089',
    SIP_GATEWAY_API_TOKEN: 'gw-control-token',
    SIP_GATEWAY_EVENT_SECRET: 'event-secret',
    TELEPHONY_FROM_NUMBER: '+922111111111',
  };
  const twilioEnv = {
    NODE_ENV: 'test',
    SESSION_SECRET: 'test'.padEnd(64, '0'),
    DATABASE_PATH: ':memory:',
    TELEPHONY_PROVIDER: 'twilio',
    TELEPHONY_ACCOUNT_SID: 'AC1',
    TELEPHONY_AUTH_TOKEN: 'tok',
    TELEPHONY_FROM_NUMBER: '+1',
  };

  test('bearer control auth accepts only the exact token', () => {
    const reg = buildRegistry(cfg(), gatewayEnv);
    assert.equal(reg.verifyGatewayControlAuth('Bearer gw-control-token'), true);
    assert.equal(reg.verifyGatewayControlAuth('Bearer wrong-token'), false);
    assert.equal(reg.verifyGatewayControlAuth('gw-control-token'), false, 'the scheme is part of the comparison');
    assert.equal(reg.verifyGatewayControlAuth(null), false);
    assert.equal(reg.verifyGatewayControlAuth(''), false);
  });

  test('event signatures are HMAC-SHA256 over the RAW body and reject tampering', () => {
    const reg = buildRegistry(cfg(), gatewayEnv);
    const raw = Buffer.from(JSON.stringify({ eventId: 'e1', callId: 'gw-call-1', status: 'answered' }));
    const sig = createHmac('sha256', 'event-secret').update(raw).digest('hex');

    assert.equal(reg.verifyGatewayEventSignature(raw, sig), true);
    assert.equal(reg.verifyGatewayEventSignature(raw, sig.toUpperCase()), true, 'hex case is irrelevant');
    assert.equal(reg.verifyGatewayEventSignature(raw, 'deadbeef'), false, 'wrong signature fails');
    assert.equal(reg.verifyGatewayEventSignature(raw, null), false, 'missing signature fails');
    assert.equal(
      reg.verifyGatewayEventSignature(Buffer.concat([raw, Buffer.from(' ')]), sig),
      false,
      'a re-serialised body must fail',
    );
    assert.equal(reg.verifyGatewayEventSignature(undefined, sig), false, 'no raw bytes -> nothing to verify');
  });

  test('a Twilio-mode or unconfigured instance accepts NO gateway traffic', () => {
    const twilio = buildRegistry(cfg(), twilioEnv);
    assert.equal(twilio.verifyGatewayControlAuth('Bearer gw-control-token'), false);
    assert.equal(
      twilio.verifyGatewayEventSignature(
        Buffer.from('{}'),
        createHmac('sha256', 'event-secret').update(Buffer.from('{}')).digest('hex'),
      ),
      false,
      'gateway verification must be inert unless the gateway provider is selected',
    );

    // Gateway provider named but the shared secrets are missing.
    const bare = buildRegistry(cfg(), {
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(64, '0'),
      DATABASE_PATH: ':memory:',
      TELEPHONY_PROVIDER: 'cloudyvoice',
      SIP_GATEWAY_BASE_URL: 'http://127.0.0.1:8089',
      TELEPHONY_FROM_NUMBER: '+922111111111',
    });
    assert.equal(bare.verifyGatewayControlAuth('Bearer anything'), false, 'no token configured -> refuse all');
    assert.equal(bare.verifyGatewayEventSignature(Buffer.from('{}'), 'any'), false, 'no secret configured -> refuse all');
  });
});

describe('gateway lifecycle mapping (contract vocabulary + SIP causes)', () => {
  test('every gateway status word maps onto the calls.status vocabulary', () => {
    const allowed = new Set(['queued', 'ringing', 'in_progress', 'completed', 'busy', 'no_answer', 'failed', 'cancelled']);
    for (const [word, mapped] of Object.entries(GATEWAY_CALL_STATUS)) {
      assert.ok(allowed.has(mapped), `gateway word "${word}" -> "${mapped}" must be a known status`);
    }
    // The words this contract actually uses.
    for (const word of ['queued', 'ringing', 'answered', 'completed', 'busy', 'no_answer', 'failed', 'cancelled']) {
      assert.ok(GATEWAY_CALL_STATUS[word], `contract word "${word}" must be mapped`);
    }
    assert.equal(GATEWAY_CALL_STATUS['answered'], 'in_progress');
  });

  test('SIP release causes map to honest statuses and outcomes', () => {
    assert.deepEqual(sipCauseToStatus(16), { status: 'completed', outcome: null }, 'normal clearing derives from duration');
    assert.deepEqual(sipCauseToStatus(17), { status: 'busy', outcome: 'unanswered' });
    assert.deepEqual(sipCauseToStatus(19), { status: 'no_answer', outcome: 'unanswered' });
    assert.deepEqual(sipCauseToStatus(28), { status: 'failed', outcome: 'wrong_number' }, 'invalid number is a wrong number');
    // An unrecognised cause is a plain failure — never a guess at "answered".
    assert.deepEqual(sipCauseToStatus(999), { status: 'failed', outcome: 'failed' });
    assert.deepEqual(sipCauseToStatus(-1), { status: 'failed', outcome: 'failed' });
  });
});
