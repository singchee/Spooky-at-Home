import type { Area, Building, MapData, Road, V2 } from '../map/types';
import { bounds, pointInPolygon } from '../map/geom';

/**
 * Grid indexes over the map's buildings and roads, so placement can ask "is this spot inside
 * a building?" or "how far is the nearest road surface?" in roughly constant time.
 * Pure data: no three.js, so placement stays testable headless.
 */
const key = (ix: number, iz: number) => (ix + 32768) * 65536 + (iz + 32768);

interface Poly {
  pts: V2[];
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface Seg {
  ax: number;
  az: number;
  bx: number;
  bz: number;
  /** Half the road's width. */
  hw: number;
  road: number;
}

class Grid<T> {
  private cells = new Map<number, T[]>();
  constructor(readonly size: number) {}
  add(minX: number, minZ: number, maxX: number, maxZ: number, item: T): void {
    const s = this.size;
    for (let ix = Math.floor(minX / s); ix <= Math.floor(maxX / s); ix++) {
      for (let iz = Math.floor(minZ / s); iz <= Math.floor(maxZ / s); iz++) {
        const k = key(ix, iz);
        const c = this.cells.get(k);
        if (c) c.push(item);
        else this.cells.set(k, [item]);
      }
    }
  }
  /** Items in the cells overlapping the box (an item can come back more than once). */
  each(minX: number, minZ: number, maxX: number, maxZ: number, fn: (item: T) => boolean | void): boolean {
    const s = this.size;
    for (let ix = Math.floor(minX / s); ix <= Math.floor(maxX / s); ix++) {
      for (let iz = Math.floor(minZ / s); iz <= Math.floor(maxZ / s); iz++) {
        const c = this.cells.get(key(ix, iz));
        if (c) for (const it of c) if (fn(it)) return true;
      }
    }
    return false;
  }
}

function segDist(px: number, pz: number, s: Seg): number {
  const dx = s.bx - s.ax;
  const dz = s.bz - s.az;
  const l2 = dx * dx + dz * dz;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - s.ax) * dx + (pz - s.az) * dz) / l2));
  return Math.hypot(px - (s.ax + dx * t), pz - (s.az + dz * t));
}

function edgeDist(p: V2, pts: V2[]): number {
  let d = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const s = { ax: pts[j].x, az: pts[j].z, bx: pts[i].x, bz: pts[i].z, hw: 0, road: 0 };
    d = Math.min(d, segDist(p.x, p.z, s));
  }
  return d;
}

/** Polygons (buildings, areas, features) for "is this point inside or near one?" questions. */
export class PolyIndex {
  private grid = new Grid<Poly>(32);
  constructor(polys: V2[][]) {
    for (const pts of polys) {
      if (pts.length < 3) continue;
      const b = bounds(pts);
      this.grid.add(b.minX, b.minZ, b.maxX, b.maxZ, { pts, ...b });
    }
  }
  /** Inside a polygon, or within `margin` metres of one. */
  hit(p: V2, margin = 0): boolean {
    return this.grid.each(p.x - margin, p.z - margin, p.x + margin, p.z + margin, (q) => {
      if (p.x < q.minX - margin || p.x > q.maxX + margin || p.z < q.minZ - margin || p.z > q.maxZ + margin) return false;
      if (pointInPolygon(p, q.pts)) return true;
      return margin > 0 && edgeDist(p, q.pts) < margin;
    });
  }
}

/** Road centrelines with their widths. */
export class RoadIndex {
  private grid = new Grid<Seg>(24);
  readonly segs: Seg[] = [];
  constructor(roads: Road[]) {
    roads.forEach((r, ri) => {
      for (let i = 1; i < r.pts.length; i++) {
        const a = r.pts[i - 1];
        const b = r.pts[i];
        const s: Seg = { ax: a.x, az: a.z, bx: b.x, bz: b.z, hw: r.width / 2, road: ri };
        this.segs.push(s);
        const m = s.hw + 1;
        this.grid.add(Math.min(a.x, b.x) - m, Math.min(a.z, b.z) - m, Math.max(a.x, b.x) + m, Math.max(a.z, b.z) + m, s);
      }
    });
  }
  /**
   * Distance from `p` to the nearest road surface edge (negative: on the road), looking no further
   * than `reach` metres. `skipRoad` ignores one road (a car parked on its own kerb).
   */
  clearance(p: V2, reach = 30, skipRoad = -1): number {
    let best = reach;
    this.grid.each(p.x - reach, p.z - reach, p.x + reach, p.z + reach, (s) => {
      if (s.road === skipRoad) return false;
      const d = segDist(p.x, p.z, s) - s.hw;
      if (d < best) best = d;
      return false;
    });
    return best;
  }
  /** The nearest road segment's closest point, within `reach`. */
  nearest(p: V2, reach = 40): { seg: Seg; q: V2; d: number } | null {
    let best: { seg: Seg; q: V2; d: number } | null = null;
    this.grid.each(p.x - reach, p.z - reach, p.x + reach, p.z + reach, (s) => {
      const dx = s.bx - s.ax;
      const dz = s.bz - s.az;
      const l2 = dx * dx + dz * dz;
      const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - s.ax) * dx + (p.z - s.az) * dz) / l2));
      const q = { x: s.ax + dx * t, z: s.az + dz * t };
      const d = Math.hypot(p.x - q.x, p.z - q.z);
      if (d < reach && (!best || d < best.d)) best = { seg: s, q, d };
      return false;
    });
    return best;
  }
}

/** A coarse occupancy grid: remembers points already used so detail doesn't pile up. */
export class Occupancy {
  private grid: Grid<V2>;
  constructor(cell = 4) {
    this.grid = new Grid<V2>(cell);
  }
  near(p: V2, r: number): boolean {
    return this.grid.each(p.x - r, p.z - r, p.x + r, p.z + r, (q) => Math.hypot(q.x - p.x, q.z - p.z) < r);
  }
  add(p: V2): void {
    this.grid.add(p.x, p.z, p.x, p.z, p);
  }
}

/** Everything placement needs to know about the map, built once. */
export interface MapIndex {
  map: MapData;
  buildings: PolyIndex;
  roads: RoadIndex;
  water: PolyIndex;
  /** Parks and woods: no fences or driveways here. */
  green: PolyIndex;
  /** Sports grounds, courts, pools and car parks: no trees, fences or garden detail. */
  open: PolyIndex;
}

export function indexMap(map: MapData): MapIndex {
  const ofKind = (k: Area['kind']) => map.areas.filter((a) => a.kind === k).map((a) => a.pts);
  const openCats = new Set(['pitch', 'stadium', 'tennis', 'swimming_pool', 'parking', 'playground']);
  return {
    map,
    buildings: new PolyIndex(map.buildings.map((b: Building) => b.pts)),
    roads: new RoadIndex(map.roads),
    water: new PolyIndex(ofKind('water')),
    green: new PolyIndex([...ofKind('park'), ...ofKind('wood')]),
    open: new PolyIndex((map.features ?? []).filter((f) => openCats.has(f.category) && f.pts && f.pts.length >= 3).map((f) => f.pts!)),
  };
}

/** Inside the playable square, `margin` metres in from its edge. */
export const inMap = (map: MapData, p: V2, margin = 0): boolean => Math.abs(p.x) <= map.half - margin && Math.abs(p.z) <= map.half - margin;
