import { afterEach, describe, expect, it, vi } from 'vitest';
import { sanitize, defaultSettings, updateSettings, _resetSettingsForTests } from '../src/ui/settings';
import { resolveReduced, reducedMotion, wantsStill, stillBecauseOfDevice, playAnimatedThisSession, _resetMotionForTests } from '../src/ui/motion';

const device = (reduce: boolean) => vi.stubGlobal('matchMedia', () => ({ matches: reduce, addEventListener() {}, removeEventListener() {} }));

afterEach(() => {
  vi.unstubAllGlobals();
  _resetSettingsForTests();
  _resetMotionForTests();
});

describe('motion setting', () => {
  it('defaults to following the device and sanitizes junk', () => {
    expect(defaultSettings().motion).toBe('device');
    expect(sanitize({ motion: 'full' }).motion).toBe('full');
    expect(sanitize({ motion: 'reduced' }).motion).toBe('reduced');
    expect(sanitize({ motion: 'always' }).motion).toBe('device');
    expect(sanitize({ motion: 3 }).motion).toBe('device');
    expect(sanitize(null).motion).toBe('device');
  });
  it('setting x device matrix', () => {
    expect(resolveReduced('device', true)).toBe(true);
    expect(resolveReduced('device', false)).toBe(false);
    expect(resolveReduced('full', true)).toBe(false);
    expect(resolveReduced('full', false)).toBe(false);
    expect(resolveReduced('reduced', true)).toBe(true);
    expect(resolveReduced('reduced', false)).toBe(true);
  });
  it('reducedMotion() reads the live setting and the device', () => {
    device(true);
    _resetSettingsForTests();
    expect(reducedMotion()).toBe(true);
    updateSettings({ motion: 'full' });
    expect(reducedMotion()).toBe(false);
    device(false);
    updateSettings({ motion: 'reduced' });
    expect(reducedMotion()).toBe(true);
  });
  it('the note shows only when the device is the reason; the session override never saves', () => {
    device(true);
    _resetSettingsForTests();
    expect(stillBecauseOfDevice()).toBe(true);
    expect(wantsStill()).toBe(true);
    playAnimatedThisSession();
    expect(wantsStill()).toBe(false);
    expect(stillBecauseOfDevice()).toBe(false);
    _resetMotionForTests();
    expect(wantsStill()).toBe(true); // a new session follows the device again
    updateSettings({ motion: 'reduced' });
    expect(stillBecauseOfDevice()).toBe(false);
  });
  it('Full motion beats Reduce flicker for stills; Reduce flicker alone still stills on device', () => {
    device(false);
    _resetSettingsForTests();
    updateSettings({ reduceFlicker: true });
    expect(wantsStill()).toBe(true);
    updateSettings({ motion: 'full' });
    expect(wantsStill()).toBe(false);
  });
});
