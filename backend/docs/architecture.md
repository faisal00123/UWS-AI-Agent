# UWS AI Sales Calling Agent — Architecture

> Status: living document. Updated as phases are implemented.
> Last updated: 2026-10-30 (Phase 10)

## 1. Goals

A secure, maintainable, genuinely functional AI sales-calling platform for
**Universal Web Solutions** (https://www.universalwebsolutions.it.com) that
automates lead discovery → analysis → scoring → eligibility → permitted
outreach → qualification → CRM pipeline → reporting, under strict
owner-defined safeguards.

Non-goals for the initial deployment: microservices, multi-tenant SaaS,
Kubernetes, message brokers.

## 2. Technology selection (and why)

| Concern | Selection | Rationale / rejected alternatives |
|---|---|---|
| Language | TypeScript (erasable syntax only) | Type safety with **zero build step** — Node 24 strips types natively. *Rejected:* ts-node/tsx (extra toolchain), compiled `dist` (build/deploy drift) |
| Runtime | Node.js 24 LTS-class | Already present in the environment; ships `node:sqlite`, native TS, `node:test` |
| HTTP | Express 5 + helmet + express-rate-limit | Mature, small, well-understood middleware model for a single-owner internal app |
| Database | **SQLite** through built-in `node:sqlite` | Real relational DB with FKs, constraints, indexes, transactions — and **no native compilation** (better-sqlite3/Prisma engines need VS Build Tools on Windows). *Rejected:* PostgreSQL (no server available in env), JSON-file storage (no integrity) |
| Validation | zod | Declarative request/config schemas, well maintained |
| Import | papaparse-free RFC4180 parser (own, tested) + exceljs for `.xlsx` | Avoids vulnerable `xlsx`/SheetJS npm build; CSV parser is small, covered by tests |
| Auth | Opaque session tokens in `HttpOnly`/`SameSite=Strict` cookies, stored hashed; **scrypt** (`node:crypto`) password hashing | Memory-hard KDF from the platform standard library; avoids native bcrypt build. Login rate limiting, session expiry, CSRF double-submit |
| Frontend | **No-build ES-module SPA** (`src/web`), served statically | Internal dashboard for one owner; avoids bundler/200 MB toolchain and keeps `npm start` the single entry point. Tradeoff: no JSX/type checking in the browser layer — mitigated by a thin API client and integration tests against the API |
| Jobs | DB-backed in-process scheduler | Crash-safe persistence without Redis; every tick re-reads emergency-stop/mode state from the DB |
| Tests | `node:test` + `node:assert/strict`, running TS natively | Zero test-framework dependencies; unit + integration + API-level acceptance suites |

## 3. Layering

```
src/web           presentation (static SPA, fetch-based API client)
   │  HTTP/JSON
src/http          transport: routes, middleware, auth/CSRF/RBAC, error mapping
   │  typed service calls
src/domain        business logic — pure, framework-free, unit-testable
   │  ports (interfaces)
src/adapters      provider adapters: simulation/* today, real/* when credentials exist
src/db            connection, migrations, transactions
src/jobs          scheduler + tasks (call domain services, honour safeguards)
src/core          config, logger (redaction), errors, time/timezone, ids
```

Rules:

1. `domain` never imports `express`, `node:http`, or provider SDKs.
2. Provider-specific code lives only behind the ports in `src/adapters/contracts.ts`.
   Swapping a telephony vendor must not touch domain code.
3. Every outbound action goes through a single choke point
   (`domain/outreach/guard.ts`) that evaluates *all* safeguards before any
   adapter is invoked.
4. Simulation results are recorded with `provider='simulation'` and are never
   mixed with real provider events.

## 4. Operating modes & safeguards

`OPERATING_MODE` ∈ {`simulation`, `live`} + global `emergency_stop` flag.

* Default is **simulation**; live requires an explicit owner action with
  re-authentication and is written to the audit log.
* Restart/crash **never** auto-resumes outreach; the system comes back in
  `paused` and requires manual owner resume.
* Guard checks (all must pass, evaluated server-side):
  operating mode · emergency stop · contact eligibility · opt-out/DNC ·
  consent status · provider permission · configured calling hours (timezone
  aware) · daily call limit (100 hard default, retries counted) · budget cap ·
  duplicate-contact protection · follow-up limits · retry limits.
  Any failure ⇒ action blocked, reason recorded on the lead's outreach ledger.
* Budget/limit breach ⇒ hard block + owner alert; resuming or raising the cap
  requires explicit owner approval (audited).

## 5. Data model (SQLite)

Grouped entities (see `src/db/migrations/`):

* **Identity**: `users`, `sessions`, `login_attempts`
* **Leads**: `businesses`, `lead_sources`, `contact_points`, `verification`,
  `website_analyses`, `lead_scores`, `score_factors`, `eligibility_checks`,
  `suppression_list` (opt-outs/DNC)
* **Pipeline**: `pipeline_stages`, `lead_stage_history`, `interactions`,
  `followup_tasks`, `meetings`, `proposals`, `deals`, `payments`
* **Outreach**: `outreach_attempts` (guard-evaluated ledger), `calls`,
  `messages`, `provider_events` (idempotent by `provider+event_id`),
  `conversations`, `transcript_segments`
* **Governance**: `settings`, `campaigns`, `approval_requests`, `audit_events`,
  `incidents`, `backups`, `restore_tests`, `notifications`
* **Finance**: `budget_usage`, `cost_records`, `daily_reports`

Integrity: FKs enforced (`PRAGMA foreign_keys=ON`), unique constraints for
dedupe keys and provider event ids, CHECK constraints for enums, indices on
every hot filter (score, stage, next_followup_at, phone/website hashes).
Money is stored as **integer minor units** with an explicit currency.

## 6. Explainable lead scoring

`domain/scoring` returns `{ score, band, factors[] }` where every factor
carries `code`, `label`, `points`, `evidence`, and `weight_config_ref`.
Missing evidence ⇒ factor contributes `0` with `state:'unknown'` (never a
guessed value). Score never bypasses eligibility: prioritisation sorts by
`(score DESC, discovered_at ASC)` **over eligible leads only**.

## 6a. Lead import pipeline (Phase 3)

Import is **two-phase** so the UI can show a preview before anything is
written (`src/domain/leads/`):

1. `analyzeRecords()` — *read-only*: header-alias mapping, per-field
   validation, duplicate lookup, and a row status of
   `imported | needs_review | merged | rejected`.
2. `commitImport()` — one `BEGIN IMMEDIATE` transaction that inserts,
   auto-merges, writes provenance (`lead_sources.raw_payload_json` keeps the
   original row verbatim), per-field `field_verifications`, an `interactions`
   timeline entry, and an audit event.

Structural problems (no business-name column, no rows) throw a `400` and
write **nothing** — a malformed file is never a partial import.

**Normalisation** (`normalize.ts`) is deterministic and side-effect free, so
it is exhaustively unit-tested. Phones converge to E.164; a number that *looks*
Pakistani (trunk `0` or bare `3XXXXXXXXX`) must match a real PK shape or it is
rejected rather than silently accepted as an international number. Raw values
are always preserved for review.

**Deduplication** (`dedupe.ts`) has explicit confidence tiers:

| Score | Strategy | Action |
|---|---|---|
| 1.00 | identical normalised phone | automatic merge |
| 0.96 | identical website host | automatic merge |
| 0.92 | identical normalised name+city | automatic merge |
| 0.75–0.91 | fuzzy name (same city) | **manual review only** |
| < 0.75 | — | treated as distinct |

Merges never delete: the incoming row is retained with `merged_into_id` set,
its sources stay attached, and every kept/conflicting value is written to
`merge_history` + `audit_events`. Duplicates are re-evaluated **at commit
time** (not analysis time) so a phone repeated within a single file merges
against the earlier row instead of tripping the unique index, and a lead
imported between preview and commit is still caught.

**Schema note:** `businesses.merged_into_id` is self-referential with
`ON DELETE SET NULL`, and `ux_businesses_phone` is a partial unique index
(`WHERE merged_into_id IS NULL`). Deleting a merge survivor therefore
resurrects its merged rows as live rows mid-statement. Deletion routines must
remove merged rows before survivors (see the retention phase for the
production path).

## 6b. Website analysis, scoring & eligibility (Phase 4)

**Website analysis** (`src/domain/analysis/`) is honest by construction:

- `parse.ts` extracts only what a single static HTML response can prove
  (title, meta, viewport, HTTPS, H1/img/alt counts, forms, tel/mailto/WhatsApp
  links, nav, contact/about/privacy/portfolio presence) and derives
  evidence-backed `opportunities`. Everything it cannot establish from one
  fetch — Core Web Vitals, JS-rendered content, WCAG conformance, rankings —
  is returned in `notMeasured` so the dashboard never implies a full audit.
- `fetcher.ts` is hardened for attacker-influenced URLs: http/https only, a
  loopback/private/link-local/reserved block applied **after** DNS resolution
  on every redirect hop, and bounded time/size. Transport and DNS are
  injectable so tests run with no network while the SSRF guard still fires.
- A `no_website` result states the whole site is the gap (there is no page to
  audit); an `unreachable`/`blocked` result is recorded as such and is **never**
  converted into "the business has no website".

**Explainable scoring** (`src/domain/scoring/`) returns a weighted sum where
each factor carries `code`, `label`, `weight`, `points`, `state` and
`evidence`. A factor with no evidence scores `0` with `state:'unknown'` — a gap
is never filled with a guess. States distinguish `measured` (from our own
analysis) from `stated` (the prospect said it) and `estimated` (a heuristic).
The score only *orders* leads; it never bypasses eligibility.

**Contact eligibility** (`src/domain/eligibility/`) is the single gate consulted
before any outbound action, evaluated per channel. Publicly available contact
information does **not** establish marketing permission: with no recorded
consent the decision is `needs_review`/`ineligible`, never `eligible`. An
opt-out or do-not-contact record overrides every other signal. Decisions persist
their full sub-check set so a reviewer sees exactly which rule passed or failed.

Exposed over `/api/leads/:id/{analyze,analysis,score,eligibility,suppression}`;
state-changing routes are CSRF-protected and role-gated, and suppression is
owner-only.

## 6c. Pipeline, evidence & follow-ups (Phase 5)

The CRM's integrity rules are enforced in `src/domain/pipeline/`:

- **Interactions** (`interactions.ts`) are the evidence layer. Every stage
  change and every follow-up completion cites a real interaction. Bookkeeping
  kinds (`system`, `score`, `import`, `analysis`, `note`) are explicitly **not**
  customer contact, so automation can never manufacture the evidence that
  unlocks a customer-facing stage. Direction (`inbound`/`outbound`/`internal`)
  keeps a prospect's reply distinguishable from our own attempt.
- **Stage advancement** (`service.ts` → `advanceStage`) refuses
  `contacted`/`interested`/`qualified` without at least one real contact, and
  refuses `won` unless the actor is the owner — win-rate and revenue reporting
  are derived from confirmed conversions, so nothing else may assert one.
  Advancing optionally schedules the stage's follow-up cadence.
- **Follow-ups** (`followups.ts`) schedule work and keep it honest:
  sequences expand offsets into numbered tasks; every task is placed inside the
  owner's `calling_schedule` window (out-of-window times are pushed forward,
  never dropped); one active task per (lead, type, time) is enforced by a
  partial unique index and surfaced as `409 conflict`.
  `evaluateDueTasks` runs a scheduler tick that (1) promotes arrived
  `scheduled` tasks to `due`, then (2) re-checks eligibility:
  - `eligible` → task stays `due` and may execute;
  - `needs_review` → consent merely unconfirmed: flagged via `blocked_reason`
    but left `due`, so a human can record consent and let it proceed — pending
    work is **not** destroyed;
  - `ineligible` → suppressed / no destination / channel disabled → moved to
    `blocked` and will not run.
  A suppression recorded **after** scheduling therefore still stops the
  outreach, because eligibility is re-checked when the task comes due.
- **Completion** requires a customer-contact interaction, so a follow-up can
  never be closed with an internal note.

Consent is recorded as an interaction of kind `consent` (migration
`007_consent_interaction.sql` added that kind by rebuilding `interactions`;
since SQLite cannot alter a CHECK constraint, the migration runner now toggles
`PRAGMA foreign_keys` **around** the migration run — it is a no-op inside a
transaction — and runs `PRAGMA foreign_key_check` afterwards so a rebuild can
never silently null child evidence links).

Exposed over `/api/leads/:id/{timeline,interactions,advance,followups}` and
`/api/followups/{:id,complete,cancel,evaluate-due}`; state-changing routes are
CSRF-protected and role-gated.

## 6d. Outreach guard, simulation calling & portfolio sharing (Phase 6)

`src/domain/outreach/` is the only code that performs an outbound action, and
it always runs the same five steps in order — the ordering itself is a safety
property:

1. **Guard** (`guard.ts` → `runGuard`) evaluates every safeguard in a fixed,
   documented order — emergency stop → pause → operating mode/provider →
   eligibility (consent, suppression, destination, channel switch) → daily
   volume → daily budget → calling window — and produces an allow/block
   verdict with the complete check list. **Blocked is a first-class result**,
   never an exception: refusing to contact someone is a successful safety
   outcome, so the API answers `200 { decision: 'blocked', attempt }` with the
   reasons, while an allowed action answers `201`.
2. **Ledger** (`recordAttempt`) writes exactly ONE `outreach_attempts` row per
   requested action, allowed or blocked, with all guard checks in
   `guard_results_json` — the audit answer to "why was this call made / not
   made". A client-supplied idempotency key makes the request replay-safe: a
   double-click returns the original row and can never place a second call.
3. **Counters** are consumed with an atomic
   `UPDATE ... WHERE used_value + ? <= limit_value` inside the transaction, so
   the hard caps (100 calls/day, budget) are enforced by SQLite itself; a
   request that loses the race becomes the blocked ledger entry rather than
   sneaking past the cap. `budget_usage.limit_value` is refreshed from the
   effective limit (owner setting clamped by the compiled-in ceiling) on every
   check, so the reported and enforced numbers can never diverge.
4. **Adapter** — simulation today. `simulation.ts` derives the rehearsal
   scenario deterministically from (lead id, business-day key): the same lead
   rehearses the same way all day, making training runs and tests reproducible
   without randomness. A simulated call writes a `calls` row
   (`provider='simulation'`, `simulation=1`), and when the scripted scenario is
   answered, a conversation whose transcript (a) opens with a system turn
   declaring the simulation, (b) always discloses the agent is an AI, and
   (c) marks every "prospect" turn as an explicit scripted placeholder — no
   real person's words are ever invented. Live mode requires the channel's
   provider to be configured (the guard checks) and will refuse execution
   until the Phase 7 adapters exist.
5. **Timeline** records the interaction with `simulation = 1` (migration
   `008_simulation_interaction.sql`). This flag is what keeps rehearsals
   honest end-to-end: `hasContactEvidence` excludes simulated rows, so a
   rehearsal can never move a lead to `contacted`/`interested`/`qualified`,
   and `completeTask` refuses simulated interactions, so a follow-up can only
   be closed by real contact. The calling window blocks automated voice
   outreach (`purpose != 'callback'`) but records — rather than enforces — it
   for an owner's explicit "call now".

**Portfolio sharing** (`portfolio.ts`, `service.ts` → `sharePortfolio`) obeys
a two-key rule: only items that are BOTH `verified` (the owner confirmed the
case study is real) AND `approved` (the owner wants it used) may ever be
quoted or sent. Selecting an unapproved item is a 400 naming every offender —
an operator cannot silently push a draft, and the system never silently drops
one either. Un-verifying an item also revokes its approval so no stale flag
keeps unverified material shareable. A share runs the full guard on the
`whatsapp_message` channel, consumes the daily message counter, writes a
`messages` row (`provider='simulation'`, `status_source='simulation'`, a
redacted truncated `body_preview` prefixed `[SIMULATION]`) and a
simulation-flagged timeline interaction.

Exposed over `/api/leads/:id/{call,portfolio/share,outreach,conversations[:conversationId]}`
and `/api/portfolio` (list/create/get for owner+staff; `verify`/`approve` are
owner-only). Conversations expose segments with their `source`, so a reader
can always tell a rehearsal from a real call. Phase 7 wired live providers
into this same seam (section 7) — simulation remains the default mode.

## 7. Provider adapters (ports) — Phase 7

`src/adapters/types.ts` defines the ports: `TelephonyPort`, `WhatsAppPort`,
`ConversationPort` (AI), `SpeechPort` (STT/TTS), `EmailPort` (SMTP),
`DiscoveryPort`. Three rules the interfaces encode:

1. **A port never decides whether an action is allowed.** The outreach guard
   decides; the orchestration service then calls a port. Adapters cannot
   bypass — or even see — the safeguard stack.
2. **Every adapter reports an honest status** (`configured`/`unconfigured`/
   `error`, features, redacted `lastError`) served by `GET /api/integrations`
   (auth-only). Secret values never leave the registry.
3. **All HTTP goes through an injectable `fetch`** (`src/adapters/http.ts`,
   with timeout + `AdapterError` mapping). Tests exercise the real request
   construction and error mapping with a fake transport; a unit test cannot
   reach a real provider by accident.

### Implementations shipped

| Port | Implementation | Notes |
|---|---|---|
| Telephony | `telephony/twilio.ts` | REST `Calls.json` (form-encoded, basic auth). Provider error codes mapped (`21211`→`invalid_destination`, 429→`rate_limited`). **Never requests recording** — no consent, no `Record` param. Also owns Twilio's webhook signature validation (HMAC-SHA1 over URL + sorted params, timing-safe). |
| Telephony | `telephony/cloudyvoice.ts` | CloudyVoice is a SIP *termination carrier* (no carrier HTTP API), so this adapter talks to **our own gateway control API** (`GET /v1/health`, `POST /v1/calls` on `SIP_GATEWAY_BASE_URL`, bearer `SIP_GATEWAY_API_TOKEN`). Error mapping: 401/403→`provider_error`, `invalid_destination`/`unroutable`→`invalid_destination`, 429→`rate_limited`. Free `ping()` reports SIP registration state without placing a call. **No carrier value (host/port/codec/CLI/credential) exists in the backend** — those live only in `deploy/sip/` on the VPS. |
| WhatsApp | `whatsapp/cloud.ts` | Cloud API **template sends only** (free-form text to a prospect who has not messaged us first is never permitted). Owns Meta's `X-Hub-Signature-256` verification (HMAC-SHA256 over the RAW body, timing-safe). Without an app secret, webhooks are **refused**, not accepted unverified. |
| AI conversation | `ai/openai.ts` | OpenAI-compatible chat completions (`AI_*` env). Defined + unit-tested; **not yet wired** into a live-call media pipeline (see limitations below). |
| Speech | `speech/openai.ts` | OpenAI-compatible STT (`/audio/transcriptions`, dependency-free multipart that preserves audio bytes) + TTS. Same wiring status as AI. |
| Email | `email/smtp.ts` | Minimal SMTP client over `node:net`/`node:tls` (STARTTLS or implicit TLS). **Plaintext SMTP is refused for non-loopback hosts** so a misconfiguration can never ship credentials in the clear; auth tokens never appear in errors. Used by Phase 8 notification delivery. |
| Discovery | `discovery/unconfigured.ts` | No vendor is chosen yet (owner decision: cost/terms/quota), so `search()` throws `unconfigured` — discovery continues via CSV/Excel import. The platform never invents leads. |

`src/adapters/registry.ts` builds an `AdapterRegistry` once at bootstrap from
(config, env): each port resolves to an adapter only when its credentials are
present, else `null` + an honest status. The registry also holds the webhook
signing secrets internally (verify methods, not raw values) and the portfolio
template name. `createApp` builds a default registry; **in tests the default
is EMPTY (never `process.env`)**, so a developer's local credentials can never
be exercised by the suite; `startTestServer` injects an env-derived registry
plus a fake transport.

### Live execution seam (same guard, new adapter)

`placeCall`/`sharePortfolio` (Phase 6) became `async` and gained one input:
optional `adapters`. Ordering is unchanged — guard → ledger → atomic daily
counter → adapter → timeline — with these live-mode properties:

* The provider call happens **outside any transaction** (network I/O inside
  `BEGIN IMMEDIATE` would stall every writer). The counter is consumed in its
  own transaction *before* the call, so a provider failure keeps the slot: a
  retry is a new request, exactly as the daily-limit setting documents.
* A provider rejection is **ledgered, not swallowed**: a `calls`/`messages`
  row with `status='failed'` + `failure_code`, an attempt row carrying the
  executing provider's key, and a timeline interaction of kind `system`/
  `internal` — deliberately NOT a contact kind, so a failed dial can never
  evidence a customer-facing stage change.
* At most one live call/message per lead may be in flight (application-level
  mirror of the `ux_calls_live_per_business`/`ux_messages_live_per_business`
  indexes); a double-click gets a first-class `blocked` result with the slot
  refunded, not a constraint error.
* Missing adapter/template/destination blocks **before** any counter is spent.
* Simulation mode ignores installed adapters entirely: a configured provider
  can never turn a rehearsal into a real dial (asserted in tests by proving
  the fake transport saw zero calls).

### Provider webhooks (`src/http/routes/webhooks.routes.ts`)

The only unauthenticated POST endpoints, authenticated by signature instead
of session: `POST /api/webhooks/whatsapp` (Meta delivery statuses + inbound
messages, verified over `req.rawBody` captured by the JSON parser's `verify`
hook — never re-serialized JSON), `POST /api/webhooks/telephony/twilio`
(Twilio status callbacks), `GET /api/webhooks/whatsapp` (Meta subscription
challenge, owner-configured verify token, 404 when unconfigured), and
`GET /api/webhooks/telephony/twilio/voice` (TwiML answer URL: the mandated
AI-identity disclosure, then — when the duplex bridge is enabled with both
speech and AI ports present and the call is attributable to a lead —
`<Connect><Stream>` into the live bridge; otherwise the fixed greeting +
`<Hangup/>`; signature-checked; 404 when unconfigured).
Ingestion runs through `src/domain/outreach/providerevents.ts`:
`(provider, event_id)` is UNIQUE in `provider_events`, so provider retries
are counted (`duplicate_count`) and change nothing twice; the raw payload is
stored for audit; unmatched events are `ignored` with a reason, never guessed
at. An inbound WhatsApp message with STOP-class wording suppresses the lead
**first** (append-only, authoritative) before the inbound interaction is
recorded, so a later crash cannot un-suppress anyone. `GET /api/integrations`
reports adapter statuses (secret-free) alongside credential presence.

### Live-call media path (duplex bridge)

* An answered call is served the duplex TwiML: the **AI-identity disclosure**
  spoken first, then `<Connect><Stream>` into the WebSocket bridge at
  `/api/media` (signed, expiring token bound to the CallSid — a WebSocket
  upgrade cannot carry a Twilio signature header). The bridge runs the real
  conversation loop: μ-law frames → voice-activity utterance detection →
  STT → engine turn (disclosure + turn ceiling) → TTS → paced μ-law frames
  back, with barge-in, DTMF human-handoff digits, and hard caps on utterance
  and call duration. It never dials, never records (`<Record/>` is never
  emitted), and audio lives in memory only for the duration of a turn.
* When the bridge is disabled, speech/AI are missing, or the caller cannot be
  attributed to a lead, the answer URL serves the **fixed, approved TwiML
  greeting** with the disclosure and hangs up — a stream that could only
  produce silence or invented speech is never opened.
* Live call outcome before provider callbacks arrive is `unknown` — never
  assumed `answered`.

### CloudyVoice SIP gateway bridge (`deploy/sip/`, `src/http/routes/gateway.routes.ts`, `src/server/gatewaymedia.ts`)

When `TELEPHONY_PROVIDER=cloudyvoice`, outbound calls are placed through a
gateway process we run (Asterisk/FreeSWITCH — engine chosen by the Phase-1
spike) that speaks SIP/RTP to the carrier and **our own contract** to this
backend (`deploy/sip/contract.md`):

* **Control (backend → gateway):** `POST /v1/calls` originates one call,
  `GET /v1/health` is the free onboarding/health probe (bearer-authenticated,
  never dials, reports SIP registration state).
* **Answer fetch (gateway → backend):** `GET /api/webhooks/telephony/gateway/answer`
  (bearer) returns the *same decision* the Twilio answer URL makes, as JSON
  instead of TwiML: `{action:'bridge', mediaUrl, greeting, mediaFormat}` for an
  attributable call, `{action:'hangup', greeting}` otherwise. The greeting
  always leads with the mandated AI disclosure; no recording instruction ever
  exists on this path.
* **Lifecycle events (gateway → backend):** `POST /api/webhooks/telephony/gateway/events`
  signed with HMAC-SHA256 over the RAW body (`SIP_GATEWAY_EVENT_SECRET`,
  timing-safe compare), ingested idempotently under `provider='cloudyvoice'`;
  `sipCause` (Q.850) maps through `domain/outreach/gatewayevents.ts` and
  outcomes derive from reported facts only (duration decides `answered`).
* **Media:** `wss://…/api/gateway/media` runs the *same* `createDuplexSession`
  as Twilio after translating the gateway dialect (`open/audio/digit/hangup`,
  `callId`↔`callSid`, `pcmu` aliases→`audio/x-mulaw`; foreign codecs pass
  through so the session refuses them honestly). Outbound frames keep Twilio's
  `{event:'media', media:{payload}}` shape on purpose, so a gateway can be
  built by adapting a Twilio Media Streams client. Both bridges share one HTTP
  server via `src/server/upgrade.ts` (claim + fallback → unknown paths 404).
* Registry URLs are provider-driven: gateway paths when `cloudyvoice`,
  Twilio's **byte-identical** historical paths otherwise (asserted by tests).
  Status is reported honestly: CloudyVoice is **NOT connected** until SIP
  registration + an owner-approved test call are verified — `npm run doctor`
  prints that warning by name and never prints a secret value.

## 7b. Notifications, daily reports & reconciliation (Phase 8)

### Notifications (`src/domain/notifications/service.ts`)

The `notifications` table (migration 001) is the owner's operational inbox.
Every event fans out to **one row per destination channel** from the
`notification_destinations` setting (dashboard → `in_app`, plus email/WhatsApp
numbers when set), and dedupes **per channel** via the derived key
`${dedupeKey}:${channel}` — so a recurring event can never raise twice on one
channel but still reaches dashboard + email when both are configured. The
dashboard is the guaranteed fallback channel: nothing is ever silently dropped.

Delivery (`deliverPendingNotifications`, run by the `notification_delivery`
job every 60 s) is explicit about every outcome:

* email → `sent` (with the provider message id) or `failed` (with a
  length-capped, secret-free reason)
* WhatsApp → **always `skipped`** with the honest reason: Meta template policy
  forbids free-form notification text to a number that has not messaged us
  first, and no notification template is approved. The dashboard in-app row is
  the delivery.
* SMTP unconfigured → `skipped` naming the missing env vars; the notification
  stays visible in-app.

"Read" is tracked by `read_at`, not by overwriting `status`, so a read email
never loses the fact that it was sent (in-app rows move `pending` → `read`).

### Daily reports & reconciliation (`src/domain/reporting/`)

`generateDailyReport` writes exactly **one row per business day**
(`daily_reports.report_date` is UNIQUE; regeneration refreshes it in place and
reuses the stored id). A past day is always `final`; a report the owner
previewed for today is a `draft` and never notifies. Future dates are refused.

* **Totals** are computed from the ledger over the business-day UTC window
  (`businessDayUtcRange`, Asia/Karachi): leads created, attempts by
  decision/channel/block-code, calls & messages simulated vs live with
  status/outcome breakdowns, opt-outs, interactions, follow-ups, budget
  usage vs limits, and costs **only from `cost_records`** — with no provider
  billing feed the total is 0 *and* the missing-data note says why.
* **Reconciliation** (`reconcileDay`) compares our own records against each
  other for one day and emits discrepancies with sample refs:
  * `missing_execution` (critical): an allowed attempt with no call/message row
  * `counter_drift` (critical): `budget_usage.used_value` ≠ allowed-attempt
    count — the hard caps could be wrong
  * `call/message_without_provider_callback` (warning): a live row still
    non-terminal 15+ minutes after placement (a webhook was missed)
  * `cost_data_unavailable` (info + missing-data note): activity without a
    billing feed — reported as unavailable, never estimated
* A `final` report raises **one** owner notification per date
  (`report_ready:<date>` dedupe) whose email body is a plain-text summary of
  the same numbers.

Routes (`src/http/routes/reporting.routes.ts`, mounted at `/api`): reports are
**owner-only** (they carry budget/spend figures) —
`GET /api/reports`, `GET /api/reports/:date`, `POST /api/reports/:date/generate`
(audited `report.generate`); notifications are owner+staff —
`GET /api/notifications`, `POST /api/notifications/:id/read`,
`POST /api/notifications/read-all`. Auth is applied **per route**: a
router-level guard mounted at the shared `/api` prefix would intercept the
public health endpoint and the signature-authenticated webhooks.

### Jobs (`src/jobs/reporting.ts`)

| Job | Interval | Behaviour |
|---|---|---|
| `daily_report` | 1 h | Finalizes yesterday always (an honest zero report for a quiet day); self-heals up to 7 days back **only** for days with outreach activity or an unfinalized draft, so a fresh install backfills no noise |
| `notification_delivery` | 60 s | Drives the email/WhatsApp queue through the shared adapter registry; runs even while paused (the owner must hear about an emergency stop while stopped) |
| `safeguard_notifications` | 5 min | Raises a critical notification for an active emergency stop (keyed by stop timestamp) and warning/critical ones for today's budget rows in `warning`/`exhausted` (keyed by date+metric+state) |

The server builds **one** adapter registry (`buildRegistry(config)`) shared by
the HTTP layer and the scheduler, so notification delivery and the outreach
seam see the same adapters and statuses. Jobs that do nothing return no detail
and are **not** written to `job_runs` (a 60-second watcher would churn the
bounded 500-row history and bury real failures); failures and skips are always
recorded and raise incidents as before.

## 8. Security

* Least-privilege RBAC (`owner`, `staff`), session expiry, login rate limit,
  CSRF double-submit, output encoding, strict input validation (zod).
* Secrets only via environment variables — never rendered to the client; a
  response-level redaction filter prevents accidental leakage.
* Structured logs with phone/email/token redaction (configurable).
* Audit events (append-only) for: login, settings changes, budget changes,
  approvals, live activation, emergency stop/resume, merges, conversions,
  financial changes, exports/deletions.
* Security headers via helmet + a strict CSP for the SPA.

## 9. Backup & recovery (Phase 9)

### Taking a backup (`src/domain/backup/service.ts`)

`runBackup` takes a **verified** snapshot of the live database:

1. a `backups` row is inserted with status `running` **before** any file work,
   so even a failure as mundane as an uncreatable directory is recorded,
   notified and auditable (the `backup.failed` audit event + a critical
   notification, then the error is rethrown so the scheduler/CLI reports it)
2. `VACUUM INTO ?` (bound parameter, no string interpolation of paths)
   produces a consistent snapshot of the live WAL database without blocking
   writers
3. when `BACKUP_PASSPHRASE` is set the stored file is encrypted with
   **AES-256-GCM** (`src/domain/backup/crypto.ts`, format `UWSBK1`:
   magic | salt | iv | ciphertext | tag, key = scrypt(passphrase, salt), the
   header is bound as AAD). Without a passphrase the file is stored as a
   plain SQLite file and the row honestly records `encrypted = 0` — no false
   sense of protection
4. the **stored** file (after encryption) is hashed (sha256) and then
   reopened and verified: `PRAGMA integrity_check`, `PRAGMA foreign_key_check`,
   required tables present, owner account exists — and the per-table row
   counts are recorded as a **manifest** in `verify_result`. A backup that
   fails verification is deleted and reported as a failure; it never counts.
   A failure writes the failed row + `backup.failed` audit event on **every**
   attempt, but the critical alert is deduped to **one per day** — the job
   retries hourly, so per-attempt alerts would email-spam the owner while a
   backup is broken.
5. retention pruning deletes backups older than `BACKUP_RETENTION_DAYS` —
   but **never the newest one** (deleting the last remaining copy would be
   indefensible). `restore_tests` rows cascade with their backup (FK).

Every pragma runs inside its own try/catch: SQLite *raises* on a corrupt
file rather than returning a sad value, so verification always reports
through the checks array and never throws mid-flight.

### Restore tests (`runRestoreTest`)

A backup that cannot be restored is worse than no backup — it breeds false
confidence. The `restore_test` job (hourly tick, acts when the newest test
is older than `RESTORE_TEST_INTERVAL_DAYS`) re-opens the **stored** backup
(decrypting if needed), runs the full check set, and additionally compares a
fresh recount against the **manifest captured at backup time** — silent
drift that "the file opens" would miss is caught here. The result is stored
in `restore_tests` with every check; a failure raises a critical
notification and a `backup.restore_test` audit event. The owner can also
trigger a test on demand: `POST /api/backups/:id/restore-test` (owner-only,
CSRF-protected).

### Restoring (`src/domain/backup/restore.ts`, `npm run restore`)

* `npm run restore -- --to <path>` verifies a backup and writes a
  **restorable copy** to the target path; the live database is untouched.
* `npm run restore -- --backup <id> --apply --confirm` replaces the live
  database file. It requires **both** flags, re-probes the live file with an
  exclusive-lock attempt (a running server holds the WAL write lock and is
  detected), and refuses on `conflict`.
* Before the swap, opt-outs recorded in the **live** database **after** the
  snapshot was taken are captured (`capturePostBackupSuppressions`); after
  the swap they are re-applied onto the restored file
  (`applyRestoredSuppressions`, idempotent — matching by id or by
  business+reason against the unique index). **A restore therefore never
  resurrects a business that opted out after the backup was taken**, and the
  snapshot itself always contains the `suppression_list` as of its time.
* The pre-restore files are renamed aside (`*.pre-restore-<timestamp>`),
  never deleted, and the restored file is verified (integrity + FK) before
  the command reports success.

### Jobs, CLI & monitoring

* Jobs (`src/jobs/backup.ts`): `backup` and `restore_test`, both no-ops
  (silent, no `job_runs` churn) while `BACKUP_ENABLED=false`; both tick
  hourly but only act when due, so a restart never mass-creates backups.
  The server builds one adapter registry and one config shared by HTTP and
  jobs.
* CLI: `npm run backup` (take now), `npm run backup -- list`, `npm run
  backup -- test`, `npm run restore`. The backup CLI warns when
  `BACKUP_PASSPHRASE` is unset; `npm run doctor` gained a **Backups**
  section (dir writable, encryption configured, last backup age/status, last
  restore test) and stays green on a system where backups are honestly
  disabled.
* Monitoring: `GET /api/backups` (owner-only — paths are operational
  detail) returns config summary, the newest backup, the newest restore test
  and both histories; `/api/system` includes a compact `backups` summary for
  the dashboard without exposing paths to staff.

Honest limitation, documented rather than hidden: the plaintext is held in
memory during encrypt/decrypt (whole-file AES-GCM). This is acceptable at
this deployment's scale (a sales CRM database) and the format is
authenticated end to end, so tampering is always detected.

## 10. Testing strategy

| Suite | Scope |
|---|---|
| `tests/unit` | scoring, eligibility guard, dedupe, CSV parsing, schedule/timezone, follow-up rules, redaction, **provider adapters (request shape, signature verification, error mapping, SMTP loopback dialogue)**, **backup encryption (roundtrip, wrong passphrase, bit-flip/tamper, truncation, header stripping)** |
| `tests/integration` | migrations, repositories, merge/audit transactions, import pipeline, **reconciliation & daily reports, notifications fan-out/delivery, reporting jobs (daily report, notification delivery, safeguard watch), outreach guard/simulation/portfolio sharing, live-mode execution seam, provider webhooks (signature, idempotency, inbound STOP), backups (verified snapshot + manifest, encrypted-at-rest, failure recording, retention pruning, restore tests incl. corrupted backup, restore helpers & opt-out re-merge, backup/restore jobs, owner-only monitoring routes)** |
| `tests/api` | HTTP acceptance: auth, RBAC, CSRF, lead CRUD, emergency stop, budget, mode transitions |
| Manual | `docs/acceptance-test-plan.md`, `docs/security-checklist.md` |

No test may ever touch a real network: the test harness injects a fake
transport into every adapter (`startTestServer(env, { fetchImpl })`), and the
default registry built in the test environment is empty — never `process.env`
— so a developer's local credentials cannot be exercised by the suite. Live
tests additionally prove the negative: simulation mode with fully configured
providers performs zero network calls.

## 11. Explicitly not (yet) implemented / external dependencies

See the final status table in `README.md`. Specifically:

* **Lead discovery** is wired to a real, free, keyless vendor (OpenStreetMap
  via the Overpass API, `DISCOVERY_PROVIDER=overpass`, Pakistan scope —
  Phase 12). The port still reports `unconfigured` when no provider is
  selected, and import remains fully functional regardless.
* **Live call media pipeline** (duplex audio) is fully wired: the answer TwiML
  opens a Twilio Media Stream and the bridge drives STT → engine turn → TTS
  over real two-way audio (see §6b/§7). It activates the moment telephony +
  AI + speech are configured; until then the fixed approved greeting is
  served. Recording is never enabled — no consent flow exists, so the TwiML
  never emits `<Record/>`.
* **Telephony / WhatsApp / SMTP / AI / STT** integrations are **unconfigured**
  until real credentials and provider approvals (Meta
  template approval) exist — listed with exact owner actions in
  `docs/external-dependencies.md`. Simulation remains the default operating
  mode; the owner-only `setMode('live')` path requires provider configuration
  to exist and is never auto-activated.
