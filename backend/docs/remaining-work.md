# Remaining-work checklist (honest status)

Compiled 2026-11-04 from verified checks in this repository. Anything marked
✅ was actually verified here; anything ❌ is genuinely not done. No item is
claimed complete without evidence.

## 1. Software (this repository)

- [x] `npm run seed:demo` implemented and verified (idempotent, temp-DB tested,
      no outreach) — README documents safe usage.
- [x] `.env.example` restored as a clean comment-free `KEY=VALUE` schema
      (64 keys, zero secrets).
- [x] `NOTIFY_OWNER_EMAIL` wired as the email-destination fallback
      (dashboard setting wins; env var used when the setting is empty) —
      targeted tests green.
- [x] Full baseline green before this session's changes: 573 tests / 87
      suites / 0 fail, typecheck 0.
- [x] Re-run **2026-11-06 after the speech-provider work: 595 tests / 91
      suites / 0 fail / 0 skipped, typecheck 0** (the +22 are the new
      ElevenLabs/Deepgram/dispatch tests).
- [ ] **Push `aefe9a7` to GitHub** — blocked by credential 403; exact steps in
      `github-push-recovery.md` (no local commit may be deleted).
- [ ] Audit-verified defects from the discovery/CRM/CSV/duplicate/follow-up and
      dashboard/reports/auth/STOP ALL reviews — see the session report for the
      fixed/pending split.
- [x] Optional: ElevenLabs / Deepgram speech adapters — **implemented
      2026-11-06**: per-capability dispatch (`STT_PROVIDER`/`TTS_PROVIDER`
      may differ, composed into one port), `adapters/speech/elevenlabs.ts`
      (TTS), `adapters/speech/deepgram.ts` (STT), honest `unconfigured`
      rejection for the direction a provider does not offer, free `ping()`
      probes, 89/89 targeted tests green + typecheck 0. **Live verification
      blocked: no `ELEVENLABS_API_KEY`/`DEEPGRAM_API_KEY` anywhere** — the
      moment either key lands in `.env` the "Test connection" button validates
      it for free.
- [ ] Optional: outbound **lead-facing** email channel — does not exist by
      design (email is internal-only: owner notifications + daily report), and
      adding it would require unsubscribe/compliance work first.

## 2. Integrations (verified states)

| Integration | Status | Evidence / next step |
|---|---|---|
| OpenAI (STT/TTS/LLM) | ✅ **working** | `GET /v1/models` 200 on the key (2026-11-06: 96 models); ping reports honest failover to `AI_API_KEY` after the dedicated key's rejection |
| ElevenLabs (TTS) | ⚠️ **code complete, no key** | Adapter + dispatch + 20+ unit tests green; `ELEVENLABS_API_KEY` absent from `.env` → live check impossible until the owner adds a key |
| Deepgram (STT) | ⚠️ **code complete, no key** | Adapter + dispatch + unit tests green; `DEEPGRAM_API_KEY` absent from `.env` → live check impossible until the owner adds a key |
| WhatsApp Cloud API — **token** | ✅ token valid | 2026-11-06: `/me` 200 (`122099788185539620` "Employee"), `debug_token` valid SYSTEM_USER, app `1811369586640393`, issued `2026-11-05T20:49:20Z`, 3 permissions granted, phone-number GET 200 (ping) |
| WhatsApp Cloud API — **WABA asset** | ❌ **blocked (400/100/33)** | WABA details / `phone_numbers` / `message_templates` all return HTTP 400 `GraphMethodException` code=100 subcode=33 (fbtrace 2026-11-06: `AmQa8bTrYoMrVv-YZyrE29W`, `AA4AedWzRbKfgaBo2E8L-eX`, `ArkTjjZD1COHwmbQE8oYxjY`). Root cause proven: the token's actor (`122099788185539620`) is a **different system-user object** than the one the WABA was assigned to (`61596188609681`, both display as "Employee"), and `granular_scopes` contains **no asset IDs**. Fix: regenerate from the asset-owning row with WABA `403489139520599` ticked — §3 |
| WhatsApp template `portfolio_intro` | ❌ **status unverifiable** | `GET /403489139520599/message_templates` → 400/100/33 (blocked by the asset issue above). Config side correct (`portfolio_intro`/`en_US`). Never assume approved — status is re-checked the moment the WABA GET returns 200 |
| WhatsApp webhook subscription | ❌ **none exists** | 2026-11-06: `GET /{app-id}/subscriptions` with the app access token → **200 `{"data":[]}`** — no callback URL, verify token or fields configured. Requires a **public HTTPS callback URL** (deployment first), then the Meta dashboard. Backend legs already verified locally: correct token → 200 challenge echo, wrong token/mode → 403, unsigned/bad-signature POST → 401 |
| WhatsApp phone/WABA | ✅ phone verified | `474426162412836` GET 200 `+92 305 2610989` CONNECTED/GREEN (app-level access works; the phone→WABA edge stays unverifiable until the WABA GET returns 200) |
| Twilio / CloudyVoice telephony | ❌ **not configured** | `TELEPHONY_PROVIDER` empty in `.env`. CloudyVoice researched 2026-11-06: prepaid A–Z SIP termination, **Pakistan mobile from $0.026/min** (Mobilink/Ufone/Warid/Zong, 1/1 increment), fixed $0.029/min, $10 minimum crypto top-up, KYC + traffic review before routes enable; works with the repo's SIP gateway contract (Asterisk/FreeSWITCH/VOS3000). Blocked on owner signup + credentials + approval for a test call |
| Email (SMTP) | ⚠️ **code complete, unconfigured** | Adapter + dispatch + `ping()` verified; `SMTP_*`/`MAIL_FROM` empty in `.env` — fills in when owner has SMTP credentials |
| Discovery (Overpass) | ✅ configured | keyless free vendor (`DISCOVERY_PROVIDER=overpass`) |
| Backups | ✅ enabled | `BACKUP_ENABLED=true` in `.env`; encrypted snapshots + restore-test flow exist and are tested |

## 3. Manual configuration (owner actions)

- [ ] **WhatsApp WABA asset (the current blocker)** — regenerate the system
      user token from the **asset-owning** row: Business Settings → Users →
      System Users → open the *Employee* row whose **Assets** list contains
      *WhatsApp business account → 403489139520599 / +92 305 2610989*
      (confirm ticked with Full control; dashboard ID `61596188609681` is the
      candidate) → **Generate new token** → app *UWS AI Sales Calling Agent*
      → tick **403489139520599** under WhatsApp business accounts →
      permissions `whatsapp_business_messaging` + `whatsapp_business_management`
      → copy once, paste straight into `backend/.env` (never chat/commit) →
      tell the engineer "saved". The old token is NOT revoked; it is only
      replaced in `.env`. Success = WABA details + `phone_numbers` +
      `message_templates` all HTTP 200, then `portfolio_intro`'s real status
      is read off the list.
- [ ] **GitHub access**: fix the stored credential (currently
      `keertikumari39-tech`, no write access) or add it as a collaborator —
      then push `aefe9a7` (`github-push-recovery.md`).
- [ ] **WhatsApp webhook subscription** (after the backend has a public HTTPS
      URL): Meta App Dashboard → Webhooks → WhatsApp → callback URL
      `https://<domain>/api/webhooks/whatsapp`, verify token = the
      `WHATSAPP_WEBHOOK_VERIFY_TOKEN` value already in `.env`, subscribe
      `messages` + `message_template_status_update`. Backend side is verified
      locally; the app currently reports **zero subscriptions**
      (`GET /{app-id}/subscriptions` → `{"data":[]}`).
- [ ] **Speech keys (optional)**: add `ELEVENLABS_API_KEY` and/or
      `DEEPGRAM_API_KEY` to `.env` to activate the already-implemented
      adapters, then hit *Test connection* (free ping) to verify. Without
      them the speech layer honestly runs on OpenAI only.
- [ ] **CloudyVoice signup (telephony)**: create the account
      (cloudyvoice.com/signup), pass traffic review, top up from $10
      (crypto), obtain the SIP endpoint credentials → fill
      `TELEPHONY_PROVIDER=cloudyvoice` + `SIP_GATEWAY_BASE_URL` /
      `SIP_GATEWAY_API_TOKEN` / `SIP_GATEWAY_EVENT_SECRET` and stand up the
      SIP gateway per `backend/deploy/sip/README.md`. **No purchase or paid
      test call without explicit owner approval.**
- [ ] **Notification email**: set `NOTIFY_OWNER_EMAIL` in `.env` (or the
      dashboard *Notification destinations* setting — the setting wins).
- [ ] **SMTP credentials** (`SMTP_HOST/SMTP_PORT/SMTP_USER/SMTP_PASS/MAIL_FROM`)
      if email delivery is wanted; verify with the free `ping()` first.
- [ ] **One identity, one writer**: stop editing `.env.example` on
      github.com web (second git identity `FAISAL FAYYAZ
      <faisalfayyaz500@gmail.com>` gutted it twice) and move the repo out of
      `OneDrive\Desktop` — OneDrive sync was reverting `.env` between machines.
- [ ] Owner account: `npm run setup` if not yet created on the target machine.

## 4. Hosting

- [ ] **Pick a host** — recommendation recorded in
      `backend/docs/deployment.md` → *Hosting options compared*:
      **Railway first** (~$5–15/mo, `/app/data` volume for SQLite, WS works,
      `railway.json` already prepared), **small VPS** (Hetzner/DigitalOcean
      ~$6/mo) as the long-term home that can also co-host the CloudyVoice SIP
      gateway. Serverless/Vercel backend rejected (ephemeral disk, no
      always-on scheduler, no WS).
- [ ] **Deploy** — blocked: no `vercel`/`railway`/`docker` CLI, no
      `VERCEL_TOKEN`/`RAILWAY_TOKEN`, no production domain in this
      environment, and no owner approval. **Nothing was deployed.**
- [ ] PostgreSQL: **not supported today** (SQLite-only by explicit
      architecture decision) — an owner-level port project, not a hosting
      checkbox; no hosting choice above blocks it.

## 5. Live-launch safety (gate before any real outreach)

Current enforced state: **`OPERATING_MODE=simulation`, outreach paused**, no
provider credentials that could send anything. Keep it until **all** of:

- [x] WhatsApp token identity/validity verified (2026-11-06: `/me` 200,
      `debug_token` valid SYSTEM_USER, permissions granted, phone GET 200).
- [ ] WhatsApp **WABA asset access** verified (details + `phone_numbers` +
      `message_templates` all HTTP 200) — currently 400/100/33, fix in §3.
- [ ] Template `portfolio_intro` **exists on WABA `403489139520599` and is
      APPROVED** by Meta — status is unverifiable while the WABA GET is
      blocked; never assume approved.
- [ ] Webhook subscription configured on the Meta app (currently
      `{"data":[]}`) and a challenge round-trip verified against the
      deployed HTTPS URL.
- [ ] Telephony configured (`TELEPHONY_PROVIDER` + gateway or Twilio) and the
      owner-approved **test call** succeeds (`npm run doctor` gateway block
      clean).
- [ ] `npm run doctor` clean on the deployment host; backup verified
      (`npm run backup` + a restore test).
- [ ] STOP ALL / emergency-stop exercised once in simulation and confirmed to
      block both calls and messages.
- [ ] Explicit owner sign-off to flip `OPERATING_MODE=live` and un-pause
      outreach — one deliberate action, never implied.
