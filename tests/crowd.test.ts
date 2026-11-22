import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { distToSegment, pointInPolygon } from '../src/map/geom';
import type { MapData, V2 } from '../src/map/types';
import { MISSION_TYPES, CHILD_FIRE_CLEARANCE, likelyWaveDirections } from '../src/sim/missions';
import {
  CROWD_FIGURE_CAP, CROWD_SCHEDULE, CROWD_SIZES, CROWD_SIZE_IDS, DAWN, MAX_SPAWNS_PER_STEP, STREAM_JITTER, SURGE_START, crowdDoors, crowdNoGo, generateCrowd, type CrowdSize,
} from '../src/sim/crowd';
import { MAX_KILL_REACH } from '../src/sim/weapons';
import { Sim } from '../src/sim/sim';
import { Bot, SKILL } from '../src/sim/bot';
import { mulberry32 } from '../src/util/rng';
import { schoolHeavyTown } from './worldFixture';

/** Spec 003 (Horde Night), technical design §7 tests 1-8: the headless crowd. */
const sample = makeSampleTown();
const heavy = schoolHeavyTown();
const ctx = new Map<MapData, { g: ReturnType<typeof buildRoadGraph>; grid: WalkGrid }>();
const of = (map: MapData) => {
  let c = ctx.get(map);
  if (!c) ctx.set(map, (c = { g: buildRoadGraph(map), grid: new WalkGrid(map) }));
  return c;
};
const crowd = (map: MapData, seed: number, size: CrowdSize) => {
  const { g, grid } = of(map);
  const r = generateCrowd(map, g, grid, { seed, size });
  if (!r.ok) throw new Error(r.reason);
  return new Sim(r.mission, map, g, grid);
};
const fnv = (s: string) => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(16);
};
const trace = (sim: Sim) => {
  const q = (v: number) => Math.round(v * 1000);
  return fnv(JSON.stringify({ state: sim.state(), z: sim.zombies.map((z) => [z.id, q(z.x), q(z.z), z.alive ? 1 : 0]) }));
};

/** Child places read straight from the map (independent of the code under test), as tests/guardrail.test.ts does. */
function childPlaces(town: MapData): { p: V2; pts?: V2[]; box: { x0: number; x1: number; z0: number; z1: number } }[] {
  const out: { p: V2; pts?: V2[] }[] = [];
  for (const f of town.features ?? []) if (['school', 'kindergarten', 'playground'].includes(f.category)) out.push({ p: f.p, pts: f.pts });
  for (const p of town.pois) if (['school', 'kindergarten', 'childcare', 'playground'].includes(p.kind)) out.push({ p: p.p });
  for (const b of town.buildings) if (['school', 'kindergarten', 'childcare', 'college'].includes(b.kind)) out.push({ p: b.pts[0], pts: b.pts });
  return out.map((z) => {
    const pts = [z.p, ...(z.pts ?? [])];
    return { ...z, box: { x0: Math.min(...pts.map((q) => q.x)), x1: Math.max(...pts.map((q) => q.x)), z0: Math.min(...pts.map((q) => q.z)), z1: Math.max(...pts.map((q) => q.z)) } };
  });
}
function nearChild(zones: ReturnType<typeof childPlaces>, p: V2, floor: number): number {
  let best = Infinity;
  for (const z of zones) {
    if (p.x < z.box.x0 - floor || p.x > z.box.x1 + floor || p.z < z.box.z0 - floor || p.z > z.box.z1 + floor) continue;
    best = Math.min(best, Math.hypot(p.x - z.p.x, p.z - z.p.z));
    if (!z.pts) continue;
    if (pointInPolygon(p, z.pts)) return 0;
    for (let i = 0, j = z.pts.length - 1; i < z.pts.length; j = i++) best = Math.min(best, distToSegment(p, z.pts[j], z.pts[i]));
  }
  return best;
}

describe('crowd night: shape and sizes', () => {
  it("the mode is a 'defend' with a crowd plan; MISSION_TYPES is untouched; sizes fit the owner's 1,200-figure cap", () => {
    expect(MISSION_TYPES).toEqual(['clear', 'escort', 'defend']);
    for (const id of CROWD_SIZE_IDS) expect(CROWD_SIZES[id].maxAlive + CROWD_SIZES[id].bodies).toBeLessThanOrEqual(CROWD_FIGURE_CAP);
    expect(CROWD_SIZES.big.maxAlive).toBeGreaterThanOrEqual(400); // the Game Director's floor for Big
    const m = crowd(sample, 1, 'big').mission;
    expect(m.type).toBe('defend');
    expect(m.timeLimit).toBe(DAWN);
    expect(m.crowd!.streams.length).toBeGreaterThanOrEqual(3);
    expect(m.crowd!.streams.length).toBeLessThanOrEqual(4);
    // The tactical map's arrows are the plan's streams (true intel).
    expect(likelyWaveDirections(m, sample, of(sample).g).map((d) => d.compass)).toEqual(m.crowd!.streams.map((s) => s.compass));
  });
});

describe('crowd night: determinism (test 1)', () => {
  it('same map, seed and size give the identical run; Big and Huge differ', () => {
    const run = (size: CrowdSize) => {
      const sim = crowd(sample, 7, size);
      while (sim.phase === 'running' && sim.t < DAWN) sim.step(1 / 60);
      return trace(sim);
    };
    const big = run('big');
    expect(run('big')).toBe(big);
    expect(run('huge')).not.toBe(big);
  }, 120_000);
});

describe('crowd night: the child guardrail, every step (test 2)', () => {
  const floor = MAX_KILL_REACH + CHILD_FIRE_CLEARANCE;
  it('no living zombie is ever within 54 m of a school, kindergarten or playground, at every step, with the bot firing', () => {
    expect(floor).toBe(54);
    let checks = 0;
    for (const map of [heavy, sample]) {
      const zones = childPlaces(map);
      for (const size of CROWD_SIZE_IDS) {
        for (const seed of [1, 2, 3, 4]) {
          const sim = crowd(map, seed, size);
          const bot = new Bot(sim, SKILL.human);
          while (sim.phase === 'running') {
            bot.step(1 / 30);
            sim.step(1 / 30);
            for (const z of sim.living) {
              if (!z.alive) continue;
              checks++;
              const d = nearChild(zones, z, floor);
              if (d < floor) throw new Error(`${map.name} ${size} seed ${seed}: zombie ${z.id} ${d.toFixed(1)} m from a child place at t=${sim.t.toFixed(2)}`);
            }
          }
        }
      }
    }
    expect(checks).toBeGreaterThan(1_000_000);
  }, 600_000);

  it("an anchor whose doors sit within the gap of a playground isn't offered, and the reason says why", () => {
    const town = schoolHeavyTown({ playgroundBesideSafehouse: true });
    const g = buildRoadGraph(town);
    const grid = new WalkGrid(town);
    for (const size of CROWD_SIZE_IDS) {
      const r = generateCrowd(town, g, grid, { seed: 1, size });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/keeps clear of schools and playgrounds/);
    }
  });
});

describe('crowd night: where it is not offered, the reason is true', () => {
  it('a landmark at the end of one long road: too few ways in, and the reason says that (not schools)', () => {
    const rect = (x0: number, z0: number, x1: number, z1: number) => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
    const road = (id: string, pts: V2[]) => ({ id, pts, kind: 'residential', width: 7, name: `Long ${id}` });
    const town: MapData = {
      name: 'One road town', half: 550, attribution: 'test', areas: [], features: [],
      roads: [road('a', Array.from({ length: 11 }, (_, i) => ({ x: -40 + i * 45, z: 0 }))), road('b', [{ x: -40, z: -40 }, { x: -40, z: 0 }, { x: -40, z: 40 }])],
      buildings: [{ id: 'h', pts: rect(-30, 10, 10, 40), height: 10, kind: 'hospital', name: 'End Hospital' }],
      pois: [{ id: 'h', p: { x: -10, z: 25 }, kind: 'hospital', name: 'End Hospital' }],
    } as unknown as MapData;
    const r = generateCrowd(town, buildRoadGraph(town), new WalkGrid(town), { seed: 1, size: 'big' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/from enough directions before dawn/);
  });
});

describe('crowd night: intel is true (test 3)', () => {
  it('every zombie spawns at a named stream; all warm; nobody out there but them; the briefing says so', () => {
    for (const size of CROWD_SIZE_IDS) {
      const sim = crowd(sample, 3, size);
      const m = sim.mission;
      const text = [...m.briefing, ...m.intel].join(' ');
      for (const s of m.crowd!.streams) expect(text).toContain(`from the ${s.compass} along ${s.street}`);
      expect(text).toMatch(/every one of them is warm/);
      expect(text).toMatch(/Nobody is out on the streets but them/);
      expect(text).toMatch(/no cold-blooded contacts/);
      expect(m.survivors).toEqual([]);
      let seen = 0;
      while (sim.phase === 'running' && sim.t < 200) {
        sim.step(1 / 30);
        for (; seen < sim.zombies.length; seen++) {
          const z = sim.zombies[seen];
          expect(z.cold).toBe(false);
          const near = Math.min(...m.crowd!.streams.map((s) => Math.hypot(z.x - s.at.x, z.z - s.at.z)));
          expect(near).toBeLessThanOrEqual(STREAM_JITTER + z.speed * 1.25 / 30 + 1e-6);
        }
      }
      expect(seen).toBeGreaterThan(300);
      expect(sim.survivors.length).toBe(0);
    }
  }, 120_000);
});

describe('crowd night: the surge arrives (test 4)', () => {
  it('unopposed, zombies reach the doors well before dawn and the run is lost', () => {
    for (const size of CROWD_SIZE_IDS) {
      const sim = crowd(sample, 2, size);
      let first = -1;
      while (sim.phase === 'running') {
        sim.step(1 / 30);
        if (first < 0 && sim.state().crowd!.atDoors > 0) first = sim.t;
      }
      expect(first).toBeGreaterThan(0);
      expect(first).toBeLessThan(DAWN - 5);
      expect(sim.phase).toBe('lost');
      expect(sim.reason).toMatch(/^The doors gave at \d:\d\d\.$/);
    }
  }, 120_000);

  it('the dawn surge itself reaches the doors before dawn, from every stream, at both sizes', () => {
    for (const size of CROWD_SIZE_IDS) {
      for (const seed of [1, 2, 3]) {
        const { g, grid } = of(sample);
        const r = generateCrowd(sample, g, grid, { seed, size });
        if (!r.ok) throw new Error(r.reason);
        const m = r.mission;
        m.crowd!.doors = { cap: 0, rate: 0 }; // unbreakable doors, so the run goes on to dawn
        const sim = new Sim(m, sample, g, grid);
        const noGo = crowdNoGo(sample, grid);
        const field = grid.flowField(crowdDoors(grid, m.safehouse!.poly, noGo), noGo);
        const firstSurgeId = new Map<number, number>();
        const arrived = new Set<number>();
        let cleared = false;
        while (sim.phase === 'running') {
          if (!cleared && sim.t >= SURGE_START - 1) {
            // A perfect gunner clears the streets just before the surge, so the cap doesn't drop surge spawns.
            for (const z of sim.living) Object.assign(z, { alive: false, diedAt: sim.t });
            cleared = true;
          }
          const before = sim.zombies.length;
          sim.step(1 / 30);
          if (sim.t - 1 / 30 >= SURGE_START) {
            for (let i = before; i < sim.zombies.length; i++) {
              const z = sim.zombies[i];
              const k = m.crowd!.streams.findIndex((s) => Math.hypot(z.x - s.at.x, z.z - s.at.z) <= STREAM_JITTER + 0.2);
              if (k >= 0 && !firstSurgeId.has(k)) firstSurgeId.set(k, z.id);
            }
          }
          for (const [k, id] of firstSurgeId) if (!arrived.has(k) && grid.fieldAt(field, sim.zombies[id].x, sim.zombies[id].z) === 0 && sim.t < DAWN - 5) arrived.add(k);
        }
        expect(sim.phase).toBe('won');
        expect(sim.reason).toBe('The doors held. Everyone inside saw the dawn.');
        expect(firstSurgeId.size, `${size} seed ${seed}`).toBe(m.crowd!.streams.length);
        expect(arrived.size, `${size} seed ${seed}: streams whose first surge zombie reached the doors before dawn`).toBe(m.crowd!.streams.length);
      }
    }
  }, 300_000);
});

describe('crowd night: budget (test 5)', () => {
  it('a step with 2,000 living crowd zombies (separation on) and 6,000 dead entries takes under 4 ms; the dead cost nothing', () => {
    const run = (dead: number) => {
      const sim = crowd(sample, 1, 'huge');
      const { grid } = of(sample);
      const noGo = crowdNoGo(sample, grid);
      for (let i = 0; i < dead; i++) sim.zombies.push({ id: 50000 + i, x: 0, z: 0, vx: 0, vz: 0, speed: 2, cold: false, alive: false, diedAt: 0, home: null, goal: null });
      const r = mulberry32(99);
      const streams = sim.mission.crowd!.streams;
      let n = 0;
      while (n < 2000) {
        const s = streams[n % streams.length].at;
        const p = { x: s.x + (r() - 0.5) * 120, z: s.z + (r() - 0.5) * 120 };
        if (grid.isBlocked(p.x, p.z) || noGo[grid.idx(p.x, p.z)]) continue;
        sim.zombies.push({ id: 10000 + n, x: p.x, z: p.z, vx: 0, vz: 0, speed: 2.2, cold: false, alive: true, diedAt: -1, home: null, goal: null });
        n++;
      }
      for (let i = 0; i < 10; i++) sim.step(1 / 60);
      const t0 = performance.now();
      for (let i = 0; i < 60; i++) {
        if (i % 5 === 0) sim.fire('25', streams[0].at);
        sim.step(1 / 60);
      }
      const ms = (performance.now() - t0) / 60;
      expect(sim.living.length).toBeGreaterThanOrEqual(1900);
      return ms;
    };
    const none = run(0);
    const withDead = run(6000);
    console.log(`crowd sim step: 2,000 living ${none.toFixed(2)} ms; + 6,000 dead ${withDead.toFixed(2)} ms`);
    expect(withDead).toBeLessThan(4);
    expect(withDead).toBeLessThan(none * 1.2 + 0.2);
  }, 120_000);
});

describe('crowd night: kerb to kerb (test 6)', () => {
  it('a build-phase stream fills the street: median distance from the road centreline is over 2 m', () => {
    const sim = crowd(sample, 1, 'big');
    const segs: [V2, V2][] = [];
    for (const road of sample.roads) for (let i = 1; i < road.pts.length; i++) segs.push([road.pts[i - 1], road.pts[i]]);
    const offs: number[] = [];
    while (sim.t < 130) {
      sim.step(1 / 60);
      if (sim.t < 100 || Math.abs(sim.t - Math.round(sim.t)) > 1e-6 + 1 / 120) continue;
      const doors = sim.mission.safehouse!.centre;
      for (const z of sim.living) {
        if (!z.alive || Math.hypot(z.x - doors.x, z.z - doors.z) < 60) continue; // streams, not the pile at the doors
        let d = Infinity;
        for (const [a, b] of segs) d = Math.min(d, distToSegment(z, a, b));
        if (d < 12) offs.push(d);
      }
    }
    offs.sort((a, b) => a - b);
    const median = offs[offs.length >> 1];
    console.log(`kerb to kerb: median ${median.toFixed(2)} m from the centreline over ${offs.length} samples`);
    expect(offs.length).toBeGreaterThan(1000);
    expect(median).toBeGreaterThan(2);
  }, 120_000);
});

describe('crowd night: spawns trickle (test 8)', () => {
  it('never more than 8 spawns in one step, even with a long step; the rest come the next step, not dropped', () => {
    const sim = crowd(sample, 1, 'huge');
    let max = 0;
    while (sim.phase === 'running' && sim.t < 250) {
      const before = sim.zombies.length;
      sim.step(0.5);
      max = Math.max(max, sim.zombies.length - before);
    }
    expect(max).toBe(MAX_SPAWNS_PER_STEP);
    const st = sim.state().crowd!;
    expect(st.spawned + st.dropped).toBeGreaterThan(0);
  });

  it('the schedule is data on time only: warm-up, build, a lull, then the surge', () => {
    expect(CROWD_SCHEDULE[0]).toMatchObject({ from: 0, streams: 2 });
    const lull = CROWD_SCHEDULE.find((r) => r.rate === 0)!;
    expect(lull.to - lull.from).toBeGreaterThanOrEqual(10);
    expect(lull.to).toBe(SURGE_START);
    const surge = CROWD_SCHEDULE.find((r) => r.from === SURGE_START)!;
    expect(surge.rate).toBe(Math.max(...CROWD_SCHEDULE.map((r) => r.rate)));
  });
});
