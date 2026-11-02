/**
 * Speech adapter — OpenAI-compatible STT/TTS (Phase 7).
 *
 * `transcribe` uploads audio as multipart/form-data to /audio/transcriptions;
 * `synthesize` requests /audio/speech and returns bytes. Both are only ever
 * called from live-call code paths (Phase 7 wires the ports; the media
 * pipeline that will call them lands with live call audio). Without
 * credentials `status()` reports unconfigured and both methods throw
 * `unconfigured` — silence is never substituted for speech.
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type SpeechPort } from '../types.ts';

export interface OpenAISpeechOptions {
  apiKey: string;
  sttModel?: string;
  ttsModel?: string;
  voice?: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';

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

export function createOpenAISpeechAdapter(opts: OpenAISpeechOptions): SpeechPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  let lastError: string | null = null;

  const configured = (): boolean => Boolean(opts.apiKey);

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
      const mp = multipart(
        { model: opts.sttModel ?? 'whisper-1' },
        {
          field: 'file',
          filename: input.filename ?? 'audio.webm',
          contentType: input.mimeType ?? 'audio/webm',
          data: input.audio,
        },
      );
      try {
        const res = await requestJson<{ text?: string }>(fetchImpl, `${base}/audio/transcriptions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': mp.contentType },
          body: mp.body,
        });
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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 20_000);
      // `pcm` is the raw s16le stream at the provider's documented 24 kHz —
      // the duplex bridge needs sample values it can resample to 8 kHz
      // telephony audio, which mp3 bytes would not give it.
      const format = input.format === 'pcm' ? 'pcm' : undefined;
      try {
        const res = await fetchImpl(`${base}/audio/speech`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: opts.ttsModel ?? 'tts-1',
            voice: input.voice ?? opts.voice ?? 'alloy',
            input: input.text,
            ...(format ? { response_format: format } : {}),
          }),
          signal: controller.signal,
        });
        if (!res.ok) {
          lastError = `provider_error: speech synthesis failed (${res.status})`;
          throw new AdapterError('provider_error', `Speech synthesis failed (${res.status})`, {
            providerStatus: res.status,
          });
        }
        const buf = Buffer.from(await res.arrayBuffer());
        lastError = null;
        const contentType = res.headers.get('content-type') ?? (format === 'pcm' ? 'audio/pcm' : 'audio/mpeg');
        return {
          audio: new Uint8Array(buf),
          contentType,
          ...(format === 'pcm' ? { sampleRate: 24_000 } : {}),
        };
      } catch (err) {
        if (err instanceof AdapterError) throw err;
        lastError = `network: ${err instanceof Error ? err.name : 'error'}`;
        throw new AdapterError('network', 'Could not reach the speech provider', { retryable: true, cause: err });
      } finally {
        clearTimeout(timer);
      }
    },

    /**
     * Free connection probe (Phase 11B): lists models (read-only, free).
     * Validates the API key WITHOUT running a paid transcription/synthesis.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      if (!configured()) return { ok: false, detail: 'No speech provider credentials are configured.' };
      try {
        const res = await requestJson<{ data?: { id?: string }[] }>(
          fetchImpl,
          `${base}/models`,
          { method: 'GET', headers: { authorization: `Bearer ${opts.apiKey}` }, timeoutMs: 8_000 },
          (status) =>
            status === 401 || status === 403
              ? new AdapterError('provider_error', 'Provider authentication failed — check the speech credentials', {
                  providerStatus: status,
                })
              : status === 429
                ? new AdapterError('rate_limited', 'Provider rate limit reached', { retryable: true, providerStatus: status })
                : null,
        );
        const count = Array.isArray(res.data) ? res.data.length : 0;
        lastError = null;
        return { ok: true, detail: `Authenticated model listing OK (${count} models) — free endpoint, nothing transcribed.` };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
