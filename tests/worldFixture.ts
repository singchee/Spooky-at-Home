import type { Building, Feature, MapData, Road, V2 } from '../src/map/types';
import { mulberry32 } from '../src/util/rng';

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [
  { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 },
];

/**
 * A big made-up suburb for build-time and placement tests: a street grid with houses on every
 * block (about `target` buildings), a few shopping blocks with car parks, sports pitches, a public
 * pool and some mapped trees. Houses are slightly rotated, so footprints aren't all axis-aligned.
 */
export function bigTown(target = 6000, seed = 3): MapData {
  const r = mulberry32(seed);
  const step = 100;
  const blocksPerSide = Math.ceil(Math.sqrt(target / 11));
  const n = Math.ceil(blocksPerSide / 2);
  const half = n * step;
  const roads: Road[] = [];
  const buildings: Building[] = [];
  const features: Feature[] = [];
  const trees: V2[] = [];
  for (let i = -n; i <= n; i++) {
    const ns: V2[] = [];
    const ew: V2[] = [];
    for (let j = -n; j <= n; j++) {
      ns.push({ x: i * step, z: j * step });
      ew.push({ x: j * step, z: i * step });
    }
    roads.push({ id: `ns${i}`, pts: ns, kind: i % 4 === 0 ? 'secondary' : 'residential', width: 7 });
    roads.push({ id: `ew${i}`, pts: ew, kind: 'residential', width: 7 });
  }
  let id = 0;
  for (let bx = -n; bx < n; bx++) {
    for (let bz = -n; bz < n; bz++) {
      const x0 = bx * step + 8;
      const x1 = (bx + 1) * step - 8;
      const z0 = bz * step + 8;
      const z1 = (bz + 1) * step - 8;
      const k = (bx * 7 + bz * 13) & 15;
      if (k === 3) {
        features.push({ id: `pitch${id}`, category: 'pitch', name: bx % 2 ? 'Memorial Oval' : undefined, p: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }, pts: rect(x0 + 4, z0 + 4, x1 - 4, z1 - 4) });
        id++;
        continue;
      }
      if (k === 7) {
        buildings.push({ id: `c${id++}`, pts: rect(x0 + 4, z0 + 4, x1 - 4, z0 + 34), height: 9, kind: 'retail' });
        features.push({ id: `park${id++}`, category: 'parking', p: { x: (x0 + x1) / 2, z: z1 - 25 }, pts: rect(x0 + 4, z0 + 40, x1 - 4, z1 - 4) });
        continue;
      }
      if (k === 11 && bx === 0) {
        features.push({ id: `pool${id++}`, category: 'swimming_pool', name: 'Aquatic Centre', p: { x: (x0 + x1) / 2, z: (z0 + z1) / 2 }, pts: rect(x0 + 20, z0 + 20, x0 + 45, z0 + 32) });
      }
      for (let lx = x0 + 9; lx < x1 - 6; lx += 14) {
        for (const side of [0, 1]) {
          const w = 9 + r() * 3;
          const d = 10 + r() * 4;
          const cz = side === 0 ? z0 + 5 + d / 2 : z1 - 5 - d / 2;
          const cx = lx + (r() - 0.5) * 2;
          const a = (r() - 0.5) * 0.2;
          const c = Math.cos(a);
          const s = Math.sin(a);
          const pts = [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([u, v]) => ({ x: cx + u * c - v * s, z: cz + u * s + v * c }));
          buildings.push({ id: `h${id++}`, pts, height: 5 + r() * 3, kind: r() < 0.5 ? 'house' : 'yes' });
        }
      }
      if (r() < 0.3) for (let t = 0; t < 4; t++) trees.push({ x: x0 + r() * (x1 - x0), z: z0 + r() * (z1 - z0) });
    }
  }
  return { name: 'Big test town', half, buildings, roads, areas: [], pois: [], attribution: 'test', features, trees, lamps: [] };
}

/**
 * A synthetic grid town (local metres only, 100 m blocks) crowded with schools, a kindergarten and a playground
 * around a hospital that serves as the safehouse. One school's grounds sit 21 m from the junction at (100, -100),
 * 200 m by road from the safehouse: where defend stragglers start, and on the shortest way to many homes.
 */
export function schoolHeavyTown(opts: { playgroundBesideSafehouse?: boolean } = {}): MapData {
  const roads: Road[] = [];
  const buildings: Building[] = [];
  for (let i = -5; i <= 5; i++) {
    const ns: V2[] = [];
    const ew: V2[] = [];
    for (let j = -5; j <= 5; j++) {
      ns.push({ x: i * 100, z: j * 100 });
      ew.push({ x: j * 100, z: i * 100 });
    }
    roads.push({ id: `ns${i}`, pts: ns, kind: 'residential', width: 7, name: `Street ${i + 6}` });
    roads.push({ id: `ew${i}`, pts: ew, kind: 'residential', width: 7, name: `Avenue ${i + 6}` });
  }
  const features: Feature[] = [];
  const pois: MapData['pois'] = [];
  const used = new Set<string>(['0,0']);
  const school = (id: string, bx: number, bz: number, name: string) => {
    const x0 = bx * 100;
    const z0 = bz * 100;
    buildings.push({ id: `${id}-hall`, pts: rect(x0 + 30, z0 + 35, x0 + 70, z0 + 65), height: 9, kind: 'school', name });
    pois.push({ id, p: { x: x0 + 50, z: z0 + 50 }, kind: 'school', name });
    features.push({ id: `f-${id}`, category: 'school', name, p: { x: x0 + 50, z: z0 + 50 }, pts: rect(x0 + 15, z0 + 15, x0 + 85, z0 + 85) });
    used.add(`${bx},${bz}`);
  };
  school('s1', 1, -2, 'Gridville Primary School');
  school('s2', -3, 1, 'Gridville High School');
  school('s3', 2, 2, 'Saint Gridley College');
  pois.push({ id: 'k1', p: { x: -145, z: -245 }, kind: 'kindergarten', name: 'Little Squares Kindergarten' });
  features.push({ id: 'f-k1', category: 'kindergarten', name: 'Little Squares Kindergarten', p: { x: -145, z: -245 } });
  features.push({ id: 'f-play', category: 'playground', name: 'Grid Playground', p: { x: -50, z: 340 }, pts: rect(-70, 320, -30, 360) });
  if (opts.playgroundBesideSafehouse) features.push({ id: 'f-play2', category: 'playground', name: 'Corner Playground', p: { x: -10, z: -10 } });
  // The hospital (safehouse), its centre nearest the junction at (0, 0).
  buildings.push({ id: 'hosp', pts: rect(25, 25, 55, 55), height: 12, kind: 'hospital', name: 'Gridville Hospital' });
  pois.push({ id: 'hosp', p: { x: 40, z: 40 }, kind: 'hospital', name: 'Gridville Hospital' });
  features.push({ id: 'f-hosp', category: 'hospital', name: 'Gridville Hospital', p: { x: 40, z: 40 } });
  // Parks, for clear missions.
  const areas: MapData['areas'] = [];
  for (const [bx, bz, name] of [[-2, -1, 'West Green'], [2, -1, 'East Green'], [-1, 2, 'North Green'], [0, -3, 'South Green']] as const) {
    const pts = rect(bx * 100 + 5, bz * 100 + 5, bx * 100 + 95, bz * 100 + 95);
    areas.push({ id: `a${bx},${bz}`, pts, kind: 'park', name });
    features.push({ id: `f-p${bx},${bz}`, category: 'park', name, p: { x: bx * 100 + 50, z: bz * 100 + 50 }, pts });
    used.add(`${bx},${bz}`);
  }
  let id = 0;
  for (let bx = -5; bx < 5; bx++) {
    for (let bz = -5; bz < 5; bz++) {
      if (used.has(`${bx},${bz}`)) continue;
      const x0 = bx * 100;
      const z0 = bz * 100;
      for (const [dx, dz] of [[20, 15], [60, 15], [20, 75], [60, 75]]) buildings.push({ id: `h${id++}`, pts: rect(x0 + dx, z0 + dz, x0 + dx + 12, z0 + dz + 10), height: 6, kind: 'house' });
    }
  }
  return { name: 'Gridville (school heavy)', half: 550, buildings, roads, areas, pois, features, attribution: 'test' };
}

/**
 * Spec 004 (Convoy): the school-heavy town with three main roads, for the convoy route finder and its guardrail
 * (the spec's `schoolHeavyTown({ mainRoads: true })`, kept as its own function so the stock fixture is untouched).
 * Street 2 (x = −400) and Street 10 (x = 400) become primary, Avenue 2 (z = −400) secondary. Two more schools
 * (points) sit beside them: one 60 m from Street 2, inside the convoy's 74 m gap, so that stretch is never on a
 * route; one 80 m from Street 10, outside the gap, so that stretch may be.
 */
export function schoolHeavyTownMainRoads(): MapData {
  const map = schoolHeavyTown();
  const kinds: Record<string, string> = { 'ns-4': 'primary', ns4: 'primary', 'ew-4': 'secondary' };
  const roads = map.roads.map((r) => (kinds[r.id] ? { ...r, kind: kinds[r.id], width: kinds[r.id] === 'primary' ? 10 : 9 } : r));
  const features: Feature[] = [
    ...(map.features ?? []),
    { id: 'f-s60', category: 'school', name: 'Gridville West School', p: { x: -340, z: 0 } },
    { id: 'f-s80', category: 'school', name: 'Gridville East School', p: { x: 320, z: 100 } },
  ];
  return { ...map, name: 'Gridville (school heavy, main roads)', roads, features };
}
