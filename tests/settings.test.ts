import { describe, expect, it } from 'vitest';
import { sanitize, defaultSettings, getSettings, updateSettings, onSettingsChange, _resetSettingsForTests } from '../src/ui/settings';

describe('settings contract', () => {
  it('sanitizes junk and out-of-range values', () => {
    const s = sanitize({ masterVolume: 7, musicVolume: -1, mouseSensitivity: 'fast', invertY: 'yes' });
    expect(s.masterVolume).toBe(1);
    expect(s.musicVolume).toBe(0);
    expect(s.mouseSensitivity).toBe(defaultSettings().mouseSensitivity);
    expect(s.invertY).toBe(false);
    expect(sanitize(null)).toEqual(defaultSettings());
  });
  it('key hints show by default and the stored choice survives sanitizing', () => {
    expect(defaultSettings().showHotkeys).toBe(true);
    expect(sanitize({ showHotkeys: false }).showHotkeys).toBe(false);
    expect(sanitize({ showHotkeys: 'no' }).showHotkeys).toBe(true);
  });
  it('updates notify subscribers and survive without localStorage', () => {
    _resetSettingsForTests();
    let seen = -1;
    const off = onSettingsChange((s) => (seen = s.musicVolume));
    updateSettings({ musicVolume: 0.25 });
    expect(seen).toBe(0.25);
    expect(getSettings().musicVolume).toBe(0.25);
    off();
    updateSettings({ musicVolume: 0.5 });
    expect(seen).toBe(0.25);
  });
});
