import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { CHILD_CATEGORIES, MISSION_TEMPLATES, nearChildPlace } from '../src/map/recon';
import { generateMission, type MissionOptions } from '../src/sim/missions';
import { createSim } from '../src/sim/setup';
import { hashString } from '../src/util/rng';
import type { MapData } from '../src/map/types';
import {
  LEVELS, MAX_GENERATOR_CALLS, NIGHT_BASE, NIGHT_PREFERENCES, NIGHT_SUBSTITUTES, NIGHTS,
  mapFingerprint, missionFingerprint, nightDifficulty, nightSeed, planCampaign, type CampaignPlan, type Generator, type Level, type NightPlan,
} from '../src/sim/campaign';

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
