import type { V2 } from '../map/types';

/**
 * Small pure pieces of the line of fire (3.39), unit-tested: where DANGER CLOSE is judged, and the
 * hysteresis that keeps the MASKED state and the cut-away's marker list from flickering.
 */

/**
 * DANGER CLOSE: a live friendly within the gun's danger radius of where the round will actually land
 * (the first building on the line of fire, or the aim point when the line is clear), not the aim point.
 */
export function dangerCloseAt(landing: V2, friends: readonly { x: number; z: number; alive: boolean; home?: unknown }[], blastRadius: number): boolean {
  const r = blastRadius * 1.6 + 4;
  return friends.some((s) => s.alive && !s.home && Math.hypot(s.x - landing.x, s.z - landing.z) < r);
}

/** What `landing()` returns: the point of contact on the line of fire, and the building (-1: none). */
export interface Contact {
  x: number;
  y: number;
  z: number;
  building: number;
}

/**
 * Where a round fired at `aim` goes (buildings stop rounds; BACKLOG 3.41 moves this into the sim):
 * `fire` is the ground point handed to the sim (under the first building contact, or the aim point),
 * `mark` is where the MASKED impact mark is drawn: the same point, on the ground (y 0), where the
 * blast will actually be, not where the line of fire meets the wall.
 */
export function roundTarget(contact: Contact): { fire: V2; mark: { x: number; y: number; z: number }; blocked: boolean } {
  return { fire: { x: contact.x, z: contact.z }, mark: { x: contact.x, y: 0, z: contact.z }, blocked: contact.building >= 0 };
}

/**
 * A steady pointer at the screen edge for a point off screen (CSS px): the point where the line from
 * the screen centre toward it leaves the screen, `margin` px inside, and the direction (radians, 0 = right).
 */
export function edgePointer(x: number, y: number, w: number, h: number, margin = 28): { x: number; y: number; angle: number } {
  const cx = w / 2;
  const cy = h / 2;
  let dx = x - cx;
  let dy = y - cy;
  if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) dy = 1;
  const t = Math.min(Math.abs(dx) > 1e-6 ? (cx - margin) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? (cy - margin) / Math.abs(dy) : Infinity);
  dx *= Math.max(0, t);
  dy *= Math.max(0, t);
  return { x: cx + dx, y: cy + dy, angle: Math.atan2(y - cy, x - cx) };
}

/** MASKED: on as soon as the line is blocked, off only once it has been clear for OFF_AFTER seconds. */
export class MaskLatch {
  static readonly OFF_AFTER = 0.3;
  on = false;
  private clearFor = 0;
  update(blocked: boolean, dt: number): boolean {
    if (blocked) {
      this.on = true;
      this.clearFor = 0;
    } else if (this.on) {
      this.clearFor += Math.max(0, dt);
      if (this.clearFor >= MaskLatch.OFF_AFTER) this.on = false;
    }
    return this.on;
  }
}

/** Mission markers the cut-away keeps in sight: added inside IN metres of the aim, dropped beyond OUT. */
export class NearSet {
  private keys = new Set<string>();
  constructor(readonly IN = 60, readonly OUT = 68) {}
  /** Items are keyed by `id` when they have one (a label can change, e.g. DOORS: CLOSE), else by label. */
  update<T extends { label: string; p: V2; id?: string }>(items: readonly T[], aim: V2): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const d = Math.hypot(it.p.x - aim.x, it.p.z - aim.z);
      const key = it.id ?? it.label;
      seen.add(key);
      if (d < this.IN || (this.keys.has(key) && d <= this.OUT)) {
        this.keys.add(key);
        out.push(it);
      } else this.keys.delete(key);
    }
    for (const k of [...this.keys]) if (!seen.has(k)) this.keys.delete(k);
    return out;
  }
}
