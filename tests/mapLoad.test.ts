import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  EXTRAS_LIMITS, LOAD_LIMITS, addExtras, classifyMapError, fetchOverpass, fetchOverpassTimed, joinParts, mapErrorMessage, parseOverpass,
  type DownloadProgress, type OverpassElement, type OverpassJson,
} from '../src/map/overpass';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { childZones, matchMissions } from '../src/map/recon';
import { generateMission } from '../src/sim/missions';
import { SpeakThrottle, WAITING_TEXT, formatBytes, formatClock, formatDuration, progressFraction, readout, timingLine } from '../src/ui/loadProgress';
import { PlaceCache, type PlaceStore } from '../src/ui/placeCache';

// BACKLOG 3.23 (two-part load), 3.20 (per-server time limits), 3.22 (timing line).

/** Saved public-place fixture (Adelaide CBD): a real answer to the old one-query download. */
function fixture(slug: string): { json: OverpassJson; origin: { lat: number; lon: number }; half: number } {
  const raw = JSON.parse(readFileSync(new URL(`../maps/fixtures/${slug}.json`, import.meta.url), 'utf8'));
  return { json: { elements: raw.elements }, origin: raw.spooky_fixture.origin, half: raw.spooky_fixture.half };
}

/** What the extras query asks for: trees, street lamps, bus routes. Everything else is core. */
const isExtra = (e: OverpassElement) =>
  e.type === 'node' ? e.tags?.natural === 'tree' || e.tags?.highway === 'street_lamp' : e.type === 'relation' && e.tags?.route === 'bus';

describe('two-part load: missions only ever use the core', () => {
  const { json, origin, half } = fixture('adelaide-cbd');
  const core: OverpassJson = { elements: json.elements.filter((e) => !isExtra(e)) };
  const extras: OverpassJson = { elements: json.elements.filter(isExtra) };
  const full = parseOverpass(json, origin, half, 'Adelaide');

  it('the fixture really has extras to test with', () => {
    expect(extras.elements.length).toBeGreaterThan(100);
    expect(full.trees!.length).toBeGreaterThan(100);
    expect(full.busRoutes!.length).toBeGreaterThan(0);
  });

  it('the core alone gives the same streets, buildings, places and protected zones as the full download', () => {
    const m = parseOverpass(core, origin, half, 'Adelaide');
    expect(m.buildings).toEqual(full.buildings);
    expect(m.roads).toEqual(full.roads);
    expect(m.areas).toEqual(full.areas);
    expect(m.pois).toEqual(full.pois);
    expect(m.features).toEqual(full.features);
    expect(childZones(m)).toEqual(childZones(full));
    expect(m.trees).toEqual([]);
    expect(m.busRoutes).toEqual([]);
  });

  it('extras arriving later add trees, lamps and bus routes, and change no suggestion or mission', () => {
    const m = parseOverpass(core, origin, half, 'Adelaide');
    const graph = buildRoadGraph(m);
    const walk = new WalkGrid(m);
    const before = matchMissions(m, 7, { count: 6 });
    const missions = (map: typeof m) => before.flatMap((s) => [1, 4].map((d) => generateMission(map, graph, walk, { type: s.base, difficulty: d, seed: 7, template: s.template, anchor: s.anchor?.id })));
    const missionsBefore = JSON.stringify(missions(m));
    const classics = JSON.stringify((['clear', 'escort', 'defend'] as const).map((t) => generateMission(m, graph, walk, { type: t, difficulty: 3, seed: 11 })));

    expect(addExtras(m, extras, origin)).toBe(m); // in place: a recon screen showing m sees them
    expect(m.trees).toEqual(full.trees);
    expect(m.lamps).toEqual(full.lamps);
    expect(m.busRoutes).toEqual(full.busRoutes);

    expect(matchMissions(m, 7, { count: 6 })).toEqual(before);
    expect(JSON.stringify(missions(m))).toBe(missionsBefore);
    // A fresh road graph and walk grid from the merged map agree too (nothing in them uses the extras).
    const g2 = buildRoadGraph(m);
    const w2 = new WalkGrid(m);
    expect(JSON.stringify((['clear', 'escort', 'defend'] as const).map((t) => generateMission(m, g2, w2, { type: t, difficulty: 3, seed: 11 })))).toBe(classics);
    expect(before.length).toBeGreaterThan(0);
  });

  it('joinParts keeps both parts and says so, so a saved place reloads complete', () => {
    const j = joinParts({ ...core, parts: ['core'] }, extras);
    expect(j.parts).toEqual(['core', 'extras']);
    expect(j.elements).toHaveLength(json.elements.length);
  });
});

// ---------- streaming and time limits, with fake timers ----------

const HOSTS = ['overpass-api.de', 'overpass.kumi.systems'];
const ok = { elements: [{ type: 'node', id: 1, lat: -10, lon: 100, tags: { amenity: 'hospital' } }] };
const enc = (s: string) => new TextEncoder().encode(s);

/** A Response whose body arrives in `chunks`, each after `gaps[i]` ms (stops when the request is aborted). */
function streamed(text: string, parts: number, gapMs: number, signal: AbortSignal, length: number | null = text.length): Response {
  const bytes = enc(text);
  const size = Math.ceil(bytes.length / parts);
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      return new Promise<void>((res, rej) => {
        const t = setTimeout(() => {
          if (i * size >= bytes.length) c.close();
          else c.enqueue(bytes.slice(i * size, ++i * size));
          res();
        }, i === 0 ? 0 : gapMs);
        signal.addEventListener('abort', () => {
          clearTimeout(t);
          rej(new DOMException('aborted', 'AbortError'));
        });
      });
    },
  });
  return new Response(body, { status: 200, headers: length ? { 'content-length': String(length) } : {} });
}

/** A request the server never answers (until it's aborted). */
const hang = (signal: AbortSignal) => new Promise<Response>((_, rej) => signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))));

interface Call { host: string; at: number; timeout: number }

function stubFetch(answer: (host: string, signal: AbortSignal, n: number) => Promise<Response>): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const host = new URL(url).host;
    const q = decodeURIComponent(String(init.body).slice(5));
    calls.push({ host, at: Date.now(), timeout: Number(/\[timeout:(\d+)\]/.exec(q)?.[1]) });
    return answer(host, init.signal!, calls.length);
  }));
  return calls;
}

describe('per-server time limits (3.20)', () => {
  const origin = { lat: -10, lon: 100 };
  beforeEach(() => vi.useFakeTimers({ now: 1_800_000_000_000 }));
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('a first server that never answers is left after 45 s for the second, one at a time', async () => {
    const t0 = Date.now();
    const calls = stubFetch((host, signal) => (host === HOSTS[0] ? hang(signal) : Promise.resolve(streamed(JSON.stringify(ok), 2, 100, signal))));
    const seen: DownloadProgress[] = [];
    const p = fetchOverpassTimed(origin, 500, undefined, { onProgress: (x) => seen.push({ ...x }) });
    await vi.advanceTimersByTimeAsync(44_000);
    expect(calls).toHaveLength(1); // never both at once
    await vi.advanceTimersByTimeAsync(2_000);
    const { json, stats } = await p;
    expect(json.elements).toHaveLength(1);
    expect(calls.map((c) => c.host)).toEqual(HOSTS);
    expect(calls[1].at - t0).toBe(LOAD_LIMITS.firstAnswerMs);
    // Overpass's own limit matches the wait: 45 s, then what's left of the 2 minutes.
    expect(calls.map((c) => c.timeout)).toEqual([45, 75]);
    expect(stats).toMatchObject({ host: HOSTS[1], attempts: 2 });
    expect(stats.waitMs).toBeGreaterThanOrEqual(45_000);
    expect(seen.find((s) => s.attempt === 1)?.movedOn).toBe("overpass-api.de didn't answer within 45 seconds");
  });

  it('when nobody answers, gives up after the overall limit with the plain-English "busy"', async () => {
    const t0 = Date.now();
    const calls = stubFetch((_h, signal) => hang(signal));
    const p = fetchOverpass(origin, 500).catch((e) => e);
    await vi.advanceTimersByTimeAsync(LOAD_LIMITS.overallWaitMs + 1_000);
    const e = await p;
    expect(classifyMapError(e)).toBe('busy');
    expect(mapErrorMessage(e)).toMatch(/busy right now\. Try again in a minute/);
    expect(calls).toHaveLength(2);
    expect(Date.now() - t0).toBeLessThanOrEqual(LOAD_LIMITS.overallWaitMs + 1_000);
  });

  it('a quick failure on the first server gives the second the rest of the budget', async () => {
    const calls = stubFetch((host, signal) => (host === HOSTS[0] ? Promise.reject(new TypeError('Failed to fetch')) : hang(signal)));
    const p = fetchOverpass(origin, 500).catch((e) => e);
    await vi.advanceTimersByTimeAsync(LOAD_LIMITS.overallWaitMs + 1_000);
    expect(classifyMapError(await p)).toBe('busy');
    expect(calls[1].timeout).toBe(120);
  });

  it('a slow download that keeps arriving is never cut off (a slow home connection still gets its map)', async () => {
    const text = JSON.stringify({ ...ok, pad: 'x'.repeat(2000) });
    stubFetch((_h, signal) => Promise.resolve(streamed(text, 20, 20_000, signal))); // 20 chunks, 20 s apart: ~6.5 minutes
    const p = fetchOverpassTimed(origin, 500);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const { stats } = await p;
    expect(stats.attempts).toBe(1);
    expect(stats.bytes).toBe(enc(text).length);
    expect(stats.downloadMs).toBeGreaterThan(6 * 60_000);
  });

  it('an answer that stops arriving for 30 s is given up on, and the next server is asked', async () => {
    const text = JSON.stringify(ok);
    const calls = stubFetch((host, signal) => Promise.resolve(streamed(text, 3, host === HOSTS[0] ? 999_999 : 10, signal)));
    const p = fetchOverpassTimed(origin, 500);
    await vi.advanceTimersByTimeAsync(LOAD_LIMITS.stallMs + 1_000);
    const { stats } = await p;
    expect(calls).toHaveLength(2);
    expect(stats.host).toBe(HOSTS[1]);
  });

  it('cancel stops at once while the server is still working, and asks no other server', async () => {
    const calls = stubFetch((_h, signal) => hang(signal));
    const ctrl = new AbortController();
    const p = fetchOverpass(origin, 500, ctrl.signal).catch((e) => e);
    await vi.advanceTimersByTimeAsync(10_000);
    ctrl.abort();
    expect(classifyMapError(await p)).toBe('aborted');
    await vi.advanceTimersByTimeAsync(LOAD_LIMITS.overallWaitMs);
    expect(calls).toHaveLength(1);
  });

  it('reports waiting, then bytes as they stream, with the announced size', async () => {
    const text = JSON.stringify({ ...ok, pad: 'x'.repeat(5000) });
    stubFetch((_h, signal) => Promise.resolve(streamed(text, 4, 500, signal)));
    const seen: DownloadProgress[] = [];
    const p = fetchOverpassTimed(origin, 500, undefined, { onProgress: (x) => seen.push({ ...x }) });
    await vi.advanceTimersByTimeAsync(5_000);
    await p;
    expect(seen[0]).toMatchObject({ stage: 'waiting', host: HOSTS[0], attempt: 0, bytes: 0 });
    const down = seen.filter((s) => s.stage === 'downloading');
    expect(down.length).toBeGreaterThanOrEqual(4);
    expect(down.every((s) => s.total === enc(text).length)).toBe(true);
    const bytes = down.map((s) => s.bytes);
    expect(bytes).toEqual([...bytes].sort((a, b) => a - b));
    expect(bytes.at(-1)).toBe(enc(text).length);
  });

  it('the extras ask the server that just answered first, and wait less', async () => {
    const calls = stubFetch((_h, signal) => hang(signal));
    const p = fetchOverpass(origin, 500, undefined, { part: 'extras', preferHost: HOSTS[1] }).catch((e) => e);
    await vi.advanceTimersByTimeAsync(EXTRAS_LIMITS.overallWaitMs + 1_000);
    expect(classifyMapError(await p)).toBe('busy');
    expect(calls.map((c) => c.host)).toEqual([HOSTS[1], HOSTS[0]]);
    expect(calls[0].timeout).toBe(EXTRAS_LIMITS.firstAnswerMs / 1000);
  });

  it('an unreadable answer is an error, never a crash', async () => {
    stubFetch((_h, signal) => Promise.resolve(streamed('<html>oops', 1, 10, signal)));
    const p = fetchOverpass(origin, 500).catch((e) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(classifyMapError(await p)).toBe('other');
  });
});

// ---------- the readout's words and numbers ----------

describe('progress maths (honest by rule)', () => {
  it('formats sizes and times', () => {
    expect(formatBytes(0)).toBe('0 KB');
    expect(formatBytes(300)).toBe('1 KB');
    expect(formatBytes(640_000)).toBe('640 KB');
    expect(formatBytes(2_400_000)).toBe('2.4 MB');
    expect(formatBytes(6_637_001)).toBe('6.6 MB');
    expect(formatClock(0)).toBe('0:00');
    expect(formatClock(7_900)).toBe('0:07');
    expect(formatClock(102_000)).toBe('1:42');
    expect(formatDuration(400)).toBe('0.4 s');
    expect(formatDuration(8_200)).toBe('8 s');
    expect(formatDuration(91_000)).toBe('1:31');
  });

  it('a fraction only when the size is known and the count fits inside it', () => {
    expect(progressFraction(500, 1000)).toBe(0.5);
    expect(progressFraction(1000, 1000)).toBe(1);
    expect(progressFraction(500, null)).toBeNull();
    expect(progressFraction(500, 0)).toBeNull();
    expect(progressFraction(1500, 1000)).toBeNull(); // a zipped answer announces its zipped size
  });

  it('says what is really happening: preparing, then bytes, then a fraction only if known', () => {
    const base: DownloadProgress = { stage: 'waiting', host: 'overpass-api.de', attempt: 0, bytes: 0, total: null };
    const w = readout(base, 30_000);
    expect(w).toMatchObject({ text: WAITING_TEXT, bar: 'waiting', fraction: null, server: 'Asking overpass-api.de' });
    expect(w.spoken).toMatch(/30 seconds so far/);
    const b = readout({ ...base, stage: 'downloading', bytes: 2_400_000 }, 40_000);
    expect(b).toMatchObject({ text: 'Downloading… 2.4 MB', bar: 'bytes', fraction: null, server: 'overpass-api.de is answering' });
    expect(b.text).not.toMatch(/%/);
    const d = readout({ ...base, stage: 'downloading', bytes: 2_400_000, total: 4_800_000 }, 40_000);
    expect(d).toMatchObject({ text: 'Downloading… 2.4 MB of 4.8 MB', bar: 'determinate', fraction: 0.5 });
    const z = readout({ ...base, stage: 'downloading', bytes: 9_000_000, total: 4_800_000 }, 40_000);
    expect(z).toMatchObject({ bar: 'bytes', fraction: null, text: 'Downloading… 9.0 MB' });
    const f = readout({ ...base, host: 'overpass.kumi.systems', attempt: 1, movedOn: "overpass-api.de didn't answer within 45 seconds" }, 46_000);
    expect(f.server).toBe("Overpass-api.de didn't answer within 45 seconds, so now asking overpass.kumi.systems");
  });

  it('screen readers hear a change of stage at once, and otherwise at most every so often', () => {
    const s = new SpeakThrottle(20_000);
    expect(s.ready('waiting:0', 0)).toBe(true);
    expect(s.ready('waiting:0', 5_000)).toBe(false);
    expect(s.ready('downloading:0', 6_000)).toBe(true);
    expect(s.ready('downloading:0', 6_250)).toBe(false); // not every chunk
    expect(s.ready('downloading:0', 26_000)).toBe(true);
  });

  it('the owner\'s timing line', () => {
    expect(timingLine({ totalMs: 102_000, serverMs: 91_000, downloadMs: 8_200, buildMs: 2_100, host: 'overpass-api.de' }))
      .toBe('Loaded in 1:42 (server 1:31, download 8 s, build 2 s) from overpass-api.de');
  });
});

describe('saved place: the extras update it only while it is still saved', () => {
  class Store implements PlaceStore {
    data = new Map<string, unknown>();
    async get(k: string) { return structuredClone(this.data.get(k)); }
    async set(k: string, v: unknown) { this.data.set(k, structuredClone(v)); }
    async delete(k: string) { this.data.delete(k); }
    async clear() { this.data.clear(); }
  }
  const place = { lat: -10, lon: 100, label: 'Test Reef' };
  const core: OverpassJson = { elements: [{ type: 'way', id: 1, tags: { building: 'house' }, geometry: [{ lat: -10, lon: 100 }] }], parts: ['core'] };
  const extras: OverpassJson = { elements: [{ type: 'node', id: 2, lat: -10, lon: 100, tags: { natural: 'tree' } }] };

  it('replaces the core-only copy, keeping when it was downloaded', async () => {
    let now = 1_800_000_000_000;
    const cache = new PlaceCache(new Store(), { now: () => now });
    expect(await cache.save('Test Reef', place, core)).toBe(true);
    now += 60_000;
    expect(await cache.update(place.lat, place.lon, joinParts(core, extras))).toBe(true);
    const got = await cache.findByQuery('test reef');
    expect(got?.json.parts).toEqual(['core', 'extras']);
    expect(got?.json.elements).toHaveLength(2);
    expect(got?.savedAt).toBe(1_800_000_000_000);
  });

  it('a place forgotten before its extras came stays forgotten', async () => {
    const cache = new PlaceCache(new Store());
    await cache.save('Test Reef', place, core);
    await cache.forget('-10.0000,100.0000');
    expect(await cache.update(place.lat, place.lon, joinParts(core, extras))).toBe(false);
    expect(await cache.findByQuery('Test Reef')).toBeNull();
    expect(await new PlaceCache(null).update(place.lat, place.lon, core)).toBe(false);
  });
});
