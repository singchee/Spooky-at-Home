/**
 * Pure mixing rules (no WebAudio here, so they run in unit tests): how the player's volume
 * settings become bus gains, and the ducking envelope that dips the music and engine drone
 * under gunfire and blasts.
 */
import type { Settings } from '../ui/settings';

/** Where each bus sits at full slider, before the player's settings. Music sits under the guns. */
export const BUS_LEVEL = { music: 0.32, sfx: 1, radio: 1 } as const;

/** How far ducking pulls each layer down at full duck (0..1 of its gain). */
export const DUCK_DEPTH = { music: 0.6, ambience: 0.35 } as const;

export interface BusGains {
  master: number;
  music: number;
  sfx: number;
  radio: number;
}

/** Slider position (0..1) to gain. Squared, so half way sounds about half as loud, not barely quieter. */
export const perceptual = (v: number): number => {
  const x = Number.isFinite(v) ? Math.max(0, Math.min(1, v)) : 0;
  return x * x;
};

/** The gain of each bus from the player's settings. `muted` silences the master; nothing else changes. */
export function busGains(s: Pick<Settings, 'masterVolume' | 'musicVolume' | 'sfxVolume' | 'radioVolume' | 'muted'>): BusGains {
  return {
    master: s.muted ? 0 : perceptual(s.masterVolume),
    music: perceptual(s.musicVolume) * BUS_LEVEL.music,
    sfx: perceptual(s.sfxVolume) * BUS_LEVEL.sfx,
    radio: perceptual(s.radioVolume) * BUS_LEVEL.radio,
  };
}

/** Gains for the duckable layers at a given duck level (0 = none, 1 = full). */
export function duckGains(level: number): { music: number; ambience: number } {
  const l = Math.max(0, Math.min(1, level));
  return { music: 1 - DUCK_DEPTH.music * l, ambience: 1 - DUCK_DEPTH.ambience * l };
}

/** How hard each gun ducks the music (depth 0..1) and for how long (s) after the shot. */
export const DUCK = {
  fire: { '25': [0.25, 0.3], '40': [0.4, 0.5], '105': [0.75, 0.9] },
  impact: { '25': [0.15, 0.2], '40': [0.35, 0.5], '105': [0.9, 1.3] },
  alarm: [0.6, 0.9],
  radio: [0.25, 1.6],
} as const;

/**
 * Ducking envelope. A hit pulls the level up quickly (attack), holds it while the shooting goes
 * on, then lets it go slowly (release), so sustained fire holds one steady dip rather than
 * pumping, and a big blast recovers over about a second and a half.
 */
export class DuckEnvelope {
  level = 0;
  private target = 0;
  private holdLeft = 0;

  /** attack and release: seconds for a full 0→1 swing. */
  constructor(
    readonly attack = 0.06,
    readonly release = 1.5,
  ) {}

  /** A shot or blast: dip to at least `depth` (0..1) and hold it for `hold` seconds. */
  trigger(depth: number, hold: number): void {
    const d = Math.max(0, Math.min(1, depth));
    if (d >= this.target) this.target = d;
    this.holdLeft = Math.max(this.holdLeft, hold);
  }

  /** Advance by dt seconds; returns the new level. */
  step(dt: number): number {
    this.holdLeft -= dt;
    if (this.holdLeft <= 0) {
      this.holdLeft = 0;
      this.target = 0;
    }
    if (this.level < this.target) this.level = Math.min(this.target, this.level + dt / this.attack);
    else this.level = Math.max(this.target, this.level - dt / this.release);
    return this.level;
  }
}
