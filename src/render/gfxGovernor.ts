/**
 * Picture quality tiers, and the governor that drops to the cheaper one on a slow device.
 *   high  full device resolution (up to 2x), 4x multisampling where supported, half-resolution
 *         bloom, silhouette outlines;
 *   low   1 device pixel per CSS pixel, no multisampling, quarter-resolution bloom, no outlines.
 * Pure logic (no three.js) so it can be unit tested.
 */
export type GfxTier = 'high' | 'low';

/** Mean frame time (seconds) above which the picture drops to `low`: about 32 fps. */
export const SLOW_FRAME = 1 / 32;
/** Frames ignored after the start (shader compiles, first uploads). */
const WARMUP_FRAMES = 90;
/** Frames averaged before each judgement. */
const WINDOW = 120;

/** `?gfx=high|low` forces a tier; `?gfx=auto` (or nothing) lets the governor decide. */
export function tierFromQuery(search: string): GfxTier | 'auto' {
  const v = new URLSearchParams(search).get('gfx');
  return v === 'high' || v === 'low' ? v : 'auto';
}

export class GfxGovernor {
  tier: GfxTier;
  private seen = 0;
  private sum = 0;
  private n = 0;
  /** True once it has dropped a tier (it never climbs back, so the picture can't pump). */
  dropped = false;

  constructor(start: GfxTier, private readonly auto: boolean) {
    this.tier = start;
  }

  /**
   * Feed one rendered frame's real duration (seconds). Returns the new tier when it changes, else null.
   * Pauses (a hidden tab, a long hitch over 0.25 s) are ignored rather than counted as slowness.
   */
  frame(dt: number): GfxTier | null {
    if (!this.auto || this.tier === 'low') return null;
    this.seen++;
    if (this.seen <= WARMUP_FRAMES || !(dt > 0) || dt > 0.25) return null;
    this.sum += dt;
    this.n++;
    if (this.n < WINDOW) return null;
    const mean = this.sum / this.n;
    this.sum = 0;
    this.n = 0;
    if (mean <= SLOW_FRAME) return null;
    this.tier = 'low';
    this.dropped = true;
    return 'low';
  }
}
