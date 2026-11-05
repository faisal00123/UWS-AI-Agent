/**
 * Speech adapter — Deepgram speech-to-text (STT direction only).
 *
 * Deepgram has no text-to-speech product: `synthesize` always throws
 * `unconfigured` so a misrouted TTS request fails loudly instead of silently
 * substituting another provider. Pair it with a TTS provider (openai,
 * elevenlabs) through the dispatch in `speech/index.ts`, which composes the
 * two directions into a single SpeechPort.
 *
 * Credentials: `DEEPGRAM_API_KEY` (read by the dispatch; sent as
 * `Authorization: Token <key>` — never logged or echoed).
 *
 * Language: Deepgram accepts 'en' (and regional variants) but has NO Urdu
 * language code. Urdu audio is therefore sent WITHOUT a language hint and
 * the provider auto-detects — never guess a language the provider cannot
 * accept (the Roman-Urdu TEXT layer is unaffected; it is conversation-side).
 *
 * Audio: raw bytes posted to /listen with the caller's content-type (the
 * duplex bridge sends a 16 kHz WAV built from telephony mu-law). The body is
 * passed through byte-for-byte — requestJson only JSON-encodes plain
 * objects, and a Buffer is explicitly exempted.
 *
 * `ping()` lists projects (GET /projects — free, read-only): it validates
 * the key without running a paid transcription.
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type SpeechPort } from '../types.ts';

export interface DeepgramOptions {
  apiKey: string;
  /** Model override (default: nova-2). */
  model?: string;
  /** Override for tests (default https://api.deepgram.com/v1). */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE = 'https://api.deepgram.com/v1';
const DEFAULT_MODEL = 'nova-2';
const STT_TIMEOUT_MS = 30_000;

/** Deepgram /listen response (only the fields we read). */
interface DeepgramListenResponse {
  results?: {
    channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
  };
}

/** Map a provider HTTP status to an AdapterError WITHOUT echoing the body
 *  (error bodies can repeat a masked key prefix — never propagate it). */
function mapStatus(status: number, what: string): AdapterError | null {
  if (status === 401 || status === 403) {
    return new AdapterError('provider_error', `${what} authentication failed`, { providerStatus: status });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', `${what} rate limit reached`, {
      retryable: true,
      providerStatus: status,
    });
  }
  if (status === 400 || status === 402 || status === 413 || status === 422) {
    return new AdapterError('provider_error', `${what} rejected the request (${status})`, {
      providerStatus: status,
    });
  }
  if (status >= 500) {
    return new AdapterError('provider_error', `${what} is unavailable (${status})`, {
      retryable: true,
      providerStatus: status,
    });
  }
  return null;
}

/** Copy a (possibly Buffer-backed) view into a standalone Buffer so the
 *  transport sends raw bytes instead of JSON-encoding a typed array. */
function asBuffer(audio: Uint8Array): Buffer {
  return Buffer.isBuffer(audio) ? audio : Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
}

export function createDeepgramSpeechAdapter(opts: DeepgramOptions): SpeechPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const key = opts.apiKey;
  let lastError: string | null = null;
  const configured = (): boolean => Boolean(key);

  return {
    key: 'deepgram_speech',
    label: 'Speech STT (Deepgram)',

    status(): AdapterStatus {
      return {
        key: 'speech',
        label: 'Speech (STT/TTS)',
        implementation: configured() ? 'deepgram' : null,
        state: configured() ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['transcription'],
        lastError,
      };
    },

    async transcribe(input): Promise<{ text: string }> {
      if (!configured()) throw new AdapterError('unconfigured', 'No Deepgram API key is configured');
      if (!input.audio || input.audio.length === 0) {
        throw new AdapterError('provider_error', 'No audio provided to transcribe', { providerStatus: 400 });
      }
      const params = new URLSearchParams({ model: opts.model ?? DEFAULT_MODEL, smart_format: 'true' });
      // 'ur' has no Deepgram language code: omit the hint and let the
      // provider auto-detect rather than sending a code it rejects.
      if (input.language === 'en') params.set('language', 'en');
      try {
        const res = await requestJson<DeepgramListenResponse>(
          fetchImpl,
          `${base}/listen?${params.toString()}`,
          {
            method: 'POST',
            headers: {
              authorization: `Token ${key}`,
              'content-type': input.mimeType ?? 'audio/wav',
            },
            body: asBuffer(input.audio),
            timeoutMs: STT_TIMEOUT_MS,
            ...(input.signal ? { signal: input.signal } : {}),
          },
          (status) => mapStatus(status, 'Transcription'),
        );
        const text = res.results?.channels?.[0]?.alternatives?.[0]?.transcript;
        if (typeof text !== 'string') {
          throw new AdapterError('provider_error', 'Transcription returned no text', { providerStatus: 200 });
        }
        lastError = null;
        return { text };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },

    // Deepgram cannot synthesise: fail loudly rather than fake a provider.
    async synthesize(): Promise<{ audio: Uint8Array; contentType: string; sampleRate?: number }> {
      throw new AdapterError(
        'unconfigured',
        'Deepgram provides speech-to-text only — configure TTS_PROVIDER (openai or elevenlabs) for synthesis',
      );
    },

    /**
     * Free connection probe: lists projects (read-only, free). Validates the
     * API key WITHOUT running a paid transcription.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      if (!configured()) return { ok: false, detail: 'No Deepgram API key is configured.' };
      try {
        const res = await requestJson<unknown>(
          fetchImpl,
          `${base}/projects`,
          { method: 'GET', headers: { authorization: `Token ${key}` }, timeoutMs: 8_000 },
          (status) => mapStatus(status, 'Deepgram'),
        );
        // /projects answers with either a bare array or { projects: [...] }.
        const count = Array.isArray(res)
          ? res.length
          : Array.isArray((res as { projects?: unknown[] })?.projects)
            ? (res as { projects: unknown[] }).projects.length
            : 0;
        lastError = null;
        return {
          ok: true,
          detail: `Authenticated project listing OK (${count} projects) — free endpoint, nothing transcribed.`,
        };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
