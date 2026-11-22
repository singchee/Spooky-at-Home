import * as THREE from 'three';
import type { MapData, V2 } from '../map/types';
import { centroid, pointInPolygon } from '../map/geom';
import { CATEGORY_INFO, mapFeatures } from '../map/recon';
import { likelyWaveDirections, type Mission, type WaveDirection } from '../sim/missions';
import { ORBIT } from '../sim/sim';
import type { RoadGraph } from '../map/roadGraph';
import { briefingMap, focusView } from './tacticalMap';
import { getSettings, onSettingsChange } from './settings';
import { el } from './dom';

/**
 * The briefing's "blocky" diorama: a small, slowly turning 3D model of the mission area, built
 * from MapData + Mission with its own little three.js renderer (never the game's), beside the 2D
 * tactical map. Normal display colours (not sensor values), consistent with the tactical map's
 * --tm-* palette.
 *
 * Colours: the app switches three's colour management off and this renderer writes shader output
 * straight to the screen (LinearSRGB output, no conversion), so every colour here is a plain sRGB
 * hex as you'd write it in CSS. Lighting is baked into vertex colours at build time with a fixed
 * "sun", so what's written here is what's shown.
 *
 * Text: labels are HTML, positioned by projecting 3D points, and go in via textContent only
 * (OpenStreetMap names are untrusted). Privacy: nothing here marks or labels the player's own typed
 * address; labels are public landmarks (recon features) and the mission's own places only.
 */

// ---------------------------------------------------------------------------------------------
// Pure helpers (no DOM, no WebGL): tested in tests/briefingDiorama.test.ts
// ---------------------------------------------------------------------------------------------

/** An axis-aligned rectangle of the map, metres (x east, z south). */
export interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

/**
 * The part of the map the diorama models: the same square as the briefing's tactical map (its
 * focus view), trimmed to where the map has data.
 */
export function dioramaExtent(map: MapData, mission: Mission): Rect {
  const half = map.half;
  const pad = half * 0.03;
  const v = focusView(mission, { x0: -half - pad, z0: -half - pad, span: 2 * (half + pad) });
  return { x0: Math.max(-half, v.x0), z0: Math.max(-half, v.z0), x1: Math.min(half, v.x0 + v.span), z1: Math.min(half, v.z0 + v.span) };
}

const inside = (p: V2, r: Rect) => p.x >= r.x0 && p.x <= r.x1 && p.z >= r.z0 && p.z <= r.z1;

/** Sutherland–Hodgman: the part of a polygon inside the rectangle (may be empty). */
export function clipPolygon(pts: V2[], r: Rect): V2[] {
  let out = pts;
  const edges: [(p: V2) => boolean, (a: V2, b: V2) => V2][] = [
    [(p) => p.x >= r.x0, (a, b) => lerpAt(a, b, (r.x0 - a.x) / (b.x - a.x))],
    [(p) => p.x <= r.x1, (a, b) => lerpAt(a, b, (r.x1 - a.x) / (b.x - a.x))],
    [(p) => p.z >= r.z0, (a, b) => lerpAt(a, b, (r.z0 - a.z) / (b.z - a.z))],
    [(p) => p.z <= r.z1, (a, b) => lerpAt(a, b, (r.z1 - a.z) / (b.z - a.z))],
  ];
  for (const [isIn, cut] of edges) {
    if (!out.length) break;
    const next: V2[] = [];
    for (let i = 0; i < out.length; i++) {
      const a = out[(i + out.length - 1) % out.length];
      const b = out[i];
      const ai = isIn(a);
      const bi = isIn(b);
      if (bi) {
        if (!ai) next.push(cut(a, b));
        next.push(b);
      } else if (ai) next.push(cut(a, b));
    }
    out = next;
  }
  return out;
}

const lerpAt = (a: V2, b: V2, t: number): V2 => ({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });

/** Liang–Barsky per segment: the pieces of a polyline inside the rectangle. */
export function clipPolyline(pts: V2[], r: Rect): V2[][] {
  const out: V2[][] = [];
  let cur: V2[] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    let t0 = 0;
    let t1 = 1;
    let ok = true;
    for (const [p, q] of [[-dx, a.x - r.x0], [dx, r.x1 - a.x], [-dz, a.z - r.z0], [dz, r.z1 - a.z]] as const) {
      if (p === 0) {
        if (q < 0) ok = false;
        continue;
      }
      const t = q / p;
      if (p < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
    if (!ok || t0 > t1) {
      cur = null;
      continue;
    }
    const s = t0 > 0 ? lerpAt(a, b, t0) : a;
    const e = t1 < 1 ? lerpAt(a, b, t1) : b;
    if (!cur || t0 > 0) {
      cur = [s];
      out.push(cur);
    }
    cur.push(e);
    if (t1 < 1) cur = null;
  }
  return out.filter((l) => l.length >= 2);
}

/** One flat arrow on the ground: a shaft and a head, as triangles in map metres. */
export interface ArrowShape {
  shaft: [V2, V2, V2, V2];
  head: [V2, V2, V2];
  /** Where the label goes: the start of the arrow inside the diorama. */
  start: V2;
  tip: V2;
}

/** Everything the mission draws in 3D, as plain data (so it can be tested without WebGL). */
export interface MissionOverlay {
  discs: { c: V2; r: number; cold: boolean }[];
  route: V2[][];
  friendlies: V2[];
  home: V2 | null;
  safehouse: V2[] | null;
  anchor: V2[] | null;
  arrows: (ArrowShape & { compass: string })[];
  waveZone: { c: V2; r0: number; r1: number } | null;
  orbit: { c: V2; r: number };
}

/** Horde zones are drawn at their true milling radius, as on the tactical map. */
export const HORDE_R = 30;

export function missionOverlay(m: Mission, waves: WaveDirection[], box: Rect): MissionOverlay {
  const arrows: MissionOverlay['arrows'] = [];
  if (m.waves && m.type === 'defend' && m.safehouse) {
    for (const w of waves) {
      const a = arrowShape(w.from, w.to, m.waves.minDist * 0.45, box);
      if (a) arrows.push({ ...a, compass: w.compass });
    }
  }
  return {
    discs: m.hordes.map((h) => ({ c: h.centre, r: HORDE_R, cold: h.cold > 0 })),
    route: m.route ? clipPolyline(m.route, box) : [],
    friendlies: m.survivors.filter((s) => !s.route).map((s) => s.start),
    home: m.home ? m.home.centre : null,
    safehouse: m.safehouse ? m.safehouse.poly : null,
    anchor: m.anchor?.pts && m.anchor.pts.length >= 3 ? clipPolygon(m.anchor.pts, box) : null,
    arrows,
    waveZone: m.waves && m.type === 'defend' && m.safehouse ? { c: m.safehouse.centre, r0: m.waves.minDist, r1: m.waves.maxDist } : null,
    orbit: { c: m.orbitCentre, r: ORBIT.radius },
  };
}

/** An arrow from `from` toward `to`, stopping `stopShort` metres before it, clipped to the box. */
export function arrowShape(from: V2, to: V2, stopShort: number, box: Rect, shaftW = 14, headW = 42, headL = 44): ArrowShape | null {
  const L = Math.hypot(to.x - from.x, to.z - from.z);
  if (L <= stopShort + headL) return null;
  const ux = (to.x - from.x) / L;
  const uz = (to.z - from.z) / L;
  const tip = { x: to.x - ux * stopShort, z: to.z - uz * stopShort };
  const base = { x: tip.x - ux * headL, z: tip.z - uz * headL };
  const seg = clipPolyline([from, base], box)[0];
  if (!seg) return null;
  const s = seg[0];
  const e = seg[seg.length - 1];
  if (Math.hypot(e.x - s.x, e.z - s.z) < 10) return null;
  const nx = -uz;
  const nz = ux;
  const off = (p: V2, k: number): V2 => ({ x: p.x + nx * k, z: p.z + nz * k });
  return {
    shaft: [off(s, shaftW / 2), off(e, shaftW / 2), off(e, -shaftW / 2), off(s, -shaftW / 2)],
    head: [tip, off(base, headW / 2), off(base, -headW / 2)],
    start: s,
    tip,
  };
}

/** A place to label in the diorama. `y` is the height (metres) of the point the label points at. */
export interface LabelSpec {
  id: string;
  text: string;
  kind: 'safe' | 'home' | 'hostile' | 'friendly' | 'wave' | 'place' | 'anchor' | 'north';
  p: V2;
  y: number;
  priority: number;
  /** Gap (px) between the label and its point: longer for things the label must not cover. */
  gap?: number;
}

/** Longest label, in characters (longer OpenStreetMap names are cut with an ellipsis). */
const LABEL_MAX = 26;
const clip = (s: string) => (s.length > LABEL_MAX ? `${s.slice(0, LABEL_MAX - 1)}…` : s);

/**
 * What gets a label: the mission's own places (safehouse, home, hordes, friendlies, wave
 * directions), the recon place it's built around, then public landmarks (recon features with a
 * name, most important first). Never the player's own typed address: it isn't a feature, so it
 * can't appear here.
 */
export function labelSpecs(map: MapData, m: Mission, waves: WaveDirection[], box: Rect, heightAt: (p: V2) => number = () => 0): LabelSpec[] {
  const out: LabelSpec[] = [];
  // Which way is north, on the plinth's north edge (the model turns; the tactical map doesn't).
  out.push({ id: 'north', text: 'N', kind: 'north', p: { x: (box.x0 + box.x1) / 2, z: box.z0 }, y: 0, priority: 120, gap: 6 });
  if (m.safehouse) out.push({ id: 'safehouse', text: 'SAFEHOUSE', kind: 'safe', p: m.safehouse.centre, y: heightAt(m.safehouse.centre) + 2, priority: 100, gap: 20 });
  if (m.home) out.push({ id: 'home', text: 'HOME', kind: 'home', p: m.home.centre, y: PIN_TOP, priority: 96 });
  // Hordes at the same place share one label, as on the tactical map.
  const groups = new Map<string, Mission['hordes']>();
  for (const h of m.hordes) groups.set(h.label, [...(groups.get(h.label) ?? []), h]);
  let k = 0;
  for (const hs of groups.values()) {
    const c = { x: hs.reduce((s, h) => s + h.centre.x, 0) / hs.length, z: hs.reduce((s, h) => s + h.centre.z, 0) / hs.length };
    const n = hs.reduce((s, h) => s + h.count, 0);
    const cold = hs.reduce((s, h) => s + h.cold, 0);
    const what = hs.length > 1 ? `${hs.length} HORDES ×${n}` : `HORDE ×${n}`;
    out.push({ id: `horde${k++}`, text: cold ? `${what} · ${cold} COLD` : what, kind: 'hostile', p: c, y: 3, priority: 90 - k, gap: 22 });
  }
  const shelter = m.survivors.find((s) => !s.route);
  if (shelter) out.push({ id: 'friendlies', text: 'FRIENDLIES', kind: 'friendly', p: shelter.start, y: PIN_TOP * 0.7, priority: 86 });
  if (m.waves && m.type === 'defend' && m.safehouse) {
    waves.forEach((w, i) => {
      const a = arrowShape(w.from, w.to, m.waves!.minDist * 0.45, box);
      if (a) out.push({ id: `wave${i}`, text: `WAVES · ${w.compass.toUpperCase()}`, kind: 'wave', p: a.start, y: 2, priority: 80 - i });
    });
  }
  const anchorId = m.anchor?.id;
  if (m.anchor && inside(m.anchor.p, box)) out.push({ id: `f:${m.anchor.id}`, text: clip(m.anchor.name), kind: 'anchor', p: m.anchor.p, y: heightAt(m.anchor.p) + 4, priority: 78 });
  const seen = new Set<string>();
  for (const f of mapFeatures(map)) {
    if (!f.name || f.id === anchorId || !inside(f.p, box) || CATEGORY_INFO[f.category].weight < 4) continue;
    // A place mapped twice (outline and point) gets one label.
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push({ id: `f:${f.id}`, text: clip(f.name), kind: 'place', p: f.p, y: heightAt(f.p) + 4, priority: 10 + CATEGORY_INFO[f.category].weight });
  }
  return out.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
}

/** Height of the home and friendlies pins, metres. */
const PIN_TOP = 34;

export type Side = 'above' | 'right' | 'left' | 'below';
export interface LabelIn {
  id: string;
  /** Anchor point on screen, CSS px; `visible` false when it's behind the camera or off the canvas. */
  x: number;
  y: number;
  visible: boolean;
  w: number;
  h: number;
  priority: number;
  /** Gap between the label and its point, px (default GAP). */
  gap?: number;
}
export interface LabelOut {
  id: string;
  shown: boolean;
  /** Top-left of the label box, CSS px. */
  left: number;
  top: number;
  side: Side;
}

const SIDES: Side[] = ['above', 'right', 'left', 'below'];
/** Gap between a label and the point it marks, px. */
const GAP = 9;
/** Space kept clear between labels, px. */
const SPACING = 3;

/**
 * Greedy label placement: most important first; each tries above, right, left, then below its point
 * (starting with the side it used last frame, so labels don't hop about while the model turns) and
 * is dropped if every spot would overlap a placed label or leave the canvas.
 */
export function placeLabels(items: LabelIn[], width: number, height: number, prev: Map<string, Side> = new Map(), margin = 4): LabelOut[] {
  const placed: { x0: number; y0: number; x1: number; y1: number }[] = [];
  const out: LabelOut[] = [];
  const order = [...items].sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
  for (const it of order) {
    let res: LabelOut = { id: it.id, shown: false, left: 0, top: 0, side: 'above' };
    if (it.visible) {
      const last = prev.get(it.id);
      const sides = last ? [last, ...SIDES.filter((s) => s !== last)] : SIDES;
      for (const side of sides) {
        const [left, top] = spot(it, side);
        const box = { x0: left, y0: top, x1: left + it.w, y1: top + it.h };
        if (box.x0 < margin || box.y0 < margin || box.x1 > width - margin || box.y1 > height - margin) continue;
        if (placed.some((b) => box.x0 < b.x1 + SPACING && box.x1 + SPACING > b.x0 && box.y0 < b.y1 + SPACING && box.y1 + SPACING > b.y0)) continue;
        placed.push(box);
        res = { id: it.id, shown: true, left, top, side };
        break;
      }
    }
    out.push(res);
  }
  return out;
}

function spot(it: LabelIn, side: Side): [number, number] {
  const g = it.gap ?? GAP;
  switch (side) {
    case 'above':
      return [it.x - it.w / 2, it.y - g - it.h];
    case 'below':
      return [it.x - it.w / 2, it.y + g];
    case 'right':
      return [it.x + g, it.y - it.h / 2];
    case 'left':
      return [it.x - g - it.w, it.y - it.h / 2];
  }
}

/** A tiny deterministic hash in [0, 1) (no Math.random: same map, same model). */
function hash01(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return ((h >>> 0) % 10007) / 10007;
}

// ---------------------------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------------------------

type RGBA = [number, number, number, number];
const rgb = (hex: number, a = 1, k = 1): RGBA => [(((hex >> 16) & 255) / 255) * k, (((hex >> 8) & 255) / 255) * k, ((hex & 255) / 255) * k, a];

/** Palette: display colours, matched to the tactical map's --tm-* tokens in style.css. */
const C = {
  plinthTop: 0x1a2420,
  plinthSide: 0x2a3631,
  park: 0x2b5638,
  wood: 0x214a2e,
  water: 0x1b4c6c,
  roadMinor: 0x4d4330,
  road: 0x8c6d36,
  roadMajor: 0xc2903f,
  bldg: 0xb4bdb8,
  bldgPublic: 0xccd4cf,
  safe: 0xb8ff8a,
  home: 0xb8ff8a,
  route: 0xb8ff8a,
  hostile: 0xff6b5e,
  cold: 0x7fe3ff,
  friendly: 0x5aa9ff,
  orbit: 0xe7efe9,
  edge: 0x0d1310,
};

/** The fixed "sun" (from the north-west, high), baked into vertex colours. */
const SUN = new THREE.Vector3(-0.45, 1, -0.35).normalize();
const shadeFor = (n: THREE.Vector3) => 0.56 + 0.44 * Math.max(0, n.dot(SUN));

/** Accumulates non-indexed triangles with vertex colours (RGBA), flat-shaded by the fixed sun. */
class Geo {
  pos: number[] = [];
  col: number[] = [];
  private n = new THREE.Vector3();
  private u = new THREE.Vector3();
  private v = new THREE.Vector3();

  /** A triangle facing `want` (flipped if needed), shaded by the sun unless `flat`. */
  tri(a: number[], b: number[], c: number[], color: RGBA, want: THREE.Vector3 | null, flat = false): void {
    this.u.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.v.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    this.n.crossVectors(this.u, this.v).normalize();
    if (want && this.n.dot(want) < 0) {
      [b, c] = [c, b];
      this.n.negate();
    }
    const s = flat ? 1 : shadeFor(this.n);
    this.pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) this.col.push(color[0] * s, color[1] * s, color[2] * s, color[3]);
  }

  /** A flat, upward-facing triangle on the ground at height y. */
  flat(a: V2, b: V2, c: V2, y: number, color: RGBA, shade = false): void {
    this.tri([a.x, y, a.z], [b.x, y, b.z], [c.x, y, c.z], color, UP, !shade);
  }

  quad(a: V2, b: V2, c: V2, d: V2, y: number, color: RGBA): void {
    this.flat(a, b, c, y, color);
    this.flat(a, c, d, y, color);
  }

  /** A filled polygon (any simple shape) on the ground. */
  polygon(pts: V2[], y: number, color: RGBA): void {
    const ring = openRing(pts);
    if (ring.length < 3) return;
    const faces = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p.x, p.z)), []);
    for (const [i, j, k] of faces) this.flat(ring[i], ring[j], ring[k], y, color);
  }

  /** A ring (annulus) on the ground; `dash` > 0 leaves gaps (dashes of that many segments). */
  ring(c: V2, r0: number, r1: number, y: number, color: RGBA, segs = 64, dash = 0): void {
    for (let i = 0; i < segs; i++) {
      if (dash && Math.floor(i / dash) % 2 === 1) continue;
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const p = (r: number, a: number): V2 => ({ x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r });
      this.quad(p(r0, a0), p(r1, a0), p(r1, a1), p(r0, a1), y, color);
    }
  }

  disc(c: V2, r: number, y: number, color: RGBA, segs = 40): void {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      this.flat(c, { x: c.x + Math.cos(a0) * r, z: c.z + Math.sin(a0) * r }, { x: c.x + Math.cos(a1) * r, z: c.z + Math.sin(a1) * r }, y, color);
    }
  }

  /** A flat strip along a polyline (roads, the route), with round-ish joints. */
  ribbon(pts: V2[], w: number, y: number, color: RGBA): void {
    const h = w / 2;
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const L = Math.hypot(b.x - a.x, b.z - a.z);
      if (L < 0.01) continue;
      const nx = (-(b.z - a.z) / L) * h;
      const nz = ((b.x - a.x) / L) * h;
      this.quad({ x: a.x + nx, z: a.z + nz }, { x: b.x + nx, z: b.z + nz }, { x: b.x - nx, z: b.z - nz }, { x: a.x - nx, z: a.z - nz }, y, color);
      if (i < pts.length - 1) this.disc(b, h, y, color, 8);
    }
  }

  /** An extruded block (a building): walls and a flat roof, shaded by the sun. */
  block(pts: V2[], h: number, wall: RGBA, roof: RGBA): void {
    const ring = openRing(pts);
    if (ring.length < 3) return;
    let a2 = 0;
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      a2 += p.x * q.z - q.x * p.z;
    }
    const sgn = Math.sign(a2) || 1;
    const out = new THREE.Vector3();
    for (let i = 0; i < ring.length; i++) {
      const p = ring[i];
      const q = ring[(i + 1) % ring.length];
      out.set((q.z - p.z) * sgn, 0, -(q.x - p.x) * sgn).normalize();
      const p0 = [p.x, 0, p.z];
      const q0 = [q.x, 0, q.z];
      const q1 = [q.x, h, q.z];
      const p1 = [p.x, h, p.z];
      this.tri(p0, q0, q1, wall, out);
      this.tri(p0, q1, p1, wall, out);
    }
    const faces = THREE.ShapeUtils.triangulateShape(ring.map((p) => new THREE.Vector2(p.x, p.z)), []);
    for (const [i, j, k] of faces) this.tri([ring[i].x, h, ring[i].z], [ring[j].x, h, ring[j].z], [ring[k].x, h, ring[k].z], roof, UP);
  }

  /** A solid upright marker: an octahedron (a "pin head") centred at (p, y). */
  gem(p: V2, y: number, r: number, color: RGBA): void {
    const top = [p.x, y + r * 1.3, p.z];
    const bot = [p.x, y - r * 1.3, p.z];
    const ring = [0, 1, 2, 3].map((k) => [p.x + Math.cos((k * Math.PI) / 2 + Math.PI / 4) * r, y, p.z + Math.sin((k * Math.PI) / 2 + Math.PI / 4) * r]);
    const centre = new THREE.Vector3(p.x, y, p.z);
    for (let k = 0; k < 4; k++) {
      const a = ring[k];
      const b = ring[(k + 1) % 4];
      for (const tip of [top, bot]) {
        const want = new THREE.Vector3((a[0] + b[0] + tip[0]) / 3, (a[1] + b[1] + tip[1]) / 3, (a[2] + b[2] + tip[2]) / 3).sub(centre);
        this.tri(a, b, tip, color, want);
      }
    }
  }

  /** A thin vertical post (a pin's stem), four-sided. */
  post(p: V2, y0: number, y1: number, r: number, color: RGBA): void {
    const sq: V2[] = [
      { x: p.x - r, z: p.z - r },
      { x: p.x + r, z: p.z - r },
      { x: p.x + r, z: p.z + r },
      { x: p.x - r, z: p.z + r },
    ];
    const out = new THREE.Vector3();
    for (let i = 0; i < 4; i++) {
      const a = sq[i];
      const b = sq[(i + 1) % 4];
      out.set((a.x + b.x) / 2 - p.x, 0, (a.z + b.z) / 2 - p.z);
      this.tri([a.x, y0, a.z], [b.x, y0, b.z], [b.x, y1, b.z], color, out);
      this.tri([a.x, y0, a.z], [b.x, y1, b.z], [a.x, y1, a.z], color, out);
    }
  }

  /** An open, see-through column of light (alpha fades to nothing at the top). */
  beam(c: V2, r: number, y0: number, y1: number, color: RGBA, segs = 16): void {
    for (let i = 0; i < segs; i++) {
      const a0 = (i / segs) * Math.PI * 2;
      const a1 = ((i + 1) / segs) * Math.PI * 2;
      const p0 = [c.x + Math.cos(a0) * r, c.z + Math.sin(a0) * r];
      const p1 = [c.x + Math.cos(a1) * r, c.z + Math.sin(a1) * r];
      const v = [
        [p0[0], y0, p0[1], color[3]],
        [p1[0], y0, p1[1], color[3]],
        [p1[0], y1, p1[1], 0],
        [p0[0], y0, p0[1], color[3]],
        [p1[0], y1, p1[1], 0],
        [p0[0], y1, p0[1], 0],
      ];
      for (const [x, y, z, a] of v) {
        this.pos.push(x, y, z);
        this.col.push(color[0], color[1], color[2], a);
      }
    }
  }

  get count(): number {
    return this.pos.length / 3;
  }

  build(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 4));
    g.computeBoundingSphere();
    return g;
  }
}

const UP = new THREE.Vector3(0, 1, 0);

function openRing(pts: V2[]): V2[] {
  const r = pts.length > 1 && pts[0].x === pts[pts.length - 1].x && pts[0].z === pts[pts.length - 1].z ? pts.slice(0, -1) : pts;
  return r.filter((p, i) => i === 0 || Math.hypot(p.x - r[i - 1].x, p.z - r[i - 1].z) > 0.05);
}

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MINOR = new Set(['service', 'footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian']);
const HOUSE = new Set(['house', 'residential', 'yes', 'detached', 'semidetached_house', 'terrace', 'apartments', 'garage', 'garages', 'shed', 'bungalow']);

/** The built scene: meshes, plus what the labels need. */
export interface Built {
  group: THREE.Group;
  box: Rect;
  maxH: number;
  heightAt: (p: V2) => number;
  overlay: MissionOverlay;
  orbit: { c: V2; r: number; y: number };
}

/**
 * Buildings are drawn at their mapped heights times this, so ordinary two-storey houses still read
 * as blocks from a few hundred metres up (a diorama's usual vertical stretch).
 */
export const HEIGHT_SCALE = 1.6;
/** Plinth depth below the ground, metres. */
const PLINTH = 16;
/**
 * The gunship's orbit is drawn as a schematic: the real one is 1 km in radius and 1.5 km up, far
 * outside the picture, so the ring sits above the model at a size that fits, centred over the real
 * orbit centre, and the caption says "orbit not to scale". Its direction of travel is true.
 */
export function orbitSchematic(orbitCentre: V2, box: Rect): { c: V2; r: number; y: number } {
  const w = box.x1 - box.x0;
  const h = box.z1 - box.z0;
  const c = { x: Math.max(box.x0, Math.min(box.x1, orbitCentre.x)), z: Math.max(box.z0, Math.min(box.z1, orbitCentre.z)) };
  return { c, r: Math.min(ORBIT.radius, Math.min(w, h) * 0.42), y: Math.max(w, h) * 0.16 };
}

/** Builds the whole model (no renderer needed): exported for tests. */
export function buildDioramaScene(map: MapData, m: Mission, waves: WaveDirection[]): Built {
  const box = dioramaExtent(map, m);
  const ground = new Geo();
  const blocks = new Geo();
  const marks = new Geo();
  const glass = new Geo();
  const group = new THREE.Group();

  // Plinth: a slab of dark slate with shaded sides.
  const corners: V2[] = [{ x: box.x0, z: box.z0 }, { x: box.x1, z: box.z0 }, { x: box.x1, z: box.z1 }, { x: box.x0, z: box.z1 }];
  ground.quad(corners[0], corners[1], corners[2], corners[3], 0, rgb(C.plinthTop));
  const cx = (box.x0 + box.x1) / 2;
  const cz = (box.z0 + box.z1) / 2;
  for (let i = 0; i < 4; i++) {
    const a = corners[i];
    const b = corners[(i + 1) % 4];
    const out = new THREE.Vector3((a.x + b.x) / 2 - cx, 0, (a.z + b.z) / 2 - cz);
    ground.tri([a.x, 0, a.z], [b.x, 0, b.z], [b.x, -PLINTH, b.z], rgb(C.plinthSide), out);
    ground.tri([a.x, 0, a.z], [b.x, -PLINTH, b.z], [a.x, -PLINTH, a.z], rgb(C.plinthSide), out);
  }

  // Open ground: parks, woods, water (and places mapped only as an outline).
  const areaIds = new Set(map.areas.map((a) => a.id));
  const areas: { pts: V2[]; kind: 'park' | 'wood' | 'water' }[] = map.areas.map((a) => ({ pts: a.pts, kind: a.kind }));
  for (const f of mapFeatures(map)) {
    if (!f.pts || f.pts.length < 3 || areaIds.has(f.id)) continue;
    if (f.category === 'forest') areas.push({ pts: f.pts, kind: 'wood' });
    else if (f.category === 'park') areas.push({ pts: f.pts, kind: 'park' });
  }
  const order = { park: 0, wood: 1, water: 2 };
  areas.sort((a, b) => order[a.kind] - order[b.kind]);
  for (const a of areas) {
    const pts = clipPolygon(openRing(a.pts), box);
    if (pts.length < 3) continue;
    ground.polygon(pts, 0.25 + order[a.kind] * 0.12, rgb(a.kind === 'water' ? C.water : a.kind === 'wood' ? C.wood : C.park));
  }

  // Roads: flat amber strips, wider for main roads (a little over true width, so they read).
  for (const r of map.roads) {
    const major = MAJOR.has(r.kind);
    const minor = MINOR.has(r.kind);
    const w = minor ? Math.max(2.5, r.width) : Math.max(7, r.width * 1.15) * (major ? 1.2 : 1);
    const y = minor ? 0.7 : major ? 0.95 : 0.85;
    for (const piece of clipPolyline(r.pts, box)) ground.ribbon(piece, w, y, rgb(minor ? C.roadMinor : major ? C.roadMajor : C.road));
  }

  // Buildings: plain blocks at their mapped heights; public buildings a shade lighter; the safehouse lit up.
  const safe = m.safehouse ? openRing(m.safehouse.poly) : null;
  const sc = m.safehouse?.centre;
  let maxH = 0;
  const tall: { pts: V2[]; h: number }[] = [];
  for (const b of map.buildings) {
    if (b.pts.length < 3) continue;
    const c = centroid(b.pts);
    if (!inside(c, box)) continue;
    const pts = clipPolygon(openRing(b.pts), box);
    if (pts.length < 3) continue;
    const h = Math.max(3, b.height) * HEIGHT_SCALE;
    maxH = Math.max(maxH, h);
    const isSafe = !!(sc && safe && (pointInPolygon(sc, b.pts) || (Math.abs(c.x - sc.x) < 0.5 && Math.abs(c.z - sc.z) < 0.5)));
    if (isSafe) continue; // drawn below, from the mission's own outline
    const k = 0.94 + hash01(b.id) * 0.1;
    const base = HOUSE.has(b.kind) ? C.bldg : C.bldgPublic;
    blocks.block(pts, h, rgb(base, 1, k * 0.97), rgb(base, 1, k * 1.04));
    if (h >= 9) tall.push({ pts: b.pts, h });
  }
  let safeH = 0;
  const heightAt = (p: V2) => {
    let best = 0;
    for (const t of tall) if (t.h > best && pointInPolygon(p, t.pts)) best = t.h;
    if (safe && pointInPolygon(p, safe)) best = Math.max(best, safeH);
    return best;
  };
  if (safe && sc) {
    // Its own height when the map has the building, else a sensible two storeys.
    const own = map.buildings.find((b) => b.pts.length >= 3 && pointInPolygon(sc, b.pts));
    safeH = Math.max(8, own?.height ?? 10) * HEIGHT_SCALE;
    const pts = clipPolygon(safe, box);
    if (pts.length >= 3) {
      blocks.block(pts, safeH, rgb(C.safe, 1, 0.92), rgb(C.safe, 1, 1.05));
      // A glow on the ground around it and a soft beam of light above it.
      const b = pts.reduce((r, p) => Math.max(r, Math.hypot(p.x - sc.x, p.z - sc.z)), 0);
      glass.disc(sc, b + 14, 1.15, rgb(C.safe, 0.2), 32);
      glass.beam(sc, Math.max(8, b * 0.55), safeH, safeH + 70, rgb(C.safe, 0.32));
    }
  }

  // Mission overlays.
  const ov = missionOverlay(m, waves, box);
  if (ov.waveZone) {
    const { c, r0, r1 } = ov.waveZone;
    // Annulus clipped by eye: drawn whole; the plinth edge cuts it visually via depth.
    annulusClipped(glass, c, r0, r1, 1.05, rgb(C.hostile, 0.06), box);
    for (const r of [r0, r1]) annulusClipped(marks, c, r - 1.2, r + 1.2, 1.1, rgb(C.hostile, 1, 0.75), box, 2);
  }
  for (const d of ov.discs) {
    if (!inside(d.c, box)) continue;
    glass.disc(d.c, d.r, 1.2, rgb(C.hostile, 0.33));
    marks.ring(d.c, d.r - 1.5, d.r + 1.5, 1.35, rgb(C.hostile), 48);
    if (d.cold) marks.ring(d.c, d.r + 6, d.r + 9, 1.35, rgb(C.cold), 48, 2);
  }
  if (ov.anchor && ov.anchor.length >= 3) {
    const pts = ov.anchor;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i];
      const b = pts[(i + 1) % pts.length];
      dashed(marks, a, b, 3, 1.3, rgb(C.safe, 1, 0.85), 9, 6);
    }
  }
  for (const piece of ov.route) {
    glass.ribbon(piece, 22, 1.45, rgb(C.route, 0.16));
    glass.ribbon(piece, 11, 1.5, rgb(C.route, 0.22));
    marks.ribbon(piece, 5, 1.6, rgb(C.route));
  }
  for (const a of ov.arrows) {
    marks.quad(a.shaft[0], a.shaft[1], a.shaft[2], a.shaft[3], 1.55, rgb(C.hostile));
    marks.flat(a.head[0], a.head[1], a.head[2], 1.55, rgb(C.hostile));
  }
  for (const f of ov.friendlies) {
    if (!inside(f, box)) continue;
    marks.post(f, 0, PIN_TOP * 0.7 - 6, 0.9, rgb(C.friendly, 1, 0.8));
    marks.gem(f, PIN_TOP * 0.7 - 2, 5, rgb(C.friendly));
    glass.disc(f, 7, 1.25, rgb(C.friendly, 0.35), 20);
  }
  if (ov.home && inside(ov.home, box)) {
    marks.post(ov.home, 0, PIN_TOP - 7, 1, rgb(C.home, 1, 0.8));
    marks.gem(ov.home, PIN_TOP - 2, 6, rgb(C.home));
    glass.disc(ov.home, 10, 1.25, rgb(C.home, 0.3), 24);
  }
  // The gunship's orbit: a faint dashed ring up in the air (schematic), and its centre marked on the ground.
  const orb = orbitSchematic(ov.orbit.c, box);
  glass.ring(orb.c, orb.r - 1.6, orb.r + 1.6, orb.y, rgb(C.orbit, 0.42), 120, 2);
  // Chevrons showing the way it flies (anticlockwise seen from above, as in the sim).
  for (let k = 0; k < 3; k++) {
    const a = (k / 3) * Math.PI * 2 + 0.3;
    const p = { x: orb.c.x + Math.cos(a) * orb.r, z: orb.c.z + Math.sin(a) * orb.r };
    // Travel direction: the sim's angle decreases over time, so d/dt (cos a, sin a) ∝ (sin a, -cos a).
    const t = { x: Math.sin(a), z: -Math.cos(a) };
    const n = { x: Math.cos(a), z: Math.sin(a) };
    const s = 7;
    const tip = { x: p.x + t.x * s, z: p.z + t.z * s };
    const l = { x: p.x - t.x * s + n.x * s, z: p.z - t.z * s + n.z * s };
    const r = { x: p.x - t.x * s - n.x * s, z: p.z - t.z * s - n.z * s };
    glass.flat(tip, l, r, orb.y, rgb(C.orbit, 0.6));
  }
  if (inside(ov.orbit.c, box)) {
    const o = ov.orbit.c;
    marks.ring(o, 6, 8, 1.4, rgb(C.orbit, 1, 0.85), 24);
    marks.quad({ x: o.x - 14, z: o.z - 0.9 }, { x: o.x + 14, z: o.z - 0.9 }, { x: o.x + 14, z: o.z + 0.9 }, { x: o.x - 14, z: o.z + 0.9 }, 1.4, rgb(C.orbit, 1, 0.85));
    marks.quad({ x: o.x - 0.9, z: o.z - 14 }, { x: o.x + 0.9, z: o.z - 14 }, { x: o.x + 0.9, z: o.z + 14 }, { x: o.x - 0.9, z: o.z + 14 }, 1.4, rgb(C.orbit, 1, 0.85));
  }

  const basic = (opts: THREE.MeshBasicMaterialParameters) => new THREE.MeshBasicMaterial({ vertexColors: true, ...opts });
  const add = (g: Geo, mat: THREE.Material, order = 0) => {
    if (!g.count) {
      mat.dispose();
      return;
    }
    const mesh = new THREE.Mesh(g.build(), mat);
    mesh.renderOrder = order;
    mesh.matrixAutoUpdate = false;
    group.add(mesh);
  };
  add(ground, basic({}));
  add(blocks, basic({}));
  add(marks, basic({}));
  add(glass, basic({ transparent: true, depthWrite: false, side: THREE.DoubleSide }), 1);
  return { group, box, maxH, heightAt, overlay: ov, orbit: orb };
}

/** A dashed line on the ground (the recon place's outline). */
function dashed(g: Geo, a: V2, b: V2, w: number, y: number, color: RGBA, on: number, off: number): void {
  const L = Math.hypot(b.x - a.x, b.z - a.z);
  for (let s = 0; s < L; s += on + off) {
    const e = Math.min(L, s + on);
    g.ribbon([lerpAt(a, b, s / L), lerpAt(a, b, e / L)], w, y, color);
  }
}

/** The defend wave zone (a ring around the safehouse), cut to the diorama's box. */
function annulusClipped(g: Geo, c: V2, r0: number, r1: number, y: number, color: RGBA, box: Rect, dash = 0): void {
  const segs = 96;
  for (let i = 0; i < segs; i++) {
    if (dash && Math.floor(i / dash) % 2 === 1) continue;
    const a0 = (i / segs) * Math.PI * 2;
    const a1 = ((i + 1) / segs) * Math.PI * 2;
    const p = (r: number, a: number): V2 => ({ x: c.x + Math.cos(a) * r, z: c.z + Math.sin(a) * r });
    const quad = clipPolygon([p(r0, a0), p(r1, a0), p(r1, a1), p(r0, a1)], box);
    if (quad.length < 3) continue;
    for (let k = 1; k < quad.length - 1; k++) g.flat(quad[0], quad[k], quad[k + 1], y, color);
  }
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

/** Auto-orbit speed, radians per second (a full turn in about 100 s). */
const SPIN = (Math.PI * 2) / 100;
/** After the player drags, the model waits this long (ms) before turning on its own again. */
const IDLE_MS = 3500;
const FOV = 30;

const reducedMotionQuery: MediaQueryList | null = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

export interface DioramaInfo {
  drawCalls: number;
  triangles: number;
  buildMs: number;
  labels: number;
  still: boolean;
}

export class BriefingDiorama {
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(FOV, 1, 10, 10000);
  private built: Built;
  private labelLayer: HTMLDivElement;
  private labels: { spec: LabelSpec; el: HTMLSpanElement; pin: HTMLSpanElement; w: number; h: number; shown: boolean; left: number; top: number }[] = [];
  private sides = new Map<string, Side>();
  private az: number;
  private elev = 0.98;
  /** Camera distance and vertical centring for the current aspect and elevation (see computeFit). */
  private fit = { dist: 0, shift: 0, aspect: 0, elev: 0 };
  private target = new THREE.Vector3();
  private radius = 400;
  private raf = 0;
  private last = 0;
  private idleUntil = 0;
  private drag: { id: number; x: number; y: number; mouse: boolean } | null = null;
  private disposed = false;
  private still: boolean;
  private resize: ResizeObserver | null = null;
  private cleanups: (() => void)[] = [];
  private size = { w: 0, h: 0 };
  readonly buildMs: number;
  private hint: HTMLSpanElement;
  private v = new THREE.Vector3();

  constructor(map: MapData, mission: Mission, waves: WaveDirection[]) {
    const t0 = performance.now();
    this.el = el('div', 'dio');
    this.el.tabIndex = 0;
    this.el.setAttribute('role', 'img');
    this.el.setAttribute('aria-label', `3D model of the mission area: ${mission.title}. Drag or use the arrow keys to turn it.`);
    const stage = el('div', 'dio-stage', undefined, this.el);
    // The model first: if it throws, no WebGL context has been made yet.
    this.built = buildDioramaScene(map, mission, waves);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    // Colours are plain display values (see the top of this file): write them out unconverted.
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.domElement.className = 'dio-canvas';
    stage.appendChild(this.renderer.domElement);
    this.labelLayer = el('div', 'dio-labels', undefined, stage);
    this.labelLayer.setAttribute('aria-hidden', 'true');
    const foot = el('div', 'dio-foot', undefined, this.el);
    this.hint = el('span', 'dio-hint', '', foot);
    el('span', 'dio-attrib', map.attribution, foot);

    this.scene.add(this.built.group);
    const b = this.built.box;
    this.target.set((b.x0 + b.x1) / 2, Math.min(12, this.built.maxH * 0.3), (b.z0 + b.z1) / 2);
    this.radius = Math.hypot(b.x1 - b.x0, b.z1 - b.z0) / 2;
    // Start looking from the south-west-ish, the same way every time for a given mission.
    this.az = -Math.PI * 0.75 + (hash01(`${mission.seed}`) - 0.5) * 0.6;
    for (const spec of labelSpecs(map, mission, waves, b, this.built.heightAt)) {
      const pin = el('span', `dio-pin ${spec.kind}`, undefined, this.labelLayer);
      const label = el('span', `dio-label ${spec.kind}`, spec.text, this.labelLayer);
      if (spec.gap) label.style.setProperty('--gap', `${spec.gap}px`);
      this.labels.push({ spec, el: label, pin, w: 0, h: 0, shown: false, left: -1, top: -1 });
    }
    this.buildMs = performance.now() - t0;
    this.el.dataset.buildMs = this.buildMs.toFixed(1);

    this.still = this.wantsStill();
    this.updateHint();
    this.bind();
  }

  private wantsStill(): boolean {
    return !!reducedMotionQuery?.matches || getSettings().reduceFlicker;
  }

  private updateHint(): void {
    this.hint.textContent = `${this.still ? 'Still view · drag to turn' : 'Drag to turn'} · orbit ring not to scale`;
  }

  private bind(): void {
    const c = this.renderer.domElement;
    const on = <K extends keyof HTMLElementEventMap>(t: HTMLElement, type: K, fn: (e: HTMLElementEventMap[K]) => void) => {
      t.addEventListener(type, fn as EventListener);
      this.cleanups.push(() => t.removeEventListener(type, fn as EventListener));
    };
    on(c, 'pointerdown', (e) => {
      this.drag = { id: e.pointerId, x: e.clientX, y: e.clientY, mouse: e.pointerType === 'mouse' };
      try {
        c.setPointerCapture(e.pointerId);
      } catch {
        /* not capturable */
      }
      this.el.classList.add('dragging');
    });
    on(c, 'pointermove', (e) => {
      const d = this.drag;
      if (!d || d.id !== e.pointerId) return;
      this.az -= (e.clientX - d.x) * 0.0085;
      if (d.mouse) this.elev = Math.max(0.35, Math.min(1.25, this.elev + (e.clientY - d.y) * 0.005));
      d.x = e.clientX;
      d.y = e.clientY;
      this.idleUntil = performance.now() + IDLE_MS;
      this.requestRender();
    });
    const end = (e: PointerEvent) => {
      if (!this.drag || this.drag.id !== e.pointerId) return;
      this.drag = null;
      this.idleUntil = performance.now() + IDLE_MS;
      this.el.classList.remove('dragging');
      this.requestRender();
    };
    on(c, 'pointerup', end);
    on(c, 'pointercancel', end);
    on(this.el, 'keydown', (e) => {
      const step = e.key === 'ArrowLeft' ? 1 : e.key === 'ArrowRight' ? -1 : 0;
      if (!step) return;
      e.preventDefault();
      this.az += (step * Math.PI) / 12;
      this.idleUntil = performance.now() + IDLE_MS;
      this.requestRender();
    });
    const motion = () => {
      this.still = this.wantsStill();
      this.updateHint();
      this.requestRender();
    };
    if (reducedMotionQuery) {
      reducedMotionQuery.addEventListener('change', motion);
      this.cleanups.push(() => reducedMotionQuery.removeEventListener('change', motion));
    }
    this.cleanups.push(onSettingsChange(motion));
    if (typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver(() => this.requestRender());
      this.resize.observe(this.el);
    }
    this.requestRender();
  }

  /** Draw on the next frame (and keep drawing while it auto-turns). */
  requestRender(): void {
    if (this.disposed || this.raf) return;
    this.raf = requestAnimationFrame(this.frame);
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    const canvas = this.renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    // Hidden (the Map tab is showing, or the card is gone): stop until something asks again.
    if (!w || !h || !this.el.isConnected) {
      this.last = 0;
      return;
    }
    if (w !== this.size.w || h !== this.size.h) {
      this.size = { w, h };
      this.renderer.setSize(w, h, false);
    }
    const turning = !this.still && !this.drag && now >= this.idleUntil;
    if (turning) this.az += SPIN * dt;
    this.draw(w, h);
    if (turning || now < this.idleUntil) this.raf = requestAnimationFrame(this.frame);
    else this.last = 0;
  };

  /** Places a camera on the turntable at azimuth `az`, `dist` metres from the target. */
  private place(cam: THREE.PerspectiveCamera, az: number, dist: number): void {
    const t = this.target;
    cam.position.set(t.x + Math.cos(az) * Math.cos(this.elev) * dist, t.y + Math.sin(this.elev) * dist, t.z + Math.sin(az) * Math.cos(this.elev) * dist);
    cam.near = Math.max(5, dist * 0.2);
    cam.far = dist * 3;
    cam.lookAt(t);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld();
  }

  /**
   * The closest camera distance at which the whole plinth (and the orbit ring) stays inside the
   * picture at every turn of the table, plus the vertical shift that centres it. Fixed for a given
   * aspect and tilt, so the model never "breathes" as it turns.
   */
  private computeFit(aspect: number): void {
    const b = this.built.box;
    const pts: THREE.Vector3[] = [];
    // The plinth's top corners (with a little height) and bottom edge. The faint orbit ring may run off the picture.
    for (const x of [b.x0, b.x1]) for (const z of [b.z0, b.z1]) pts.push(new THREE.Vector3(x, -PLINTH, z), new THREE.Vector3(x, Math.min(20, this.built.maxH * 0.4), z));
    const cam = new THREE.PerspectiveCamera(FOV, aspect, 1, 1e5);
    const v = new THREE.Vector3();
    const measure = (dist: number) => {
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let k = 0; k < 24; k++) {
        this.place(cam, (k / 24) * Math.PI * 2, dist);
        for (const p of pts) {
          v.copy(p).project(cam);
          x0 = Math.min(x0, v.x);
          x1 = Math.max(x1, v.x);
          y0 = Math.min(y0, v.y);
          y1 = Math.max(y1, v.y);
        }
      }
      return { x0, x1, y0, y1 };
    };
    let lo = this.radius * 0.5;
    let hi = this.radius * 20;
    for (let i = 0; i < 22; i++) {
      const mid = (lo + hi) / 2;
      const m = measure(mid);
      if (Math.max(m.x1 - m.x0, m.y1 - m.y0) / 2 <= 0.95) hi = mid;
      else lo = mid;
    }
    const m = measure(hi);
    this.fit = { dist: hi, shift: -(m.y0 + m.y1) / 2, aspect, elev: this.elev };
  }

  private draw(w: number, h: number): void {
    const cam = this.camera;
    cam.aspect = w / h;
    if (this.fit.aspect !== cam.aspect || this.fit.elev !== this.elev) this.computeFit(cam.aspect);
    this.place(cam, this.az, this.fit.dist);
    // Centre the model vertically: shift the picture in screen space (NDC y) without tilting the view.
    cam.projectionMatrix.elements[9] -= this.fit.shift;
    this.renderer.render(this.scene, cam);
    this.layoutLabels(w, h);
    this.el.dataset.drawCalls = String(this.renderer.info.render.calls);
  }

  private layoutLabels(w: number, h: number): void {
    const items: LabelIn[] = [];
    const pts: { x: number; y: number; visible: boolean }[] = [];
    // Landmarks are context, not intel: only the top few, fewer on a small (phone) picture.
    let places = w < 360 ? 1 : 3;
    for (const l of this.labels) {
      if (!l.w) {
        // Measure once (it's on screen now); fall back to an estimate.
        const r = l.el.getBoundingClientRect();
        l.w = Math.ceil(r.width) || Math.ceil(l.spec.text.length * 14 * 0.62 + 14);
        l.h = Math.ceil(r.height) || 24;
      }
      this.v.set(l.spec.p.x, l.spec.y, l.spec.p.z).project(this.camera);
      const p = { x: ((this.v.x + 1) / 2) * w, y: ((1 - this.v.y) / 2) * h, visible: this.v.z < 1 && this.v.z > -1 && Math.abs(this.v.x) <= 1 && Math.abs(this.v.y) <= 1 };
      if (l.spec.kind === 'place' && p.visible && places-- <= 0) p.visible = false;
      pts.push(p);
      items.push({ id: l.spec.id, x: p.x, y: p.y, visible: p.visible, w: l.w, h: l.h, priority: l.spec.priority, gap: l.spec.gap });
    }
    const placed = new Map(placeLabels(items, w, h, this.sides).map((o) => [o.id, o]));
    this.labels.forEach((l, i) => {
      const o = placed.get(l.spec.id)!;
      if (o.shown) this.sides.set(o.id, o.side);
      else this.sides.delete(o.id);
      if (o.shown !== l.shown) {
        l.shown = o.shown;
        l.el.classList.toggle('on', o.shown);
        l.pin.classList.toggle('on', o.shown);
      }
      if (!o.shown) return;
      const left = Math.round(o.left);
      const top = Math.round(o.top);
      l.el.dataset.side = o.side;
      if (left !== l.left || top !== l.top) {
        l.left = left;
        l.top = top;
        l.el.style.transform = `translate(${left}px, ${top}px)`;
      }
      l.pin.style.transform = `translate(${Math.round(pts[i].x)}px, ${Math.round(pts[i].y)}px)`;
    });
  }

  info(): DioramaInfo {
    return { drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, buildMs: this.buildMs, labels: this.labels.filter((l) => l.shown).length, still: this.still };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.resize?.disconnect();
    this.resize = null;
    for (const f of this.cleanups) f();
    this.cleanups = [];
    this.scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
      const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
      else mat?.dispose();
    });
    this.scene.clear();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.el.remove();
  }
}

/** Live diorama count (tests and the WebGL-context leak check read it). */
let live = 0;
export const liveDioramas = (): number => live;

/**
 * The briefing's picture block: the 3D diorama beside the tactical map (wide screens), or a Map / 3D
 * toggle (narrow screens), with the map's legend under both. Call dispose() when the briefing closes.
 * If WebGL isn't available, it's just the tactical map.
 */
export function briefingVisuals(map: MapData, mission: Mission, graph: RoadGraph): { el: HTMLDivElement; dispose(): void } {
  const wrap = el('div', 'briefing-visuals show-3d');
  const toggle = el('div', 'bv-toggle', undefined, wrap);
  toggle.setAttribute('role', 'group');
  toggle.setAttribute('aria-label', 'Briefing picture');
  const panels = el('div', 'bv-panels', undefined, wrap);
  const mapBlock = briefingMap(map, mission, graph);
  const legend = mapBlock.querySelector('.tmap-legend');
  let dio: BriefingDiorama | null = null;
  try {
    dio = new BriefingDiorama(map, mission, likelyWaveDirections(mission, map, graph));
    live++;
  } catch {
    dio = null; // no WebGL: the tactical map alone
  }
  if (dio) panels.appendChild(dio.el);
  panels.appendChild(mapBlock);
  if (legend) wrap.appendChild(legend);
  if (dio) {
    const btn = (text: string, show: '3d' | 'map') => {
      const b = el('button', 'bv-tab', text, toggle);
      b.type = 'button';
      b.addEventListener('click', () => {
        wrap.classList.toggle('show-3d', show === '3d');
        wrap.classList.toggle('show-map', show === 'map');
        for (const x of toggle.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
        dio?.requestRender();
      });
      b.setAttribute('aria-pressed', String(show === '3d'));
    };
    btn('3D view', '3d');
    btn('Map', 'map');
  } else {
    wrap.classList.replace('show-3d', 'show-map');
    wrap.classList.add('no-3d');
  }
  let done = false;
  return {
    el: wrap,
    dispose() {
      if (done) return;
      done = true;
      if (dio) {
        dio.dispose();
        live--;
      }
      dio = null;
    },
  };
}
