import type { Building, MapData, Road, V2 } from '../map/types';
import { bounds, centroid, dist, pointInPolygon, polygonArea, polylineLength } from '../map/geom';
import { hashString, mulberry32, type Rng } from '../util/rng';
import { at, bestFrame, corners, type Frame } from './frame';
import { indexMap, inMap, Occupancy, RoadIndex, type MapIndex } from './spatial';

/**
 * Where the map's small detail goes: trees, parked cars, pools, sports-field lines and garden
 * fences. Pure functions of (map, seed): no three.js and only seeded randomness, so the same map and seed
 * always give the same street, and tests can check the rules (nothing inside buildings, nothing
 * blocking roads, counts capped).
 */

export const CAPS = { trees: 9000, cars: 3500, pools: 700, fences: 14000, lines: 6000, bays: 12000 } as const;

export interface TreeP {
  x: number;
  z: number;
  /** Canopy radius, metres. */
  r: number;
  /** Ground height the tree stands on. */
  y: number;
  rot: number;
  src: 'mapped' | 'park' | 'street';
}

export interface CarP {
  x: number;
  z: number;
  /** Surface height (roads are drawn 1 m up, car parks 0.7 m). */
  y: number;
  /** Heading, radians, around +y (0 = facing +x). */
  heading: number;
  /** Engine still warm: a hot bonnet on thermal. */
  warm: boolean;
  /** 0..1, varies the paint (visible light) and a little of the heat. */
  tint: number;
  where: 'kerb' | 'driveway' | 'lot';
}

export const CAR = { length: 4.4, width: 1.8 } as const;

export interface PoolP {
  pts: V2[];
  /** Underwater light on: glows on night vision. */
  lit: boolean;
}

export interface Line {
  a: V2;
  b: V2;
}

export interface FenceRun {
  a: V2;
  b: V2;
  kind: 'fence' | 'hedge';
}

export interface Detail {
  trees: TreeP[];
  cars: CarP[];
  pools: PoolP[];
  /** Painted lines on pitches and courts (visible light only). */
  fieldLines: Line[];
  /** Car-park surfaces (asphalt) and their bay lines. */
  carParks: V2[][];
  bayLines: Line[];
  fences: FenceRun[];
}

const STREET_TREE_ROADS = new Set(['residential', 'living_street', 'tertiary', 'unclassified', 'secondary', 'primary']);
const KERB_ROADS = new Set(['residential', 'living_street', 'tertiary', 'unclassified', 'secondary']);
const FOOT = new Set(['footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian', 'bridleway']);
const HOUSE_KINDS = new Set(['house', 'detached', 'semidetached_house', 'terrace', 'bungalow', 'residential', 'farm', 'cabin', 'hut']);

/** A small home: gets a pitched roof, a garden fence, maybe a pool and a car in the drive. */
export function isHouse(b: Building): boolean {
  const area = polygonArea(b.pts);
  const h = Number.isFinite(b.height) ? b.height : 7;
  if (HOUSE_KINDS.has(b.kind)) return area < 400 && h < 13;
  return (b.kind === 'yes' || !b.kind) && area > 40 && area < 260 && h < 10;
}

/** A stable random stream for one object: same seed and id, same numbers, whatever else changed. */
export const streamFor = (seed: number, id: string): Rng => mulberry32((seed ^ hashString(id)) >>> 0);

// ---------------------------------------------------------------- trees

function treeOk(ix: MapIndex, p: V2, r: number, occ: Occupancy): boolean {
  if (!inMap(ix.map, p, 1)) return false;
  if (ix.buildings.hit(p, r * 0.6)) return false;
  if (ix.roads.clearance(p, 12) < r * 0.75) return false;
  if (ix.water.hit(p) || ix.open.hit(p)) return false;
  return !occ.near(p, r * 1.1);
}

export function placeTrees(ix: MapIndex, seed: number): TreeP[] {
  const map = ix.map;
  const out: TreeP[] = [];
  const occ = new Occupancy(6);
  const push = (p: V2, r: number, y: number, rot: number, src: TreeP['src']) => {
    out.push({ x: p.x, z: p.z, r, y, rot, src });
    occ.add(p);
  };
  // 1. Trees someone mapped. Trust them, but not inside a building or in the middle of a road.
  const mr = streamFor(seed, 'mapped-trees');
  for (const p of map.trees ?? []) {
    if (out.length >= CAPS.trees) break;
    const r = 2.3 + mr() * 1.4;
    const rot = mr() * Math.PI * 2;
    if (!inMap(map, p, 0) || ix.buildings.hit(p, 0.5) || ix.roads.clearance(p, 12) < 0.3 || occ.near(p, 1.5)) continue;
    push(p, r, ix.green.hit(p) ? 0.4 : 0, rot, 'mapped');
  }
  // 2. Woods and parks, scattered (fewer where the map already has its trees).
  for (const a of map.areas) {
    if (a.kind === 'water' || a.pts.length < 3) continue;
    const rr = streamFor(seed, `area-${a.id}`);
    const bb = bounds(a.pts);
    const n = Math.min(320, Math.floor(polygonArea(a.pts) / (a.kind === 'wood' ? 85 : 280)));
    for (let i = 0, tries = 0; i < n && tries < n * 4 && out.length < CAPS.trees; tries++) {
      const p = { x: bb.minX + rr() * (bb.maxX - bb.minX), z: bb.minZ + rr() * (bb.maxZ - bb.minZ) };
      const r = a.kind === 'wood' ? 2.4 + rr() * 1.6 : 2.6 + rr() * 1.8;
      const rot = rr() * Math.PI * 2;
      if (!pointInPolygon(p, a.pts) || !treeOk(ix, p, a.kind === 'wood' ? r * 0.55 : r, occ)) continue;
      push(p, r, 0.4, rot, 'park');
      i++;
    }
  }
  // 3. Street trees on the verges of residential streets. On a big map the density drops so the
  // cap is spread over every street instead of running out on the first ones.
  const treeKeep = (road: Road) => (road.kind === 'primary' ? 0.35 : road.kind === 'secondary' ? 0.5 : 0.62);
  const expected = map.roads.reduce((s, road) => s + (STREET_TREE_ROADS.has(road.kind) ? (polylineLength(road.pts) / 14) * 2 * treeKeep(road) : 0), 0);
  const treeScale = Math.min(1, (CAPS.trees - out.length) / Math.max(1, expected));
  for (const road of map.roads) {
    if (!STREET_TREE_ROADS.has(road.kind)) continue;
    const rr = streamFor(seed, `street-trees-${road.id}`);
    const keep = treeKeep(road) * treeScale;
    alongRoad(road, 12 + rr() * 4, rr, (p, dir, nrm) => {
      for (const side of [-1, 1]) {
        if (out.length >= CAPS.trees || rr() > keep) continue;
        const r = 2.1 + rr() * 1.2;
        const off = road.width / 2 + r * 0.8 + 0.9 + rr() * 0.6;
        const s = (rr() - 0.5) * 3;
        const q = { x: p.x + nrm.x * off * side + dir.x * s, z: p.z + nrm.z * off * side + dir.z * s };
        const rot = rr() * Math.PI * 2;
        if (treeOk(ix, q, r, occ)) push(q, r, 0, rot, 'street');
      }
    });
  }
  return out;
}

/** Calls `fn` every `step` metres along a road with the point, unit direction and unit left normal. */
function alongRoad(road: Road, step: number, rr: Rng, fn: (p: V2, dir: V2, nrm: V2) => void): void {
  let carry = rr() * step;
  for (let i = 1; i < road.pts.length; i++) {
    const a = road.pts[i - 1];
    const b = road.pts[i];
    const L = dist(a, b);
    if (L < 0.01) continue;
    const dir = { x: (b.x - a.x) / L, z: (b.z - a.z) / L };
    const nrm = { x: -dir.z, z: dir.x };
    let s = carry;
    for (; s < L; s += step) fn({ x: a.x + dir.x * s, z: a.z + dir.z * s }, dir, nrm);
    carry = s - L;
  }
}

// ---------------------------------------------------------------- house lots

/** A house's garden, in a frame facing its street: t runs along the street, n points at it. */
export interface Lot {
  b: Building;
  c: V2;
  /** Unit vector toward the street. */
  n: V2;
  /** Unit vector along the street. */
  t: V2;
  t0: number;
  t1: number;
  /** Back and front of the house itself. */
  n0: number;
  n1: number;
  /** The front boundary (just behind the footpath). */
  front: number;
  back: number;
  rng: Rng;
}

const lotPt = (l: Lot, t: number, n: number): V2 => ({ x: l.c.x + l.t.x * t + l.n.x * n, z: l.c.z + l.t.z * t + l.n.z * n });

export function houseLots(ix: MapIndex, streets: RoadIndex, seed: number): Lot[] {
  const lots: Lot[] = [];
  for (const b of ix.map.buildings) {
    if (b.pts.length < 3 || !isHouse(b)) continue;
    const c = centroid(b.pts);
    const near = streets.nearest(c, 45);
    if (!near || near.d < 1) continue;
    const n = { x: (near.q.x - c.x) / near.d, z: (near.q.z - c.z) / near.d };
    const t = { x: -n.z, z: n.x };
    let t0 = Infinity;
    let t1 = -Infinity;
    let n0 = Infinity;
    let n1 = -Infinity;
    for (const p of b.pts) {
      const dt = (p.x - c.x) * t.x + (p.z - c.z) * t.z;
      const dn = (p.x - c.x) * n.x + (p.z - c.z) * n.z;
      t0 = Math.min(t0, dt);
      t1 = Math.max(t1, dt);
      n0 = Math.min(n0, dn);
      n1 = Math.max(n1, dn);
    }
    const front = near.d - near.seg.hw - 1.8;
    if (front < n1 + 1) continue; // the house is on the footpath: no front garden to speak of
    const rng = streamFor(seed, `lot-${b.id}`);
    lots.push({ b, c, n, t, t0, t1, n0, n1, front, back: n0 - (8 + rng() * 6), rng });
  }
  return lots;
}

// ---------------------------------------------------------------- cars

const carCorners = (c: CarP): V2[] => corners({ cx: c.x, cz: c.z, ux: Math.cos(c.heading), uz: Math.sin(c.heading), hl: CAR.length / 2, hw: CAR.width / 2 });

function carClear(ix: MapIndex, c: CarP, skipRoad: number, minRoad: number, occ: Occupancy): boolean {
  if (!inMap(ix.map, c, 2) || occ.near(c, 4.6)) return false;
  for (const q of [...carCorners(c), { x: c.x, z: c.z }]) {
    if (ix.buildings.hit(q, 0.3) || ix.water.hit(q)) return false;
    if (ix.roads.clearance(q, 12, skipRoad) < minRoad) return false;
  }
  return true;
}

export function placeCars(ix: MapIndex, lots: Lot[], seed: number): { cars: CarP[]; bays: Line[]; carParks: V2[][] } {
  const map = ix.map;
  const cars: CarP[] = [];
  const occ = new Occupancy(6);
  const add = (c: CarP) => {
    cars.push(c);
    occ.add(c);
  };
  const full = () => cars.length >= CAPS.cars;
  // 1. Car parks: rows of bays, about half taken (fewer per lot on a map with very many lots).
  const bays: Line[] = [];
  const carParks: V2[][] = [];
  const BAY_W = 2.6;
  const BAY_D = 5;
  const slots: { p: V2; heading: number; fill: number; rr: Rng }[] = [];
  for (const f of map.features ?? []) {
    if (f.category !== 'parking' || !f.pts || f.pts.length < 3 || polygonArea(f.pts) < 120) continue;
    carParks.push(f.pts);
    const rr = streamFor(seed, `carpark-${f.id}`);
    const fr = bestFrame(f.pts);
    const fill = 0.35 + rr() * 0.4;
    let lotBays = 0;
    // Rows run along the long axis: bay (5 m), bay (5 m), aisle (6.5 m), repeating.
    for (let v = -fr.hw + 1; v + BAY_D <= fr.hw - 0.5 && lotBays < 400; v += 6.5) {
      for (const facing of [1, -1]) {
        if (v + BAY_D > fr.hw - 0.5) break;
        const vc = v + BAY_D / 2;
        for (let u = -fr.hl + 1 + BAY_W / 2; u + BAY_W / 2 <= fr.hl - 1 && lotBays < 400 && bays.length < CAPS.bays; u += BAY_W) {
          const bay: Frame = { ...centreAt(fr, u, vc), ux: fr.ux, uz: fr.uz, hl: BAY_W / 2, hw: BAY_D / 2 };
          const cs = corners(bay);
          if (!cs.every((q) => pointInPolygon(q, f.pts!)) || cs.some((q) => ix.buildings.hit(q, 0.2) || ix.roads.clearance(q, 10) < 0.2)) continue;
          lotBays++;
          // The two long sides of the bay as painted lines.
          bays.push({ a: at(fr, u - BAY_W / 2, v), b: at(fr, u - BAY_W / 2, v + BAY_D) });
          bays.push({ a: at(fr, u + BAY_W / 2, v), b: at(fr, u + BAY_W / 2, v + BAY_D) });
          // Nose into the bay.
          slots.push({ p: at(fr, u, vc + facing * 0.15), heading: Math.atan2(fr.ux * facing, -fr.uz * facing), fill, rr });
        }
        v += BAY_D;
      }
    }
  }
  const lotExpected = slots.reduce((s, b) => s + b.fill, 0);
  const lotScale = Math.min(1, (CAPS.cars * 0.4) / Math.max(1, lotExpected));
  for (const b of slots) {
    if (b.rr() > b.fill * lotScale || full()) continue;
    const c: CarP = { x: b.p.x + (b.rr() - 0.5) * 0.3, z: b.p.z, y: 0.7, heading: b.heading + (b.rr() - 0.5) * 0.08, warm: b.rr() < 0.14, tint: b.rr(), where: 'lot' };
    if (!occ.near(c, 2.4)) add(c);
  }
  // 2. Kerbside, on residential streets. Thinned on big maps so every street gets its share.
  const kerbDensity = (road: Road) => (road.kind === 'residential' || road.kind === 'living_street' ? 0.15 : 0.08);
  const kerbRoad = (road: Road) => KERB_ROADS.has(road.kind) && road.width >= 6;
  const kerbExpected = map.roads.reduce((s, road) => s + (kerbRoad(road) ? (polylineLength(road.pts) / 6.2) * 2 * kerbDensity(road) : 0), 0);
  const kerbScale = Math.min(1, ((CAPS.cars - cars.length) * 0.7) / Math.max(1, kerbExpected));
  map.roads.forEach((road, ri) => {
    if (!kerbRoad(road)) return;
    const rr = streamFor(seed, `kerb-${road.id}`);
    const density = kerbDensity(road) * kerbScale;
    alongRoad(road, 6.2, rr, (p, dir, nrm) => {
      for (const side of [-1, 1]) {
        if (full() || rr() > density) continue;
        const off = road.width / 2 - CAR.width / 2 - 0.25;
        const heading = Math.atan2(dir.z * -side, dir.x * -side) + (rr() - 0.5) * 0.06;
        const c: CarP = { x: p.x + nrm.x * off * side, z: p.z + nrm.z * off * side, y: 1.0, heading, warm: rr() < 0.12, tint: rr(), where: 'kerb' };
        // Clear of every other road (so not across a side street) and of driveways' cars.
        if (carClear(ix, c, ri, 0.6, occ)) add(c);
      }
    });
  });
  // 3. In driveways, beside the house, nose to the street.
  for (const l of lots) {
    if (full()) break;
    const rr = l.rng;
    if (rr() > 0.42) continue;
    const room = l.front - l.n1;
    if (room < CAR.length + 1.4) continue;
    const t = rr() < 0.5 ? l.t0 + 1.4 : l.t1 - 1.4;
    const n = l.n1 + 0.8 + CAR.length / 2 + rr() * Math.max(0, room - CAR.length - 1.4);
    const p = lotPt(l, t, n);
    const nose = rr() < 0.7 ? 1 : -1;
    const c: CarP = { x: p.x, z: p.z, y: 0, heading: Math.atan2(l.n.z * nose, l.n.x * nose), warm: rr() < 0.18, tint: rr(), where: 'driveway' };
    if (carClear(ix, c, -1, 0.5, occ) && !ix.green.hit(c) && !ix.open.hit(c)) add(c);
  }
  return { cars, bays, carParks };
}

const centreAt = (f: Frame, u: number, v: number): { cx: number; cz: number } => {
  const p = at(f, u, v);
  return { cx: p.x, cz: p.z };
};

// ---------------------------------------------------------------- pools

export function placePools(ix: MapIndex, lots: Lot[], seed: number): PoolP[] {
  const out: PoolP[] = [];
  const used = new Occupancy(10);
  // Public pools from the map (leisure=swimming_pool). Outdoor ones show; indoor ones sit under their roof.
  for (const f of ix.map.features ?? []) {
    if (f.category !== 'swimming_pool' || out.length >= CAPS.pools) continue;
    const rr = streamFor(seed, `pool-${f.id}`);
    let pts = f.pts && f.pts.length >= 3 ? f.pts : null;
    if (pts && polygonArea(pts) > 3000) {
      // A whole aquatic centre's grounds: put a 50 m pool in the middle of it.
      const fr = bestFrame(pts);
      pts = corners({ ...fr, hl: Math.min(fr.hl - 3, 25), hw: Math.min(fr.hw - 3, 11) });
    }
    if (!pts) pts = corners({ cx: f.p.x, cz: f.p.z, ux: 1, uz: 0, hl: 12.5, hw: 6 });
    out.push({ pts, lit: rr() < 0.6 });
    used.add(centroid(pts));
  }
  // Backyard pools, behind some houses (OpenStreetMap leaves most private pools out).
  for (const l of lots) {
    if (out.length >= CAPS.pools) break;
    const rr = streamFor(seed, `bpool-${l.b.id}`);
    if (rr() > 0.13) continue;
    const len = 7 + rr() * 3;
    const wid = 3.4 + rr() * 1.4;
    const n = l.n0 - 2.4 - wid / 2;
    if (n - wid / 2 < l.back + 1) continue;
    const span = Math.max(0, l.t1 - l.t0 - len);
    const t = l.t0 + len / 2 + rr() * span;
    const c = lotPt(l, t, n);
    const pts = corners({ cx: c.x, cz: c.z, ux: l.t.x, uz: l.t.z, hl: len / 2, hw: wid / 2 });
    const probe = [...pts, c];
    if (!inMap(ix.map, c, 3) || used.near(c, 8)) continue;
    if (probe.some((q) => ix.buildings.hit(q, 1) || ix.roads.clearance(q, 12) < 3 || ix.water.hit(q) || ix.green.hit(q) || ix.open.hit(q))) continue;
    out.push({ pts, lit: rr() < 0.2 });
    used.add(c);
  }
  return out;
}

// ---------------------------------------------------------------- field lines

/** Painted lines on pitches, ovals and tennis courts. */
export function fieldLines(ix: MapIndex): Line[] {
  const out: Line[] = [];
  const seg = (a: V2, b: V2) => out.length < CAPS.lines && out.push({ a, b });
  const poly = (pts: V2[]) => pts.forEach((p, i) => seg(p, pts[(i + 1) % pts.length]));
  const ellipse = (f: Frame, a: number, b: number, n = 40) => poly(Array.from({ length: n }, (_, i) => at(f, Math.cos((i / n) * Math.PI * 2) * a, Math.sin((i / n) * Math.PI * 2) * b)));
  const rect = (f: Frame, u0: number, v0: number, u1: number, v1: number) => poly([at(f, u0, v0), at(f, u1, v0), at(f, u1, v1), at(f, u0, v1)]);
  for (const f of ix.map.features ?? []) {
    if (!f.pts || f.pts.length < 3) continue;
    const fr = bestFrame(f.pts);
    if (fr.hl < 8 || fr.hw < 5) continue;
    if (f.category === 'tennis') {
      // Courts laid side by side across the grounds, clear of the clubhouse.
      const CL = 36;
      const CW = 18;
      for (let u = -fr.hl + 2; u + CW <= fr.hl - 2; u += CW) {
        for (let v = -fr.hw + 2; v + CL <= fr.hw - 2; v += CL) {
          const cu = u + CW / 2;
          const cv = v + CL / 2;
          const cs = [at(fr, u, v), at(fr, u + CW, v), at(fr, u + CW, v + CL), at(fr, u, v + CL)];
          if (!cs.every((q) => pointInPolygon(q, f.pts!)) || cs.some((q) => ix.buildings.hit(q, 0.5))) continue;
          rect(fr, cu - 5.49, cv - 11.89, cu + 5.49, cv + 11.89);
          rect(fr, cu - 4.11, cv - 11.89, cu + 4.11, cv + 11.89);
          seg(at(fr, cu - 4.11, cv - 6.4), at(fr, cu + 4.11, cv - 6.4));
          seg(at(fr, cu - 4.11, cv + 6.4), at(fr, cu + 4.11, cv + 6.4));
          seg(at(fr, cu, cv - 6.4), at(fr, cu, cv + 6.4));
          seg(at(fr, cu - 5.8, cv), at(fr, cu + 5.8, cv));
        }
      }
    } else if (f.category === 'pitch' || f.category === 'stadium') {
      const oval = /oval|cricket/i.test(f.name ?? '') || fr.fill < 0.88;
      if (oval) {
        const a = fr.hl - 3;
        const b = fr.hw - 3;
        ellipse(fr, a, b, 56);
        rect(fr, -10, -1.5, 10, 1.5); // the cricket pitch
        if (a > 45 && b > 35) rect(fr, -25, -25, 25, 25); // the centre square
        ellipse(fr, 5, 5, 16);
      } else {
        const a = fr.hl - 2;
        const b = fr.hw - 2;
        rect(fr, -a, -b, a, b);
        seg(at(fr, 0, -b), at(fr, 0, b));
        ellipse(fr, Math.min(9.15, b * 0.3), Math.min(9.15, b * 0.3), 24);
        const bw = Math.min(20, b * 0.6);
        const bd = Math.min(16.5, a * 0.3);
        rect(fr, -a, -bw, -a + bd, bw);
        rect(fr, a - bd, -bw, a, bw);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------- fences and hedges

export function placeFences(ix: MapIndex, lots: Lot[], cars: CarP[], pools: PoolP[]): FenceRun[] {
  const out: FenceRun[] = [];
  const occ = new Occupancy(4);
  const blockers = new Occupancy(8);
  for (const c of cars) if (c.where === 'driveway') blockers.add(c);
  for (const p of pools) blockers.add(centroid(p.pts));
  const STEP = 2;
  for (const l of lots) {
    if (out.length >= CAPS.fences) break;
    const rr = l.rng;
    const side = 1.8 + rr() * 1.6;
    const tL = l.t0 - side;
    const tR = l.t1 + side;
    const frontStyle = rr();
    const frontKind: FenceRun['kind'] | null = frontStyle < 0.35 ? 'hedge' : frontStyle < 0.6 ? 'fence' : null;
    const gapAt = rr() < 0.5 ? l.t0 + 1.4 : l.t1 - 1.4;
    const lines: [V2, V2, FenceRun['kind'], boolean][] = [
      [lotPt(l, tL, l.back), lotPt(l, tR, l.back), rr() < 0.15 ? 'hedge' : 'fence', false],
      [lotPt(l, tL, l.back), lotPt(l, tL, l.front), 'fence', false],
      [lotPt(l, tR, l.back), lotPt(l, tR, l.front), 'fence', false],
    ];
    if (frontKind) lines.push([lotPt(l, tL, l.front), lotPt(l, tR, l.front), frontKind, true]);
    const mine: V2[] = [];
    for (const [a, b, kind, front] of lines) {
      const L = dist(a, b);
      const n = Math.max(1, Math.round(L / STEP));
      let run: V2 | null = null;
      let last: V2 = a;
      for (let i = 0; i < n; i++) {
        const p0 = { x: a.x + ((b.x - a.x) * i) / n, z: a.z + ((b.z - a.z) * i) / n };
        const p1 = { x: a.x + ((b.x - a.x) * (i + 1)) / n, z: a.z + ((b.z - a.z) * (i + 1)) / n };
        const m = { x: (p0.x + p1.x) / 2, z: (p0.z + p1.z) / 2 };
        let ok = inMap(ix.map, m, 1) && !ix.buildings.hit(m, 0.5) && ix.roads.clearance(m, 10) > 0.8 && !ix.water.hit(m) && !ix.green.hit(m) && !ix.open.hit(m);
        ok = ok && !occ.near(m, 2.2) && !blockers.near(m, 3.2);
        if (ok && front) {
          const tm = (m.x - l.c.x) * l.t.x + (m.z - l.c.z) * l.t.z;
          ok = Math.abs(tm - gapAt) > 1.8;
        }
        if (ok) {
          mine.push(m);
          if (!run) run = p0;
          last = p1;
        } else if (run) {
          out.push({ a: run, b: last, kind });
          run = null;
        }
      }
      if (run) out.push({ a: run, b: last, kind });
    }
    for (const m of mine) occ.add(m);
  }
  return out.slice(0, CAPS.fences);
}

// ---------------------------------------------------------------- everything

export function placeDetail(map: MapData, seed: number): Detail {
  const ix = indexMap(map);
  const streets = new RoadIndex(map.roads.filter((r) => !FOOT.has(r.kind)));
  const lots = houseLots(ix, streets, seed);
  const trees = placeTrees(ix, seed);
  const { cars, bays, carParks } = placeCars(ix, lots, seed);
  const pools = placePools(ix, lots, seed);
  const fences = placeFences(ix, lots, cars, pools);
  return { trees, cars, pools, fieldLines: fieldLines(ix), carParks, bayLines: bays, fences };
}
