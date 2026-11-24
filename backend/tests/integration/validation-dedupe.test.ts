/**
 * Phase 5: validation & dedupe hardening.
 *
 * Proves:
 *  - SOURCE-RECORD IDENTITY: a record-unique source URL (last path segment
 *    is a number — OSM element permalinks, listing ids) shared by two live
 *    rows auto-merges with strategy `source_record`, even when the name and
 *    city differ (a re-imported/updated extract where the lower tiers
 *    cannot match). The survivor keeps its values; the conflict is preserved
 *    in merge_history, nothing is deleted.
 *  - Shared NON-record URLs (category/listing pages without an id) never
 *    drive an automatic merge — several businesses can legitimately share
 *    them — and different record ids are different records.
 *  - MACHINE MAILBOXES are rejected by every entry point: import warns and
 *    drops the value (with a FAILED field_verification explaining why), and
 *    manual/discovery creation reports the same problem instead of writing
 *    a dead-end address onto a lead.
 *  - A row whose only contact detail is unusable gets the honest
 *    "cannot be contacted yet" warning (usable-contact check, not raw
 *    presence).
 *  - Coordinate pairs: latitude without longitude (or vice versa) is
 *    flagged for review while the present value is kept — never silently
 *    half-geolocated.
 *  - Long addresses are truncated WITH a visible warning, never silently.
 */
import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase, type DB } from '../../src/db/index.ts';
import { runMigrations } from '../../src/db/migrate.ts';
import { loadConfig, type Config } from '../../src/core/config.ts';
import { importCsvText, type ImportMeta } from '../../src/domain/leads/import.ts';
import { createLead } from '../../src/domain/leads/repository.ts';

let db: DB;
let cfg: Config;

const META: ImportMeta = {
  sourceType: 'csv_import',
  sourceLabel: 'phase5.csv',
  sourceUrl: null,
  importedBy: { userId: null, label: 'system' },
};

function importCsv(csv: string): ReturnType<typeof importCsvText> {
  return importCsvText(db, cfg, csv, META);
}

function count(sql: string, ...params: unknown[]): number {
  return (db.prepare(sql).get(...(params as never[])) as { c: number }).c;
}

function businessByName(name: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM businesses WHERE display_name = ?').get(name) as Record<string, unknown> | undefined;
}

describe('Phase 5: validation & dedupe', () => {
  before(() => {
    cfg = loadConfig({
      NODE_ENV: 'test',
      SESSION_SECRET: 'test'.padEnd(48, '0'),
      DATABASE_PATH: ':memory:',
      LOG_LEVEL: 'silent',
    });
    db = openDatabase(':memory:');
    await runMigrations(db);
  });
  after(() => db.close());
  beforeEach(() => {
    db.exec(
      'DELETE FROM merge_history; DELETE FROM duplicate_candidates; DELETE FROM lead_sources; DELETE FROM interactions; DELETE FROM field_verifications;' +
        ' DELETE FROM businesses WHERE merged_into_id IS NOT NULL; DELETE FROM businesses;',
    );
  });

  // ------------------------------------------------------- source record ---

  test('same record-unique source URL auto-merges as source_record', () => {
    // Same OSM element re-imported from an updated extract: the name was
    // changed upstream, so name+city cannot match — only the element URL
    // identifies it as the same record.
    const first = importCsv(
      'Name,Phone,City,Source\n' +
        'Old Clinic Name,03001111111,,https://www.openstreetmap.org/node/777\n',
    );
    assert.equal(first.imported, 1, JSON.stringify(first.rows, null, 2));

    const second = importCsv(
      'Name,Phone,City,Source\n' +
        'Renamed Clinic,03002222222,,https://www.openstreetmap.org/node/777\n',
    );
    assert.equal(second.merged, 1, 'same source record must merge, not clone');
    assert.equal(second.imported, 0);

    const live = count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL');
    assert.equal(live, 1, 'one live lead for one source record');
    assert.equal(count('SELECT COUNT(*) c FROM businesses'), 2, 'merged row retained, never deleted');

    const survivor = businessByName('Old Clinic Name');
    assert.ok(survivor, 'the survivor keeps its values on conflict');
    const mergedRow = businessByName('Renamed Clinic');
    assert.ok(mergedRow);
    assert.equal(mergedRow.merged_into_id, survivor.id);

    const merge = db.prepare('SELECT * FROM merge_history WHERE survivor_id = ?').get(String(survivor.id)) as {
      strategy: string;
      match_score: number;
      overridden_values_json: string;
    };
    assert.equal(merge.strategy, 'source_record', 'the strategy names the real rule that fired');
    assert.equal(merge.match_score, 0.98);
    const overridden = JSON.parse(merge.overridden_values_json) as Record<string, { survivor: string; incoming: string }>;
    assert.equal(overridden.display_name?.survivor, 'Old Clinic Name');
    assert.equal(overridden.display_name?.incoming, 'Renamed Clinic', 'conflicting values preserved, not dropped');

    assert.equal(count(`SELECT COUNT(*) c FROM duplicate_candidates WHERE status = 'merged' AND auto_merged = 1`), 1);
    assert.equal(count(`SELECT COUNT(*) c FROM audit_events WHERE action = 'lead.merge'`), 1);
  });

  test('a shared listing URL (no record id) never auto-merges', () => {
    // /listings has no numeric record id: several different businesses can
    // live on one page, so sharing it proves nothing about identity.
    const summary = importCsv(
      'Name,City,Phone,Source\n' +
        'Alpha Traders,Karachi,03001111111,https://directory.example/listings\n' +
        'Beta Goods,Lahore,03002222222,https://directory.example/listings\n',
    );
    assert.equal(summary.merged, 0, 'a shared page must not merge distinct rows');
    assert.equal(summary.imported, 2, JSON.stringify(summary.rows, null, 2));
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL'), 2);
  });

  test('different record ids on the same host are different records', () => {
    importCsv('Name,Phone,Source\nSeven Clinic,03001111111,https://www.openstreetmap.org/node/777\n');
    const summary = importCsv('Name,Phone,Source\nZebra Motors,03002222222,https://www.openstreetmap.org/node/778\n');
    assert.equal(summary.merged, 0, 'node/778 is not node/777');
    assert.equal(count('SELECT COUNT(*) c FROM businesses WHERE merged_into_id IS NULL'), 2);
  });

  // ------------------------------------------------------ machine mailbox ---

  test('import rejects a machine mailbox: warned, dropped, evidence recorded', () => {
    const summary = importCsv(
      'Name,City,Email,Phone\n' +
        'Auto Reply Clinic,Karachi,noreply@clinic.pk,03001111111\n',
    );
    const row = summary.rows.find((r) => r.candidate?.displayName === 'Auto Reply Clinic');
    assert.ok(row, 'row analyzed');
    assert.ok(
      row.problems.some((p) => p.field === 'email' && /automated mailbox/.test(p.message)),
      `machine mailbox is reported: ${JSON.stringify(row.problems)}`,
    );
    assert.equal(row.status, 'needs_review', 'a dropped contact detail needs review');
    assert.equal(row.candidate?.email, null, 'the dead-end address is never applied');

    const stored = businessByName('Auto Reply Clinic');
    assert.ok(stored);
    assert.equal(stored.email, null, 'nothing unusable is written to the lead');

    // The observed-but-rejected value is traceable: FAILED verification with
    // the real reason, so "no email" is not mistaken for "no email seen".
    const fv = db
      .prepare(`SELECT state, evidence FROM field_verifications WHERE business_id = ? AND field = 'email'`)
      .get(String(stored.id)) as { state: string; evidence: string } | undefined;
    assert.ok(fv, 'the rejected value is recorded');
    assert.equal(fv.state, 'failed');
    assert.match(fv.evidence, /automated mailbox/);
  });

  test('a row whose only contact is a machine mailbox is honestly uncontactable', () => {
    const summary = importCsv('Name,Email\nLonely Clinic,noreply@lonely.pk\n');
    const row = summary.rows[0]!;
    assert.ok(
      row.problems.some((p) => p.field === 'contact' && /cannot be contacted/.test(p.message)),
      `usable-contact warning fires: ${JSON.stringify(row.problems)}`,
    );
    assert.equal(row.status, 'needs_review');
  });

  test('createLead (manual/discovery) rejects a machine mailbox too', () => {
    const result = createLead(
      db,
      { displayName: 'Manual Noreply Clinic', city: 'Karachi', email: 'no-reply@manual.pk' },
      { userId: null, label: 'owner' },
    );
    assert.ok(
      result.problems.some((p) => p.field === 'email' && /automated mailbox/.test(p.message)),
      `reported to the caller: ${JSON.stringify(result.problems)}`,
    );
    const stored = businessByName('Manual Noreply Clinic');
    assert.ok(stored);
    assert.equal(stored.email, null, 'never written to the lead');

    // A normal address is unaffected by the guard.
    const ok = createLead(
      db,
      { displayName: 'Human Clinic', city: 'Karachi', email: 'reception@human.pk' },
      { userId: null, label: 'owner' },
    );
    assert.deepEqual(ok.problems, []);
    assert.equal(businessByName('Human Clinic')?.email, 'reception@human.pk');
  });

  // ------------------------------------------------------ coordinate pair ---

  test('latitude without longitude is flagged, the value itself is kept', () => {
    const summary = importCsv('Name,City,Phone,Lat\nHalf Pairs Clinic,Karachi,03001111111,24.9167\n');
    const row = summary.rows[0]!;
    assert.ok(
      row.problems.some((p) => p.field === 'longitude' && /pair incomplete/.test(p.message)),
      `incomplete pair reported on the missing half: ${JSON.stringify(row.problems)}`,
    );
    assert.equal(row.status, 'needs_review', 'half a coordinate is incomplete evidence');

    const stored = businessByName('Half Pairs Clinic');
    assert.ok(stored);
    assert.equal(stored.latitude, 24.9167, 'the present value is still evidence');
    assert.equal(stored.longitude, null, 'no longitude invented');
  });

  test('a complete coordinate pair imports cleanly (no false positive)', () => {
    const summary = importCsv('Name,City,Phone,Lat,Lon\nFull Pair Clinic,Karachi,03001111111,24.9167,67.0666\n');
    assert.equal(summary.rows[0]!.status, 'imported', JSON.stringify(summary.rows[0]!.problems));
    assert.equal(businessByName('Full Pair Clinic')?.latitude, 24.9167);
  });

  // -------------------------------------------------------- address cap ----

  test('a long address is truncated WITH a warning, never silently', () => {
    const longAddress = 'Plot 123, Sector F-8, ' + 'Very Long Street Name, '.repeat(20);
    assert.ok(longAddress.length > 300, 'fixture exceeds the 300-char column cap');
    const summary = importCsv(`Name,City,Phone,Address\nTruncated Address Clinic,Karachi,03001111111,"${longAddress}"\n`);
    const row = summary.rows[0]!;
    assert.ok(
      row.problems.some((p) => p.field === 'address' && /truncated/.test(p.message)),
      `truncation is visible: ${JSON.stringify(row.problems)}`,
    );

    const stored = businessByName('Truncated Address Clinic');
    assert.ok(stored);
    assert.equal(String(stored.address).length, 300, 'stored value respects the cap');
    assert.ok(String(stored.address).startsWith('Plot 123'), 'leading content preserved');
  });
});
