# CloudyVoice SIP integration

**Status: implemented on our side, NOT connected to the carrier.**
CloudyVoice has issued no credentials yet, no SIP registration has occurred, and
no test call has been placed. Nothing in this document may be read as "calling
works" — the backend half is complete and test-verified; the carrier half is
blocked on onboarding.

## 1. What CloudyVoice is (public facts only)

From cloudyvoice.com:

- a **SIP termination carrier** (wholesale voice), not a CPaaS — there is **no
  published HTTP API for placing calls**;
- authentication is **SIP registration or static IP**, not API keys;
- destinations in **E.164**; Pakistan (+92) from **$0.026/min**; **KYC
  required** before service;
- codecs, transport, DTMF, channels, CPS, billing increment, CDR format are
  "confirmed during onboarding" — i.e. **not published**, therefore never
  assumed here;
- publishes support for **Asterisk and FreeSWITCH**;
- sales contact: sales@cloudyvoice.com.

Because there is no carrier HTTP API, calls cannot leave this platform the way
Twilio calls do. They leave through a **gateway process we run** that speaks
SIP/RTP to CloudyVoice and speaks *our own* contract to the backend.

## 2. Architecture

```
  Vercel (SPA) ──/api/*──► backend (Node, one host)
                             │  control: POST /v1/calls, GET /v1/health
                             │  answer : GET  …/gateway/answer   (bearer)
                             │  events : POST …/gateway/events   (HMAC)
                             │  media  : wss://…/api/gateway/media
                             ▼
                     gateway (Asterisk/FreeSWITCH + bridge, VPS)
                             │  SIP/RTP
                             ▼
                     CloudyVoice ──► PSTN
```

Design rules (all enforced in code):

1. **The gateway speaks our contract** (`backend/deploy/sip/contract.md`), never
   CloudyVoice's undocumented behaviour. The carrier only ever sees SIP/RTP.
2. **No carrier value lives in the backend** — no SIP hostname, port, codec,
   caller ID or credential appears anywhere in `backend/src`. Those live only
   in `backend/deploy/sip/*.sample` → filled copies on the VPS.
3. **One conversation pipeline.** The gateway media bridge translates its wire
   dialect into the exact events `createDuplexSession` already consumes, so
   SIP calls run the same VAD → STT (OpenAI) → engine → TTS → transcript →
   qualification → opt-out path as Twilio calls. There is no second pipeline.
4. **Twilio stays fully intact.** `TELEPHONY_PROVIDER=twilio` restores the
   previous behaviour byte-for-byte (proven by tests that assert the exact
   historical webhook URLs).

## 3. What is implemented (backend, this repo)

| Area | File | Behaviour |
|---|---|---|
| Adapter | `src/adapters/telephony/cloudyvoice.ts` | `TelephonyPort` over the gateway control API: bearer auth, error mapping (401/403→provider_error, `invalid_destination`/`unroutable`→invalid_destination, 429→rate_limited), free `ping()` on `/v1/health` reporting SIP registration state, token never logged |
| Dispatch | `src/adapters/telephony/index.ts` | `case 'cloudyvoice'`, `gatewayEnvFrom()` (rejects non-http URLs, clamps timeout 500–60000 ms, default 10000), `SUPPORTED_TELEPHONY_PROVIDERS` |
| Registry | `src/adapters/registry.ts` | provider-driven `voiceAnswerUrl`/`voiceStatusUrl` (gateway paths vs Twilio's byte-identical paths), `verifyGatewayControlAuth` (timing-safe bearer), `verifyGatewayEventSignature` (HMAC-SHA256 over raw body, timing-safe) |
| Config | `src/core/config.ts` | 4 new env vars (`SIP_GATEWAY_BASE_URL/API_TOKEN/EVENT_SECRET/TIMEOUT_MS`), malformed gateway URL fails fast, provider-aware telephony status (gateway needs gateway names, not Twilio's) |
| Answer + events | `src/http/routes/gateway.routes.ts` | `GET …/gateway/answer` (bearer → `{action:'bridge', mediaUrl, greeting, mediaFormat}` or `{action:'hangup', greeting}`), `POST …/gateway/events` (HMAC → idempotent ingest under `provider='cloudyvoice'`) |
| Media bridge | `src/server/gatewaymedia.ts` | `wss://…/api/gateway/media`, same 5 upgrade gates as the Twilio bridge, dialect translation (`open/audio/digit/hangup` aliases, `callId`↔`callSid`, `pcmu` aliases→`audio/x-mulaw`, other codecs passed through so the session refuses them honestly) |
| Two bridges, one server | `src/server/upgrade.ts` | upgrade claim/fallback so `/api/media` (Twilio) and `/api/gateway/media` coexist; unknown paths 404 instead of hanging |
| Lifecycle events | `src/domain/outreach/gatewayevents.ts` | gateway status vocabulary + Q.850 SIP cause table → `calls` ledger transitions; outcomes derived from facts only (duration decides answered) |
| Domain | `src/domain/outreach/service.ts` | `voiceStatusUrl` supplied by the registry (Twilio-path compatibility fallback keeps hand-built adapter maps working) |
| Inbound attribution | `src/domain/media/duplex.ts` | `resolveCallForAnswer({provider})` labels inbound ledger rows with the real carrier (`cloudyvoice`, default `twilio`) |
| Diagnostics | `src/cli/doctor.ts` | "SIP gateway" section: variable **names** + presence only, plus explicit "CloudyVoice NOT verified" warning |
| Env template | `backend/.env.example` | gateway block with empty values; Twilio block untouched |
| Tests | `tests/unit/adapters-cloudyvoice.test.ts` (19), `tests/integration/gateway.test.ts` (14) | request construction/auth/error mapping, registry URL selection proving Twilio byte-identical, timing-safe verification, full SIP-dialect conversation over a real WebSocket, signed events (apply/replay/tamper/orphan), upgrade gating, unknown path 404, Twilio route untouched |

Full suite after this work: **573 pass / 87 suites / 0 fail**, typecheck 0.

## 4. Required values (BLOCKED — carrier onboarding)

None of these may be invented; each is either printed by `npm run doctor`
(backend side, names only) or belongs in the gateway config on the VPS:

**From CloudyVoice (their onboarding):**
1. SIP proxy hostname/IPs + port + transport (UDP/TCP/TLS)
2. auth mode: SIP credentials **or** static-IP allowlist (+ their network IP list)
3. confirmed codec list, DTMF mode, channels/CPS limits
4. DID (if inbound wanted) + **CLI/caller-ID approval for Pakistan**
5. rate deck / billing increment / CDR format
6. KYC completion

**From us (owner generates, no carrier):**
7. `SIP_GATEWAY_API_TOKEN` — backend ↔ gateway bearer (`.env.example` shows how)
8. `SIP_GATEWAY_EVENT_SECRET` — HMAC secret for signed gateway events
9. a VPS with public IP + Asterisk/FreeSWITCH (Phase-1 spike decides which)

**Backend `.env` when the gateway exists:**

```ini
TELEPHONY_PROVIDER=cloudyvoice
TELEPHONY_FROM_NUMBER=            # CLI-approved E.164, from item 4
SIP_GATEWAY_BASE_URL=             # e.g. http://127.0.0.1:8089
SIP_GATEWAY_API_TOKEN=            # item 7
SIP_GATEWAY_EVENT_SECRET=         # item 8
SIP_GATEWAY_TIMEOUT_MS=           # optional, default 10000
```

`npm run doctor` lists every missing name once `TELEPHONY_PROVIDER=cloudyvoice`
is set — it never prints a value.

## 5. Verification path (in order — nothing may be skipped)

1. **Phase-1 spike (needs VPS):** engine choice (Asterisk vs FreeSWITCH),
   loopback registration to the carrier proxy, bidirectional audio on a
   carrier-approved test call.
2. **Free health probe:** `GET /v1/health` via `npm run doctor` / dashboard
   onboarding verification — proves reachability + registration, costs nothing.
3. **Owner-approved test call** with a tiny daily limit, live mode, prospect
   informed — the first and only paid action, and only after items 1–2 pass.
4. Live outreach still requires the explicit owner resume from the dashboard.

Until step 3 succeeds, the honest status remains: **CloudyVoice NOT connected.**

## 6. Safety controls preserved (unchanged)

- `OPERATING_MODE=simulation` default + outreach paused on every start;
- daily call/budget ceilings, consent gating, `Stop All`/emergency stop;
- calling-hours schedule, suppression list (STOP), append-only opt-out;
- **no recording is ever requested** on any path (consent is domain-owned);
- the mandated AI disclosure leads every greeting and turn;
- gateway secrets are never logged, never echoed, compared timing-safe;
- unconfigured → 401/404 and zero network I/O, not a guess.

## 7. Related docs

- `backend/deploy/sip/contract.md` — the authoritative backend ⇄ gateway API
- `backend/deploy/sip/README.md` — Windows-dev steps, VPS steps, firewall table
- `docs/deployment.md` — topology and deploy sequence
- `docs/architecture.md` — layer overview (gateway bridge section)
- `docs/external-dependencies.md` — CloudyVoice entry
- `docs/security-checklist.md` — gateway secret handling
