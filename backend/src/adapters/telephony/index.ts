/**
 * Telephony provider dispatch (Phase 11A, Task 1).
 *
 * `TELEPHONY_PROVIDER` selects the concrete adapter:
 *   twilio - Twilio voice REST API + signed status callbacks
 *   mock   - deterministic simulation (no key, no network)
 *
 * Unknown or missing provider names yield `null` (unconfigured). The inbound
 * leg is provider-neutral: the answer webhook renders our TwiML XML from the
 * domain layer (see webhooks.routes.ts), which is the format Twilio's voice
 * URL consumes; other providers plug in by mapping the same domain answer to
 * their media format when chosen.
 */
import type { TelephonyPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createTwilioAdapter } from './twilio.ts';
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
    default:
      return null;
  }
}

export const SUPPORTED_TELEPHONY_PROVIDERS = ['twilio', 'mock'] as const;
