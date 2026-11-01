/**
 * Timezone-aware time helpers.
 *
 * All business scheduling (calling hours, daily limits, follow-up windows) is
 * evaluated in the configured business timezone (default Asia/Karachi, UTC+5,
 * no DST historically - but these helpers use Intl so any IANA zone works).
 */
import { AppError } from './errors.ts';

export interface TimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** 0 = Sunday … 6 = Saturday */
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function assertTimezone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
  } catch {
    throw new AppError('validation_failed', `Unknown timezone: ${timeZone}`);
  }
}

export function partsInZone(date: Date, timeZone: string): TimeParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '0';
  const hour = Number(get('hour'));
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    // Intl can render midnight as "24" with hour12:false in some ICU versions.
    hour: hour === 24 ? 0 : hour,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAY_INDEX[get('weekday')] ?? 0,
  };
}

export function businessDayKey(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function minutesOfDayInZone(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  return p.hour * 60 + p.minute;
}

export function isWeekendDayNumber(weekday: number): boolean {
  return weekday === 0 || weekday === 6;
}

/** Parse "HH:MM" into minutes past midnight. Throws on malformed input. */
export function parseClock(hhmm: string): number {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(hhmm.trim());
  if (!m) throw new AppError('validation_failed', `Invalid time "${hhmm}" (expected HH:MM)`);
  return Number(m[1]) * 60 + Number(m[2]);
}

export interface CallSchedule {
  /** Days the business permits outbound calling: 0 = Sunday … 6 = Saturday. */
  days: number[];
  /** Local "HH:MM" inclusive start. */
  startTime: string;
  /** Local "HH:MM" exclusive end. */
  endTime: string;
  timezone: string;
}

export interface ScheduleDecision {
  allowed: boolean;
  reason: string;
  localDay: number;
  localMinutes: number;
  nextAllowedAt: Date | null;
}

/**
 * Backend authority for calling hours. The frontend may show this too, but
 * only this function decides whether an outbound action may proceed.
 */
export function isWithinCallSchedule(now: Date, schedule: CallSchedule): ScheduleDecision {
  assertTimezone(schedule.timezone);
  const p = partsInZone(now, schedule.timezone);
  const minutes = p.hour * 60 + p.minute;
  const start = parseClock(schedule.startTime);
  const end = parseClock(schedule.endTime);
  const dayOk = schedule.days.includes(p.weekday);
  const timeOk = start <= minutes && minutes < end;

  if (!dayOk) {
    return {
      allowed: false,
      reason: `Calling is not permitted on ${WEEKDAY_NAME[p.weekday]}s (${schedule.timezone})`,
      localDay: p.weekday,
      localMinutes: minutes,
      nextAllowedAt: nextAllowedTime(now, schedule),
    };
  }
  if (!timeOk) {
    return {
      allowed: false,
      reason: `Outside configured calling hours ${schedule.startTime}-${schedule.endTime} ${schedule.timezone} (local time ${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')})`,
      localDay: p.weekday,
      localMinutes: minutes,
      nextAllowedAt: nextAllowedTime(now, schedule),
    };
  }
  return {
    allowed: true,
    reason: 'Within configured calling hours',
    localDay: p.weekday,
    localMinutes: minutes,
    nextAllowedAt: null,
  };
}

export const WEEKDAY_NAME = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/**
 * Next instant (UTC) at which the schedule permits calling.
 * Uses incremental day stepping in the business timezone; horizon = 8 days.
 */
export function nextAllowedTime(now: Date, schedule: CallSchedule): Date | null {
  const start = parseClock(schedule.startTime);
  for (let offset = 0; offset <= 8; offset++) {
    // Probe at local 00:00 of day+|offset| by stepping 24h from now, then
    // normalising to the local date we are probing.
    const probe = new Date(now.getTime() + offset * 24 * 60 * 60 * 1000);
    const p = partsInZone(probe, schedule.timezone);
    if (!schedule.days.includes(p.weekday)) continue;
    const sameDay = offset === 0;
    if (sameDay && p.hour * 60 + p.minute >= start) {
      // Already past start today; if still before end it would have been allowed.
      const end = parseClock(schedule.endTime);
      if (p.hour * 60 + p.minute < end) return probe;
      continue;
    }
    return localWallClockToDate(p.year, p.month, p.day, start, schedule.timezone);
  }
  return null;
}

/**
 * Convert a wall-clock time in a named zone to a UTC Date.
 * Iterative refinement handles zones with sub-hour/offset transitions.
 */
export function localWallClockToDate(
  year: number,
  month: number,
  day: number,
  minutesPastMidnight: number,
  timeZone: string,
): Date {
  const target = minutesPastMidnight;
  // Initial guess treating the offset as UTC.
  let ts = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + target * 60_000;
  for (let i = 0; i < 4; i++) {
    const p = partsInZone(new Date(ts), timeZone);
    const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
    const wantedAsUtc = Date.UTC(year, month - 1, day, 0, 0, 0, 0) + target * 60_000;
    const diff = wantedAsUtc - asUtc;
    if (diff === 0) break;
    ts += diff;
  }
  return new Date(ts);
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

export function isValidIso(s: string): boolean {
  return !Number.isNaN(Date.parse(s));
}
