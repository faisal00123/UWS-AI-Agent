/**
 * Phase 11A API tests: integrations dashboard + test-connection + toggles.
 *
 * Verifies:
 *  - GET /api/integrations returns the extended shape (adapters, health,
 *    usage, toggles, portfolioTemplate, emailQueue, resilience, speechDefaults)
 *    and NEVER leaks a secret;
 *  - POST /api/integrations/:key/test runs the free probe, requires owner +
 *    CSRF, rejects an unknown key, and persists a health record;
 *  - the enable/disable toggle flow: disabling an integration makes its
 *    adapter report 'disabled' and its test-connection honest (no network).
 *
 * The server is built with mock adapters (env *_PROVIDER=mock) so no test can
 * ever reach a real provider.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createUser } from '../../src/domain/auth/service.ts';

interface IntegrationsBody {
  adapters: { key: string; state: string; implementation: string | null; simulated?: boolean }[];
  credentialPresence: { key: string; present: string[]; missing: string[] }[];
  health: Record<string, { ok: boolean; state: string; detail: string | null } | null>;
  usage: { integration: string; total: number }[];
  toggles: Record<string, boolean>;
  portfolioTemplate: { name: string; language: string } | null;
  emailQueue: { pending: number; failed: number; sent: number };
  resilience: { retryAttempts: number; ratePerMinute: number };
  speechDefaults: { language: string; voiceConfigured: boolean };
}

describe('integrations API (Phase 11A)', () => {
  let server: TestServer;
  let owner: TestClient;
  let staff: TestClient;

  before(async () => {
    server = await startTestServer({
      // Mock providers: deterministic, zero network.
      TELEPHONY_PROVIDER: 'mock',
      WHATSAPP_PROVIDER: 'mock',
      AI_PROVIDER: 'mock',
      STT_PROVIDER: 'mock',
      TTS_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'mock',
      DISCOVERY_PROVIDER: 'mock',
    });
    const seeded = await seedOwner(server);
    owner = await loginAs(server, seeded.email, seeded.password);
    // A staff user for RBAC checks.
    const staffEmail = `staff-${Date.now()}@uws.test`;
    await createUser(
      server.db,
      server.config,
      { email: staffEmail, password: 'Staff-Password-123!', displayName: 'Test Staff', role: 'staff' },
      { userId: seeded.user.id, label: 'owner' },
    );
    staff = await loginAs(server, staffEmail, 'Staff-Password-123!');
  });

  after(async () => {
    await server.close();
  });

  test('GET /api/integrations requires authentication', async () => {
    const anon = server.client();
    const res = await anon.get('/api/integrations');
    assert.equal(res.status, 401);
  });

  test('GET returns the extended shape with all six integrations', async () => {
    const res = await owner.get<IntegrationsBody>('/api/integrations');
    assert.equal(res.status, 200);
    const b = res.body;
    assert.equal(b.adapters.length, 6);
    const keys = b.adapters.map((a) => a.key).sort();
    assert.deepEqual(keys, ['ai', 'discovery', 'email', 'speech', 'telephony', 'whatsapp']);
    // Mock adapters advertise themselves as simulated.
    const ai = b.adapters.find((a) => a.key === 'ai')!;
    assert.equal(ai.implementation, 'mock');
    assert.equal(ai.simulated, true);
    assert.equal(ai.state, 'configured');
    // Defaults: every integration enabled.
    assert.equal(b.toggles['telephony'], true);
    assert.equal(b.toggles['discovery'], true);
    // Resilience + speech defaults are reported (non-secret).
    assert.ok(b.resilience.retryAttempts >= 1);
    assert.ok(b.resilience.ratePerMinute >= 1);
    assert.equal(b.speechDefaults.language, 'en');
    // Email queue shape exists (zeros on a fresh db).
    assert.ok(typeof b.emailQueue.pending === 'number');
    // Usage summary starts empty.
    assert.deepEqual(b.usage, []);
  });

  test('response NEVER contains a secret value', async () => {
    const res = await owner.get('/api/integrations');
    const raw = res.raw;
    // No credential-shaped strings from env vars should ever appear. The
    // test env sets no real secrets, but the assertion guards the SHAPE:
    // credentialPresence lists env-var NAMES only.
    const body = res.body as IntegrationsBody;
    for (const p of body.credentialPresence) {
      for (const name of p.present) {
        assert.ok(/^[A-Z0-9_]+$/.test(name), `present entry should be a VAR NAME: ${name}`);
      }
    }
    assert.ok(!raw.includes('access_token'), 'must not echo token values');
    assert.ok(!raw.includes('TELEPHONY_AUTH_TOKEN:'), 'must not echo token assignments');
  });

  test('POST test-connection requires CSRF', async () => {
    const res = await owner.request('/api/integrations/ai/test', { method: 'POST', body: {}, csrf: false });
    assert.equal(res.status, 403);
  });

  test('POST test-connection runs the free probe and persists a health record', async () => {
    const res = await owner.post<{ result: { ok: boolean; state: string; detail: string; integration: string } }>(
      '/api/integrations/ai/test',
      {},
    );
    assert.equal(res.status, 200);
    const r = res.body.result;
    assert.equal(r.integration, 'ai');
    assert.equal(r.ok, true);
    assert.equal(r.state, 'configured');
    assert.match(r.detail, /simulated/); // mock probe is honest about being simulated

    // The result is now the persisted "last health check".
    const after2 = await owner.get<IntegrationsBody>('/api/integrations');
    const health = after2.body.health['ai'];
    assert.ok(health, 'health record persisted');
    assert.equal(health!.ok, true);
    assert.ok(health!.detail);
  });

  test('POST test-connection records usage for the ping', async () => {
    await owner.post('/api/integrations/speech/test', {});
    const res = await owner.get<IntegrationsBody>('/api/integrations');
    const usage = res.body.usage.find((u) => u.integration === 'speech');
    assert.ok(usage, 'speech usage recorded');
    assert.ok(usage!.total >= 1);
  });

  test('POST test-connection rejects an unknown integration key', async () => {
    const res = await owner.post('/api/integrations/teleport/test', {});
    assert.equal(res.status, 400);
  });

  test('staff cannot run test-connection (owner only)', async () => {
    const res = await staff.post('/api/integrations/ai/test', {});
    assert.equal(res.status, 403);
  });

  test('disabling an integration flips its status and its probe to disabled', async () => {
    // Turn OFF telephony via the settings endpoint (non-sensitive => no reauth).
    const upd = await owner.put('/api/settings', {
      updates: {
        integration_toggles: {
          telephony: false,
          whatsapp: true,
          ai: true,
          speech: true,
          email: true,
          discovery: true,
        },
      },
    });
    assert.equal(upd.status, 200);

    // Adapter status now reports disabled.
    const list = await owner.get<IntegrationsBody>('/api/integrations');
    const tel = list.body.adapters.find((a) => a.key === 'telephony')!;
    assert.equal(tel.state, 'disabled');
    assert.equal(list.body.toggles['telephony'], false);

    // Probe is honest: disabled, ok=false, NO network.
    const probe = await owner.post<{ result: { ok: boolean; state: string; detail: string } }>(
      '/api/integrations/telephony/test',
      {},
    );
    assert.equal(probe.status, 200);
    assert.equal(probe.body.result.ok, false);
    assert.equal(probe.body.result.state, 'disabled');

    // Usage captured the refused operation as 'disabled'.
    const after2 = await owner.get<IntegrationsBody>('/api/integrations');
    const telUsage = after2.body.usage.find((u) => u.integration === 'telephony');
    assert.ok(telUsage, 'telephony usage recorded');
  });

  test('re-enabling restores the configured state', async () => {
    const upd = await owner.put('/api/settings', {
      updates: {
        integration_toggles: {
          telephony: true,
          whatsapp: true,
          ai: true,
          speech: true,
          email: true,
          discovery: true,
        },
      },
    });
    assert.equal(upd.status, 200);
    const list = await owner.get<IntegrationsBody>('/api/integrations');
    const tel = list.body.adapters.find((a) => a.key === 'telephony')!;
    assert.equal(tel.state, 'configured');
  });

  test('an unconfigured integration probes as unconfigured with no network', async () => {
    // Fresh server with NO providers configured.
    const bare = await startTestServer({});
    try {
      const seeded = await seedOwner(bare);
      const c = await loginAs(bare, seeded.email, seeded.password);
      const list = await c.get<IntegrationsBody>('/api/integrations');
      assert.equal(list.body.adapters.length, 6);
      assert.ok(list.body.adapters.every((a) => a.state === 'unconfigured'));

      const probe = await c.post<{ result: { ok: boolean; state: string } }>('/api/integrations/whatsapp/test', {});
      assert.equal(probe.status, 200);
      assert.equal(probe.body.result.ok, false);
      assert.equal(probe.body.result.state, 'unconfigured');
    } finally {
      await bare.close();
    }
  });
});
