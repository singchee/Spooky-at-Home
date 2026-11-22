import type { MapData, V2 } from '../map/types';
import { dist, pointAlong, polylineLength } from '../map/geom';
import { dijkstra, type Edge, type RoadGraph } from '../map/roadGraph';
import { isChildPlaceFeature, segmentNearChildPlace } from '../map/recon';
import { placeLabel } from './missions';
import { MAX_KILL_REACH, weaponById } from './weapons';
import { hashString, mulberry32, shuffle, type Rng } from '../util/rng';

/**
 * Convoy (spec 004): Ground's trucks drive in on one main road and out on another. This file holds the
 * headless route finder and the corridor index; the trucks themselves come in a later commit.
 * Pure and deterministic: no three.js, no DOM, no unseeded randomness.
 *
 * Constants from missions.ts are mirrored here, not imported, because missions.ts will import this file
 * (buildConvoy) and a top-level read across that cycle would see them uninitialised. tests/convoy.test.ts
 * asserts each mirror equals its source.
 */

/** Road classes a convoy drives on (OSM highway=*). Motorways are left out: fenced, and far from the action. */
export const MAIN_ROAD_KINDS: readonly string[] = ['trunk', 'primary', 'secondary', 'tertiary'];
/** Smaller roads a truck can use as a short connector between two main roads, at CONNECTOR_COST × their length. */
export const CONNECTOR_KINDS: readonly string[] = ['unclassified', 'residential', 'living_street', 'service'];
const CONNECTOR_COST = 4;
/** At least this share of a route's length is on MAIN_ROAD_KINDS. */
export const CONVOY_MAIN_SHARE = 0.8;
/** The route stays inside this share of the half-width (missions.ts HORDE_EDGE): in sight, and the aim reaches it. */
export const CONVOY_EDGE = 0.9;
/** Entry and exit are at least this many degrees apart, as bearings from the map centre. */
export const CONVOY_MIN_TURN = 90;
/** Shortest route worth offering, in metres (spec 004, Chief's reconciliation: replaces the 900-1,500 m band). */
export const CONVOY_MIN_LENGTH = 850;
/** The route length aimed for at difficulty d, capped by what the map allows. */
export const convoyTargetLength = (d: number): number => 900 + 100 * (d - 1);
/** Entry points tried per map (stable order), so a huge map costs at most this many dijkstra runs. */
export const CONVOY_MAX_ENTRIES = 24;
/** Trucks by difficulty 1-5. */
export const CONVOY_TRUCKS = [3, 3, 4, 4, 5] as const;
/** Half-width of the stretch of road where a zombie can stop a truck (metres). */
export const CONVOY_CORRIDOR = 9;

/** Mirror of missions.ts CHILD_FIRE_CLEARANCE (asserted equal in tests). */
const FIRE_CLEARANCE = 30;
/** Half a 3 m walk cell's diagonal: a zombie held out of a cell can still stand this close to its centre. */
const HALF_CELL_DIAGONAL = (3 * Math.SQRT2) / 2;
/**
 * Guardrail (spec 004 §6): no living convoy-mission zombie stands within this many metres of a school,
 * kindergarten or playground. A 105 aimed at one, landing three spreads off and killing at its full reach,
 * still leaves FIRE_CLEARANCE of clear ground: 24 + 30 + 9 + 2.1 ≈ 65 m.
 */
export const CONVOY_ZOMBIE_GAP = MAX_KILL_REACH + FIRE_CLEARANCE + 3 * weaponById('105').spread + HALF_CELL_DIAGONAL;
/** The route keeps this far from every child place, so the whole corridor sits outside the zombie gap (≈ 74 m). Never shrunk. */
export const CONVOY_CHILD_GAP = CONVOY_ZOMBIE_GAP + CONVOY_CORRIDOR;

/** Why no convoy is offered (drafts for the Story Writer; always true). */
export const CONVOY_NO_MAIN_ROADS = "There aren't enough main roads through here for a convoy.";
export const CONVOY_NO_SAFE_ROAD = "Every main road through here passes a school or playground, so there's no convoy here.";

export interface ConvoyEnd {
  /** Where the route meets the edge of the playable box. */
  p: V2;
  /** The main road it's on, or "an unnamed road". Untrusted map text: textContent only. */
  street: string;
  /** Compass side of the map, from its centre ("south", "north-east"). */
  side: string;
}

export interface ConvoyCheckpoint {
  /** Metres along the route. */
  s: number;
  p: V2;
  /** Cross street, else a nearby named place, else a compass phrase. Never a child place's name. */
  label: string;
}

export interface ConvoyRoute {
  /** Polyline from the entry to the exit, both on the CONVOY_EDGE box edge. */
  route: V2[];
  length: number;
  entry: ConvoyEnd;
  exit: ConvoyEnd;
  /** At 25, 50 and 75 % of the length. */
  checkpoints: ConvoyCheckpoint[];
  /** Metres on MAIN_ROAD_KINDS, as a share of `length`. */
  mainShare: number;
  trucks: number;
}

export type ConvoyRouteResult = { ok: true; plan: ConvoyRoute } | { ok: false; reason: string };

/** The seeded stream the convoy generator uses (spec 004 §2). */
export const convoyRng = (map: MapData, seed: number, d: number): Rng => mulberry32(hashString(`convoy|${map.name}|${seed}|${d}`));

export const isMainRoad = (kind: string): boolean => MAIN_ROAD_KINDS.includes(kind);
export const hasMainRoads = (map: MapData): boolean => map.roads.some((r) => isMainRoad(r.kind));

const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
/** Bearing from the map centre in degrees, 0 = north (−z), clockwise. */
const bearing = (p: V2): number => ((Math.atan2(p.x, -p.z) * 180) / Math.PI + 360) % 360;
const compassOf = (p: V2): string => COMPASS[Math.round(bearing(p) / 45) % 8];
const angleApart = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};

/** A label that could name a school, kindergarten or playground (owner decision #11: never on screen). */
const childLabel = (map: MapData, label: string, p: V2): boolean => isChildPlaceFeature(map, 'road', label, p);

// ---------------------------------------------------------------------------------------
// Corridor raster: which grid cells lie within the corridor, and how far along the route.
// ---------------------------------------------------------------------------------------

/** The parts of a WalkGrid the corridor needs (a WalkGrid fits; so does a bare geometry). */
export interface CorridorGrid {
  readonly cell: number;
  readonly half: number;
  readonly n: number;
}

/** Calls `visit(cell index, s, distance)` for every cell centre within `width` of each route segment. */
function rasterCorridor(grid: CorridorGrid, route: V2[], width: number, visit: (k: number, s: number, d: number) => void): void {
  const { cell, half, n } = grid;
  const col = (x: number) => Math.floor((x + half) / cell);
  let s0 = 0;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const len = dist(a, b);
    const i0 = Math.max(0, col(Math.min(a.x, b.x) - width));
    const i1 = Math.min(n - 1, col(Math.max(a.x, b.x) + width));
    const j0 = Math.max(0, col(Math.min(a.z, b.z) - width));
    const j1 = Math.min(n - 1, col(Math.max(a.z, b.z) + width));
    for (let j = j0; j <= j1; j++) {
      const z = -half + (j + 0.5) * cell;
      for (let ii = i0; ii <= i1; ii++) {
        const x = -half + (ii + 0.5) * cell;
        const dx = b.x - a.x;
        const dz = b.z - a.z;
        const t = len === 0 ? 0 : Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (len * len)));
        const d = Math.hypot(x - (a.x + dx * t), z - (a.z + dz * t));
        if (d <= width) visit(j * n + ii, s0 + t * len, d);
      }
    }
    s0 += len;
  }
}

/**
 * One entry per grid cell: the route distance `s` of the nearest route point for cells within CONVOY_CORRIDOR of
 * the route, else −1. Built once per Sim so the per-step "anything on the road ahead?" test is one lookup per zombie.
 */
export function corridorIndex(grid: CorridorGrid, route: V2[], width = CONVOY_CORRIDOR): Float32Array {
  const out = new Float32Array(grid.n * grid.n).fill(-1);
  const best = new Float32Array(grid.n * grid.n).fill(Infinity);
  rasterCorridor(grid, route, width, (k, s, d) => {
    if (d < best[k]) {
      best[k] = d;
      out[k] = s;
    }
  });
  return out;
}

/**
 * How far apart along the route two stretches may claim the same corridor cell before it counts as doubling back.
 * The spec's 2 × corridor rejects every real roundabout and hairpin (West Hobart's routes all curl round one):
 * a bend of radius r ≤ corridor shares cells over up to 2πr of route. So the limit is a full turn at the corridor's
 * radius. A route that really comes back along itself (a parallel road, an out-and-back) shares cells far beyond it.
 */
export const CONVOY_DOUBLE_BACK = 2 * Math.PI * CONVOY_CORRIDOR;

/** True when the route comes back over its own corridor: some cell is claimed by two stretches more than `apart` apart in s. */
export function routeDoublesBack(route: V2[], half: number, width = CONVOY_CORRIDOR, apart = CONVOY_DOUBLE_BACK): boolean {
  const grid: CorridorGrid = { cell: 3, half: half + 60, n: Math.ceil((2 * (half + 60)) / 3) };
  const lo = new Map<number, number>();
  const hi = new Map<number, number>();
  let doubled = false;
  rasterCorridor(grid, route, width, (k, s) => {
    const a = lo.get(k);
    if (a === undefined) {
      lo.set(k, s);
      hi.set(k, s);
      return;
    }
    const l = Math.min(a, s);
    const h = Math.max(hi.get(k)!, s);
    lo.set(k, l);
    hi.set(k, h);
    if (h - l > apart) doubled = true;
  });
  return doubled;
}

// ---------------------------------------------------------------------------------------
// Route finder
// ---------------------------------------------------------------------------------------

/** Where a main road crosses out of the box: its last node inside, the crossing point, the road. */
interface Gate {
  node: number;
  p: V2;
  road: number;
  bearing: number;
}

/** The point where segment inside→outside crosses the box |x|,|z| ≤ lim. */
function boxCrossing(a: V2, b: V2, lim: number): V2 {
  let t = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  if (dx > 0) t = Math.min(t, (lim - a.x) / dx);
  if (dx < 0) t = Math.min(t, (-lim - a.x) / dx);
  if (dz > 0) t = Math.min(t, (lim - a.z) / dz);
  if (dz < 0) t = Math.min(t, (-lim - a.z) / dz);
  return { x: a.x + dx * t, z: a.z + dz * t };
}

/** Edges no convoy may use within `gap` of a child place (cached per graph, map and gap). */
const closedCache = new WeakMap<RoadGraph, { map: MapData; gap: number; closed: Map<number, boolean> }>();
function childClosed(map: MapData, g: RoadGraph, gap: number): (u: number, v: number) => boolean {
  let c = closedCache.get(g);
  if (!c || c.map !== map || c.gap !== gap) {
    c = { map, gap, closed: new Map() };
    closedCache.set(g, c);
  }
  const memo = c.closed;
  const n = g.nodes.length;
  return (u, v) => {
    const key = Math.min(u, v) * n + Math.max(u, v);
    let x = memo.get(key);
    if (x === undefined) {
      x = segmentNearChildPlace(map, g.nodes[u], g.nodes[v], gap);
      memo.set(key, x);
    }
    return x;
  };
}

interface Candidate {
  from: Gate;
  to: Gate;
  path: number[];
  length: number;
  main: number;
}

/** Every route between two gates that meets the rules except doubling back (checked lazily, it costs more). */
function candidates(map: MapData, g: RoadGraph, gap: number | null): { list: Candidate[]; gates: number } {
  const lim = map.half * CONVOY_EDGE;
  const inside = (p: V2) => Math.abs(p.x) <= lim && Math.abs(p.z) <= lim;
  const closed = gap === null ? () => false : childClosed(map, g, gap);
  const kindOf = (e: Edge) => map.roads[e.road].kind;

  // Gates: main-road nodes inside the box with a main-road edge leaving it, the crossing itself clear of child places.
  const all: Gate[] = [];
  for (let u = 0; u < g.nodes.length; u++) {
    if (g.comp[u] !== g.mainComp || !inside(g.nodes[u])) continue;
    for (const e of g.adj[u]) {
      if (!isMainRoad(kindOf(e)) || inside(g.nodes[e.to])) continue;
      const p = boxCrossing(g.nodes[u], g.nodes[e.to], lim);
      if (gap !== null && segmentNearChildPlace(map, p, g.nodes[u], gap)) continue;
      all.push({ node: u, p, road: e.road, bearing: bearing(p) });
    }
  }
  // Stable order (by bearing, then node), thinned evenly to the cap.
  all.sort((a, b) => a.bearing - b.bearing || a.node - b.node || a.road - b.road);
  const gates = all.length <= CONVOY_MAX_ENTRIES ? all : Array.from({ length: CONVOY_MAX_ENTRIES }, (_, i) => all[Math.floor((i * all.length) / CONVOY_MAX_ENTRIES)]);

  // Per road: 0 main, 1 connector, 2 closed to trucks. Per node: inside the box.
  const cls = Uint8Array.from(map.roads, (r) => (isMainRoad(r.kind) ? 0 : CONNECTOR_KINDS.includes(r.kind) ? 1 : 2));
  const inBox = Uint8Array.from(g.nodes, (p) => (inside(p) ? 1 : 0));
  const cost = (u: number, e: Edge): number => {
    const c = cls[e.road];
    if (c === 2 || !inBox[e.to] || closed(u, e.to)) return Infinity;
    return c === 0 ? e.w : e.w * CONNECTOR_COST;
  };
  const list: Candidate[] = [];
  for (const from of gates) {
    const { d, prev } = dijkstra(g, from.node, cost);
    for (const to of gates) {
      if (to.node === from.node || angleApart(from.bearing, to.bearing) < CONVOY_MIN_TURN || !Number.isFinite(d[to.node])) continue;
      const path: number[] = [];
      for (let u = to.node; u !== -1; u = prev[u]) path.push(u);
      path.reverse();
      let length = dist(from.p, g.nodes[from.node]) + dist(g.nodes[to.node], to.p);
      let main = length;
      for (let i = 1; i < path.length; i++) {
        // The edge dijkstra took: the cheapest between the two nodes.
        let best: Edge | null = null;
        for (const e of g.adj[path[i - 1]]) if (e.to === path[i] && (!best || cost(path[i - 1], e) < cost(path[i - 1], best))) best = e;
        length += best!.w;
        if (isMainRoad(kindOf(best!))) main += best!.w;
      }
      if (length < CONVOY_MIN_LENGTH || main / length < CONVOY_MAIN_SHARE) continue;
      list.push({ from, to, path, length, main });
    }
  }
  return { list, gates: gates.length };
}

const roadName = (map: MapData, road: number): string => map.roads[road].name || 'an unnamed road';

/** A cross street at a route junction within 40 m of s, else placeLabel, never a child place's name. */
function checkpointLabel(map: MapData, g: RoadGraph, c: Candidate, nodeS: number[], s: number, p: V2): string {
  const onRoute = new Set<string>();
  for (let i = 1; i < c.path.length; i++) for (const e of g.adj[c.path[i - 1]]) if (e.to === c.path[i] && map.roads[e.road].name) onRoute.add(map.roads[e.road].name!);
  let best: string | null = null;
  let bd = 40;
  for (let i = 0; i < c.path.length; i++) {
    const ds = Math.abs(nodeS[i] - s);
    if (ds > bd) continue;
    const u = c.path[i];
    for (const e of g.adj[u]) {
      const name = map.roads[e.road].name;
      if (name && !onRoute.has(name) && !childLabel(map, name, g.nodes[u])) {
        best = name;
        bd = ds;
        break;
      }
    }
  }
  if (best !== null) return best;
  const l = placeLabel(map, p);
  return childLabel(map, l, p) ? `the ${compassOf(p)} of the map` : l;
}

function plan(map: MapData, g: RoadGraph, c: Candidate, d: number): ConvoyRoute {
  const route = [c.from.p, ...c.path.map((u) => g.nodes[u]), c.to.p];
  const length = polylineLength(route);
  const nodeS: number[] = [];
  let s = dist(c.from.p, g.nodes[c.path[0]]);
  c.path.forEach((u, i) => {
    if (i > 0) s += dist(g.nodes[c.path[i - 1]], g.nodes[u]);
    nodeS.push(s);
  });
  const checkpoints = [0.25, 0.5, 0.75].map((f) => {
    const cs = length * f;
    const p = pointAlong(route, cs);
    return { s: cs, p, label: checkpointLabel(map, g, c, nodeS, cs, p) };
  });
  return {
    route,
    length,
    entry: { p: c.from.p, street: roadName(map, c.from.road), side: compassOf(c.from.p) },
    exit: { p: c.to.p, street: roadName(map, c.to.road), side: compassOf(c.to.p) },
    checkpoints,
    mainShare: c.main / c.length,
    trucks: CONVOY_TRUCKS[Math.max(1, Math.min(5, Math.round(d))) - 1],
  };
}

/**
 * The convoy's route on this map at difficulty d (spec 004 §4 and Technical design §2): main roads from one edge of
 * the CONVOY_EDGE box to another at least 90° round, ≥ 80 % on main roads, ≥ CONVOY_MIN_LENGTH, never within
 * CONVOY_CHILD_GAP of a school, kindergarten or playground, never doubling back. Picks one of the three routes
 * nearest convoyTargetLength(d) with `rng`. With none, says why in words that are true.
 */
export function findConvoyRoute(map: MapData, g: RoadGraph, d: number, rng: Rng): ConvoyRouteResult {
  if (!hasMainRoads(map) || g.mainComp < 0) return { ok: false, reason: CONVOY_NO_MAIN_ROADS };
  const target = convoyTargetLength(Math.max(1, Math.min(5, Math.round(d))));
  const { list } = candidates(map, g, CONVOY_CHILD_GAP);
  // Seeded order first, then a stable sort by whole metres from the target: routes of (near) equal length, common
  // on a street grid, are chosen between by seed rather than always by bearing.
  shuffle(rng, list);
  const off = (c: Candidate) => Math.round(Math.abs(c.length - target));
  list.sort((a, b) => off(a) - off(b));
  const near: Candidate[] = [];
  for (const c of list) {
    if (near.length === 3) break;
    if (!routeDoublesBack([c.from.p, ...c.path.map((u) => g.nodes[u]), c.to.p], map.half)) near.push(c);
  }
  if (near.length) return { ok: true, plan: plan(map, g, near[Math.floor(rng() * near.length)], d) };
  // Say which rule ruled it out: would the main roads make a route if schools didn't close any? (Only for the words.)
  const open = candidates(map, g, null).list;
  const anyOpen = open.some((c) => !routeDoublesBack([c.from.p, ...c.path.map((u) => g.nodes[u]), c.to.p], map.half));
  return { ok: false, reason: anyOpen ? CONVOY_NO_SAFE_ROAD : CONVOY_NO_MAIN_ROADS };
}
