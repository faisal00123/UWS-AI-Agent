/**
 * WhatsApp Business Cloud API adapter (Phase 7).
 *
 * Sends the owner-approved portfolio template and verifies Meta's
 * signatures. Notes:
 *
 *  - Only TEMPLATES may be sent for outreach (Meta policy + our own rule that
 *    free-form text to a prospect who has not messaged us first is not
 *    permitted); this adapter therefore exposes `sendTemplate` only.
 *  - `verifySignature` implements X-Hub-Signature-256 (HMAC-SHA256 over the
 *    RAW body with the app secret) with a timing-safe compare — without the
 *    app secret configured it returns false, i.e. webhooks are refused rather
 *    than accepted unverified.
 *  - The access token never appears in errors or logs.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson, type FetchLike } from '../http.ts';
import {
  AdapterError,
  type AdapterStatus,
  type TemplateApprovalCheck,
  type WhatsAppPort,
  type SendTemplateRequest,
  type SendTemplateResponse,
} from '../types.ts';

export interface WhatsAppCloudOptions {
  phoneNumberId: string;
  accessToken: string;
  appSecret: string;
  /** WABA id — used by the pre-send template approval check (read-only GET). */
  businessAccountId?: string;
  fetchImpl?: FetchLike;
  /** Override for tests (default https://graph.facebook.com). */
  baseUrl?: string;
  apiVersion?: string;
}

interface MetaResponse {
  messages?: { id?: string }[];
  error?: { message?: string; code?: number };
}

export function createWhatsAppCloudAdapter(opts: WhatsAppCloudOptions): WhatsAppPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? 'https://graph.facebook.com').replace(/\/+$/, '');
  const version = opts.apiVersion ?? 'v20.0';
  let lastError: string | null = null;

  return {
    key: 'whatsapp_cloud',
    label: 'WhatsApp Business (Cloud API)',

    status(): AdapterStatus {
      const configured = Boolean(opts.phoneNumberId && opts.accessToken && opts.appSecret);
      return {
        key: 'whatsapp',
        label: 'WhatsApp Business',
        implementation: configured ? 'whatsapp_cloud' : null,
        state: configured ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['template messages', 'delivery events', 'inbound replies & opt-outs'],
        lastError,
      };
    },

    async sendTemplate(req: SendTemplateRequest): Promise<SendTemplateResponse> {
      if (!req.templateName.trim()) {
        throw new AdapterError(
          'unconfigured',
          'No portfolio message template is configured (WHATSAPP_TEMPLATE_NAME_PORTFOLIO). Meta requires an approved template before anything can be sent.',
        );
      }
      const url = `${base}/${version}/${opts.phoneNumberId}/messages`;
      try {
        const res = await requestJson<MetaResponse>(fetchImpl, url, {
          method: 'POST',
          headers: { authorization: `Bearer ${opts.accessToken}` },
          body: {
            messaging_product: 'whatsapp',
            to: req.to,
            type: 'template',
            template: {
              name: req.templateName,
              language: { code: req.languageCode },
              ...(req.bodyParams && req.bodyParams.length > 0
                ? {
                    components: [
                      {
                        type: 'body',
                        parameters: req.bodyParams.map((t) => ({ type: 'text', text: t })),
                      },
                    ],
                  }
                : {}),
            },
          },
        });
        const id = res.messages?.[0]?.id;
        if (!id) {
          throw new AdapterError('provider_error', 'Provider accepted the message but returned no message id', {
            providerStatus: 200,
          });
        }
        lastError = null;
        return { providerMessageId: id, status: 'accepted' };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },

    /**
     * Pre-send approval gate (read-only GET): fetch the WABA's message
     * templates and confirm the EXACT configured template is APPROVED in the
     * configured language. Any failure — PENDING/REJECTED/missing/mismatch,
     * a missing WABA id, a non-2xx response or a network error — returns
     * `ok: false` so the caller blocks the send. Never throws, never retries
     * into a send, and the token never appears in the result or errors.
     */
    async verifyTemplate(name: string, language: string): Promise<TemplateApprovalCheck> {
      const wanted = name.trim();
      const wantedLang = language.trim();
      if (!wanted || !wantedLang) {
        return {
          ok: false,
          status: 'UNVERIFIABLE',
          detail: 'No template name/language is configured — approval cannot be verified.',
        };
      }
      const waba = (opts.businessAccountId ?? '').trim();
      if (!waba) {
        return {
          ok: false,
          status: 'UNVERIFIABLE',
          detail: 'WHATSAPP_BUSINESS_ACCOUNT_ID is not configured — approval cannot be verified.',
        };
      }
      const url = `${base}/${version}/${waba}/message_templates?fields=name,status,language&limit=100`;
      let body: { data?: { name?: string; status?: string; language?: string }[] };
      try {
        body = await requestJson<{ data?: { name?: string; status?: string; language?: string }[] }>(
          fetchImpl,
          url,
          { method: 'GET', headers: { authorization: `Bearer ${opts.accessToken}` }, timeoutMs: 8_000 },
        );
      } catch (err) {
        // requestJson messages carry the host only — never credentials.
        const detail = err instanceof AdapterError ? err.message : 'template status check failed';
        return { ok: false, status: 'UNVERIFIABLE', detail: `Template approval check failed (${detail}).` };
      }
      const list = Array.isArray(body?.data) ? body.data : [];
      const hit = list.find((t) => t?.name === wanted);
      if (!hit) {
        return {
          ok: false,
          status: 'MISSING',
          detail: `Template '${wanted}' is not present on this WhatsApp business account.`,
        };
      }
      const status = (hit.status ?? 'UNKNOWN').toUpperCase();
      if (status !== 'APPROVED') {
        return { ok: false, status, detail: `Template '${wanted}' status is ${status}, not APPROVED.` };
      }
      if ((hit.language ?? '') !== wantedLang) {
        return {
          ok: false,
          status: 'LANGUAGE_MISMATCH',
          detail: `Template '${wanted}' is '${hit.language ?? 'unknown'}' but '${wantedLang}' is configured.`,
        };
      }
      return { ok: true, status: 'APPROVED', detail: `Template '${wanted}' is APPROVED in ${wantedLang}.` };
    },

    verifySignature(rawBody: Buffer, signatureHeader: string | null): boolean {
      if (!opts.appSecret || !signatureHeader) return false;
      const expected = `sha256=${createHmac('sha256', opts.appSecret).update(rawBody).digest('hex')}`;
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(signatureHeader, 'utf8');
      if (a.length !== b.length) return false;
      return timingSafeEqual(a, b);
    },

    /**
     * Free connection probe (Phase 11B): fetches the phone-number record.
     * Validates the access token + phone-number id WITHOUT sending any
     * message. The token never appears in the result or in errors.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      const url = `${base}/${version}/${opts.phoneNumberId}`;
      try {
        const res = await requestJson<{ id?: string; display_phone_number?: string }>(
          fetchImpl,
          url,
          { method: 'GET', headers: { authorization: `Bearer ${opts.accessToken}` }, timeoutMs: 8_000 },
          (status) =>
            status === 401 || status === 403
              ? new AdapterError('provider_error', 'Provider authentication failed — check the WhatsApp credentials', {
                  providerStatus: status,
                })
              : status === 429
                ? new AdapterError('rate_limited', 'Provider rate limit reached', { retryable: true, providerStatus: status })
                : null,
        );
        if (!res.id) {
          return { ok: false, detail: 'Phone-number endpoint returned no id — check credentials.' };
        }
        lastError = null;
        const shown = typeof res.display_phone_number === 'string' ? ' (number on record)' : '';
        return { ok: true, detail: `Authenticated phone-number fetch OK${shown} — free endpoint, no message sent.` };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
