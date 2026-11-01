-- 002_leads.sql
-- Leads, provenance, verification, website analysis, scoring, eligibility,
-- suppression (opt-outs) and duplicate management.

-- ------------------------------------------------------- businesses --------
CREATE TABLE businesses (
  id                   TEXT PRIMARY KEY,
  display_name         TEXT NOT NULL,
  normalized_name      TEXT NOT NULL,          -- lowercase, punctuation stripped
  category             TEXT,
  city                 TEXT,
  region               TEXT,
  country              TEXT NOT NULL DEFAULT 'PK' CHECK (country IN ('PK')),
  website_url          TEXT,
  website_host         TEXT,                   -- lowercase host, no scheme/www (dedupe key)
  phone_e164           TEXT,                   -- normalised e.g. +923001234567
  phone_raw            TEXT,
  email                TEXT COLLATE NOCASE,
  whatsapp_e164        TEXT,
  contact_person_name  TEXT,
  contact_person_role  TEXT,

  source_type          TEXT NOT NULL CHECK (source_type IN
                        ('web_search','directory','social','csv_import','excel_import','manual','api','other')),
  source_url           TEXT,
  source_ref           TEXT,

  discovered_at        TEXT NOT NULL,
  last_checked_at      TEXT,

  -- Pipeline (default UWS pipeline, Section 1.9)
  stage                TEXT NOT NULL DEFAULT 'new_lead' CHECK (stage IN (
                         'new_lead','website_analyzed','eligible_to_contact',
                         'call_attempted','contacted','interested','qualified',
                         'meeting_callback','proposal_sent','negotiation','won','lost')),
  stage_changed_at     TEXT,
  stage_change_reason  TEXT,

  -- Cached projection of lead_scores (authoritative rows live in lead_scores)
  score                INTEGER CHECK (score IS NULL OR (score >= 0 AND score <= 100)),
  score_band           TEXT CHECK (score_band IS NULL OR score_band IN ('low','medium','high','very_high')),
  score_updated_at     TEXT,

  -- Cached projection of the latest eligibility check
  eligibility_state    TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (eligibility_state IN ('unknown','eligible','ineligible','needs_review')),
  eligibility_checked_at TEXT,

  interest_level       TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (interest_level IN ('unknown','not_interested','neutral','interested','opted_out')),
  qualification_status TEXT NOT NULL DEFAULT 'unqualified'
                         CHECK (qualification_status IN ('unqualified','needs_review','qualified','disqualified')),
  preferred_language   TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (preferred_language IN ('ur','roman_ur','en','mixed','unknown')),

  -- Budget / timeline (never guessed: state says where the number came from)
  budget_minor         INTEGER,
  budget_currency      TEXT NOT NULL DEFAULT 'PKR',
  budget_state         TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (budget_state IN ('unknown','estimated','stated','verified')),
  timeline             TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (timeline IN ('unknown','immediate','within_1_month','within_3_months','within_6_months','later')),
  requirements         TEXT,
  service_interest     TEXT,                   -- services.key when known

  -- Duplicate handling
  merged_into_id       TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  duplicate_of_id      TEXT REFERENCES businesses(id) ON DELETE SET NULL,
  duplicate_status     TEXT NOT NULL DEFAULT 'unique'
                         CHECK (duplicate_status IN ('unique','pending_review','duplicate','survivor')),

  created_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL,

  CONSTRAINT chk_merge_direction CHECK (merged_into_id IS NULL OR merged_into_id <> id),
  CONSTRAINT chk_dup_direction    CHECK (duplicate_of_id IS NULL OR duplicate_of_id <> id),
  -- High-confidence merge sets the stage-history reason instead of silent overwrite.
  CONSTRAINT chk_merged_has_stage_reason CHECK (merged_into_id IS NULL OR stage_change_reason IS NOT NULL)
);
CREATE INDEX idx_businesses_stage ON businesses(stage, score DESC, discovered_at);
CREATE INDEX idx_businesses_city ON businesses(city);
CREATE INDEX idx_businesses_category ON businesses(category);
CREATE INDEX idx_businesses_elig ON businesses(eligibility_state, score DESC);
-- Exact phone / website matches are high-confidence duplicates: the importer
-- merges them instead of inserting a second row, and merged rows keep their
-- original values for audit - so uniqueness only applies to live rows.
CREATE UNIQUE INDEX ux_businesses_phone
  ON businesses(phone_e164) WHERE phone_e164 IS NOT NULL AND merged_into_id IS NULL;
CREATE UNIQUE INDEX ux_businesses_website
  ON businesses(website_host) WHERE website_host IS NOT NULL AND merged_into_id IS NULL;
CREATE UNIQUE INDEX ux_businesses_name_city ON businesses(normalized_name, city) WHERE merged_into_id IS NULL;
CREATE INDEX idx_businesses_merged ON businesses(merged_into_id);

-- --------------------------------------------------------- lead_sources ----
CREATE TABLE lead_sources (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  source_type     TEXT NOT NULL,
  source_url      TEXT,
  source_ref      TEXT,
  raw_payload_json TEXT,
  imported_by     TEXT REFERENCES users(id) ON DELETE SET NULL,
  imported_at     TEXT NOT NULL
);
CREATE INDEX idx_lead_sources_business ON lead_sources(business_id);

-- ------------------------------------------------------ contact_points -----
CREATE TABLE contact_points (
  id               TEXT PRIMARY KEY,
  business_id      TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL CHECK (kind IN ('phone','whatsapp','email','website','social')),
  value            TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  is_primary       INTEGER NOT NULL DEFAULT 0 CHECK (is_primary IN (0,1)),
  verified_state   TEXT NOT NULL DEFAULT 'unverified'
                     CHECK (verified_state IN ('unverified','verified','failed','invalid','conflicting')),
  verification_note TEXT,
  source           TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_contact_points_business ON contact_points(business_id, kind);
CREATE UNIQUE INDEX ux_contact_points ON contact_points(business_id, kind, normalized_value);

-- ---------------------------------------------- field_verifications --------
-- Per-field verification state so "verified" claims are traceable.
CREATE TABLE field_verifications (
  id          TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  field       TEXT NOT NULL,
  value       TEXT NOT NULL,
  state       TEXT NOT NULL CHECK (state IN ('unverified','verified','failed','conflicting','superseded')),
  method      TEXT NOT NULL,        -- 'format_check','dns_check','http_fetch','provider_check','owner_confirmed','prospect_confirmed'
  evidence    TEXT,
  checked_at  TEXT NOT NULL
);
CREATE INDEX idx_field_verifications_business ON field_verifications(business_id, field);
CREATE UNIQUE INDEX ux_field_verifications ON field_verifications(business_id, field, value, state);

-- ---------------------------------------------------- website_analyses -----
-- Measured columns hold OBSERVED facts only. Heuristic/derived values live in
-- estimates_json and are flagged `is_estimate = 1`.
CREATE TABLE website_analyses (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  target_url         TEXT NOT NULL,
  status             TEXT NOT NULL CHECK (status IN
                       ('pending','running','reachable','unreachable','blocked','no_website','error')),
  http_status        INTEGER,
  final_url          TEXT,
  redirect_count     INTEGER,
  fetched_at         TEXT,
  duration_ms        INTEGER,
  bytes              INTEGER,
  title              TEXT,
  meta_description   TEXT,
  has_https          INTEGER CHECK (has_https IS NULL OR has_https IN (0,1)),
  has_viewport_meta  INTEGER CHECK (has_viewport_meta IS NULL OR has_viewport_meta IN (0,1)),
  h1_count           INTEGER,
  img_count          INTEGER,
  imgs_missing_alt   INTEGER,
  internal_links     INTEGER,
  forms              INTEGER,
  tel_links          INTEGER,
  mailto_links       INTEGER,
  whatsapp_links     INTEGER,
  has_contact_page   INTEGER CHECK (has_contact_page IS NULL OR has_contact_page IN (0,1)),
  has_about_page     INTEGER CHECK (has_about_page IS NULL OR has_about_page IN (0,1)),
  has_privacy_page   INTEGER CHECK (has_privacy_page IS NULL OR has_privacy_page IN (0,1)),
  has_portfolio_page INTEGER CHECK (has_portfolio_page IS NULL OR has_portfolio_page IN (0,1)),
  nav_texts_json     TEXT,
  opportunities_json TEXT NOT NULL DEFAULT '[]',
  estimates_json     TEXT NOT NULL DEFAULT '{}',
  not_measured_json  TEXT NOT NULL DEFAULT '[]',   -- explicit list of what we did NOT test
  error_message      TEXT,
  engine_version     TEXT NOT NULL,
  is_estimate        INTEGER NOT NULL DEFAULT 0 CHECK (is_estimate IN (0,1)),
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_analyses_business ON website_analyses(business_id, created_at DESC);
CREATE UNIQUE INDEX ux_analyses_target ON website_analyses(business_id, target_url, fetched_at);

-- --------------------------------------------------------- lead_scores -----
CREATE TABLE lead_scores (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  score         INTEGER NOT NULL CHECK (score >= 0 AND score <= 100),
  band          TEXT NOT NULL CHECK (band IN ('low','medium','high','very_high')),
  model_version TEXT NOT NULL,
  inputs_json   TEXT NOT NULL,        -- evidence snapshot used for the computation
  summary       TEXT NOT NULL,
  computed_at   TEXT NOT NULL
);
CREATE INDEX idx_scores_business ON lead_scores(business_id, computed_at DESC);
CREATE INDEX idx_scores_current ON lead_scores(score DESC, computed_at DESC);

CREATE TABLE score_factors (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  score_id  TEXT NOT NULL REFERENCES lead_scores(id) ON DELETE CASCADE,
  code      TEXT NOT NULL,
  label     TEXT NOT NULL,
  weight    REAL NOT NULL,
  points    REAL NOT NULL,
  raw_value TEXT NOT NULL,            -- 'unknown' or the observed value
  state     TEXT NOT NULL CHECK (state IN ('measured','stated','estimated','unknown')),
  evidence  TEXT,
  UNIQUE (score_id, code)
);
CREATE INDEX idx_score_factors_score ON score_factors(score_id);

-- ----------------------------------------------------- eligibility_checks --
CREATE TABLE eligibility_checks (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel        TEXT NOT NULL CHECK (channel IN ('call','whatsapp_message','whatsapp_call','email')),
  decision       TEXT NOT NULL CHECK (decision IN ('eligible','ineligible','needs_review')),
  policy_version TEXT NOT NULL,
  checks_json    TEXT NOT NULL,        -- every sub-check with pass/fail/unknown
  reasons_json   TEXT NOT NULL,
  checked_at     TEXT NOT NULL
);
CREATE INDEX idx_eligibility_business ON eligibility_checks(business_id, checked_at DESC);

-- ------------------------------------------------------ suppression_list ---
-- Opt-outs / do-not-contact. This table is authoritative and MUST survive
-- restores, merges and retention clean-up.
CREATE TABLE suppression_list (
  id            TEXT PRIMARY KEY,
  business_id   TEXT REFERENCES businesses(id) ON DELETE CASCADE,
  scope         TEXT NOT NULL CHECK (scope IN ('business','phone','whatsapp','email')),
  phone_e164    TEXT,
  whatsapp_e164 TEXT,
  email         TEXT COLLATE NOCASE,
  reason        TEXT NOT NULL CHECK (reason IN
                  ('opt_out','do_not_contact','refused','invalid_number','legal','customer_request','owner_manual','unreachable_permanent')),
  source        TEXT NOT NULL CHECK (source IN ('call','message','import','manual','owner','system')),
  evidence      TEXT,
  permanent     INTEGER NOT NULL DEFAULT 1 CHECK (permanent IN (0,1)),
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_suppression_business ON suppression_list(business_id);
CREATE INDEX idx_suppression_phone ON suppression_list(phone_e164);
CREATE INDEX idx_suppression_whatsapp ON suppression_list(whatsapp_e164);
CREATE UNIQUE INDEX ux_suppression_business_reason
  ON suppression_list(business_id, reason) WHERE business_id IS NOT NULL;

-- -------------------------------------------------- duplicate management ---
CREATE TABLE duplicate_candidates (
  id            TEXT PRIMARY KEY,
  business_id_a TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  business_id_b TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  match_score   REAL NOT NULL CHECK (match_score >= 0 AND match_score <= 1),
  match_fields  TEXT NOT NULL,        -- JSON: which fields matched and how
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','merged','rejected','reviewed_not_duplicate')),
  auto_merged   INTEGER NOT NULL DEFAULT 0 CHECK (auto_merged IN (0,1)),
  decided_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at    TEXT,
  decision_note TEXT,
  created_at    TEXT NOT NULL,
  -- canonical ordering so (a,b) and (b,a) cannot both exist
  CONSTRAINT chk_dup_order CHECK (business_id_a < business_id_b),
  UNIQUE (business_id_a, business_id_b)
);
CREATE INDEX idx_dup_status ON duplicate_candidates(status, match_score DESC);

CREATE TABLE merge_history (
  id                   TEXT PRIMARY KEY,
  survivor_id          TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  merged_id            TEXT NOT NULL,          -- id may later be re-keyed; keep literal value
  match_score          REAL NOT NULL,
  strategy             TEXT NOT NULL,          -- 'exact_phone'|'exact_website'|'name_city'|'manual'
  kept_values_json     TEXT NOT NULL,
  overridden_values_json TEXT NOT NULL,        -- conflicting values are PRESERVED here, never dropped
  sources_merged       INTEGER NOT NULL DEFAULT 1,
  performed_by         TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = automatic
  performed_at         TEXT NOT NULL,
  reverted_at          TEXT,
  revert_note          TEXT
);
CREATE INDEX idx_merge_survivor ON merge_history(survivor_id, performed_at DESC);
