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
  update<T extends { label: string; p: V2 }>(items: readonly T[], aim: V2): T[] {
    const out: T[] = [];
    const seen = new Set<string>();
    for (const it of items) {
      const d = Math.hypot(it.p.x - aim.x, it.p.z - aim.z);
      const key = it.label;
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
