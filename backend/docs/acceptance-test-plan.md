# Acceptance Test Plan — UWS AI Sales Calling Agent

> Manual acceptance walkthrough, phase by phase. It **complements** the
> automated suite (`npm test` — 332 tests / 48 suites, all green): the
> automated tests pin behaviour at the unit/integration/API level, and this
> plan covers the end-to-end, human-visible paths through the dashboard, CLI
> and reports that a script cannot fully assert.
>
> **Rule for every step below:** run it in `simulation` mode against a
> throw-away database. No step contacts a real customer. Where a step says
> "verify in the dashboard", sign in as the owner unless it says staff.

## Before you start

```bash
npm install
npm run setup        # migrate + create the first owner account
npm run doctor       # must exit 0; note which providers are unconfigured
npm test             # must be all green before you trust any manual result
npm start            # open http://localhost:3100
```

Record the database path shown by `npm run doctor` (default
`./data/uws.sqlite`) so you can reset between destructive sections.

---

## Phase 1–2 — Boot, auth, RBAC, operating state

| # | Step | Expected |
|---|---|---|
| 2.1 | Open the dashboard logged out | Login screen; no app chrome leaked |
| 2.2 | Sign in with the owner account | Shell loads; topbar shows the operating-state badge |
| 2.3 | Sign in with a wrong password | Generic "Incorrect email or password" — no hint whether the account exists |
| 2.4 | Submit ~6 bad logins quickly | HTTP 429 / "Too many requests" |
| 2.5 | `GET /api/auth/me` (browser dev tools) | `{user, csrfToken, reauthValid, sessionExpiresAt}`; no `password`, no `csrf_secret` |
| 2.6 | Session cookie in dev tools | `HttpOnly`, `SameSite=Strict`; the `uws_csrf` cookie is readable by JS (double-submit) |
| 2.7 | Create a **staff** user (System → Add user), sign in as staff | Staff sees no owner-only nav (Reports / Backups / Settings) |
| 2.8 | As staff, open `/api/settings` in dev tools | `403 forbidden` |
| 2.9 | Restart the server (`Ctrl-C`, `npm start`) | Topbar badge shows **paused**; a banner says manual owner resume required; `restartCount` incremented |
| 2.10 | Trigger **STOP ALL** from any screen | Reason prompt → confirm; state banner turns to EMERGENCY STOP; every outbound action is now blocked |
| 2.11 | As owner, **Resume outreach** | Readiness checks table shown; resume requires a fresh password re-auth |

---

## Phase 3 — Lead import, normalisation, dedupe

| # | Step | Expected |
|---|---|---|
| 3.1 | Leads → **Import CSV / Excel** with a small CSV (name, city, phone, website, email) | Preview modal: total rows, will-import, merged, needs-review counts; unmapped headers listed, not silently dropped |
| 3.2 | Cancel the preview | **Nothing** persisted (reload the list — still empty) |
| 3.3 | Commit the import | Per-row outcomes; leads appear in the list sorted by score |
| 3.4 | Import a second file containing the same phone / website host / name+city | Exact matches **auto-merge** (no duplicate rows); conflicts recorded in merge history |
| 3.5 | Import a near-name match (fuzzy) | Flagged for manual review — **never** auto-merged |
| 3.6 | Duplicates screen | Pending candidates listed with confidence + strategy; **Merge** and **Not a duplicate** both keep data (nothing deleted) |
| 3.7 | Edit a lead's phone to a malformed value | Rejected with a reason; original value preserved |
| 3.8 | Import a file with no recognisable name column | Whole file rejected with an explanation naming what was found |

---

## Phase 4 — Website analysis & explainable scoring

| # | Step | Expected |
|---|---|---|
| 4.1 | Lead detail → Analysis → **Analyze website now** (a lead with a URL) | A result card: reachability, HTTP status, extracted facts (JSON), and an "explicitly NOT measured" section |
| 4.2 | Analyze a lead with **no** website | `no_website` — a finding, not an error |
| 4.3 | Analyze a lead whose host is unreachable | `unreachable` — **never** reported as "no website"; never a fabricated page |
| 4.4 | Analyze a private/internal host (e.g. `http://127.0.0.1`) | Blocked by the SSRF guard **before** any request; no fetch attempted |
| 4.5 | Lead detail → Score | Score ring + band; a factor table with code, points, weight, evidence-state badge (`measured`/`stated`/`estimated`/`unknown`), observed value and evidence text |
| 4.6 | A lead with a clean, modern site vs one with none | The weak/absent site scores **higher** on the website-gap factor |
| 4.7 | Lead detail → Eligibility → evaluate a channel | A stored decision (eligible / ineligible / needs_review) with the full reason list |

---

## Phase 5 — CRM pipeline, evidence, follow-ups

| # | Step | Expected |
|---|---|---|
| 5.1 | Record an interaction (kind=call, summary) | Appears on the timeline with kind/direction/timestamp |
| 5.2 | Advance stage to **Interested** with no evidence | **Refused** — customer-facing stages require a real contact interaction |
| 5.3 | Advance to **Interested** with a contact summary | Allowed; the evidence interaction is linked; the follow-up cadence is scheduled |
| 5.4 | Try to advance to **Won** as staff | Refused — only the owner confirms a conversion |
| 5.5 | Schedule a follow-up at an out-of-window time | Scheduled time is pushed to the next permitted calling slot |
| 5.6 | Schedule a follow-up at a duplicate active slot | `409 conflict` |
| 5.7 | Complete a follow-up with only a `note` interaction | Refused — completion requires a customer-contact interaction |
| 5.8 | Add a suppression, then let a due task come up | The task is **blocked** with the suppression reason recorded, not silently run |
| 5.9 | Pipeline screen (cross-lead board) | All follow-ups across leads with status, scheduled time, blockers; evaluate-due re-checks without performing outreach |

---

## Phase 6 — Outreach guard, simulation, portfolio

| # | Step | Expected |
|---|---|---|
| 6.1 | Place a call on a lead with no consent recorded | `200 {decision:'blocked'}` with the full check list; a ledger row records the reason |
| 6.2 | Record consent + enable the call channel, then place a call | `201 {decision:'allowed', simulated:true}`; a simulation-labelled call row + transcript that declares itself simulated |
| 6.3 | Place the same call again with the same idempotency key | Never dials twice |
| 6.4 | Place a call while the system is paused / emergency-stopped | Blocked with the exact code (`paused` / `emergency_stop`) |
| 6.5 | Portfolio → create an item | Starts **unverified + unapproved**; not shareable |
| 6.6 | Approve before verifying | **Refused** — the two-key rule |
| 6.7 | Verify, then Approve | Now shareable; sharing is rehearsed and labelled simulated |
| 6.8 | Un-verify a verified item | Approval is **revoked**; the item is no longer shareable |

---

## Phase 7 — Provider adapters & live seam (configured providers only)

> Skip if every provider is unconfigured (the honest default). To exercise,
> supply credentials in `.env` and re-run `npm run doctor` until the provider
> shows `configured`.

| # | Step | Expected |
|---|---|---|
| 7.1 | Activate **LIVE** mode (dashboard, owner + re-auth) | Requires provider configuration to exist; otherwise `provider_unavailable` and mode stays simulation |
| 7.2 | In live mode, place a call | Ledger → counter → adapter → timeline ordering; the call row is labelled `live` (not simulated) |
| 7.3 | Inbound WhatsApp `STOP` (signed webhook) | Lead is suppressed **immediately**; the reply is recorded; the suppression blocks all channels |
| 7.4 | An invalid webhook signature | `401`; the payload is never touched |
| 7.5 | Share the portfolio in live mode | Only the **approved template** is sent — never free-form text |
| 7.6 | The TwiML answer URL (signed request) | Speaks the AI disclosure; with the duplex bridge ready it opens `<Connect><Stream>` (disclosure first), otherwise it hangs up; **no** recording is enabled either way |
| 7.7 | Answered call over the media stream (with speech + AI configured) | The prospect's utterance becomes a transcript segment, the agent replies in audio, barge-in stops playback, DTMF `0`/`1` requests a human per policy, and the call ends with qualification extracted |
| 7.8 | WebSocket upgrade to `/api/media` without a valid signed token | `401`; with a token but an unknown call `404`; while the call is already streaming `409`; bridge disabled or speech/AI missing `503` |

---

## Phase 8 — Notifications, reconciliation, daily reports

| # | Step | Expected |
|---|---|---|
| 8.1 | Reports screen → **Generate / refresh** for a past date | A `final` report; today's is a `draft`; future dates rejected |
| 8.2 | Read the report totals | Leads, attempts (allowed/blocked + by code), calls (simulated/live), messages, opt-outs, follow-ups, spend |
| 8.3 | Reconciliation panel | Checks pass/fail; discrepancies listed with severity, count and sample refs; missing data reported as *missing*, **never estimated** |
| 8.4 | Regenerate the same date | Idempotent — still exactly one report row for that date |
| 8.5 | Notifications screen | Fan-out creates one row per destination channel; unread count; mark-one / mark-all read preserve delivery state |
| 8.6 | Disable SMTP, trigger a notification that targets email | Delivery is **skipped honestly** with the reason, not silently dropped |
| 8.7 | Reports are owner-only | Staff get `403` on `/api/reports`; staff **can** read notifications |

---

## Phase 9 — Backup, restore, restore tests

| # | Step | Expected |
|---|---|---|
| 9.1 | `npm run doctor` with `BACKUP_ENABLED` unset | Backups section warns "DISABLED" — honest, no false confidence |
| 9.2 | Set `BACKUP_ENABLED=true`, `BACKUP_PASSPHRASE=…`, restart, `npm run backup` | A `verified`/`completed` row; the stored file is encrypted (a raw SQLite open fails) |
| 9.3 | Backups screen | Config cards (interval, retention, encryption state), last backup, last restore test, history with verification checks |
| 9.4 | Trigger a **Restore test** on a good backup | `passed` — decrypted, opened, integrity + FK + row-count manifest all recounted |
| 9.5 | Restore test a corrupted backup | `failed` + a **critical** notification; the corruption is caught, not glossed |
| 9.6 | `npm run restore -- --to ./restored.sqlite` | Writes a restorable copy; the live DB is untouched |
| 9.7 | Record an opt-out **after** the backup, then `npm run restore -- --backup <id> --apply --confirm` | The opt-out recorded after the snapshot is **re-applied** — a restore never resurrects a suppressed business |
| 9.8 | Let retention run with a very short window | Old backups pruned, but the **newest** backup is never deleted |

---

## Phase 10 — The dashboard (SPA) end-to-end

| # | Step | Expected |
|---|---|---|
| 10.1 | Load `/` in a fresh browser | Shell renders; hash router works; STOP ALL is visible on **every** screen |
| 10.2 | Dev tools → console | No CSP violations; no inline `<script>`; no inline `on…=` handler attributes |
| 10.3 | Dashboard | State banner, resume-readiness checks, provider cards, recent jobs, open incidents, resume/mode/stop actions |
| 10.4 | Leads list | Filters (search, stage, eligibility, needs-review, duplicates-only, sort) actually filter; pagination works; CSV **and** XLSX import both run preview → commit |
| 10.5 | Lead detail | Tabs: overview / analysis / score / pipeline / outreach / suppression all render real data; evidence rules enforced on stage advance; simulate a call; share portfolio; suppress |
| 10.6 | Settings | Per-setting editors; save shows applied vs rejected; sensitive settings prompt for a password; **Reset to default** clears the override (audited) |
| 10.7 | System | Status, providers, background jobs, incidents, users (add/revoke sessions), change password |
| 10.8 | Any dynamic text containing `<script>` or `"` | Rendered **escaped** — never executed, never breaks the layout |
| 10.9 | Delete a sensitive setting via the API without re-auth | `401 reauth_required`; with re-auth it resets to default |

---

## Sign-off checklist

- [ ] `npm test` — 332/332 green
- [ ] `npm run typecheck` — clean
- [ ] `npm run doctor` — exit 0 (backups/integrations warnings are honest, not failures)
- [ ] Emergency STOP halts every channel and only the owner can resume (with re-auth)
- [ ] Restart pauses outreach; no auto-resume
- [ ] Daily call limit and budget caps are enforced server-side
- [ ] Simulation is the default; live requires owner action + configured providers
- [ ] Opt-outs / suppressions block all channels and survive a restore
- [ ] No secret, password hash, or CSRF secret appears in any response or log
- [ ] Backups are verified; a restore test passes; a corrupted backup fails loudly
