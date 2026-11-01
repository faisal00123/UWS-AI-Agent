/**
 * Phase 11A unit tests: provider-independent integration architecture.
 *
 * Covers:
 *  - AI dispatch by env (openai/anthropic/gemini/mock, unknown -> null);
 *  - Anthropic + Gemini request construction (injected fetch, no network);
 *  - speech dispatch + language/voice propagation (ur/en);
 *  - website discovery extraction (title/phones/emails, scheme guard);
 *  - registry decoration: disable gate, rate limit, retry-on-idempotent-only,
 *    usage recording, simulated flag.
 *
 * Every adapter here is exercised through an INJECTED fetch — a unit test
 * cannot reach a real provider by accident.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';
import { createAnthropicAdapter } from '../../src/adapters/ai/anthropic.ts';
import { createGeminiAdapter } from '../../src/adapters/ai/gemini.ts';
import { createConversationAdapter } from '../../src/adapters/ai/index.ts';
import { createTelephonyAdapter } from '../../src/adapters/telephony/index.ts';
import { createWhatsAppAdapter } from '../../src/adapters/whatsapp/index.ts';
import { createSpeechAdapter, speechDefaultsFromEnv, voiceForLanguage } from '../../src/adapters/speech/index.ts';
import { createEmailAdapter } from '../../src/adapters/email/index.ts';
import { createDiscoveryAdapter } from '../../src/adapters/discovery/index.ts';
import { discoverFromWebsite } from '../../src/adapters/discovery/website.ts';
import { buildRegistry, type AdapterUsageEvent } from '../../src/adapters/registry.ts';
import { loadConfig } from '../../src/core/config.ts';
import { createMockAIAdapter, createMockSpeechAdapter } from '../../src/adapters/mock/index.ts';

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

const CFG = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(64), DATABASE_PATH: ':memory:' });

describe('AI provider dispatch', () => {
  test('empty AI_PROVIDER yields null (unconfigured, never a guess)', () => {
    assert.equal(createConversationAdapter({}), null);
    assert.equal(createConversationAdapter({ AI_PROVIDER: '' }), null);
  });

  test('unknown AI_PROVIDER yields null', () => {
    assert.equal(createConversationAdapter({ AI_PROVIDER: 'skynet', AI_API_KEY: 'k', AI_MODEL: 'm' }), null);
  });

  test('openai without key/model yields null', () => {
    assert.equal(createConversationAdapter({ AI_PROVIDER: 'openai', AI_MODEL: 'm' }), null);
    assert.equal(createConversationAdapter({ AI_PROVIDER: 'openai', AI_API_KEY: 'k' }), null);
  });

  test('openai with credentials yields an openai adapter', () => {
    const port = createConversationAdapter({ AI_PROVIDER: 'openai', AI_API_KEY: 'k', AI_MODEL: 'm' });
    assert.ok(port);
    assert.equal(port.status().implementation, 'openai_compatible');
  });

  test('anthropic with credentials yields an anthropic adapter', () => {
    const port = createConversationAdapter({ AI_PROVIDER: 'anthropic', AI_API_KEY: 'k', AI_MODEL: 'm' });
    assert.ok(port);
    assert.equal(port.status().implementation, 'anthropic');
  });

  test('gemini with credentials yields a gemini adapter', () => {
    const port = createConversationAdapter({ AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_MODEL: 'm' });
    assert.ok(port);
    assert.equal(port.status().implementation, 'gemini');
  });

  test('mock yields a simulated adapter with simulated=true', () => {
    const port = createConversationAdapter({ AI_PROVIDER: 'mock' });
    assert.ok(port);
    const st = port.status();
    assert.equal(st.implementation, 'mock');
    assert.equal(st.simulated, true);
    assert.equal(st.state, 'configured');
  });
});

describe('anthropic adapter', () => {
  test('posts /v1/messages with x-api-key, system field, mapped roles', async () => {
    const { fetchImpl, calls } = fakeFetch({
      body: { content: [{ type: 'text', text: 'hello there' }], model: 'claude-test' },
    });
    const port = createAnthropicAdapter({ apiKey: 'sk-ant-secret', model: 'claude-3-5', fetchImpl });
    const res = await port.complete({
      messages: [
        { role: 'system', content: 'DISCLOSURE first.' },
        { role: 'user', content: 'Assalam-o-Alaikum' },
      ],
    });
    assert.equal(res.text, 'hello there');
    assert.equal(res.model, 'claude-test');
    assert.equal(calls.length, 1);
    assert.match(calls[0]!.url, /api\.anthropic\.com\/v1\/messages$/);
    const headers = calls[0]!.init.headers as Record<string, string>;
    assert.equal(headers['x-api-key'], 'sk-ant-secret');
    assert.ok(headers['anthropic-version']);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    assert.equal(body['system'], 'DISCLOSURE first.');
    const msgs = body['messages'] as { role: string }[];
    assert.equal(msgs.length, 1); // system lifted out
    assert.equal(msgs[0]!.role, 'user');
  });

  test('rate-limited responses map to retryable rate_limited', async () => {
    const { fetchImpl } = fakeFetch({ status: 429, body: { error: 'slow down' } });
    const port = createAnthropicAdapter({ apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(
      port.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited' && err.retryable,
    );
  });

  test('auth failure never leaks the key in the error message', async () => {
    const { fetchImpl } = fakeFetch({ status: 401, body: { error: 'bad key sk-ant-secret' } });
    const port = createAnthropicAdapter({ apiKey: 'sk-ant-secret', model: 'm', fetchImpl });
    await assert.rejects(port.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.ok(!err.message.includes('sk-ant-secret'), 'key leaked in message');
      return true;
    });
  });

  test('an empty completion (no text blocks) maps to provider_error', async () => {
    const { fetchImpl } = fakeFetch({ body: { content: [], model: 'm' } });
    const port = createAnthropicAdapter({ apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(
      port.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) => err instanceof AdapterError && err.code === 'provider_error',
    );
  });
});

describe('gemini adapter', () => {
  test('posts generateContent with key in query, model role mapping, systemInstruction', async () => {
    const { fetchImpl, calls } = fakeFetch({
      body: { candidates: [{ content: { parts: [{ text: 'namaste' }], role: 'model' } }], modelVersion: 'gemini-1.5' },
    });
    const port = createGeminiAdapter({ apiKey: 'AIza-secret', model: 'gemini-1.5-flash', fetchImpl });
    const res = await port.complete({
      messages: [
        { role: 'system', content: 'Be polite.' },
        { role: 'user', content: 'salam' },
        { role: 'assistant', content: 'walaikum assalam' },
        { role: 'user', content: 'need a website' },
      ],
    });
    assert.equal(res.text, 'namaste');
    assert.equal(res.model, 'gemini-1.5');
    assert.match(calls[0]!.url, /models\/gemini-1\.5-flash:generateContent\?key=AIza-secret$/);
    const body = JSON.parse(String(calls[0]!.init.body)) as Record<string, unknown>;
    assert.ok(body['systemInstruction']);
    const contents = body['contents'] as { role: string }[];
    assert.equal(contents.length, 3); // system lifted out
    assert.equal(contents[0]!.role, 'user');
    assert.equal(contents[1]!.role, 'model'); // assistant -> model
  });

  test('bad request maps to provider_error without leaking the key', async () => {
    const { fetchImpl } = fakeFetch({ status: 400, body: { error: 'bad model AIza-secret' } });
    const port = createGeminiAdapter({ apiKey: 'AIza-secret', model: 'nope', fetchImpl });
    await assert.rejects(port.complete({ messages: [{ role: 'user', content: 'hi' }] }), (err: unknown) => {
      assert.ok(err instanceof AdapterError);
      assert.equal(err.code, 'provider_error');
      assert.ok(!err.message.includes('AIza-secret'));
      return true;
    });
  });

  test('rate limit maps to retryable rate_limited', async () => {
    const { fetchImpl } = fakeFetch({ status: 429, body: { error: 'quota' } });
    const port = createGeminiAdapter({ apiKey: 'k', model: 'm', fetchImpl });
    await assert.rejects(
      port.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited',
    );
  });
});

describe('speech dispatch + language', () => {
  test('speechDefaultsFromEnv parses ur/en and voices', () => {
    const d = speechDefaultsFromEnv({ SPEECH_LANGUAGE: 'ur', SPEECH_VOICE: 'alloy', SPEECH_VOICE_UR: 'uzma' });
    assert.equal(d.language, 'ur');
    assert.equal(d.voice, 'alloy');
    assert.equal(d.voiceUr, 'uzma');
    // Invalid values fall back to 'en' safely.
    assert.equal(speechDefaultsFromEnv({ SPEECH_LANGUAGE: 'klingon' }).language, 'en');
  });

  test('voiceForLanguage picks the Urdu voice for ur and the default for en', () => {
    const d = { language: 'en' as const, voice: 'alloy', voiceUr: 'uzma' };
    assert.equal(voiceForLanguage(d, 'ur'), 'uzma');
    assert.equal(voiceForLanguage(d, 'en'), 'alloy');
    // Falls back to the primary voice when the Urdu voice is unset.
    assert.equal(voiceForLanguage({ ...d, voiceUr: '' }, 'ur'), 'alloy');
  });

  test('mock speech adapter records the transcribed/synthesised language', async () => {
    const port = createMockSpeechAdapter({ language: 'ur', voice: 'uzma' }) as unknown as {
      transcribe(i: { audio: Uint8Array; language?: 'en' | 'ur' }): Promise<{ text: string }>;
      synthesize(i: { text: string; language?: 'en' | 'ur' }): Promise<{ audio: Uint8Array }>;
      transcriptions: { language?: string }[];
      syntheses: { text: string; voice?: string; language?: string }[];
    };
    await port.transcribe({ audio: new Uint8Array(10) });
    await port.synthesize({ text: 'salam' });
    assert.equal(port.transcriptions[0]!.language, 'ur');
    assert.equal(port.syntheses[0]!.language, 'ur');
    assert.equal(port.syntheses[0]!.voice, 'uzma');
  });

  test('unknown speech provider yields null', () => {
    assert.equal(createSpeechAdapter({ STT_PROVIDER: 'deepfake' }), null);
  });

  test('openai speech without a key yields null', () => {
    assert.equal(createSpeechAdapter({ STT_PROVIDER: 'openai' }), null);
  });
});

describe('other dispatch modules', () => {
  test('telephony: unknown provider -> null; mock -> simulated', () => {
    assert.equal(createTelephonyAdapter({ TELEPHONY_PROVIDER: 'nokia' }), null);
    const mock = createTelephonyAdapter({ TELEPHONY_PROVIDER: 'mock' });
    assert.ok(mock);
    assert.equal(mock.status().simulated, true);
  });

  test('telephony: twilio without full credentials -> null', () => {
    assert.equal(
      createTelephonyAdapter({ TELEPHONY_PROVIDER: 'twilio', TELEPHONY_ACCOUNT_SID: 'AC1', TELEPHONY_AUTH_TOKEN: 't' }),
      null, // missing FROM_NUMBER
    );
  });

  test('whatsapp: meta aliases dispatch; unknown -> null', () => {
    assert.equal(createWhatsAppAdapter({ WHATSAPP_PROVIDER: 'signal' }), null);
    const meta = createWhatsAppAdapter({
      WHATSAPP_PROVIDER: 'meta_cloud',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_ACCESS_TOKEN: 'tok',
    });
    assert.ok(meta);
    const alias = createWhatsAppAdapter({
      WHATSAPP_PROVIDER: 'cloud',
      WHATSAPP_PHONE_NUMBER_ID: '123',
      WHATSAPP_ACCESS_TOKEN: 'tok',
    });
    assert.ok(alias);
  });

  test('email: smtp without full credentials -> null; mock -> simulated', () => {
    assert.equal(createEmailAdapter({ EMAIL_PROVIDER: 'smtp', SMTP_HOST: 'h' }), null);
    const mock = createEmailAdapter({ EMAIL_PROVIDER: 'mock' });
    assert.ok(mock);
    assert.equal(mock.status().simulated, true);
  });

  test('discovery: empty/unknown -> unconfigured adapter (not null, never fabricated)', async () => {
    const none = createDiscoveryAdapter({});
    assert.equal(none.status().state, 'unconfigured');
    const unknown = createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'google_places' });
    assert.equal(unknown.status().state, 'unconfigured');
    await assert.rejects(
      unknown.search({ query: 'anything' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });

  test('discovery: mock returns fixture hits filtered by query', async () => {
    const mock = createDiscoveryAdapter({ DISCOVERY_PROVIDER: 'mock' });
    const hits = await mock.search({ query: 'grill' });
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.name, 'Demo Grill House');
  });
});

describe('website discovery helper', () => {
  function htmlFetch(html: string, status = 200): FetchLike {
    return async () => new Response(html, { status, headers: { 'content-type': 'text/html' } });
  }

  test('extracts title, phones and emails from a homepage', async () => {
    const html = `<html><head><title>  Ahmed Grill House — Best BBQ in Lahore </title></head>
      <body><p>Call us at +92 300 1234567 or 0300-1234567</p>
      <p>Email: orders@ahmedgrill.pk and info@ahmedgrill.pk</p></body></html>`;
    const found = await discoverFromWebsite('https://ahmedgrill.pk', { fetchImpl: htmlFetch(html) });
    assert.equal(found.title, 'Ahmed Grill House — Best BBQ in Lahore');
    assert.ok(found.phones.some((p) => p.includes('923001234567')));
    assert.ok(found.emails.includes('orders@ahmedgrill.pk'));
    assert.ok(found.emails.includes('info@ahmedgrill.pk'));
  });

  test('ignores script/style content when extracting contacts', async () => {
    const html = `<html><head><title>T</title><script>var phone = "+19999999999";</script></head>
      <body>+92 321 1112223</body></html>`;
    const found = await discoverFromWebsite('https://x.pk', { fetchImpl: htmlFetch(html) });
    assert.ok(!found.phones.some((p) => p.includes('19999999999')), 'script content leaked');
    assert.ok(found.phones.some((p) => p.includes('923211112223')));
  });

  test('rejects non-http(s) schemes', async () => {
    await assert.rejects(
      discoverFromWebsite('file:///etc/passwd', { fetchImpl: htmlFetch('') }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );
  });

  test('rejects a malformed URL', async () => {
    await assert.rejects(
      discoverFromWebsite('not a url', { fetchImpl: htmlFetch('') }),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );
  });

  test('non-2xx maps to provider_error with the status preserved', async () => {
    await assert.rejects(
      discoverFromWebsite('https://gone.pk', { fetchImpl: htmlFetch('nope', 404) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'provider_error' && err.providerStatus === 404,
    );
  });

  test('network failure maps to retryable network error', async () => {
    const boom: FetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    await assert.rejects(
      discoverFromWebsite('https://down.pk', { fetchImpl: boom }),
      (err: unknown) => err instanceof AdapterError && err.code === 'network' && err.retryable,
    );
  });
});

describe('registry decoration (Phase 11A)', () => {
  const env = { AI_PROVIDER: 'mock' };

  test('statuses() reports six integrations and mock as simulated', () => {
    const reg = buildRegistry(CFG, env, {});
    const statuses = reg.statuses();
    assert.equal(statuses.length, 6);
    const ai = statuses.find((s) => s.key === 'ai');
    assert.ok(ai);
    assert.equal(ai.implementation, 'mock');
    assert.equal(ai.simulated, true);
  });

  test('a disabled integration fails fast with unconfigured and records usage', async () => {
    const events: AdapterUsageEvent[] = [];
    const reg = buildRegistry(CFG, env, {
      isEnabled: (key) => key !== 'ai',
      onUsage: (e) => events.push(e),
    });
    assert.ok(reg.ai); // adapter exists...
    assert.equal(reg.ai!.status().state, 'disabled'); // ...but reports disabled
    await assert.rejects(
      reg.ai!.complete({ messages: [{ role: 'user', content: 'hi' }] }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
    // The refused call was recorded, and no completion happened.
    assert.equal(events.length, 1);
    assert.equal(events[0]!.outcome, 'disabled');
  });

  test('operations are recorded through onUsage with ok outcome', async () => {
    const events: AdapterUsageEvent[] = [];
    const reg = buildRegistry(CFG, env, { onUsage: (e) => events.push(e) });
    await reg.ai!.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(events.length, 1);
    assert.equal(events[0]!.integration, 'ai');
    assert.equal(events[0]!.operation, 'complete');
    assert.equal(events[0]!.outcome, 'ok');
    assert.ok(events[0]!.durationMs >= 0);
  });

  test('rate limiting applies to paid ops (a refused call never happens)', async () => {
    const events: AdapterUsageEvent[] = [];
    const reg = buildRegistry(
      CFG,
      { TELEPHONY_PROVIDER: 'mock' },
      { ratePerMinute: 1, onUsage: (e) => events.push(e) },
    );
    assert.ok(reg.telephony);
    const req = {
      to: '+923001234567',
      answerUrl: 'https://x/answer',
      statusCallbackUrl: 'https://x/status',
      metadata: { businessId: 'b', attemptId: 'a' },
    };
    await reg.telephony!.createCall(req); // first call passes the bucket
    await assert.rejects(
      reg.telephony!.createCall(req), // second is throttled BEFORE any network
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited',
    );
    const outcomes = events.map((e) => e.outcome);
    assert.deepEqual(outcomes, ['ok', 'rate_limited']);
  });

  test('retries apply to idempotent ops (ping) — succeeds after transient failures', async () => {
    // gemini ping() is idempotent and uses fetch: two socket failures then a
    // success proves the retry plumbing (attempts=3 total).
    const events: AdapterUsageEvent[] = [];
    let attempts = 0;
    const flakyFetch: FetchLike = async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError('socket hang up'); // network class failure
      return new Response(JSON.stringify({ name: 'models/gemini-1.5-flash' }), { status: 200 });
    };
    const reg = buildRegistry(
      CFG,
      { AI_PROVIDER: 'gemini', AI_API_KEY: 'k', AI_MODEL: 'm' },
      { fetchImpl: flakyFetch, retryAttempts: 3, onUsage: (e) => events.push(e) },
    );
    assert.ok(reg.ai);
    const res = await reg.ai!.ping!();
    assert.equal(res.ok, true);
    assert.equal(attempts, 3, 'idempotent ping should have been retried');
    // The usage record reflects the retries performed.
    const pingEvents = events.filter((e) => e.operation === 'ping');
    assert.equal(pingEvents.length, 1);
    assert.equal(pingEvents[0]!.retries, 2);
  });

  test('usage recording failure never breaks the operation', async () => {
    const reg = buildRegistry(CFG, env, {
      onUsage: () => {
        throw new Error('db on fire');
      },
    });
    const res = await reg.ai!.complete({ messages: [{ role: 'user', content: 'hi' }] });
    assert.ok(res.text.length > 0);
  });

  test('empty registry (no env) reports every port honestly', () => {
    const reg = buildRegistry(CFG, {}, {});
    const statuses = reg.statuses();
    assert.equal(statuses.length, 6);
    assert.ok(statuses.every((s) => s.state === 'unconfigured' || s.state === 'disabled'));
    assert.equal(reg.telephony, null);
    assert.equal(reg.ai, null);
    assert.equal(reg.discovery.status().state, 'unconfigured');
    // No signature verification possible without config.
    assert.equal(reg.verifyTwilioSignature('https://x', {}, 'sig'), false);
    assert.equal(reg.verifyWhatsAppSignature(Buffer.from('body'), 'sha256=x'), false);
    assert.equal(reg.whatsappVerifyToken, null);
  });

  test('mock AI adapter default reply contains a parseable qualification block', async () => {
    const mock = createMockAIAdapter();
    const { text } = await mock.complete({ messages: [{ role: 'user', content: 'hi' }] });
    const q = extractJson(text);
    assert.ok(q, 'default reply must contain JSON');
    assert.equal(q!['qualification'], 'needs_review');
  });
});

/** Tiny helper: last fenced JSON in text, or null. */
function extractJson(text: string): Record<string, unknown> | null {
  const m = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)].pop();
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]) as Record<string, unknown>;
  } catch {
    return null;
  }
}
