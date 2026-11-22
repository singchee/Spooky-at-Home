import type { MapData, V2 } from '../map/types';
import type { Mission } from '../sim/missions';
import { CATEGORY_INFO, isChildPlaceFeature, mapFeatures } from '../map/recon';
import { dist } from '../map/geom';

/**
 * In-flight landmark markers (BACKLOG 3.19): public places the recon found (tennis club, park,
 * sports ground, shops, station, police, fire, hospital, library...) as small labels in the
 * gunship view. Pure: no DOM, no three.js (the layer in landmarkLayer.ts draws them).
 *
 * Never schools, kindergartens, childcare or playgrounds (owner decision #11), not even a sports
 * ground or a place named after one, and never the player's own typed address (it isn't a map
 * feature; `typed`, when a caller has it, also drops any place whose name matches it).
 * Names are OpenStreetMap text: untrusted, shown with textContent only.
 */
export interface Landmark {
  id: string;
  label: string;
  p: V2;
  /** Higher is more relevant to the mission (placed first). */
  priority: number;
}

/** Longest label, in characters (longer names get an ellipsis). */
export const LANDMARK_MAX_CHARS = 24;
/** Most landmarks on screen at once. */
export const MAX_LANDMARKS = 6;
/** Landmark kinds (map.pois) worth a marker, besides the recon features. */
const POI_LABELS: Record<string, true> = { hospital: true, police: true, fire_station: true, library: true, community_centre: true, clinic: true, place_of_worship: true };

const norm = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const clip = (s: string) => (s.length > LANDMARK_MAX_CHARS ? `${s.slice(0, LANDMARK_MAX_CHARS - 1)}…` : s);

/** True when a name could stand for the typed address (equal, or one contains the other). */
function matchesTyped(name: string, typed: string | undefined): boolean {
  if (!typed) return false;
  const a = norm(name);
  const b = norm(typed);
  return !!a && !!b && (a === b || a.includes(b) || b.includes(a));
}

/**
 * Every place that may get a marker on this map, most relevant to the mission first: the place the
 * mission is built around, then places near the mission's own places (hordes, safehouse, home,
 * route), then by how interesting they are to a gunship crew.
 */
export function landmarkList(map: MapData, mission: Mission, opts: { typed?: string } = {}): Landmark[] {
  const missionPts: V2[] = [
    ...mission.hordes.map((h) => h.centre),
    ...(mission.safehouse ? [mission.safehouse.centre] : []),
    ...(mission.home ? [mission.home.centre] : []),
    ...(mission.route ?? []),
  ];
  const near = (p: V2) => missionPts.reduce((d, q) => Math.min(d, dist(p, q)), Infinity);
  const out: Landmark[] = [];
  const names = new Set<string>();
  const add = (id: string, kind: string, name: string | undefined, p: V2, weight: number) => {
    if (!name || isChildPlaceFeature(map, kind, name, p) || matchesTyped(name, opts.typed)) return;
    const key = norm(name);
    if (names.has(key)) return; // mapped twice (outline and point): one marker
    names.add(key);
    const anchor = mission.anchor?.id === id ? 100 : 0;
    const d = near(p);
    const close = d < 150 ? 20 : d < 300 ? 10 : 0;
    out.push({ id, label: clip(name), p, priority: anchor + close + weight });
  };
  for (const f of mapFeatures(map)) add(f.id, f.category, f.name, f.p, CATEGORY_INFO[f.category].weight);
  for (const p of map.pois) if (POI_LABELS[p.kind]) add(p.id, p.kind, p.name, p.p, 5);
  return out.sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1));
}

/** A box on screen, CSS px. */
export interface Rect { x0: number; y0: number; x1: number; y1: number }

/** One landmark this frame: where it projects (CSS px), whether it's in front of the camera. */
export interface LandmarkIn {
  id: string;
  label: string;
  priority: number;
  x: number;
  y: number;
  visible: boolean;
  /** Ground distance from the aim point, metres. */
  aimDist: number;
}

export interface LandmarkOut {
  id: string;
  label: string;
  /** The marked point (the pin), CSS px. */
  x: number;
  y: number;
  /** The label box's top-left, CSS px. */
  left: number;
  top: number;
  opacity: number;
}

export interface PlaceOptions {
  width: number;
  height: number;
  /** HUD panels, touch controls, mission markers: no label or pin goes over these. */
  blocked: Rect[];
  /** Lens zoom (1 = none): zoomed in, only nearer places show, fainter. */
  zoom: number;
  /** Half the visible ground width at the aim point, metres (sets how far "far" is). */
  viewHalf: number;
  /** Max markers (default MAX_LANDMARKS). */
  max?: number;
}

/** Label text size, px (QUALITY: no text under 14 px). */
export const LANDMARK_FONT_PX = 14;
/** Estimated width of one character at 14 px in the HUD font, px (generous, so boxes never undershoot). */
const CHAR_PX = 9;
const LABEL_H = 20;
const PAD_X = 6;
/** Gap between the pin and its label, px. */
const GAP = 6;
/** Space kept clear around the screen edge, px. */
const EDGE = 8;
/** Half-size of the reticle area kept clear, px (the crosshair is 120 px; its DANGER CLOSE tag sits beside or below it). */
const RETICLE = 80;

export const labelWidth = (label: string) => label.length * CHAR_PX + PAD_X * 2;

/** The reticle area: the crosshair, plus room for its DANGER CLOSE tag to the right and below, and MASKED above (3.39). */
export function reticleRects(width: number, height: number): Rect[] {
  const cx = width / 2;
  const cy = height / 2;
  return [
    { x0: cx - RETICLE, y0: cy - RETICLE, x1: cx + RETICLE, y1: cy + RETICLE },
    { x0: cx + RETICLE - 20, y0: cy - 18, x1: cx + RETICLE + 150, y1: cy + 18 },
    { x0: cx - 85, y0: cy + RETICLE - 20, x1: cx + 85, y1: cy + RETICLE + 36 },
    { x0: cx - 50, y0: cy - RETICLE - 20, x1: cx + 50, y1: cy - RETICLE + 20 },
  ];
}

const hit = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

/**
 * Opacity for a place `aimDist` metres from the aim point: full near the middle of the view,
 * fading towards the edge of it; zoomed in, the view is smaller, so places fade sooner and
 * the labels step back while the crew aims.
 */
export function landmarkOpacity(aimDist: number, viewHalf: number, zoom: number): number {
  const r = aimDist / Math.max(1, viewHalf);
  const far = r <= 0.6 ? 1 : r >= 1.3 ? 0 : 1 - (r - 0.6) / 0.7;
  const z = zoom <= 1.5 ? 1 : zoom >= 4 ? 0.6 : 1 - ((zoom - 1.5) / 2.5) * 0.4;
  return Math.round(far * z * 100) / 100;
}

/**
 * Declutter: most relevant first (mission relevance, then nearest the aim point), at most `max`,
 * each label tried above, right, left, then below its pin; dropped if every spot overlaps a placed
 * label, a blocked box, the reticle area or the screen edge, or if it has faded out.
 */
export function placeLandmarks(items: LandmarkIn[], o: PlaceOptions): LandmarkOut[] {
  const max = o.max ?? MAX_LANDMARKS;
  const blocked = [...o.blocked, ...reticleRects(o.width, o.height)];
  const placed: Rect[] = [];
  const out: LandmarkOut[] = [];
  const order = items
    .filter((i) => i.visible)
    .map((i) => ({ i, opacity: landmarkOpacity(i.aimDist, o.viewHalf, o.zoom) }))
    .filter((e) => e.opacity >= 0.25)
    .sort((a, b) => b.i.priority - a.i.priority || a.i.aimDist - b.i.aimDist || (a.i.id < b.i.id ? -1 : 1));
  const free = (r: Rect) => r.x0 >= EDGE && r.y0 >= EDGE && r.x1 <= o.width - EDGE && r.y1 <= o.height - EDGE && !blocked.some((b) => hit(r, b)) && !placed.some((b) => hit(r, b));
  for (const { i, opacity } of order) {
    if (out.length >= max) break;
    const pin: Rect = { x0: i.x - 5, y0: i.y - 5, x1: i.x + 5, y1: i.y + 5 };
    if (!free(pin)) continue;
    const w = labelWidth(i.label);
    const spots: [number, number][] = [
      [i.x - w / 2, i.y - GAP - LABEL_H], // above
      [i.x + GAP + 4, i.y - LABEL_H / 2], // right
      [i.x - GAP - 4 - w, i.y - LABEL_H / 2], // left
      [i.x - w / 2, i.y + GAP], // below
    ];
    for (const [left, top] of spots) {
      const box: Rect = { x0: left, y0: top, x1: left + w, y1: top + LABEL_H };
      if (!free(box)) continue;
      placed.push(pin, box);
      out.push({ id: i.id, label: i.label, x: i.x, y: i.y, left: Math.round(left), top: Math.round(top), opacity });
      break;
    }
  }
  return out;
}
