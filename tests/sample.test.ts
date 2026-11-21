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
});
