/**
 * AI conversation adapter — Google Gemini generateContent (Phase 11A, Task 2).
 *
 * Same port contract as the other AI adapters. `system` turns go into
 * `systemInstruction`; user/assistant turns become `contents[].parts[].text`
 * with Gemini's role names (`user` / `model`).
 *
 * The API key travels as the `?key=` query parameter (Google's documented
 * API-key transport). `requestJson` only ever reports the HOST on failure,
 * so the key cannot leak through an error message.
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type ConversationPort, type PingResult } from '../types.ts';

export interface GeminiOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[]; role?: string } }[];
  modelVersion?: string;
}

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

function mapGeminiStatus(status: number): AdapterError | null {
  if (status === 400) {
    return new AdapterError('provider_error', 'Provider rejected the request (bad model, key, or payload)', {
      providerStatus: status,
    });
  }
  if (status === 401 || status === 403) {
    return new AdapterError('provider_error', 'Provider authentication failed — check the AI credentials', {
      providerStatus: status,
    });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', 'Provider rate limit reached', { retryable: true, providerStatus: status });
  }
  return null;
}

export function createGeminiAdapter(opts: GeminiOptions): ConversationPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  let lastError: string | null = null;
  const url = (action: string): string => `${base}/models/${encodeURIComponent(opts.model)}:${action}?key=${encodeURIComponent(opts.apiKey)}`;

  return {
    key: 'gemini',
    label: 'AI conversation (Gemini)',
    status(): AdapterStatus {
      const configured = Boolean(opts.apiKey && opts.model);
      return {
        key: 'ai',
        label: 'AI conversation',
        implementation: configured ? 'gemini' : null,
        state: configured ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['call turns', 'qualification extraction'],
        lastError,
      };
    },
    async complete(input): Promise<{ text: string; model: string }> {
      if (!opts.model.trim()) throw new AdapterError('unconfigured', 'No AI model is configured (AI_MODEL)');
      const system = input.messages
        .filter((m) => m.role === 'system')
        .map((m) => m.content)
        .join('\n\n');
      const contents = input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
      if (contents.length === 0) {
        throw new AdapterError('provider_error', 'A conversation needs at least one non-system turn');
      }
      try {
        const res = await requestJson<GenerateContentResponse>(fetchImpl, url('generateContent'), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: {
            contents,
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            generationConfig: {
              maxOutputTokens: input.maxTokens ?? 512,
              temperature: input.temperature ?? 0.4,
            },
          },
        }, mapGeminiStatus);
        const text = (res.candidates?.[0]?.content?.parts ?? [])
          .map((p) => p.text ?? '')
          .join('');
        if (!text) {
          throw new AdapterError('provider_error', 'Model returned no completion text', { providerStatus: 200 });
        }
        lastError = null;
        return { text, model: res.modelVersion ?? opts.model };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },
    async ping(): Promise<PingResult> {
      // Free, read-only endpoint: model metadata.
      await requestJson<unknown>(
        fetchImpl,
        `${base}/models/${encodeURIComponent(opts.model)}?key=${encodeURIComponent(opts.apiKey)}`,
        { method: 'GET', timeoutMs: 8_000 },
        mapGeminiStatus,
      );
      return { ok: true, detail: 'model metadata OK (free endpoint)' };
    },
  };
}
