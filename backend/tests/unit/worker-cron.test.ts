/**
 * Phase 11 tests: the Cloudflare backup-cron Worker.
 *
 * Determinism / isolation rules:
 *  - imports ONLY worker-logic.ts (pure, zero imports) — no Workers runtime,
 *    no network, no app code: classification/backoff decisions are tested
 *    with injected jitter so results are exact
 *  - the wrangler.toml / README checks are static file reads that guard
 *    against regressions in the deployment contract (secret never committed,
 *    cron schedule present, free-tier notes kept up to date)
 */
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MAX_ATTEMPTS,
  BASE_BACKOFF_MS,
  MAX_BACKOFF_MS,
  backoffDelayMs,
  buildAuthHeader,
  classifyError,
  classifyStatus,
  isRetryable,
  planAttempt,
  shouldRetry,
} from '../../deploy/cloudflare/worker-logic.ts';

const DEPLOY_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'cloudflare');

describe('worker: classifyStatus', () => {
  test('2xx is success', () => {
    assert.equal(classifyStatus(201), 'success');
    assert.equal(classifyStatus(200), 'success');
    assert.equal(classifyStatus(299), 'success');
  });

  test('401/403 are auth failures (never retried)', () => {
    assert.equal(classifyStatus(401), 'auth_failed');
    assert.equal(classifyStatus(403), 'auth_failed');
  });

  test('404 (no app secret) and 409 (backups disabled) are misconfiguration', () => {
    assert.equal(classifyStatus(404), 'misconfigured');
    assert.equal(classifyStatus(409), 'misconfigured');
  });

  test('429 and 5xx are transient', () => {
    assert.equal(classifyStatus(429), 'rate_limited');
    assert.equal(classifyStatus(500), 'server_error');
    assert.equal(classifyStatus(502), 'server_error');
    assert.equal(classifyStatus(503), 'server_error');
  });

  test('other 4xx are caller bugs (never retried)', () => {
    assert.equal(classifyStatus(400), 'unexpected');
    assert.equal(classifyStatus(422), 'unexpected');
    assert.equal(classifyStatus(418), 'unexpected');
  });
});

describe('worker: retry policy', () => {
  test('transport errors are transient', () => {
    assert.equal(classifyError(new Error('fetch failed')), 'network_error');
    assert.equal(classifyError(undefined), 'network_error');
  });

  test('only transient kinds are retryable', () => {
    assert.equal(isRetryable('rate_limited'), true);
    assert.equal(isRetryable('server_error'), true);
    assert.equal(isRetryable('network_error'), true);
    assert.equal(isRetryable('success'), false);
    assert.equal(isRetryable('auth_failed'), false);
    assert.equal(isRetryable('misconfigured'), false);
    assert.equal(isRetryable('unexpected'), false);
  });

  test('shouldRetry stops at MAX_ATTEMPTS and for permanent kinds', () => {
    assert.equal(shouldRetry('server_error', 1), true);
    assert.equal(shouldRetry('server_error', MAX_ATTEMPTS - 1), true);
    assert.equal(shouldRetry('server_error', MAX_ATTEMPTS), false);
    assert.equal(shouldRetry('server_error', MAX_ATTEMPTS + 5), false);
    assert.equal(shouldRetry('auth_failed', 1), false);
    assert.equal(shouldRetry('misconfigured', 1), false);
  });
});

describe('worker: backoff', () => {
  test('exponential with bounded jitter', () => {
    assert.equal(backoffDelayMs(1, 0), BASE_BACKOFF_MS);
    assert.equal(backoffDelayMs(1, 1), Math.round(BASE_BACKOFF_MS * 1.5));
    assert.equal(backoffDelayMs(2, 0), BASE_BACKOFF_MS * 2);
    assert.equal(backoffDelayMs(2, 1), Math.round(BASE_BACKOFF_MS * 2 * 1.5));
  });

  test('caps at MAX_BACKOFF_MS and clamps jitter input', () => {
    assert.equal(backoffDelayMs(50, 0), MAX_BACKOFF_MS);
    assert.equal(backoffDelayMs(50, 1), MAX_BACKOFF_MS);
    // rand outside 0..1 is clamped, never produces a wild delay
    assert.equal(backoffDelayMs(1, -5), BASE_BACKOFF_MS);
    assert.equal(backoffDelayMs(1, 99), Math.round(BASE_BACKOFF_MS * 1.5));
  });

  test('attempt 0/negative behaves like attempt 1', () => {
    assert.equal(backoffDelayMs(0, 0), BASE_BACKOFF_MS);
    assert.equal(backoffDelayMs(-3, 0), BASE_BACKOFF_MS);
  });
});

describe('worker: planAttempt', () => {
  test('success stops immediately with no delay', () => {
    const plan = planAttempt(1, 'success', 0.5);
    assert.deepEqual(plan, { attempt: 1, kind: 'success', retry: false, delayMs: 0, reason: 'backup_completed' });
  });

  test('permanent kinds stop with a machine-readable reason', () => {
    const auth = planAttempt(1, 'auth_failed', 0.5);
    assert.equal(auth.retry, false);
    assert.equal(auth.reason, 'permanent:auth_failed');
    const mis = planAttempt(2, 'misconfigured', 0.5);
    assert.equal(mis.retry, false);
    assert.equal(mis.reason, 'permanent:misconfigured');
  });

  test('transient kinds retry with backoff until MAX_ATTEMPTS', () => {
    const first = planAttempt(1, 'server_error', 0);
    assert.equal(first.retry, true);
    assert.equal(first.delayMs, BASE_BACKOFF_MS);
    assert.equal(first.reason, 'retry_after:server_error');

    const last = planAttempt(MAX_ATTEMPTS, 'server_error', 0);
    assert.equal(last.retry, false);
    assert.equal(last.delayMs, 0);
    assert.equal(last.reason, `max_attempts:${MAX_ATTEMPTS}`);
  });

  test('a full retry sequence is bounded: attempts and total sleep', () => {
    // Simulate the worst case: every attempt transient, jitter at maximum.
    let attempt = 1;
    let totalSleep = 0;
    let guard = 0;
    while (guard++ < 100) {
      const plan = planAttempt(attempt, 'network_error', 1);
      if (!plan.retry) break;
      totalSleep += plan.delayMs;
      attempt += 1;
    }
    assert.equal(attempt, MAX_ATTEMPTS, 'stops after MAX_ATTEMPTS');
    assert.ok(totalSleep <= MAX_BACKOFF_MS * (MAX_ATTEMPTS - 1), 'sleep stays within cap x retries');
    assert.ok(totalSleep >= BASE_BACKOFF_MS * (MAX_ATTEMPTS - 1), 'sleep grows at least linearly');
  });
});

describe('worker: buildAuthHeader', () => {
  test('produces the bearer header the endpoint expects', () => {
    assert.equal(buildAuthHeader('s3cret-value'), 'Bearer s3cret-value');
    assert.equal(buildAuthHeader('  padded  '), 'Bearer padded');
  });

  test('fails loudly on a missing secret instead of sending an empty bearer', () => {
    assert.throws(() => buildAuthHeader(''), /BACKUP_TRIGGER_SECRET is not configured/);
    assert.throws(() => buildAuthHeader('   '), /BACKUP_TRIGGER_SECRET is not configured/);
  });
});

describe('worker: deployment config (static checks, no network)', () => {
  const wrangler = readFileSync(join(DEPLOY_DIR, 'wrangler.toml'), 'utf8');
  const readme = readFileSync(join(DEPLOY_DIR, 'README.md'), 'utf8');

  test('wrangler.toml schedules a daily cron and points at the backup endpoint config', () => {
    assert.match(wrangler, /\[triggers\]/);
    assert.match(wrangler, /crons\s*=\s*\[\s*"[0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+ [0-9*/,-]+"\s*\]/);
    assert.match(wrangler, /main\s*=\s*"backup-cron\.ts"/);
    assert.match(wrangler, /BACKUP_BASE_URL/);
  });

  test('wrangler.toml never contains a secret value (names/placeholders only)', () => {
    // The secret must be provided via `wrangler secret put`, not committed.
    assert.doesNotMatch(wrangler, /BACKUP_TRIGGER_SECRET\s*=\s*"[^"]+"/);
    assert.match(wrangler, /wrangler secret put BACKUP_TRIGGER_SECRET/);
    assert.doesNotMatch(wrangler, /R2_SECRET|DATABASE_URL\s*=/);
  });

  test('README documents free-tier limits and forbids auto-enabling billing', () => {
    assert.match(readme, /100,000 requests\/day/);
    assert.match(readme, /10 ms CPU/);
    assert.match(readme, /5 cron triggers/);
    assert.match(readme, /10 GB/); // R2 Free storage
    assert.match(readme, /never enabled automatically/i);
    assert.match(readme, /BACKUP_ENABLED=false/); // 409 owner-decision path
  });

  test('README documents every endpoint outcome the Worker can see', () => {
    for (const status of ['201', '401', '404', '409', '429', '5xx']) {
      assert.ok(readme.includes(status), `README missing status ${status}`);
    }
  });
});
