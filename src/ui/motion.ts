/**
 * One place that decides "reduced motion". The Settings "Motion" choice (follow the device / full /
 * reduced) wins; "device" follows the OS `prefers-reduced-motion`. A session override ("Play
 * animated" on the intro/tour note) acts like Full for this page load only and is never saved
 * unless the player picks "Always". Motion is never switched on by itself.
 * `reduceFlicker` stays a separate setting (grain, flashes, camera kick).
 */
import { getSettings, onSettingsChange, updateSettings } from './settings';

export type MotionSetting = 'device' | 'full' | 'reduced';

const QUERY = '(prefers-reduced-motion: reduce)';
let sessionFull = false;
const listeners = new Set<() => void>();
let wired = false;

/** The device (OS / browser) asks for reduced motion. */
export function deviceWantsReduced(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia(QUERY).matches;
  } catch {
    return false;
  }
}

/** The effective choice, with the session override applied. */
export function motionMode(): MotionSetting {
  return sessionFull ? 'full' : getSettings().motion;
}

/** Pure rule, for tests: setting x device preference. */
export function resolveReduced(setting: MotionSetting, device: boolean): boolean {
  return setting === 'reduced' ? true : setting === 'full' ? false : device;
}

/** Should motion be reduced right now? (JS only; CSS uses the classes set by `syncMotionClass`.) */
export function reducedMotion(): boolean {
  return resolveReduced(motionMode(), deviceWantsReduced());
}

/**
 * Still frames for the intro, tour and diorama: reduced motion, or (unless the player chose Full
 * motion) Reduce flicker.
 */
export function wantsStill(): boolean {
  return motionMode() === 'full' ? false : reducedMotion() || getSettings().reduceFlicker;
}

/** True when stills are shown only because the device asks (not the player's own choice). */
export function stillBecauseOfDevice(): boolean {
  return motionMode() === 'device' && deviceWantsReduced();
}

/** Toggle `motion-reduced` / `motion-full` on <html> so CSS follows the same decision. */
export function syncMotionClass(): void {
  if (typeof document === 'undefined') return;
  const m = motionMode();
  const root = document.documentElement;
  root.classList.toggle('motion-reduced', m === 'reduced');
  root.classList.toggle('motion-full', m === 'full');
  root.classList.toggle('flicker-reduced', getSettings().reduceFlicker);
}

function notify(): void {
  syncMotionClass();
  for (const f of [...listeners]) f();
}

function wire(): void {
  if (wired) return;
  wired = true;
  onSettingsChange(notify);
  try {
    if (typeof matchMedia === 'function') matchMedia(QUERY).addEventListener('change', notify);
  } catch {
    /* no matchMedia (tests) */
  }
}

/** Call once at start-up. */
export function initMotion(): void {
  wire();
  syncMotionClass();
}

/** Subscribe to any change of the effective motion decision; returns an unsubscribe function. */
export function onMotionChange(f: () => void): () => void {
  wire();
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Full motion for this session only (the "Play animated" link). */
export function playAnimatedThisSession(): void {
  sessionFull = true;
  notify();
}

/** Save Full motion (the "Always" link). */
export function alwaysFullMotion(): void {
  updateSettings({ motion: 'full' });
}

export const MOTION_NOTE = {
  text: 'Showing still frames because your device asks for reduced motion',
  play: 'Play animated',
  always: 'Always',
};

/** The note (text plus two buttons, each at least 48 px). Null unless the device setting is the reason. */
export function buildMotionNote(onPlay: () => void): HTMLElement | null {
  if (!stillBecauseOfDevice()) return null;
  const p = document.createElement('p');
  p.className = 'motion-note';
  const t = document.createElement('span');
  t.textContent = `${MOTION_NOTE.text} · `;
  p.append(t);
  const mk = (cls: string, text: string, fn: () => void, label?: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `motion-link ${cls}`;
    b.textContent = text;
    if (label) b.setAttribute('aria-label', label);
    b.addEventListener('click', fn);
    p.append(b);
  };
  mk('motion-play', MOTION_NOTE.play, () => {
    playAnimatedThisSession();
    onPlay();
  });
  mk('motion-always', MOTION_NOTE.always, () => {
    alwaysFullMotion();
    onPlay();
  }, 'Always play animated (save in Settings)');
  return p;
}

/** For tests only. */
export function _resetMotionForTests(): void {
  sessionFull = false;
  listeners.clear();
}
