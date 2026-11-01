-- 006_session_reauth.sql
-- Short-lived re-authentication grant used before sensitive owner actions
-- (enabling live outreach, raising budget/limits, resuming after emergency stop).
ALTER TABLE sessions ADD COLUMN reauth_until TEXT;
