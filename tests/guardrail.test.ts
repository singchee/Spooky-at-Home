import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph, dijkstra, nearestNode, pathFromPrev, type RoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { distToSegment, pointInPolygon } from '../src/map/geom';
import { CHILD_FIRE_CLEARANCE, HORDE_SPREAD, HORDE_WANDER, SCATTER_LEASH, generateMission } from '../src/sim/missions';
import { nearChildPlace, childZones, TEMPLATE_IDS } from '../src/map/recon';
import { parseOverpass, featureCategory, type OverpassJson } from '../src/map/overpass';
import { KILL_REACH, WEAPONS } from '../src/sim/weapons';
import { Sim, WAVE_SPREAD, noWaveSpawn } from '../src/sim/sim';
import type { MapData, V2 } from '../src/map/types';
import { schoolHeavyTown } from './worldFixture';

/**
 * Guardrail (PLAN §9, issue #11, pending the owner's decision): no part of a mission is placed in or near
 * the grounds of a school, kindergarten, childcare centre or playground. Holes found in code review round 2.
 */
describe('guardrail holes from code review round 2', () => {
  it('A: escort never ends at a shed or portable classroom inside school grounds', () => {
    const base = makeSampleTown();
    const school = base.buildings.find((b) => b.kind === 'school')!;
    // Four 12x12 m huts inside the school block, tagged as ordinary buildings, as real school grounds often are.
    const c = school.pts.reduce((a, p) => ({ x: a.x + p.x / school.pts.length, z: a.z + p.z / school.pts.length }), { x: 0, z: 0 });
    const huts = [[-30, 25], [30, 25], [-30, -25], [30, -25]].map(([dx, dz], i) => ({
      id: `hut${i}`, kind: 'yes', height: 4,
      pts: [{ x: c.x + dx - 6, z: c.z + dz - 6 }, { x: c.x + dx + 6, z: c.z + dz - 6 }, { x: c.x + dx + 6, z: c.z + dz + 6 }, { x: c.x + dx - 6, z: c.z + dz + 6 }],
    }));
    const map: MapData = { ...base, name: 'huts', buildings: [...base.buildings, ...huts] };
    const graph = buildRoadGraph(map);
    const grid = new WalkGrid(map);
    let checked = 0;
    for (let seed = 1; seed <= 100; seed++) {
      for (const d of [1, 3, 5]) {
        const r = generateMission(map, graph, grid, { type: 'escort', difficulty: d, seed });
        if (!r.ok) continue;
        checked++;
        expect(nearChildPlace(map, r.mission.home!.centre), `escort d${d} seed ${seed} home`).toBe(false);
        for (const s of r.mission.survivors) expect(nearChildPlace(map, s.start, 30), `escort d${d} seed ${seed} start`).toBe(false);
      }
    }
    expect(checked).toBeGreaterThan(250);
  }, 120_000);

  it('B: a campus mapped as a multipolygon relation is protected across its whole grounds, not just its middle', () => {
    // A 250 x 250 m campus (open ocean test coordinates); the relation's outer ring is two ways.
    const lat0 = -10, lon0 = 100, d = 0.00113; // ~125 m
    const ring = [
      { lat: lat0 - d, lon: lon0 - d }, { lat: lat0 - d, lon: lon0 + d }, { lat: lat0 + d, lon: lon0 + d },
      { lat: lat0 + d, lon: lon0 - d }, { lat: lat0 - d, lon: lon0 - d },
    ];
    const json: OverpassJson = {
      elements: [
        {
          type: 'relation', id: 5, tags: { type: 'multipolygon', amenity: 'school', name: 'Test College' },
          members: [
            { type: 'way', ref: 1, role: 'outer', geometry: ring.slice(0, 3) },
            { type: 'way', ref: 2, role: 'outer', geometry: ring.slice(2) },
          ],
        },
        { type: 'way', id: 9, tags: { highway: 'residential' }, geometry: [{ lat: lat0 - 0.004, lon: lon0 }, { lat: lat0 + 0.004, lon: lon0 }] },
      ],
    };
    const map = parseOverpass(json, { lat: lat0, lon: lon0 }, 600, 'campus');
    const f = map.features!.find((x) => x.id === 'r5')!;
    expect(f.category).toBe('school');
    expect(f.pts && f.pts.length >= 4).toBe(true);
    // A playing field 100 m from the centre, inside the campus, is protected (it would not be with a centre circle).
    expect(nearChildPlace(map, { x: 100, z: 100 })).toBe(true);
    expect(childZones(map).some((z) => z.pts)).toBe(true);
    // Well outside the campus is not.
    expect(nearChildPlace(map, { x: 260, z: 260 })).toBe(false);
  });

  it('C: childcare centres count as protected places', () => {
    expect(featureCategory({ amenity: 'childcare' })).toBe('kindergarten');
    const json: OverpassJson = { elements: [{ type: 'node', id: 3, lat: -10, lon: 100, tags: { amenity: 'childcare', name: 'Little Ones' } }] };
    const map = parseOverpass(json, { lat: -10, lon: 100 }, 600, 'cc');
    expect(nearChildPlace(map, { x: 20, z: 0 })).toBe(true);
  });
});

/**
 * Item 3.8 (owner decision, 22 Nov: schools are left out of the game). Three gaps the code reviewer found:
 * escort routes and defend stragglers walked past school grounds, and a 105 round on a horde's edge
 * could land within ~10 m of them.
 */
describe('item 3.8: school guardrail gaps', () => {
  const BUFFER = 50; // metres every survivor's start and walk keeps from a child place
  // The farthest any shell kills from its impact (Sim.updateShells: lethal radius, half the time out to KILL_REACH x).
  const reach105 = WEAPONS.find((w) => w.id === '105')!.radius * KILL_REACH;

  it('escort: the way home routes around a school its shortest road passes, or picks another home', () => {
    const town = schoolHeavyTown();
    const g = buildRoadGraph(town);
    const w = new WalkGrid(town);
    const zones = childPlaces(town);
    let built = 0;
    let rerouted = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const d of [1, 3, 5]) {
        const r = generateMission(town, g, w, { type: 'escort', difficulty: d, seed });
        if (!r.ok) continue;
        built++;
        const m = r.mission;
        const at = `escort d${d} s${seed}`;
        expect(routeClearance(zones, m.route!), `${at} route`).toBeGreaterThanOrEqual(BUFFER);
        for (const s of m.survivors) expect(nearestChildPlace(zones, s.start), `${at} start`).toBeGreaterThanOrEqual(BUFFER);
        // Does the plain shortest road to this home pass a school? Then the mission really did route around it.
        if (routeClearance(zones, shortestRoad(g, m.route![0], m.home!.centre)) < BUFFER) rerouted++;
      }
    }
    expect(built).toBeGreaterThan(60);
    expect(rerouted, 'the test town must make some shortest roads pass a school').toBeGreaterThan(0);
  }, 120_000);

  it('escort: when every way home passes a school there is no mission, and the reason says so', () => {
    const town = schoolHeavyTown({ playgroundBesideSafehouse: true });
    const g = buildRoadGraph(town);
    const w = new WalkGrid(town);
    for (const seed of [1, 2, 3]) {
      const r = generateMission(town, g, w, { type: 'escort', difficulty: 3, seed });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/passes a school, kindergarten or playground/);
    }
    // Defend still works there: everyone is already inside, so nobody walks past the playground.
    const def = generateMission(town, g, w, { type: 'defend', difficulty: 3, seed: 1 });
    expect(def.ok && def.mission.survivors.length).toBe(0);
  }, 60_000);

  it('defend: stragglers never start beside a school, nor walk in past one', () => {
    // A school's grounds sit 21 m from the junction at (100, -100), one of the eight 200 m by road from the safehouse.
    const town = schoolHeavyTown();
    const g = buildRoadGraph(town);
    const w = new WalkGrid(town);
    const zones = childPlaces(town);
    expect(nearestChildPlace(zones, { x: 100, z: -100 })).toBeLessThan(BUFFER);
    let built = 0;
    let withStragglers = 0;
    for (let seed = 1; seed <= 40; seed++) {
      for (const d of [1, 3, 5]) {
        const r = generateMission(town, g, w, { type: 'defend', difficulty: d, seed });
        if (!r.ok) continue;
        built++;
        const m = r.mission;
        if (m.survivors.length) withStragglers++;
        for (const s of m.survivors) {
          const at = `defend d${d} s${seed}`;
          expect(nearestChildPlace(zones, s.start), `${at} straggler start`).toBeGreaterThanOrEqual(BUFFER);
          expect(routeClearance(zones, s.route!), `${at} straggler route`).toBeGreaterThanOrEqual(BUFFER);
        }
      }
    }
    expect(built).toBeGreaterThan(60);
    expect(withStragglers, 'stragglers still come in from the clear side of town').toBe(built);
  }, 120_000);

  it('hordes: worst-case wander or scatter plus a 105 round stays 30 m clear of child places, every template, difficulty and seed', () => {
    // From the sim's own numbers: zombies start within HORDE_SPREAD, mill within HORDE_WANDER and, scattered by a
    // 105 in Clear (spec 002), run at most SCATTER_LEASH from their horde's path; a 105 round can kill reach105 from where it lands.
    const gap = Math.max(HORDE_SPREAD, HORDE_WANDER, SCATTER_LEASH) + reach105 + CHILD_FIRE_CLEARANCE;
    expect(gap).toBeGreaterThanOrEqual(99);
    for (const town of [makeSampleTown(), schoolHeavyTown()]) {
      const g = buildRoadGraph(town);
      const w = new WalkGrid(town);
      const zones = childPlaces(town);
      let hordes = 0;
      for (const id of TEMPLATE_IDS) {
        for (let d = 1; d <= 5; d++) {
          for (let seed = 1; seed <= 6; seed++) {
            const r = generateMission(town, g, w, { type: 'auto', difficulty: d, seed, template: id });
            if (!r.ok || !r.mission.hordes.length) continue;
            const m = r.mission;
            const at = `${town.name} ${id} d${d} s${seed}`;
            for (const h of m.hordes) {
              hordes++;
              expect(nearestChildPlace(zones, h.centre), `${at} horde at ${h.label}`).toBeGreaterThanOrEqual(gap);
            }
            // The horde nearest the sheltering friendlies drifts to them (Sim): their spot, and its whole way there, keep the gap too.
            const shelter = m.survivors.find((s) => !s.route);
            if (shelter) {
              const drifter = m.hordes.reduce((a, h) => (dist(h.centre, shelter.start) < dist(a.centre, shelter.start) ? h : a), m.hordes[0]);
              expect(nearestChildPlace(zones, shelter.start), `${at} shelter`).toBeGreaterThanOrEqual(gap);
              expect(routeClearance(zones, [drifter.centre, shelter.start]), `${at} drift to shelter`).toBeGreaterThanOrEqual(gap);
            }
          }
        }
      }
      expect(hordes, town.name).toBeGreaterThan(100);
    }
  }, 240_000);

  it('waves: a wave never spawns where a 105 round on it would land within 30 m of a child place', () => {
    // A wave's zombies appear within WAVE_SPREAD of its spawn point. The school-heavy town has a kindergarten
    // 64 m from a junction 280 m from the safehouse: allowed by the old 60 m gap, too close by this rule.
    const gap = WAVE_SPREAD + reach105 + CHILD_FIRE_CLEARANCE;
    for (const town of [makeSampleTown(), schoolHeavyTown()]) {
      const g = buildRoadGraph(town);
      const zones = childPlaces(town);
      const banned = noWaveSpawn(town, g);
      let allowed = 0;
      g.nodes.forEach((n, i) => {
        if (banned[i]) return;
        allowed++;
        expect(nearestChildPlace(zones, n), `${town.name} spawn point ${n.x}, ${n.z}`).toBeGreaterThanOrEqual(gap);
      });
      expect(allowed, town.name).toBeGreaterThan(g.nodes.length / 2);
    }
  });

  it('in play: no zombie, horde or fresh wave, ever stands where a 105 round would land within 30 m of a child place', () => {
    // End to end: run the real sim with nobody firing and watch every zombie. Horde zombies are watched all the
    // time; wave zombies walk on toward the survivors, so they are checked where they appear.
    const town = schoolHeavyTown();
    const g = buildRoadGraph(town);
    const w = new WalkGrid(town);
    const zones = childPlaces(town);
    const floor = reach105 + CHILD_FIRE_CLEARANCE - 2; // 2 m: the walk grid's half-cell nudges
    let watched = 0;
    for (const type of ['clear', 'escort', 'defend'] as const) {
      for (const d of [1, 3, 5]) {
        for (let seed = 1; seed <= 3; seed++) {
          const r = generateMission(town, g, w, { type, difficulty: d, seed });
          if (!r.ok) continue;
          const sim = new Sim(r.mission, town, g, w);
          const seen = new Set<number>();
          let worst = Infinity;
          const check = () => {
            for (const z of sim.zombies) {
              if (!z.alive || (seen.has(z.id) && !z.home)) continue;
              seen.add(z.id);
              worst = Math.min(worst, nearestChildPlace(zones, z));
              watched++;
            }
          };
          check();
          while (sim.phase === 'running' && sim.t < 90) {
            sim.step(1 / 10);
            check();
          }
          expect(worst, `${type} d${d} s${seed}`).toBeGreaterThanOrEqual(floor);
        }
      }
    }
    expect(watched).toBeGreaterThan(1000);
  }, 240_000);
});

const dist = (a: V2, b: V2) => Math.hypot(a.x - b.x, a.z - b.z);
/** Schools, kindergartens, childcare and playgrounds, worked out here independently of the code under test. */
function childPlaces(town: MapData): { p: V2; pts?: V2[] }[] {
  const out: { p: V2; pts?: V2[] }[] = [];
  for (const f of town.features ?? []) if (['school', 'kindergarten', 'playground'].includes(f.category)) out.push({ p: f.p, pts: f.pts });
  for (const p of town.pois) if (['school', 'kindergarten', 'childcare', 'playground'].includes(p.kind)) out.push({ p: p.p });
  for (const b of town.buildings) if (['school', 'kindergarten', 'childcare', 'college'].includes(b.kind)) out.push({ p: b.pts[0], pts: b.pts });
  return out;
}

/** Metres from a point to the nearest child place (0 inside one). */
function nearestChildPlace(zones: { p: V2; pts?: V2[] }[], p: V2): number {
  let best = Infinity;
  for (const z of zones) {
    best = Math.min(best, Math.hypot(p.x - z.p.x, p.z - z.p.z));
    if (!z.pts) continue;
    if (pointInPolygon(p, z.pts)) return 0;
    for (let i = 0, j = z.pts.length - 1; i < z.pts.length; j = i++) best = Math.min(best, distToSegment(p, z.pts[j], z.pts[i]));
  }
  return best;
}

/** The closest any point along a polyline comes to a child place, sampled every half metre. */
function routeClearance(zones: { p: V2; pts?: V2[] }[], route: V2[]): number {
  let best = route.length ? nearestChildPlace(zones, route[0]) : Infinity;
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1];
    const b = route[i];
    const n = Math.max(1, Math.ceil(dist(a, b) / 0.5));
    for (let k = 1; k <= n; k++) best = Math.min(best, nearestChildPlace(zones, { x: a.x + ((b.x - a.x) * k) / n, z: a.z + ((b.z - a.z) * k) / n }));
  }
  return best;
}

/** The plain shortest road between two points, ignoring every guardrail. */
function shortestRoad(g: RoadGraph, from: V2, to: V2): V2[] {
  const { prev } = dijkstra(g, nearestNode(g, from));
  return [...pathFromPrev(prev, nearestNode(g, to)).map((i) => g.nodes[i]), to];
}
