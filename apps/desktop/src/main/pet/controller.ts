import { powerMonitor, screen, type BrowserWindow } from 'electron';
import { PET_WINDOW, type PetMode, type StateMsg } from '../../shared/ipc';
import type { PetIpc } from '../ipc';
import { scoped } from '../logger';
import { celebrate, initialState, tick, type PetState, type Segment } from './sim';

const log = scoped('pet');
const TICK_MS = 1000 / 60;
/** Approximate half-width of the sprite, keeps the character itself on-screen. */
const HALF_CHARACTER = 60;

/**
 * Drives the pure simulation and maps it onto a small moving window. Only the window moves; the
 * renderer animates the sprite in place, so IPC traffic is limited to mode/offset changes.
 */
export class PetController {
  private state: PetState;
  private segments: Segment[] = [];
  private timer: NodeJS.Timeout | null = null;
  private last = Date.now();
  private lastSent: StateMsg | null = null;
  private lastBounds = { x: Number.NaN, y: Number.NaN };
  private idleSec = 0;
  private idlePolledAt = 0;
  alerting = false;
  paused = false;

  constructor(
    private readonly win: BrowserWindow,
    private readonly ipc: PetIpc,
  ) {
    this.refreshDisplays();
    this.state = initialState(this.segments, Date.now());
    screen.on('display-added', this.onDisplaysChanged);
    screen.on('display-removed', this.onDisplaysChanged);
    screen.on('display-metrics-changed', this.onDisplaysChanged);
  }

  private readonly onDisplaysChanged = (): void => {
    this.refreshDisplays();
  };

  /** Stop and detach from global `screen` events (the controller is recreated after a crash). */
  dispose(): void {
    this.stop();
    screen.removeListener('display-added', this.onDisplaysChanged);
    screen.removeListener('display-removed', this.onDisplaysChanged);
    screen.removeListener('display-metrics-changed', this.onDisplaysChanged);
  }

  start(): void {
    if (this.timer) return;
    this.last = Date.now();
    this.timer = setInterval(() => {
      this.step();
    }, TICK_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  get mode(): PetMode {
    return this.state.mode;
  }

  celebrate(): void {
    this.state = celebrate(this.state, Date.now());
    this.step();
  }

  private refreshDisplays(): void {
    const primary = screen.getPrimaryDisplay();
    const displays = screen.getAllDisplays();
    // Primary first so a fresh start (or a lost monitor) lands on the main screen.
    displays.sort((a, b) =>
      a.id === primary.id ? -1 : b.id === primary.id ? 1 : a.workArea.x - b.workArea.x,
    );
    this.segments = displays.map((d) => ({
      id: d.id,
      left: d.workArea.x,
      right: d.workArea.x + d.workArea.width,
      bottom: d.workArea.y + d.workArea.height,
    }));
    log.info('displays', { count: this.segments.length });
  }

  private step(): void {
    if (this.win.isDestroyed()) {
      this.stop();
      return;
    }
    const now = Date.now();
    const dt = Math.min((now - this.last) / 1000, 0.25); // clamp after sleep/resume
    this.last = now;
    if (now - this.idlePolledAt > 1000) {
      this.idleSec = powerMonitor.getSystemIdleTime();
      this.idlePolledAt = now;
    }

    this.state = tick(
      this.state,
      {
        now,
        dt,
        segments: this.segments,
        alerting: this.alerting,
        paused: this.paused,
        systemIdleSec: this.idleSec,
        halfWidth: HALF_CHARACTER,
      },
      Math.random,
    );
    this.place();
  }

  private place(): void {
    const seg = this.segments.find((s) => s.id === this.state.segmentId);
    if (!seg) return;
    const x = Math.round(
      Math.min(
        Math.max(this.state.x - PET_WINDOW.width / 2, seg.left),
        seg.right - PET_WINDOW.width,
      ),
    );
    const y = Math.round(seg.bottom - PET_WINDOW.height);
    if (x !== this.lastBounds.x || y !== this.lastBounds.y) {
      this.win.setBounds({ x, y, width: PET_WINDOW.width, height: PET_WINDOW.height });
      this.lastBounds = { x, y };
    }
    const msg: StateMsg = {
      mode: this.state.mode,
      dir: this.state.dir,
      offsetX: Math.round(this.state.x - x),
    };
    const prev = this.lastSent;
    if (prev?.mode !== msg.mode) log.debug('mode', { mode: msg.mode, x: Math.round(this.state.x) });
    if (!prev || prev.mode !== msg.mode || prev.dir !== msg.dir || prev.offsetX !== msg.offsetX) {
      this.ipc.send('pet:state', msg);
      this.lastSent = msg;
    }
  }
}
