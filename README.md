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
it is both *verified* and *approved*. **Daily reports** reconcile the ledger
against execution rows and counters, surfacing discrepancies and honestly
reporting missing data instead of estimating it. **Backups** are verified
snapshots (optionally AES-256-GCM encrypted) with periodic restore tests.

Everything sensitive is **audited** (append-only) and logged with phone /
email / token redaction. An emergency **STOP ALL** halts every outbound
channel immediately and is reachable from every screen.

---

## Final status table

All roadmap phases through Phase 12 are implemented and covered by automated
tests. The table below reflects the state at the end of Phase 12.

| Phase | Scope | Status | Notes |
|---|---|---|---|
| 1–2 | Project baseline, config, auth (scrypt), sessions, CSRF, RBAC, re-auth, settings engine, operating state, health, scheduler, CLIs | ✅ Complete | Migrations 001–006; setup/migrate/doctor CLIs |
| 3 | Lead import (CSV/Excel, preview→commit), normalisation, dedupe/merge, repository, routes | ✅ Complete | Single canonical header-alias table; duplicates re-evaluated at commit time in-transaction |
| 4 | Website analysis (fetcher + parser), explainable scoring, contact eligibility, routes | ✅ Complete | Measured vs estimated vs unknown; `notMeasured` always populated; unreachable ≠ no-website |
| 5 | Pipeline interactions, evidence-backed stage advancement, follow-up scheduling/execution | ✅ Complete | Migration 007 (consent as an `interactions` row); evidence rules enforced |
| 6 | Outreach guard + ledger, deterministic simulation adapter, portfolio two-key rule, conversations, orchestration | ✅ Complete | Ordering (guard→ledger→counter→adapter→timeline) is a safety property; blocked=200, allowed=201 |
| 7 | Provider adapters (Twilio, WhatsApp Cloud, OpenAI-compatible, SMTP), registry, webhooks, live seam | ✅ Complete | TwiML answer = static AI-disclosure + Hangup (no recording); inbound WhatsApp STOP suppresses first |
| 8 | Notifications fan-out/delivery, reconciliation, daily reports, reporting jobs, shared registry | ✅ Complete | One `daily_reports` row per date; reports owner-only, notifications owner+staff |
| 9 | Backup (verified snapshot), AES-256-GCM encryption, restore + restore tests, jobs, CLIs, monitoring | ✅ Complete | `UWSBK1` format; retention never deletes the newest backup; restore re-applies late opt-outs |
| 10 | No-build ES-module SPA (dashboard, leads, lead detail, pipeline, duplicates, portfolio, notifications, reports, backups, settings, system) | ✅ Complete | CSP `script-src 'self'` — no inline scripts/handlers; all dynamic content escaped |
| 11A | Integration observability: adapter `ping()` probes, health checks, usage tracking, enable/disable toggles, mock providers, resilience (rate limit/retry/circuit-breaker) | ✅ Complete | Free probes only; unconfigured/disabled = no network; secrets never leave env names |
| 11B | Live media pipeline seam (STT→AI→TTS conversation lifecycle), provider onboarding verification, opt-in unsuppression review queue, scheduled health checks, live-mode activation guardrails | ✅ Complete | Live requires owner + typed "GO LIVE" + fresh reauth + verified telephony; suppression lifts are append-only, owner-only, reason-mandatory |
| 12 | Lead discovery vendor integration: OpenStreetMap/Overpass adapter, discovery run service + API (`/api/discovery/status`, `/api/discovery/run`), SPA trigger | ✅ Complete | Free + keyless (no `DISCOVERY_API_KEY` needed); Pakistan-only scope; runs in simulation (public-data research, contacts no customer); all-fail runs throw honestly |

### Automated test coverage

`npm test` runs **476 tests across 69 suites** (unit + integration + API
acceptance), all green. `npm run typecheck` is clean and `npm run doctor`
exits 0. No test ever touches a real network: adapters receive an injected
transport, and the default registry in the test environment is built from an
explicit env map (never `process.env`), so local credentials cannot be
exercised by the suite.

---

## Not yet implemented / external dependencies

These are deliberate, documented gaps — not oversights. See
`backend/docs/architecture.md` §11 for the full rationale.

* **Discovery coverage limits** — Phase 12 wired a real discovery vendor:
  OpenStreetMap via the free, keyless Overpass API (`DISCOVERY_PROVIDER=overpass`).
  It covers Pakistan only and is thinner than commercial directories (best for
  named businesses with a published phone). Import remains fully functional,
  and the discovery port reports `unconfigured` until a provider is selected.
* **Duplex live-call audio** — the conversation lifecycle (STT → AI turn →
  TTS, transcript segments, qualification extraction, opt-out handling) is
  implemented and API-driven (`/api/conversations/*`), but an inbound call
  still speaks the fixed, approved TwiML greeting (with the AI disclosure)
  and hangs up until a duplex audio bridge is wired to the media seam.
  Recording or transcribing a real person without a consent flow is not
  acceptable, so the TwiML never enables recording.
* **Telephony / WhatsApp / SMTP / AI / STT** integrations — **unconfigured**
  on the deployed instance until real credentials and provider approvals
  (e.g. Meta template approval) exist. Simulation stays the default; the
  owner-only live-activation path additionally requires a **verified**
  telephony onboarding (free connection probe), the typed "GO LIVE"
  confirmation and a fresh password re-authentication — and is never
  auto-activated.
* **Backups** — disabled by default; opt in with `BACKUP_ENABLED=true` and set
  `BACKUP_PASSPHRASE` for encryption at rest. `npm run doctor` reports the
  honest state.

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

Telephony (`TELEPHONY_*`) · WhatsApp Business (`WHATSAPP_*`) · Lead discovery
(`DISCOVERY_*` — OpenStreetMap/Overpass is free and keyless; set
`DISCOVERY_PROVIDER=overpass`, no API key required) · AI conversation
(`AI_*`) · Speech (`STT_*`) · Email/SMTP (`SMTP_*`). Backups
(`BACKUP_ENABLED`, `BACKUP_PASSPHRASE`, `BACKUP_RETENTION_DAYS`,
`BACKUP_INTERVAL_HOURS`, `RESTORE_TEST_INTERVAL_DAYS`).

---

## Documentation

| Document | Contents |
|---|---|
| `backend/docs/architecture.md` | Full architecture: goals, technology choices (and rejections), layering, safeguards, data model, scoring, import/analysis/pipeline/outreach/notifications/backup design, security, testing strategy |
| `backend/docs/acceptance-test-plan.md` | Manual acceptance walkthrough per phase, complementing the automated suite |
| `backend/docs/security-checklist.md` | Security posture checklist mapped to the implementation |

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
               state, settings, auth, discovery)
    adapters/  provider ports + implementations (mock/simulation and real)
    http/      Express routes, middleware (auth/CSRF/RBAC/reauth), error mapping
    jobs/      scheduler + tasks (reporting, backup, health) — honour safeguards
    server/    app assembly (middleware order, CSP, static + SPA fallback), entry
  tests/
    unit/        pure-logic tests
    integration/ DB + service + job tests
    api/         HTTP acceptance tests against the real app
    helpers/     test server/client harness
  docs/        architecture, acceptance plan, security checklist
```

The backend serves `frontend/` as static files (SPA fallback to
`frontend/index.html`), so run every npm command from `backend/`.

---

## License / ownership

Internal tooling for Universal Web Solutions. Not a multi-tenant SaaS; no
microservices, message brokers, or orchestration by design.
