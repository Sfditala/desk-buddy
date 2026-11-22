import { NAG_INTERVAL_MS, DEFAULT_TIME_ZONE } from '@desk-buddy/core';
import type { ActionMsg, ReminderView } from '../../shared/ipc';
import { scoped } from '../logger';

const log = scoped('presenter');

export interface Alert {
  id: string;
  /** Occurrence key: identical keys are never shown twice. */
  key: string;
  title: string;
  notes: string | null;
  dueAt: Date;
}

export interface PresenterPorts {
  show(view: ReminderView): void;
  hide(id: string): void;
  nag(id: string): void;
  setAlerting(on: boolean): void;
  onAction(alert: Alert, action: ActionMsg['action']): void;
}

export interface PresenterTimers {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

const whenFormat = new Intl.DateTimeFormat('en-GB', {
  timeZone: DEFAULT_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  weekday: 'short',
  day: 'numeric',
  month: 'short',
  hourCycle: 'h23',
});

export function formatWhen(d: Date): string {
  const parts = Object.fromEntries(whenFormat.formatToParts(d).map((p) => [p.type, p.value]));
  return `${parts.hour ?? ''}:${parts.minute ?? ''} · ${parts.weekday ?? ''} ${parts.day ?? ''} ${parts.month ?? ''}`;
}

/**
 * One alert on screen at a time, FIFO by due time. Re-nags every few minutes until the user
 * taps Done/Snooze. Pausing holds alerts (nothing is dropped) until resumed.
 */
export class AlertPresenter {
  private queue: Alert[] = [];
  private current: Alert | null = null;
  private nagHandle: unknown = null;
  private paused = false;

  constructor(
    private readonly ports: PresenterPorts,
    private readonly timers: PresenterTimers = {
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => {
        clearInterval(h as NodeJS.Timeout);
      },
    },
  ) {}

  get showing(): Alert | null {
    return this.current;
  }

  get pending(): readonly Alert[] {
    return this.queue;
  }

  push(alerts: readonly Alert[]): void {
    const known = new Set([this.current?.key, ...this.queue.map((a) => a.key)]);
    let added = 0;
    for (const a of alerts) {
      if (known.has(a.key)) continue;
      // A newer occurrence of the same reminder replaces the stale queued one.
      this.queue = this.queue.filter((q) => q.id !== a.id);
      this.queue.push(a);
      known.add(a.key);
      added++;
    }
    if (added === 0) return;
    this.queue.sort((x, y) => x.dueAt.getTime() - y.dueAt.getTime());
    if (this.current) this.redisplay();
    else this.next();
  }

  /** The reminder was completed, snoozed or deleted elsewhere (Telegram, another device). */
  retract(id: string): void {
    this.queue = this.queue.filter((a) => a.id !== id);
    if (this.current?.id === id) {
      this.clearCurrent();
      this.next();
    } else if (this.current) {
      this.redisplay();
    }
  }

  handleAction(msg: ActionMsg): void {
    const alert = this.current;
    if (alert?.id !== msg.id) {
      log.warn('action for alert not on screen', { id: msg.id, showing: alert?.id ?? null });
      return;
    }
    this.clearCurrent();
    this.ports.onAction(alert, msg.action);
    this.next();
  }

  setPaused(paused: boolean): void {
    if (this.paused === paused) return;
    this.paused = paused;
    if (paused && this.current) {
      // Put it back at the front; it will be shown again on resume.
      this.queue.unshift(this.current);
      this.clearCurrent();
    } else if (!paused) {
      this.next();
    }
  }

  dispose(): void {
    this.stopNag();
  }

  private next(): void {
    if (this.paused || this.current) return;
    const alert = this.queue.shift();
    if (!alert) {
      this.ports.setAlerting(false);
      return;
    }
    this.current = alert;
    this.ports.setAlerting(true);
    this.ports.show(this.view(alert));
    this.stopNag();
    this.nagHandle = this.timers.setInterval(() => {
      if (this.current) this.ports.nag(this.current.id);
    }, NAG_INTERVAL_MS);
  }

  /** Re-send the alert on screen, e.g. after the renderer was recreated. */
  redisplay(): void {
    if (this.current) this.ports.show(this.view(this.current));
  }

  private clearCurrent(): void {
    if (!this.current) return;
    this.ports.hide(this.current.id);
    this.current = null;
    this.stopNag();
    if (this.queue.length === 0 || this.paused) this.ports.setAlerting(false);
  }

  private stopNag(): void {
    if (this.nagHandle !== null) this.timers.clearInterval(this.nagHandle);
    this.nagHandle = null;
  }

  private view(a: Alert): ReminderView {
    return {
      id: a.id,
      title: a.title,
      notes: a.notes,
      when: formatWhen(a.dueAt),
      queued: this.queue.length,
    };
  }
}
