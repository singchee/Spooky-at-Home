import type { MapData, V2 } from '../map/types';
import { centroid, dist, pointInPolygon, polygonArea, polylineLength, distToSegment } from '../map/geom';
import { dijkstra, nearestNode, pathFromPrev, roadNamesAlong, type RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
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

export interface WavePlan {
  every: number;
  size: number;
  coldShare: number;
  minDist: number;
  maxDist: number;
  maxAlive: number;
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
}

export interface MissionOptions {
  type: MissionType | 'auto';
  difficulty: number;
  seed: number;
}

export type MissionResult = { ok: true; mission: Mission } | { ok: false; reason: string };

const SAFE_KINDS = ['school', 'hospital', 'community_centre', 'police', 'fire_station', 'library', 'place_of_worship', 'clinic'];
const KIND_LABEL: Record<string, string> = {
  school: 'the school', hospital: 'the hospital', community_centre: 'the community centre', police: 'the police station',
  fire_station: 'the fire station', library: 'the library', place_of_worship: 'the church', clinic: 'the clinic',
};

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

function findSafehouse(map: MapData, g: RoadGraph, rng: Rng): Mission['safehouse'] | null {
  const lim = map.half * 0.65;
  const pois = map.pois.filter((p) => SAFE_KINDS.includes(p.kind) && Math.abs(p.p.x) < lim && Math.abs(p.p.z) < lim);
  shuffle(rng, pois);
  for (const poi of pois) {
    if (nearestNode(g, poi.p, 150) < 0) continue;
    const b =
      map.buildings.find((x) => pointInPolygon(poi.p, x.pts)) ??
      map.buildings.filter((x) => dist(centroid(x.pts), poi.p) < 60).sort((a, c) => dist(centroid(a.pts), poi.p) - dist(centroid(c.pts), poi.p))[0];
    const poly = b ? b.pts : circle(poi.p, 12);
    return { centre: centroid(poly), poly, name: poi.name ?? KIND_LABEL[poi.kind] ?? 'the safehouse' };
  }
  // Fallback: one of the biggest buildings near the middle.
  const big = map.buildings
    .filter((b) => Math.hypot(centroid(b.pts).x, centroid(b.pts).z) < map.half * 0.5)
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
  const type: MissionType = opts.type === 'auto' ? pick(rng, MISSION_TYPES) : opts.type;
  const base = { type, difficulty: d, seed: opts.seed, mapName: map.name, friendlyFireLimit: 2 };
  const coldShare = d <= 1 ? 0 : 0.12 + 0.06 * (d - 2);
  const coldIntel = (where: string) =>
    coldShare > 0
      ? `Intel: cold-blooded contacts are mixed in ${where}. They barely show on thermal, and are faint on cool grass and gardens. Night vision picks them up.`
      : 'Intel: no cold-blooded contacts in this area.';
  const roe = `Rules of engagement: friendlies carry IR strobes (visible on night vision) and a cold ID panel (a dark square on thermal). ${base.friendlyFireLimit} friendly-fire incidents ends the mission.`;

  if (type === 'clear') {
    const nHordes = Math.min(6, 2 + Math.floor(d * 0.8));
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
      if (centres.every((o) => dist(o, free) > 130)) centres.push(free);
    }
    if (centres.length < 2) return { ok: false, reason: 'Could not find room for the hordes on this map.' };
    const per = 6 + 3 * d;
    const hordes: Horde[] = centres.map((c) => ({ centre: c, count: per, cold: Math.round(per * coldShare), label: placeLabel(map, c) }));
    const shelterAt = hordes[Math.floor(rng() * hordes.length)];
    const ang = rng() * Math.PI * 2;
    const shelterSpot = grid.nearestFree({ x: shelterAt.centre.x + Math.cos(ang) * 45, z: shelterAt.centre.z + Math.sin(ang) * 45 });
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
  if (!safehouse) return { ok: false, reason: 'No school, hospital or large building near the middle of this map to use as a safehouse.' };
  const safeNode = nearestNode(g, safehouse.centre, 200);
  if (safeNode < 0) return { ok: false, reason: 'The safehouse is not reachable by road.' };
  const { d: roadDist, prev } = dijkstra(g, safeNode);

  if (type === 'escort') {
    const minL = 280 + 40 * d;
    const maxL = 480 + 70 * d;
    const homes = map.buildings
      .map((b) => ({ b, c: centroid(b.pts), area: polygonArea(b.pts) }))
      .filter((h) => h.area > 40 && h.area < 400 && Math.abs(h.c.x) < map.half * 0.9 && Math.abs(h.c.z) < map.half * 0.9);
    const scored: { c: V2; node: number; L: number }[] = [];
    for (const h of homes) {
      const node = nearestNode(g, h.c, 60);
      if (node < 0 || !Number.isFinite(roadDist[node])) continue;
      scored.push({ c: h.c, node, L: roadDist[node] });
      if (scored.length > 4000) break;
    }
    let pool = scored.filter((s) => s.L >= minL && s.L <= maxL);
    if (!pool.length) pool = scored.filter((s) => s.L >= 150).sort((a, b) => b.L - a.L).slice(0, 10);
    if (!pool.length) return { ok: false, reason: 'No homes are far enough away by road for an escort mission.' };
    const home = pick(rng, pool);
    const pathNodes = pathFromPrev(prev, home.node);
    const route = [grid.nearestFree(g.nodes[pathNodes[0]]), ...pathNodes.slice(1).map((i) => g.nodes[i]), home.c];
    const streets = roadNamesAlong(g, map, pathNodes);
    const homeStreet = nearestStreet(map, home.c);
    const n = 4 + Math.floor(d / 2);
    const need = Math.ceil(n / 2);
    const survivors: SurvivorPlan[] = Array.from({ length: n }, (_, k) => ({ start: route[0], route, delay: 6 + k * 1.4 }));
    const length = Math.round(polylineLength(route) / 10) * 10;
    const xs = route.map((p) => p.x);
    const zs = route.map((p) => p.z);
    return {
      ok: true,
      mission: {
        ...base,
        title: `Get them home — ${homeStreet}`,
        briefing: [
          `Spooky, this is Ground. ${n} survivors are holed up at ${safehouse.name}.`,
          `They need to get home to a house on ${homeStreet}, about ${length} m away by road${streets.length > 1 ? `, via ${listJoin(streets.slice(0, 3))}` : ''}.`,
          `Keep the road clear. If fewer than ${need} make it home, the mission fails.`,
          roe,
        ],
        intel: [coldIntel('with the waves')],
        timeLimit: 420 + 30 * d,
        orbitCentre: { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 },
        safehouse,
        home: { centre: home.c, street: homeStreet },
        route,
        survivors,
        needHome: need,
        hordes: [],
        waves: { every: Math.max(12, 27 - 2.8 * d), size: 2 + 2 * d, coldShare, minDist: 140, maxDist: 300, maxAlive: 60 + 20 * d },
      },
    };
  }

  // defend
  const hold = 150 + 15 * d;
  // The waves must be able to reach the building, or the mission can't be lost.
  const perimeter = grid.perimeterCells(safehouse.poly);
  const field = grid.flowField(perimeter);
  const reachableSpawns = roadNodesWithin(g, map, 0.95).filter((i) => grid.fieldAt(field, g.nodes[i].x, g.nodes[i].z) > 0);
  if (!perimeter.length || reachableSpawns.length < 5) {
    return { ok: false, reason: `Zombies can't reach ${safehouse.name} on foot, so it can't be defended. Try another mission type or seed.` };
  }
  const stragglerStarts = roadNodesWithin(g, map, 0.9).filter((i) => roadDist[i] > 110 && roadDist[i] < 220);
  const survivors: SurvivorPlan[] = [];
  if (stragglerStarts.length) {
    const s = pick(rng, stragglerStarts);
    const path = pathFromPrev(prev, s).reverse();
    const route = [...path.map((i) => g.nodes[i]), safehouse.centre];
    survivors.push({ start: route[0], route, delay: 4 }, { start: route[0], route, delay: 5.5 });
  }
  const from = survivors.length ? nearestStreet(map, survivors[0].start) : '';
  return {
    ok: true,
    mission: {
      ...base,
      title: `Hold the safehouse — ${safehouse.name}`,
      briefing: [
        `Spooky, this is Ground. ${capitalise(safehouse.name)} is the neighbourhood's safehouse, and the dead know it.`,
        `Hold it for ${fmtTime(hold)}. If they break in, it's over.`,
        survivors.length ? `Two stragglers are on their way in along ${from}. Don't hit them.` : 'Everyone is already inside.',
        roe,
      ],
      intel: [coldIntel('with the waves')],
      timeLimit: hold,
      orbitCentre: safehouse.centre,
      safehouse,
      survivors,
      needHome: 0,
      hordes: [],
      waves: { every: Math.max(7, 20 - 2.6 * d), size: 6 + 4 * d, coldShare, minDist: 180, maxDist: 340, maxAlive: 80 + 25 * d },
    },
  };
}

const unique = <T>(a: T[]) => [...new Set(a)];
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function listJoin(a: string[]): string {
  if (a.length <= 1) return a[0] ?? '';
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
export { fmtTime };
