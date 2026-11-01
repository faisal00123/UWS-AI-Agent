import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations, hasPendingMigrations, MIGRATIONS_DIR } from '../../src/db/migrate.ts';

let db: DB;

describe('database migrations', () => {
  before(() => {
    db = openDatabase(':memory:');
  });
  after(() => {
    db.close();
  });

  test('all migrations apply successfully', () => {
    const res = runMigrations(db);
    assert.ok(res.applied.length >= 5, `expected >=5 migrations, got ${res.applied.length}`);
    assert.equal(hasPendingMigrations(db), false);
  });

  test('re-running is a no-op', () => {
    const res = runMigrations(db);
    assert.equal(res.applied.length, 0);
    assert.ok(res.skipped.length >= 5);
  });

  test('expected tables, indices and columns exist', () => {
    const names = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    for (const t of [
      'users', 'sessions', 'login_attempts', 'settings', 'operating_state', 'audit_events',
      'incidents', 'notifications', 'job_runs', 'businesses', 'lead_sources', 'contact_points',
      'field_verifications', 'website_analyses', 'lead_scores', 'score_factors', 'eligibility_checks',
      'suppression_list', 'duplicate_candidates', 'merge_history', 'interactions',
      'lead_stage_history', 'followup_tasks', 'meetings', 'proposals', 'deals', 'payments',
      'human_handoffs', 'outreach_attempts', 'calls', 'messages', 'provider_events',
      'conversations', 'transcript_segments', 'campaigns', 'approval_requests',
      'budget_usage', 'cost_records', 'daily_reports', 'services', 'portfolio_items',
      'message_templates', 'backups', 'restore_tests', 'retention_policies', 'data_requests',
      'schema_migrations',
    ]) {
      assert.ok(names.has(t), `missing table: ${t}`);
    }
    const idx = new Set(
      (db.prepare(`SELECT name FROM sqlite_master WHERE type='index'`).all() as { name: string }[]).map(
        (r) => r.name,
      ),
    );
    for (const i of ['ux_businesses_phone', 'ux_followup_active', 'ux_provider_events', 'ux_notifications_dedupe']) {
      assert.ok(idx.has(i), `missing index: ${i}`);
    }
  });

  test('foreign keys are enforced', () => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO interactions (id, business_id, kind, summary, occurred_at)
             VALUES ('i1', 'does-not-exist', 'note', 'x', '2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      /FOREIGN KEY/i,
    );
  });

  test('CHECK constraints reject invalid enums', () => {
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO businesses (id, display_name, normalized_name, source_type, stage, discovered_at, created_at, updated_at)
             VALUES ('b1','X','x','web_search','not_a_stage','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
          )
          .run(),
      /CHECK constraint/i,
    );
  });

  test('trigger: interested/qualified stage change requires evidence', () => {
    const now = '2026-01-01T00:00:00.000Z';
    db.prepare(
      `INSERT INTO businesses (id, display_name, normalized_name, source_type, discovered_at, created_at, updated_at)
       VALUES ('b_ev','Evidence Co','evidence co','manual',?,?,?)`,
    ).run(now, now, now);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO lead_stage_history (business_id, from_stage, to_stage, reason, changed_at)
             VALUES ('b_ev','new_lead','interested','felt like it',?)`,
          )
          .run(now),
      /stage_change_requires_evidence/,
    );
    // with an evidence interaction id it succeeds
    db.prepare(
      `INSERT INTO interactions (id, business_id, kind, summary, occurred_at)
       VALUES ('i_ev','b_ev','note','prospect said yes',?)`,
    ).run(now);
    db.prepare(
      `INSERT INTO lead_stage_history (business_id, from_stage, to_stage, reason, evidence_interaction_id, changed_at)
       VALUES ('b_ev','new_lead','interested','prospect confirmed interest','i_ev',?)`,
    ).run(now);
  });

  test('trigger: won/lost requires a reason', () => {
    const now = '2026-01-01T00:00:00.000Z';
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO lead_stage_history (business_id, from_stage, to_stage, reason, changed_at)
             VALUES ('b_ev','qualified','won','',?)`,
          )
          .run(now),
      /won_lost_requires_reason/,
    );
  });

  test('deal cannot be marked won without confirmation', () => {
    const now = '2026-01-01T00:00:00.000Z';
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO deals (id, business_id, title, stage, confirmed, created_at, updated_at)
             VALUES ('d1','b_ev','Website','won',0,?,?)`,
          )
          .run(now, now),
      /CHECK constraint/i,
    );
    db.prepare(
      `INSERT INTO deals (id, business_id, title, stage, confirmed, confirmed_at, created_at, updated_at)
       VALUES ('d2','b_ev','Website','won',1,?,?,?)`,
    ).run(now, now, now);
  });

  test('duplicate candidate ordering is canonical (no double pairs)', () => {
    const now = '2026-01-01T00:00:00.000Z';
    for (const id of ['b_a', 'b_b', 'b_c']) {
      db.prepare(
        `INSERT INTO businesses (id, display_name, normalized_name, source_type, discovered_at, created_at, updated_at)
         VALUES (?, ?, ?, 'manual', ?, ?, ?)`,
      ).run(id, id, id, now, now, now);
    }
    db.prepare(
      `INSERT INTO duplicate_candidates (id, business_id_a, business_id_b, match_score, match_fields, created_at)
       VALUES ('dc1','b_a','b_b',0.9,'["phone"]',?)`,
    ).run(now);
    assert.throws(
      () =>
        db
          .prepare(
            `INSERT INTO duplicate_candidates (id, business_id_a, business_id_b, match_score, match_fields, created_at)
             VALUES ('dc2','b_b','b_a',0.9,'["phone"]',?)`,
          )
          .run(now),
      /UNIQUE|CHECK/i,
    );
  });

  test('editing an applied migration is detected (checksum drift)', () => {
    const dir = mkdtempSync(join(tmpdir() || './tmp', 'uws-mig-'));
    try {
      mkdirSync(join(dir, 'migrations'), { recursive: true });
      const real = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'));
      for (const f of real) copyFileSync(join(MIGRATIONS_DIR, f), join(dir, 'migrations', f));
      const fresh = openDatabase(':memory:');
      runMigrations(fresh, join(dir, 'migrations'));
      const victim = join(dir, 'migrations', real[0]!);
      writeFileSync(victim, readFileSync(victim, 'utf8') + '\n-- tampered\n');
      assert.throws(() => runMigrations(fresh, join(dir, 'migrations')), /modified after it was applied/);
      fresh.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
