/**
 * The radio voice: recorded crew lines that add flavour under the on-screen radio text (which
 * stays as it is and carries the places and numbers).
 *
 * - VoiceDirector (pure): which line, if any, a game event or a change in the mission calls for.
 *   Only true things are said (PLAN §5a): "cold-blooded" only once cold contacts really exist,
 *   "all clear" only when no contact is left alive, and so on.
 * - VoiceQueue (pure): one line at a time, a minimum gap between lines, per-line cooldowns, low-
 *   priority lines dropped when the radio is busy, stale news dropped, and urgent safety calls
 *   (check fire, friendlies under attack) cutting in.
 * - VoiceChannel: plays the queue's choices on the radio bus, a squelch before each line, with the
 *   music ducked underneath.
 */
import type { Sim, SimEvent } from '../sim/sim';
import { SFX, voiceAsset, type VoiceLine } from './assets';
import { Kit } from './kit';

export const PRIORITY = { low: 0, normal: 1, high: 2, urgent: 3 } as const;
export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];

export interface LineRule {
  priority: Priority;
  /** The same line is not said again within this many seconds. */
  cooldown: number;
  /** Cuts off a lower-priority line that is playing. */
  preempt?: boolean;
  /** Minimum quiet before this line (s); defaults to MIN_GAP. */
  gap?: number;
  /** Dropped if it has waited longer than this (s); defaults to MAX_WAIT. */
  maxWait?: number;
}

/** Quiet between two lines (s), so the radio never chatters. */
export const MIN_GAP = 3;
/** News older than this (s) is no longer worth saying. */
export const MAX_WAIT = 6;
/** Lines waiting at most. */
export const QUEUE_MAX = 3;

const L = PRIORITY.low;
const N = PRIORITY.normal;
const H = PRIORITY.high;
const U = PRIORITY.urgent;
export const RULES: Record<VoiceLine, LineRule> = {
  'check-fire': { priority: U, cooldown: 6, preempt: true, gap: 0.2 },
  'friendlies-under-attack': { priority: U, cooldown: 8, preempt: true, gap: 0.2 },
  'mission-complete': { priority: U, cooldown: 0, gap: 0.5, maxWait: 12 },
  'mission-failed': { priority: U, cooldown: 0, gap: 0.5, maxWait: 12 },
  'cleared-hot': { priority: H, cooldown: 30, gap: 0, maxWait: 4 },
  'survivor-lost': { priority: H, cooldown: 8, maxWait: 8 },
  'danger-close': { priority: H, cooldown: 12, maxWait: 3 },
  'cold-blooded': { priority: N, cooldown: 60, maxWait: 12 },
  rushers: { priority: N, cooldown: 15, maxWait: 8 },
  'big-group': { priority: N, cooldown: 15, maxWait: 8 },
  'new-contacts': { priority: N, cooldown: 15 },
  'more-coming': { priority: N, cooldown: 15 },
  'survivors-moving': { priority: N, cooldown: 30, maxWait: 10 },
  'survivor-home-kettle': { priority: N, cooldown: 10 },
  'survivor-home-quieter': { priority: N, cooldown: 10 },
  'safehouse-hits': { priority: N, cooldown: 25 },
  'all-clear': { priority: N, cooldown: 30, maxWait: 4 },
  'good-effect': { priority: L, cooldown: 12 },
  'former-neighbours': { priority: L, cooldown: 12 },
  'splash-residents': { priority: L, cooldown: 12 },
  // Spec 002: once per mission each (the sim says them once); P2 in the radio script: dropped if not started within 3 s.
  'few-left': { priority: N, cooldown: 600, maxWait: 3 },
  'cold-leftovers': { priority: N, cooldown: 600, maxWait: 3 },
};

export type Decision = 'queued' | 'preempt' | 'dropped';

interface Pending {
  line: VoiceLine;
  at: number;
}

/**
 * One voice at a time. Feed it requests with say() and call poll() every tick; poll() returns the
 * line to start now (and whether it cuts the current one), and the queue then counts that line as
 * playing for `durationOf(line)` seconds (or until cut).
 */
export class VoiceQueue {
  private queue: Pending[] = [];
  private lastSaid = new Map<VoiceLine, number>();
  /** The line on air, if any. */
  current: { line: VoiceLine; start: number; end: number } | null = null;
  /** When the radio last went quiet. */
  private quietSince = -Infinity;
  private cutNext = false;

  constructor(
    private durationOf: (line: VoiceLine) => number,
    private rules: Record<VoiceLine, LineRule> = RULES,
  ) {}

  private busy(now: number): boolean {
    this.expire(now);
    return !!this.current;
  }

  private expire(now: number): void {
    if (this.current && now >= this.current.end) {
      this.quietSince = this.current.end;
      this.current = null;
    }
  }

  say(line: VoiceLine, now: number): Decision {
    const r = this.rules[line];
    if (!r) return 'dropped';
    const last = this.lastSaid.get(line);
    if (last !== undefined && now - last < r.cooldown) return 'dropped';
    if (this.queue.some((p) => p.line === line) || this.current?.line === line) return 'dropped';
    if (!(this.durationOf(line) > 0)) return 'dropped'; // not loaded: the text on screen carries it
    const busy = this.busy(now);
    // Low priority (kill banter) only goes out on a free channel.
    if (r.priority === PRIORITY.low && (busy || this.queue.length || now - this.quietSince < this.gapFor(line))) return 'dropped';
    let decision: Decision = 'queued';
    if (busy && r.preempt && this.rules[this.current!.line].priority < r.priority) {
      decision = 'preempt';
      this.cutNext = true;
    }
    if (this.queue.length >= QUEUE_MAX) {
      // Make room by dropping the least important (newest of those) if it ranks below this one.
      let worst = 0;
      this.queue.forEach((p, i) => {
        if (this.rules[p.line].priority <= this.rules[this.queue[worst].line].priority) worst = i;
      });
      if (this.rules[this.queue[worst].line].priority >= r.priority) return 'dropped';
      this.queue.splice(worst, 1);
    }
    this.queue.push({ line, at: now });
    return decision;
  }

  private gapFor(line: VoiceLine): number {
    return this.rules[line].gap ?? MIN_GAP;
  }

  /** The line to start now, if any; `cut` means stop the current one first. */
  poll(now: number): { line: VoiceLine; cut: boolean } | null {
    this.queue = this.queue.filter((p) => now - p.at <= (this.rules[p.line].maxWait ?? MAX_WAIT));
    if (!this.queue.length) {
      this.cutNext = false;
      return null;
    }
    // Highest priority first, then oldest.
    let best = 0;
    this.queue.forEach((p, i) => {
      const a = this.rules[p.line].priority;
      const b = this.rules[this.queue[best].line].priority;
      if (a > b || (a === b && p.at < this.queue[best].at)) best = i;
    });
    const next = this.queue[best];
    let cut = false;
    if (this.busy(now)) {
      if (!(this.cutNext && this.rules[next.line].preempt && this.rules[this.current!.line].priority < this.rules[next.line].priority)) return null;
      cut = true;
    } else if (now - this.quietSince < this.gapFor(next.line)) return null;
    this.cutNext = false;
    this.queue.splice(best, 1);
    this.lastSaid.set(next.line, now);
    this.current = { line: next.line, start: now, end: now + this.durationOf(next.line) };
    return { line: next.line, cut };
  }

  /** The line on air was cut short (or the screen changed): the radio is quiet from now. */
  stop(now: number, clearQueue = true): void {
    if (this.current) {
      this.current.end = Math.min(this.current.end, now);
      this.expire(now);
    }
    if (clearQueue) this.queue = [];
    this.cutNext = false;
  }

  /** Drop everything waiting (e.g. the mission just ended: stale news). */
  clear(): void {
    this.queue = [];
    this.cutNext = false;
  }

  get waiting(): number {
    return this.queue.length;
  }
}

// ---------- which line for which moment ----------

/** What the director watches in a running mission (plain numbers, so tests can build one). */
export interface VoiceWorld {
  t: number;
  running: boolean;
  defend: boolean;
  zombiesAlive: number;
  coldAlive: number;
  /** Escorted survivors who have set off (their start delay is over), alive and not yet home. */
  setOff: number;
  integrity: number;
}

export function voiceWorld(sim: Pick<Sim, 't' | 'phase' | 'zombies' | 'survivors' | 'mission' | 'integrity'>): VoiceWorld {
  let alive = 0;
  let cold = 0;
  for (const z of sim.zombies) {
    if (!z.alive) continue;
    alive++;
    if (z.cold) cold++;
  }
  let setOff = 0;
  for (const s of sim.survivors) if (s.alive && !s.home && s.route && sim.t >= s.delay) setOff++;
  return { t: sim.t, running: sim.phase === 'running', defend: sim.mission.type === 'defend', zombiesAlive: alive, coldAlive: cold, setOff, integrity: sim.integrity };
}

const KILL_LINES: VoiceLine[] = ['good-effect', 'former-neighbours', 'splash-residents'];
/** Safehouse damage (0..1 of integrity) between "taking hits" calls. */
const SAFEHOUSE_STEP = 0.04;
/** How often (sim seconds) the director looks at the whole mission state. */
const WATCH_EVERY = 0.25;

/** Turns game events and mission changes into voice lines. One per Game; pure apart from `say`. */
export class VoiceDirector {
  private started = false;
  private coldSaid = false;
  private waves = 0;
  private homes = 0;
  private kills: number;
  private prev: VoiceWorld | null = null;
  private integrityMark = 1;
  private nextWatch = 0;

  constructor(
    private say: (line: VoiceLine) => void,
    seed = 0,
  ) {
    this.kills = Math.abs(Math.floor(seed)) % KILL_LINES.length;
  }

  /** Call once a frame while the mission runs, with that frame's events. */
  update(events: readonly SimEvent[], sim: Parameters<typeof voiceWorld>[0]): void {
    if (!this.started) {
      this.started = true;
      const w = voiceWorld(sim);
      this.say('cleared-hot');
      // Truthful: only when the mission really has cold-blooded contacts out there now.
      if (w.coldAlive > 0) {
        this.coldSaid = true;
        this.say('cold-blooded');
      }
      this.prev = w;
      this.integrityMark = w.integrity;
    }
    for (const e of events) {
      const line = this.lineFor(e);
      if (line) this.say(line);
    }
    if (sim.t >= this.nextWatch) {
      this.nextWatch = sim.t + WATCH_EVERY;
      for (const line of this.watch(voiceWorld(sim))) this.say(line);
    }
  }

  /** A big kill was called in on the radio: banter, taking turns. */
  bigKill(): void {
    this.say(KILL_LINES[this.kills]);
    this.kills = (this.kills + 1) % KILL_LINES.length;
  }

  lineFor(e: SimEvent): VoiceLine | null {
    switch (e.type) {
      case 'friendly-hit':
        return 'check-fire';
      case 'danger-close':
        return 'danger-close';
      case 'survivor-lost':
        return 'survivor-lost';
      case 'survivor-home':
        return this.homes++ % 2 === 0 ? 'survivor-home-kettle' : 'survivor-home-quieter';
      case 'radio':
        return /under attack/i.test(e.text) ? 'friendlies-under-attack' : null;
      case 'wave': {
        const n = this.waves++;
        if (e.cold > 0 && !this.coldSaid) {
          this.coldSaid = true;
          return 'cold-blooded';
        }
        if (e.kind === 'rush') return 'rushers';
        if (e.kind === 'big') return 'big-group';
        return n === 0 || n % 2 === 0 ? 'new-contacts' : 'more-coming';
      }
      case 'result':
        return e.won ? 'mission-complete' : 'mission-failed';
      default:
        return null;
    }
  }

  /** Changes in the mission that no event reports. */
  watch(w: VoiceWorld): VoiceLine[] {
    const p = this.prev;
    this.prev = w;
    if (!p || !w.running) return [];
    const out: VoiceLine[] = [];
    if (w.setOff > p.setOff) out.push('survivors-moving');
    if (w.defend && w.integrity < this.integrityMark - SAFEHOUSE_STEP) {
      this.integrityMark = w.integrity;
      out.push('safehouse-hits');
    }
    if (p.zombiesAlive > 0 && w.zombiesAlive === 0) out.push('all-clear');
    if (w.coldAlive > 0 && !this.coldSaid) {
      this.coldSaid = true;
      out.push('cold-blooded');
    }
    return out;
  }
}

// ---------- playback ----------

/** Squelch: the burst in the file runs ~0.2–0.7 s; play a short slice of it before each line. */
export const SQUELCH = { offset: 0.18, length: 0.32, gain: 0.22 };
/** The line starts this long after its squelch. */
const LEAD = 0.26;
/** A cut line fades out this fast (s). */
const CUT_FADE = 0.06;

export interface VoiceLogEntry {
  line: VoiceLine;
  start: number;
  end: number;
}

type Buffers = { get(id: string): AudioBuffer | null; status?(id: string): string };
/** A line asked for while its file is still loading waits this long (s) for it. */
const LOAD_WAIT = 4;

/** Plays the VoiceQueue's choices: squelch, then the line through a radio band-pass, music ducked. */
export class VoiceChannel {
  readonly queue: VoiceQueue;
  private kit: Kit;
  private playing: { src: AudioBufferSourceNode; g: GainNode; entry: VoiceLogEntry } | null = null;
  /** Recent lines (audio-clock times; end = when it really stopped) for the automated check. */
  readonly log: VoiceLogEntry[] = [];
  said = 0;
  /** Lines asked for before their file arrived (e.g. "cleared hot" on the very first mission). */
  private deferred: { line: VoiceLine; at: number }[] = [];

  constructor(
    private ctx: AudioContext,
    private dest: AudioNode,
    private bank: Buffers,
    private duck: (depth: number, hold: number) => void,
    count?: (d: number) => void,
  ) {
    this.kit = new Kit(ctx, count);
    this.queue = new VoiceQueue((line) => {
      const b = bank.get(voiceAsset(line));
      return b ? b.duration + LEAD + 0.1 : 0;
    });
  }

  say(line: VoiceLine): void {
    // The mission is over: whatever was waiting is stale news.
    if (line === 'mission-complete' || line === 'mission-failed') {
      this.queue.clear();
      this.deferred = [];
    }
    const now = this.ctx.currentTime;
    const st = this.bank.status?.(voiceAsset(line));
    if (!this.bank.get(voiceAsset(line)) && (st === 'idle' || st === 'queued' || st === 'loading')) {
      if (!this.deferred.some((d) => d.line === line)) this.deferred.push({ line, at: now });
    } else this.queue.say(line, now);
    this.tick();
  }

  tick(): void {
    const now = this.ctx.currentTime;
    if (this.deferred.length) {
      const keep: { line: VoiceLine; at: number }[] = [];
      for (const d of this.deferred) {
        if (this.bank.get(voiceAsset(d.line))) this.queue.say(d.line, now);
        else if (now - d.at < LOAD_WAIT && this.bank.status?.(voiceAsset(d.line)) !== 'failed') keep.push(d);
      }
      this.deferred = keep;
    }
    const next = this.queue.poll(now);
    if (!next) return;
    if (next.cut) this.cut(now);
    this.play(next.line, now + (next.cut ? CUT_FADE + 0.02 : 0.02));
  }

  private play(line: VoiceLine, t: number): void {
    const { ctx, kit } = this;
    const buf = this.bank.get(voiceAsset(line));
    if (!buf) return;
    const sq = this.bank.get(SFX.squelch);
    if (sq) {
      const s = ctx.createBufferSource();
      s.buffer = sq;
      const sg = ctx.createGain();
      sg.gain.setValueAtTime(SQUELCH.gain, t);
      sg.gain.setValueAtTime(SQUELCH.gain, t + SQUELCH.length - 0.06);
      sg.gain.linearRampToValueAtTime(0, t + SQUELCH.length);
      s.connect(sg).connect(this.dest);
      if (kit.adopt(s, sg)) {
        s.start(t, SQUELCH.offset, SQUELCH.length);
        s.stop(t + SQUELCH.length + 0.02);
      }
    }
    // A gentle radio band (keeps the words clear).
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 260;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = 4200;
    const g = ctx.createGain();
    g.gain.value = 0.9;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(hp).connect(lp).connect(g).connect(this.dest);
    const start = t + LEAD;
    const entry = { line, start, end: start + buf.duration };
    if (!kit.adopt(src, hp, lp, g)) return;
    src.start(start);
    src.stop(entry.end + 0.02);
    src.addEventListener('ended', () => {
      if (this.playing?.src === src) this.playing = null;
    });
    this.playing = { src, g, entry };
    this.log.push(entry);
    if (this.log.length > 40) this.log.shift();
    this.said++;
    // Music (and the drone) duck under the voice, for as long as it speaks.
    this.duck(DUCK_VOICE, entry.end - ctx.currentTime + 0.2);
  }

  /** Stop the line on air now (fast fade, no click). */
  private cut(now: number): void {
    const p = this.playing;
    if (!p) return;
    this.playing = null;
    const end = Math.max(now, Math.min(p.entry.end, now + CUT_FADE));
    p.entry.end = Math.max(p.entry.start, end);
    try {
      p.g.gain.cancelScheduledValues(now);
      p.g.gain.setValueAtTime(p.g.gain.value, now);
      p.g.gain.linearRampToValueAtTime(0, now + CUT_FADE);
      p.src.stop(now + CUT_FADE + 0.01);
    } catch {
      /* already ended */
    }
  }

  /** The screen is going (retry, quit): stop talking and forget what was waiting. */
  hush(): void {
    const now = this.ctx.currentTime;
    this.cut(now);
    this.queue.stop(now);
    this.deferred = [];
  }

  /** Lines whose sound overlapped the previous line's (must stay 0). */
  overlaps(): number {
    let n = 0;
    for (let i = 1; i < this.log.length; i++) if (this.log[i].start < this.log[i - 1].end - 1e-3) n++;
    return n;
  }
}

/** How far the music ducks under a voice line. */
export const DUCK_VOICE = 0.45;
