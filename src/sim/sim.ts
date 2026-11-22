import type { MapData, V2 } from '../map/types';
import { dist, distToSegment, pointAlong, pointInPolygon, polylineLength } from '../map/geom';
import type { RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { hashString, mulberry32, type Rng } from '../util/rng';
import { nearChildPlace } from '../map/recon';
import { fmtTime, placeLabel } from './missions';
import {
  ALARM_STEPS, CROWD_SPEED, MAX_SPAWNS_PER_STEP, MULT_DOWN, MULT_MAX, MULT_UP, SEP_PUSH, SEP_RADIUS, STREAM_JITTER, crowdDoors, crowdNoGo, streamRate,
} from './crowd';
import { CHILD_FIRE_CLEARANCE, FIRST_WAVE, HORDE_EDGE, HORDE_SPREAD, HORDE_WANDER, SCATTER_LEASH, WAVE_KINDS, type Mission, type WaveKind } from './missions';
import type { LineId } from './campaignText';
import { KILL_REACH, MAX_KILL_REACH, WEAPONS, weaponById, type WeaponDef } from './weapons';

/**
 * The game rules with no graphics. Deterministic: same mission + same inputs at the
 * same times → same result. The browser renders it; tests and the bot play it headless.
 */
export interface Zombie {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  cold: boolean;
  alive: boolean;
  diedAt: number;
  home: V2 | null;
  goal: V2 | null;
  /** Clear missions (spec 002): 0 or unset = with its horde, 1 = fleeing a 105 hit, 2 = lurking, 3 = walking back. */
  scatter?: 0 | 1 | 2 | 3;
  /** When a scattered zombie starts back to its horde (sim time, s). */
  scatterT?: number;
  /** Fleeing until this time (s). */
  fleeUntil?: number;
  /** The way it ran: unit vector away from the impact, with a seeded wobble. */
  scatterDir?: V2;
  /** Seconds walking back without getting closer. */
  stuckT?: number;
  /** Seconds a horde zombie has made no headway, and the short detour it takes once wedged (see UNSTICK_S). */
  blockedT?: number;
  unstick?: { dir: V2; until: number };
}

/** Spec 002 (Balance Analyst's numbers). A 105 scatters surviving horde zombies within this multiple of its lethal radius. */
export const SCATTER_REACH = 2;
/** Fleeing: this multiple of a zombie's walking speed, for FLEE_S plus up to FLEE_JITTER seconds. */
export const FLEE_MUL = 3.2;
export const FLEE_S = 3;
export const FLEE_JITTER = 1;
/** Up to this many radians either side of straight away from the impact. */
export const SCATTER_WOBBLE = 0.5;
/** Seconds from the hit to heading back: REGROUP_S + REGROUP_PER_D per difficulty above 1, plus up to REGROUP_JITTER. */
export const REGROUP_S = 20;
export const REGROUP_PER_D = 3;
export const REGROUP_JITTER = 6;
/** Forest sweep regroups sooner (cold runners under trees are the hardest to find; spec 002 pillar 3). */
export const FOREST_REGROUP = 0.8;
/** Walking back: this multiple of a zombie's walking speed (lurking uses the idle shamble, 0.45). */
export const RETURN_MUL = 1;
/** A runner that can't get closer to its horde for this long gives up and mills where it is (still inside the leash). */
export const STUCK_S = 6;
/**
 * A zombie heading into a wall slides along it. If the slide keeps less than this share of its step, it is walking
 * into the wall nearly head-on (its goal is inside or behind a building): it picks a new goal instead. Without this
 * it crept a hundredth of a millimetre a step towards that goal for ever and stood still, which on grass made a
 * cold-blooded one invisible on thermal and motionless on night vision (owner's "can't find the last ones").
 */
export const SLIDE_MIN = 0.3;
/**
 * A horde zombie farther than HORDE_WANDER + LEFT_BEHIND from its anchor has been left behind (a building between it
 * and the drifting horde): it walks back along the horde's flow field instead of heading straight into the wall.
 */
export const LEFT_BEHIND = 4;
/** Tries at a milling goal the zombie can walk straight to, before it settles for one it can't. */
export const GOAL_TRIES = 4;
/** A horde zombie that makes no headway for this long (wedged in a corner) walks its horde's flow field for 3-5 s. */
export const UNSTICK_S = 2;
/** A horde's flow field is rebuilt once its anchor has drifted this far (metres). */
export const FIELD_REFRESH = 6;
/**
 * Endgame search help (owner's report: "I'm looking and looking and can't find them... so I just give up").
 * In Clear, once ENDGAME_LEFT or fewer are left (or that few cold-blooded ones), and nothing has been hit for
 * ENDGAME_QUIET_S seconds (or the gunner flicks cameras SEARCH_SWITCHES times in SEARCH_SWITCH_S without a hit),
 * Ground names where the stragglers are (true), a soft SEARCH_RADIUS circle marks each group (never the exact spot),
 * and the stragglers get restless and walk, so night vision shows them moving. A hit ends it; it re-arms.
 * It's a hint, not a reveal. Training night uses the same help on the cold one after TRAINING_QUIET_S.
 */
export const SEARCH_HELP = true;
export const ENDGAME_LEFT = 5;
export const ENDGAME_QUIET_S = 20;
export const TRAINING_QUIET_S = 15;
export const SEARCH_SWITCHES = 3;
export const SEARCH_SWITCH_S = 20;
/** The circle's radius (m), how far its centre may sit from a straggler, and how close to its rim one may get. */
export const SEARCH_RADIUS = 40;
export const SEARCH_OFFSET = 15;
export const SEARCH_MARGIN = 5;
/** Restless stragglers walk at this multiple of their walking speed (milling is a 0.45 shamble). */
export const RESTLESS_MUL = 1;
/** One soft search circle: what the minimap and screen marker show. */
export interface SearchArea {
  p: V2;
  r: number;
  /** How many stragglers it holds, and how many of those are cold-blooded. */
  n: number;
  cold: number;
}
/** A Clear in-mission line (radio script section C), with how many contacts are left for its caption. */
export type ClearLine = Extract<LineId, 'few-left' | 'cold-leftovers'>;

export interface Survivor {
  id: number;
  x: number;
  z: number;
  alive: boolean;
  home: boolean;
  hp: number;
  s: number;
  delay: number;
  offset: number;
  route: V2[] | null;
  routeLen: number;
  diedAt: number;
}

export interface Shell {
  weapon: WeaponDef;
  from: { x: number; y: number; z: number };
  to: V2;
  t0: number;
  tof: number;
}

export type SimEvent =
  | { type: 'fire'; weapon: string; from: { x: number; y: number; z: number }; to: V2; tof: number }
  | { type: 'impact'; weapon: string; x: number; z: number; kills: number }
  | { type: 'friendly-hit'; x: number; z: number }
  | { type: 'danger-close' }
  | { type: 'survivor-lost'; x: number; z: number }
  | { type: 'survivor-home' }
  | { type: 'wave'; count: number; cold: number; from: string; place: string; kind: WaveKind }
  | { type: 'radio'; text: string }
  | { type: 'line'; id: ClearLine; left: number }
  | { type: 'search'; text: string; left: number; cold: boolean }
  | { type: 'result'; won: boolean; reason: string };

export interface WeaponState {
  id: string;
  ammo: number;
  cooldown: number;
  reloading: number;
}

/** Spec 003: the crowd night's score, all sim-side and deterministic. */
export interface CrowdStats {
  kills: number;
  score: number;
  multiplier: number;
  bestMultiplier: number;
  /** The biggest single round: kills, gun, and where (untrusted map text). */
  best: { kills: number; weapon: string; place: string } | null;
  spawned: number;
  /** Spawns dropped because the crowd was at its size's cap (never queued: the schedule is time-only). */
  dropped: number;
  atDoors: number;
  /** A living zombie is close to the doors: the tell before the multiplier drops (Feel M4). */
  alarm: boolean;
}

export interface SimState {
  t: number;
  phase: 'running' | 'won' | 'lost';
  reason: string;
  type: Mission['type'];
  timeLeft: number;
  zombiesAlive: number;
  coldAlive: number;
  zombiesTotal: number;
  survivorsAlive: number;
  survivorsHome: number;
  survivorsTotal: number;
  needHome: number;
  integrity: number;
  friendlyHits: number;
  shots: number;
  kills: number;
  weapons: WeaponState[];
  /** Only on a crowd night (absent otherwise, so other modes' traces are unchanged). */
  crowd?: CrowdStats;
}

export const ORBIT = { radius: 1000, altitude: 1500, period: 120 };
/** New zombies never appear closer than this to a survivor (metres). Spawn points sit 12 m wide, so this leaves ~60 m. */
export const MIN_SPAWN_GAP = 75;
/** A wave's zombies appear within this many metres of its spawn point. */
export const WAVE_SPREAD = 12;
/**
 * Waves never spawn this close to a school, kindergarten or playground (guardrail, PLAN §9): far enough that
 * a 105 round on the freshly spawned wave still lands CHILD_FIRE_CLEARANCE clear of the grounds (12 + 24 + 30 = 66 m).
 */
export const WAVE_CHILD_GAP = WAVE_SPREAD + MAX_KILL_REACH + CHILD_FIRE_CLEARANCE;

/** Road nodes waves may never spawn at (1): within WAVE_CHILD_GAP of a school, kindergarten or playground. */
export function noWaveSpawn(map: MapData, graph: RoadGraph): Uint8Array {
  return Uint8Array.from(graph.nodes, (n) => (nearChildPlace(map, n, WAVE_CHILD_GAP) ? 1 : 0));
}

export class Sim {
  readonly mission: Mission;
  readonly map: MapData;
  readonly graph: RoadGraph;
  readonly grid: WalkGrid;
  t = 0;
  phase: SimState['phase'] = 'running';
  reason = '';
  /** Every zombie ever spawned, dead or alive, append-only (ids = indices for the renderer and tests). */
  zombies: Zombie[] = [];
  /**
   * The live zombies in id order (spec 003): every per-zombie loop walks this, so the dead cost the sim nothing.
   * Entries pushed onto `zombies` are picked up at the next sync (tests and Training push directly); dead ones
   * are removed by stable compaction at the end of a step, so the rng is drawn in exactly the old order.
   */
  readonly living: Zombie[] = [];
  private livingSeen = 0;
  private livingDirty = false;
  survivors: Survivor[] = [];
  shells: Shell[] = [];
  weapons: WeaponState[];
  integrity = 1;
  friendlyHits = 0;
  shots = 0;
  kills = 0;
  private events: SimEvent[] = [];
  private rng: Rng;
  private field: Int32Array | null = null;
  private fieldAge = 99;
  private waveTimer = 0;
  /** Index of the next wave kind in mission.waves.kinds (advances only when a wave really arrives). */
  private waveIndex = 0;
  /** Compass sectors (0-7) the last two waves came from, so the next one comes from somewhere new. */
  private waveSectors: number[] = [];
  private nextId = 0;
  private safeField: Int32Array | null = null;
  private lastDangerClose = -99;
  /** Road nodes waves may not spawn at: near schools, kindergartens, playgrounds. Computed once. */
  private noSpawn: Uint8Array;
  /** Seconds before zombies notice sheltering friendlies (longer on easy). */
  private shelterGrace: number;
  private lastUnderAttack = -99;
  /** Each survivor's destination footprint (the home or safehouse their route ends in): they go inside at its wall. */
  private doors: (V2[] | null)[] = [];
  /** A horde creeping toward the sheltering friendlies (clear missions). */
  private drift: { anchor: V2; target: V2; speed: number } | null = null;
  /** Shelled hordes scatter (spec 002): on for Clear unless the caller opts out (Training night). */
  readonly scatterOn: boolean;
  /** Scatter's own seeded stream, so the main stream is untouched until a 105 lands (hard rule 1). */
  private srng: Rng;
  /** Each horde: its movable anchor, where it gathered, and the place its runners are told they regroup at. */
  private hordes: { anchor: V2; origin: V2; label: string; regroup: string }[] = [];
  private hordeOf = new Map<V2, number>();
  private scatterSaid = false;
  private fewSaid = false;
  private coldSaid = false;
  /** Crowd night (spec 003): the child no-go mask, the spawner's own stream and accumulators, the score. */
  private noGo: Uint8Array | null = null;
  private crng: Rng | null = null;
  private spawnAcc: number[] = [];
  private crowdStats: CrowdStats | null = null;
  private calmT = 0;
  private contactT = 0;
  private contact = false;
  private bucketHead: Int32Array | null = null;
  private bucketNext = new Int32Array(0);
  private snapX = new Float64Array(0);
  private snapZ = new Float64Array(0);
  /** Endgame search help: quiet seconds before it starts (null = never on its own), and its own seeded stream. */
  private searchQuiet: number | null;
  private erng: Rng;
  private lastHit = -Infinity;
  private switches: number[] = [];
  private search: { ids: Set<number>; areas: (SearchArea & { ids: number[] })[]; kills: number } | null = null;

  constructor(mission: Mission, map: MapData, graph: RoadGraph, grid: WalkGrid, opts: { scatter?: boolean; drift?: boolean; search?: boolean } = {}) {
    this.mission = mission;
    this.map = map;
    this.graph = graph;
    this.grid = grid;
    this.rng = mulberry32(hashString(`sim|${mission.mapName}|${mission.seed}|${mission.type}|${mission.difficulty}`));
    this.weapons = WEAPONS.map((w) => ({ id: w.id, ammo: w.magazine, cooldown: 0, reloading: 0 }));
    // Each horde mills around its own movable anchor (a copy, so the mission data never changes).
    const anchors = mission.hordes.map((h) => ({ ...h.centre }));
    this.scatterOn = opts.scatter ?? mission.type === 'clear';
    // Endgame search help is Clear's (and Training's, on request); never a crowd night, whatever the caller asks.
    this.searchQuiet = SEARCH_HELP && !mission.crowd && (opts.search ?? mission.type === 'clear') ? ENDGAME_QUIET_S : null;
    this.erng = mulberry32(hashString(`search|${mission.mapName}|${mission.seed}|${mission.type}|${mission.difficulty}`));
    this.srng = mulberry32(hashString(`scatter|${mission.mapName}|${mission.seed}|${mission.type}|${mission.difficulty}`));
    mission.hordes.forEach((h, k) => {
      this.hordes.push({ anchor: anchors[k], origin: { ...h.centre }, label: h.label, regroup: h.label });
      this.hordeOf.set(anchors[k], k);
    });
    mission.hordes.forEach((h, k) => {
      // Only on ground the horde can walk to: never walled into a courtyard or a gap between buildings (owner's report).
      const field = this.hordeField(k);
      for (let i = 0; i < h.count; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * HORDE_SPREAD;
        this.spawnZombie(this.reachable(field, { x: h.centre.x + Math.cos(a) * r, z: h.centre.z + Math.sin(a) * r }, h.centre), i < h.cold, anchors[k]);
      }
    });
    // Clear missions: after the grace period, the horde nearest the sheltering friendlies drifts toward them,
    // so there is real pressure to find and protect them (the critic found the friendlies were never threatened).
    const shelter = mission.type === 'clear' && opts.drift !== false ? mission.survivors.find((s) => !s.route) : undefined;
    if (shelter && anchors.length) {
      let best = 0;
      anchors.forEach((a, k) => {
        if (dist(a, shelter.start) < dist(anchors[best], shelter.start)) best = k;
      });
      this.drift = { anchor: anchors[best], target: { ...shelter.start }, speed: 0.5 + 0.1 * mission.difficulty };
    }
    mission.survivors.forEach((p, i) => {
      this.survivors.push({
        id: i, x: p.start.x, z: p.start.z, alive: true, home: false, hp: 1, s: 0, delay: p.delay,
        offset: ((i % 3) - 1) * 1.4, route: p.route, routeLen: p.route ? polylineLength(p.route) : 0, diedAt: -1,
      });
      // Spread the waiting group out a little instead of stacking everyone on one point (never into a wall).
      const last = this.survivors[this.survivors.length - 1];
      last.x += ((i % 3) - 1) * 1.6;
      last.z += (Math.floor(i / 3) - 0.5) * 1.6;
      if (grid.isBlocked(last.x, last.z)) Object.assign(last, grid.nearestFree({ x: last.x, z: last.z }));
      this.doors.push(p.route ? destination(p.route[p.route.length - 1], map, mission.safehouse?.poly) : null);
    });
    if (mission.crowd && mission.safehouse) {
      this.noGo = crowdNoGo(map, grid);
      this.safeField = grid.flowField(crowdDoors(grid, mission.safehouse.poly, this.noGo), this.noGo);
      this.crng = mulberry32(hashString(`crowd-sim|${mission.mapName}|${mission.seed}|${mission.crowd.size}|${mission.anchor?.id ?? ''}`));
      this.spawnAcc = mission.crowd.streams.map(() => 0);
      this.crowdStats = { kills: 0, score: 0, multiplier: 1, bestMultiplier: 1, best: null, spawned: 0, dropped: 0, atDoors: 0, alarm: false };
    } else if (mission.safehouse && mission.type === 'defend') this.safeField = grid.flowField(grid.perimeterCells(mission.safehouse.poly));
    if (mission.waves) this.waveTimer = FIRST_WAVE; // first wave arrives quickly
    this.shelterGrace = Math.max(15, 45 - 6 * mission.difficulty);
    this.noSpawn = mission.waves ? noWaveSpawn(map, graph) : new Uint8Array(graph.nodes.length);
  }

  /** Walking steps to each horde's anchor (-1 = can't get there). Computed on first use, again once the anchor drifts. */
  private fields = new Map<number, { at: V2; f: Int32Array }>();
  private hordeField(k: number): Int32Array {
    const a = this.hordes[k].anchor;
    let e = this.fields.get(k);
    if (!e || dist(e.at, a) > FIELD_REFRESH) {
      const p = this.grid.nearestFree(a, 30);
      e = { at: { ...a }, f: this.grid.flowField([this.grid.idx(p.x, p.z)]) };
      this.fields.set(k, e);
    }
    return e.f;
  }

  /** The free spot nearest p that a field reaches (falls back to the nearest free spot to `home`). */
  private reachable(field: Int32Array, p: V2, home: V2): V2 {
    const g = this.grid;
    const ok = (q: V2) => !g.isBlocked(q.x, q.z) && g.fieldAt(field, q.x, q.z) >= 0;
    if (ok(p)) return { ...p };
    for (let r = g.cell; r <= 60; r += g.cell) {
      const steps = Math.max(16, Math.ceil((2 * Math.PI * r) / g.cell));
      for (let a = 0; a < steps; a++) {
        const q = { x: p.x + Math.cos((a / steps) * Math.PI * 2) * r, z: p.z + Math.sin((a / steps) * Math.PI * 2) * r };
        if (ok(q)) return q;
      }
    }
    return g.nearestFree(home);
  }

  /** Aircraft position: a steady left-hand orbit around the mission's centre. */
  aircraft(t = this.t): { x: number; y: number; z: number } {
    const a = (-t / ORBIT.period) * Math.PI * 2;
    const c = this.mission.orbitCentre;
    return { x: c.x + Math.cos(a) * ORBIT.radius, y: ORBIT.altitude, z: c.z + Math.sin(a) * ORBIT.radius };
  }

  drainEvents(): SimEvent[] {
    const e = this.events;
    this.events = [];
    return e;
  }

  private emit(e: SimEvent): void {
    this.events.push(e);
  }

  private spawnZombie(p: V2, cold: boolean, home: V2 | null, speedMul = 1): void {
    const d = this.mission.difficulty;
    this.zombies.push({
      id: this.nextId++, x: p.x, z: p.z, vx: 0, vz: 0, cold, alive: true, diedAt: -1, home, goal: null,
      speed: ((cold ? 1.1 : 1.3) + this.rng() * 0.6 + 0.08 * d) * speedMul,
    });
    this.syncLiving();
  }

  /** Pick up zombies appended to `zombies` since the last sync (in order), live ones only. */
  syncLiving(): Zombie[] {
    const zs = this.zombies;
    if (zs.length < this.livingSeen) {
      // The list was replaced or cut (tests): start over.
      this.living.length = 0;
      this.livingSeen = 0;
    }
    for (let i = this.livingSeen; i < zs.length; i++) if (zs[i].alive) this.living.push(zs[i]);
    this.livingSeen = zs.length;
    return this.living;
  }

  /** Drop the dead from `living`, keeping the order (never swap-remove: the rng order depends on it). */
  private compactLiving(): void {
    const l = this.living;
    let w = 0;
    for (let i = 0; i < l.length; i++) if (l[i].alive) l[w++] = l[i];
    l.length = w;
    this.livingDirty = false;
  }

  /** The kind of the next wave to arrive. */
  private nextWaveKind(): WaveKind {
    return this.mission.waves?.kinds?.[this.waveIndex] ?? 'standard';
  }

  /**
   * Add one zombie at a walkable spot near `p` (used by Training night to restock its targets).
   * Ids come from the same counter as every other zombie, so they never collide.
   */
  addZombie(p: V2, cold: boolean, home: V2 | null): Zombie {
    this.spawnZombie(this.grid.nearestFree(p), cold, home);
    return this.zombies[this.zombies.length - 1];
  }

  /** Bring a fallen survivor back to their feet where they fell (Training night patches up friendly fire). */
  revive(survivorId: number): boolean {
    const s = this.survivors.find((x) => x.id === survivorId);
    if (!s || s.alive || s.home) return false;
    s.alive = true;
    s.hp = 1;
    s.diedAt = -1;
    return true;
  }

  weaponReady(id: string): boolean {
    const s = this.weapons.find((w) => w.id === id);
    return !!s && this.phase === 'running' && s.reloading <= 0 && s.cooldown <= 0 && s.ammo > 0;
  }

  /** Fire a gun at a ground point. Returns false if it isn't ready. */
  fire(id: string, target: V2): boolean {
    if (!this.weaponReady(id)) return false;
    const w = weaponById(id);
    const s = this.weapons.find((x) => x.id === id)!;
    s.ammo--;
    s.cooldown += w.interval;
    if (s.ammo <= 0) s.reloading = w.reload;
    const from = this.aircraft();
    const g = gaussian(this.rng);
    const a = this.rng() * Math.PI * 2;
    const to = { x: target.x + Math.cos(a) * g * w.spread, z: target.z + Math.sin(a) * g * w.spread };
    const tof = Math.hypot(to.x - from.x, from.y, to.z - from.z) / w.speed;
    this.shells.push({ weapon: w, from, to, t0: this.t, tof });
    this.shots++;
    this.emit({ type: 'fire', weapon: id, from, to, tof });
    return true;
  }

  step(dt: number): void {
    if (this.phase !== 'running') return;
    this.t += dt;
    this.syncLiving();
    for (const s of this.weapons) {
      // Keep the remainder (can go slightly negative) so rate of fire is exact at any step size.
      s.cooldown = Math.max(-dt, s.cooldown - dt);
      if (s.reloading > 0) {
        s.reloading -= dt;
        if (s.reloading <= 0) {
          s.reloading = 0;
          s.ammo = weaponById(s.id).magazine;
        }
      }
    }
    this.updateShells();
    if (this.crowdStats) {
      this.updateCrowdSpawns(dt);
      this.updateCrowdZombies(dt);
    } else {
      this.updateSurvivors(dt);
      this.updateWaves(dt);
      this.updateZombies(dt);
    }
    this.updateLines();
    this.updateSearch();
    this.checkResult();
    if (this.livingDirty) this.compactLiving();
  }

  private updateShells(): void {
    const keep: Shell[] = [];
    for (const sh of this.shells) {
      if (this.t - sh.t0 < sh.tof) {
        keep.push(sh);
        continue;
      }
      const r = sh.weapon.radius;
      let kills = 0;
      for (const z of this.living) {
        if (!z.alive) continue;
        const d = Math.hypot(z.x - sh.to.x, z.z - sh.to.z);
        if (d < r || (d < r * KILL_REACH && this.rng() < 0.5)) {
          z.alive = false;
          z.diedAt = this.t;
          kills++;
        }
      }
      if (kills) this.livingDirty = true;
      this.kills += kills;
      const cs = this.crowdStats;
      if (cs && kills) {
        cs.kills += kills;
        cs.score += kills * cs.multiplier;
        if (!cs.best || kills > cs.best.kills) cs.best = { kills, weapon: sh.weapon.id, place: placeLabel(this.map, sh.to) };
      }
      if (kills) this.lastHit = this.t;
      if (this.scatterOn && sh.weapon.id === '105') this.scatter(sh.to, r);
      for (const s of this.survivors) {
        if (!s.alive || s.home) continue;
        const d = Math.hypot(s.x - sh.to.x, s.z - sh.to.z);
        if (d < r || (d < r * KILL_REACH && this.rng() < 0.5)) {
          s.alive = false;
          s.diedAt = this.t;
          this.friendlyHits++;
          this.emit({ type: 'friendly-hit', x: s.x, z: s.z });
        } else if (d < r * 3 && this.t - this.lastDangerClose > 4) {
          this.lastDangerClose = this.t;
          this.emit({ type: 'danger-close' });
        }
      }
      this.emit({ type: 'impact', weapon: sh.weapon.id, x: sh.to.x, z: sh.to.z, kills });
    }
    this.shells = keep;
  }

  /** Spec 002: every horde zombie a 105 left standing within SCATTER_REACH x its lethal radius runs (scatter stream only). */
  private scatter(at: V2, r: number): void {
    const count = new Map<number, number>();
    for (const z of this.living) {
      if (!z.alive || !z.home) continue;
      const k = this.hordeOf.get(z.home);
      if (k === undefined) continue;
      const dx = z.x - at.x;
      const dz = z.z - at.z;
      const d = Math.hypot(dx, dz);
      if (d >= r * SCATTER_REACH) continue;
      const base = d > 0.01 ? Math.atan2(dz, dx) : this.srng() * Math.PI * 2;
      const a = base + (this.srng() - 0.5) * 2 * SCATTER_WOBBLE;
      z.scatter = 1;
      z.scatterDir = { x: Math.cos(a), z: Math.sin(a) };
      z.fleeUntil = this.t + FLEE_S + this.srng() * FLEE_JITTER;
      const forest = this.mission.template === 'forest-sweep' ? FOREST_REGROUP : 1;
      z.scatterT = this.t + (REGROUP_S + REGROUP_PER_D * (this.mission.difficulty - 1) + this.srng() * REGROUP_JITTER) * forest;
      z.stuckT = 0;
      z.goal = null;
      count.set(k, (count.get(k) ?? 0) + 1);
    }
    // The place runners are told they'll come back to is always true (PLAN §5a): where the horde gathered,
    // or for the drifting horde once it has moved, where it is now.
    for (const k of count.keys()) {
      const h = this.hordes[k];
      h.regroup = dist(h.anchor, h.origin) > HORDE_WANDER ? placeLabel(this.map, h.anchor) : h.label;
    }
    if (!this.scatterSaid && count.size) {
      this.scatterSaid = true;
      const k = [...count.entries()].reduce((a, b) => (b[1] > a[1] ? b : a))[0];
      this.emit({ type: 'radio', text: `They're scattering. They'll drift back to ${this.hordes[k].regroup}.` });
    }
  }

  /** Metres from a point to its horde's path: the gathering point, or the line the drifting horde has walked. */
  private pathDist(k: number, p: V2): number {
    const h = this.hordes[k];
    return distToSegment(p, h.origin, h.anchor);
  }

  /** Where scattered hordes will regroup, while any of their runners are out (feel M1: the in-flight marker). */
  regroupPoints(): { label: string; p: V2 }[] {
    const out = new Set<number>();
    for (const z of this.syncLiving()) if (z.alive && z.scatter && z.home) out.add(this.hordeOf.get(z.home)!);
    return [...out].sort((a, b) => a - b).map((k) => ({ label: this.hordes[k].regroup, p: { ...this.hordes[k].anchor } }));
  }

  private updateSurvivors(dt: number): void {
    for (const s of this.survivors) {
      if (!s.alive || s.home) continue;
      let attackers = 0;
      let nearest = Infinity;
      for (const z of this.living) {
        if (!z.alive) continue;
        const d = Math.hypot(z.x - s.x, z.z - s.z);
        if (d < nearest) nearest = d;
        if (d < 1.6) attackers++;
      }
      if (!s.route && nearest < 12 && this.t - this.lastUnderAttack > 8) {
        this.lastUnderAttack = this.t;
        this.emit({ type: 'radio', text: 'FRIENDLIES UNDER ATTACK! Contacts closing on the sheltering friendlies.' });
      }
      if (attackers) {
        s.hp -= 0.7 * attackers * dt;
        if (s.hp <= 0) {
          s.alive = false;
          s.diedAt = this.t;
          this.emit({ type: 'survivor-lost', x: s.x, z: s.z });
          continue;
        }
      }
      if (!s.route || this.t < s.delay || attackers) continue;
      const speed = nearest < 14 ? 3.2 : 2.1;
      s.s += speed * dt;
      if (s.s >= s.routeLen) {
        s.home = true;
        this.emit({ type: 'survivor-home' });
        continue;
      }
      const p = pointAlong(s.route, s.s);
      const q = pointAlong(s.route, s.s + 1);
      const len = Math.hypot(q.x - p.x, q.z - p.z) || 1;
      const x = p.x + (-(q.z - p.z) / len) * s.offset;
      const z = p.z + ((q.x - p.x) / len) * s.offset;
      // Through the door of their own home or the safehouse: they're inside now, not walking through its walls.
      const door = this.doors[s.id];
      if (door && (pointInPolygon(p, door) || pointInPolygon({ x, z }, door))) {
        s.home = true;
        this.emit({ type: 'survivor-home' });
        continue;
      }
      // Buildings are solid (3.15): step in off the shoulder, or round a building the road's last leg cuts across.
      const at = !this.grid.isBlocked(x, z) ? { x, z } : !this.grid.isBlocked(p.x, p.z) ? p : this.grid.nearestFree(p, 30);
      s.x = at.x;
      s.z = at.z;
    }
  }

  private activeSurvivors(): Survivor[] {
    return this.survivors.filter((s) => s.alive && !s.home);
  }

  private updateWaves(dt: number): void {
    const w = this.mission.waves;
    if (!w) return;
    this.waveTimer -= dt;
    if (this.waveTimer > 0) return;
    // A wave that can't arrive (too many alive, nowhere to spawn) keeps its kind for the next try.
    this.waveTimer = w.every * WAVE_KINDS[this.nextWaveKind()].gap;
    const alive = this.living.reduce((n, z) => n + (z.alive ? 1 : 0), 0);
    if (alive >= w.maxAlive) return;
    const active = this.activeSurvivors();
    const g = this.graph;
    const lim = this.map.half * 0.95;
    const cands: number[] = [];
    let ref: V2 = this.mission.safehouse?.centre ?? this.mission.orbitCentre;
    if (this.mission.type === 'escort' && active.length) {
      // Ambush: spawn beside the route, ahead of the leading survivor, so the group must walk into them.
      const lead = active.reduce((a, s) => (s.s > a.s ? s : a), active[0]);
      if (lead.route) {
        const ahead = Math.min(lead.routeLen, lead.s + 90 + this.rng() * 140);
        ref = pointAlong(lead.route, ahead);
        for (let i = 0; i < g.nodes.length; i++) {
          if (g.comp[i] !== g.mainComp || this.noSpawn[i]) continue;
          const d = dist(g.nodes[i], ref);
          // Routes can double back, so also keep ambushes well clear of where the survivors are now.
          if (d >= 30 && d <= 90 && active.every((s) => dist(g.nodes[i], s) >= MIN_SPAWN_GAP)) cands.push(i);
        }
      }
    }
    if (!cands.length) {
      for (let i = 0; i < g.nodes.length; i++) {
        if (g.comp[i] !== g.mainComp || this.noSpawn[i]) continue;
        const n = g.nodes[i];
        if (Math.abs(n.x) > lim || Math.abs(n.z) > lim) continue;
        const d = dist(n, ref);
        if (d < w.minDist || d > w.maxDist || !active.every((s) => dist(n, s) >= MIN_SPAWN_GAP)) continue;
        // In defend, only spawn where zombies can actually walk to the safehouse (not across a river).
        if (this.safeField && this.grid.fieldAt(this.safeField, n.x, n.z) <= 0) continue;
        cands.push(i);
      }
    }
    if (!cands.length) return;
    // Come from a different direction than the last two waves, where the map allows it.
    const fresh = cands.filter((i) => !this.waveSectors.includes(compassSector(ref, g.nodes[i])));
    const pool = fresh.length ? fresh : cands;
    const at = g.nodes[pool[Math.floor(this.rng() * pool.length)]];
    const kind = this.nextWaveKind();
    const k = WAVE_KINDS[kind];
    const size = Math.min(Math.max(1, Math.round(w.size * k.size)), w.maxAlive - alive);
    const cold = Math.round(size * (k.cold ?? w.coldShare));
    for (let i = 0; i < size; i++) {
      const a = this.rng() * Math.PI * 2;
      const r = Math.sqrt(this.rng()) * WAVE_SPREAD;
      this.spawnZombie(this.grid.nearestFree({ x: at.x + Math.cos(a) * r, z: at.z + Math.sin(a) * r }), i < cold, null, k.speed);
    }
    this.waveIndex++;
    this.waveTimer = w.every * WAVE_KINDS[this.nextWaveKind()].gap;
    this.waveSectors = [compassSector(ref, at), ...this.waveSectors].slice(0, 2);
    const dir = compassWord(ref, at);
    this.emit({ type: 'wave', count: size, cold, from: dir, place: placeLabel(this.map, at), kind });
  }

  private updateZombies(dt: number): void {
    if (this.drift && this.t > this.shelterGrace) {
      const { anchor, target, speed } = this.drift;
      const d = dist(anchor, target);
      if (d > 8) {
        anchor.x += ((target.x - anchor.x) / d) * speed * dt;
        anchor.z += ((target.z - anchor.z) / d) * speed * dt;
      }
    }
    const grid = this.grid;
    const active = this.activeSurvivors();
    if (this.mission.type === 'escort') {
      this.fieldAge += dt;
      if (this.fieldAge >= 1 && active.length) {
        this.fieldAge = 0;
        this.field = grid.flowField(active.map((s) => grid.idx(s.x, s.z)).filter((k) => k >= 0).flatMap((k) => this.freeAround(k)));
      }
    }
    for (const z of this.living) {
      if (!z.alive) {
        this.livingDirty = true;
        continue;
      }
      let dir: V2 | null = null;
      // Chase any survivor within 25 m directly.
      let near: Survivor | null = null;
      let nd = 25;
      for (const s of active) {
        // Sheltering friendlies stay hidden for the first moments, so the player has time to find them.
        if (!s.route && this.t < this.shelterGrace) continue;
        const d = Math.hypot(s.x - z.x, s.z - z.z);
        if (d < nd) {
          nd = d;
          near = s;
        }
      }
      if (near) {
        if (nd < 1.1) dir = { x: 0, z: 0 };
        else dir = { x: (near.x - z.x) / nd, z: (near.z - z.z) / nd };
      } else if (this.mission.type === 'escort' && this.field) {
        dir = grid.downhill(this.field, z.x, z.z);
      } else if (this.mission.type === 'defend' && this.safeField) {
        const here = grid.fieldAt(this.safeField, z.x, z.z);
        if (here === 0) {
          this.integrity -= 0.02 * dt;
          dir = { x: 0, z: 0 };
        } else dir = grid.downhill(this.safeField, z.x, z.z);
      } else if (this.search?.ids.has(z.id)) {
        dir = this.restlessDir(z, dt);
      } else if (z.scatter && z.home) {
        dir = this.runnerDir(z, dt);
      } else if (z.home && this.hordeOf.has(z.home) && Math.hypot(z.home.x - z.x, z.home.z - z.z) > HORDE_WANDER + LEFT_BEHIND) {
        // Left behind (owner's report: frozen against a wall while the horde drifted off): walk round, not into, the wall.
        z.goal = null;
        dir = this.walkDir(this.hordeField(this.hordeOf.get(z.home)!), z, z.speed * 0.45 * dt) ?? { x: (z.home.x - z.x) / Math.hypot(z.home.x - z.x, z.home.z - z.z), z: (z.home.z - z.z) / Math.hypot(z.home.x - z.x, z.home.z - z.z) };
      } else if (z.home) {
        // Mill around the horde's gathering point.
        if (!z.goal || Math.hypot(z.goal.x - z.x, z.goal.z - z.z) < 2) {
          // A spot it can walk straight to (a few tries): goals behind a wall pinned zombies to it (owner's report).
          for (let tries = 0; tries < GOAL_TRIES; tries++) {
            const a = this.rng() * Math.PI * 2;
            const r = this.rng() * HORDE_WANDER;
            z.goal = { x: z.home.x + Math.cos(a) * r, z: z.home.z + Math.sin(a) * r };
            if (this.clearLine(z, z.goal)) break;
          }
        }
        const goal = z.goal!;
        const d = Math.hypot(goal.x - z.x, goal.z - z.z) || 1;
        dir = { x: (goal.x - z.x) / d, z: (goal.z - z.z) / d };
      }
      if (!dir) {
        const a = this.rng() * Math.PI * 2;
        dir = { x: Math.cos(a), z: Math.sin(a) };
      }
      // Shamble when idle, lunge when a survivor is close.
      if (!near && this.search?.ids.has(z.id)) {
        // Restless stragglers walk, not shamble, and horde ones keep to the leash and the map like runners.
        const sp = z.speed * RESTLESS_MUL;
        if (z.home && this.hordeOf.has(z.home)) this.moveRunner(z, dir, sp, dt);
        else this.moveFree(z, dir, sp, dt);
        continue;
      }
      if (z.scatter && z.home) {
        // Runners (spec 002): flee fast, lurk at a shamble, walk back; the leash holds whatever they do.
        const run = near ? z.speed * 1.45 : z.speed * (z.scatter === 1 ? FLEE_MUL : z.scatter === 3 ? RETURN_MUL : 0.45);
        this.moveRunner(z, dir, run, dt);
        continue;
      }
      // Wedged against a wall (a slanted corner, or goals behind a thin wall): walk the horde's flow field round it
      // for a moment, or, walled off from the horde, take a seeded free heading.
      if (z.home && !near && z.unstick && this.t < z.unstick.until) {
        const k = this.hordeOf.get(z.home);
        dir = (k !== undefined && this.walkDir(this.hordeField(k), z, z.speed * 0.45 * dt)) || z.unstick.dir;
      }
      const sp = near ? z.speed * 1.45 : z.home ? z.speed * 0.45 : z.speed;
      const x0 = z.x;
      const z0 = z.z;
      const nx = z.x + dir.x * sp * dt;
      const nz = z.z + dir.z * sp * dt;
      if (!grid.isBlocked(nx, nz)) {
        z.x = nx;
        z.z = nz;
      } else if (!grid.isBlocked(nx, z.z)) {
        if (Math.abs(dir.x) < SLIDE_MIN) z.goal = null;
        z.x = nx;
      } else if (!grid.isBlocked(z.x, nz)) {
        if (Math.abs(dir.z) < SLIDE_MIN) z.goal = null;
        z.z = nz;
      } else z.goal = null;
      if (z.home && !near) this.unstick(z, Math.hypot(z.x - x0, z.z - z0) < 0.1 * sp * dt, dt);
      z.vx = dir.x * sp;
      z.vz = dir.z * sp;
    }
  }

  /**
   * Downhill in a flow field, but only towards a neighbouring cell the next step can really take: the field is
   * coarse (3 m cells), and a slanted wall can close the way to the lowest cell while a nearly-as-low one is open.
   */
  private walkDir(field: Int32Array, p: V2, step: number): V2 | null {
    const g = this.grid;
    const k = g.idx(p.x, p.z);
    if (k < 0 || field[k] < 0) return null;
    const i = k % g.n;
    const j = (k - i) / g.n;
    let best: V2 | null = null;
    let bv = Infinity;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= g.n || jj >= g.n) continue;
        const v = field[jj * g.n + ii];
        if (v < 0 || v > field[k] || v >= bv) continue;
        const dx = g.cx(ii) - p.x;
        const dz = g.cz(jj) - p.z;
        const len = Math.hypot(dx, dz) || 1;
        const u = { x: dx / len, z: dz / len };
        if (g.isBlocked(p.x + u.x * step, p.z + u.z * step)) continue;
        best = u;
        bv = v;
      }
    }
    return best;
  }

  /** True if nothing solid lies on the straight line from a to b (checked every metre). */
  private clearLine(a: V2, b: V2): boolean {
    const n = Math.ceil(dist(a, b));
    for (let i = 1; i <= n; i++) if (this.grid.isBlocked(a.x + ((b.x - a.x) * i) / n, a.z + ((b.z - a.z) * i) / n)) return false;
    return true;
  }

  /** Count time a horde zombie makes no headway; after UNSTICK_S it takes a seeded free heading for a moment. */
  private unstick(z: Zombie, still: boolean, dt: number): void {
    z.blockedT = still ? (z.blockedT ?? 0) + dt : 0;
    if (z.blockedT < UNSTICK_S) return;
    z.blockedT = 0;
    const g = this.grid;
    const free: V2[] = [];
    for (let a = 0; a < 16; a++) {
      const u = { x: Math.cos((a * Math.PI) / 8), z: Math.sin((a * Math.PI) / 8) };
      if ([0.1, 0.3, 0.6, 1].every((r) => !g.isBlocked(z.x + u.x * r, z.z + u.z * r))) free.push(u);
    }
    if (!free.length) return;
    z.unstick = { dir: free[Math.floor(this.srng() * free.length)], until: this.t + 3 + this.srng() * 2 };
    z.goal = null;
  }

  /** A scattered zombie's heading: flee, then lurk, then walk back and rejoin the milling (spec 002). */
  private runnerDir(z: Zombie, dt: number): V2 {
    const home = z.home!;
    if (z.scatter === 1 && this.t >= z.fleeUntil!) {
      z.scatter = 2;
      z.goal = null;
    }
    if (z.scatter !== 3 && this.t >= z.scatterT!) {
      z.scatter = 3;
      z.stuckT = 0;
    }
    if (z.scatter === 1) return z.scatterDir!;
    if (z.scatter === 2) {
      if (!z.goal || Math.hypot(z.goal.x - z.x, z.goal.z - z.z) < 1) {
        const a = this.srng() * Math.PI * 2;
        const r = 2 + this.srng() * 4;
        z.goal = { x: z.x + Math.cos(a) * r, z: z.z + Math.sin(a) * r };
      }
      const d = Math.hypot(z.goal.x - z.x, z.goal.z - z.z) || 1;
      return { x: (z.goal.x - z.x) / d, z: (z.goal.z - z.z) / d };
    }
    const d = Math.hypot(home.x - z.x, home.z - z.z);
    if (d <= HORDE_WANDER) {
      z.scatter = 0;
      z.goal = null;
    }
    z.stuckT = (z.stuckT ?? 0) + dt;
    return d > 0.01 ? { x: (home.x - z.x) / d, z: (home.z - z.z) / d } : { x: 0, z: 0 };
  }

  /**
   * The leash (spec 002 rule 3, a hard move rule): a runner's move is taken only if it ends within SCATTER_LEASH of
   * its horde's path, or no farther from it than before. Otherwise it slides along walls and the leash, or stops.
   */
  private moveRunner(z: Zombie, dir: V2, sp: number, dt: number): void {
    const k = this.hordeOf.get(z.home!)!;
    const home = z.home!;
    const before = this.pathDist(k, z);
    const was = Math.hypot(home.x - z.x, home.z - z.z);
    const edge = this.map.half * HORDE_EDGE;
    const out = Math.max(Math.abs(z.x), Math.abs(z.z));
    const ok = (x: number, zz: number) => {
      if (this.grid.isBlocked(x, zz)) return false;
      // Never out past HORDE_EDGE, where the picture fades and the camera can't follow (owner's report).
      const o = Math.max(Math.abs(x), Math.abs(zz));
      if (o > edge && o > out) return false;
      const d = this.pathDist(k, { x, z: zz });
      return d <= SCATTER_LEASH || d <= before;
    };
    const nx = z.x + dir.x * sp * dt;
    const nz = z.z + dir.z * sp * dt;
    let moved = true;
    if (ok(nx, nz)) {
      z.x = nx;
      z.z = nz;
    } else if (ok(nx, z.z)) {
      z.x = nx;
      if (Math.abs(dir.x) < SLIDE_MIN) headOn(z);
    } else if (ok(z.x, nz)) {
      z.z = nz;
      if (Math.abs(dir.z) < SLIDE_MIN) headOn(z);
    } else {
      moved = false;
      headOn(z); // ran into a wall or the end of the leash: lurk there
    }
    z.vx = moved ? dir.x * sp : 0;
    z.vz = moved ? dir.z * sp : 0;
    if (z.scatter === 3) {
      // Walking back but getting no closer (a river, a fenced block): give up and mill here, inside the leash.
      if (Math.hypot(home.x - z.x, home.z - z.z) < was - 1e-6) z.stuckT = 0;
      else if ((z.stuckT ?? 0) >= STUCK_S) {
        z.scatter = 0;
        z.goal = null;
      }
    }
  }

  /**
   * Crowd night spawner: each open stream's rate (a pure function of t) fills an accumulator; whole zombies spawn
   * across the road at its node, at most MAX_SPAWNS_PER_STEP a step. At the size's cap a spawn is dropped, never queued.
   */
  private updateCrowdSpawns(dt: number): void {
    const plan = this.mission.crowd!;
    const cs = this.crowdStats!;
    const r = this.crng!;
    let alive = 0;
    for (const z of this.living) if (z.alive) alive++;
    let spawned = 0;
    const t0 = this.t - dt;
    for (let k = 0; k < plan.streams.length; k++) {
      this.spawnAcc[k] += streamRate(plan, k, t0) * dt;
      while (this.spawnAcc[k] >= 1 && spawned < MAX_SPAWNS_PER_STEP) {
        this.spawnAcc[k] -= 1;
        if (alive >= plan.maxAlive) {
          cs.dropped++;
          continue;
        }
        const at = plan.streams[k].at;
        const d = this.grid.steer(this.safeField!, at.x, at.z) ?? { x: 1, z: 0 };
        const across = (r() * 2 - 1) * (STREAM_JITTER - 0.5);
        const back = r() * 2;
        let p = { x: at.x - d.z * across - d.x * back, z: at.z + d.x * across - d.z * back };
        if (!this.free(p.x, p.z)) p = { x: at.x - d.z * across * 0.5, z: at.z + d.x * across * 0.5 };
        if (!this.free(p.x, p.z)) p = { x: at.x, z: at.z };
        this.spawnZombie(p, false, null, CROWD_SPEED);
        alive++;
        spawned++;
        cs.spawned++;
      }
    }
  }

  /** Walkable and outside the child no-go mask (the crowd guardrail, checked on every move). */
  private free(x: number, z: number): boolean {
    if (this.grid.isBlocked(x, z)) return false;
    const k = this.grid.idx(x, z);
    return !(this.noGo && this.noGo[k]);
  }

  /**
   * Crowd zombies: down the doors' field (steer keeps lanes), pushed apart by neighbours from a bucket grid built at
   * the start of the step (order-independent), every move refused if it would enter a wall or the child mask.
   * At the doors they wear them down, capped; the multiplier and the alarm follow.
   */
  private updateCrowdZombies(dt: number): void {
    const grid = this.grid;
    const field = this.safeField!;
    const plan = this.mission.crowd!;
    const cs = this.crowdStats!;
    const live = this.living;
    const n = live.length;
    const cells = grid.n * grid.n;
    if (!this.bucketHead || this.bucketHead.length !== cells) this.bucketHead = new Int32Array(cells).fill(-1);
    if (this.bucketNext.length < n) {
      const cap = Math.max(n, this.bucketNext.length * 2, 256);
      this.bucketNext = new Int32Array(cap);
      this.snapX = new Float64Array(cap);
      this.snapZ = new Float64Array(cap);
    }
    const head = this.bucketHead;
    const next = this.bucketNext;
    const sx = this.snapX;
    const sz = this.snapZ;
    for (let a = 0; a < n; a++) {
      const z = live[a];
      sx[a] = z.x;
      sz[a] = z.z;
      next[a] = -1;
      if (!z.alive) {
        this.livingDirty = true;
        continue;
      }
      const c = grid.idx(z.x, z.z);
      if (c < 0) continue;
      next[a] = head[c];
      head[c] = a;
    }
    const gn = grid.n;
    const R = SEP_RADIUS;
    let atDoors = 0;
    let alarm = false;
    for (let a = 0; a < n; a++) {
      const z = live[a];
      if (!z.alive) continue;
      const here = grid.fieldAt(field, sx[a], sz[a]);
      let dir: V2 = { x: 0, z: 0 };
      if (here === 0) atDoors++;
      else {
        if (here > 0 && here <= ALARM_STEPS) alarm = true;
        dir = grid.steer(field, sx[a], sz[a]) ?? dir;
      }
      // Separation: read the snapshot only, so the result doesn't depend on loop order.
      let px = 0;
      let pz = 0;
      const c = grid.idx(sx[a], sz[a]);
      if (c >= 0) {
        const ci = c % gn;
        const cj = (c - ci) / gn;
        for (let dj = -1; dj <= 1; dj++) {
          const jj = cj + dj;
          if (jj < 0 || jj >= gn) continue;
          for (let di = -1; di <= 1; di++) {
            const ii = ci + di;
            if (ii < 0 || ii >= gn) continue;
            for (let b = head[jj * gn + ii]; b >= 0; b = next[b]) {
              if (b === a) continue;
              const dx = sx[a] - sx[b];
              const dz = sz[a] - sz[b];
              if (dx > R || dx < -R || dz > R || dz < -R) continue;
              const d = Math.hypot(dx, dz);
              if (d >= R) continue;
              if (d < 1e-6) {
                // Exactly on top of each other: part by id, the same way whichever is processed first.
                px += z.id < live[b].id ? 1 : -1;
                continue;
              }
              const w = (R - d) / R;
              px += (dx / d) * w;
              pz += (dz / d) * w;
            }
          }
        }
      }
      const sp = z.speed;
      let vx = dir.x * sp + px * SEP_PUSH;
      let vz = dir.z * sp + pz * SEP_PUSH;
      const v = Math.hypot(vx, vz);
      const vmax = sp * 1.25;
      if (v > vmax) {
        vx *= vmax / v;
        vz *= vmax / v;
      }
      const nx = z.x + vx * dt;
      const nz = z.z + vz * dt;
      if (this.free(nx, nz)) {
        z.x = nx;
        z.z = nz;
      } else if (this.free(nx, z.z)) z.x = nx;
      else if (this.free(z.x, nz)) z.z = nz;
      z.vx = vx;
      z.vz = vz;
    }
    // Clear only the buckets used.
    for (let a = 0; a < n; a++) {
      const c = grid.idx(sx[a], sz[a]);
      if (c >= 0) head[c] = -1;
    }
    cs.atDoors = atDoors;
    cs.alarm = alarm || atDoors > 0;
    this.integrity -= Math.min(atDoors, plan.doors.cap) * plan.doors.rate * dt;
    // The multiplier: the doors untouched climbs it, zombies at them knock it down (pillar 2 in the score).
    if (atDoors > 0) {
      this.calmT = 0;
      let drop = false;
      if (!this.contact) {
        this.contact = true;
        this.contactT = 0;
        drop = true;
      } else {
        this.contactT += dt;
        if (this.contactT >= MULT_DOWN) {
          this.contactT -= MULT_DOWN;
          drop = true;
        }
      }
      if (drop && cs.multiplier > 1) {
        cs.multiplier--;
        this.emit({ type: 'radio', text: `They're at the doors. Multiplier down to ×${cs.multiplier}.` });
      }
    } else {
      this.contact = false;
      this.calmT += dt;
      if (this.calmT >= MULT_UP) {
        this.calmT -= MULT_UP;
        if (cs.multiplier < MULT_MAX) {
          cs.multiplier++;
          cs.bestMultiplier = Math.max(cs.bestMultiplier, cs.multiplier);
        }
      }
    }
  }

  /** The gunner switched camera (the game calls this): flicking between views without a hit is a sign of searching. */
  noteSensorSwitch(): void {
    this.switches.push(this.t);
    while (this.switches.length && this.t - this.switches[0] > SEARCH_SWITCH_S) this.switches.shift();
  }

  /** The soft search circles on show (empty when the help is off). */
  searchAreas(): SearchArea[] {
    return (this.search?.areas ?? []).map((a) => ({ p: { ...a.p }, r: a.r, n: a.n, cold: a.cold }));
  }

  /** Is the search help on, and for which zombies? */
  searching(): number[] {
    return this.search ? [...this.search.ids] : [];
  }

  /** Start the search help now for the zombies `pick` chooses (Training night calls this; Clear starts it itself). */
  startSearch(pick: (z: Zombie) => boolean): boolean {
    if (this.crowdStats) return false; // crowd nights: everyone is warm and in the streets; no search help
    const targets = this.zombies.filter((z) => z.alive && pick(z));
    if (!targets.length) return false;
    this.search = { ids: new Set(targets.map((z) => z.id)), areas: [], kills: this.kills };
    for (const z of targets) {
      // Runners stop running: restless, they head back to their horde instead.
      if (z.scatter) z.scatter = 0;
      z.goal = null;
    }
    this.refreshAreas();
    const left = targets.length;
    const cold = targets.every((z) => z.cold);
    const places: string[] = [];
    for (const z of targets) {
      const l = placeLabel(this.map, z);
      if (!places.includes(l)) places.push(l);
    }
    const where = places.length > 3 ? `${places.slice(0, 3).join(', ')} and round about` : places.length > 1 ? `${places.slice(0, -1).join(', ')} and ${places[places.length - 1]}` : places[0];
    const who = left === 1 ? (cold ? 'One cold one' : 'One straggler') : `${left} ${cold ? 'cold ones' : 'stragglers'}`;
    const tip = cold ? ' Night vision: watch for movement.' : ' Watch for movement.';
    this.emit({ type: 'search', text: `Spooky, Ground. ${who} still out there, around ${where}. They're getting restless. Check the circle.${tip}`, left, cold });
    return true;
  }

  /** End the search help (a hit, or Training night moving on). */
  stopSearch(): void {
    this.search = null;
  }

  /** Clear: start the help when the endgame has gone quiet, end it on a hit, and keep its circles true. */
  private updateSearch(): void {
    if (this.search) {
      const ids = this.search.ids;
      for (const id of ids) if (!this.zombies[this.zombieIndex(id)]?.alive) ids.delete(id);
      if (this.kills > this.search.kills || !ids.size) this.search = null;
      else this.refreshAreas();
      return;
    }
    if (this.searchQuiet === null || !this.kills || this.phase !== 'running') return;
    const alive = this.zombies.filter((z) => z.alive);
    const coldOnes = alive.filter((z) => z.cold);
    // The last few, or the last few cold-blooded ones (the hardest to find) while warm ones are still about.
    if (!alive.length || (alive.length > ENDGAME_LEFT && (!coldOnes.length || coldOnes.length > ENDGAME_LEFT))) return;
    const quiet = this.t - this.lastHit;
    const flicking = this.switches.length >= SEARCH_SWITCHES && this.switches.every((t) => t > this.lastHit) && this.t - this.switches[0] <= SEARCH_SWITCH_S;
    if (quiet < this.searchQuiet && !flicking) return;
    const targets = new Set(alive.length <= ENDGAME_LEFT ? alive : coldOnes);
    this.switches = [];
    this.startSearch((z) => targets.has(z));
  }

  private zombieIndex(id: number): number {
    // Ids are handed out in order and zombies are never removed, so an id is its index.
    return id;
  }

  /**
   * Every straggler sits inside a circle, at least SEARCH_MARGIN in from its rim. A circle keeps its place while it
   * holds; a straggler that leaves gets a new one, centred up to SEARCH_OFFSET away from it (never the exact spot).
   */
  private refreshAreas(): void {
    const s = this.search!;
    const keep = s.areas.map((a) => ({ ...a, ids: [] as number[], n: 0, cold: 0 }));
    const lim = this.map.half * HORDE_EDGE;
    for (const id of [...s.ids].sort((a, b) => a - b)) {
      const z = this.zombies[this.zombieIndex(id)];
      let a = keep.find((c) => dist(c.p, z) <= c.r - SEARCH_MARGIN);
      if (!a) {
        const ang = this.erng() * Math.PI * 2;
        const r = this.erng() * SEARCH_OFFSET;
        const p = { x: Math.max(-lim, Math.min(lim, z.x + Math.cos(ang) * r)), z: Math.max(-lim, Math.min(lim, z.z + Math.sin(ang) * r)) };
        a = { p, r: SEARCH_RADIUS, n: 0, cold: 0, ids: [] };
        keep.push(a);
      }
      a.ids.push(id);
      a.n++;
      if (z.cold) a.cold++;
    }
    s.areas = keep.filter((a) => a.n > 0);
  }

  /** A restless straggler: back to its horde round the walls if it's out, else milling at a walk; else roaming. */
  private restlessDir(z: Zombie, dt: number): V2 {
    if (z.home) {
      const k = this.hordeOf.get(z.home);
      const d = Math.hypot(z.home.x - z.x, z.home.z - z.z);
      if (d > HORDE_WANDER) {
        z.goal = null;
        const w = k !== undefined ? this.walkDir(this.hordeField(k), z, z.speed * RESTLESS_MUL * dt) : null;
        return w ?? { x: (z.home.x - z.x) / d, z: (z.home.z - z.z) / d };
      }
    }
    const c = z.home ?? z;
    if (!z.goal || Math.hypot(z.goal.x - z.x, z.goal.z - z.z) < 2) {
      for (let tries = 0; tries < GOAL_TRIES; tries++) {
        const a = this.erng() * Math.PI * 2;
        const r = 6 + this.erng() * (HORDE_WANDER - 6);
        z.goal = { x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r };
        if (this.clearLine(z, z.goal)) break;
      }
    }
    const g = z.goal!;
    const d = Math.hypot(g.x - z.x, g.z - z.z) || 1;
    return { x: (g.x - z.x) / d, z: (g.z - z.z) / d };
  }

  /** Move a zombie with no horde (a Training stand-in): walls slide, a head-on wall means a new goal. */
  private moveFree(z: Zombie, dir: V2, sp: number, dt: number): void {
    const g = this.grid;
    const nx = z.x + dir.x * sp * dt;
    const nz = z.z + dir.z * sp * dt;
    if (!g.isBlocked(nx, nz)) {
      z.x = nx;
      z.z = nz;
    } else if (!g.isBlocked(nx, z.z) && Math.abs(dir.x) >= SLIDE_MIN) z.x = nx;
    else if (!g.isBlocked(z.x, nz) && Math.abs(dir.z) >= SLIDE_MIN) z.z = nz;
    else z.goal = null;
    z.vx = dir.x * sp;
    z.vz = dir.z * sp;
  }

  /** Clear (radio script section C): `few-left` once at 5 or fewer, `cold-leftovers` once when all that's left is cold. */
  private updateLines(): void {
    if (!this.scatterOn) return;
    let left = 0;
    let cold = 0;
    for (const z of this.living) {
      if (!z.alive) continue;
      left++;
      if (z.cold) cold++;
    }
    if (left === 0 || left > 5) return;
    if (cold === left && !this.coldSaid) {
      this.coldSaid = true;
      this.fewSaid = true; // beats few-left
      this.emit({ type: 'line', id: 'cold-leftovers', left });
    } else if (!this.fewSaid) {
      this.fewSaid = true;
      this.emit({ type: 'line', id: 'few-left', left });
    }
  }

  private freeAround(k: number): number[] {
    if (!this.grid.blocked[k]) return [k];
    const n = this.grid.n;
    const out: number[] = [];
    for (const o of [-1, 1, -n, n, -n - 1, -n + 1, n - 1, n + 1]) if (k + o >= 0 && !this.grid.blocked[k + o]) out.push(k + o);
    return out;
  }

  private checkResult(): void {
    const m = this.mission;
    const end = (won: boolean, reason: string) => {
      this.phase = won ? 'won' : 'lost';
      this.reason = reason;
      this.emit({ type: 'result', won, reason });
    };
    if (this.friendlyHits >= m.friendlyFireLimit) return end(false, 'Too many friendly-fire incidents. You are relieved of the guns.');
    const alive = this.survivors.filter((s) => s.alive);
    const home = this.survivors.filter((s) => s.home).length;
    if (m.type === 'clear') {
      if (this.living.every((z) => !z.alive)) return end(true, 'Every horde cleared.');
      if (this.survivors.length && !alive.length) return end(false, 'The sheltering friendlies were overrun.');
      if (this.t >= m.timeLimit) return end(false, 'Out of time. The hordes are still out there.');
    } else if (m.type === 'escort') {
      const stillPossible = alive.length >= m.needHome;
      if (!stillPossible) return end(false, `Too few survivors left to make it home (needed ${m.needHome}).`);
      if (alive.every((s) => s.home)) return end(true, `${home} of ${this.survivors.length} survivors made it home.`);
      if (this.t >= m.timeLimit) return end(false, 'Out of time before everyone got home.');
    } else if (this.crowdStats) {
      if (this.integrity <= 0) return end(false, `The doors gave at ${fmtTime(this.t)}.`);
      if (this.t >= m.timeLimit) return end(true, 'The doors held. Everyone inside saw the dawn.');
    } else {
      if (this.integrity <= 0) return end(false, 'The dead broke into the safehouse.');
      if (this.t >= m.timeLimit) return end(true, 'Safehouse held until dawn patrol arrived.');
    }
  }

  state(): SimState {
    const zAlive = this.syncLiving().filter((z) => z.alive);
    return {
      t: this.t,
      phase: this.phase,
      reason: this.reason,
      type: this.mission.type,
      timeLeft: Math.max(0, this.mission.timeLimit - this.t),
      zombiesAlive: zAlive.length,
      coldAlive: zAlive.filter((z) => z.cold).length,
      zombiesTotal: this.zombies.length,
      survivorsAlive: this.survivors.filter((s) => s.alive && !s.home).length,
      survivorsHome: this.survivors.filter((s) => s.home).length,
      survivorsTotal: this.survivors.length,
      needHome: this.mission.needHome,
      integrity: Math.max(0, this.integrity),
      friendlyHits: this.friendlyHits,
      shots: this.shots,
      kills: this.kills,
      weapons: this.weapons.map((w) => ({ ...w })),
      ...(this.crowdStats ? { crowd: { ...this.crowdStats, best: this.crowdStats.best && { ...this.crowdStats.best } } } : {}),
    };
  }
}

/** The footprint a route ends in: the safehouse, or the building (home) holding its last point. */
function destination(end: V2, map: MapData, safehouse: V2[] | undefined): V2[] | null {
  if (safehouse && pointInPolygon(end, safehouse)) return safehouse;
  return map.buildings.find((b) => b.pts.length >= 3 && pointInPolygon(end, b.pts))?.pts ?? null;
}

function gaussian(r: Rng): number {
  const u = Math.max(1e-9, r());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r());
}

/** A runner blocked, or creeping along a wall it's walking into (SLIDE_MIN): stop fleeing, or pick a new lurking spot. */
function headOn(z: Zombie): void {
  if (z.scatter === 1) z.scatter = 2;
  z.goal = null;
}

/** 0 = north, then clockwise in eighths. */
function compassSector(from: V2, to: V2): number {
  const a = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
  return Math.round(((a + 360) % 360) / 45) % 8;
}

function compassWord(from: V2, to: V2): string {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][compassSector(from, to)];
}
