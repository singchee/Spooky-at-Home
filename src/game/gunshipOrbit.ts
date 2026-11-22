import type { V2 } from '../map/types';

/**
 * Where the gunship flies (3.39), render and game side. The camera looks along the gun's real line
 * of fire, from the gunship to the aim point, so what you see is what you could hit.
 *
 * Over low-rise ground the gunship flies the sim's orbit exactly (src/sim/sim.ts ORBIT: 1000 m
 * radius around the mission's centre, 1500 m up). Over tall blocks it flies a tighter, steeper
 * orbit around the aim area (TIGHT_RADIUS: ~27° off vertical), so street canyons open up at some
 * points of the circle. Moderate on purpose (owner, after Paris): picking your moment in the orbit
 * should still matter. The sim still fires from its own orbit (flight times only); BACKLOG 3.39
 * lists the sim change that makes them the same.
 */
export interface OrbitShape {
  cx: number;
  cz: number;
  r: number;
}

/**
 * Orbit strength (tune after play). TIGHT_RADIUS: the orbit's radius over high-rise blocks, metres
 * (atan(750 / 1500) ≈ 27° off vertical, against ~34° on the sim's orbit). CENTRE_PULL: how far the
 * orbit's centre moves from the mission's centre toward the aim over high-rise blocks (0-1).
 */
export const TIGHT_RADIUS = 750;
export const CENTRE_PULL = 1;
/** City height (median of the built cells around the aim, metres) where the orbit starts / finishes tightening. */
export const TALL_FROM = 16;
export const TALL_TO = 28;
/** Easing time constant (s) and speed caps (m/s): the plane changes orbit like a plane, not a camera. */
export const ORBIT_TAU = 2;
export const CENTRE_SPEED = 160;
export const RADIUS_SPEED = 80;
/**
 * Reduced motion: the orbit only changes in one cut, after an aim move of RM_FAR metres or a pause in
 * firing of RM_IDLE s; never sooner than RM_GAP s after the last cut, only once the aim has been still
 * for RM_STILL s, and a change in the tall factor only counts once it has moved RM_K_STEP (no cuts
 * flickering back and forth at the edge of a high-rise district).
 */
export const RM_FAR = 150;
export const RM_IDLE = 1;
export const RM_GAP = 1.5;
export const RM_STILL = 0.4;
export const RM_K_STEP = 0.25;

/** 0 over low-rise ground, 1 over high-rise blocks (smooth in between). */
export function tallFactor(tallness: number): number {
  const t = Math.max(0, Math.min(1, (tallness - TALL_FROM) / (TALL_TO - TALL_FROM)));
  return t * t * (3 - 2 * t);
}

/** The orbit to fly for tall factor k: the sim's orbit at 0, the tight one around the aim at 1. */
export function orbitTarget(k: number, centre: V2, aim: V2, radius: number): OrbitShape {
  const c = k * CENTRE_PULL;
  return { cx: centre.x + (aim.x - centre.x) * c, cz: centre.z + (aim.z - centre.z) * c, r: radius + (TIGHT_RADIUS - radius) * k };
}

/** Degrees off vertical of the line from a ground point at horizontal distance `d` to a plane at `alt`. */
export function offVertical(d: number, alt: number): number {
  return (Math.atan2(d, alt) * 180) / Math.PI;
}

export class GunshipOrbit {
  shape: OrbitShape;
  /** Reduced motion: the tall factor and aim of the last cut, a clock, the last cut's time, how long the aim has been still. */
  private kHeld: number;
  private cutAim: V2;
  private prevAim: V2;
  private t = 0;
  private lastCut = -Infinity;
  private still = 0;
  /** Cuts so far (reduced motion), for tests. */
  cuts = 0;
  constructor(start: OrbitShape, aim: V2, k = 0) {
    this.shape = { ...start };
    this.kHeld = k;
    this.cutAim = { ...aim };
    this.prevAim = { ...aim };
  }

  /**
   * Fly toward the orbit for tall factor k around `aim` (the sim's orbit is `centre`, `radius`):
   * eased, dt-scaled and speed-capped; with reduced motion held, then changed in one cut (RM_*).
   */
  update(dt: number, k: number, centre: V2, aim: V2, radius: number, o: { reducedMotion: boolean; idle: number }): void {
    dt = Math.max(0, dt); // the first animation frame can stamp a time just before the game's start
    this.t += dt;
    const moved = Math.hypot(aim.x - this.prevAim.x, aim.z - this.prevAim.z);
    this.still = moved > 0.5 ? 0 : this.still + dt;
    this.prevAim = { ...aim };
    const s = this.shape;
    if (o.reducedMotion) {
      if (this.t - this.lastCut < RM_GAP || this.still < RM_STILL) return;
      const kNext = Math.abs(k - this.kHeld) >= RM_K_STEP ? k : this.kHeld;
      const far = Math.hypot(aim.x - this.cutAim.x, aim.z - this.cutAim.z) >= RM_FAR;
      if (!far && !(kNext !== this.kHeld && o.idle >= RM_IDLE)) return;
      const target = orbitTarget(kNext, centre, aim, radius);
      this.cutAim = { ...aim };
      const worth = Math.hypot(target.cx - s.cx, target.cz - s.cz) > 60 || Math.abs(target.r - s.r) > 60;
      if (!worth) return;
      this.kHeld = kNext;
      this.shape = { ...target };
      this.lastCut = this.t;
      this.cuts++;
      return;
    }
    this.kHeld = k;
    this.cutAim = { ...aim };
    const target = orbitTarget(k, centre, aim, radius);
    const a = 1 - Math.exp(-dt / ORBIT_TAU);
    let dx = (target.cx - s.cx) * a;
    let dz = (target.cz - s.cz) * a;
    const L = Math.hypot(dx, dz);
    const cap = CENTRE_SPEED * dt;
    if (L > cap && L > 0) {
      dx *= cap / L;
      dz *= cap / L;
    }
    s.cx += dx;
    s.cz += dz;
    const dr = (target.r - s.r) * a;
    s.r += Math.sign(dr) * Math.min(Math.abs(dr), RADIUS_SPEED * dt);
  }

  /** The gunship at orbit angle `angle` (radians, the sim's) and altitude `alt`. */
  position(angle: number, alt: number): { x: number; y: number; z: number } {
    const s = this.shape;
    return { x: s.cx + Math.cos(angle) * s.r, y: alt, z: s.cz + Math.sin(angle) * s.r };
  }
}

/**
 * The picture's "up" heading (radians, atan2 of x, z on the ground) turns toward `target` at no more
 * than `maxRate` rad/s, so it never flips when the gunship passes right over the aim point.
 */
export function turnHeading(current: number, target: number, maxRate: number, dt: number): number {
  let d = target - current;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const step = Math.max(0, maxRate * dt);
  return current + Math.max(-step, Math.min(step, d));
}
