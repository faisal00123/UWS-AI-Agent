# Deployment

Target topology (as requested by the owner):

```
                 ┌──────────────────────────────┐
  Browser ──────►│ Vercel   frontend/ (static)  │  vercel.mjs: security headers,
  (dashboard)    │          no build step        │  /api/* rewrite → backend
                 └──────────────┬───────────────┘
                                │ /api/:path*  (HTTP, same-origin cookies)
                                ▼
                 ┌──────────────────────────────┐
  Twilio ───────►│ Railway  backend/ (Node 24)  │  Express + duplex WebSocket
  (TwiML + WSS)  │          SQLite + jobs        │  /api/media, /api/webhooks/*
                 └──────────────────────────────┘
```

* **Vercel serves the SPA**; every `/api/...` request is rewritten to the
  backend so cookies/CSRF/session behave exactly like a single-origin deploy.
* **Twilio talks only to the backend**: the answer TwiML and the
  Media Streams `wss://` URL are built from `PUBLIC_BASE_URL`, which must be
  the backend's own `https://` origin — the duplex WebSocket is therefore
  never proxied through Vercel.
* **Railway runs everything server-side**: HTTP API, duplex bridge,
  background scheduler (reporting, backups, health probes), SQLite.

## Files in this repo

| File | Purpose |
|---|---|
| `frontend/vercel.mjs` | Programmatic Vercel config: `/api/*` rewrite to `RAILWAY_BACKEND_URL`, CSP + security headers mirroring the backend's helmet policy. Fails the build with an actionable error while `RAILWAY_BACKEND_URL` is unset. |
| `backend/railway.json` | Railway service config: Nixpacks build (`npm ci`), start command, `ON_FAILURE` restart policy, `/api/health` health check. |
| `backend/Dockerfile` + `.dockerignore` | Container image alternative for any host (build from the repo root). |
| `.github/workflows/ci.yml` | CI: typecheck → full test suite → doctor → frontend `node --check` → vercel config guard. Needs no secrets; every provider is unconfigured by design there. |

## Exact deploy sequence

### 1. Railway (backend) first

1. Create a Railway account/project (Railway may require a payment method on
   file — this is their requirement, not ours).
2. Create a service from this repository with **root directory `backend`**
   (Nixpacks picks up `railway.json`), or use the container path:
   `docker build -f backend/Dockerfile -t uws-ai-agent .`.
3. Set the environment variables in the Railway dashboard
   (all non-secret except where noted):

   | Variable | Value |
   |---|---|
   | `NODE_ENV` | `production` |
   | `SESSION_SECRET` | **generate**: `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"` |
   | `PUBLIC_BASE_URL` | `https://<your-backend-domain>` (must be `https://` — Twilio requires `wss://` for media streams) |
   | `OPERATING_MODE` | `simulation` (ship safe; live needs the owner's GO LIVE action anyway) |
   | `DISCOVERY_PROVIDER` | `overpass` (free, keyless) |
   | `BACKUP_ENABLED` / `BACKUP_PASSPHRASE` | `true` / a generated passphrase |
   | `DATABASE_PATH` | `/app/data/uws.sqlite` (container) with a Railway **volume** mounted at `/app/data` — SQLite needs durable storage |
   | `DUPLEX_*` | optional; defaults are sensible |
   | `TELEPHONY_*`, `AI_*`, `STT_*`, `TTS_*`, `WHATSAPP_*`, `SMTP_*` | **left unset until the provider accounts exist** — the app reports `unconfigured` honestly and does no I/O |

4. Deploy. Verify:
   * `GET https://<backend>/api/health` → `{"status":"ok",...}`
   * `npm run doctor` equivalent: `GET /api/system` (authenticated) shows
     `pendingMigrations: false`
   * the duplex endpoint refuses cleanly: a plain `GET /api/media` upgrade
     without a token returns `401` (not a crash).

### 2. Vercel (frontend)

1. Create a Vercel project from the repository with **root directory
   `frontend`** (static; `vercel.mjs` supplies the config).
2. Add the environment variable **`RAILWAY_BACKEND_URL`** = the Railway
   origin from step 1 (e.g. `https://uws-ai-agent.up.railway.app`).
   The build fails with an explicit message until this exists — by design.
3. Deploy. Verify:
   * the dashboard loads and signs in (session cookie flows through the
     rewrite);
   * `GET https://<vercel-domain>/api/health` proxies to the backend;
   * response headers include the CSP (`script-src 'self'`).

### 3. After both are live

* Point the production domain's DNS at the hosts (owner owns DNS), set
  `PUBLIC_BASE_URL` to the final backend `https://` origin, redeploy.
* Twilio: set the voice webhook to
  `https://<backend>/api/webhooks/telephony/twilio/voice` and the status
  callback to `https://<backend>/api/webhooks/telephony/twilio`.
* Run the free **Test connection** probes in the dashboard for every
  configured integration — these are the production health/integration
  checks; no paid API call is ever made by them.
* Live outreach still requires the owner's **GO LIVE** action (verified
  telephony onboarding + typed confirmation + fresh re-authentication).

## SIP gateway (CloudyVoice) — a third host, when onboarding lands

CloudyVoice is a SIP carrier (no HTTP call-placement API), so calling through
it adds **one gateway process** to this topology — not a new backend and not a
change to the two-host deploy above:

```
  Vercel SPA ──/api/*──► backend ──control/events/media──► gateway (VPS) ──SIP/RTP──► CloudyVoice ──► PSTN
```

* The backend needs **no new egress besides** `SIP_GATEWAY_BASE_URL` (ideally
  loopback — gateway on the same host) and the gateway needs HTTPS/WSS to the
  backend's `PUBLIC_BASE_URL` (answer fetch, signed events, media WS).
* The gateway host is provisioned from `backend/deploy/sip/*.sample` (placeholders
  filled **on the VPS only**) — see `backend/deploy/sip/README.md` for the step list
  and the firewall table.
* Sequence when the carrier values arrive: Phase-1 engine spike → fill
  samples → free `/v1/health` probe → `npm run doctor` gateway block clean →
  owner-approved test call → only then consider live mode. Until the test call
  succeeds the status stays **CloudyVoice NOT connected**
  (`docs/cloudyvoice-integration.md`).
* `TELEPHONY_PROVIDER=twilio` remains fully supported: switching back restores
  the previous two-host behaviour byte-for-byte (tests assert the historical
  webhook URLs are unchanged).

## Hosting options compared (persistence, scheduler, WebSockets)

What the backend actually requires of a host:

| Requirement | Why |
|---|---|
| Long-running Node 24 process | Express API + in-process job scheduler (reports, backups, health probes) — **not** serverless-friendly (a FaaS instance freezes between invocations; scheduled jobs and the duplex WebSocket `/api/media` bridge would break) |
| Durable disk | SQLite (`node:sqlite`) is a **single file** (`DATABASE_PATH`); it must sit on a persistent volume, never an ephemeral container filesystem. Single-writer is fine at this workload; nightly verified backups already run in-app |
| WebSocket + long-lived connections | Duplex call bridge (`ws`) and Twilio/gateway media streams need a host that proxies WS upgrades with generous idle timeouts |
| Public HTTPS origin | Meta webhook callbacks + Twilio signatures validate absolute URLs (`PUBLIC_BASE_URL`) |
| PostgreSQL | **Not supported today.** The app is SQLite-only by explicit architecture decision (`docs/architecture.md`); a PG switch is an owner-level project (driver + `DATABASE_URL` wiring), not a hosting checkbox |

| Option | Fits? | Cost | Notes |
|---|---|---|---|
| **Railway** (documented path) | ✅ | ~$5–15/mo usage-based | Volume at `/app/data` for SQLite, WS works, Nixpacks config already in `railway.json`, health check wired. Requires a payment method. **Recommended first deployment** — zero ops for the owner |
| **Small VPS** (Hetzner CX22 / DigitalOcean ~$6/mo) | ✅ | ~$6/mo | Full control: systemd unit, Caddy for auto-TLS, SQLite on local disk, WS native. Best long-term value and **the same machine can later host the CloudyVoice SIP gateway** (Asterisk/FreeSWITCH), removing a whole network hop. Costs: you own OS updates, TLS renewal, backup cron (the app's own `npm run backup` covers app data) |
| Render / Fly.io / Railway-like PaaS | ✅ (paid tiers) | $7+/mo | Render's **free tier sleeps** — avoid it (scheduler + WS need always-on). Fly SQLite volumes work but pricing/regions changed often |
| Oracle Cloud free tier ARM VM | ✅ | $0 | Generous free ARM instance; harder support story, but viable for a budget-conscious always-on host |
| Vercel (backend) / serverless | ❌ | — | Ephemeral filesystem (no SQLite), no always-on scheduler, WS not supported — Vercel remains the **frontend** host only |

**Recommendation:** deploy as documented (Railway backend + Vercel frontend) for the
first live cut; when CloudyVoice onboarding reaches the gateway phase, migrate the
backend onto the same VPS as the SIP engine (one `systemd` unit + Caddy, SQLite on
disk, `npm run backup` scheduled) — fewer moving parts and lower cost than running
two separate hosts. PostgreSQL only becomes relevant if the owner later decides to
port the data layer; no hosting choice made today blocks that decision.

## Why deployment is currently blocked (honest status)

Verified in this environment, never worked around:

| Check | Result |
|---|---|
| `vercel`, `railway`, `docker` CLIs | not installed |
| `VERCEL_TOKEN`, `RAILWAY_TOKEN`, `GITHUB_TOKEN` | unset |
| Vercel / Railway accounts | none linked to this environment |
| Production domain / DNS | not available here |

No deployment was attempted against a nonexistent account and no deployment
result is claimed. Everything above is prepared and verified as far as it
can be without those external accounts; the two config guards were exercised
locally (missing env → actionable failure; set env → correct rewrite and
headers). The moment a Vercel token and a Railway token exist, the sequence
in this document runs as written, and the health checks at the end are the
acceptance evidence.
