import { polylineLength } from '../map/geom';
import type { Mission, MissionType } from './missions';

/**
 * Mission grades, S (best) to D. A pure function of how the mission went, so the same result
 * always earns the same grade. What counts, most first:
 *   1. people saved (survivors home, friendlies alive, the safehouse intact): 55 points;
 *   2. friendly fire: 25 points off per incident, and any incident caps the grade at B;
 *   3. time against the par: 18 points (Hold missions last a fixed time, so their 18 go to the safehouse instead);
 *   4. rounds per kill: 12 points.
 * Winning is worth 15 points on its own; a lost mission is always D.
 */
export type Grade = 'S' | 'A' | 'B' | 'C' | 'D';
export const GRADES: readonly Grade[] = ['S', 'A', 'B', 'C', 'D'];

export interface ScoreInput {
  won: boolean;
  type: MissionType;
  /** Seconds the mission took. */
  time: number;
  /** Seconds a quick, clean run takes (see parTime). Ignored for defend. */
  par: number;
  /** Escort: survivors who set off. Clear: sheltering friendlies. Defend: stragglers on their way in. */
  survivorsTotal: number;
  /** Escort and defend: made it in. Clear: still alive. */
  survivorsSaved: number;
  friendlyHits: number;
  shots: number;
  kills: number;
  /** Defend: the safehouse, 0..1. */
  integrity: number;
}

export interface Score {
  grade: Grade;
  /** 0..100. */
  points: number;
  /** One line, e.g. "A: all survivors home, zero friendly fire, a bit slow". */
  reason: string;
}

/** Grade boundaries on points (a grade needs at least this many). */
export const GRADE_POINTS: Record<Exclude<Grade, 'D'>, number> = { S: 90, A: 78, B: 62, C: 45 };

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** 1 when the mission took par or less, falling to 0 at 1.5x par. */
export function timeScore(time: number, par: number): number {
  if (!(par > 0)) return 1;
  return clamp01(1 - (time / par - 1) / 0.5);
}

/** 1 at 1.5 rounds per kill or better, falling to 0 at 6. */
export function ammoScore(shots: number, kills: number): number {
  if (shots <= 0) return 1;
  const rpk = shots / Math.max(1, kills);
  return clamp01(1 - (rpk - 1.5) / 4.5);
}

/** Share of the people saved, 0..1 (for defend, the safehouse counts as most of it). */
export function savedShare(i: ScoreInput): number {
  const people = i.survivorsTotal > 0 ? clamp01(i.survivorsSaved / i.survivorsTotal) : 1;
  if (i.type === 'defend') return i.survivorsTotal > 0 ? 0.6 * clamp01(i.integrity) + 0.4 * people : clamp01(i.integrity);
  return people;
}

export function gradeMission(i: ScoreInput): Score {
  const saved = savedShare(i);
  const timed = i.type !== 'defend';
  const ts = timed ? timeScore(i.time, i.par) : 1;
  const as = ammoScore(i.shots, i.kills);
  const lostSomeone = i.survivorsTotal > 0 && i.survivorsSaved < i.survivorsTotal;
  let points = 0;
  let grade: Grade = 'D';
  if (i.won) {
    points = 15 + (timed ? 55 * saved + 18 * ts : 73 * saved) + 12 * as - 25 * i.friendlyHits;
    points = Math.max(0, Math.min(100, Math.round(points)));
    grade = points >= GRADE_POINTS.S ? 'S' : points >= GRADE_POINTS.A ? 'A' : points >= GRADE_POINTS.B ? 'B' : points >= GRADE_POINTS.C ? 'C' : 'D';
    // Caps: a perfect grade needs everyone saved and clean hands.
    if (grade === 'S' && (lostSomeone || (i.type === 'defend' && i.integrity < 0.95))) grade = 'A';
    if (i.friendlyHits > 0 && rank(grade) < rank('B')) grade = 'B';
  }
  const parts = [savedPhrase(i)];
  parts.push(i.friendlyHits === 0 ? 'zero friendly fire' : i.friendlyHits === 1 ? 'one friendly-fire incident' : `${i.friendlyHits} friendly-fire incidents`);
  if (i.won) {
    // The weakest of pace and shooting, or praise when both are good.
    const weakTime = timed && ts < 0.75;
    const weakAmmo = as < 0.6;
    if (weakTime && (!weakAmmo || ts <= as)) parts.push(ts < 0.35 ? 'slow' : 'a bit slow');
    else if (weakAmmo) parts.push(as < 0.25 ? 'a lot of rounds per kill' : 'a few too many rounds per kill');
    else parts.push(timed ? 'quick and accurate' : 'accurate shooting');
  }
  const reason = `${grade}: ${i.won ? '' : 'mission failed, '}${parts.join(', ')}`;
  return { grade, points, reason };
}

/** 0 = S ... 4 = D. Lower is better. */
export function rank(g: Grade): number {
  return GRADES.indexOf(g);
}

function savedPhrase(i: ScoreInput): string {
  const n = i.survivorsTotal;
  const s = i.survivorsSaved;
  if (i.type === 'escort') return s >= n ? 'all survivors home' : s === 0 ? 'nobody made it home' : `${s} of ${n} home`;
  if (i.type === 'clear') {
    if (!n) return 'no friendlies to protect';
    if (s >= n) return n === 2 ? 'both friendlies safe' : 'all friendlies safe';
    return s === 0 ? (n === 2 ? 'both friendlies lost' : 'every friendly lost') : `${n - s} of ${n} friendlies lost`;
  }
  const pct = Math.round(clamp01(i.integrity) * 100);
  const house = pct >= 99 ? 'safehouse untouched' : pct <= 0 ? 'safehouse overrun' : `safehouse ${pct}% intact`;
  if (!n) return house;
  return `${house}, ${s >= n ? 'stragglers safe' : s === 0 ? 'stragglers lost' : `${s} of ${n} stragglers in`}`;
}

/**
 * Seconds a quick, clean run takes. Clear: 40% of the time limit. Escort: the survivors' walk at
 * their steady pace from the last one setting off, plus a little slack. Defend: the hold time (fixed).
 */
export function parTime(m: Mission): number {
  if (m.type === 'clear') return m.timeLimit * 0.4;
  if (m.type === 'escort' && m.route) {
    const lastOff = Math.max(0, ...m.survivors.map((s) => s.delay));
    return polylineLength(m.route) / ESCORT_PACE + lastOff + 15;
  }
  return m.timeLimit;
}
/** Survivors' steady walking pace, m/s (they hurry when zombies are close, and stop when caught). */
export const ESCORT_PACE = 2.1;

/** Builds the score input from a finished simulation's mission and state. */
export function scoreInput(m: Mission, s: {
  phase: string; t: number; survivorsTotal: number; survivorsHome: number; survivorsAlive: number;
  friendlyHits: number; shots: number; kills: number; integrity: number;
}): ScoreInput {
  return {
    won: s.phase === 'won',
    type: m.type,
    time: s.t,
    par: parTime(m),
    survivorsTotal: s.survivorsTotal,
    survivorsSaved: m.type === 'clear' ? s.survivorsAlive : s.survivorsHome,
    friendlyHits: s.friendlyHits,
    shots: s.shots,
    kills: s.kills,
    integrity: s.integrity,
  };
}
