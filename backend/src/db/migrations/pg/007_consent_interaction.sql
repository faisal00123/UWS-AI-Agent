-- 007_consent_interaction.sql (PostgreSQL)
-- Add 'consent' to the interactions.kind CHECK constraint so explicit marketing
-- consent can be recorded on the audit timeline (the eligibility gate reads
-- kind='consent'; without this value the constraint rejected every attempt).
--
-- PostgreSQL CAN alter a CHECK constraint in place, so the SQLite table-rebuild
-- dance (PRAGMA legacy_alter_table + RENAME + copy + DROP) is unnecessary here:
-- 003_pipeline.sql names the constraint chk_interactions_kind precisely so this
-- migration can DROP and re-ADD it. No row is touched, no FK is dropped, and
-- the NOT NULL column property is unaffected (NOT NULL is separate from the
-- CHECK constraint).
ALTER TABLE interactions DROP CONSTRAINT chk_interactions_kind;

ALTER TABLE interactions ADD CONSTRAINT chk_interactions_kind CHECK (kind IN
  ('call','whatsapp_message','whatsapp_call','email','meeting',
   'note','followup','import','analysis','system','score','consent'));
