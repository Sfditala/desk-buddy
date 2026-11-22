import {
  applyAction,
  dueAt,
  occurrenceKey,
  planDue,
  Reminder,
  type ReminderAction,
} from '@desk-buddy/core';
import { z } from 'zod';
import type { Alert } from '../reminders/presenter';

/** What the engine needs from the server. Implemented by SupabaseBackend; faked in tests. */
export interface Backend {
  /** All non-deleted, not-done reminders plus anything touched recently. */
  snapshot(): Promise<unknown[]>;
  ack(id: string, action: ReminderAction, occurrence: string): Promise<unknown>;
  /** Confirms the device is still allowed; throws DeviceRevokedError if not. */
  heartbeat(): Promise<void>;
  subscribe(handlers: {
    onChange: (row: unknown) => void;
    onStatus: (status: 'live' | 'down') => void;
  }): () => void;
}

export class DeviceRevokedError extends Error {
  override name = 'DeviceRevokedError';
}

/** Server said the row no longer exists (deleted / not ours): drop the queued action. */
export class NotFoundError extends Error {
  override name = 'NotFoundError';
}

export interface Persistence {
  load(): unknown;
  save(state: PersistedState): void;
}

const OutboxItem = z.object({
  id: z.uuid(),
  action: z.enum(['done', 'snooze']),
  occurrence: z.string(),
  at: z.string(),
  attempts: z.number().int().min(0),
});
type OutboxItem = z.infer<typeof OutboxItem>;

const PersistedState = z.object({
  v: z.literal(1),
  reminders: z.array(Reminder),
  handled: z.array(z.tuple([z.string(), z.number()])),
  outbox: z.array(OutboxItem),
});
export type PersistedState = z.infer<typeof PersistedState>;

export interface EngineHooks {
  /** Alerts that are due now (presenter de-duplicates by key). */
  due(alerts: Alert[]): void;
  /** These reminder ids must not be on screen any more. */
  retract(ids: string[]): void;
  status(s: SyncStatus): void;
  revoked(): void;
  log(level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void;
}

export type SyncStatus = 'live' | 'polling' | 'offline';

export interface EngineOptions {
  pollMs?: number;
  /** Max time between plan re-evaluations, so laptop sleep / clock jumps are caught. */
  maxTimerMs?: number;
  now?: () => Date;
  handledTtlMs?: number;
}

/** Server row: a Reminder plus the soft-delete marker. */
const RemoteRow = Reminder.extend({ deleted_at: z.string().nullable().optional() });
type RemoteRow = z.infer<typeof RemoteRow>;

const HANDLED_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 50;

/**
 * Keeps a local, encrypted-at-rest copy of reminders and fires them on time even when offline.
 * Sources: Realtime (instant) + polling every 30s (fallback/reconcile). Done/Snooze are applied
 * locally at once and queued in an outbox that is flushed (idempotently) when the server is back.
 */
export class SyncEngine {
  private reminders = new Map<string, Reminder>();
  /** Reminder ids currently reported as due, so we know what to retract. */
  private knownIds = new Set<string>();
  private handled = new Map<string, number>();
  private outbox: OutboxItem[] = [];
  private unsubscribe: (() => void) | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private planTimer: ReturnType<typeof setTimeout> | null = null;
  private realtimeLive = false;
  private online = false;
  private flushing = false;
  private stopped = true;
  private readonly pollMs: number;
  private readonly maxTimerMs: number;
  private readonly now: () => Date;
  private readonly handledTtlMs: number;

  constructor(
    private readonly backend: Backend,
    private readonly store: Persistence,
    private readonly hooks: EngineHooks,
    opts: EngineOptions = {},
  ) {
    this.pollMs = opts.pollMs ?? 30_000;
    this.maxTimerMs = opts.maxTimerMs ?? 60_000;
    this.now = opts.now ?? (() => new Date());
    this.handledTtlMs = opts.handledTtlMs ?? HANDLED_TTL_MS;
    this.restore();
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.plan(); // fire anything already due from the offline cache, before any network
    this.unsubscribe = this.backend.subscribe({
      onChange: (row) => {
        this.applyRemote(row);
      },
      onStatus: (s) => {
        this.realtimeLive = s === 'live';
        if (this.realtimeLive) void this.poll(); // reconcile anything missed while down
        this.emitStatus();
      },
    });
    void this.poll();
    this.pollTimer = setInterval(() => void this.poll(), this.pollMs);
  }

  stop(): void {
    this.stopped = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.planTimer) clearTimeout(this.planTimer);
    this.pollTimer = this.planTimer = null;
  }

  /** Wipe local state (sign-out / revoked). */
  clear(): void {
    this.reminders.clear();
    this.handled.clear();
    this.outbox = [];
    this.persist();
  }

  /** Re-evaluate now (system resume, clock change). */
  nudge(): void {
    this.plan();
    void this.poll();
  }

  get snapshot(): { reminders: number; outbox: number; status: SyncStatus } {
    return { reminders: this.reminders.size, outbox: this.outbox.length, status: this.status() };
  }

  /** User tapped Done/Snooze on an alert. */
  act(alert: Alert, action: ReminderAction): void {
    this.handled.set(alert.key, this.now().getTime());
    const r = this.reminders.get(alert.id);
    if (r) {
      this.reminders.set(r.id, { ...r, ...applyAction(r, action, this.now()) });
      this.outbox.push({
        id: r.id,
        action,
        occurrence: dueAt(r).toISOString(),
        at: this.now().toISOString(),
        attempts: 0,
      });
    }
    this.persist();
    this.plan();
    // Offline is expected here: the outbox keeps the action and the next poll retries it.
    this.flush().catch(() => undefined);
  }

  // ---------------------------------------------------------------------------------------------

  private status(): SyncStatus {
    if (!this.online) return 'offline';
    return this.realtimeLive ? 'live' : 'polling';
  }

  private emitStatus(): void {
    this.hooks.status(this.status());
  }

  private async poll(): Promise<void> {
    if (this.stopped) return;
    try {
      await this.backend.heartbeat();
      await this.flush();
      const rows = await this.backend.snapshot();
      this.applySnapshot(rows);
      if (!this.online) this.hooks.log('info', 'sync online');
      this.online = true;
    } catch (err) {
      if (err instanceof DeviceRevokedError) {
        this.hooks.log('warn', 'device revoked');
        this.stop();
        this.clear();
        this.hooks.revoked();
        return;
      }
      if (this.online) this.hooks.log('warn', 'sync offline', { error: errName(err) });
      this.online = false;
    } finally {
      this.emitStatus();
    }
  }

  private async flush(): Promise<void> {
    if (this.flushing || this.outbox.length === 0) return;
    this.flushing = true;
    try {
      while (this.outbox.length > 0) {
        const item = this.outbox[0];
        if (!item) break;
        try {
          const row = await this.backend.ack(item.id, item.action, item.occurrence);
          this.outbox.shift();
          this.applyRemote(row);
        } catch (err) {
          if (err instanceof NotFoundError || item.attempts + 1 >= MAX_ATTEMPTS) {
            this.hooks.log('warn', 'dropping queued action', { id: item.id, error: errName(err) });
            this.outbox.shift();
            continue;
          }
          item.attempts += 1;
          throw err; // network: keep the queue, retry on next poll
        } finally {
          this.persist();
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private parse(row: unknown): RemoteRow | null {
    const parsed = RemoteRow.safeParse(row);
    if (!parsed.success) {
      this.hooks.log('warn', 'ignored malformed reminder row');
      return null;
    }
    return parsed.data;
  }

  private applyRemote(row: unknown): void {
    const parsed = this.parse(row);
    if (!parsed) return;
    const { deleted_at: deletedAt, ...r } = parsed;
    const existing = this.reminders.get(r.id);
    if (existing && new Date(existing.updated_at) > new Date(r.updated_at)) return; // stale echo
    if (deletedAt) this.reminders.delete(r.id);
    else this.reminders.set(r.id, this.withPendingActions(r));
    this.persist();
    this.plan();
  }

  private applySnapshot(rows: unknown[]): void {
    const next = new Map<string, Reminder>();
    for (const row of rows) {
      const parsed = this.parse(row);
      if (!parsed || parsed.deleted_at) continue;
      next.set(parsed.id, this.withPendingActions(stripDeleted(parsed)));
    }
    this.reminders = next;
    this.persist();
    this.plan();
  }

  /** Keep optimistic results while their outbox item has not reached the server yet. */
  private withPendingActions(r: Reminder): Reminder {
    const queued = this.outbox.filter(
      (o) => o.id === r.id && o.occurrence === dueAt(r).toISOString(),
    );
    return queued.reduce(
      (acc, o) => ({ ...acc, ...applyAction(acc, o.action, new Date(o.at)) }),
      r,
    );
  }

  private plan(): void {
    if (this.planTimer) clearTimeout(this.planTimer);
    this.planTimer = null;
    const now = this.now();
    this.pruneHandled(now);
    const { due, nextAt } = planDue(
      [...this.reminders.values()],
      now,
      new Set(this.handled.keys()),
    );

    // Anything not due-and-unhandled any more must leave the screen.
    const dueIds = new Set(due.map((r) => r.id));
    this.hooks.retract([...this.knownIds].filter((id) => !dueIds.has(id)));
    this.knownIds = dueIds;

    if (due.length > 0) {
      this.hooks.due(
        due.map((r) => ({
          id: r.id,
          key: occurrenceKey(r),
          title: r.title,
          notes: r.notes,
          dueAt: dueAt(r),
        })),
      );
    }
    const wait = nextAt ? Math.max(0, nextAt.getTime() - now.getTime()) : this.maxTimerMs;
    this.planTimer = setTimeout(
      () => {
        this.plan();
      },
      Math.min(wait + 25, this.maxTimerMs),
    );
  }

  private pruneHandled(now: Date): void {
    for (const [k, t] of this.handled)
      if (now.getTime() - t > this.handledTtlMs) this.handled.delete(k);
  }

  private restore(): void {
    try {
      const raw = this.store.load();
      if (raw == null) return;
      const s = PersistedState.parse(raw);
      this.reminders = new Map(s.reminders.map((r) => [r.id, r]));
      this.handled = new Map(s.handled);
      this.outbox = s.outbox;
    } catch {
      this.hooks.log('warn', 'local cache unreadable, starting fresh');
    }
  }

  private persist(): void {
    try {
      this.store.save({
        v: 1,
        reminders: [...this.reminders.values()],
        handled: [...this.handled.entries()],
        outbox: this.outbox,
      });
    } catch (err) {
      this.hooks.log('error', 'failed to persist local cache', { error: errName(err) });
    }
  }
}

function stripDeleted(row: RemoteRow): Reminder {
  const copy: Partial<RemoteRow> = { ...row };
  delete copy.deleted_at;
  return copy as Reminder;
}

function errName(err: unknown): string {
  if (err instanceof Error) return `${err.name}${'code' in err ? `:${String(err.code)}` : ''}`;
  return 'unknown';
}
