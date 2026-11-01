-- 005_finance_reporting.sql
-- Budgets/usage, cost records, daily reports, portfolio & templates,
-- company services, backups/restore tests and data-subject requests.

-- ---------------------------------------------------------- budget_usage ---
-- One row per (business-day, metric). Outbound counters are incremented with
--   UPDATE ... SET used_value = used_value + ? WHERE used_value + ? <= limit_value
-- so the hard caps (100 calls/day, budget cap) are enforced atomically by the
-- database itself, not by read-then-write application code.
CREATE TABLE budget_usage (
  usage_date   TEXT NOT NULL,             -- business-timezone YYYY-MM-DD
  metric       TEXT NOT NULL CHECK (metric IN
                 ('calls','whatsapp_messages','whatsapp_calls','cost_minor')),
  used_value   INTEGER NOT NULL DEFAULT 0 CHECK (used_value >= 0),
  limit_value  INTEGER NOT NULL CHECK (limit_value >= 0),
  state        TEXT NOT NULL DEFAULT 'ok' CHECK (state IN ('ok','warning','exhausted')),
  pause_reason TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (usage_date, metric)
);

-- ----------------------------------------------------------- cost_records ---
CREATE TABLE cost_records (
  id            TEXT PRIMARY KEY,
  usage_date    TEXT NOT NULL,
  occurred_at   TEXT NOT NULL,
  channel       TEXT NOT NULL CHECK (channel IN ('call','whatsapp_message','whatsapp_call','other')),
  resource_type TEXT NOT NULL CHECK (resource_type IN ('call','message','credit','subscription')),
  resource_id   TEXT,
  provider      TEXT NOT NULL,
  amount_minor  INTEGER NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'USD',
  state         TEXT NOT NULL CHECK (state IN ('actual','estimated','unavailable')),
  source        TEXT NOT NULL CHECK (source IN ('provider_report','manual','rate_card_estimate')),
  note          TEXT,
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_cost_date ON cost_records(usage_date, channel);
-- A provider billable resource is recorded at most once (no double counting).
CREATE UNIQUE INDEX ux_cost_resource ON cost_records(provider, resource_type, resource_id)
  WHERE resource_id IS NOT NULL;

-- ---------------------------------------------------------- daily_reports ---
CREATE TABLE daily_reports (
  id                 TEXT PRIMARY KEY,
  report_date        TEXT NOT NULL UNIQUE,
  generated_at       TEXT NOT NULL,
  generated_by       TEXT REFERENCES users(id) ON DELETE SET NULL,   -- NULL = scheduler
  status             TEXT NOT NULL DEFAULT 'final' CHECK (status IN ('draft','final')),
  totals_json        TEXT NOT NULL,
  reconciliation_json TEXT NOT NULL,
  discrepancies_count INTEGER NOT NULL DEFAULT 0,
  missing_data_json  TEXT NOT NULL DEFAULT '[]',
  payload_json       TEXT NOT NULL
);
CREATE INDEX idx_reports_date ON daily_reports(report_date DESC);

-- ------------------------------------------------------ company services ----
CREATE TABLE services (
  key              TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  description      TEXT NOT NULL DEFAULT '',
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  owner_approved   INTEGER NOT NULL DEFAULT 0 CHECK (owner_approved IN (0,1)),
  approval_note    TEXT,
  updated_by       TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at       TEXT NOT NULL
);

-- -------------------------------------------------------- portfolio_items ---
CREATE TABLE portfolio_items (
  id                TEXT PRIMARY KEY,
  title             TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  service_key       TEXT REFERENCES services(key) ON DELETE SET NULL,
  url               TEXT,
  image_url         TEXT,
  -- Only owner-verified items may ever be quoted to a prospect.
  verified          INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
  verification_note TEXT,
  is_approved       INTEGER NOT NULL DEFAULT 0 CHECK (is_approved IN (0,1)),
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE INDEX idx_portfolio_approved ON portfolio_items(is_approved, verified, sort_order);

-- ------------------------------------------------------- message_templates --
CREATE TABLE message_templates (
  id          TEXT PRIMARY KEY,
  key         TEXT NOT NULL,
  channel     TEXT NOT NULL CHECK (channel IN ('whatsapp_message','email','call_script')),
  language    TEXT NOT NULL CHECK (language IN ('ur','roman_ur','en','mixed')),
  title       TEXT NOT NULL,
  body        TEXT NOT NULL,
  version     INTEGER NOT NULL DEFAULT 1,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  approved_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (key, channel, language, version)
);

-- ---------------------------------------------------- backups/restore ------
CREATE TABLE backups (
  id             TEXT PRIMARY KEY,
  path           TEXT NOT NULL,
  size_bytes     INTEGER,
  sha256         TEXT,
  encrypted      INTEGER NOT NULL DEFAULT 0 CHECK (encrypted IN (0,1)),
  status         TEXT NOT NULL DEFAULT 'running'
                   CHECK (status IN ('running','completed','verified','failed')),
  verify_result  TEXT,
  error          TEXT,
  retention_until TEXT,
  created_at     TEXT NOT NULL,
  verified_at    TEXT
);
CREATE INDEX idx_backups_created ON backups(created_at DESC);

CREATE TABLE restore_tests (
  id           TEXT PRIMARY KEY,
  backup_id    TEXT NOT NULL REFERENCES backups(id) ON DELETE CASCADE,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  status       TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','passed','failed')),
  checks_json  TEXT NOT NULL DEFAULT '[]',
  error        TEXT,
  performed_by TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_restore_tests ON restore_tests(started_at DESC);

-- -------------------------------------------- retention / data requests ----
CREATE TABLE retention_policies (
  entity        TEXT PRIMARY KEY CHECK (entity IN
                  ('leads','recordings','transcripts','message_logs','analytics')),
  retain_days   INTEGER NOT NULL CHECK (retain_days >= 1),
  action        TEXT NOT NULL DEFAULT 'delete' CHECK (action IN ('delete','anonymise')),
  -- Suppression/opt-out records are never subject to automatic deletion.
  exempt_note   TEXT NOT NULL DEFAULT 'suppression_list retained permanently',
  updated_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE data_requests (
  id            TEXT PRIMARY KEY,
  kind          TEXT NOT NULL CHECK (kind IN ('export','deletion')),
  subject_ref   TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','in_progress','completed','rejected')),
  result_path   TEXT,
  notes         TEXT,
  requested_by  TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  completed_at  TEXT
);
