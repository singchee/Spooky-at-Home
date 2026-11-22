import type { V2 } from '../map/types';
import { polygonArea } from '../map/geom';

/**
 * An oriented rectangle: centre, unit long axis (u), unit short axis (v = u turned 90°) and half
 * extents. Used for roofs, car parks, pitches, cars and pools.
 */
export interface Frame {
  cx: number;
  cz: number;
  ux: number;
  uz: number;
  /** Half length along u (the longer side). */
  hl: number;
  /** Half width along v. */
  hw: number;
}

export const vAxis = (f: Frame): V2 => ({ x: -f.uz, z: f.ux });

/** A point given in the frame's (u, v) coordinates. */
export const at = (f: Frame, u: number, v: number): V2 => ({ x: f.cx + f.ux * u - f.uz * v, z: f.cz + f.uz * u + f.ux * v });

/** The frame's corners, counter-clockwise in (u, v). */
export const corners = (f: Frame, grow = 0): V2[] => [
  at(f, -f.hl - grow, -f.hw - grow),
  at(f, f.hl + grow, -f.hw - grow),
  at(f, f.hl + grow, f.hw + grow),
  at(f, -f.hl - grow, f.hw + grow),
];

/**
 * The smallest rectangle around a polygon whose sides follow one of the polygon's edges
 * (exact for convex shapes, close for the rest). `fill` is polygon area / rectangle area:
 * near 1 for rectangles, ~0.79 for an ellipse.
 */
export function bestFrame(pts: V2[]): Frame & { fill: number } {
  let best: (Frame & { fill: number }) | null = null;
  let bestArea = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const dx = pts[i].x - pts[j].x;
    const dz = pts[i].z - pts[j].z;
    const L = Math.hypot(dx, dz);
    if (L < 1e-6) continue;
    const ux = dx / L;
    const uz = dz / L;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    for (const p of pts) {
      const u = p.x * ux + p.z * uz;
      const v = -p.x * uz + p.z * ux;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const area = (u1 - u0) * (v1 - v0);
    if (area < bestArea - 1e-6) {
      bestArea = area;
      const cu = (u0 + u1) / 2;
      const cv = (v0 + v1) / 2;
      const long = u1 - u0 >= v1 - v0;
      const f: Frame = long
        ? { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux, uz, hl: (u1 - u0) / 2, hw: (v1 - v0) / 2 }
        : { cx: cu * ux - cv * uz, cz: cu * uz + cv * ux, ux: -uz, uz: ux, hl: (v1 - v0) / 2, hw: (u1 - u0) / 2 };
      best = { ...f, fill: 0 };
    }
  }
  if (!best) return { cx: pts[0]?.x ?? 0, cz: pts[0]?.z ?? 0, ux: 1, uz: 0, hl: 0, hw: 0, fill: 0 };
  best.fill = bestArea > 0 ? polygonArea(pts) / bestArea : 0;
  return best;
}
