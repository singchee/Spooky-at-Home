/**
 * Looping recorded files that were not made as seamless loops: each pass starts before the
 * previous one ends and the two crossfade with equal-power curves (sin/cos), so the join keeps a
 * steady loudness instead of a gap or a bump. With a known tempo the loop length is a whole number
 * of bars, so the beat carries straight across the join. Several stems (the mission's calm, tense
 * and overrun layers) loop on one shared clock, so they stay in sync for as long as they play.
 */
import type { Kit } from './kit';

/** Default crossfade at the loop point (s). */
export const LOOP_OVERLAP = 1.5;

export interface LoopTiming {
  /** Seconds from the start of one pass to the start of the next. */
  period: number;
  /** Seconds the passes overlap (crossfade length) = duration - period. */
  overlap: number;
}

/**
 * Loop timing for a file of `duration` seconds: at least `overlap` of crossfade (capped at half the
 * file), and, if `beat` (s) is given, a period of whole bars so the rhythm lines up across the join.
 */
export function loopTiming(duration: number, opts: { beat?: number; beatsPerBar?: number; overlap?: number } = {}): LoopTiming {
  const d = Number.isFinite(duration) && duration > 0 ? duration : 0;
  if (d === 0) return { period: 1, overlap: 0 };
  const ov = Math.min(opts.overlap ?? LOOP_OVERLAP, d / 2);
  let period = d - ov;
  if (opts.beat && opts.beat > 0) {
    const bar = opts.beat * (opts.beatsPerBar ?? 4);
    const bars = Math.floor(period / bar + 1e-6);
    // Only snap if it keeps the crossfade within half the file.
    if (bars >= 1 && bars * bar >= d / 2) period = bars * bar;
  }
  return { period, overlap: d - period };
}

/** Equal-power fade: gain at fraction x (0..1) of the crossfade. */
export const fadeIn = (x: number): number => Math.sin((Math.max(0, Math.min(1, x)) * Math.PI) / 2);
export const fadeOut = (x: number): number => Math.cos((Math.max(0, Math.min(1, x)) * Math.PI) / 2);

/**
 * Gain of one pass `tIn` seconds after it started. The first pass starts at full (the score's own
 * fade-in covers it); later ones fade in over the overlap; every pass fades out over its last
 * `overlap` seconds.
 */
export function passGain(tIn: number, duration: number, timing: LoopTiming, first: boolean): number {
  if (tIn < 0 || tIn > duration) return 0;
  const ov = timing.overlap;
  if (ov <= 0) return 1;
  let g = 1;
  if (!first && tIn < ov) g *= fadeIn(tIn / ov);
  if (tIn > timing.period) g *= fadeOut((tIn - timing.period) / ov);
  return g;
}

/** Sampled curve for setValueCurveAtTime. */
export function curve(f: (x: number) => number, n = 64): Float32Array {
  const c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = f(i / (n - 1));
  return c;
}
const IN = curve(fadeIn);
const OUT = curve(fadeOut);

/** How far ahead (s) passes are scheduled. Must exceed the engine's tick interval. */
const LOOKAHEAD = 0.5;

/**
 * One or more buffers looping together on a shared clock, each into its own destination.
 * Buffers should be the same length; the first one sets the timing.
 */
export class StemLoop {
  private timing: LoopTiming;
  private duration: number;
  private next: number;
  private passes = 0;

  constructor(
    private ctx: BaseAudioContext,
    private kit: Kit,
    private stems: { buffer: AudioBuffer; dest: AudioNode }[],
    opts: { beat?: number; overlap?: number; at?: number } = {},
  ) {
    this.duration = stems[0]?.buffer.duration ?? 0;
    this.timing = loopTiming(this.duration, opts);
    this.next = opts.at ?? ctx.currentTime + 0.05;
  }

  /** Schedule passes due within the lookahead. Call ~20 times a second with the audio clock. */
  tick(now: number): void {
    if (!this.duration) return;
    // After a long stall (the clock jumped), start afresh from now rather than stacking passes.
    if (this.next < now - this.timing.overlap) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      this.schedule(this.next, this.passes === 0);
      this.passes++;
      this.next += this.timing.period;
    }
  }

  private schedule(t: number, first: boolean): void {
    const { ctx, kit, timing } = this;
    const ov = timing.overlap;
    for (const s of this.stems) {
      const src = ctx.createBufferSource();
      src.buffer = s.buffer;
      const g = ctx.createGain();
      if (ov > 0) {
        if (first) g.gain.setValueAtTime(1, t);
        else g.gain.setValueCurveAtTime(IN, t, ov);
        g.gain.setValueCurveAtTime(OUT, t + timing.period, ov);
      }
      src.connect(g).connect(s.dest);
      kit.play(src, t, t + this.duration + 0.02, g);
    }
  }
}
