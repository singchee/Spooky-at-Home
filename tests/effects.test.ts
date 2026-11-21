import { describe, expect, it } from 'vitest';
import { Effects } from '../src/game/effects';

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
