import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { generateMission } from '../src/sim/missions';
import { nearChildPlace, childZones } from '../src/map/recon';
import { parseOverpass, featureCategory, type OverpassJson } from '../src/map/overpass';
import type { MapData } from '../src/map/types';

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
