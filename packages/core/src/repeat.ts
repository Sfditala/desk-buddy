import { DateTime } from 'luxon';
import { z } from 'zod';

/**
 * Supported subset of RFC 5545 RRULE. Kept deliberately small so the same rules can be
 * evaluated identically in Postgres (`public.next_occurrence`) and here.
 *
 *   FREQ=DAILY|WEEKLY|MONTHLY|YEARLY   (required)
 *   INTERVAL=1..366                     (default 1)
 *   BYDAY=MO,TU,...                     (WEEKLY only)
 *   UNTIL=YYYYMMDDTHHMMSSZ              (UTC, inclusive)
 */
export const WEEKDAYS = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
export type Freq = 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY';

export interface RepeatRule {
  freq: Freq;
  interval: number;
  byDay: Weekday[] | null;
  until: Date | null;
}

export class RepeatRuleError extends Error {
  override name = 'RepeatRuleError';
}

const UNTIL_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

export function parseRepeatRule(input: string): RepeatRule {
  const raw = input.trim().replace(/^RRULE:/i, '');
  if (raw.length === 0 || raw.length > 200) throw new RepeatRuleError('empty or too long');

  const parts = new Map<string, string>();
  for (const part of raw.split(';')) {
    const [k, v, ...rest] = part.split('=');
    if (!k || v === undefined || rest.length > 0 || v === '') {
      throw new RepeatRuleError(`malformed part "${part}"`);
    }
    const key = k.toUpperCase();
    if (parts.has(key)) throw new RepeatRuleError(`duplicate ${key}`);
    parts.set(key, v.toUpperCase());
  }
  for (const key of parts.keys()) {
    if (!['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL'].includes(key)) {
      throw new RepeatRuleError(`unsupported ${key}`);
    }
  }

  const freq = parts.get('FREQ');
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') {
    throw new RepeatRuleError('FREQ must be DAILY, WEEKLY, MONTHLY or YEARLY');
  }

  const intervalRaw = parts.get('INTERVAL') ?? '1';
  if (!/^\d{1,3}$/.test(intervalRaw)) throw new RepeatRuleError('INTERVAL must be 1..366');
  const interval = Number(intervalRaw);
  if (interval < 1 || interval > 366) throw new RepeatRuleError('INTERVAL must be 1..366');

  let byDay: Weekday[] | null = null;
  const byDayRaw = parts.get('BYDAY');
  if (byDayRaw !== undefined) {
    if (freq !== 'WEEKLY') throw new RepeatRuleError('BYDAY is only supported with WEEKLY');
    const days = byDayRaw.split(',');
    if (!days.every((d): d is Weekday => (WEEKDAYS as readonly string[]).includes(d))) {
      throw new RepeatRuleError('BYDAY must list MO..SU');
    }
    byDay = WEEKDAYS.filter((d) => days.includes(d));
    if (byDay.length !== days.length) throw new RepeatRuleError('duplicate BYDAY');
  }

  let until: Date | null = null;
  const untilRaw = parts.get('UNTIL');
  if (untilRaw !== undefined) {
    const m = UNTIL_RE.exec(untilRaw);
    if (!m) throw new RepeatRuleError('UNTIL must be YYYYMMDDTHHMMSSZ');
    const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    const dt = DateTime.utc(y, mo, d, h, mi, s);
    if (!dt.isValid) throw new RepeatRuleError('UNTIL is not a valid date');
    until = dt.toJSDate();
  }

  return { freq, interval, byDay, until };
}

export function isValidRepeatRule(input: string): boolean {
  try {
    parseRepeatRule(input);
    return true;
  } catch {
    return false;
  }
}

export const RepeatRuleString = z
  .string()
  .refine(isValidRepeatRule, { message: 'unsupported repeat rule' });

const UNIT: Record<Exclude<Freq, 'WEEKLY'>, 'days' | 'months' | 'years'> = {
  DAILY: 'days',
  MONTHLY: 'months',
  YEARLY: 'years',
};

/**
 * First occurrence of the series strictly after `after`, or null when the series has ended.
 *
 * Occurrences are computed from the series `anchor` (its first `remind_at`) in local wall-clock
 * time, so 09:00 stays 09:00 across DST changes and the 31st clamps to short months without
 * drifting. Missed occurrences are skipped: a laptop that was off for a week fires once.
 */
export function nextOccurrence(
  rule: RepeatRule,
  anchor: Date,
  after: Date,
  timeZone: string,
): Date | null {
  const start = DateTime.fromJSDate(anchor, { zone: timeZone });
  if (!start.isValid) throw new RepeatRuleError(`invalid time zone ${timeZone}`);
  const afterMs = after.getTime();
  const result =
    rule.freq === 'WEEKLY' ? nextWeekly(rule, start, afterMs) : nextSimple(rule, start, afterMs);
  if (result === null) return null;
  if (rule.until && result.getTime() > rule.until.getTime()) return null;
  return result;
}

function nextSimple(rule: RepeatRule, start: DateTime, afterMs: number): Date {
  const unit = UNIT[rule.freq as Exclude<Freq, 'WEEKLY'>];
  if (start.toMillis() > afterMs) return start.toJSDate();
  // Jump close to the answer, then step. The estimate can overshoot by a step around DST/clamping.
  const elapsed = DateTime.fromMillis(afterMs, { zone: start.zone }).diff(start, unit).get(unit);
  let k = Math.max(0, Math.floor(elapsed / rule.interval) - 1);
  for (let guard = 0; guard < 10_000; guard++, k++) {
    const candidate = start.plus({ [unit]: k * rule.interval });
    if (candidate.toMillis() > afterMs) return candidate.toJSDate();
  }
  throw new RepeatRuleError('next occurrence not found');
}

function nextWeekly(rule: RepeatRule, start: DateTime, afterMs: number): Date | null {
  const days: readonly Weekday[] = rule.byDay ?? WEEKDAYS.slice(start.weekday - 1, start.weekday);
  const offsets = days.map((d) => WEEKDAYS.indexOf(d)); // 0 = Monday
  const weekStart = start.startOf('week'); // ISO week, Monday
  const afterLocal = DateTime.fromMillis(afterMs, { zone: start.zone });
  const weeksElapsed = Math.max(0, Math.floor(afterLocal.diff(weekStart, 'weeks').weeks));
  let w = Math.max(0, Math.floor(weeksElapsed / rule.interval) - 1) * rule.interval;

  for (let guard = 0; guard < 10_000; guard++, w += rule.interval) {
    const week = weekStart.plus({ weeks: w });
    for (const offset of offsets) {
      const candidate = week
        .plus({ days: offset })
        .set({ hour: start.hour, minute: start.minute, second: start.second, millisecond: 0 });
      if (candidate < start) continue;
      if (candidate.toMillis() > afterMs) return candidate.toJSDate();
    }
  }
  throw new RepeatRuleError('next occurrence not found');
}
