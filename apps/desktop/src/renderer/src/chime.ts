/**
 * A soft two-note chime synthesised with WebAudio: no audio asset, no licensing, and quiet by
 * design (peak gain 0.12, gentle attack, long release).
 */
let ctx: AudioContext | null = null;

function note(ac: AudioContext, freq: number, at: number, dur: number, gain: number): void {
  const osc = ac.createOscillator();
  const overtone = ac.createOscillator();
  const env = ac.createGain();
  osc.type = 'sine';
  overtone.type = 'sine';
  osc.frequency.value = freq;
  overtone.frequency.value = freq * 2;
  const over = ac.createGain();
  over.gain.value = 0.18;
  env.gain.setValueAtTime(0, at);
  env.gain.linearRampToValueAtTime(gain, at + 0.02);
  env.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  osc.connect(env);
  overtone.connect(over).connect(env);
  env.connect(ac.destination);
  osc.start(at);
  overtone.start(at);
  osc.stop(at + dur + 0.05);
  overtone.stop(at + dur + 0.05);
}

export function playChime(): void {
  try {
    ctx ??= new AudioContext();
    if (ctx.state === 'suspended') void ctx.resume();
    const t = ctx.currentTime + 0.01;
    note(ctx, 880, t, 0.9, 0.12); // A5
    note(ctx, 1318.5, t + 0.16, 1.2, 0.1); // E6
  } catch {
    /* audio device unavailable: alert still shows */
  }
}
