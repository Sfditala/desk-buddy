import type { PetMode } from '../../shared/ipc';
import type { Character } from './characters';

export interface Pose {
  /** Vertical lift in CSS px (positive = up). */
  lift: number;
  scaleX: number;
  scaleY: number;
  /** Radians, around the feet. */
  rotate: number;
}

const TAU = Math.PI * 2;

/**
 * Procedural motion from a single still image. Scales pivot at the feet, so squash & stretch reads
 * as weight. `t` is seconds since the page started; `sinceChange` is seconds in the current mode.
 */
export function pose(mode: PetMode, t: number, sinceChange: number): Pose {
  // Pop on every mode change: a quick squash that settles in ~0.2s.
  const pop = sinceChange < 0.22 ? Math.sin((sinceChange / 0.22) * Math.PI) * 0.06 : 0;
  const base: Pose = { lift: 0, scaleX: 1 + pop, scaleY: 1 - pop, rotate: 0 };

  switch (mode) {
    case 'idle': {
      const b = Math.sin((t * TAU) / 3.2);
      return { ...base, scaleY: base.scaleY + b * 0.012, scaleX: base.scaleX - b * 0.006 };
    }
    case 'walk': {
      const phase = (t * TAU) / 0.62; // one step every ~0.31s
      const step = Math.abs(Math.sin(phase));
      const contact = 1 - step;
      return {
        lift: step * 5,
        scaleX: base.scaleX + contact * 0.035,
        scaleY: base.scaleY - contact * 0.045 + step * 0.015,
        rotate: Math.sin(phase) * 0.035,
      };
    }
    case 'sit': {
      const b = Math.sin((t * TAU) / 4.5);
      return { ...base, scaleY: base.scaleY + b * 0.01 };
    }
    case 'sleep': {
      const b = Math.sin((t * TAU) / 5.5);
      return { ...base, scaleY: base.scaleY + b * 0.022, scaleX: base.scaleX - b * 0.008 };
    }
    case 'alert': {
      // Hop + landing squash every 1.1s, with a little shake in the air.
      const cycle = (sinceChange % 1.1) / 1.1;
      const air = cycle < 0.45 ? Math.sin((cycle / 0.45) * Math.PI) : 0;
      const land = cycle >= 0.45 && cycle < 0.6 ? Math.sin(((cycle - 0.45) / 0.15) * Math.PI) : 0;
      return {
        lift: air * 16,
        scaleX: 1 + land * 0.09 - air * 0.03,
        scaleY: 1 - land * 0.11 + air * 0.05,
        rotate: air * Math.sin(sinceChange * 40) * 0.05,
      };
    }
    case 'happy': {
      const cycle = (sinceChange % 0.45) / 0.45;
      const air = Math.sin(cycle * Math.PI);
      return { lift: air * 12, scaleX: 1 - air * 0.03, scaleY: 1 + air * 0.05, rotate: 0 };
    }
  }
}

interface View {
  mode: PetMode;
  dir: 1 | -1;
  offsetX: number;
}

/** Canvas renderer for the character plus small overlays (!, Zzz, ♥). */
export class Stage {
  private readonly ctx: CanvasRenderingContext2D;
  private character: Character | null = null;
  private view: View = { mode: 'idle', dir: -1, offsetX: 190 };
  private modeSince = 0;
  private nextBlink = 2;
  private blinkUntil = 0;
  private frame = 0;
  private readonly start = performance.now();
  /** Last drawn sprite rect in CSS px, for the bubble anchor and hit-testing. */
  bounds = { x: 0, y: 0, w: 0, h: 0 };

  constructor(private readonly canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('2d context unavailable');
    this.ctx = ctx;
    this.resize();
    window.addEventListener('resize', () => {
      this.resize();
    });
  }

  setCharacter(c: Character): void {
    this.character = c;
    this.modeSince = this.now();
  }

  setView(v: View): void {
    if (v.mode !== this.view.mode) this.modeSince = this.now();
    this.view = v;
  }

  /** Restart the current mode's timeline (used for nags so the hop replays). */
  replay(): void {
    this.modeSince = this.now();
  }

  run(): void {
    const loop = () => {
      this.draw();
      this.frame = requestAnimationFrame(loop);
    };
    this.frame = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.frame);
  }

  /** True if the CSS-px point is over a non-transparent character pixel. */
  hit(x: number, y: number): boolean {
    const b = this.bounds;
    if (x < b.x || x > b.x + b.w || y < b.y || y > b.y + b.h) return false;
    const dpr = window.devicePixelRatio || 1;
    const px = this.ctx.getImageData(Math.floor(x * dpr), Math.floor(y * dpr), 1, 1).data;
    return (px[3] ?? 0) > 24;
  }

  private now(): number {
    return (performance.now() - this.start) / 1000;
  }

  private resize(): void {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(window.innerWidth * dpr);
    this.canvas.height = Math.round(window.innerHeight * dpr);
  }

  private draw(): void {
    const { ctx, canvas } = this;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const c = this.character;
    if (!c) return;

    const t = this.now();
    const since = t - this.modeSince;
    const { mode, dir, offsetX } = this.view;
    const state = c.states[mode];
    const p = pose(mode, t, since);

    // Blink every 2–6s for ~130ms, only where a closed-eye frame exists.
    if (t > this.nextBlink) {
      this.blinkUntil = t + 0.13;
      this.nextBlink = t + 2 + Math.random() * 4;
    }
    const img = state.blink && t < this.blinkUntil ? state.blink : state.image;

    const frames = Math.max(1, state.spec.frames ?? 1);
    const frameW = img.naturalWidth / frames;
    const frameIdx = frames > 1 ? Math.floor(t * (state.spec.fps ?? 8)) % frames : 0;
    const w = frameW * c.manifest.scale;
    const h = img.naturalHeight * c.manifest.scale;
    const floor = window.innerHeight - 4;

    const facing = state.spec.facing ?? 'right';
    const flip = facing === 'none' ? false : (facing === 'right') !== (dir === 1);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = !c.manifest.pixelated;
    ctx.imageSmoothingQuality = 'high';

    // Ground shadow shrinks as the character lifts.
    ctx.save();
    ctx.globalAlpha = 0.18 * (1 - Math.min(p.lift / 30, 0.6));
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(offsetX, floor, w * 0.32 * (1 - p.lift / 80), 4, 0, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.save();
    ctx.translate(offsetX, floor - p.lift);
    ctx.rotate(p.rotate);
    ctx.scale(p.scaleX * (flip ? -1 : 1), p.scaleY);
    ctx.drawImage(img, frameIdx * frameW, 0, frameW, img.naturalHeight, -w / 2, -h, w, h);
    ctx.restore();

    this.bounds = {
      x: offsetX - w / 2,
      y: floor - p.lift - h * p.scaleY,
      w,
      h: h * p.scaleY + p.lift,
    };
    this.drawOverlay(mode, t, since, offsetX, this.bounds.y);
  }

  private drawOverlay(mode: PetMode, t: number, since: number, cx: number, top: number): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    if (mode === 'alert') {
      const s = 1 + Math.sin(since * 12) * 0.08;
      ctx.translate(cx + 34, top - 2);
      ctx.scale(s, s);
      ctx.font = '800 30px "IBM Plex Sans Arabic", system-ui, sans-serif';
      ctx.lineWidth = 5;
      ctx.strokeStyle = '#2a2230';
      ctx.fillStyle = '#ffd23f';
      ctx.strokeText('!', 0, 0);
      ctx.fillText('!', 0, 0);
    } else if (mode === 'sleep') {
      ctx.font = '700 16px "IBM Plex Sans Arabic", system-ui, sans-serif';
      ctx.fillStyle = '#4b5b8a';
      for (let i = 0; i < 3; i++) {
        const k = (t * 0.45 + i / 3) % 1;
        ctx.globalAlpha = Math.sin(k * Math.PI);
        ctx.fillText('z', cx + 30 + k * 24, top + 10 - k * 40 - i * 2);
      }
    } else if (mode === 'happy') {
      const k = Math.min(since / 1.2, 1);
      ctx.globalAlpha = 1 - k;
      ctx.font = '22px system-ui, sans-serif';
      ctx.fillStyle = '#e0435c';
      ctx.fillText('♥', cx + 30, top - k * 30);
    }
    ctx.restore();
  }
}
