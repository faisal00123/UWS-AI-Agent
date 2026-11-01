/**
 * AI conversation adapter — OpenAI-compatible chat completions (Phase 7).
 *
 * Used to generate live call turns and extract qualification data from
 * transcripts. The system prompt (identity disclosure, script, opt-out
 * handling) is composed by the domain layer, not here: the adapter only moves
 * tokens. `baseUrl` + `model` come from `AI_PROVIDER`/`AI_MODEL`, so a
 * self-hosted OpenAI-compatible endpoint works by pointing at it.
 *
 * Not yet wired into the call media pipeline (that lands with live call
 * media); it is exercised by the qualification/extraction entry points and
 * unit tests.
 */
import { requestJson, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type ConversationPort, type ConversationTurn } from '../types.ts';

export interface OpenAIConversationOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: FetchLike;
}

interface ChatResponse {
  choices?: { message?: { content?: string } }[];
  model?: string;
}

const DEFAULT_BASE = 'https://api.openai.com/v1';

export function createOpenAIConversationAdapter(opts: OpenAIConversationOptions): ConversationPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, '');
  let lastError: string | null = null;

  return {
    key: 'openai_chat',
    label: 'AI conversation (OpenAI-compatible)',

    status(): AdapterStatus {
      const configured = Boolean(opts.apiKey && opts.model);
      return {
        key: 'ai',
        label: 'AI conversation',
        implementation: configured ? 'openai_compatible' : null,
        state: configured ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['call turns', 'qualification extraction'],
        lastError,
      };
    },

    async complete(input): Promise<{ text: string; model: string }> {
      if (!opts.model.trim()) {
        throw new AdapterError('unconfigured', 'No AI model is configured (AI_MODEL)');
      }
      try {
        const res = await requestJson<ChatResponse>(fetchImpl, `${base}/chat/completions`, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.apiKey}` },
          body: {
            model: opts.model,
            messages: input.messages satisfies ConversationTurn[],
            max_tokens: input.maxTokens ?? 512,
            temperature: input.temperature ?? 0.4,
          },
        });
        const text = res.choices?.[0]?.message?.content;
        if (typeof text !== 'string') {
          throw new AdapterError('provider_error', 'Model returned no completion text', { providerStatus: 200 });
        }
        lastError = null;
        return { text, model: res.model ?? opts.model };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },

    /**
     * Free connection probe (Phase 11B): lists models (read-only, free).
     * Validates the API key WITHOUT a paid completion.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      if (!opts.apiKey) return { ok: false, detail: 'No AI credentials are configured.' };
      try {
        const res = await requestJson<{ data?: { id?: string }[] }>(
          fetchImpl,
          `${base}/models`,
          { method: 'GET', headers: { authorization: `Bearer ${opts.apiKey}` }, timeoutMs: 8_000 },
          (status) =>
            status === 401 || status === 403
              ? new AdapterError('provider_error', 'Provider authentication failed — check the AI credentials', {
                  providerStatus: status,
                })
              : status === 429
                ? new AdapterError('rate_limited', 'Provider rate limit reached', { retryable: true, providerStatus: status })
                : null,
        );
        const count = Array.isArray(res.data) ? res.data.length : 0;
        lastError = null;
        return { ok: true, detail: `Authenticated model listing OK (${count} models) — free endpoint, no completion billed.` };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
