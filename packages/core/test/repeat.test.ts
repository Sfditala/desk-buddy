import { DateTime } from 'luxon';
import { describe, expect, it } from 'vitest';
import { nextOccurrence, parseRepeatRule, RepeatRuleError } from '../src/repeat.js';
import fixtures from './repeat-cases.json' with { type: 'json' };

const zone = fixtures.timeZone;
const local = (s: string) => DateTime.fromFormat(s, 'yyyy-MM-dd HH:mm', { zone }).toJSDate();
const fmt = (d: Date | null) =>
  d ? DateTime.fromJSDate(d, { zone }).toFormat('yyyy-MM-dd HH:mm') : null;

describe('nextOccurrence (shared fixtures, also run against SQL)', () => {
  it.each(fixtures.cases)('$name', ({ rule, anchor, after, expected }) => {
    expect(fmt(nextOccurrence(parseRepeatRule(rule), local(anchor), local(after), zone))).toBe(
      expected,
    );
  });

  it('is strictly after `after`', () => {
    const rule = parseRepeatRule('FREQ=DAILY');
    const at = local('2026-11-22 09:00');
    expect(fmt(nextOccurrence(rule, at, at, zone))).toBe('2026-11-23 09:00');
  });

  it('handles a series years old without iterating forever', () => {
    const rule = parseRepeatRule('FREQ=DAILY');
    const started = performance.now();
    const next = nextOccurrence(rule, local('2001-01-01 09:00'), local('2026-11-22 10:00'), zone);
    expect(fmt(next)).toBe('2026-11-23 09:00');
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('rejects an invalid time zone', () => {
    expect(() =>
      nextOccurrence(parseRepeatRule('FREQ=DAILY'), new Date(), new Date(), 'Mars/Base'),
    ).toThrow(RepeatRuleError);
  });
});

describe('parseRepeatRule', () => {
  it('parses a full rule and normalises case and RRULE: prefix', () => {
    expect(
      parseRepeatRule('rrule:freq=weekly;interval=2;byday=th,su;until=20270101T000000Z'),
    ).toEqual({
      freq: 'WEEKLY',
      interval: 2,
      byDay: ['TH', 'SU'],
      until: new Date('2027-01-01T00:00:00Z'),
    });
  });

  it.each(fixtures.invalid)('rejects %j', (rule) => {
    expect(() => parseRepeatRule(rule)).toThrow(RepeatRuleError);
  });
});
