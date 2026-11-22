import {
  DEFAULT_TIME_ZONE,
  MAX_SNOOZE_MINUTES,
  SNOOZE_MINUTES,
  type Reminder,
  type ReminderAction,
} from './reminder.js';
import { nextOccurrence, parseRepeatRule } from './repeat.js';

/** When the reminder should (next) be shown. Snoozed reminders use `snooze_until`. */
export function dueAt(r: Pick<Reminder, 'status' | 'remind_at' | 'snooze_until'>): Date {
  if (r.status === 'snoozed' && r.snooze_until) return new Date(r.snooze_until);
  return new Date(r.remind_at);
}

/**
 * Identity of one concrete alert. A repeat advances `remind_at` and a snooze changes the due
 * time, so each produces a fresh key; Realtime echoes and polling of the same row do not.
 */
export function occurrenceKey(
  r: Pick<Reminder, 'id' | 'status' | 'remind_at' | 'snooze_until'>,
): string {
  return `${r.id}@${dueAt(r).toISOString()}`;
}

export interface DuePlan {
  /** Reminders to alert now, oldest first. */
  due: Reminder[];
  /** Earliest future due time, for arming a single timer. */
  nextAt: Date | null;
}

/**
 * Decide what to show. Missed reminders (app was offline/asleep) are all included, oldest first;
 * `handled` holds occurrence keys the user already acknowledged on this device.
 */
export function planDue(
  reminders: readonly Reminder[],
  now: Date,
  handled: ReadonlySet<string>,
): DuePlan {
  const due: Reminder[] = [];
  let nextAt: Date | null = null;
  for (const r of reminders) {
    if (r.status === 'done') continue;
    if (handled.has(occurrenceKey(r))) continue;
    const at = dueAt(r);
    if (at.getTime() <= now.getTime()) {
      due.push(r);
    } else if (!nextAt || at < nextAt) {
      nextAt = at;
    }
  }
  due.sort((a, b) => dueAt(a).getTime() - dueAt(b).getTime());
  return { due, nextAt };
}

export function snoozeUntil(now: Date, minutes: number = SNOOZE_MINUTES): Date {
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_SNOOZE_MINUTES) {
    throw new RangeError(`snooze minutes must be 1..${MAX_SNOOZE_MINUTES}`);
  }
  return new Date(now.getTime() + minutes * 60_000);
}

export type ReminderPatch = Pick<
  Reminder,
  'status' | 'remind_at' | 'snooze_until' | 'acknowledged_at' | 'fired_at'
>;

/**
 * Optimistic local result of a user action. Mirrors `public.ack_reminder` in SQL, which is the
 * source of truth once the action syncs.
 */
export function applyAction(
  r: Reminder,
  action: ReminderAction,
  now: Date,
  timeZone: string = DEFAULT_TIME_ZONE,
): ReminderPatch {
  const nowIso = now.toISOString();
  if (action === 'snooze') {
    return {
      status: 'snoozed',
      remind_at: r.remind_at,
      snooze_until: snoozeUntil(now).toISOString(),
      acknowledged_at: r.acknowledged_at,
      fired_at: r.fired_at,
    };
  }
  if (r.repeat_rule) {
    const rule = parseRepeatRule(r.repeat_rule);
    const anchor = new Date(r.repeat_anchor ?? r.remind_at);
    // Advance past both "now" and the current occurrence so Done never re-fires the same one.
    const from = new Date(Math.max(now.getTime(), new Date(r.remind_at).getTime()));
    const next = nextOccurrence(rule, anchor, from, timeZone);
    if (next) {
      return {
        status: 'pending',
        remind_at: next.toISOString(),
        snooze_until: null,
        acknowledged_at: nowIso,
        fired_at: null,
      };
    }
  }
  return {
    status: 'done',
    remind_at: r.remind_at,
    snooze_until: null,
    acknowledged_at: nowIso,
    fired_at: r.fired_at,
  };
}

/** Re-nag cadence while an alert is unacknowledged. */
export const NAG_INTERVAL_MS = 3 * 60_000;
