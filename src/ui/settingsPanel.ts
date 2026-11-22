import { defaultSettings, getSettings, onSettingsChange, updateSettings, type Settings } from './settings';
import { el } from './dom';
import { placeCache } from './placeCache';
import { forgetWaits } from './loadEstimate';

/**
 * The settings panel: volumes, mouse, comfort. Opens over the pause screen, the front page or the menu.
 * Every control is a native, labelled input, so it works with the keyboard and screen readers.
 * Changes apply at once (through the shared settings contract) and are stored only in this browser.
 */
type NumberKey = { [K in keyof Settings]: Settings[K] extends number ? K : never }[keyof Settings];
type BoolKey = { [K in keyof Settings]: Settings[K] extends boolean ? K : never }[keyof Settings];

export interface SliderDef {
  key: NumberKey;
  label: string;
  group: 'sound' | 'controls';
  /** Slider units (whole numbers, so arrow keys step cleanly). */
  min: number;
  max: number;
  step: number;
  toSetting(v: number): number;
  fromSetting(s: number): number;
  text(v: number): string;
}
export interface ToggleDef {
  key: BoolKey;
  label: string;
  group: 'sound' | 'controls' | 'comfort';
  hint?: string;
}

const pct = (key: NumberKey, label: string): SliderDef => ({
  key, label, group: 'sound', min: 0, max: 100, step: 5,
  toSetting: (v) => v / 100,
  fromSetting: (s) => Math.round(s * 100),
  text: (v) => `${v}%`,
});

export const SLIDERS: readonly SliderDef[] = [
  pct('masterVolume', 'Master volume'),
  pct('musicVolume', 'Music'),
  pct('sfxVolume', 'Guns and effects'),
  pct('radioVolume', 'Radio'),
  {
    key: 'mouseSensitivity', label: 'Mouse sensitivity', group: 'controls', min: 25, max: 300, step: 5,
    toSetting: (v) => v / 100,
    fromSetting: (s) => Math.round(s * 100),
    text: (v) => `${(v / 100).toFixed(2)}×`,
  },
];

export const TOGGLES: readonly ToggleDef[] = [
  { key: 'muted', label: 'Mute all sound', group: 'sound', hint: 'M in a mission' },
  { key: 'invertY', label: 'Invert vertical aim', group: 'controls', hint: 'Mouse up moves the aim down' },
  { key: 'showHotkeys', label: 'Show key hints', group: 'controls', hint: 'The strip of keys along the bottom of a mission (not shown with touch controls)' },
  { key: 'reduceFlicker', label: 'Reduce flicker', group: 'comfort', hint: 'No camera kick from the 105, and camera switches fade instead of flashing static' },
];

const GROUPS: { id: 'sound' | 'controls' | 'comfort'; title: string }[] = [
  { id: 'sound', title: 'Sound' },
  { id: 'controls', title: 'Controls' },
  { id: 'comfort', title: 'Comfort' },
];

let uid = 0;

export interface SettingsPanelOptions {
  /** Called after the panel closes (Done, Esc or clicking outside it). */
  onClose?(): void;
}

/** Opens the panel; returns a function that closes it. */
export function openSettingsPanel(parent: HTMLElement, o: SettingsPanelOptions = {}): () => void {
  const id = `set${++uid}`;
  const returnFocus = document.activeElement as HTMLElement | null;
  const backdrop = el('div', 'settings-backdrop', undefined, parent);
  const panel = el('div', 'card settings-panel', undefined, backdrop);
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-labelledby', `${id}-title`);
  panel.tabIndex = -1; // a click on the panel's background keeps the keyboard inside it
  const title = el('h2', undefined, 'Settings', panel);
  title.id = `${id}-title`;

  const sync: ((s: Settings) => void)[] = [];
  for (const g of GROUPS) {
    const box = el('fieldset', 'settings-group', undefined, panel);
    el('legend', undefined, g.title, box);
    for (const d of SLIDERS.filter((x) => x.group === g.id)) {
      const row = el('div', 'settings-row', undefined, box);
      const label = el('label', undefined, d.label, row);
      label.htmlFor = `${id}-${d.key}`;
      const input = el('input', undefined, undefined, row);
      input.type = 'range';
      input.id = `${id}-${d.key}`;
      input.min = String(d.min);
      input.max = String(d.max);
      input.step = String(d.step);
      const out = el('output', 'settings-value', undefined, row);
      out.htmlFor.add(input.id);
      const show = (v: number) => {
        input.value = String(v);
        out.textContent = d.text(v);
        input.setAttribute('aria-valuetext', d.text(v));
      };
      input.addEventListener('input', () => {
        const v = Number(input.value);
        show(v);
        updateSettings({ [d.key]: d.toSetting(v) } as Partial<Settings>);
      });
      sync.push((s) => show(d.fromSetting(s[d.key])));
    }
    for (const d of TOGGLES.filter((x) => x.group === g.id)) {
      const row = el('div', 'settings-row settings-toggle', undefined, box);
      const input = el('input', undefined, undefined, row);
      input.type = 'checkbox';
      input.id = `${id}-${d.key}`;
      const label = el('label', undefined, d.label, row);
      label.htmlFor = input.id;
      if (d.hint) {
        const hint = el('span', 'settings-hint', d.hint, row);
        hint.id = `${input.id}-hint`;
        input.setAttribute('aria-describedby', hint.id);
      }
      input.addEventListener('change', () => updateSettings({ [d.key]: input.checked } as Partial<Settings>));
      sync.push((s) => (input.checked = s[d.key]));
    }
  }
  // Places kept on this device (BACKLOG 3.12). Only a count and a size are shown here, never the places.
  const places = el('fieldset', 'settings-group settings-places', undefined, panel);
  el('legend', undefined, 'Saved places', places);
  const placesText = el('p', 'small', 'Checking this browser…', places);
  placesText.setAttribute('aria-live', 'polite');
  const forgetAll = el('button', 'settings-forget-places', 'Forget all saved places', places);
  forgetAll.type = 'button';
  forgetAll.disabled = true;
  el('p', 'small', 'Places you scout are kept in this browser for 30 days so they open instantly next time. They are never sent anywhere.', places);
  const countPlaces = async () => {
    const list = await placeCache().list();
    const mb = list.reduce((s, i) => s + i.bytes, 0) / (1024 * 1024);
    placesText.textContent = list.length
      ? `${list.length} place${list.length === 1 ? '' : 's'} saved on this device (${mb < 0.1 ? 'under 0.1' : mb.toFixed(1)} MB).`
      : 'No places saved on this device.';
    forgetAll.disabled = !list.length;
  };
  void countPlaces();
  forgetAll.addEventListener('click', async () => {
    forgetAll.disabled = true;
    forgetWaits(); // this device's load times (the scouting estimate) go too
    const ok = await placeCache().forgetAll();
    if (ok) await countPlaces();
    else {
      placesText.textContent = "This browser wouldn't let the game clear them. Clearing this site's data in the browser settings removes them too.";
      forgetAll.disabled = false;
    }
    if (forgetAll.disabled) done.focus(); // the button that had focus is now disabled
  });

  el('p', 'small', 'Saved in this browser only.', panel);
  const row = el('div', 'row settings-actions', undefined, panel);
  const reset = el('button', undefined, 'Reset to defaults', row);
  reset.type = 'button';
  reset.addEventListener('click', () => updateSettings(defaultSettings()));
  const done = el('button', 'primary', 'Done', row);
  done.type = 'button';

  const refresh = (s: Settings) => sync.forEach((f) => f(s));
  refresh(getSettings());
  // Stay in step with changes made elsewhere (e.g. M mutes in a mission).
  const off = onSettingsChange(refresh);

  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    off();
    backdrop.remove();
    if (returnFocus?.isConnected) returnFocus.focus();
    o.onClose?.();
  };
  done.addEventListener('click', close);
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close();
  });
  // Keys stay inside the panel: Esc closes it, Tab cycles through it, and no game hotkey fires underneath.
  panel.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
      return;
    }
    if (e.key !== 'Tab') return;
    const items = [...panel.querySelectorAll<HTMLElement>('input, button')];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });
  panel.addEventListener('keyup', (e) => e.stopPropagation());
  panel.querySelector<HTMLInputElement>('input')?.focus();
  return close;
}
