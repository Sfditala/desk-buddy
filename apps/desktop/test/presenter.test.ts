import { NAG_INTERVAL_MS } from '@desk-buddy/core';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { Alert, PresenterPorts as Ports } from '../src/main/reminders/presenter';

vi.mock('../src/main/logger', () => ({
  scoped: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

const { AlertPresenter, formatWhen } = await import('../src/main/reminders/presenter');

function alert(id: string, minute: number, key = `${id}@${minute}`): Alert {
  return {
    id,
    key,
    title: `t-${id}`,
    notes: null,
    dueAt: new Date(Date.UTC(2026, 10, 22, 8, minute)),
  };
}

describe('AlertPresenter', () => {
  let ports: { [K in keyof Ports]: Mock<Ports[K]> };
  let p: InstanceType<typeof AlertPresenter>;

  beforeEach(() => {
    vi.useFakeTimers();
    ports = {
      show: vi.fn<Ports['show']>(),
      hide: vi.fn<Ports['hide']>(),
      nag: vi.fn<Ports['nag']>(),
      setAlerting: vi.fn<Ports['setAlerting']>(),
      onAction: vi.fn<Ports['onAction']>(),
    };
    p = new AlertPresenter(ports);
  });

  it('shows the oldest alert first and queues the rest', () => {
    p.push([alert('b', 5), alert('a', 1)]);
    expect(p.showing?.id).toBe('a');
    expect(ports.show).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'a', queued: 1 }));
    expect(ports.setAlerting).toHaveBeenLastCalledWith(true);
  });

  it('never shows the same occurrence twice (realtime + polling echoes)', () => {
    p.push([alert('a', 1)]);
    p.push([alert('a', 1)]);
    p.push([alert('a', 1)]);
    expect(ports.show).toHaveBeenCalledTimes(1);
    expect(p.pending).toHaveLength(0);
  });

  it('re-nags until acknowledged, then stops', () => {
    p.push([alert('a', 1)]);
    vi.advanceTimersByTime(NAG_INTERVAL_MS * 2 + 1);
    expect(ports.nag).toHaveBeenCalledTimes(2);
    p.handleAction({ id: 'a', action: 'done' });
    vi.advanceTimersByTime(NAG_INTERVAL_MS * 3);
    expect(ports.nag).toHaveBeenCalledTimes(2);
    expect(ports.onAction).toHaveBeenCalledWith(expect.objectContaining({ id: 'a' }), 'done');
    expect(ports.setAlerting).toHaveBeenLastCalledWith(false);
  });

  it('advances to the next alert after an action', () => {
    p.push([alert('a', 1), alert('b', 2)]);
    p.handleAction({ id: 'a', action: 'snooze' });
    expect(p.showing?.id).toBe('b');
    expect(ports.hide).toHaveBeenCalledWith('a');
  });

  it('ignores actions for an alert that is not on screen', () => {
    p.push([alert('a', 1), alert('b', 2)]);
    p.handleAction({ id: 'b', action: 'done' });
    expect(ports.onAction).not.toHaveBeenCalled();
    expect(p.showing?.id).toBe('a');
  });

  it('retracts an alert handled elsewhere', () => {
    p.push([alert('a', 1), alert('b', 2)]);
    p.retract('a');
    expect(ports.hide).toHaveBeenCalledWith('a');
    expect(p.showing?.id).toBe('b');
    p.retract('b');
    expect(p.showing).toBeNull();
    expect(ports.setAlerting).toHaveBeenLastCalledWith(false);
  });

  it('holds alerts while paused and shows them on resume', () => {
    p.setPaused(true);
    p.push([alert('a', 1)]);
    expect(ports.show).not.toHaveBeenCalled();
    p.setPaused(false);
    expect(p.showing?.id).toBe('a');
  });

  it('pausing mid-alert keeps it for later', () => {
    p.push([alert('a', 1)]);
    p.setPaused(true);
    expect(p.showing).toBeNull();
    p.setPaused(false);
    expect(p.showing?.id).toBe('a');
  });

  it('a newer occurrence of the same reminder replaces a stale queued one', () => {
    p.push([alert('x', 0), alert('a', 1)]);
    p.push([alert('a', 30, 'a@snoozed')]);
    expect(p.pending.map((a) => a.key)).toEqual(['a@snoozed']);
  });
});

describe('formatWhen', () => {
  it('formats in Asia/Hebron', () => {
    expect(formatWhen(new Date('2026-11-22T07:00:00Z'))).toBe('09:00 · Sun 22 Nov');
  });
});
