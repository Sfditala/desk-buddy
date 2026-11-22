export interface VisibilityPorts {
  show(): void;
  hide(): void;
}

export interface VisibilityTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/**
 * Decides when the pet window is on screen.
 * - `onlyForReminders` (default): hidden until an alert arrives; after Done/Snooze it lingers for
 *   `lingerMs` so the happy animation can play, then hides.
 * - otherwise: always visible once the renderer is ready.
 * `peek()` shows it briefly (tray test, launching the app again) in reminders-only mode.
 */
export class PetVisibility {
  private onlyForReminders: boolean;
  private ready = false;
  private alerting = false;
  private peeking = false;
  private visible = false;
  private hideTimer: unknown = null;
  private peekTimer: unknown = null;

  constructor(
    private readonly ports: VisibilityPorts,
    opts: { onlyForReminders: boolean; lingerMs?: number; peekMs?: number },
    private readonly timers: VisibilityTimers = {
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (h) => {
        clearTimeout(h as NodeJS.Timeout);
      },
    },
  ) {
    this.onlyForReminders = opts.onlyForReminders;
    this.lingerMs = opts.lingerMs ?? 2_500;
    this.peekMs = opts.peekMs ?? 6_000;
  }

  private readonly lingerMs: number;
  private readonly peekMs: number;

  get isVisible(): boolean {
    return this.visible;
  }

  setReady(ready: boolean): void {
    this.ready = ready;
    if (!ready) this.visible = false; // window was recreated; it starts hidden
    this.apply(true);
  }

  setOnlyForReminders(on: boolean): void {
    this.onlyForReminders = on;
    this.apply(true);
  }

  setAlerting(on: boolean): void {
    this.alerting = on;
    this.apply(false);
  }

  peek(): void {
    if (!this.onlyForReminders) return;
    this.peeking = true;
    if (this.peekTimer !== null) this.timers.clearTimeout(this.peekTimer);
    this.peekTimer = this.timers.setTimeout(() => {
      this.peeking = false;
      this.peekTimer = null;
      this.apply(false);
    }, this.peekMs);
    this.apply(false);
  }

  private wanted(): boolean {
    return this.ready && (!this.onlyForReminders || this.alerting || this.peeking);
  }

  private apply(immediate: boolean): void {
    if (this.wanted()) {
      this.cancelHide();
      if (!this.visible) {
        this.visible = true;
        this.ports.show();
      }
      return;
    }
    if (!this.visible) return;
    if (immediate || !this.ready) {
      this.cancelHide();
      this.visible = false;
      this.ports.hide();
      return;
    }
    if (this.hideTimer !== null) return;
    this.hideTimer = this.timers.setTimeout(() => {
      this.hideTimer = null;
      if (!this.wanted() && this.visible) {
        this.visible = false;
        this.ports.hide();
      }
    }, this.lingerMs);
  }

  private cancelHide(): void {
    if (this.hideTimer !== null) this.timers.clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }
}
