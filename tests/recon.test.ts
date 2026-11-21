import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { MISSION_TEMPLATES, TEMPLATE_IDS, mapFeatures, matchMissions, rankMissions, reconMap, type TemplateId } from '../src/map/recon';
import { generateMission } from '../src/sim/missions';
import type { Building, Feature, FeatureCategory, MapData, Road, V2 } from '../src/map/types';

const sample = makeSampleTown();
const sampleGraph = buildRoadGraph(sample);
const sampleGrid = new WalkGrid(sample);

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];

/** A small synthetic grid town in local metres (no real coordinates at all), with optional places. */
function gridTown(features: Feature[] = [], name = 'Gridville'): MapData {
  const roads: Road[] = [];
  const buildings: Building[] = [];
  for (let i = -4; i <= 4; i++) {
    const ns: V2[] = [];
    const ew: V2[] = [];
    for (let j = -4; j <= 4; j++) {
      ns.push({ x: i * 100, z: j * 100 });
      ew.push({ x: j * 100, z: i * 100 });
    }
    roads.push({ id: `ns${i}`, pts: ns, kind: 'residential', width: 7, name: `Street ${i + 5}` });
    roads.push({ id: `ew${i}`, pts: ew, kind: 'residential', width: 7, name: `Avenue ${i + 5}` });
  }
  let id = 0;
  for (let bx = -4; bx < 4; bx++) {
    for (let bz = -4; bz < 4; bz++) {
      const x0 = bx * 100;
      const z0 = bz * 100;
      const taken = features.some((f) => f.p.x > x0 && f.p.x < x0 + 100 && f.p.z > z0 && f.p.z < z0 + 100);
      if (taken) continue;
      for (const [dx, dz] of [[20, 15], [60, 15], [20, 75], [60, 75]]) buildings.push({ id: `h${id++}`, pts: rect(x0 + dx, z0 + dz, x0 + dx + 12, z0 + dz + 10), height: 6, kind: 'house' });
    }
  }
  // Buildings for any place that needs one (a hall, a shop, a station).
  for (const f of features) {
    if (['sports_centre', 'mall', 'supermarket', 'school', 'train_station', 'bus_station', 'police', 'hospital', 'fire_station', 'stadium'].includes(f.category)) {
      buildings.push({ id: `b-${f.id}`, pts: rect(f.p.x - 20, f.p.z - 15, f.p.x + 20, f.p.z + 15), height: 9, kind: 'commercial', name: f.name });
    }
  }
  return { name, half: 450, buildings, roads, areas: [], pois: [], attribution: 'test', features };
}

const place = (id: string, category: FeatureCategory, x: number, z: number, name?: string, size = 0): Feature => ({
  id, category, name, p: { x, z }, ...(size ? { pts: rect(x - size, z - size, x + size, z + size) } : {}),
});

const CHILD_WORDS = /\b(child|children|kid|kids|pupil|pupils|student|students|schoolchild|toddler|baby|babies)\b/i;

describe('reconMap', () => {
  it('summarises the sample town with counts and real names', () => {
    const r = reconMap(sample);
    expect(r.empty).toBe(false);
    const cat = (c: string) => r.categories.find((x) => x.category === c);
    expect(cat('tennis')?.text).toBe('1 tennis club');
    expect(cat('tennis')?.names).toEqual(['Orchard Tennis Club']);
    expect(cat('park')?.text).toBe('3 parks');
    expect(cat('forest')?.names).toEqual(['Grevillea Woods']);
    expect(cat('sports_centre')?.count).toBe(1);
    expect(r.busRoutes).toHaveLength(1);
    expect(r.message).toMatch(/^Recon complete: .*1 bus route\.$/);
    expect(r.notable.map((f) => f.name)).toContain('Ironbark Sports Centre');
    expect(r.trees).toBeGreaterThan(0);
  });

  it('gives a clear message for a map with roads but no places', () => {
    const r = reconMap(gridTown());
    expect(r.empty).toBe(true);
    expect(r.categories).toHaveLength(0);
    expect(r.message).toMatch(/no landmarks/);
  });

  it('gives a clear message for an empty map', () => {
    const empty: MapData = { name: 'Nowhere', half: 400, buildings: [], roads: [], areas: [], pois: [], attribution: 'test' };
    const r = reconMap(empty);
    expect(r.empty).toBe(true);
    expect(r.message).toMatch(/nothing to work with/);
    expect(matchMissions(empty, 1)).toEqual([]);
  });

  it('falls back to landmarks and parks for maps saved before phase 2', () => {
    const old: MapData = { ...sample, features: undefined, busRoutes: undefined, trees: undefined, lamps: undefined };
    const cats = mapFeatures(old).map((f) => f.category);
    expect(cats).toContain('school');
    expect(cats).toContain('park');
    expect(cats).toContain('forest');
    expect(reconMap(old).empty).toBe(false);
  });
});

describe('matchMissions', () => {
  it('suggests three missions for the sample town, each with a reason that uses real names', () => {
    const s = matchMissions(sample, 1);
    expect(s).toHaveLength(3);
    expect(new Set(s.map((x) => x.template)).size).toBe(3);
    for (const x of s) {
      expect(x.why.length).toBeGreaterThan(20);
      if (x.anchor) {
        expect(x.anchor.name).toBeTruthy();
        expect(x.why).toContain(x.anchor.name!);
        expect(x.title).toContain(x.anchor.name!);
      }
    }
    // Real places beat the classic fallbacks when they exist.
    expect(s.every((x) => !x.template.startsWith('classic'))).toBe(true);
  });

  it('mixes mission types rather than offering three of the same', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const bases = matchMissions(sample, seed).map((x) => x.base);
      expect(new Set(bases).size, `seed ${seed}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('is deterministic for map + seed, and the seed can change the picks', () => {
    expect(JSON.stringify(matchMissions(sample, 5))).toBe(JSON.stringify(matchMissions(sample, 5)));
    const seen = new Set<string>();
    for (let seed = 1; seed <= 12; seed++) seen.add(matchMissions(sample, seed).map((x) => x.template).join(','));
    expect(seen.size).toBeGreaterThan(1);
  });

  it('every suggestion builds a valid mission on the sample town', () => {
    for (let seed = 1; seed <= 6; seed++) {
      for (const s of matchMissions(sample, seed)) {
        const r = generateMission(sample, sampleGraph, sampleGrid, { type: s.base, difficulty: 3, seed, template: s.template, anchor: s.anchor?.id });
        expect(r.ok, `${s.template} seed ${seed}: ${r.ok ? '' : r.reason}`).toBe(true);
      }
    }
  });

  it('only offers a place-based template when the map has that place', () => {
    const cases: [TemplateId, Feature][] = [
      ['clear-tennis', place('t', 'tennis', 150, 150, 'Test Tennis Club', 35)],
      ['forest-sweep', place('f', 'forest', -150, 150, 'Test Woods', 45)],
      ['hold-sports', place('s', 'sports_centre', 150, -150, 'Test Sports Centre')],
      ['escort-shops', place('m', 'mall', -150, -150, 'Test Plaza')],
      ['escort-school', place('sc', 'school', 50, -250, 'Test High School')],
      ['escort-station', place('st', 'train_station', -250, 50, 'Test Central')],
      ['clear-park', place('p', 'park', 250, 50, 'Test Park', 40)],
      ['hold-landmark', place('po', 'police', -50, 250, 'Test Police Station')],
    ];
    for (const [id, f] of cases) {
      const without = rankMissions(gridTown(), 1).map((s) => s.template);
      expect(without, id).not.toContain(id);
      const withIt = rankMissions(gridTown([f]), 1);
      const s = withIt.find((x) => x.template === id);
      expect(s, id).toBeDefined();
      expect(s!.anchor!.id).toBe(f.id);
      expect(s!.why).toContain(f.name!);
    }
  });

  it('offers only classic missions on a map with roads but no places', () => {
    const s = matchMissions(gridTown(), 1);
    expect(s.map((x) => x.template).sort()).toEqual(['classic-clear', 'classic-defend', 'classic-escort']);
  });

  it('describes unnamed places by their street', () => {
    const s = rankMissions(gridTown([place('t', 'tennis', 150, 150, undefined, 35)]), 1).find((x) => x.template === 'clear-tennis')!;
    expect(s.why).toMatch(/the tennis club on (Street|Avenue) \d/);
  });

  it('ignores places at the very edge of the map (out of the orbit)', () => {
    const s = rankMissions(gridTown([place('t', 'tennis', 420, 420, 'Edge Tennis', 20)]), 1);
    expect(s.find((x) => x.template === 'clear-tennis')).toBeUndefined();
  });

  it('respects accept(): unbuildable suggestions are replaced by the next best', () => {
    const s = matchMissions(sample, 1, { accept: (x) => x.template !== 'forest-sweep' });
    expect(s).toHaveLength(3);
    expect(s.some((x) => x.template === 'forest-sweep')).toBe(false);
  });

  it('guardrail: no template is about children, and none is anchored on kindergartens or playgrounds', () => {
    for (const id of TEMPLATE_IDS) {
      const t = MISSION_TEMPLATES[id];
      expect(t.anchors).not.toContain('kindergarten');
      expect(t.anchors).not.toContain('playground');
      expect(t.name).not.toMatch(CHILD_WORDS);
    }
    const all = rankMissions(gridTown([place('k', 'kindergarten', 150, 150, 'Little Ones Kindy'), place('pg', 'playground', -150, 150, 'Swings')]), 1);
    expect(all.every((s) => !s.anchor)).toBe(true);
    for (let seed = 1; seed <= 4; seed++) {
      for (const s of rankMissions(sample, seed)) {
        expect(s.why).not.toMatch(CHILD_WORDS);
        expect(s.title).not.toMatch(CHILD_WORDS);
      }
    }
  });
});
