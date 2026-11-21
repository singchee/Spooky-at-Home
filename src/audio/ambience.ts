/**
 * The bed under a mission: the gunship's engines (a low, steady turboprop drone that swells a
 * little as the aircraft banks round its orbit), a distant city hum, and now and then a car alarm
 * a long way off. All synthesised; noise texture comes from a shared buffer.
 */
import { mulberry32, type Rng } from '../util/rng';
import { Kit } from './kit';

/** The aircraft orbit takes 120 s (sim ORBIT.period); the drone swells twice per lap as it banks. */
const BANK_RATE = 1 / 60;
/** The whole bed sits well under the score and the guns. */
const LEVEL = 0.25;

export class Ambience {
  private kit: Kit;
  private out: GainNode;
  private rng: Rng;
  private nextAlarm: number;
  private stopAt = -1;
  done = false;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    private noise: AudioBuffer,
    seed: number,
    count?: (d: number) => void,
  ) {
    const k = (this.kit = new Kit(ctx, count));
    this.rng = mulberry32(seed);
    const now = ctx.currentTime;
    this.nextAlarm = now + 25 + this.rng() * 25;
    this.out = k.own(ctx.createGain());
    this.out.gain.value = 0;
    this.out.gain.setTargetAtTime(LEVEL, now, 1.2);
    this.out.connect(dest);

    // Engines: two slightly detuned blade-pass tones (a slow 0.4 Hz beat) and a sub, low-passed.
    const eng = k.own(ctx.createBiquadFilter());
    eng.type = 'lowpass';
    eng.frequency.value = 230;
    eng.Q.value = 0.5;
    const engGain = k.own(ctx.createGain());
    engGain.gain.value = 0.16;
    eng.connect(engGain).connect(this.out);
    for (const [type, f, v] of [['sawtooth', 68, 0.5], ['sawtooth', 68.4, 0.5], ['triangle', 34, 0.9]] as const) {
      const o = ctx.createOscillator();
      o.type = type;
      o.frequency.value = f;
      const g = k.own(ctx.createGain());
      g.gain.value = v;
      o.connect(g).connect(eng);
      k.play(o, now);
    }
    this.lfo(BANK_RATE, 45, eng.frequency);
    this.lfo(BANK_RATE, 0.035, engGain.gain);

    // Air rushing past the airframe.
    this.noiseBed('bandpass', 520, 0.6, 0.035, 1 / 23, 0.012);
    // The town below: a low, distant rumble that breathes very slowly.
    this.noiseBed('lowpass', 150, 0.7, 0.09, 1 / 17, 0.03);
  }

  private lfo(rate: number, depth: number, param: AudioParam): void {
    const o = this.ctx.createOscillator();
    o.frequency.value = rate;
    const g = this.kit.own(this.ctx.createGain());
    g.gain.value = depth;
    o.connect(g).connect(param);
    this.kit.play(o, this.ctx.currentTime);
  }

  private noiseBed(type: BiquadFilterType, freq: number, q: number, vol: number, rate: number, depth: number): void {
    const { ctx, kit } = this;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = kit.own(ctx.createBiquadFilter());
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = kit.own(ctx.createGain());
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.out);
    kit.play(src, ctx.currentTime);
    this.lfo(rate, depth, g.gain);
  }

  /** A car alarm somewhere across town: a slow whoop (1.3 cycles a second), muffled by distance. */
  private carAlarm(t: number): void {
    const { ctx } = this;
    const o = ctx.createOscillator();
    o.type = 'triangle';
    const cycles = 6;
    const per = 0.75;
    for (let i = 0; i < cycles; i++) {
      o.frequency.setValueAtTime(620, t + i * per);
      o.frequency.linearRampToValueAtTime(900, t + i * per + per * 0.8);
    }
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 900;
    const g = ctx.createGain();
    const end = t + cycles * per;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(0.012, t + 1);
    g.gain.setValueAtTime(0.012, end - 1.2);
    g.gain.linearRampToValueAtTime(0, end);
    o.connect(f).connect(g).connect(this.out);
    this.kit.play(o, t, end + 0.05, f, g);
  }

  tick(now: number): void {
    if (this.done) return;
    if (this.stopAt >= 0) {
      if (now >= this.stopAt) this.dispose();
      return;
    }
    if (now >= this.nextAlarm) {
      this.carAlarm(now + 0.1);
      this.nextAlarm = now + 45 + this.rng() * 50;
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

/** Faint radio hiss under a radio line: band-passed noise that fades in, holds and fades out. */
export function radioStatic(ctx: AudioContext, dest: AudioNode, noise: AudioBuffer, dur: number, offset: number, kit: Kit): void {
  const t = ctx.currentTime;
  const src = ctx.createBufferSource();
  src.buffer = noise;
  src.loop = true;
  const f = ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 2600;
  f.Q.value = 0.9;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0, t);
  g.gain.linearRampToValueAtTime(0.03, t + 0.06);
  g.gain.setValueAtTime(0.03, t + dur);
  g.gain.linearRampToValueAtTime(0, t + dur + 0.3);
  src.connect(f).connect(g).connect(dest);
  if (!kit.adopt(src, f, g)) return;
  // Start partway into the buffer so back-to-back lines don't hiss identically.
  src.start(t, offset % (noise.duration || 1));
  src.stop(t + dur + 0.35);
}
