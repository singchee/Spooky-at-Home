import { describe, expect, it } from 'vitest';
import { CAMPAIGN_KEY, CampaignStore, MAX_PLACES, NOT_KEPT } from '../src/ui/campaignStore';
import type { KeyValueStore } from '../src/ui/bests';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { mapFeatures } from '../src/map/recon';
import { emptyRecord, placeKey, planCampaign, type Level, type NightPlan, type Run } from '../src/sim/campaign';

// Spec 001 §2 and §5: the campaign record on this device only. Numbers only, one record per difficulty,
// keyed by S plus the map's shape (never map.name), and nothing here ever throws.

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
const throwing = (onRead: boolean, onWrite: boolean): KeyValueStore => ({
  getItem: () => {
    if (onRead) throw new Error('SecurityError');
    return null;
  },
  setItem: () => {
    if (onWrite) throw new Error('QuotaExceededError');
  },
});
function clock(start = 1000) {
  let t = start;
  return () => t++;
}

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);
function plan(B: Level, m = map): NightPlan[] {
  const p = planCampaign(m, m === map ? graph : buildRoadGraph(m), m === map ? grid : new WalkGrid(m), 1, B);
  if (!p.ok) throw new Error(p.reason);
  return p.nights;
}
const place = placeKey(1, map);
const win = (grade: Run['grade'] = 'B', time = 200): Run => ({
  won: true, grade, time, survivorsTotal: 5, survivorsSaved: 4, friendlyHits: 1, kills: 40, integrity: 1,
});
const loss = (): Run => ({ ...win('D'), won: false, survivorsSaved: 1 });

describe('campaign store (this device only)', () => {
  it('round-trips through a fake store', () => {
    const store = fakeStore();
    const ns = plan(2);
    const a = new CampaignStore(store, clock());
    expect(a.get(place, 2)).toEqual(emptyRecord());
    expect(a.record(place, 2, 1, ns[0].fp, win('A', 123.4)).isNewBest).toBe(true);
    const b = new CampaignStore(store, clock());
    expect(b.get(place, 2).nights[0]).toEqual({ fp: ns[0].fp, tries: 1, best: { grade: 'A', time: 123.4, survivorsTotal: 5, survivorsSaved: 4, friendlyHits: 1, kills: 40, integrity: 1 } });
    expect(b.levels(place)).toEqual([2]);
    expect(b.warning).toBeNull();
    // get() hands out a copy: changing it doesn't change what's stored.
    b.get(place, 2).nights[0]!.tries = 99;
    expect(b.get(place, 2).nights[0]!.tries).toBe(1);
  });

  it('keeps one record per difficulty; changing difficulty starts a separate campaign', () => {
    const s = new CampaignStore(fakeStore(), clock());
    const n1 = plan(1);
    const n3 = plan(3);
    s.record(place, 1, 1, n1[0].fp, win());
    expect(s.get(place, 3)).toEqual(emptyRecord());
    s.record(place, 3, 1, n3[0].fp, loss());
    expect(s.get(place, 1).nights[0]!.best).toBeDefined();
    expect(s.get(place, 3).nights[0]).toEqual({ fp: n3[0].fp, tries: 1 });
    expect(s.levels(place)).toEqual([1, 3]);
  });

  it('wins-only best; losses count as tries; a loss never removes a win', () => {
    const s = new CampaignStore(fakeStore(), clock());
    const fp = plan(2)[0].fp;
    s.record(place, 2, 1, fp, loss());
    expect(s.get(place, 2).nights[0]).toEqual({ fp, tries: 1 });
    s.record(place, 2, 1, fp, win('B'));
    s.record(place, 2, 1, fp, loss());
    const worse = s.record(place, 2, 1, fp, win('C'));
    expect(worse.isNewBest).toBe(false);
    expect(s.get(place, 2).nights[0]).toMatchObject({ tries: 4, best: { grade: 'B' } });
    expect(s.record(place, 2, 1, fp, win('S')).isNewBest).toBe(true);
    expect(s.get(place, 2).nights[0]!.best!.grade).toBe('S');
    // A locked night records nothing.
    const before = s.get(place, 2);
    s.record(place, 2, 3, 'cccccccc', win());
    expect(s.get(place, 2)).toEqual(before);
  });

  it('an fp mismatch resets that night and every later one when the campaign is opened', () => {
    const store = fakeStore();
    const s = new CampaignStore(store, clock());
    const ns = plan(2);
    for (const x of ns) s.record(place, 2, x.night, x.fp, win());
    expect(s.open(place, 2, ns)).toEqual({ record: s.get(place, 2), reset: null });
    const changed = ns.map((x) => (x.night === 2 ? { ...x, fp: '0badf00d' } : x));
    const o = s.open(place, 2, changed);
    expect(o.reset).toBe(2);
    expect(o.record.nights[0]!.best).toBeDefined();
    expect(o.record.nights.slice(1)).toEqual([null, null]);
    // The reset is saved, so the next session sees it too.
    expect(new CampaignStore(store, clock()).get(place, 2)).toEqual(o.record);
  });

  it('corrupt JSON or wrong version starts fresh without throwing', () => {
    const ns = plan(2);
    for (const raw of ['{not json', 'null', '"x"', '[]', JSON.stringify({ places: {} }), 'x'.repeat(200_000)]) {
      const store = fakeStore();
      store.data.set(CAMPAIGN_KEY, raw);
      const s = new CampaignStore(store, clock());
      expect(s.get(place, 2)).toEqual(emptyRecord());
      expect(() => s.record(place, 2, 1, ns[0].fp, win())).not.toThrow();
      expect(JSON.parse(store.data.get(CAMPAIGN_KEY)!).v).toBe(1);
    }
    // A bad field: that place is ignored and rebuilt fresh; other places survive.
    const good = { updated: 5, levels: { 2: { nights: [{ fp: ns[0].fp, tries: 2 }, null, null] } } };
    const bads = [
      { updated: 5, levels: { 2: { nights: [{ fp: 'nothex!!', tries: 1 }, null, null] } } },
      { updated: 5, levels: { 2: { nights: [{ fp: ns[0].fp, tries: -1 }, null, null] } } },
      { updated: 5, levels: { 2: { nights: [{ fp: ns[0].fp, tries: 1, best: { ...win(), grade: 'Z' } }, null, null] } } },
      { updated: 5, levels: { 2: { nights: [{ fp: ns[0].fp, tries: 1, best: { ...win(), survivorsSaved: 9 } }, null, null] } } },
      { updated: 5, levels: { 2: { nights: [{ fp: ns[0].fp, tries: 1, best: { ...win(), integrity: 3 } }, null, null] } } },
      { updated: 5, levels: { 2: { nights: [{ fp: ns[0].fp, tries: 1, best: { ...win(), name: 'Elm Street' } }, null, null] } } },
      { updated: 5, levels: { 7: { nights: [null, null, null] } } },
      { updated: 5, levels: { 2: { nights: [null, null] } } },
      { updated: 'soon', levels: {} },
    ];
    for (const bad of bads) {
      const store = fakeStore();
      store.data.set(CAMPAIGN_KEY, JSON.stringify({ v: 1, places: { [place]: bad, '00000002:0000abcd': good } }));
      const s = new CampaignStore(store, clock());
      expect(s.get(place, 2), JSON.stringify(bad)).toEqual(emptyRecord());
      expect(s.get('00000002:0000abcd', 2).nights[0]).toEqual({ fp: ns[0].fp, tries: 2 });
    }
    // A key that isn't a place key is dropped.
    const store = fakeStore();
    store.data.set(CAMPAIGN_KEY, JSON.stringify({ v: 1, places: { 'Sampleton (sample town)': good } }));
    expect(new CampaignStore(store, clock()).levels('Sampleton (sample town)')).toEqual([]);
  });

  it('blocked or full storage keeps progress in memory', () => {
    const ns = plan(2);
    for (const [s, why] of [
      [new CampaignStore(throwing(true, true), clock()), 'blocked'],
      [new CampaignStore(throwing(false, true), clock()), 'full'],
      [new CampaignStore(null, clock()), 'unavailable'],
    ] as const) {
      expect(() => s.record(place, 2, 1, ns[0].fp, win())).not.toThrow();
      expect(s.get(place, 2).nights[0]!.best, why).toBeDefined();
      expect(s.warning, why).toBe(NOT_KEPT);
      expect(() => s.forget(place)).not.toThrow();
      expect(s.levels(place)).toEqual([]);
    }
    expect(NOT_KEPT).toBe("This browser won't keep campaign progress.");
  });

  it('keeps at most 20 places, oldest first out', () => {
    const store = fakeStore();
    const s = new CampaignStore(store, clock());
    const fp = plan(1)[0].fp;
    const key = (i: number) => `${i.toString(16).padStart(8, '0')}:${(0x1000 + i).toString(16).padStart(8, '0')}`;
    for (let i = 0; i < MAX_PLACES; i++) s.record(key(i), 1, 1, fp, win());
    s.record(key(0), 1, 1, fp, loss()); // place 0 is touched again, so place 1 is now the oldest
    s.record(key(99), 1, 1, fp, win());
    const again = new CampaignStore(store, clock());
    expect(MAX_PLACES).toBe(20);
    expect(again.levels(key(1))).toEqual([]);
    expect(again.levels(key(0))).toEqual([1]);
    expect(again.levels(key(99))).toEqual([1]);
    expect(Object.keys(JSON.parse(store.data.get(CAMPAIGN_KEY)!).places)).toHaveLength(MAX_PLACES);
    expect(store.data.get(CAMPAIGN_KEY)!.length).toBeLessThan(30_000);
  });

  it('forget removes every difficulty for the place', () => {
    const store = fakeStore();
    const s = new CampaignStore(store, clock());
    for (const B of [1, 2, 3] as Level[]) s.record(place, B, 1, plan(B)[0].fp, win());
    s.record('00000009:0000abcd', 2, 1, plan(2)[0].fp, win());
    expect(s.levels(place)).toEqual([1, 2, 3]);
    s.forget(place);
    expect(s.levels(place)).toEqual([]);
    for (const B of [1, 2, 3] as Level[]) expect(s.get(place, B)).toEqual(emptyRecord());
    const again = new CampaignStore(store, clock());
    expect(again.levels(place)).toEqual([]);
    expect(again.levels('00000009:0000abcd')).toEqual([2]);
  });

  it('the stored JSON contains no feature names, street names, coordinates or map.name', () => {
    const named = { ...makeSampleTown(), name: '12, Example Street' };
    const ns = (() => {
      const p = planCampaign(named, buildRoadGraph(named), new WalkGrid(named), 1, 2);
      if (!p.ok) throw new Error(p.reason);
      return p.nights;
    })();
    const store = fakeStore();
    const s = new CampaignStore(store, clock());
    const key = placeKey(1, named);
    for (const x of ns) s.record(key, 2, x.night, x.fp, { ...win(), time: 271.25, integrity: 0.4375 });
    s.record(key, 2, 3, ns[2].fp, loss());
    const json = store.data.get(CAMPAIGN_KEY)!;
    const names = [
      named.name, ...named.roads.flatMap((r) => (r.name ? [r.name] : [])), ...mapFeatures(named).flatMap((f) => (f.name ? [f.name] : [])),
      ...ns.flatMap((x) => [x.mission.anchor?.name, x.mission.safehouse?.name, x.mission.home?.street, x.mission.title]).filter((v): v is string => !!v),
    ];
    for (const n of names) expect(json, n).not.toContain(n);
    expect(json).not.toMatch(/Street|Avenue|Example/);
    // Structure: only these keys, and the only strings are the version's place key, fingerprints and grades.
    const KEYS = new Set(['v', 'places', 'updated', 'levels', '1', '2', '3', 'nights', 'fp', 'tries', 'best', 'grade', 'time',
      'survivorsTotal', 'survivorsSaved', 'friendlyHits', 'kills', 'integrity']);
    const walk = (v: unknown, path: string): void => {
      if (typeof v === 'string') expect(/^([0-9a-f]{8}|[SABCD])$/.test(v), `${path} = ${v}`).toBe(true);
      else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
      else if (v && typeof v === 'object') {
        for (const [k, x] of Object.entries(v)) {
          expect(KEYS.has(k) || (path === '.places' && k === key), `${path}.${k}`).toBe(true);
          walk(x, `${path}.${k}`);
        }
      }
    };
    walk(JSON.parse(json), '');
    // No coordinates: no number in the record looks like a map position (every stored number is listed above).
    expect(key).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
  }, 60_000);

  it('a key storage would reject keeps progress in memory and says so (no silent soft-lock)', () => {
    const store = fakeStore();
    const s = new CampaignStore(store, clock());
    const ns = plan(2);
    const odd = '1e+21:not-a-key';
    s.record(odd, 2, 1, ns[0].fp, win());
    expect(s.get(odd, 2).nights[0]!.best).toBeDefined();
    expect(s.levels(odd)).toEqual([2]);
    expect(s.warning).toBe(NOT_KEPT);
    // Night two is open for that campaign this session.
    expect(s.record(odd, 2, 2, ns[1].fp, win()).record.nights[1]!.best).toBeDefined();
    // It never reaches storage, and good places still do.
    s.record(place, 2, 1, ns[0].fp, win());
    const json = store.data.get(CAMPAIGN_KEY)!;
    expect(json).not.toContain(odd);
    expect(new CampaignStore(store, clock()).levels(place)).toEqual([2]);
  });

  it('a stale tab never erases a win another tab saved', () => {
    const store = fakeStore();
    const ns = plan(2);
    const n1 = plan(1);
    const stale = new CampaignStore(store, clock(1));
    expect(stale.get(place, 2)).toEqual(emptyRecord()); // this tab read storage before the win
    const other = new CampaignStore(store, clock(100));
    other.record(place, 2, 1, ns[0].fp, win('A'));
    // The stale tab records a different difficulty, then a loss on the same night.
    stale.record(place, 1, 1, n1[0].fp, loss());
    stale.record(place, 2, 1, ns[0].fp, loss());
    const now = new CampaignStore(store, clock(200));
    expect(now.get(place, 2).nights[0]).toMatchObject({ tries: 2, best: { grade: 'A' } });
    expect(now.get(place, 1).nights[0]).toMatchObject({ tries: 1 });
    // put() also merges with what is stored now, so a direct put of another difficulty keeps the win too.
    const stale2 = new CampaignStore(store, clock(300));
    stale2.get(place, 3);
    new CampaignStore(store, clock(400)).record(place, 2, 2, ns[1].fp, win('B'));
    stale2.put(place, 3, emptyRecord());
    expect(new CampaignStore(store, clock()).get(place, 2).nights[1]).toMatchObject({ best: { grade: 'B' } });
  });
});

// BACKLOG 3.25: three store nits.
describe('campaign store: edge cases (3.25)', () => {
  const rec = () => {
    const r = emptyRecord();
    r.nights[0] = { fp: 'abcdef01', tries: 1 };
    return r;
  };
  const key = (i: number) => `${i.toString(16).padStart(8, '0')}:00000001`;

  it('a first read that throws never overwrites storage with only this session', () => {
    const data = new Map<string, string>([[CAMPAIGN_KEY, '{"v":1,"places":{}}']]);
    let readsFail = true;
    const store: KeyValueStore = {
      getItem: (k) => {
        if (readsFail) throw new Error('SecurityError');
        return data.get(k) ?? null;
      },
      setItem: (k, v) => void data.set(k, v),
    };
    const s = new CampaignStore(store, clock());
    s.put(place, 1, rec());
    readsFail = false;
    expect(data.get(CAMPAIGN_KEY)).toBe('{"v":1,"places":{}}');
    expect(s.get(place, 1).nights[0]).toEqual({ fp: 'abcdef01', tries: 1 }); // still kept in memory
    expect(s.warning).toBe(NOT_KEPT);
  });

  it('trimming never removes the place just written, even when the clock goes backwards', () => {
    const store = fakeStore();
    let t = 1_000_000;
    const s = new CampaignStore(store, () => t);
    for (let i = 0; i < MAX_PLACES; i++) {
      t += 10;
      s.put(key(i), 1, rec());
    }
    t = 5; // the clock jumps back: the new place looks the oldest
    s.put(key(99), 1, rec());
    const saved = JSON.parse(store.data.get(CAMPAIGN_KEY)!).places;
    expect(Object.keys(saved)).toHaveLength(MAX_PLACES);
    expect(saved[key(99)]).toBeDefined();
    expect(new CampaignStore(store, clock()).get(key(99), 1).nights[0]).toEqual({ fp: 'abcdef01', tries: 1 });
  });

  it('an older build meeting newer (v2) data leaves it alone, keeps progress in memory and warns', () => {
    const store = fakeStore();
    const v2 = JSON.stringify({ v: 2, places: { [place]: { shape: 'new' } } });
    store.data.set(CAMPAIGN_KEY, v2);
    const s = new CampaignStore(store, clock());
    s.put(place, 1, rec());
    s.put(key(3), 2, rec());
    expect(store.data.get(CAMPAIGN_KEY)).toBe(v2);
    expect(store.writes).toBe(0);
    expect(s.get(place, 1).nights[0]).toEqual({ fp: 'abcdef01', tries: 1 });
    expect(s.warning).toBe(NOT_KEPT);
  });
});
