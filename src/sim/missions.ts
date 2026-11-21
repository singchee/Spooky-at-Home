import type { Feature, FeatureCategory, MapData, V2 } from '../map/types';
import { bounds, centroid, dist, pointInPolygon, polygonArea, polylineLength, distToSegment } from '../map/geom';
import { dijkstra, nearestNode, pathFromPrev, roadNamesAlong, type RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { CATEGORY_INFO, CHILD_KINDS, MISSION_TEMPLATES, featureName, findAnchor, nearChildPlace, type TemplateId } from '../map/recon';
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

/** Guardrail (PLAN §9): no horde is placed within this many metres of a school, kindergarten or playground. */
const HORDE_CHILD_GAP = 60;

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
      if (nearChildPlace(map, free, HORDE_CHILD_GAP)) continue; // guardrail (PLAN §9)
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
      ? `Intel: cold-blooded contacts are mixed in ${where}. They match grass on thermal and show as a dark smudge on roads. Night vision picks them up.`
      : 'Intel: no cold-blooded contacts in this area.';
  const roe = `Rules of engagement: friendlies carry IR strobes (visible on night vision) and a cold ID panel (a dark square on thermal). ${base.friendlyFireLimit} friendly-fire incidents ends the mission.`;
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
  const { d: roadDist, prev } = dijkstra(g, safeNode);
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
      title: fl.title(homeStreet),
      briefing: [
        fl.opener(n).replace('{safehouse}', () => safehouse.name),
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
      waves: { every: Math.max(9, 22 - 2.6 * d), size: 3 + 3 * d, coldShare, minDist: 140, maxDist: 300, maxAlive: 60 + 20 * d },
    },
  };
}

interface DefendFlavour {
  title: string;
  opener: string;
}

function buildDefend(c: Ctx, safehouse: Safehouse, fl?: DefendFlavour): MissionResult {
  const { map, g, grid, rng, d, base, coldShare, coldIntel, roe } = c;
  const safeNode = nearestNode(g, safehouse.centre, 200);
  if (safeNode < 0) return { ok: false, reason: 'The safehouse is not reachable by road.' };
  const { d: roadDist, prev } = dijkstra(g, safeNode);
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
      title: fl?.title ?? `Hold the safehouse — ${safehouse.name}`,
      briefing: [
        fl?.opener ?? `Spooky, this is Ground. ${capitalise(safehouse.name)} is the neighbourhood's safehouse, and the dead know it.`,
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
  const nHordes = Math.min(6, 2 + Math.floor(d * 0.8));
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
  const per = 6 + 3 * d;
  const hordes: Horde[] = centres.map((p) => {
    const here = isHere(p);
    return { centre: p, count: per, cold: Math.round(per * (here ? coldHere : coldShare)), label: here ? name : placeLabel(map, p) };
  });
  const shelterAt = hordes[Math.floor(rng() * hordes.length)];
  const ang = rng() * Math.PI * 2;
  const shelterSpot = grid.nearestFree({ x: shelterAt.centre.x + Math.cos(ang) * 45, z: shelterAt.centre.z + Math.sin(ang) * 45 });
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

const unique = <T>(a: T[]) => [...new Set(a)];
const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function listJoin(a: string[]): string {
  if (a.length <= 1) return a[0] ?? '';
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
export { fmtTime };
