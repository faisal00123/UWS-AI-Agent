/**
 * Phase 8: the CSV export writer (pure — no database).
 *
 *  - Every editable column header resolves through the SHARED alias table,
 *    so an export → import round trip preserves the record (address and
 *    coordinates included).
 *  - Read-only bookkeeping columns (Stage, Score, …) resolve to nothing:
 *    the import mapper ignores them instead of fighting over derived fields.
 *  - RFC 4180 quoting: commas, quotes, newlines and edge spaces survive a
 *    write/read cycle byte-for-byte; absent values are empty cells, never
 *    placeholders like "null" or "—".
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { leadsToCsv, LEAD_EXPORT_HEADERS, parseCsv, mapByHeader } from '../../src/domain/leads/csv.ts';
import { headerMatchesField } from '../../src/domain/leads/headers.ts';

/** The logical fields the export must round-trip through import. */
const ROUND_TRIP: Record<string, string> = {
  Name: 'name',
  Category: 'category',
  City: 'city',
  Address: 'address',
  Lat: 'latitude',
  Lon: 'longitude',
  Website: 'website',
  Phone: 'phone',
  WhatsApp: 'whatsapp',
  Email: 'email',
  'Contact Person': 'contactPerson',
  Requirements: 'requirements',
  'Source URL': 'sourceUrl',
};

const READ_ONLY = ['Stage', 'Score', 'Interest Level', 'Duplicate Status', 'Source Type', 'Discovered'];

describe('CSV export writer', () => {
  test('every editable header resolves through the shared alias table', () => {
    const columns = LEAD_EXPORT_HEADERS as readonly string[];
    for (const [header, field] of Object.entries(ROUND_TRIP)) {
      assert.ok(headerMatchesField(header, field), `"${header}" must map to ${field}`);
      assert.ok(columns.includes(header), `"${header}" is an export column`);
    }
  });

  test('bookkeeping headers are ignored by the import mapper (not misread as data)', () => {
    const importable = Object.keys(ROUND_TRIP);
    const columns = LEAD_EXPORT_HEADERS as readonly string[];
    for (const header of READ_ONLY) {
      assert.ok(columns.includes(header), `"${header}" is an export column`);
      for (const field of importable) {
        assert.ok(!headerMatchesField(header, field), `"${header}" must NOT map to ${field}`);
      }
    }
  });

  test('quoting: commas, quotes, newlines and edge spaces survive the round trip', () => {
    const nasty = 'Plot 4, "Block" 7\nGulshan-e-Iqbal  ';
    const csv = leadsToCsv([
      {
        display_name: 'Comma, Clinic',
        category: 'clinic',
        city: 'Karachi',
        address: nasty,
        latitude: 24.9167,
        longitude: 67.0666,
        website_url: 'https://comma-clinic.pk',
        phone_e164: '+923001234567',
        whatsapp_e164: null,
        email: 'a@b.pk',
        contact_person_name: null,
        requirements: null,
        stage: 'new',
        score: 42.5,
        interest_level: 'unknown',
        duplicate_status: 'unique',
        source_type: 'csv_import',
        source_url: null,
        discovered_at: '2026-11-14T00:00:00.000Z',
      },
    ]);

    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.errors, [], 'the file parses cleanly');
    assert.equal(parsed.rows[1]!.cells[3], nasty, 'raw cells keep every byte: comma/quote/newline/space intact');
    const mapped = mapByHeader(parsed, ['name']);
    assert.deepEqual(mapped.errors, []);
    const row = mapped.records[0]!.values;

    assert.equal(row['Name'], 'Comma, Clinic');
    assert.equal(row['Address'], nasty.trim(), 'the mapper trims edge whitespace, as import always has');
    assert.equal(row['Lat'], '24.9167', 'coordinate written exactly as stored');
    assert.equal(row['Lon'], '67.0666');
    assert.equal(row['Phone'], '+923001234567');
    assert.equal(row['Email'], 'a@b.pk');
    assert.equal(row['Source URL'], '', 'absent value is an empty cell — never "null" or "—"');
    assert.equal(row['WhatsApp'], '');
    assert.equal(row['Requirements'], '');
  });

  test('header-only export (zero leads) is valid and round-trips', () => {
    const csv = leadsToCsv([]);
    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows.length, 1, 'just the header row');
    const mapped = mapByHeader(parsed, ['name']);
    assert.deepEqual(mapped.errors, [], 'still a valid import file');
    assert.equal(mapped.records.length, 0);
    assert.ok(csv.endsWith('\r\n'), 'RFC 4180 CRLF terminator');
  });
});

/**
 * H1 — CSV/formula injection: lead data is untrusted (OSM tags are publicly
 * editable), so a cell beginning with =, +, - or @ would be EVALUATED by
 * Excel/LibreOffice/Sheets when the export is opened. The writer neutralises
 * such cells with a leading apostrophe (the spreadsheet text marker) and the
 * parser strips it again, so the export → import round trip stays exact.
 */
describe('CSV export: formula-injection guard (H1)', () => {
  const MALICIOUS = [
    "=cmd|' /C calc'!A0",
    "+cmd|' /C calc'!A0",
    "-2+3+cmd|' /C calc'!A0",
    "@SUM(1+1)*cmd|' /C calc'!A0",
    '  =HYPERLINK("http://evil.example","click")', // whitespace before the marker
    '\t+danger', // control character before the marker
    '\u0001@danger',
  ];

  /** First cell of a single-line record (RFC 4180: quoted, "" = literal quote). */
  function firstCell(line: string): string {
    if (line.startsWith('"')) {
      let cell = '';
      for (let i = 1; i < line.length; i++) {
        if (line[i] === '"' && line[i + 1] === '"') {
          cell += '"';
          i++;
          continue;
        }
        if (line[i] === '"') break;
        cell += line[i]!;
      }
      return cell;
    }
    const comma = line.indexOf(',');
    return comma === -1 ? line : line.slice(0, comma);
  }

  function rowFor(name: string): Record<string, unknown> {
    return { display_name: name, city: 'Karachi', latitude: 24.9167, longitude: 67.0666 };
  }

  test('every formula-shaped value is neutralised in the written cell', () => {
    const csv = leadsToCsv(MALICIOUS.map(rowFor));
    const lines = csv.split('\r\n').filter((l) => l !== '');
    assert.equal(lines.length, MALICIOUS.length + 1, 'header + one line per row (no embedded newlines)');
    MALICIOUS.forEach((value, i) => {
      const cell = firstCell(lines[i + 1]!);
      // Security property: no cell may start (after whitespace/control
      // characters) with a spreadsheet formula marker.
      assert.ok(
        !/^[\u0000-\u0020\u007f]*[=+\-@]/.test(cell),
        `cell for ${JSON.stringify(value)} must not begin with a formula marker (got ${JSON.stringify(cell)})`,
      );
      assert.ok(cell.startsWith(`'`), `guard apostrophe present for ${JSON.stringify(value)}`);
    });
  });

  test('neutralised values round-trip back to the EXACT original bytes', () => {
    const csv = leadsToCsv(MALICIOUS.map(rowFor));
    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.errors, []);
    MALICIOUS.forEach((value, i) => {
      assert.equal(parsed.rows[i + 1]!.cells[0], value, `round trip of ${JSON.stringify(value)}`);
    });
  });

  test('ordinary values are untouched: names stay plain, phones/coords/negative numbers round-trip', () => {
    const rows = [
      rowFor('Karachi Dental Care'),
      { ...rowFor('Plus Phone Co'), phone_e164: '+923001234567' },
      { ...rowFor('Negative Coord Co'), latitude: -33.9, longitude: -70.6 },
      { ...rowFor('Comma Address Co'), address: 'Plot 4, Block 7' },
      { ...rowFor('Dash Notes Co'), requirements: '- looking for a new site' },
      { ...rowFor('Apostrophe Co'), requirements: "'tis the season" },
      { ...rowFor('Empty Co'), latitude: null, longitude: null, requirements: null },
    ];
    const csv = leadsToCsv(rows);
    const lines = csv.split('\r\n').filter((l) => l !== '');

    // Plain data carries NO guard apostrophe.
    assert.equal(firstCell(lines[1]!), 'Karachi Dental Care');
    // Phones legitimately start with '+': guarded in the file (so Excel shows
    // text instead of evaluating) but restored exactly on import.
    assert.ok(csv.includes("'+923001234567"), 'phone guarded in the raw file');
    assert.ok(!csv.includes(',+923001234567,'), 'phone never written unguarded');
    // Negative coordinates are guarded too, and round-trip unchanged.
    assert.ok(csv.includes("'-33.9"), 'negative latitude guarded in the raw file');
    assert.ok(!csv.includes(',-33.9'), 'negative latitude never written unguarded');

    const parsed = parseCsv(csv);
    assert.deepEqual(parsed.errors, []);
    const cells = parsed.rows.slice(1).map((r) => r.cells);
    assert.equal(cells[0]![0], 'Karachi Dental Care');
    assert.equal(cells[1]![7], '+923001234567');
    assert.equal(cells[2]![4], '-33.9');
    assert.equal(cells[2]![5], '-70.6');
    assert.equal(cells[3]![3], 'Plot 4, Block 7', 'comma address stays a normal quoted cell');
    assert.equal(cells[4]![11], '- looking for a new site', 'legitimate leading-dash text round-trips');
    assert.equal(cells[5]![11], "'tis the season", 'an apostrophe that is NOT a guard is kept');
    assert.equal(cells[6]![4], '', 'absent value is an empty cell');
    assert.equal(cells[6]![11], '');
  });

  test('documented edge: a value already starting with an apostrophe before a marker imports as the spreadsheet would show it', () => {
    // `'=literal` is how Excel DISPLAYS a guarded cell, so reading it back
    // yields `=literal` — consistent with what the file's author saw.
    const parsed = parseCsv("Name\r\n'=literal\r\n");
    assert.deepEqual(parsed.errors, []);
    assert.equal(parsed.rows[1]!.cells[0], '=literal');
  });
});
