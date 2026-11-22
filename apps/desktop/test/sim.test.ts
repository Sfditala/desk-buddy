import { describe, expect, it } from 'vitest';
import {
  celebrate,
  initialState,
  PET_TUNING,
  tick,
  type PetState,
  type Segment,
  type TickInput,
} from '../src/main/pet/sim';

const LEFT: Segment = { id: 1, left: 0, right: 1920, bottom: 1040 };
const RIGHT: Segment = { id: 2, left: 1920, right: 3840, bottom: 1400 };

const fixed = (v: number) => () => v;

function input(over: Partial<TickInput> = {}): TickInput {
  return {
    now: 10_000,
    dt: 1 / 60,
    segments: [LEFT],
    alerting: false,
    paused: false,
    systemIdleSec: 0,
    halfWidth: 50,
    ...over,
  };
}

function walking(over: Partial<PetState> = {}): PetState {
  return { mode: 'walk', x: 500, dir: 1, segmentId: 1, until: Infinity, ...over };
}

describe('pet sim', () => {
  it('starts idle on the first display', () => {
    expect(initialState([LEFT, RIGHT], 0)).toMatchObject({ mode: 'idle', segmentId: 1 });
  });

  it('walks at the configured speed', () => {
    const next = tick(walking(), input({ dt: 1 }), fixed(0.5));
    expect(next.x).toBeCloseTo(500 + PET_TUNING.walkSpeed);
  });

  it('turns around at a screen edge with no neighbour', () => {
    const next = tick(walking({ x: 1869 }), input({ dt: 1 }), fixed(0.5));
    expect(next).toMatchObject({ x: 1870, dir: -1, segmentId: 1 });
  });

  it('crosses onto an adjacent monitor', () => {
    const next = tick(walking({ x: 1869 }), input({ dt: 1, segments: [LEFT, RIGHT] }), fixed(0.5));
    expect(next.segmentId).toBe(2);
    expect(next.dir).toBe(1);
  });

  it('does not cross to a monitor that is not adjacent', () => {
    const far = { ...RIGHT, left: 2000 };
    const next = tick(walking({ x: 1869 }), input({ dt: 1, segments: [LEFT, far] }), fixed(0.5));
    expect(next).toMatchObject({ segmentId: 1, dir: -1 });
  });

  it('recovers when its monitor is unplugged', () => {
    const next = tick(walking({ segmentId: 2, x: 3000 }), input({ segments: [LEFT] }), fixed(0.5));
    expect(next.segmentId).toBe(1);
    expect(next.x).toBeLessThanOrEqual(1870);
  });

  it('alert overrides everything and stops walking', () => {
    const s = tick(walking(), input({ alerting: true, systemIdleSec: 9999 }), fixed(0.5));
    expect(s.mode).toBe('alert');
    expect(tick(s, input({ alerting: true, dt: 5 }), fixed(0.5)).x).toBe(500);
  });

  it('sleeps after long system idle and wakes on activity', () => {
    const asleep = tick(walking(), input({ systemIdleSec: PET_TUNING.sleepAfterSec }), fixed(0.5));
    expect(asleep.mode).toBe('sleep');
    expect(tick(asleep, input({ systemIdleSec: 60 }), fixed(0.5)).mode).toBe('sleep');
    expect(tick(asleep, input({ systemIdleSec: 0 }), fixed(0.5)).mode).toBe('idle');
  });

  it('sits still while paused, then resumes', () => {
    const paused = tick(walking(), input({ paused: true }), fixed(0.5));
    expect(paused.mode).toBe('sit');
    expect(tick(paused, input({ paused: true, dt: 10 }), fixed(0.5)).x).toBe(500);
    expect(tick(paused, input(), fixed(0.1)).mode).toBe('idle');
  });

  it('plays happy after acknowledging, then returns to idle', () => {
    const happy = celebrate(walking(), 10_000);
    expect(tick(happy, input({ now: 11_000 }), fixed(0.5)).mode).toBe('happy');
    expect(tick(happy, input({ now: 10_000 + PET_TUNING.happyMs }), fixed(0.9)).mode).toBe('idle');
  });

  it('chooses random behaviours when the current one ends', () => {
    const idle: PetState = { mode: 'idle', x: 500, dir: 1, segmentId: 1, until: 0 };
    expect(tick(idle, input(), fixed(0.1)).mode).toBe('walk');
    expect(tick(idle, input(), fixed(0.6)).mode).toBe('sit');
    expect(tick(idle, input(), fixed(0.9)).mode).toBe('idle');
  });
});
