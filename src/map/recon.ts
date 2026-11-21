import type { Feature, FeatureCategory, MapData, V2 } from './types';
import { FEATURE_CATEGORIES } from './types';
import { centroid, dist, distToSegment, pointInPolygon, polygonArea } from './geom';
import { hashString } from '../util/rng';

/**
 * Recon: what's in the area, and which missions suit it. Pure and deterministic
 * (same map + seed → same report and suggestions), no DOM, no three.js.
 *
 * Guardrail (PLAN §9, issue #11): until the owner decides the rules for school missions, no
 * mission is anchored at, built around, or sheltered in a school, kindergarten or playground.
 * Recon still lists them, and they mark an exclusion zone (see `childZones`).
 */
export interface CategoryInfo {
  /** Singular and plural for the recon list ("1 tennis club", "3 tennis clubs"). */
  one: string;
  many: string;
  /** Short code for the tactical-map symbol, military style. */
  code: string;
  /** How interesting it is to a gunship crew; orders the "notable places" list. */
  weight: number;
}

export const CATEGORY_INFO: Record<FeatureCategory, CategoryInfo> = {
  school: { one: 'school', many: 'schools', code: 'SCH', weight: 6 },
  kindergarten: { one: 'kindergarten', many: 'kindergartens', code: 'KG', weight: 1 },
  sports_centre: { one: 'sports centre', many: 'sports centres', code: 'SPT', weight: 9 },
  stadium: { one: 'stadium', many: 'stadiums', code: 'STD', weight: 9 },
  pitch: { one: 'sports ground', many: 'sports grounds', code: 'PCH', weight: 4 },
  tennis: { one: 'tennis club', many: 'tennis clubs', code: 'TEN', weight: 8 },
  swimming_pool: { one: 'swimming pool', many: 'swimming pools', code: 'SWM', weight: 4 },
  playground: { one: 'playground', many: 'playgrounds', code: 'PG', weight: 1 },
  park: { one: 'park', many: 'parks', code: 'PRK', weight: 5 },
  forest: { one: 'forest', many: 'forests', code: 'FOR', weight: 8 },
  supermarket: { one: 'supermarket', many: 'supermarkets', code: 'SUP', weight: 6 },
  mall: { one: 'shopping centre', many: 'shopping centres', code: 'MAL', weight: 8 },
  parking: { one: 'car park', many: 'car parks', code: 'P', weight: 2 },
  hospital: { one: 'hospital', many: 'hospitals', code: 'HOS', weight: 7 },
  police: { one: 'police station', many: 'police stations', code: 'POL', weight: 6 },
  fire_station: { one: 'fire station', many: 'fire stations', code: 'FIR', weight: 6 },
  train_station: { one: 'train station', many: 'train stations', code: 'RLY', weight: 7 },
  bus_station: { one: 'bus station', many: 'bus stations', code: 'BUS', weight: 5 },
};

const POI_CATEGORY: Record<string, FeatureCategory> = { school: 'school', hospital: 'hospital', police: 'police', fire_station: 'fire_station' };

/**
 * The map's recon features. Maps saved before phase 2 have none, so fall back to what
 * they do have: landmarks (pois) and named parks and woods.
 */
export function mapFeatures(map: MapData): Feature[] {
  if (map.features) return map.features;
  const out: Feature[] = [];
  for (const p of map.pois) {
    const category = POI_CATEGORY[p.kind];
    if (category) out.push({ id: p.id, category, name: p.name, p: p.p });
  }
  for (const a of map.areas) {
    if (a.kind === 'water' || a.pts.length < 3) continue;
    out.push({ id: a.id, category: a.kind === 'wood' ? 'forest' : 'park', name: a.name, p: centroid(a.pts), pts: a.pts });
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Guardrail: places where children are. Missions keep well away from them (PLAN §9).
// ---------------------------------------------------------------------------------------

/** Recon categories no mission may be anchored at, built around or sheltered in. */
export const CHILD_CATEGORIES: readonly FeatureCategory[] = ['school', 'kindergarten', 'playground'];
/** Landmark (poi) and building kinds that are never a safehouse. */
export const CHILD_KINDS: readonly string[] = ['school', 'kindergarten', 'college'];
/** Metres to keep between a mission's places and a school, kindergarten or playground. */
export const CHILD_BUFFER = 50;

/** A school, kindergarten or playground: its point, and its outline when the map has one. */
export interface ChildZone {
  p: V2;
  pts?: V2[];
}

const zoneCache = new WeakMap<MapData, ChildZone[]>();

/** Every school, kindergarten and playground on the map: recon places, landmarks and buildings. */
export function childZones(map: MapData): ChildZone[] {
  const cached = zoneCache.get(map);
  if (cached) return cached;
  const zones: ChildZone[] = [];
  for (const f of mapFeatures(map)) {
    if (CHILD_CATEGORIES.includes(f.category)) zones.push(f.pts && f.pts.length >= 3 ? { p: f.p, pts: f.pts } : { p: f.p });
  }
  for (const p of map.pois) if (CHILD_KINDS.includes(p.kind) || p.kind === 'playground') zones.push({ p: p.p });
  for (const b of map.buildings) if (b.pts.length >= 3 && CHILD_KINDS.includes(b.kind)) zones.push({ p: centroid(b.pts), pts: b.pts });
  zoneCache.set(map, zones);
  return zones;
}

/** Distance from a point to a zone: 0 inside its outline, else to its edge (or its point). */
function zoneDist(p: V2, z: ChildZone): number {
  if (!z.pts) return dist(p, z.p);
  if (pointInPolygon(p, z.pts)) return 0;
  let d = Infinity;
  for (let i = 0, j = z.pts.length - 1; i < z.pts.length; j = i++) d = Math.min(d, distToSegment(p, z.pts[j], z.pts[i]));
  return d;
}

/** True when a point is inside, or within `buffer` metres of, a school, kindergarten or playground. */
export function nearChildPlace(map: MapData, p: V2, buffer = CHILD_BUFFER): boolean {
  return childZones(map).some((z) => zoneDist(p, z) < buffer);
}

/** True when an outline contains a school, kindergarten or playground (a park with a playground in it). */
export function containsChildPlace(map: MapData, pts: V2[] | undefined): boolean {
  if (!pts || pts.length < 3) return false;
  return childZones(map).some((z) => pointInPolygon(z.p, pts) || (z.pts ?? []).some((q) => pointInPolygon(q, pts)));
}

const plural = (n: number, c: FeatureCategory) => `${n} ${n === 1 ? CATEGORY_INFO[c].one : CATEGORY_INFO[c].many}`;

/** Nearest named street to a point (or null). Used to describe unnamed places. */
export function nearestStreetName(map: MapData, p: V2, maxDist = 120): string | null {
  let best: string | null = null;
  let bd = maxDist;
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
  return best;
}

/** A name for a feature that's always printable: its own name, or "the tennis club on X Street". */
export function featureName(map: MapData, f: Feature): string {
  if (f.name) return f.name;
  const street = nearestStreetName(map, f.p);
  return `the ${CATEGORY_INFO[f.category].one}${street ? ` on ${street}` : ''}`;
}

export interface ReconCategory {
  category: FeatureCategory;
  count: number;
  /** "3 schools" */
  text: string;
  /** Up to five real names, for the recon list. */
  names: string[];
}

export interface ReconReport {
  mapName: string;
  /** True when recon found no places at all (missions fall back to streets and big buildings). */
  empty: boolean;
  /** One line for the top of the recon screen. Always set, including for an empty map. */
  message: string;
  categories: ReconCategory[];
  /** The most interesting named places, best first. */
  notable: Feature[];
  busRoutes: { ref?: string; name?: string }[];
  trees: number;
  lamps: number;
  buildings: number;
  roads: number;
}

export function reconMap(map: MapData): ReconReport {
  const features = mapFeatures(map);
  const categories: ReconCategory[] = [];
  for (const c of FEATURE_CATEGORIES) {
    const fs = features.filter((f) => f.category === c);
    if (!fs.length) continue;
    const names = [...new Set(fs.map((f) => f.name).filter((n): n is string => !!n))].slice(0, 5);
    categories.push({ category: c, count: fs.length, text: plural(fs.length, c), names });
  }
  const notable = features
    .filter((f) => f.name && CATEGORY_INFO[f.category].weight >= 4)
    .sort((a, b) => CATEGORY_INFO[b.category].weight - CATEGORY_INFO[a.category].weight || dist(a.p, { x: 0, z: 0 }) - dist(b.p, { x: 0, z: 0 }) || (a.id < b.id ? -1 : 1))
    .slice(0, 8);
  const busRoutes = (map.busRoutes ?? []).map((r) => ({ ref: r.ref, name: r.name }));
  const empty = categories.length === 0 && busRoutes.length === 0;
  let message: string;
  if (!map.roads.length && !map.buildings.length) {
    message = 'Recon found nothing to work with: no roads or buildings in this area. Try a more built-up spot, or the sample town.';
  } else if (empty) {
    message = 'Recon found no landmarks here: no schools, sports grounds, parks or shops on the map. Missions will use the streets and the biggest buildings.';
  } else {
    const parts = [...categories].sort((a, b) => CATEGORY_INFO[b.category].weight - CATEGORY_INFO[a.category].weight).slice(0, 4).map((c) => c.text);
    if (busRoutes.length) parts.push(`${busRoutes.length} bus route${busRoutes.length === 1 ? '' : 's'}`);
    message = `Recon complete: ${joinList(parts)}.`;
  }
  return {
    mapName: map.name, empty, message, categories, notable, busRoutes,
    trees: map.trees?.length ?? 0, lamps: map.lamps?.length ?? 0, buildings: map.buildings.length, roads: map.roads.length,
  };
}

// ---------------------------------------------------------------------------------------
// Mission templates and matching
// ---------------------------------------------------------------------------------------

export type MissionBase = 'clear' | 'escort' | 'defend';

export type TemplateId =
  | 'hold-sports'
  | 'clear-tennis'
  | 'forest-sweep'
  | 'escort-shops'
  | 'escort-station'
  | 'hold-landmark'
  | 'clear-park'
  | 'classic-clear'
  | 'classic-escort'
  | 'classic-defend';

export interface MissionTemplate {
  id: TemplateId;
  base: MissionBase;
  /** Name on the mission card. */
  name: string;
  /** Places that can anchor it; empty = any map with roads ("classic" missions). */
  anchors: readonly FeatureCategory[];
  /** How strongly it's preferred when its places exist. */
  weight: number;
}

export const MISSION_TEMPLATES: Record<TemplateId, MissionTemplate> = {
  'forest-sweep': { id: 'forest-sweep', base: 'clear', name: 'Forest sweep', anchors: ['forest'], weight: 74 },
  'clear-tennis': { id: 'clear-tennis', base: 'clear', name: 'Clear the tennis club', anchors: ['tennis'], weight: 72 },
  'hold-sports': { id: 'hold-sports', base: 'defend', name: 'Hold the sports centre', anchors: ['sports_centre', 'stadium'], weight: 70 },
  'escort-shops': { id: 'escort-shops', base: 'escort', name: 'Get them home from the shops', anchors: ['mall', 'supermarket'], weight: 66 },
  'escort-station': { id: 'escort-station', base: 'escort', name: 'Last train home', anchors: ['train_station', 'bus_station'], weight: 58 },
  'clear-park': { id: 'clear-park', base: 'clear', name: 'Clear the park', anchors: ['park'], weight: 52 },
  'hold-landmark': { id: 'hold-landmark', base: 'defend', name: 'Hold the line', anchors: ['police', 'fire_station', 'hospital'], weight: 50 },
  'classic-clear': { id: 'classic-clear', base: 'clear', name: 'Clear the horde', anchors: [], weight: 22 },
  'classic-escort': { id: 'classic-escort', base: 'escort', name: 'Get them home', anchors: [], weight: 21 },
  'classic-defend': { id: 'classic-defend', base: 'defend', name: 'Hold the safehouse', anchors: [], weight: 20 },
};
export const TEMPLATE_IDS = Object.keys(MISSION_TEMPLATES) as TemplateId[];

export interface MissionSuggestion {
  template: TemplateId;
  base: MissionBase;
  /** The real place it's built around (absent for classic missions). */
  anchor?: Feature;
  /** Card title, with the real name where there is one. */
  title: string;
  /** One line: why this mission fits this map. */
  why: string;
  score: number;
}

/** Deterministic 0..1 jitter from a string, to break ties and vary suggestions by seed. */
const jitter = (s: string) => hashString(s) / 4294967296;

/** Can this place hold a mission? It must sit well inside the map, where the orbit and the roads are. */
function playable(map: MapData, f: Feature): boolean {
  const lim = map.half * 0.8;
  return Math.abs(f.p.x) < lim && Math.abs(f.p.z) < lim;
}

/** Candidate places for a template, best first (named, central, then a seeded tie-break). */
export function templateAnchors(map: MapData, id: TemplateId, seed: number): Feature[] {
  const t = MISSION_TEMPLATES[id];
  if (!t.anchors.length) return [];
  const score = (f: Feature) => (f.name ? 100 : 0) - dist(f.p, { x: 0, z: 0 }) / 25 + jitter(`${seed}|${id}|${f.id}`) * 12;
  return mapFeatures(map)
    .filter((f) => t.anchors.includes(f.category) && playable(map, f))
    .filter((f) => id !== 'forest-sweep' || !f.pts || polygonArea(f.pts) >= 2500)
    // Guardrail: never next to, or wrapped around, a school, kindergarten or playground.
    .filter((f) => !CHILD_CATEGORIES.includes(f.category) && !nearChildPlace(map, f.p) && !containsChildPlace(map, f.pts))
    .map((f) => ({ f, s: score(f) }))
    .sort((a, b) => b.s - a.s || (a.f.id < b.f.id ? -1 : 1))
    .map((x) => x.f);
}

/** Finds the anchor a suggestion named, or the template's best anchor. */
export function findAnchor(map: MapData, id: TemplateId, seed: number, anchorId?: string): Feature | null {
  const list = templateAnchors(map, id, seed);
  if (anchorId !== undefined) return list.find((f) => f.id === anchorId) ?? null;
  return list[0] ?? null;
}

function hectares(f: Feature): string | null {
  if (!f.pts || f.pts.length < 3) return null;
  const ha = polygonArea(f.pts) / 10000;
  return ha >= 10 ? `${Math.round(ha)} hectares` : `${ha.toFixed(1)} hectares`;
}

function describe(map: MapData, id: TemplateId, f: Feature | undefined, count: number): { title: string; why: string } {
  const t = MISSION_TEMPLATES[id];
  const name = f ? featureName(map, f) : '';
  const Name = name.charAt(0).toUpperCase() + name.slice(1);
  const others = count > 1 ? ` (one of ${count} here)` : '';
  switch (id) {
    case 'forest-sweep': {
      const ha = f && hectares(f);
      return { title: `Forest sweep: ${name}`, why: `${Name}${ha ? ` covers ${ha}` : ' is thick with trees'}: hordes are moving under the canopy, with more cold-blooded ones than usual.` };
    }
    case 'clear-tennis':
      return { title: `Clear the tennis club: ${name}`, why: `Hordes have wandered onto the courts at ${name}${others}. Flat, open ground: good shooting.` };
    case 'hold-sports': {
      const oval = f && mapFeatures(map).find((o) => (o.category === 'pitch' || o.category === 'stadium') && o.id !== f.id && dist(o.p, f.p) < 200 && o.name);
      return {
        title: `Hold the sports centre: ${name}`,
        why: oval ? `${Name} is a big hall with ${oval.name} beside it: open ground, so you'll see them coming.` : `${Name} is a big, solid hall that the whole neighbourhood knows how to find.`,
      };
    }
    case 'escort-shops':
      return { title: `Get them home from ${name}`, why: `Late-night shoppers are barricaded inside ${name}${others}. Walk them home through real streets.` };
    case 'escort-station': {
      const what = f?.category === 'bus_station' ? 'last bus' : 'last train';
      return { title: `Last ${what.split(' ')[1]} home: ${name}`, why: `Passengers off the ${what} are stuck at ${name}. Get them home on foot.` };
    }
    case 'clear-park':
      return { title: `Clear the park: ${name}`, why: `A horde has gathered in ${name}${others}. Clear it before it spills into the streets.` };
    case 'hold-landmark':
      return { title: `Hold ${name}`, why: `${Name} is a solid building everyone knows. The neighbours are inside; keep the dead out.` };
    case 'classic-clear':
      return { title: t.name, why: `Hordes in the streets and open spaces of ${map.name}. Works anywhere.` };
    case 'classic-escort':
      return { title: t.name, why: `Walk survivors from a safehouse to a home across ${map.name}. Works anywhere.` };
    case 'classic-defend':
      return { title: t.name, why: `Hold the most solid building near the middle of ${map.name}. Works anywhere.` };
  }
}

/** Every template that the map's places allow, scored (best first, before diversity). */
export function rankMissions(map: MapData, seed: number): MissionSuggestion[] {
  const features = mapFeatures(map);
  const out: MissionSuggestion[] = [];
  for (const id of TEMPLATE_IDS) {
    const t = MISSION_TEMPLATES[id];
    let anchor: Feature | undefined;
    let count = 0;
    if (t.anchors.length) {
      const list = templateAnchors(map, id, seed);
      if (!list.length) continue;
      anchor = list[0];
      count = features.filter((f) => t.anchors.includes(f.category)).length;
    } else if (map.roads.length === 0) {
      continue;
    }
    const score = t.weight + (anchor?.name ? 8 : 0) + Math.min(6, 2 * count) + jitter(`${map.name}|${seed}|${id}`) * 10;
    out.push({ template: id, base: t.base, anchor, ...describe(map, id, anchor, count), score: Math.round(score * 100) / 100 });
  }
  return out.sort((a, b) => b.score - a.score || (a.template < b.template ? -1 : 1));
}

/**
 * The top suggestions for this map and seed: best score first, with a penalty for repeating a
 * mission type so the player sees variety. `accept` lets the caller drop suggestions that
 * can't be built on this map (the UI checks each with the mission generator).
 */
export function matchMissions(map: MapData, seed: number, opts: { count?: number; accept?: (s: MissionSuggestion) => boolean } = {}): MissionSuggestion[] {
  const count = opts.count ?? 3;
  const pool = rankMissions(map, seed);
  const chosen: MissionSuggestion[] = [];
  while (chosen.length < count && pool.length) {
    let bi = 0;
    let best = -Infinity;
    pool.forEach((s, i) => {
      const v = s.score - 30 * chosen.filter((c) => c.base === s.base).length;
      if (v > best) {
        best = v;
        bi = i;
      }
    });
    const [s] = pool.splice(bi, 1);
    if (!opts.accept || opts.accept(s)) chosen.push(s);
  }
  return chosen;
}

function joinList(a: string[]): string {
  if (a.length <= 1) return a[0] ?? '';
  return `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`;
}
