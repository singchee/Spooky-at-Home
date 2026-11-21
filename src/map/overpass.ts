import { bboxAround, toLocal, type LatLon } from './project';
import type { Area, AreaKind, Building, BusRoute, Feature, FeatureCategory, MapData, Poi, Road, V2 } from './types';
import { FEATURE_CATEGORIES } from './types';
import { centroid, dist, pointInPolygon, polygonArea } from './geom';
import { hashString, mulberry32 } from '../util/rng';

/**
 * Real-world maps come from OpenStreetMap through the public Overpass API.
 * The player's browser makes these requests directly; nothing passes through a game server.
 * Overpass is a shared community service: keep requests small and infrequent.
 */
const OVERPASS_ENDPOINTS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];

const ROAD_WIDTHS: Record<string, number> = {
  motorway: 14, trunk: 12, primary: 10, secondary: 9, tertiary: 8, unclassified: 6, residential: 7,
  living_street: 5, service: 4, pedestrian: 4, footway: 2, path: 1.5, cycleway: 2, steps: 2, track: 3,
};

const POI_AMENITIES = ['hospital', 'school', 'police', 'fire_station', 'community_centre', 'place_of_worship', 'library', 'clinic'];

/** Caps that keep a dense city centre from flooding the game with recon detail. */
const MAX_FEATURES = 2000;
const MAX_TREES = 5000;
const MAX_LAMPS = 3000;

/**
 * One request per map, in three output blocks: ways and nodes with full geometry; big
 * multipolygon places (forests, parks, schools) as a centre point only, which keeps the answer
 * small; and bus routes with their geometry clipped to the map square.
 */
export function buildQuery(origin: LatLon, half: number): string {
  const b = bboxAround(origin, half);
  const bb = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  const hw = Object.keys(ROAD_WIDTHS).join('|');
  const am = [...POI_AMENITIES, 'kindergarten', 'parking', 'bus_station'].join('|');
  return `[out:json][timeout:30];
(
  way["building"](${bb});
  way["highway"~"^(${hw})$"](${bb});
  way["leisure"~"^(park|pitch|playground|garden|recreation_ground|sports_centre|stadium|swimming_pool|track)$"](${bb});
  way["landuse"~"^(grass|recreation_ground|meadow|village_green|forest)$"](${bb});
  way["natural"~"^(water|wood)$"](${bb});
  way["amenity"~"^(school|kindergarten|hospital|parking|bus_station)$"](${bb});
  way["shop"~"^(supermarket|mall)$"](${bb});
  way["club"="tennis"](${bb});
  node["amenity"~"^(${am})$"](${bb});
  node["leisure"~"^(sports_centre|stadium|pitch|swimming_pool|playground)$"](${bb});
  node["sport"="tennis"](${bb});
  node["club"="tennis"](${bb});
  node["shop"~"^(supermarket|mall)$"](${bb});
  node["railway"~"^(station|halt)$"](${bb});
  node["highway"="street_lamp"](${bb});
  node["natural"="tree"](${bb});
);
out geom;
(
  relation["landuse"="forest"](${bb});
  relation["natural"="wood"](${bb});
  relation["leisure"~"^(park|sports_centre|stadium)$"](${bb});
  relation["amenity"~"^(school|hospital)$"](${bb});
  relation["shop"="mall"](${bb});
);
out center tags;
relation["route"="bus"](${bb});
out geom(${bb});`;
}

export interface OverpassMember {
  type: 'node' | 'way' | 'relation';
  ref: number;
  role?: string;
  lat?: number;
  lon?: number;
  /** With a clipped `out geom(bbox)`, points outside the box can come back as null. */
  geometry?: ({ lat: number; lon: number } | null)[];
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
  center?: { lat: number; lon: number };
  members?: OverpassMember[];
  tags?: Record<string, string>;
}

export interface OverpassJson {
  elements: OverpassElement[];
}

export async function fetchOverpass(origin: LatLon, half: number, signal?: AbortSignal): Promise<OverpassJson> {
  const body = 'data=' + encodeURIComponent(buildQuery(origin, half));
  let lastErr: unknown;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      });
      if (!res.ok) throw new Error(`${url} answered ${res.status}`);
      return (await res.json()) as OverpassJson;
    } catch (e) {
      if (signal?.aborted) throw e;
      lastErr = e;
    }
  }
  throw new Error(`Could not download map data (${String(lastErr)})`);
}

function buildingHeight(tags: Record<string, string>, id: number): number {
  const h = parseFloat(tags.height ?? '');
  if (Number.isFinite(h) && h > 0) return Math.min(h, 200);
  const lv = parseFloat(tags['building:levels'] ?? '');
  if (Number.isFinite(lv) && lv > 0) return Math.min(lv * 3.2 + 1, 200);
  const r = mulberry32(id)();
  const base: Record<string, number> = {
    house: 6, detached: 6, semidetached_house: 6, terrace: 7, garage: 3, shed: 2.5, apartments: 14,
    commercial: 9, retail: 6, industrial: 8, warehouse: 9, school: 8, hospital: 18, church: 12,
  };
  return (base[tags.building] ?? 7) + r * 2;
}

function areaKind(tags: Record<string, string>): AreaKind | null {
  if (tags.natural === 'water') return 'water';
  if (tags.natural === 'wood' || tags.landuse === 'forest') return 'wood';
  // Sports centres and pools are buildings or recon places, not open ground.
  if (tags.leisure === 'sports_centre' || tags.leisure === 'swimming_pool') return null;
  if (tags.leisure || tags.landuse) return 'park';
  return null;
}

const hasValue = (v: string | undefined, want: string) => !!v && v.split(';').map((x) => x.trim()).includes(want);

/** Which recon category an OpenStreetMap object belongs to, if any. */
export function featureCategory(tags: Record<string, string>): FeatureCategory | null {
  // A tennis club is club=tennis, or a named tennis place. An unnamed court (leisure=pitch +
  // sport=tennis) is just a sports ground: lone courts sit in backyards and school grounds.
  if (tags.club === 'tennis') return 'tennis';
  if (hasValue(tags.sport, 'tennis') && !!tags.name && (!tags.leisure || ['pitch', 'sports_centre'].includes(tags.leisure))) return 'tennis';
  switch (tags.amenity) {
    case 'school': return 'school';
    case 'kindergarten': return 'kindergarten';
    case 'hospital': return 'hospital';
    case 'police': return 'police';
    case 'fire_station': return 'fire_station';
    case 'parking': return 'parking';
    case 'bus_station': return 'bus_station';
  }
  switch (tags.leisure) {
    case 'sports_centre': return 'sports_centre';
    case 'stadium': return 'stadium';
    case 'pitch': return 'pitch';
    case 'swimming_pool': return 'swimming_pool';
    case 'playground': return 'playground';
    case 'park': return 'park';
  }
  if (tags.landuse === 'forest' || tags.natural === 'wood') return 'forest';
  if (tags.shop === 'supermarket') return 'supermarket';
  if (tags.shop === 'mall') return 'mall';
  if (tags.railway === 'station' || tags.railway === 'halt') return 'train_station';
  if (tags.public_transport === 'station' && tags.bus === 'yes') return 'bus_station';
  return null;
}

/** Backyard pools are everywhere in some suburbs: only public, named or large pools count as places. */
function worthKeeping(cat: FeatureCategory, tags: Record<string, string>, pts: V2[] | undefined): boolean {
  if (cat !== 'swimming_pool') return true;
  if (tags.access === 'private' || tags.access === 'no') return false;
  return !!tags.name || (!!pts && polygonArea(pts) >= 200);
}

/**
 * The same place is often mapped twice (school grounds plus the school building, a club
 * plus its courts). Merge same-category features with the same name, or where one sits inside
 * the other's outline. The one with the bigger outline wins and keeps any name.
 */
export function dedupeFeatures(list: Feature[]): Feature[] {
  const size = (f: Feature) => (f.pts && f.pts.length >= 3 ? polygonArea(f.pts) : 0);
  const byId = (a: Feature, b: Feature) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const sorted = [...list].sort((a, b) => size(b) - size(a) || byId(a, b));
  const out: Feature[] = [];
  for (const f of sorted) {
    const twin = out.find(
      (o) =>
        o.category === f.category &&
        ((!!o.name && !!f.name && o.name.toLowerCase() === f.name.toLowerCase() && dist(o.p, f.p) < 400) ||
          (!!o.pts && o.pts.length >= 3 && pointInPolygon(f.p, o.pts) && (!f.name || !o.name || o.name === f.name))),
    );
    if (twin) {
      if (!twin.name && f.name) twin.name = f.name;
      continue;
    }
    out.push({ ...f });
  }
  // A stable, readable order: by category, then named before unnamed, then id.
  const order = (c: FeatureCategory) => FEATURE_CATEGORIES.indexOf(c);
  return out.sort((a, b) => order(a.category) - order(b.category) || (a.name ? 0 : 1) - (b.name ? 0 : 1) || byId(a, b));
}

/** Turns raw Overpass JSON into the game's local-metre map format. */
export function parseOverpass(json: OverpassJson, origin: LatLon, half: number, name: string): MapData {
  const buildings: Building[] = [];
  const roads: Road[] = [];
  const areas: Area[] = [];
  const pois: Poi[] = [];
  const features: Feature[] = [];
  const trees: V2[] = [];
  const lamps: V2[] = [];
  const routes = new Map<string, RouteBuilder>();
  const margin = half + 60;
  const inside = (p: V2) => Math.abs(p.x) <= margin && Math.abs(p.z) <= margin;
  const inMap = (p: V2) => Math.abs(p.x) <= half && Math.abs(p.z) <= half;
  const seen = new Set<string>();
  const addFeature = (id: string, tags: Record<string, string>, p: V2, pts?: V2[]) => {
    const category = featureCategory(tags);
    if (!category || !inMap(p) || seen.has(id) || !worthKeeping(category, tags, pts)) return;
    seen.add(id);
    features.push({ id, category, name: tags.name, p, ...(pts ? { pts } : {}) });
  };

  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      const p = toLocal(origin, el.lat, el.lon);
      if (!inside(p)) continue;
      if (tags.highway === 'street_lamp') {
        if (lamps.length < MAX_LAMPS) lamps.push(p);
        continue;
      }
      if (tags.natural === 'tree') {
        if (trees.length < MAX_TREES) trees.push(p);
        continue;
      }
      if (tags.amenity && POI_AMENITIES.includes(tags.amenity)) pois.push({ id: `n${el.id}`, p, kind: tags.amenity, name: tags.name });
      addFeature(`n${el.id}`, tags, p);
      continue;
    }
    if (el.type === 'relation') {
      if (tags.route === 'bus') addBusRoute(routes, el, origin, inside);
      else if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
        addFeature(`r${el.id}`, tags, toLocal(origin, el.center.lat, el.center.lon));
      }
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    let pts = el.geometry.map((g) => toLocal(origin, g.lat, g.lon));
    if (!pts.some(inside)) continue;

    const closed = pts.length > 3 && pts[0].x === pts[pts.length - 1].x && pts[0].z === pts[pts.length - 1].z;
    const outline = closed ? pts.slice(0, -1) : undefined;
    addFeature(`w${el.id}`, tags, centroid(outline ?? pts), outline);
    if (tags.building && closed) {
      pts = pts.slice(0, -1);
      buildings.push({ id: `w${el.id}`, pts, height: buildingHeight(tags, el.id), kind: tags.building, name: tags.name });
      if (tags.amenity && POI_AMENITIES.includes(tags.amenity)) {
        pois.push({ id: `w${el.id}`, p: centroid(pts), kind: tags.amenity, name: tags.name });
      }
    } else if (tags.highway && ROAD_WIDTHS[tags.highway] !== undefined) {
      roads.push({ id: `w${el.id}`, pts, kind: tags.highway, width: ROAD_WIDTHS[tags.highway], name: tags.name });
    } else if (closed) {
      const kind = areaKind(tags);
      if (kind) areas.push({ id: `w${el.id}`, pts: pts.slice(0, -1), kind, name: tags.name });
    }
  }

  return {
    name,
    half,
    buildings,
    roads,
    areas,
    pois,
    attribution: 'Map data © OpenStreetMap contributors (ODbL)',
    features: dedupeFeatures(features).slice(0, MAX_FEATURES),
    busRoutes: [...routes.values()].map(({ members: _members, ...r }) => r).filter((r) => r.lines.length > 0),
    trees,
    lamps,
  };
}

type RouteBuilder = BusRoute & { members: Set<number> };

/**
 * A bus route relation, clipped to the map. Most lines exist once per direction, so routes
 * with the same number are merged and shared streets are kept once.
 */
function addBusRoute(routes: Map<string, RouteBuilder>, el: OverpassElement, origin: LatLon, inside: (p: V2) => boolean): void {
  const tags = el.tags ?? {};
  const key = tags.ref ? `ref:${tags.ref}` : tags.name ? `name:${tags.name}` : `id:${el.id}`;
  let r = routes.get(key);
  if (!r) {
    r = { id: `r${el.id}`, ref: tags.ref, name: tags.name, lines: [], members: new Set() };
    routes.set(key, r);
  }
  const route = r;
  for (const m of el.members ?? []) {
    if (m.type !== 'way' || !m.geometry || route.members.has(m.ref)) continue;
    if (m.role && m.role !== 'forward' && m.role !== 'backward') continue; // platforms and stops
    route.members.add(m.ref);
    let line: V2[] = [];
    const flush = () => {
      if (line.length >= 2 && line.some(inside)) route.lines.push(line);
      line = [];
    };
    for (const g of m.geometry) {
      if (!g || !Number.isFinite(g.lat) || !Number.isFinite(g.lon)) flush();
      else line.push(toLocal(origin, g.lat, g.lon));
    }
    flush();
  }
}

let lastGeocode = 0;

/** Accepts "lat, lon" directly, otherwise asks OpenStreetMap's Nominatim geocoder (max 1 request/second). */
export async function geocode(query: string, signal?: AbortSignal): Promise<LatLon & { label: string }> {
  const m = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m) return { lat: parseFloat(m[1]), lon: parseFloat(m[2]), label: `${parseFloat(m[1]).toFixed(4)}, ${parseFloat(m[2]).toFixed(4)}` };
  // Nominatim's usage policy: at most one request per second from this client.
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocode = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Place search failed (${res.status})`);
  const arr = (await res.json()) as { lat: string; lon: string; display_name: string }[];
  if (arr.length === 0) throw new Error(`No place found for "${query}"`);
  return { lat: parseFloat(arr[0].lat), lon: parseFloat(arr[0].lon), label: arr[0].display_name.split(',').slice(0, 2).join(',') };
}

/** Stable seed for a real location so revisiting it gives the same missions. */
export const seedForPlace = (o: LatLon): number => hashString(`${o.lat.toFixed(4)},${o.lon.toFixed(4)}`);
