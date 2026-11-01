/**
 * Twilio telephony adapter (Phase 7).
 *
 * Creates outbound calls through Twilio's REST API and validates Twilio's
 * status-callback signatures. Design notes:
 *
 *  - No recording is requested: recording requires prospect consent, which the
 *    platform only honours through an explicit record — so `Record` is never
 *    set by this adapter.
 *  - The auth token is used for BOTH API auth and webhook signature
 *    validation, and never leaves this module (no logs, no error bodies).
 *  - Provider-specific error codes are mapped so callers can distinguish a
 *    bad destination (21211/21217) from an auth problem or a rate limit.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { requestJson, formBody, type FetchLike } from '../http.ts';
import { AdapterError, type AdapterStatus, type TelephonyPort, type CreateCallRequest, type CreateCallResponse } from '../types.ts';

export interface TwilioOptions {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  fetchImpl?: FetchLike;
  /** Override for tests (default https://api.twilio.com). */
  baseUrl?: string;
}

interface TwilioCallResponse {
  sid?: string;
  status?: string;
  code?: number;
  message?: string;
}

/** Map Twilio error codes to adapter semantics. */
function mapTwilioStatus(status: number, body: unknown): AdapterError | null {
  const b = (body ?? {}) as TwilioCallResponse;
  const code = typeof b.code === 'number' ? b.code : null;
  if (code === 21211 || code === 21217 || code === 21606) {
    return new AdapterError('invalid_destination', `The destination number was rejected by the provider (code ${code})`, {
      providerStatus: status,
    });
  }
  if (status === 401 || status === 403) {
    return new AdapterError('provider_error', 'Provider authentication failed — check the telephony credentials', {
      providerStatus: status,
    });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', 'Provider rate limit reached', { retryable: true, providerStatus: status });
  }
  return null;
}

export function createTwilioAdapter(opts: TwilioOptions): TelephonyPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = (opts.baseUrl ?? 'https://api.twilio.com').replace(/\/+$/, '');
  const authHeader = `Basic ${Buffer.from(`${opts.accountSid}:${opts.authToken}`).toString('base64')}`;
  let lastError: string | null = null;

  return {
    key: 'twilio',
    label: 'Twilio (voice)',

    status(): AdapterStatus {
      const configured = Boolean(opts.accountSid && opts.authToken && opts.fromNumber);
      return {
        key: 'telephony',
        label: 'Telephony (calls)',
        implementation: configured ? 'twilio' : null,
        state: configured ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['outbound calls', 'status callbacks', 'call duration events'],
        lastError,
      };
    },

    async createCall(req: CreateCallRequest): Promise<CreateCallResponse> {
      const url = `${base}/2010-04-01/Accounts/${opts.accountSid}/Calls.json`;
      try {
        const res = await requestJson<TwilioCallResponse>(
          fetchImpl,
          url,
          {
            method: 'POST',
            headers: { authorization: authHeader, 'content-type': 'application/x-www-form-urlencoded' },
            body: formBody({
              To: req.to,
              From: opts.fromNumber,
              Url: req.answerUrl,
              StatusCallback: req.statusCallbackUrl,
              Timeout: String(req.timeoutSeconds ?? 30),
              // Custom fields are echoed back on the signed status callback,
              // letting the webhook find the lead without an extra lookup key.
              businessId: req.metadata.businessId,
              attemptId: req.metadata.attemptId,
            }),
          },
          mapTwilioStatus,
        );
        if (!res.sid) {
          throw new AdapterError('provider_error', 'Provider accepted the call but returned no call id', {
            providerStatus: 200,
          });
        }
        lastError = null;
        return { providerCallId: res.sid, status: res.status ?? 'queued' };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },

    /**
     * Free connection probe (Phase 11B): fetches the account record. Validates
     * credentials WITHOUT placing a call or spending money. Never returns or
     * logs the auth token; the response is only checked for an account sid.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      const url = `${base}/2010-04-01/Accounts/${opts.accountSid}.json`;
      try {
        const res = await requestJson<{ sid?: string; status?: string }>(
          fetchImpl,
          url,
          { method: 'GET', headers: { authorization: authHeader }, timeoutMs: 8_000 },
          mapTwilioStatus,
        );
        if (!res.sid) {
          return { ok: false, detail: 'Account endpoint returned no account sid — check credentials.' };
        }
        lastError = null;
        const status = res.status ? ` (account status: ${res.status})` : '';
        return { ok: true, detail: `Authenticated account fetch OK${status} — free endpoint, no call placed.` };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}

/**
 * Validate Twilio's X-Twilio-Signature: base64(HMAC-SHA1(token, url + sorted
 * concatenation of POST params)). For GET requests the params string is empty.
 * The comparison is timing-safe; malformed headers are simply invalid.
 */
export function validateTwilioSignature(
  authToken: string,
  fullUrl: string,
  params: Record<string, string>,
  signatureHeader: string | null,
): boolean {
  if (!signatureHeader || !authToken) return false;
  const keys = Object.keys(params).sort();
  const concat = keys.map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', authToken).update(fullUrl + concat).digest('base64');
  const a = Buffer.from(expected);
  const b = Buffer.from(signatureHeader);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
