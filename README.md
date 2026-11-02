# UWS AI Sales Calling Agent

A secure, maintainable, genuinely functional AI sales-calling platform for
**Universal Web Solutions** (https://www.universalwebsolutions.it.com). It
automates *lead discovery → analysis → scoring → eligibility → permitted
outreach → qualification → CRM pipeline → reporting* under strict
owner-defined safeguards — and it ships **disabled**: the default operating
mode is **simulation**, and live outreach can never happen without an explicit
owner action.

> **Read this first.** Nothing in this repository contacts a real customer out
> of the box. The system starts in `simulation` mode and `paused`. Live mode
> requires configured providers, an owner-only activation with
> re-authentication, and is reachable only after every safety check passes.
> Restarting the service **pauses** outreach again — it never auto-resumes.

---

## Quick start

```bash
# 0. All commands run from the backend folder
cd backend

# 1. Install dependencies (no build step — Node 24 runs the TypeScript directly)
npm install

# 2. Apply database migrations and create the first owner account
npm run setup

# 3. Run the automated test suite (unit + integration + API acceptance)
npm test

# 4. Sanity-check the deployment (config, DB, migrations, providers, safeguards)
npm run doctor

# 5. Start the server (opens the dashboard)
npm start            # default http://localhost:3100
```

Sign in with the owner account you created in `npm run setup`. The dashboard is
a no-build ES-module SPA served from `frontend/` by the same process — open the
printed URL.

### Useful scripts

| Script | What it does |
|---|---|
| `npm start` | Run the HTTP server + background scheduler |
| `npm run dev` | Same, with file-watch restart |
| `npm test` | Full automated test suite (`node:test`) |
| `npm run typecheck` | `tsc --noEmit` over the whole project |
| `npm run setup` | Interactive: migrate DB + create owner account |
| `npm run migrate` | Apply pending migrations |
| `npm run doctor` | Environment / DB / provider / safeguard health report |
| `npm run backup` | Take a (verified, optionally encrypted) backup now |
| `npm run restore` | Restore a backup (writes a copy, or `--apply` to swap) |

---

## How it works (one paragraph per layer)

Leads enter through the **import pipeline** (CSV / Excel, preview-then-commit)
or a **discovery run** over public OpenStreetMap data (free Overpass API,
Pakistan scope). Each lead's **website is analysed** (reachability,
structure, contact signals) — an unreachable site is recorded as a real
finding, never fabricated. A **transparent score** is computed from six
explainable factors, each stored with its code, weight, points, evidence state
(`measured` / `stated` / `estimated` / `unknown`) and evidence text — missing
data scores zero and is marked *unknown*, never guessed.

Before any outreach, an **eligibility gate** evaluates consent, the
suppression list, channel enablement and usable contact data. When a channel is
allowed, every outbound action passes a single **guard** that checks operating
mode, emergency stop, eligibility, opt-outs, calling window (timezone-aware),
daily call limit and budget — in that order, server-side. Only after the guard
allows does the action reach a provider **adapter** (or the deterministic
simulation adapter), and every attempt (allowed *or* blocked) is written to the
ledger with its exact reason.

The **CRM pipeline** tracks interactions, evidence-backed stage advancement
(customer-facing stages require a real contact interaction; only the owner
confirms a conversion), follow-ups and a cross-lead follow-up board.
**Portfolio sharing** enforces a two-key rule: an item is shareable only when
it is both *verified* and *approved*. On an answered call the **duplex
bridge** opens a Twilio Media Stream and runs the same conversation lifecycle
over real audio — voice-activity turn detection → STT → engine (AI disclosure
and turn ceiling enforced) → TTS paced back as μ-law frames, with barge-in,
DTMF human handoff and opt-out handling — and it never dials or records.
**Daily reports** reconcile the ledger
against execution rows and counters, surfacing discrepancies and honestly
reporting missing data instead of estimating it. **Backups** are verified
snapshots (optionally AES-256-GCM encrypted) with periodic restore tests.

Everything sensitive is **audited** (append-only) and logged with phone /
email / token redaction. An emergency **STOP ALL** halts every outbound
channel immediately and is reachable from every screen.

---

## Final status table

All roadmap phases through Phase 12 **plus the final addendum** (duplex
live-call audio, configuration and deployment readiness) are implemented and
covered by automated tests.

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 1–2 | Project baseline, config, auth (scrypt), sessions, CSRF, RBAC, re-auth, settings engine, operating state, health, scheduler, CLIs | ✅ Complete | Migrations 001–006; setup/migrate/doctor CLIs |
| 3 | Lead import (CSV/Excel, preview→commit), normalisation, dedupe/merge, repository, routes | ✅ Complete | Single canonical header-alias table; duplicates re-evaluated at commit time in-transaction |
| 4 | Website analysis (fetcher + parser), explainable scoring, contact eligibility, routes | ✅ Complete | Measured vs estimated vs unknown; `notMeasured` always populated; unreachable ≠ no-website |
| 5 | Pipeline interactions, evidence-backed stage advancement, follow-up scheduling/execution | ✅ Complete | Migration 007 (consent as an `interactions` row); evidence rules enforced |
| 6 | Outreach guard + ledger, deterministic simulation adapter, portfolio two-key rule, conversations, orchestration | ✅ Complete | Ordering (guard→ledger→counter→adapter→timeline) is a safety property; blocked=200, allowed=201 |
| 7 | Provider adapters (Twilio, WhatsApp Cloud, OpenAI-compatible, SMTP), registry, webhooks, live seam | ✅ Complete | TwiML answer = duplex variant (disclosure → `<Connect><Stream>`) or fixed disclosure + Hangup; inbound WhatsApp STOP suppresses first |
| 8 | Notifications fan-out/delivery, reconciliation, daily reports, reporting jobs, shared registry | ✅ Complete | One `daily_reports` row per date; reports owner-only, notifications owner+staff |
| 9 | Backup (verified snapshot), AES-256-GCM encryption, restore + restore tests, jobs, CLIs, monitoring | ✅ Complete | `UWSBK1` format; retention never deletes the newest backup; restore re-applies late opt-outs |
| 10 | No-build ES-module SPA (dashboard, leads, lead detail, pipeline, duplicates, portfolio, notifications, reports, backups, settings, system) | ✅ Complete | CSP `script-src 'self'` — no inline scripts/handlers; all dynamic content escaped |
| 11A | Integration observability: adapter `ping()` probes, health checks, usage tracking, enable/disable toggles, mock providers, resilience (rate limit/retry/circuit-breaker) | ✅ Complete | Free probes only; unconfigured/disabled = no network; secrets never leave env names |
| 11B | Live media pipeline seam (STT→AI→TTS conversation lifecycle), provider onboarding verification, opt-in unsuppression review queue, scheduled health checks, live-mode activation guardrails | ✅ Complete | Live requires owner + typed "GO LIVE" + fresh reauth + verified telephony; suppression lifts are append-only, owner-only, reason-mandatory |
| 12 | Lead discovery vendor integration: OpenStreetMap/Overpass adapter, discovery run service + API (`/api/discovery/status`, `/api/discovery/run`), SPA trigger | ✅ Complete | Free + keyless (no `DISCOVERY_API_KEY` needed); Pakistan-only scope; runs in simulation (public-data research, contacts no customer); all-fail runs throw honestly |
| Duplex | Live two-way call audio: G.711 μ-law/WAV/resample primitives, voice-activity utterance detection, Twilio Media Streams bridge (`/api/media` WSS), signed expiring stream tokens, inbound call attribution, barge-in, DTMF human handoff, call-duration caps | ✅ Complete | Answer TwiML: disclosure → `<Connect><Stream track=inbound_track codec=PCMU 8kHz>` → `<Hangup/>`; never `<Record/>`; the bridge never dials; a call runs the SAME conversation lifecycle (STT→engine→TTS, transcript, qualification, opt-out suppression) over real audio |
| CloudyVoice SIP | Backend half of the SIP gateway bridge (intended primary outbound provider): gateway control adapter + registry webhook selection, signed answer/lifecycle routes, SIP-dialect media bridge sharing the server with the Twilio bridge, Q.850 cause mapping, doctor/env/docs/templates | ✅ Backend complete — **NOT connected** | CloudyVoice is a SIP carrier (no HTTP call API): carrier values are BLOCKED on onboarding; `backend/deploy/sip/*.sample` placeholders + `contract.md` ready; no SIP registration or test call has happened; Twilio path byte-identical and untouched |

### Automated test coverage

`npm test` runs **573 tests across 87 suites** (unit + integration + API
acceptance), all green. `npm run typecheck` is clean and `npm run doctor`
exits 0. No test ever touches a real network: adapters receive an injected
transport, and the default registry in the test environment is built from an
explicit env map (never `process.env`), so local credentials cannot be
exercised by the suite. The duplex bridge is covered end to end over a real
WebSocket with mock providers, as is the SIP-gateway media bridge (real
WebSocket, fake gateway, zero carrier traffic).

---

## Not yet implemented / external dependencies

The software itself is complete. What follows are **external dependencies**
— items that require the owner (or a provider) to act outside this
repository. See `backend/docs/architecture.md` §11 for the full rationale.

* **Discovery coverage limits** — Phase 12 wired a real discovery vendor:
  OpenStreetMap via the free, keyless Overpass API (`DISCOVERY_PROVIDER=overpass`).
  It covers Pakistan only and is thinner than commercial directories (best for
  named businesses with a published phone). Import remains fully functional.
* **Telephony / WhatsApp / SMTP / AI / STT** integrations — **unconfigured**
  until real credentials and provider approvals exist (account creation,
  Meta template approval, API keys entered as env vars). Simulation stays the
  default; the owner-only live-activation path additionally requires a
  **verified** telephony onboarding (free connection probe), the typed "GO LIVE"
  confirmation and a fresh password re-authentication — and is never
  auto-activated. Each gap, with its exact owner action, is listed in
  `backend/docs/external-dependencies.md`.
* **Duplex live-call audio** — implemented (answer TwiML opens a Twilio
  Media Stream at `/api/media`; the conversation runs over real two-way
  audio). It requires the telephony + AI + speech integrations above to be
  configured; until then the answer URL serves the fixed approved greeting
  and the bridge refuses upgrades honestly (503). Recording is never
  enabled — no consent flow exists, so `<Record/>` is never emitted.
* **Backups** — opt in with `BACKUP_ENABLED=true` and set
  `BACKUP_PASSPHRASE` for encryption at rest (the local `.env` enables both).
  `npm run doctor` reports the honest state.
* **CloudyVoice SIP calling** — the backend half is complete and tested
  (gateway control adapter, signed answer/lifecycle routes, SIP-dialect media
  bridge, `backend/deploy/sip/` templates, `backend/docs/cloudyvoice-integration.md`),
  but **nothing is connected to the carrier**: no credentials, no SIP
  registration, no test call. It stays blocked on CloudyVoice onboarding (KYC,
  SIP host/port/transport, auth mode, codecs/DTMF, CLI approval for Pakistan)
  and a VPS for the gateway engine. `npm run doctor` prints the exact missing
  names once `TELEPHONY_PROVIDER=cloudyvoice` is set — values are never
  printed. Twilio remains fully available and untouched.

---

## Configuration

Configuration comes from the environment (a `.env` file is loaded if present).
Run `npm run doctor` for a live view of what is set and what is missing — it
never prints secret values.

### Required to boot

| Variable | Default | Notes |
|---|---|---|
| `SESSION_SECRET` | ephemeral (dev) | **Required in production** (≥ 32 chars). Sessions reset on restart if ephemeral. |
| `DATABASE_PATH` | `./data/uws.sqlite` | SQLite file (WAL mode). |
| `PORT` | `3100` | Explicit `EADDRINUSE` error if taken. |
| `NODE_ENV` | `development` | `production` tightens requirements. |

### Safety ceilings (compiled-in; settings can never exceed them)

| Variable | Default | Notes |
|---|---|---|
| `HARD_DAILY_CALL_LIMIT` | `100` | Absolute cap on outbound call attempts per day. |
| `HARD_DAILY_BUDGET_MINOR` | `100000` | Absolute cap on daily calling+messaging spend (minor units). |

### Operating safeguards (owner-configurable via the dashboard / settings API)

`calling_schedule` (days + hours + timezone) · `daily_call_limit` ·
`daily_budget` · `retry_policy` · `followup_policy` · `eligible_channels` ·
`recording_policy` · `notification_destinations` · `retention` ·
`scoring_weights` · `discovery_policy` · `conversation_policy` ·
`portfolio_policy`. Sensitive settings require a fresh password
re-authentication to change.

### Providers (all optional; unconfigured providers report honestly)

Telephony (`TELEPHONY_*` — `TELEPHONY_PROVIDER=twilio` or `cloudyvoice`;
CloudyVoice additionally uses `SIP_GATEWAY_BASE_URL`, `SIP_GATEWAY_API_TOKEN`,
`SIP_GATEWAY_EVENT_SECRET`, `SIP_GATEWAY_TIMEOUT_MS` — see
`backend/docs/cloudyvoice-integration.md`) · WhatsApp Business (`WHATSAPP_*`) ·
Lead discovery
(`DISCOVERY_*` — OpenStreetMap/Overpass is free and keyless; set
`DISCOVERY_PROVIDER=overpass`, no API key required) · AI conversation
(`AI_*`) · Speech (`STT_*`) · Email/SMTP (`SMTP_*`). Backups
(`BACKUP_ENABLED`, `BACKUP_PASSPHRASE`, `BACKUP_RETENTION_DAYS`,
`BACKUP_INTERVAL_HOURS`, `RESTORE_TEST_INTERVAL_DAYS`).

### Duplex live-call bridge (non-secret behaviour tuning)

| Variable | Default | Notes |
|---|---|---|
| `DUPLEX_ENABLED` | `true` | Master switch. When off (or speech/AI missing) the answer URL serves the fixed greeting and the WebSocket upgrade returns 503. |
| `DUPLEX_VAD_THRESHOLD` | `400` | RMS above which an inbound frame counts as speech. |
| `DUPLEX_SILENCE_MS` | `600` | Trailing silence that ends a prospect utterance. |
| `DUPLEX_MAX_UTTERANCE_MS` | `15000` | Hard cap on a single utterance (bounds memory per call). |
| `DUPLEX_MAX_CALL_SECONDS` | `300` | Hard cap on one live call; the bridge then hangs up. |

---

## Documentation

| Document | Contents |
|---|---|
| `backend/docs/architecture.md` | Full architecture: goals, technology choices (and rejections), layering, safeguards, data model, scoring, import/analysis/pipeline/outreach/notifications/backup design, security, testing strategy |
| `backend/docs/acceptance-test-plan.md` | Manual acceptance walkthrough per phase, complementing the automated suite |
| `backend/docs/security-checklist.md` | Security posture checklist mapped to the implementation |
| `backend/docs/external-dependencies.md` | Every remaining external dependency with its exact owner action (provider accounts, hosting, DNS, GO LIVE) |
| `backend/docs/deployment.md` | Vercel (frontend) + Railway (backend) topology, deploy sequence, env vars, and the honest current blockage |
| `backend/docs/cloudyvoice-integration.md` | CloudyVoice SIP integration: what the carrier is, gateway architecture, implemented backend surface, blocked required values, ordered verification path |
| `backend/deploy/sip/` | Gateway templates: `contract.md` (authoritative backend ⇄ gateway API), `README.md` (Windows-dev + VPS steps + firewall table), Asterisk/env/systemd `*.sample` files — placeholders only |

---

## Project layout

```
frontend/    no-build ES-module SPA served as static files by the backend
  index.html   mount point (#app) + module entry
  app.js       router + shell
  lib.js       fetch helper (CSRF), escaping, dialogs, badges, table helpers
  styles.css   design system
  views/       home, leads, lead detail, pipeline, ops, owner pages
backend/     Node 24 + TypeScript (run directly, no build step) — the whole
             server, domain, adapters, jobs, tests, docs and npm scripts
  src/
    core/      config, logger (redaction), errors, time/timezone, ids, password
    db/        connection, migrations (001–010), transaction helpers
    domain/    business logic — pure, framework-free (leads, analysis, scoring,
               eligibility, pipeline, outreach, portfolio, reporting, backup,
               state, settings, auth, discovery, media/duplex)
    adapters/  provider ports + implementations (mock/simulation and real)
    http/      Express routes, middleware (auth/CSRF/RBAC/reauth), error mapping
    jobs/      scheduler + tasks (reporting, backup, health) — honour safeguards
    server/    app assembly (middleware order, CSP, static + SPA fallback), entry
  tests/
    unit/        pure-logic tests
    integration/ DB + service + job tests
    api/         HTTP acceptance tests against the real app
    helpers/     test server/client harness
  docs/        architecture, acceptance plan, security checklist,
               cloudyvoice-integration
  deploy/sip/  SIP gateway templates: contract.md (authoritative backend ⇄
               gateway API), README.md (VPS steps + firewall table),
               Asterisk/env/systemd *.sample — placeholders only, never filled here
```

The backend serves `frontend/` as static files (SPA fallback to
`frontend/index.html`), so run every npm command from `backend/`.

---

## License / ownership

Internal tooling for Universal Web Solutions. Not a multi-tenant SaaS; no
microservices, message brokers, or orchestration by design.
