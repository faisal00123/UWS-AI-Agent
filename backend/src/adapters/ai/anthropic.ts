/**
 * AI conversation adapter — Anthropic Messages API (Phase 11A, Task 2).
 *
 * Same port contract as the OpenAI adapter: the domain composes the system
 * prompt (disclosure, script, objections), this adapter only moves tokens.
 * `system` turns are lifted into the API's dedicated `system` field; the
 * remaining turns map to `messages` (role user/assistant).
 *
 * The API key never leaves this module: it travels in the `x-api-key` header
 * and is excluded from every error (http.ts reports hosts only).
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type ConversationPort, type ConversationTurn, type PingResult } from '../types.ts';

export interface AnthropicOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
  apiVersion?: string;
}

interface MessagesResponse {
  content?: { type?: string; text?: string }[];
  model?: string;
}

const DEFAULT_BASE = 'https://api.anthropic.com';
const DEFAULT_VERSION = '2023-06-01';

function mapAnthropicStatus(status: number): AdapterError | null {
  if (status === 401 || status === 403) {
    return new AdapterError('provider_error', 'Provider authentication failed — check the AI credentials', {
      providerStatus: status,
    });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', 'Provider rate limit reached', { retryable: true, providerStatus: status });
  }
  if (status === 400) {
    return new AdapterError('provider_error', 'Provider rejected the request (bad model or payload)', {
      providerStatus: status,
    });
  }
  return null;
}

export function createAnthropicAdapter(opts: AnthropicOptions): ConversationPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  let lastError: string | null = null;

  const headers = (): Record<string, string> => ({
    'x-api-key': opts.apiKey,
    'anthropic-version': opts.apiVersion ?? DEFAULT_VERSION,
  });

  return {
    key: 'anthropic',
    label: 'AI conversation (Anthropic)',
    status(): AdapterStatus {
      const configured = Boolean(opts.apiKey && opts.model);
      return {
        key: 'ai',
        label: 'AI conversation',
        implementation: configured ? 'anthropic' : null,
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
      const messages = input.messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role, content: m.content }));
      if (messages.length === 0) {
        throw new AdapterError('provider_error', 'A conversation needs at least one non-system turn');
      }
      try {
        const res = await requestJson<MessagesResponse>(fetchImpl, `${base}/v1/messages`, {
          method: 'POST',
          headers: headers(),
          body: {
            model: opts.model,
            max_tokens: input.maxTokens ?? 512,
            temperature: input.temperature ?? 0.4,
            ...(system ? { system } : {}),
            messages,
          },
        }, mapAnthropicStatus);
        const text = (res.content ?? [])
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('');
        if (!text) {
          throw new AdapterError('provider_error', 'Model returned no completion text', { providerStatus: 200 });
        }
        lastError = null;
        return { text, model: res.model ?? opts.model };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },
    async ping(): Promise<PingResult> {
      // Free, read-only endpoint: lists accessible models.
      await requestJson(fetchImpl, `${base}/v1/models?limit=1`, { method: 'GET', headers: headers(), timeoutMs: 8_000 }, mapAnthropicStatus);
      return { ok: true, detail: 'authenticated model listing OK (free endpoint)' };
    },
  };
}

/** Re-exported so the engine layer can narrow turns without importing types.ts twice. */
export type { ConversationTurn };
