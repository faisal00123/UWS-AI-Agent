/**
 * AI provider dispatch (Phase 11A, Task 2: multiple AI provider support).
 *
 * `AI_PROVIDER` selects the concrete adapter:
 *   openai    - OpenAI-compatible chat completions (also self-hosted bases)
 *   anthropic - Anthropic Messages API
 *   gemini    - Google Gemini generateContent
 *   mock      - deterministic simulation (no key, no network)
 *
 * Anything else (including empty) yields `null` = unconfigured; the registry
 * reports that honestly instead of guessing a vendor. Credentials are read
 * HERE and live only inside the returned adapter.
 */
import type { ConversationPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createOpenAIConversationAdapter } from './openai.ts';
import { createAnthropicAdapter } from './anthropic.ts';
import { createGeminiAdapter } from './gemini.ts';
import { createMockAIAdapter } from '../mock/index.ts';

type Env = Record<string, string | undefined>;

export interface AiAdapterOptions {
  fetchImpl?: FetchLike;
}

export function createConversationAdapter(env: Env, opts: AiAdapterOptions = {}): ConversationPort | null {
  const provider = (env['AI_PROVIDER'] ?? '').trim().toLowerCase();
  const apiKey = (env['AI_API_KEY'] ?? '').trim();
  const model = (env['AI_MODEL'] ?? '').trim();
  if (!provider) return null;

  switch (provider) {
    case 'mock':
      return createMockAIAdapter();
    case 'openai':
      if (!apiKey || !model) return null;
      return createOpenAIConversationAdapter({
        apiKey,
        model,
        ...(env['AI_BASE_URL'] ? { baseUrl: env['AI_BASE_URL'] } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    case 'anthropic':
      if (!apiKey || !model) return null;
      return createAnthropicAdapter({
        apiKey,
        model,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    case 'gemini':
      if (!apiKey || !model) return null;
      return createGeminiAdapter({
        apiKey,
        model,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    default:
      // Unknown provider name: unconfigured, never a silent wrong guess.
      return null;
  }
}

/** Providers this build can actually talk to (used by .env.example / doctor hints). */
export const SUPPORTED_AI_PROVIDERS = ['openai', 'anthropic', 'gemini', 'mock'] as const;
