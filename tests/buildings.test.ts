import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { distToSegment, pointInPolygon } from '../src/map/geom';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import { MISSION_TYPES } from '../src/sim/missions';
import type { Sim } from '../src/sim/sim';
import type { MapData, V2 } from '../src/map/types';
import { bigTown, schoolHeavyTown } from './worldFixture';

/**
 * Owner playtest 3.15: "zombies climb into buildings and can't be seen". Real missions are played headless
 * (bot at human skill) and every zombie and survivor is checked against every building footprint at every step.
 * A survivor walking through the door of their own destination (home, or the safehouse for stragglers) is fine.
 */
const TOL = 0.3; // metres: how deep inside a wall an agent may stand (its body overlaps the wall a little)

class Footprints {
  private cells = new Map<number, V2[][]>();
  constructor(map: MapData, private size = 25) {
    for (const b of map.buildings) {
      if (b.pts.length < 3) continue;
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of b.pts) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
      for (let j = Math.floor(z0 / size); j <= Math.floor(z1 / size); j++) {
        for (let i = Math.floor(x0 / size); i <= Math.floor(x1 / size); i++) {
          const k = (j + 10_000) * 20_000 + (i + 10_000);
          (this.cells.get(k) ?? this.cells.set(k, []).get(k)!).push(b.pts);
        }
      }
    }
  }
  /** The footprint p stands more than TOL inside of, if any. */
  inside(p: V2): V2[] | null {
    const k = (Math.floor(p.z / this.size) + 10_000) * 20_000 + (Math.floor(p.x / this.size) + 10_000);
    for (const pts of this.cells.get(k) ?? []) {
      if (!pointInPolygon(p, pts)) continue;
      let edge = Infinity;
      for (let i = 0; i < pts.length; i++) edge = Math.min(edge, distToSegment(p, pts[i], pts[(i + 1) % pts.length]));
      if (edge > TOL) return pts;
    }
    return null;
  }
}

interface Breach { what: string; t: number; x: number; z: number }

function playAndWatch(fp: Footprints, sim: Sim, maxT: number): Breach[] {
  const bot = new Bot(sim, SKILL.human);
  const out: Breach[] = [];
  // A survivor's own destination: the building their route ends in (their home, or the safehouse).
  const doors = sim.survivors.map((s) => (s.route ? fp.inside(s.route[s.route.length - 1]) : null));
  const check = () => {
    for (const z of sim.zombies) if (z.alive && fp.inside(z)) out.push({ what: `zombie ${z.id}`, t: sim.t, x: z.x, z: z.z });
    sim.survivors.forEach((s, i) => {
      if (!s.alive || s.home) return;
      const b = fp.inside(s);
      if (b && b !== doors[i]) out.push({ what: `survivor ${s.id}`, t: sim.t, x: s.x, z: s.z });
    });
  };
  check();
  while (sim.phase === 'running' && sim.t < maxT && out.length < 50) {
    bot.step(1 / 30);
    sim.step(1 / 30);
    check();
  }
  return out;
}

describe('buildings are solid (3.15)', () => {
  const maps: [string, MapData][] = [
    ['sample town', makeSampleTown()],
    ['school-heavy town', schoolHeavyTown()],
    ['big synthetic suburb', bigTown(1500, 5)],
  ];
  for (const [name, map] of maps) {
    it(`no zombie or survivor ever stands inside a building: ${name}`, () => {
      const fp = new Footprints(map);
      const report: string[] = [];
      let played = 0;
      for (const type of MISSION_TYPES) {
        for (const difficulty of [2, 5]) {
          for (const seed of [1, 2]) {
            const r = createSim(map, { type, difficulty, seed });
            if (!r.ok) continue;
            played++;
            const b = playAndWatch(fp, r.sim, 240);
            if (b.length) report.push(`${type} d${difficulty} s${seed}: ${b.length}+ breaches, first ${b[0].what} at t=${b[0].t.toFixed(1)} (${b[0].x.toFixed(1)}, ${b[0].z.toFixed(1)})`);
          }
        }
      }
      expect(played).toBeGreaterThanOrEqual(6);
      expect(report).toEqual([]);
    }, 300_000);
  }
});
