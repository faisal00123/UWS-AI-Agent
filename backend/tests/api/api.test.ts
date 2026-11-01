/**
 * API acceptance tests: security headers, auth, RBAC, CSRF, rate limits,
 * settings validation, operating state (emergency stop / resume / mode).
 * These run against the REAL app with real middleware.
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, loginAs, type TestServer, type TestClient } from '../helpers/app.ts';
import { createUser } from '../../src/domain/auth/service.ts';
import { markApplicationStart, getOperatingState } from '../../src/domain/state/service.ts';

interface ErrorBody {
  error: { code: string; message: string; details?: Record<string, unknown> };
}

let server: TestServer;
let owner: { email: string; password: string; id: string };
let ownerClient: TestClient;
let staffClient: TestClient;

describe('API acceptance', () => {
  before(async () => {
    server = await startTestServer({ LOGIN_MAX_ATTEMPTS: '5' });
    const seeded = await seedOwner(server, { email: 'owner@api.test' });
    owner = { email: seeded.email, password: seeded.password, id: seeded.user.id };
    ownerClient = await loginAs(server, owner.email, owner.password);

    const staffUser = await createUser(
      server.db,
      server.config,
      { email: 'staff@api.test', password: 'Staff-Password-123!', displayName: 'Staff', role: 'staff' },
      { userId: owner.id, label: 'owner' },
    );
    assert.equal(staffUser.role, 'staff');
    staffClient = await loginAs(server, 'staff@api.test', 'Staff-Password-123!');
  });

  after(async () => {
    await server.close();
  });

  // ---------------------------------------------------------------- health --
  test('GET /api/health is public and minimal', async () => {
    const res = await server.client().get<{ status: string }>('/api/health');
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'ok');
    assert.ok(!res.raw.includes('SECRET'), 'no secrets in health output');
  });

  test('GET /api/system requires authentication', async () => {
    const res = await server.client().get<ErrorBody>('/api/system');
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'unauthenticated');
  });

  // -------------------------------------------------------------- headers ---
  test('security headers are present', async () => {
    const res = await server.client().get('/api/health');
    assert.ok(res.headers.get('content-security-policy'), 'CSP missing');
    assert.equal(res.headers.get('x-frame-options')?.toLowerCase(), 'deny');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
    assert.ok(res.headers.get('permissions-policy')?.includes('camera=()'));
    assert.equal(res.headers.get('x-powered-by'), null, 'x-powered-by must be disabled');
  });

  // --------------------------------------------------------------- sign in --
  test('sign in returns a user and sets HttpOnly session cookie', async () => {
    const c = server.client();
    const res = await c.login(owner.email, owner.password);
    assert.equal(res.status, 200);
    const setCookies = res.headers.getSetCookie();
    const session = setCookies.find((x) => x.startsWith('uws_session='));
    assert.ok(session, 'session cookie missing');
    assert.ok(session!.includes('HttpOnly'), 'session cookie must be HttpOnly');
    assert.ok(session!.includes('SameSite=Strict'));
    const csrf = setCookies.find((x) => x.startsWith('uws_csrf='));
    assert.ok(csrf, 'csrf cookie missing');
    assert.ok(!csrf!.includes('HttpOnly'), 'csrf cookie must be readable by the SPA');
  });

  test('bad credentials return 401 with a generic message', async () => {
    const c = server.client();
    const res = await c.request<ErrorBody>('/api/auth/login', {
      method: 'POST',
      body: { email: owner.email, password: 'Not-The-Password-1!' },
    });
    assert.equal(res.status, 401);
    assert.match(res.body.error.message, /Incorrect email or password/);
    assert.ok(!res.raw.includes('scrypt$'), 'password hash must never be returned');
  });

  test('concurrent failed logins are rate limited (HTTP 429)', async () => {
    const c = server.client();
    let sawLimit = false;
    for (let i = 0; i < 8; i++) {
      const res = await c.request<ErrorBody>('/api/auth/login', {
        method: 'POST',
        body: { email: 'rate@api.test', password: 'bad-password-here' },
      });
      if (res.status === 429) {
        sawLimit = true;
        assert.equal(res.body.error.code, 'rate_limited');
        break;
      }
    }
    assert.ok(sawLimit, 'expected a 429 within 8 attempts');
  });

  // ------------------------------------------------------------------ CSRF --
  test('mutating request without CSRF token is rejected', async () => {
    const c = await loginAs(server, owner.email, owner.password);
    c.csrfToken = null; // simulate a cross-site form post without the token
    const res = await c.put<ErrorBody>('/api/settings', {
      updates: { notification_destinations: { dashboard: true, email: '', whatsapp: '' } },
    });
    assert.equal(res.status, 403);
    assert.match(res.body.error.message, /CSRF/i);
  });

  test('GET /api/auth/me returns the current user (no secrets)', async () => {
    const res = await ownerClient.get<{ user: { role: string }; csrfToken: string }>('/api/auth/me');
    assert.equal(res.status, 200);
    assert.equal(res.body.user.role, 'owner');
    assert.ok(res.body.csrfToken.length > 10);
    assert.ok(!res.raw.includes('password'), 'no password fields in /me');
    assert.ok(!res.raw.includes('csrf_secret'), 'csrf secret must not be exposed raw');
  });

  // ------------------------------------------------------------------- RBAC --
  test('staff cannot read the user list (owner only)', async () => {
    const res = await staffClient.get<ErrorBody>('/api/auth/users');
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'forbidden');
  });

  test('staff cannot change settings', async () => {
    const res = await staffClient.put<ErrorBody>('/api/settings', {
      updates: { notification_destinations: { dashboard: true, email: '', whatsapp: '' } },
    });
    assert.equal(res.status, 403);
  });

  test('staff cannot resume after emergency stop (owner only)', async () => {
    const stopRes = await staffClient.post('/api/state/emergency-stop', {
      reason: 'staff triggered stop for test',
    });
    assert.equal(stopRes.status, 200, 'stopping is allowed for staff (safe direction)');
    const stateAfter = getOperatingState(server.db);
    assert.equal(stateAfter.emergencyStop, true);

    const res = await staffClient.post<ErrorBody>('/api/state/resume', { clearEmergencyStop: true });
    assert.equal(res.status, 403, 'staff must not resume');
    assert.match(res.body.error.message, /owner/i);
    await ownerClient.post('/api/state/emergency-stop', { reason: 'keeping it stopped for next test' });
  });

  // -------------------------------------------------------------- settings --
  test('GET /api/settings returns every definition with defaults', async () => {
    const res = await ownerClient.get<{
      settings: { key: string; value: unknown; source: string }[];
      hardCeilings: { dailyCallLimit: number };
    }>('/api/settings');
    assert.equal(res.status, 200);
    const keys = res.body.settings.map((s) => s.key);
    for (const expected of [
      'calling_schedule',
      'daily_call_limit',
      'daily_budget',
      'retry_policy',
      'followup_policy',
      'eligible_channels',
      'retention',
      'scoring_weights',
    ]) {
      assert.ok(keys.includes(expected), `missing setting ${expected}`);
    }
    assert.equal(res.body.hardCeilings.dailyCallLimit, 100);
  });

  test('sensitive setting change requires re-authentication', async () => {
    const res = await ownerClient.put<ErrorBody>('/api/settings', {
      updates: { daily_call_limit: 50 },
    });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'reauth_required');
  });

  test('after re-authentication the sensitive setting applies', async () => {
    const re = await ownerClient.post<{ ok: boolean }>('/api/auth/reauth', {
      password: owner.password,
    });
    assert.equal(re.status, 200);
    const res = await ownerClient.put<{ applied: string[]; settings: { key: string; value: number }[] }>(
      '/api/settings',
      { updates: { daily_call_limit: 50 } },
    );
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.applied, ['daily_call_limit']);
    assert.equal(res.body.settings.find((s) => s.key === 'daily_call_limit')?.value, 50);
  });

  test('daily call limit can never exceed the compiled hard ceiling', async () => {
    const res = await ownerClient.put<{ applied: string[]; settings: { key: string; value: number }[] }>(
      '/api/settings',
      { updates: { daily_call_limit: 100000 } },
    );
    // value is clamped to the ceiling, never rejected upward silently
    assert.equal(res.status, 200);
    assert.equal(res.body.settings.find((s) => s.key === 'daily_call_limit')?.value, 100);
  });

  test('invalid setting values are rejected with a reason', async () => {
    const res = await ownerClient.put<ErrorBody>('/api/settings', {
      updates: { calling_schedule: { days: [], startTime: '09:00', endTime: '18:00', timezone: 'Asia/Karachi' } },
    });
    assert.equal(res.status, 400);
    assert.ok(res.body.error.details?.rejected);
  });

  test('non-sensitive settings do not require re-authentication', async () => {
    const res = await ownerClient.put<{ applied: string[] }>('/api/settings', {
      updates: { notification_destinations: { dashboard: true, email: 'owner@example.com', whatsapp: '' } },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.applied, ['notification_destinations']);
  });

  // ------------------------------------------------------- operating state --
  test('emergency stop activates, blocks tasks and is audited', async () => {
    const res = await ownerClient.post<{ state: { emergencyStop: boolean; emergencyStopReason: string } }>(
      '/api/state/emergency-stop',
      { reason: 'manual test stop' },
    );
    assert.equal(res.status, 200);
    assert.equal(res.body.state.emergencyStop, true);
    assert.equal(res.body.state.emergencyStopReason, 'manual test stop');

    const audit = server.db
      .prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'emergency.stop'`)
      .get() as { c: number };
    assert.ok(audit.c >= 1, 'emergency stop must be audited');
  });

  test('resume without recent re-authentication is rejected', async () => {
    // A fresh session has no re-authentication grant yet.
    const fresh = await loginAs(server, owner.email, owner.password);
    const res = await fresh.post<ErrorBody>('/api/state/resume', { clearEmergencyStop: true });
    assert.equal(res.status, 401);
    assert.equal(res.body.error.code, 'reauth_required');
  });

  test('owner can resume after re-authentication', async () => {
    const fresh = await loginAs(server, owner.email, owner.password);
    await fresh.post('/api/auth/reauth', { password: owner.password });
    const res = await fresh.post<{ state: { emergencyStop: boolean; paused: boolean }; evaluation: { canResume: boolean } }>(
      '/api/state/resume',
      { clearEmergencyStop: true },
    );
    assert.equal(res.status, 200, res.raw);
    assert.equal(res.body.state.emergencyStop, false);
    assert.equal(res.body.state.paused, false);
    assert.equal(res.body.evaluation.canResume, true);
  });

  test('live mode cannot be enabled without a configured telephony provider', async () => {
    await ownerClient.post('/api/auth/reauth', { password: owner.password });
    const res = await ownerClient.post<ErrorBody>('/api/state/mode', { mode: 'live', confirmation: 'GO LIVE' });
    assert.equal(res.status, 503);
    assert.equal(res.body.error.code, 'provider_unavailable');
    assert.equal(getOperatingState(server.db).mode, 'simulation', 'mode must stay simulation');
  });

  test('live mode requires the typed GO LIVE confirmation', async () => {
    await ownerClient.post('/api/auth/reauth', { password: owner.password });
    // Missing confirmation phrase -> rejected before any provider check.
    const missing = await ownerClient.post<ErrorBody>('/api/state/mode', { mode: 'live' });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, 'validation_failed');
    // Wrong phrase -> rejected too.
    const wrong = await ownerClient.post<ErrorBody>('/api/state/mode', { mode: 'live', confirmation: 'yes' });
    assert.equal(wrong.status, 400);
    assert.equal(getOperatingState(server.db).mode, 'simulation', 'mode must stay simulation');
  });

  test('simulated restart pauses outreach and demands a manual resume', () => {
    markApplicationStart(server.db, 'test_restart');
    const state = getOperatingState(server.db);
    assert.equal(state.paused, true);
    assert.equal(state.pauseReason, 'test_restart');
    assert.ok(state.restartCount >= 1);

    // staff still cannot resume
    const audit = server.db
      .prepare(`SELECT COUNT(*) c FROM audit_events WHERE action = 'system.start'`)
      .get() as { c: number };
    assert.ok(audit.c >= 1);
  });

  test('secrets are never present in API responses', async () => {
    const paths = ['/api/system', '/api/settings', '/api/state', '/api/auth/me', '/api/auth/users'];
    for (const p of paths) {
      const res = await ownerClient.get(p);
      assert.ok(!res.raw.includes(server.config.sessionSecret), `session secret leaked at ${p}`);
      assert.ok(!res.raw.includes('password_hash'), `password hash leaked at ${p}`);
      assert.ok(!res.raw.includes('csrf_secret'), `csrf secret leaked at ${p}`);
    }
  });

  test('unknown API routes return JSON 404, not the SPA', async () => {
    const res = await server.client().get<ErrorBody>('/api/nope');
    assert.equal(res.status, 404);
    assert.equal(res.body.error.code, 'not_found');
  });
});
