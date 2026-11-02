import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/core/config.ts';

const MIN: Record<string, string | undefined> = {
  NODE_ENV: 'test',
  SESSION_SECRET: 'x'.repeat(48),
};

describe('configuration', () => {
  test('provides safe defaults', () => {
    const cfg = loadConfig(MIN);
    assert.equal(cfg.operatingModeSeed, 'simulation', 'live mode is never the default');
    assert.equal(cfg.hardDailyCallLimit, 100, 'hard 100 calls/day ceiling');
    assert.equal(cfg.businessTimezone, 'Asia/Karachi');
    assert.equal(cfg.logRedact, true, 'PII redaction on by default');
    assert.equal(cfg.businessWebsite, 'https://www.universalwebsolutions.it.com');
  });

  test('rejects an invalid configuration with field-level messages', () => {
    assert.throws(
      () => loadConfig({ ...MIN, PORT: '99999' }),
      /Invalid environment configuration/,
    );
    assert.throws(() => loadConfig({ ...MIN, NODE_ENV: 'staging' }), /Invalid environment configuration/);
    assert.throws(() => loadConfig({ ...MIN, PUBLIC_BASE_URL: 'ftp://nope' }), /PUBLIC_BASE_URL/);
    assert.throws(() => loadConfig({ ...MIN, SESSION_SECRET: 'short' }), /at least 32/);
  });

  test('production requires an explicit session secret', () => {
    assert.throws(() => loadConfig({ NODE_ENV: 'production', DATABASE_PATH: ':memory:' }), /SESSION_SECRET/);
  });

  test('development without a secret gets an ephemeral one', () => {
    const cfg = loadConfig({ NODE_ENV: 'development' });
    assert.equal(cfg.ephemeralSessionSecret, true);
    assert.ok(cfg.sessionSecret.length >= 32);
  });

  test('provider status never exposes credential values', () => {
    const cfg = loadConfig({
      ...MIN,
      TELEPHONY_PROVIDER: 'twilio',
      TELEPHONY_ACCOUNT_SID: 'AC_secret_value_123',
      TELEPHONY_AUTH_TOKEN: 'super-secret-token',
      TELEPHONY_FROM_NUMBER: '+920000000000',
    });
    const serialized = JSON.stringify(cfg.providers);
    assert.ok(!serialized.includes('super-secret-token'), 'auth token must not appear');
    assert.ok(!serialized.includes('AC_secret_value_123'), 'account sid must not appear');
    const telephony = cfg.providers.find((p) => p.key === 'telephony');
    assert.equal(telephony?.state, 'configured');
    assert.deepEqual(telephony?.missing, []);
    assert.ok(telephony?.present.includes('TELEPHONY_AUTH_TOKEN'));
  });

  test('partial credentials are reported as partial, not configured', () => {
    const cfg = loadConfig({ ...MIN, TELEPHONY_PROVIDER: 'twilio', TELEPHONY_ACCOUNT_SID: 'AC1' });
    const telephony = cfg.providers.find((p) => p.key === 'telephony');
    assert.equal(telephony?.state, 'partial');
    assert.ok((telephony?.missing.length ?? 0) > 0);
  });

  test('speech state is honest: provider name + any valid key path', () => {
    const speechOf = (env: Record<string, string | undefined>) =>
      loadConfig({ ...MIN, ...env }).providers.find((p) => p.key === 'speech');

    // Fully configured via a dedicated speech key (named from STT_PROVIDER —
    // the generic SPEECH_PROVIDER var does not exist, so it must not be used).
    const dedicated = speechOf({ STT_PROVIDER: 'openai', STT_API_KEY: 'sk-test' });
    assert.equal(dedicated?.state, 'configured', 'dedicated key + provider name = configured');
    assert.deepEqual(dedicated?.missing, []);

    // Shared-key path: no speech key at all, but AI_API_KEY covers it
    // (same vendor/host) — must NOT be reported as `partial`.
    const shared = speechOf({ STT_PROVIDER: 'openai', AI_API_KEY: 'sk-platform' });
    assert.equal(shared?.state, 'configured', 'shared AI key is a valid speech credential');
    assert.deepEqual(shared?.missing, []);

    // Provider named but no key anywhere: honest `partial`, never configured.
    const noKey = speechOf({ STT_PROVIDER: 'openai' });
    assert.equal(noKey?.state, 'partial');
    assert.deepEqual(noKey?.missing, ['STT_API_KEY']);

    // Key present but no provider named: also `partial` (nothing selected it).
    const noProvider = speechOf({ STT_API_KEY: 'sk-test' });
    assert.equal(noProvider?.state, 'partial');
    assert.ok(noProvider?.missing.includes('STT_PROVIDER'));

    // Nothing at all: unconfigured.
    assert.equal(speechOf({})?.state, 'unconfigured');

    // No credential values ever leak into the report.
    const serialized = JSON.stringify(speechOf({ STT_PROVIDER: 'openai', STT_API_KEY: 'sk-super-secret' }));
    assert.ok(!serialized.includes('sk-super-secret'));
  });

  test('no provider is configured by default', () => {
    const cfg = loadConfig(MIN);
    for (const p of cfg.providers) {
      assert.equal(p.state, 'unconfigured', `${p.key} must start unconfigured`);
    }
  });

  // ------------------------------------------------------- Phase 12: discovery --

  test('Overpass discovery is configured with NO api key (free, keyless vendor)', () => {
    const cfg = loadConfig({ ...MIN, DISCOVERY_PROVIDER: 'overpass' });
    const discovery = cfg.providers.find((p) => p.key === 'discovery');
    assert.equal(discovery?.state, 'configured', 'keyless provider must not be reported partial');
    assert.deepEqual(discovery?.missing, []);
    assert.ok(
      discovery?.features.some((f) => /free/i.test(f)),
      'the free/no-key nature is advertised honestly',
    );
  });

  test('a keyed discovery provider still requires its API key', () => {
    const cfg = loadConfig({ ...MIN, DISCOVERY_PROVIDER: 'somevendor' });
    const discovery = cfg.providers.find((p) => p.key === 'discovery');
    assert.equal(discovery?.state, 'partial', 'keyed vendors still need DISCOVERY_API_KEY');
    assert.ok(discovery?.missing.includes('DISCOVERY_API_KEY'));
  });

  test('the optional Overpass endpoint override never leaks into provider status', () => {
    const cfg = loadConfig({
      ...MIN,
      DISCOVERY_PROVIDER: 'overpass',
      DISCOVERY_OVERPASS_URL: 'https://overpass.example.de/api/interpreter',
    });
    const discovery = cfg.providers.find((p) => p.key === 'discovery');
    assert.equal(discovery?.state, 'configured');
    const serialized = JSON.stringify(cfg.providers);
    assert.ok(!serialized.includes('overpass.example.de'), 'endpoint override stays out of provider status');
  });
});
