import { describe, expect, it } from 'vitest';
import { MAX_AGE_MS, PlaceCache, normaliseQuery, placeId, queryKey, timeAgo, type PlaceStore } from '../src/ui/placeCache';
import type { OverpassJson } from '../src/map/overpass';

// Places remembered on this device (BACKLOG 3.12). A fake store stands in for IndexedDB.
// Test coordinates are in the open ocean: never anyone's street.

class FakeStore implements PlaceStore {
  data = new Map<string, unknown>();
  calls = 0;
  async get(k: string) {
    this.calls++;
    return structuredClone(this.data.get(k));
  }
  async set(k: string, v: unknown) {
    this.calls++;
    this.data.set(k, structuredClone(v));
  }
  async delete(k: string) {
    this.calls++;
    this.data.delete(k);
  }
  async clear() {
    this.calls++;
    this.data.clear();
  }
}

/** A store that refuses everything, like a locked-down private window. */
const throwing: PlaceStore = {
  get: () => Promise.reject(new DOMException('denied', 'SecurityError')),
  set: () => Promise.reject(new DOMException('full', 'QuotaExceededError')),
  delete: () => Promise.reject(new Error('nope')),
  clear: () => Promise.reject(new Error('nope')),
};

const DAY = 24 * 3600 * 1000;
const ocean = (k: number) => ({ lat: -10 - k * 0.01, lon: 100 + k * 0.01, label: `Test Reef ${k}` });
const town = (n = 3, pad = 0): OverpassJson => ({
  elements: [
    ...Array.from({ length: n }, (_, i) => ({ type: 'way' as const, id: i + 1, tags: { building: 'house' }, geometry: [{ lat: -10, lon: 100 }] })),
    ...(pad ? [{ type: 'node' as const, id: 999, lat: -10, lon: 100, tags: { note: 'x'.repeat(pad) } }] : []),
  ],
});

function setup(o: { maxPlaces?: number; maxBytes?: number } = {}) {
  const store = new FakeStore();
  let now = 1_800_000_000_000;
  const clock = { advance: (ms: number) => (now += ms) };
  const cache = new PlaceCache(store, { now: () => now, ...o });
  return { store, cache, clock };
}

describe('saved places: keys', () => {
  it('normalises searches: case, spacing and commas do not matter', () => {
    expect(normaliseQuery('  Test   Reef ,Open  Ocean. ')).toBe('test reef, open ocean');
    expect(normaliseQuery('TEST REEF, OPEN OCEAN')).toBe('test reef, open ocean');
    expect(normaliseQuery(' , ')).toBe('');
  });

  it('rounds coordinates to about 11 m', () => {
    expect(placeId(-10.00001, 100.00004)).toBe('-10.0000,100.0000');
    expect(placeId(-10.00001, 100.00004)).toBe(placeId(-9.99998, 99.99996));
    expect(placeId(-10, 100)).not.toBe(placeId(-10.001, 100));
  });

  it('says how long ago in plain English', () => {
    expect(timeAgo(5_000)).toBe('just now');
    expect(timeAgo(60_000)).toBe('1 minute ago');
    expect(timeAgo(5 * 3600_000)).toBe('5 hours ago');
    expect(timeAgo(DAY)).toBe('1 day ago');
    expect(timeAgo(3 * DAY + 5)).toBe('3 days ago');
    expect(timeAgo(-50)).toBe('just now');
  });
});

describe('saved places on this device', () => {
  it('round trip: found again by the search typed, another spelling of it, or the coordinates', async () => {
    const { cache } = setup();
    const p = ocean(1);
    expect(await cache.findByQuery('Test Reef')).toBeNull();
    expect(await cache.save('Test Reef', p, town(4))).toBe(true);
    for (const q of ['Test Reef', '  test   reef ']) {
      const hit = await cache.findByQuery(q);
      expect(hit?.label).toBe('Test Reef 1');
      expect(hit?.json).toEqual(town(4));
    }
    expect((await cache.findByCoords(p.lat + 0.00001, p.lon))?.id).toBe(placeId(p.lat, p.lon));
    expect(await cache.findByQuery('Some Other Place')).toBeNull();
    // A different search that lands on the same spot is remembered too, under one entry.
    await cache.save('Reef Road', p, town(5));
    const list = await cache.list();
    expect(list).toHaveLength(1);
    expect(list[0].queries).toEqual([queryKey('Reef Road'), queryKey('test reef')]);
    expect((await cache.findByQuery('test reef'))?.json.elements).toHaveLength(5);
  });

  it('never stores the words typed (they may be a home address): only a fingerprint', async () => {
    const { cache, store } = setup();
    await cache.save('12 Example Street, Test Reef', ocean(1), town());
    const stored = JSON.stringify([...store.data.entries()]);
    expect(stored).not.toMatch(/example street/i);
    expect(queryKey(' 12 example street ,test reef')).toBe(queryKey('12 Example Street, Test Reef'));
    expect(queryKey('12 Example Street')).not.toBe(queryKey('14 Example Street'));
    expect((await cache.findByQuery('12 example street, test reef'))?.label).toBe('Test Reef 1');
  });

  it('expires after 30 days, and forgets the stored map', async () => {
    const { cache, store, clock } = setup();
    await cache.save('Test Reef', ocean(1), town());
    clock.advance(MAX_AGE_MS - 1000);
    expect(await cache.findByQuery('Test Reef')).not.toBeNull();
    clock.advance(2000);
    expect(await cache.findByQuery('Test Reef')).toBeNull();
    expect(await cache.list()).toEqual([]);
    expect([...store.data.keys()].filter((k) => k.startsWith('place:'))).toEqual([]);
  });

  it('a re-download (Refresh) restarts the 30 days', async () => {
    const { cache, clock } = setup();
    await cache.save('Test Reef', ocean(1), town());
    clock.advance(20 * DAY);
    await cache.save('Test Reef', ocean(1), town(6));
    clock.advance(20 * DAY);
    expect((await cache.findByQuery('Test Reef'))?.json.elements).toHaveLength(6);
  });

  it('keeps at most 5 places: the least recently used goes first', async () => {
    const { cache, store, clock } = setup();
    for (let k = 1; k <= 5; k++) {
      await cache.save(`Reef ${k}`, ocean(k), town());
      clock.advance(1000);
    }
    expect(await cache.findByQuery('Reef 1')).not.toBeNull(); // used again: now the most recent
    clock.advance(1000);
    await cache.save('Reef 6', ocean(6), town());
    const names = (await cache.list()).map((i) => i.label);
    expect(names).toHaveLength(5);
    expect(names).not.toContain('Test Reef 2');
    expect(names).toContain('Test Reef 1');
    expect(store.data.has(`place:${placeId(ocean(2).lat, ocean(2).lon)}`)).toBe(false);
  });

  it('keeps the total size under the cap, and never stores one place bigger than it', async () => {
    const { cache } = setup({ maxBytes: 5000 });
    await cache.save('Reef 1', ocean(1), town(1, 2000));
    await cache.save('Reef 2', ocean(2), town(1, 2000));
    await cache.save('Reef 3', ocean(3), town(1, 2000)); // pushes Reef 1 out
    expect((await cache.list()).map((i) => i.label)).toEqual(['Test Reef 3', 'Test Reef 2']);
    expect((await cache.list()).reduce((s, i) => s + i.bytes, 0)).toBeLessThanOrEqual(5000);
    expect(await cache.save('Huge', ocean(4), town(1, 6000))).toBe(false);
    expect(await cache.findByQuery('Huge')).toBeNull();
    expect(await cache.list()).toHaveLength(2);
  });

  it('ignores a corrupt or edited entry, and drops it', async () => {
    const { cache, store } = setup();
    await cache.save('Test Reef', ocean(1), town());
    await cache.save('Reef 2', ocean(2), town());
    store.data.set(`place:${placeId(ocean(1).lat, ocean(1).lon)}`, '{"elements": [trunc');
    expect(await cache.findByQuery('Test Reef')).toBeNull();
    expect((await cache.list()).map((i) => i.label)).toEqual(['Test Reef 2']);
    store.data.set(`place:${placeId(ocean(2).lat, ocean(2).lon)}`, JSON.stringify({ nope: 1 }));
    expect(await cache.findByQuery('Reef 2')).toBeNull();
    // A broken index: bad rows are skipped, the rest still work.
    await cache.save('Reef 3', ocean(3), town());
    const idx = store.data.get('index') as unknown[];
    store.data.set('index', [...idx, { id: 5 }, null, 'junk']);
    expect((await cache.findByQuery('Reef 3'))?.label).toBe('Test Reef 3');
    store.data.set('index', 'not a list');
    expect(await cache.findByQuery('Reef 3')).toBeNull();
    expect(await cache.list()).toEqual([]);
  });

  it('storage that throws (a private window) never breaks scouting: nothing found, nothing saved', async () => {
    const cache = new PlaceCache(throwing);
    expect(await cache.save('Test Reef', ocean(1), town())).toBe(false);
    expect(await cache.findByQuery('Test Reef')).toBeNull();
    expect(await cache.findByCoords(-10, 100)).toBeNull();
    expect(await cache.list()).toEqual([]);
    expect(await cache.forget('x')).toBe(false);
    expect(await cache.forgetAll()).toBe(false);
    const none = new PlaceCache(null);
    expect(await none.save('Test Reef', ocean(1), town())).toBe(false);
    expect(await none.findByQuery('Test Reef')).toBeNull();
    expect(await none.forgetAll()).toBe(true);
  });

  it('a write that fails half way leaves nothing that claims to be saved', async () => {
    const store = new FakeStore();
    const cache = new PlaceCache(store);
    await cache.save('Reef 1', ocean(1), town());
    const flaky: PlaceStore = { ...store, get: (k) => store.get(k), delete: (k) => store.delete(k), clear: () => store.clear(), set: () => Promise.reject(new Error('QuotaExceededError')) };
    const c2 = new PlaceCache(flaky);
    expect(await c2.save('Reef 2', ocean(2), town())).toBe(false);
    expect(await c2.findByQuery('Reef 2')).toBeNull();
    expect((await c2.findByQuery('Reef 1'))?.label).toBe('Test Reef 1');
  });

  it('forget one place, or all of them', async () => {
    const { cache, store } = setup();
    await cache.save('Reef 1', ocean(1), town());
    await cache.save('Reef 2', ocean(2), town());
    const id = (await cache.findByQuery('Reef 1'))!.id;
    expect(await cache.forget(id)).toBe(true);
    expect(await cache.findByQuery('Reef 1')).toBeNull();
    expect(await cache.findByQuery('Reef 2')).not.toBeNull();
    expect(await cache.forgetAll()).toBe(true);
    expect(await cache.list()).toEqual([]);
    expect(store.data.size).toBe(0);
  });
});
