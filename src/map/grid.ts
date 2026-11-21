import type { MapData, V2 } from './types';
import { bounds, centroid, pointInPolygon } from './geom';

/**
 * A coarse walkability grid (default 3 m cells): cells inside buildings or water are blocked.
 * Zombies navigate with a "flow field": for a set of target cells, every free cell stores
 * its step count to the nearest target, and a zombie simply walks downhill.
 */
export class WalkGrid {
  readonly cell: number;
  readonly half: number;
  readonly n: number;
  readonly blocked: Uint8Array;
  private queue: Int32Array;

  constructor(map: MapData, cell = 3) {
    this.cell = cell;
    this.half = map.half + 60;
    this.n = Math.ceil((2 * this.half) / cell);
    this.blocked = new Uint8Array(this.n * this.n);
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
    for (let j = Math.max(0, j0); j <= Math.min(this.n - 1, j1); j++) {
      for (let i = Math.max(0, i0); i <= Math.min(this.n - 1, i1); i++) {
        if (pointInPolygon({ x: this.cx(i), z: this.cz(j) }, pts)) {
          this.blocked[j * this.n + i] = 1;
          any = true;
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

  isBlocked(x: number, z: number): boolean {
    const k = this.idx(x, z);
    return k < 0 || this.blocked[k] === 1;
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
