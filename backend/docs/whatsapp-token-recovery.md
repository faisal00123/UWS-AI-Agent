# WhatsApp Access Token Recovery Checklist (owner-run)

**Purpose:** restore a working `WHATSAPP_ACCESS_TOKEN` after Meta rejects the
current one (HTTP 401, Graph `error 190`, `subcode 463` = expired/invalid).
The token is a secret: it is pasted only into `backend/.env` and never shared
in chat, logs, screenshots or commits.

## Why tokens expire

| Token type | Typical lifetime | Where it comes from |
|---|---|---|
| Temporary / system-user "temporary" token | **24 hours** (sometimes minutes) | Developers → Your App → WhatsApp → API Setup → *Temporary access token* |
| Long-lived user token | **≈ 60 days** | Exchanged via Graph API Explorer / business login |
| **System-user token (recommended)** | **60 days or never** (owner chooses) | Business Settings → System Users → *Generate new token* |

A token that worked yesterday and returns `190/463` today has simply expired
(or been regenerated elsewhere). Nothing in this repository caused it.

## Recovery steps (owner, ~5 minutes)

1. Open **business.facebook.com/settings** → select the correct Business
   Portfolio → **Users → System users** → open/create the system user with
   **Admin** role → **Generate new token**.
2. Select the app (the one whose WABA is `403489139520599`).
3. Grant exactly these assets/permissions (both were verified granted on the
   previous token):
   - `whatsapp_business_messaging` (send)
   - `whatsapp_business_management` (manage templates/numbers)
   - plus `public_profile` if offered
4. Set expiry to **60 days** (or *Never*, if Meta offers it for your account).
5. Copy the token (Meta shows it once) and paste it into `backend/.env`:
   ```
   WHATSAPP_ACCESS_TOKEN=<paste here — never commit, never chat>
   ```
   Keep the line length plausible (300+ characters); do not add quotes or spaces.
6. Save the file. No restart is required for verification probes; restart the
   server (`npm start`) when you want the running app to pick it up.

## Verification (run by the assistant, on request — safe, read-only)

After the owner confirms the paste, the assistant runs **only** these GETs and
reports HTTP status + non-secret fields (no token, no message sends):

1. `GET /v20.0/me/permissions` → expect `whatsapp_business_messaging:granted`,
   `whatsapp_business_management:granted`
2. `GET /v20.0/474426162412836?fields=id,display_phone_number,verified_name,status`
   → expect HTTP 200, `+92 305 2610989`, `CONNECTED`
3. `GET /v20.0/403489139520599` → expect HTTP 200, name `Universal Web Solutions`

**Nothing else is executed:** no messages, no template changes, no
registration, no webhook changes, no `.env` edits by the assistant.

## Status tracking

- [x] Token in `backend/.env` is **valid** — verified 2026-11-04 with all three
      safe GETs (permissions 200 with both grants, phone `CONNECTED`, WABA 200).
- [x] Read-only verification requested → all three GETs returned expected results.
- [ ] Server restarted so the running app uses the current token (when live).
- [ ] **Template `portfolio_intro` is NOT listed on this WABA**
      (`GET /403489139520599/message_templates` → `data: []`): confirm the
      template was submitted against WABA `403489139520599` / the app that owns
      it, and re-submit there if not. Re-verification after that: the same GET
      should show the template with a `PENDING`/`APPROVED` status.

## Related

- Template `portfolio_intro` (Marketing, `en_US`) is **IN REVIEW** — sending
  stays disabled (simulation + paused outreach) regardless of token state.
- Template audit procedure: `backend/docs/external-dependencies.md`.
