/**
 * API acceptance tests for Phase 10 additions:
 *
 *  1. `GET /api/followups` — the cross-lead follow-up board (read-only,
 *     owner+staff) that the dashboard's Pipeline screen is built on.
 *  2. `DELETE /api/settings/:key` — reset a stored override to its
 *     compiled-in default (owner-only, CSRF-protected, and a fresh
 *     re-authentication for sensitive settings).
 *
 * Both were added to back specific dashboard affordances; these tests pin the
 * exact behaviour the UI relies on so a regression fails here rather than as a
 * blank table in the browser.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}
interface LeadRef {
  id: string;
}
interface TaskRef {
  id: string;
  status: string;
}
interface BoardBody {
  items: {
    id: string;
    businessId: string;
    title: string;
    type: string;
    status: string;
    scheduledFor: string;
  }[];
}
interface SettingsBody {
  settings: { key: string; value: unknown; source: string }[];
}

let server: TestServer;
let owner: { email: string; password: string };
let ownerClient: TestClient;
let staffClient: TestClient;
let anonymous: TestClient;
let seq = 0;

async function makeLead(name: string): Promise<string> {
  const n = seq++;
  const res = await ownerClient.post<LeadRef>('/api/leads', {
    displayName: `${name} ${n}`,
    city: 'Lahore',
    phone: `0321${String(3000000 + n).slice(-7)}`,
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

async function makeTask(bizId: string, title: string): Promise<string> {
  const res = await ownerClient.post<TaskRef>(`/api/leads/${bizId}/followups`, {
    type: 'callback',
    title,
    scheduledFor: '2026-11-02T06:00:00.000Z', // Mon 11:00 PKT — inside the window
  });
  assert.equal(res.status, 201, res.raw);
  return res.body.id;
}

describe('phase 10 API', () => {
  before(async () => {
    server = await startTestServer();
    const seeded = await seedOwner(server, { email: 'owner@phase10.test' });
    owner = { email: seeded.email, password: seeded.password };
    ownerClient = await loginAs(server, owner.email, owner.password);
    const staffRes = await ownerClient.post<{ user: { id: string; email: string } }>('/api/auth/users', {
      email: 'staff@phase10.test',
      displayName: 'Staff Member',
      password: 'Staff-Passw0rd!',
      role: 'staff',
    });
    assert.equal(staffRes.status, 201, staffRes.raw);
    staffClient = await loginAs(server, 'staff@phase10.test', 'Staff-Passw0rd!');
    anonymous = server.client();
  });
  after(async () => {
    await server.close();
  });

  // ------------------------------------------------------ follow-up board --
  test('the global board requires authentication', async () => {
    const res = await anonymous.get<ErrorBody>('/api/followups');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthenticated');
  });

  test('the owner sees every scheduled task across all leads', async () => {
    const bizA = await makeLead('Board Co A');
    const bizB = await makeLead('Board Co B');
    await makeTask(bizA, 'First touch call');
    await makeTask(bizB, 'Portfolio send');

    const res = await ownerClient.get<BoardBody>('/api/followups?limit=200');
    assert.equal(res.status, 200, res.raw);
    assert.ok(Array.isArray(res.body.items), 'board always returns an items array');
    const ids = res.body.items.map((t) => t.id);
    assert.ok(res.body.items.some((t) => t.businessId === bizA), 'task for lead A is on the board');
    assert.ok(res.body.items.some((t) => t.businessId === bizB), 'task for lead B is on the board');
    // Every item carries the fields the pipeline table renders.
    for (const t of res.body.items) {
      assert.equal(typeof t.id, 'string');
      assert.equal(typeof t.businessId, 'string');
      assert.equal(typeof t.title, 'string');
      assert.equal(typeof t.status, 'string');
      assert.ok(t.scheduledFor, 'each row has a scheduledFor timestamp');
    }
    assert.equal(new Set(ids).size, ids.length, 'no duplicate rows');
  });

  test('staff may read the board (owner+staff surface)', async () => {
    const res = await staffClient.get<BoardBody>('/api/followups?limit=200');
    assert.equal(res.status, 200, res.raw);
    assert.ok(res.body.items.length > 0, 'staff see the same tasks the owner seeded');
  });

  test('the board can be filtered by status', async () => {
    const all = await ownerClient.get<BoardBody>('/api/followups?limit=500');
    assert.equal(all.status, 200);
    const completed = all.body.items.filter((t) => t.status === 'completed');
    if (completed.length > 0) {
      const res = await ownerClient.get<BoardBody>('/api/followups?status=completed&limit=200');
      assert.equal(res.status, 200);
      for (const t of res.body.items) assert.equal(t.status, 'completed');
      assert.equal(res.body.items.length, completed.length);
    }
    // An impossible status is rejected rather than silently ignored.
    const bad = await anonymous.get<ErrorBody>('/api/followups?status=not_a_status');
    assert.equal(bad.status, 401, 'auth is checked first');
  });

  test('an invalid status filter is rejected for an authenticated caller', async () => {
    const res = await ownerClient.get<ErrorBody>('/api/followups?status=not_a_status');
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'validation_failed');
  });

  // ------------------------------------------------------- settings reset --
  test('resetting a setting requires authentication', async () => {
    const res = await anonymous.request<ErrorBody>('/api/settings/daily_call_limit', { method: 'DELETE' });
    assert.equal(res.status, 401);
  });

  test('staff cannot reset settings (owner only)', async () => {
    const res = await staffClient.request<ErrorBody>('/api/settings/daily_call_limit', { method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  test('a DELETE without the CSRF token is rejected', async () => {
    const c = await loginAs(server, owner.email, owner.password);
    c.csrfToken = null;
    const res = await c.request<ErrorBody>('/api/settings/notification_destinations', { method: 'DELETE' });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /CSRF/i);
  });

  test('resetting an unknown key is a 404, not a crash', async () => {
    const res = await ownerClient.request<ErrorBody>('/api/settings/not_a_real_key', { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });

  test('resetting a key with no stored override is a harmless no-op', async () => {
    const before = await ownerClient.get<SettingsBody>('/api/settings');
    const def = before.body.settings.find((s) => s.key === 'notification_destinations');
    assert.ok(def);
    assert.equal(def!.source, 'default', 'nothing has been saved yet in this fresh DB');

    const res = await ownerClient.request<{ reset: boolean; settings: SettingsBody['settings'] }>(
      '/api/settings/notification_destinations',
      { method: 'DELETE' },
    );
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.reset, false, 'no override existed, so nothing was deleted');
  });

  test('a sensitive setting reset requires recent re-authentication', async () => {
    // Give the owner a non-default value first (needs reauth to write).
    await ownerClient.post('/api/auth/reauth', { password: owner.password });
    const set = await ownerClient.put<{ applied: string[] }>('/api/settings', {
      updates: { daily_call_limit: 42 },
    });
    assert.equal(set.status, 200, set.raw);

    // A brand-new session has no reauth grant, so the reset is refused.
    const fresh = await loginAs(server, owner.email, owner.password);
    const res = await fresh.request<ErrorBody>('/api/settings/daily_call_limit', { method: 'DELETE' });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'reauth_required');

    // The value is untouched by the refused reset.
    const check = await ownerClient.get<SettingsBody>('/api/settings');
    assert.equal(check.body.settings.find((s) => s.key === 'daily_call_limit')?.value, 42);
  });

  test('after re-authentication the owner resets a sensitive setting to default', async () => {
    // The previous test left daily_call_limit = 42 (a stored override). The
    // compiled-in default is Math.min(100, hardDailyCallLimit); in the test env
    // the hard ceiling is 100, so the default is 100.
    const fresh = await loginAs(server, owner.email, owner.password);
    await fresh.post('/api/auth/reauth', { password: owner.password });

    const before = await fresh.get<SettingsBody & { hardCeilings: { dailyCallLimit: number } }>(
      '/api/settings',
    );
    const overridden = before.body.settings.find((s) => s.key === 'daily_call_limit');
    assert.equal(overridden?.source, 'database', 'the prior test stored an override');
    assert.equal(overridden?.value, 42);
    const expectedDefault = Math.min(100, before.body.hardCeilings.dailyCallLimit);

    const res = await fresh.request<{ reset: boolean; settings: SettingsBody['settings'] }>(
      '/api/settings/daily_call_limit',
      { method: 'DELETE' },
    );
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.reset, true, 'the override was removed');

    const after = await fresh.get<SettingsBody>('/api/settings');
    const entry = after.body.settings.find((s) => s.key === 'daily_call_limit');
    assert.equal(entry?.source, 'default', 'back on the compiled-in default');
    assert.equal(entry?.value, expectedDefault, 'the override 42 is gone; the default applies');
  });

  test('a non-sensitive setting resets without re-authentication', async () => {
    await ownerClient.put('/api/settings', {
      updates: { notification_destinations: { dashboard: true, email: 'x@example.com', whatsapp: '' } },
    });
    const fresh = await loginAs(server, owner.email, owner.password);
    const res = await fresh.request<{ reset: boolean }>('/api/settings/notification_destinations', {
      method: 'DELETE',
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.reset, true);
    const check = await fresh.get<SettingsBody>('/api/settings');
    assert.equal(check.body.settings.find((s) => s.key === 'notification_destinations')?.source, 'default');
  });

  test('a reset is recorded in the audit trail', async () => {
    await ownerClient.post('/api/auth/reauth', { password: owner.password });
    await ownerClient.put('/api/settings', { updates: { daily_call_limit: 30 } });
    const res = await ownerClient.request<{ reset: boolean }>('/api/settings/daily_call_limit', {
      method: 'DELETE',
    });
    assert.equal(res.status, 200, res.raw);

    const audit = server.db
      .prepare(
        `SELECT COUNT(*) c FROM audit_events WHERE action = 'settings.reset' AND entity_id = 'daily_call_limit'`,
      )
      .get() as { c: number };
    assert.ok(audit.c >= 1, 'resetting a setting must be audited');
  });
});
