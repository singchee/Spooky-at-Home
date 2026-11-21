import { audio, type SfxOutput } from './engine';
import { DUCK } from './mix';

/**
 * Small synthesised sound effects (no audio files). Starts only after a user gesture, as browsers
 * require. By default they play through the page's shared audio engine (sfx and radio buses, with
 * the music ducked under each shot); given a bare AudioContext (tests) they play straight to it.
 */
export class Sfx {
  private out: SfxOutput | null = null;
  private noise: AudioBuffer | null = null;
  /** Local mute (the player's mute setting silences the master bus instead). */
  muted = false;
  /** Audio-clock time until which the friendly-fire alarm is sounding; radio blips wait it out. */
  private alarmUntil = -1;

  constructor(private makeContext: () => AudioContext | SfxOutput | null = () => audio.output()) {}

  unlock(): void {
    if (this.out) {
      this.out.resume?.();
      return;
    }
    try {
      const got = this.makeContext();
      if (!got) return;
      const out: SfxOutput = 'createGain' in got ? { ctx: got, sfx: got.destination, radio: got.destination } : got;
      if (out.noise) this.noise = out.noise;
      else {
        const len = out.ctx.sampleRate;
        this.noise = out.ctx.createBuffer(1, len, out.ctx.sampleRate);
        const d = this.noise.getChannelData(0);
        for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1; // audio texture only, not game logic
      }
      this.out = out;
    } catch {
      this.out = null;
    }
  }

  private play(src: AudioScheduledSourceNode, at: number, stopAt: number, ...chain: AudioNode[]): void {
    if (this.out?.kit) this.out.kit.play(src, at, stopAt, ...chain);
    else {
      src.start(at);
      src.stop(stopAt);
    }
  }

  private burst(freq: number, dur: number, vol: number, delay = 0): void {
    const o = this.out;
    if (!o || !this.noise || this.muted) return;
    const t = o.ctx.currentTime + delay;
    const src = o.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = o.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = freq;
    const g = o.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(o.sfx);
    this.play(src, t, t + dur + 0.05, f, g);
  }

  /** The body of a big gun or blast: a sine that drops in pitch (felt more than heard). */
  private thump(from: number, to: number, dur: number, vol: number): void {
    const o = this.out;
    if (!o || this.muted) return;
    const t = o.ctx.currentTime;
    const osc = o.ctx.createOscillator();
    osc.frequency.setValueAtTime(from, t);
    osc.frequency.exponentialRampToValueAtTime(to, t + dur * 0.6);
    const g = o.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    osc.connect(g).connect(o.sfx);
    this.play(osc, t, t + dur + 0.05, g);
  }

  private duck(d: readonly [number, number]): void {
    this.out?.duck?.(d[0], d[1]);
  }

  fire(weapon: string): void {
    if (weapon === '25') this.burst(2200, 0.06, 0.12);
    else if (weapon === '40') {
      this.burst(900, 0.25, 0.35);
      this.thump(140, 70, 0.25, 0.25);
    } else {
      this.burst(300, 0.9, 0.7);
      this.thump(90, 38, 0.9, 0.55);
    }
    this.duck(DUCK.fire[weapon as keyof typeof DUCK.fire] ?? DUCK.fire['25']);
  }

  impact(weapon: string): void {
    if (weapon === '25') this.burst(700, 0.12, 0.05);
    else if (weapon === '40') this.burst(400, 0.4, 0.15);
    else {
      this.burst(160, 1.4, 0.35);
      this.thump(60, 28, 1.6, 0.45);
    }
    this.duck(DUCK.impact[weapon as keyof typeof DUCK.impact] ?? DUCK.impact['25']);
  }

  /**
   * Distinct two-tone alarm for friendly fire (square wave, 880/660 Hz, ~0.5 s), never the radio
   * blip. Other radio blips in the same moment are dropped so they can't mask it.
   */
  alarm(): void {
    const o = this.out;
    if (!o || this.muted) return;
    const t = o.ctx.currentTime;
    this.alarmUntil = t + 0.5;
    for (const [i, f] of [[0, 880], [1, 660], [2, 880], [3, 660]]) {
      const osc = o.ctx.createOscillator();
      const g = o.ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = f;
      g.gain.setValueAtTime(0.05, t + i * 0.12);
      g.gain.setValueAtTime(0, t + i * 0.12 + 0.11);
      osc.connect(g).connect(o.radio);
      this.play(osc, t + i * 0.12, t + i * 0.12 + 0.12, g);
    }
    this.duck(DUCK.alarm);
  }

  /** Short radio blip for ordinary radio lines (a sine at 1400 Hz) over faint hiss. Silent while the alarm sounds. */
  radio(): void {
    const o = this.out;
    if (!o || this.muted) return;
    const t = o.ctx.currentTime;
    if (t < this.alarmUntil) return;
    const osc = o.ctx.createOscillator();
    const g = o.ctx.createGain();
    osc.frequency.value = 1400;
    g.gain.setValueAtTime(0.04, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(g).connect(o.radio);
    this.play(osc, t, t + 0.1, g);
    o.radioStatic?.(1.4);
    this.duck(DUCK.radio);
  }
}
