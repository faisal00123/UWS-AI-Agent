-- 010_phase11b.sql
-- Phase 11B: provider onboarding, opt-in unsuppression review, live activation.
--
-- provider_onboardings  - per-integration verification state. Credentials are
--                          NEVER stored here (env-only); this table records
--                          only the outcome of a free connection probe and
--                          who performed it.
-- suppression_list      - gains nullable lifted_at/lifted_by/lifted_reason.
--                          Append-only: a lifted row is never deleted, its
--                          evidence stays; the eligibility check simply
--                          ignores rows where lifted_at is set. Lifting is an
--                          explicit owner action (never automatic).
-- suppression_reviews   - the owner's review decision for a lift request,
--                          linked to the suppression row (audit trail).
-- live_activations      - one row per explicit switch to live mode, storing
--                          the guardrail checks that passed. Live mode
--                          cannot be entered without an activation record.

-- ---------------------------------------------------- provider_onboardings --
CREATE TABLE provider_onboardings (
  integration   TEXT PRIMARY KEY,            -- telephony|whatsapp|ai|speech|email|discovery
  provider      TEXT,                        -- vendor key chosen in env (never credentials)
  state         TEXT NOT NULL DEFAULT 'pending'
                  CHECK (state IN ('pending','verified','failed','disabled')),
  verified_at   TEXT,
  verified_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  detail        TEXT,                        -- redacted human summary (no secrets)
  updated_at    TEXT NOT NULL
);

-- --------------------------------------------------- suppression lifting ---
ALTER TABLE suppression_list ADD COLUMN lifted_at TEXT;
ALTER TABLE suppression_list ADD COLUMN lifted_by TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE suppression_list ADD COLUMN lifted_reason TEXT;

-- Eligibility must ignore lifted rows.
CREATE INDEX idx_suppression_active
  ON suppression_list(business_id) WHERE lifted_at IS NULL;

-- The dedupe/unique rule must only cover ACTIVE rows: once an owner lifts a
-- suppression, a genuine later opt-out must be able to create a NEW row
-- (append-only — the lifted row and its evidence are never reused or removed).
DROP INDEX ux_suppression_business_reason;
CREATE UNIQUE INDEX ux_suppression_business_reason
  ON suppression_list(business_id, reason) WHERE business_id IS NOT NULL AND lifted_at IS NULL;

CREATE TABLE suppression_reviews (
  id             TEXT PRIMARY KEY,
  suppression_id TEXT NOT NULL REFERENCES suppression_list(id) ON DELETE CASCADE,
  business_id    TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  decision       TEXT NOT NULL CHECK (decision IN ('lifted','kept')),
  reason         TEXT NOT NULL,
  reviewed_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at    TEXT NOT NULL
);
CREATE INDEX idx_suppression_reviews_business ON suppression_reviews(business_id, reviewed_at DESC);

-- ------------------------------------------------------ live_activations ---
CREATE TABLE live_activations (
  id             TEXT PRIMARY KEY,
  activated_at   TEXT NOT NULL,
  activated_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  checks_json    TEXT NOT NULL,               -- the guardrail checks that passed
  detail         TEXT,
  reverted_at    TEXT,                        -- set when the owner returns to simulation
  reverted_by    TEXT REFERENCES users(id) ON DELETE SET NULL
);
