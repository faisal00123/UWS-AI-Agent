import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedOwner, type TestServer } from '../helpers/app.ts';
import {
  changePassword,
  createUser,
  destroyOtherSessions,
  hashToken,
  loadSession,
  login,
} from '../../src/domain/auth/service.ts';
import { sessionPurgeJob } from '../../src/jobs/sessions.ts';
import { summarise } from '../../src/domain/state/service.ts';
import { createLogger } from '../../src/core/logger.ts';

let server: TestServer;

describe('authentication service', () => {
  before(async () => {
    server = await startTestServer({ LOGIN_MAX_ATTEMPTS: '3' });
  });
  after(async () => {
    await server.close();
  });

  const ip = (n: number): string => `10.0.0.${n}`;

  test('owner can be created and signs in with the correct password', async () => {
    const owner = await seedOwner(server, { email: 'first@uws.test' });
    const res = await login(server.db, server.config, {
      email: owner.email,
      password: owner.password,
      ipHash: 'hash1',
      userAgent: 'test',
    });
    assert.equal(res.user.role, 'owner');
    assert.ok(res.session.token.length > 20);
    // raw token is never stored
    const stored = server.db.prepare('SELECT id FROM sessions').all() as { id: string }[];
    assert.ok(stored.every((r) => r.id !== res.session.token), 'raw session token must not be stored');
  });

  test('wrong password is rejected', async () => {
    const owner = await seedOwner(server, { email: 'second@uws.test' });
    await assert.rejects(
      () =>
        login(server.db, server.config, {
          email: owner.email,
          password: 'Wrong-Password-99!',
          ipHash: 'hash2',
          userAgent: null,
        }),
      /Incorrect email or password/,
    );
  });

  test('unknown account is rejected with the same generic error', async () => {
    await assert.rejects(
      () =>
        login(server.db, server.config, {
          email: 'nobody@uws.test',
          password: 'Whatever-12345!',
          ipHash: 'hash3',
          userAgent: null,
        }),
      /Incorrect email or password/,
    );
  });

  test('repeated failures trip the per-account rate limiter', async () => {
    const owner = await seedOwner(server, { email: 'brute@uws.test' });
    const attempt = (): Promise<unknown> =>
      login(server.db, server.config, {
        email: owner.email,
        password: 'nope-nope-nope',
        ipHash: 'hash4',
        userAgent: null,
      });
    // LOGIN_MAX_ATTEMPTS = 3 for this suite
    await assert.rejects(attempt, /Incorrect email or password/);
    await assert.rejects(attempt, /Incorrect email or password/);
    await assert.rejects(attempt, /Incorrect email or password/);
    await assert.rejects(attempt, /Too many failed sign-in attempts/, '4th attempt must be rate limited');
    // even with the CORRECT password the limiter still applies
    await assert.rejects(
      () =>
        login(server.db, server.config, {
          email: owner.email,
          password: owner.password,
          ipHash: 'hash4',
          userAgent: null,
        }),
      /Too many failed sign-in attempts/,
    );
  });

  test('failed attempts are recorded for audit', () => {
    const rows = server.db
      .prepare(`SELECT COUNT(*) c FROM login_attempts WHERE succeeded = 0`)
      .get() as { c: number };
    assert.ok(rows.c >= 5, 'failures must be recorded');
  });

  test('password change succeeds and revokes other sessions', async () => {
    const owner = await seedOwner(server, { email: 'change@uws.test' });
    const first = await login(server.db, server.config, {
      email: owner.email,
      password: owner.password,
      ipHash: 'h5',
      userAgent: null,
    });
    const second = await login(server.db, server.config, {
      email: owner.email,
      password: owner.password,
      ipHash: 'h6',
      userAgent: null,
    });

    const result = await changePassword(
      server.db,
      server.config,
      owner.user.id,
      owner.password,
      'Brand-New-Password-42!',
      null, // keep no prior session
    );
    assert.ok(result.revokedSessions >= 1, 'other sessions must be revoked');

    // old password no longer works
    await assert.rejects(() =>
      login(server.db, server.config, {
        email: owner.email,
        password: owner.password,
        ipHash: 'h7',
        userAgent: null,
      }),
    );
    // session created before the change is gone
    const stillValid = loadSession(server.db, first.session.token);
    // (first session is the one kept or revoked depending on keepSessionId; both
    // were created before the change and none is the current one -> revoked)
    assert.equal(stillValid, null, 'pre-change sessions must be invalid');
  });

  test('policy rejects weak new passwords', async () => {
    const owner = await seedOwner(server, { email: 'weak@uws.test' });
    await assert.rejects(
      () =>
        changePassword(server.db, server.config, owner.user.id, owner.password, 'short', null),
      /at least 12 characters/,
    );
  });

  test('duplicate email is rejected', async () => {
    const owner = await seedOwner(server, { email: 'dupe@uws.test' });
    assert.ok(owner.user.id);
    await assert.rejects(
      () =>
        createUser(
          server.db,
          server.config,
          { email: 'dupe@uws.test', password: 'Another-Password-1!', displayName: 'X', role: 'staff' },
          { userId: owner.user.id, label: 'owner' },
        ),
      /already exists/,
    );
  });

  test('staff accounts can only be created by an owner actor', async () => {
    await assert.rejects(
      () =>
        createUser(
          server.db,
          server.config,
          { email: 'x@uws.test', password: 'Another-Password-1!', displayName: 'X', role: 'staff' },
          { userId: null, label: 'system' },
        ),
      /Only the owner may create staff/,
    );
  });

  test('inactive account cannot load a session', async () => {
    const owner = await seedOwner(server, { email: 'inactive@uws.test' });
    const res = await login(server.db, server.config, {
      email: owner.email,
      password: owner.password,
      ipHash: 'h8',
      userAgent: null,
    });
    server.db.prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(owner.user.id);
    assert.equal(loadSession(server.db, res.session.token), null, 'deactivation kills sessions');
  });

  test('destroyOtherSessions keeps the current session only', async () => {
    const owner = await seedOwner(server, { email: 'multi@uws.test' });
    const a = await login(server.db, server.config, { email: owner.email, password: owner.password, ipHash: 'h9', userAgent: null });
    const b = await login(server.db, server.config, { email: owner.email, password: owner.password, ipHash: 'h9', userAgent: null });
    const revoked = destroyOtherSessions(server.db, owner.user.id, hashToken(b.session.token));
    assert.ok(revoked >= 1);
    assert.notEqual(loadSession(server.db, b.session.token), null, 'kept session survives');
    assert.equal(loadSession(server.db, a.session.token), null, 'other session revoked');
  });

  // ---- lockout hardening: no re-arm DoS, no account-existence oracle ----

  test('lockout rejections do not re-arm the rate-limit window', async () => {
    const owner = await seedOwner(server, { email: 'rearm@uws.test' });
    const attempt = (password: string): Promise<unknown> =>
      login(server.db, server.config, { email: owner.email, password, ipHash: 'h10', userAgent: null });

    // Burn the per-account budget (LOGIN_MAX_ATTEMPTS = 3 for this suite).
    for (let i = 0; i < 3; i++) {
      await assert.rejects(() => attempt('wrong-password-x'), /Incorrect email or password/);
    }
    // Spam while locked out: every rejection must still be RECORDED for the
    // audit trail...
    for (let i = 0; i < 5; i++) {
      await assert.rejects(() => attempt('wrong-password-x'), /Too many failed sign-in attempts/);
    }
    const recorded = server.db
      .prepare(`SELECT COUNT(*) c FROM login_attempts WHERE email = ? AND reason = 'rate_limited'`)
      .get(owner.email) as { c: number };
    assert.ok(recorded.c >= 5, 'rejections must be recorded for audit');

    // ...but must never COUNT towards the window: once the 3 genuine failures
    // age out, the account must be usable again even though 5 rejections
    // happened inside the window. (Before the fix those rows were counted,
    // so an attacker who knows the email could re-arm the window forever.)
    const aged = new Date(Date.now() - 16 * 60_000).toISOString();
    server.db
      .prepare(
        `UPDATE login_attempts SET created_at = ?
          WHERE email = ? AND succeeded = 0
            AND COALESCE(reason, '') NOT IN ('rate_limited', 'account_locked')`,
      )
      .run(aged, owner.email);

    const res = await login(server.db, server.config, {
      email: owner.email,
      password: owner.password,
      ipHash: 'h10',
      userAgent: null,
    });
    assert.equal(res.user.email, owner.email, 'expired window must allow the correct password again');
  });

  test('a wrong password on a locked account is indistinguishable from a non-existent one', async () => {
    const owner = await seedOwner(server, { email: 'locked-oracle@uws.test' });
    server.db
      .prepare('UPDATE users SET locked_until = ? WHERE id = ?')
      .run(new Date(Date.now() + 10 * 60_000).toISOString(), owner.user.id);

    const messageOf = async (email: string, password: string): Promise<string> => {
      try {
        await login(server.db, server.config, { email, password, ipHash: 'h11', userAgent: null });
        return '(unexpected success)';
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    };

    const lockedMsg = await messageOf(owner.email, 'Wrong-Password-99!');
    const ghostMsg = await messageOf('ghost@uws.test', 'Wrong-Password-99!');
    assert.equal(lockedMsg, 'Incorrect email or password.');
    assert.equal(lockedMsg, ghostMsg, 'a lock must not reveal whether the account exists');
  });

  test('only the correct password learns when a lock expires, and spam cannot extend it', async () => {
    const owner = await seedOwner(server, { email: 'lock-expiry@uws.test' });
    const lockedUntil = new Date(Date.now() + 10 * 60_000).toISOString();
    server.db.prepare('UPDATE users SET locked_until = ? WHERE id = ?').run(lockedUntil, owner.user.id);

    for (let i = 0; i < 3; i++) {
      await assert.rejects(
        () => login(server.db, server.config, { email: owner.email, password: 'wrong-again-123', ipHash: 'h12', userAgent: null }),
        /Incorrect email or password/,
      );
    }
    const row = server.db.prepare('SELECT locked_until FROM users WHERE id = ?').get(owner.user.id) as {
      locked_until: string | null;
    };
    assert.equal(row.locked_until, lockedUntil, 'wrong-password spam must not push the lock further out');

    await assert.rejects(
      () => login(server.db, server.config, { email: owner.email, password: owner.password, ipHash: 'h12', userAgent: null }),
      /Too many failed sign-in attempts/,
      'the correct password is told when the lock expires',
    );
  });

  test('session_purge job deletes expired session rows but keeps live ones', async () => {
    const owner = await seedOwner(server, { email: 'purge@uws.test' });
    const creds = { email: owner.email, password: owner.password, ipHash: 'h13', userAgent: null };
    const keep = await login(server.db, server.config, creds);
    const drop = await login(server.db, server.config, creds);

    const expired = new Date(Date.now() - 60_000).toISOString();
    server.db
      .prepare('UPDATE sessions SET expires_at = ? WHERE id = ?')
      .run(expired, hashToken(drop.session.token));

    const result = await sessionPurgeJob.run({
      db: server.db,
      config: server.config,
      logger: createLogger('error', false),
      guard: summarise(server.db),
      now: new Date(),
    });
    const detail = (result as { detail?: string } | undefined)?.detail;

    assert.equal(loadSession(server.db, drop.session.token), null, 'expired session row must be deleted');
    assert.notEqual(loadSession(server.db, keep.session.token), null, 'live session must survive');
    assert.match(String(detail ?? ''), /expired session\(s\) purged/, 'the job reports what it removed');
  });
});
