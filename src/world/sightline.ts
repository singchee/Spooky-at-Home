import type { V2 } from '../map/types';

/**
 * Lines of sight through a city (3.39, high-rise visibility). Pure maths, no three.js, so it is
 * unit-tested and shared by the building cut-away (which towers to see through), the reticle's
 * MASKED state (is a building between the gunship and the aim point?) and the camera's orbit
 * (how tall is the city around the aim?).
 *
 * Buildings are vertical prisms: a footprint polygon and a flat top. The line from a ground point
 * p (at height y0) up to the gunship at G rises steadily, so it is below a building's top `top`
 * exactly while its ground track runs from p toward G for a horizontal length of
 * |G - p| * (top - y0) / (G.y - y0). The line passes through the building iff that ground segment
 * touches the footprint; a building hides the area within R of p iff the segment comes within R of it.
 */
export interface V3 {
  x: number;
  y: number;
  z: number;
}

export interface Prism {
  pts: V2[];
  /** Height of the top (flat roof, or about the middle of a pitched one), metres. */
  top: number;
  /** Footprint centroid and the radius around it that holds every corner (a quick reject). */
  cx: number;
  cz: number;
  r: number;
}

export function prism(pts: V2[], top: number): Prism {
  let cx = 0;
  let cz = 0;
  for (const p of pts) {
    cx += p.x;
    cz += p.z;
  }
  cx /= pts.length || 1;
  cz /= pts.length || 1;
  let r = 0;
  for (const p of pts) r = Math.max(r, Math.hypot(p.x - cx, p.z - cz));
  return { pts, top, cx, cz, r };
}

/**
 * The ground track of the line from p (height y0) toward `from`, up to where it reaches height `top`.
 * `out` is reused when given (hot loops: no garbage per building per frame).
 */
export function sightSegment(p: V2, from: V3, top: number, y0 = 0, out?: [V2, V2]): [V2, V2] {
  const t = Math.max(0, Math.min(1, (top - y0) / Math.max(1e-6, from.y - y0)));
  const o = out ?? [p, { x: 0, z: 0 }];
  o[0] = p;
  o[1].x = p.x + (from.x - p.x) * t;
  o[1].z = p.z + (from.z - p.z) * t;
  return o;
}

const SEG: [V2, V2] = [{ x: 0, z: 0 }, { x: 0, z: 0 }];
const CEN: V2 = { x: 0, z: 0 };

/** Distance from point q to segment a-b. */
export function pointSegDist(q: V2, a: V2, b: V2): number {
  const ux = b.x - a.x;
  const uz = b.z - a.z;
  const L2 = ux * ux + uz * uz;
  const t = L2 > 0 ? Math.max(0, Math.min(1, ((q.x - a.x) * ux + (q.z - a.z) * uz) / L2)) : 0;
  return Math.hypot(q.x - a.x - ux * t, q.z - a.z - uz * t);
}

function cross(ax: number, az: number, bx: number, bz: number): number {
  return ax * bz - az * bx;
}

/** Do segments a-b and c-d cross or touch? */
export function segmentsCross(a: V2, b: V2, c: V2, d: V2): boolean {
  const d1 = cross(d.x - c.x, d.z - c.z, a.x - c.x, a.z - c.z);
  const d2 = cross(d.x - c.x, d.z - c.z, b.x - c.x, b.z - c.z);
  const d3 = cross(b.x - a.x, b.z - a.z, c.x - a.x, c.z - a.z);
  const d4 = cross(b.x - a.x, b.z - a.z, d.x - a.x, d.z - a.z);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0) || d1 === 0 || d2 === 0) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0) || d3 === 0 || d4 === 0);
}

function inside(q: V2, pts: V2[]): boolean {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i];
    const b = pts[j];
    if (a.z > q.z !== b.z > q.z && q.x < ((b.x - a.x) * (q.z - a.z)) / (b.z - a.z) + a.x) c = !c;
  }
  return c;
}

/** Distance between segment a-b and a polygon (0 if they touch or the segment is inside). */
export function segPolyDist(a: V2, b: V2, pts: V2[]): number {
  if (inside(a, pts) || inside(b, pts)) return 0;
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const c = pts[j];
    const d = pts[i];
    if (segmentsCross(a, b, c, d)) return 0;
    best = Math.min(best, pointSegDist(a, c, d), pointSegDist(b, c, d), pointSegDist(c, a, b), pointSegDist(d, a, b));
  }
  return best;
}

/** How close (metres) building `b` comes to hiding ground point p from `from`: 0 = it covers p. */
export function hideDistance(b: Prism, p: V2, from: V3, y0 = 0): number {
  if (b.top <= y0) return Infinity;
  const [s0, s1] = sightSegment(p, from, b.top, y0, SEG);
  return segPolyDist(s0, s1, b.pts);
}

/** Quick reject: a lower bound on hideDistance from the bounding circle. */
export function hideDistanceBound(b: Prism, p: V2, from: V3, y0 = 0): number {
  if (b.top <= y0) return Infinity;
  const [s0, s1] = sightSegment(p, from, b.top, y0, SEG);
  CEN.x = b.cx;
  CEN.z = b.cz;
  return pointSegDist(CEN, s0, s1) - b.r;
}

/** Does building b stand between the point p (at height y0) and `from`? */
export function blocks(b: Prism, p: V2, from: V3, y0 = 0): boolean {
  return hideDistanceBound(b, p, from, y0) <= 0 && hideDistance(b, p, from, y0) === 0;
}

/**
 * Where the line from `from` (the gunship) down to ground point p first enters building b, as the
 * fraction t of the way from p back up to `from` (0 = p itself; -1: it never enters). The highest t
 * is the first contact seen from the gunship: the roof if the line comes down through it, else a wall.
 */
export function entryT(b: Prism, p: V2, from: V3): number {
  const tTop = Math.max(0, Math.min(1, b.top / Math.max(1e-6, from.y)));
  const at = (t: number): V2 => ({ x: p.x + (from.x - p.x) * t, z: p.z + (from.z - p.z) * t });
  if (inside(at(tTop), b.pts)) return tTop;
  // Walls: where the ground track [p, at(tTop)] crosses the footprint's edges; the crossing nearest the top.
  const a = p;
  const e = at(tTop);
  let best = inside(p, b.pts) ? 0 : -1;
  const n = b.pts.length;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const c = b.pts[j];
    const d = b.pts[i];
    const rx = e.x - a.x, rz = e.z - a.z;
    const sx = d.x - c.x, sz = d.z - c.z;
    const den = cross(rx, rz, sx, sz);
    if (Math.abs(den) < 1e-12) continue;
    const u = cross(c.x - a.x, c.z - a.z, sx, sz) / den; // along the track
    const v = cross(c.x - a.x, c.z - a.z, rx, rz) / den; // along the edge
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    best = Math.max(best, u * tTop);
  }
  return best;
}

/**
 * A coarse grid of building heights (cell `cell` metres): each cell holds the top of the tallest
 * building over its centre, 0 for open ground. Built once with the map.
 */
export class HeightGrid {
  readonly n: number;
  readonly h: Float32Array;
  constructor(readonly half: number, readonly cell: number, prisms: Prism[]) {
    this.n = Math.ceil((half * 2) / cell);
    this.h = new Float32Array(this.n * this.n);
    for (const b of prisms) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const p of b.pts) {
        x0 = Math.min(x0, p.x);
        x1 = Math.max(x1, p.x);
        z0 = Math.min(z0, p.z);
        z1 = Math.max(z1, p.z);
      }
      const i0 = Math.max(0, Math.floor((x0 + half) / cell));
      const i1 = Math.min(this.n - 1, Math.floor((x1 + half) / cell));
      const j0 = Math.max(0, Math.floor((z0 + half) / cell));
      const j1 = Math.min(this.n - 1, Math.floor((z1 + half) / cell));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) {
          const c = { x: -half + (i + 0.5) * cell, z: -half + (j + 0.5) * cell };
          if (inside(c, b.pts)) this.h[j * this.n + i] = Math.max(this.h[j * this.n + i], b.top);
        }
      }
    }
  }

  /**
   * How tall the city is around p (metres): the median height of the built cells within `radius`,
   * scaled down where little is built (a lone tower in a suburb is not a high-rise district).
   */
  tallness(p: V2, radius = 100): number {
    const { n, cell, half } = this;
    const heights: number[] = [];
    let total = 0;
    const r = Math.ceil(radius / cell);
    const ci = Math.floor((p.x + half) / cell);
    const cj = Math.floor((p.z + half) / cell);
    for (let j = cj - r; j <= cj + r; j++) {
      for (let i = ci - r; i <= ci + r; i++) {
        const x = -half + (i + 0.5) * cell;
        const z = -half + (j + 0.5) * cell;
        if (Math.hypot(x - p.x, z - p.z) > radius) continue;
        total++;
        if (i < 0 || j < 0 || i >= n || j >= n) continue;
        const v = this.h[j * n + i];
        if (v > 0) heights.push(v);
      }
    }
    if (!heights.length || !total) return 0;
    heights.sort((a, b) => a - b);
    const median = heights[Math.floor(heights.length / 2)];
    const cover = heights.length / total;
    const t = Math.max(0, Math.min(1, (cover - 0.1) / 0.15));
    return median * t * t * (3 - 2 * t);
  }
}

/** A grid of building indices by footprint bounds, for line-of-sight queries. */
export class PrismIndex {
  private cells: number[][];
  private n: number;
  private stamp: Uint32Array;
  private tick = 0;
  readonly maxTop: number;
  constructor(readonly prisms: Prism[], readonly half: number, readonly cell = 40) {
    this.n = Math.max(1, Math.ceil((half * 2 + 400) / cell));
    this.cells = Array.from({ length: this.n * this.n }, () => []);
    this.stamp = new Uint32Array(prisms.length);
    let maxTop = 0;
    prisms.forEach((b, k) => {
      maxTop = Math.max(maxTop, b.top);
      const [i0, j0] = this.at(b.cx - b.r, b.cz - b.r);
      const [i1, j1] = this.at(b.cx + b.r, b.cz + b.r);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.cells[j * this.n + i].push(k);
    });
    this.maxTop = maxTop;
  }

  private at(x: number, z: number): [number, number] {
    const o = this.half + 200;
    const c = (v: number) => Math.max(0, Math.min(this.n - 1, Math.floor((v + o) / this.cell)));
    return [c(x), c(z)];
  }

  /** Indices of the buildings that could stand on the line from p (height y0) toward `from`. */
  candidates(p: V2, from: V3, y0 = 0, pad = 0): number[] {
    const [, s1] = sightSegment(p, from, this.maxTop, y0);
    const [i0, j0] = this.at(Math.min(p.x, s1.x) - pad, Math.min(p.z, s1.z) - pad);
    const [i1, j1] = this.at(Math.max(p.x, s1.x) + pad, Math.max(p.z, s1.z) + pad);
    const out: number[] = [];
    if (++this.tick === 0xffffffff) {
      this.stamp.fill(0);
      this.tick = 1;
    }
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const k of this.cells[j * this.n + i]) {
          if (this.stamp[k] === this.tick) continue;
          this.stamp[k] = this.tick;
          out.push(k);
        }
      }
    }
    return out;
  }

  /**
   * Where a round fired from `from` at ground point p lands: the first building it meets, or p.
   * Returns the 3D point of contact (y > 0 on a wall or roof) and the building, -1 for none.
   */
  landing(p: V2, from: V3): { x: number; y: number; z: number; building: number } {
    let bestT = -1;
    let bestK = -1;
    for (const k of this.candidates(p, from, 0)) {
      const t = entryT(this.prisms[k], p, from);
      if (t > bestT) {
        bestT = t;
        bestK = k;
      }
    }
    if (bestK < 0) return { x: p.x, y: 0, z: p.z, building: -1 };
    return { x: p.x + (from.x - p.x) * bestT, y: from.y * bestT, z: p.z + (from.z - p.z) * bestT, building: bestK };
  }

  /**
   * The first building on the line from p (height y0) to `from`, or -1 for a clear line. `topOf`
   * overrides a building's height (the cut-away's opaque part).
   */
  blocker(p: V2, from: V3, y0 = 0, topOf?: (k: number) => number): number {
    let best = -1;
    let bestD = Infinity;
    for (const k of this.candidates(p, from, y0)) {
      const b = this.prisms[k];
      const top = topOf ? topOf(k) : b.top;
      const bb = top === b.top ? b : { ...b, top };
      if (!blocks(bb, p, from, y0)) continue;
      const d = Math.hypot(b.cx - p.x, b.cz - p.z);
      if (d < bestD) {
        bestD = d;
        best = k;
      }
    }
    return best;
  }
}
