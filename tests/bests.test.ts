import { describe, expect, it } from 'vitest';
import { Bests, bestKey, formatBest, isBetter, missionKind, type KeyValueStore } from '../src/ui/bests';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { matchMissions } from '../src/map/recon';
import { generateMission } from '../src/sim/missions';
import { mapFingerprint } from '../src/sim/campaign';
import { clearOfRects } from '../src/game/lineOfFire';

/** An in-memory stand-in for localStorage. */
function fakeStore(): KeyValueStore & { data: Map<string, string>; writes: number } {
  const data = new Map<string, string>();
  return {
    data,
    writes: 0,
    getItem: (k) => data.get(k) ?? null,
    setItem(k, v) {
      this.writes++;
      data.set(k, v);
    },
  };
}

describe('personal bests (stored only in this browser)', () => {
  const key = bestKey('Sample Town', 'escort', 3);

  it('the first win is a new best; a worse one is not; a better grade or a faster same grade is', () => {
    const b = new Bests(fakeStore());
    expect(b.get(key)).toBeNull();
    expect(b.record(key, { grade: 'B', time: 200 })).toMatchObject({ isNew: true, previous: null });
    expect(b.record(key, { grade: 'C', time: 100 }).isNew).toBe(false);
    expect(b.record(key, { grade: 'B', time: 250 }).isNew).toBe(false);
    const faster = b.record(key, { grade: 'B', time: 180 });
    expect(faster.isNew).toBe(true);
    expect(faster.previous).toEqual({ grade: 'B', time: 200 });
    expect(b.record(key, { grade: 'A', time: 400 }).isNew).toBe(true);
    expect(b.get(key)).toEqual({ grade: 'A', time: 400 });
  });

  it('survives a reload through storage, and keeps maps, missions and difficulties apart', () => {
    const store = fakeStore();
    new Bests(store).record(key, { grade: 'S', time: 192 });
    const again = new Bests(store);
    expect(again.get(key)).toEqual({ grade: 'S', time: 192 });
    expect(again.get(bestKey('Sample Town', 'escort', 4))).toBeNull();
    expect(again.get(bestKey('Sample Town', 'defend', 3))).toBeNull();
    expect(again.get(bestKey('Elsewhere', 'escort', 3))).toBeNull();
    expect(formatBest(again.get(key)!)).toBe('Best: S 3:12');
  });

  it('works without storage, with storage that throws, and ignores corrupt or edited values', () => {
    const none = new Bests(null);
    expect(none.record(key, { grade: 'A', time: 60 }).isNew).toBe(true);
    expect(none.get(key)).toEqual({ grade: 'A', time: 60 });
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('full');
      },
    };
    const t = new Bests(throwing);
    expect(t.get(key)).toBeNull();
    expect(t.record(key, { grade: 'C', time: 90 }).isNew).toBe(true);
    const junk = fakeStore();
    junk.data.set('spooky.bests', JSON.stringify({ [key]: { grade: 'Z', time: 5 }, b: { grade: 'A', time: -1 }, c: 'x', d: { grade: 'B', time: 75 } }));
    const j = new Bests(junk);
    expect(j.get(key)).toBeNull();
    expect(j.get('b')).toBeNull();
    expect(j.get('d')).toEqual({ grade: 'B', time: 75 });
    const corrupt = fakeStore();
    corrupt.data.set('spooky.bests', '{not json');
    expect(new Bests(corrupt).get(key)).toBeNull();
  });

  it('only writes when there is a new best', () => {
    const store = fakeStore();
    const b = new Bests(store);
    b.record(key, { grade: 'A', time: 100 });
    b.record(key, { grade: 'B', time: 50 });
    expect(store.writes).toBe(1);
  });

  it('orders grades, then time', () => {
    expect(isBetter({ grade: 'S', time: 500 }, { grade: 'A', time: 10 })).toBe(true);
    expect(isBetter({ grade: 'A', time: 10 }, { grade: 'A', time: 10 })).toBe(false);
  });

  it('a recon card and the mission it builds share one key (so the card shows the right best)', () => {
    const map = makeSampleTown();
    const graph = buildRoadGraph(map);
    const grid = new WalkGrid(map);
    for (const seed of [1, 2, 3]) {
      for (const s of matchMissions(map, seed)) {
        const r = generateMission(map, graph, grid, { type: s.base, difficulty: 2, seed, template: s.template, anchor: s.anchor?.id });
        if (!r.ok) continue;
        const fromCard = bestKey(map.name, missionKind(s.template, s.base), 2);
        const fromMission = bestKey(r.mission.mapName, missionKind(r.mission.template, r.mission.type), r.mission.difficulty);
        expect(fromMission, s.template).toBe(fromCard);
      }
    }
    expect(missionKind('classic-escort', 'escort')).toBe('escort');
    expect(missionKind(undefined, 'clear')).toBe('clear');
    expect(missionKind('forest-sweep', 'clear')).toBe('forest-sweep');
  });
});

describe('bests storage holds no place text', () => {
  it('migrates a plain-name entry to the map fingerprint once, deleting the old key', () => {
    const map = makeSampleTown();
    const fp = mapFingerprint(map);
    const store = fakeStore();
    store.setItem('spooky.bests', JSON.stringify({ [`${map.name}|escort|3`]: { grade: 'A', time: 100 }, 'Other Place|clear|1': { grade: 'B', time: 50 } }));
    const b = new Bests(store);
    b.migrate(map.name, fp);
    expect(b.get(bestKey(fp, 'escort', 3))).toEqual({ grade: 'A', time: 100 });
    expect(b.get(`${map.name}|escort|3`)).toBeNull();
    const keys = Object.keys(JSON.parse(store.data.get('spooky.bests')!));
    expect(keys).toContain(`${fp}|escort|3`);
    expect(keys.some((k) => k.startsWith(`${map.name}|`))).toBe(false);
    const writes = store.writes;
    b.migrate(map.name, fp); // nothing left to move: no write
    expect(store.writes).toBe(writes);
  });

  it('new records are keyed by the fingerprint, so the stored keys contain no place text', () => {
    const map = makeSampleTown();
    const store = fakeStore();
    const b = new Bests(store);
    b.migrate(map.name, mapFingerprint(map));
    b.record(bestKey(mapFingerprint(map), 'escort', 3), { grade: 'S', time: 120 });
    const stored = store.data.get('spooky.bests')!;
    expect(stored).not.toContain(map.name);
    for (const word of map.name.split(/\s+/)) expect(stored).not.toContain(word);
  });
});

describe('edge pointers stay out from under the touch controls', () => {
  it('moves a pointer off a blocker, and leaves a clear one alone', () => {
    const pad = [{ x0: 700, y0: 250, x1: 820, y1: 370 }];
    expect(clearOfRects({ x: 100, y: 100 }, pad, 844, 390)).toEqual({ x: 100, y: 100 });
    const p = clearOfRects({ x: 816, y: 310 }, pad, 844, 390);
    expect(p.x > 820 + 20 || p.x < 700 - 20 || p.y < 250 - 20 || p.y > 370 + 20).toBe(true);
    expect(p.x).toBeGreaterThanOrEqual(28);
    expect(p.x).toBeLessThanOrEqual(844 - 28);
    expect(p.y).toBeLessThanOrEqual(390 - 28);
  });
});
