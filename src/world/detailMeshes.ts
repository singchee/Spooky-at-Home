import * as THREE from 'three';
import type { V2 } from '../map/types';
import { centroid } from '../map/geom';
import { GeoBuilder, type Sig } from './geo';
import { CAR, type CarP, type FenceRun, type Line, type PoolP, type TreeP } from './placement';

/**
 * Geometry for the placed detail. Sensor values (R heat, G visible light, B near-IR):
 * - Tree canopies: a touch warmer than grass (0.19) and cooler than roofs (0.23+); dark on night vision.
 * - Cars: cool bodies, cold glass (it mirrors the night sky); a warm car has a hot bonnet, ~0.45,
 *   far below a live zombie (0.98) and a different shape: a flat rectangle that never moves.
 * - Pools: cold water (0.1, near black in white-hot), a pale concrete edge, some with a pool light.
 * - Lines on pitches and car parks: visible light only, the same heat as the surface under them.
 */
export const DETAIL_SIG = {
  canopy: [0.245, 0.03, 0] as Sig,
  carBody: [0.27, 0.085, 0] as Sig,
  carGlass: [0.2, 0.035, 0] as Sig,
  carRoof: [0.215, 0.08, 0] as Sig,
  warmBonnet: [0.46, 0.09, 0] as Sig,
  poolWater: [0.1, 0.03, 0] as Sig,
  poolLit: [0.1, 0.24, 0] as Sig,
  poolEdge: [0.23, 0.1, 0] as Sig,
  carPark: [0.31, 0.075, 0] as Sig,
  bayLine: [0.31, 0.13, 0] as Sig,
  fieldLine: [0.195, 0.12, 0] as Sig,
  fence: [0.205, 0.075, 0] as Sig,
  hedge: [0.214, 0.028, 0] as Sig,
};

// ---------------------------------------------------------------- trees

/**
 * A lumpy dome of leaves (unit radius, 27 triangles): an irregular rim, a shoulder ring and a
 * crown. No underside: the camera is always far above. Baked shading: the crown catches the moon.
 */
export function canopyGeometry(): THREE.BufferGeometry {
  const N = 9;
  const g = new GeoBuilder();
  const lump = (i: number, k: number) => 0.84 + 0.22 * (0.5 + 0.5 * Math.sin(i * 2.39 + k * 1.7));
  const ring = (k: number, rad: number, y: number) =>
    Array.from({ length: N }, (_, i) => {
      const a = ((i + k * 0.5) / N) * Math.PI * 2;
      const r = rad * lump(i, k);
      return [Math.cos(a) * r, y, Math.sin(a) * r];
    });
  const rim = ring(0, 1, 0);
  const shoulder = ring(1, 0.72, 0.5);
  const crown = [0, 0.8, 0];
  // Canopy tops lose heat to the sky: a hair cooler on top than at the sides.
  const sig = (y: number): Sig => [DETAIL_SIG.canopy[0] - 0.012 * y, DETAIL_SIG.canopy[1], 0];
  const t = (a: number[], b: number[], c: number[]) => g.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], sig((a[1] + b[1] + c[1]) / 3));
  for (let i = 0; i < N; i++) {
    const j = (i + 1) % N;
    t(rim[i], shoulder[i], rim[j]);
    t(rim[j], shoulder[i], shoulder[j]);
    t(shoulder[i], crown, shoulder[j]);
  }
  return g.toGeometry();
}

export function treeMatrices(mesh: THREE.InstancedMesh, trees: TreeP[]): void {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3();
  const t = new THREE.Vector3();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  trees.forEach((tr, i) => {
    const h = 0.85 + ((tr.rot * 7.3) % 1) * 0.3;
    s.set(tr.r, tr.r * h, tr.r);
    t.set(tr.x, tr.y + 1.6 + tr.r * h * 0.85, tr.z);
    q.setFromAxisAngle(up, tr.rot);
    mesh.setMatrixAt(i, m.compose(t, q, s));
    const k = (tr.rot * 3.1) % 1;
    c.setRGB(0.98 + 0.05 * k, 0.75 + 0.6 * ((tr.rot * 5.7) % 1), 1);
    mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------- cars

/** A car along +x, centred, wheels on y = 0. */
export function carGeometry(warm: boolean): THREE.BufferGeometry {
  const g = new GeoBuilder();
  const L = CAR.length / 2;
  const W = CAR.width / 2;
  const body = DETAIL_SIG.carBody;
  const bonnet = warm ? DETAIL_SIG.warmBonnet : body;
  // Rear body and boot, then the bonnet, then the cabin (glass sides, cold metal roof).
  g.box(-0.65, 0, 1, 0, 1.55, W, 0.25, 0.72, body);
  g.box(L - 0.65, 0, 1, 0, 0.65, W, 0.25, 0.68, bonnet, warm ? [0.4, 0.08, 0] : body);
  g.box(-0.35, 0, 1, 0, 1.05, W - 0.1, 0.97, 0.5, DETAIL_SIG.carRoof, DETAIL_SIG.carGlass);
  return g.toGeometry();
}

export function carMatrices(mesh: THREE.InstancedMesh, cars: CarP[]): void {
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const s = new THREE.Vector3(1, 1, 1);
  const t = new THREE.Vector3();
  const c = new THREE.Color();
  const up = new THREE.Vector3(0, 1, 0);
  cars.forEach((car, i) => {
    t.set(car.x, car.y, car.z);
    // three.js turns +x toward -z for a positive angle; headings here turn +x toward +z.
    q.setFromAxisAngle(up, -car.heading);
    mesh.setMatrixAt(i, m.compose(t, q, s));
    c.setRGB(0.96 + 0.08 * ((car.tint * 13.7) % 1), 0.45 + 1.4 * car.tint * car.tint, 1);
    mesh.setColorAt(i, c);
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
}

// ---------------------------------------------------------------- flat things

/** A flat polygon at height y (triangulated). */
function flatPoly(g: GeoBuilder, pts: V2[], y: number, col: Sig): void {
  if (pts.length < 3) return;
  let faces: number[][] = [];
  try {
    faces = THREE.ShapeUtils.triangulateShape(pts.map((p) => new THREE.Vector2(p.x, p.z)), []);
  } catch {
    return;
  }
  for (const [i, j, k] of faces) {
    const a = pts[i], b = pts[j], c = pts[k];
    const ny = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z);
    if (ny >= 0) g.tri(a.x, y, a.z, b.x, y, b.z, c.x, y, c.z, col, true);
    else g.tri(a.x, y, a.z, c.x, y, c.z, b.x, y, b.z, col, true);
  }
}

function flatLine(g: GeoBuilder, l: Line, y: number, w: number, col: Sig): void {
  const dx = l.b.x - l.a.x;
  const dz = l.b.z - l.a.z;
  const L = Math.hypot(dx, dz);
  if (L < 0.05) return;
  const nx = (-dz / L) * (w / 2);
  const nz = (dx / L) * (w / 2);
  const a = [l.a.x + nx, y, l.a.z + nz], b = [l.a.x - nx, y, l.a.z - nz], c = [l.b.x - nx, y, l.b.z - nz], d = [l.b.x + nx, y, l.b.z + nz];
  // Face up whichever way the line runs.
  const ny = (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]);
  if (ny >= 0) g.quad(a, b, c, d, col, true);
  else g.quad(a, d, c, b, col, true);
}

/** Grows a polygon by about `m` metres (around its centre; fine for the convex shapes used here). */
function grow(pts: V2[], m: number): V2[] {
  const c = centroid(pts);
  const rad = pts.reduce((s, p) => s + Math.hypot(p.x - c.x, p.z - c.z), 0) / pts.length || 1;
  const k = 1 + m / rad;
  return pts.map((p) => ({ x: c.x + (p.x - c.x) * k, z: c.z + (p.z - c.z) * k }));
}

/** Car parks, pools and painted lines: one flat, unlit layer above the grass and below the roads. */
export function flatDetail(d: { carParks: V2[][]; bayLines: Line[]; pools: PoolP[]; fieldLines: Line[] }): GeoBuilder {
  const g = new GeoBuilder();
  for (const cp of d.carParks) flatPoly(g, cp, 0.7, DETAIL_SIG.carPark);
  for (const l of d.bayLines) flatLine(g, l, 0.74, 0.25, DETAIL_SIG.bayLine);
  for (const l of d.fieldLines) flatLine(g, l, 0.46, 0.35, DETAIL_SIG.fieldLine);
  for (const p of d.pools) {
    flatPoly(g, grow(p.pts, 0.9), 0.5, DETAIL_SIG.poolEdge);
    flatPoly(g, p.pts, 0.55, p.lit ? DETAIL_SIG.poolLit : DETAIL_SIG.poolWater);
  }
  return g;
}

// ---------------------------------------------------------------- fences and hedges

export function fenceGeometry(runs: FenceRun[]): GeoBuilder {
  const g = new GeoBuilder();
  for (const f of runs) {
    const dx = f.b.x - f.a.x;
    const dz = f.b.z - f.a.z;
    const L = Math.hypot(dx, dz);
    if (L < 0.3) continue;
    const hedge = f.kind === 'hedge';
    const sig = hedge ? DETAIL_SIG.hedge : DETAIL_SIG.fence;
    g.box((f.a.x + f.b.x) / 2, (f.a.z + f.b.z) / 2, dx / L, dz / L, L / 2, hedge ? 0.5 : 0.06, 0, hedge ? 1.4 : 1.7, sig, sig, { ends: false, lid: hedge });
  }
  return g;
}
