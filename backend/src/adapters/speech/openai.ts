/**
 * Speech adapter — OpenAI-compatible STT/TTS (Phase 7, completed).
 *
 * `transcribe` uploads audio as multipart/form-data to /audio/transcriptions;
 * `synthesize` requests /audio/speech and returns bytes. Without credentials
 * `status()` reports unconfigured and both methods throw `unconfigured` —
 * silence is never substituted for speech.
 *
 * Key handling (verified empirically, not assumed):
 *   - A dedicated `STT_API_KEY`/`TTS_API_KEY` is used first when it actually
 *     authenticates to this host. Foreign-format keys (Deepgram/ElevenLabs)
 *     are rejected by OpenAI with 401 — so when the primary key 401s/403s we
 *     retry EXACTLY ONCE with the shared `AI_API_KEY`, which is the same
 *     vendor/host/trust boundary (same platform project). Nothing is billed
 *     by an auth rejection, so this fallback is free and safe.
 *   - The fallback is sticky (`usingSharedKey`) so subsequent calls skip the
 *     doomed first attempt, and `ping()` reports honestly (variable names
 *     only, never key material).
 *
 * Language: OpenAI STT accepts ISO-639-1 hints — 'ur' (Urdu), 'en' (English).
 * Roman Urdu audio IS Urdu speech, so it transcribes with language 'ur' and
 * the Roman-Urdu TEXT is handled by the conversation layer.
 *
 * Twilio Media Streams compatibility: the duplex bridge converts mu-law 8 kHz
 * frames to a 16 kHz WAV before upload (audio.ts), and asks TTS for raw PCM
 * (`response_format: pcm`, 24 kHz s16le) which it resamples back to 8 kHz.
 * This adapter never claims a byte format it did not receive: the returned
 * `contentType` is classified from the CONTENT (RIFF/ID3/frame-sync), because
 * the provider's declared content-type for `pcm` is unverifiable without a
 * paid test.
 *
 * Logging: this module only sets `lastError` to code+message pairs (no audio,
 * no credentials, no transcript text). The registry records usage aggregates.
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type SpeechPort } from '../types.ts';

export interface OpenAISpeechOptions {
  apiKey: string;
  /**
   * Optional second key tried when `apiKey` is rejected with 401/403 — the
   * shared AI key. Different from `apiKey` only when a dedicated speech key
   * is configured (its foreign format then fails over to the known-good one).
   */
  fallbackApiKey?: string;
  sttModel?: string;
  ttsModel?: string;
  voice?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';
const STT_TIMEOUT_MS = 30_000;
const TTS_TIMEOUT_MS = 30_000;

/** Build a multipart/form-data body without any dependency. */
export function multipart(
  fields: Record<string, string>,
  file: { field: string; filename: string; contentType: string; data: Uint8Array },
): { body: Buffer; contentType: string } {
  const boundary = `----uws${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
  const chunks: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  }
  chunks.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\n` +
        `Content-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  chunks.push(Buffer.from(file.data));
  chunks.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return {
    body: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** Sensible filename extension for a known audio mime type (multipart hint). */
function filenameFor(mime: string | undefined): string {
  const m = (mime ?? '').toLowerCase();
  if (m.includes('wav')) return 'audio.wav';
  if (m.includes('mpeg') || m.includes('mp3')) return 'audio.mp3';
  if (m.includes('ogg')) return 'audio.ogg';
  if (m.includes('flac')) return 'audio.flac';
  if (m.includes('webm')) return 'audio.webm';
  if (m.includes('mp4')) return 'audio.mp4';
  if (m.includes('mulaw') || m.includes('pcmu') || m.includes('x-mulaw')) return 'audio.wav';
  return 'audio.webm';
}

/**
 * Classify TTS response bytes by CONTENT, never trusting the header alone:
 *   RIFF....WAVE -> audio/wav  (riff container)
 *   ID3 / frame sync 0xFFEx -> audio/mpeg
 *   raw (pcm requested) -> audio/pcm @24kHz (provider's documented s16le rate)
 * This keeps the duplex bridge honest: it decides what to do with bytes it
 * can actually verify, and mp3 (which nothing can resample without a decoder)
 * is reported as mp3 rather than silently passed off as PCM.
 */
export function classifyAudioContent(bytes: Uint8Array, requested: 'pcm' | undefined): {
  contentType: string;
  sampleRate?: number;
} {
  if (bytes.length >= 12 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
    // 'RIFF'
    return { contentType: 'audio/wav' };
  }
  if (bytes.length >= 3 && bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    // 'ID3'
    return { contentType: 'audio/mpeg' };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) {
    // MPEG frame sync
    return { contentType: 'audio/mpeg' };
  }
  // Not a recognised container: it is the raw s16le stream when we asked for
  // pcm; otherwise report the provider's default (mp3) honestly.
  if (requested === 'pcm') return { contentType: 'audio/pcm', sampleRate: 24_000 };
  return { contentType: 'audio/mpeg' };
}

/** Map a provider HTTP status to an AdapterError WITHOUT echoing the body
 *  (the body may repeat a masked key prefix — never propagate it). */
function mapAuthStatus(status: number, what: string): AdapterError | null {
  if (status === 401 || status === 403) {
    return new AdapterError('provider_error', `${what} authentication failed`, {
      providerStatus: status,
    });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', `${what} rate limit reached`, {
      retryable: true,
      providerStatus: status,
    });
  }
  if (status === 400 || status === 413 || status === 422) {
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

const isAuthFailure = (err: unknown): boolean =>
  err instanceof AdapterError && (err.providerStatus === 401 || err.providerStatus === 403);

export function createOpenAISpeechAdapter(opts: OpenAISpeechOptions): SpeechPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  const primary = opts.apiKey;
  const secondary = (opts.fallbackApiKey ?? '').trim();
  const hasFallback = Boolean(secondary && secondary !== primary);
  let usingSharedKey = false; // sticky once the fallback proved necessary
  let lastError: string | null = null;

  const configured = (): boolean => Boolean(primary || secondary);

  /** Key to attempt: the dedicated one first, the shared one once known good. */
  const keyFor = (): string => (usingSharedKey && secondary ? secondary : primary || secondary);

  /**
   * Run `attempt` with the primary key; on a 401/403 auth failure and ONLY
   * then, retry exactly once with the fallback key. Auth rejections bill
   * nothing, so the retry costs nothing. Any other error is returned as-is.
   */
  async function withKeyFallback<T>(attempt: (key: string) => Promise<T>): Promise<T> {
    if (!hasFallback || usingSharedKey) return attempt(keyFor());
    try {
      return await attempt(primary);
    } catch (err) {
      if (!isAuthFailure(err)) throw err;
      usingSharedKey = true;
      return attempt(secondary);
    }
  }

  return {
    key: 'openai_speech',
    label: 'Speech STT/TTS (OpenAI-compatible)',

    status(): AdapterStatus {
      return {
        key: 'speech',
        label: 'Speech (STT/TTS)',
        implementation: configured() ? 'openai_compatible' : null,
        state: configured() ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['transcription', 'voice synthesis'],
        lastError,
      };
    },

    async transcribe(input): Promise<{ text: string }> {
      if (!configured()) throw new AdapterError('unconfigured', 'No speech provider credentials are configured');
      if (!input.audio || input.audio.length === 0) {
        throw new AdapterError('provider_error', 'No audio provided to transcribe', { providerStatus: 400 });
      }
      const fields: Record<string, string> = { model: opts.sttModel ?? 'whisper-1' };
      // ISO-639-1 hint: 'ur' Urdu, 'en' English. Omitted for mixed/unknown so
      // the provider auto-detects (never guess the spoken language).
      if (input.language === 'ur' || input.language === 'en') fields['language'] = input.language;
      const mp = multipart(fields, {
        field: 'file',
        filename: input.filename ?? filenameFor(input.mimeType),
        contentType: input.mimeType ?? 'audio/webm',
        data: input.audio,
      });
      try {
        const res = await withKeyFallback((key) =>
          requestJson<{ text?: string }>(
            fetchImpl,
            `${base}/audio/transcriptions`,
            {
              method: 'POST',
              headers: { authorization: `Bearer ${key}`, 'content-type': mp.contentType },
              body: mp.body,
              timeoutMs: STT_TIMEOUT_MS,
              ...(input.signal ? { signal: input.signal } : {}),
            },
            (status) => mapAuthStatus(status, 'Transcription'),
          ),
        );
        if (typeof res.text !== 'string') {
          throw new AdapterError('provider_error', 'Transcription returned no text', { providerStatus: 200 });
        }
        lastError = null;
        return { text: res.text };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },

    async synthesize(input): Promise<{ audio: Uint8Array; contentType: string; sampleRate?: number }> {
      if (!configured()) throw new AdapterError('unconfigured', 'No speech provider credentials are configured');
      if (!input.text || input.text.trim().length === 0) {
        throw new AdapterError('provider_error', 'No text provided to synthesise', { providerStatus: 400 });
      }
      // `pcm` is the raw s16le stream at the provider's documented 24 kHz —
      // the duplex bridge needs sample values it can resample to 8 kHz
      // telephony audio, which mp3 bytes would not give it.
      const requestedPcm = input.format === 'pcm';
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
        const key = await Promise.resolve(keyFor());
        const doFetch = (k: string): Promise<Response> =>
          fetchImpl(`${base}/audio/speech`, {
            method: 'POST',
            headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              model: opts.ttsModel ?? 'tts-1',
              voice: input.voice ?? opts.voice ?? 'alloy',
              input: input.text,
              ...(requestedPcm ? { response_format: 'pcm' } : {}),
            }),
            signal: controller.signal,
          });

        let res: Response;
        try {
          res = await doFetch(key);
          if ((res.status === 401 || res.status === 403) && hasFallback && !usingSharedKey) {
            usingSharedKey = true;
            res = await doFetch(secondary);
          }
        } catch (err) {
          if (external?.aborted && !timedOut.value) {
            throw new AdapterError('provider_error', 'Speech synthesis cancelled', { retryable: false, cause: err });
          }
          throw new AdapterError('network', 'Could not reach the speech provider', {
            retryable: true,
            cause: err,
          });
        }

        if (!res.ok) {
          // Status mapping only — NEVER the response body (it can echo a
          // masked key prefix, which must not reach logs or the UI).
          const mapped = mapAuthStatus(res.status, 'Speech synthesis');
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
        const classified = classifyAudioContent(bytes, requestedPcm ? 'pcm' : undefined);
        lastError = null;
        return { audio: bytes, ...classified };
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
     * Free connection probe (Phase 11B): lists models (read-only, free).
     * Validates the API key WITHOUT running a paid transcription/synthesis.
     * Uses the same primary->fallback auth resolution as the real methods, so
     * a green ping proves the key that speech will actually use.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      if (!configured()) return { ok: false, detail: 'No speech provider credentials are configured.' };
      try {
        const count = await withKeyFallback(async (key) => {
          const res = await requestJson<{ data?: { id?: string }[] }>(
            fetchImpl,
            `${base}/models`,
            { method: 'GET', headers: { authorization: `Bearer ${key}` }, timeoutMs: 8_000 },
            (status) => mapAuthStatus(status, 'Speech provider'),
          );
          return Array.isArray(res.data) ? res.data.length : 0;
        });
        lastError = null;
        const via = hasFallback && usingSharedKey ? ' (using shared AI_API_KEY after primary-key rejection)' : '';
        return {
          ok: true,
          detail: `Authenticated model listing OK (${count} models) — free endpoint, nothing transcribed.${via}`,
        };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
