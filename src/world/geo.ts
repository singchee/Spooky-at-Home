import * as THREE from 'three';

/** Sensor values: R = heat (thermal), G = visible light (night vision), B = near-infrared. */
export type Sig = [number, number, number];

/** The moon: where baked visible-light shading comes from (same direction as the scene's light). */
const MOON = new THREE.Vector3(-0.4, 1, 0.3).normalize();

/**
 * Visible-light shading for a face with normal (nx, ny, nz): faces toward the moon are brighter.
 * Heat barely depends on facing, so thermal stays flat.
 */
export function moonShade(nx: number, ny: number, nz: number): number {
  return 0.55 + 0.45 * Math.max(0, nx * MOON.x + ny * MOON.y + nz * MOON.z);
}

/**
 * Collects triangles straight into growable arrays (non-indexed, flat faces), much faster than
 * building one BufferGeometry per object and merging. Colours get baked shading per face.
 */
export class GeoBuilder {
  pos: number[] = [];
  col: number[] = [];
  /** Optional extra per-vertex attribute (4 floats), e.g. the window parameters on walls. */
  extra: number[] | null;
  constructor(withExtra = false) {
    this.extra = withExtra ? [] : null;
  }
  get triangles(): number {
    return this.pos.length / 9;
  }
  /**
   * One triangle. `c` is the face's sensor value; G is shaded by facing unless `flat`.
   * `e` gives the extra attribute per vertex (3 × 4 floats) when this builder has one.
   */
  tri(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, c: Sig, flat = false, e?: number[]): void {
    let s = 1;
    if (!flat) {
      const ux = bx - ax, uy = by - ay, uz = bz - az;
      const vx = cx - ax, vy = cy - ay, vz = cz - az;
      let nx = uy * vz - uz * vy;
      let ny = uz * vx - ux * vz;
      let nz = ux * vy - uy * vx;
      const L = Math.hypot(nx, ny, nz) || 1;
      nx /= L;
      ny /= L;
      nz /= L;
      s = moonShade(nx, ny, nz);
    }
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    const r = c[0];
    const g = c[1] * s;
    const b = c[2];
    this.col.push(r, g, b, r, g, b, r, g, b);
    if (this.extra) {
      if (e) this.extra.push(...e);
      else this.extra.push(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
    }
  }
  /** A quad a-b-c-d (counter-clockwise seen from the front). */
  quad(a: number[], b: number[], c: number[], d: number[], col: Sig, flat = false, e?: [number[], number[], number[], number[]]): void {
    this.tri(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2], col, flat, e && [...e[0], ...e[1], ...e[2]]);
    this.tri(a[0], a[1], a[2], c[0], c[1], c[2], d[0], d[1], d[2], col, flat, e && [...e[0], ...e[2], ...e[3]]);
  }
  /**
   * A box from its footprint centre, axis (unit ux, uz), half length/width, base and height.
   * No bottom face; `ends: false` drops the two short sides and `lid: false` the top (thin fences).
   */
  box(cx: number, cz: number, ux: number, uz: number, hl: number, hw: number, y0: number, h: number, top: Sig, side: Sig = top, o: { ends?: boolean; lid?: boolean } = {}): void {
    const vx = -uz;
    const vz = ux;
    const p = (u: number, v: number, y: number) => [cx + ux * u + vx * v, y, cz + uz * u + vz * v];
    const y1 = y0 + h;
    const a = p(-hl, -hw, 0), b = p(hl, -hw, 0), c = p(hl, hw, 0), d = p(-hl, hw, 0);
    const lo = (q: number[]) => [q[0], y0, q[2]];
    const hi = (q: number[]) => [q[0], y1, q[2]];
    if (o.lid !== false) this.quad(hi(a), hi(d), hi(c), hi(b), top);
    this.quad(lo(b), lo(a), hi(a), hi(b), side);
    this.quad(lo(d), lo(c), hi(c), hi(d), side);
    if (o.ends !== false) {
      this.quad(lo(c), lo(b), hi(b), hi(c), side);
      this.quad(lo(a), lo(d), hi(d), hi(a), side);
    }
  }
  toGeometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (this.extra) g.setAttribute('wall', new THREE.Float32BufferAttribute(this.extra, 4));
    g.computeBoundingSphere();
    return g;
  }
}
