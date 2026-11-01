/**
 * Phase 11A unit tests: adapter resilience primitives.
 *
 *  - withRetry: retries ONLY retryable AdapterErrors, bounded attempts,
 *    deterministic delays via injectable sleep/random;
 *  - TokenBucket/RateLimiter: burst + refill via injectable clock, never
 *    negative, per-key isolation.
 *
 * No network, no real timers (sleeps are recorded, not waited).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, TokenBucket, RateLimiter } from '../../src/adapters/resilience.ts';
import { AdapterError } from '../../src/adapters/types.ts';

/** sleep recorder: resolves immediately, records the requested delays. */
function sleepRecorder(): { sleep: (ms: number) => Promise<void>; delays: number[] } {
  const delays: number[] = [];
  return {
    delays,
    sleep: async (ms) => {
      delays.push(ms);
    },
  };
}

describe('withRetry', () => {
  test('returns the value with retries=0 when the first attempt succeeds', async () => {
    let calls = 0;
    const { value, retries } = await withRetry(async () => {
      calls += 1;
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(retries, 0);
    assert.equal(calls, 1);
  });

  test('retries a retryable AdapterError until success', async () => {
    let calls = 0;
    const { sleep, delays } = sleepRecorder();
    const { value, retries } = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new AdapterError('network', 'connection reset', { retryable: true });
        return 'ok';
      },
      { attempts: 3, sleep, random: () => 1 },
    );
    assert.equal(value, 'ok');
    assert.equal(retries, 2);
    assert.equal(calls, 3);
    assert.equal(delays.length, 2); // two sleeps between three attempts
  });

  test('does NOT retry a non-retryable AdapterError (e.g. invalid destination)', async () => {
    let calls = 0;
    const { sleep, delays } = sleepRecorder();
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new AdapterError('invalid_destination', 'bad number');
        },
        { attempts: 5, sleep },
      ),
      (err: unknown) => err instanceof AdapterError && err.code === 'invalid_destination',
    );
    assert.equal(calls, 1);
    assert.equal(delays.length, 0);
  });

  test('does NOT retry a generic (non-AdapterError) throw', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls += 1;
        throw new TypeError('programmer error');
      }),
    );
    assert.equal(calls, 1);
  });

  test('stops retrying when retryOn returns false even if marked retryable', async () => {
    let calls = 0;
    const { sleep } = sleepRecorder();
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new AdapterError('rate_limited', 'slow down', { retryable: true });
        },
        { attempts: 4, sleep, retryOn: () => false },
      ),
    );
    assert.equal(calls, 1);
  });

  test('gives up after the attempt budget and rethrows the last error', async () => {
    let calls = 0;
    const { sleep, delays } = sleepRecorder();
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new AdapterError('network', 'down', { retryable: true });
        },
        { attempts: 3, sleep, random: () => 0 },
      ),
      (err: unknown) => err instanceof AdapterError && err.code === 'network',
    );
    assert.equal(calls, 3);
    assert.equal(delays.length, 2);
  });

  test('delays grow exponentially (base * 2^(attempt-1), jitter 50-100%)', async () => {
    const { sleep, delays } = sleepRecorder();
    await assert
      .rejects(
        withRetry(
          async () => {
            throw new AdapterError('network', 'down', { retryable: true });
          },
          { attempts: 4, baseDelayMs: 100, maxDelayMs: 10_000, sleep, random: () => 1 },
        ),
      )
      .catch(() => undefined);
    // random()=1 => full jitter multiplier (0.5 + 1*0.5 = 1.0): 100, 200, 400.
    assert.deepEqual(delays, [100, 200, 400]);
  });

  test('delay is capped by maxDelayMs', async () => {
    const { sleep, delays } = sleepRecorder();
    await assert
      .rejects(
        withRetry(
          async () => {
            throw new AdapterError('network', 'down', { retryable: true });
          },
          { attempts: 5, baseDelayMs: 1_000, maxDelayMs: 1_500, sleep, random: () => 1 },
        ),
      )
      .catch(() => undefined);
    // 1000, 2000->1500(cap), 4000->1500, 8000->1500
    assert.deepEqual(delays, [1000, 1500, 1500, 1500]);
  });
});

describe('TokenBucket', () => {
  test('allows a full-capacity burst then refuses', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(3, 60, () => nowMs);
    assert.equal(bucket.tryRemove(), true);
    assert.equal(bucket.tryRemove(), true);
    assert.equal(bucket.tryRemove(), true);
    assert.equal(bucket.tryRemove(), false); // burst exhausted
  });

  test('refills continuously with the clock (60/min = 1 per second)', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(1, 60, () => nowMs);
    assert.equal(bucket.tryRemove(), true);
    assert.equal(bucket.tryRemove(), false);
    nowMs += 1_000; // one second => one token
    assert.equal(bucket.tryRemove(), true);
    assert.equal(bucket.tryRemove(), false);
  });

  test('never exceeds capacity even after a long idle period', () => {
    let nowMs = 0;
    const bucket = new TokenBucket(2, 600, () => nowMs);
    nowMs += 60 * 60 * 1000; // one hour: would be +600 tokens without the cap
    assert.equal(bucket.available(), 2);
  });

  test('a backwards clock cannot mint tokens', () => {
    let nowMs = 10_000;
    const bucket = new TokenBucket(1, 60, () => nowMs);
    assert.equal(bucket.tryRemove(), true);
    nowMs = 5_000; // clock jumped backwards
    assert.equal(bucket.tryRemove(), false);
  });
});

describe('RateLimiter', () => {
  test('limits per key independently', () => {
    let nowMs = 0;
    const limiter = new RateLimiter(1, 60, () => nowMs);
    assert.equal(limiter.tryRemove('telephony'), true);
    assert.equal(limiter.tryRemove('telephony'), false);
    // A different integration has its own bucket.
    assert.equal(limiter.tryRemove('whatsapp'), true);
    assert.equal(limiter.tryRemove('whatsapp'), false);
  });

  test('refills a specific key after time passes', () => {
    let nowMs = 0;
    const limiter = new RateLimiter(1, 60, () => nowMs); // 60/min = 1 token/sec
    assert.equal(limiter.tryRemove('ai'), true);
    assert.equal(limiter.tryRemove('ai'), false);
    nowMs += 500; // half a token: not yet a whole token
    assert.equal(limiter.tryRemove('ai'), false);
    nowMs += 500; // now >= 1 full token
    assert.equal(limiter.tryRemove('ai'), true);
  });
});
