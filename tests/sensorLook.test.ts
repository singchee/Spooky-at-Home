import { describe, expect, it } from 'vitest';
import { GfxGovernor, SLOW_FRAME, tierFromQuery } from '../src/render/gfxGovernor';
import { surfaceHeatRange } from '../src/render/groundShader';
import { BrightShader, SensorShader } from '../src/render/sensors';
import { SIG } from '../src/world/buildWorld';
import { HEAT } from '../src/game/agentAnim';
import { WEAPONS } from '../src/sim/weapons';

describe('ground texture keeps the sensor contract (PLAN §5a)', () => {
  it('grass texture is too faint to hide or reveal a cold-blooded zombie, and never adds warm clutter', () => {
    const [lo, hi] = surfaceHeatRange('grass');
    // A coldie (0.2) on grass (0.19) is a 0.01 difference; the grass mottle stays about that size.
    expect(hi).toBeLessThanOrEqual(0.015);
    expect(lo).toBeGreaterThanOrEqual(-0.015);
    expect(SIG.park[0] + hi).toBeLessThan(HEAT.cold + 0.01);
  });

  it('roads stay clearly warmer than a cold-blooded zombie, at their coolest patch', () => {
    const [lo] = surfaceHeatRange('asphalt');
    expect(SIG.road[0] + lo - HEAT.cold).toBeGreaterThanOrEqual(0.08);
  });

  it('nothing on the ground gets near warm-zombie heat (they stay the brightest thing)', () => {
    for (const k of ['asphalt', 'ground', 'grass'] as const) {
      const [, hi] = surfaceHeatRange(k);
      expect(SIG.road[0] + hi).toBeLessThan(HEAT.warmCore - 0.5);
    }
  });
});

describe('sensor picture', () => {
  it('night-vision bloom comes from visible and near-infrared light only, thermal bloom from heat only', () => {
    const f = BrightShader.fragmentShader;
    expect(f).toMatch(/float hot = max\(c\.r - 0\.45, 0\.0\);/);
    expect(f).toMatch(/float lit = max\(\(c\.g \+ c\.b\) \* 3\.0 - 1\.0, 0\.0\);/);
  });

  it('detail enhancement leaves differences as small as coldie-on-grass alone (coring)', () => {
    expect(SensorShader.fragmentShader).toMatch(/smoothstep\(vec3\(0\.012\), vec3\(0\.03\), abs\(dd\)\)/);
    expect(SIG.road[0] - HEAT.cold).toBeGreaterThan(0.03); // roads: full halo
    expect(Math.abs(HEAT.cold - SIG.park[0])).toBeLessThanOrEqual(0.012); // grass: none
  });

  it('reduce flicker freezes the grain and stops the rolling band', () => {
    const f = SensorShader.fragmentShader;
    expect(f).toMatch(/float gt = floor\(time \* 30\.0\) \* \(1\.0 - calm\);/);
    expect(f).toMatch(/float roll = \(1\.0 - calm\) \*/);
  });

  it('gun lenses: the 25 is the narrowest, the 105 the widest', () => {
    const fov = Object.fromEntries(WEAPONS.map((w) => [w.id, w.fov]));
    expect(fov['25']).toBeLessThan(fov['40']);
    expect(fov['40']).toBeLessThan(fov['105']);
  });
});

describe('graphics tier governor', () => {
  const run = (g: GfxGovernor, dt: number, n: number) => {
    let changed: string | null = null;
    for (let i = 0; i < n; i++) changed = g.frame(dt) ?? changed;
    return changed;
  };

  it('stays high on a fast device', () => {
    const g = new GfxGovernor('high', true);
    expect(run(g, 1 / 60, 2000)).toBeNull();
    expect(g.tier).toBe('high');
  });

  it('drops to low once, after warm-up, on sustained slow frames, and never climbs back', () => {
    const g = new GfxGovernor('high', true);
    expect(run(g, SLOW_FRAME * 1.5, 90)).toBeNull(); // warm-up frames don't count
    expect(run(g, SLOW_FRAME * 1.5, 130)).toBe('low');
    expect(g.tier).toBe('low');
    expect(run(g, 1 / 120, 2000)).toBeNull();
    expect(g.tier).toBe('low');
  });

  it('ignores pauses and hitches, and does nothing when not automatic', () => {
    const g = new GfxGovernor('high', true);
    run(g, 1 / 60, 100);
    expect(run(g, 2, 500)).toBeNull();
    const fixed = new GfxGovernor('high', false);
    expect(run(fixed, 0.2, 2000)).toBeNull();
  });

  it('reads ?gfx=', () => {
    expect(tierFromQuery('?gfx=low')).toBe('low');
    expect(tierFromQuery('?a=1&gfx=high')).toBe('high');
    expect(tierFromQuery('?gfx=bogus')).toBe('auto');
    expect(tierFromQuery('')).toBe('auto');
  });
});
