import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph, dijkstra, nearestNode, pathFromPrev } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { generateMission, MISSION_TYPES, waveIntel, type MissionType } from '../src/sim/missions';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import type { Sim } from '../src/sim/sim';
import type { MapData } from '../src/map/types';

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);

function play(sim: Sim, bot: Bot | null, maxT = 900): Sim {
  while (sim.phase === 'running' && sim.t < maxT) {
    bot?.step(1 / 30);
    sim.step(1 / 30);
  }
  return sim;
}
const make = (type: MissionType, difficulty: number, seed: number) => {
  const r = createSim(map, { type, difficulty, seed });
  if (!r.ok) throw new Error(r.reason);
  return r.sim;
};

describe('road network and walk grid', () => {
  it('the sample town is one connected network', () => {
    expect(graph.mainCompShare).toBe(1);
  });
  it('finds a route between opposite corners', () => {
    const a = nearestNode(graph, { x: -400, z: -400 });
    const b = nearestNode(graph, { x: 400, z: 400 });
    const { d, prev } = dijkstra(graph, a);
    expect(d[b]).toBeCloseTo(1760, -1); // Manhattan distance on the grid of streets
    expect(pathFromPrev(prev, b)[0]).toBe(a);
  });
  it('blocks buildings and lets zombies flow around them', () => {
    const b = map.buildings.find((x) => x.kind === 'hospital')!;
    expect(grid.isBlocked(b.pts[0].x + 5, b.pts[0].z + 5)).toBe(true);
    const field = grid.flowField([grid.idx(0, 0)]);
    expect(grid.fieldAt(field, 300, 300)).toBeGreaterThan(0);
    expect(grid.downhill(field, 300, 300)).not.toBeNull();
  });
});

describe('mission generator (gate G4/G5 on the sample town)', () => {
  it('builds a valid mission for every type x difficulty x seed', () => {
    for (const type of MISSION_TYPES) {
      for (let d = 1; d <= 5; d++) {
        for (let seed = 1; seed <= 4; seed++) {
          const r = generateMission(map, graph, grid, { type, difficulty: d, seed });
          expect(r.ok, `${type} d${d} s${seed}`).toBe(true);
          if (!r.ok) continue;
          const m = r.mission;
          expect(m.briefing.length).toBeGreaterThan(2);
          // One line about cold-blooded contacts, plus one about how the waves vary whenever they do.
          expect(m.intel).toEqual([m.intel[0], ...(m.waves ? waveIntel(m.waves) : [])]);
          if (type === 'escort') expect(m.route!.length).toBeGreaterThan(2);
          if (type === 'clear') expect(m.hordes.length).toBeGreaterThanOrEqual(2);
          if (type !== 'clear') expect(m.safehouse).toBeDefined();
        }
      }
    }
  });

  it('is deterministic: same inputs give an identical mission; a different seed changes it', () => {
    const a = generateMission(map, graph, grid, { type: 'escort', difficulty: 3, seed: 42 });
    const b = generateMission(map, graph, grid, { type: 'escort', difficulty: 3, seed: 42 });
    const c = generateMission(map, graph, grid, { type: 'escort', difficulty: 3, seed: 43 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it('intel is truthful: it mentions cold-blooded contacts exactly when there are some', () => {
    for (const type of MISSION_TYPES) {
      for (const d of [1, 4]) {
        const sim = make(type, d, 3);
        play(sim, null, 60); // let a few waves arrive
        const saysCold = !/no cold-blooded/.test(sim.mission.intel[0]);
        const hasCold = sim.zombies.some((z) => z.cold) || (sim.mission.waves?.coldShare ?? 0) > 0;
        expect(saysCold, `${type} d${d}`).toBe(hasCold);
      }
    }
  });

  it('returns a clear reason instead of crashing on a map with no roads', () => {
    const empty: MapData = { ...map, roads: [], name: 'empty' };
    const r = createSim(empty, { type: 'escort', difficulty: 1, seed: 1 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/roads/);
  });
});

describe('simulation (gate G6: win and loss both reachable)', () => {
  it('replays identically with the same inputs', () => {
    const a = play(make('escort', 3, 5), null, 0);
    const s1 = make('escort', 3, 5);
    const s2 = make('escort', 3, 5);
    play(s1, new Bot(s1), 90);
    play(s2, new Bot(s2), 90);
    expect(JSON.stringify(s1.state())).toBe(JSON.stringify(s2.state()));
    expect(a.t).toBe(0);
  });

  for (const type of MISSION_TYPES) {
    it(`${type}: a capable gunner wins on difficulty 1`, () => {
      const sim = make(type, 1, 2);
      play(sim, new Bot(sim, SKILL.human));
      expect(sim.phase, sim.reason).toBe('won');
    });
    it(`${type}: doing nothing loses`, () => {
      const sim = make(type, 3, 2);
      play(sim, null);
      expect(sim.phase, sim.reason).toBe('lost');
    });
  }

  it('friendly fire twice ends the mission', () => {
    const sim = make('escort', 1, 1);
    play(sim, null, 12); // survivors set off
    for (let i = 0; i < 4 && sim.phase === 'running'; i++) {
      const s = sim.survivors.find((x) => x.alive && !x.home);
      if (!s) break;
      sim.fire('105', { x: s.x, z: s.z });
      play(sim, null, sim.t + 6);
    }
    expect(sim.friendlyHits).toBeGreaterThanOrEqual(2);
    expect(sim.phase).toBe('lost');
    expect(sim.reason).toMatch(/friendly/i);
  });

  it('guns respect magazine and reload', () => {
    const sim = make('clear', 1, 1);
    expect(sim.fire('105', { x: 0, z: 0 })).toBe(true);
    expect(sim.fire('105', { x: 0, z: 0 })).toBe(false); // reloading
    play(sim, null, 5);
    expect(sim.weaponReady('105')).toBe(true);
  });

  it('budget (QUALITY §2): one step with ~1,000 zombies takes under 4 ms on average', () => {
    const sim = make('defend', 5, 1);
    for (let i = 0; i < 1000; i++) {
      const p = grid.nearestFree({ x: ((i * 37) % 900) - 450, z: ((i * 53) % 900) - 450 });
      sim.zombies.push({ id: 10000 + i, x: p.x, z: p.z, vx: 0, vz: 0, speed: 1.5, cold: false, alive: true, diedAt: -1, home: null, goal: null });
    }
    const t0 = performance.now();
    for (let i = 0; i < 60; i++) sim.step(1 / 60);
    const ms = (performance.now() - t0) / 60;
    expect(ms).toBeLessThan(4);
  });
});

describe('committed fingerprint (gate G4 across machines and versions)', () => {
  it('the sample-town escort mission at difficulty 3, seed 42 has not changed', () => {
    const r = generateMission(map, graph, grid, { type: 'escort', difficulty: 3, seed: 42 });
    const json = JSON.stringify(r);
    let h = 2166136261;
    for (let i = 0; i < json.length; i++) h = Math.imul(h ^ json.charCodeAt(i), 16777619);
    // If this fails, missions changed for everyone: update the value only on purpose, and say so in the PR.
    expect((h >>> 0).toString(16)).toBe(EXPECTED_FINGERPRINT);
  });
});

describe('committed fingerprint: single-mission defend (locked before spec 001 touches missions.ts or sim.ts)', () => {
  const fnv = (s: string) => {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
    return (h >>> 0).toString(16);
  };
  it('committed fingerprint: sample-town defend d3 seed 42 has not changed', () => {
    const r = generateMission(map, graph, grid, { type: 'defend', difficulty: 3, seed: 42 });
    // If this fails, single-mission Hold changed for everyone: the campaign finale must never do that (spec 001 §4).
    expect(fnv(JSON.stringify(r))).toBe(EXPECTED_DEFEND_FINGERPRINT);
  });
  it('a single-mission defend plays identically (trace hash)', () => {
    const sim = make('defend', 3, 42);
    for (let i = 0; i < 1800; i++) sim.step(1 / 60);
    const q = (v: number) => Math.round(v * 1000);
    const trace = {
      state: sim.state(),
      zombies: sim.zombies.map((z) => [z.id, q(z.x), q(z.z), z.alive ? 1 : 0, z.cold ? 1 : 0]),
      survivors: sim.survivors.map((s) => [s.id, q(s.x), q(s.z), s.alive ? 1 : 0, s.home ? 1 : 0]),
    };
    expect(trace.zombies.length).toBeGreaterThan(0);
    expect(fnv(JSON.stringify(trace))).toBe(EXPECTED_DEFEND_TRACE);
  });
});
// Spec 001 step 1: locks today's single-mission Hold (mission and 30 s of play with no input) before the finale work.
const EXPECTED_DEFEND_FINGERPRINT = 'bdca4d43';
const EXPECTED_DEFEND_TRACE = '9028d334';

// 3dd039a3 (phase 3.2): waves vary within a mission (WavePlan.kinds) and the intel says how. Stripped of those two, it is still 7de5904e.
// be9b7fe7 (phase 3.8): escort routes may not pass within 50 m of a school, kindergarten or playground, so homes whose
// shortest road passed one now have a longer, clear road (or drop out), and the seeded pick lands on a different home.
const EXPECTED_FINGERPRINT = 'be9b7fe7';

describe('regressions from the phase 1 playtest', () => {
  it('escort ambushes never spawn on top of survivors (was: 3.5% of missions lost by second 5)', () => {
    for (let d = 1; d <= 5; d++) {
      for (let seed = 1; seed <= 40; seed++) {
        const sim = make('escort', d, seed);
        play(sim, null, 4); // first wave arrives at t = 3 s
        for (const s of sim.survivors) {
          const nearest = Math.min(...sim.zombies.filter((z) => z.alive).map((z) => Math.hypot(z.x - s.x, z.z - s.z)));
          expect(nearest, `escort d${d} seed ${seed}`).toBeGreaterThanOrEqual(55);
        }
      }
    }
  }, 120_000);

  it('a perfect gunner wins escort on difficulty 1 for nearly every seed', () => {
    let wins = 0;
    for (let seed = 1; seed <= 8; seed++) {
      const sim = make('escort', 1, seed);
      play(sim, new Bot(sim, SKILL.ace));
      if (sim.phase === 'won') wins++;
    }
    expect(wins).toBeGreaterThanOrEqual(7);
  }, 180_000);

  it('defend waves only spawn where zombies can walk to the safehouse', () => {
    for (let seed = 1; seed <= 6; seed++) {
      const sim = make('defend', 3, seed);
      play(sim, null, 30);
      const field = sim.grid.flowField(sim.grid.perimeterCells(sim.mission.safehouse!.poly));
      const stranded = sim.zombies.filter((z) => z.alive && sim.grid.fieldAt(field, z.x, z.z) < 0);
      expect(stranded.length, `defend seed ${seed}`).toBe(0);
    }
  }, 60_000);

  it('rejects a NaN difficulty or unknown mission type instead of building a broken mission', () => {
    expect(generateMission(map, graph, grid, { type: 'clear', difficulty: NaN, seed: 1 }).ok).toBe(false);
    expect(generateMission(map, graph, grid, { type: 'foo' as MissionType, difficulty: 2, seed: 1 }).ok).toBe(false);
  });
});

describe('guardrail: waves stay away from schools, kindergartens and playgrounds (PLAN §9)', () => {
  it('no wave zombie ever spawns within 60 m of one, even when schools line half the map', async () => {
    const { nearChildPlace } = await import('../src/map/recon');
    // Schools at every road junction on the west side: without the guard, waves land there.
    const schools = graph.nodes
      .filter((n, i) => n.x <= -200 && i % 2 === 0)
      .map((n, i) => ({ id: `testschool${i}`, p: { x: n.x + 8, z: n.z + 8 }, kind: 'school', name: `Test School ${i}` }));
    const schoolMap: MapData = { ...map, name: 'school-test', pois: [...map.pois, ...schools] };
    let checked = 0;
    for (const type of ['escort', 'defend'] as MissionType[]) {
      for (let seed = 1; seed <= 6; seed++) {
        const r = createSim(schoolMap, { type, difficulty: 4, seed });
        if (!r.ok) continue;
        const sim = r.sim;
        const seen = new Set<number>();
        for (let t = 0; t < 150 && sim.phase === 'running'; t += 1) {
          play(sim, null, t + 1);
          for (const z of sim.zombies) {
            if (seen.has(z.id)) continue;
            seen.add(z.id);
            checked++;
            // spawn spread is 12 m around the node, so allow that much inside the 60 m gap
            expect(nearChildPlace(schoolMap, { x: z.x, z: z.z }, 45), `${type} seed ${seed} zombie ${z.id}`).toBe(false);
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  }, 180_000);
});

describe('training helpers', () => {
  it('addZombie gives every new zombie a fresh id, on walkable ground, even after waves have spawned', () => {
    const sim = make('defend', 3, 2);
    play(sim, null, 20); // waves add zombies through the sim's own counter
    const before = sim.zombies.length;
    const a = sim.addZombie({ x: 0, z: 0 }, true, { x: 0, z: 0 });
    const b = sim.addZombie({ x: 5, z: 5 }, false, null);
    expect(sim.zombies.length).toBe(before + 2);
    expect(a.cold).toBe(true);
    expect(b.cold).toBe(false);
    expect(a.alive && b.alive).toBe(true);
    expect(sim.grid.isBlocked(a.x, a.z)).toBe(false);
    const ids = sim.zombies.map((z) => z.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(b.id).toBeGreaterThan(a.id);
  });

  it('revive brings back a fallen survivor by id, and only a fallen one', () => {
    const sim = make('escort', 2, 3);
    const s = sim.survivors[1];
    expect(sim.revive(s.id)).toBe(false); // alive already
    s.alive = false;
    s.hp = 0;
    s.diedAt = sim.t;
    expect(sim.revive(s.id)).toBe(true);
    expect(s.alive).toBe(true);
    expect(s.hp).toBe(1);
    expect(s.diedAt).toBe(-1);
    expect(sim.revive(s.id)).toBe(false); // already up
    expect(sim.revive(9999)).toBe(false);
  });
});
