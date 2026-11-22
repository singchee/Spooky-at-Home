import { parseOverpass, seedForPlace, type OverpassElement, type OverpassJson } from './overpass';
import type { LatLon } from './project';
import type { MapData } from './types';

/**
 * "Famous places" (BACKLOG 3.27): six public landmark areas bundled with the game as static files
 * under public/maps/presets/. They are OpenStreetMap downloads made once with the game's own core
 * and extras queries and stored compactly (scripts/build-presets.mjs). Loading one never touches
 * the network beyond our own origin. Pure data and decoding here: no DOM, no three.js.
 */
export interface PresetInfo {
  slug: string;
  country: string;
  /** Flag emoji, decorative. */
  flag: string;
  /** Area name shown on the button. */
  area: string;
  /** City, for the map's name. */
  city: string;
  origin: LatLon;
  half: number;
  /** The file is bundled. A place whose download is still outstanding stays false and is not offered. */
  ready: boolean;
}

/**
 * All six planned places. Only New York and Paris are bundled so far: the Overpass downloads for the
 * other four (core query) kept timing out (see public/maps/presets/CREDITS.md). Flip `ready` when a
 * file is added with scripts/build-presets.mjs.
 */
export const ALL_PRESETS: readonly PresetInfo[] = [
  { slug: 'sydney-circular-quay', country: 'Australia', flag: '🇦🇺', city: 'Sydney', area: 'Circular Quay & The Rocks', origin: { lat: -33.8585, lon: 151.212 }, half: 600, ready: false },
  { slug: 'london-tower', country: 'United Kingdom', flag: '🇬🇧', city: 'London', area: 'Tower of London & Tower Bridge', origin: { lat: 51.507, lon: -0.0757 }, half: 600, ready: false },
  { slug: 'new-york-midtown', country: 'United States', flag: '🇺🇸', city: 'New York', area: 'Times Square & Midtown', origin: { lat: 40.756, lon: -73.9845 }, half: 600, ready: true },
  { slug: 'paris-eiffel', country: 'France', flag: '🇫🇷', city: 'Paris', area: 'Eiffel Tower & Champ de Mars', origin: { lat: 48.8565, lon: 2.297 }, half: 600, ready: true },
  { slug: 'tokyo-shibuya', country: 'Japan', flag: '🇯🇵', city: 'Tokyo', area: 'Shibuya Crossing', origin: { lat: 35.663, lon: 139.701 }, half: 600, ready: false },
  { slug: 'rome-colosseum', country: 'Italy', flag: '🇮🇹', city: 'Rome', area: 'Colosseum', origin: { lat: 41.8905, lon: 12.4925 }, half: 600, ready: false },
];

/** The places on offer: the ones whose file is bundled. */
export const PRESETS: readonly PresetInfo[] = ALL_PRESETS.filter((p) => p.ready);

/** Presets grouped by country, in the order above. */
export function presetsByCountry(list: readonly PresetInfo[] = PRESETS): { country: string; flag: string; places: PresetInfo[] }[] {
  const out: { country: string; flag: string; places: PresetInfo[] }[] = [];
  for (const p of list) {
    let g = out.find((x) => x.country === p.country);
    if (!g) out.push((g = { country: p.country, flag: p.flag, places: [] }));
    g.places.push(p);
  }
  return out;
}

/** The map's name on screen and in best-score keys. */
export const presetMapName = (p: Pick<PresetInfo, 'area' | 'city'>): string => `${p.area}, ${p.city}`;

/** Missions on a preset are deterministic: the seed comes from the place, like a scouted one. */
export const presetSeed = (p: Pick<PresetInfo, 'origin'>): number => seedForPlace(p.origin);

export const PRESET_URL = (slug: string): string => `maps/presets/${slug}.json`;

// ---------- The compact file format ----------
// Coordinates are whole units of 1e-5 degrees (about 1 m). A way's points are a flat list of
// [lat, lon, dlat, dlon, dlat, dlon, ...]: the first point, then steps. Trees and lamps are
// step lists too. A list is packed as text (zigzag, 5 bits a character, a continue bit; see
// unpackInts) to keep a file small. Only the tags the game reads are kept (scripts/build-presets.mjs).

export const COORD_UNIT = 1e-5;

export interface PresetMeta {
  slug: string;
  name: string;
  country: string;
  area: string;
  city: string;
  origin: LatLon;
  half: number;
  downloaded: string;
  source: string;
  license: string;
}

export interface CompactMember {
  /** way ref */
  r: number;
  /** role */
  o?: string;
  /** points, packed */
  g: string;
}

export interface CompactElement {
  t: 'n' | 'w' | 'r';
  i: number;
  k?: Record<string, string>;
  /** node position, or a relation's centre, in units */
  p?: [number, number];
  /** way points, packed */
  g?: string;
  m?: CompactMember[];
}

export interface PresetFile {
  spooky_preset: PresetMeta;
  e: CompactElement[];
  /** steps from the previous tree (the first from 0,0), packed */
  trees: string;
  /** the same for street lamps */
  lamps: string;
}

const deg = (n: number) => n * COORD_UNIT;

const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const DIGIT = new Map([...DIGITS].map((c, i) => [c, i]));

/** The whole numbers in a packed string (see the file format above). */
export function unpackInts(s: string): number[] {
  const out: number[] = [];
  let z = 0;
  let mul = 1;
  for (const c of s) {
    const d = DIGIT.get(c) ?? 0;
    z += (d % 32) * mul;
    if (d >= 32) mul *= 32;
    else {
      out.push(z % 2 ? -(z + 1) / 2 : z / 2);
      z = 0;
      mul = 1;
    }
  }
  return out;
}

function points(packed: string): { lat: number; lon: number }[] {
  const flat = unpackInts(packed);
  const out: { lat: number; lon: number }[] = [];
  let la = 0;
  let lo = 0;
  for (let i = 0; i + 1 < flat.length; i += 2) {
    la += flat[i];
    lo += flat[i + 1];
    out.push({ lat: deg(la), lon: deg(lo) });
  }
  return out;
}

/** Spreads a compact file back into the Overpass answer parseOverpass reads. */
export function expandPreset(f: PresetFile): OverpassJson {
  const elements: OverpassElement[] = [];
  for (const e of f.e) {
    if (e.t === 'n' && e.p) elements.push({ type: 'node', id: e.i, lat: deg(e.p[0]), lon: deg(e.p[1]), tags: e.k });
    else if (e.t === 'w' && e.g) elements.push({ type: 'way', id: e.i, geometry: points(e.g), tags: e.k });
    else if (e.t === 'r') {
      elements.push({
        type: 'relation',
        id: e.i,
        tags: e.k,
        ...(e.p ? { center: { lat: deg(e.p[0]), lon: deg(e.p[1]) } } : {}),
        ...(e.m ? { members: e.m.map((m) => ({ type: 'way' as const, ref: m.r, role: m.o, geometry: points(m.g) })) } : {}),
      });
    }
  }
  const nodes = (packed: string, tags: Record<string, string>, base: number) => {
    const flat = unpackInts(packed);
    let la = 0;
    let lo = 0;
    for (let i = 0; i + 1 < flat.length; i += 2) {
      la += flat[i];
      lo += flat[i + 1];
      elements.push({ type: 'node', id: base + i / 2, lat: deg(la), lon: deg(lo), tags });
    }
  };
  nodes(f.trees ?? '', { natural: 'tree' }, 9_000_000_000);
  nodes(f.lamps ?? '', { highway: 'street_lamp' }, 9_100_000_000);
  return { elements, parts: ['core', 'extras'] };
}

/** Checks a downloaded file looks like a preset before it is used. */
export function isPresetFile(v: unknown): v is PresetFile {
  const f = v as PresetFile | null;
  return !!f && typeof f === 'object' && !!f.spooky_preset && typeof f.spooky_preset.origin?.lat === 'number' && typeof f.spooky_preset.origin?.lon === 'number' && Array.isArray(f.e);
}

/** A preset file as a playable map. */
export function presetToMap(f: PresetFile, info?: Pick<PresetInfo, 'area' | 'city'>): MapData {
  const m = f.spooky_preset;
  return parseOverpass(expandPreset(f), m.origin, m.half, presetMapName(info ?? m));
}
