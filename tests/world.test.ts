import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeSampleTown } from '../src/map/sample';
import { centroid, pointInPolygon } from '../src/map/geom';
import type { Building, MapData } from '../src/map/types';
import { HEAT } from '../src/game/agentAnim';
import { buildWorld, SIG } from '../src/world/buildWorld';
import { planBuilding } from '../src/world/buildings';
import { CAR, CAPS, placeDetail, type CarP } from '../src/world/placement';
import { DETAIL_SIG } from '../src/world/detailMeshes';
import { edgeFade } from '../src/world/shading';
import { corners } from '../src/world/frame';
import { PolyIndex, RoadIndex } from '../src/world/spatial';
import { bigTown } from './worldFixture';

const sample = makeSampleTown();
const big = bigTown(8000);

const carCorners = (c: CarP) => corners({ cx: c.x, cz: c.z, ux: Math.cos(c.heading), uz: Math.sin(c.heading), hl: CAR.length / 2, hw: CAR.width / 2 });

/** Draw calls the world adds per frame: one per visible mesh per material. */
function drawCalls(group: THREE.Object3D): number {
  let n = 0;
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.isMesh && m.visible) n += Array.isArray(m.material) ? m.material.length : 1;
  });
  return n;
}

describe('map detail placement', () => {
  it('is deterministic: same map and seed, same street', () => {
    expect(placeDetail(sample, 7)).toEqual(placeDetail(sample, 7));
    const a = placeDetail(sample, 7);
    const b = placeDetail(sample, 8);
    expect(a.cars.map((c) => c.x)).not.toEqual(b.cars.map((c) => c.x));
  });

  it('builds the same geometry twice for the same seed', () => {
    const pos = (m: MapData) => {
      const w = buildWorld(m, 5);
      const g = (w.group.getObjectByName('buildings') as THREE.Mesh).geometry.attributes.position.array as Float32Array;
      const out = Array.from(g.slice(0, 3000));
      w.dispose();
      return out;
    };
    expect(pos(sample)).toEqual(pos(sample));
  });

  for (const [name, map] of [['sample town', sample], ['big town', big]] as const) {
    describe(name, () => {
      const d = placeDetail(map, 7);
      const blds = new PolyIndex(map.buildings.map((b) => b.pts));
      const roads = new RoadIndex(map.roads);

      it('puts trees outside buildings and off the road surface', () => {
        expect(d.trees.length).toBeGreaterThan(100);
        for (const t of d.trees) {
          expect(blds.hit(t)).toBe(false);
          expect(roads.clearance(t)).toBeGreaterThan(0);
        }
        // Street trees keep their canopies (mostly) off the road, so cold contacts on roads stay visible.
        for (const t of d.trees.filter((q) => q.src === 'street')) expect(roads.clearance(t)).toBeGreaterThanOrEqual(t.r * 0.75 - 1e-6);
      }, 30000);

      it('parks cars clear of buildings, and never in the middle of a road', () => {
        expect(d.cars.length).toBeGreaterThan(50);
        for (const c of d.cars) {
          for (const q of carCorners(c)) {
            expect(blds.hit(q)).toBe(false);
            if (c.where === 'kerb') {
              // On its own kerb: within a car's width (plus a little) of the road's edge.
              expect(roads.clearance(q)).toBeGreaterThan(-(CAR.width + 0.6));
            } else {
              expect(roads.clearance(q)).toBeGreaterThan(0);
            }
          }
        }
        // Cars don't overlap each other.
        let closest = Infinity;
        for (let i = 0; i < d.cars.length; i++) {
          for (let j = i + 1; j < d.cars.length; j++) closest = Math.min(closest, Math.hypot(d.cars[i].x - d.cars[j].x, d.cars[i].z - d.cars[j].z));
        }
        expect(closest).toBeGreaterThan(2.2);
        // Some warm engines, mostly cold.
        const warm = d.cars.filter((c) => c.warm).length / d.cars.length;
        expect(warm).toBeGreaterThan(0.04);
        expect(warm).toBeLessThan(0.3);
      }, 30000);

      it('keeps pools and fences out of buildings and off roads', () => {
        for (const p of d.pools) for (const q of p.pts) expect(blds.hit(q)).toBe(false);
        for (const f of d.fences) {
          const m = { x: (f.a.x + f.b.x) / 2, z: (f.a.z + f.b.z) / 2 };
          expect(blds.hit(m)).toBe(false);
          expect(roads.clearance(m)).toBeGreaterThan(0);
        }
      });

      it('stays within its caps', () => {
        expect(d.trees.length).toBeLessThanOrEqual(CAPS.trees);
        expect(d.cars.length).toBeLessThanOrEqual(CAPS.cars);
        expect(d.pools.length).toBeLessThanOrEqual(CAPS.pools);
        expect(d.fences.length).toBeLessThanOrEqual(CAPS.fences);
        expect(d.fieldLines.length).toBeLessThanOrEqual(CAPS.lines);
        expect(d.bayLines.length).toBeLessThanOrEqual(CAPS.bays);
      });
    });
  }

  it('spreads capped detail over the whole of a big map, not just its first streets', () => {
    expect(big.buildings.length).toBeGreaterThanOrEqual(6000);
    const d = placeDetail(big, 7);
    const quadrant = (p: { x: number; z: number }) => (p.x < 0 ? 0 : 1) + (p.z < 0 ? 0 : 2);
    for (const list of [d.trees.filter((t) => t.src === 'street'), d.cars.filter((c) => c.where === 'kerb')]) {
      const per = [0, 0, 0, 0];
      for (const p of list) per[quadrant(p)]++;
      expect(Math.min(...per)).toBeGreaterThan(list.length * 0.15);
    }
  });

  it('draws pools, pitch lines and car parks from the map features', () => {
    const d = placeDetail(big, 7);
    const feats = big.features!;
    const pool = feats.find((f) => f.category === 'swimming_pool')!;
    expect(d.pools.some((p) => pointInPolygon(centroid(p.pts), pool.pts!))).toBe(true);
    const pitch = feats.find((f) => f.category === 'pitch')!;
    expect(d.fieldLines.filter((l) => pointInPolygon(l.a, pitch.pts!)).length).toBeGreaterThan(10);
    const lot = feats.find((f) => f.category === 'parking')!;
    expect(d.carParks).toContainEqual(lot.pts);
    expect(d.cars.filter((c) => c.where === 'lot' && pointInPolygon(c, lot.pts!)).length).toBeGreaterThan(5);
    expect(d.bayLines.length).toBeGreaterThan(20);
    // No trees on pitches or in car parks.
    for (const t of d.trees) for (const f of feats) if (f.pts && ['pitch', 'parking'].includes(f.category)) expect(pointInPolygon(t, f.pts)).toBe(false);
    // The sample town's oval and tennis club get their lines too.
    const s = placeDetail(sample, 7);
    for (const name of ['Ironbark Oval', 'Orchard Tennis Club']) {
      const f = sample.features!.find((q) => q.name === name)!;
      expect(s.fieldLines.filter((l) => pointInPolygon(l.a, f.pts!)).length).toBeGreaterThan(8);
    }
  });
});

describe('map detail on the sensors', () => {
  it('keeps live zombies the hottest thing, and canopies between grass and roofs', () => {
    const heats = Object.values(DETAIL_SIG).map((s) => s[0]);
    expect(Math.max(...heats)).toBeLessThan(HEAT.warmLimb);
    expect(DETAIL_SIG.warmBonnet[0]).toBeGreaterThan(SIG.road[0]);
    expect(DETAIL_SIG.canopy[0]).toBeGreaterThan(SIG.park[0]);
    expect(DETAIL_SIG.canopy[0]).toBeLessThan(0.25); // coolest roof (buildings.ts)
    // Pools are cold, and painted lines carry no heat of their own.
    expect(DETAIL_SIG.poolWater[0]).toBeLessThan(SIG.park[0]);
    expect(Math.abs(DETAIL_SIG.fieldLine[0] - SIG.park[0])).toBeLessThan(0.01);
    expect(DETAIL_SIG.bayLine[0]).toBe(DETAIL_SIG.carPark[0]);
  });

  it('gives houses pitched roofs and shops flat ones', () => {
    const rect = (w: number, d: number) => [{ x: 0, z: 0 }, { x: w, z: 0 }, { x: w, z: d }, { x: 0, z: d }];
    const b = (kind: string, pts = rect(10, 12), height = 6): Building => ({ id: `t-${kind}`, kind, pts, height });
    expect(['gable', 'hip']).toContain(planBuilding(b('house'), 1).roof);
    expect(planBuilding(b('house'), 1).eave).toBeGreaterThanOrEqual(2.7);
    expect(planBuilding(b('retail', rect(40, 30), 9), 1).roof).toBe('flat');
    const L = [{ x: 0, z: 0 }, { x: 12, z: 0 }, { x: 12, z: 5 }, { x: 5, z: 5 }, { x: 5, z: 12 }, { x: 0, z: 12 }];
    expect(planBuilding(b('house', L), 1).roof).toBe('flat');
    expect(planBuilding(b('garage', rect(6, 6), 3), 1).style).toBe(0);
  });

  it('fades to neutral at the map edge, not inside where the action is', () => {
    expect(edgeFade(0, 0, 550)).toBe(0);
    // Missions place everything within 90% of the half-width: untouched there.
    expect(edgeFade(550 * 0.9, 0, 550)).toBe(0);
    // Agents can wander to 95%: at most lightly faded.
    expect(edgeFade(550 * 0.95, 0, 550)).toBeLessThan(0.25);
    // At the edge itself the data has mostly faded out, and it's gone soon after.
    expect(edgeFade(550, 0, 550)).toBeGreaterThan(0.7);
    expect(edgeFade(550 + 30, 0, 550)).toBe(1);
    expect(edgeFade(600, 600, 550)).toBe(1);
  });
});

describe('world budget', () => {
  it('stays within the draw-call budget with everything on, builds fast, and disposes everything', () => {
    const t0 = performance.now();
    const w = buildWorld(big, 7);
    const ms = performance.now() - t0;
    console.log(`buildWorld: ${big.buildings.length} buildings in ${ms.toFixed(0)} ms, ${drawCalls(w.group)} draw calls`);
    expect(drawCalls(w.group)).toBeLessThanOrEqual(40);
    // The budget is 2 s on a desktop; leave room for a loaded test machine.
    expect(ms).toBeLessThan(6000);
    const disposed = new Set<unknown>();
    const owned = new Set<THREE.EventDispatcher<{ dispose: object }>>();
    w.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      owned.add(m.geometry);
      for (const mat of Array.isArray(m.material) ? m.material : [m.material]) owned.add(mat);
    });
    for (const o of owned) o.addEventListener('dispose', () => disposed.add(o));
    w.dispose();
    expect(disposed.size).toBe(owned.size);
  }, 30000);

  it('uses no unseeded randomness', () => {
    for (const f of readdirSync('src/world')) expect(readFileSync(`src/world/${f}`, 'utf8')).not.toMatch(/Math\.random/);
  });
});
