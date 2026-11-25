import { afterEach, describe, expect, it, vi } from 'vitest';
import { MapLoadError, checkEnoughMap, classifyMapError, fetchOverpass, geocode, mapErrorMessage, type MapErrorKind } from '../src/map/overpass';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { generateMission } from '../src/sim/missions';
import { matchMissions } from '../src/map/recon';
import { rankedSuggestions, setCount, suggestionSet } from '../src/ui/suggestions';
import type { MapData } from '../src/map/types';

// The way in from the front page (BACKLOG 2.8, 2.9): plain-English errors and "Other suggestions".
// No real network: fetch is stubbed. Test coordinates are in the open ocean.
const origin = { lat: -10.0, lon: 100.0 };
const json = (body: unknown, status = 200) => ({ ok: status < 400, status, json: async () => body }) as unknown as Response;
const offline = () => Promise.reject(new TypeError('Failed to fetch'));

describe('map errors in plain English', () => {
  afterEach(() => vi.unstubAllGlobals());

  const kinds: MapErrorKind[] = ['offline', 'busy', 'not-found', 'bad-coords', 'too-little', 'aborted', 'other'];

  it('never shows the browser\'s own error text, and every kind has its own message', () => {
    const seen = new Set<string>();
    for (const k of kinds) {
      const m = mapErrorMessage(new MapLoadError(k, 'TypeError: Failed to fetch'));
      expect(m).not.toMatch(/failed to fetch|typeerror|networkerror|\b[45]\d\d\b/i);
      seen.add(m);
    }
    expect(seen.size).toBe(kinds.length);
    expect(mapErrorMessage(new TypeError('Failed to fetch'))).not.toMatch(/failed to fetch/i);
  });

  it('says exactly what the backlog asks for when OpenStreetMap is unreachable', () => {
    expect(mapErrorMessage(new TypeError('Failed to fetch'))).toBe("Couldn't reach OpenStreetMap. Check your connection, or try the sample town.");
    expect(classifyMapError(new TypeError('NetworkError when attempting to fetch resource.'))).toBe('offline');
    expect(classifyMapError(new TypeError('Load failed'))).toBe('offline');
  });

  it('suggests waiting a minute only when the server is busy, never for bad coordinates', () => {
    expect(mapErrorMessage(new MapLoadError('busy', 'x'))).toMatch(/try again in a minute/i);
    const bad = mapErrorMessage(new MapLoadError('bad-coords', 'x'));
    expect(bad).toMatch(/^That isn't a real latitude\/longitude/);
    expect(bad).not.toMatch(/minute/i);
    for (const k of kinds.filter((x) => x !== 'busy')) expect(mapErrorMessage(new MapLoadError(k, 'x'))).not.toMatch(/minute/i);
  });

  it('counts what was found when there is too little map', () => {
    const m = mapErrorMessage(new MapLoadError('too-little', 'x', { buildings: 1, roads: 0 }));
    expect(m).toMatch(/too little/i);
    expect(m).toContain('1 building and 0 roads');
  });

  it('an AbortError is a cancel, not a failure', () => {
    expect(classifyMapError(new DOMException('stop', 'AbortError'))).toBe('aborted');
    expect(mapErrorMessage(new DOMException('stop', 'AbortError'))).toBe('Scouting cancelled.');
  });

  it('a programming slip is not mistaken for being offline', () => {
    expect(classifyMapError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe('other');
  });

  it('geocode: out-of-range coordinates are bad-coords, with no network call', async () => {
    const f = vi.fn(offline);
    vi.stubGlobal('fetch', f);
    const e = await geocode('91, 200').catch((x) => x);
    expect(classifyMapError(e)).toBe('bad-coords');
    expect(f).not.toHaveBeenCalled();
  });

  it('geocode: the map is named after the neighbourhood, never the house number typed (privacy)', async () => {
    // Made-up answers in the open ocean, shaped like Nominatim's (addressdetails=1).
    const answers = [
      { lat: '-10', lon: '100', display_name: '12, Kelp Street, Test Reef, Open Ocean, 9999, Nowhere', address: { house_number: '12', road: 'Kelp Street', suburb: 'Test Reef', state: 'Open Ocean', postcode: '9999', country: 'Nowhere' } },
      { lat: '-10', lon: '100', display_name: '12A, Kelp Street, Coral Town, Nowhere', address: { house_number: '12A', road: 'Kelp Street', town: 'Coral Town', country: 'Nowhere' } },
      { lat: '-10', lon: '100', display_name: '12, Kelp Street, Nowhere', address: { house_number: '12', road: 'Kelp Street', country: 'Nowhere' } },
      { lat: '-10', lon: '100', display_name: '12, Kelp Street, Test Reef, 9999, Nowhere' }, // no address details at all
      { lat: '-10', lon: '100', display_name: '12/4, 77, 9999' }, // nothing safe left: coordinates
    ];
    const labels: string[] = [];
    let urls = '';
    for (const a of answers) {
      vi.stubGlobal('fetch', vi.fn(async (u: string) => ((urls += u), json([a]))));
      labels.push((await geocode('12 Kelp Street, Test Reef')).label);
    }
    expect(labels).toEqual(['Test Reef, Open Ocean', 'Coral Town, Nowhere', 'Kelp Street, Nowhere', 'Kelp Street, Test Reef', '-10.0000, 100.0000']);
    for (const l of labels) expect(l).not.toMatch(/\b12A?\b|9999/);
    expect(urls).toContain('addressdetails=1');
  }, 15_000);

  it('geocode: unreachable, nothing found, busy', async () => {
    vi.stubGlobal('fetch', vi.fn(offline));
    expect(classifyMapError(await geocode('Nowhere Lane').catch((x) => x))).toBe('offline');
    vi.stubGlobal('fetch', vi.fn(async () => json([])));
    expect(classifyMapError(await geocode('Nowhere Lane').catch((x) => x))).toBe('not-found');
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: 'slow down' }, 429)));
    expect(classifyMapError(await geocode('Nowhere Lane').catch((x) => x))).toBe('busy');
  }, 10_000);

  it('fetchOverpass: offline everywhere, busy anywhere, or a gateway timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(offline));
    expect(classifyMapError(await fetchOverpass(origin, 500).catch((x) => x))).toBe('offline');
    let n = 0;
    vi.stubGlobal('fetch', vi.fn(async () => (++n === 1 ? json({ elements: [], remark: 'runtime error: Query timed out' }) : offline())));
    expect(classifyMapError(await fetchOverpass(origin, 500).catch((x) => x))).toBe('busy');
    vi.stubGlobal('fetch', vi.fn(async () => json('', 504)));
    expect(classifyMapError(await fetchOverpass(origin, 500).catch((x) => x))).toBe('busy');
    vi.stubGlobal('fetch', vi.fn(async () => json({ nonsense: true })));
    expect(classifyMapError(await fetchOverpass(origin, 500).catch((x) => x))).toBe('other');
  });

  it('fetchOverpass: a cancel stops at once and stays a cancel', async () => {
    const ctrl = new AbortController();
    const f = vi.fn(async () => {
      ctrl.abort();
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });
    vi.stubGlobal('fetch', f);
    expect(classifyMapError(await fetchOverpass(origin, 500, ctrl.signal).catch((x) => x))).toBe('aborted');
    expect(f).toHaveBeenCalledTimes(1); // didn't go on to the second server
  });

  it('checkEnoughMap: an empty patch is too little; the sample town is plenty', () => {
    const empty: MapData = { ...makeSampleTown(), buildings: [], roads: [] };
    expect(() => checkEnoughMap(empty)).toThrow(MapLoadError);
    expect(classifyMapError((() => { try { checkEnoughMap(empty); } catch (e) { return e; } })())).toBe('too-little');
    const town = makeSampleTown();
    expect(checkEnoughMap(town)).toBe(town);
  });
});

describe('"Other suggestions" cycles through the ranked list', () => {
  const map = makeSampleTown();
  const graph = buildRoadGraph(map);
  const walk = new WalkGrid(map);
  const accept = (seed: number, d: number) => (s: { base: 'clear' | 'escort' | 'defend'; template: string; anchor?: { id: string } }) =>
    generateMission(map, graph, walk, { type: s.base, difficulty: d, seed, template: s.template as never, anchor: s.anchor?.id }).ok;

  it('suggestionSet wraps, and consecutive sets always differ', () => {
    for (let L = 1; L <= 13; L++) {
      const list = Array.from({ length: L }, (_, i) => i);
      const n = setCount(L);
      if (L <= 3) {
        expect(n).toBe(1);
        expect(suggestionSet(list, 5)).toEqual(list);
        continue;
      }
      const seen = new Set<number>();
      for (let p = 0; p < n; p++) {
        const a = suggestionSet(list, p);
        const b = suggestionSet(list, p + 1);
        expect(a).toHaveLength(3);
        expect(new Set(a).size).toBe(3);
        expect([...a].sort().join()).not.toBe([...b].sort().join());
        a.forEach((x) => seen.add(x));
      }
      expect(seen.size).toBe(L); // one full cycle shows every suggestion
      expect(suggestionSet(list, n)).toEqual(suggestionSet(list, 0)); // and then starts again
    }
  });

  it('on the sample town, each click shows missions not on the previous set, and the first set is the usual top three', () => {
    for (const seed of [1, 2, 7]) {
      const ranked = rankedSuggestions(map, seed, accept(seed, 2));
      expect(ranked.length).toBeGreaterThan(3);
      expect(ranked.slice(0, 3).map((s) => s.template)).toEqual(matchMissions(map, seed, { accept: accept(seed, 2) }).map((s) => s.template));
      const sets = Array.from({ length: setCount(ranked.length) + 1 }, (_, p) => suggestionSet(ranked, p).map((s) => s.template));
      for (let p = 1; p < sets.length; p++) {
        const fresh = sets[p].filter((t) => !sets[p - 1].includes(t));
        expect(fresh.length).toBeGreaterThan(0);
      }
      // Every template appears once per cycle, no duplicates in the ranked list.
      expect(new Set(ranked.map((s) => s.template)).size).toBe(ranked.length);
    }
  });

  it('is deterministic per seed', () => {
    const a = rankedSuggestions(map, 4, accept(4, 3)).map((s) => s.template);
    const b = rankedSuggestions(map, 4, accept(4, 3)).map((s) => s.template);
    expect(a).toEqual(b);
  });
});
