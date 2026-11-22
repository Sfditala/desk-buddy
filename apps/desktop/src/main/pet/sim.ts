import type { PetMode } from '../../shared/ipc';

/** A display's work area (excludes taskbar), in global DIP coordinates. */
export interface Segment {
  id: number;
  left: number;
  right: number;
  bottom: number;
}

export interface PetState {
  mode: PetMode;
  /** Character centre, global DIP X. */
  x: number;
  dir: 1 | -1;
  segmentId: number;
  /** Epoch ms at which the current autonomous behaviour ends. */
  until: number;
}

export interface TickInput {
  now: number;
  /** Seconds since the previous tick (clamped by the caller). */
  dt: number;
  segments: readonly Segment[];
  alerting: boolean;
  paused: boolean;
  systemIdleSec: number;
  /** Half the character's width, so it never walks off-screen. */
  halfWidth: number;
}

export type Rng = () => number;

export const PET_TUNING = {
  walkSpeed: 46, // DIP/s
  sleepAfterSec: 5 * 60,
  wakeBelowSec: 3,
  happyMs: 1800,
  edgeJoinTolerance: 2,
  durations: {
    idle: [3_000, 8_000],
    walk: [4_000, 12_000],
    sit: [10_000, 25_000],
  },
} as const;

const between = (rng: Rng, [a, b]: readonly [number, number]) => a + (b - a) * rng();

export function initialState(segments: readonly Segment[], now: number): PetState {
  const seg = segments[0];
  if (!seg) throw new Error('no displays');
  return {
    mode: 'idle',
    x: seg.left + (seg.right - seg.left) * 0.75,
    dir: -1,
    segmentId: seg.id,
    until: now + 2_000,
  };
}

/** Called when the user acknowledges a reminder or pokes the pet. */
export function celebrate(state: PetState, now: number): PetState {
  return { ...state, mode: 'happy', until: now + PET_TUNING.happyMs };
}

function nextBehaviour(state: PetState, now: number, rng: Rng): PetState {
  const r = rng();
  let mode: 'idle' | 'walk' | 'sit';
  switch (state.mode) {
    case 'walk':
      mode = r < 0.7 ? 'idle' : 'sit';
      break;
    case 'idle':
      mode = r < 0.55 ? 'walk' : r < 0.7 ? 'sit' : 'idle';
      break;
    default:
      mode = 'idle';
  }
  const dir: 1 | -1 = mode === 'walk' && rng() < 0.35 ? (state.dir === 1 ? -1 : 1) : state.dir;
  const range = PET_TUNING.durations[mode];
  return { ...state, mode, dir, until: now + between(rng, range) };
}

function clampToSegments(state: PetState, input: TickInput): PetState {
  const seg = input.segments.find((s) => s.id === state.segmentId) ?? input.segments[0];
  if (!seg) return state;
  const min = seg.left + input.halfWidth;
  const max = seg.right - input.halfWidth;
  return { ...state, segmentId: seg.id, x: Math.min(Math.max(state.x, min), max) };
}

function walk(state: PetState, input: TickInput): PetState {
  const seg = input.segments.find((s) => s.id === state.segmentId);
  if (!seg) return state;
  const x = state.x + state.dir * PET_TUNING.walkSpeed * input.dt;
  const min = seg.left + input.halfWidth;
  const max = seg.right - input.halfWidth;
  if (x >= min && x <= max) return { ...state, x };

  // At an edge: cross onto a horizontally adjacent display, otherwise turn around.
  const tol = PET_TUNING.edgeJoinTolerance;
  const neighbour = input.segments.find((s) =>
    state.dir === 1 ? Math.abs(s.left - seg.right) <= tol : Math.abs(s.right - seg.left) <= tol,
  );
  if (neighbour) return { ...state, x, segmentId: neighbour.id };
  return { ...state, x: x > max ? max : min, dir: -state.dir as 1 | -1 };
}

export function tick(prev: PetState, input: TickInput, rng: Rng): PetState {
  let s = clampToSegments(prev, input);
  const { now } = input;

  if (input.alerting) return s.mode === 'alert' ? s : { ...s, mode: 'alert', until: Infinity };
  if (s.mode === 'alert') s = { ...s, mode: 'idle', until: now + 1_500 };

  if (s.mode === 'happy') {
    if (now < s.until) return s;
    s = { ...s, mode: 'idle', until: now + between(rng, PET_TUNING.durations.idle) };
  }

  if (s.mode === 'sleep') {
    if (input.systemIdleSec >= PET_TUNING.wakeBelowSec) return s;
    return { ...s, mode: 'idle', until: now + 2_500 };
  }
  if (input.systemIdleSec >= PET_TUNING.sleepAfterSec)
    return { ...s, mode: 'sleep', until: Infinity };

  if (input.paused) return s.mode === 'sit' ? s : { ...s, mode: 'sit', until: Infinity };
  if (s.mode === 'sit' && s.until === Infinity) s = { ...s, until: now };

  if (now >= s.until) s = nextBehaviour(s, now, rng);
  return s.mode === 'walk' ? walk(s, input) : s;
}
