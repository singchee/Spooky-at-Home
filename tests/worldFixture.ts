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
