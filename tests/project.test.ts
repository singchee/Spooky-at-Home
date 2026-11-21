import { describe, expect, it } from 'vitest';
import { bboxAround, toLocal } from '../src/map/project';

describe('toLocal', () => {
  const origin = { lat: -37.8, lon: 145.0 };

  it('puts the origin at 0,0', () => {
    const p = toLocal(origin, origin.lat, origin.lon);
    expect(p.x).toBeCloseTo(0);
    expect(p.z).toBeCloseTo(0);
  });

  it('maps north to -z and east to +x, roughly 111 m per 0.001 degree of latitude', () => {
    const north = toLocal(origin, origin.lat + 0.001, origin.lon);
    const east = toLocal(origin, origin.lat, origin.lon + 0.001);
    expect(north.z).toBeCloseTo(-110.6, 0);
    expect(east.x).toBeGreaterThan(80);
    expect(east.x).toBeLessThan(90); // cos(37.8°) ≈ 0.79
  });

  it('bboxAround is symmetric and about the requested size', () => {
    const b = bboxAround(origin, 500);
    const sw = toLocal(origin, b.south, b.west);
    const ne = toLocal(origin, b.north, b.east);
    expect(ne.x - sw.x).toBeCloseTo(1000, 0);
    expect(sw.z - ne.z).toBeCloseTo(1000, 0);
  });
});
