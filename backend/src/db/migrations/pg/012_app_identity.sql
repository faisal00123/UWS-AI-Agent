-- 012_app_identity.sql (PostgreSQL)
-- Database identity: proves which logical database this is.
--
-- The row is seeded by application code (db/identity.ts) during explicit
-- initialisation or on first boot of a legacy database that predates this
-- table — never automatically on an empty production database, which must
-- fail loudly instead (see db/identity.ts).
--
-- Identical semantics to the SQLite original: INTEGER PRIMARY KEY with the
-- single-row CHECK (id = 1) is valid PostgreSQL as written.
CREATE TABLE IF NOT EXISTS app_identity (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  instance_id TEXT NOT NULL,
  app         TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
