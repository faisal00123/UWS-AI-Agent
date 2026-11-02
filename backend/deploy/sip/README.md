# backend/deploy/sip — CloudyVoice SIP gateway templates

Everything here is a **template with placeholders**. Nothing is filled in, no
carrier value is guessed, and nothing in this folder is required to *run* the
backend — the backend works (simulation mode, no gateway) without any of it.

> **CloudyVoice is NOT connected yet.** SIP registration and an owner-approved
> test call have not happened. These files exist so the gateway work can start
> the moment the carrier's onboarding values arrive.

## What this folder contains

| File | Purpose |
| --- | --- |
| `contract.md` | The authoritative backend ⇄ gateway API (our contract, not CloudyVoice's) |
| `gateway.env.sample` | Secrets/config for the gateway bridge process (never committed filled) |
| `pjsip.conf.sample` | Asterisk PJSIP endpoint/transport skeleton (placeholders) |
| `rtp.conf.sample` | Asterisk RTP port range skeleton (placeholders) |
| `extensions.conf.sample` | Asterisk dialplan skeleton: answer-fetch → bridge / hangup |
| `uws-gateway.service.sample` | systemd unit for the gateway bridge on the VPS |
| `README.md` | this file |

**Engine choice (Asterisk vs FreeSWITCH) is decided by the Phase-1 loopback
spike on the VPS** — both integrate with CloudyVoice per its published
platform support; the samples here are Asterisk-flavoured because CloudyVoice
documents Asterisk/FreeSWITCH support, and the contract does not care which
engine runs behind it.

## Prerequisites (owner supplies — all BLOCKED on CloudyVoice onboarding)

From the carrier (see `backend/docs/cloudyvoice-integration.md` §Required
values, auto-listed by `npm run doctor` once `TELEPHONY_PROVIDER=cloudyvoice`):

1. SIP proxy hostname/IPs, port, transport (UDP/TCP/TLS)
2. Auth mode: SIP credentials **or** static-IP allowlisting
3. Codec list + DTMF mode (RFC2833/SIP INFO/in-band) confirmed for our account
4. Channels/CPS limits, billing increment, rate deck (Pakistan +92)
5. DID (if inbound is wanted) and CLI/caller-ID approval for Pakistan
6. Their network IP list (for firewalling the media/signalling path)

From us (owner generates — no carrier involvement):

7. `SIP_GATEWAY_API_TOKEN` and `SIP_GATEWAY_EVENT_SECRET`
   (`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   twice) → `backend/.env`
8. A VPS with a public IP, Docker or systemd, Node ≥ 24, and (for the samples)
   Asterisk or FreeSWITCH installed

## Windows dev machine (no carrier, no spend)

The backend half is fully testable locally without any of the above:

```powershell
cd backend
npm ci
npm run typecheck      # 0 errors
npm test               # includes tests/integration/gateway.test.ts
npm run doctor         # shows the SIP gateway section (names only)
```

To exercise the gateway *paths* locally, set in `backend/.env` (values are
obviously-fake test values; still never commit them):

```ini
TELEPHONY_PROVIDER=cloudyvoice
TELEPHONY_FROM_NUMBER=+92XXXXXXXXX        # placeholder until CLI-approved
SIP_GATEWAY_BASE_URL=http://127.0.0.1:8089
SIP_GATEWAY_API_TOKEN=<random-32-bytes-hex>
SIP_GATEWAY_EVENT_SECRET=<another-random-32-bytes-hex>
```

`npm run doctor` then lists the gateway block. Leave `OPERATING_MODE=simulation`
and outreach paused — no call can be placed in this state, by design.

## VPS steps (when the carrier values arrive)

1. **Spike (Phase 1):** install Asterisk *or* FreeSWITCH on the VPS, register a
   loopback/test endpoint against the carrier's proxy with the onboarding
   values, and confirm bidirectional audio in both directions of a test call
   *the carrier approved*. Record the engine choice.
2. Fill the `*.sample` files **on the VPS only** (copy → rename, never commit
   filled copies): `pjsip.conf`, `rtp.conf`, `extensions.conf`, `gateway.env`.
3. Install the gateway bridge as a service:
   `sudo cp uws-gateway.service.sample /etc/systemd/system/uws-gateway.service`
   (edit paths/ports), then `sudo systemctl enable --now uws-gateway`.
4. Backend `.env`: set the four `SIP_GATEWAY_*` values + `TELEPHONY_PROVIDER=cloudyvoice`
   + `TELEPHONY_FROM_NUMBER`. Restart the backend.
5. Verify, in order — each step must pass before the next:
   1. `curl -H "Authorization: Bearer $TOKEN" http://127.0.0.1:8089/v1/health`
      → `{"ok":true,"sip":{"registered":true}}`
   2. `npm run doctor` → gateway block all present, no `[FAIL]`
   3. free onboarding probe from the dashboard (never places a call)
   4. an **owner-approved** test call with a tiny daily limit, in live mode,
      with the prospect actually informed it is a test
6. Only after 5.4 succeeds may live outreach even be considered — and outreach
   still requires the explicit owner resume from the dashboard.

## Firewall notes (VPS)

Allow **only** what the topology needs; every item below is a placeholder port
range to be confirmed with the carrier during onboarding:

| Port/proto | From → To | Why |
| --- | --- | --- |
| `SIP_PORT/udp,tcp` (carrier value, e.g. 5060 — CONFIRM) | gateway ↔ carrier proxy | signalling |
| `RTP_RANGE/udp` (from `rtp.conf.sample` — CONFIRM with carrier) | gateway ↔ carrier media | RTP audio |
| `CONTROL_PORT/tcp` (e.g. 8089) | loopback only (backend → gateway) | control API `GET /v1/health`, `POST /v1/calls` |
| `443/tcp` (or backend port) | gateway host → backend public URL | answer fetch + `wss://…/api/gateway/media` + signed events |
| `22/tcp` | admin IPs only | SSH |

Hard rules:

- The control API must **never** be exposed to the internet: bind it to
  `127.0.0.1` when the backend shares the host, otherwise restrict it to the
  backend's IP **and** keep the bearer token (defence in depth).
- Do not expose the SIP/RTP ports to the world; the carrier's proxy IPs (their
  published network list) are the only peers.
- Backend public endpoints (`/api/webhooks/telephony/gateway/*`, `/api/gateway/media`)
  must stay reachable from the gateway host — that is normal HTTPS/WSS ingress.
- Rotate `SIP_GATEWAY_API_TOKEN` / `SIP_GATEWAY_EVENT_SECRET` by updating both
  sides and restarting both processes; there is no dual-secret overlap window,
  so do it when no call is live.

## Safety invariants (apply to every file here)

- No live call, ever, without `OPERATING_MODE=live` + outreach resumed +
  verified onboarding + owner-approved test.
- No recording is requested by any path in this folder (consent-gated domain).
- No secret is committed: every sample uses `REPLACE_WITH_…` placeholders.
- Twilio remains fully intact: setting `TELEPHONY_PROVIDER=twilio` restores the
  previous behaviour byte-for-byte.
