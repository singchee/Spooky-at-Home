/**
 * Player settings: one shared contract for the whole game (audio, controls, comfort).
 * Stored only in this browser (localStorage, wrapped in try/catch). Never sent anywhere.
 * Owners: the settings panel (UI) writes; audio, input and rendering read and subscribe.
 */
export interface Settings {
  /** 0..1 */
  masterVolume: number;
  musicVolume: number;
  sfxVolume: number;
  radioVolume: number;
  muted: boolean;
  /** Multiplies mouse aim speed; 1 = default. */
  mouseSensitivity: number;
  invertY: boolean;
  /** Calmer camera and switch effects; defaults to the OS reduced-motion preference. */
  reduceFlicker: boolean;
  /** The key-hints strip along the bottom of the mission HUD (keyboard and mouse only). */
  showHotkeys: boolean;
}

const KEY = 'spooky.settings';

export function defaultSettings(): Settings {
  let reduce = false;
  try {
    reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    /* no matchMedia (tests) */
  }
  return { masterVolume: 0.8, musicVolume: 0.6, sfxVolume: 0.9, radioVolume: 0.8, muted: false, mouseSensitivity: 1, invertY: false, reduceFlicker: reduce, showHotkeys: true };
}

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d);

/** Accepts anything (e.g. an old or edited stored value) and returns valid settings. */
export function sanitize(raw: unknown): Settings {
  const d = defaultSettings();
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<Settings>;
  return {
    masterVolume: clamp(r.masterVolume, 0, 1, d.masterVolume),
    musicVolume: clamp(r.musicVolume, 0, 1, d.musicVolume),
    sfxVolume: clamp(r.sfxVolume, 0, 1, d.sfxVolume),
    radioVolume: clamp(r.radioVolume, 0, 1, d.radioVolume),
    muted: typeof r.muted === 'boolean' ? r.muted : d.muted,
    mouseSensitivity: clamp(r.mouseSensitivity, 0.25, 3, d.mouseSensitivity),
    invertY: typeof r.invertY === 'boolean' ? r.invertY : d.invertY,
    reduceFlicker: typeof r.reduceFlicker === 'boolean' ? r.reduceFlicker : d.reduceFlicker,
    showHotkeys: typeof r.showHotkeys === 'boolean' ? r.showHotkeys : d.showHotkeys,
  };
}

let current: Settings | null = null;
const listeners = new Set<(s: Settings) => void>();

export function getSettings(): Settings {
  if (!current) {
    let stored: unknown = null;
    try {
      stored = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    } catch {
      /* private window, blocked storage, or no localStorage (tests) */
    }
    current = sanitize(stored);
  }
  return current;
}

export function updateSettings(patch: Partial<Settings>): Settings {
  current = sanitize({ ...getSettings(), ...patch });
  try {
    localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* storage unavailable: keep the in-memory value */
  }
  for (const f of listeners) f(current);
  return current;
}

/** Subscribe to changes; returns an unsubscribe function. */
export function onSettingsChange(f: (s: Settings) => void): () => void {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** For tests only. */
export function _resetSettingsForTests(): void {
  current = null;
  listeners.clear();
}
