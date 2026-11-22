import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PetVisibility } from '../src/main/pet/visibility';

describe('PetVisibility', () => {
  let show: ReturnType<typeof vi.fn<() => void>>;
  let hide: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.useFakeTimers();
    show = vi.fn<() => void>();
    hide = vi.fn<() => void>();
  });

  const make = (onlyForReminders: boolean) =>
    new PetVisibility({ show, hide }, { onlyForReminders, lingerMs: 2_500, peekMs: 6_000 });

  it('reminders-only: stays hidden until an alert arrives', () => {
    const v = make(true);
    v.setReady(true);
    expect(show).not.toHaveBeenCalled();
    v.setAlerting(true);
    expect(show).toHaveBeenCalledTimes(1);
    expect(v.isVisible).toBe(true);
  });

  it('reminders-only: lingers after Done so the happy animation plays, then hides', () => {
    const v = make(true);
    v.setReady(true);
    v.setAlerting(true);
    v.setAlerting(false);
    vi.advanceTimersByTime(2_400);
    expect(hide).not.toHaveBeenCalled();
    vi.advanceTimersByTime(200);
    expect(hide).toHaveBeenCalledTimes(1);
    expect(v.isVisible).toBe(false);
  });

  it('reminders-only: a new alert during the linger keeps it on screen', () => {
    const v = make(true);
    v.setReady(true);
    v.setAlerting(true);
    v.setAlerting(false);
    vi.advanceTimersByTime(1_000);
    v.setAlerting(true);
    vi.advanceTimersByTime(10_000);
    expect(hide).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('always mode: visible as soon as the renderer is ready, never hidden by alerts ending', () => {
    const v = make(false);
    v.setReady(true);
    expect(show).toHaveBeenCalledTimes(1);
    v.setAlerting(true);
    v.setAlerting(false);
    vi.advanceTimersByTime(60_000);
    expect(hide).not.toHaveBeenCalled();
  });

  it('switching to reminders-only hides immediately when nothing is due', () => {
    const v = make(false);
    v.setReady(true);
    v.setOnlyForReminders(true);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('switching to always shows immediately', () => {
    const v = make(true);
    v.setReady(true);
    v.setOnlyForReminders(false);
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('peek shows briefly in reminders-only mode', () => {
    const v = make(true);
    v.setReady(true);
    v.peek();
    expect(show).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(6_000 + 2_500);
    expect(hide).toHaveBeenCalledTimes(1);
  });

  it('an alert that arrives before the renderer is ready shows once it is ready', () => {
    const v = make(true);
    v.setAlerting(true);
    expect(show).not.toHaveBeenCalled();
    v.setReady(true);
    expect(show).toHaveBeenCalledTimes(1);
  });
});
