/**
 * Playing recorded sound-effect samples: a small, seeded pitch and gain variation on every play (so
 * the same gun fired again and again doesn't phase into a comb-filtered machine), and a cap on how
 * many copies of each sound can ring at once (the oldest is faded out to make room).
 */
import { mulberry32, type Rng } from '../util/rng';
import { Kit } from './kit';

/** Seeded variation: playback rate within ±cents, gain within ±db. */
export function vary(rng: Rng, cents: number, db: number): { rate: number; gain: number } {
  const c = (rng() * 2 - 1) * cents;
  const d = (rng() * 2 - 1) * db;
  return { rate: 2 ** (c / 1200), gain: 10 ** (d / 20) };
}

/**
 * Which voices to cut so a new one fits under `max` per group. Pure bookkeeping on end times:
 * voices that have ended are forgotten; if still full, the oldest are stolen.
 */
export class VoiceLimiter<T> {
  private groups = new Map<string, { item: T; start: number; end: number }[]>();

  admit(group: string, item: T, now: number, end: number, max: number): T[] {
    const live = (this.groups.get(group) ?? []).filter((v) => v.end > now);
    const stolen: T[] = [];
    while (live.length >= Math.max(1, max)) stolen.push(live.shift()!.item);
    live.push({ item, start: now, end });
    this.groups.set(group, live);
    return stolen;
  }

  count(group: string, now: number): number {
    return (this.groups.get(group) ?? []).filter((v) => v.end > now).length;
  }
}

export interface PlayOpts {
  /** Group for the voice cap (usually the sample's name). */
  group: string;
  max: number;
  gain: number;
  /** Seconds into the buffer to start from. */
  offset?: number;
  /** Add a seeded 0..jitter seconds to the offset (so retriggers don't repeat exactly). */
  jitter?: number;
  /** Seconds to play (default: to the end). */
  duration?: number;
  /** Fade-out length at the end of a shortened play (s). */
  fade?: number;
  /** Base playback rate (before variation). */
  rate?: number;
  /** Variation range: ±cents and ±dB. */
  cents?: number;
  db?: number;
  /** Start delay from now (s). */
  delay?: number;
}

interface Playing {
  src: AudioBufferSourceNode;
  g: GainNode;
}

export class SamplePlayer {
  private kit: Kit;
  private rng: Rng;
  private limiter = new VoiceLimiter<Playing>();

  constructor(
    private ctx: AudioContext,
    count?: (d: number) => void,
    seed = 0x5a3e,
  ) {
    this.kit = new Kit(ctx, count);
    this.rng = mulberry32(seed);
  }

  /** Play `buf` into `dest`. Returns the start and end times on the audio clock. */
  play(buf: AudioBuffer, dest: AudioNode, o: PlayOpts): { start: number; end: number } {
    const { ctx } = this;
    const v = vary(this.rng, o.cents ?? 40, o.db ?? 1.5);
    const rate = (o.rate ?? 1) * v.rate;
    const t = ctx.currentTime + (o.delay ?? 0);
    const offset = Math.max(0, Math.min(buf.duration - 0.01, (o.offset ?? 0) + this.rng() * (o.jitter ?? 0)));
    const len = Math.min(buf.duration - offset, o.duration ?? Infinity);
    const end = t + len / rate;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = ctx.createGain();
    const peak = o.gain * v.gain;
    g.gain.setValueAtTime(peak, t);
    if (o.duration !== undefined && o.fade) {
      const f = Math.min(o.fade, len / rate / 2);
      g.gain.setValueAtTime(peak, end - f);
      g.gain.linearRampToValueAtTime(0, end);
    }
    src.connect(g).connect(dest);
    for (const old of this.limiter.admit(o.group, { src, g }, t, end, o.max)) this.cut(old);
    if (this.kit.adopt(src, g)) {
      src.start(t, offset, len);
      src.stop(end + 0.02);
    }
    return { start: t, end };
  }

  /** Fade a playing voice out over 30 ms and stop it (no click). */
  private cut(p: Playing): void {
    const now = this.ctx.currentTime;
    try {
      p.g.gain.cancelScheduledValues(now);
      p.g.gain.setValueAtTime(p.g.gain.value, now);
      p.g.gain.linearRampToValueAtTime(0, now + 0.03);
      p.src.stop(now + 0.04);
    } catch {
      /* already stopped */
    }
  }

  live(group: string): number {
    return this.limiter.count(group, this.ctx.currentTime);
  }

  dispose(): void {
    this.kit.dispose();
  }
}
