import type { MapData } from '../map/types';
import { buildRoadGraph } from '../map/roadGraph';
import { WalkGrid } from '../map/grid';
import { CATEGORY_INFO, reconMap, type MissionSuggestion } from '../map/recon';
import { rankedSuggestions, setCount, suggestionSet } from './suggestions';
import { generateMission } from '../sim/missions';
import { TacticalMap } from './tacticalMap';
import { el } from './dom';
import { bestKey, bests, formatBest, missionKind } from './bests';
import { timeAgo } from './placeCache';
import { generateCrowd, type CrowdSize } from '../sim/crowd';
import { mapFingerprint } from '../sim/campaign';
import { crowdBestKey, crowdBests } from './crowdBests';

/**
 * "Recon complete": what's in the area, a tactical map, and three missions that suit it.
 * Choosing one goes to the usual briefing; "Custom mission" goes back to the manual controls.
 */
export interface ReconHandlers {
  onChoose(s: MissionSuggestion, difficulty: number, seed: number): void;
  onCustom(): void;
  onBack(): void;
  /** Spec 003: fly a crowd night on this map at this size. */
  onCrowd?(size: CrowdSize, seed: number): void;
}

/** The crowd size a device starts on (spec 003 §4): tablets and phones Big, desktops Huge. The player can change it. */
export function defaultCrowdSize(): CrowdSize {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches ? 'big' : 'huge';
  } catch {
    return 'huge';
  }
}

/** A place kept on this device (BACKLOG 3.12): say so, and offer Refresh and Forget. */
export interface SavedNote {
  /** True when this visit loaded it from the device; false when it was just downloaded and kept. */
  fromDevice: boolean;
  /** When it was downloaded (ms since 1970). */
  savedAt: number;
  onRefresh(): void;
  /** Resolves false if the browser refused. */
  onForget(): Promise<boolean>;
}

const BASE_LABEL = { clear: 'CLEAR', escort: 'ESCORT', defend: 'HOLD' } as const;

/** The recon screen, with hooks for the map's extras arriving later (BACKLOG 3.23). */
export interface ReconView {
  close(): void;
  /**
   * The extras (trees, lamps, bus routes): 'pending' says they're on the way; 'added' redraws the
   * tactical map and the counts from the (updated) map; 'failed' quietly drops the note.
   * Suggested missions never change: they don't use the extras.
   */
  extras(state: 'pending' | 'added' | 'failed'): void;
  /** A small line for the owner: how long the load took (in memory only, BACKLOG 3.22). */
  timing(text: string): void;
}

export function showRecon(parent: HTMLElement, map: MapData, start: { seed: number; difficulty: number }, h: ReconHandlers, saved?: SavedNote): ReconView {
  const root = el('div', 'card wide recon', undefined, parent);
  let report = reconMap(map);
  el('div', 'card-kicker', report.empty ? 'RECON · NOTHING NOTABLE' : 'RECON COMPLETE', root);
  el('h2', undefined, map.name, root);
  const statusLine = el('p', 'status', report.message, root);
  if (saved) savedLine(root, saved);

  const grid = el('div', 'recon-grid', undefined, root);
  const mapBox = el('div', 'tmap-wrap recon-map', undefined, grid);
  // A first guess at the map's width; it measures its real width on screen and redraws, so text stays 14 px or more.
  const tm = new TacticalMap(map, { size: Math.max(300, Math.min(600, window.innerWidth - 72)), label: `Tactical map of ${map.name}` });
  mapBox.appendChild(tm.svg);

  const side = el('div', 'recon-side', undefined, grid);
  el('h3', undefined, 'Found in the area', side);
  const found = el('div', 'recon-found', undefined, side);
  const extrasNote = el('p', 'small recon-extras', undefined, side);
  extrasNote.hidden = true;
  const timingNote = el('p', 'small recon-timing', undefined, side);
  timingNote.hidden = true;
  drawFound(found, report);

  el('h3', undefined, 'Suggested missions', root);
  const ctrl = el('div', 'row', undefined, root);
  const diffLabel = el('label', 'field', 'Difficulty ', ctrl);
  const diff = el('select', undefined, undefined, diffLabel);
  for (const [v, t] of [['1', '1 — Rookie'], ['2', '2'], ['3', '3 — Veteran'], ['4', '4'], ['5', '5 — Nightmare']]) {
    const o = el('option', undefined, t, diff);
    o.value = v;
  }
  diff.value = String(start.difficulty);
  const more = el('button', 'recon-more', 'Other suggestions', ctrl);
  const setLabel = el('span', 'small recon-set', undefined, ctrl);
  setLabel.setAttribute('aria-live', 'polite');
  const cards = el('div', 'recon-cards', undefined, root);

  const graph = buildRoadGraph(map);
  const walk = new WalkGrid(map);
  const seed = start.seed;
  // Every mission this map allows, best first; "Other suggestions" steps through them a few at a time.
  let ranked: MissionSuggestion[] = [];
  let rankedFor = NaN;
  let page = 0;
  const render = () => {
    const d = Number(diff.value);
    if (rankedFor !== d) {
      // Only offer missions the generator can actually build here, at this difficulty.
      const accept = (s: MissionSuggestion) => {
        try {
          return generateMission(map, graph, walk, { type: s.base, difficulty: d, seed, template: s.template, anchor: s.anchor?.id }).ok;
        } catch {
          return false;
        }
      };
      ranked = rankedSuggestions(map, seed, accept);
      rankedFor = d;
    }
    const sets = setCount(ranked.length);
    const picks = suggestionSet(ranked, page);
    more.disabled = sets < 2;
    setLabel.textContent = sets > 1 ? `Set ${(page % sets) + 1} of ${sets}` : '';
    cards.replaceChildren();
    if (!picks.length) {
      el('p', 'status', "Recon couldn't fit a mission here: there aren't enough connected roads. Try a more built-up spot, or the sample town.", cards);
    }
    picks.forEach((s, i) => {
      const card = el('div', 'mission-card', undefined, cards);
      el('span', `mc-type t-${s.base}`, BASE_LABEL[s.base], card);
      el('h4', undefined, s.title, card);
      el('p', undefined, s.why, card);
      // Personal best on this map, mission and difficulty (stored in this browser only).
      const bfp = mapFingerprint(map);
      bests().migrate(map.name, bfp);
      const best = bests().get(bestKey(bfp, missionKind(s.template, s.base), d));
      el('p', best ? 'mc-best' : 'mc-best none', best ? formatBest(best) : 'Not flown yet', card);
      const go = el('button', i === 0 ? 'primary' : undefined, 'Brief me', card);
      go.addEventListener('click', () => h.onChoose(s, d, seed));
      if (s.anchor) {
        const id = s.anchor.id;
        card.addEventListener('mouseenter', () => tm.setHighlight(id));
        card.addEventListener('mouseleave', () => tm.setHighlight(null));
        go.addEventListener('focus', () => tm.setHighlight(id));
        go.addEventListener('blur', () => tm.setHighlight(null));
      }
    });
  };
  render();
  diff.addEventListener('change', () => {
    page = 0;
    render();
  });
  more.addEventListener('click', () => {
    page += 1;
    render();
  });

  if (h.onCrowd) crowdEntry(root, map, graph, walk, seed, h.onCrowd);

  const foot = el('div', 'row', undefined, root);
  el('button', 'recon-custom', 'Custom mission', foot).addEventListener('click', () => h.onCustom());
  el('button', 'recon-change', 'Scout another place', foot).addEventListener('click', () => h.onBack());
  el('p', 'attrib', map.attribution, root);
  return {
    close: () => root.remove(),
    extras(state) {
      if (state === 'pending') {
        extrasNote.hidden = false;
        extrasNote.textContent = 'Trees, street lamps and bus routes are still on their way. Missions are ready now.';
      } else if (state === 'added') {
        report = reconMap(map);
        statusLine.textContent = report.message;
        drawFound(found, report);
        tm.redraw();
        extrasNote.hidden = false;
        extrasNote.textContent = 'Trees, street lamps and bus routes added.';
      } else {
        extrasNote.hidden = true; // the game is the same without them: nothing to worry the player with
      }
    },
    timing(text) {
      timingNote.hidden = false;
      timingNote.textContent = text;
    },
  };
}

/**
 * Spec 003: the crowd night's entry, below the suggested missions (the story stays the front door). Always offered
 * where the map allows it; where it doesn't, the generator's own reason. "Horde Night" is a working title.
 */
function crowdEntry(root: HTMLElement, map: MapData, graph: ReturnType<typeof buildRoadGraph>, walk: WalkGrid, seed: number, go: (size: CrowdSize, seed: number) => void): void {
  const box = el('div', 'recon-crowd', undefined, root);
  el('h3', undefined, 'Horde Night', box);
  el('p', undefined, 'Five minutes. Thousands of them. Just shooting.', box);
  let check: ReturnType<typeof generateCrowd>;
  try {
    check = generateCrowd(map, graph, walk, { seed, size: 'big' });
  } catch (e) {
    check = { ok: false, reason: `Couldn't plan a Horde Night here (${(e as Error).message}).` };
  }
  if (!check.ok) {
    el('p', 'small recon-crowd-reason', check.reason, box);
    return;
  }
  el('p', 'small', `At ${check.mission.safehouse!.name}, till dawn.`, box);
  const row = el('div', 'row recon-crowd-row', undefined, box);
  const group = el('div', 'recon-crowd-size', undefined, row);
  group.setAttribute('role', 'radiogroup');
  group.setAttribute('aria-label', 'Crowd size');
  let size = defaultCrowdSize();
  const best = el('p', 'small mc-best', '', box);
  const fp = mapFingerprint(map);
  const showBest = () => {
    const b = crowdBests().get(crowdBestKey(fp, size));
    best.textContent = b ? `Best on ${size === 'big' ? 'Big' : 'Huge'}: ${b.score.toLocaleString('en-AU')} (${b.kills.toLocaleString('en-AU')} kills)` : 'Not flown yet at this size';
  };
  for (const [id, label, note] of [['big', 'Big', 'up to 600 at once · for tablets'], ['huge', 'Huge', 'up to 800 at once · for desktops']] as const) {
    const lab = el('label', 'recon-crowd-opt', undefined, group);
    const input = el('input', undefined, undefined, lab);
    input.type = 'radio';
    input.name = 'crowd-size';
    input.value = id;
    input.checked = id === size;
    input.addEventListener('change', () => {
      size = id;
      showBest();
    });
    el('span', undefined, ` ${label} `, lab);
    el('span', 'small', note, lab);
  }
  showBest();
  el('button', 'recon-crowd-go', 'Fly Horde Night', row).addEventListener('click', () => go(size, seed));
}

/** "Found in the area": the places, bus routes, and the counts. Drawn again when the extras arrive. */
function drawFound(box: HTMLElement, report: ReturnType<typeof reconMap>): void {
  box.replaceChildren();
  const list = el('ul', 'recon-list', undefined, box);
  if (!report.categories.length) el('li', 'small', 'No schools, sports grounds, parks, shops or stations are mapped here.', list);
  for (const c of report.categories) {
    const li = el('li', undefined, undefined, list);
    el('span', `recon-code fam-${familyOf(c.category)}`, CATEGORY_INFO[c.category].code, li);
    const txt = el('span', 'recon-text', undefined, li);
    el('span', 'recon-count', c.text, txt);
    if (c.names.length) el('span', 'recon-names', c.names.join(' · '), txt);
  }
  if (report.busRoutes.length) {
    const li = el('li', undefined, undefined, list);
    el('span', 'recon-code fam-transport', 'BUS', li);
    const txt = el('span', 'recon-text', undefined, li);
    el('span', 'recon-count', `${report.busRoutes.length} bus route${report.busRoutes.length === 1 ? '' : 's'}`, txt);
    const refs = report.busRoutes.map((r) => r.ref).filter((r): r is string => !!r).slice(0, 6);
    if (refs.length) el('span', 'recon-names', `${refs.length === 1 ? 'Route' : 'Routes'} ${refs.join(', ')}`, txt);
  }
  const extras: string[] = [`${report.buildings} buildings`, `${report.roads} roads`];
  if (report.trees) extras.push(`${report.trees} mapped trees`);
  if (report.lamps) extras.push(`${report.lamps} street lamps`);
  el('p', 'small recon-counts', extras.join(' · '), box);
}

/** "Loaded from this device · downloaded 3 days ago · Refresh · Forget this place", and a plain privacy note. */
function savedLine(parent: HTMLElement, s: SavedNote): void {
  const box = el('div', 'recon-saved', undefined, parent);
  const line = el('p', 'small', undefined, box);
  line.setAttribute('aria-live', 'polite');
  const text = el('span', 'recon-saved-text', s.fromDevice ? `Loaded from this device · downloaded ${timeAgo(Date.now() - s.savedAt)}` : 'Saved on this device, so next time it opens instantly', line);
  const buttons: HTMLButtonElement[] = [];
  if (s.fromDevice) {
    const refresh = el('button', 'recon-refresh', 'Refresh', line);
    refresh.type = 'button';
    refresh.title = 'Download this place again from OpenStreetMap';
    refresh.addEventListener('click', () => s.onRefresh());
    buttons.push(refresh);
  }
  const forget = el('button', 'recon-forget', 'Forget this place', line);
  forget.type = 'button';
  buttons.push(forget);
  el('p', 'small recon-saved-privacy', 'Saved places stay in this browser for 30 days and are never sent anywhere.', box);
  forget.addEventListener('click', async () => {
    forget.disabled = true;
    const ok = await s.onForget();
    if (ok) {
      buttons.forEach((b) => b.remove());
      text.textContent = 'Forgotten. Next time this place downloads fresh from OpenStreetMap.';
      text.tabIndex = -1;
      text.focus({ preventScroll: true }); // the button that had focus is gone
    } else {
      forget.disabled = false;
      text.textContent = "This browser wouldn't let the game forget it. Try Settings, Forget all saved places.";
    }
  });
}

function familyOf(c: string): string {
  if (['school', 'kindergarten', 'hospital', 'police', 'fire_station'].includes(c)) return 'civic';
  if (['park', 'forest'].includes(c)) return 'green';
  if (['supermarket', 'mall', 'parking'].includes(c)) return 'shop';
  if (['train_station', 'bus_station'].includes(c)) return 'transport';
  return 'sport';
}
