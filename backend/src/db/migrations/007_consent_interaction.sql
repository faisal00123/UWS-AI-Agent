-- 007_consent_interaction.sql
-- Add 'consent' to the interactions.kind CHECK constraint so explicit marketing
-- consent can be recorded on the audit timeline (the eligibility gate reads
-- kind='consent'; without this value the constraint rejected every attempt).
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.
-- Two tables reference interactions(id) with ON DELETE SET NULL, so a plain
-- DROP would silently null their evidence links. The rename therefore runs
-- with legacy_alter_table=ON: references in lead_stage_history and
-- followup_tasks keep pointing at the table NAME 'interactions' while the
-- replacement is built underneath them, and no row is dropped or nulled.
PRAGMA legacy_alter_table = ON;

ALTER TABLE interactions RENAME TO interactions_legacy;

CREATE TABLE interactions (
  id             TEXT PRIMARY KEY,
  business_id    TEXT NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN
                   ('call','whatsapp_message','whatsapp_call','email','meeting',
                    'note','followup','import','analysis','system','score','consent')),
  direction      TEXT CHECK (direction IS NULL OR direction IN ('inbound','outbound','internal')),
  summary        TEXT NOT NULL,
  outcome        TEXT,
  evidence_json  TEXT,
  occurred_at    TEXT NOT NULL,
  created_by     TEXT REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO interactions (id, business_id, kind, direction, summary, outcome, evidence_json, occurred_at, created_by)
  SELECT id, business_id, kind, direction, summary, outcome, evidence_json, occurred_at, created_by
  FROM interactions_legacy;

-- The legacy table still owns the original index names; drop it first so the
-- replacement indexes can take them.
DROP TABLE interactions_legacy;

CREATE INDEX idx_interactions_business ON interactions(business_id, occurred_at DESC);
CREATE INDEX idx_interactions_kind ON interactions(kind, occurred_at DESC);

PRAGMA legacy_alter_table = OFF;
