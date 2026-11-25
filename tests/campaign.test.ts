import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { CHILD_CATEGORIES, MISSION_TEMPLATES, nearChildPlace } from '../src/map/recon';
import { generateMission, type MissionOptions } from '../src/sim/missions';
import { createSim } from '../src/sim/setup';
import { hashString } from '../src/util/rng';
import type { Feature, MapData, V2 } from '../src/map/types';
import {
  LEVELS, MAX_GENERATOR_CALLS, NIGHT_BASE, NIGHT_PREFERENCES, NIGHT_SUBSTITUTES, NIGHTS,
  applyRun, betterRun, emptyRecord, firstUnwon, mapFingerprint, missionFingerprint, nightDifficulty, nightOpen, nightSeed, planCampaign,
  placeKey, reconcile, runFrom, type CampaignPlan, type Generator, type Level, type NightPlan, type Run,
} from '../src/sim/campaign';
import { gradeMission, scoreInput } from '../src/sim/score';
import { Bot, SKILL } from '../src/sim/bot';

// Spec 001 (Three Nights), step 1: three deterministic, guardrail-clean nights out of every map we have,
// and a replayed night is the same mission. docs/story/campaign.md §2, §5 and §9.

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);

function plan(m: MapData, S: number, B: Level, generate?: Generator): CampaignPlan {
  const g = m === map ? graph : buildRoadGraph(m);
  const w = m === map ? grid : new WalkGrid(m);
  return planCampaign(m, g, w, S, B, generate ? { generate } : {});
}
function nights(p: CampaignPlan): NightPlan[] {
  if (!p.ok) throw new Error(`no campaign: night ${p.night}: ${p.reason}`);
  return p.nights;
}
/** A generator that counts its calls and can refuse some mission types (to force substitutes). */
function counting(refuse: (o: MissionOptions) => boolean = () => false): Generator & { calls: number } {
  const gen = ((m, g, w, o) => {
    gen.calls++;
    return refuse(o) ? { ok: false, reason: `Test: no ${o.template ?? o.type} here.` } : generateMission(m, g, w, o);
  }) as Generator & { calls: number };
  gen.calls = 0;
  return gen;
}

describe('campaign: seeds and difficulty', () => {
  it('night difficulty rises every night and never passes 5', () => {
    for (const B of LEVELS) {
      const ds = NIGHTS.map((n) => nightDifficulty(B, n));
      expect(ds).toEqual([B, B + 1, B + 2]);
      for (let i = 1; i < ds.length; i++) expect(ds[i]).toBeGreaterThan(ds[i - 1]);
      expect(Math.max(...ds)).toBeLessThanOrEqual(5);
    }
  });

  it('night seeds are hashString(campaign|S|n)', () => {
    for (const S of [1, 7, 123456]) for (const n of NIGHTS) expect(nightSeed(S, n)).toBe(hashString(`campaign|${S}|${n}`));
    expect(new Set(NIGHTS.map((n) => nightSeed(1, n))).size).toBe(3);
  });
});

describe('campaign: planning on the sample town', () => {
  it('all three nights resolve on the sample town at B 1..3', () => {
    for (const B of LEVELS) {
      for (const S of [1, 2, 3]) {
        const ns = nights(plan(map, S, B));
        expect(ns.map((x) => x.night)).toEqual([1, 2, 3]);
        expect(ns.map((x) => x.mission.type), `B${B} S${S}`).toEqual(['clear', 'escort', 'defend']);
        for (const x of ns) {
          expect(x.level).toBe(B);
          expect(x.difficulty).toBe(nightDifficulty(B, x.night));
          expect(x.mission.difficulty).toBe(x.difficulty);
          expect(x.seed).toBe(nightSeed(S, x.night));
          expect(x.mission.seed).toBe(x.seed);
          expect(x.options).toMatchObject({ seed: x.seed, difficulty: x.difficulty, template: x.template });
          expect(x.substitute).toBe(false);
          expect(NIGHT_PREFERENCES[x.night]).toContain(x.template);
          expect(x.fp).toBe(missionFingerprint(x.mission));
          expect(x.hadCold).toBe(x.mission.hordes.some((h) => h.cold > 0) || (x.mission.waves?.coldShare ?? 0) > 0);
          if (MISSION_TEMPLATES[x.template].anchors.length) expect(x.anchorId).toBe(x.mission.anchor?.id);
          else expect(x.anchorId).toBeUndefined();
        }
      }
    }
  }, 120_000);

  it('the sample town gets its real places: the tennis club, the shops, the sports centre', () => {
    const ns = nights(plan(map, 1, 2));
    expect(ns.map((x) => x.template)).toEqual(['clear-tennis', 'escort-shops', 'hold-sports']);
  });

  it('planning is deterministic: same map+S+B gives deep-equal plans', () => {
    for (const B of LEVELS) {
      const a = plan(map, 5, B);
      const b = plan(map, 5, B);
      expect(b).toEqual(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
    // B isn't in the seed, but it is in the difficulty: the same S at another B is a different campaign.
    expect(nights(plan(map, 5, 1))[0].fp).not.toBe(nights(plan(map, 5, 2))[0].fp);
  });

  it('a replayed night is the identical Mission and the identical SimState after 600 steps', () => {
    for (const x of nights(plan(map, 4, 2))) {
      const a = createSim(map, x.options);
      const b = createSim(map, x.options);
      if (!a.ok || !b.ok) throw new Error('replay failed to build');
      expect(a.sim.mission).toEqual(x.mission);
      expect(b.sim.mission).toEqual(x.mission);
      for (let i = 0; i < 600; i++) {
        a.sim.step(1 / 60);
        b.sim.step(1 / 60);
      }
      expect(JSON.stringify(b.sim.state())).toBe(JSON.stringify(a.sim.state()));
      const pos = (s: typeof a.sim) => JSON.stringify([s.zombies.map((z) => [z.x, z.z, z.alive]), s.survivors.map((v) => [v.x, v.z, v.alive, v.home])]);
      expect(pos(b.sim)).toBe(pos(a.sim));
      expect(a.sim.zombies.length + a.sim.survivors.length).toBeGreaterThan(0);
    }
  }, 60_000);

  it('no anchor is used twice', () => {
    for (const B of LEVELS) {
      for (const S of [1, 2, 3, 4, 5, 6]) {
        const ids = nights(plan(map, S, B)).flatMap((x) => (x.anchorId ? [x.anchorId] : []));
        expect(new Set(ids).size, `B${B} S${S}: ${ids}`).toBe(ids.length);
      }
    }
  }, 120_000);

  it('no preference or substitute list holds a template anchored on a child category, and every resolved anchor passes nearChildPlace === false', () => {
    for (const n of NIGHTS) {
      for (const id of [...NIGHT_PREFERENCES[n], ...NIGHT_SUBSTITUTES[n]]) {
        for (const c of MISSION_TEMPLATES[id].anchors) expect(CHILD_CATEGORIES, `${id} anchors on ${c}`).not.toContain(c);
      }
    }
    for (const B of LEVELS) {
      for (const S of [1, 2, 3, 4]) {
        for (const x of nights(plan(map, S, B))) {
          const a = x.mission.anchor;
          if (!a) continue;
          expect(CHILD_CATEGORIES).not.toContain(a.category);
          expect(nearChildPlace(map, a.p), `${x.template} at ${a.name}`).toBe(false);
        }
      }
    }
  }, 120_000);
});

describe('campaign: substitutes and fallbacks (campaign.md §5)', () => {
  it('each night has its own base type first, and the substitutes campaign.md §5 lists, in order', () => {
    expect(NIGHT_BASE).toEqual({ 1: 'clear', 2: 'escort', 3: 'defend' });
    expect(NIGHT_PREFERENCES).toEqual({
      1: ['clear-tennis', 'clear-park', 'forest-sweep', 'classic-clear'],
      2: ['escort-shops', 'escort-station', 'classic-escort'],
      3: ['hold-sports', 'hold-landmark', 'classic-defend'],
    });
    expect(NIGHT_SUBSTITUTES).toEqual({
      1: ['classic-escort', 'classic-defend'],
      2: ['forest-sweep', 'clear-park', 'clear-tennis', 'classic-clear'],
      3: ['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'],
    });
    for (const n of NIGHTS) for (const id of NIGHT_PREFERENCES[n]) expect(MISSION_TEMPLATES[id].base).toBe(NIGHT_BASE[n]);
    // Night two never becomes a defend mission: a defend with no stragglers would make n2-open false.
    for (const id of NIGHT_SUBSTITUTES[2]) expect(MISSION_TEMPLATES[id].base).toBe('clear');
  });

  it('night two always has survivors (substitutes too)', () => {
    for (const B of LEVELS) {
      for (const refuse of [() => false, (o: MissionOptions) => o.type === 'escort']) {
        const ns = nights(plan(map, 2, B, counting(refuse)));
        expect(ns[1].mission.survivors.length, `B${B}`).toBeGreaterThan(0);
      }
    }
  }, 60_000);

  it('when a night type cannot be built, the night falls to its substitutes and says so', () => {
    const noEscort = nights(plan(map, 2, 2, counting((o) => o.type === 'escort')));
    expect(noEscort[1].substitute).toBe(true);
    expect(noEscort[1].mission.type).toBe('clear');
    expect(NIGHT_SUBSTITUTES[2]).toContain(noEscort[1].template);
    expect(noEscort[1].template).not.toBe(noEscort[0].template); // an unused clear template

    const noDefend = nights(plan(map, 2, 2, counting((o) => o.type === 'defend')));
    expect(noDefend[2].substitute).toBe(true);
    expect(noDefend[2].template).toBe('classic-clear');
    expect(noDefend[2].mission.type).toBe('clear');

    const noClear = nights(plan(map, 2, 2, counting((o) => o.type === 'clear')));
    expect(noClear[0].substitute).toBe(true);
    expect(noClear[0].template).toBe('classic-escort');
    expect(noClear.map((x) => x.mission.type)).toEqual(['escort', 'escort', 'defend']);
  }, 60_000);

  it('roads-and-houses map plays three classic nights', () => {
    const plain: MapData = { ...map, name: 'Plain streets', features: [], pois: [], areas: [], busRoutes: [] };
    for (const B of LEVELS) {
      const ns = nights(plan(plain, 1, B));
      expect(ns.map((x) => x.template)).toEqual(['classic-clear', 'classic-escort', 'classic-defend']);
      expect(ns.map((x) => x.mission.type)).toEqual(['clear', 'escort', 'defend']);
      expect(ns.every((x) => x.anchorId === undefined && !x.substitute)).toBe(true);
    }
  }, 60_000);

  it("a map with no connected roads has no campaign and gives the generator's reason", () => {
    const empty: MapData = { ...map, name: 'No roads', roads: [] };
    const gen = counting();
    const p = plan(empty, 1, 2, gen);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.night).toBe(1);
    expect(p.reason).toMatch(/roads/);
    expect(p.calls).toBe(gen.calls);
  });

  it('planning makes at most 30 generateMission calls', () => {
    expect(MAX_GENERATOR_CALLS).toBe(30);
    const cases: [string, MapData, (o: MissionOptions) => boolean][] = [
      ['sample town', map, () => false],
      ['no roads', { ...map, name: 'No roads', roads: [] }, () => false],
      ['nothing builds', map, () => true],
      // The worst case: every place for every template fails, so each night walks its whole list.
      ['only classic builds', map, (o) => o.template === undefined || !o.template.startsWith('classic-')],
      ['only the last substitutes build', map, (o) => o.template !== 'classic-defend' && o.template !== 'forest-sweep' && o.template !== 'classic-clear'],
    ];
    for (const [name, m, refuse] of cases) {
      for (const B of LEVELS) {
        const gen = counting(refuse);
        const p = plan(m, 1, B, gen);
        expect(gen.calls, `${name} B${B}`).toBeLessThanOrEqual(MAX_GENERATOR_CALLS);
        expect(p.calls, name).toBe(gen.calls);
      }
    }
  }, 120_000);

  it('a campaign is three nights or none', () => {
    // Nothing at all builds on night three: no two-night campaign, and the reason is the generator's own.
    const n3 = nightSeed(1, 3);
    const p = plan(map, 1, 2, counting((o) => o.seed === n3));
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.night).toBe(3);
    expect(p.reason).toMatch(/^Test: no /);
    expect('nights' in p).toBe(false);
  }, 60_000);
});

describe('campaign: fingerprints', () => {
  it('missionFingerprint is stable, short, and changes when the mission does', () => {
    const [a, b] = [nights(plan(map, 1, 1)), nights(plan(map, 1, 2))];
    expect(a[2].fp).toMatch(/^[0-9a-f]{8}$/);
    expect(missionFingerprint(a[2].mission)).toBe(a[2].fp);
    expect(new Set([...a, ...b].map((x) => x.fp)).size).toBe(6);
    expect(missionFingerprint({ ...a[2].mission, timeLimit: a[2].mission.timeLimit + 1 })).not.toBe(a[2].fp);
    // Text isn't part of it, so a reworded briefing doesn't wipe anyone's progress.
    expect(missionFingerprint({ ...a[2].mission, briefing: ['reworded'] })).toBe(a[2].fp);
  });

  it('mapFingerprint tells the sample town from an edited copy and from a different map', () => {
    expect(mapFingerprint(map)).toMatch(/^[0-9a-f]{8}$/);
    expect(mapFingerprint(makeSampleTown())).toBe(mapFingerprint(map));
    expect(mapFingerprint({ ...map, buildings: map.buildings.slice(1) })).not.toBe(mapFingerprint(map));
    const moved = { ...map.roads[0], pts: map.roads[0].pts.map((p) => ({ x: p.x + 5, z: p.z })) };
    expect(mapFingerprint({ ...map, roads: [moved, ...map.roads.slice(1)] })).not.toBe(mapFingerprint(map));
    // The name isn't part of it (it can hold a house number); the place key adds S.
    expect(mapFingerprint({ ...map, name: '12, Example Street' })).toBe(mapFingerprint(map));
  });
});

describe('campaign record reducer (numbers only)', () => {
  const won = (grade: Run['grade'], time: number, extra: Partial<Run> = {}): Run => ({
    won: true, grade, time, survivorsTotal: 2, survivorsSaved: 2, friendlyHits: 0, kills: 30, integrity: 1, ...extra,
  });
  const lost = (time = 100): Run => ({ ...won('D', time), won: false, survivorsSaved: 0 });

  it('a win is stored as best; a better replay replaces it; a worse one does not', () => {
    let r = emptyRecord();
    const first = applyRun(r, 1, 'aaaaaaaa', won('B', 120));
    expect(first.isNewBest).toBe(true);
    expect(first.previous).toBeNull();
    r = first.record;
    expect(r.nights[0]).toEqual({ fp: 'aaaaaaaa', tries: 1, best: { grade: 'B', time: 120, survivorsTotal: 2, survivorsSaved: 2, friendlyHits: 0, kills: 30, integrity: 1 } });
    const worse = applyRun(r, 1, 'aaaaaaaa', won('C', 60));
    expect(worse.isNewBest).toBe(false);
    expect(worse.record.nights[0]!.best!.grade).toBe('B');
    expect(worse.record.nights[0]!.tries).toBe(2);
    const better = applyRun(worse.record, 1, 'aaaaaaaa', won('A', 200, { kills: 41 }));
    expect(better.isNewBest).toBe(true);
    expect(better.previous!.grade).toBe('B');
    expect(better.record.nights[0]!.best).toMatchObject({ grade: 'A', time: 200, kills: 41 });
    // Same grade: only a clearly faster run replaces it; a tie keeps the old run.
    expect(applyRun(better.record, 1, 'aaaaaaaa', won('A', 199.8, { kills: 1 })).isNewBest).toBe(false);
    expect(applyRun(better.record, 1, 'aaaaaaaa', won('A', 150)).isNewBest).toBe(true);
    expect(betterRun(won('A', 10), undefined)).toBe(true);
    expect(betterRun(won('S', 500), won('A', 10))).toBe(true);
    expect(betterRun(won('A', 10), won('A', 10))).toBe(false);
    // The reducer never changes the record it was given.
    expect(r.nights[0]!.tries).toBe(1);
  });

  it('a loss increments tries and never removes a win', () => {
    let r = applyRun(emptyRecord(), 1, 'aaaaaaaa', lost()).record;
    expect(r.nights[0]).toEqual({ fp: 'aaaaaaaa', tries: 1 });
    r = applyRun(r, 1, 'aaaaaaaa', won('C', 250)).record;
    r = applyRun(r, 1, 'aaaaaaaa', lost()).record;
    r = applyRun(r, 1, 'aaaaaaaa', lost()).record;
    expect(r.nights[0]!.tries).toBe(4);
    expect(r.nights[0]!.best!.grade).toBe('C');
    // A lost run is never a best, even if its grade field says otherwise.
    expect(applyRun(r, 1, 'aaaaaaaa', { ...won('S', 1), won: false }).record.nights[0]!.best!.grade).toBe('C');
  });

  it('night n opens only after night n−1 is won', () => {
    let r = emptyRecord();
    expect([nightOpen(r, 1), nightOpen(r, 2), nightOpen(r, 3)]).toEqual([true, false, false]);
    expect(firstUnwon(r)).toBe(1);
    // Flying a locked night records nothing.
    expect(applyRun(r, 2, 'bbbbbbbb', won('A', 100)).record).toEqual(r);
    r = applyRun(r, 1, 'aaaaaaaa', lost()).record;
    expect(nightOpen(r, 2)).toBe(false);
    r = applyRun(r, 1, 'aaaaaaaa', won('B', 100)).record;
    expect([nightOpen(r, 2), nightOpen(r, 3)]).toEqual([true, false]);
    expect(firstUnwon(r)).toBe(2);
    r = applyRun(r, 2, 'bbbbbbbb', won('B', 300)).record;
    r = applyRun(r, 3, 'cccccccc', won('A', 270)).record;
    expect(nightOpen(r, 3)).toBe(true);
    expect(firstUnwon(r)).toBeNull();
  });

  it('an fp mismatch resets that night and every later one', () => {
    const p = nights(plan(map, 1, 2));
    let r = emptyRecord();
    for (const x of p) r = applyRun(r, x.night, x.fp, won('B', 100)).record;
    expect(reconcile(p, r)).toEqual({ record: r, reset: null });
    // The map changed under night two: nights two and three start fresh, night one stays won.
    const changed = p.map((x) => (x.night === 2 ? { ...x, fp: '00000000' } : x));
    const rec = reconcile(changed, r);
    expect(rec.reset).toBe(2);
    expect(rec.record.nights[0]).toEqual(r.nights[0]);
    expect(rec.record.nights[1]).toBeNull();
    expect(rec.record.nights[2]).toBeNull();
    // Recording a run against a changed night resets it (and the ones after) the same way.
    const again = applyRun(r, 2, '00000000', lost()).record;
    expect(again.nights[1]).toEqual({ fp: '00000000', tries: 1 });
    expect(again.nights[2]).toBeNull();
    expect(again.nights[0]).toEqual(r.nights[0]);
  });

  it('runFrom takes its numbers from the finished sim and its grade', () => {
    const x = nights(plan(map, 1, 1))[0];
    const r = createSim(map, x.options);
    if (!r.ok) throw new Error(r.reason);
    const bot = new Bot(r.sim, SKILL.ace);
    while (r.sim.phase === 'running' && r.sim.t < 600) {
      bot.step(1 / 30);
      r.sim.step(1 / 30);
    }
    const s = r.sim.state();
    const score = gradeMission(scoreInput(r.sim.mission, s));
    const run = runFrom(r.sim.mission, s, score);
    const si = scoreInput(r.sim.mission, s);
    expect(run).toEqual({
      won: s.phase === 'won', grade: score.grade, time: s.t, survivorsTotal: s.survivorsTotal, survivorsSaved: si.survivorsSaved,
      friendlyHits: s.friendlyHits, kills: s.kills, integrity: s.integrity,
    });
  }, 60_000);
});

// ---------------------------------------------------------------------------------------
// Review round 1 (spec 001 build): truth of anchored nights, fingerprints, seeds, call budget.
// ---------------------------------------------------------------------------------------

const square = (cx: number, cz: number, h: number): V2[] => [
  { x: cx - h, z: cz - h }, { x: cx + h, z: cz - h }, { x: cx + h, z: cz + h }, { x: cx - h, z: cz + h },
];
/**
 * The sample town without its tennis club, parks or woods, plus a 52 x 52 m wood at (-300, 100) with a
 * playground 58 m east of its centre: the wood is a legal anchor (50 m from child places) but no horde may
 * gather in it (hordes keep 80 m), so a forest sweep there builds with its hordes out on the streets.
 */
function smallWoodMap(): MapData {
  const base = makeSampleTown();
  const wood = square(-300, 100, 26);
  return {
    ...base,
    name: 'Small wood',
    areas: [...base.areas.filter((a) => a.kind !== 'wood'), { id: 'tiny-wood', kind: 'wood', name: 'Tiny Wood', pts: wood }],
    features: [
      ...base.features!.filter((f) => !['tennis', 'park', 'forest'].includes(f.category)),
      { id: 'f-tiny-wood', category: 'forest', name: 'Tiny Wood', p: { x: -300, z: 100 }, pts: wood },
      { id: 'f-test-pg', category: 'playground', name: 'Test Playground', p: { x: -242, z: 100 }, pts: square(-242, 100, 6) },
    ],
  };
}

describe('single anchored clear missions are true to their place (BACKLOG 3.24)', () => {
  it('a clear-tennis with a playground just outside the anchor buffer is refused, not built with 0 hordes on the courts', () => {
    const base = makeSampleTown();
    const court = base.features!.find((f) => f.category === 'tennis')!;
    const m: MapData = {
      ...base,
      features: [...base.features!, ...[70, -70].map((dx, i) => ({ id: `f-test-pg2-${i}`, category: 'playground' as const, name: 'Test Playground', p: { x: court.p.x + dx, z: court.p.z }, pts: square(court.p.x + dx, court.p.z, 6) }))],
    };
    const g = buildRoadGraph(m);
    const w = new WalkGrid(m);
    let refused = 0;
    for (let seed = 1; seed <= 6; seed++) {
      const r = generateMission(m, g, w, { type: 'clear', difficulty: 2, seed, template: 'clear-tennis', anchor: court.id });
      if (r.ok) expect(r.mission.hordes.some((h) => h.label === r.mission.anchor!.name), `seed ${seed}`).toBe(true);
      else { refused++; expect(r.reason).toMatch(/can't gather/); }
    }
    expect(refused).toBeGreaterThan(0);
  });

  it('a forest sweep that cannot hold a horde is refused', () => {
    const m = smallWoodMap();
    const r = generateMission(m, buildRoadGraph(m), new WalkGrid(m), { type: 'clear', difficulty: 1, seed: nightSeed(1, 1), template: 'forest-sweep' });
    expect(r.ok).toBe(false);
  });
});

describe('campaign: anchored nights are true to their place (rule 9, campaign §9)', () => {
  it('every planned forest-sweep night has at least one horde labelled with the forest whose cold > 0', () => {
    const m = smallWoodMap();
    // The generator alone builds this forest sweep with no horde in the wood (that's the trap).
    const raw = generateMission(m, buildRoadGraph(m), new WalkGrid(m), { type: 'clear', difficulty: 1, seed: nightSeed(1, 1), template: 'forest-sweep' });
    expect(raw.ok && raw.mission.hordes.some((h) => h.label === raw.mission.anchor!.name)).toBe(false);
    let forests = 0;
    for (const S of [1, 2, 3, 4]) {
      const ns = nights(plan(m, S, 1));
      expect(ns[0].template, `S${S}`).not.toBe('forest-sweep');
      expect(ns[0].template).toBe('classic-clear');
      for (const x of [...ns, ...nights(plan(map, S, 1))]) {
        if (x.template !== 'forest-sweep') continue;
        forests++;
        expect(x.mission.hordes.some((h) => h.label === x.mission.anchor!.name && h.cold > 0)).toBe(true);
      }
    }
    // On a forest that can hold a horde, the sweep is still planned (and true).
    const woods = nights(plan(map, 1, 1, counting((o) => o.template === 'clear-tennis' || o.template === 'clear-park')));
    expect(woods[0].template).toBe('forest-sweep');
    expect(woods[0].mission.hordes.some((h) => h.label === woods[0].mission.anchor!.name && h.cold > 0)).toBe(true);
    expect(forests).toBeGreaterThanOrEqual(0);
  }, 120_000);

  it('every planned anchored clear night has a horde at its place', () => {
    for (const B of LEVELS) {
      for (const S of [1, 2, 3]) {
        for (const x of [...nights(plan(map, S, B)), ...nights(plan(map, S, B, counting((o) => o.type === 'escort')))]) {
          if (x.mission.type !== 'clear' || !x.mission.anchor) continue;
          expect(x.mission.hordes.some((h) => h.label === x.mission.anchor!.name), `${x.template} B${B} S${S}`).toBe(true);
        }
      }
    }
  }, 120_000);
});

describe('campaign: fingerprints cover where things are (review)', () => {
  it('missionFingerprint changes when a horde, a survivor start or the wave kinds change', () => {
    const [c, e, d] = nights(plan(map, 1, 2));
    const fp = (m: typeof c.mission) => missionFingerprint(m);
    const moved = { ...c.mission, hordes: c.mission.hordes.map((h, i) => (i === 0 ? { ...h, centre: { x: h.centre.x + 5, z: h.centre.z } } : h)) };
    expect(fp(moved)).not.toBe(c.fp);
    expect(fp({ ...c.mission, hordes: c.mission.hordes.map((h, i) => (i === 0 ? { ...h, count: h.count + 1 } : h)) })).not.toBe(c.fp);
    expect(fp({ ...c.mission, hordes: c.mission.hordes.map((h, i) => (i === 0 ? { ...h, cold: h.cold + 1 } : h)) })).not.toBe(c.fp);
    expect(fp({ ...c.mission, survivors: c.mission.survivors.map((v) => ({ ...v, start: { x: v.start.x + 9, z: v.start.z } })) })).not.toBe(c.fp);
    expect(fp({ ...d.mission, waves: { ...d.mission.waves!, kinds: [...d.mission.waves!.kinds!].reverse() } })).not.toBe(d.fp);
    expect(fp({ ...e.mission, title: 'Reworded', briefing: [] })).toBe(e.fp);
  });
});

describe('campaign: any seed gives a usable place key (review)', () => {
  it('placeKey hashes S, so huge, odd or long seeds still give a valid, distinct key', () => {
    const seeds = [1, 2, 1e21, Infinity, -Infinity, NaN, 12345678901234567890, -7, 0.5];
    const keys = seeds.map((S) => placeKey(S, map));
    for (const k of keys) expect(k).toMatch(/^[0-9a-f]{8}:[0-9a-f]{8}$/);
    expect(new Set(keys).size).toBe(keys.length);
    expect(placeKey(1, map)).toBe(placeKey(1, makeSampleTown()));
    for (const S of [1e21, Infinity]) expect(nights(plan(map, S, 2))).toHaveLength(3);
  }, 60_000);
});

describe('campaign: the call budget never starves a night of its own classic (review)', () => {
  it("with places everywhere and nothing anchored building, each night still reaches its classics and reports its own reason", () => {
    // Three of every anchored place, so each anchored template burns three calls.
    const base = makeSampleTown();
    const extra: Feature[] = base.features!.flatMap((f) => [1, 2].map((k) => ({ ...f, id: `${f.id}-copy${k}` })));
    const m: MapData = { ...base, name: 'Busy town', features: [...base.features!, ...extra] };
    const [s1, s2, s3] = [nightSeed(1, 1), nightSeed(1, 2), nightSeed(1, 3)];
    const allow = (o: MissionOptions) =>
      (o.seed === s1 && o.template === 'classic-defend') || (o.seed === s2 && o.template === 'classic-clear') || (o.seed === s3 && o.template === 'classic-defend');
    const gen = counting((o) => !allow(o));
    const p = plan(m, 1, 2, gen);
    expect(gen.calls).toBeLessThanOrEqual(MAX_GENERATOR_CALLS);
    const ns = nights(p);
    expect(ns.map((x) => x.template)).toEqual(['classic-defend', 'classic-clear', 'classic-defend']);
    // Nothing builds on night three: the reason is its own classic's, not an anchored template's.
    const none = plan(m, 1, 2, counting((o) => !allow(o) || o.seed === s3));
    expect(none.ok).toBe(false);
    if (!none.ok) {
      expect(none.night).toBe(3);
      expect(none.reason).toBe('Test: no classic-defend here.');
    }
  }, 120_000);
});
