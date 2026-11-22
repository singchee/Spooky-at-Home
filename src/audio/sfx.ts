import { audio, type SfxOutput } from './engine';
import { DUCK } from './mix';
import { SFX } from './assets';
import type { PlayOpts } from './samples';
import { FIRE_WEIGHT, Gate, IMPACT_WEIGHT, MIN_GAP, PUNCH, RETRIGGER_25, type Gun, type NoiseLayer, type SubLayer, type Weight } from './weight';

export { RETRIGGER_25 };

/** How each recorded effect plays: level, voice cap, slice and variation. */
export const SAMPLE_PLAY: Record<string, Omit<PlayOpts, 'group'>> = {
  // Gains and trims: the 25 mm file is the quietest (peak -12 dBFS); the 105 and the explosion
  // start after 80-90 ms of near-silence, trimmed so the blast lands with the flash.
  [SFX.fire25]: { max: 2, gain: 1, duration: RETRIGGER_25 + 0.08, fade: 0.08, jitter: 0.08, cents: 60, db: 1.5 },
  [SFX.fire40]: { max: 4, gain: 0.5, duration: 1.2, fade: 0.3, cents: 50, db: 1.5 },
  [SFX.fire105]: { max: 2, gain: 0.75, offset: 0.08, cents: 40, db: 1 },
  [SFX.explosion]: { max: 3, gain: 0.85, offset: 0.09, cents: 60, db: 1.5 },
  /** A 40 mm round landing: the explosion, smaller (a little faster, so less of its low end is lost than before, and quieter). */
  'boom40': { max: 4, gain: 0.3, rate: 1.2, offset: 0.09, duration: 1.6, fade: 0.5, cents: 80, db: 2 },
  /** Two pulses of the recorded alarm (0.4 s on, 0.35 s off: 1.3 a second), under the synthesised two-tone. */
  [SFX.alarm]: { max: 1, gain: 0.2, duration: 1.3, fade: 0.15, cents: 0, db: 0 },
};

/**
 * Sound effects. Starts only after a user gesture, as browsers require. By default they play
 * through the page's shared audio engine (sfx and radio buses, with the music ducked under each
 * shot), using the recorded samples once they have loaded and synthesised sound until then (or if
 * they never do); given a bare AudioContext (tests) they are all synthesised, straight to it.
 */
export class Sfx {
  private out: SfxOutput | null = null;
  private noise: AudioBuffer | null = null;
  /** Local mute (the player's mute setting silences the master bus instead). */
  muted = false;
  /** Audio-clock time until which the friendly-fire alarm is sounding; radio blips wait it out. */
  private alarmUntil = -1;
  /** Audio-clock time from which the next 25 mm recorded burst may start. */
  private next25 = -1;
  /** Retrigger caps for the weight layers and the punch (comfort: under 3 a second). */
  private gate = new Gate();

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

  /** A sub layer (weight.ts): a sine dropping in pitch, felt more than heard. */
  private sub(l: SubLayer): void {
    const o = this.out;
    if (!o || this.muted) return;
    const t = o.ctx.currentTime + l.delay;
    const osc = o.ctx.createOscillator();
    osc.frequency.setValueAtTime(l.from, t);
    osc.frequency.exponentialRampToValueAtTime(l.to, t + l.dur * 0.6);
    const g = o.ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(l.gain, t + l.attack);
    g.gain.exponentialRampToValueAtTime(0.001, t + l.dur);
    osc.connect(g).connect(o.sfx);
    this.play(osc, t, t + l.dur + 0.05, g);
  }

  private body(l: NoiseLayer): void {
    this.burst(l.lp, l.dur, l.gain, l.delay);
  }

  /** The weight under a shot or blast, at most once per its gap (else false). */
  private weigh(key: string, w: Weight | undefined): boolean {
    const o = this.out;
    if (!o || this.muted || !w || !this.gate.admit(key, o.ctx.currentTime, w.gap)) return false;
    this.sub(w.sub);
    this.body(w.body);
    return true;
  }

  /** Pump the music and drone out of the way (sidechain-style, on the audio clock). */
  private punch(p: (typeof PUNCH)[keyof typeof PUNCH]): void {
    const o = this.out;
    if (!o?.punch || this.muted || !this.gate.admit('punch', o.ctx.currentTime, MIN_GAP)) return;
    o.punch(p);
  }

  private duck(d: readonly [number, number]): void {
    this.out?.duck?.(d[0], d[1]);
  }

  /** Play a recorded sample on the sfx bus if it has loaded. False: use the synthesised sound. */
  private sample(id: string, how = id): boolean {
    const o = this.out;
    if (!o || this.muted || !o.samples) return false;
    const buf = o.sample?.(id);
    if (!buf) return false;
    o.samples.play(buf, o.sfx, { group: how, ...SAMPLE_PLAY[how] });
    return true;
  }

  fire(weapon: string): void {
    this.weigh(`fire${weapon}`, FIRE_WEIGHT[weapon as Gun]);
    if (weapon === '25') {
      const o = this.out;
      const rec = !!o?.sample?.(SFX.fire25);
      this.burst(2200, 0.06, rec ? 0.08 : 0.12);
      if (rec && o!.ctx.currentTime >= this.next25 && this.sample(SFX.fire25)) this.next25 = o!.ctx.currentTime + RETRIGGER_25;
    } else if (weapon === '40') {
      // Generated stand-ins carry only the bang: the weight layer above is the thump, for both.
      if (!this.sample(SFX.fire40)) this.burst(900, 0.25, 0.35);
    } else {
      if (!this.sample(SFX.fire105)) this.burst(300, 0.9, 0.7);
      this.punch(PUNCH.fire105);
    }
    this.duck(DUCK.fire[weapon as keyof typeof DUCK.fire] ?? DUCK.fire['25']);
  }

  /** A round landing (called by the game on the sim's impact event, i.e. after the shell's flight time). */
  impact(weapon: string): void {
    this.weigh(`impact${weapon}`, IMPACT_WEIGHT[weapon as Gun]);
    if (weapon === '25') this.burst(700, 0.12, 0.05);
    else if (weapon === '40') {
      if (!this.sample(SFX.explosion, 'boom40')) this.burst(400, 0.4, 0.15);
    } else {
      if (!this.sample(SFX.explosion)) this.burst(160, 1.4, 0.35);
      this.punch(PUNCH.impact105);
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
    // The square-wave two-tone below is the specified friendly-fire cue and always plays; the
    // recorded alarm, if loaded, is layered under it (two slow pulses) and holds radio blips off too.
    this.alarmUntil = this.sample(SFX.alarm) ? t + (SAMPLE_PLAY[SFX.alarm].duration ?? 1.3) : t + 0.5;
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
