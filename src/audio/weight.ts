/**
 * Gun weight: the synthesised low end laid under every gun and blast, recorded or generated.
 *
 * The recorded guns are thin below 150 Hz (measured: 25 mm 7 % of its energy, 105 mm 19 %), so
 * each shot gets a sub "thump" (a sine that drops in pitch) and a body (low-passed noise), scaled
 * by weapon: a light floor under the 25 mm, a kick for the 40 mm, a heavy punch for the 105. A
 * 40 or 105 round landing adds a low-passed boom just after the flash, and the 105's blast pulls
 * the music and drone down on the audio clock (a sidechain-style pump; see Mixer.punch).
 *
 * Pure numbers and maths here (no WebAudio), so the levels, the retrigger caps and the headroom
 * can be checked in unit tests; Sfx turns them into nodes.
 */

export type Gun = '25' | '40' | '105';

/** A sine that drops from `from` to `to` Hz (over 60 % of `dur`), with a short attack and an exponential tail. */
export interface SubLayer {
  from: number;
  to: number;
  dur: number;
  gain: number;
  /** Attack (s): soft enough not to click, short enough to punch. */
  attack: number;
  /** Start after the call (s). */
  delay: number;
}

/** White noise through a low-pass at `lp` Hz, exponential decay. */
export interface NoiseLayer {
  lp: number;
  dur: number;
  gain: number;
  delay: number;
}

export interface Weight {
  sub: SubLayer;
  body: NoiseLayer;
  /**
   * Optional: a short, higher sine sweep laid on top of the sub (owner playtest 1: impacts "sound like
   * a soft thud"). The sub sits under 80 Hz, which laptop and phone speakers barely play; the kick
   * starts around 150 Hz, so the blow reads as a boom on any speaker while the sub carries the weight.
   */
  kick?: SubLayer;
  /** Fewest seconds between two weight layers of this gun (comfort: under 3 a second). */
  gap: number;
}

/** The lowest anything here goes: below this a speaker only wastes headroom. */
export const SUB_FLOOR = 28;

/**
 * Comfort: no layer here retriggers more than this often (s). 0.34 s is under 3 a second. The
 * 25 mm fires 12 rounds a second, so its weight follows the recorded burst's own retrigger
 * (RETRIGGER_25, 0.42 s): a steady low floor under a held burst, not a 12 Hz flutter.
 */
export const MIN_GAP = 0.34;

/**
 * The 25 mm fires 12 rounds a second: each round keeps its short synthesised crack, and the
 * recorded burst (and this weight) is laid under it at most this often (s) while the trigger is
 * held. 2.4 a second, under the comfort limit of 3.
 */
export const RETRIGGER_25 = 0.42;

/** Per shot. The 25 mm's sub (0.75 s) overlaps the next retrigger, so a held burst never drops out. */
export const FIRE_WEIGHT: Record<Gun, Weight> = {
  '25': {
    sub: { from: 78, to: 52, dur: 0.75, gain: 0.11, attack: 0.02, delay: 0 },
    body: { lp: 380, dur: 0.12, gain: 0.07, delay: 0 },
    gap: RETRIGGER_25,
  },
  '40': {
    sub: { from: 120, to: 50, dur: 0.38, gain: 0.24, attack: 0.006, delay: 0 },
    body: { lp: 520, dur: 0.2, gain: 0.16, delay: 0 },
    gap: MIN_GAP,
  },
  '105': {
    sub: { from: 82, to: 34, dur: 1.1, gain: 0.38, attack: 0.008, delay: 0 },
    body: { lp: 280, dur: 0.55, gain: 0.25, delay: 0 },
    gap: MIN_GAP,
  },
};

/**
 * A round landing: a delayed, low-passed boom (the crack is the flash; this is the ground answering).
 * Owner playtest 1 ("a soft thud"): more sub, a longer and brighter body, and a kick on top. The
 * 105 is by far the biggest thing in the game (tests: at least 6 dB over the 40 mm's boom).
 */
export const IMPACT_WEIGHT: Partial<Record<Gun, Weight>> = {
  '40': {
    sub: { from: 92, to: 40, dur: 0.75, gain: 0.18, attack: 0.008, delay: 0.05 },
    body: { lp: 240, dur: 0.85, gain: 0.18, delay: 0.05 },
    kick: { from: 150, to: 62, dur: 0.25, gain: 0.16, attack: 0.005, delay: 0.05 },
    gap: MIN_GAP,
  },
  '105': {
    sub: { from: 72, to: 28, dur: 2.3, gain: 0.34, attack: 0.012, delay: 0.09 },
    body: { lp: 240, dur: 2.4, gain: 0.38, delay: 0.09 },
    kick: { from: 150, to: 48, dur: 0.5, gain: 0.22, attack: 0.005, delay: 0.09 },
    gap: MIN_GAP,
  },
};

/**
 * The 105's blast pumps the music and engine drone on the audio clock (sample-accurate, unlike
 * the 20 Hz duck envelope): down by `depth` (0..1 of their gain) within `attack`, held, then back
 * over `release`. Under the slower duck, so the two multiply.
 */
export const PUNCH = {
  fire105: { depth: 0.35, attack: 0.012, hold: 0.08, release: 0.5 },
  impact105: { depth: 0.6, attack: 0.012, hold: 0.2, release: 0.9 },
} as const;

/**
 * The weapon bus's tone: a high-pass under everything (keeps sub-sonic rumble from eating the
 * limiter's headroom), then a gentle low shelf.
 */
export const WEAPON_EQ = { highpass: 30, shelfHz: 120, shelfDb: 4 } as const;

/** Per-key retrigger gate on the audio clock: true if `key` may sound at `now` (and books it). */
export class Gate {
  private next = new Map<string, number>();

  admit(key: string, now: number, gap: number): boolean {
    if (now < (this.next.get(key) ?? -Infinity)) return false;
    this.next.set(key, now + Math.max(gap, 0));
    return true;
  }
}

/** Gain of the sub layer at `t` seconds after it was called (the WebAudio automation, in closed form). */
export function subEnvelope(s: SubLayer, t: number): number {
  const u = t - s.delay;
  if (u < 0 || u > s.dur) return 0;
  if (u < s.attack) return (s.gain * u) / s.attack;
  // exponentialRampToValueAtTime(0.001, dur) from the attack's end.
  const k = (u - s.attack) / Math.max(1e-6, s.dur - s.attack);
  return s.gain * (0.001 / s.gain) ** k;
}

/** Frequency of the sub layer at `t` (exponential drop over 60 % of its length, then flat). */
export function subFreq(s: SubLayer, t: number): number {
  const u = Math.max(0, t - s.delay);
  const k = Math.min(1, u / (s.dur * 0.6));
  return s.from * (s.to / s.from) ** k;
}

/** Gain of a noise layer at `t` (instant start, exponential decay to 0.001). */
export function noiseEnvelope(n: NoiseLayer, t: number): number {
  const u = t - n.delay;
  if (u < 0 || u > n.dur) return 0;
  return n.gain * (0.001 / n.gain) ** (u / n.dur);
}

/** What the punch leaves of the music's gain at `t` after it fires (1 = untouched). */
export function punchGain(p: { depth: number; attack: number; hold: number; release: number }, t: number): number {
  if (t < 0) return 1;
  const low = 1 - p.depth;
  if (t < p.attack) return 1 - (p.depth * t) / p.attack;
  if (t < p.attack + p.hold) return low;
  const r = (t - p.attack - p.hold) / p.release;
  return r >= 1 ? 1 : low + p.depth * r;
}

/** A shot or blast in a test timeline. */
export interface WeightEvent {
  at: number;
  gun: Gun;
  kind: 'fire' | 'impact';
}

/**
 * Render the weight layers of a timeline offline (mono, plain JS): each event that passes the
 * gate, as Sfx plays it. The noise is seeded, and taken at full scale (|x| ≤ 1) so the peak is a
 * worst case. Used by the tests to prove a held 25 mm burst under a 105 blast keeps its headroom.
 */
export function renderWeight(events: readonly WeightEvent[], seconds: number, sampleRate = 8000, rnd: () => number = Math.random): Float32Array {
  const out = new Float32Array(Math.ceil(seconds * sampleRate));
  const gate = new Gate();
  for (const e of [...events].sort((a, b) => a.at - b.at)) {
    const w = e.kind === 'fire' ? FIRE_WEIGHT[e.gun] : IMPACT_WEIGHT[e.gun];
    if (!w || !gate.admit(`${e.kind}${e.gun}`, e.at, w.gap)) continue;
    const i0 = Math.floor(e.at * sampleRate);
    const kick = w.kick;
    const len = Math.ceil((Math.max(w.sub.delay + w.sub.dur, w.body.delay + w.body.dur, kick ? kick.delay + kick.dur : 0) + 0.01) * sampleRate);
    let phase = 0;
    let kphase = 0;
    // One-pole low-pass for the body noise (close enough to the biquad for a level check).
    const a = 1 - Math.exp((-2 * Math.PI * w.body.lp) / sampleRate);
    let lp = 0;
    for (let j = 0; j < len && i0 + j < out.length; j++) {
      const t = j / sampleRate;
      if (t >= w.sub.delay) phase += (2 * Math.PI * subFreq(w.sub, t)) / sampleRate;
      lp += a * (rnd() * 2 - 1 - lp);
      let k = 0;
      if (kick && t >= kick.delay) {
        kphase += (2 * Math.PI * subFreq(kick, t)) / sampleRate;
        k = Math.sin(kphase) * subEnvelope(kick, t);
      }
      out[i0 + j] += Math.sin(phase) * subEnvelope(w.sub, t) + lp * noiseEnvelope(w.body, t) + k;
    }
  }
  return out;
}
