-- 004_outreach.sql
-- The outreach ledger (every guard decision), calls, messages, provider
-- events (idempotent), conversations, campaigns and approval requests.

-- ---------------------------------------------------- outreach_attempts ----
-- ONE row is written for EVERY outbound action request, whether the guard
-- allowed or blocked it. This is the audit trail for "why was this call made /
-- not made".
CREATE TABLE outreach_attempts (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('call','whatsapp_call','whatsapp_message')),
  purpose           TEXT NOT NULL CHECK (purpose IN
                      ('initial_outreach','followup','callback','portfolio_share','owner_notification')),
  task_id           TEXT REFERENCES followup_tasks(id) ON DELETE SET NULL,
  decision          TEXT NOT NULL CHECK (decision IN ('allowed','blocked')),
  blocked_reason    TEXT,
  blocked_code      TEXT,
  guard_results_json TEXT NOT NULL,      -- every safeguard evaluated, with pass/fail/unknown
  idempotency_key   TEXT NOT NULL UNIQUE, -- prevents duplicate concurrent outreach
  mode              TEXT NOT NULL CHECK (mode IN ('simulation','live')),
  provider          TEXT,                 -- NULL when blocked before provider selection
  call_id           TEXT,
  message_id        TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_outreach_business ON outreach_attempts(business_id, created_at DESC);
CREATE INDEX idx_outreach_decision ON outreach_attempts(decision, created_at DESC);
CREATE INDEX idx_outreach_day ON outreach_attempts(channel, created_at);

-- --------------------------------------------------------------- calls -----
CREATE TABLE calls (
  id                TEXT PRIMARY KEY,
  attempt_id        TEXT REFERENCES outreach_attempts(id) ON DELETE SET NULL,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  direction         TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('outbound','inbound')),
  channel           TEXT NOT NULL CHECK (channel IN ('call','whatsapp_call')),
  provider          TEXT NOT NULL,            -- 'simulation' or a vendor key
  provider_call_id  TEXT,
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                      ('queued','initiated','ringing','in_progress','completed','busy','no_answer',
                       'failed','cancelled','voicemail')),
  outcome           TEXT NOT NULL DEFAULT 'unknown' CHECK (outcome IN
                      ('unknown','answered','unanswered','failed','voicemail','wrong_number',
                       'not_interested','interested','qualified','callback_requested',
                       'human_requested','opted_out','do_not_call_request')),
  to_number_e164    TEXT NOT NULL,
  recording_enabled INTEGER NOT NULL DEFAULT 0 CHECK (recording_enabled IN (0,1)),
  recording_consent INTEGER NOT NULL DEFAULT 0 CHECK (recording_consent IN (0,1)),
  recording_ref     TEXT,
  started_at        TEXT,
  answered_at       TEXT,
  ended_at          TEXT,
  duration_seconds  INTEGER CHECK (duration_seconds IS NULL OR duration_seconds >= 0),
  failure_code      TEXT,
  failure_detail    TEXT,
  simulation        INTEGER NOT NULL DEFAULT 0 CHECK (simulation IN (0,1)),
  counts_against_daily_limit INTEGER NOT NULL DEFAULT 1 CHECK (counts_against_daily_limit IN (0,1)),
  daily_bucket      TEXT,                    -- business-timezone YYYY-MM-DD the attempt was counted in
  cost_minor        INTEGER,
  cost_currency     TEXT,
  cost_state        TEXT NOT NULL DEFAULT 'unavailable'
                      CHECK (cost_state IN ('actual','estimated','unavailable')),
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_calls_provider_ref ON calls(provider, provider_call_id)
  WHERE provider_call_id IS NOT NULL;
CREATE INDEX idx_calls_business ON calls(business_id, created_at DESC);
CREATE INDEX idx_calls_daily ON calls(daily_bucket, direction);
-- Duplicate concurrent call protection: at most one live outbound call per lead.
CREATE UNIQUE INDEX ux_calls_live_per_business
  ON calls(business_id, channel)
  WHERE status IN ('queued','initiated','ringing','in_progress') AND direction = 'outbound';

-- ------------------------------------------------------------- messages -----
CREATE TABLE messages (
  id                TEXT PRIMARY KEY,
  attempt_id        TEXT REFERENCES outreach_attempts(id) ON DELETE SET NULL,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  channel           TEXT NOT NULL CHECK (channel IN ('whatsapp_message','email','sms_not_supported')),
  provider          TEXT NOT NULL,
  provider_message_id TEXT,
  template_key      TEXT,
  purpose           TEXT NOT NULL DEFAULT 'portfolio_share'
                      CHECK (purpose IN ('portfolio_share','followup','owner_notification','proposal','other')),
  number_used       TEXT,                     -- the WhatsApp number actually used
  number_source     TEXT CHECK (number_source IS NULL OR number_source IN
                      ('same_as_call','provided_by_prospect','owner_configured','unknown')),
  body_preview      TEXT,                     -- redacted/truncated preview
  status            TEXT NOT NULL DEFAULT 'queued' CHECK (status IN
                      ('queued','accepted','sent','delivered','read','failed','rejected','blocked','unknown')),
  status_source     TEXT NOT NULL DEFAULT 'none'
                      CHECK (status_source IN ('none','provider_event','simulation')),
  error_code        TEXT,
  error_detail      TEXT,
  simulation        INTEGER NOT NULL DEFAULT 0 CHECK (simulation IN (0,1)),
  counts_against_daily_limit INTEGER NOT NULL DEFAULT 1 CHECK (counts_against_daily_limit IN (0,1)),
  daily_bucket      TEXT,
  cost_minor        INTEGER,
  cost_currency     TEXT,
  cost_state        TEXT NOT NULL DEFAULT 'unavailable'
                      CHECK (cost_state IN ('actual','estimated','unavailable')),
  sent_at           TEXT,
  last_status_at    TEXT,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_messages_provider_ref ON messages(provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX idx_messages_business ON messages(business_id, created_at DESC);
CREATE INDEX idx_messages_status ON messages(status, created_at DESC);
-- SMS is deliberately NOT a supported channel: only WhatsApp/email rows exist.
CREATE UNIQUE INDEX ux_messages_live_per_business
  ON messages(business_id, channel)
  WHERE status IN ('queued','accepted','sent') AND channel = 'whatsapp_message';

-- -------------------------------------------------------- provider_events ---
-- Idempotency: replaying a webhook cannot double-count a call or a delivery.
CREATE TABLE provider_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  provider      TEXT NOT NULL,
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  resource_type TEXT NOT NULL CHECK (resource_type IN ('call','message','unknown')),
  resource_id   TEXT,
  payload_json  TEXT NOT NULL,
  received_at   TEXT NOT NULL,
  processed_at  TEXT,
  process_result TEXT,
  duplicate_count INTEGER NOT NULL DEFAULT 0
);
-- Replayed webhooks (same provider + event id) cannot be inserted twice.
CREATE UNIQUE INDEX ux_provider_events ON provider_events(provider, event_id);
CREATE INDEX idx_provider_events_resource ON provider_events(resource_type, resource_id);
CREATE INDEX idx_provider_events_time ON provider_events(received_at DESC);

-- --------------------------------------------------------- conversations ---
CREATE TABLE conversations (
  id                TEXT PRIMARY KEY,
  call_id           TEXT REFERENCES calls(id) ON DELETE CASCADE,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  language          TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (language IN ('ur','roman_ur','en','mixed','unknown')),
  ai_identity_disclosed INTEGER NOT NULL DEFAULT 1 CHECK (ai_identity_disclosed IN (0,1)),
  human_requested   INTEGER NOT NULL DEFAULT 0 CHECK (human_requested IN (0,1)),
  transcript_state  TEXT NOT NULL DEFAULT 'none'
                      CHECK (transcript_state IN ('none','partial','complete','unavailable')),
  summary           TEXT,
  extracted_json    TEXT,               -- structured qualification extracted from the conversation
  started_at        TEXT NOT NULL,
  ended_at          TEXT,
  created_at        TEXT NOT NULL
);
CREATE INDEX idx_conversations_business ON conversations(business_id, started_at DESC);

CREATE TABLE transcript_segments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  speaker         TEXT NOT NULL CHECK (speaker IN ('agent','prospect','system')),
  text            TEXT NOT NULL,
  language        TEXT CHECK (language IS NULL OR language IN ('ur','roman_ur','en','mixed','unknown')),
  confidence      REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  source          TEXT NOT NULL CHECK (source IN ('stt','typed','simulated','structured_outcome')),
  occurred_at     TEXT NOT NULL,
  UNIQUE (conversation_id, seq)
);

-- --------------------------------------------------- campaigns/approvals ----
CREATE TABLE campaigns (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  description        TEXT,
  target_categories_json TEXT NOT NULL DEFAULT '[]',
  target_cities_json TEXT NOT NULL DEFAULT '[]',
  script_key         TEXT,
  script_version     INTEGER NOT NULL DEFAULT 1,
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                       ('draft','pending_approval','approved','rejected','active','paused','completed')),
  approval_id        TEXT,
  max_daily_calls    INTEGER,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE approval_requests (
  id                 TEXT PRIMARY KEY,
  change_type        TEXT NOT NULL CHECK (change_type IN
                       ('campaign_strategy','script','targeting','schedule','budget',
                        'settings','live_activation','budget_increase','retention')),
  title              TEXT NOT NULL,
  proposed_json      TEXT NOT NULL,
  current_json       TEXT,
  reason             TEXT NOT NULL,
  expected_benefit   TEXT,
  evidence_json      TEXT,
  risks              TEXT,
  current_config_version TEXT,
  status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                       ('pending','approved','rejected','withdrawn')),
  decision_note      TEXT,
  decided_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  decided_at         TEXT,
  applied_at         TEXT,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL
);
CREATE INDEX idx_approvals_status ON approval_requests(status, created_at DESC);
