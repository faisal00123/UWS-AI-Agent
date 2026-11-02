/**
 * CloudyVoice telephony adapter — talks to OUR SIP gateway, never to the carrier.
 *
 * CloudyVoice is a SIP *termination carrier* (cloudyvoice.com publishes no HTTP
 * call-placement API): calls leave the platform as SIP/RTP, so a gateway process
 * (Asterisk or FreeSWITCH, decided by the Phase-1 spike) owns signalling and
 * media. This adapter is the backend half of that bridge and speaks only to a
 * control API **we define ourselves** — see `backend/deploy/sip/contract.md`:
 *
 *   GET  ${SIP_GATEWAY_BASE_URL}/v1/health   free liveness + SIP registration
 *   POST ${SIP_GATEWAY_BASE_URL}/v1/calls    originate one call
 *
 * Design notes (mirroring twilio.ts):
 *
 *  - NO CLOUDYVOICE VALUE LIVES HERE. No SIP hostname, port, codec, caller ID or
 *    carrier credential appears in this file — those belong to the gateway's own
 *    configuration (`backend/deploy/sip/`), which is exactly where they must stay.
 *  - `SIP_GATEWAY_API_TOKEN` authenticates us TO our gateway. It never leaves
 *    this module: no logs, no error bodies, no status payloads.
 *  - `ping()` is a FREE health fetch. It never originates a call, so onboarding
 *    verification and the 30-minute health job cannot spend money.
 *  - No recording is ever requested (consent-gated in the domain).
 */
import { requestJson, type FetchLike } from '../http.ts';
import {
  AdapterError,
  type AdapterStatus,
  type TelephonyPort,
  type CreateCallRequest,
  type CreateCallResponse,
} from '../types.ts';

export interface CloudyVoiceOptions {
  /** Base URL of OUR gateway control API (e.g. http://127.0.0.1:8089). */
  baseUrl: string;
  /** Bearer token shared with our gateway — never logged or echoed. */
  apiToken: string;
  /** Caller ID. Must be CLI-approved by CloudyVoice before any live dial. */
  fromNumber: string;
  /** Per-request timeout for gateway control calls. */
  timeoutMs?: number;
  fetchImpl?: FetchLike;
}

interface GatewayCallBody {
  callId?: string;
  status?: string;
  code?: string;
  message?: string;
}

interface GatewayHealthBody {
  ok?: boolean;
  sip?: {
    registered?: boolean;
    transport?: string;
  };
}

/** Map gateway control responses to adapter semantics. */
function mapGatewayStatus(status: number, body: unknown): AdapterError | null {
  const b = (body ?? {}) as GatewayCallBody;
  const nested = (b as { error?: { code?: unknown } }).error;
  const code = typeof nested?.code === 'string' ? nested.code : typeof b.code === 'string' ? b.code : null;
  if (code === 'invalid_destination' || code === 'unroutable') {
    return new AdapterError('invalid_destination', 'The gateway rejected the destination number', {
      providerStatus: status,
    });
  }
  if (status === 401 || status === 403) {
    return new AdapterError('provider_error', 'SIP gateway authentication failed — check SIP_GATEWAY_API_TOKEN', {
      providerStatus: status,
    });
  }
  if (status === 429) {
    return new AdapterError('rate_limited', 'SIP gateway rate limit reached', {
      retryable: true,
      providerStatus: status,
    });
  }
  return null;
}

export function createCloudyVoiceAdapter(opts: CloudyVoiceOptions): TelephonyPort {
  const fetchImpl: FetchLike = opts.fetchImpl ?? ((url, init) => fetch(url, init));
  const base = opts.baseUrl.replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const authHeader = `Bearer ${opts.apiToken}`;
  let lastError: string | null = null;

  return {
    key: 'cloudyvoice',
    label: 'CloudyVoice (SIP via gateway)',

    status(): AdapterStatus {
      const configured = Boolean(opts.baseUrl && opts.apiToken && opts.fromNumber);
      return {
        key: 'telephony',
        label: 'Telephony (calls)',
        implementation: configured ? 'cloudyvoice' : null,
        state: configured ? (lastError ? 'error' : 'configured') : 'unconfigured',
        features: ['outbound calls via SIP gateway', 'call status events', 'media bridge (duplex)'],
        lastError,
      };
    },

    async createCall(req: CreateCallRequest): Promise<CreateCallResponse> {
      const url = `${base}/v1/calls`;
      try {
        const res = await requestJson<GatewayCallBody>(
          fetchImpl,
          url,
          {
            method: 'POST',
            headers: { authorization: authHeader, 'content-type': 'application/json' },
            body: {
              to: req.to,
              from: opts.fromNumber,
              answerUrl: req.answerUrl,
              statusCallbackUrl: req.statusCallbackUrl,
              timeoutSeconds: req.timeoutSeconds ?? 30,
              // Echoed back on the signed status callback so an event finds its
              // attempt without an extra lookup key.
              metadata: { businessId: req.metadata.businessId, attemptId: req.metadata.attemptId },
            },
            timeoutMs,
          },
          mapGatewayStatus,
        );
        if (!res.callId) {
          throw new AdapterError('provider_error', 'The gateway accepted the call but returned no call id', {
            providerStatus: 200,
          });
        }
        lastError = null;
        return { providerCallId: res.callId, status: res.status ?? 'queued' };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        throw err;
      }
    },

    /**
     * Free connection probe: fetches the gateway health record. Proves the
     * gateway is reachable and (when the gateway reports it) that SIP
     * registration to the carrier is up — WITHOUT placing a call or spending
     * money. The token is never included in the returned detail.
     */
    async ping(): Promise<{ ok: boolean; detail?: string }> {
      const url = `${base}/v1/health`;
      try {
        const res = await requestJson<GatewayHealthBody>(
          fetchImpl,
          url,
          { method: 'GET', headers: { authorization: authHeader }, timeoutMs: 8_000 },
          mapGatewayStatus,
        );
        if (res.ok !== true) {
          return { ok: false, detail: 'SIP gateway health endpoint reported not-ok — check the gateway service.' };
        }
        lastError = null;
        const registered = res.sip?.registered;
        const sipNote =
          registered === true
            ? '; SIP registration to the carrier: registered'
            : registered === false
              ? '; SIP registration to the carrier: NOT registered'
              : '; SIP registration state not reported by the gateway';
        return {
          ok: true,
          detail: `Gateway health OK${sipNote} — free endpoint, no call placed.`,
        };
      } catch (err) {
        if (err instanceof AdapterError) lastError = `${err.code}: ${err.message}`;
        const detail = err instanceof AdapterError ? `${err.code}: ${err.message}` : 'Connection probe failed.';
        return { ok: false, detail };
      }
    },
  };
}
