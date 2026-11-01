-- 001_core.sql
-- Identity, governance, operating state, notifications, incidents.
-- Every timestamp is ISO-8601 UTC text ("2026-10-27T09:00:00.000Z").

-- ---------------------------------------------------------------- users ----
CREATE TABLE users (
  id                   TEXT PRIMARY KEY,
  email                TEXT NOT NULL COLLATE NOCASE,
  display_name         TEXT NOT NULL,
  role                 TEXT NOT NULL CHECK (role IN ('owner','staff')),
  password_hash        TEXT NOT NULL,          -- format: scrypt$N$r$p$salt$hash
  password_algo        TEXT NOT NULL DEFAULT 'scrypt' CHECK (password_algo IN ('scrypt')),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0,1)),
  mfa_enabled          INTEGER NOT NULL DEFAULT 0 CHECK (mfa_enabled IN (0,1)),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  failed_login_count   INTEGER NOT NULL DEFAULT 0,
  locked_until         TEXT,
  last_login_at        TEXT,
  password_changed_at  TEXT,
  created_at           TEXT NOT NULL,
  updated_at           TEXT NOT NULL
);
CREATE UNIQUE INDEX ux_users_email ON users(email);

-- ------------------------------------------------------------- sessions ----
-- Only the SHA-256 of the opaque cookie token is stored: a database leak does
-- not yield usable sessions.
CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,             -- sha256(raw token)
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret  TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip_hash      TEXT,
  user_agent   TEXT
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL COLLATE NOCASE,
  ip_hash    TEXT NOT NULL,
  succeeded  INTEGER NOT NULL CHECK (succeeded IN (0,1)),
  reason     TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_login_attempts_email ON login_attempts(email, created_at);
CREATE INDEX idx_login_attempts_ip ON login_attempts(ip_hash, created_at);

-- ----------------------------------------------------------- settings ------
-- Owner-editable configuration. Each key is validated by a zod schema in
-- src/domain/settings before it can be written.
CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  version    INTEGER NOT NULL DEFAULT 1,
  updated_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL
);

-- ---------------------------------------------------- operating state ------
-- Single row. Contains the ONLY authoritative operating mode + emergency stop
-- used by the outreach guard. Restart/crash sets `paused = 1` so outreach
-- never resumes automatically (Section 3.5).
CREATE TABLE operating_state (
  id                   INTEGER PRIMARY KEY CHECK (id = 1),
  mode                 TEXT NOT NULL DEFAULT 'simulation'
                           CHECK (mode IN ('simulation','live')),
  emergency_stop       INTEGER NOT NULL DEFAULT 0 CHECK (emergency_stop IN (0,1)),
  emergency_stop_reason TEXT,
  emergency_stop_at    TEXT,
  emergency_stop_by    TEXT REFERENCES users(id) ON DELETE SET NULL,
  paused               INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  pause_reason         TEXT,
  paused_at            TEXT,
  resumed_at           TEXT,
  resumed_by           TEXT REFERENCES users(id) ON DELETE SET NULL,
  restart_count        INTEGER NOT NULL DEFAULT 0,
  updated_at           TEXT NOT NULL
);
INSERT INTO operating_state (id, mode, paused, pause_reason, updated_at)
VALUES (1, 'simulation', 0, NULL, '1970-01-01T00:00:00.000Z');

-- -------------------------------------------------------- audit_events -----
-- Append-only. Never updated or deleted by application code.
CREATE TABLE audit_events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at    TEXT NOT NULL,
  actor_user_id  TEXT REFERENCES users(id) ON DELETE SET NULL,
  actor_label    TEXT NOT NULL,             -- 'owner', 'staff', 'system', 'scheduler'
  action         TEXT NOT NULL,             -- e.g. 'settings.update', 'emergency.stop'
  entity_type    TEXT,
  entity_id      TEXT,
  summary        TEXT NOT NULL,
  details_json   TEXT,
  ip_hash        TEXT
);
CREATE INDEX idx_audit_time ON audit_events(occurred_at);
CREATE INDEX idx_audit_action ON audit_events(action, occurred_at);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);

-- --------------------------------------------------------- incidents -------
CREATE TABLE incidents (
  id                  TEXT PRIMARY KEY,
  component           TEXT NOT NULL,     -- database|telephony|whatsapp|scheduler|auth|backup|reporting|discovery
  severity            TEXT NOT NULL CHECK (severity IN ('info','warning','critical')),
  title               TEXT NOT NULL,
  detail              TEXT,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open','investigating','mitigated','resolved','false_positive')),
  detected_at         TEXT NOT NULL,
  last_error          TEXT,
  recovery_attempted  TEXT,
  recovery_test_ref   TEXT,               -- required before 'resolved'
  recovery_verified_at TEXT,
  verified_by         TEXT REFERENCES users(id) ON DELETE SET NULL,
  resolved_at         TEXT,
  -- An incident may not be claimed "resolved" without a verified recovery test.
  CONSTRAINT chk_incident_resolution CHECK (
    status <> 'resolved'
    OR (resolved_at IS NOT NULL AND recovery_test_ref IS NOT NULL AND recovery_verified_at IS NOT NULL)
  )
);
CREATE INDEX idx_incidents_status ON incidents(status, detected_at);

-- ------------------------------------------------------ notifications ------
CREATE TABLE notifications (
  id           TEXT PRIMARY KEY,
  kind         TEXT NOT NULL,
  severity     TEXT NOT NULL DEFAULT 'info' CHECK (severity IN ('info','warning','critical')),
  title        TEXT NOT NULL,
  body         TEXT NOT NULL,
  channel      TEXT NOT NULL CHECK (channel IN ('in_app','email','whatsapp')),
  status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','delivered','failed','skipped','read')),
  status_source TEXT NOT NULL DEFAULT 'none'
                 CHECK (status_source IN ('none','provider_event','simulation')),
  provider_ref TEXT,
  error_detail TEXT,
  entity_type  TEXT,
  entity_id    TEXT,
  dedupe_key   TEXT,
  read_at      TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_notifications_created ON notifications(created_at DESC);
CREATE INDEX idx_notifications_status ON notifications(status, created_at);
-- Idempotent fan-out: the same event never raises two notifications.
CREATE UNIQUE INDEX ux_notifications_dedupe ON notifications(dedupe_key) WHERE dedupe_key IS NOT NULL;

-- ---------------------------------------------------------- job_runs -------
CREATE TABLE job_runs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  job_name   TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status     TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','success','failed','skipped')),
  detail     TEXT,
  error      TEXT
);
CREATE INDEX idx_job_runs_name ON job_runs(job_name, started_at DESC);
