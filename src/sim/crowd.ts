import type { MapData, V2 } from '../map/types';
import { dist } from '../map/geom';
import type { RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { childMask, featureName, templateAnchors } from '../map/recon';
import { hashString, mulberry32, shuffle } from '../util/rng';
import { MAX_KILL_REACH } from './weapons';
import { CHILD_FIRE_CLEARANCE, findSafehouse, placeLabel, safehouseFromFeature, type Mission, type MissionResult } from './missions';

/**
 * Spec 003, Horde Night (working title; the Story Writer names it): a five-minute hold till dawn at a real
 * landmark while dense, all-warm streams walk in on a schedule that runs on time only. Mission type 'defend'
 * with a `crowd` plan; MISSION_TYPES is untouched, so no other mission changes.
 */
export type CrowdSize = 'big' | 'huge';
export const CROWD_SIZE_IDS: readonly CrowdSize[] = ['big', 'huge'];

/** The owner's cap: at most this many zombie figures drawn at once, living and bodies together (22 Nov 2026). */
export const CROWD_FIGURE_CAP = 1200;

export interface CrowdSizeDef {
  /** Most alive at once: spawns over it are dropped, never queued. */
  maxAlive: number;
  /** Bodies left on the ground (drawn); maxAlive + bodies <= CROWD_FIGURE_CAP. */
  bodies: number;
  /** Most full character models drawn at once (render level of detail). */
  models: number;
  /** Roughly how many arrive over a run (sets the streams' peak rate). */
  total: number;
}
export const CROWD_SIZES: Record<CrowdSize, CrowdSizeDef> = {
  big: { maxAlive: 600, bodies: 400, models: 150, total: 2400 },
  huge: { maxAlive: 800, bodies: 400, models: 400, total: 3000 },
};

/** One row of the schedule: from..to seconds, how many streams are open, and their rate (x the plan's peak, per stream). */
export interface CrowdRow {
  from: number;
  to: number;
  streams: number;
  rate: number;
}
/** Run length: dawn. */
export const DAWN = 300;
/**
 * The schedule, in spawn time (Balance Analyst owns the numbers). A pure function of t, so the briefing can quote
 * it. The surge spawns from SURGE_START and is at the doors in the last ~75 s; nothing new after 255 s (it
 * couldn't arrive before dawn).
 */
export const CROWD_SCHEDULE: readonly CrowdRow[] = [
  { from: 0, to: 45, streams: 2, rate: 0.25 }, // warm-up: two thin streams
  { from: 45, to: 100, streams: 3, rate: 0.5 }, // build
  { from: 100, to: 150, streams: 4, rate: 0.75 }, // build: every direction open
  { from: 150, to: 160, streams: 4, rate: 0 }, // the lull
  { from: 160, to: 255, streams: 4, rate: 1 }, // dawn surge
];
export const SURGE_START = 160;
/** Crowd zombies walk at the difficulty-3 speeds (no dial) times this: a purposeful shamble. */
export const CROWD_DIFFICULTY = 3;
export const CROWD_SPEED = 1.35;
/** Slowest crowd zombie (m/s): Sim.spawnZombie's 1.3 + 0.08 x difficulty, times CROWD_SPEED. */
export const CROWD_SLOWEST = (1.3 + 0.08 * CROWD_DIFFICULTY) * CROWD_SPEED;
/** Spawn spots: up to this far either side of the stream's road node, across the road (metres). */
export const STREAM_JITTER = 6;
/** Never more than this many spawns in one step, across all streams. */
export const MAX_SPAWNS_PER_STEP = 8;
/** Stream origins sit this far from the doors, straight line (metres). */
export const STREAM_MIN = 170;
export const STREAM_MAX = 420;
/**
 * The child guardrail for crowds (spec 003 §5): no living zombie, at any moment, within reach of a 105 round landing
 * CHILD_FIRE_CLEARANCE from a school, kindergarten or playground. The no-go mask adds half a cell's diagonal so
 * every point of an allowed cell is at least this far.
 */
export const CROWD_CHILD_GAP = MAX_KILL_REACH + CHILD_FIRE_CLEARANCE;
/**
 * Door damage, capped (a per-zombie drain would end a run in a second): integrity lost per second per zombie at the
 * doors, up to `cap` of them. A full pile of 30 breaks them in 3 minutes; doing nothing loses at about 4:25.
 */
export const CROWD_DOORS = { cap: 30, rate: 1 / (30 * 180) };
/** Multiplier: +1 for every MULT_UP seconds the doors go untouched (to MULT_MAX); -1 at first contact, then every MULT_DOWN s of contact. */
export const MULT_MAX = 5;
export const MULT_UP = 25;
export const MULT_DOWN = 6;
/** The doors' alarm (Feel M4): a living zombie within this many field steps of the doors, before the multiplier drops. */
export const ALARM_STEPS = 12;
/** Separation (kerb to kerb): zombies closer than this push apart, at up to SEP_PUSH m/s. Crowd mode only. */
export const SEP_RADIUS = 1.2;
export const SEP_PUSH = 1.6;

export interface CrowdStream {
  /** The road node it walks in from. */
  at: V2;
  /** Direction from the doors, as the briefing says it. */
  compass: string;
  /** The street or place it comes down (untrusted map text: textContent only). */
  street: string;
  /** Seconds the slowest zombie needs from here to the doors (with slack for corners). */
  walk: number;
}

export interface CrowdPlan {
  size: CrowdSize;
  streams: CrowdStream[];
  schedule: CrowdRow[];
  /** Spawns per second per open stream at rate 1. */
  peakRate: number;
  maxAlive: number;
  doors: { cap: number; rate: number };
}

/** Rate (zombies per second) of stream `k` at time t. */
export function streamRate(plan: CrowdPlan, k: number, t: number): number {
  for (const r of plan.schedule) if (t >= r.from && t < r.to) return k < r.streams ? r.rate * plan.peakRate : 0;
  return 0;
}

const SECTORS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
function sector(from: V2, to: V2): number {
  const a = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
  return Math.round(((a + 360) % 360) / 45) % 8;
}
const sectorGap = (a: number, b: number) => Math.min((a - b + 8) % 8, (b - a + 8) % 8);

/** The doors: free cells just outside the building, never inside the child no-go mask. */
export function crowdDoors(grid: WalkGrid, poly: V2[], noGo: Uint8Array): number[] {
  return grid.perimeterCells(poly).filter((k) => !noGo[k]);
}

/** The child no-go mask used by the generator and the sim (cached per grid). */
export function crowdNoGo(map: MapData, grid: WalkGrid): Uint8Array {
  return childMask(map, grid, CROWD_CHILD_GAP + grid.cell * Math.SQRT1_2 + 1e-6);
}

const noWayIn = (place: string) => `There's no way in to ${place} that keeps clear of schools and playgrounds, so there's no Horde Night here.`;

/**
 * Build a crowd night: the first anchor (sports centre or stadium, then police, fire station or hospital, then the
 * classic safehouse) whose doors are clear of the child mask and that 3-4 streams can feed in time for the surge.
 */
export function generateCrowd(map: MapData, g: RoadGraph, grid: WalkGrid, opts: { seed: number; size: CrowdSize; anchor?: string }): MissionResult {
  const size = CROWD_SIZES[opts.size];
  if (!size) return { ok: false, reason: `Unknown crowd size "${String(opts.size)}".` };
  if (g.mainComp < 0) return { ok: false, reason: 'There are too few connected roads here to build a mission. Try a more built-up spot, or the sample town.' };
  const noGo = crowdNoGo(map, grid);
  type Cand = { id: string; name: string; safehouse: NonNullable<Mission['safehouse']>; anchor?: Mission['anchor'] };
  const cands: Cand[] = [];
  for (const t of ['hold-sports', 'hold-landmark'] as const) {
    for (const f of templateAnchors(map, t, opts.seed)) {
      if (opts.anchor !== undefined && f.id !== opts.anchor) continue;
      const name = featureName(map, f);
      cands.push({ id: f.id, name, safehouse: safehouseFromFeature(map, f, name), anchor: { id: f.id, name, category: f.category, p: f.p, ...(f.pts ? { pts: f.pts } : {}) } });
    }
  }
  if (opts.anchor === undefined) {
    const sh = findSafehouse(map, g, mulberry32(hashString(`crowd-safehouse|${map.name}|${opts.seed}`)));
    if (sh) cands.push({ id: 'safehouse', name: sh.name, safehouse: sh });
  }
  if (!cands.length) {
    return { ok: false, reason: opts.anchor !== undefined ? 'That place can\'t hold a Horde Night.' : "There's no sports centre, police station, fire station or hospital here to hold, so there's no Horde Night here." };
  }
  for (const c of cands) {
    const streams = planStreams(map, g, grid, noGo, c.safehouse, opts.seed, c.id);
    if (!streams) continue;
    return { ok: true, mission: crowdMission(map, opts, c.safehouse, streams, c.anchor) };
  }
  return { ok: false, reason: noWayIn(cands[0].name) };
}

/** 3-4 streams on real roads, in sectors at least two apart, each able to walk in before dawn. Null if fewer than 3. */
function planStreams(map: MapData, g: RoadGraph, grid: WalkGrid, noGo: Uint8Array, sh: NonNullable<Mission['safehouse']>, seed: number, anchorId: string): CrowdStream[] | null {
  const doors = crowdDoors(grid, sh.poly, noGo);
  const all = grid.perimeterCells(sh.poly);
  // A child place within the gap of any door: this anchor isn't offered (the gap is never shrunk).
  if (!doors.length || doors.length < all.length) return null;
  const field = grid.flowField(doors, noGo);
  const lim = map.half * 0.95;
  const latest = DAWN - 10 - SURGE_START;
  const bySector: { i: number; walk: number }[][] = Array.from({ length: 8 }, () => []);
  for (let i = 0; i < g.nodes.length; i++) {
    if (g.comp[i] !== g.mainComp) continue;
    const p = g.nodes[i];
    if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) continue;
    const r = dist(p, sh.centre);
    if (r < STREAM_MIN || r > STREAM_MAX) continue;
    const k = grid.idx(p.x, p.z);
    if (k < 0 || noGo[k] || grid.isBlocked(p.x, p.z) || field[k] <= 0) continue;
    const walk = (field[k] * grid.cell * 1.25) / CROWD_SLOWEST;
    if (walk > latest) continue; // the surge couldn't reach the doors before dawn from here
    bySector[sector(sh.centre, p)].push({ i, walk });
  }
  const rng = mulberry32(hashString(`crowd|${map.name}|${seed}|${anchorId}`));
  // Each sector's candidate: one of its farthest-walking nodes (long streams make the best shooting), seeded.
  const pickIn = bySector.map((list) => {
    if (!list.length) return null;
    list.sort((a, b) => b.walk - a.walk || a.i - b.i);
    const top = list.slice(0, Math.max(1, Math.ceil(list.length / 3)));
    return top[Math.floor(rng() * top.length)];
  });
  // The largest set of sectors pairwise >= 2 apart (at most 4), seeded among equals.
  const open = pickIn.map((c, s) => (c ? s : -1)).filter((s) => s >= 0);
  let best: number[] = [];
  const sets: number[][] = [];
  for (let m = 1; m < 256; m++) {
    const set = open.filter((_, b) => m & (1 << b));
    if (set.length < best.length || set.length > 4) continue;
    if (set.some((a, x) => set.some((b, y) => x < y && sectorGap(a, b) < 2))) continue;
    if (set.length > best.length) {
      best = set;
      sets.length = 0;
    }
    sets.push(set);
  }
  if (best.length < 3) return null;
  const chosen = sets[Math.floor(rng() * sets.length)];
  const streams = shuffle(rng, [...chosen]).map((s) => {
    const at = g.nodes[pickIn[s]!.i];
    return { at: { x: at.x, z: at.z }, compass: SECTORS[s], street: placeLabel(map, at), walk: Math.round(pickIn[s]!.walk * 10) / 10 };
  });
  return streams;
}

function crowdMission(map: MapData, opts: { seed: number; size: CrowdSize }, safehouse: NonNullable<Mission['safehouse']>, streams: CrowdStream[], anchor?: Mission['anchor']): Mission {
  const size = CROWD_SIZES[opts.size];
  // The peak rate that brings about `total` over the run with this many streams.
  let units = 0;
  for (const r of CROWD_SCHEDULE) units += Math.min(r.streams, streams.length) * r.rate * (r.to - r.from);
  const peakRate = Math.round((size.total / units) * 1000) / 1000;
  const name = safehouse.name;
  const ways = streams.map((s) => `from the ${s.compass} along ${s.street}`);
  const list = ways.length > 1 ? `${ways.slice(0, -1).join(', ')} and ${ways[ways.length - 1]}` : ways[0];
  return {
    type: 'defend',
    difficulty: CROWD_DIFFICULTY,
    seed: opts.seed,
    mapName: map.name,
    title: `Horde Night — ${name}`,
    briefing: [
      `Spooky, this is Ground. Everyone left on this side of town is behind the doors of ${name}. Keep the dead off those doors till dawn: five minutes.`,
      `They're coming in ${list}.`,
      'Thin to start, thicker as it goes, a short quiet spell, then the thickest of it just before dawn.',
      'Nobody is out on the streets but them, and every one of them is warm. Weapons free.',
    ],
    intel: ['Intel: no cold-blooded contacts tonight. Every one of them shows warm.', 'Intel: no friendlies in the field. Nobody is out there but them.'],
    timeLimit: DAWN,
    orbitCentre: { ...safehouse.centre },
    safehouse,
    survivors: [],
    needHome: 0,
    hordes: [],
    friendlyFireLimit: 2,
    ...(anchor ? { anchor } : {}),
    crowd: { size: opts.size, streams, schedule: CROWD_SCHEDULE.map((r) => ({ ...r })), peakRate, maxAlive: size.maxAlive, doors: { ...CROWD_DOORS } },
  };
}

/** Which anchors offer the mode on this map (for recon and the map check): name and ok/reason. */
export function crowdAnchors(map: MapData, g: RoadGraph, grid: WalkGrid, seed: number): { id: string; name: string; ok: boolean; streams: number }[] {
  const noGo = crowdNoGo(map, grid);
  const out: { id: string; name: string; ok: boolean; streams: number }[] = [];
  for (const t of ['hold-sports', 'hold-landmark'] as const) {
    for (const f of templateAnchors(map, t, seed)) {
      const name = featureName(map, f);
      const s = planStreams(map, g, grid, noGo, safehouseFromFeature(map, f, name), seed, f.id);
      out.push({ id: f.id, name, ok: !!s, streams: s?.length ?? 0 });
    }
  }
  const sh = findSafehouse(map, g, mulberry32(hashString(`crowd-safehouse|${map.name}|${seed}`)));
  if (sh) {
    const s = planStreams(map, g, grid, noGo, sh, seed, 'safehouse');
    out.push({ id: 'safehouse', name: sh.name, ok: !!s, streams: s?.length ?? 0 });
  }
  return out;
}
