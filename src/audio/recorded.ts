/**
 * The recorded soundtrack and ambience bed (files in public/audio, see assets.ts).
 *
 * Menu: the menu theme, looped. Mission: three 70 BPM layers recorded to the same grid (calm, tense,
 * overrun) start together and loop together; the threat crossfades between them with equal-power
 * gains taken from layerWeights, so the recorded score follows the same thresholds as the generated
 * one. Loops crossfade at whole bars (see loop.ts). If the files are missing the engine keeps the
 * GeneratedScore, which stays the fallback.
 */
import { IntensitySmoother } from './intensity';
import { Kit } from './kit';
import { layerWeights, type Score, type ScoreMode } from './music';
import { StemLoop } from './loop';
import { MUSIC, SFX } from './assets';

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

export interface StemWeights {
  calm: number;
  tense: number;
  overrun: number;
}

/**
 * How loud each recorded layer is at a threat level. The generated score's pulse layer (which comes
 * in from 0.15 to 0.45) moves calm → tense, and its tension layer (0.55 to 0.9) moves tense →
 * overrun. Equal power: the squares always sum to 1, so a crossfade never dips or swells.
 */
export function stemWeights(intensity: number, mode: ScoreMode): StemWeights {
  if (mode === 'menu') return { calm: 1, tense: 0, overrun: 0 };
  const w = layerWeights(intensity, mode);
  const p = clamp01(w.pulse) + clamp01(w.tension); // 0..2
  const a = (Math.min(1, p) * Math.PI) / 2;
  const b = (Math.max(0, p - 1) * Math.PI) / 2;
  return { calm: Math.cos(a), tense: Math.sin(a) * Math.cos(b), overrun: Math.sin(a) * Math.sin(b) };
}

/** A track: the files (stems) and their tempo, and a trim per stem to even out their loudness. */
interface Track {
  ids: string[];
  trims: number[];
  /** One beat, in seconds. */
  beat: number;
}
/** Measured: mission layers 70 BPM and phase-aligned at 0 s; menu theme 95 BPM. RMS -13 / -10 / -13 / -12 dBFS. */
export const TRACKS: Record<ScoreMode, Track> = {
  menu: { ids: [MUSIC.menu], trims: [0.3], beat: 60 / 95 },
  mission: { ids: [MUSIC.calm, MUSIC.tense, MUSIC.overrun], trims: [0.36, 0.26, 0.34], beat: 60 / 70 },
};
export const trackIds = (mode: ScoreMode): string[] => TRACKS[mode].ids;

type Buffers = { get(id: string): AudioBuffer | null };

export class RecordedScore implements Score {
  private kit: Kit;
  private out: GainNode;
  private stems: GainNode[];
  private loop: StemLoop;
  private smoother: IntensitySmoother;
  private target: number;
  private last: number;
  private stopAt = -1;
  private dipUntil = -1;
  done = false;

  /** Throws if a stem is missing (the engine checks first). */
  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    readonly mode: ScoreMode,
    bank: Buffers,
    count?: (d: number) => void,
    start = mode === 'menu' ? 0.2 : 0.15,
    /** Fade-in time constant (s): slower when taking over from the generated score. */
    fadeIn = 0.8,
  ) {
    const track = TRACKS[mode];
    const buffers = track.ids.map((id) => bank.get(id));
    if (buffers.some((b) => !b)) throw new Error('recorded score not loaded');
    this.kit = new Kit(ctx, count);
    this.smoother = new IntensitySmoother(start);
    this.target = start;
    const now = ctx.currentTime;
    this.last = now;
    const k = this.kit;
    this.out = k.own(ctx.createGain());
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(1, now, fadeIn);
    this.out.connect(dest);
    const w = this.weights(start);
    this.stems = track.ids.map((_, i) => {
      const g = k.own(ctx.createGain());
      g.gain.value = w[i] * track.trims[i];
      g.connect(this.out);
      return g;
    });
    this.loop = new StemLoop(
      ctx,
      k,
      buffers.map((b, i) => ({ buffer: b!, dest: this.stems[i] })),
      { beat: track.beat, at: now + 0.05 },
    );
    this.loop.tick(now);
  }

  private weights(x: number): number[] {
    const s = stemWeights(x, this.mode);
    return this.mode === 'menu' ? [1] : [s.calm, s.tense, s.overrun];
  }

  get intensity(): number {
    return this.smoother.value;
  }

  setIntensity(x: number): void {
    if (this.mode === 'mission') this.target = clamp01(x);
  }

  /** Drop to `level` for `hold` seconds (under an end-of-mission sting), then come back slowly. */
  dip(level: number, hold: number): void {
    if (this.stopAt >= 0 || this.done) return;
    const now = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(level, now, 0.3);
    this.dipUntil = now + hold;
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
    const w = this.weights(x);
    const trims = TRACKS[this.mode].trims;
    // Slow time constant: layers swell over seconds (comfort: never flickers).
    w.forEach((v, i) => this.stems[i].gain.setTargetAtTime(v * trims[i], now, 1.2));
    if (this.dipUntil >= 0 && now >= this.dipUntil) {
      this.dipUntil = -1;
      this.out.gain.setTargetAtTime(1, now, 1.5);
    }
    this.loop.tick(now);
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

/** Files the recorded ambience bed needs. */
export const BED_IDS = [SFX.drone, SFX.night];
/** The aircraft swells twice per 120 s orbit as it banks (as in the generated bed). */
const BANK_RATE = 1 / 60;
/** Measured RMS: drone -15 dBFS, night ambience -41 dBFS. Trims bring both under the score. */
const BED_TRIM = { drone: 0.22, night: 1.4 };

/**
 * The recorded engine drone and night ambience, each looped with a 1.5 s crossfade (neither file is
 * a seamless loop), layered over a quieter generated bed. Plays on the ambience bus, so gunfire
 * ducks it like the generated drone.
 */
export class RecordedBed {
  private kit: Kit;
  private out: GainNode;
  private loop: StemLoop;
  private nightLoop: StemLoop;
  private stopAt = -1;
  done = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    bank: Buffers,
    count?: (d: number) => void,
  ) {
    const drone = bank.get(SFX.drone);
    const night = bank.get(SFX.night);
    if (!drone || !night) throw new Error('recorded bed not loaded');
    const k = (this.kit = new Kit(ctx, count));
    const now = ctx.currentTime;
    this.out = k.own(ctx.createGain());
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(1, now, 1.5);
    this.out.connect(dest);
    const dg = k.own(ctx.createGain());
    dg.gain.value = BED_TRIM.drone;
    dg.connect(this.out);
    // Bank swell: ±15 % on the drone, one cycle a minute.
    const lfo = ctx.createOscillator();
    lfo.frequency.value = BANK_RATE;
    const depth = k.own(ctx.createGain());
    depth.gain.value = BED_TRIM.drone * 0.15;
    lfo.connect(depth).connect(dg.gain);
    k.play(lfo, now);
    const ng = k.own(ctx.createGain());
    ng.gain.value = BED_TRIM.night;
    ng.connect(this.out);
    // Two separate clocks: the files differ in length (10 s and 20 s), and need no common beat.
    this.loop = new StemLoop(ctx, k, [{ buffer: drone, dest: dg }], { at: now + 0.05 });
    this.nightLoop = new StemLoop(ctx, k, [{ buffer: night, dest: ng }], { at: now + 0.05 });
    this.tick(now);
  }

  tick(now: number): void {
    if (this.done) return;
    if (this.stopAt >= 0) {
      if (now >= this.stopAt) this.dispose();
      return;
    }
    this.loop.tick(now);
    this.nightLoop.tick(now);
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

/** Play a recorded sting (8 s) on the music bus. Returns false if it isn't loaded. */
export function playRecordedSting(ctx: AudioContext, dest: AudioNode, bank: Buffers, won: boolean, count?: (d: number) => void): boolean {
  const buf = bank.get(won ? MUSIC.stingWin : MUSIC.stingLose);
  if (!buf) return false;
  const kit = new Kit(ctx, count);
  const t = ctx.currentTime + 0.05;
  const src = ctx.createBufferSource();
  src.buffer = buf;
  const g = ctx.createGain();
  g.gain.value = 0.42;
  src.connect(g).connect(dest);
  kit.play(src, t, t + buf.duration + 0.02, g);
  return true;
}
