import { describe, expect, it } from 'vitest';
import { buildQuery, geocode, parseOverpass, type OverpassJson } from '../src/map/overpass';

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
