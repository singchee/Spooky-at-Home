import * as THREE from 'three';
import type { Building, V2 } from '../map/types';
import { pointInPolygon, polygonArea } from '../map/geom';
import { at, bestFrame } from './frame';
import { GeoBuilder, type Sig } from './geo';
import { isHouse, streamFor } from './placement';

/**
 * Buildings: walls extruded from the footprint, then a roof. Houses get pitched (gable) or hipped
 * roofs when their footprint is close to a rectangle; everything else is flat, and big flat roofs
 * carry a few warm plant boxes (air conditioners). Heat varies a little per building and roofs
 * run cooler than walls (they lose heat to the night sky). Walls carry window parameters for the
 * window shader (see shading.ts): lit windows add visible light only.
 */

const NO_WINDOWS = new Set(['garage', 'garages', 'shed', 'roof', 'carport', 'hut', 'industrial', 'warehouse', 'hangar', 'barn', 'greenhouse', 'service', 'storage_tank', 'silo', 'transformer_tower']);

export type RoofKind = 'gable' | 'hip' | 'flat';

export interface BuildingPlan {
  /** Wall height (to the eaves on a pitched roof). */
  eave: number;
  /** Ridge height above the eaves (0 for flat). */
  rise: number;
  roof: RoofKind;
  /** Window style: 0 none, 1 house, 2 shops/offices/flats. */
  style: number;
}

/** How a building is drawn: pure, so tests can check roof choices. */
export function planBuilding(b: Building, seed: number): BuildingPlan {
  const h = Number.isFinite(b.height) ? Math.max(2.5, b.height) : 7;
  const house = isHouse(b);
  const style = NO_WINDOWS.has(b.kind) || h < 3 ? 0 : house ? 1 : 2;
  if (!house && !['garage', 'garages', 'shed'].includes(b.kind)) return { eave: h, rise: 0, roof: 'flat', style };
  const fr = bestFrame(b.pts);
  if (fr.fill < 0.84 || b.pts.length > 12 || fr.hw < 1.5) return { eave: h, rise: 0, roof: 'flat', style };
  const r = streamFor(seed, `roof-${b.id}`);
  const small = !house;
  const rise = Math.min(small ? 1.2 : 3.4, fr.hw * (small ? 0.35 : 0.55 + r() * 0.25));
  const eave = Math.max(small ? 2.2 : 2.7, h - rise);
  return { eave, rise, roof: small || r() < 0.4 ? 'gable' : 'hip', style };
}

export function buildBuildings(buildings: Building[], seed: number): { geo: GeoBuilder; plans: number } {
  const geo = new GeoBuilder(true);
  let plans = 0;
  for (const b of buildings) {
    if (b.pts.length < 3 || polygonArea(b.pts) < 4) continue;
    addBuilding(geo, b, seed);
    plans++;
  }
  return { geo, plans };
}

function signedArea(pts: V2[]): number {
  let s = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) s += pts[j].x * pts[i].z - pts[i].x * pts[j].z;
  return s / 2;
}

function addBuilding(geo: GeoBuilder, b: Building, seed: number): void {
  const plan = planBuilding(b, seed);
  const r = streamFor(seed, `bld-${b.id}`);
  const house = plan.style === 1;
  // Heat: walls leak a little warmth; roofs face the cold sky. Visible light: pale walls, darker roofs.
  const wallHeat = house ? 0.29 + r() * 0.05 : 0.29 + r() * 0.05;
  const roofHeat = house ? 0.25 + r() * 0.06 : 0.26 + r() * 0.06;
  const wall: Sig = [wallHeat, 0.085 + r() * 0.03, 0];
  const roof: Sig = [roofHeat, 0.075 + r() * 0.045, 0];
  const winSeed = r();

  // Walls: orient the footprint so the outward normal is (-dz, dx) for each edge a→b.
  const pts = signedArea(b.pts) > 0 ? [...b.pts].reverse() : b.pts;
  const top = plan.eave;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    const L = Math.hypot(c.x - a.x, c.z - a.z);
    if (L < 0.05) continue;
    // Style in the whole part, a 0-63 seed in the fraction (centred, so interpolation never tips it).
    const w = plan.style + (Math.floor(((winSeed + i * 0.1373) % 1) * 64) + 0.5) / 64;
    const e0 = [0, L, top, w];
    const e1 = [L, L, top, w];
    geo.quad([a.x, 0, a.z], [c.x, 0, c.z], [c.x, top, c.z], [a.x, top, a.z], wall, false, [e0, e1, e1, e0]);
  }

  if (plan.roof === 'flat') {
    const contour = pts.map((p) => new THREE.Vector2(p.x, p.z));
    let faces: number[][] = [];
    try {
      faces = THREE.ShapeUtils.triangulateShape(contour, []);
    } catch {
      faces = [];
    }
    for (const [i, j, k] of faces) upTri(geo, [pts[i].x, top, pts[i].z], [pts[j].x, top, pts[j].z], [pts[k].x, top, pts[k].z], roof);
    // Plant on big flat roofs: small warm boxes (still far cooler than anyone alive).
    const area = polygonArea(pts);
    if (area > 250 && plan.style !== 1) {
      const fr = bestFrame(pts);
      const n = Math.min(4, 1 + Math.floor(area / 700));
      for (let k = 0; k < n; k++) {
        const u = (r() - 0.5) * 2 * Math.max(0, fr.hl - 3);
        const v = (r() - 0.5) * 2 * Math.max(0, fr.hw - 3);
        const p = at(fr, u, v);
        const corners = [at(fr, u - 1.3, v - 1), at(fr, u + 1.3, v - 1), at(fr, u + 1.3, v + 1), at(fr, u - 1.3, v + 1)];
        if (!corners.every((q) => pointInPolygon(q, pts))) continue;
        const warm = 0.34 + r() * 0.08;
        geo.box(p.x, p.z, fr.ux, fr.uz, 1.1, 0.8, top, 1.1, [warm, 0.07, 0], [warm, 0.06, 0]);
      }
    }
    return;
  }

  // Pitched roofs on the footprint's rectangle, ridge along the long side.
  const fr = bestFrame(pts);
  const E = top;
  const R = top + plan.rise;
  const { hl, hw } = fr;
  const P = (u: number, v: number, y: number) => {
    const q = at(fr, u, v);
    return [q.x, y, q.z];
  };
  const ridge = plan.roof === 'hip' ? Math.max(0, hl - hw) : hl;
  // Long sides.
  upQuad(geo, P(-hl, -hw, E), P(hl, -hw, E), P(ridge, 0, R), P(-ridge, 0, R), roof);
  upQuad(geo, P(hl, hw, E), P(-hl, hw, E), P(-ridge, 0, R), P(ridge, 0, R), roof);
  if (plan.roof === 'hip') {
    upTri(geo, P(hl, -hw, E), P(hl, hw, E), P(ridge, 0, R), roof);
    upTri(geo, P(-hl, hw, E), P(-hl, -hw, E), P(-ridge, 0, R), roof);
  } else {
    // Gable ends are wall.
    outTri(geo, P(hl, -hw, E), P(hl, hw, E), P(hl, 0, R), [fr.ux, fr.uz], wall);
    outTri(geo, P(-hl, -hw, E), P(-hl, hw, E), P(-hl, 0, R), [-fr.ux, -fr.uz], wall);
  }
}

/** A triangle facing up (flipped if its vertices came the other way round). */
function upTri(geo: GeoBuilder, a: number[], b: number[], c: number[], col: Sig): void {
  const ny = (c[0] - a[0]) * (b[2] - a[2]) - (b[0] - a[0]) * (c[2] - a[2]);
  // ny = y component of (b - a) × (c - a)
  if (ny >= 0) geo.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col);
  else geo.tri(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], col);
}

function upQuad(geo: GeoBuilder, a: number[], b: number[], c: number[], d: number[], col: Sig): void {
  upTri(geo, a, b, c, col);
  upTri(geo, a, c, d, col);
}

/** A vertical triangle facing `out` (x, z). */
function outTri(geo: GeoBuilder, a: number[], b: number[], c: number[], out: [number, number], col: Sig): void {
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
  const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const nz = ux * vy - uy * vx;
  if (nx * out[0] + nz * out[1] >= 0) geo.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col);
  else geo.tri(a[0], a[1], a[2], c[0], c[1], c[2], b[0], b[1], b[2], col);
}
