import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { loadMapFile } from '../src/ui/menu';
import { parseOverpass } from '../src/map/overpass';
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
          { type: 'way', id: 1, tags: { building: 'yes' }, geometry: sq(-10.0, 100.0) },
          { type: 'way', id: 2, tags: { highway: 'residential' }, geometry: [{ lat: -10.005, lon: 99.995 }, { lat: -9.995, lon: 100.005 }] },
        ],
      },
      'my-area.json',
    );
    expect(m.name).toBe('my-area');
    expect(m.buildings).toHaveLength(1);
    expect(m.roads).toHaveLength(1);
    expect(Math.abs(m.roads[0].pts[0].x)).toBeLessThan(600);
  });

  it('keeps recon data (features, bus routes, trees, lamps) and drops malformed entries', () => {
    const m = makeSampleTown();
    const raw = JSON.parse(JSON.stringify(m));
    raw.features.push({ id: 'bad', category: 'volcano', p: { x: 0, z: 0 } }, { id: 'bad2', category: 'park', p: { x: 'x', z: 0 } });
    raw.trees.push({ x: NaN, z: 1 });
    const back = loadMapFile(raw, 'x.json');
    expect(back.features).toHaveLength(m.features!.length);
    expect(back.features!.find((f) => f.category === 'tennis')!.name).toBe('Orchard Tennis Club');
    expect(back.busRoutes).toHaveLength(1);
    expect(back.trees).toHaveLength(m.trees!.length);
    expect(back.lamps).toHaveLength(m.lamps!.length);
  });

  it('still loads maps saved before phase 2 (no recon fields)', () => {
    const { features: _f, busRoutes: _b, trees: _t, lamps: _l, ...old } = makeSampleTown();
    const back = loadMapFile(JSON.parse(JSON.stringify(old)), 'old.json');
    expect(back.features).toBeUndefined();
    expect(back.buildings.length).toBe(old.buildings.length);
  });

  it('rejects files that are not maps', () => {
    expect(() => loadMapFile({ hello: 'world' }, 'x.json')).toThrow();
    expect(() => loadMapFile({ elements: [] }, 'x.json')).toThrow();
  });

  // BACKLOG 3.21: the old guess used every node, so far-flung relation members shrank the town.
  it('loads a raw Overpass file of a whole town without losing it (Gundagai: stored centre or building box)', () => {
    const raw = JSON.parse(readFileSync(new URL('../maps/fixtures/gundagai.json', import.meta.url), 'utf8'));
    const f = raw.spooky_fixture;
    const want = parseOverpass({ elements: raw.elements }, f.origin, f.half, 'g');
    expect(want.buildings.length).toBeGreaterThan(300);
    const within = (a: number, b: number) => Math.abs(a - b) <= b * 0.05;
    const withMeta = loadMapFile(raw, 'g.json');
    expect(within(withMeta.buildings.length, want.buildings.length)).toBe(true);
    expect(within(withMeta.roads.length, want.roads.length)).toBe(true);
    const { spooky_fixture: _drop, ...bare } = raw;
    const guessed = loadMapFile(bare, 'g.json');
    expect(within(guessed.buildings.length, want.buildings.length)).toBe(true);
    expect(within(guessed.roads.length, want.roads.length)).toBe(true);
  });
});
