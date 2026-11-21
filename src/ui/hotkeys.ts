import { HOTKEY_STRIP } from '../game/controls';
import { getSettings, onSettingsChange } from './settings';
import { el } from './dom';

/**
 * The permanent key-hints strip on the mission HUD (3.11): "Hold LMB fire · R weapon · Q view ...".
 * Bottom left, under the radio captions and clear of the OSM attribution (style.css .hud-keys).
 * Hidden when the player turns it off in Settings, and by CSS when touch controls are showing.
 * Static text we wrote, set with textContent.
 */
export class HotkeyStrip {
  readonly el: HTMLDivElement;
  private off: () => void;

  constructor(parent: HTMLElement) {
    this.el = el('div', 'hud-keys', undefined, parent);
    this.el.setAttribute('aria-label', 'Keys');
    HOTKEY_STRIP.forEach(([key, what], i) => {
      if (i) el('span', 'hk-sep', ' · ', this.el);
      el('kbd', undefined, key, this.el);
      el('span', undefined, ` ${what}`, this.el);
    });
    const apply = () => (this.el.hidden = !getSettings().showHotkeys);
    apply();
    this.off = onSettingsChange(apply);
  }

  dispose(): void {
    this.off();
    this.el.remove();
  }
}
