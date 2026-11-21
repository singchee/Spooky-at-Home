import type { Area, Building, BusRoute, Feature, MapData, Poi, Road, V2 } from './types';
import { bounds, centroid, pointInPolygon } from './geom';
import { dedupeFeatures } from './overpass';
import { mulberry32 } from '../util/rng';

/** Blocks given over to recon places (phase 2): a sports centre, a tennis club and a forest. */
const SPECIAL: Record<string, 'sports' | 'tennis' | 'forest'> = { '-3,0': 'sports', '2,1': 'tennis', '-3,-3': 'forest', '-4,-3': 'forest' };

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
  const features: Feature[] = [];

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
        for (let k = 0; k < 3; k++) {
          const mall = key === '0,0' && k === 0;
          box(cx + (bx === 0 ? -1 : 1) * 25, z0 + 15 + k * 30, 35, 24, 8 + r() * 10, 'commercial', mall ? 'Sampleton Plaza' : undefined);
          if (mall) features.push({ id: 'f-plaza', category: 'mall', name: 'Sampleton Plaza', p: centroid(buildings[buildings.length - 1].pts), pts: buildings[buildings.length - 1].pts });
        }
        continue;
      }
      // Recon blocks (phase 2). Their houses are still drawn from the random stream and then
      // dropped, so every other block keeps exactly the houses it had before.
      const special = SPECIAL[key];
      // Houses along the north and south edges of the block.
      for (let lx = x0 + 10; lx < x1 - 6; lx += 19) {
        for (const side of [0, 1]) {
          if (r() < 0.12) continue;
          const w = 9 + r() * 4;
          const d = 10 + r() * 5;
          const hz = side === 0 ? z0 + 6 + d / 2 : z1 - 6 - d / 2;
          const hx = lx + (r() - 0.5) * 3;
          const h = 5 + r() * 3;
          if (!special) box(hx, hz, w, d, h, 'house');
        }
      }
      if (special === 'sports') {
        // Ironbark Sports Centre: a hall on the north side, an oval to the south.
        box(-292, 30, 50, 30, 11, 'sports_centre', 'Ironbark Sports Centre');
        const hall = buildings[buildings.length - 1];
        features.push({ id: 'f-sports', category: 'sports_centre', name: 'Ironbark Sports Centre', p: centroid(hall.pts), pts: hall.pts });
        const oval = rect(x0 + 4, 54, x1 - 4, z1 - 4);
        areas.push({ id: 'oval', kind: 'park', name: 'Ironbark Oval', pts: oval });
        features.push({ id: 'f-oval', category: 'pitch', name: 'Ironbark Oval', p: centroid(oval), pts: oval });
      } else if (special === 'tennis') {
        // Orchard Tennis Club: open courts with a small clubhouse in the corner.
        const grounds = rect(x0 + 2, z0 + 2, x1 - 2, z1 - 2);
        areas.push({ id: 'tennis', kind: 'park', name: 'Orchard Tennis Club', pts: grounds });
        box(x1 - 16, z1 - 12, 18, 12, 4, 'clubhouse', 'Orchard Tennis Club');
        features.push({ id: 'f-tennis', category: 'tennis', name: 'Orchard Tennis Club', p: { x: cx, z: cz }, pts: grounds });
      }
      // The forest blocks get their trees and outline below.
    }
  }
  pois.push({ id: 'police', p: { x: -60, z: -170 }, kind: 'police', name: 'Sampleton Police Station' });
  box(-60, -170, 30, 20, 9, 'commercial', 'Sampleton Police Station');

  // Grevillea Woods: a small forest across two blocks in the north-west, with the road running through.
  const woodsW: V2[] = [{ x: -428, z: -300 }, { x: -402, z: -318 }, { x: -340, z: -316 }, { x: -340, z: -234 }, { x: -418, z: -238 }, { x: -431, z: -266 }];
  const woodsE: V2[] = [{ x: -320, z: -316 }, { x: -244, z: -312 }, { x: -231, z: -272 }, { x: -240, z: -234 }, { x: -320, z: -232 }];
  areas.push({ id: 'woods-w', kind: 'wood', name: 'Grevillea Woods', pts: woodsW }, { id: 'woods-e', kind: 'wood', name: 'Grevillea Woods', pts: woodsE });
  const woods: V2[] = [woodsW[0], woodsW[1], woodsE[1], woodsE[2], woodsE[3], woodsW[4], woodsW[5]];

  // Mapped trees and street lamps (their own random stream, so the town above never changes).
  const tr = mulberry32(seed * 7919 + 17);
  const trees: V2[] = [];
  for (const poly of [woodsW, woodsE]) {
    const bb = bounds(poly);
    for (let i = 0, tries = 0; i < 110 && tries < 600; tries++) {
      const p = { x: bb.minX + tr() * (bb.maxX - bb.minX), z: bb.minZ + tr() * (bb.maxZ - bb.minZ) };
      if (pointInPolygon(p, poly)) {
        trees.push(p);
        i++;
      }
    }
  }
  for (let z = -540; z <= 540; z += 24) for (const s of [-7, 7]) trees.push({ x: -2 * step + s, z: z + (tr() - 0.5) * 4 }); // Acacia Street's street trees
  const lamps: V2[] = [];
  for (let k = -n * step + 20; k <= n * step - 20; k += 40) {
    lamps.push({ x: (k / 40) % 2 ? 6 : -6, z: k }); // Main Street
    lamps.push({ x: k, z: (k / 40) % 2 ? 6 : -6 }); // Bridge Avenue
  }

  // Recon features: the places missions can be built around.
  const blockRect = (k: string) => {
    const [bx, bz] = k.split(',').map(Number);
    return rect(bx * step + 8, bz * step + 8, (bx + 1) * step - 8, (bz + 1) * step - 8);
  };
  const schoolPts = blockRect(school);
  const reserve = areas.find((a) => a.name === 'Banksia Reserve')!;
  const rc = centroid(reserve.pts);
  const playground = rect(rc.x + 12, rc.z - 30, rc.x + 34, rc.z - 14);
  const named = (name: string) => buildings.find((b) => b.name === name)!.pts;
  features.push(
    { id: 'f-school', category: 'school', name: 'Wattle Hill Primary School', p: centroid(schoolPts), pts: schoolPts },
    { id: 'f-playground', category: 'playground', name: 'Banksia Reserve Playground', p: centroid(playground), pts: playground },
    { id: 'f-woods', category: 'forest', name: 'Grevillea Woods', p: centroid(woods), pts: woods },
    { id: 'f-hospital', category: 'hospital', name: 'St Kestrel Hospital', p: centroid(named('St Kestrel Hospital')), pts: named('St Kestrel Hospital') },
    { id: 'f-police', category: 'police', name: 'Sampleton Police Station', p: { x: -60, z: -170 }, pts: named('Sampleton Police Station') },
    { id: 'f-interchange', category: 'bus_station', name: 'Sampleton Interchange', p: { x: 14, z: -500 } },
  );
  for (const a of areas) {
    if (a.kind === 'park' && a.name?.endsWith('Reserve')) features.push({ id: `f-${a.id}`, category: 'park', name: a.name, p: centroid(a.pts), pts: a.pts });
  }
  const busRoutes: BusRoute[] = [
    { id: 'bus7', ref: '7', name: 'Route 7: Interchange to Mill Avenue', lines: [[{ x: 0, z: -n * step }, { x: 0, z: 2 * step }, { x: n * step, z: 2 * step }]] },
  ];

  return {
    name: 'Sampleton (sample town)', half, buildings, roads, areas, pois, attribution: 'Procedurally generated sample town',
    features: dedupeFeatures(features), busRoutes, trees, lamps,
  };
}

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];
