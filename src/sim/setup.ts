import type { MapData } from '../map/types';
import { buildRoadGraph } from '../map/roadGraph';
import { WalkGrid } from '../map/grid';
import { generateMission, type MissionOptions, type MissionResult } from './missions';
import { Sim } from './sim';

/** One call to go from a map to a ready-to-run simulation (or a player-facing reason it can't). */
export function createSim(map: MapData, opts: MissionOptions): { ok: true; sim: Sim } | { ok: false; reason: string } {
  const graph = buildRoadGraph(map);
  const grid = new WalkGrid(map);
  const r: MissionResult = generateMission(map, graph, grid, opts);
  if (!r.ok) return r;
  return { ok: true, sim: new Sim(r.mission, map, graph, grid) };
}
