-- 006_session_reauth.sql (PostgreSQL)
-- Short-lived re-authentication grant used before sensitive owner actions
-- (enabling live outreach, raising budget/limits, resuming after emergency stop).
--
-- Identical to the SQLite original: a nullable TEXT column is valid
-- PostgreSQL as written.
ALTER TABLE sessions ADD COLUMN reauth_until TEXT;
