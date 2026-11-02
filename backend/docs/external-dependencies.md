# External dependencies — what is NOT in this repository, and why

The software is complete: every module, workflow, integration seam, safety
control and test in this repository is implemented and green. What remains
are **external dependencies** — items that only the owner (or a provider)
can supply, from outside the codebase. Nothing here is a placeholder in the
code; each item has an exact owner action.

**Rule held throughout:** no credential, account, approval or connection
result is ever invented. An unconfigured integration reports `unconfigured`
performs **zero network I/O**, and blocks nothing else — all other work
continues while any provider is pending.

---

## 1. Provider accounts & credentials

| # | Dependency | Missing | Exact owner action | Unblocks |
|---|---|---|---|---|
| 1 | **Twilio** (telephony) | Account SID, auth token, a purchased voice-capable number | Create a Twilio account → complete any KYC → buy a number → set `TELEPHONY_PROVIDER=twilio`, `TELEPHONY_ACCOUNT_SID`, `TELEPHONY_AUTH_TOKEN`, `TELEPHONY_FROM_NUMBER` → run the free "Test connection" / "Verify provider" probes in the dashboard | Outbound calls, the duplex live-call bridge, live-mode activation (which *requires* verified telephony) |
| 1b | **CloudyVoice** (SIP termination carrier — *intended primary* outbound provider) | Everything: KYC, SIP proxy host/port/transport, auth mode (SIP credentials or static IP) + their network IP list, confirmed codecs/DTMF/channels/CPS, rate deck/billing increment, DID (if inbound), **CLI/caller-ID approval for Pakistan**; plus our side: a VPS, an engine (Asterisk/FreeSWITCH, chosen by the Phase-1 spike), `SIP_GATEWAY_API_TOKEN`, `SIP_GATEWAY_EVENT_SECRET` | Complete CloudyVoice onboarding/KYC (sales@cloudyvoice.com) → provision the VPS gateway from `backend/deploy/sip/*.sample` (placeholders filled **on the VPS only**) → set `TELEPHONY_PROVIDER=cloudyvoice`, `TELEPHONY_FROM_NUMBER`, `SIP_GATEWAY_*` in `backend/.env` → `npm run doctor` lists any missing name → free health probe → **owner-approved test call** | SIP calling through our gateway. **Backend side is implemented and tested; NOT connected until SIP registration + an approved test call are verified.** Full list: `docs/cloudyvoice-integration.md` §4 |
| 2 | **AI conversation provider** | API key + model | Choose OpenAI / Anthropic / Google Gemini → create an API key → set `AI_PROVIDER`, `AI_API_KEY`, `AI_MODEL` | Real conversation turns and qualification extraction (mock available for rehearsal) |
| 3 | **Speech STT/TTS** | Nothing — already configured | `STT_PROVIDER=openai`, `TTS_PROVIDER=openai` are set; no dedicated speech key is required because OpenAI speech authenticates with the existing `AI_API_KEY` (same vendor/host as the conversation model; a dedicated `STT_API_KEY`/`TTS_API_KEY` is used first only if it actually authenticates, otherwise the adapter fails over to `AI_API_KEY`). Models: `STT_MODEL=whisper-1` (Urdu + English), `TTS_MODEL=tts-1`. Verify with the free "Test connection" probe; a paid transcription/synthesis needs explicit owner approval | Live call transcription + spoken replies; required for the duplex bridge |
| 4 | **WhatsApp Business (Meta Cloud API)** | App, phone number ID, access token, **approved** portfolio template, app secret, webhook verify token | Create a Meta developer app → add the WhatsApp product → submit the portfolio template for approval (approval is Meta's, not ours) → set the `WHATSAPP_*` vars | WhatsApp outreach channel |
| 5 | **Email / SMTP** | Host, user, password, from-address | Create/authorise a mailbox (or transactional-mail account) → set `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM`, `NOTIFY_OWNER_EMAIL` | Owner notifications + daily report emails |

Once credentials are entered, each integration is verified with the built-in
**free** connection probes (`POST /api/integrations/:key/test` and
`/onboard`) — never a paid API call.

## 2. Deployment hosting

| # | Dependency | Evidence of blockage | Exact owner action |
|---|---|---|---|
| 6 | **Vercel** (frontend) | `vercel` CLI not installed; `VERCEL_TOKEN` unset; no Vercel account linked | Create/log in to a Vercel account → `npm i -g vercel` (or provide `VERCEL_TOKEN`) → `vercel link` + `vercel deploy` from `frontend/` (config prepared in `vercel.json`) |
| 7 | **Railway** (backend) | `railway` CLI not installed; `RAILWAY_TOKEN` unset; no Railway project | Create/log in to a Railway account (a plan/payment method may be required by Railway) → install the CLI or provide `RAILWAY_TOKEN` → deploy from `backend/` (config prepared in `railway.json` + `Dockerfile`) |
| 8 | **Production domain + DNS** | Domain DNS not under this tool's control | Point the chosen hosts' DNS records at the deployed services, then set `PUBLIC_BASE_URL` to the final `https://` origin (Twilio requires `wss://` over TLS for media streams) |

Deployment counts as complete only when the **production app passes health
and integration checks** — that verification runs as soon as credentials for
#6/#7 exist; it cannot be simulated.

## 3. Data store decision (owner call, not unfinished code)

| # | Item | State |
|---|---|---|
| 9 | **PostgreSQL vs SQLite** | The defined production database is **SQLite via `node:sqlite`** — PostgreSQL is explicitly rejected in `backend/docs/architecture.md` (no server available in this environment) and there is no PG server to connect to. Switching to PostgreSQL is an **architecture decision for the owner**: it would require a PG server/instance plus a driver/`DATABASE_URL` wiring pass. Nothing in the code is waiting on it. |

## 4. Final live-campaign authorisation

| # | Dependency | Why it is external |
|---|---|---|
| 10 | **GO LIVE** | Live outreach requires the owner's explicit action in the dashboard: verified telephony onboarding (#1), typed `GO LIVE` confirmation, and fresh password re-authentication. The system ships `simulation` + `paused` and never auto-enables real outreach. This is a deliberate control, not a gap. |

---

## What runs today without any of the above

- Full test suite: **524 tests / 79 suites, 0 failures**; typecheck clean;
  doctor exit 0.
- **Lead discovery**: `DISCOVERY_PROVIDER=overpass` — a real, free, keyless
  vendor (OpenStreetMap), configured in `backend/.env` and verified.
- **Backups**: enabled + AES-256-GCM encrypted; a verified backup and a full
  restore test both pass locally.
- Import/analysis/scoring/eligibility/pipeline/ledger/reporting/monitoring:
  fully functional in simulation with the deterministic simulation adapters.
- The duplex bridge: implemented and proven end-to-end over a real WebSocket
  in tests; in production it activates the moment #1–#3 exist.
