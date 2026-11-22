import type { Feature, FeatureCategory, MapData, V2 } from '../map/types';
import { bounds, centroid, dist, pointInPolygon, polygonArea, polylineLength, distToSegment } from '../map/geom';
import { avoidingEdges, dijkstra, nearestNode, pathFromPrev, roadNamesAlong, type EdgeCost, type RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import {
  CATEGORY_INFO, CHILD_KINDS, MISSION_TEMPLATES, featureName, findAnchor, nearChildPlace, routeNearChildPlace, segmentNearChildPlace, type TemplateId,
} from '../map/recon';
import { MAX_KILL_REACH } from './weapons';
import { hashString, mulberry32, pick, shuffle, type Rng } from '../util/rng';

/**
 * Builds a mission from a map with fixed, seeded rules. Same map + seed + settings
 * always gives the same mission. Briefing intel is always true (PLAN §5a).
 */
export type MissionType = 'clear' | 'escort' | 'defend';
export const MISSION_TYPES: readonly MissionType[] = ['clear', 'escort', 'defend'];

export interface Horde {
  centre: V2;
  count: number;
  cold: number;
  label: string;
}

export interface SurvivorPlan {
  start: V2;
  /** null = stays put (sheltering). */
  route: V2[] | null;
  delay: number;
}

/**
 * Waves vary within a mission. Each kind scales the plan's base wave:
 * - standard: the plan as it is;
 * - rush: fewer zombies, all warm, lunging fast, and sooner after the last wave;
 * - cold: mostly cold-blooded (hard to see on thermal), only offered when the area has cold-blooded contacts;
 * - big: a larger wave after a longer lull, never in the opening waves.
 * Averaged over a mission the kinds bring roughly as many zombies per minute as standard waves alone.
 */
export type WaveKind = 'standard' | 'rush' | 'cold' | 'big';
export interface WaveKindDef {
  /** Multiplies the plan's wave size. */
  size: number;
  /** Multiplies the zombies' walking speed. */
  speed: number;
  /** Multiplies the plan's `every`: the lull before this wave arrives. */
  gap: number;
  /** Share of cold-blooded zombies; null = the plan's coldShare. */
  cold: number | null;
}
export const WAVE_KINDS: Record<WaveKind, WaveKindDef> = {
  standard: { size: 1, speed: 1, gap: 1, cold: null },
  rush: { size: 0.6, speed: 1.4, gap: 0.8, cold: 0 },
  cold: { size: 1, speed: 1, gap: 1, cold: 0.75 },
  big: { size: 1.7, speed: 1, gap: 1.5, cold: null },
};
/** Seconds before the first wave (it arrives quickly). */
export const FIRST_WAVE = 3;

export interface WavePlan {
  every: number;
  size: number;
  coldShare: number;
  minDist: number;
  maxDist: number;
  maxAlive: number;
  /** The kind of each wave in order (seeded). Missing = every wave is standard. */
  kinds?: WaveKind[];
}

export interface Mission {
  type: MissionType;
  difficulty: number;
  seed: number;
  mapName: string;
  title: string;
  briefing: string[];
  intel: string[];
  /** Seconds. For "defend" this is how long to hold. */
  timeLimit: number;
  orbitCentre: V2;
  safehouse?: { centre: V2; poly: V2[]; name: string };
  home?: { centre: V2; street: string };
  route?: V2[];
  survivors: SurvivorPlan[];
  needHome: number;
  hordes: Horde[];
  waves?: WavePlan;
  friendlyFireLimit: number;
  /** Set when the mission was built from a recon template around a real place. */
  template?: TemplateId;
  anchor?: { id: string; name: string; category: FeatureCategory; p: V2; pts?: V2[] };
}

export interface MissionOptions {
  type: MissionType | 'auto';
  difficulty: number;
  seed: number;
  /** A recon template (see src/map/recon.ts). Its base type wins; `type` may be 'auto' or that base. */
  template?: TemplateId;
  /** The feature id the template is built around; defaults to the template's best place. */
  anchor?: string;
}

export type MissionResult = { ok: true; mission: Mission } | { ok: false; reason: string };

// Guardrail (PLAN §9, issue #11): schools, kindergartens and colleges are never a safehouse.
const SAFE_KINDS = ['hospital', 'community_centre', 'police', 'fire_station', 'library', 'place_of_worship', 'clinic'];
const KIND_LABEL: Record<string, string> = {
  hospital: 'the hospital', community_centre: 'the community centre', police: 'the police station',
  fire_station: 'the fire station', library: 'the library', place_of_worship: 'the church', clinic: 'the clinic',
};

/**
 * How much bigger hordes and waves get with difficulty (owner playtest 3.16: "even at level 2 the waves are
 * quite small and easily taken out"). Difficulty 1 stays gentle (x1); each level above adds the type's step.
 * Tuned with the balance runner so the human-skill bot stays in QUALITY §3's bands.
 */
export const PRESSURE_STEP = { clear: 0.45, escort: 0.65 } as const;
export const pressure = (type: keyof typeof PRESSURE_STEP, d: number): number => 1 + PRESSURE_STEP[type] * (d - 1);
/**
 * Hold the safehouse: zombies per wave by difficulty 1-5 (was 6 + 4d: 10-26). Defend is the steepest mission:
 * at difficulty 5 waves come every 7 s and a few more zombies at the wall decide it (bot win rate 67% at 30,
 * 50% at 34, 33% at 38, 17% at 45 in a sweep), so it rises fast through the middle and difficulty 5 differs from 4 mostly
 * only in how often the waves come.
 */
export const DEFEND_WAVE_SIZE = [10, 20, 30, 36, 37] as const;
/** Clear missions: how many hordes (difficulty 2 and up bring one more than before 3.16). */
export const hordeCount = (d: number): number => Math.min(6, 2 + Math.floor(d * 0.8) + (d >= 2 ? 1 : 0));
/** Clear missions: zombies in each horde. */
export const hordeSize = (d: number): number => Math.round((6 + 3 * d) * pressure('clear', d));

/** A horde's zombies start within this many metres of its gathering point (see Sim). */
export const HORDE_SPREAD = 22;
/** ...and mill around it, each heading for a spot up to this many metres away (see Sim.updateZombies). */
export const HORDE_WANDER = 26;
/** Metres of clear ground kept between the farthest a shell can kill and a school, kindergarten or playground. */
export const CHILD_FIRE_CLEARANCE = 30;
/**
 * Guardrail (PLAN §9): no horde gathers within this many metres of a school, kindergarten or playground.
 * A zombie at the edge of its wander, hit by a 105 round, still leaves CHILD_FIRE_CLEARANCE of clear
 * ground before the grounds: 26 + 24 + 30 = 80 m.
 */
export const HORDE_CHILD_GAP = Math.max(HORDE_SPREAD, HORDE_WANDER) + MAX_KILL_REACH + CHILD_FIRE_CLEARANCE;

/** Road edges a survivor's route may not use: any that passes within CHILD_BUFFER of a child place (PLAN §9). */
const routeCostCache = new WeakMap<RoadGraph, { map: MapData; cost: EdgeCost }>();
function childSafeCost(map: MapData, g: RoadGraph): EdgeCost {
  const hit = routeCostCache.get(g);
  if (hit && hit.map === map) return hit.cost;
  const cost = avoidingEdges(g, (a, b) => segmentNearChildPlace(map, a, b));
  routeCostCache.set(g, { map, cost });
  return cost;
}

const fmtTime = (secs: number) => {
  const s = Math.max(0, Math.ceil(secs));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

function compass(from: V2, to: V2): string {
  const a = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI; // 0 = north
  const dirs = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  return dirs[Math.round(((a + 360) % 360) / 45) % 8];
}

/** A human name for a spot: a named park it's in or beside, else the nearest named street. */
export function placeLabel(map: MapData, p: V2): string {
  for (const a of map.areas) {
    if (a.name && a.kind !== 'water' && (pointInPolygon(p, a.pts) || dist(centroid(a.pts), p) < 70)) return a.name;
  }
  let best: string | undefined;
  let bd = 90;
  for (const r of map.roads) {
    if (!r.name) continue;
    for (let i = 1; i < r.pts.length; i++) {
      const d = distToSegment(p, r.pts[i - 1], r.pts[i]);
      if (d < bd) {
        bd = d;
        best = r.name;
      }
    }
  }
  return best ?? `the ${compass({ x: 0, z: 0 }, p)} of the map`;
}

function nearestStreet(map: MapData, p: V2): string {
  const l = placeLabel({ ...map, areas: [] }, p);
  return l.startsWith('the ') ? 'an unnamed street' : l;
}

/**
 * Guardrail (PLAN §9): may this building be a mission's safehouse? Never a school, kindergarten
 * or college, and never inside or beside one, or beside a playground.
 */
function safeBuilding(map: MapData, b: { pts: V2[]; kind?: string }): boolean {
  return !CHILD_KINDS.includes(b.kind ?? '') && !nearChildPlace(map, centroid(b.pts));
}

function findSafehouse(map: MapData, g: RoadGraph, rng: Rng): Mission['safehouse'] | null {
  const lim = map.half * 0.65;
  const pois = map.pois.filter((p) => SAFE_KINDS.includes(p.kind) && Math.abs(p.p.x) < lim && Math.abs(p.p.z) < lim && !nearChildPlace(map, p.p));
  shuffle(rng, pois);
  for (const poi of pois) {
    if (nearestNode(g, poi.p, 150) < 0) continue;
    const inside = map.buildings.find((x) => pointInPolygon(poi.p, x.pts));
    if (inside && !safeBuilding(map, inside)) continue;
    const b =
      inside ??
      map.buildings
        .filter((x) => dist(centroid(x.pts), poi.p) < 60 && safeBuilding(map, x))
        .sort((a, c) => dist(centroid(a.pts), poi.p) - dist(centroid(c.pts), poi.p))[0];
    const poly = b ? b.pts : circle(poi.p, 12);
    if (nearChildPlace(map, centroid(poly))) continue;
    return { centre: centroid(poly), poly, name: poi.name ?? KIND_LABEL[poi.kind] ?? 'the safehouse' };
  }
  // Fallback: one of the biggest buildings near the middle.
  const big = map.buildings
    .filter((b) => Math.hypot(centroid(b.pts).x, centroid(b.pts).z) < map.half * 0.5 && safeBuilding(map, b))
    .sort((a, b) => polygonArea(b.pts) - polygonArea(a.pts))
    .slice(0, 8)
    .filter((b) => nearestNode(g, centroid(b.pts), 80) >= 0);
  if (!big.length) return null;
  const b = pick(rng, big);
  return { centre: centroid(b.pts), poly: b.pts, name: b.name ?? `the big building on ${nearestStreet(map, centroid(b.pts))}` };
}

function circle(c: V2, r: number): V2[] {
  return Array.from({ length: 8 }, (_, i) => ({ x: c.x + Math.cos((i / 8) * Math.PI * 2) * r, z: c.z + Math.sin((i / 8) * Math.PI * 2) * r }));
}

function roadNodesWithin(g: RoadGraph, map: MapData, frac: number): number[] {
  const lim = map.half * frac;
  const out: number[] = [];
  for (let i = 0; i < g.nodes.length; i++) {
    if (g.comp[i] === g.mainComp && Math.abs(g.nodes[i].x) < lim && Math.abs(g.nodes[i].z) < lim) out.push(i);
  }
  return out;
}

export function generateMission(map: MapData, g: RoadGraph, grid: WalkGrid, opts: MissionOptions): MissionResult {
  if (!Number.isFinite(opts.difficulty)) return { ok: false, reason: 'Difficulty must be a number from 1 to 5.' };
  if (opts.type !== 'auto' && !MISSION_TYPES.includes(opts.type)) return { ok: false, reason: `Unknown mission type "${String(opts.type)}".` };
  const d = Math.max(1, Math.min(5, Math.round(opts.difficulty)));
  const rng = mulberry32(hashString(`${map.name}|${opts.seed}|${opts.type}|${d}`));
  if (g.mainComp < 0 || roadNodesWithin(g, map, 0.9).length < 10) {
    return { ok: false, reason: 'There are too few connected roads here to build a mission. Try a more built-up spot, or the sample town.' };
  }
  if (opts.template !== undefined) return generateFromTemplate(map, g, grid, opts, d);
  const type: MissionType = opts.type === 'auto' ? pick(rng, MISSION_TYPES) : opts.type;
  const c = context(map, g, grid, rng, d, type, opts.seed);
  const { base, coldShare, coldIntel, roe } = c;

  if (type === 'clear') {
    const nHordes = hordeCount(d);
    const candidates: V2[] = [];
    for (const a of map.areas) {
      const c = centroid(a.pts);
      if (a.kind !== 'water' && Math.abs(c.x) < map.half * 0.65 && Math.abs(c.z) < map.half * 0.65) candidates.push(c);
    }
    const nodes = shuffle(rng, roadNodesWithin(g, map, 0.6));
    for (const i of nodes.slice(0, 60)) candidates.push(g.nodes[i]);
    const centres: V2[] = [];
    for (const c of candidates) {
      if (centres.length >= nHordes) break;
      const free = grid.nearestFree(c);
      if (grid.isBlocked(free.x, free.z)) continue; // never put a horde inside a building
      if (nearChildPlace(map, free, HORDE_CHILD_GAP)) continue; // guardrail (PLAN §9)
      if (centres.every((o) => dist(o, free) > 130)) centres.push(free);
    }
    if (centres.length < 2) return { ok: false, reason: 'Could not find room for the hordes on this map.' };
    const per = hordeSize(d);
    const hordes: Horde[] = centres.map((c) => ({ centre: c, count: per, cold: Math.round(per * coldShare), label: placeLabel(map, c) }));
    const shelterAt = hordes[Math.floor(rng() * hordes.length)];
    const shelterSpot = shelterSpotFor(grid, map, hordes, shelterAt, rng);
    if (!shelterSpot) return { ok: false, reason: noShelterReason };
    const survivors: SurvivorPlan[] = [0, 1].map((k) => ({ start: { x: shelterSpot.x + k * 2, z: shelterSpot.z }, route: null, delay: 0 }));
    const orbit = centroid(centres);
    const coldPlaces = hordes.filter((h) => h.cold > 0).map((h) => h.label);
    const timeLimit = 240 + 30 * d;
    return {
      ok: true,
      mission: {
        ...base,
        title: `Clear the horde — ${placeLabel(map, orbit)}`,
        briefing: [
          `Spooky, this is Ground. ${hordes.length} hordes are shambling around ${listJoin(unique(hordes.map((h) => h.label)))}.`,
          `Clear every one of them within ${fmtTime(timeLimit)}.`,
          `Two friendlies are sheltering near ${shelterAt.label}. Mind your aim.`,
          roe,
        ],
        intel: [coldPlaces.length ? coldIntel(`with the hordes at ${listJoin(unique(coldPlaces))}`) : coldIntel('')],
        timeLimit,
        orbitCentre: orbit,
        survivors,
        needHome: 0,
        hordes,
      },
    };
  }

  const safehouse = findSafehouse(map, g, rng);
  if (!safehouse) return { ok: false, reason: 'No hospital, police station or other large building near the middle of this map to use as a safehouse.' };
  return type === 'escort' ? buildEscort(c, safehouse) : buildDefend(c, safehouse);
}

/** Everything a mission builder needs: the map, the seeded random stream, and the shared text. */
interface Ctx {
  map: MapData;
  g: RoadGraph;
  grid: WalkGrid;
  rng: Rng;
  d: number;
  base: { type: MissionType; difficulty: number; seed: number; mapName: string; friendlyFireLimit: number; template?: TemplateId; anchor?: Mission['anchor'] };
  coldShare: number;
  coldIntel: (where: string) => string;
  roe: string;
}

function context(map: MapData, g: RoadGraph, grid: WalkGrid, rng: Rng, d: number, type: MissionType, seed: number, extra: Partial<Ctx['base']> = {}): Ctx {
  const base = { type, difficulty: d, seed, mapName: map.name, friendlyFireLimit: 2, ...extra };
  const coldShare = d <= 1 ? 0 : 0.12 + 0.06 * (d - 2);
  // Intel is always true (PLAN §5a, hard rule 9). Cold-blooded zombies sit at ground heat (HEAT.cold
  // in src/game/agentAnim.ts): they vanish on grass (0.19-0.2) and show dark against warmer roads (0.33).
  const coldIntel = (where: string) =>
    coldShare > 0
      ? `Intel: cold-blooded contacts are mixed in ${where}. They match grass on thermal and show as a cold smudge on warm roads (dark in white-hot, light in black-hot). Night vision picks them up.`
      : 'Intel: no cold-blooded contacts in this area.';
  const roe = `Rules of engagement: friendlies carry IR strobes (visible on night vision) and a cold ID panel on the chest (on thermal: dark in white-hot, light in black-hot). ${base.friendlyFireLimit} friendly-fire incidents ends the mission.`;
  return { map, g, grid, rng, d, base, coldShare, coldIntel, roe };
}

type Safehouse = NonNullable<Mission['safehouse']>;

/** Text that changes between the classic escort and the recon templates built on it. */
interface EscortFlavour {
  title(homeStreet: string): string;
  opener(n: number): string;
}
const CLASSIC_ESCORT: EscortFlavour = {
  title: (homeStreet) => `Get them home — ${homeStreet}`,
  opener: (n) => `Spooky, this is Ground. ${n} survivors are holed up at {safehouse}.`,
};

function buildEscort(c: Ctx, safehouse: Safehouse, fl: EscortFlavour = CLASSIC_ESCORT): MissionResult {
  const { map, g, grid, rng, d, base, coldShare, coldIntel, roe } = c;
  const safeNode = nearestNode(g, safehouse.centre, 200);
  if (safeNode < 0) return { ok: false, reason: 'The safehouse is not reachable by road.' };
  // Guardrail (PLAN §9): the walk home never passes within CHILD_BUFFER of a school, kindergarten or
  // playground. Roads that do are closed to the route finder; a home only reachable past one isn't offered.
  const { d: roadDist, prev } = dijkstra(g, safeNode, childSafeCost(map, g));
  const minL = 280 + 40 * d;
  const maxL = 480 + 70 * d;
  const homes = map.buildings
    .map((b) => ({ b, c: centroid(b.pts), area: polygonArea(b.pts) }))
    .filter((h) => h.area > 40 && h.area < 400 && Math.abs(h.c.x) < map.half * 0.9 && Math.abs(h.c.z) < map.half * 0.9)
    // Guardrail (PLAN §9): never a shed or portable classroom in school grounds, nor next to one.
    .filter((h) => safeBuilding(map, h.b));
  const scored: { c: V2; node: number; L: number }[] = [];
  for (const h of homes) {
    const node = nearestNode(g, h.c, 60);
    if (node < 0 || !Number.isFinite(roadDist[node])) continue;
    scored.push({ c: h.c, node, L: roadDist[node] });
    if (scored.length > 4000) break;
  }
  const routeTo = (s: { c: V2; node: number }) => {
    const pathNodes = pathFromPrev(prev, s.node);
    return { pathNodes, route: [grid.nearestFree(g.nodes[pathNodes[0]]), ...pathNodes.slice(1).map((i) => g.nodes[i]), s.c] };
  };
  // The roads are clear; also the first step off the safehouse's corner and the last one up to the door.
  const clearWalk = (s: { c: V2; node: number }) => !routeNearChildPlace(map, routeTo(s).route);
  let pool = scored.filter((s) => s.L >= minL && s.L <= maxL).filter(clearWalk);
  if (!pool.length) pool = scored.filter((s) => s.L >= 150).sort((a, b) => b.L - a.L).filter(clearWalk).slice(0, 10);
  if (!pool.length) {
    // Say why: is it the distance, or is every way home past a school?
    const { d: anyDist } = dijkstra(g, safeNode);
    const farEnough = homes.some((h) => {
      const node = nearestNode(g, h.c, 60);
      return node >= 0 && anyDist[node] >= 150 && Number.isFinite(anyDist[node]);
    });
    return farEnough
      ? { ok: false, reason: `Every way home from ${safehouse.name} passes a school, kindergarten or playground, so there's no escort mission from here. Try another mission.` }
      : { ok: false, reason: 'No homes are far enough away by road for an escort mission.' };
  }
  const home = pick(rng, pool);
  const { pathNodes, route } = routeTo(home);
  const streets = roadNamesAlong(g, map, pathNodes);
  const homeStreet = nearestStreet(map, home.c);
  const n = 4 + Math.floor(d / 2);
  const need = Math.ceil(n / 2);
  const survivors: SurvivorPlan[] = Array.from({ length: n }, (_, k) => ({ start: route[0], route, delay: 6 + k * 1.4 }));
  const length = Math.round(polylineLength(route) / 10) * 10;
  const timeLimit = 420 + 30 * d;
  const every = Math.max(9, 22 - 2.6 * d);
  const waves: WavePlan = { every, size: Math.round((3 + 3 * d) * pressure('escort', d)), coldShare, minDist: 140, maxDist: 300, maxAlive: Math.round((60 + 20 * d) * pressure('escort', d)), kinds: waveSequence(c, every, Math.min(timeLimit, escortMinTime(route, survivors))) };
  const xs = route.map((p) => p.x);
  const zs = route.map((p) => p.z);
  return {
    ok: true,
    mission: {
      ...base,
      title: fl.title(homeStreet),
      briefing: [
        fl.opener(n).replace('{safehouse}', () => safehouse.name),
        `They need to get home to a house on ${homeStreet}, about ${length} m away by road${streets.length > 1 ? `, via ${listJoin(streets.slice(0, 3))}` : ''}.`,
        `Keep the road clear. If fewer than ${need} make it home, the mission fails.`,
        roe,
      ],
      intel: [coldIntel('with the waves'), ...waveIntel(waves)],
      timeLimit,
      orbitCentre: { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 },
      safehouse,
      home: { centre: home.c, street: homeStreet },
      route,
      survivors,
      needHome: need,
      hordes: [],
      waves,
    },
  };
}

/**
 * The soonest an escort can possibly end: everyone walking at their top speed, never stopping.
 * Wave kinds are only planned inside this window, so every kind the intel promises really arrives.
 */
function escortMinTime(route: V2[], survivors: SurvivorPlan[]): number {
  return polylineLength(route) / SURVIVOR_TOP_SPEED + Math.max(0, ...survivors.map((s) => s.delay));
}
/** Survivors' fastest walking pace (m/s), when zombies are close (see Sim.updateSurvivors). */
export const SURVIVOR_TOP_SPEED = 3.2;

/** The seeded order of wave kinds for one mission. Its own random stream, so the rest of the mission is unchanged. */
function waveSequence(c: Ctx, every: number, horizon: number): WaveKind[] {
  const b = c.base;
  const rng = mulberry32(hashString(`waves|${b.mapName}|${b.seed}|${b.template ?? b.type}|${b.anchor?.id ?? ''}|${c.d}`));
  return planWaveKinds(rng, every, horizon, c.coldShare > 0);
}

/**
 * Wave kinds in order, for every wave that arrives within `horizon` seconds (the first at FIRST_WAVE,
 * each later one after `every` x its kind's gap). The opener is standard, a big wave never comes in the
 * first two, the same special kind never comes twice running, and cold waves only where cold-blooded
 * zombies live. A mission with four or more waves always has at least one special.
 */
export function planWaveKinds(rng: Rng, every: number, horizon: number, coldAllowed: boolean): WaveKind[] {
  const kinds: WaveKind[] = ['standard'];
  let t = FIRST_WAVE;
  for (;;) {
    const prev = kinds[kinds.length - 1];
    const options: [WaveKind, number][] = [
      ['standard', 45],
      ['rush', 20],
      ['cold', coldAllowed ? 20 : 0],
      ['big', kinds.length >= 2 ? 15 : 0],
    ];
    const allowed = options.filter(([k, w]) => w > 0 && (k === 'standard' || k !== prev));
    let r = rng() * allowed.reduce((a, [, w]) => a + w, 0);
    let k: WaveKind = 'standard';
    for (const [kind, w] of allowed) {
      r -= w;
      if (r < 0) {
        k = kind;
        break;
      }
    }
    t += every * WAVE_KINDS[k].gap;
    if (t > horizon) break;
    kinds.push(k);
  }
  if (kinds.length >= 4 && !kinds.some((k) => k !== 'standard')) kinds[2] = 'rush';
  return kinds;
}

/** One line of intel about how the waves vary, built from the real plan (intel is always true, PLAN §5a). */
export function waveIntel(w: WavePlan): string[] {
  const n = (k: WaveKind) => (w.kinds ?? []).filter((x) => x === k).length;
  const parts: string[] = [];
  if (n('rush')) parts.push(n('rush') === 1 ? 'a small rush of fast lungers' : 'small rushes of fast lungers');
  if (n('cold')) parts.push(n('cold') === 1 ? 'a mostly cold-blooded wave' : 'mostly cold-blooded waves');
  if (n('big')) parts.push(n('big') === 1 ? 'one big wave after a lull' : 'big waves after a lull');
  if (!parts.length) return [];
  return [`Intel: the waves won't all look alike. Expect a mix: ${listJoin(parts)}.`];
}

interface DefendFlavour {
  title: string;
  opener: string;
}

function buildDefend(c: Ctx, safehouse: Safehouse, fl?: DefendFlavour): MissionResult {
  const { map, g, grid, rng, d, base, coldShare, coldIntel, roe } = c;
  const safeNode = nearestNode(g, safehouse.centre, 200);
  if (safeNode < 0) return { ok: false, reason: 'The safehouse is not reachable by road.' };
  // Guardrail (PLAN §9): stragglers start, and walk in, clear of schools, kindergartens and playgrounds
  // (the same rule as escort routes): roads past one are closed to them.
  const { d: roadDist, prev } = dijkstra(g, safeNode, childSafeCost(map, g));
  const hold = 150 + 15 * d;
  // The waves must be able to reach the building, or the mission can't be lost.
  const perimeter = grid.perimeterCells(safehouse.poly);
  const field = grid.flowField(perimeter);
  const reachableSpawns = roadNodesWithin(g, map, 0.95).filter((i) => {
    const r = dist(g.nodes[i], safehouse.centre);
    return r >= 180 && r <= 340 && grid.fieldAt(field, g.nodes[i].x, g.nodes[i].z) > 0;
  });
  if (!perimeter.length || reachableSpawns.length < 5) {
    return { ok: false, reason: `Zombies can't reach ${safehouse.name} on foot, so it can't be defended. Try another mission type or seed.` };
  }
  const stragglerRoute = (s: number) => [...pathFromPrev(prev, s).reverse().map((i) => g.nodes[i]), safehouse.centre];
  const stragglerStarts = roadNodesWithin(g, map, 0.9).filter((i) => roadDist[i] > 110 && roadDist[i] < 220 && !routeNearChildPlace(map, stragglerRoute(i)));
  const survivors: SurvivorPlan[] = [];
  if (stragglerStarts.length) {
    const route = stragglerRoute(pick(rng, stragglerStarts));
    survivors.push({ start: route[0], route, delay: 4 }, { start: route[0], route, delay: 5.5 });
  }
  const from = survivors.length ? nearestStreet(map, survivors[0].start) : '';
  const every = Math.max(7, 20 - 2.6 * d);
  const waves: WavePlan = { every, size: DEFEND_WAVE_SIZE[d - 1], coldShare, minDist: 180, maxDist: 340, maxAlive: 80 + 25 * d + 3 * (DEFEND_WAVE_SIZE[d - 1] - (6 + 4 * d)), kinds: waveSequence(c, every, hold) };
  return {
    ok: true,
    mission: {
      ...base,
      title: fl?.title ?? `Hold the safehouse — ${safehouse.name}`,
      briefing: [
        fl?.opener ?? `Spooky, this is Ground. ${capitalise(safehouse.name)} is the neighbourhood's safehouse, and the dead know it.`,
        `Hold it for ${fmtTime(hold)}. If they break in, it's over.`,
        survivors.length ? `Two stragglers are on their way in along ${from}. Don't hit them.` : 'Everyone is already inside.',
        roe,
      ],
      intel: [coldIntel('with the waves'), ...waveIntel(waves)],
      timeLimit: hold,
      orbitCentre: safehouse.centre,
      safehouse,
      survivors,
      needHome: 0,
      hordes: [],
      waves,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Recon templates: the same three mechanics, built around a real place (src/map/recon.ts)
// ---------------------------------------------------------------------------------------

/** The building that stands for a place: the one it's in, one with its name, or the biggest on its grounds. */
function safehouseFromFeature(map: MapData, f: Feature, name: string): Safehouse {
  // Guardrail (PLAN §9): never a school building, nor one beside a school, kindergarten or playground.
  const solid = (b: { pts: V2[]; kind?: string }) => polygonArea(b.pts) >= 60 && safeBuilding(map, b);
  let b = map.buildings.find((x) => solid(x) && pointInPolygon(f.p, x.pts));
  if (!b && f.name) b = map.buildings.find((x) => solid(x) && x.name === f.name && dist(centroid(x.pts), f.p) < 300);
  if (!b && f.pts && f.pts.length >= 3) {
    const pts = f.pts;
    b = map.buildings.filter((x) => solid(x) && pointInPolygon(centroid(x.pts), pts)).sort((a, c) => polygonArea(c.pts) - polygonArea(a.pts))[0];
  }
  if (!b) b = map.buildings.filter((x) => solid(x) && dist(centroid(x.pts), f.p) < 50).sort((a, c) => dist(centroid(a.pts), f.p) - dist(centroid(c.pts), f.p))[0];
  const poly = b ? b.pts : circle(f.p, 14);
  return { centre: centroid(poly), poly, name };
}

/** Evenly spread points inside a polygon (spacing in metres), in a seeded order. */
function pointsInside(pts: V2[], spacing: number, rng: Rng): V2[] {
  const bb = bounds(pts);
  const out: V2[] = [];
  for (let z = bb.minZ + spacing / 2; z < bb.maxZ; z += spacing) {
    for (let x = bb.minX + spacing / 2; x < bb.maxX; x += spacing) if (pointInPolygon({ x, z }, pts)) out.push({ x, z });
  }
  return shuffle(rng, out);
}

function generateFromTemplate(map: MapData, g: RoadGraph, grid: WalkGrid, opts: MissionOptions, d: number): MissionResult {
  const t = MISSION_TEMPLATES[opts.template!];
  if (!t) return { ok: false, reason: `Unknown mission template "${String(opts.template)}".` };
  if (opts.type !== 'auto' && opts.type !== t.base) return { ok: false, reason: `"${t.name}" is a ${t.base} mission, not ${opts.type}.` };
  // Classic templates are exactly the missions the custom menu builds.
  if (!t.anchors.length) return generateMission(map, g, grid, { type: t.base, difficulty: d, seed: opts.seed });
  const f = findAnchor(map, t.id, opts.seed, opts.anchor);
  if (!f) {
    const what = t.anchors.map((a) => CATEGORY_INFO[a].one).join(' or ');
    return { ok: false, reason: `Recon found no ${what} here for "${t.name}". Pick another mission.` };
  }
  const name = featureName(map, f);
  const rng = mulberry32(hashString(`${map.name}|${opts.seed}|${t.id}|${f.id}|${d}`));
  const anchor: Mission['anchor'] = { id: f.id, name, category: f.category, p: f.p, ...(f.pts ? { pts: f.pts } : {}) };
  const c = context(map, g, grid, rng, d, t.base, opts.seed, { template: t.id, anchor });
  const Name = capitalise(name);
  switch (t.id) {
    case 'clear-tennis':
    case 'clear-park':
    case 'forest-sweep':
      return templateClear(c, f, name, t.id);
    case 'hold-sports':
      return buildDefend(c, safehouseFromFeature(map, f, name), {
        title: `Hold the sports centre — ${name}`,
        opener: `Spooky, this is Ground. Half the street ran to ${name}, and the dead followed them there.`,
      });
    case 'hold-landmark':
      return buildDefend(c, safehouseFromFeature(map, f, name), {
        title: `Hold ${name}`,
        opener: `Spooky, this is Ground. ${Name} is the most solid building for blocks. The neighbours are inside, and the dead know it.`,
      });
    case 'escort-shops':
      return buildEscort(c, safehouseFromFeature(map, f, name), {
        title: () => `Get them home from ${name}`,
        opener: (n) => `Spooky, this is Ground. ${n} late-night shoppers are barricaded inside {safehouse}.`,
      });
    case 'escort-station': {
      const what = f.category === 'bus_station' ? 'bus' : 'train';
      return buildEscort(c, safehouseFromFeature(map, f, name), {
        title: () => `Last ${what} home — ${name}`,
        opener: (n) => `Spooky, this is Ground. ${n} passengers off the last ${what} are stuck at {safehouse}.`,
      });
    }
    default:
      return { ok: false, reason: `Unknown mission template "${t.id}".` };
  }
}

/** Clear missions around a place: hordes on the tennis courts, in the park, or among the trees. */
function templateClear(c: Ctx, f: Feature, name: string, id: 'clear-tennis' | 'clear-park' | 'forest-sweep'): MissionResult {
  const { map, g, grid, rng, d, base, coldShare, coldIntel, roe } = c;
  const nHordes = hordeCount(d);
  const forest = id === 'forest-sweep';
  // Forests hide more cold-blooded zombies: they match the cool ground under the trees.
  const coldHere = forest ? Math.min(0.6, coldShare + 0.25) : coldShare;
  const isHere = (p: V2) => (f.pts && f.pts.length >= 3 ? pointInPolygon(p, f.pts) || dist(p, f.p) < 30 : dist(p, f.p) < 60);
  const area = f.pts && f.pts.length >= 3 ? polygonArea(f.pts) : 0;
  const maxHere = Math.max(1, Math.min(nHordes - (forest ? 0 : 1), Math.floor(area / (forest ? 2200 : 1800))));
  const gapHere = id === 'clear-tennis' ? 32 : 45;
  const centres: V2[] = [];
  const add = (p: V2, gap: number) => {
    const free = grid.nearestFree(p, 40);
    if (grid.isBlocked(free.x, free.z)) return false; // never put a horde inside a building
    if (nearChildPlace(map, free, HORDE_CHILD_GAP)) return false; // guardrail (PLAN §9)
    if (!centres.every((o) => dist(o, free) > gap)) return false;
    centres.push(free);
    return true;
  };
  // First the place itself...
  const inside = f.pts && f.pts.length >= 3 ? pointsInside(f.pts, 12, rng) : [];
  add(f.p, 0);
  for (const p of inside) {
    if (centres.length >= maxHere) break;
    if (isHere(p)) add(p, gapHere);
  }
  // ...then the streets and open ground around it, nearest first.
  const around: V2[] = [];
  for (const a of map.areas) if (a.kind !== 'water' && a.pts.length >= 3) around.push(centroid(a.pts));
  for (const i of roadNodesWithin(g, map, 0.85)) around.push(g.nodes[i]);
  around.sort((a, b) => dist(a, f.p) - dist(b, f.p) || a.x - b.x || a.z - b.z);
  for (const p of around) {
    if (centres.length >= nHordes) break;
    if (dist(p, f.p) > 420) break;
    if (dist(p, f.p) < 70) continue;
    add(p, 110);
  }
  if (centres.length < 2) return { ok: false, reason: `Could not find room for the hordes around ${name}.` };
  const per = hordeSize(d);
  const hordes: Horde[] = centres.map((p) => {
    const here = isHere(p);
    return { centre: p, count: per, cold: Math.round(per * (here ? coldHere : coldShare)), label: here ? name : placeLabel(map, p) };
  });
  const shelterAt = hordes[Math.floor(rng() * hordes.length)];
  const shelterSpot = shelterSpotFor(grid, map, hordes, shelterAt, rng);
  if (!shelterSpot) return { ok: false, reason: noShelterReason };
  const survivors: SurvivorPlan[] = [0, 1].map((k) => ({ start: { x: shelterSpot.x + k * 2, z: shelterSpot.z }, route: null, delay: 0 }));
  const timeLimit = 240 + 30 * d + (forest ? 30 : 0);
  const hereCount = hordes.filter((h) => h.label === name).length;
  const elsewhere = unique(hordes.filter((h) => h.label !== name).map((h) => h.label));
  let opener: string;
  let title: string;
  if (forest) {
    title = `Forest sweep — ${name}`;
    opener = `Spooky, this is Ground. ${hereCount === 1 ? 'A horde is' : `${hereCount} hordes are`} moving among the trees in ${name}${elsewhere.length ? `, with more around ${listJoin(elsewhere.slice(0, 3))}` : ''}.`;
  } else if (id === 'clear-tennis') {
    title = `Clear the tennis club — ${name}`;
    opener = `Spooky, this is Ground. The dead have taken over ${name}: ${hereCount === 1 ? 'a horde is' : `${hereCount} hordes are`} on the courts${elsewhere.length ? `, and more are around ${listJoin(elsewhere.slice(0, 3))}` : ''}.`;
  } else {
    title = `Clear the park — ${name}`;
    opener = `Spooky, this is Ground. ${hereCount === 1 ? 'A horde has' : `${hereCount} hordes have`} gathered in ${name}${elsewhere.length ? `, and more are around ${listJoin(elsewhere.slice(0, 3))}` : ''}.`;
  }
  // Intel is always true (PLAN §5a): say exactly where the cold-blooded ones are.
  const coldTotal = hordes.reduce((s, h) => s + h.cold, 0);
  let intel: string;
  if (!coldTotal) intel = coldIntel('');
  else if (forest) {
    const inF = hordes.filter((h) => h.label === name);
    const fc = inF.reduce((s, h) => s + h.cold, 0);
    const ft = inF.reduce((s, h) => s + h.count, 0);
    const out = unique(hordes.filter((h) => h.label !== name && h.cold > 0).map((h) => h.label));
    intel =
      `Intel: ${fc} of the ${ft} contacts in ${name} are cold-blooded, far more than usual. Under the trees they match the ground on thermal. ` +
      `Night vision picks them up, though it's murky in there.${out.length ? ` A few more are mixed in with the hordes at ${listJoin(out)}.` : ''}`;
  } else {
    intel = coldIntel(`with the hordes at ${listJoin(unique(hordes.filter((h) => h.cold > 0).map((h) => h.label)))}`);
  }
  return {
    ok: true,
    mission: {
      ...base,
      title,
      briefing: [opener, `Clear every one of them within ${fmtTime(timeLimit)}.`, `Two friendlies are sheltering near ${shelterAt.label}. Mind your aim.`, roe],
      intel: [intel],
      timeLimit,
      orbitCentre: centroid(centres),
      survivors,
      needHome: 0,
      hordes,
    },
  };
}

/** Where waves are most likely to come from, for the tactical map (defend missions only). */
export interface WaveDirection {
  from: V2;
  to: V2;
  compass: string;
  /** Share of possible spawn points in this direction (0..1). */
  share: number;
}

export function likelyWaveDirections(m: Mission, map: MapData, g: RoadGraph): WaveDirection[] {
  if (!m.waves || m.type !== 'defend' || !m.safehouse) return [];
  const ref = m.safehouse.centre;
  const lim = map.half * 0.95;
  const sums = Array.from({ length: 8 }, () => ({ n: 0, x: 0, z: 0 }));
  let total = 0;
  for (let i = 0; i < g.nodes.length; i++) {
    if (g.comp[i] !== g.mainComp) continue;
    const p = g.nodes[i];
    if (Math.abs(p.x) > lim || Math.abs(p.z) > lim) continue;
    const r = dist(p, ref);
    if (r < m.waves.minDist || r > m.waves.maxDist) continue;
    const a = (Math.atan2(p.x - ref.x, -(p.z - ref.z)) * 180) / Math.PI;
    const s = sums[Math.round(((a + 360) % 360) / 45) % 8];
    s.n++;
    s.x += p.x;
    s.z += p.z;
    total++;
  }
  if (!total) return [];
  return sums
    .map((s, k) => ({ s, k }))
    .filter(({ s }) => s.n / total >= 0.12)
    .sort((a, b) => b.s.n - a.s.n || a.k - b.k)
    .slice(0, 3)
    .map(({ s }) => {
      const from = { x: s.x / s.n, z: s.z / s.n };
      return { from, to: ref, compass: compass(ref, from), share: s.n / total };
    });
}

/** Sheltering friendlies sit at least this far from every horde's gathering point (hordes mill within ~30 m). */
export const SHELTER_GAP = 70;

/** The two sheltering friendlies stand up to this far from their spot (Sim spreads them out a little). */
const SHELTER_SPREAD = 4;

/**
 * Where the two sheltering friendlies wait in a Clear mission: near their named horde (that's the story),
 * but at least SHELTER_GAP from every horde, so a player who hasn't found them yet can't lose in seconds.
 * Guardrail (PLAN §9): the nearest horde drifts toward them (Sim), so their spot, and the drifting horde's
 * whole way there, keep the same HORDE_CHILD_GAP from schools, kindergartens and playgrounds as a horde does.
 * Null when there is no such spot.
 */
function shelterSpotFor(grid: WalkGrid, map: MapData, hordes: Horde[], near: Horde, rng: Rng): V2 | null {
  const a0 = rng() * Math.PI * 2;
  const childSafe = (p: V2) => {
    if (grid.isBlocked(p.x, p.z) || Math.abs(p.x) >= map.half * 0.9 || Math.abs(p.z) >= map.half * 0.9) return false;
    if (nearChildPlace(map, p, HORDE_CHILD_GAP + SHELTER_SPREAD)) return false;
    // The horde that will drift here: the nearest one (first on a tie), as Sim picks it.
    const drifter = hordes.reduce((a, h) => (dist(h.centre, p) < dist(a.centre, p) ? h : a), hordes[0]);
    return !segmentNearChildPlace(map, drifter.centre, p, HORDE_CHILD_GAP);
  };
  const ok = (p: V2) => hordes.every((h) => dist(h.centre, p) >= SHELTER_GAP) && childSafe(p);
  const ring = (r: number, k: number) => {
    const a = a0 + (k / 16) * Math.PI * 2;
    return grid.nearestFree({ x: near.centre.x + Math.cos(a) * r, z: near.centre.z + Math.sin(a) * r }, 9);
  };
  for (let r = SHELTER_GAP + 5; r <= 200; r += 15) {
    for (let k = 0; k < 16; k++) {
      const p = ring(r, k);
      if (ok(p)) return p;
    }
  }
  // Fallback: a spot 120 m out, or failing that any child-safe spot on the search rings.
  const far = grid.nearestFree({ x: near.centre.x + Math.cos(a0) * 120, z: near.centre.z + Math.sin(a0) * 120 });
  if (childSafe(far)) return far;
  for (let r = SHELTER_GAP + 5; r <= 200; r += 15) {
    for (let k = 0; k < 16; k++) {
      const p = ring(r, k);
      if (childSafe(p)) return p;
    }
  }
  return null;
}

const noShelterReason = 'Could not find a safe spot for the sheltering friendlies on this map. Try another mission.';
const unique = <T>(a: T[]) => [...new Set(a)];
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function listJoin(a: string[]): string {
  if (a.length <= 1) return a[0] ?? '';
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
export { fmtTime };
