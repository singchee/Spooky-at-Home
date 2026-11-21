import { describe, expect, it } from 'vitest';
import { loadMapFile } from '../src/ui/menu';
import { makeSampleTown } from '../src/map/sample';

describe('loadMapFile', () => {
  it('round-trips a map saved by the game', () => {
    const m = makeSampleTown();
    const back = loadMapFile(JSON.parse(JSON.stringify(m)), 'x.json');
    expect(back.buildings.length).toBe(m.buildings.length);
    expect(back.half).toBe(m.half);
  });

  it('accepts raw Overpass JSON exported from overpass-turbo, centred on its data', () => {
    const sq = (lat: number, lon: number) => [
      { lat, lon }, { lat, lon: lon + 0.0001 }, { lat: lat + 0.0001, lon: lon + 0.0001 }, { lat: lat + 0.0001, lon }, { lat, lon },
    ];
    const m = loadMapFile(
      {
        elements: [
          { type: 'way', id: 1, tags: { building: 'yes' }, geometry: sq(-37.8, 145.0) },
          { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [{ lat: -37.805, lon: 144.995 }, { lat: -37.795, lon: 145.005 }] },
        ],
      },
      'my-area.json',
    );
    expect(m.name).toBe('my-area');
    expect(m.buildings).toHaveLength(1);
    expect(m.roads).toHaveLength(1);
    expect(Math.abs(m.roads[0].pts[0].x)).toBeLessThan(600);
  });

  it('rejects files that are not maps', () => {
    expect(() => loadMapFile({ hello: 'world' }, 'x.json')).toThrow();
    expect(() => loadMapFile({ elements: [] }, 'x.json')).toThrow();
  });
});
