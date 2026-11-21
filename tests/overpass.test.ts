import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildQuery, capFeatures, checkOverpassAnswer, featureCategory, fetchOverpass, geocode, parseOverpass, type OverpassElement, type OverpassJson } from '../src/map/overpass';
import type { Feature, FeatureCategory } from '../src/map/types';

// A point in the open ocean: test coordinates must never point at anyone's home.
const origin = { lat: -10.0, lon: 100.0 };
const sq = (lat: number, lon: number, d = 0.0001) => [
  { lat, lon }, { lat, lon: lon + d }, { lat: lat + d, lon: lon + d }, { lat: lat + d, lon }, { lat, lon },
];

const fixture: OverpassJson = {
  elements: [
    { type: 'way', id: 1, tags: { building: 'house' }, geometry: sq(-10.0, 100.0) },
    { type: 'way', id: 2, tags: { building: 'apartments', 'building:levels': '5' }, geometry: sq(-10.001, 100.001) },
    { type: 'way', id: 3, tags: { building: 'school', amenity: 'school', name: 'Test Primary' }, geometry: sq(-9.999, 99.999) },
    { type: 'way', id: 4, tags: { highway: 'residential', name: 'Banksia <b>Street</b>' }, geometry: [{ lat: -10.0, lon: 99.998 }, { lat: -10.0, lon: 100.002 }] },
    { type: 'way', id: 5, tags: { leisure: 'park' }, geometry: sq(-10.002, 100.0, 0.0005) },
    { type: 'node', id: 6, lat: -10.0005, lon: 100.0005, tags: { amenity: 'hospital', name: 'Test Hospital' } },
    { type: 'way', id: 7, tags: { building: 'house' }, geometry: sq(-11.5, 101.0) }, // far outside: dropped
    { type: 'way', id: 8, tags: { highway: 'motorway_link' }, geometry: [{ lat: -10.0, lon: 100.0 }, { lat: -10.0, lon: 100.001 }] }, // unsupported kind
  ],
};

describe('parseOverpass', () => {
  const map = parseOverpass(fixture, origin, 500, 'Test');

  it('sorts features into buildings, roads, areas and landmarks', () => {
    expect(map.buildings.map((b) => b.id).sort()).toEqual(['w1', 'w2', 'w3']);
    expect(map.roads).toHaveLength(1);
    expect(map.areas).toHaveLength(1);
    expect(map.pois.map((p) => p.kind).sort()).toEqual(['hospital', 'school']);
  });

  it('drops the repeated closing point of building outlines', () => {
    expect(map.buildings[0].pts).toHaveLength(4);
  });

  it('uses building:levels for height', () => {
    expect(map.buildings.find((b) => b.id === 'w2')!.height).toBeCloseTo(17);
  });

  it('keeps map text as raw data (escaping is the UI layer’s job)', () => {
    expect(map.roads[0].name).toBe('Banksia <b>Street</b>');
  });

  it('always carries OpenStreetMap attribution', () => {
    expect(map.attribution).toMatch(/OpenStreetMap/);
  });
});

describe('buildQuery / geocode', () => {
  it('builds a bounded Overpass query', () => {
    const q = buildQuery(origin, 500);
    expect(q).toContain('[out:json]');
    expect(q).toContain('way["building"]');
    expect(q).toContain('out geom;');
  });

  it('accepts raw "lat, lon" without any network call', async () => {
    const r = await geocode('-10.01, 99.96');
    expect(r.lat).toBeCloseTo(-10.01);
    expect(r.lon).toBeCloseTo(99.96);
  });
});

describe('parseOverpass: recon categories (phase 2)', () => {
  // Still in the open ocean, around -10, 100.
  const recon: OverpassJson = {
    elements: [
      { type: 'way', id: 101, tags: { amenity: 'school', name: 'Ocean Primary' }, geometry: sq(-10.001, 100.001, 0.0008) },
      { type: 'way', id: 102, tags: { building: 'school', amenity: 'school', name: 'Ocean Primary' }, geometry: sq(-10.0008, 100.0012, 0.0002) },
      { type: 'node', id: 103, lat: -10.0005, lon: 99.999, tags: { amenity: 'kindergarten', name: 'Little Fish Kindy' } },
      { type: 'way', id: 104, tags: { leisure: 'sports_centre', name: 'Reef Sports Centre' }, geometry: sq(-10.002, 99.998, 0.0005) },
      { type: 'way', id: 105, tags: { leisure: 'stadium', name: 'Tide Oval' }, geometry: sq(-10.003, 100.003, 0.0006) },
      { type: 'way', id: 106, tags: { leisure: 'pitch', sport: 'soccer' }, geometry: sq(-9.999, 100.002, 0.0003) },
      { type: 'way', id: 107, tags: { leisure: 'pitch', sport: 'tennis' }, geometry: sq(-9.998, 99.998, 0.0002) },
      { type: 'node', id: 108, lat: -9.9975, lon: 99.9975, tags: { club: 'tennis', name: 'Coral Tennis Club' } },
      { type: 'way', id: 109, tags: { leisure: 'swimming_pool', access: 'private' }, geometry: sq(-9.997, 100.0, 0.0001) },
      { type: 'node', id: 110, lat: -9.9965, lon: 100.0005, tags: { leisure: 'swimming_pool', name: 'Ocean Aquatic Centre' } },
      { type: 'node', id: 111, lat: -9.996, lon: 100.001, tags: { leisure: 'playground' } },
      { type: 'way', id: 112, tags: { leisure: 'park', name: 'Kelp Park' }, geometry: sq(-10.004, 99.996, 0.0006) },
      { type: 'way', id: 113, tags: { landuse: 'forest', name: 'Seagrass Woods' }, geometry: sq(-10.0035, 100.004, 0.0008) },
      { type: 'relation', id: 114, center: { lat: -9.997, lon: 99.9965 }, tags: { natural: 'wood', type: 'multipolygon' } },
      { type: 'node', id: 115, lat: -10.0012, lon: 99.9995, tags: { shop: 'supermarket', name: 'Tidal Grocer' } },
      { type: 'way', id: 116, tags: { shop: 'mall', name: 'Lagoon Plaza' }, geometry: sq(-10.0015, 99.997, 0.0004) },
      { type: 'way', id: 117, tags: { amenity: 'parking' }, geometry: sq(-10.0016, 99.9965, 0.0001) },
      { type: 'node', id: 118, lat: -10.0001, lon: 100.0001, tags: { amenity: 'police', name: 'Ocean Police' } },
      { type: 'node', id: 119, lat: -10.0002, lon: 100.0002, tags: { amenity: 'fire_station' } },
      { type: 'node', id: 120, lat: -10.0003, lon: 100.0003, tags: { railway: 'station', name: 'Ocean Central' } },
      { type: 'node', id: 121, lat: -10.0004, lon: 100.0004, tags: { amenity: 'bus_station', name: 'Ocean Interchange' } },
      { type: 'node', id: 122, lat: -10.0006, lon: 100.0006, tags: { highway: 'street_lamp' } },
      { type: 'node', id: 123, lat: -10.0007, lon: 100.0007, tags: { natural: 'tree' } },
      { type: 'node', id: 124, lat: -10.0008, lon: 100.0007, tags: { natural: 'tree' } },
      {
        type: 'relation', id: 130, tags: { route: 'bus', ref: '42', name: 'Bus 42: Ocean Central - Kelp Park' },
        members: [
          { type: 'way', ref: 9001, role: '', geometry: [{ lat: -10.0, lon: 99.997 }, { lat: -10.0, lon: 100.0 }, null, { lat: -10.0, lon: 100.002 }, { lat: -10.0, lon: 100.003 }] },
          { type: 'node', ref: 9002, role: 'stop', lat: -10.0, lon: 100.0 },
          { type: 'way', ref: 9003, role: 'platform', geometry: [{ lat: -10.0001, lon: 99.999 }, { lat: -10.0001, lon: 99.9992 }] },
        ],
      },
      // The same line in the other direction shares way 9001: merged, not counted twice.
      { type: 'relation', id: 131, tags: { route: 'bus', ref: '42' }, members: [{ type: 'way', ref: 9001, role: 'forward', geometry: [{ lat: -10.0, lon: 99.997 }, { lat: -10.0, lon: 100.0 }] }] },
      // A route that never enters the map is dropped.
      { type: 'relation', id: 132, tags: { route: 'bus', ref: '7' }, members: [{ type: 'way', ref: 9004, geometry: [{ lat: -11.5, lon: 101.0 }, { lat: -11.5, lon: 101.01 }] }] },
    ],
  };
  const m = parseOverpass(recon, origin, 600, 'Recon test');
  const cats = (c: string) => m.features!.filter((f) => f.category === c);

  it('finds each category', () => {
    for (const c of ['school', 'kindergarten', 'sports_centre', 'stadium', 'pitch', 'tennis', 'swimming_pool', 'playground', 'park', 'forest', 'supermarket', 'mall', 'parking', 'police', 'fire_station', 'train_station', 'bus_station']) {
      expect(cats(c).length, c).toBeGreaterThan(0);
    }
  });

  it('merges a school mapped as grounds and as a building', () => {
    expect(cats('school')).toHaveLength(1);
    expect(cats('school')[0].name).toBe('Ocean Primary');
    expect(cats('school')[0].pts!.length).toBe(4);
  });

  it('counts tennis from club=tennis; an unnamed sport=tennis pitch is just a sports ground', () => {
    expect(cats('tennis').map((f) => f.name ?? '').sort()).toEqual(['Coral Tennis Club']);
    expect(cats('pitch').map((f) => f.id).sort()).toEqual(['w106', 'w107']);
  });

  it('skips private backyard pools but keeps the public one', () => {
    expect(cats('swimming_pool').map((f) => f.name)).toEqual(['Ocean Aquatic Centre']);
  });

  it('keeps multipolygon forests as a centre point', () => {
    expect(cats('forest').some((f) => f.id === 'r114' && !f.pts)).toBe(true);
  });

  it('reads trees, lamps and bus routes (clipped, merged by number, platforms ignored)', () => {
    expect(m.trees).toHaveLength(2);
    expect(m.lamps).toHaveLength(1);
    expect(m.busRoutes).toHaveLength(1);
    const r = m.busRoutes![0];
    expect(r.ref).toBe('42');
    expect(r.lines).toHaveLength(2); // split where the clipped geometry had a gap
    expect(r.lines.every((l) => l.length >= 2)).toBe(true);
  });

  it('sports centres and pools do not become walkable park areas', () => {
    expect(m.areas.find((a) => a.id === 'w104')).toBeUndefined();
    expect(m.areas.find((a) => a.id === 'w113')?.kind).toBe('wood');
  });

  it('still fills pois for the mission generator', () => {
    expect(m.pois.map((p) => p.kind).sort()).toEqual(['fire_station', 'police', 'school']);
  });

  it('asks Overpass for the new categories in one modest query', () => {
    const q = buildQuery(origin, 600);
    expect(q).toContain('relation["route"="bus"]');
    expect(q).toMatch(/out geom\(-?\d/); // bus routes clipped to the map square
    expect(q).toContain('out center tags;');
    expect(q).toContain('"highway"="street_lamp"');
    expect(q).toContain('"natural"="tree"');
    expect(q).toContain('"club"="tennis"');
    // 4 output blocks: ways and nodes; protected campuses (school, kindergarten, childcare) with full
    // geometry so their whole grounds are protected; other relations as centres; clipped bus routes.
    expect(q.match(/^out /gm)).toHaveLength(4);
    expect(q).toContain('relation["amenity"~"^(school|kindergarten|childcare)$"]');
    expect(q).toMatch(/childcare/);
  });
});

describe('featureCategory: tennis', () => {
  it('only club=tennis or a named tennis place is a tennis club', () => {
    expect(featureCategory({ leisure: 'pitch', sport: 'tennis' })).toBe('pitch');
    expect(featureCategory({ leisure: 'pitch', sport: 'tennis;basketball' })).toBe('pitch');
    expect(featureCategory({ leisure: 'sports_centre', sport: 'tennis' })).toBe('sports_centre');
    expect(featureCategory({ sport: 'tennis' })).toBe(null);
    expect(featureCategory({ leisure: 'pitch', sport: 'tennis', name: 'Coral Courts' })).toBe('tennis');
    expect(featureCategory({ leisure: 'sports_centre', sport: 'tennis', name: 'Reef Tennis Centre' })).toBe('tennis');
    expect(featureCategory({ club: 'tennis' })).toBe('tennis');
    expect(featureCategory({ club: 'tennis', leisure: 'pitch' })).toBe('tennis');
  });
});

describe('feature cap', () => {
  const f = (id: string, category: FeatureCategory): Feature => ({ id, category, p: { x: 0, z: 0 } });

  it('drops car parks and pitches first, and never schools, kindergartens or playgrounds', () => {
    const list = [f('s', 'school'), f('pk1', 'parking'), f('h', 'hospital'), f('pi', 'pitch'), f('k', 'kindergarten'), f('pk2', 'parking'), f('po', 'police'), f('pg', 'playground'), f('rs', 'train_station')];
    expect(capFeatures(list, 6).map((x) => x.id)).toEqual(['s', 'h', 'k', 'po', 'pg', 'rs']); // original order kept
    expect(capFeatures(list, 7).map((x) => x.id)).toEqual(['s', 'h', 'pi', 'k', 'po', 'pg', 'rs']);
    // Even past the cap, every child place stays (the exclusion zone needs them).
    expect(capFeatures(list, 2).map((x) => x.id)).toEqual(['s', 'k', 'pg']);
    expect(capFeatures(list, 100)).toBe(list);
  });

  it('a map flooded with car parks still keeps its hospital, police, station and school', () => {
    const els: OverpassElement[] = [];
    for (let i = 0; i < 2100; i++) els.push({ type: 'node', id: 5000 + i, lat: -10.0 + (i % 50) * 0.00005, lon: 100.0 + Math.floor(i / 50) * 0.00005, tags: { amenity: 'parking' } });
    els.push(
      { type: 'node', id: 1, lat: -10.001, lon: 100.001, tags: { amenity: 'hospital', name: 'Flood Hospital' } },
      { type: 'node', id: 2, lat: -10.002, lon: 100.002, tags: { amenity: 'police', name: 'Flood Police' } },
      { type: 'node', id: 3, lat: -10.003, lon: 100.003, tags: { railway: 'station', name: 'Flood Central' } },
      { type: 'node', id: 4, lat: -10.004, lon: 100.004, tags: { amenity: 'school', name: 'Flood Primary' } },
      { type: 'node', id: 6, lat: -10.0045, lon: 100.0045, tags: { leisure: 'playground' } },
    );
    const m = parseOverpass({ elements: els }, origin, 600, 'Flood');
    expect(m.features).toHaveLength(2000);
    const cats = m.features!.map((x) => x.category);
    for (const c of ['hospital', 'police', 'train_station', 'school', 'playground']) expect(cats, c).toContain(c);
  });
});

describe('fetchOverpass: a failed query is a failure, even with HTTP 200', () => {
  afterEach(() => vi.unstubAllGlobals());
  // Inline fixtures: what Overpass sends when a query runs out of time or memory.
  const timedOut: OverpassJson = { elements: [], remark: 'runtime error: Query timed out in "query" at line 3 after 61 seconds.' };
  const outOfMemory: OverpassJson = { elements: [], remark: 'runtime error: Query run out of memory using about 2048 MB of RAM.' };
  const good: OverpassJson = { elements: [{ type: 'node', id: 6, lat: -10.0005, lon: 100.0005, tags: { amenity: 'hospital', name: 'Test Hospital' } }] };
  const answer = (json: unknown) => ({ ok: true, status: 200, json: async () => json }) as unknown as Response;

  it('asks for a 60 s server timeout', () => {
    expect(buildQuery(origin, 500)).toMatch(/^\[out:json\]\[timeout:60\];/);
  });

  it('treats a "runtime error" or "timed out" remark as a failure', () => {
    expect(() => checkOverpassAnswer(timedOut, 'a')).toThrow(/timed out/);
    expect(() => checkOverpassAnswer(outOfMemory, 'a')).toThrow(/runtime error/);
    expect(() => checkOverpassAnswer({ elements: [], remark: 'Query timed out' } as OverpassJson, 'a')).toThrow();
    expect(checkOverpassAnswer(good, 'a')).toBe(good);
    expect(checkOverpassAnswer({ ...good, remark: 'some harmless note' }, 'a').elements).toHaveLength(1);
  });

  it('moves on to the next server when the first one times out', async () => {
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(url);
      return answer(urls.length === 1 ? timedOut : good);
    }));
    const json = await fetchOverpass(origin, 500);
    expect(urls).toHaveLength(2);
    expect(urls[0]).not.toBe(urls[1]);
    expect(json.elements).toHaveLength(1);
  });

  it('fails clearly when every server times out', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => answer(timedOut)));
    await expect(fetchOverpass(origin, 500)).rejects.toThrow(/Could not download map data.*timed out/);
  });
});
