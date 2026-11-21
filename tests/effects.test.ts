import { describe, expect, it } from 'vitest';
import { BLAST_PROFILES, Effects } from '../src/game/effects';
import { SMOKE_DIM } from '../src/render/particleShader';

describe('Effects', () => {
  it('draws a fixed number of objects however much you fire (draw-call budget G8)', () => {
    const fx = new Effects();
    for (let i = 0; i < 400; i++) {
      fx.fire('25', { x: 0, y: 1500, z: 1000 }, { x: i, z: 0 }, 2, i * 0.05);
      fx.impact(i % 3 === 0 ? '105' : '25', i, 0, i * 0.05);
    }
    fx.update(19.9, 1 / 60);
    const s = fx.stats;
    expect(s.objects).toBe(3);
    expect(s.craters).toBe(Effects.LIMITS.craters); // 400 impacts, capped at the limit
    expect(s.tracers).toBeGreaterThan(0);
    expect(s.tracers).toBeLessThanOrEqual(Effects.LIMITS.tracers);
    expect(s.blasts).toBeLessThanOrEqual(Effects.LIMITS.blasts);
    fx.dispose();
  });
});

describe('Effects: layered explosions stay bounded', () => {
  it('500 impacts of every gun keep particle pools, fires and draw objects within fixed limits', () => {
    const fx = new Effects();
    const weapons = ['25', '40', '105'];
    for (let i = 0; i < 500; i++) {
      const t = i * 0.08;
      fx.fire(weapons[i % 3], { x: 0, y: 1500, z: 1000 }, { x: i % 40, z: 0 }, 2, t);
      fx.impact(weapons[i % 3], i % 40, (i * 7) % 30, t);
      if (i % 25 === 0) {
        fx.update(t, 1 / 60);
        const s = fx.stats;
        expect(s.objects).toBe(3);
        expect(s.glow).toBeLessThanOrEqual(Effects.LIMITS.glow);
        expect(s.smoke).toBeLessThanOrEqual(Effects.LIMITS.smoke);
        expect(s.fires).toBeLessThanOrEqual(Effects.LIMITS.fires);
        expect(s.tracers).toBeLessThanOrEqual(Effects.LIMITS.tracers);
      }
    }
    fx.update(40.5, 1 / 60);
    const s = fx.stats;
    expect(s.objects).toBe(3);
    expect(s.craters).toBe(Effects.LIMITS.craters);
    expect(s.fires).toBeGreaterThan(0); // fires still burning after the last 40 / 105 rounds
    expect(s.smoke).toBeGreaterThan(0);
    // Long after the shooting stops, everything has burned out except the craters.
    fx.update(120, 1 / 60);
    expect(fx.stats.glow).toBe(0);
    expect(fx.stats.smoke).toBe(0);
    expect(fx.stats.craters).toBe(Effects.LIMITS.craters);
    fx.dispose();
  });

  it('lingering fires only come from the 40 mm and 105 mm, and burn 10-20 s', () => {
    for (const [w, expectFires] of [['25', false], ['40', true], ['105', true]] as const) {
      const fx = new Effects();
      fx.impact(w, 0, 0, 0);
      fx.update(5, 1 / 60);
      expect(fx.stats.fires > 0).toBe(expectFires);
      fx.update(9.5, 1 / 60);
      expect(fx.stats.fires > 0).toBe(expectFires); // still burning at 9.5 s
      fx.update(21, 1 / 60);
      expect(fx.stats.fires).toBe(0); // all out by 21 s
      fx.dispose();
    }
  });

  it('bigger guns make bigger, longer blasts (25 → 40 → 105)', () => {
    const p = BLAST_PROFILES;
    for (const k of ['fbLife', 'sparks', 'debris', 'ring', 'smoke', 'fires'] as const) {
      expect(p['40'][k]).toBeGreaterThanOrEqual(p['25'][k]);
      expect(p['105'][k]).toBeGreaterThan(p['40'][k]);
    }
    expect(p['105'].fbSize[1]).toBeGreaterThan(p['40'].fbSize[1]);
    expect(p['40'].fbSize[1]).toBeGreaterThan(p['25'].fbSize[1]);
  });

  it('smoke dims night vision (visible and near-IR) far more than thermal', () => {
    expect(SMOKE_DIM.thermal).toBeLessThan(0.1);
    expect(SMOKE_DIM.visible).toBeGreaterThan(0.6);
    expect(SMOKE_DIM.nir).toBeGreaterThan(0.5);
  });
});
