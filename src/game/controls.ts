/**
 * The game's controls as data: which key does what on which screen, the three views Q cycles through,
 * and the touch stick's response curve. Pure (no DOM, no three.js), so it is tested headless, and the
 * keyboard, the on-screen touch buttons and the hotkey strip all read the same table.
 *
 * Key map (3.11, owner: "R to cycle weapon, Q to cycle view, Esc to menu and briefing"):
 *   R          cycle gun 25 → 40 → 105 (was Q)        1 / 2 / 3   pick a gun
 *   Q          cycle view white-hot → black-hot → night vision (new)
 *   V          thermal ↔ night vision (unchanged)    H           white-hot ↔ black-hot (unchanged)
 *   Z zoom · WASD / arrows nudge the aim · M mute · Esc pause menu (Resume, Briefing, Restart, Settings, Quit)
 *   Paused: Esc resumes (or goes back from the briefing). R no longer restarts (it is the gun key now):
 *   use the pause menu's "Restart mission" button.
 *   Result screen: R retry, N next mission, after a short grace so an R pressed for the gun as the
 *   mission ends doesn't skip the debrief.
 */

export type ScreenName = 'briefing' | 'playing' | 'paused' | 'ended';

export type ControlAction =
  | 'weapon-next'
  | 'weapon-1'
  | 'weapon-2'
  | 'weapon-3'
  | 'view-next'
  | 'camera'
  | 'polarity'
  | 'zoom'
  | 'mute'
  | 'pause'
  | 'back'
  | 'retry'
  | 'next';

/** Seconds after the result screen appears before its R / N keys work. */
export const RESULT_KEY_GRACE = 1;
/** Seconds after pausing before Esc resumes (the Esc that freed the pointer must not also resume). */
export const PAUSE_ESC_GRACE = 0.3;

/**
 * What a key press means on a screen, or null. `key` is KeyboardEvent.key (any case).
 * `sinceScreen` is how long (seconds) the current screen has been showing.
 */
export function keyAction(key: string, screen: ScreenName, sinceScreen = Infinity): ControlAction | null {
  const k = key.toLowerCase();
  if (k === 'm') return 'mute';
  if (screen === 'ended') {
    if (sinceScreen < RESULT_KEY_GRACE) return null;
    if (k === 'r') return 'retry';
    if (k === 'n') return 'next';
    return null;
  }
  if (screen === 'paused') return k === 'escape' && sinceScreen >= PAUSE_ESC_GRACE ? 'back' : null;
  if (screen !== 'playing') return null;
  switch (k) {
    case 'escape':
      return 'pause';
    case 'r':
      return 'weapon-next';
    case '1':
      return 'weapon-1';
    case '2':
      return 'weapon-2';
    case '3':
      return 'weapon-3';
    case 'q':
      return 'view-next';
    case 'v':
      return 'camera';
    case 'h':
      return 'polarity';
    case 'z':
      return 'zoom';
    default:
      return null;
  }
}

export type SensorName = 'thermal' | 'night';
export interface View {
  sensor: SensorName;
  /** 0 white-hot, 1 black-hot (thermal only). */
  polarity: number;
}

/** Q / the VIEW button: white-hot → black-hot → night vision → white-hot. */
export function nextView(v: View): View {
  if (v.sensor === 'night') return { sensor: 'thermal', polarity: 0 };
  if (v.polarity < 0.5) return { sensor: 'thermal', polarity: 1 };
  return { sensor: 'night', polarity: v.polarity };
}

/** Short name of a view, for the VIEW button and the hotkey strip. */
export function viewLabel(v: View): string {
  return v.sensor === 'night' ? 'NV' : v.polarity >= 0.5 ? 'BH' : 'WH';
}

/** The HUD's cold-blooded count, with a hint naming the control the player really has (spec 002 feel M2). */
export function coldHint(n: number, sensor: string, touch: boolean): string {
  return `COLD-BLOODED ${n}${sensor === 'night' ? '' : touch ? ' (VIEW: NIGHT VISION)' : ' (V: NIGHT VISION)'}`;
}

/** The permanent strip on the desktop HUD (static text we wrote). */
export const HOTKEY_STRIP: readonly [string, string][] = [
  ['Hold LMB', 'fire'],
  ['R', 'weapon'],
  ['Q', 'view'],
  ['Z', 'zoom'],
  ['WASD', 'nudge'],
  ['Esc', 'menu'],
];

/** The one-line keys reminder (briefing card) for keyboard and mouse. */
export const KEYS_SENTENCE =
  'Controls: mouse to aim (click to capture the pointer) · hold left click to fire · R or 1/2/3 switch gun · Q cycle view (white-hot, black-hot, night vision) · V thermal/night · H white/black-hot · Z zoom · WASD nudge aim · M mute · Esc pause menu.';
/** The same for touch screens. */
export const TOUCH_SENTENCE =
  'Controls: drag the stick (bottom left) to aim, or tap the picture to aim there · hold FIRE to shoot · GUN switches gun · VIEW cycles white-hot, black-hot and night vision · ZOOM or pinch to zoom · II pauses.';

/** Stick: no movement inside this share of the radius (thumbs rest unevenly). */
export const STICK_DEADZONE = 0.12;
/** Aim speed at full deflection, in screen pixels per second (the WASD keys move 400). */
export const STICK_SPEED = 520;

/**
 * The stick's deflection from a thumb offset (px) and the stick radius (px): each axis in -1..1, clamped
 * to the circle, zero inside the dead zone and rising linearly to 1 at the rim.
 */
export function stickDeflection(dx: number, dy: number, radius: number): [number, number] {
  const r = Math.hypot(dx, dy);
  if (!(radius > 0) || r <= radius * STICK_DEADZONE) return [0, 0];
  const m = Math.min(1, (r / radius - STICK_DEADZONE) / (1 - STICK_DEADZONE));
  return [(dx / r) * m, (dy / r) * m];
}

/** How far (screen px) the aim moves this frame for a stick deflection: proportional to it, scaled by dt. */
export function stickNudge(d: [number, number], dt: number): [number, number] {
  return [d[0] * STICK_SPEED * dt, d[1] * STICK_SPEED * dt];
}

/** A short touch that barely moved is a tap (aim there), not a drag. */
export const TAP_MAX_MS = 450; // a long-press starts around 500 ms
export const TAP_MAX_PX = 12;
/** ...or lifted within this many drawn frames: on a struggling device, input waits for frames, so a quick tap looks slow. */
export const TAP_MAX_FRAMES = 2;
/** Pinch: fingers spread or closed by this ratio zooms one step. */
export const PINCH_STEP = 1.25;

/** One zoom step from a pinch, given the finger distance now and at the start of the step (or 0). */
export function pinchStep(start: number, now: number): -1 | 0 | 1 {
  if (!(start > 0)) return 0;
  if (now / start >= PINCH_STEP) return 1;
  if (now / start <= 1 / PINCH_STEP) return -1;
  return 0;
}
