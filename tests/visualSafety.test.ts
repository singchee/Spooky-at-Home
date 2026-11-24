import { describe, expect, it } from 'vitest';
import { cameraShakePx, Effects, RUMBLE, rumbleFalloff, rumbleOffsetPx, SHAKE_MAX_PX, SHAKE_TIME, shakeOffsetPx } from '../src/game/effects';
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

describe('105 rumble (owner playtest 1): kick and rumble together keep the 105 kick rule', () => {
  const len = (o: { x: number; y: number }) => Math.hypot(o.x, o.y);
  /** Kick and rumble together, `t` s after a 105 lands `d` m from the aim point. */
  const both = (d: number, at: number[], still = false) => {
    const fx = new Effects();
    for (const t0 of at) fx.impact('105', 0, 0, t0, d);
    return { fx, at: (t: number) => cameraShakePx(fx, t, still) };
  };
  const samples = (f: (t: number) => { x: number; y: number }, fps: number, from = 0) =>
    Array.from({ length: Math.ceil(fps * 1.2) }, (_, i) => f(from + i / fps));
  /** Swings along a screen axis, counted as the safety playtest counts them (a change of 1 px or more). */
  const swings = (os: { x: number; y: number }[], dir: { x: number; y: number }) => {
    let n = 0;
    let sign = 0;
    let ext = 0;
    for (const o of os) {
      const v = o.x * dir.x + o.y * dir.y;
      const d = v - ext;
      if (Math.abs(d) < 1) continue;
      if (Math.sign(d) !== sign) n++;
      sign = Math.sign(d);
      ext = v;
    }
    return n;
  };
  const KICK = { x: 0.34, y: 0.94 };
  const ACROSS = { x: 0.94, y: -0.34 };

  it('has a tunable strength and never moves the picture more than SHAKE_MAX_PX (5) in all, at any frame rate', () => {
    expect(RUMBLE.strength).toBeGreaterThan(0);
    expect(SHAKE_MAX_PX).toBeLessThanOrEqual(5);
    for (const fps of [30, 60, 144, 1000]) {
      for (const at of [[0], [0, 0.03], [0, 0.1, 0.2]]) {
        for (const o of samples(both(0, at).at, fps)) expect(len(o)).toBeLessThanOrEqual(SHAKE_MAX_PX + 1e-9);
      }
    }
  });

  it('is clearly felt: a sideways swing of several pixels, so the picture rolls instead of only nudging', () => {
    const near = samples(both(0, [0]).at, 1000);
    const side = Math.max(...near.map((o) => Math.abs(o.x * ACROSS.x + o.y * ACROSS.y)));
    expect(side).toBeGreaterThan(2.5);
    expect(Math.max(...near.map(len))).toBeGreaterThan(4); // the whole jolt stays as big as the kick was
  });

  it('is one damped swing per axis (at most two swings, as the safety playtest counts them), settled by 0.5 s', () => {
    for (const at of [[0], [0, 0.03]]) {
      const os = samples(both(0, at).at, 1000);
      expect(swings(os, KICK)).toBeLessThanOrEqual(2);
      expect(swings(os, ACROSS)).toBeLessThanOrEqual(2);
    }
    const { at } = both(0, [0]);
    expect(RUMBLE.delay + RUMBLE.time).toBeLessThanOrEqual(0.5);
    expect(len(at(RUMBLE.delay + RUMBLE.time + 0.01))).toBe(0);
    expect(RUMBLE.hz).toBeLessThan(5);
  });

  it('scales with the distance from the aim point: full near it, only the kick far away', () => {
    expect(rumbleFalloff(0)).toBe(1);
    expect(rumbleFalloff(RUMBLE.near)).toBe(1);
    expect(rumbleFalloff((RUMBLE.near + RUMBLE.range) / 2)).toBeCloseTo(0.5);
    expect(rumbleFalloff(RUMBLE.range)).toBe(0);
    expect(rumbleFalloff(NaN)).toBe(0);
    const side = (d: number) => Math.max(...samples((t) => rumbleOffsetPx([{ t0: 0, amp: rumbleFalloff(d) }], t), 1000).map(len));
    expect(side(10)).toBeGreaterThan(side(90));
    expect(side(90)).toBeGreaterThan(0);
    expect(side(400)).toBe(0);
    // Far away: no rumble, and the kick is untouched.
    const far = both(400, [0]);
    expect(far.at(0.08)).toEqual(far.fx.shakePx(0.08));
  });

  it('is the same at any frame rate: the picture at a moment does not depend on how frames were stepped', () => {
    const run = (dt: number) => {
      const fx = new Effects();
      const seen = new Map<string, number>();
      for (let t = 0; t <= 2 + 1e-9; t += dt) {
        fx.update(t, dt);
        if (Math.abs(t - 0.5) < dt / 2) fx.impact('105', 0, 0, 0.5, 30);
        for (const probe of [0.6, 0.75, 0.9]) if (Math.abs(t - probe) < 1e-6) seen.set(String(probe), len(cameraShakePx(fx, probe, false)));
      }
      fx.dispose();
      return seen;
    };
    const a = run(1 / 20);
    const b = run(1 / 100);
    for (const k of ['0.6', '0.75', '0.9']) expect(b.get(k)).toBeCloseTo(a.get(k)!, 9);
  });

  it('only a 105 rumbles; reduced motion (or Reduce flicker) turns the whole shake off', () => {
    const fx = new Effects();
    fx.impact('40', 0, 0, 1, 0);
    expect(len(fx.rumblePx(1.2))).toBe(0);
    fx.impact('105', 0, 0, 2, 0);
    expect(len(fx.rumblePx(2.15))).toBeGreaterThan(1);
    expect(len(cameraShakePx(fx, 2.15, true))).toBe(0);
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
