/**
 * Speech provider dispatch (Phase 11A, Task 3; extended for ElevenLabs +
 * Deepgram with per-capability selection).
 *
 * `STT_PROVIDER` / `TTS_PROVIDER` choose the adapter PER DIRECTION:
 *   openai      - OpenAI-compatible /audio/transcriptions + /audio/speech
 *   deepgram    - STT only (Deepgram has no TTS product)
 *   elevenlabs  - TTS only (ElevenLabs has no STT product)
 *   mock        - deterministic simulation (no key, no network)
 *
 * When both names resolve to the SAME provider, one adapter instance serves
 * both directions (unchanged behaviour). When they differ, the two
 * single-direction adapters are composed into one SpeechPort: transcribe
 * routes to the STT side, synthesize to the TTS side, status/ping merge both
 * honestly. An unknown provider name (or a missing key) yields null for that
 * direction; if no direction can be built the dispatch returns null, and a
 * capability the chosen provider lacks fails with `unconfigured` — silence
 * and fake transcripts are never substituted.
 *
 * Language + voice configuration comes from env (never secrets):
 *   SPEECH_LANGUAGE  default STT language hint: 'en' | 'ur'
 *   SPEECH_VOICE     default TTS voice for the primary language
 *   SPEECH_VOICE_UR  TTS voice used when synthesising Urdu (falls back)
 *   STT_MODEL        transcription model override (default: whisper-1 / nova-2)
 *   TTS_MODEL        synthesis model override (default: tts-1 / eleven_multilingual_v2)
 *   DEEPGRAM_API_KEY / ELEVENLABS_API_KEY / ELEVENLABS_VOICE_ID / DEEPGRAM_MODEL
 *                    / ELEVENLABS_MODEL  (read from process.env by this
 *                    dispatch, passed as adapter options, never logged)
 *
 * Key sharing: OpenAI is the AI conversation host AND the speech host, so
 * `AI_API_KEY` doubles as the speech credential when no dedicated speech key
 * is set (or when a dedicated key is a foreign-format one the provider
 * rejects). This is same-vendor sharing, not cross-vendor — no key leaves the
 * platform it belongs to. The adapter fails over once on 401/403 and reports
 * honestly which path it ended up on (variable name only, never the value).
 * ElevenLabs/Deepgram keys are vendor-specific and are never shared across
 * vendors.
 *
 * Roman Urdu: no STT provider accepts a `roman_ur` language code — the audio
 * of a Roman-Urdu conversation IS Urdu, so STT runs with language 'ur' (or
 * auto-detects where the provider has no 'ur' code); the Roman-Urdu TEXT is
 * then handled by the AI conversation layer, which is configured through the
 * `conversation_policy` setting.
 */
import type { AdapterStatus, SpeechLanguage, SpeechPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createOpenAISpeechAdapter } from './openai.ts';
import { createElevenLabsSpeechAdapter } from './elevenlabs.ts';
import { createDeepgramSpeechAdapter } from './deepgram.ts';
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
  const language = (env['SPEECH_LANGUAGE'] ?? '').trim() === 'ur' ? 'ur' : 'en';
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

const trim = (env: Env, k: string): string => (env[k] ?? '').trim();

/** Build the adapter that can serve `direction`; null when the provider is
 *  unknown, lacks credentials, or does not offer that capability. */
function buildFor(
  provider: string,
  direction: 'stt' | 'tts',
  env: Env,
  opts: SpeechAdapterOptions,
  defaults: SpeechDefaults,
): SpeechPort | null {
  switch (provider) {
    case 'mock':
      return createMockSpeechAdapter({ language: defaults.language, voice: defaults.voice || undefined });
    case 'openai': {
      // Dedicated speech keys first; when they are absent (or turn out to be
      // foreign-format keys that OpenAI rejects) the shared AI key covers it —
      // same vendor, same host, same trust boundary. Both are passed through
      // so the adapter can fail over ONCE on 401/403 (auth rejections bill
      // nothing) and stay sticky on the key that actually works.
      const dedicated = trim(env, 'STT_API_KEY') || trim(env, 'TTS_API_KEY');
      const shared = trim(env, 'AI_API_KEY');
      const apiKey = dedicated || shared;
      if (!apiKey) return null;
      return createOpenAISpeechAdapter({
        apiKey,
        ...(shared && shared !== apiKey ? { fallbackApiKey: shared } : {}),
        ...(trim(env, 'STT_MODEL') ? { sttModel: trim(env, 'STT_MODEL') } : {}),
        ...(trim(env, 'TTS_MODEL') ? { ttsModel: trim(env, 'TTS_MODEL') } : {}),
        voice: defaults.voice || undefined,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    case 'deepgram': {
      if (direction === 'tts') return null; // Deepgram has no TTS product
      const apiKey = trim(env, 'DEEPGRAM_API_KEY');
      if (!apiKey) return null;
      return createDeepgramSpeechAdapter({
        apiKey,
        ...(trim(env, 'DEEPGRAM_MODEL') ? { model: trim(env, 'DEEPGRAM_MODEL') } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    case 'elevenlabs': {
      if (direction === 'stt') return null; // ElevenLabs has no STT product
      const apiKey = trim(env, 'ELEVENLABS_API_KEY');
      if (!apiKey) return null;
      return createElevenLabsSpeechAdapter({
        apiKey,
        ...(trim(env, 'ELEVENLABS_VOICE_ID') ? { voice: trim(env, 'ELEVENLABS_VOICE_ID') } : {}),
        ...(trim(env, 'ELEVENLABS_MODEL') ? { model: trim(env, 'ELEVENLABS_MODEL') } : {}),
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    default:
      return null;
  }
}

/** Compose two single-direction adapters into one SpeechPort. */
function composite(stt: SpeechPort, tts: SpeechPort): SpeechPort {
  return {
    key: 'speech',
    label: `Speech (${stt.label} + ${tts.label})`,

    status(): AdapterStatus {
      const a = stt.status();
      const b = tts.status();
      const implementation =
        a.implementation && b.implementation && a.implementation !== b.implementation
          ? `${a.implementation}+${b.implementation}`
          : (a.implementation ?? b.implementation);
      const state: AdapterStatus['state'] = a.state === 'error' || b.state === 'error' ? 'error' : 'configured';
      const features = [...new Set([...a.features, ...b.features])];
      const lastError =
        a.lastError && b.lastError ? `${a.lastError} | ${b.lastError}` : (a.lastError ?? b.lastError ?? null);
      return { key: 'speech', label: 'Speech (STT/TTS)', implementation, state, features, lastError };
    },

    transcribe: (input) => stt.transcribe(input),
    synthesize: (input) => tts.synthesize(input),

    async ping(): Promise<{ ok: boolean; detail?: string }> {
      const probe = (p: SpeechPort, tag: string): Promise<{ ok: boolean; detail?: string }> =>
        p.ping ? p.ping() : Promise.resolve({ ok: true, detail: `${tag}: no probe available` });
      const [pa, pb] = await Promise.all([probe(stt, 'STT'), probe(tts, 'TTS')]);
      const parts = [`STT: ${pa.detail ?? (pa.ok ? 'ok' : 'failed')}`, `TTS: ${pb.detail ?? (pb.ok ? 'ok' : 'failed')}`];
      return { ok: pa.ok && pb.ok, detail: parts.join(' | ') };
    },
  };
}

export function createSpeechAdapter(env: Env, opts: SpeechAdapterOptions = {}): SpeechPort | null {
  // Per-direction provider names; each falls back to the other so a single
  // STT_PROVIDER=... (or TTS_PROVIDER=...) still configures both directions
  // through one provider, exactly as before.
  const sttName = trim(env, 'STT_PROVIDER').toLowerCase() || trim(env, 'TTS_PROVIDER').toLowerCase();
  const ttsName = trim(env, 'TTS_PROVIDER').toLowerCase() || trim(env, 'STT_PROVIDER').toLowerCase();
  if (!sttName && !ttsName) return null;

  const defaults = speechDefaultsFromEnv(env);

  // Same provider for both directions: one instance serves both (its own
  // methods honestly reject a direction it does not offer, e.g. deepgram).
  if (sttName === ttsName) {
    return buildFor(sttName, 'stt', env, opts, defaults) ?? buildFor(sttName, 'tts', env, opts, defaults);
  }

  const stt = buildFor(sttName, 'stt', env, opts, defaults);
  const tts = buildFor(ttsName, 'tts', env, opts, defaults);
  if (stt && tts) return composite(stt, tts);
  // Only one direction configured: the other direction fails honestly inside
  // the adapter that WAS built (unconfigured), never silently.
  return stt ?? tts;
}

export const SUPPORTED_SPEECH_PROVIDERS = ['openai', 'deepgram', 'elevenlabs', 'mock'] as const;
