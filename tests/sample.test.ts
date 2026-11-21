import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';

describe('makeSampleTown', () => {
  it('is deterministic for a given seed', () => {
    expect(JSON.stringify(makeSampleTown(7))).toEqual(JSON.stringify(makeSampleTown(7)));
  });

  it('has the landmarks the mission generator relies on', () => {
    const m = makeSampleTown();
    expect(m.buildings.length).toBeGreaterThan(300);
    expect(m.pois.some((p) => p.kind === 'school')).toBe(true);
    expect(m.areas.some((a) => a.kind === 'park')).toBe(true);
    expect(m.roads.every((r) => r.pts.length >= 2 && r.name)).toBe(true);
  });

  it('has the recon places the mission templates need, so recon works offline', () => {
    const m = makeSampleTown();
    const has = (c: string) => m.features!.filter((f) => f.category === c).map((f) => f.name);
    expect(has('tennis')).toEqual(['Orchard Tennis Club']);
    expect(has('sports_centre')).toEqual(['Ironbark Sports Centre']);
    expect(has('pitch')).toEqual(['Ironbark Oval']);
    expect(has('forest')).toEqual(['Grevillea Woods']);
    expect(has('playground')).toHaveLength(1);
    expect(has('mall')).toEqual(['Sampleton Plaza']);
    expect(m.busRoutes).toHaveLength(1);
    expect(m.areas.some((a) => a.kind === 'wood')).toBe(true);
    expect(m.trees!.length).toBeGreaterThan(100);
    expect(m.lamps!.length).toBeGreaterThan(20);
  });

  it('recon blocks hold no houses (nothing standing on the courts or in the woods)', () => {
    const m = makeSampleTown();
    for (const f of m.features!.filter((x) => x.category === 'tennis' || x.category === 'forest' || x.category === 'pitch')) {
      const inside = m.buildings.filter((b) => b.kind === 'house' && b.pts.some((p) => Math.abs(p.x - f.p.x) < 40 && Math.abs(p.z - f.p.z) < 40));
      expect(inside, f.name).toHaveLength(0);
    }
  });
});
