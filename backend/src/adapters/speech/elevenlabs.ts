/**
 * Speech adapter — ElevenLabs text-to-speech (TTS direction only).
 *
 * ElevenLabs has no speech-to-text product: `transcribe` always throws
 * `unconfigured` so a misrouted STT request fails loudly instead of silently
 * substituting another provider. Pair it with an STT provider (openai,
 * deepgram) through the dispatch in `speech/index.ts`, which composes the two
 * directions into a single SpeechPort.
 *
 * Credentials: `ELEVENLABS_API_KEY` (read by the dispatch, never logged —
 * this module only ever sees the value as `apiKey` and never echoes it).
 * Voice: the per-call voice, else `SPEECH_VOICE`, else ElevenLabs' classic
 * default voice id. Model defaults to `eleven_multilingual_v2`
 * (`ELEVENLABS_MODEL` overrides); language/voice support is provider-side —
 * any rejection surfaces as an honest provider_error, never a silent swap.
 *
 * Output format: mp3 by default; `format: 'pcm'` requests ElevenLabs' raw
 * s16le `pcm_16000` stream (reported sampleRate 16000) so the telephony
 * layer can resample it to 8 kHz. Bytes are classified by CONTENT
 * (RIFF/ID3/frame sync), never by trusting a header.
 *
 * `ping()` lists voices (GET /voices — free, read-only): it validates the
 * key without spending a single character of synthesis.
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type SpeechPort } from '../types.ts';
import { classifyAudioContent } from './openai.ts';

export interface ElevenLabsOptions {
  apiKey: string;
  /** Voice id override (falls back to ElevenLabs' classic default voice). */
  voice?: string;
  /** Model id override (default: eleven_multilingual_v2). */
  model?: string;
  /** Override for tests (default https://api.elevenlabs.io/v1). */
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE = 'https://api.elevenlabs.io/v1';
const DEFAULT_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'; // ElevenLabs' classic default voice
const DEFAULT_MODEL = 'eleven_multilingual_v2';
const TTS_TIMEOUT_MS = 30_000;

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

export function createElevenLabsSpeechAdapter(opts: ElevenLabsOptions): SpeechPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const key = opts.apiKey;
  let lastError: string | null = null;
  const configured = (): boolean => Boolean(key);

  return {
    key: 'elevenlabs_speech',
    label: 'Speech TTS (ElevenLabs)',

    status(): AdapterStatus {
      return {
        key: 'speech',
        label: 'Speech (STT/TTS)',
        implementation: configured() ? 'elevenlabs' : null,
        state: configured() ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['voice synthesis'],
        lastError,
      };
    },

    // ElevenLabs cannot transcribe: fail loudly rather than fake a provider.
    async transcribe(): Promise<{ text: string }> {
      throw new AdapterError(
        'unconfigured',
        'ElevenLabs provides text-to-speech only — configure STT_PROVIDER (openai or deepgram) for transcription',
      );
    },

    async synthesize(input): Promise<{ audio: Uint8Array; contentType: string; sampleRate?: number }> {
      if (!configured()) throw new AdapterError('unconfigured', 'No ElevenLabs API key is configured');
      if (!input.text || input.text.trim().length === 0) {
        throw new AdapterError('provider_error', 'No text provided to synthesise', { providerStatus: 400 });
      }
      const voiceId = input.voice ?? opts.voice ?? DEFAULT_VOICE_ID;
      const wantPcm = input.format === 'pcm';
      // output_format is a query param on ElevenLabs; pcm_16000 is their raw
      // s16le stream (documented rate 16 kHz), mp3_44100_128 the default.
      const url = `${base}/text-to-speech/${encodeURIComponent(voiceId)}?output_format=${wantPcm ? 'pcm_16000' : 'mp3_44100_128'}`;

      const controller = new AbortController();
      const timedOut = { value: false };
      const timer = setTimeout(() => {
        timedOut.value = true;
        controller.abort();
      }, TTS_TIMEOUT_MS);
      const external = input.signal;
      const onExternalAbort = (): void => controller.abort();
      if (external) {
        if (external.aborted) controller.abort();
        else external.addEventListener('abort', onExternalAbort, { once: true });
      }
      try {
        const res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'xi-api-key': key, 'content-type': 'application/json' },
          body: JSON.stringify({
            text: input.text,
            model_id: opts.model ?? DEFAULT_MODEL,
            voice_settings: { stability: 0.5, similarity_boost: 0.75 },
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          // Status mapping only — NEVER the response body (it can echo a
          // masked key prefix, which must not reach logs or the UI).
          const mapped = mapStatus(res.status, 'Speech synthesis');
          const err =
            mapped ??
            new AdapterError('provider_error', `Speech synthesis failed (${res.status})`, {
              providerStatus: res.status,
            });
          lastError = `${err.code}: ${err.message}`;
          throw err;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (bytes.length === 0) {
          throw new AdapterError('provider_error', 'Speech synthesis returned no audio', { providerStatus: 200 });
        }
        const classified = classifyAudioContent(bytes, wantPcm ? 'pcm' : undefined);
        // classifyAudioContent assumes OpenAI's 24 kHz pcm; ElevenLabs'
        // pcm_16000 stream is 16 kHz — correct the rate for this provider.
        const out =
          classified.contentType === 'audio/pcm'
            ? { contentType: classified.contentType, sampleRate: 16_000 }
            : classified;
        lastError = null;
        return { audio: bytes, ...out };
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        lastError = `network: ${err instanceof Error ? err.name : 'error'}`;
        throw new AdapterError('network', 'Could not reach the speech provider', { retryable: true, cause: err });
      } finally {
        clearTimeout(timer);
        external?.removeEventListener('abort', onExternalAbort);
      }
    },

    /**
     * Free connection probe: lists voices (read-only, free). Validates the
     * API key WITHOUT running a paid synthesis.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      if (!configured()) return { ok: false, detail: 'No ElevenLabs API key is configured.' };
      try {
        const res = await requestJson<{ voices?: unknown[] }>(
          fetchImpl,
          `${base}/voices`,
          { method: 'GET', headers: { 'xi-api-key': key }, timeoutMs: 8_000 },
          (status) => mapStatus(status, 'ElevenLabs'),
        );
        const count = Array.isArray(res.voices) ? res.voices.length : 0;
        lastError = null;
        return {
          ok: true,
          detail: `Authenticated voice listing OK (${count} voices) — free endpoint, nothing synthesized.`,
        };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
