import type { MapData, V2 } from '../map/types';
import { dist, polylineLength } from '../map/geom';
import { nearestNode, roadNamesAlong, type RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { mapFeatures } from '../map/recon';
import { FIRST_WAVE, placeLabel, type Mission, type WaveDirection } from '../sim/missions';
import { noWaveSpawn, ORBIT } from '../sim/sim';
import type { ArrowShape, LabelSpec, Rect } from './briefingDiorama';
import { TOUR_TEXT } from './briefingTourText';

/**
 * The briefing walk-through ("Hello, home", BACKLOG 3.7): a scripted camera tour over the diorama,
 * built entirely from the mission data (never written per map). This file is pure (no DOM, no
 * WebGL): the stops, their captions and timings, and the camera maths. The view is in
 * briefingTourView.ts; the words are in briefingTourText.ts.
 *
 * Order: the area (establishing shot, public landmarks labelled), the safehouse or home, the
 * survivors or friendlies, each threat (horde groups; defend wave directions with the place names
 * the sim uses; the escort route traced along the road), then the gunship's orbit, then the camera
 * settles into the diorama's free orbit.
 */

export type StopKind = 'area' | 'safehouse' | 'home' | 'survivors' | 'friendlies' | 'stragglers' | 'horde' | 'waves' | 'route' | 'orbit';

/** What a stop highlights on both pictures (diorama and tactical map). */
export type TourMark =
  | { kind: 'area'; box: Rect }
  | { kind: 'ring'; p: V2; r: number; tone: 'safe' | 'hostile' | 'friendly' }
  | { kind: 'path'; pts: V2[] }
  | { kind: 'orbit'; c: V2; r: number };

export interface TourStop {
  id: string;
  kind: StopKind;
  caption: string;
  /** What the camera frames: a ground point, the radius (m) to keep in view, and the height to look at. */
  focus: { p: V2; r: number; y: number };
  /** Camera tilt above the horizon, radians. */
  elev: number;
  /** Look from this side (wave stops: from where they come, toward the safehouse). */
  lookFrom?: V2;
  /** Escort route: the camera's target follows it along the road during the hold. */
  path?: V2[];
  /** Diorama labels this stop is about (shown first and emphasised). */
  labels: string[];
  mark: TourMark | null;
  /** Share of the tour's hold time (1 = an ordinary stop). */
  weight: number;
}

export interface TourInput {
  map: MapData;
  mission: Mission;
  waves: WaveDirection[];
  graph: RoadGraph;
  /** The sim's walk grid: lets wave place names respect the same "can walk to the safehouse" rule as the sim. */
  grid?: WalkGrid;
  /** The diorama's extent. */
  box: Rect;
  /** The diorama's labels (labelSpecs): landmarks come only from these, so the player's typed address never can. */
  labels: LabelSpec[];
  /** The wave arrows drawn in the diorama, one per entry of `waves` (null where none is drawn). */
  waveArrows: (ArrowShape | null)[];
}

/** Places a tour never names as a landmark (schools and the like are left out of the game, owner decision #11). */
const NOT_A_LANDMARK = new Set(['school', 'kindergarten', 'playground']);
/** placeLabel's fallback when no named place is near: true, but not a name worth saying. */
const isFallbackLabel = (s: string) => /^the .* of the map$/.test(s);
/**
 * The gunship's orbit direction seen from above (north up). The sim's angle runs backwards
 * (Sim.aircraft: a = -t / period · 2π, x east, z south), which is anticlockwise on the map;
 * tests/briefingTour.test.ts checks this against the sim.
 */
export const ORBIT_DIRECTION = 'anticlockwise' as const;

const mid = (a: V2, b: V2): V2 => ({ x: (a.x + b.x) / 2, z: (a.z + b.z) / 2 });
const mean = (ps: V2[]): V2 => ({ x: ps.reduce((s, p) => s + p.x, 0) / ps.length, z: ps.reduce((s, p) => s + p.z, 0) / ps.length });

/** The stops for one mission, in order. */
export function tourStops(input: TourInput): TourStop[] {
  const { map, mission: m, box } = input;
  const stops: TourStop[] = [];
  const centre = { x: (box.x0 + box.x1) / 2, z: (box.z0 + box.z1) / 2 };

  // 1. The area: an establishing shot, with up to two real public landmarks named.
  const feats = new Map(mapFeatures(map).map((f) => [`f:${f.id}`, f]));
  const landmarks: string[] = [];
  for (const l of [...input.labels.filter((x) => x.kind === 'anchor'), ...input.labels.filter((x) => x.kind === 'place')]) {
    const f = feats.get(l.id);
    if (!f?.name || NOT_A_LANDMARK.has(f.category) || landmarks.includes(f.name)) continue;
    landmarks.push(f.name);
    if (landmarks.length === 2) break;
  }
  const across = Math.round(Math.max(box.x1 - box.x0, box.z1 - box.z0) / 50) * 50;
  stops.push({
    id: 'area',
    kind: 'area',
    caption: TOUR_TEXT.area({ across, landmarks }),
    focus: { p: centre, r: across / 2, y: 0 },
    elev: 1.12,
    labels: input.labels.filter((l) => l.kind === 'anchor').map((l) => l.id),
    mark: { kind: 'area', box },
    weight: 1.2,
  });

  // 2. The safehouse (defend) or the home pin (escort).
  if (m.type === 'defend' && m.safehouse) {
    const s = m.safehouse;
    const r = Math.max(...s.poly.map((p) => dist(p, s.centre)));
    stops.push({
      id: 'safehouse',
      kind: 'safehouse',
      caption: TOUR_TEXT.safehouse({ name: s.name, hold: clock(m.timeLimit) }),
      focus: { p: s.centre, r: Math.max(70, r * 3), y: 8 },
      elev: 0.72,
      labels: ['safehouse'],
      mark: { kind: 'ring', p: s.centre, r: r + 16, tone: 'safe' },
      weight: 1,
    });
  }
  if (m.type === 'escort' && m.home) {
    stops.push({
      id: 'home',
      kind: 'home',
      caption: TOUR_TEXT.home({ street: m.home.street, need: m.needHome, n: m.survivors.length }),
      focus: { p: m.home.centre, r: 75, y: 12 },
      elev: 0.85,
      labels: ['home'],
      mark: { kind: 'ring', p: m.home.centre, r: 16, tone: 'safe' },
      weight: 1,
    });
  }

  // 3. The people we're here for.
  if (m.type === 'escort' && m.safehouse && m.survivors.length) {
    const delay = Math.min(...m.survivors.map((s) => s.delay));
    stops.push({
      id: 'survivors',
      kind: 'survivors',
      caption: TOUR_TEXT.survivors({ n: m.survivors.length, place: m.safehouse.name, delay: Math.round(delay) }),
      focus: { p: m.safehouse.centre, r: 75, y: 8 },
      elev: 0.8,
      labels: ['safehouse'],
      mark: { kind: 'ring', p: m.safehouse.centre, r: 26, tone: 'friendly' },
      weight: 1,
    });
  }
  const sheltering = m.survivors.filter((s) => !s.route);
  if (sheltering.length) {
    const p = sheltering[0].start;
    const near = m.hordes.length ? m.hordes.reduce((a, h) => (dist(h.centre, p) < dist(a.centre, p) ? h : a)) : null;
    stops.push({
      id: 'friendlies',
      kind: 'friendlies',
      caption: TOUR_TEXT.friendlies({ n: sheltering.length, place: near ? near.label : placeLabel(map, p) }),
      focus: { p, r: 70, y: 6 },
      elev: 0.9,
      labels: ['friendlies'],
      mark: { kind: 'ring', p, r: 14, tone: 'friendly' },
      weight: 1,
    });
  }
  const walkingIn = m.type === 'defend' ? m.survivors.filter((s) => s.route) : [];
  if (walkingIn.length && m.safehouse) {
    const p = walkingIn[0].start;
    stops.push({
      id: 'stragglers',
      kind: 'stragglers',
      caption: TOUR_TEXT.stragglers({ n: walkingIn.length, street: streetAt(map, p) }),
      focus: { p: mid(p, m.safehouse.centre), r: dist(p, m.safehouse.centre) / 2 + 50, y: 4 },
      elev: 0.9,
      labels: [],
      mark: { kind: 'ring', p, r: 14, tone: 'friendly' },
      weight: 1,
    });
  }

  // 4. Threats. Hordes at the same place share a stop, as they share a label (ids match labelSpecs).
  const groups = new Map<string, Mission['hordes']>();
  for (const h of m.hordes) groups.set(h.label, [...(groups.get(h.label) ?? []), h]);
  let k = 0;
  for (const [place, hs] of groups) {
    const c = mean(hs.map((h) => h.centre));
    const spread = Math.max(...hs.map((h) => dist(h.centre, c)));
    stops.push({
      id: `horde${k}`,
      kind: 'horde',
      caption: TOUR_TEXT.horde({ hordes: hs.length, count: hs.reduce((s, h) => s + h.count, 0), cold: hs.reduce((s, h) => s + h.cold, 0), place, k }),
      focus: { p: c, r: spread + 30 + 55, y: 2 },
      elev: 0.95,
      labels: [`horde${k}`],
      mark: { kind: 'ring', p: c, r: spread + 30 + 10, tone: 'hostile' },
      weight: 1,
    });
    k++;
  }
  if (m.type === 'defend' && m.waves && m.safehouse) {
    const names = wavePlaceNames(input);
    input.waves.forEach((w, i) => {
      const a = input.waveArrows[i];
      const subject = a ? mid(a.start, a.tip) : m.safehouse!.centre;
      const r = a ? dist(a.start, a.tip) / 2 + 45 : 120;
      stops.push({
        id: `wave${i}`,
        kind: 'waves',
        caption: TOUR_TEXT.waves({ compass: w.compass, places: names[i], first: i === 0 ? FIRST_WAVE : null }),
        focus: { p: subject, r, y: 2 },
        elev: 0.62,
        lookFrom: w.from,
        labels: a ? [`wave${i}`] : [],
        mark: a ? { kind: 'ring', p: a.start, r: 26, tone: 'hostile' } : null,
        weight: 1,
      });
    });
  }
  if (m.type === 'escort' && m.route && m.route.length >= 2) {
    stops.push({
      id: 'route',
      kind: 'route',
      caption: TOUR_TEXT.route({ length: Math.round(polylineLength(m.route) / 10) * 10, via: routeStreets(input) }),
      focus: { p: m.route[0], r: 95, y: 2 },
      elev: 0.82,
      path: m.route,
      labels: ['home'],
      mark: { kind: 'path', pts: m.route },
      weight: 1.7,
    });
  }

  // 5. The gunship.
  stops.push({
    id: 'orbit',
    kind: 'orbit',
    caption: TOUR_TEXT.orbit({ place: placeLabel(map, m.orbitCentre), direction: ORBIT_DIRECTION, radius: ORBIT.radius, altitude: ORBIT.altitude }),
    focus: { p: centre, r: across / 2, y: 0 },
    elev: 0.62,
    labels: [],
    mark: { kind: 'orbit', c: m.orbitCentre, r: ORBIT.radius },
    weight: 1,
  });
  return stops;
}

/** "3:45", as the briefing writes times. */
export function clock(secs: number): string {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The street a point is on, as the defend briefing names it (nearest named road, else "an unnamed street"). */
function streetAt(map: MapData, p: V2): string {
  const l = placeLabel({ ...map, areas: [] }, p);
  return isFallbackLabel(l) ? 'an unnamed street' : l;
}

const sector = (from: V2, to: V2) => Math.round((((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI + 360) % 360) / 45) % 8;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

/**
 * For each likely wave direction, the (up to two) place names the sim would announce for a wave
 * spawning there: placeLabel of the road nodes the sim may spawn at in that compass sector (same
 * filters as Sim.updateWaves for defend), most common first. Unnamed fallbacks are left out.
 */
export function wavePlaceNames(input: Pick<TourInput, 'map' | 'mission' | 'waves' | 'graph' | 'grid'>): string[][] {
  const { map, mission: m, graph: g, grid } = input;
  if (!m.waves || !m.safehouse) return input.waves.map(() => []);
  const ref = m.safehouse.centre;
  const lim = map.half * 0.95;
  const banned = noWaveSpawn(map, g);
  const field = grid ? grid.flowField(grid.perimeterCells(m.safehouse.poly)) : null;
  const counts = Array.from({ length: 8 }, () => new Map<string, number>());
  for (let i = 0; i < g.nodes.length; i++) {
    if (g.comp[i] !== g.mainComp || banned[i]) continue;
    const n = g.nodes[i];
    if (Math.abs(n.x) > lim || Math.abs(n.z) > lim) continue;
    const r = dist(n, ref);
    if (r < m.waves.minDist || r > m.waves.maxDist) continue;
    if (field && grid && grid.fieldAt(field, n.x, n.z) <= 0) continue;
    const label = placeLabel(map, n);
    if (isFallbackLabel(label)) continue;
    const c = counts[sector(ref, n)];
    c.set(label, (c.get(label) ?? 0) + 1);
  }
  return input.waves.map((w) => {
    const c = counts[COMPASS.indexOf(w.compass)] ?? new Map<string, number>();
    return [...c.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).slice(0, 2).map(([name]) => name);
  });
}

/** The streets an escort walks, as its briefing lists them ("via A, B and C"; none if only one). */
export function routeStreets(input: Pick<TourInput, 'map' | 'mission' | 'graph'>): string[] {
  const { map, mission: m, graph: g } = input;
  if (!m.route || !m.safehouse) return [];
  const byPos = new Map<string, number>();
  g.nodes.forEach((n, i) => byPos.set(`${n.x},${n.z}`, i));
  const start = nearestNode(g, m.safehouse.centre, 200);
  const inner = m.route.slice(1, -1).map((p) => byPos.get(`${p.x},${p.z}`) ?? -1);
  if (start < 0 || inner.some((i) => i < 0)) return [];
  const names = roadNamesAlong(g, map, [start, ...inner]);
  return names.length > 1 ? names.slice(0, 3) : [];
}

// ---------------------------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------------------------

/** The tour's length, seconds: the owner approved 15–20 s. */
export const TOUR_MIN = 15;
export const TOUR_MAX = 20;
/** Seconds per ordinary stop (move in plus hold) when there's room. A mission with many hordes gets less, never under 2 s. */
const STOP_IDEAL = 2.6;
/** First stop's hold (the tour starts there: no move in). */
const FIRST_HOLD = 2.6;
/** Flying from one stop to the next (shorter when stops are short). */
export const MOVE = 1.0;
/** Settling from the last stop into the free orbit. */
export const SETTLE = 1.3;

export interface TourSegment {
  /** When the move toward this stop starts (its caption shows from here). */
  t0: number;
  move: number;
  hold: number;
}

export interface TourTimeline {
  segs: TourSegment[];
  /** When the settle into the free orbit starts. */
  settleAt: number;
  total: number;
}

export function tourTimeline(stops: Pick<TourStop, 'weight'>[]): TourTimeline {
  const weights = stops.slice(1).reduce((s, x) => s + x.weight, 0);
  const total = Math.max(TOUR_MIN, Math.min(TOUR_MAX, FIRST_HOLD + SETTLE + weights * STOP_IDEAL));
  const unit = weights ? (total - FIRST_HOLD - SETTLE) / weights : 0;
  const segs: TourSegment[] = [];
  let t = 0;
  stops.forEach((s, i) => {
    const slot = i ? unit * s.weight : FIRST_HOLD;
    const move = i ? Math.min(MOVE, 0.4 * unit) : 0;
    segs.push({ t0: t, move, hold: slot - move });
    t += slot;
  });
  return { segs, settleAt: t, total: t + SETTLE };
}

/** Which stop is on at time t (its move or hold), or -1 once settling. */
export function stopAt(tl: TourTimeline, t: number): number {
  if (t >= tl.settleAt) return -1;
  for (let i = tl.segs.length - 1; i >= 0; i--) if (t >= tl.segs[i].t0) return i;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Camera maths
// ---------------------------------------------------------------------------------------------

/** A camera on a turntable: looking at (x, y, z) from `dist` metres, at azimuth `az` and tilt `elev`. `shift`: vertical picture offset (NDC). */
export interface Pose {
  x: number;
  y: number;
  z: number;
  dist: number;
  az: number;
  elev: number;
  shift: number;
}

export const easeInOut = (t: number): number => {
  const k = Math.max(0, Math.min(1, t));
  return k < 0.5 ? 4 * k * k * k : 1 - (-2 * k + 2) ** 3 / 2;
};

/** The shortest signed turn from angle a to angle b. */
export const angleDelta = (a: number, b: number): number => {
  const d = (b - a) % (Math.PI * 2);
  return d > Math.PI ? d - Math.PI * 2 : d < -Math.PI ? d + Math.PI * 2 : d;
};

/**
 * A camera move from a to b at eased progress e (0..1): the target glides, the turn takes the short
 * way round, the zoom is geometric, and a long move rises a little in the middle (a flyover, not a dolly).
 */
export function blendPose(a: Pose, b: Pose, e: number): Pose {
  const lerp = (x: number, y: number) => x + (y - x) * e;
  const travel = Math.hypot(b.x - a.x, b.z - a.z);
  const hop = Math.min(0.5, travel / (a.dist + b.dist));
  const dist = Math.exp(lerp(Math.log(a.dist), Math.log(b.dist))) * (1 + hop * Math.sin(Math.PI * e));
  return { x: lerp(a.x, b.x), y: lerp(a.y, b.y), z: lerp(a.z, b.z), dist, az: a.az + angleDelta(a.az, b.az) * e, elev: lerp(a.elev, b.elev), shift: lerp(a.shift, b.shift) };
}

/** Camera distance that keeps a circle of radius r (m) in view, for a vertical field of view (degrees) and aspect. */
export function framingDist(r: number, aspect: number, fovDeg: number): number {
  const v = (fovDeg * Math.PI) / 360;
  const h = Math.atan(Math.tan(v) * aspect);
  return r / Math.tan(Math.min(v, h)) / 0.88;
}

/** The point `s` metres along a polyline (clamped to its ends). */
export function pointAlong(pts: V2[], s: number): V2 {
  let left = Math.max(0, s);
  for (let i = 1; i < pts.length; i++) {
    const L = dist(pts[i - 1], pts[i]);
    if (left <= L && L > 0) {
      const k = left / L;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * k, z: pts[i - 1].z + (pts[i].z - pts[i - 1].z) * k };
    }
    left -= L;
  }
  return { ...pts[pts.length - 1] };
}

/** Tours seen this session (by mission), so re-opening a briefing starts with the tour already done. */
const seen = new Set<string>();
export const tourKey = (m: Mission): string => [m.mapName, m.type, m.difficulty, m.seed, m.template ?? '', m.anchor?.id ?? ''].join('|');
export const tourSeen = (m: Mission): boolean => seen.has(tourKey(m));
export const markTourSeen = (m: Mission): void => void seen.add(tourKey(m));
