import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { matchMissions } from '../src/map/recon';
import { generateMission, SHELTER_GAP } from '../src/sim/missions';
import { Sim } from '../src/sim/sim';
import { Bot, SKILL } from '../src/sim/bot';
import { geocode } from '../src/map/overpass';

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);

describe('sheltering friendlies (QA: ~8% of suggested missions were lost within seconds)', () => {
  it('every suggested Clear mission keeps its friendlies clear of every horde, and a perfect gunner never loses in the first 15 s', () => {
    let clears = 0;
    for (let seed = 1; seed <= 30; seed++) {
      for (let d = 1; d <= 5; d++) {
        for (const s of matchMissions(map, seed)) {
          const r = generateMission(map, graph, grid, { type: s.base, difficulty: d, seed, template: s.template, anchor: s.anchor?.id });
          expect(r.ok, `${s.template} d${d} s${seed}`).toBe(true);
          if (!r.ok || r.mission.type !== 'clear') continue;
          clears++;
          for (const f of r.mission.survivors) {
            for (const h of r.mission.hordes) {
              expect(Math.hypot(f.start.x - h.centre.x, f.start.z - h.centre.z), `${s.template} d${d} s${seed}`).toBeGreaterThanOrEqual(SHELTER_GAP - 5);
            }
          }
          const sim = new Sim(r.mission, map, graph, grid);
          const bot = new Bot(sim, SKILL.ace);
          while (sim.phase === 'running' && sim.t < 15) {
            bot.step(1 / 30);
            sim.step(1 / 30);
          }
          expect(sim.phase, `${s.template} d${d} s${seed}: ${sim.reason}`).not.toBe('lost');
        }
      }
    }
    expect(clears).toBeGreaterThan(50);
  }, 240_000);
});

describe('geocode', () => {
  it('rejects out-of-range coordinates without contacting OpenStreetMap', async () => {
    await expect(geocode('91, 200')).rejects.toThrow(/out of range/);
  });
});
