/**
 * Speech provider dispatch (Phase 11A, Task 3).
 *
 * `STT_PROVIDER` / `TTS_PROVIDER` (either selecting) choose the adapter:
 *   openai - OpenAI-compatible /audio/transcriptions + /audio/speech
 *   mock   - deterministic simulation (no key, no network)
 *
 * Language + voice configuration comes from env (never secrets):
 *   SPEECH_LANGUAGE  default STT language hint: 'en' | 'ur'
 *   SPEECH_VOICE     default TTS voice for the primary language
 *   SPEECH_VOICE_UR  TTS voice used when synthesising Urdu (falls back)
 *   STT_MODEL        transcription model override (default: whisper-1)
 *   TTS_MODEL        synthesis model override (default: tts-1)
 *
 * Key sharing: OpenAI is the AI conversation host AND the speech host, so
 * `AI_API_KEY` doubles as the speech credential when no dedicated speech key
 * is set (or when a dedicated key is a foreign-format one the provider
 * rejects). This is same-vendor sharing, not cross-vendor — no key leaves the
 * platform it belongs to. The adapter fails over once on 401/403 and reports
 * honestly which path it ended up on (variable name only, never the value).
 *
 * Roman Urdu: no STT provider accepts a `roman_ur` language code — the audio
 * of a Roman-Urdu conversation IS Urdu, so STT runs with language 'ur'; the
 * Roman-Urdu TEXT is then handled by the AI conversation layer, which is
 * configured through the `conversation_policy` setting.
 */
import type { SpeechLanguage, SpeechPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createOpenAISpeechAdapter } from './openai.ts';
import { createMockSpeechAdapter } from '../mock/index.ts';

type Env = Record<string, string | undefined>;

export interface SpeechAdapterOptions {
  fetchImpl?: FetchLike;
}

export interface SpeechDefaults {
  language: SpeechLanguage;
  /** Primary voice (English / fallback). */
  voice: string;
  /** Urdu voice (falls back to the primary voice when unset). */
  voiceUr: string;
}

export function speechDefaultsFromEnv(env: Env): SpeechDefaults {
  const language = (env['SPEECH_LANGUAGE'] ?? 'en').trim() === 'ur' ? 'ur' : 'en';
  return {
    language,
    voice: (env['SPEECH_VOICE'] ?? '').trim(),
    voiceUr: (env['SPEECH_VOICE_UR'] ?? '').trim(),
  };
}

/** Voice for a given synthesised text language (provider-neutral selection). */
export function voiceForLanguage(defaults: SpeechDefaults, language?: SpeechLanguage): string | undefined {
  const lang = language ?? defaults.language;
  if (lang === 'ur') return defaults.voiceUr || defaults.voice || undefined;
  return defaults.voice || undefined;
}

export function createSpeechAdapter(env: Env, opts: SpeechAdapterOptions = {}): SpeechPort | null {
  const provider =
    (env['STT_PROVIDER'] ?? '').trim().toLowerCase() || (env['TTS_PROVIDER'] ?? '').trim().toLowerCase();
  if (!provider) return null;

  const defaults = speechDefaultsFromEnv(env);

  switch (provider) {
    case 'mock':
      return createMockSpeechAdapter({ language: defaults.language, voice: defaults.voice || undefined });
    case 'openai': {
      // Dedicated speech keys first; when they are absent (or turn out to be
      // foreign-format keys that OpenAI rejects) the shared AI key covers it —
      // same vendor, same host, same trust boundary. Both are passed through
      // so the adapter can fail over ONCE on 401/403 (auth rejections bill
      // nothing) and stay sticky on the key that actually works.
      const dedicated = (env['STT_API_KEY'] ?? '').trim() || (env['TTS_API_KEY'] ?? '').trim();
      const shared = (env['AI_API_KEY'] ?? '').trim();
      const apiKey = dedicated || shared;
      if (!apiKey) return null;
      return createOpenAISpeechAdapter({
        apiKey,
        ...(shared && shared !== apiKey ? { fallbackApiKey: shared } : {}),
        ...((env['STT_MODEL'] ?? '').trim() ? { sttModel: (env['STT_MODEL'] ?? '').trim() } : {}),
        ...((env['TTS_MODEL'] ?? '').trim() ? { ttsModel: (env['TTS_MODEL'] ?? '').trim() } : {}),
        voice: defaults.voice || undefined,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    default:
      return null;
  }
}

export const SUPPORTED_SPEECH_PROVIDERS = ['openai', 'mock'] as const;
