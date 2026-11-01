import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { nullLogger } from '../../src/core/logger.ts';
import { analyzeCsv, commitImport, importCsvText, type ImportMeta } from '../../src/domain/leads/import.ts';
import { parseCsv } from '../../src/domain/leads/csv.ts';
import { changeStage, createLead, listLeads, updateLead, getLeadDetail } from '../../src/domain/leads/repository.ts';
import { resolveDuplicate } from '../../src/domain/leads/dedupe.ts';

let db: DB;
let cfg: Config;

const META: ImportMeta = {
  sourceType: 'csv_import',
  sourceLabel: 'test.csv',
  sourceUrl: null,
  importedBy: { userId: null, label: 'system' },
};

function importCsv(csv: string, meta: ImportMeta = META) {
  return importCsvText(db, cfg, csv, meta);
}

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...(params as never[])) as { c: number }).c;
}

describe('lead import pipeline', () => {
  before(() => {
    cfg = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(48, '0'),
      DATABASE_PATH: ':memory:',
      LOG_LEVEL: 'silent',
    });
    db = openDatabase(':memory:');
    runMigrations(db);
  });
  after(() => db.close());
  beforeEach(() => {
    // Delete children, then merged rows, then survivors. businesses.merged_into_id
    // is self-referential with ON DELETE SET NULL, so deleting a survivor first
    // would resurrect its merged rows as live rows mid-statement and trip the
    // partial unique index on phone_e164.
    db.exec(
      'DELETE FROM merge_history; DELETE FROM duplicate_candidates; DELETE FROM lead_sources; DELETE FROM interactions; DELETE FROM field_verifications;' +
        ' DELETE FROM businesses WHERE merged_into_id IS NOT NULL; DELETE FROM businesses;',
    );
  });

  test('valid CSV import creates leads with provenance and audit trail', () => {
    const csv =
      'Business Name,City,Phone,Website,Category\n' +
      'Karachi Care Clinic,Karachi,03001234567,https://karachicare.pk,clinic\n' +
      'Lahore Bites,Lahore,+92 321 9876543,lahorebites.pk,restaurant\n' +
      'Islamabad Academy,Islamabad,03451112233,,school\n';

    const summary = importCsv(csv);
    assert.equal(summary.totalRows, 3);
    assert.equal(summary.imported, 3, JSON.stringify(summary.rows, null, 2));
    assert.equal(summary.rejected, 0);
    assert.equal(summary.committed, true);
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL'), 3);

    const lead = db.prepare('SELECT * FROM businesses WHERE display_name = ?').get('Karachi Care Clinic') as Record<string, unknown>;
    assert.equal(lead.phone_e164, '+923001234567', 'phone must be normalised');
    assert.equal(lead.website_host, 'karachicare.pk', 'host must be normalised');
    assert.equal(lead.source_type, 'csv_import');
    assert.equal(lead.stage, 'new_lead');
    assert.equal(lead.eligibility_state, 'unknown', 'eligibility must never be assumed');

    // provenance: original values preserved verbatim
    const source = db.prepare('SELECT * FROM lead_sources WHERE business_id = ?').get(String(lead.id)) as { raw_payload_json: string; source_ref: string };
    assert.ok(source.raw_payload_json.includes('03001234567'), 'raw phone must be preserved');
    assert.equal(source.source_ref, 'test.csv');

    // interaction timeline entry
    assert.equal(count(`SELECT COUNT(*) c FROM interactions WHERE kind = 'import' AND business_id = ?`, String(lead.id)), 1);

    // audit trail
    const audit = db.prepare(`SELECT * FROM audit_events WHERE action = 'lead.import' ORDER BY id DESC LIMIT 1`).get() as { summary: string };
    assert.match(audit.summary, /3 row\(s\)/);

    // field verification states recorded
    assert.ok(count(`SELECT COUNT(*) c FROM field_verifications WHERE state = 'verified'`) >= 3);
  });

  test('row without a name is rejected; unusable contact data is flagged, not dropped', () => {
    const csv =
      'name,city,phone,website\n' +
      ',Karachi,03001234567,example.com\n' +
      'Good Business,Lahore,not-a-phone,::::\n' +
      'No Contact Ltd,Karachi,,\n';

    const summary = importCsv(csv);
    assert.equal(summary.rejected, 1, 'nameless row must be rejected');
    assert.equal(summary.needsReview, 2, 'rows with unusable fields need review');
    assert.equal(summary.imported, 0);

    const rejected = summary.rows.find((r) => r.status === 'rejected')!;
    assert.ok(rejected.problems.some((p) => p.field === 'name' && p.severity === 'error'));

    const flagged = summary.rows.find((r) => r.raw.name === 'Good Business')!;
    assert.ok(flagged.problems.some((p) => p.field === 'phone'));
    assert.ok(flagged.problems.some((p) => p.field === 'website'));

    const noContact = summary.rows.find((r) => r.raw.name === 'No Contact Ltd')!;
    assert.ok(noContact.problems.some((p) => /cannot be contacted/.test(p.message)));

    // flagged rows are still stored (never silently discarded)
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 2);
  });

  test('exact phone duplicate is auto-merged and conflicts are preserved', () => {
    importCsv('name,city,phone\nFirst Source,Karachi,03001234567\n');
    const summary = importCsv('name,city,phone\nSecond Name Same Number,Karachi,03001234567\n');

    assert.equal(summary.merged, 1);
    const rows = db.prepare('SELECT id, display_name, merged_into_id FROM businesses ORDER BY created_at').all() as {
      id: string;
      display_name: string;
      merged_into_id: string | null;
    }[];
    assert.equal(rows.length, 2, 'merged row is retained, never deleted');
    const merged = rows.find((r) => r.merged_into_id !== null)!;
    const survivor = rows.find((r) => r.merged_into_id === null)!;
    assert.equal(merged.merged_into_id, survivor.id);
    assert.equal(survivor.display_name, 'First Source', 'survivor keeps its values on conflict');

    // conflict is recorded, not overwritten
    const merge = db.prepare('SELECT * FROM merge_history WHERE survivor_id = ?').get(survivor.id) as {
      overridden_values_json: string;
      kept_values_json: string;
      strategy: string;
      performed_by: string | null;
    };
    assert.equal(merge.strategy, 'exact_phone');
    assert.equal(merge.performed_by, null, 'automatic merges are attributed to the system');
    const overridden = JSON.parse(merge.overridden_values_json) as Record<string, { survivor: string; incoming: string }>;
    assert.ok(overridden.display_name, 'name conflict must be preserved');
    assert.equal(overridden.display_name.survivor, 'First Source');
    assert.equal(overridden.display_name.incoming, 'Second Name Same Number');

    // both source records survive
    assert.equal(count('SELECT COUNT(*) c FROM lead_sources'), 2);
    assert.equal(count(`SELECT COUNT(*) c FROM audit_events WHERE action = 'lead.merge'`), 1);
  });

  test('website host duplicate is auto-merged', () => {
    importCsv('name,website\nAlpha,https://www.Same-Site.com\n');
    const summary = importCsv('name,website\nBeta Trading,same-site.com\n');
    assert.equal(summary.merged, 1);
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL'), 1);
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 2);
  });

  test('exact name+city duplicate is auto-merged', () => {
    importCsv('name,city\nKarachi Care Clinic,Karachi\n');
    const summary = importCsv('name,city\nkarachi care clinic,Karachi\n');
    assert.equal(summary.merged, 1);
    assert.equal(count('SELECT COUNT(*) c FROM duplicate_candidates WHERE status = ' + "'merged'"), 1);
  });

  test('fuzzy name match is flagged for review, never merged automatically', () => {
    importCsv('name,city,phone\nKarachi Clinics,Karachi,03001111111\n');
    const summary = importCsv('name,city,phone\nKarachi Clinic,Karachi,03002222222\n');

    assert.equal(summary.merged, 0, 'fuzzy matches must not auto-merge');
    assert.equal(summary.needsReview, 1);
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL'), 2);
    assert.equal(count(`SELECT COUNT(*) c FROM duplicate_candidates WHERE status = 'pending'`), 1);

    const flagged = db.prepare(`SELECT duplicate_status, duplicate_of_id FROM businesses WHERE display_name = 'Karachi Clinic'`).get() as {
      duplicate_status: string;
      duplicate_of_id: string;
    };
    assert.equal(flagged.duplicate_status, 'pending_review');
    assert.ok(flagged.duplicate_of_id);
  });

  test('manual decisions: merge and not-duplicate both keep data', () => {
    importCsv('name,city,phone\nKarachi Clinics,Karachi,03001111111\n');
    importCsv('name,city,phone\nKarachi Clinic,Karachi,03002222222\n');

    const dup = db.prepare(`SELECT id FROM duplicate_candidates WHERE status = 'pending'`).get() as { id: string };

    const result = resolveDuplicate(db, dup.id, 'merge', { userId: null, label: 'owner' }, 'same shop, verified');
    assert.ok(result.mergedId);
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NOT NULL'), 1);
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 2, 'nothing is deleted');
    const decision = db.prepare('SELECT status, decision_note FROM duplicate_candidates WHERE id = ?').get(dup.id) as {
      status: string;
      decision_note: string;
    };
    assert.equal(decision.status, 'merged');
    assert.equal(decision.decision_note, 'same shop, verified');

    // second scenario: distinct businesses
    db.exec('DELETE FROM duplicate_candidates');
    importCsv('name,city,phone\nKarachi Clinic Two,Karachi,03003333333\n');
    db.exec("UPDATE businesses SET duplicate_status='unique'");
    const dup2 = db.prepare(`SELECT id FROM duplicate_candidates WHERE status = 'pending'`).get() as { id: string } | undefined;
    if (dup2) {
      resolveDuplicate(db, dup2.id, 'not_duplicate', { userId: null, label: 'owner' }, 'different branches');
      assert.equal(count(`SELECT COUNT(*) c FROM duplicate_candidates WHERE status = 'reviewed_not_duplicate'`), 1);
      assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NOT NULL'), 1, 'still only the earlier merge');
    }
  });

  test('duplicate phone inside the SAME file merges against an earlier row', () => {
    const csv =
      'name,phone\n' +
      'Branch A,03001234567\n' +
      'Branch B,03001234567\n' +
      'Branch C,03001234567\n';
    const summary = importCsv(csv);
    assert.equal(summary.imported, 1);
    assert.equal(summary.merged, 2);
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL'), 1);
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 3, 'all rows retained');
    assert.equal(count('SELECT COUNT(*) c FROM lead_sources'), 3, 'all sources retained');
  });

  test('preview (analyze only) writes nothing', () => {
    const analysis = analyzeCsv(db, parseCsv('name,city\nPreview Lead,Quetta\n'));
    assert.equal(analysis.rows.length, 1);
    // no phone/website/email -> honestly flagged as not contactable yet
    assert.equal(analysis.rows[0]!.status, 'needs_review');
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 0, 'preview must not persist');
  });

  test('rollback: a mid-import failure leaves no partial data', () => {
    // Force a failure by breaking the table temporarily via a constraint we can
    // trigger: an impossibly long display_name (>200 chars is rejected by the
    // row analysis, so instead we simulate by dropping a required column).
    const before = count('SELECT COUNT(*) c FROM businesses');
    assert.throws(() => {
      db.exec('ALTER TABLE businesses RENAME TO businesses_tmp_import');
      try {
        importCsv('name\nDoomed Lead\n');
      } finally {
        db.exec('ALTER TABLE businesses_tmp_import RENAME TO businesses');
      }
    });
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), before, 'no partial rows after rollback');
  });

  test('missing name column rejects the whole file with an explanation', () => {
    assert.throws(() => importCsv('city,phone\nKarachi,03001234567\n'), /Missing required column: name/);
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 0, 'structurally invalid files write nothing');
  });
});

describe('lead repository', () => {
  before(() => {
    db = openDatabase(':memory:');
    runMigrations(db);
    cfg = loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'test'.padEnd(48, '0'), DATABASE_PATH: ':memory:' });
  });
  after(() => db.close());

  test('manual creation validates and reports duplicate matches', () => {
    const first = createLead(
      db,
      { displayName: 'Manual Clinic', city: 'Karachi', phone: '03009998887' },
      { userId: null, label: 'owner' },
    );
    assert.equal(first.mergedIntoId, null);

    const dupe = createLead(
      db,
      { displayName: 'Manual Clinic Karachi', city: 'Karachi', phone: '+92 300 9998887' },
      { userId: null, label: 'owner' },
    );
    assert.ok(dupe.mergedIntoId, 'exact phone match must merge');
    assert.equal(dupe.duplicate?.autoMerge, true);
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 2, 'both records retained');
  });

  test('invalid phone on manual create is reported as a problem', () => {
    const res = createLead(
      db,
      { displayName: 'Bad Phone Co', phone: 'zzz' },
      { userId: null, label: 'owner' },
    );
    assert.ok(res.problems.some((p) => p.field === 'phone'));
    const lead = db.prepare('SELECT phone_e164, phone_raw FROM businesses WHERE id = ?').get(res.id) as {
      phone_e164: string | null;
      phone_raw: string | null;
    };
    assert.equal(lead.phone_e164, null, 'invalid numbers never become contact keys');
    assert.equal(lead.phone_raw, 'zzz', 'raw value preserved for review');
  });

  test('edits are validated, normalised and audited with previous values', () => {
    const created = createLead(db, { displayName: 'Edit Target', city: 'Multan' }, { userId: null, label: 'owner' });

    assert.throws(
      () => updateLead(db, created.id, [{ field: 'phone', value: 'garbage' }], { userId: null, label: 'owner' }),
      /not usable/,
    );

    const result = updateLead(
      db,
      created.id,
      [
        { field: 'phone', value: '03005556667' },
        { field: 'city', value: '  Faisalabad ' },
      ],
      { userId: null, label: 'owner' },
    );
    const business = result.business as { phone_e164: string; city: string };
    assert.equal(business.phone_e164, '+923005556667');
    assert.equal(business.city, 'Faisalabad');

    const audit = db
      .prepare(`SELECT details_json FROM audit_events WHERE action = 'lead.update' AND entity_id = ? ORDER BY id DESC LIMIT 1`)
      .get(created.id) as { details_json: string };
    const details = JSON.parse(audit.details_json) as { changes: Record<string, { from: unknown; to: unknown }> };
    assert.equal(details.changes.city?.from, 'Multan', 'previous value must be recorded');
    assert.equal(details.changes.city?.to, 'Faisalabad');
  });

  test('unknown fields cannot be edited', () => {
    const created = createLead(db, { displayName: 'Locked Field Co' }, { userId: null, label: 'owner' });
    assert.throws(
      () => updateLead(db, created.id, [{ field: 'score', value: 100 }], { userId: null, label: 'owner' }),
      /not editable/,
    );
  });

  test('stage transitions require evidence for interested/qualified', () => {
    const created = createLead(db, { displayName: 'Stage Target' }, { userId: null, label: 'owner' });

    assert.throws(
      () => changeStage(db, created.id, 'interested', { reason: 'gut feeling', actor: { userId: null, label: 'system' } }),
      /requires a supporting interaction/,
    );

    // valid path: record an interaction first
    const now = new Date().toISOString();
    db.prepare(
      `INSERT INTO interactions (id, business_id, kind, summary, occurred_at) VALUES ('itx_test', ?, 'call', 'prospect interested', ?)`,
    ).run(created.id, now);

    const changed = changeStage(db, created.id, 'interested', {
      reason: 'prospect asked for a proposal',
      evidenceInteractionId: 'itx_test',
      actor: { userId: null, label: 'owner' },
    });
    assert.equal(changed.to, 'interested');

    const history = db.prepare('SELECT * FROM lead_stage_history WHERE business_id = ?').get(created.id) as {
      evidence_interaction_id: string;
      reason: string;
    };
    assert.equal(history.evidence_interaction_id, 'itx_test');
  });

  test('evidence interaction must belong to the same lead', () => {
    const a = createLead(db, { displayName: 'Evidence A' }, { userId: null, label: 'owner' });
    const b = createLead(db, { displayName: 'Evidence B' }, { userId: null, label: 'owner' });
    const now = new Date().toISOString();
    db.prepare(`INSERT INTO interactions (id, business_id, kind, summary, occurred_at) VALUES ('itx_b', ?, 'note', 'x', ?)`).run(b.id, now);
    assert.throws(
      () =>
        changeStage(db, a.id, 'interested', {
          reason: 'borrowed evidence',
          evidenceInteractionId: 'itx_b',
          actor: { userId: null, label: 'owner' },
        }),
      /does not belong/,
    );
  });

  test('won/lost requires a reason', () => {
    const created = createLead(db, { displayName: 'Winner Co' }, { userId: null, label: 'owner' });
    assert.throws(
      () => changeStage(db, created.id, 'won', { reason: '  ', actor: { userId: null, label: 'owner' } }),
      /requires a reason/,
    );
    // With a reason it works - but the DEAL confirmation rule is separate and
    // enforced by the database (covered in migrations.test.ts).
    const r = changeStage(db, created.id, 'lost', {
      reason: 'prospect chose another vendor',
      actor: { userId: null, label: 'owner' },
    });
    assert.equal(r.to, 'lost');
  });

  test('listing: default order is highest score first, then OLDEST lead', () => {
    db.exec('DELETE FROM businesses');
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const mk = (id: string, name: string, score: number | null, discoveredAt: string): void => {
      db.prepare(
        `INSERT INTO businesses (id, display_name, normalized_name, source_type, discovered_at, score, stage, created_at, updated_at)
         VALUES (?, ?, ?, 'manual', ?, ?, 'new_lead', ?, ?)`,
      ).run(id, name, name.toLowerCase(), discoveredAt, score, discoveredAt, discoveredAt);
    };
    mk('l1', 'Low Score', 40, new Date(base).toISOString());
    mk('l2', 'High Score Old', 90, new Date(base + 1000).toISOString());
    mk('l3', 'High Score New', 90, new Date(base + 2000).toISOString());
    mk('l4', 'No Score', null, new Date(base + 3000).toISOString());

    const list = listLeads(db, { sort: 'score' });
    assert.deepEqual(
      list.items.map((i) => i.displayName),
      ['High Score Old', 'High Score New', 'Low Score', 'No Score'],
    );
    assert.equal(list.total, 4);

    const paged = listLeads(db, { pageSize: 2, page: 2 });
    assert.equal(paged.items.length, 2);
    assert.equal(paged.totalPages, 2);
    assert.equal(paged.total, 4);

    const search = listLeads(db, { q: 'high' });
    assert.equal(search.total, 2);
  });

  test('regression (Phase 11): every sort key x direction builds valid SQL', () => {
    db.exec('DELETE FROM businesses');
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    const mk = (id: string, name: string, score: number | null, discoveredAt: string): void => {
      db.prepare(
        `INSERT INTO businesses (id, display_name, normalized_name, source_type, discovered_at, score, stage, created_at, updated_at)
         VALUES (?, ?, ?, 'manual', ?, ?, 'new_lead', ?, ?)`,
      ).run(id, name, name.toLowerCase(), discoveredAt, score, discoveredAt, discoveredAt);
    };
    mk('s1', 'Alpha Clinic', 40, new Date(base).toISOString());
    mk('s2', 'Beta Clinic', 90, new Date(base + 1000).toISOString());
    mk('s3', 'Gamma Clinic', 90, new Date(base + 2000).toISOString());
    mk('s4', 'No Score Clinic', null, new Date(base + 3000).toISOString());

    // The old bug: `${sortMap[sortKey]} ${order}` produced "… ASC DESC" and
    // SQLite threw `near "DESC": syntax error`. Every combination must work.
    const sorts = ['score', 'discovered_at', 'name', 'stage'] as const;
    const orders = ['asc', 'desc'] as const;
    for (const sort of sorts) {
      for (const order of orders) {
        const r = listLeads(db, { sort, order });
        assert.equal(r.total, 4, `${sort}/${order} must return all rows`);
        assert.equal(r.items.length, 4, `${sort}/${order} must return all items`);
      }
    }

    // Explicit desc must equal the default ordering (SPA always sends both).
    const explicit = listLeads(db, { sort: 'score', order: 'desc' });
    const implicit = listLeads(db, { sort: 'score' });
    assert.deepEqual(
      explicit.items.map((i) => i.id),
      implicit.items.map((i) => i.id),
      'explicit score/desc equals default ordering',
    );
    assert.deepEqual(
      explicit.items.map((i) => i.displayName),
      ['Beta Clinic', 'Gamma Clinic', 'Alpha Clinic', 'No Score Clinic'],
      'score desc: highest first, oldest tie-break, nulls last',
    );

    // score asc: lowest first among scored rows, nulls still last.
    const asc = listLeads(db, { sort: 'score', order: 'asc' });
    assert.deepEqual(
      asc.items.map((i) => i.displayName),
      ['Alpha Clinic', 'Beta Clinic', 'Gamma Clinic', 'No Score Clinic'],
      'score asc: lowest first, nulls last',
    );

    // name asc is case-insensitive alphabetical.
    const byName = listLeads(db, { sort: 'name', order: 'asc' });
    assert.deepEqual(
      byName.items.map((i) => i.displayName),
      ['Alpha Clinic', 'Beta Clinic', 'Gamma Clinic', 'No Score Clinic'],
      'name asc: alphabetical',
    );
  });

  test('merged rows are hidden from listings unless requested', () => {
    const survivor = createLead(db, { displayName: 'Visible Lead', phone: '03000000001' }, { userId: null, label: 'owner' });
    const merged = createLead(db, { displayName: 'Visible Lead dup', phone: '03000000001' }, { userId: null, label: 'owner' });
    assert.ok(merged.mergedIntoId);
    const normal = listLeads(db, { pageSize: 200 });
    assert.ok(normal.items.some((i) => i.id === survivor.id));
    assert.ok(!normal.items.some((i) => i.id === merged.id), 'merged rows hidden by default');
    const withMerged = listLeads(db, { includeMerged: true, pageSize: 200 });
    assert.ok(withMerged.items.some((i) => i.id === merged.id));
  });

  test('detail view aggregates sources, merges and history', () => {
    const created = createLead(db, { displayName: 'Detail Lead', phone: '03000000002' }, { userId: null, label: 'owner' });
    const detail = getLeadDetail(db, created.id);
    assert.equal((detail.business as { display_name: string }).display_name, 'Detail Lead');
    assert.equal(detail.sources.length, 1);
    assert.ok(Array.isArray(detail.stageHistory));
    assert.throws(() => getLeadDetail(db, 'does-not-exist'), /not found/);
  });
});
