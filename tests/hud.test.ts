import { describe, expect, it } from 'vitest';
import { ammoText } from '../src/ui/hud';
import { weaponById } from '../src/sim/weapons';

describe('HUD ammo column', () => {
  it('shows ∞ for the unlimited 25 mm, never a count or a reload', () => {
    expect(ammoText(weaponById('25'), { ammo: Infinity, reloading: 0 })).toBe('∞');
    expect(ammoText(weaponById('25'), { ammo: Infinity, reloading: 2 })).toBe('∞');
  });
  it('keeps counts and reloads for the 40 mm and 105 mm', () => {
    expect(ammoText(weaponById('40'), { ammo: 5, reloading: 0 })).toBe('5/8');
    expect(ammoText(weaponById('105'), { ammo: 0, reloading: 2.06 })).toBe('RELOAD 2.1');
  });
});
