import { describe, expect, it } from 'vitest';
import { defaultSettings, sanitize, type Settings } from '../src/ui/settings';
import { CHOICES, SLIDERS, TOGGLES } from '../src/ui/settingsPanel';
import { effectiveReduceFlicker, mouseAimDelta } from '../src/game/input';

describe('settings panel controls', () => {
  it('has one labelled control for every setting', () => {
    const keys = [...SLIDERS.map((s) => s.key), ...TOGGLES.map((t) => t.key), ...CHOICES.map((c) => c.key)].sort(); // CHOICES (radio groups) added with the Motion setting, 3.30
    expect(keys).toEqual((Object.keys(defaultSettings()) as (keyof Settings)[]).sort());
    for (const c of [...SLIDERS, ...TOGGLES]) expect(c.label.length).toBeGreaterThan(3);
  });

  it('every slider position maps to a valid setting, and every default maps back onto the slider', () => {
    for (const s of SLIDERS) {
      for (let v = s.min; v <= s.max; v += s.step) {
        const value = s.toSetting(v);
        expect(sanitize({ [s.key]: value })[s.key], `${s.key} at ${v}`).toBe(value);
        expect(s.fromSetting(value)).toBe(v);
      }
      const d = s.fromSetting(defaultSettings()[s.key]);
      expect(d).toBeGreaterThanOrEqual(s.min);
      expect(d).toBeLessThanOrEqual(s.max);
      expect((d - s.min) % s.step).toBe(0);
    }
    expect(SLIDERS.find((s) => s.key === 'mouseSensitivity')!.text(150)).toBe('1.50×');
    expect(SLIDERS.find((s) => s.key === 'masterVolume')!.text(80)).toBe('80%');
  });
});

describe('settings wired into the game', () => {
  it('mouse sensitivity scales both axes; invert-Y flips only the vertical', () => {
    expect(mouseAimDelta(10, 4, { mouseSensitivity: 1, invertY: false })).toEqual([10, 4]);
    expect(mouseAimDelta(10, 4, { mouseSensitivity: 2, invertY: false })).toEqual([20, 8]);
    expect(mouseAimDelta(10, 4, { mouseSensitivity: 0.5, invertY: true })).toEqual([5, -2]);
  });

  it('reduce flicker follows the setting unless the game was given an explicit choice', () => {
    expect(effectiveReduceFlicker(undefined, { reduceFlicker: true })).toBe(true);
    expect(effectiveReduceFlicker(undefined, { reduceFlicker: false })).toBe(false);
    expect(effectiveReduceFlicker(false, { reduceFlicker: true })).toBe(false);
    expect(effectiveReduceFlicker(true, { reduceFlicker: false })).toBe(true);
  });
});
