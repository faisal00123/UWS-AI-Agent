import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { businessDayKey, isWithinCallSchedule, nextAllowedTime, parseClock, localWallClockToDate } from '../../src/core/time.ts';

describe('calling schedule enforcement (Asia/Karachi)', () => {
  const schedule = {
    days: [1, 2, 3, 4, 5], // Mon-Fri
    startTime: '09:00',
    endTime: '18:00',
    timezone: 'Asia/Karachi',
  };

  test('2026-10-26 12:00 PKT (Monday) is allowed', () => {
    // 2026-10-26 is a Monday; 12:00 local = 07:00 UTC
    const d = new Date('2026-10-26T07:00:00Z');
    const r = isWithinCallSchedule(d, schedule);
    assert.equal(r.allowed, true, r.reason);
    assert.equal(r.localDay, 1);
  });

  test('before opening hours is blocked with a reason', () => {
    // 08:30 local Monday = 03:30 UTC
    const r = isWithinCallSchedule(new Date('2026-10-26T03:30:00Z'), schedule);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /Outside configured calling hours 09:00-18:00/);
    assert.ok(r.nextAllowedAt, 'a next allowed time must be proposed');
  });

  test('after closing hours is blocked', () => {
    // 18:30 local Monday = 13:30 UTC
    const r = isWithinCallSchedule(new Date('2026-10-26T13:30:00Z'), schedule);
    assert.equal(r.allowed, false);
  });

  test('weekend is blocked even during hours', () => {
    // 2026-10-24 is a Saturday; 12:00 local = 07:00 UTC
    const r = isWithinCallSchedule(new Date('2026-10-24T07:00:00Z'), schedule);
    assert.equal(r.allowed, false);
    assert.match(r.reason, /Saturdays/);
  });

  test('exact end time is exclusive', () => {
    // 18:00 local Monday = 13:00 UTC
    const r = isWithinCallSchedule(new Date('2026-10-26T13:00:00Z'), schedule);
    assert.equal(r.allowed, false);
  });

  test('next allowed time lands on a permitted day and hour', () => {
    const next = nextAllowedTime(new Date('2026-10-24T13:30:00Z'), schedule); // Saturday evening local
    assert.ok(next);
    const again = isWithinCallSchedule(next!, schedule);
    assert.equal(again.allowed, true, `next allowed ${next?.toISOString()} should be inside: ${again.reason}`);
  });

  test('business day key uses the configured timezone, not UTC', () => {
    // 2026-10-26T20:00Z is already 2026-10-27 01:00 in Karachi
    assert.equal(businessDayKey(new Date('2026-10-26T20:00:00Z'), 'Asia/Karachi'), '2026-10-27');
    assert.equal(businessDayKey(new Date('2026-10-26T20:00:00Z'), 'UTC'), '2026-10-26');
  });

  test('parseClock rejects malformed times', () => {
    assert.equal(parseClock('09:30'), 570);
    assert.equal(parseClock('23:59'), 1439);
    assert.throws(() => parseClock('24:00'));
    assert.throws(() => parseClock('9-30'));
    assert.throws(() => parseClock('09:60'));
  });

  test('localWallClockToDate round-trips through the zone', () => {
    const d = localWallClockToDate(2026, 10, 27, 9 * 60, 'Asia/Karachi');
    assert.equal(businessDayKey(d, 'Asia/Karachi'), '2026-10-27');
    const r = isWithinCallSchedule(d, schedule);
    assert.equal(r.allowed, true, r.reason);
  });
});
