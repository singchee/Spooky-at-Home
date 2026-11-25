/**
 * The generative score: a dark, slightly silly night-ops soundtrack synthesised in code.
 *
 * Four layers crossfade with the threat (see layerWeights): a low drone and minor-key pad, a soft
 * bass pulse, an occasional out-of-tune music-box motif (the dark joke), and at the top a low drum
 * and a queasy high cluster. The menu variant is slower, with no pulse or drums.
 *
 * Comfort: nothing in the score starts notes faster than MAX_ONSETS_PER_SEC, every note has a soft
 * attack, and layers fade over seconds, never switch.
 *
 * A recorded track can replace this later (issue #10): anything that implements `Score` plugs into
 * the engine. A stem-based track would loop one file per layer and set each stem's gain from
 * layerWeights(intensity, mode), so it follows the threat exactly as this one does.
 */
import { mulberry32, type Rng } from '../util/rng';
import { IntensitySmoother } from './intensity';
import { Kit, hz } from './kit';

export type ScoreMode = 'menu' | 'mission';

/** What the audio engine needs from a soundtrack, generated or recorded. */
export interface Score {
  readonly mode: ScoreMode;
  /** The threat target, 0..1 (smoothed inside). */
  setIntensity(x: number): void;
  /** The smoothed intensity the score is playing at now. */
  readonly intensity: number;
  /** Called ~20 times a second with the audio clock. */
  tick(now: number): void;
  /** Fade out over `fade` seconds, then free everything. */
  stop(fade: number): void;
  readonly done: boolean;
  dispose(): void;
}

export interface LayerWeights {
  pad: number;
  pulse: number;
  motif: number;
  tension: number;
}

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);
const ramp = (x: number, a: number, b: number) => clamp01((x - a) / (b - a));

/** How loud each layer is at a given threat (all 0..1). Shared by any score, generated or recorded. */
export function layerWeights(intensity: number, mode: ScoreMode): LayerWeights {
  if (mode === 'menu') return { pad: 1, pulse: 0, motif: 1, tension: 0 };
  const x = clamp01(intensity);
  return {
    pad: 1 - 0.25 * ramp(x, 0.6, 1),
    pulse: ramp(x, 0.15, 0.45),
    motif: 0.5 + 0.5 * ramp(x, 0.2, 0.55) - 0.6 * ramp(x, 0.75, 1),
    tension: ramp(x, 0.55, 0.9),
  };
}

export const BPM: Record<ScoreMode, number> = { mission: 76, menu: 56 };
/** Above this intensity the pulse moves from quarter notes to eighths. */
export const EIGHTHS_AT = 0.55;
/** No layer starts notes faster than this (comfort: well under 3 a second). */
export const MAX_ONSETS_PER_SEC = 3;
/** The fastest any layer starts notes in a mode: eighth notes. */
export const fastestOnsetsPerSec = (mode: ScoreMode): number => (BPM[mode] / 60) * 2;

interface Chord {
  /** Bass note (MIDI). */
  root: number;
  /** Pad voicing (MIDI). */
  tones: number[];
}

/** D minor: i – ♭VI – iv – V. The A major at the end is the "uh-oh". */
const MISSION_PROG: Chord[] = [
  { root: 38, tones: [50, 57, 65] },
  { root: 34, tones: [50, 58, 65] },
  { root: 43, tones: [55, 58, 62] },
  { root: 45, tones: [57, 61, 64] },
];
/** The menu: i – iv/D – ♭VI – V7, slower and softer. */
const MENU_PROG: Chord[] = [
  { root: 38, tones: [50, 57, 65] },
  { root: 38, tones: [50, 55, 58] },
  { root: 34, tones: [50, 53, 58] },
  { root: 45, tones: [55, 61, 64] },
];
const BARS_PER_CHORD = 2;

/** Motifs: [semitones from D, length in eighths]. Creeping, chromatic, a little too pleased with themselves. */
const MOTIFS: [number, number][][] = [
  [[0, 1], [3, 1], [2, 1], [-1, 3]],
  [[7, 2], [6, 1], [5, 1], [1, 4]],
  [[0, 1], [0, 1], [3, 2], [8, 2], [7, 4]],
  [[-5, 2], [0, 1], [1, 1], [0, 2], [-2, 1], [-4, 3]],
  [[5, 1], [3, 1], [2, 1], [1, 1], [0, 4]],
];

const LOOKAHEAD = 0.3;

export class GeneratedScore implements Score {
  private kit: Kit;
  private rng: Rng;
  private out: GainNode;
  private layer: Record<keyof LayerWeights, GainNode>;
  private padFilter: BiquadFilterNode;
  private smoother: IntensitySmoother;
  private target: number;
  private prog: Chord[];
  private eighth: number;
  private step = 0;
  private next: number;
  private last: number;
  private motifUntil = 0;
  private stopAt = -1;
  done = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    readonly mode: ScoreMode,
    seed: number,
    count?: (d: number) => void,
    start = mode === 'menu' ? 0.2 : 0.15,
  ) {
    this.kit = new Kit(ctx, count);
    this.rng = mulberry32(seed);
    this.smoother = new IntensitySmoother(start);
    this.target = start;
    this.prog = mode === 'menu' ? MENU_PROG : MISSION_PROG;
    this.eighth = 60 / BPM[mode] / 2;
    const now = ctx.currentTime;
    this.last = now;
    this.next = now + 0.1;

    const k = this.kit;
    this.out = k.own(ctx.createGain());
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(1, now, 0.8);
    this.out.connect(dest);
    const w = layerWeights(start, mode);
    const mk = (v: number) => {
      const g = k.own(ctx.createGain());
      g.gain.value = v;
      g.connect(this.out);
      return g;
    };
    this.layer = { pad: mk(w.pad), pulse: mk(w.pulse), motif: mk(w.motif), tension: mk(w.tension) };

    // Pad filter, breathing slowly (one cycle every 20 s).
    this.padFilter = k.own(ctx.createBiquadFilter());
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = this.cutoff(start);
    this.padFilter.Q.value = 0.7;
    this.padFilter.connect(this.layer.pad);
    this.lfo(0.05, 160, this.padFilter.frequency);

    // The drone: D and A, low and steady.
    this.drone(hz(38), 0.2, this.layer.pad);
    this.drone(hz(45), 0.06, this.layer.pad);

    // Tension: a quiet, queasy A/B♭ cluster high up, only heard when things get bad.
    if (mode === 'mission') {
      const f = k.own(ctx.createBiquadFilter());
      f.type = 'lowpass';
      f.frequency.value = 1400;
      const g = k.own(ctx.createGain());
      g.gain.value = 0.028;
      f.connect(g).connect(this.layer.tension);
      for (const m of [69, 70]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(m);
        o.connect(f);
        k.play(o, now);
      }
    }
  }

  get intensity(): number {
    return this.smoother.value;
  }

  setIntensity(x: number): void {
    if (this.mode === 'mission') this.target = clamp01(x);
  }

  private cutoff(x: number): number {
    return this.mode === 'menu' ? 520 : 480 + 1000 * x;
  }

  private drone(f: number, vol: number, dest: AudioNode): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = f;
    const g = this.kit.own(this.ctx.createGain());
    g.gain.value = vol;
    o.connect(g).connect(dest);
    this.kit.play(o, this.ctx.currentTime);
  }

  private lfo(rate: number, depth: number, param: AudioParam): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = rate;
    const g = this.kit.own(this.ctx.createGain());
    g.gain.value = depth;
    o.connect(g).connect(param);
    this.kit.play(o, this.ctx.currentTime);
  }

  tick(now: number): void {
    if (this.done) return;
    if (this.stopAt >= 0) {
      if (now >= this.stopAt) this.dispose();
      return;
    }
    const dt = Math.max(0, Math.min(0.5, now - this.last));
    this.last = now;
    const x = this.smoother.step(this.target, dt);
    const w = layerWeights(x, this.mode);
    for (const k of Object.keys(w) as (keyof LayerWeights)[]) this.layer[k].gain.setTargetAtTime(w[k], now, 1.2);
    this.padFilter.frequency.setTargetAtTime(this.cutoff(x), now, 1.5);
    // After a stall (background tab), pick up from now rather than firing a backlog of notes.
    if (this.next < now - 0.2) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      this.schedule(this.step, this.next, w, x);
      this.step++;
      this.next += this.eighth;
    }
  }

  private schedule(i: number, t: number, w: LayerWeights, x: number): void {
    const bar = Math.floor(i / 8);
    const pos = i % 8;
    const chord = this.prog[Math.floor(bar / BARS_PER_CHORD) % this.prog.length];
    const chordLen = this.eighth * 8 * BARS_PER_CHORD;
    if (i % (8 * BARS_PER_CHORD) === 0) this.pad(chord, t, chordLen);
    if (w.pulse > 0.02 && (pos % 2 === 0 || x >= EIGHTHS_AT)) this.pulse(chord.root, t, pos === 0 ? 1 : pos % 2 ? 0.55 : 0.75);
    if (w.tension > 0.02) {
      if (pos === 0) this.drum(t, 1);
      else if (pos === 4 && bar % 2 === 1) this.drum(t, 0.6);
    }
    const every = this.mode === 'menu' ? 2 : 4;
    if (pos === 0 && bar % every === 1 && t >= this.motifUntil && w.motif > 0.02) {
      const chance = this.mode === 'menu' ? 0.85 : 0.3 + 0.5 * w.motif;
      if (this.rng() < chance) this.motif(t);
    }
  }

  private pad(chord: Chord, t: number, len: number): void {
    const { ctx, kit } = this;
    const peak = this.mode === 'menu' ? 0.06 : 0.055;
    for (const m of chord.tones) {
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(peak, t + 1.8);
      g.gain.setValueAtTime(peak, t + len);
      g.gain.linearRampToValueAtTime(0, t + len + 2.2);
      g.connect(this.padFilter);
      for (const cents of [-7, 7]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = hz(m);
        o.detune.value = cents;
        o.connect(g);
        kit.play(o, t, t + len + 2.3, g);
      }
    }
  }

  private pulse(root: number, t: number, accent: number): void {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = hz(root);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 380;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.34 * accent, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.34);
    o.connect(f).connect(g).connect(this.layer.pulse);
    this.kit.play(o, t, t + 0.38, f, g);
  }

  private drum(t: number, accent: number): void {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(92, t);
    o.frequency.exponentialRampToValueAtTime(46, t + 0.35);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.42 * accent, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.9);
    o.connect(g).connect(this.layer.tension);
    this.kit.play(o, t, t + 0.95, g);
  }

  private motif(t: number): void {
    const phrase = MOTIFS[Math.floor(this.rng() * MOTIFS.length)];
    const base = this.mode === 'menu' ? 74 : 62;
    let at = t;
    for (const [semi, len] of phrase) {
      const d = len * this.eighth;
      this.bell(base + semi, at, d);
      at += d;
    }
    this.motifUntil = at + this.eighth * 4;
  }

  /** Menu: a slightly out-of-tune music box. Mission: a soft glassy triangle. */
  private bell(m: number, t: number, len: number): void {
    const { ctx } = this;
    const box = this.mode === 'menu';
    const g = ctx.createGain();
    const peak = box ? 0.07 : 0.06;
    const ring = box ? 1.4 : len + 0.6;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + (box ? 0.006 : 0.03));
    g.gain.exponentialRampToValueAtTime(0.001, t + ring);
    g.connect(this.layer.motif);
    const partials: [OscillatorType, number, number][] = box
      ? [['sine', 1, 1], ['sine', 2.01, 0.35]]
      : [['triangle', 1, 1], ['sine', 2, 0.25]];
    for (const [type, mult, vol] of partials) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = hz(m) * mult;
      const pg = ctx.createGain();
      pg.gain.value = vol;
      o.connect(pg).connect(g);
      this.kit.play(o, t, t + ring + 0.05, pg, g);
    }
  }

  stop(fade: number): void {
    if (this.stopAt >= 0 || this.done) return;
    const now = this.ctx.currentTime;
    const p = this.out.gain;
    p.cancelScheduledValues(now);
    p.setValueAtTime(p.value, now);
    p.linearRampToValueAtTime(0, now + fade);
    this.stopAt = now + fade + 0.05;
  }

  dispose(): void {
    if (this.done) return;
    this.done = true;
    this.kit.dispose();
  }
}

/** A short cue when a mission ends: a hopeful music-box rise for a win, a low falling minor triad for a loss. */
export function playSting(ctx: AudioContext, dest: AudioNode, won: boolean, count?: (d: number) => void): void {
  const kit = new Kit(ctx, count);
  const t0 = ctx.currentTime + 0.05;
  const notes = won ? [74, 78, 81, 86] : [57, 53, 50];
  const gap = won ? 0.36 : 0.5;
  notes.forEach((m, i) => {
    const t = t0 + i * gap;
    const last = i === notes.length - 1;
    const ring = last ? 2.4 : 1.0;
    const o = ctx.createOscillator();
    o.type = won ? 'sine' : 'triangle';
    o.frequency.value = hz(m);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(won ? 0.09 : 0.16, t + (won ? 0.008 : 0.04));
    g.gain.exponentialRampToValueAtTime(0.001, t + ring);
    o.connect(g).connect(dest);
    kit.play(o, t, t + ring + 0.05, g);
  });
}
