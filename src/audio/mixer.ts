import { getSettings, onSettingsChange, type Settings } from '../ui/settings';
import { busGains, duckGains, DuckEnvelope } from './mix';

/**
 * The mixing desk: music, sound-effect and radio buses into a master, with the player's volume
 * settings applied live and the music and engine drone ducked under gunfire.
 *
 *   music in ─ duck ─ music bus ─┐
 *   ambience in ─ duck ─┐        │
 *   sfx in ─────────── sfx bus ──┼─ limiter ─ master ─ speakers
 *   radio in ───────── radio bus ┘
 */
export class Mixer {
  /** Where each kind of sound plugs in. */
  readonly music: GainNode;
  readonly ambience: GainNode;
  readonly sfx: GainNode;
  readonly radio: GainNode;
  private master: GainNode;
  private limiter: DynamicsCompressorNode;
  private musicBus: GainNode;
  private radioBus: GainNode;
  private musicDuck: GainNode;
  private ambDuck: GainNode;
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
    this.musicDuck = g();
    this.musicDuck.connect(this.musicBus);
    this.music = this.musicDuck;

    this.sfx = g();
    this.sfx.connect(this.limiter);
    this.ambDuck = g();
    this.ambDuck.connect(this.sfx);
    this.ambience = this.ambDuck;

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

  /** Called about 20 times a second by the engine. */
  tick(dt: number): void {
    const d = duckGains(this.env.step(dt));
    const t = this.ctx.currentTime;
    this.musicDuck.gain.setTargetAtTime(d.music, t, 0.03);
    this.ambDuck.gain.setTargetAtTime(d.ambience, t, 0.03);
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
    for (const n of [this.master, this.limiter, this.musicBus, this.musicDuck, this.sfx, this.ambDuck, this.radioBus]) n.disconnect();
  }
}
