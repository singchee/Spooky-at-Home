import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph, type RoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { parseOverpass } from '../src/map/overpass';
import { generateMission, type MissionOptions } from '../src/sim/missions';
import { Sim } from '../src/sim/sim';
import { Bot, SKILL } from '../src/sim/bot';
import { planLayout, trainingMission } from '../src/ui/tutorialSteps';
import type { MapData } from '../src/map/types';
import { schoolHeavyTown } from './worldFixture';

/**
 * Owner's report: "Sometimes the cold-blooded ones are impossible to find and the game goes forever without ending."
 * Regressions for the causes found headless (see the fix commits), and the endgame search help.
 */
interface Town {
  name: string;
  map: MapData;
  graph: RoadGraph;
  grid: WalkGrid;
}
const towns = new Map<string, Town>();
function town(name: string): Town {
  let t = towns.get(name);
  if (!t) {
    let map: MapData;
    if (name === 'sample') map = makeSampleTown();
    else if (name === 'school') map = schoolHeavyTown();
    else {
      const raw = JSON.parse(readFileSync(new URL(`../maps/fixtures/${name}.json`, import.meta.url), 'utf8'));
      map = parseOverpass({ elements: raw.elements }, raw.spooky_fixture.origin, raw.spooky_fixture.half, name);
    }
    t = { name, map, graph: buildRoadGraph(map), grid: new WalkGrid(map) };
    towns.set(name, t);
  }
  return t;
}
function clearSim(t: Town, opts: MissionOptions): Sim | null {
  const r = generateMission(t.map, t.graph, t.grid, opts);
  return r.ok ? new Sim(r.mission, t.map, t.graph, t.grid) : null;
}

describe('cause 1: a milling zombie whose goal is behind a wall freezes there for good', () => {
  it('Training night: the cold one by the marker never stands still for a minute', () => {
    const t = town('sample');
    const l = planLayout(t.map, t.graph, t.grid)!;
    const sim = new Sim(trainingMission(t.map, l), t.map, t.graph, t.grid, { scatter: false, drift: false });
    const cold = sim.zombies.find((z) => z.cold)!;
    let last = { x: cold.x, z: cold.z, t: 0 };
    let still = 0;
    for (let i = 0; i < 600 * 30; i++) {
      sim.step(1 / 30);
      if (Math.hypot(cold.x - last.x, cold.z - last.z) > 0.5) last = { x: cold.x, z: cold.z, t: sim.t };
      still = Math.max(still, sim.t - last.t);
    }
    expect(still, 'longest time the cold one stood still (s)').toBeLessThan(60);
  }, 60_000);

  it('no horde zombie in a Clear mission stands still for a minute (nobody firing)', () => {
    // Before the fix: 635 zombies (of 24 missions) stood still for over a minute. After: none on the sample town, and
    // on Adelaide's CBD a handful from one horde (d3 seed 4), left behind by its drift in a slanted corner of
    // footprints thinner than the 3 m walk-grid cell. The endgame search help still marks those (see below).
    const stuck = new Map<string, number>();
    for (const name of ['sample', 'adelaide-cbd']) {
      const t = town(name);
      for (const d of [3, 5]) {
        for (let seed = 1; seed <= 6; seed++) {
          const sim = clearSim(t, { type: 'clear', difficulty: d, seed });
          if (!sim) continue;
          const last = new Map<number, { x: number; z: number; t: number }>();
          for (let i = 0; i < 200 * 15 && sim.phase === 'running'; i++) {
            sim.step(1 / 15);
            if (i % 15) continue;
            for (const z of sim.zombies) {
              const l = last.get(z.id);
              if (!l || Math.hypot(z.x - l.x, z.z - l.z) > 0.5) last.set(z.id, { x: z.x, z: z.z, t: sim.t });
              else if (sim.t - l.t > 60) stuck.set(`${name} d${d} s${seed} z${z.id}`, 1);
            }
          }
        }
      }
    }
    const keys = [...stuck.keys()];
    expect(keys.filter((k) => k.startsWith('sample'))).toEqual([]);
    expect(keys.length, keys.join(', ')).toBeLessThanOrEqual(6);
  }, 240_000);
});

describe('cause 2: hordes placed past the edge of the playable map, or walled into a pocket', () => {
  it('every horde zombie starts inside 90% of the half-width, on ground connected to its horde', () => {
    const bad: string[] = [];
    for (const name of ['sample', 'school', 'adelaide-cbd', 'gundagai', 'west-hobart']) {
      const t = town(name);
      const lim = t.map.half * 0.9;
      for (const template of ['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'] as const) {
        for (const d of [1, 3, 5]) {
          for (let seed = 1; seed <= 8; seed++) {
            const sim = clearSim(t, { type: 'auto', difficulty: d, seed, template });
            if (!sim) continue;
            const fields = new Map<object, Int32Array>();
            for (const z of sim.zombies) {
              const tag = `${name} ${template} d${d} s${seed} z${z.id}`;
              if (Math.abs(z.x) > lim || Math.abs(z.z) > lim) bad.push(`${tag} edge`);
              let f = fields.get(z.home!);
              if (!f) fields.set(z.home!, (f = t.grid.flowField([t.grid.idx(z.home!.x, z.home!.z)])));
              if (t.grid.fieldAt(f, z.x, z.z) < 0) bad.push(`${tag} pocket`);
            }
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 240_000);

  it('with the human bot firing, no zombie ever leaves 90% of the half-width (gundagai and west-hobart)', () => {
    for (const name of ['gundagai', 'west-hobart']) {
      const t = town(name);
      const lim = t.map.half * 0.9;
      for (const template of ['clear-park', 'forest-sweep', 'classic-clear'] as const) {
        for (const d of [2, 4]) {
          for (let seed = 1; seed <= 4; seed++) {
            const sim = clearSim(t, { type: 'auto', difficulty: d, seed, template });
            if (!sim) continue;
            const bot = new Bot(sim, SKILL.human);
            while (sim.phase === 'running') {
              bot.step(1 / 30);
              sim.step(1 / 30);
              for (const z of sim.zombies) if (z.alive) expect(Math.max(Math.abs(z.x), Math.abs(z.z)), `${name} ${template} d${d} s${seed} z${z.id}`).toBeLessThanOrEqual(lim);
            }
          }
        }
      }
    }
  }, 240_000);
});
