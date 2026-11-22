import { describe, expect, it } from 'vitest';
import {
  HOTKEY_STRIP,
  PAUSE_ESC_GRACE,
  RESULT_KEY_GRACE,
  STICK_SPEED,
  keyAction,
  nextView,
  pinchStep,
  stickDeflection,
  stickNudge,
  viewLabel,
} from '../src/game/controls';

describe('key map (3.11)', () => {
  it('R cycles the gun, Q cycles the view, Esc opens the pause menu', () => {
    expect(keyAction('r', 'playing')).toBe('weapon-next');
    expect(keyAction('R', 'playing')).toBe('weapon-next');
    expect(keyAction('q', 'playing')).toBe('view-next');
    expect(keyAction('Escape', 'playing')).toBe('pause');
  });
  it('keeps the bindings that did not clash', () => {
    expect(keyAction('1', 'playing')).toBe('weapon-1');
    expect(keyAction('2', 'playing')).toBe('weapon-2');
    expect(keyAction('3', 'playing')).toBe('weapon-3');
    expect(keyAction('v', 'playing')).toBe('camera');
    expect(keyAction('h', 'playing')).toBe('polarity');
    expect(keyAction('z', 'playing')).toBe('zoom');
    expect(keyAction('m', 'playing')).toBe('mute');
    expect(keyAction('m', 'paused')).toBe('mute');
  });
  it('paused: R no longer restarts (it is the gun key now); Esc goes back after a short grace', () => {
    expect(keyAction('r', 'paused', 5)).toBeNull();
    expect(keyAction('q', 'paused', 5)).toBeNull();
    expect(keyAction('Escape', 'paused', 0.05)).toBeNull();
    expect(keyAction('Escape', 'paused', PAUSE_ESC_GRACE)).toBe('back');
  });
  it('result screen: R retries and N moves on, but not in the first moment (an R meant for the gun)', () => {
    expect(keyAction('r', 'ended', 0.2)).toBeNull();
    expect(keyAction('n', 'ended', 0.2)).toBeNull();
    expect(keyAction('r', 'ended', RESULT_KEY_GRACE)).toBe('retry');
    expect(keyAction('n', 'ended', RESULT_KEY_GRACE + 3)).toBe('next');
    expect(keyAction('q', 'ended', 9)).toBeNull();
  });
  it('the briefing screen takes no game keys', () => {
    for (const k of ['r', 'q', 'v', 'h', 'z', '1', 'Escape']) expect(keyAction(k, 'briefing')).toBeNull();
  });
  it('the hotkey strip names the new keys', () => {
    const text = HOTKEY_STRIP.map(([k, v]) => `${k} ${v}`).join(' · ');
    expect(text).toMatch(/R weapon/);
    expect(text).toMatch(/Q view/);
    expect(text).toMatch(/Esc menu/);
    expect(text).toMatch(/Z zoom/);
  });
});

describe('Q / VIEW cycles white-hot, black-hot, night vision', () => {
  it('goes round all three and back', () => {
    let v = { sensor: 'thermal' as const, polarity: 0 } as { sensor: 'thermal' | 'night'; polarity: number };
    const seen: string[] = [viewLabel(v)];
    for (let i = 0; i < 3; i++) {
      v = nextView(v);
      seen.push(viewLabel(v));
    }
    expect(seen).toEqual(['WH', 'BH', 'NV', 'WH']);
  });
  it('from night vision it always lands on white-hot thermal', () => {
    expect(nextView({ sensor: 'night', polarity: 1 })).toEqual({ sensor: 'thermal', polarity: 0 });
  });
});

describe('touch stick', () => {
  it('has a dead zone, is proportional to deflection, and clamps at the rim', () => {
    expect(stickDeflection(3, 0, 60)).toEqual([0, 0]);
    const [half] = stickDeflection(30, 0, 60);
    const [full] = stickDeflection(60, 0, 60);
    expect(full).toBeCloseTo(1);
    expect(half).toBeGreaterThan(0.3);
    expect(half).toBeLessThan(0.6);
    expect(stickDeflection(600, 0, 60)[0]).toBeCloseTo(1);
    const [x, y] = stickDeflection(0, -45, 60);
    expect(x).toBeCloseTo(0);
    expect(y).toBeLessThan(0);
  });
  it('moves the aim by speed x deflection x dt (frame-rate independent)', () => {
    const d: [number, number] = [0.5, -1];
    const once = stickNudge(d, 1 / 30);
    const twice = stickNudge(d, 1 / 60);
    expect(once[0]).toBeCloseTo(twice[0] * 2);
    expect(stickNudge([1, 0], 1)[0]).toBe(STICK_SPEED);
  });
  it('pinch: spreading zooms in a step, closing zooms out, small wobbles do nothing', () => {
    expect(pinchStep(100, 130)).toBe(1);
    expect(pinchStep(100, 75)).toBe(-1);
    expect(pinchStep(100, 110)).toBe(0);
    expect(pinchStep(0, 110)).toBe(0);
  });
});
