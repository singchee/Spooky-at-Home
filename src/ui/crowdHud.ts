import type { CrowdStats } from '../sim/sim';
import { el } from './dom';

/**
 * Spec 003 HUD for crowd nights (Feel M1-M4, S1-S3): KILLS, the ×N multiplier and the score at the top centre,
 * clear of the guns panel, the stick and the buttons; a door alarm that changes words, not only colour; and
 * "×N" tallies over impacts. All text goes in with textContent (place names are map text). Elements are
 * reused and moved with transform; nothing is built per kill.
 */

/** Tallies: only for rounds (or 25 mm bursts) that kill at least this many. */
export const TALLY_MIN = 5;
/** At most this many tallies on screen; a new one fades the oldest out. */
export const TALLY_MAX = 3;
/** Fade in, hold, fade out (seconds). Fades are never shorter than 0.3 s (no pop, no pulse). */
export const TALLY_IN = 0.3;
export const TALLY_HOLD = 1.4;
export const TALLY_OUT = 0.4;
/** A 25 mm burst ends when no 25 mm round has landed for this long (the trigger let go, or the magazine ran dry). */
export const BURST_GAP = 0.35;
/** The kill counter changes at most this often (Feel S1). */
export const COUNTER_HZ = 4;
/** Multiplier changes fade out and in over this long. */
export const MULT_FADE = 0.3;

interface Tally {
  el: HTMLDivElement;
  x: number;
  z: number;
  /** When it appeared, and when it started fading out (-1: not yet). */
  t0: number;
  out: number;
  live: boolean;
}

/**
 * Which tallies to show for an impact: the 105 and the 40 make one per round of TALLY_MIN or more; the 25 mm adds
 * up a burst into one tally (see BurstCounter). Pure, for tests.
 */
export function tallyFor(weapon: string, kills: number): boolean {
  return (weapon === '105' || weapon === '40') && kills >= TALLY_MIN;
}

/** Sums a 25 mm burst; `flush` returns the burst's total and last impact once it's over. */
export class BurstCounter {
  private sum = 0;
  private last = -1;
  private at = { x: 0, z: 0 };
  add(kills: number, x: number, z: number, now: number): void {
    this.sum += kills;
    this.last = now;
    this.at = { x, z };
  }
  flush(now: number, force = false): { kills: number; x: number; z: number } | null {
    if (this.last < 0 || (!force && now - this.last < BURST_GAP)) return null;
    const out = { kills: this.sum, ...this.at };
    this.sum = 0;
    this.last = -1;
    return out;
  }
}

/** Opacity of a tally at `now` (calm: on or off, no fades). */
export function tallyOpacity(t: { t0: number; out: number }, now: number, calm: boolean): number {
  const age = now - t.t0;
  if (t.out >= 0) return calm ? 0 : Math.max(0, 1 - (now - t.out) / TALLY_OUT) * Math.min(1, age / TALLY_IN);
  if (calm) return 1;
  return Math.min(1, age / TALLY_IN);
}

export class CrowdHud {
  readonly root: HTMLDivElement;
  private killsEl: HTMLDivElement;
  private multEl: HTMLDivElement;
  private scoreEl: HTMLDivElement;
  private alarmEl: HTMLDivElement;
  private layer: HTMLDivElement;
  private pool: Tally[] = [];
  private burst = new BurstCounter();
  private shownKills = -1;
  private nextCounter = 0;
  private mult = 1;
  private multChangeAt = -99;
  private multPending = 1;

  constructor(parent: HTMLElement) {
    this.root = el('div', 'crowd-hud', undefined, parent);
    const top = el('div', 'crowd-top', undefined, this.root);
    this.killsEl = el('div', 'crowd-kills', 'KILLS 0', top);
    this.multEl = el('div', 'crowd-mult', '×1', top);
    this.scoreEl = el('div', 'crowd-score', 'SCORE 0', top);
    this.alarmEl = el('div', 'crowd-alarm', '', this.root);
    this.alarmEl.hidden = true;
    this.layer = el('div', 'crowd-tallies', undefined, this.root);
    // TALLY_MAX on screen, plus one that can be fading out while a new one fades in.
    for (let i = 0; i < TALLY_MAX + 1; i++) {
      const t = el('div', 'crowd-tally', '', this.layer);
      t.style.opacity = '0';
      this.pool.push({ el: t, x: 0, z: 0, t0: -99, out: -99, live: false });
    }
  }

  /** A round landed. The 105 and 40 tally per round; the 25 mm adds to its burst. */
  impact(weapon: string, kills: number, x: number, z: number, now: number): void {
    if (weapon === '25') {
      const done = this.burst.flush(now);
      if (done && done.kills >= TALLY_MIN) this.spawn(done.kills, done.x, done.z, now);
      this.burst.add(kills, x, z, now);
      return;
    }
    if (tallyFor(weapon, kills)) this.spawn(kills, x, z, now);
  }

  private spawn(kills: number, x: number, z: number, now: number): void {
    const live = this.pool.filter((t) => t.live && t.out < 0).sort((a, b) => a.t0 - b.t0);
    if (live.length >= TALLY_MAX) live[0].out = now; // the oldest fades out, never pops
    const free = this.pool.find((t) => !t.live) ?? this.pool.filter((t) => t.out >= 0).sort((a, b) => a.out - b.out)[0] ?? this.pool[0];
    Object.assign(free, { x, z, t0: now, out: -1, live: true });
    free.el.textContent = `×${kills}`; // a tally is ×N and nothing else
  }

  /** Called every frame: counter (at most COUNTER_HZ), multiplier fade, the door alarm, and the tallies. */
  update(s: CrowdStats, now: number, calm: boolean, screenOf: (x: number, z: number) => { x: number; y: number; visible: boolean }): void {
    const b = this.burst.flush(now);
    if (b && b.kills >= TALLY_MIN) this.spawn(b.kills, b.x, b.z, now);
    if (now >= this.nextCounter && s.kills !== this.shownKills) {
      this.shownKills = s.kills;
      this.nextCounter = now + 1 / COUNTER_HZ;
      this.killsEl.textContent = `KILLS ${s.kills.toLocaleString('en-AU')}`;
      this.scoreEl.textContent = `SCORE ${s.score.toLocaleString('en-AU')}`;
    }
    // The multiplier fades out, changes, fades back in (calm: changes at once).
    if (s.multiplier !== this.multPending) {
      this.multPending = s.multiplier;
      this.multChangeAt = now;
      this.multEl.classList.toggle('down', s.multiplier < this.mult);
    }
    const since = now - this.multChangeAt;
    if (this.mult !== this.multPending && (calm || since >= MULT_FADE)) {
      this.mult = this.multPending;
      this.multEl.textContent = `×${this.mult}`;
    }
    this.multEl.style.opacity = calm || since >= 2 * MULT_FADE ? '1' : since < MULT_FADE ? String(1 - since / MULT_FADE) : String((since - MULT_FADE) / MULT_FADE);
    // The tell before the multiplier drops (Feel M4): words, not just colour.
    const alarm = s.atDoors > 0 ? 'DOORS UNDER ATTACK' : s.alarm ? 'DOORS: THEY’RE CLOSE' : '';
    this.alarmEl.hidden = !alarm;
    if (this.alarmEl.textContent !== alarm) this.alarmEl.textContent = alarm;
    this.alarmEl.classList.toggle('hit', s.atDoors > 0);
    for (const t of this.pool) {
      if (!t.live) continue;
      if (t.out < 0 && now - t.t0 >= TALLY_IN + TALLY_HOLD) t.out = now;
      const o = tallyOpacity(t, now, calm);
      if (t.out >= 0 && (calm || now - t.out >= TALLY_OUT)) {
        t.live = false;
        t.el.style.opacity = '0';
        continue;
      }
      const p = screenOf(t.x, t.z);
      t.el.style.opacity = p.visible ? o.toFixed(3) : '0';
      t.el.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px) translate(-50%, -130%)`;
    }
  }

  /** Tallies on screen now (fading ones included), for tests. */
  get tallies(): number {
    return this.pool.filter((t) => t.live).length;
  }

  dispose(): void {
    this.root.remove();
  }
}
