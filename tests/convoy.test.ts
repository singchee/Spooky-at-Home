import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph, type RoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { parseOverpass } from '../src/map/overpass';
import { presetToMap } from '../src/map/presets';
import { distToSegment, pointAlong, polylineLength } from '../src/map/geom';
import { childZones, mapFeatures, routeNearChildPlace } from '../src/map/recon';
import { CHILD_FIRE_CLEARANCE, HORDE_EDGE, MISSION_TYPES, generateMission } from '../src/sim/missions';
import { MAX_KILL_REACH, weaponById } from '../src/sim/weapons';
import {
  CONNECTOR_KINDS, CONVOY_CHILD_GAP, CONVOY_CORRIDOR, CONVOY_EDGE, CONVOY_MAIN_SHARE, CONVOY_MIN_LENGTH, CONVOY_MIN_TURN, CONVOY_NO_MAIN_ROADS,
  CONVOY_NO_SAFE_ROAD, CONVOY_TRUCKS, CONVOY_ZOMBIE_GAP, MAIN_ROAD_KINDS, convoyRng, corridorIndex, findConvoyRoute, hasMainRoads, routeDoublesBack,
  type ConvoyRoute,
} from '../src/sim/convoy';
import { hashString } from '../src/util/rng';
import type { MapData, V2 } from '../src/map/types';
import { schoolHeavyTown, schoolHeavyTownMainRoads } from './worldFixture';

// Spec 004 (Convoy), commit 1: the headless route finder. Technical design §9, tests 1-4.

const maps = new Map<string, { map: MapData; graph: RoadGraph }>();
function town(name: string): { map: MapData; graph: RoadGraph } {
  let t = maps.get(name);
  if (!t) {
    let map: MapData;
    if (name === 'sample') map = makeSampleTown();
    else if (name === 'school') map = schoolHeavyTown();
    else if (name === 'school-main') map = schoolHeavyTownMainRoads();
    else if (name === 'new-york-midtown' || name === 'paris-eiffel') map = presetToMap(JSON.parse(readFileSync(new URL(`../public/maps/presets/${name}.json`, import.meta.url), 'utf8')));
    else {
      const raw = JSON.parse(readFileSync(new URL(`../maps/fixtures/${name}.json`, import.meta.url), 'utf8'));
      map = parseOverpass({ elements: raw.elements }, raw.spooky_fixture.origin, raw.spooky_fixture.half, name);
    }
    t = { map, graph: buildRoadGraph(map) };
    maps.set(name, t);
  }
  return t;
}

function route(name: string, seed: number, d: number): ConvoyRoute {
  const { map, graph } = town(name);
  const r = findConvoyRoute(map, graph, d, convoyRng(map, seed, d));
  if (!r.ok) throw new Error(`${name} seed ${seed} d${d}: ${r.reason}`);
  return r.plan;
}

/** Bearing from the map centre, degrees, 0 = north. */
const bearing = (p: V2) => ((Math.atan2(p.x, -p.z) * 180) / Math.PI + 360) % 360;
const apart = (a: number, b: number) => {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
};
/** Kinds of the roads a point lies on (within 0.5 m of their line). */
const kindsAt = (map: MapData, p: V2) => map.roads.filter((r) => r.pts.some((q, i) => i > 0 && distToSegment(p, r.pts[i - 1], q) < 0.5)).map((r) => r.kind);
/** Points every `step` metres along a polyline, both ends included. */
const samples = (pts: V2[], step = 2) => {
  const L = polylineLength(pts);
  return [...Array.from({ length: Math.floor(L / step) + 1 }, (_, i) => pointAlong(pts, i * step)), pts[pts.length - 1]];
};
/** Names a label must never be: child places' own names, or anything that reads as one. */
const CHILDISH = /\b(school|kinder|kindergarten|pre-?school|nursery|child ?care|day ?care|cr[eè]che|playground|college|[eé]cole)\b/i;

const ROUTED = ['sample', 'adelaide-cbd', 'gundagai', 'new-york-midtown', 'paris-eiffel', 'school-main'];

describe('convoy constants', () => {
  it('keeps the child-place gaps the spec settled, built from the guns and the fire clearance (never shrunk)', () => {
    expect(CONVOY_ZOMBIE_GAP).toBeCloseTo(MAX_KILL_REACH + CHILD_FIRE_CLEARANCE + 3 * weaponById('105').spread + (3 * Math.SQRT2) / 2, 9);
    expect(CONVOY_CHILD_GAP).toBeCloseTo(CONVOY_ZOMBIE_GAP + CONVOY_CORRIDOR, 9);
    expect(CONVOY_ZOMBIE_GAP).toBeGreaterThanOrEqual(65);
    expect(CONVOY_CHILD_GAP).toBeGreaterThanOrEqual(74);
    expect(CONVOY_EDGE).toBe(HORDE_EDGE);
    expect(CONVOY_MIN_LENGTH).toBe(850);
    expect(MAIN_ROAD_KINDS).toEqual(['trunk', 'primary', 'secondary', 'tertiary']);
    expect(CONNECTOR_KINDS).not.toContain('motorway');
  });
});

describe('test 1: determinism', () => {
  it('same map, seed and difficulty give the identical plan (sample town, New York, Adelaide; d1-5; seeds 1-3)', () => {
    for (const name of ['sample', 'new-york-midtown', 'adelaide-cbd']) {
      const { map } = town(name);
      const fresh = buildRoadGraph(map); // a second graph, so no cache is shared between the two runs
      for (let d = 1; d <= 5; d++) {
        for (let seed = 1; seed <= 3; seed++) {
          const a = route(name, seed, d);
          const b = findConvoyRoute(map, fresh, d, convoyRng(map, seed, d));
          expect(b.ok && b.plan, `${name} d${d} seed ${seed}`).toEqual(a);
          expect(a.trucks).toBe(CONVOY_TRUCKS[d - 1]);
        }
      }
    }
  });
  it('different seeds can give different routes where the map has a choice', () => {
    const plans = new Set<string>();
    for (let seed = 1; seed <= 10; seed++) plans.add(JSON.stringify(route('new-york-midtown', seed, 3).route));
    expect(plans.size).toBeGreaterThan(1);
  });
});

describe('test 2: route rules', () => {
  it('main roads, edge to edge 90° apart, long enough, clear of child places, no doubling back, no motorway, honest labels', () => {
    for (const name of ROUTED) {
      const { map } = town(name);
      const lim = map.half * CONVOY_EDGE;
      for (const d of [1, 3, 5]) {
        for (let seed = 1; seed <= 3; seed++) {
          const p = route(name, seed, d);
          const why = `${name} d${d} seed ${seed}`;
          const r = p.route;
          // Length, and the whole route inside the box.
          expect(p.length, why).toBeCloseTo(polylineLength(r), 6);
          expect(p.length, why).toBeGreaterThanOrEqual(CONVOY_MIN_LENGTH);
          for (const q of r) expect(Math.max(Math.abs(q.x), Math.abs(q.z)), why).toBeLessThanOrEqual(lim + 1e-6);
          // Entry and exit on the box edge (±1 m), at least 90° apart from the centre.
          expect(r[0]).toEqual(p.entry.p);
          expect(r[r.length - 1]).toEqual(p.exit.p);
          for (const e of [p.entry.p, p.exit.p]) expect(Math.abs(Math.max(Math.abs(e.x), Math.abs(e.z)) - lim), why).toBeLessThanOrEqual(1);
          expect(apart(bearing(p.entry.p), bearing(p.exit.p)), why).toBeGreaterThanOrEqual(CONVOY_MIN_TURN);
          // Every leg on a drivable road, never a motorway; at least 80 % of the length on main roads.
          let main = 0;
          for (let i = 1; i < r.length; i++) {
            const kinds = kindsAt(map, { x: (r[i - 1].x + r[i].x) / 2, z: (r[i - 1].z + r[i].z) / 2 });
            expect(kinds.some((k) => MAIN_ROAD_KINDS.includes(k) || CONNECTOR_KINDS.includes(k)), `${why} leg ${i}: ${kinds}`).toBe(true);
            expect(kinds.every((k) => k !== 'motorway' && k !== 'motorway_link'), `${why} leg ${i}`).toBe(true);
            if (kinds.some((k) => MAIN_ROAD_KINDS.includes(k))) main += Math.hypot(r[i].x - r[i - 1].x, r[i].z - r[i - 1].z);
          }
          expect(main / p.length, why).toBeGreaterThanOrEqual(CONVOY_MAIN_SHARE);
          // The guardrail: the whole route keeps the convoy's child gap.
          expect(routeNearChildPlace(map, r, CONVOY_CHILD_GAP), why).toBe(false);
          expect(routeDoublesBack(r, map.half), why).toBe(false);
          // Checkpoints at 25, 50, 75 %, on the route, with labels that are never a child place.
          const childNames = new Set([...mapFeatures(map).map((f) => f.name), ...map.pois.map((q) => q.name)].filter((n): n is string => !!n && CHILDISH.test(n)));
          expect(p.checkpoints.map((c) => c.s / p.length)).toEqual([0.25, 0.5, 0.75].map((f) => expect.closeTo(f, 9)));
          for (const c of p.checkpoints) {
            expect(c.p).toEqual(pointAlong(r, c.s));
            expect(c.label.trim().length, why).toBeGreaterThan(0);
            expect(CHILDISH.test(c.label) || childNames.has(c.label), `${why}: "${c.label}"`).toBe(false);
          }
          for (const e of [p.entry, p.exit]) {
            expect(e.street.length).toBeGreaterThan(0);
            expect(['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']).toContain(e.side);
          }
        }
      }
    }
  });

  it('school-heavy town with main roads: the stretch 60 m from a school is never used, the one 80 m away may be', () => {
    const { map } = town('school-main');
    const west = { x: -340, z: 0 }; // Gridville West School, 60 m from Street 2 (x = -400)
    let usedEast = 0;
    for (let d = 1; d <= 5; d++) {
      for (let seed = 1; seed <= 20; seed++) {
        const p = route('school-main', seed, d);
        for (const q of samples(p.route)) {
          expect(Math.hypot(q.x - west.x, q.z - west.z), `d${d} seed ${seed}`).toBeGreaterThanOrEqual(CONVOY_CHILD_GAP);
          expect(Math.abs(q.x + 400) < 1 && Math.abs(q.z) < 100, `d${d} seed ${seed} on Street 2 beside the school`).toBe(false);
          if (Math.abs(q.x - 400) < 1 && Math.abs(q.z - 100) < 5) usedEast++;
        }
      }
    }
    // Gridville East School is 80 m from Street 10: outside the gap, so routes may pass it.
    expect(usedEast).toBeGreaterThan(0);
    // Control: the same town without the West school does send routes down Street 2 past that spot, so it's the
    // school (and the gap) that keeps them off, not the rest of the route rules.
    const control: MapData = { ...map, name: 'Gridville control', features: map.features!.filter((f) => f.id !== 'f-s60') };
    const cg = buildRoadGraph(control);
    let usedWest = 0;
    for (let d = 1; d <= 5; d++) {
      for (let seed = 1; seed <= 20; seed++) {
        const r = findConvoyRoute(control, cg, d, convoyRng(control, seed, d));
        if (r.ok && samples(r.plan.route).some((q) => Math.abs(q.x + 400) < 1 && Math.abs(q.z) < 100)) usedWest++;
      }
    }
    expect(usedWest).toBeGreaterThan(0);
    // The fixture really has both schools where it says.
    const zones = childZones(map);
    expect(zones.some((z) => z.p.x === -340 && z.p.z === 0)).toBe(true);
    expect(zones.some((z) => z.p.x === 320 && z.p.z === 100)).toBe(true);
  });

  it('routeDoublesBack flags a route that comes back along itself, and lets a roundabout or a corner through', () => {
    const outAndBack: V2[] = [{ x: -400, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 12 }, { x: -400, z: 12 }];
    expect(routeDoublesBack(outAndBack, 550)).toBe(true);
    const corner: V2[] = [{ x: -400, z: 0 }, { x: 0, z: 0 }, { x: 0, z: 400 }];
    expect(routeDoublesBack(corner, 550)).toBe(false);
    // Three quarters of the way round a 9 m roundabout, in and out on straight roads.
    const ring = Array.from({ length: 28 }, (_, i) => {
      const a = Math.PI + (i / 27) * 1.5 * Math.PI;
      return { x: 9 * Math.cos(a), z: 9 * Math.sin(a) };
    });
    expect(routeDoublesBack([{ x: -400, z: 0 }, ...ring, { x: 0, z: 400 }], 550)).toBe(false);
  });
});

describe('test 3: not offered', () => {
  it('school-heavy town (no main roads): no route, and it says so', () => {
    const { map, graph } = town('school');
    expect(hasMainRoads(map)).toBe(false);
    for (const d of [1, 3, 5]) expect(findConvoyRoute(map, graph, d, convoyRng(map, 1, d))).toEqual({ ok: false, reason: CONVOY_NO_MAIN_ROADS });
  });
  it('West Hobart: every main-road route passes within the gap of a school, so no convoy (the gap is never shrunk)', () => {
    const { map, graph } = town('west-hobart');
    expect(hasMainRoads(map)).toBe(true);
    for (const d of [1, 3, 5]) {
      for (let seed = 1; seed <= 3; seed++) expect(findConvoyRoute(map, graph, d, convoyRng(map, seed, d))).toEqual({ ok: false, reason: CONVOY_NO_SAFE_ROAD });
    }
  });
  it('maps with main roads offer one', () => {
    for (const name of ROUTED) expect(hasMainRoads(town(name).map), name).toBe(true);
  });
  // rankMissions leaving the convoy out where hasMainRoads is false needs the template in src/map/recon.ts (commit 2).
  it.todo('rankMissions leaves the convoy out where hasMainRoads is false (commit 2, with the template)');
});

describe('test 4: nothing else moves', () => {
  it('MISSION_TYPES is unchanged', () => {
    expect(MISSION_TYPES).toEqual(['clear', 'escort', 'defend']);
  });
  it('"auto" missions on the sample town, seeds 1-20 x d1-5, match the snapshot taken before any generator change', () => {
    // Captured at 0e9f57e (feat/phase-3), before any convoy code. Never update this to make a change pass.
    const map = makeSampleTown();
    const graph = buildRoadGraph(map);
    const grid = new WalkGrid(map);
    const parts: string[] = [];
    for (let seed = 1; seed <= 20; seed++) for (let d = 1; d <= 5; d++) parts.push(JSON.stringify(generateMission(map, graph, grid, { type: 'auto', difficulty: d, seed })));
    expect(hashString(parts.join('\n'))).toBe(108157701);
  });
});

describe('corridorIndex', () => {
  it('gives the route distance for cells within the corridor, and -1 outside it', () => {
    const map = makeSampleTown();
    const grid = new WalkGrid(map);
    const r: V2[] = [{ x: -300, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }];
    const idx = corridorIndex(grid, r);
    expect(idx.length).toBe(grid.n * grid.n);
    const at = (x: number, z: number) => idx[grid.idx(x, z)];
    expect(at(-200, 0)).toBeCloseTo(100, -0.5);
    expect(at(-200, 5)).toBeCloseTo(100, -0.5);
    expect(at(-200, 15)).toBe(-1);
    expect(at(300, 100)).toBeCloseTo(700, -0.5);
    expect(at(0, 200)).toBe(-1);
    // Cells claimed by two legs at the corner take the nearer one.
    expect(at(299.5, 1.5)).toBeGreaterThan(595);
    expect(at(299.5, 1.5)).toBeLessThan(605);
  });
});
