import { bboxAround, toLocal, type LatLon } from './project';
import type { Area, AreaKind, Building, BusRoute, Feature, FeatureCategory, MapData, Poi, Road, V2 } from './types';
import { FEATURE_CATEGORIES } from './types';
import { convexHull, centroid, dist, pointInPolygon, polygonArea } from './geom';
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

/** Amenities whose grounds are protected; fetched as relations with full geometry. */
const CHILD_RELATION = /^(school|kindergarten|childcare)$/;
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
  const am = [...POI_AMENITIES, 'kindergarten', 'childcare', 'parking', 'bus_station'].join('|');
  return `[out:json][timeout:60];
(
  way["building"](${bb});
  way["highway"~"^(${hw})$"](${bb});
  way["leisure"~"^(park|pitch|playground|garden|recreation_ground|sports_centre|stadium|swimming_pool|track)$"](${bb});
  way["landuse"~"^(grass|recreation_ground|meadow|village_green|forest)$"](${bb});
  way["natural"~"^(water|wood)$"](${bb});
  way["amenity"~"^(school|kindergarten|childcare|hospital|parking|bus_station)$"](${bb});
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
relation["amenity"~"^(school|kindergarten|childcare)$"](${bb});
out geom;
(
  relation["landuse"="forest"](${bb});
  relation["natural"="wood"](${bb});
  relation["leisure"~"^(park|sports_centre|stadium)$"](${bb});
  relation["amenity"="hospital"](${bb});
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
  /** Overpass reports a query that ran out of time or memory here, with HTTP 200 and partial (or no) elements. */
  remark?: string;
}

// ---------- Why a map didn't load (for plain-English messages) ----------

/**
 * offline: the browser couldn't connect at all (no network, a blocked host, a firewall).
 * busy: the server answered but was overloaded or ran out of time; worth trying again in a minute.
 * not-found: the place search found nothing. bad-coords: a "lat, lon" that isn't on the globe.
 * too-little: the download worked but hardly anything is mapped there. aborted: the player cancelled.
 */
export type MapErrorKind = 'offline' | 'busy' | 'not-found' | 'bad-coords' | 'too-little' | 'aborted' | 'other';

export class MapLoadError extends Error {
  constructor(readonly kind: MapErrorKind, message: string, readonly counts?: { buildings: number; roads: number }) {
    super(message);
    this.name = 'MapLoadError';
  }
}

/** HTTP answers that mean "busy, try later": rate limited, or the gateway gave up waiting. */
const BUSY_STATUS = new Set([429, 502, 503, 504]);
/** What browsers say when fetch() can't connect (Chrome, Firefox, Safari, Node). */
const OFFLINE_TEXT = /failed to fetch|networkerror|load failed|network request failed|fetch failed/i;

const isAbort = (e: unknown) => !!e && typeof e === 'object' && (e as { name?: string }).name === 'AbortError';

export function classifyMapError(e: unknown): MapErrorKind {
  if (e instanceof MapLoadError) return e.kind;
  if (isAbort(e)) return 'aborted';
  const msg = String((e as Error)?.message ?? e);
  if (OFFLINE_TEXT.test(msg)) return 'offline';
  if (/timed out|timeout|runtime error|too many requests/i.test(msg)) return 'busy';
  return 'other';
}

/** A sentence or two for the player. Never the browser's own error text. */
export function mapErrorMessage(e: unknown): string {
  switch (classifyMapError(e)) {
    case 'offline':
      return "Couldn't reach OpenStreetMap. Check your connection, or try the sample town.";
    case 'busy':
      return "OpenStreetMap's map server is busy right now. Try again in a minute, or try the sample town.";
    case 'not-found':
      return 'Couldn\'t find that place. Try adding the suburb, town or country, or type coordinates as "lat, lon".';
    case 'bad-coords':
      return "That isn't a real latitude/longitude. Latitude runs from -90 to 90 and longitude from -180 to 180.";
    case 'too-little': {
      const c = e instanceof MapLoadError ? e.counts : undefined;
      const found = c ? ` (${c.buildings} building${c.buildings === 1 ? '' : 's'} and ${c.roads} road${c.roads === 1 ? '' : 's'})` : '';
      return `There's too little on the map there to fly a mission${found}. Try a busier spot nearby, or the sample town.`;
    }
    case 'aborted':
      return 'Scouting cancelled.';
    default:
      return 'Something went wrong building that place. Try again, or try the sample town.';
  }
}

/** Below this there's nothing to fly over: no streets to walk, or hardly a house. */
export function checkEnoughMap(m: MapData): MapData {
  if (m.roads.length < 2 || m.buildings.length < 5) {
    throw new MapLoadError('too-little', `Only ${m.buildings.length} buildings and ${m.roads.length} roads are mapped here`, { buildings: m.buildings.length, roads: m.roads.length });
  }
  return m;
}

/** fetch() that labels a failure to connect as 'offline' (an abort stays an abort). */
async function fetchOrOffline(url: string, init: RequestInit, what: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (e) {
    if (isAbort(e) || init.signal?.aborted) throw e;
    throw new MapLoadError('offline', `Couldn't reach ${what} (${String(e)})`);
  }
}

/** A 200 answer can still be a failed query: Overpass says so in `remark`. Throws for those. */
export function checkOverpassAnswer(json: OverpassJson, url: string): OverpassJson {
  if (!json || !Array.isArray(json.elements)) throw new MapLoadError('other', `${url} sent an answer with no map data`);
  if (typeof json.remark === 'string' && /runtime error|timed out/i.test(json.remark)) throw new MapLoadError('busy', `${url} could not finish the query (${json.remark.slice(0, 120)})`);
  return json;
}

export async function fetchOverpass(origin: LatLon, half: number, signal?: AbortSignal): Promise<OverpassJson> {
  const body = 'data=' + encodeURIComponent(buildQuery(origin, half));
  let lastErr: unknown;
  const kinds: MapErrorKind[] = [];
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetchOrOffline(url, {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        signal,
      }, 'the map server');
      if (!res.ok) throw new MapLoadError(BUSY_STATUS.has(res.status) ? 'busy' : 'other', `${url} answered ${res.status}`);
      // A timed-out or failed query still answers 200; try the next server instead.
      return checkOverpassAnswer((await res.json()) as OverpassJson, url);
    } catch (e) {
      if (signal?.aborted || isAbort(e)) throw e;
      lastErr = e;
      kinds.push(classifyMapError(e));
    }
  }
  // Busy anywhere: worth another go soon. Unreachable everywhere: a connection problem.
  const kind: MapErrorKind = kinds.includes('busy') ? 'busy' : kinds.every((k) => k === 'offline') ? 'offline' : 'other';
  throw new MapLoadError(kind, `Could not download map data (${String(lastErr)})`);
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
    case 'childcare': return 'kindergarten'; // day care (common tagging in Australia and the UK)
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

/**
 * Which places survive the MAX_FEATURES cap, best first. Schools, kindergartens and playgrounds
 * are never dropped: the mission guardrail's exclusion zone depends on them (PLAN §9). Hospitals,
 * police and stations come next; car parks and sports pitches, the most numerous, go last.
 */
const CAP_PRIORITY: readonly FeatureCategory[] = [
  'school', 'kindergarten', 'playground',
  'hospital', 'police', 'fire_station', 'train_station', 'bus_station',
  'mall', 'supermarket', 'sports_centre', 'stadium', 'tennis', 'forest', 'park', 'swimming_pool',
  'pitch', 'parking',
];
const NEVER_DROP: readonly FeatureCategory[] = ['school', 'kindergarten', 'playground'];

/** Keeps at most `max` features (plus every school, kindergarten and playground), in their original order. */
export function capFeatures(list: Feature[], max = MAX_FEATURES): Feature[] {
  if (list.length <= max) return list;
  const must = list.filter((f) => NEVER_DROP.includes(f.category)).length;
  const keep = new Set(
    list
      .map((f, i) => ({ f, i }))
      .sort((a, b) => CAP_PRIORITY.indexOf(a.f.category) - CAP_PRIORITY.indexOf(b.f.category) || a.i - b.i)
      .slice(0, Math.max(max, must))
      .map((x) => x.f),
  );
  return list.filter((f) => keep.has(f));
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
      else if (CHILD_RELATION.test(tags.amenity ?? '') && el.members?.length) {
        // Campus mapped as a multipolygon: protect the whole grounds (convex hull of the outer rings),
        // not just a circle around the middle (guardrail, PLAN §9).
        const outer: V2[] = [];
        for (const m of el.members) {
          if (m.type !== 'way' || (m.role && m.role !== 'outer')) continue;
          for (const g of m.geometry ?? []) if (g && Number.isFinite(g.lat) && Number.isFinite(g.lon)) outer.push(toLocal(origin, g.lat, g.lon));
        }
        const hull = convexHull(outer);
        if (hull.length >= 3) addFeature(`r${el.id}`, tags, centroid(hull), hull);
        else if (el.center) addFeature(`r${el.id}`, tags, toLocal(origin, el.center.lat, el.center.lon));
      } else if (el.center && Number.isFinite(el.center.lat) && Number.isFinite(el.center.lon)) {
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
    features: capFeatures(dedupeFeatures(features)),
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
  if (m) {
    const lat = parseFloat(m[1]);
    const lon = parseFloat(m[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) throw new MapLoadError('bad-coords', 'Coordinates out of range: latitude must be -90 to 90 and longitude -180 to 180');
    return { lat, lon, label: `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
  }
  // Nominatim's usage policy: at most one request per second from this client.
  const wait = lastGeocode + 1100 - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  signal?.throwIfAborted(); // cancelled while waiting: don't send the request at all
  lastGeocode = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&q=${encodeURIComponent(query)}`;
  const res = await fetchOrOffline(url, { signal, headers: { Accept: 'application/json' } }, 'the place search');
  if (!res.ok) throw new MapLoadError(BUSY_STATUS.has(res.status) ? 'busy' : 'other', `Place search failed (${res.status})`);
  let arr: { lat: string; lon: string; display_name?: string }[];
  try {
    arr = (await res.json()) as typeof arr;
  } catch (e) {
    if (isAbort(e)) throw e;
    throw new MapLoadError('other', "The place search sent an answer this game can't read");
  }
  const lat = Array.isArray(arr) ? parseFloat(arr[0]?.lat) : NaN;
  const lon = Array.isArray(arr) ? parseFloat(arr[0]?.lon) : NaN;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new MapLoadError('not-found', `No place found for "${query}"`);
  const label = String(arr[0].display_name ?? '').split(',').slice(0, 2).join(',').trim();
  return { lat, lon, label: label || `${lat.toFixed(4)}, ${lon.toFixed(4)}` };
}

/** Stable seed for a real location so revisiting it gives the same missions. */
export const seedForPlace = (o: LatLon): number => hashString(`${o.lat.toFixed(4)},${o.lon.toFixed(4)}`);
