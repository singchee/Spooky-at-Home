import * as THREE from 'three';
import type { MapData, V2 } from '../map/types';
import { dist } from '../map/geom';
import { mulberry32 } from '../util/rng';
import { buildBuildings } from './buildings';
import { Cutaway } from './cutaway';
import { canopyGeometry, carGeometry, carMatrices, fenceGeometry, flatDetail, treeMatrices } from './detailMeshes';
import { GeoBuilder, type Sig } from './geo';
import { placeDetail, type Detail } from './placement';
import { patchMaterial, type FadeOpts } from './shading';
import { Occupancy } from './spatial';
import { applyLampFalloff, applySurfaceTexture } from '../render/groundShader';

/**
 * Turns MapData into 3D meshes. Colours are not colours: each surface stores three
 * "sensor values" in its RGB channels, and the camera filter decides how to show them:
 *   R = heat (thermal camera)   G = visible light (night vision)   B = near-infrared (IR strobes)
 * Nothing is lit at draw time (all materials are unlit), so the values are exact; shape shading
 * for night vision is baked into the vertex colours. Everything is merged or instanced into a
 * dozen draw calls; detail placement lives in placement.ts (pure and tested).
 */
export type { Sig };
export const SIG: Record<string, Sig> = {
  ground: [0.2, 0.07, 0],
  road: [0.33, 0.1, 0],
  park: [0.19, 0.05, 0],
  wood: [0.2, 0.035, 0],
  water: [0.1, 0.02, 0],
};

export interface World {
  group: THREE.Group;
  pickables: THREE.Object3D[];
  /** What was placed (trees, cars, pools...), for tests and tools. */
  detail: Detail;
  /** The building cut-away, line-of-sight index and height grid (3.39). */
  cutaway: Cutaway;
  dispose(): void;
}

/** How far past the map's edge the ground carries on (metres): far enough that its edge never shows. */
const GROUND_BEYOND = 3500;

export function buildWorld(map: MapData, seed: number): World {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  const half = map.half;
  const fadeTo = SIG.ground;
  const basic = (o: THREE.MeshBasicMaterialParameters = {}, extra: Partial<Omit<FadeOpts, 'half' | 'to'>> & { to?: Sig } = {}) => {
    const m = patchMaterial(new THREE.MeshBasicMaterial({ vertexColors: true, ...o }), { half, ...extra, to: extra.to ?? fadeTo });
    disposables.push(m);
    return m;
  };
  const add = <T extends THREE.Object3D>(o: T, name: string): T => {
    o.name = name;
    group.add(o);
    return o;
  };
  const fromBuilder = (g: GeoBuilder, mat: THREE.Material, name: string): THREE.Mesh | null => {
    if (!g.triangles) return null;
    const geo = g.toGeometry();
    disposables.push(geo);
    return add(new THREE.Mesh(geo, mat), name);
  };

  // Ground, out well past the map so its own edge is never on screen; the edge fade hides where the data stops.
  const flat = basic();
  const size = (half + GROUND_BEYOND) * 2;
  const groundGeo = new THREE.PlaneGeometry(size, size, 1, 1).rotateX(-Math.PI / 2);
  groundGeo.deleteAttribute('uv');
  colorAttr(groundGeo, SIG.ground);
  disposables.push(groundGeo);
  // Procedural surface texture (shader only, src/render/groundShader.ts): seams on bare ground, a faint
  // mottle on grass, worn cracks on roads.
  const groundMat = applySurfaceTexture(basic({}, { noise: true }), 'ground');
  const ground = add(new THREE.Mesh(groundGeo, groundMat), 'ground');

  // Parks, woods, water
  const areas = new GeoBuilder();
  for (const a of map.areas) {
    if (a.pts.length < 3) continue;
    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(a.pts.map((p) => new THREE.Vector2(p.x, p.z)), []);
    } catch {
      continue; // skip polygons three.js can't triangulate
    }
    const y = a.kind === 'water' ? 0.6 : 0.4;
    for (const [i, j, k] of faces) upFlat(areas, a.pts[i], a.pts[j], a.pts[k], y, SIG[a.kind]);
  }
  fromBuilder(areas, applySurfaceTexture(basic(), 'grass'), 'areas');

  // Roads as flat ribbons
  const roads = new GeoBuilder();
  for (const r of map.roads) {
    const hw = r.width / 2;
    const y = r.kind === 'footway' || r.kind === 'path' ? 0.8 : 1.0;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const L = dist(a, b);
      if (L < 0.01) continue;
      const nx = (-(b.z - a.z) / L) * hw;
      const nz = ((b.x - a.x) / L) * hw;
      roads.quad([a.x + nx, y, a.z + nz], [a.x - nx, y, a.z - nz], [b.x - nx, y, b.z - nz], [b.x + nx, y, b.z + nz], SIG.road, true);
    }
  }
  fromBuilder(roads, applySurfaceTexture(basic({ side: THREE.DoubleSide }), 'asphalt'), 'roads');

  // Detail placement (pure, seeded): trees, cars, pools, lines, fences.
  const detail = placeDetail(map, seed);
  fromBuilder(flatDetail(detail), flat, 'flat-detail');

  // Buildings: walls, pitched or flat roofs, procedural windows (visible light only). Towers in the
  // way of the aim area cut away (cutaway.ts): the solid part here, the see-through part as a ghost
  // drawn after everything opaque (same geometry, one extra draw call, nothing drawn when nothing is cut).
  const { geo: bGeo, prisms } = buildBuildings(map.buildings, seed);
  const cutaway = new Cutaway(prisms, half);
  disposables.push(cutaway);
  const buildingMesh = fromBuilder(bGeo, basic({}, { windows: true, cut: { tex: cutaway.texture, part: 'solid' } }), 'buildings');
  if (buildingMesh) {
    const ghostMat = basic({ transparent: true, depthWrite: false, side: THREE.DoubleSide }, { cut: { tex: cutaway.texture, part: 'ghost' } });
    const ghost = add(new THREE.Mesh(buildingMesh.geometry, ghostMat), 'buildings-ghost');
    ghost.renderOrder = 10;
  }

  fromBuilder(fenceGeometry(detail.fences), basic(), 'fences');

  if (detail.trees.length) {
    const tg = canopyGeometry();
    disposables.push(tg);
    const trees = add(new THREE.InstancedMesh(tg, basic(), detail.trees.length), 'trees');
    treeMatrices(trees, detail.trees);
    trees.computeBoundingSphere();
  }

  for (const warm of [false, true]) {
    const list = detail.cars.filter((c) => c.warm === warm);
    if (!list.length) continue;
    const cg = carGeometry(warm);
    disposables.push(cg);
    const cars = add(new THREE.InstancedMesh(cg, basic(), list.length), warm ? 'cars-warm' : 'cars');
    carMatrices(cars, list);
    cars.computeBoundingSphere();
  }

  // Streetlight pools: add only visible light (G), so they matter to night vision and not to thermal.
  // Mapped lamps first; generated ones fill the streets the map has none on.
  const lamps: V2[] = (map.lamps ?? []).filter((p) => Math.abs(p.x) <= half + 50 && Math.abs(p.z) <= half + 50);
  const mapped = new Occupancy(25);
  lamps.forEach((p) => mapped.add(p));
  for (const r of map.roads) {
    if (['footway', 'path', 'cycleway', 'steps', 'track'].includes(r.kind)) continue;
    let carry = rng() * 38;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const L = dist(a, b);
      for (let s = carry; s < L; s += 38) {
        if (rng() < 0.2) continue;
        const t = s / L;
        const side = rng() < 0.5 ? 1 : -1;
        const nx = (-(b.z - a.z) / L) * (r.width / 2 + 1) * side;
        const nz = ((b.x - a.x) / L) * (r.width / 2 + 1) * side;
        const p = { x: a.x + (b.x - a.x) * t + nx, z: a.z + (b.z - a.z) * t + nz };
        if (!mapped.near(p, 25)) lamps.push(p);
      }
      carry = (carry + L) % 38;
    }
  }
  if (lamps.length) {
    const lg = new THREE.CircleGeometry(11, 18).rotateX(-Math.PI / 2);
    const lm = patchMaterial(new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0.085, 0), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false }), { half, to: [0, 0, 0] });
    applyLampFalloff(lm, 11);
    const pools = add(new THREE.InstancedMesh(lg, lm, lamps.length), 'lamp-pools');
    const m = new THREE.Matrix4();
    lamps.forEach((p, i) => pools.setMatrixAt(i, m.makeTranslation(p.x, 1.6, p.z)));
    pools.computeBoundingSphere();
    disposables.push(lg, lm);
  }

  return {
    group,
    pickables: buildingMesh ? [buildingMesh, ground] : [ground],
    detail,
    cutaway,
    dispose: () => {
      for (const o of group.children) if (o instanceof THREE.InstancedMesh) o.dispose();
      disposables.forEach((d) => d.dispose());
      group.clear();
    },
  };
}

function colorAttr(geo: THREE.BufferGeometry, c: Sig): void {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
}

function upFlat(g: GeoBuilder, a: V2, b: V2, c: V2, y: number, col: Sig): void {
  const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
  if (ny >= 0) g.tri(a.x, y, a.z, b.x, y, b.z, c.x, y, c.z, col, true);
  else g.tri(a.x, y, a.z, c.x, y, c.z, b.x, y, b.z, col, true);
}
