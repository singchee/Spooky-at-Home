import { describe, expect, it } from 'vitest';
import { Effects, SHAKE_MAX_PX, SHAKE_TIME, shakeOffsetPx } from '../src/game/effects';
import { AgentsView } from '../src/game/agentsView';
import { PANEL_SIZE, PANEL_Y, PART, StrobeSprites, buildFigureGeometry } from '../src/render/figureShader';
import { SensorShader } from '../src/render/sensors';
import { Sfx } from '../src/audio/sfx';

describe('105 camera kick (photosensitivity)', () => {
  const samples = (fps: number) => Array.from({ length: Math.ceil(fps * 1.2) }, (_, i) => shakeOffsetPx(i / fps));

  it('never moves the picture more than SHAKE_MAX_PX (5) screen pixels', () => {
    expect(SHAKE_MAX_PX).toBeLessThanOrEqual(5);
    for (const fps of [30, 60, 144, 1000]) for (const o of samples(fps)) expect(Math.hypot(o.x, o.y)).toBeLessThanOrEqual(SHAKE_MAX_PX + 1e-9);
  });

  it('is one damped kick: at most two swings, settled within about 0.4 s', () => {
    expect(SHAKE_TIME).toBeLessThanOrEqual(0.45);
    const ys = samples(1000).map((o) => o.y);
    let swings = 0;
    let sign = 0;
    for (const y of ys) {
      if (Math.abs(y) < 0.05) continue; // ignore sub-pixel wobble
      const s = Math.sign(y);
      if (s !== sign) swings++;
      sign = s;
    }
    expect(swings).toBeGreaterThanOrEqual(1);
    expect(swings).toBeLessThanOrEqual(2);
    // The second swing is much smaller than the first (damped).
    const max = Math.max(...ys);
    const min = Math.min(...ys);
    expect(Math.abs(min)).toBeLessThan(max * 0.4);
    expect(shakeOffsetPx(SHAKE_TIME)).toEqual({ x: 0, y: 0 });
    expect(shakeOffsetPx(2)).toEqual({ x: 0, y: 0 });
    expect(shakeOffsetPx(-0.1)).toEqual({ x: 0, y: 0 });
  });

  it('only the 105 kicks the camera, from the moment of impact', () => {
    const fx = new Effects();
    fx.impact('25', 0, 0, 1);
    fx.impact('40', 0, 0, 1);
    expect(fx.shakePx(1.05)).toEqual({ x: 0, y: 0 });
    fx.impact('105', 0, 0, 2);
    const k = fx.shakePx(2.06);
    expect(Math.hypot(k.x, k.y)).toBeGreaterThan(2);
    expect(fx.shakePx(2.5)).toEqual({ x: 0, y: 0 });
    fx.dispose();
  });
});

describe('night-vision washout timing', () => {
  it('peaks with the 105 blast (within 0.15 s) and has faded by 1.5 s', () => {
    const fx = new Effects();
    fx.impact('105', 0, 0, 0);
    let peak = 0;
    let peakAt = 0;
    for (let i = 1; i <= 90; i++) {
      fx.update(i / 60, 1 / 60);
      if (fx.washout > peak) {
        peak = fx.washout;
        peakAt = i / 60;
      }
    }
    expect(peakAt).toBeLessThanOrEqual(0.15);
    expect(peak).toBeGreaterThan(0.25);
    expect(fx.washout).toBeLessThan(0.02);
    fx.dispose();
  });

  it('still eases in over a few frames rather than cutting straight to full', () => {
    const fx = new Effects();
    fx.impact('105', 0, 0, 0);
    fx.update(1 / 60, 1 / 60);
    expect(fx.washout).toBeLessThan(0.3);
    expect(fx.washout).toBeGreaterThan(0.1);
    fx.dispose();
  });
});

describe('survivor kit on thermal', () => {
  it('the IR strobe is not part of the figure: no thermal footprint, nothing covering the head', () => {
    expect(Object.keys(PART)).not.toContain('strobe');
    const g = buildFigureGeometry(true);
    const parts = Array.from(g.attributes.aPart.array as Float32Array);
    expect(Math.max(...parts)).toBe(PART.panel);
    g.dispose();
  });

  it('the strobe sprite adds near-IR only (R = 0 heat, G = 0 visible) and never hides what is under it', () => {
    const s = new StrobeSprites(4);
    const m = s.material;
    expect(m.fragmentShader).toMatch(/gl_FragColor\s*=\s*vec4\(0\.0,\s*0\.0,/);
    expect(m.blending).toBe(2); // THREE.AdditiveBlending
    expect(m.depthWrite).toBe(false);
    s.dispose();
  });

  it('the cold ID panel sits mid-chest and is well inside the chest, so warm body frames it', () => {
    const g = buildFigureGeometry(true);
    const pos = g.attributes.position;
    const part = g.attributes.aPart;
    let px = 0;
    const torsoY: number[] = [];
    let top = 0;
    let bottom = 0;
    for (let i = 0; i < pos.count; i++) {
      if (part.getX(i) === PART.panel) px = Math.max(px, Math.abs(pos.getX(i)));
      if (part.getX(i) === PART.torso) torsoY.push(pos.getY(i));
      // Torso half-widths at its top and bottom (it tapers toward the waist).
      if (part.getX(i) === PART.torso && pos.getY(i) > 1.5) top = Math.max(top, Math.abs(pos.getX(i)));
      if (part.getX(i) === PART.torso && pos.getY(i) < 1.5) bottom = Math.max(bottom, Math.abs(pos.getX(i)));
    }
    const lo = Math.min(...torsoY);
    const hi = Math.max(...torsoY);
    expect(PANEL_Y).toBeGreaterThan(lo + 0.25);
    expect(PANEL_Y).toBeLessThan(hi - 0.2);
    const chestHalf = bottom + ((top - bottom) * (PANEL_Y - lo)) / (hi - lo);
    expect(px).toBeCloseTo(PANEL_SIZE / 2, 5);
    expect(px).toBeLessThan(chestHalf * 0.7);
    g.dispose();
  });

  it('live survivors get a strobe each, dead and rescued ones none', () => {
    const view = new AgentsView();
    const survivors = [
      { id: 0, x: 0, z: 0, alive: true, home: false, diedAt: -1 },
      { id: 1, x: 5, z: 0, alive: false, home: false, diedAt: 1 },
      { id: 2, x: 9, z: 0, alive: true, home: true, diedAt: -1 },
      { id: 3, x: 9, z: 4, alive: true, home: false, diedAt: -1 },
    ];
    view.update({ zombies: [], survivors, t: 2 } as never, 1);
    expect(view.stats.survivors).toBe(3);
    expect(view.stats.strobes).toBe(2);
    view.dispose();
  });
});

describe('reduce flicker: camera-switch cover', () => {
  it('the sensor shader has a calm mode that drops the static noise', () => {
    expect(SensorShader.uniforms.calm.value).toBe(0);
    expect(SensorShader.fragmentShader).toMatch(/\(1\.0 - calm\)/);
  });
});

/** A fake audio context that records the oscillators made (type and frequency once set). */
function fakeAudio() {
  const made: { type: string; frequency: { value: number } }[] = [];
  const param = () => ({ value: 0, setValueAtTime() {}, exponentialRampToValueAtTime() {} });
  const ctx = {
    currentTime: 0,
    sampleRate: 100,
    destination: {},
    createBuffer: () => ({ getChannelData: () => new Float32Array(100) }),
    createOscillator: () => {
      const o = { type: 'sine', frequency: param(), connect: (n: unknown) => n, start() {}, stop() {} };
      made.push(o);
      return o;
    },
    createGain: () => ({ connect: (n: unknown) => n, gain: param() }),
  };
  return { ctx, made };
}

describe('friendly-fire sound', () => {
  it('plays the square-wave alarm, not the radio blip, and blips at the same moment are held back', () => {
    const { ctx, made } = fakeAudio();
    const sfx = new Sfx(() => ctx as unknown as AudioContext);
    sfx.unlock();
    sfx.alarm();
    sfx.radio(); // e.g. "Good effect on target" from the same shell
    expect(made.length).toBe(4);
    expect(made.every((o) => o.type === 'square')).toBe(true);
    expect(new Set(made.map((o) => o.frequency.value))).toEqual(new Set([880, 660]));
    ctx.currentTime = 1;
    sfx.radio();
    expect(made.length).toBe(5);
    expect(made[4].type).toBe('sine');
    expect(made[4].frequency.value).toBe(1400);
  });
});
