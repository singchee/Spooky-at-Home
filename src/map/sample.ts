import type { Area, Building, MapData, Poi, Road, V2 } from './types';
import { mulberry32 } from '../util/rng';

/**
 * A made-up suburb, generated in code, so the game is playable with no network
 * and so tests have a stable map. Same output format as a real OpenStreetMap download.
 */
const STREETS = ['Wattle', 'Banksia', 'Grevillea', 'Acacia', 'Myrtle', 'Main', 'Station', 'Orchard', 'Kestrel', 'Heron', 'Ironbark'];
const AVES = ['Albert', 'Victoria', 'Railway', 'Church', 'High', 'Bridge', 'Mill', 'Park', 'Hill', 'River', 'Market'];

export function makeSampleTown(seed = 7): MapData {
  const r = mulberry32(seed);
  const step = 110;
  const n = 5;
  const half = n * step;
  const roads: Road[] = [];
  const buildings: Building[] = [];
  const areas: Area[] = [];
  const pois: Poi[] = [];

  // Streets run north-south (x fixed), avenues east-west (z fixed). Points at every crossing so the road network joins up.
  for (let i = -n; i <= n; i++) {
    const ns: V2[] = [];
    const ew: V2[] = [];
    for (let j = -n; j <= n; j++) {
      ns.push({ x: i * step, z: j * step });
      ew.push({ x: j * step, z: i * step });
    }
    const main = i === 0;
    roads.push({ id: `ns${i}`, pts: ns, kind: main ? 'primary' : 'residential', width: main ? 10 : 7, name: `${STREETS[i + n]} Street` });
    roads.push({ id: `ew${i}`, pts: ew, kind: main ? 'secondary' : 'residential', width: main ? 9 : 7, name: `${AVES[i + n]} Avenue` });
  }

  const parks = new Set(['2,-3', '-4,1', '3,3']);
  const school = '-2,2';
  const hospital = '1,-1';
  let bid = 0;
  const box = (cx: number, cz: number, w: number, d: number, h: number, kind: string, name?: string) => {
    buildings.push({
      id: `b${bid++}`,
      pts: [
        { x: cx - w / 2, z: cz - d / 2 },
        { x: cx + w / 2, z: cz - d / 2 },
        { x: cx + w / 2, z: cz + d / 2 },
        { x: cx - w / 2, z: cz + d / 2 },
      ],
      height: h,
      kind,
      name,
    });
  };

  for (let bx = -n; bx < n; bx++) {
    for (let bz = -n; bz < n; bz++) {
      const x0 = bx * step + 8;
      const x1 = (bx + 1) * step - 8;
      const z0 = bz * step + 8;
      const z1 = (bz + 1) * step - 8;
      const key = `${bx},${bz}`;
      const cx = (x0 + x1) / 2;
      const cz = (z0 + z1) / 2;
      if (parks.has(key)) {
        areas.push({ id: `p${key}`, kind: 'park', name: `${STREETS[bx + n]} Reserve`, pts: [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }] });
        if (key === '3,3') {
          areas.push({ id: 'pond', kind: 'water', name: 'Heron Pond', pts: [{ x: cx - 20, z: cz - 12 }, { x: cx + 18, z: cz - 16 }, { x: cx + 22, z: cz + 10 }, { x: cx - 15, z: cz + 15 }] });
        }
        continue;
      }
      if (key === school) {
        box(cx - 15, cz, 50, 22, 8, 'school', 'Wattle Hill Primary School');
        box(cx + 25, cz + 20, 20, 30, 7, 'school');
        pois.push({ id: 'school', p: { x: cx - 15, z: cz }, kind: 'school', name: 'Wattle Hill Primary School' });
        continue;
      }
      if (key === hospital) {
        box(cx, cz, 60, 45, 22, 'hospital', 'St Kestrel Hospital');
        pois.push({ id: 'hospital', p: { x: cx, z: cz }, kind: 'hospital', name: 'St Kestrel Hospital' });
        continue;
      }
      const commercial = bx === -1 || bx === 0;
      if (commercial && bz > -3 && bz < 2) {
        for (let k = 0; k < 3; k++) box(cx + (bx === 0 ? -1 : 1) * 25, z0 + 15 + k * 30, 35, 24, 8 + r() * 10, 'commercial');
        continue;
      }
      // Houses along the north and south edges of the block.
      for (let lx = x0 + 10; lx < x1 - 6; lx += 19) {
        for (const side of [0, 1]) {
          if (r() < 0.12) continue;
          const w = 9 + r() * 4;
          const d = 10 + r() * 5;
          const hz = side === 0 ? z0 + 6 + d / 2 : z1 - 6 - d / 2;
          box(lx + (r() - 0.5) * 3, hz, w, d, 5 + r() * 3, 'house');
        }
      }
    }
  }
  pois.push({ id: 'police', p: { x: -60, z: -170 }, kind: 'police', name: 'Sampleton Police Station' });
  box(-60, -170, 30, 20, 9, 'commercial', 'Sampleton Police Station');

  return { name: 'Sampleton (sample town)', half, buildings, roads, areas, pois, attribution: 'Procedurally generated sample town' };
}
