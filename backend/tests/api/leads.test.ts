/**
 * API acceptance tests for the leads module: import preview/commit, listing,
 * detail, edits, stage evidence, duplicate review, and access control.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createUser } from '../../src/domain/auth/service.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface ListBody {
  items: { id: string; displayName: string; stage: string; score: number | null }[];
  total: number;
  page: number;
  totalPages: number;
}

let server: TestServer;
let owner: { email: string; password: string };
let ownerClient: TestClient;
let staffClient: TestClient;
let anonymous: TestClient;

const CSV =
  'Business Name,City,Phone,Website,Category\n' +
  'Karachi Care Clinic,Karachi,03001234567,https://karachicare.pk,clinic\n' +
  'Lahore Bites,Lahore,+92 321 9876543,lahorebites.pk,restaurant\n';

describe('leads API', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@leads.test' });
    owner = { email: seeded.email, password: seeded.password };
    ownerClient = await loginAs(server, owner.email, owner.password);

    await createUser(
      server.db,
      server.config,
      { email: 'staff@leads.test', password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: seeded.user.id, label: 'owner' },
    );
    staffClient = await loginAs(server, 'staff@leads.test', 'Staff-Password-123!');
    anonymous = server.client();
  });
  after(async () => {
    await server.close();
  });

  test('leads require authentication', async () => {
    const res = await anonymous.get<ErrorBody>('/api/leads');
    assert.equal(res.status, 401);
  });

  test('CSV import preview does not persist anything', async () => {
    const res = await ownerClient.request<{ totalRows: number; committed: boolean; imported: number }>(
      '/api/leads/import/preview',
      { method: 'POST', rawBody: CSV, headers: { 'content-type': 'text/csv', 'x-import-filename': 'preview.csv' } },
    );
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.totalRows, 2);
    assert.equal(res.body.committed, false);
    const list = await ownerClient.get<ListBody>('/api/leads');
    assert.equal(list.body.total, 0, 'preview must not create leads');
  });

  test('CSV import commits leads and reports per-row outcomes', async () => {
    const res = await ownerClient.request<{
      committed: boolean;
      imported: number;
      rows: { status: string; name: string }[];
    }>('/api/leads/import', {
      method: 'POST',
      rawBody: CSV,
      headers: { 'content-type': 'text/csv', 'x-import-filename': 'leads.csv' },
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.committed, true);
    assert.equal(res.body.imported, 2);
    assert.ok(res.body.rows.every((r) => r.status === 'imported'));

    const list = await ownerClient.get<ListBody>('/api/leads');
    assert.equal(list.body.total, 2);
    assert.equal(list.body.items[0]?.displayName, 'Karachi Care Clinic', 'default order: best score, then oldest');
  });

  test('regression (Phase 11): dashboard sort+order+pagination params return 200', async () => {
    // Exact query string src/web/views/leads.js sends (sort + order always set).
    const queries = [
      '/api/leads?sort=score&order=desc&page=1&pageSize=25',
      '/api/leads?sort=score&order=asc',
      '/api/leads?sort=name&order=asc',
      '/api/leads?sort=name&order=desc',
      '/api/leads?sort=stage&order=asc',
      '/api/leads?sort=stage&order=desc',
      '/api/leads?sort=discovered_at&order=desc',
      '/api/leads?sort=discovered_at&order=asc',
    ];
    for (const qs of queries) {
      const res = await ownerClient.get<ListBody>(qs);
      assert.equal(res.status, 200, `${qs} -> ${res.status} ${res.raw}`);
      assert.ok(Array.isArray(res.body.items), `${qs} returns items array`);
      assert.equal(typeof res.body.total, 'number', `${qs} returns total`);
    }

    // Sorting + pagination combined (page size honoured).
    const paged = await ownerClient.get<ListBody>('/api/leads?sort=score&order=desc&page=1&pageSize=1');
    assert.equal(paged.status, 200, paged.raw);
    assert.equal(paged.body.items.length, 1, 'pageSize=1 respected');
    assert.equal(paged.body.page, 1);

    // Sorting + filtering combined (search still works alongside sort).
    const filtered = await ownerClient.get<ListBody>('/api/leads?q=karachi&sort=name&order=asc');
    assert.equal(filtered.status, 200, filtered.raw);
    assert.equal(filtered.body.total, 1, 'q filter still applies with sort');

    // Invalid sort/order values are rejected by validation, never reach SQL.
    const badSort = await ownerClient.get<ErrorBody>('/api/leads?sort=id;DROP+TABLE');
    assert.equal(badSort.status, 400, 'unknown sort key -> 400');
    const badOrder = await ownerClient.get<ErrorBody>('/api/leads?order=sideways');
    assert.equal(badOrder.status, 400, 'unknown order -> 400');

    // Anonymous access still rejected.
    const anon = await anonymous.get<ErrorBody>('/api/leads?sort=score&order=desc');
    assert.equal(anon.status, 401);
  });

  test('import without CSRF is rejected', async () => {
    const noCsrf = await loginAs(server, owner.email, owner.password);
    noCsrf.csrfToken = null;
    const res = await noCsrf.request<ErrorBody>('/api/leads/import', { method: 'POST', rawBody: CSV });
    assert.equal(res.status, 403);
  });

  test('staff may import leads (least privilege allows operation)', async () => {
    const res = await staffClient.request<{ imported: number }>('/api/leads/import', {
      method: 'POST',
      rawBody: 'name,city,phone\nStaff Added Lead,Quetta,03007776665\n',
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.imported, 1);
  });

  test('structurally invalid CSV returns 400 with an explanation', async () => {
    const res = await ownerClient.request<ErrorBody>('/api/leads/import', {
      method: 'POST',
      rawBody: 'city,phone\nKarachi,03001234567\n',
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
    assert.match(res.body.error.message, /Missing required column: name/);
  });

  test('duplicate phone in a second import is merged, not duplicated', async () => {
    const res = await ownerClient.request<{ imported: number; merged: number }>('/api/leads/import', {
      method: 'POST',
      rawBody: 'name,city,phone\nKarachi Care Clinic Branch,Karachi,+923001234567\n',
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.merged, 1);
    assert.equal(res.body.imported, 0);

    const list = await ownerClient.get<ListBody>('/api/leads', );
    const names = list.body.items.map((i) => i.displayName);
    assert.ok(names.includes('Karachi Care Clinic'));
    assert.ok(!names.includes('Karachi Care Clinic Branch'), 'merged rows are hidden by default');
  });

  test('duplicate review queue lists pending matches with details', async () => {
    // fuzzy match: same city, very similar (typo'd) name, different phone
    await ownerClient.request('/api/leads/import', {
      method: 'POST',
      rawBody: 'name,city,phone\nLahore Bitez,Lahore,03009990001\n',
    });
    const res = await ownerClient.get<{ items: { match_score: number; name_a: string; name_b: string; status: string }[] }>(
      '/api/duplicates?status=pending',
    );
    assert.equal(res.status, 200);
    assert.ok(res.body.items.length >= 1, 'fuzzy match must be queued for review');
    assert.ok(res.body.items[0]!.match_score < 1, 'only uncertain matches are queued');
    assert.equal(res.body.items[0]!.status, 'pending');
  });

  test('staff can resolve a duplicate decision', async () => {
    const pending = await ownerClient.get<{ items: { id: string }[] }>('/api/duplicates?status=pending');
    const id = pending.body.items[0]?.id;
    assert.ok(id, 'expected a pending duplicate');
    const res = await staffClient.post<{ ok: boolean; survivorId: string }>(`/api/duplicates/${id}/decision`, {
      decision: 'not_duplicate',
      note: 'different branch on another street',
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.ok, true);

    const after = await ownerClient.get<{ items: unknown[] }>('/api/duplicates?status=pending');
    assert.equal(after.body.items.length, 0);
  });

  test('unknown decision value is rejected', async () => {
    const res = await staffClient.post<ErrorBody>('/api/duplicates/does-not-exist/decision', {
      decision: 'delete_everything',
    });
    assert.equal(res.status, 400);
  });

  test('lead detail returns aggregated record without secrets', async () => {
    const list = await ownerClient.get<ListBody>('/api/leads?q=Karachi Care');
    const id = list.body.items[0]!.id;
    const res = await ownerClient.get<{
      business: { display_name: string; phone_e164: string };
      sources: unknown[];
      fieldVerifications: unknown[];
      audit: unknown[];
      suppression: unknown[];
    }>(`/api/leads/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.business.display_name, 'Karachi Care Clinic');
    assert.equal(res.body.business.phone_e164, '+923001234567');
    assert.ok(res.body.sources.length >= 1);
    assert.ok(res.body.audit.length >= 1, 'audit history exposed on detail');
    assert.deepEqual(res.body.suppression, [], 'no suppression by default');
    assert.ok(!res.raw.includes('password'), 'no credentials in detail payload');
  });

  test('field edits are validated, normalised and audited', async () => {
    const list = await ownerClient.get<ListBody>('/api/leads?q=Karachi Care');
    const id = list.body.items[0]!.id;

    const bad = await ownerClient.patch<ErrorBody>(`/api/leads/${id}`, {
      updates: [{ field: 'phone', value: 'not-a-number' }],
    });
    assert.equal(bad.status, 400);

    const good = await ownerClient.patch<{ changes: Record<string, { from: unknown; to: unknown }> }>(
      `/api/leads/${id}`,
      { updates: [{ field: 'city', value: 'Karachi South' }] },
    );
    assert.equal(good.status, 200, good.raw);
    assert.equal(good.body.changes.city?.from, 'Karachi');
    assert.equal(good.body.changes.city?.to, 'Karachi South');

    const detail = await ownerClient.get<{ audit: { action: string; summary: string }[] }>(`/api/leads/${id}`);
    assert.ok(detail.body.audit.some((a) => a.action === 'lead.update'), 'edit must be audited');
  });

  test('stage change to interested requires evidence', async () => {
    const list = await ownerClient.get<ListBody>('/api/leads?q=Lahore Bites');
    const id = list.body.items[0]!.id;

    const noEvidence = await ownerClient.post<ErrorBody>(`/api/leads/${id}/stage`, {
      toStage: 'interested',
      reason: 'they sounded keen',
    });
    assert.equal(noEvidence.status, 400);
    assert.match(noEvidence.body.error.message, /requires a supporting interaction/);

    // record the evidence interaction through the normal path later; for now
    // verify that an unknown evidence id is also rejected
    const bogus = await ownerClient.post<ErrorBody>(`/api/leads/${id}/stage`, {
      toStage: 'interested',
      reason: 'they sounded keen',
      evidenceInteractionId: 'itx_missing',
    });
    assert.equal(bogus.status, 400);
    assert.match(bogus.body.error.message, /does not belong/);
  });

  test('list filters: stage, score range, search and pagination', async () => {
    const search = await ownerClient.get<ListBody>('/api/leads?q=lahore');
    assert.ok(search.body.total >= 1);
    assert.ok(search.body.items.every((i) => i.displayName.toLowerCase().includes('lahore')));

    const staged = await ownerClient.get<ListBody>('/api/leads?stage=new_lead');
    assert.ok(staged.body.total >= 3);

    const paged = await ownerClient.get<ListBody>('/api/leads?pageSize=2&page=1');
    assert.equal(paged.body.items.length, 2);
    assert.ok(paged.body.totalPages >= 2);

    const invalid = await ownerClient.get<ErrorBody>('/api/leads?minScore=500');
    assert.equal(invalid.status, 400, 'query validation must reject out-of-range values');
  });

  test('manual lead creation enforces duplicate rules', async () => {
    const dupe = await ownerClient.post<{ mergedIntoId: string | null; duplicate: { autoMerge: boolean } | null }>(
      '/api/leads',
      { displayName: 'Karachi Care Clinic', city: 'Karachi', phone: '03001234567' },
    );
    assert.equal(dupe.status, 201, dupe.raw);
    assert.ok(dupe.body.mergedIntoId, 'same phone must merge');

    const invalid = await ownerClient.post<ErrorBody>('/api/leads', { displayName: '' });
    assert.equal(invalid.status, 400);
  });
});
