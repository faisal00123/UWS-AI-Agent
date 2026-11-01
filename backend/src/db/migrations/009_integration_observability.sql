-- 009_integration_observability.sql
-- Phase 11A: adapter usage tracking + persisted health checks.
--
-- adapter_usage    - one row per outbound adapter operation (call placed,
--                    message sent, completion, transcription, ...). Contains
--                    operational metadata only: NEVER credentials, payloads
--                    or destination numbers.
-- integration_health - the most recent connection probe per integration as
--                    shown on the Settings/Integrations dashboard ("last
--                    health check"). Detail text is redacted by the writer.

CREATE TABLE adapter_usage (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  integration  TEXT NOT NULL,               -- telephony|whatsapp|ai|speech|email|discovery
  operation    TEXT NOT NULL,               -- e.g. createCall, sendTemplate, complete
  outcome      TEXT NOT NULL CHECK (outcome IN ('ok', 'error', 'rate_limited', 'disabled')),
  error_code   TEXT,                        -- AdapterErrorCode when outcome != ok
  duration_ms  INTEGER NOT NULL,
  retries      INTEGER NOT NULL DEFAULT 0,
  occurred_at  TEXT NOT NULL
);
CREATE INDEX idx_adapter_usage_time ON adapter_usage(integration, occurred_at);
CREATE INDEX idx_adapter_usage_outcome ON adapter_usage(outcome, occurred_at);

CREATE TABLE integration_health (
  integration  TEXT PRIMARY KEY,            -- telephony|whatsapp|ai|speech|email|discovery
  checked_at   TEXT NOT NULL,
  ok           INTEGER NOT NULL CHECK (ok IN (0, 1)),
  state        TEXT NOT NULL,               -- configured|unconfigured|disabled|error
  detail       TEXT,                        -- redacted human summary (no secrets)
  duration_ms  INTEGER NOT NULL
);
