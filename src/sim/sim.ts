import type { MapData, V2 } from '../map/types';
import { dist, pointAlong, pointInPolygon, polylineLength } from '../map/geom';
import type { RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { hashString, mulberry32, type Rng } from '../util/rng';
import { nearChildPlace } from '../map/recon';
import { placeLabel } from './missions';
import { CHILD_FIRE_CLEARANCE, FIRST_WAVE, HORDE_SPREAD, HORDE_WANDER, WAVE_KINDS, type Mission, type WaveKind } from './missions';
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
}

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
  | { type: 'result'; won: boolean; reason: string };

export interface WeaponState {
  id: string;
  ammo: number;
  cooldown: number;
  reloading: number;
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
  zombies: Zombie[] = [];
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

  constructor(mission: Mission, map: MapData, graph: RoadGraph, grid: WalkGrid) {
    this.mission = mission;
    this.map = map;
    this.graph = graph;
    this.grid = grid;
    this.rng = mulberry32(hashString(`sim|${mission.mapName}|${mission.seed}|${mission.type}|${mission.difficulty}`));
    this.weapons = WEAPONS.map((w) => ({ id: w.id, ammo: w.magazine, cooldown: 0, reloading: 0 }));
    // Each horde mills around its own movable anchor (a copy, so the mission data never changes).
    const anchors = mission.hordes.map((h) => ({ ...h.centre }));
    mission.hordes.forEach((h, k) => {
      for (let i = 0; i < h.count; i++) {
        const a = this.rng() * Math.PI * 2;
        const r = Math.sqrt(this.rng()) * HORDE_SPREAD;
        this.spawnZombie(grid.nearestFree({ x: h.centre.x + Math.cos(a) * r, z: h.centre.z + Math.sin(a) * r }), i < h.cold, anchors[k]);
      }
    });
    // Clear missions: after the grace period, the horde nearest the sheltering friendlies drifts toward them,
    // so there is real pressure to find and protect them (the critic found the friendlies were never threatened).
    const shelter = mission.type === 'clear' ? mission.survivors.find((s) => !s.route) : undefined;
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
    if (mission.safehouse && mission.type === 'defend') this.safeField = grid.flowField(grid.perimeterCells(mission.safehouse.poly));
    if (mission.waves) this.waveTimer = FIRST_WAVE; // first wave arrives quickly
    this.shelterGrace = Math.max(15, 45 - 6 * mission.difficulty);
    this.noSpawn = mission.waves ? noWaveSpawn(map, graph) : new Uint8Array(graph.nodes.length);
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
    this.updateSurvivors(dt);
    this.updateWaves(dt);
    this.updateZombies(dt);
    this.checkResult();
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
      for (const z of this.zombies) {
        if (!z.alive) continue;
        const d = Math.hypot(z.x - sh.to.x, z.z - sh.to.z);
        if (d < r || (d < r * KILL_REACH && this.rng() < 0.5)) {
          z.alive = false;
          z.diedAt = this.t;
          kills++;
        }
      }
      this.kills += kills;
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

  private updateSurvivors(dt: number): void {
    for (const s of this.survivors) {
      if (!s.alive || s.home) continue;
      let attackers = 0;
      let nearest = Infinity;
      for (const z of this.zombies) {
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
    const alive = this.zombies.reduce((n, z) => n + (z.alive ? 1 : 0), 0);
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
    for (const z of this.zombies) {
      if (!z.alive) continue;
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
      } else if (z.home) {
        // Mill around the horde's gathering point.
        if (!z.goal || Math.hypot(z.goal.x - z.x, z.goal.z - z.z) < 2) {
          const a = this.rng() * Math.PI * 2;
          const r = this.rng() * HORDE_WANDER;
          z.goal = { x: z.home.x + Math.cos(a) * r, z: z.home.z + Math.sin(a) * r };
        }
        const d = Math.hypot(z.goal.x - z.x, z.goal.z - z.z) || 1;
        dir = { x: (z.goal.x - z.x) / d, z: (z.goal.z - z.z) / d };
      }
      if (!dir) {
        const a = this.rng() * Math.PI * 2;
        dir = { x: Math.cos(a), z: Math.sin(a) };
      }
      // Shamble when idle, lunge when a survivor is close.
      const sp = near ? z.speed * 1.45 : z.home ? z.speed * 0.45 : z.speed;
      const nx = z.x + dir.x * sp * dt;
      const nz = z.z + dir.z * sp * dt;
      if (!grid.isBlocked(nx, nz)) {
        z.x = nx;
        z.z = nz;
      } else if (!grid.isBlocked(nx, z.z)) z.x = nx;
      else if (!grid.isBlocked(z.x, nz)) z.z = nz;
      else z.goal = null;
      z.vx = dir.x * sp;
      z.vz = dir.z * sp;
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
      if (this.zombies.every((z) => !z.alive)) return end(true, 'Every horde cleared.');
      if (this.survivors.length && !alive.length) return end(false, 'The sheltering friendlies were overrun.');
      if (this.t >= m.timeLimit) return end(false, 'Out of time. The hordes are still out there.');
    } else if (m.type === 'escort') {
      const stillPossible = alive.length >= m.needHome;
      if (!stillPossible) return end(false, `Too few survivors left to make it home (needed ${m.needHome}).`);
      if (alive.every((s) => s.home)) return end(true, `${home} of ${this.survivors.length} survivors made it home.`);
      if (this.t >= m.timeLimit) return end(false, 'Out of time before everyone got home.');
    } else {
      if (this.integrity <= 0) return end(false, 'The dead broke into the safehouse.');
      if (this.t >= m.timeLimit) return end(true, 'Safehouse held until dawn patrol arrived.');
    }
  }

  state(): SimState {
    const zAlive = this.zombies.filter((z) => z.alive);
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

/** 0 = north, then clockwise in eighths. */
function compassSector(from: V2, to: V2): number {
  const a = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
  return Math.round(((a + 360) % 360) / 45) % 8;
}

function compassWord(from: V2, to: V2): string {
  return ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'][compassSector(from, to)];
}
