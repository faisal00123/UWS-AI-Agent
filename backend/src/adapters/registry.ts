/**
 * Adapter registry v2 (Phase 11A, Task 8).
 *
 * One object, built once at bootstrap from (config, env), that answers four
 * questions:
 *   - which adapter should serve each port RIGHT NOW (null when unconfigured)?
 *   - what is the honest status of each integration (no secret values)?
 *   - do provider webhooks have the signing secrets they need to VERIFY
 *     callbacks (never exposed outside this module)?
 *   - is this specific operation ALLOWED right now (enable/disable toggle)?
 *
 * Phase 11A additions over the Phase 7 registry:
 *   - provider dispatch: `<X>_PROVIDER` env selects the concrete adapter
 *     (twilio/meta_cloud/openai/anthropic/gemini/smtp/mock); unknown names
 *     yield `null` = unconfigured — never a silent guess;
 *   - every returned port is DECORATED with:
 *       * enable/disable gate (`isEnabled` callback, wired from app.ts with a
 *         db-backed closure — a disabled integration fails fast with
 *         `unconfigured` and never touches the network);
 *       * per-integration rate limiting (TokenBucket, applies to every op
 *         including paid ones — throttling is always safe);
 *       * bounded retry for IDEMPOTENT operations only (AI completions,
 *         transcribe, synthesize, discovery search, health probes). Paid
 *         non-idempotent actions (createCall, sendTemplate) are NOT retried
 *         by the registry — a retry there could double-charge or double-
 *         contact a lead; the domain guard owns re-dial policy.
 *   - usage recording: every operation (ok/error/rate_limited/disabled) is
 *     reported through `onUsage` for the `adapter_usage` table.
 *
 * Env — including credential values — is read here at construction and kept
 * inside the concrete adapters; `Config` itself never gains secret fields, so
 * no route can accidentally serialize a token by rendering config.
 */
import type { Config } from '../core/config.ts';
import {
  AdapterError,
  type AdapterStatus,
  type ConversationPort,
  type CreateCallRequest,
  type CreateCallResponse,
  type DiscoveryHit,
  type DiscoveryPort,
  type DiscoveryQuery,
  type EmailMessage,
  type EmailPort,
  type FetchLike,
  type PingResult,
  type SendTemplateRequest,
  type SendTemplateResponse,
  type SpeechPort,
  type TelephonyPort,
  type WhatsAppPort,
} from './types.ts';
import { validateTwilioSignature } from './telephony/twilio.ts';
import { createUnconfiguredDiscovery } from './discovery/unconfigured.ts';
import { createTelephonyAdapter } from './telephony/index.ts';
import { createWhatsAppAdapter } from './whatsapp/index.ts';
import { createConversationAdapter } from './ai/index.ts';
import { createSpeechAdapter, speechDefaultsFromEnv, voiceForLanguage, type SpeechDefaults } from './speech/index.ts';
import { createEmailAdapter } from './email/index.ts';
import { createDiscoveryAdapter } from './discovery/index.ts';
import { RateLimiter, withRetry } from './resilience.ts';

type Env = Record<string, string | undefined>;

export type IntegrationKey = 'telephony' | 'whatsapp' | 'ai' | 'speech' | 'email' | 'discovery';

export const INTEGRATION_KEYS: readonly IntegrationKey[] = [
  'telephony',
  'whatsapp',
  'ai',
  'speech',
  'email',
  'discovery',
] as const;

/** One usage record per outbound adapter operation (persisted by the domain). */
export interface AdapterUsageEvent {
  integration: IntegrationKey;
  operation: string;
  outcome: 'ok' | 'error' | 'rate_limited' | 'disabled';
  errorCode?: string | null;
  durationMs: number;
  retries: number;
  occurredAt: Date;
}

export interface AdapterRegistryHooks {
  /** False when the owner disabled this integration in settings. Default: true. */
  isEnabled?: (key: IntegrationKey) => boolean;
  /** Called once per adapter operation; the domain persists it. Must never throw. */
  onUsage?: (event: AdapterUsageEvent) => void;
}

export interface AdapterRegistry {
  telephony: TelephonyPort | null;
  whatsapp: WhatsAppPort | null;
  ai: ConversationPort | null;
  speech: SpeechPort | null;
  email: EmailPort | null;
  discovery: DiscoveryPort;
  /** Speech voice/language defaults resolved from env (never secrets). */
  speechDefaults: SpeechDefaults;
  /** Status list for the Integrations page (secret-free). */
  statuses(): AdapterStatus[];
  /** Verify a Twilio callback signature; false when unconfigured. */
  verifyTwilioSignature(fullUrl: string, params: Record<string, string>, signature: string | null): boolean;
  /** Verify Meta's X-Hub-Signature-256 over the raw body; false when unconfigured. */
  verifyWhatsAppSignature(rawBody: Buffer, signature: string | null): boolean;
  /** Meta webhook subscription challenge token, or null. */
  whatsappVerifyToken: string | null;
  /** TwiML answer URL for outbound calls, or null when telephony is absent. */
  voiceAnswerUrl: string | null;
  /** Template + language used for portfolio shares. */
  portfolioTemplate: { name: string; language: string } | null;
}

const pick = (env: Env, key: string): string => (env[key] ?? '').trim();

export interface BuildRegistryOptions extends AdapterRegistryHooks {
  fetchImpl?: FetchLike;
  /** Total attempts for idempotent ops (default from env, else 2). */
  retryAttempts?: number;
  /** Operations per minute per integration (default from env, else 60). */
  ratePerMinute?: number;
}

/** Operations that are safe to retry automatically (idempotent by nature). */
const IDEMPOTENT_OPS = new Set([
  'complete',
  'transcribe',
  'synthesize',
  'search',
  'ping',
]);

function noopUsage(): void {
  /* usage recording is optional */
}

export function buildRegistry(cfg: Config, env: Env = process.env, opts: BuildRegistryOptions = {}): AdapterRegistry {
  const f = opts.fetchImpl;
  const isEnabled = opts.isEnabled ?? ((): boolean => true);
  const onUsage = opts.onUsage ?? noopUsage;

  const retryAttempts = Math.max(
    1,
    opts.retryAttempts ?? Number(pick(env, 'ADAPTER_RETRY_ATTEMPTS') || '2'),
  );
  const ratePerMinute = Math.max(
    1,
    opts.ratePerMinute ?? Number(pick(env, 'ADAPTER_RATE_LIMIT_PER_MIN') || '60'),
  );

  // One bucket per integration key; throttling is always safe (a refused
  // call simply never happens) so it wraps EVERY operation.
  const limiter = new RateLimiter(ratePerMinute, ratePerMinute);

  /**
   * Decorate one port method: enable gate -> rate limit -> optional retry ->
   * usage record. `op` is the operation name recorded in `adapter_usage`.
   */
  function decorate<A extends unknown[], R>(
    key: IntegrationKey,
    op: string,
    fn: (...args: A) => Promise<R>,
  ): (...args: A) => Promise<R> {
    const idempotent = IDEMPOTENT_OPS.has(op);
    return async (...args: A): Promise<R> => {
      const started = Date.now();
      const record = (
        outcome: AdapterUsageEvent['outcome'],
        errorCode: string | null,
        retries: number,
      ): void => {
        try {
          onUsage({
            integration: key,
            operation: op,
            outcome,
            errorCode,
            durationMs: Date.now() - started,
            retries,
            occurredAt: new Date(),
          });
        } catch {
          /* usage accounting must never break the operation */
        }
      };

      if (!isEnabled(key)) {
        record('disabled', 'disabled', 0);
        throw new AdapterError('unconfigured', `The ${key} integration is disabled in settings`);
      }
      if (!limiter.tryRemove(key)) {
        record('rate_limited', 'rate_limited', 0);
        throw new AdapterError('rate_limited', `Rate limit reached for ${key}; retry shortly`, { retryable: true });
      }

      try {
        if (idempotent) {
          const { value, retries } = await withRetry(() => fn(...args), { attempts: retryAttempts });
          record('ok', null, retries);
          return value;
        }
        const value = await fn(...args);
        record('ok', null, 0);
        return value;
      } catch (err) {
        const code = err instanceof AdapterError ? err.code : 'provider_error';
        record('error', code, 0);
        throw err;
      }
    };
  }

  // ---------------------------------------------------------- telephony ----
  const rawTelephony = createTelephonyAdapter(env, f ? { fetchImpl: f } : {});
  const telephony: TelephonyPort | null = rawTelephony
    ? {
        key: rawTelephony.key,
        label: rawTelephony.label,
        status: () => decorateStatus('telephony', rawTelephony.status(), isEnabled),
        createCall: decorate('telephony', 'createCall', (req: CreateCallRequest) =>
          rawTelephony.createCall(req),
        ),
        ...(rawTelephony.ping
          ? {
              ping: decorate('telephony', 'ping', () =>
                rawTelephony.ping!(),
              ),
            }
          : {}),
      }
    : null;

  // ----------------------------------------------------------- whatsapp ----
  const rawWhatsapp = createWhatsAppAdapter(env, f ? { fetchImpl: f } : {});
  const whatsapp: WhatsAppPort | null = rawWhatsapp
    ? {
        key: rawWhatsapp.key,
        label: rawWhatsapp.label,
        status: () => decorateStatus('whatsapp', rawWhatsapp.status(), isEnabled),
        sendTemplate: decorate('whatsapp', 'sendTemplate', (req: SendTemplateRequest) =>
          rawWhatsapp.sendTemplate(req),
        ),
        verifySignature: (rawBody: Buffer, signature: string | null) =>
          rawWhatsapp.verifySignature(rawBody, signature),
        ...(rawWhatsapp.ping
          ? { ping: decorate('whatsapp', 'ping', () => rawWhatsapp.ping!()) }
          : {}),
      }
    : null;

  // --------------------------------------------------------------- ai ------
  const rawAi = createConversationAdapter(env, f ? { fetchImpl: f } : {});
  const ai: ConversationPort | null = rawAi
    ? {
        key: rawAi.key,
        label: rawAi.label,
        status: () => decorateStatus('ai', rawAi.status(), isEnabled),
        complete: decorate('ai', 'complete', (input) => rawAi.complete(input)),
        ...(rawAi.ping ? { ping: decorate('ai', 'ping', () => rawAi.ping!()) } : {}),
      }
    : null;

  // ------------------------------------------------------------ speech ----
  const rawSpeech = createSpeechAdapter(env, f ? { fetchImpl: f } : {});
  const speech: SpeechPort | null = rawSpeech
    ? {
        key: rawSpeech.key,
        label: rawSpeech.label,
        status: () => decorateStatus('speech', rawSpeech.status(), isEnabled),
        transcribe: decorate('speech', 'transcribe', (input) => rawSpeech.transcribe(input)),
        synthesize: decorate('speech', 'synthesize', (input) =>
          rawSpeech.synthesize({
            ...input,
            voice: input.voice ?? voiceForLanguage(speechDefaults, input.language),
          }),
        ),
        ...(rawSpeech.ping ? { ping: decorate('speech', 'ping', () => rawSpeech.ping!()) } : {}),
      }
    : null;

  // ------------------------------------------------------------- email ----
  const rawEmail = createEmailAdapter(env);
  const email: EmailPort | null = rawEmail
    ? {
        key: rawEmail.key,
        label: rawEmail.label,
        status: () => decorateStatus('email', rawEmail.status(), isEnabled),
        send: decorate('email', 'send', (msg: EmailMessage) => rawEmail.send(msg)),
        ...(rawEmail.ping ? { ping: decorate('email', 'ping', () => rawEmail.ping!()) } : {}),
      }
    : null;

  // ----------------------------------------------------------- discovery ---
  // Phase 12: the injected transport must reach the discovery adapter too —
  // the Overpass adapter is a real HTTP client and tests inject a fake fetch.
  const rawDiscovery = createDiscoveryAdapter(env, f ? { fetchImpl: f } : {});
  const discovery: DiscoveryPort = {
    key: rawDiscovery.key,
    label: rawDiscovery.label,
    status: () => decorateStatus('discovery', rawDiscovery.status(), isEnabled),
    search: decorate('discovery', 'search', (q: DiscoveryQuery) => rawDiscovery.search(q)),
    ...(rawDiscovery.ping ? { ping: decorate('discovery', 'ping', () => rawDiscovery.ping!()) } : {}),
  };

  const speechDefaults = speechDefaultsFromEnv(env);

  const registry: AdapterRegistry = {
    telephony,
    whatsapp,
    ai,
    speech,
    email,
    discovery,
    speechDefaults,

    statuses(): AdapterStatus[] {
      const list: AdapterStatus[] = [];
      list.push(
        telephony
          ? telephony.status()
          : {
              key: 'telephony',
              label: 'Telephony (calls)',
              implementation: null,
              state: isEnabled('telephony') ? 'unconfigured' : 'disabled',
              features: ['outbound calls', 'status callbacks', 'duration tracking'],
              lastError: null,
            },
      );
      list.push(
        whatsapp
          ? whatsapp.status()
          : {
              key: 'whatsapp',
              label: 'WhatsApp Business',
              implementation: null,
              state: isEnabled('whatsapp') ? 'unconfigured' : 'disabled',
              features: [
                'portfolio messages',
                'delivery events',
                'inbound replies & opt-outs',
                'template management',
              ],
              lastError: null,
            },
      );
      list.push(
        ai
          ? ai.status()
          : {
              key: 'ai',
              label: 'AI conversation',
              implementation: null,
              state: isEnabled('ai') ? 'unconfigured' : 'disabled',
              features: ['call turns', 'qualification extraction', 'objection handling'],
              lastError: null,
            },
      );
      list.push(
        speech
          ? speech.status()
          : {
              key: 'speech',
              label: 'Speech (STT/TTS)',
              implementation: null,
              state: isEnabled('speech') ? 'unconfigured' : 'disabled',
              features: ['transcription', 'voice synthesis', 'ur + en'],
              lastError: null,
            },
      );
      list.push(
        email
          ? email.status()
          : {
              key: 'email',
              label: 'Email (SMTP)',
              implementation: null,
              state: isEnabled('email') ? 'unconfigured' : 'disabled',
              features: ['owner notifications', 'daily report email', 'delivery status'],
              lastError: null,
            },
      );
      list.push(discovery.status());
      return list;
    },

    verifyTwilioSignature(fullUrl, params, signature): boolean {
      if (!rawTelephony) return false;
      const token = pick(env, 'TELEPHONY_AUTH_TOKEN');
      if (!token) return false;
      return validateTwilioSignature(token, fullUrl, params, signature);
    },

    verifyWhatsAppSignature(rawBody, signature): boolean {
      if (!rawWhatsapp) return false;
      return rawWhatsapp.verifySignature(rawBody, signature);
    },

    whatsappVerifyToken: pick(env, 'WHATSAPP_WEBHOOK_VERIFY_TOKEN') || null,

    voiceAnswerUrl: rawTelephony ? `${cfg.publicBaseUrl}/api/webhooks/telephony/twilio/voice` : null,

    portfolioTemplate:
      rawWhatsapp && pick(env, 'WHATSAPP_TEMPLATE_NAME_PORTFOLIO')
        ? {
            name: pick(env, 'WHATSAPP_TEMPLATE_NAME_PORTFOLIO'),
            language: pick(env, 'WHATSAPP_TEMPLATE_LANGUAGE') || 'en',
          }
        : null,
  };

  return registry;
}

/** Report 'disabled' in the status when the toggle is off (regardless of config). */
function decorateStatus(
  _key: IntegrationKey,
  status: AdapterStatus,
  isEnabled: (key: IntegrationKey) => boolean,
): AdapterStatus {
  // `status.key` is the integration key string used by each adapter.
  const integration = status.key as IntegrationKey;
  if (!isEnabled(integration)) {
    return { ...status, state: 'disabled' };
  }
  return status;
}

/** A registry with nothing configured — the default for tests/simulation. */
export function emptyRegistry(cfg: Config): AdapterRegistry {
  return buildRegistry(cfg, {}, {});
}

export type { AdapterStatus, PingResult };
