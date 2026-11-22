import type { Reminder } from '@desk-buddy/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Alert } from '../src/main/reminders/presenter';
import {
  DeviceRevokedError,
  NotFoundError,
  SyncEngine,
  type Backend,
  type EngineHooks,
  type PersistedState,
} from '../src/main/sync/engine';

const T0 = new Date('2026-11-22T10:00:00.000Z');

function row(over: Partial<Reminder> & { id: string }): Reminder {
  return {
    title: 'تذكير',
    notes: null,
    remind_at: '2026-11-22T10:05:00.000Z',
    status: 'pending',
    repeat_rule: null,
    repeat_anchor: null,
    snooze_until: null,
    fired_at: null,
    acknowledged_at: null,
    source: 'telegram',
    created_at: '2026-11-22T09:00:00.000Z',
    updated_at: '2026-11-22T09:00:00.000Z',
    ...over,
  };
}

const ID = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

class FakeBackend implements Backend {
  rows: Reminder[] = [];
  online = true;
  revoked = false;
  acks: { id: string; action: string; occurrence: string }[] = [];
  handlers: Parameters<Backend['subscribe']>[0] | null = null;

  snapshot() {
    if (!this.online) return Promise.reject(new TypeError('fetch failed'));
    return Promise.resolve(this.rows);
  }
  heartbeat() {
    if (!this.online) return Promise.reject(new TypeError('fetch failed'));
    if (this.revoked) return Promise.reject(new DeviceRevokedError('revoked'));
    return Promise.resolve();
  }
  ack(id: string, action: 'done' | 'snooze', occurrence: string) {
    if (!this.online) return Promise.reject(new TypeError('fetch failed'));
    const r = this.rows.find((x) => x.id === id);
    if (!r) return Promise.reject(new NotFoundError('gone'));
    this.acks.push({ id, action, occurrence });
    const updated = {
      ...r,
      status: action === 'done' ? 'done' : 'snoozed',
      updated_at: new Date().toISOString(),
    } as Reminder;
    if (action === 'snooze') updated.snooze_until = new Date(Date.now() + 600_000).toISOString();
    this.rows = this.rows.map((x) => (x.id === id ? updated : x));
    return Promise.resolve(updated);
  }
  subscribe(h: Parameters<Backend['subscribe']>[0]) {
    this.handlers = h;
    return () => {
      this.handlers = null;
    };
  }
  push(r: Reminder) {
    this.rows = [...this.rows.filter((x) => x.id !== r.id), r];
    this.handlers?.onChange(r);
  }
}

class MemoryStore {
  state: PersistedState | null = null;
  load() {
    return this.state;
  }
  save(s: PersistedState) {
    this.state = structuredClone(s);
  }
}

function hooks() {
  const due: Alert[][] = [];
  const retracted: string[] = [];
  const spies = {
    status: vi.fn<EngineHooks['status']>(),
    revoked: vi.fn<EngineHooks['revoked']>(),
    log: vi.fn<EngineHooks['log']>(),
  };
  const h: EngineHooks = {
    due: (a) => {
      due.push(a);
    },
    retract: (ids) => {
      retracted.push(...ids);
    },
    ...spies,
  };
  return { h, spies, due, retracted, dueIds: () => due.flat().map((a) => a.id) };
}

let backend: FakeBackend;
let store: MemoryStore;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  backend = new FakeBackend();
  store = new MemoryStore();
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = () => vi.advanceTimersByTimeAsync(0);

describe('SyncEngine', () => {
  it('a reminder created via Realtime fires exactly at its due time', async () => {
    const { h, dueIds } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    backend.push(row({ id: ID(1), remind_at: '2026-11-22T10:00:30.000Z' }));
    await vi.advanceTimersByTimeAsync(29_000);
    expect(dueIds()).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(dueIds()).toEqual([ID(1)]);
    e.stop();
  });

  it('falls back to polling when Realtime is down', async () => {
    const { h, dueIds } = hooks();
    const e = new SyncEngine(backend, store, h, { pollMs: 30_000 });
    e.start();
    await flush();
    backend.rows = [row({ id: ID(2), remind_at: '2026-11-22T09:59:00.000Z' })]; // no realtime event
    await vi.advanceTimersByTimeAsync(30_000);
    expect(dueIds()).toContain(ID(2));
    e.stop();
  });

  it('fires from the encrypted local cache while offline, and syncs the action on reconnect', async () => {
    backend.rows = [row({ id: ID(3), remind_at: '2026-11-22T10:01:00.000Z' })];
    const first = hooks();
    const e1 = new SyncEngine(backend, store, first.h);
    e1.start();
    await flush();
    e1.stop();

    // App restarts with no network.
    backend.online = false;
    const { h, spies, due } = hooks();
    const e2 = new SyncEngine(backend, store, h);
    e2.start();
    await vi.advanceTimersByTimeAsync(61_000);
    const alert = due.flat().find((a) => a.id === ID(3))!;
    expect(alert).toBeDefined();
    expect(spies.status).toHaveBeenLastCalledWith('offline');

    e2.act(alert, 'done');
    await flush();
    expect(backend.acks).toEqual([]);
    expect(store.state?.outbox).toHaveLength(1);

    backend.online = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backend.acks).toEqual([
      { id: ID(3), action: 'done', occurrence: '2026-11-22T10:01:00.000Z' },
    ]);
    expect(store.state?.outbox).toHaveLength(0);
    e2.stop();
  });

  it('never alerts twice for the same occurrence (realtime + poll + restart)', async () => {
    const r = row({ id: ID(4), remind_at: '2026-11-22T09:59:00.000Z', status: 'fired' });
    backend.rows = [r];
    const { h, due } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    const alert = due.flat().find((a) => a.id === ID(4))!;
    e.act(alert, 'done');
    await flush();
    backend.handlers?.onChange({ ...r }); // stale realtime echo of the pre-ack row
    await vi.advanceTimersByTimeAsync(90_000);
    e.stop();
    const h2 = hooks();
    const e3 = new SyncEngine(backend, store, h2.h);
    e3.start();
    await vi.advanceTimersByTimeAsync(31_000);
    expect(due.flat().filter((a) => a.id === ID(4))).toHaveLength(1);
    expect(h2.dueIds()).not.toContain(ID(4));
    e3.stop();
  });

  it('retracts an alert handled on another device or deleted from Telegram', async () => {
    backend.rows = [row({ id: ID(5), remind_at: '2026-11-22T09:59:00.000Z', status: 'fired' })];
    const { h, retracted } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    backend.push(row({ id: ID(5), status: 'done', updated_at: '2026-11-22T10:00:10.000Z' }));
    expect(retracted).toContain(ID(5));
    e.stop();
  });

  it('snooze re-fires 10 minutes later', async () => {
    backend.rows = [row({ id: ID(6), remind_at: '2026-11-22T09:59:00.000Z', status: 'fired' })];
    const { h, due } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    e.act(due.flat()[0]!, 'snooze');
    await flush();
    const before = due.flat().length;
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(due.flat().length).toBe(before);
    await vi.advanceTimersByTimeAsync(61_000 + 30_000);
    expect(
      due
        .flat()
        .slice(before)
        .map((a) => a.id),
    ).toContain(ID(6));
    e.stop();
  });

  it('drops a queued action whose reminder was deleted server-side', async () => {
    backend.rows = [row({ id: ID(7), remind_at: '2026-11-22T09:59:00.000Z' })];
    const { h, due } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    backend.online = false;
    e.act(due.flat()[0]!, 'done');
    backend.rows = [];
    backend.online = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(store.state?.outbox).toEqual([]);
    e.stop();
  });

  it('wipes local data and signs out when the device is revoked', async () => {
    backend.rows = [row({ id: ID(8) })];
    const { h, spies } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    expect(store.state?.reminders).toHaveLength(1);
    backend.revoked = true;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(spies.revoked).toHaveBeenCalled();
    expect(store.state?.reminders).toEqual([]);
  });

  it('ignores malformed rows from the network', async () => {
    const { h, spies, dueIds } = hooks();
    const e = new SyncEngine(backend, store, h);
    e.start();
    await flush();
    backend.handlers?.onChange({ id: 'not-a-uuid', title: 42 });
    expect(dueIds()).toEqual([]);
    expect(spies.log).toHaveBeenCalledWith('warn', 'ignored malformed reminder row');
    e.stop();
  });

  it('survives a corrupted local cache', () => {
    store.state = { v: 2 } as unknown as PersistedState;
    const { h } = hooks();
    expect(() => new SyncEngine(backend, store, h)).not.toThrow();
  });
});
