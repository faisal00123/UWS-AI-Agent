# SIP Gateway Control Contract (v1)

**Status: our own contract.** This document defines the API spoken between the
UWS backend and the SIP gateway process that carries CloudyVoice traffic. It is
NOT an API of CloudyVoice — CloudyVoice is a SIP *termination carrier* with no
published HTTP call-placement API; it only ever sees SIP/RTP on the wire.

```
                     ┌────────────────────────────── VPS ──────────────────────────────┐
                     │                                                                  │
  UWS backend ───────┤  control:  GET /v1/health   POST /v1/calls        (our gateway)  │
  (Node, Express)    │  events:   POST /api/webhooks/telephony/gateway/events           │
       │             │  answer:   GET  /api/webhooks/telephony/gateway/answer           │
       │             │  media:    WS   /api/gateway/media                              │
       │             │                                                                  │
       └─────────────┤  gateway (Asterisk/FreeSWITCH) ── SIP/RTP ──► CloudyVoice ──► PSTN│
                     └──────────────────────────────────────────────────────────────────┘
```

Both sides share **two secrets** (never CloudyVoice credentials):

| Secret | Direction | Purpose |
| --- | --- | --- |
| `SIP_GATEWAY_API_TOKEN` | backend → gateway (and gateway → answer URL) | `Authorization: Bearer` on control requests and the answer fetch |
| `SIP_GATEWAY_EVENT_SECRET` | gateway → backend | HMAC-SHA256 signature over the **raw** event body |

---

## 1. Backend → Gateway (control API)

Base URL: `SIP_GATEWAY_BASE_URL` (e.g. `http://127.0.0.1:8089` — loopback when
the gateway runs on the same host as the backend).

All requests carry `Authorization: Bearer ${SIP_GATEWAY_API_TOKEN}`.

### 1.1 `GET /v1/health` — free liveness probe

Used by the onboarding verification and the 30-minute health job. **Never
originates a call.**

```json
200 {
  "ok": true,
  "sip": { "registered": true, "transport": "udp" }
}
```

- `ok` must be `true` for the probe to pass.
- `sip.registered` is the gateway's registration state towards the carrier
  (`true` / `false`, or omit when the gateway does not track it).
- Any `401`/`403` means the token does not match.

### 1.2 `POST /v1/calls` — originate one call

```json
{
  "to": "+923001234567",
  "from": "+922111111111",
  "answerUrl": "https://<public-host>/api/webhooks/telephony/gateway/answer",
  "statusCallbackUrl": "https://<public-host>/api/webhooks/telephony/gateway/events",
  "timeoutSeconds": 30,
  "metadata": { "businessId": "biz_...", "attemptId": "att_..." }
}
```

Success:

```json
200 { "callId": "gw-...", "status": "queued" }
```

- `callId` is **required** in the response; without it the backend treats the
  call as failed (`provider_error`) rather than tracking an invisible call.
- `status` is one of the lifecycle words in §3 when known, else `queued`.
- The gateway MUST echo `metadata` back on the status callback (§2.2) so events
  find their attempt without a second lookup key.
- The backend never requests recording.

Error responses (mapped by the backend adapter):

| HTTP | body | backend mapping |
| --- | --- | --- |
| 400/422 | `{ "error": { "code": "invalid_destination" \| "unroutable" } }` | `invalid_destination` (no retry) |
| 401/403 | any | `provider_error` (check `SIP_GATEWAY_API_TOKEN`) |
| 429 | any | `rate_limited` (retryable) |
| other 4xx/5xx | any | `provider_error` |

---

## 2. Gateway → Backend (webhooks)

Public base: `PUBLIC_BASE_URL`.

### 2.1 `GET /api/webhooks/telephony/gateway/answer` — the answer fetch

The gateway fetches this when the callee answers (outbound) or on an inbound
INVITE (before answering). Auth: `Authorization: Bearer ${SIP_GATEWAY_API_TOKEN}`.

Query: `callId` (required), `from`, `to` (E.164 when known).

**Bridge** (call attributable to a lead AND duplex enabled AND speech+AI ports exist):

```json
200 {
  "action": "bridge",
  "mediaUrl": "wss://<public-host>/api/gateway/media?callSid=...&token=...",
  "greeting": "<AI disclosure> ...",
  "mediaFormat": { "encoding": "audio/x-mulaw", "sampleRate": 8000, "channels": 1 }
}
```

**Hangup** (anything else — unattributable caller, bridge off, error):

```json
200 { "action": "hangup", "greeting": "<fixed approved greeting incl. disclosure>" }
```

Rules:

- The token in `mediaUrl` is signed and expiring (the gateway cannot attach
  headers to a WebSocket upgrade). Use it once, immediately.
- `greeting` must be played to the caller verbatim (it carries the legally
  required AI disclosure). The backend NEVER returns `<Record/>` or any
  recording instruction.
- The gateway MUST transcode to `audio/x-mulaw @ 8000 Hz mono` or refuse the
  bridge — never silently send another codec.
- `401` = bad/absent bearer token. `404` = telephony not configured.

### 2.2 `POST /api/webhooks/telephony/gateway/events` — lifecycle events

Headers: `Content-Type: application/json`,
`X-UWS-Gateway-Signature: <hex HMAC-SHA256 of the RAW body with SIP_GATEWAY_EVENT_SECRET>`.

```json
{
  "eventId": "gw-ev-unique-...",
  "callId": "gw-...",
  "status": "answered",
  "sipCause": 16,
  "durationSeconds": 42,
  "timestamp": "2026-11-03T10:00:00Z"
}
```

- `eventId` and `callId` are both required; without them the backend answers
  `204` and records nothing (a retry can never make such a payload useful).
- `eventId` must be **stable per occurrence** — replays are counted as
  duplicates and change nothing (idempotency).
- Signing is over the exact bytes sent. Re-serialising the JSON invalidates it.
- Response is always `204` on success, `401` on a bad/absent signature (the
  payload is never recorded). The gateway should retry `5xx`/network failures
  with backoff; it should NOT retry `401`/`404`.

---

## 3. Lifecycle vocabulary

`status` (gateway's own word) → backend `calls.status`:

| gateway status | calls.status |
| --- | --- |
| `queued`, `initiating`, `trying`, `routing` | `queued` |
| `ringing`, `early_media` | `ringing` |
| `answered`, `active`, `bridged` | `in_progress` |
| `completed` | `completed` |
| `busy` | `busy` |
| `no_answer`, `timeout` | `no_answer` |
| `failed`, `rejected`, `error` | `failed` |
| `cancelled`, `canceled` | `cancelled` |

`sipCause` (Q.850 / RFC 4499 release cause) is used when `status` is absent or
unrecognised: `16`→completed, `17`→busy, `18/19/20`→no_answer, `21/27/34/38/41/
42/47/50/55/58/86`→failed, `22/28`→failed(wrong_number); anything else→failed.
Outcome (`answered`/`unanswered`/`failed`) is derived from facts only: a
`completed` call with `durationSeconds > 0` is `answered`.

---

## 4. Media WebSocket (`wss://<public>/api/gateway/media?callSid=..&token=..`)

Five gates, in order (each failure is a real HTTP status on the upgrade):
bridge enabled → speech+AI ports exist → token valid for this `callSid` →
call exists in the ledger → no other connection already serves this call
(`409`).

**Gateway → backend** (translated to the session dialect on arrival):

```json
{ "event": "start", "callId": "gw-...", "mediaFormat": { "encoding": "pcmu", "sampleRate": 8000 } }
{ "event": "media", "payload": "<base64 mu-law frame>" }      // or { "event":"audio", ... }
{ "event": "dtmf",  "digit": "2" }                            // or { "event":"digit", ... }
{ "event": "clear" }
{ "event": "hangup", "callId": "gw-..." }                     // or end/bye/stop
```

Accepted aliases: `open`≡`start`, `audio`≡`media` (top-level `payload` also
accepted), `digit`≡`dtmf`, `hangup|end|bye|stop`≡`stop`. `callId`≡`callSid`
everywhere. Encoding aliases `pcmu|ulaw|mulaw|g711u|...` are normalised to
`audio/x-mulaw`; any other codec is passed through so the session refuses it
honestly. Unparseable/unknown frames are dropped, never fatal.

**Backend → gateway** (Twilio Media Streams shape, on purpose — a gateway can be
built by adapting a Twilio Media Streams client):

```json
{ "event": "media", "media": { "payload": "<base64 mu-law frame>" } }
{ "event": "stop",  "stop": { "callSid": "gw-..." } }
```

160-byte frames = 20 ms of 8 kHz mu-law.

---

## 5. Explicit non-goals

- No CloudyVoice credential, hostname, port, codec list or caller ID appears in
  the backend or in this contract — those live only in the gateway's own
  configuration (`deploy/sip/*.sample` placeholders → filled on the VPS).
- The backend never talks SIP and never holds carrier credentials.
- The gateway never receives backend session data beyond what a call needs.
- Nothing here enables live calling: `OPERATING_MODE=simulation` + paused
  outreach still block every dial regardless of configuration.
