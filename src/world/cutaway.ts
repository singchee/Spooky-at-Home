import * as THREE from 'three';
import type { V2 } from '../map/types';
import { hideDistance, hideDistanceBound, HeightGrid, PrismIndex, segPolyDist, type Prism, type V3 } from './sightline';

/**
 * The building cut-away (3.39), subtle on purpose: firing round buildings should stay a puzzle (owner,
 * after Paris). Only a building that hides the aim point (or a mission marker near it) from the
 * gunship fades, and only the part of it above the line of sight: below the cut line it stays solid,
 * above it turns partly see-through (GHOST in shading.ts: ~45% opaque, roof line, corners and the cut
 * line as bright edges). Each building fades on its own over FADE_TIME (the cut line sweeps down), so
 * nothing pops. The fades live here (the truth, for the test hooks) and in a small float texture
 * the building shader reads by building index: no extra draw call for the solid part, one for the ghost.
 *
 * Also owns the line-of-sight index (MASKED reticle) and the height grid (the gunship's orbit).
 */

/** Buildings lower than this (metres) never cut away: houses don't hide streets. */
export const CUT_MIN_TOP = 12;
/** The cut line never goes lower than this, metres (footprints still read on the street). */
export const STUMP = 3;
/** Radius kept clear around the aim point, metres (a figure and a little room). */
export const AIM_KEEP = 8;
/** A building fades out or back in over this long, seconds. */
export const FADE_TIME = 0.25;
/** A building cut for a point within R comes back only once the point is R + this away (no toggling). */
const HYSTERESIS = 8;
/** Texture width (buildings per row). */
const TEX_W = 256;

export interface Keep {
  p: V2;
  /** Radius around p to keep clear, metres. */
  r: number;
}

export class Cutaway {
  readonly texture: THREE.DataTexture;
  readonly index: PrismIndex;
  readonly heights: HeightGrid;
  /** Current fade per building, 0 solid … 1 cut. */
  readonly fade: Float32Array;
  private target: Uint8Array;
  private tall: number[];
  private data: Float32Array;

  constructor(readonly prisms: Prism[], half: number) {
    // Texel k: (fade, top, cut height, unused).
    const n = Math.max(1, prisms.length);
    const rows = Math.ceil(n / TEX_W);
    this.data = new Float32Array(TEX_W * rows * 4);
    prisms.forEach((b, k) => {
      this.data[k * 4 + 1] = b.top;
      this.data[k * 4 + 2] = Math.min(b.top, STUMP);
    });
    this.texture = new THREE.DataTexture(this.data, TEX_W, rows, THREE.RGBAFormat, THREE.FloatType);
    this.texture.needsUpdate = true;
    this.fade = new Float32Array(prisms.length);
    this.target = new Uint8Array(prisms.length);
    this.tall = prisms.flatMap((b, k) => (b.top >= CUT_MIN_TOP ? [k] : []));
    this.index = new PrismIndex(prisms, half);
    this.heights = new HeightGrid(half, 20, prisms);
  }

  /** How many buildings are (partly) cut now. */
  get cutCount(): number {
    let n = 0;
    for (const f of this.fade) if (f > 0) n++;
    return n;
  }

  /**
   * Decide which tall buildings hide a kept point from `cam`, and where to cut them: at the height the
   * lowest line of sight from the kept area meets the building (below that it hides nothing). Then
   * ease each fade (dt-scaled).
   */
  update(cam: V3, keep: Keep[], dt: number): void {
    let changed = false;
    for (const k of this.tall) {
      const b = this.prisms[k];
      let d = Infinity;
      let cutAt = b.top;
      for (const q of keep) {
        if (hideDistanceBound(b, q.p, cam) - q.r > HYSTERESIS) continue;
        const dq = hideDistance(b, q.p, cam) - q.r;
        d = Math.min(d, dq);
        if (dq <= 0) cutAt = Math.min(cutAt, cutHeight(b, q, cam));
      }
      if (d <= 0) {
        this.target[k] = 1;
        // A fresh cut starts at its height; a standing one follows the aim smoothly (no jumping cut line).
        const was = this.data[k * 4 + 2];
        const now = this.fade[k] > 0 ? was + (cutAt - was) * (1 - Math.exp(-dt / 0.12)) : cutAt;
        if (Math.abs(now - was) > 0.01) {
          this.data[k * 4 + 2] = now;
          changed = true;
        }
      } else if (d > HYSTERESIS) this.target[k] = 0;
    }
    const step = dt / FADE_TIME;
    for (const k of this.tall) {
      const f = this.fade[k];
      const t = this.target[k];
      if (f === t) continue;
      const nf = t > f ? Math.min(t, f + step) : Math.max(t, f - step);
      this.fade[k] = nf;
      this.data[k * 4] = nf;
      changed = true;
    }
    if (changed) this.texture.needsUpdate = true;
  }

  /** The height the solid part of building k stands to now (the cut line, as the shader draws it). */
  solidTop(k: number): number {
    const b = this.prisms[k];
    const f = this.fade[k];
    if (f < 0.001) return b.top;
    const e = f * f * (3 - 2 * f);
    return Math.min(b.top, b.top + 0.5 + (this.data[k * 4 + 2] - b.top - 0.5) * e);
  }

  /** The building (index) between ground point p (height y0) and `from`, or -1: whole buildings (MASKED). */
  blocker(p: V2, from: V3, y0: number): number {
    return this.index.blocker(p, from, y0);
  }

  /** The same, counting only what is drawn solid after the cut-away (is p covered on screen?). */
  coverer(p: V2, from: V3, y0: number): number {
    return this.index.blocker(p, from, y0, (k) => this.solidTop(k));
  }

  dispose(): void {
    this.texture.dispose();
  }
}

/**
 * Where to cut building b for kept point q seen from cam: the height the line of sight from the near
 * edge of q's area reaches at the building's nearest point (never below STUMP, never above the top).
 */
export function cutHeight(b: Prism, q: Keep, cam: V3): number {
  const d = Math.max(0, segPolyDist(q.p, q.p, b.pts) - q.r);
  const slope = cam.y / Math.max(1, Math.hypot(cam.x - q.p.x, cam.z - q.p.z));
  return Math.max(Math.min(b.top, STUMP), Math.min(b.top, d * slope));
}
