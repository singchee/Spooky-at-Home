import type { MapData, V2 } from './types';
import { bounds, centroid, distToSegment, pointInPolygon } from './geom';

/**
 * A coarse walkability grid (default 3 m cells): cells whose centre is inside a building or water are blocked.
 * Zombies navigate with a "flow field": for a set of target cells, every free cell stores
 * its step count to the nearest target, and a zombie simply walks downhill.
 *
 * Cells only tell part of the story: a free cell can still hold up to ~1.5 m of a wall. So every cell that a
 * footprint's edge passes near keeps that footprint, and isBlocked() tests the exact polygon there. Anything
 * that moves or places agents through isBlocked/nearestFree therefore never stands inside a building (3.15).
 */
export class WalkGrid {
  readonly cell: number;
  readonly half: number;
  readonly n: number;
  readonly blocked: Uint8Array;
  /** 1 = a footprint edge passes through or near this cell: check the exact polygons in `edgePolys`. */
  private edge: Uint8Array;
  private edgePolys = new Map<number, V2[][]>();
  private queue: Int32Array;

  constructor(map: MapData, cell = 3) {
    this.cell = cell;
    this.half = map.half + 60;
    this.n = Math.ceil((2 * this.half) / cell);
    this.blocked = new Uint8Array(this.n * this.n);
    this.edge = new Uint8Array(this.n * this.n);
    this.queue = new Int32Array(this.n * this.n);
    for (const b of map.buildings) this.rasterize(b.pts);
    for (const a of map.areas) if (a.kind === 'water') this.rasterize(a.pts);
  }

  private rasterize(pts: V2[]): void {
    if (pts.length < 3) return;
    const bb = bounds(pts);
    const i0 = this.col(bb.minX);
    const i1 = this.col(bb.maxX);
    const j0 = this.col(bb.minZ);
    const j1 = this.col(bb.maxZ);
    let any = false;
    // Half a cell's diagonal: any cell whose centre is nearer than this to an edge may hold part of the polygon.
    const reach = this.cell * Math.SQRT1_2 + 1e-6;
    for (let j = Math.max(0, j0 - 1); j <= Math.min(this.n - 1, j1 + 1); j++) {
      for (let i = Math.max(0, i0 - 1); i <= Math.min(this.n - 1, i1 + 1); i++) {
        const c = { x: this.cx(i), z: this.cz(j) };
        const k = j * this.n + i;
        if (i >= i0 && i <= i1 && j >= j0 && j <= j1 && pointInPolygon(c, pts)) {
          this.blocked[k] = 1;
          any = true;
        }
        let near = false;
        for (let e = 0; e < pts.length && !near; e++) near = distToSegment(c, pts[e], pts[(e + 1) % pts.length]) <= reach;
        if (near) {
          this.edge[k] = 1;
          const list = this.edgePolys.get(k);
          if (list) list.push(pts);
          else this.edgePolys.set(k, [pts]);
        }
      }
    }
    if (!any) {
      const c = centroid(pts);
      const k = this.idx(c.x, c.z);
      if (k >= 0) this.blocked[k] = 1;
    }
  }

  col(x: number): number {
    return Math.floor((x + this.half) / this.cell);
  }
  cx(i: number): number {
    return -this.half + (i + 0.5) * this.cell;
  }
  cz(j: number): number {
    return -this.half + (j + 0.5) * this.cell;
  }

  idx(x: number, z: number): number {
    const i = this.col(x);
    const j = this.col(z);
    if (i < 0 || j < 0 || i >= this.n || j >= this.n) return -1;
    return j * this.n + i;
  }

  /** True if (x, z) is off the grid, in a blocked cell, or inside any building or water polygon. */
  isBlocked(x: number, z: number): boolean {
    const k = this.idx(x, z);
    if (k < 0 || this.blocked[k] === 1) return true;
    if (this.edge[k] === 0) return false;
    const p = { x, z };
    for (const pts of this.edgePolys.get(k)!) if (pointInPolygon(p, pts)) return true;
    return false;
  }

  /** Closest free spot to p (searching outward up to maxR metres), or p itself if none. */
  nearestFree(p: V2, maxR = 120): V2 {
    if (!this.isBlocked(p.x, p.z)) return { ...p };
    for (let r = this.cell; r <= maxR; r += this.cell) {
      const steps = Math.max(16, Math.ceil((2 * Math.PI * r) / this.cell));
      for (let a = 0; a < steps; a++) {
        const q = { x: p.x + Math.cos((a / steps) * Math.PI * 2) * r, z: p.z + Math.sin((a / steps) * Math.PI * 2) * r };
        if (!this.isBlocked(q.x, q.z)) return q;
      }
    }
    return { ...p };
  }

  /** Free cells just outside a polygon: where zombies stand to attack a building. */
  perimeterCells(poly: V2[]): number[] {
    const bb = bounds(poly);
    const out: number[] = [];
    const pad = this.cell * 2;
    for (let z = bb.minZ - pad; z <= bb.maxZ + pad; z += this.cell) {
      for (let x = bb.minX - pad; x <= bb.maxX + pad; x += this.cell) {
        const k = this.idx(x, z);
        if (k >= 0 && !this.blocked[k] && !pointInPolygon({ x, z }, poly)) out.push(k);
      }
    }
    return out;
  }

  /** Breadth-first step counts from the source cells to every reachable free cell (-1 = unreachable). */
  flowField(sources: number[]): Int32Array {
    const n = this.n;
    const d = new Int32Array(n * n).fill(-1);
    const q = this.queue;
    let head = 0;
    let tail = 0;
    for (const s of sources) {
      if (s >= 0 && d[s] === -1 && !this.blocked[s]) {
        d[s] = 0;
        q[tail++] = s;
      }
    }
    while (head < tail) {
      const u = q[head++];
      const i = u % n;
      const j = (u - i) / n;
      const du = d[u] + 1;
      for (let dj = -1; dj <= 1; dj++) {
        const jj = j + dj;
        if (jj < 0 || jj >= n) continue;
        for (let di = -1; di <= 1; di++) {
          if (di === 0 && dj === 0) continue;
          const ii = i + di;
          if (ii < 0 || ii >= n) continue;
          const v = jj * n + ii;
          if (d[v] !== -1 || this.blocked[v]) continue;
          // no cutting corners between two blocked cells
          if (di !== 0 && dj !== 0 && (this.blocked[j * n + ii] || this.blocked[jj * n + i])) continue;
          d[v] = du;
          q[tail++] = v;
        }
      }
    }
    return d;
  }

  /** Unit direction downhill in the flow field from (x,z), or null if there's no way. */
  downhill(field: Int32Array, x: number, z: number): V2 | null {
    const k = this.idx(x, z);
    if (k < 0 || field[k] < 0) return null;
    const n = this.n;
    const i = k % n;
    const j = (k - i) / n;
    let best = field[k];
    let bi = -1;
    let bj = -1;
    for (let dj = -1; dj <= 1; dj++) {
      for (let di = -1; di <= 1; di++) {
        const ii = i + di;
        const jj = j + dj;
        if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
        const v = field[jj * n + ii];
        if (v >= 0 && v < best) {
          best = v;
          bi = ii;
          bj = jj;
        }
      }
    }
    if (bi < 0) return null;
    const dx = this.cx(bi) - x;
    const dz = this.cz(bj) - z;
    const len = Math.hypot(dx, dz) || 1;
    return { x: dx / len, z: dz / len };
  }

  fieldAt(field: Int32Array, x: number, z: number): number {
    const k = this.idx(x, z);
    return k < 0 ? -1 : field[k];
  }
}
