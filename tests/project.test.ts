import { describe, expect, it } from 'vitest';
import { bboxAround, toLocal } from '../src/map/project';

describe('toLocal', () => {
  // A point in the open ocean: test coordinates must never point at anyone's home.
  const origin = { lat: -10.0, lon: 100.0 };

  it('puts the origin at 0,0', () => {
    const p = toLocal(origin, origin.lat, origin.lon);
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });

  it('maps north to -z and east to +x, roughly 111 m per 0.001 degree of latitude', () => {
    const north = toLocal(origin, origin.lat + 0.001, origin.lon);
    const east = toLocal(origin, origin.lat, origin.lon + 0.001);
    expect(north.z).toBeCloseTo(-110.6, 0);
    expect(east.x).toBeGreaterThan(105);
    expect(east.x).toBeLessThan(112); // cos(10°) ≈ 0.985
  });

  it('bboxAround is symmetric and about the requested size', () => {
    const b = bboxAround(origin, 500);
    const sw = toLocal(origin, b.south, b.west);
    const ne = toLocal(origin, b.north, b.east);
    expect(ne.x - sw.x).toBeCloseTo(1000, 0);
    expect(sw.z - ne.z).toBeCloseTo(1000, 0);
  });
});
