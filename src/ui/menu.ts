import type { MapData, V2 } from '../map/types';
import { FEATURE_CATEGORIES } from '../map/types';
import { makeSampleTown } from '../map/sample';
import { fetchOverpass, geocode, parseOverpass, type OverpassJson } from '../map/overpass';
import { centroid } from '../map/geom';
import type { MissionType } from '../sim/missions';
import type { TemplateId } from '../map/recon';
import { el } from './dom';
import { showRecon } from './recon';

/** The start screen: pick a map (sample town, an address, or a saved file) and a mission. */
export interface MenuChoice {
  map: MapData;
  type: MissionType | 'auto';
  difficulty: number;
  seed: number;
  /** Set when the mission was chosen on the recon screen. */
  template?: TemplateId;
  anchor?: string;
}

const HALF = 600;
const MAX_BUILDINGS = 6000;

export function showMenu(parent: HTMLElement, onStart: (c: MenuChoice) => void, last?: Partial<MenuChoice>): () => void {
  const root = el('div', 'menu', undefined, parent);
  const card = el('div', 'card wide', undefined, root);
  el('div', 'card-kicker', 'GUNSHIP · NIGHT SHIFT', card);
  el('h1', undefined, 'SPOOKY AT HOME', card);
  el('p', undefined, 'Circle your own neighbourhood at night. Get the survivors home. Mind the cold-blooded ones.', card);
  el('p', 'small', 'Best with a mouse and keyboard.', card);

  let map: MapData | null = last?.map ?? null;

  el('h3', undefined, '1. Choose the map', card);
  const status = el('p', 'status', map ? describe(map) : 'Using the sample town until you pick a place.', card);
  const row1 = el('div', 'row', undefined, card);
  const sampleBtn = el('button', undefined, 'Sample town', row1);
  const q = el('input', undefined, undefined, row1);
  q.placeholder = 'Address, suburb, or "lat, lon"';
  q.setAttribute('aria-label', 'Address, suburb, or latitude and longitude');
  const searchBtn = el('button', undefined, 'Build this place', row1);
  const row2 = el('div', 'row', undefined, card);
  const fileLabel = el('label', 'filelabel', 'Load a saved map file', row2);
  const file = el('input', undefined, undefined, fileLabel);
  file.type = 'file';
  file.accept = '.json,application/json';
  const saveBtn = el('button', undefined, 'Save this map to a file', row2);
  el('p', 'small', 'Your search goes straight from your browser to OpenStreetMap. This game has no server and stores nothing. Saved map files stay on your computer.', card);

  el('h3', undefined, '2. Choose the mission', card);
  const row3 = el('div', 'row', undefined, card);
  const type = select(row3, 'Mission', [['auto', 'Surprise me'], ['clear', 'Clear the horde'], ['escort', 'Get them home'], ['defend', 'Hold the safehouse']], last?.type ?? 'escort');
  const diff = select(row3, 'Difficulty', [['1', '1 — Rookie'], ['2', '2'], ['3', '3 — Veteran'], ['4', '4'], ['5', '5 — Nightmare']], String(last?.difficulty ?? 2));
  const seedLabel = el('label', 'field', 'Seed ', row3);
  const seed = el('input', undefined, undefined, seedLabel);
  seed.type = 'number';
  seed.value = String(last?.seed ?? 1);
  const start = el('button', 'primary big', 'Brief me', card);
  el('p', 'attrib', 'Map data © OpenStreetMap contributors (ODbL) when a real place is used.', card);

  const seedValue = () => Math.max(1, Math.floor(Number(seed.value) || 1));
  // Recon screen: shown after a map loads. "Custom mission" and "Change map" come back here.
  let closeRecon: (() => void) | null = null;
  const backToMenu = (focus?: HTMLElement) => {
    closeRecon?.();
    closeRecon = null;
    card.style.display = '';
    focus?.focus();
  };
  const openRecon = (m: MapData) => {
    closeRecon?.();
    card.style.display = 'none';
    closeRecon = showRecon(root, m, { seed: seedValue(), difficulty: Number(diff.value) }, {
      onChoose: (s, d, sd) => onStart({ map: m, type: s.base, template: s.template, anchor: s.anchor?.id, difficulty: d, seed: sd }),
      onCustom: () => backToMenu(type),
      onBack: () => backToMenu(q),
    });
    root.scrollTop = 0;
  };
  const setMap = (m: MapData) => {
    map = m;
    status.textContent = describe(m);
    openRecon(m);
  };
  // Back from a recon mission: return to the recon screen for the same map.
  if (map && last?.template) openRecon(map);
  sampleBtn.addEventListener('click', () => setMap(makeSampleTown()));
  let busy = false;
  const search = async () => {
    if (busy || !q.value.trim()) return;
    busy = true;
    searchBtn.disabled = true;
    try {
      status.textContent = 'Finding the place…';
      const place = await geocode(q.value);
      status.textContent = `Downloading streets and buildings around ${place.label} (this can take 10–20 seconds)…`;
      const json = await fetchOverpass(place, HALF);
      setMap(trim(parseOverpass(json, place, HALF, place.label)));
    } catch (e) {
      status.textContent = `Couldn't build that place: ${(e as Error).message}. Try again in a minute, or use the sample town.`;
    } finally {
      busy = false;
      searchBtn.disabled = false;
    }
  };
  searchBtn.addEventListener('click', search);
  q.addEventListener('keydown', (e) => e.key === 'Enter' && !e.repeat && search());
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      setMap(loadMapFile(JSON.parse(await f.text()), f.name));
    } catch (e) {
      status.textContent = `That file isn't a map this game understands (${(e as Error).message}).`;
    }
  });
  saveBtn.addEventListener('click', () => {
    if (!map) return;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(map)], { type: 'application/json' }));
    a.download = `${map.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.spooky-map.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  start.addEventListener('click', () => {
    onStart({ map: map ?? makeSampleTown(), type: type.value as MenuChoice['type'], difficulty: Number(diff.value), seed: seedValue() });
  });
  return () => root.remove();
}

function select(parent: HTMLElement, label: string, opts: [string, string][], value: string): HTMLSelectElement {
  const l = el('label', 'field', `${label} `, parent);
  const s = el('select', undefined, undefined, l);
  for (const [v, t] of opts) {
    const o = el('option', undefined, t, s);
    o.value = v;
  }
  s.value = value;
  return s;
}

function describe(m: MapData): string {
  const warn = m.buildings.length < 30 ? ' Very few buildings here: missions may be thin.' : '';
  return `Map: ${m.name}: ${m.buildings.length} buildings, ${m.roads.length} roads, ${m.areas.length} parks and water, ${m.pois.length} landmarks.${warn}`;
}

/** Keep the busiest maps playable: drop the buildings furthest from the centre. */
function trim(m: MapData): MapData {
  if (m.buildings.length <= MAX_BUILDINGS) return m;
  const sorted = [...m.buildings].sort((a, b) => {
    const ca = centroid(a.pts);
    const cb = centroid(b.pts);
    return Math.hypot(ca.x, ca.z) - Math.hypot(cb.x, cb.z);
  });
  return { ...m, buildings: sorted.slice(0, MAX_BUILDINGS) };
}

/** Accepts this game's saved maps, or raw Overpass JSON exported from overpass-turbo. */
export function loadMapFile(data: unknown, filename: string): MapData {
  const d = data as Partial<MapData> & Partial<OverpassJson>;
  if (Array.isArray(d.buildings) && Array.isArray(d.roads) && typeof d.half === 'number') {
    if (!Number.isFinite(d.half) || d.half < 100 || d.half > 2000) throw new Error('map size out of range');
    const okPts = (p: unknown, min: number) =>
      Array.isArray(p) && p.length >= min && p.every((q) => q && Number.isFinite((q as V2).x) && Number.isFinite((q as V2).z));
    const buildings = d.buildings.filter((b) => okPts(b?.pts, 3)).map((b) => ({ ...b, height: Number.isFinite(b.height) ? b.height : 7 }));
    const roads = d.roads.filter((r) => okPts(r?.pts, 2)).map((r) => ({ ...r, width: Number.isFinite(r.width) ? r.width : 6 }));
    const areas = (d.areas ?? []).filter((a) => okPts(a?.pts, 3));
    const pois = (d.pois ?? []).filter((p) => p && Number.isFinite(p.p?.x) && Number.isFinite(p.p?.z));
    if (!roads.length) throw new Error('no usable roads');
    // Recon data (phase 2) is optional: older files simply don't have it.
    const okP = (p: unknown) => !!p && Number.isFinite((p as V2).x) && Number.isFinite((p as V2).z);
    const features = Array.isArray(d.features)
      ? d.features
          .filter((f) => f && typeof f.id === 'string' && FEATURE_CATEGORIES.includes(f.category) && okP(f.p))
          .map((f) => ({ id: f.id, category: f.category, p: f.p, ...(typeof f.name === 'string' ? { name: f.name } : {}), ...(okPts(f.pts, 3) ? { pts: f.pts } : {}) }))
      : undefined;
    const busRoutes = Array.isArray(d.busRoutes)
      ? d.busRoutes
          .filter((r) => r && typeof r.id === 'string' && Array.isArray(r.lines))
          .map((r) => ({ id: r.id, ref: typeof r.ref === 'string' ? r.ref : undefined, name: typeof r.name === 'string' ? r.name : undefined, lines: r.lines.filter((l) => okPts(l, 2)) }))
          .filter((r) => r.lines.length)
      : undefined;
    const pointsOf = (a: unknown) => (Array.isArray(a) ? (a.filter(okP) as V2[]) : undefined);
    // The credit is fixed: a file can't remove or change it.
    const sample = d.attribution === 'Procedurally generated sample town';
    return trim({
      name: String(d.name ?? filename).slice(0, 80), half: d.half, buildings, roads, areas, pois, attribution: sample ? d.attribution! : 'Map data © OpenStreetMap contributors (ODbL)',
      ...(features ? { features } : {}), ...(busRoutes ? { busRoutes } : {}),
      ...(pointsOf(d.trees) ? { trees: pointsOf(d.trees) } : {}), ...(pointsOf(d.lamps) ? { lamps: pointsOf(d.lamps) } : {}),
    });
  }
  if (Array.isArray(d.elements)) {
    let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;
    for (const e of d.elements) {
      const pts = e.geometry ?? (e.lat !== undefined && e.lon !== undefined ? [{ lat: e.lat, lon: e.lon }] : []);
      for (const p of pts) {
        minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
        minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
      }
    }
    if (!Number.isFinite(minLat)) throw new Error('no coordinates');
    const origin = { lat: (minLat + maxLat) / 2, lon: (minLon + maxLon) / 2 };
    const halfM = Math.min(HALF, ((maxLat - minLat) * 110574) / 2);
    return trim(parseOverpass(d as OverpassJson, origin, Math.max(200, halfM), filename.replace(/\.json$/i, '')));
  }
  throw new Error('missing buildings/roads or elements');
}
