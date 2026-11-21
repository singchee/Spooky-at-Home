import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { MapData, V2 } from '../map/types';
import { bounds, dist, pointInPolygon, polygonArea } from '../map/geom';
import { mulberry32 } from '../util/rng';

/**
 * Turns MapData into 3D meshes. Colours are not colours: each surface stores three
 * "sensor values" in its RGB channels, and the camera filter decides how to show them:
 *   R = heat (thermal camera)   G = visible light (night vision)   B = near-infrared (IR strobes)
 * Everything is merged into a handful of draw calls.
 */
export type Sig = [number, number, number];
export const SIG: Record<string, Sig> = {
  ground: [0.2, 0.07, 0],
  road: [0.33, 0.1, 0],
  park: [0.19, 0.05, 0],
  wood: [0.2, 0.035, 0],
  water: [0.1, 0.02, 0],
  tree: [0.235, 0.07, 0],
};

export interface World {
  group: THREE.Group;
  pickables: THREE.Object3D[];
  dispose(): void;
}

function colorAttr(geo: THREE.BufferGeometry, c: Sig): void {
  const n = geo.attributes.position.count;
  const a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) a.set(c, i * 3);
  geo.setAttribute('color', new THREE.BufferAttribute(a, 3));
}

const shapeOf = (pts: V2[]) => new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, -p.z)));

export function buildWorld(map: MapData, seed: number): World {
  const rng = mulberry32(seed ^ 0x5bd1e995);
  const group = new THREE.Group();
  const disposables: { dispose(): void }[] = [];
  // Buildings are lit so their shapes read; flat surfaces are unlit so their sensor values are exact.
  const lit = new THREE.MeshLambertMaterial({ vertexColors: true });
  const flat = new THREE.MeshBasicMaterial({ vertexColors: true });
  disposables.push(lit, flat);

  // Ground
  const size = map.half * 2 + 1600;
  const groundGeo = new THREE.PlaneGeometry(size, size).rotateX(-Math.PI / 2);
  groundGeo.deleteAttribute('uv');
  colorAttr(groundGeo, SIG.ground);
  const ground = new THREE.Mesh(groundGeo, flat);
  group.add(ground);
  disposables.push(groundGeo);

  // Parks, woods, water
  const areaGeos: THREE.BufferGeometry[] = [];
  for (const a of map.areas) {
    if (a.pts.length < 3) continue;
    try {
      const g = new THREE.ShapeGeometry(shapeOf(a.pts)).rotateX(-Math.PI / 2);
      g.translate(0, a.kind === 'water' ? 0.6 : 0.4, 0);
      g.deleteAttribute('uv');
      colorAttr(g, SIG[a.kind]);
      areaGeos.push(g.index ? g.toNonIndexed() : g);
    } catch {
      /* skip polygons three.js can't triangulate */
    }
  }
  if (areaGeos.length) addMerged(areaGeos, flat);

  // Roads as flat ribbons
  const pos: number[] = [];
  const col: number[] = [];
  for (const r of map.roads) {
    const hw = r.width / 2;
    for (let i = 1; i < r.pts.length; i++) {
      const a = r.pts[i - 1];
      const b = r.pts[i];
      const L = dist(a, b);
      if (L < 0.01) continue;
      const nx = (-(b.z - a.z) / L) * hw;
      const nz = ((b.x - a.x) / L) * hw;
      const y = r.kind === 'footway' || r.kind === 'path' ? 0.8 : 1.0;
      const q = [a.x + nx, y, a.z + nz, a.x - nx, y, a.z - nz, b.x - nx, y, b.z - nz, b.x + nx, y, b.z + nz];
      for (const k of [0, 1, 2, 0, 2, 3]) {
        pos.push(q[k * 3], q[k * 3 + 1], q[k * 3 + 2]);
        col.push(...SIG.road);
      }
    }
  }
  if (pos.length) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    const up = new Float32Array(pos.length);
    for (let i = 1; i < up.length; i += 3) up[i] = 1;
    g.setAttribute('normal', new THREE.BufferAttribute(up, 3));
    // Flat and unlit: roads show their sensor values exactly. Lamp pools sit above them.
    const roadMat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide });
    disposables.push(g, roadMat);
    group.add(new THREE.Mesh(g, roadMat));
  }

  // Buildings: extruded footprints, slightly different temperatures each
  const bGeos: THREE.BufferGeometry[] = [];
  for (const b of map.buildings) {
    if (b.pts.length < 3 || polygonArea(b.pts) < 4) continue;
    try {
      const h = Number.isFinite(b.height) ? Math.max(2.5, b.height) : 7;
      const g = new THREE.ExtrudeGeometry(shapeOf(b.pts), { depth: h, bevelEnabled: false });
      g.rotateX(-Math.PI / 2);
      g.deleteAttribute('uv');
      colorAttr(g, [0.25 + rng() * 0.1, 0.2 + rng() * 0.1, 0]);
      bGeos.push(g);
    } catch {
      /* skip */
    }
  }
  let buildingMesh: THREE.Mesh | null = null;
  if (bGeos.length) buildingMesh = addMerged(bGeos);

  // Trees in parks and woods
  const treePts: V2[] = [];
  for (const a of map.areas) {
    if (a.kind === 'water' || a.pts.length < 3) continue;
    const bb = bounds(a.pts);
    const n = Math.min(300, Math.floor(polygonArea(a.pts) / (a.kind === 'wood' ? 90 : 260)));
    for (let i = 0, tries = 0; i < n && tries < n * 4; tries++) {
      const p = { x: bb.minX + rng() * (bb.maxX - bb.minX), z: bb.minZ + rng() * (bb.maxZ - bb.minZ) };
      if (pointInPolygon(p, a.pts)) {
        treePts.push(p);
        i++;
      }
    }
  }
  if (treePts.length) {
    const tg = new THREE.IcosahedronGeometry(2.8, 0);
    const tm = new THREE.MeshLambertMaterial({ color: new THREE.Color(...SIG.tree) });
    const trees = new THREE.InstancedMesh(tg, tm, treePts.length);
    const m = new THREE.Matrix4();
    treePts.forEach((p, i) => {
      const s = 0.8 + rng() * 0.6;
      m.makeScale(s, s * 1.2, s).setPosition(p.x, 3.2 * s, p.z);
      trees.setMatrixAt(i, m);
    });
    group.add(trees);
    disposables.push(tg, tm);
  }

  // Streetlight pools: add only visible light (G), so they matter to night vision and not to thermal.
  const lamps: V2[] = [];
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
        lamps.push({ x: a.x + (b.x - a.x) * t + nx, z: a.z + (b.z - a.z) * t + nz });
      }
      carry = (carry + L) % 38;
    }
  }
  if (lamps.length) {
    const lg = new THREE.CircleGeometry(11, 18).rotateX(-Math.PI / 2);
    const lm = new THREE.MeshBasicMaterial({ color: new THREE.Color(0, 0.085, 0), blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
    const pools = new THREE.InstancedMesh(lg, lm, lamps.length);
    const m = new THREE.Matrix4();
    lamps.forEach((p, i) => pools.setMatrixAt(i, m.makeTranslation(p.x, 1.6, p.z)));
    group.add(pools);
    disposables.push(lg, lm);
  }

  function addMerged(geos: THREE.BufferGeometry[], material: THREE.Material = lit): THREE.Mesh {
    const merged = mergeGeometries(geos, false) ?? geos[0];
    geos.forEach((g) => g !== merged && g.dispose());
    const mesh = new THREE.Mesh(merged, material);
    group.add(mesh);
    disposables.push(merged);
    return mesh;
  }

  return {
    group,
    pickables: buildingMesh ? [buildingMesh, ground] : [ground],
    dispose: () => disposables.forEach((d) => d.dispose()),
  };
}
