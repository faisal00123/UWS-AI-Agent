-- 003_pipeline.sql
-- Stage history, interactions, follow-ups, meetings, proposals, deals,
-- payments and human handoffs.

-- -------------------------------------------------------- interactions -----
CREATE TABLE interactions (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('call','whatsapp_message','whatsapp_call','email','meeting',
                    'note','followup','import','analysis','system','score')),
  direction      TEXT CHECK (direction IS NULL OR direction IN ('inbound','outbound','internal')),
  summary        TEXT NOT NULL,
  outcome        TEXT,
  evidence_json  TEXT,
  occurred_at    TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX idx_interactions_business ON interactions(business_id, occurred_at DESC);
CREATE INDEX idx_interactions_kind ON interactions(kind, occurred_at DESC);

-- ---------------------------------------------------- stage history --------
CREATE TABLE lead_stage_history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  from_stage        TEXT,
  to_stage          TEXT NOT NULL,
  reason            TEXT NOT NULL,
  evidence_interaction_id TEXT REFERENCES interactions(id) ON DELETE SET NULL,
  changed_by        TEXT REFERENCES users(id) ON DELETE SET NULL,  -- NULL = system/automation
  changed_at        TEXT NOT NULL
);
CREATE INDEX idx_stage_history_business ON lead_stage_history(business_id, changed_at DESC);

-- Database-level evidence requirement: "Interested" and "Qualified" cannot be
-- recorded without a supporting interaction. Business logic also enforces this
-- with a clearer message; this trigger is the backstop.
CREATE TRIGGER trg_stage_evidence_required
BEFORE INSERT ON lead_stage_history
WHEN NEW.to_stage IN ('interested','qualified','contacted')
BEGIN
  SELECT CASE WHEN NEW.evidence_interaction_id IS NULL THEN
    RAISE(ABORT, 'stage_change_requires_evidence')
  END;
END;

-- Won/Lost must cite a reason (owner confirmation or verified record).
CREATE TRIGGER trg_stage_won_lost_reason
BEFORE INSERT ON lead_stage_history
WHEN NEW.to_stage IN ('won','lost')
BEGIN
  SELECT CASE WHEN length(trim(NEW.reason)) < 3 THEN
    RAISE(ABORT, 'won_lost_requires_reason')
  END;
END;

-- ------------------------------------------------------- followup_tasks ----
CREATE TABLE followup_tasks (
  id                 TEXT PRIMARY KEY,
  business_id        TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  type               TEXT NOT NULL CHECK (type IN
                       ('callback','meeting','followup_call','followup_message','task','human_handoff')),
  title              TEXT NOT NULL,
  notes              TEXT,
  scheduled_for      TEXT NOT NULL,
  timezone           TEXT NOT NULL DEFAULT 'Asia/Karachi',
  channel            TEXT CHECK (channel IS NULL OR channel IN ('call','whatsapp_message','whatsapp_call','email','manual')),
  followup_sequence  INTEGER NOT NULL DEFAULT 1 CHECK (followup_sequence >= 1),
  status             TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN
                       ('scheduled','due','running','completed','cancelled','blocked','failed','missed')),
  blocked_reason     TEXT,
  requested_by_customer INTEGER NOT NULL DEFAULT 0 CHECK (requested_by_customer IN (0,1)),
  requires_evidence  INTEGER NOT NULL DEFAULT 1 CHECK (requires_evidence IN (0,1)),
  completed_at       TEXT,
  completed_interaction_id TEXT REFERENCES interactions(id) ON DELETE SET NULL,
  cancel_reason      TEXT,
  created_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);
CREATE INDEX idx_followup_due ON followup_tasks(status, scheduled_for);
CREATE INDEX idx_followup_business ON followup_tasks(business_id, status);
-- Duplicate-concurrency guard: at most ONE active task of a type+time per lead.
CREATE UNIQUE INDEX ux_followup_active
  ON followup_tasks(business_id, type, scheduled_for)
  WHERE status IN ('scheduled','due','running');

-- ------------------------------------------------------------ meetings -----
CREATE TABLE meetings (
  id              TEXT PRIMARY KEY,
  business_id     TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  followup_task_id TEXT REFERENCES followup_tasks(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'meeting' CHECK (kind IN ('meeting','callback')),
  starts_at       TEXT NOT NULL,
  ends_at         TEXT NOT NULL,
  timezone        TEXT NOT NULL DEFAULT 'Asia/Karachi',
  status          TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN
                    ('proposed','scheduled','completed','cancelled','no_show','failed')),
  channel         TEXT NOT NULL DEFAULT 'manual' CHECK (channel IN ('manual','call','whatsapp_message','calendar')),
  provider_ref    TEXT,
  notes           TEXT,
  outcome_note    TEXT,
  created_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  CONSTRAINT chk_meeting_window CHECK (ends_at > starts_at)
);
CREATE INDEX idx_meetings_business ON meetings(business_id, starts_at);
CREATE INDEX idx_meetings_upcoming ON meetings(status, starts_at);

-- ----------------------------------------------------------- proposals -----
CREATE TABLE proposals (
  id            TEXT PRIMARY KEY,
  business_id   TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  deal_id       TEXT,                     -- FK added after deals table exists
  services_json TEXT NOT NULL,            -- array of services.key
  portfolio_items_json TEXT NOT NULL DEFAULT '[]',
  status        TEXT NOT NULL DEFAULT 'draft' CHECK (status IN
                  ('draft','sent','viewed','accepted','rejected','expired','cancelled')),
  estimated_value_minor INTEGER,
  currency      TEXT NOT NULL DEFAULT 'PKR',
  sent_at       TEXT,
  sent_via      TEXT CHECK (sent_via IS NULL OR sent_via IN ('whatsapp_message','email','call','manual')),
  provider_message_id TEXT,
  response_note TEXT,
  created_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);
CREATE INDEX idx_proposals_business ON proposals(business_id, created_at DESC);
CREATE INDEX idx_proposals_status ON proposals(status, sent_at);

-- --------------------------------------------------------------- deals -----
CREATE TABLE deals (
  id                TEXT PRIMARY KEY,
  business_id       TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  title             TEXT NOT NULL,
  services_json     TEXT NOT NULL DEFAULT '[]',
  currency          TEXT NOT NULL DEFAULT 'PKR',
  stage             TEXT NOT NULL DEFAULT 'proposed'
                      CHECK (stage IN ('proposed','negotiating','won','lost')),
  -- Estimated vs verified value are DIFFERENT columns on purpose.
  estimated_value_minor INTEGER,
  estimated_state   TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (estimated_state IN ('unknown','estimated','stated')),
  agreed_value_minor INTEGER,
  agreed_state      TEXT NOT NULL DEFAULT 'unknown'
                      CHECK (agreed_state IN ('unknown','stated','verified')),
  -- A deal can only be 'won' with owner confirmation or a verified record.
  confirmed         INTEGER NOT NULL DEFAULT 0 CHECK (confirmed IN (0,1)),
  confirmation_evidence TEXT,
  confirmed_by      TEXT REFERENCES users(id) ON DELETE SET NULL,
  confirmed_at      TEXT,
  won_at            TEXT,
  lost_at           TEXT,
  loss_reason       TEXT,
  created_by        TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL,
  CONSTRAINT chk_deal_won_confirmed CHECK (
    stage <> 'won' OR (confirmed = 1 AND confirmed_at IS NOT NULL)
  ),
  CONSTRAINT chk_deal_lost_reason CHECK (
    stage <> 'lost' OR (lost_at IS NOT NULL AND loss_reason IS NOT NULL)
  )
);
CREATE INDEX idx_deals_business ON deals(business_id, created_at DESC);
CREATE INDEX idx_deals_stage ON deals(stage, updated_at DESC);

-- Proposal -> deal integrity is enforced by the application layer (ALTER kept
-- out of an applied migration to preserve checksum stability).
CREATE INDEX idx_proposals_deal ON proposals(deal_id);

-- ------------------------------------------------------------- payments -----
CREATE TABLE payments (
  id            TEXT PRIMARY KEY,
  deal_id       TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  amount_minor  INTEGER NOT NULL CHECK (amount_minor > 0),
  currency      TEXT NOT NULL DEFAULT 'PKR',
  status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN
                  ('pending','received','verified','failed','refunded')),
  method        TEXT,
  reference     TEXT,
  received_at   TEXT,
  verified_at   TEXT,
  verified_by   TEXT REFERENCES users(id) ON DELETE SET NULL,
  evidence_note TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL
);
CREATE INDEX idx_payments_deal ON payments(deal_id, status);
-- Revenue is only ever counted from verified payments:
CREATE INDEX idx_payments_verified ON payments(status, verified_at) WHERE status = 'verified';

-- -------------------------------------------------------- human_handoffs ----
CREATE TABLE human_handoffs (
  id                   TEXT PRIMARY KEY,
  business_id          TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  requested_at         TEXT NOT NULL,
  conversation_id      TEXT,
  summary              TEXT NOT NULL,
  preferred_contact_time TEXT,
  preferred_language   TEXT NOT NULL DEFAULT 'unknown'
                         CHECK (preferred_language IN ('ur','roman_ur','en','mixed','unknown')),
  status               TEXT NOT NULL DEFAULT 'requested' CHECK (status IN
                         ('requested','notified','scheduled','completed','cancelled')),
  assigned_to          TEXT REFERENCES users(id) ON DELETE SET NULL,
  next_action          TEXT,
  notification_id      TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE INDEX idx_handoffs_status ON human_handoffs(status, requested_at DESC);
