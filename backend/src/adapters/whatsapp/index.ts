/**
 * WhatsApp provider dispatch (Phase 11A, Task 4).
 *
 * `WHATSAPP_PROVIDER` selects the concrete adapter:
 *   meta_cloud (aliases: meta, cloud, whatsapp_cloud) - Meta Cloud API
 *   mock                                               - simulation
 *
 * Unknown/missing -> null (unconfigured). Webhook signature verification and
 * the Meta verify-token challenge live with the adapter and the registry.
 */
import type { WhatsAppPort } from '../types.ts';
import type { FetchLike } from '../http.ts';
import { createWhatsAppCloudAdapter } from './cloud.ts';
import { createMockWhatsAppAdapter } from '../mock/index.ts';

type Env = Record<string, string | undefined>;

export interface WhatsAppAdapterOptions {
  fetchImpl?: FetchLike;
}

const META_ALIASES = new Set(['meta', 'meta_cloud', 'cloud', 'whatsapp_cloud']);

export function createWhatsAppAdapter(env: Env, opts: WhatsAppAdapterOptions = {}): WhatsAppPort | null {
  const provider = (env['WHATSAPP_PROVIDER'] ?? '').trim().toLowerCase();
  if (!provider) return null;

  if (provider === 'mock') return createMockWhatsAppAdapter();

  if (META_ALIASES.has(provider)) {
    const phoneNumberId = (env['WHATSAPP_PHONE_NUMBER_ID'] ?? '').trim();
    const accessToken = (env['WHATSAPP_ACCESS_TOKEN'] ?? '').trim();
    if (!phoneNumberId || !accessToken) return null;
    return createWhatsAppCloudAdapter({
      phoneNumberId,
      accessToken,
      appSecret: (env['WHATSAPP_APP_SECRET'] ?? '').trim(),
      businessAccountId: (env['WHATSAPP_BUSINESS_ACCOUNT_ID'] ?? '').trim(),
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
    });
  }

  return null;
}

export const SUPPORTED_WHATSAPP_PROVIDERS = ['meta_cloud', 'mock'] as const;
