/**
 * Telephony provider dispatch (Phase 11A, Task 1).
 *
 * `TELEPHONY_PROVIDER` selects the concrete adapter:
 *   twilio      - Twilio voice REST API + signed status callbacks
 *   cloudyvoice - OUR SIP gateway control API (carrier is SIP-only; see
 *                 adapters/telephony/cloudyvoice.ts and backend/deploy/sip/contract.md)
 *   mock        - deterministic simulation (no key, no network)
 *
 * Unknown or missing provider names yield `null` (unconfigured). The inbound
 * leg is provider-neutral: the answer webhook renders our TwiML XML from the
 * domain layer (see webhooks.routes.ts), which is the format Twilio's voice
 * URL consumes; other providers plug in by mapping the same domain answer to
 * their media format when chosen — the gateway answer route returns the same
 * decision as JSON instructions instead of TwiML.
 */
import type { TelephonyPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createTwilioAdapter } from './twilio.ts';
import { createCloudyVoiceAdapter } from './cloudyvoice.ts';
import { createMockTelephonyAdapter } from '../mock/index.ts';

type Env = Record<string, string | undefined>;

export interface TelephonyAdapterOptions {
  fetchImpl?: FetchLike;
}

export function createTelephonyAdapter(env: Env, opts: TelephonyAdapterOptions = {}): TelephonyPort | null {
  const provider = (env['TELEPHONY_PROVIDER'] ?? '').trim().toLowerCase();
  if (!provider) return null;

  switch (provider) {
    case 'mock':
      return createMockTelephonyAdapter();
    case 'twilio': {
      const accountSid = (env['TELEPHONY_ACCOUNT_SID'] ?? '').trim();
      const authToken = (env['TELEPHONY_AUTH_TOKEN'] ?? '').trim();
      const fromNumber = (env['TELEPHONY_FROM_NUMBER'] ?? '').trim();
      if (!accountSid || !authToken || !fromNumber) return null;
      return createTwilioAdapter({
        accountSid,
        authToken,
        fromNumber,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    case 'cloudyvoice': {
      const gw = gatewayEnvFrom(env);
      if (!gw || !gw.fromNumber) return null;
      return createCloudyVoiceAdapter({
        baseUrl: gw.baseUrl,
        apiToken: gw.apiToken,
        fromNumber: gw.fromNumber,
        timeoutMs: gw.timeoutMs,
        ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      });
    }
    default:
      return null;
  }
}

export interface GatewayControlEnv {
  baseUrl: string;
  apiToken: string;
  fromNumber: string;
  timeoutMs: number;
}

/**
 * Read the gateway control settings from env. Returns null when the gateway
 * URL is absent or is not an absolute http(s) URL — a malformed value is
 * reported as UNCONFIGURED rather than being dialled into a doomed request.
 *
 * Only names of variables are ever surfaced by callers; values stay inside the
 * adapter. `SIP_GATEWAY_EVENT_SECRET` is deliberately NOT read here: it only
 * ever verifies inbound gateway callbacks in the registry.
 */
export function gatewayEnvFrom(env: Env): GatewayControlEnv | null {
  const baseUrl = (env['SIP_GATEWAY_BASE_URL'] ?? '').trim().replace(/\/+$/, '');
  if (!baseUrl) return null;
  if (!/^https?:\/\/.+/i.test(baseUrl)) return null;
  const apiToken = (env['SIP_GATEWAY_API_TOKEN'] ?? '').trim();
  if (!apiToken) return null;
  const rawTimeout = Number(env['SIP_GATEWAY_TIMEOUT_MS'] ?? '');
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout >= 500 && rawTimeout <= 60_000 ? rawTimeout : 10_000;
  return {
    baseUrl,
    apiToken,
    fromNumber: (env['TELEPHONY_FROM_NUMBER'] ?? '').trim(),
    timeoutMs,
  };
}

export const SUPPORTED_TELEPHONY_PROVIDERS = ['twilio', 'cloudyvoice', 'mock'] as const;
