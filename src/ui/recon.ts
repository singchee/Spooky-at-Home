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

/**
 * "Recon complete": what's in the area, a tactical map, and three missions that suit it.
 * Choosing one goes to the usual briefing; "Custom mission" goes back to the manual controls.
 */
export interface ReconHandlers {
  onChoose(s: MissionSuggestion, difficulty: number, seed: number): void;
  onCustom(): void;
  onBack(): void;
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

export function showRecon(parent: HTMLElement, map: MapData, start: { seed: number; difficulty: number }, h: ReconHandlers, saved?: SavedNote): () => void {
  const root = el('div', 'card wide recon', undefined, parent);
  const report = reconMap(map);
  el('div', 'card-kicker', report.empty ? 'RECON · NOTHING NOTABLE' : 'RECON COMPLETE', root);
  el('h2', undefined, map.name, root);
  el('p', 'status', report.message, root);
  if (saved) savedLine(root, saved);

  const grid = el('div', 'recon-grid', undefined, root);
  const mapBox = el('div', 'tmap-wrap recon-map', undefined, grid);
  // A first guess at the map's width; it measures its real width on screen and redraws, so text stays 14 px or more.
  const tm = new TacticalMap(map, { size: Math.max(300, Math.min(600, window.innerWidth - 72)), label: `Tactical map of ${map.name}` });
  mapBox.appendChild(tm.svg);

  const side = el('div', 'recon-side', undefined, grid);
  el('h3', undefined, 'Found in the area', side);
  const list = el('ul', 'recon-list', undefined, side);
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
  el('p', 'small', extras.join(' · '), side);

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
      const best = bests().get(bestKey(map.name, missionKind(s.template, s.base), d));
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

  const foot = el('div', 'row', undefined, root);
  el('button', 'recon-custom', 'Custom mission', foot).addEventListener('click', () => h.onCustom());
  el('button', 'recon-change', 'Scout another place', foot).addEventListener('click', () => h.onBack());
  el('p', 'attrib', map.attribution, root);
  return () => root.remove();
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
