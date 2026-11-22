import { z } from 'zod';
import { RepeatRuleString } from './repeat.js';

export const DEFAULT_TIME_ZONE = 'Asia/Hebron';

export const REMINDER_STATUSES = ['pending', 'fired', 'done', 'snoozed'] as const;
export const ReminderStatus = z.enum(REMINDER_STATUSES);
export type ReminderStatus = z.infer<typeof ReminderStatus>;

/** Postgres returns timestamptz as e.g. `2026-11-22T10:00:00+00:00`. */
const Timestamp = z.iso.datetime({ offset: true });

/** Row shape of `public.reminders` as the desktop app and dashboard see it. */
export const Reminder = z.object({
  id: z.uuid(),
  title: z.string().min(1).max(500),
  notes: z.string().max(4000).nullable(),
  remind_at: Timestamp,
  status: ReminderStatus,
  repeat_rule: RepeatRuleString.nullable(),
  repeat_anchor: Timestamp.nullable(),
  snooze_until: Timestamp.nullable(),
  fired_at: Timestamp.nullable(),
  acknowledged_at: Timestamp.nullable(),
  source: z.string().max(50),
  created_at: Timestamp,
  updated_at: Timestamp,
});
export type Reminder = z.infer<typeof Reminder>;

export const ReminderAction = z.enum(['done', 'snooze']);
export type ReminderAction = z.infer<typeof ReminderAction>;

export const SNOOZE_MINUTES = 10;
export const MAX_SNOOZE_MINUTES = 24 * 60;
