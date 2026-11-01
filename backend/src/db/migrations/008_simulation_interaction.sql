-- 008_simulation_interaction.sql
-- Distinguish simulated contact from real customer contact on the timeline.
--
-- A simulated call rehearses the full mechanics (guard, ledger, transcript,
-- timeline) without a real person ever being reached. It must therefore be
-- marked at the row level so it can NEVER satisfy an honesty rule:
--   - hasContactEvidence() excludes simulation=1 (no stage advance on rehearsals)
--   - completeTask() refuses simulation=1 (a follow-up needs a real outcome)
-- Default 0 keeps every existing (real) interaction real.
ALTER TABLE interactions ADD COLUMN simulation INTEGER NOT NULL DEFAULT 0
  CHECK (simulation IN (0, 1));
