import { getSettings, onSettingsChange, type Settings } from '../ui/settings';
import { busGains, duckGains, DuckEnvelope } from './mix';
import { WEAPON_EQ } from './weight';

/**
 * The mixing desk: music, sound-effect and radio buses into a master, with the player's volume
 * settings applied live and the music and engine drone ducked under gunfire.
 *
 *   music in ─ duck ─ punch ─ music bus ─┐
 *   ambience in ─ duck ─ punch ─┐        │
 *   weapons in ─ high-pass ─ low shelf ──┤
 *   sfx in ──────────────────── sfx bus ─┼─ limiter ─ master ─ speakers
 *   radio in ───────────────── radio bus ┘
 *
 * "duck" follows the slow envelope (20 Hz ticks); "punch" is scheduled on the audio clock, so the
 * music drops out of the way at the very moment a 105 lands (see weight.ts, PUNCH).
 */
export class Mixer {
  /** Where each kind of sound plugs in. */
  readonly music: GainNode;
  readonly ambience: GainNode;
  readonly sfx: GainNode;
  readonly radio: GainNode;
  /** The guns and blasts: through the weapon EQ into the sfx bus. */
  readonly weapons: AudioNode;
  private master: GainNode;
  private limiter: DynamicsCompressorNode;
  private musicBus: GainNode;
  private radioBus: GainNode;
  private musicDuck: GainNode;
  private ambDuck: GainNode;
  private musicPunch: GainNode;
  private ambPunch: GainNode;
  private eq: BiquadFilterNode[];
  private env = new DuckEnvelope();
  private off: () => void;

  constructor(private ctx: AudioContext) {
    const g = () => ctx.createGain();
    this.master = g();
    this.limiter = ctx.createDynamicsCompressor();
    // A gentle safety limiter: a stack of blasts never clips or jumps out of the speakers.
    this.limiter.threshold.value = -12;
    this.limiter.knee.value = 8;
    this.limiter.ratio.value = 8;
    this.limiter.attack.value = 0.005;
    this.limiter.release.value = 0.25;
    this.limiter.connect(this.master).connect(ctx.destination);

    this.musicBus = g();
    this.musicBus.connect(this.limiter);
    this.musicPunch = g();
    this.musicPunch.connect(this.musicBus);
    this.musicDuck = g();
    this.musicDuck.connect(this.musicPunch);
    this.music = this.musicDuck;

    this.sfx = g();
    this.sfx.connect(this.limiter);
    this.ambPunch = g();
    this.ambPunch.connect(this.sfx);
    this.ambDuck = g();
    this.ambDuck.connect(this.ambPunch);
    this.ambience = this.ambDuck;

    // Weapon EQ: no sub-sonic mud, then a gentle lift under 120 Hz.
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = WEAPON_EQ.highpass;
    hp.Q.value = 0.7;
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'lowshelf';
    shelf.frequency.value = WEAPON_EQ.shelfHz;
    shelf.gain.value = WEAPON_EQ.shelfDb;
    hp.connect(shelf).connect(this.sfx);
    this.eq = [hp, shelf];
    this.weapons = hp;

    this.radioBus = g();
    this.radioBus.connect(this.limiter);
    this.radio = this.radioBus;

    this.apply(getSettings(), true);
    this.off = onSettingsChange((s) => this.apply(s));
  }

  /** Apply volume settings; eases over ~50 ms so dragging a slider never clicks. */
  apply(s: Settings, now = false): void {
    const b = busGains(s);
    const set = (p: AudioParam, v: number) => {
      if (now) p.value = v;
      else p.setTargetAtTime(v, this.ctx.currentTime, 0.04);
    };
    set(this.master.gain, b.master);
    set(this.musicBus.gain, b.music);
    set(this.sfx.gain, b.sfx);
    set(this.radioBus.gain, b.radio);
  }

  /** Dip the music and drone (see DuckEnvelope). */
  duck(depth: number, hold: number): void {
    this.env.trigger(depth, hold);
  }

  /**
   * Pump the music and drone out of the way of a big blast, on the audio clock: down by `depth`
   * within `attack` s, held for `hold`, back over `release`. A new punch takes over from the old.
   */
  punch(p: { depth: number; attack: number; hold: number; release: number }): void {
    const t = this.ctx.currentTime;
    const low = 1 - Math.max(0, Math.min(1, p.depth));
    for (const n of [this.musicPunch, this.ambPunch]) {
      const g = n.gain;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(low, t + p.attack);
      g.setValueAtTime(low, t + p.attack + p.hold);
      g.linearRampToValueAtTime(1, t + p.attack + p.hold + p.release);
    }
  }

  /** Called about 20 times a second by the engine. */
  tick(dt: number): void {
    const d = duckGains(this.env.step(dt));
    const t = this.ctx.currentTime;
    this.musicDuck.gain.setTargetAtTime(d.music, t, 0.03);
    this.ambDuck.gain.setTargetAtTime(d.ambience, t, 0.03);
  }

  /**
   * A level meter on the radio bus or on the master output (after the limiter and master gain), for
   * the automated check only: an AnalyserNode fed from the bus, connected to nothing else.
   */
  tap(where: 'radio' | 'master'): AnalyserNode {
    const a = this.ctx.createAnalyser();
    // ~0.35 s of history: a loaded test machine reads the meter far less often than every 50 ms.
    a.fftSize = 16384;
    (where === 'radio' ? this.radioBus : this.master).connect(a);
    return a;
  }

  /** Current gains as the audio thread sees them (for the automated check). */
  read(): { master: number; music: number; sfx: number; radio: number; musicDuck: number; duck: number } {
    return {
      master: this.master.gain.value,
      music: this.musicBus.gain.value,
      sfx: this.sfx.gain.value,
      radio: this.radioBus.gain.value,
      musicDuck: this.musicDuck.gain.value,
      duck: this.env.level,
    };
  }

  dispose(): void {
    this.off();
    for (const n of [this.master, this.limiter, this.musicBus, this.musicDuck, this.musicPunch, this.sfx, this.ambDuck, this.ambPunch, this.radioBus, ...this.eq]) n.disconnect();
  }
}
