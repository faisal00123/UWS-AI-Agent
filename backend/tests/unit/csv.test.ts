import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, sniffDelimiter, stripBom, mapByHeader } from '../../src/domain/leads/csv.ts';

describe('CSV parser (RFC 4180)', () => {
  test('parses simple rows', () => {
    const r = parseCsv('name,city\nKarachi Clinic,Karachi\nLahore Dhaba,Lahore\n');
    assert.equal(r.delimiter, ',');
    assert.equal(r.rows.length, 3);
    assert.deepEqual(r.rows[1]!.cells, ['Karachi Clinic', 'Karachi']);
    assert.equal(r.errors.length, 0);
  });

  test('handles quoted fields with commas, quotes and newlines', () => {
    const csv = 'name,notes\n"ABC, Inc.","He said ""hello""\nsecond line"';
    const r = parseCsv(csv);
    assert.equal(r.rows.length, 2);
    assert.equal(r.rows[1]!.cells[0], 'ABC, Inc.');
    assert.equal(r.rows[1]!.cells[1], 'He said "hello"\nsecond line');
    assert.equal(r.errors.length, 0);
  });

  test('handles CRLF and a trailing newline', () => {
    const r = parseCsv('a,b\r\n1,2\r\n');
    assert.equal(r.rows.length, 2);
    assert.deepEqual(r.rows[1]!.cells, ['1', '2']);
  });

  test('strips a UTF-8 BOM', () => {
    const { text, hadBom } = stripBom('\uFEFFname,city');
    assert.equal(hadBom, true);
    assert.equal(text, 'name,city');
    const r = parseCsv('\uFEFFname,city\nX,Y\n');
    assert.equal(r.hadBom, true);
    assert.equal(r.rows[0]!.cells[0], 'name');
  });

  test('sniffs semicolon and tab delimiters (Excel exports)', () => {
    assert.equal(sniffDelimiter('name;city'), ';');
    assert.equal(sniffDelimiter('name\tcity'), '\t');
    const r = parseCsv('name;city\nClinic;Karachi');
    assert.equal(r.delimiter, ';');
    assert.deepEqual(r.rows[1]!.cells, ['Clinic', 'Karachi']);
  });

  test('reports unterminated quotes instead of throwing', () => {
    const r = parseCsv('name,notes\n"broken, value');
    assert.ok(r.errors.some((e) => /Unterminated/.test(e.message)));
  });

  test('empty file yields an error, not a crash', () => {
    const r = parseCsv('');
    assert.ok(r.errors.some((e) => /no data rows/.test(e.message)));
  });

  test('skips blank lines inside the file', () => {
    const r = parseCsv('name,city\n\nClinic,Karachi\n');
    assert.equal(r.rows.length, 2);
  });

  test('mapByHeader requires the name column and reports what was found', () => {
    const r = parseCsv('sku;city\nClinic;Karachi');
    const mapped = mapByHeader(r, ['name']);
    assert.equal(mapped.records.length, 0);
    assert.ok(mapped.errors.some((e) => /Missing required column/.test(e.message)));
    assert.match(mapped.errors[0]!.message, /Found: sku, city/);
  });

  test('mapByHeader accepts known name aliases such as "Company"', () => {
    const r = parseCsv('Company,City\nClinic,Karachi');
    const mapped = mapByHeader(r, ['name']);
    assert.equal(mapped.errors.length, 0);
    assert.equal(mapped.records.length, 1);
    assert.equal(mapped.records[0]!.values['Company'], 'Clinic');
  });

  test('mapByHeader maps header variants case/space-insensitively', () => {
    const r = parseCsv('Business Name,City,Phone Number\n"ABC Clinic",Karachi,03001234567');
    const mapped = mapByHeader(r, ['name']);
    assert.equal(mapped.records.length, 1);
    assert.equal(mapped.records[0]!.values['Business Name'], 'ABC Clinic');
  });
});
