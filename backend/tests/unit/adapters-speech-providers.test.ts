/**
 * Unit tests: ElevenLabs (TTS) + Deepgram (STT) adapters and the
 * per-capability speech dispatch (composite SpeechPort).
 *
 * Every test uses an injected fetch — no network, no credentials, and a test
 * can never reach a real provider by accident.
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { AdapterError, type FetchLike } from '../../src/adapters/types.ts';
import { createElevenLabsSpeechAdapter } from '../../src/adapters/speech/elevenlabs.ts';
import { createDeepgramSpeechAdapter } from '../../src/adapters/speech/deepgram.ts';
import { createSpeechAdapter, SUPPORTED_SPEECH_PROVIDERS } from '../../src/adapters/speech/index.ts';

/** Capturing fake fetch: records every call, replies with a canned response. */
function fakeFetch(
  reply: { status?: number; body?: unknown; headers?: Record<string, string> } | ((url: string, init: RequestInit) => { status?: number; body?: unknown }),
): { fetchImpl: FetchLike; calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const r = typeof reply === 'function' ? reply(url, init) : reply;
    const body = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? {});
    return new Response(body, {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetchImpl, calls };
}

function header(init: RequestInit, name: string): string {
  const h = (init.headers ?? {}) as Record<string, string>;
  return h[name] ?? '';
}

// ------------------------------------------------------------- dispatch ---

describe('speech dispatch: per-capability provider selection', () => {
  test('deepgram/elevenlabs without keys yield null', () => {
    assert.equal(createSpeechAdapter({ STT_PROVIDER: 'deepgram' }), null);
    assert.equal(createSpeechAdapter({ TTS_PROVIDER: 'elevenlabs' }), null);
  });

  test('SUPPORTED_SPEECH_PROVIDERS lists every implemented provider', () => {
    assert.deepEqual([...SUPPORTED_SPEECH_PROVIDERS].sort(), ['deepgram', 'elevenlabs', 'mock', 'openai']);
  });

  test('deepgram alone serves STT and rejects TTS honestly', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: { results: { channels: [{ alternatives: [{ transcript: 'hi' }] }] } } });
    const port = createSpeechAdapter({ STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg-key' }, { fetchImpl });
    assert.ok(port);
    assert.equal(port.status().implementation, 'deepgram');
    const out = await port.transcribe({ audio: new Uint8Array([1, 2, 3]) });
    assert.equal(out.text, 'hi');
    assert.match(calls[0]!.url, /api\.deepgram\.com\/v1\/listen/);
    await assert.rejects(
      () => port.synthesize({ text: 'hello' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });

  test('elevenlabs alone serves TTS and rejects STT honestly', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: 'ID3mp3bytes' });
    const port = createSpeechAdapter({ TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el-key' }, { fetchImpl });
    assert.ok(port);
    assert.equal(port.status().implementation, 'elevenlabs');
    const out = await port.synthesize({ text: 'hello' });
    assert.ok(out.audio.length > 0);
    assert.match(calls[0]!.url, /api\.elevenlabs\.io\/v1\/text-to-speech\//);
    await assert.rejects(
      () => port.transcribe({ audio: new Uint8Array([1]) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });

  test('mixed STT/TTS providers compose into one port and route each direction', async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.includes('deepgram')
        ? { body: { results: { channels: [{ alternatives: [{ transcript: 'salaam' }] }] } } }
        : { body: 'ID3mp3bytes' },
    );
    const port = createSpeechAdapter(
      { STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg', TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el' },
      { fetchImpl },
    );
    assert.ok(port, 'both directions configured must compose');
    assert.equal(port.status().implementation, 'deepgram+elevenlabs');
    assert.deepEqual(port.status().features.sort(), ['transcription', 'voice synthesis']);

    const t = await port.transcribe({ audio: new Uint8Array([9]) });
    assert.equal(t.text, 'salaam');
    const s = await port.synthesize({ text: 'hello' });
    assert.ok(s.audio.length > 0);

    assert.ok(calls[0]!.url.includes('api.deepgram.com'), 'transcribe must hit the STT provider');
    assert.ok(calls[1]!.url.includes('api.elevenlabs.io'), 'synthesize must hit the TTS provider');
    assert.equal(header(calls[0]!.init, 'authorization'), 'Token dg');
    assert.equal(header(calls[1]!.init, 'xi-api-key'), 'el');
  });

  test('mixed providers with only one side keyed still return a port that fails honestly', () => {
    const port = createSpeechAdapter({
      STT_PROVIDER: 'deepgram',
      DEEPGRAM_API_KEY: 'dg',
      TTS_PROVIDER: 'elevenlabs', // no key
    });
    assert.ok(port, 'the keyed direction must still be usable');
    assert.equal(port.status().implementation, 'deepgram');
    return assert.rejects(
      () => port.synthesize({ text: 'hello' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });

  test('openai STT + elevenlabs TTS routes each side to its own host', async () => {
    const { fetchImpl, calls } = fakeFetch((url) =>
      url.includes('openai') ? { body: { text: 'ok' } } : { body: 'ID3mp3' },
    );
    const port = createSpeechAdapter(
      { STT_PROVIDER: 'openai', AI_API_KEY: 'sk-x', TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el' },
      { fetchImpl },
    );
    assert.ok(port);
    await port.transcribe({ audio: new Uint8Array([1]) });
    await port.synthesize({ text: 'hi' });
    assert.ok(calls[0]!.url.includes('api.openai.com'));
    assert.ok(calls[1]!.url.includes('api.elevenlabs.io'));
  });
});

// ------------------------------------------------------------- deepgram ---

describe('Deepgram adapter', () => {
  test('transcribe posts raw audio with Token auth and parses the transcript', async () => {
    const { fetchImpl, calls } = fakeFetch({
      body: { results: { channels: [{ alternatives: [{ transcript: 'hello there' }] }] } },
    });
    const dg = createDeepgramSpeechAdapter({ apiKey: 'dg-secret', fetchImpl });
    const audio = new Uint8Array([1, 2, 3, 4]);
    const out = await dg.transcribe({ audio, mimeType: 'audio/wav', language: 'en' });
    assert.equal(out.text, 'hello there');

    const [url, init] = [calls[0]!.url, calls[0]!.init];
    assert.ok(url.includes('/v1/listen?'), 'POST must target /listen');
    assert.ok(url.includes('model=nova-2'), 'default model is nova-2');
    assert.ok(url.includes('language=en'), 'explicit en hint is sent');
    assert.equal(header(init, 'authorization'), 'Token dg-secret');
    assert.equal(header(init, 'content-type'), 'audio/wav');
    const sent = Buffer.from(init.body as Uint8Array);
    assert.deepEqual([...sent], [...audio], 'audio bytes must pass through unmodified');
  });

  test("transcribe omits the language hint for 'ur' (no Deepgram Urdu code)", async () => {
    const { fetchImpl, calls } = fakeFetch({
      body: { results: { channels: [{ alternatives: [{ transcript: 'khuda hafiz' }] }] } },
    });
    const dg = createDeepgramSpeechAdapter({ apiKey: 'k', fetchImpl });
    await dg.transcribe({ audio: new Uint8Array([1]), language: 'ur' });
    assert.ok(!calls[0]!.url.includes('language='), 'ur must auto-detect, never a guessed code');
  });

  test('transcribe maps 401 to provider_error and 429 to retryable rate_limited', async () => {
    const denied = createDeepgramSpeechAdapter({ apiKey: 'bad', fetchImpl: fakeFetch({ status: 401, body: {} }).fetchImpl });
    await assert.rejects(
      () => denied.transcribe({ audio: new Uint8Array([1]) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'provider_error' && err.providerStatus === 401,
    );
    const limited = createDeepgramSpeechAdapter({ apiKey: 'k', fetchImpl: fakeFetch({ status: 429, body: {} }).fetchImpl });
    await assert.rejects(
      () => limited.transcribe({ audio: new Uint8Array([1]) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited' && err.retryable === true,
    );
  });

  test('transcribe rejects empty audio and a response with no transcript', async () => {
    const dg = createDeepgramSpeechAdapter({ apiKey: 'k', fetchImpl: fakeFetch({ body: {} }).fetchImpl });
    await assert.rejects(
      () => dg.transcribe({ audio: new Uint8Array(0) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'provider_error',
    );
    await assert.rejects(
      () => dg.transcribe({ audio: new Uint8Array([1]) }),
      (err: unknown) => err instanceof AdapterError && /no text/.test(err.message),
    );
  });

  test('ping lists projects for free and reports auth failures honestly', async () => {
    const ok = createDeepgramSpeechAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch({ body: [{ id: 'p1' }, { id: 'p2' }] }).fetchImpl,
    });
    const res = await ok.ping!();
    assert.equal(res.ok, true);
    assert.match(res.detail ?? '', /2 projects/);

    const bad = createDeepgramSpeechAdapter({ apiKey: 'bad', fetchImpl: fakeFetch({ status: 401, body: {} }).fetchImpl });
    const res2 = await bad.ping!();
    assert.equal(res2.ok, false);
    assert.match(res2.detail ?? '', /authentication failed/);
  });

  test('status reports unconfigured without a key; synthesize always throws unconfigured', async () => {
    const dg = createDeepgramSpeechAdapter({ apiKey: '' });
    assert.equal(dg.status().state, 'unconfigured');
    assert.equal(dg.status().implementation, null);
    await assert.rejects(
      () => dg.synthesize({ text: 'x' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });
});

// ----------------------------------------------------------- elevenlabs ---

describe('ElevenLabs adapter', () => {
  test('synthesize posts to the voice endpoint with xi-api-key and classifies mp3 by content', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: 'ID3mp3bytes' });
    const el = createElevenLabsSpeechAdapter({ apiKey: 'el-secret', fetchImpl });
    const out = await el.synthesize({ text: 'hello' });
    assert.equal(out.contentType, 'audio/mpeg');

    const [url, init] = [calls[0]!.url, calls[0]!.init];
    assert.ok(url.includes('/v1/text-to-speech/'), 'POST must target text-to-speech');
    assert.ok(url.includes('output_format=mp3_44100_128'), 'default output is mp3');
    assert.equal(header(init, 'xi-api-key'), 'el-secret');
    const body = JSON.parse(init.body as string) as { text: string; model_id: string };
    assert.equal(body.text, 'hello');
    assert.equal(body.model_id, 'eleven_multilingual_v2');
  });

  test("synthesize honours format:'pcm' (pcm_16000, reported 16 kHz) and the per-call voice", async () => {
    const { fetchImpl, calls } = fakeFetch({ body: 'rawpcmdata' });
    const el = createElevenLabsSpeechAdapter({ apiKey: 'k', fetchImpl });
    const out = await el.synthesize({ text: 'hi', format: 'pcm', voice: 'voice-abc' });
    assert.equal(out.contentType, 'audio/pcm');
    assert.equal(out.sampleRate, 16_000, 'ElevenLabs pcm_16000 is 16 kHz, not OpenAI 24 kHz');
    assert.ok(calls[0]!.url.includes('output_format=pcm_16000'));
    assert.ok(calls[0]!.url.includes('/text-to-speech/voice-abc'), 'per-call voice reaches the path');
  });

  test('synthesize maps error statuses without echoing response bodies', async () => {
    const denied = createElevenLabsSpeechAdapter({
      apiKey: 'bad',
      fetchImpl: fakeFetch({ status: 401, body: { detail: { message: 'masked key abc123' } } }).fetchImpl,
    });
    await assert.rejects(
      () => denied.synthesize({ text: 'x' }),
      (err: unknown) =>
        err instanceof AdapterError &&
        err.code === 'provider_error' &&
        !err.message.includes('masked') &&
        err.providerStatus === 401,
    );
    const limited = createElevenLabsSpeechAdapter({ apiKey: 'k', fetchImpl: fakeFetch({ status: 429, body: {} }).fetchImpl });
    await assert.rejects(
      () => limited.synthesize({ text: 'x' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'rate_limited' && err.retryable === true,
    );
  });

  test('synthesize rejects empty text before any network call', async () => {
    const { fetchImpl, calls } = fakeFetch({ body: 'ID3x' });
    const el = createElevenLabsSpeechAdapter({ apiKey: 'k', fetchImpl });
    await assert.rejects(
      () => el.synthesize({ text: '   ' }),
      (err: unknown) => err instanceof AdapterError && err.code === 'provider_error',
    );
    assert.equal(calls.length, 0, 'validation must happen before fetch');
  });

  test('ping lists voices for free and reports auth failures honestly', async () => {
    const ok = createElevenLabsSpeechAdapter({
      apiKey: 'k',
      fetchImpl: fakeFetch({ body: { voices: [{ voice_id: 'a' }] } }).fetchImpl,
    });
    const res = await ok.ping!();
    assert.equal(res.ok, true);
    assert.match(res.detail ?? '', /1 voices/);

    const bad = createElevenLabsSpeechAdapter({ apiKey: 'bad', fetchImpl: fakeFetch({ status: 403, body: {} }).fetchImpl });
    const res2 = await bad.ping!();
    assert.equal(res2.ok, false);
    assert.match(res2.detail ?? '', /authentication failed/);
  });

  test('status reports unconfigured without a key; transcribe always throws unconfigured', async () => {
    const el = createElevenLabsSpeechAdapter({ apiKey: '' });
    assert.equal(el.status().state, 'unconfigured');
    assert.equal(el.status().implementation, null);
    await assert.rejects(
      () => el.transcribe({ audio: new Uint8Array([1]) }),
      (err: unknown) => err instanceof AdapterError && err.code === 'unconfigured',
    );
  });
});

// --------------------------------------------------------------- composite -

describe('composite port behaviour', () => {
  test('ping merges both probes and fails when either side fails', async () => {
    const { fetchImpl } = fakeFetch((url) =>
      url.includes('deepgram') ? { status: 401, body: {} } : { body: { voices: [{ voice_id: 'a' }] } },
    );
    const port = createSpeechAdapter(
      { STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg', TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el' },
      { fetchImpl },
    );
    assert.ok(port);
    const res = await port.ping!();
    assert.equal(res.ok, false, 'a failing side must fail the merged ping');
    assert.match(res.detail ?? '', /STT:/);
    assert.match(res.detail ?? '', /TTS:/);
  });

  test('status state escalates to error when either side has a last error', async () => {
    const { fetchImpl } = fakeFetch({ status: 401, body: {} });
    const port = createSpeechAdapter(
      { STT_PROVIDER: 'deepgram', DEEPGRAM_API_KEY: 'dg', TTS_PROVIDER: 'elevenlabs', ELEVENLABS_API_KEY: 'el' },
      { fetchImpl },
    );
    assert.ok(port);
    await port.transcribe({ audio: new Uint8Array([1]) }).catch(() => undefined);
    assert.equal(port.status().state, 'error');
    assert.match(port.status().lastError ?? '', /provider_error/);
  });
});
