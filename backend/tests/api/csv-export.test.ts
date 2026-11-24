/**
 * Phase 8: CSV export over HTTP.
 *
 *  - Access: owner and staff may export; anonymous is rejected (401).
 *  - Shape: text/csv attachment with a dated filename and a UTF-8 BOM
 *    (Excel opens it correctly; the import parser strips the BOM).
 *  - Content: every live lead, with address + coordinates written exactly
 *    as stored; absent values are empty cells.
 *  - Round trip: the downloaded file feeds straight back into the import
 *    PREVIEW endpoint with zero parse errors and the same row count — the
 *    export is a valid import file by construction.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { parseCsv, mapByHeader } from '../../src/domain/leads/csv.ts';

interface PreviewBody {
  totalRows: number;
  parseErrors: { line: number; message: string }[];
}

let server: TestServer;
let ownerClient: TestClient;
let staffClient: TestClient;
let anonymous: TestClient;

describe('Phase 8: CSV export', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@phase8.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);

    const { createUser } = await import('../../src/domain/auth/service.ts');
    await createUser(
      server.db,
      server.config,
      { email: 'staff@phase8.test', password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: seeded.user.id, label: 'owner' },
    );
    staffClient = await loginAs(server, 'staff@phase8.test', 'Staff-Password-123!');
    anonymous = server.client();
  });
  after(async () => {
    await server.close();
  });

  test('anonymous export is rejected', async () => {
    const res = await anonymous.get<unknown>('/api/leads/export');
    assert.equal(res.status, 401);
  });

  test('export is a dated CSV attachment with BOM and both leads', async () => {
    // One lead WITH address/coords, one WITHOUT — both must appear.
    const withCoords = await ownerClient.request<{ imported: number }>('/api/leads/import', {
      method: 'POST',
      rawBody:
        'Name,City,Address,Lat,Lon,Phone\n' +
        'Phase8 Geo Clinic,Karachi,"Plot 4, Block 7",24.9167,67.0666,03008881111\n',
    });
    assert.equal(withCoords.status, 200, withCoords.raw);
    const bare = await ownerClient.request<{ imported: number }>('/api/leads/import', {
      method: 'POST',
      rawBody: 'Name,City,Phone\nPhase8 Bare Clinic,Lahore,03008881112\n',
    });
    assert.equal(bare.status, 200, bare.raw);

    // BOM check at BYTE level: Response.text() strips a leading BOM per the
    // Fetch spec, so the decoded body can never prove it was there.
    const res = await fetch(`${server.url}/api/leads/export`, {
      headers: { cookie: ownerClient.cookieHeader, accept: 'text/csv' },
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') ?? '', /text\/csv/);
    assert.match(res.headers.get('content-disposition') ?? '', /attachment; filename="leads-\d{4}-\d{2}-\d{2}\.csv"/);
    const bytes = new Uint8Array(await res.arrayBuffer());
    assert.deepEqual([...bytes.slice(0, 3)], [0xef, 0xbb, 0xbf], 'UTF-8 BOM for Excel');
    // decode with ignoreBOM (a constructor option) so the BOM survives into
    // the string below — the round trip must prove the import parser strips
    // it cleanly.
    const body = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    assert.ok(body.startsWith('\uFEFF'), 'BOM preserved for the round-trip check');

    const parsed = parseCsv(body);
    assert.deepEqual(parsed.errors, [], 'the export parses as CSV');
    const mapped = mapByHeader(parsed, ['name']);
    assert.deepEqual(mapped.errors, [], 'and as an import file');

    const byName = new Map(mapped.records.map((r) => [r.values['Name'], r.values]));
    assert.equal(mapped.records.length, 2, 'every live lead exported, merged rows excluded');

    const geo = byName.get('Phase8 Geo Clinic');
    assert.ok(geo, 'lead with coordinates present');
    assert.equal(geo['Address'], 'Plot 4, Block 7');
    assert.equal(geo['Lat'], '24.9167');
    assert.equal(geo['Lon'], '67.0666');
    assert.equal(geo['Phone'], '+923008881111');

    const bareRow = byName.get('Phase8 Bare Clinic');
    assert.ok(bareRow, 'lead without address present');
    assert.equal(bareRow['Address'], '', 'absent address is an empty cell, not a placeholder');
    assert.equal(bareRow['Lat'], '');
    assert.equal(bareRow['Lon'], '');
  });

  test('staff may export (same read permission as the leads list)', async () => {
    const res = await staffClient.get<string>('/api/leads/export');
    assert.equal(res.status, 200, res.raw.slice(0, 200));
    assert.ok(res.raw.includes('Phase8 Geo Clinic'), 'staff sees the same data');
  });

  test('the exported file feeds straight back into the import preview', async () => {
    const res = await fetch(`${server.url}/api/leads/export`, {
      headers: { cookie: ownerClient.cookieHeader },
    });
    assert.equal(res.status, 200);
    const bytes = new Uint8Array(await res.arrayBuffer());
    // BOM intact (constructor-level ignoreBOM): the preview must strip it
    // (stripBom) and still parse.
    const bodyWithBom = new TextDecoder('utf-8', { ignoreBOM: true }).decode(bytes);
    assert.ok(bodyWithBom.startsWith('\uFEFF'));

    const preview = await ownerClient.request<PreviewBody>('/api/leads/import/preview', {
      method: 'POST',
      rawBody: bodyWithBom,
    });
    assert.equal(preview.status, 200, preview.raw.slice(0, 300));
    assert.deepEqual(preview.body.parseErrors ?? [], [], 'round trip parses without errors');
    assert.equal(preview.body.totalRows, 2, 'same row count came back');
    // Nothing persisted by the preview itself (read-only by contract).
    const list = await ownerClient.get<{ total: number }>('/api/leads?pageSize=1');
    assert.equal(list.body.total, 2, 'preview never writes');
  });
});
