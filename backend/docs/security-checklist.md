# Security Checklist — UWS AI Sales Calling Agent

> Working security posture for the deployed instance. Each item names the
> mechanism and where to verify it. Items marked **[owner action]** cannot be
> satisfied by code alone and must be completed before live outreach.
>
> Cross-reference: `docs/architecture.md` §4 (safeguards) and §8 (security).

## 1. Authentication & sessions

| Control | Status | Where / how to verify |
|---|---|---|
| Passwords hashed with scrypt (memory-hard KDF), unique salt per user | ✅ | `src/core/password.ts`; `tests/unit/password.test.ts` |
| Opaque session tokens stored **hashed**, never in plaintext | ✅ | `src/domain/auth/*` |
| Session cookie is `HttpOnly` + `SameSite=Strict` (+`Secure` when base URL is https) | ✅ | `setSessionCookies`; API test asserts both flags |
| CSRF double-submit: mutating requests require `x-csrf-token` matching the readable `uws_csrf` cookie | ✅ | `requireCsrf`; API tests reject a missing/incorrect token with 403 |
| Login rate limiting (per account + per IP) returns 429 | ✅ | `loginLimiter`; API test trips it within 8 attempts |
| Generic login failure message (no account enumeration) | ✅ | API test asserts identical 401 for wrong-password and unknown-account |
| Sensitive actions require a **fresh re-authentication** (5-min grant) | ✅ | `requireReauth`: live-mode activation, resume after stop, sensitive settings changes/resets |
| Password change revokes all other sessions | ✅ | `changePassword`; integration test |
| Weak-password policy enforced on create/change | ✅ | password policy test |

## 2. Authorization (RBAC)

| Control | Status | Where / how to verify |
|---|---|---|
| Roles limited to `owner` and `staff`; least privilege | ✅ | `requireRole(...)` applied **per route**, never a blanket `router.use` on the shared `/api` mount |
| Owner-only: settings (read/write/reset), reports, backups + restore tests, user management, live-mode activation, resume after stop, conversion (won), portfolio verify/approve | ✅ | API tests assert 403 for staff on each surface |
| Staff may operate (import, pipeline, simulated outreach, notifications) but not change policy | ✅ | `tests/api/*` |
| Emergency **STOP** is available to staff (safe direction); only the owner may resume | ✅ | API test: staff stop = 200, staff resume = 403 |

## 3. Input validation & output encoding

| Control | Status | Where / how to verify |
|---|---|---|
| Every request body/query/param validated with zod before use | ✅ | route schemas in `src/http/routes/*` |
| All dynamic SPA content escaped (`esc()`) before entering HTML | ✅ | `src/web/lib.js`; no `innerHTML` with raw user data |
| SQL uses bound parameters throughout (no string-built queries) | ✅ | `db.prepare(...).run/all(...)` with `?` placeholders |
| Phone/website/email normalised and validated; malformed values rejected with a reason | ✅ | `tests/unit/normalize.test.ts`; repository tests |
| CSV import: header mapping, per-row validation, parse errors surfaced (no silent drops); RFC4180 parser is owned and tested | ✅ | `tests/unit/csv.test.ts`, import pipeline tests |
| Structured error responses; stack traces never sent to the client | ✅ | error middleware maps `AppError` → `{error:{code,message,details}}` |

## 4. Transport & browser hardening

| Control | Status | Where / how to verify |
|---|---|---|
| helmet security headers on every response | ✅ | `src/server/app.ts`; API test asserts headers present |
| Strict CSP: `script-src 'self'` (no inline scripts **and** no inline event handlers); `object-src 'none'`; `frame-ancestors 'none'`; `form-action 'self'`; `base-uri 'self'` | ✅ | `src/server/app.ts`; browser console shows no CSP violations |
| `X-Content-Type-Options`, referrer policy, frameguard, COOP/CORP same-origin | ✅ | helmet config |
| HTTPS: `upgrade-insecure-requests` enabled when the public base URL is https | ✅ | **[owner action]** terminate TLS in front of the app; set `PUBLIC_BASE_URL=https://…` |
| Unknown `/api/*` routes return JSON 404 (not the SPA) | ✅ | API test |

## 5. Secrets & logging

| Control | Status | Where / how to verify |
|---|---|---|
| Secrets supplied only via environment; never rendered to the client | ✅ | config layer; provider status shows only presence/absence, never values |
| Response-level + log-level redaction of phone/email/token-like values | ✅ | `src/core/logger.ts`; `tests/unit/logger.test.ts` |
| API responses never contain `password_hash`, `csrf_secret`, or the session secret | ✅ | API test greps raw bodies of `/api/system`, `/api/settings`, `/api/state`, `/api/auth/me`, `/api/auth/users` |
| Production requires an explicit `SESSION_SECRET` (≥ 32 chars); dev uses an ephemeral one with a warning | ✅ | config tests; `npm run doctor` warns |
| `npm run doctor` reports provider configuration **without** printing credential values | ✅ | doctor output |

## 6. Audit & accountability

| Control | Status | Where / how to verify |
|---|---|---|
| Append-only audit events for: login, settings changes/resets, budget/limit changes, portfolio approvals, live activation, emergency stop/resume, merges, stage conversions, suppressions | ✅ | `recordAudit` across services; tests assert specific actions |
| Audit trail is surfaced per lead and in reports | ✅ | lead detail includes recent audit rows |

## 7. Outreach safety (the core risk)

| Control | Status | Where / how to verify |
|---|---|---|
| Default mode is **simulation**; live is never auto-activated | ✅ | fresh DB seeds `mode=simulation`; live needs owner action + re-auth + configured provider |
| Single guard choke point evaluates **all** safeguards before any adapter call | ✅ | `domain/outreach/guard.ts`; guard-order tests |
| Guard order: emergency stop → pause → mode/provider → eligibility → daily volume → budget → calling window | ✅ | `tests/integration` guard tests |
| Every attempt (allowed **or** blocked) is ledgered with its exact reason — nothing silently dropped | ✅ | ledger tests; blocked = 200, allowed = 201 |
| Daily call limit (≤100) and budget cap enforced **server-side** with atomic counters | ✅ | hard ceilings in config; cap-enforcement tests |
| Restart/crash **pauses** outreach; manual owner resume only (with re-auth) | ✅ | `markApplicationStart`; API test |
| Emergency STOP halts every channel immediately, from every screen | ✅ | dashboard STOP; state tests |
| Opt-outs / suppressions override every other rule, on every channel | ✅ | eligibility tests; suppression dominates |
| Published contact info alone **never** establishes consent/eligibility | ✅ | eligibility tests |
| Simulated interactions are flagged and **never** count as customer contact evidence | ✅ | pipeline/simulation tests |
| Portfolio two-key rule: only `verified` **and** `is_approved` items are shareable; un-verifying revokes approval | ✅ | portfolio tests |
| Calling window is timezone-aware (Asia/Karachi) and enforced server-side | ✅ | schedule tests |
| Live WhatsApp outreach is **template-only** (no free-form blast) | ✅ | live-mode tests |

## 8. Provider integration security

| Control | Status | Where / how to verify |
|---|---|---|
| Webhook signatures verified (Meta `X-Hub-Signature-256`, Twilio signature) over the exact raw bytes; invalid signature = 401, payload untouched | ✅ | webhook + adapter tests |
| Webhook processing is idempotent on replay | ✅ | webhook tests |
| Inbound WhatsApp `STOP` suppresses **before** any other handling | ✅ | webhook test |
| TwiML answer URL serves the AI disclosure (duplex stream only when fully configured and attributable, else disclosure + hangup); **recording never enabled** | ✅ | webhook + duplex tests |
| Duplex stream URL access is a signed, expiring token bound to the CallSid; bad/missing token = 401, unknown call = 404, duplicate stream = 409, unconfigured bridge = 503 | ✅ | duplex unit + integration tests |
| Duplex call audio is transient memory only — never written to disk; no `<Record/>` is ever emitted | ✅ | duplex tests (recording flags asserted `0`) |
| The bridge never dials and never changes operating mode; it only serves calls already in the ledger | ✅ | duplex tests |
| Unconfigured webhooks 404 (an unconfigured instance advertises nothing) | ✅ | webhook test |
| SMTP: plaintext to non-loopback hosts refused (no credential-in-the-clear) | ✅ | SMTP adapter tests |
| Provider auth/token errors never leak the token | ✅ | adapter tests |
| SIP gateway control auth: timing-safe bearer comparison; wrong/missing token = 401, and verification is **inert unless `TELEPHONY_PROVIDER=cloudyvoice`** (a Twilio-mode instance accepts no gateway traffic) | ✅ | `adapters-cloudyvoice.test.ts` |
| SIP gateway events: HMAC-SHA256 over the **raw** body (`SIP_GATEWAY_EVENT_SECRET`, timing-safe, hex case-insensitive); tampered/re-serialised/unsigned = 401 with the payload never recorded; idempotent on replay | ✅ | `gateway.test.ts` (apply/replay/tamper/orphan) |
| Gateway media WebSocket: same 5 gates as Twilio (bridge enabled, speech+AI ports, signed expiring token, call in ledger, single stream → 401/404/409/503); unknown upgrade paths 404 via shared fallback | ✅ | `gateway.test.ts` upgrade gating |
| No carrier value in the backend (no SIP host/port/codec/CLI/credential in `backend/src`); gateway secrets appear only as env **names** in doctor/dashboard output, never values | ✅ | doctor gateway section prints names only; `deploy/sip/*.sample` hold placeholders |
| Gateway answer path serves disclosure + `hangup` for unattributable calls and **never** requests recording | ✅ | `gateway.test.ts` answer-route tests |

## 9. Data integrity & recovery

| Control | Status | Where / how to verify |
|---|---|---|
| Real relational DB with FKs, CHECK constraints, unique indexes; migrations are checksummed (drift detected) | ✅ | migrations tests |
| Backups are **verified** (integrity + FK + required tables + owner present + row-count manifest); a failed verification never counts | ✅ | backup tests |
| Backups optionally AES-256-GCM encrypted at rest (`UWSBK1`); wrong passphrase / bit-flip / truncation all fail loudly | ✅ | `tests/unit/backupcrypto.test.ts` |
| Periodic **restore tests** prove backups are restorable; corruption raises a critical notification | ✅ | restore-test tests |
| Restore re-applies opt-outs recorded **after** the snapshot (never resurrects a suppressed business) | ✅ | restore-helper tests |
| Retention pruning never deletes the newest backup | ✅ | retention test |
| Backup-failure alerting deduplicated (one per day) to avoid alert fatigue | ✅ | backup service |

## 10. Owner actions required before live outreach

These cannot be satisfied by code and are intentionally left to the owner:

- [ ] Terminate TLS in front of the app; set `PUBLIC_BASE_URL=https://…`
- [ ] Set a strong, persistent `SESSION_SECRET` (≥ 32 chars) in the environment
- [ ] Configure real provider credentials (telephony, WhatsApp, AI, STT, SMTP) and complete provider approvals (e.g. Meta template approval)
- [ ] Enable backups: `BACKUP_ENABLED=true` and set `BACKUP_PASSPHRASE`
- [ ] Review and set the operating safeguards: calling window, daily call limit, daily budget, eligible channels, retry/follow-up policy
- [ ] Review the AI conversation policy and the portfolio items (verify + approve) before any are shared
- [ ] Confirm the consent capture and opt-out handling match the jurisdictions UWS operates in
- [ ] Restrict filesystem access to the database and backup directories to the service account
