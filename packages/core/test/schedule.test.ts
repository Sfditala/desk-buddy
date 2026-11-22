import { describe, expect, it } from 'vitest';
import { Reminder } from '../src/reminder.js';
import { applyAction, dueAt, occurrenceKey, planDue, snoozeUntil } from '../src/schedule.js';

const NOW = new Date('2026-11-22T10:00:00Z');

function make(overrides: Partial<Reminder> = {}): Reminder {
  return Reminder.parse({
    id: crypto.randomUUID(),
    title: 'اتصل بأحمد',
    notes: null,
    remind_at: '2026-11-22T09:59:00+00:00',
    status: 'pending',
    repeat_rule: null,
    repeat_anchor: null,
    snooze_until: null,
    fired_at: null,
    acknowledged_at: null,
    source: 'telegram',
    created_at: '2026-11-22T09:00:00+00:00',
    updated_at: '2026-11-22T09:00:00+00:00',
    ...overrides,
  });
}

describe('dueAt / occurrenceKey', () => {
  it('uses snooze_until only while snoozed', () => {
    const r = make({ status: 'snoozed', snooze_until: '2026-11-22T10:10:00+00:00' });
    expect(dueAt(r).toISOString()).toBe('2026-11-22T10:10:00.000Z');
    expect(dueAt({ ...r, status: 'fired' }).toISOString()).toBe('2026-11-22T09:59:00.000Z');
  });

  it('gives a snoozed occurrence a new key', () => {
    const r = make();
    const snoozed = { ...r, status: 'snoozed' as const, snooze_until: '2026-11-22T10:10:00+00:00' };
    expect(occurrenceKey(r)).not.toBe(occurrenceKey(snoozed));
  });

  it('is stable across equivalent timestamp formats (realtime vs REST)', () => {
    const a = make({ remind_at: '2026-11-22T12:00:00+02:00' });
    const b = { ...a, remind_at: '2026-11-22T10:00:00.000Z' };
    expect(occurrenceKey(a)).toBe(occurrenceKey(b));
  });
});

describe('planDue', () => {
  it('returns due reminders oldest first and the next timer', () => {
    const older = make({ remind_at: '2026-11-20T08:00:00+00:00' });
    const newer = make({ remind_at: '2026-11-22T09:00:00+00:00' });
    const future = make({ remind_at: '2026-11-22T11:00:00+00:00' });
    const sooner = make({
      status: 'snoozed',
      remind_at: '2026-11-22T09:00:00+00:00',
      snooze_until: '2026-11-22T10:05:00+00:00',
    });
    const plan = planDue([newer, future, older, sooner], NOW, new Set());
    expect(plan.due.map((r) => r.id)).toEqual([older.id, newer.id]);
    expect(plan.nextAt?.toISOString()).toBe('2026-11-22T10:05:00.000Z');
  });

  it('skips done and already-handled occurrences (no duplicates)', () => {
    const done = make({ status: 'done' });
    const handled = make();
    const fired = make({ status: 'fired' });
    const plan = planDue([done, handled, fired], NOW, new Set([occurrenceKey(handled)]));
    expect(plan.due.map((r) => r.id)).toEqual([fired.id]);
  });

  it('fires at exactly the due instant', () => {
    const r = make({ remind_at: NOW.toISOString() });
    expect(planDue([r], NOW, new Set()).due).toHaveLength(1);
  });
});

describe('snooze', () => {
  it('defaults to 10 minutes', () => {
    expect(snoozeUntil(NOW).toISOString()).toBe('2026-11-22T10:10:00.000Z');
  });
  it.each([0, -5, 1.5, 24 * 60 + 1])('rejects %d minutes', (m) => {
    expect(() => snoozeUntil(NOW, m)).toThrow(RangeError);
  });
  it('snooze action keeps remind_at and sets snooze_until', () => {
    const r = make();
    expect(applyAction(r, 'snooze', NOW)).toMatchObject({
      status: 'snoozed',
      remind_at: r.remind_at,
      snooze_until: '2026-11-22T10:10:00.000Z',
    });
  });
});

describe('applyAction done', () => {
  it('completes a one-off reminder', () => {
    expect(applyAction(make(), 'done', NOW)).toMatchObject({
      status: 'done',
      acknowledged_at: NOW.toISOString(),
      snooze_until: null,
    });
  });

  it('advances a repeating reminder to the next occurrence (09:00 Hebron daily)', () => {
    const r = make({
      repeat_rule: 'FREQ=DAILY',
      remind_at: '2026-11-22T07:00:00+00:00',
      repeat_anchor: '2026-11-01T07:00:00+00:00',
    });
    expect(applyAction(r, 'done', NOW)).toMatchObject({
      status: 'pending',
      remind_at: '2026-11-23T07:00:00.000Z',
      snooze_until: null,
      fired_at: null,
    });
  });

  it('done on a snoozed repeat does not re-fire the same day', () => {
    const r = make({
      repeat_rule: 'FREQ=DAILY',
      status: 'snoozed',
      remind_at: '2026-11-22T07:00:00+00:00',
      snooze_until: '2026-11-22T07:10:00+00:00',
      repeat_anchor: '2026-11-22T07:00:00+00:00',
    });
    expect(applyAction(r, 'done', new Date('2026-11-22T07:10:30Z')).remind_at).toBe(
      '2026-11-23T07:00:00.000Z',
    );
  });

  it('completes a repeating reminder whose series has ended', () => {
    const r = make({
      repeat_rule: 'FREQ=DAILY;UNTIL=20261122T235959Z',
      remind_at: '2026-11-22T07:00:00+00:00',
    });
    expect(applyAction(r, 'done', NOW).status).toBe('done');
  });
});

describe('Reminder schema', () => {
  it('rejects an unsupported repeat rule', () => {
    expect(() => make({ repeat_rule: 'FREQ=HOURLY' })).toThrow();
  });
  it('round-trips Arabic text untouched', () => {
    expect(make({ title: 'موعد الطبيب الخميس الجاي 🩺' }).title).toBe(
      'موعد الطبيب الخميس الجاي 🩺',
    );
  });
});
