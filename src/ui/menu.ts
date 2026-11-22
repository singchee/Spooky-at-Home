import type { MapData, V2 } from '../map/types';
import { FEATURE_CATEGORIES } from '../map/types';
import { makeSampleTown } from '../map/sample';
import { checkEnoughMap, classifyMapError, fetchOverpass, geocode, mapErrorMessage, parseOverpass, type OverpassJson } from '../map/overpass';
import { centroid } from '../map/geom';
import type { MissionType } from '../sim/missions';
import type { TemplateId } from '../map/recon';
import { el } from './dom';
import { showRecon, type SavedNote } from './recon';
import { placeCache, placeId, timeAgo } from './placeCache';

/**
 * Everything between the front page and a briefing:
 * - "scout": one big address box. Enter or "Scout it" builds the typed place, with a staged
 *   loading readout, a Cancel button and plain-English errors. Never quietly swaps in the sample town.
 * - "recon": what's in the area and three missions that suit it (see recon.ts).
 * - "custom": the manual form (map, mission type, difficulty, seed) for players who want to pick.
 */
export interface MenuChoice {
  map: MapData;
  type: MissionType | 'auto';
  difficulty: number;
  seed: number;
  /** Set when the mission was chosen on the recon screen. */
  template?: TemplateId;
  anchor?: string;
}

export type MenuMode = 'scout' | 'recon' | 'custom';

export interface MenuOptions {
  mode: MenuMode;
  /** The last mission's choices: its map, difficulty and seed carry over. */
  preset?: Partial<MenuChoice>;
  onFrontPage(): void;
}

const HALF = 600;
const MAX_BUILDINGS = 6000;

/** The scouting readout, in order. The third line gets the counts once the map is read. */
export const SCOUT_STAGES = ['Finding the place…', 'Downloading streets and buildings…', 'Reading the map…', 'Recon'] as const;

export function showMenu(parent: HTMLElement, onStart: (c: MenuChoice) => void, opts: MenuOptions): () => void {
  const root = el('div', 'menu', undefined, parent);
  // In the page flow (not floating), so it can never sit on top of a heading.
  const top = el('div', 'menu-top', undefined, root);
  const back = el('button', 'menu-back', '← Front page', top);

  let map: MapData | null = opts.preset?.map ?? null;

  // ---------- scout ----------
  const scout = el('section', 'card scout', undefined, root);
  el('div', 'card-kicker', 'SCOUT · YOUR NEIGHBOURHOOD', scout);
  el('h1', 'scout-title', 'Scout my neighbourhood', scout);
  el('p', 'scout-lede', 'Type an address, a street, a suburb or a town. We download the streets and buildings around it from OpenStreetMap and find missions that suit it.', scout);
  const form = el('form', 'scout-form', undefined, scout);
  form.setAttribute('role', 'search');
  const q = el('input', 'scout-input', undefined, form);
  q.type = 'text';
  q.placeholder = 'Street, suburb or town (or "lat, lon")';
  q.setAttribute('aria-label', 'Address, suburb, or latitude and longitude');
  q.autocomplete = 'off';
  q.spellcheck = false;
  q.setAttribute('enterkeyhint', 'go');
  const go = el('button', 'primary scout-go', 'Scout it', form);
  go.type = 'submit';

  const progress = el('div', 'scout-progress', undefined, scout);
  progress.hidden = true;
  progress.setAttribute('role', 'status');
  progress.setAttribute('aria-live', 'polite');
  const sweep = el('div', 'scout-sweep', undefined, progress);
  sweep.setAttribute('aria-hidden', 'true');
  el('span', undefined, undefined, sweep);
  const stageList = el('ol', 'scout-stages', undefined, progress);
  const stageItems = SCOUT_STAGES.map((t) => el('li', undefined, t, stageList));
  const placeLine = el('p', 'small scout-place', undefined, progress);
  const cancel = el('button', 'scout-cancel', 'Cancel', progress);
  cancel.type = 'button';

  const msg = el('div', 'scout-msg', undefined, scout);
  msg.hidden = true;
  const msgText = el('p', undefined, undefined, msg);

  const alt = el('div', 'row scout-alt', undefined, scout);
  const sampleBtn = el('button', 'scout-sample', 'Try the sample town', alt);
  const customBtn = el('button', 'scout-custom', 'Custom mission', alt);
  const fileLabel = el('label', 'filelabel', 'Load a saved map file', alt);
  const file = el('input', undefined, undefined, fileLabel);
  file.type = 'file';
  file.accept = '.json,application/json';
  el('p', 'small', 'Your search goes straight from your browser to OpenStreetMap. This game has no server. Places you scout are kept in this browser for 30 days so they open instantly next time; they are never sent anywhere. Saved map files stay on your computer.', scout);
  el('p', 'small', 'Plays with a mouse and keyboard, or with on-screen touch controls.', scout);
  el('p', 'attrib', 'Map data © OpenStreetMap contributors (ODbL) when a real place is used.', scout);

  // ---------- custom mission (the manual form) ----------
  const custom = el('section', 'card wide custom', undefined, root);
  el('div', 'card-kicker', 'CUSTOM MISSION', custom);
  el('h2', undefined, 'Pick it yourself', custom);
  el('h3', undefined, '1. The map', custom);
  const status = el('p', 'status custom-map', undefined, custom);
  const row1 = el('div', 'row', undefined, custom);
  const cSample = el('button', undefined, 'Sample town', row1);
  const cScout = el('button', undefined, 'Scout a place', row1);
  const cRecon = el('button', undefined, 'Suggested missions', row1);
  const saveBtn = el('button', undefined, 'Save this map to a file', row1);
  el('h3', undefined, '2. The mission', custom);
  const row3 = el('div', 'row', undefined, custom);
  const type = select(row3, 'Mission', [['auto', 'Surprise me'], ['clear', 'Clear the horde'], ['escort', 'Get them home'], ['defend', 'Hold the safehouse']], opts.preset?.type ?? 'escort');
  const diff = select(row3, 'Difficulty', [['1', '1 — Rookie'], ['2', '2'], ['3', '3 — Veteran'], ['4', '4'], ['5', '5 — Nightmare']], String(opts.preset?.difficulty ?? 2));
  const seedLabel = el('label', 'field', 'Seed ', row3);
  const seed = el('input', undefined, undefined, seedLabel);
  seed.type = 'number';
  seed.value = String(opts.preset?.seed ?? 1);
  const start = el('button', 'primary big', 'Brief me', custom);
  const customAttrib = el('p', 'attrib', undefined, custom);

  const seedValue = () => Math.max(1, Math.floor(Number(seed.value) || 1));
  const currentMap = () => (map ??= makeSampleTown());

  // ---------- switching screens ----------
  let closeRecon: (() => void) | null = null;
  /** The note under the recon heading for a place kept on this device (only for that map). */
  let savedNote: (SavedNote & { map: MapData }) | null = null;
  const show = (mode: MenuMode) => {
    closeRecon?.();
    closeRecon = null;
    root.dataset.mode = mode;
    scout.hidden = mode !== 'scout';
    custom.hidden = mode !== 'custom';
    if (mode === 'recon') {
      const m = currentMap();
      closeRecon = showRecon(root, m, { seed: seedValue(), difficulty: Number(diff.value) }, {
        onChoose: (s, d, sd) => onStart({ map: m, type: s.base, template: s.template, anchor: s.anchor?.id, difficulty: d, seed: sd }),
        onCustom: () => show('custom'),
        onBack: () => show('scout'),
      }, savedNote?.map === m ? savedNote : undefined);
    }
    if (mode === 'custom') {
      const m = currentMap();
      status.textContent = describe(m);
      customAttrib.textContent = m.attribution;
    }
    root.scrollTop = 0;
    if (mode === 'scout') q.focus({ preventScroll: true });
    else if (mode === 'recon') root.querySelector<HTMLButtonElement>('.mission-card button.primary')?.focus({ preventScroll: true });
    else start.focus({ preventScroll: true });
  };
  const toRecon = (m: MapData, note?: SavedNote) => {
    map = m;
    savedNote = note ? { ...note, map: m } : null;
    show('recon');
  };

  // ---------- scouting a typed place ----------
  let run = 0;
  let ctrl: AbortController | null = null;
  const setStage = (i: number, text?: string) => {
    stageItems.forEach((li, k) => {
      li.dataset.state = k < i ? 'done' : k === i ? 'active' : 'todo';
      if (k === i && text) li.textContent = text;
    });
  };
  const setBusy = (busy: boolean) => {
    progress.hidden = !busy;
    form.classList.toggle('busy', busy);
    q.disabled = busy;
    go.disabled = busy;
    if (busy) {
      msg.hidden = true;
      stageItems.forEach((li, k) => (li.textContent = SCOUT_STAGES[k]));
      placeLine.textContent = '';
    }
  };
  const say = (text: string, kind: 'error' | 'note') => {
    msg.hidden = false;
    msg.className = `scout-msg ${kind}`;
    // An error is announced at once; a note (e.g. "cancelled") politely.
    msg.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    msgText.textContent = text;
  };
  const stop = () => {
    run++;
    ctrl?.abort();
    ctrl = null;
    setBusy(false);
  };
  /** `refresh`: download this (already found) place again instead of using the copy on this device. */
  const scoutPlace = async (query: string, refresh?: { lat: number; lon: number; label: string }) => {
    const id = ++run;
    ctrl = new AbortController();
    const signal = ctrl.signal;
    setBusy(true);
    setStage(0);
    cancel.focus({ preventScroll: true });
    const cache = placeCache();
    try {
      // Scouted before on this device: no request to OpenStreetMap at all.
      let saved = refresh ? null : await cache.findByQuery(query);
      if (id !== run) return;
      const place = refresh ?? saved ?? (await geocode(query, signal));
      if (id !== run) return;
      // The same spot under another name: skip the big download (and remember this name too).
      if (!refresh && !saved) saved = await cache.findByCoords(place.lat, place.lon, query);
      if (id !== run) return;
      let json: OverpassJson;
      if (saved) {
        setStage(1, `Loaded from this device · downloaded ${timeAgo(Date.now() - saved.savedAt)}`);
        placeLine.textContent = `${place.label}.`;
        json = saved.json;
        await painted(400); // long enough to read where it came from
      } else {
        setStage(1);
        placeLine.textContent = `${place.label}. This can take 10 to 20 seconds.`;
        json = await fetchOverpass(place, HALF, signal);
      }
      if (id !== run) return;
      setStage(2);
      await painted();
      if (id !== run) return;
      const m = checkEnoughMap(trim(parseOverpass(json, place, HALF, place.label)));
      setStage(2, `Reading the map (${m.buildings.length.toLocaleString('en')} buildings, ${m.roads.length.toLocaleString('en')} roads)…`);
      // Keep a fresh download on this device (only a map good enough to fly over is worth keeping).
      const [, kept] = await Promise.all([painted(350), saved ? true : cache.save(query, place, json)]);
      if (id !== run) return;
      setStage(3);
      await painted();
      if (id !== run) return;
      ctrl = null;
      setBusy(false);
      toRecon(m, kept ? {
        fromDevice: !!saved,
        savedAt: saved?.savedAt ?? Date.now(),
        onRefresh: () => {
          show('scout');
          q.value = query;
          void scoutPlace(query, { lat: place.lat, lon: place.lon, label: place.label });
        },
        onForget: () => cache.forget(placeId(place.lat, place.lon)),
      } : undefined);
    } catch (e) {
      if (id !== run) return; // cancelled, or a newer search started
      ctrl = null;
      setBusy(false);
      say(mapErrorMessage(e), classifyMapError(e) === 'aborted' ? 'note' : 'error');
      q.focus({ preventScroll: true });
      q.select();
    }
  };
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (ctrl) return; // already scouting (e.g. Enter held down)
    const text = q.value.trim();
    if (!text) {
      say('Type an address, a suburb or a town first. Or try the sample town.', 'note');
      q.focus();
      return;
    }
    void scoutPlace(text);
  });
  cancel.addEventListener('click', () => {
    stop();
    say(mapErrorMessage(new DOMException('cancelled', 'AbortError')), 'note');
    q.focus({ preventScroll: true });
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ctrl) cancel.click();
  });
  const sample = () => {
    stop();
    toRecon(makeSampleTown());
  };
  sampleBtn.addEventListener('click', sample);
  customBtn.addEventListener('click', () => {
    stop();
    show('custom');
  });
  file.addEventListener('change', async () => {
    const f = file.files?.[0];
    if (!f) return;
    try {
      const m = loadMapFile(JSON.parse(await f.text()), f.name);
      stop();
      toRecon(m);
    } catch (e) {
      say(`That file isn't a map this game understands (${(e as Error).message}).`, 'error');
    } finally {
      file.value = '';
    }
  });

  // ---------- custom form actions ----------
  cSample.addEventListener('click', () => {
    map = makeSampleTown();
    status.textContent = describe(map);
    customAttrib.textContent = map.attribution;
  });
  cScout.addEventListener('click', () => show('scout'));
  cRecon.addEventListener('click', () => show('recon'));
  saveBtn.addEventListener('click', () => {
    const m = currentMap();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify(m)], { type: 'application/json' }));
    a.download = `${m.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.spooky-map.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  start.addEventListener('click', () => {
    // Always the map named above the button: there's no address box here to be ignored.
    onStart({ map: currentMap(), type: type.value as MenuChoice['type'], difficulty: Number(diff.value), seed: seedValue() });
  });

  back.addEventListener('click', () => {
    stop();
    opts.onFrontPage();
  });

  show(opts.mode);
  return () => {
    stop();
    closeRecon?.();
    root.remove();
  };
}

/** Let the browser draw the readout before the next (synchronous, sometimes slow) step. */
function painted(minMs = 0): Promise<void> {
  return new Promise((res) => {
    let done = false;
    const finish = () => {
      if (!done) {
        done = true;
        res();
      }
    };
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(finish, minMs)));
    setTimeout(finish, Math.max(200, minMs + 100)); // a hidden tab doesn't run animation frames
  });
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
