import type { Settings } from '../ui/settings';

/**
 * How the player's settings shape input (pure, so it is tested without a browser).
 * Mouse movement is scaled by the sensitivity; invert-Y flips the vertical axis (mouse only:
 * the WASD nudge keys always move the way they point).
 */
export function mouseAimDelta(dx: number, dy: number, s: Pick<Settings, 'mouseSensitivity' | 'invertY'>): [number, number] {
  const k = s.mouseSensitivity;
  return [dx * k, dy * k * (s.invertY ? -1 : 1)];
}

/** Reduce flicker: an explicit game option wins (tests, demos); otherwise the player's setting, live. */
export function effectiveReduceFlicker(option: boolean | undefined, s: Pick<Settings, 'reduceFlicker'>): boolean {
  return option ?? s.reduceFlicker;
}
