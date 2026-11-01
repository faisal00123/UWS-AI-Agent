/**
 * Phase 12 API tests: discovery status + run endpoints.
 *
 * Proves:
 *  - GET /api/discovery/status is auth-gated and honest (provider name,
 *    simulated flag, enabled flag, policy summary — no secrets);
 *  - POST /api/discovery/run is auth + CSRF gated, owner AND staff (same
 *    posture as CSV import — research on public data contacts no customer),
 *    validates its body, honours the integration toggle (403) and reports an
 *    unconfigured provider as an honest 503 instead of fabricating leads;
 *  - mock-provider runs work end-to-end and announce simulated: true.
 *
 * The server runs with mock adapters (zero network).
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createUser } from '../../src/domain/auth/service.ts';

interface StatusBody {
  provider: string | null;
  state: string;
  simulated: boolean;
  enabled: boolean;
  policy: { categories: string[]; cities: string[]; maxPerRun: number; autoAnalyze: boolean; autoScore: boolean };
}
interface RunBody {
  run: {
    provider: string;
    simulated: boolean;
    hits: number;
    created: number;
    pendingReview: number;
    merged: number;
    skipped: number;
    cityResults: { city: string; hits: number; error: string | null }[];
  };
}
interface ErrorBody {
  error: { code: string; message: string };
}

const MOCK_ENV = { DISCOVERY_PROVIDER: 'mock' };

describe('Phase 12 API: discovery', () => {
  let server: TestServer;
  let owner: TestClient;
  let staff: TestClient;

  before(async () => {
    server = await startTestServer(MOCK_ENV);
    const seeded = await seedOwner(server);
    owner = await loginAs(server, seeded.email, seeded.password);
    const staffEmail = `staff-12-${Date.now()}@uws.test`;
    await createUser(
      server.db,
      server.config,
      { email: staffEmail, password: 'Staff-Password-123!', displayName: 'Phase12 Staff', role: 'staff' },
      { userId: seeded.user.id, label: 'owner' },
    );
    staff = await loginAs(server, staffEmail, 'Staff-Password-123!');
  });

  after(async () => {
    await server.close();
  });

  test('GET /api/discovery/status is auth-gated and honest', async () => {
    const anon = server.client();
    assert.equal((await anon.get('/api/discovery/status')).status, 401);

    const res = await owner.get<StatusBody>('/api/discovery/status');
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.provider, 'mock');
    assert.equal(res.body.simulated, true, 'rehearsal provider announces itself');
    assert.equal(res.body.enabled, true);
    assert.ok(res.body.policy.categories.length > 0);
    assert.ok(res.body.policy.maxPerRun >= 1);
    assert.ok(!res.raw.includes('api_key'), 'no key material in the status payload');
  });

  test('POST /api/discovery/run requires auth and CSRF', async () => {
    const anon = server.client();
    assert.equal((await anon.post('/api/discovery/run', {})).status, 401);

    // Authenticated but no CSRF token: cross-site form posts must be refused.
    const saved = owner.csrfToken;
    owner.csrfToken = null;
    try {
      const res = await owner.post<ErrorBody>('/api/discovery/run', {});
      assert.equal(res.status, 403);
      assert.match(res.body.error.message, /CSRF/i);
    } finally {
      owner.csrfToken = saved;
    }
  });

  test('staff may run discovery (import posture) and the run is simulated', async () => {
    const res = await staff.post<RunBody>('/api/discovery/run', {
      categories: ['salon'],
      cities: ['Karachi'],
    });
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.run.provider, 'mock');
    assert.equal(res.body.run.simulated, true, 'mock runs are never presented as real');
    assert.ok(res.body.run.created >= 1, 'Sample Salon Studio matches "salon" in Karachi');
    assert.equal(res.body.run.cityResults[0]!.error, null);

    // The lead landed in the database with mock provenance.
    const lead = server.db
      .prepare(`SELECT display_name FROM businesses WHERE display_name = 'Sample Salon Studio'`)
      .get() as { display_name: string } | undefined;
    assert.ok(lead, 'the discovered lead was persisted');
  });

  test('the run body is validated', async () => {
    const tooMany = await owner.post<ErrorBody>('/api/discovery/run', {
      cities: Array.from({ length: 41 }, (_, i) => `City ${i}`),
    });
    assert.equal(tooMany.status, 400);
    assert.equal(tooMany.body.error.code, 'validation_failed');

    const blank = await owner.post<ErrorBody>('/api/discovery/run', { categories: [''] });
    assert.equal(blank.status, 400);
  });

  test('a disabled integration refuses the run with 403', async () => {
    server.db
      .prepare(
        `INSERT INTO settings (key, value_json, version, updated_by, updated_at)
         VALUES ('integration_toggles', ?, 1, NULL, '1970-01-01T00:00:00.000Z')
         ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(JSON.stringify({ discovery: false }));
    try {
      const res = await owner.post<ErrorBody>('/api/discovery/run', {});
      assert.equal(res.status, 403);
      assert.equal(res.body.error.code, 'blocked_by_safeguard');
    } finally {
      server.db.prepare(`DELETE FROM settings WHERE key = 'integration_toggles'`).run();
    }
  });

  test('an unconfigured provider is an honest 503 — no fabricated leads', async () => {
    const bare = await startTestServer({}); // no DISCOVERY_PROVIDER at all
    try {
      const seeded = await seedOwner(bare);
      const bareOwner = await loginAs(bare, seeded.email, seeded.password);
      const run = await bareOwner.post<ErrorBody>('/api/discovery/run', {});
      assert.equal(run.status, 503);
      assert.equal(run.body.error.code, 'provider_unavailable');
      assert.match(run.body.error.message, /DISCOVERY_PROVIDER/, 'the message says exactly how to fix it');
      const leads = bare.db.prepare('SELECT COUNT(*) c FROM businesses').get() as { c: number };
      assert.equal(leads.c, 0, 'nothing was invented');
      const status = await bareOwner.get<StatusBody>('/api/discovery/status');
      assert.equal(status.body.provider, null);
      assert.equal(status.body.state, 'unconfigured');
    } finally {
      await bare.close();
    }
  });
});
