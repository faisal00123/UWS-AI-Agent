/**
 * Phase 7: the dashboard surfaces the free-first fields end to end.
 *
 *  - The Leads board list items carry `address` (rendered under city/category)
 *    and it is `null` — never undefined or an empty string — when the source
 *    record had none: nothing is invented to fill the cell.
 *  - The lead detail exposes address + latitude + longitude from the raw
 *    business row (rendered in the Business record card, coordinates shown
 *    exactly as recorded).
 *  - Both come from one real CSV import through the HTTP API — the same path
 *    the dashboard's Import button uses.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';

interface ListItem {
  id: string;
  displayName: string;
  city: string | null;
  category: string | null;
  address: string | null;
}
interface ListBody {
  items: ListItem[];
  total: number;
}
interface DetailBody {
  business: Record<string, unknown>;
}

let server: TestServer;
let ownerClient: TestClient;

describe('Phase 7: dashboard fields (address + coordinates)', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@phase7.test' });
    ownerClient = await loginAs(server, seeded.email, seeded.password);
  });
  after(async () => {
    await server.close();
  });

  test('address + coordinates imported via CSV reach BOTH list and detail', async () => {
    const res = await ownerClient.request<{ imported: number }>('/api/leads/import', {
      method: 'POST',
      rawBody:
        'Name,City,Address,Lat,Lon,Phone\n' +
        'Phase7 Full Clinic,Karachi,"Block 7, Gulshan-e-Iqbal",24.9167,67.0666,03005551212\n',
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.imported, 1, 'row committed');

    const list = await ownerClient.get<ListBody>('/api/leads?q=Phase7');
    assert.equal(list.status, 200, list.raw);
    const item = list.body.items.find((i) => i.displayName === 'Phase7 Full Clinic');
    assert.ok(item, 'the lead is on the board');
    assert.equal(item.address, 'Block 7, Gulshan-e-Iqbal', 'address reaches the list row');

    const detail = await ownerClient.get<DetailBody>(`/api/leads/${encodeURIComponent(item.id)}`);
    assert.equal(detail.status, 200, detail.raw);
    assert.equal(detail.body.business.address, 'Block 7, Gulshan-e-Iqbal');
    assert.equal(detail.body.business.latitude, 24.9167, 'coordinate stored as evidence');
    assert.equal(detail.body.business.longitude, 67.0666);
  });

  test('a lead without address lists as null — nothing invented for the cell', async () => {
    const res = await ownerClient.request<{ imported: number }>('/api/leads/import', {
      method: 'POST',
      rawBody: 'Name,City,Phone\nPhase7 Bare Clinic,Lahore,03005551213\n',
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.imported, 1);

    const list = await ownerClient.get<ListBody>('/api/leads?q=Phase7');
    const item = list.body.items.find((i) => i.displayName === 'Phase7 Bare Clinic');
    assert.ok(item, 'the lead is on the board');
    assert.equal(item.address, null, 'absent address is an explicit null');
    assert.equal(item.city, 'Lahore', 'other fields unaffected');

    const detail = await ownerClient.get<DetailBody>(`/api/leads/${encodeURIComponent(item.id)}`);
    assert.equal(detail.body.business.address, null);
    assert.equal(detail.body.business.latitude, null, 'no coordinates invented');
    assert.equal(detail.body.business.longitude, null);
  });
});
