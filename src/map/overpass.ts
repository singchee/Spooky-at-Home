import { bboxAround, toLocal, type LatLon } from './project';
import type { Area, AreaKind, Building, MapData, Poi, Road, V2 } from './types';
import { centroid } from './geom';
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

export function buildQuery(origin: LatLon, half: number): string {
  const b = bboxAround(origin, half);
  const bb = `${b.south.toFixed(6)},${b.west.toFixed(6)},${b.north.toFixed(6)},${b.east.toFixed(6)}`;
  const hw = Object.keys(ROAD_WIDTHS).join('|');
  const am = POI_AMENITIES.join('|');
  return `[out:json][timeout:30];
(
  way["building"](${bb});
  way["highway"~"^(${hw})$"](${bb});
  way["leisure"~"^(park|pitch|playground|garden|recreation_ground)$"](${bb});
  way["landuse"~"^(grass|recreation_ground|meadow|village_green|forest)$"](${bb});
  way["natural"~"^(water|wood)$"](${bb});
  node["amenity"~"^(${am})$"](${bb});
);
out geom;`;
}

export interface OverpassElement {
  type: 'node' | 'way' | 'relation';
  id: number;
  lat?: number;
  lon?: number;
  geometry?: { lat: number; lon: number }[];
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
  if (tags.leisure || tags.landuse) return 'park';
  return null;
}

/** Turns raw Overpass JSON into the game's local-metre map format. */
export function parseOverpass(json: OverpassJson, origin: LatLon, half: number, name: string): MapData {
  const buildings: Building[] = [];
  const roads: Road[] = [];
  const areas: Area[] = [];
  const pois: Poi[] = [];
  const margin = half + 60;
  const inside = (p: V2) => Math.abs(p.x) <= margin && Math.abs(p.z) <= margin;

  for (const el of json.elements) {
    const tags = el.tags ?? {};
    if (el.type === 'node' && el.lat !== undefined && el.lon !== undefined) {
      const p = toLocal(origin, el.lat, el.lon);
      if (tags.amenity && inside(p)) pois.push({ id: `n${el.id}`, p, kind: tags.amenity, name: tags.name });
      continue;
    }
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) continue;
    let pts = el.geometry.map((g) => toLocal(origin, g.lat, g.lon));
    if (!pts.some(inside)) continue;

    const closed = pts.length > 3 && pts[0].x === pts[pts.length - 1].x && pts[0].z === pts[pts.length - 1].z;
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
  };
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
