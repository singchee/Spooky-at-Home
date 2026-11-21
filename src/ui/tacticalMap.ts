import type { Feature, FeatureCategory, MapData, V2 } from '../map/types';
import { bounds } from '../map/geom';
import { CATEGORY_INFO, mapFeatures } from '../map/recon';
import { likelyWaveDirections, type Mission, type WaveDirection } from '../sim/missions';
import { ORBIT } from '../sim/sim';
import type { RoadGraph } from '../map/roadGraph';
import { el } from './dom';

/**
 * A top-down tactical map drawn as SVG from MapData: roads, buildings, parks, woods, water,
 * bus routes, military-style place symbols and labels, plus mission overlays.
 * All map text goes in through textContent (OpenStreetMap names are untrusted).
 * North is up: SVG y is the map's z (south), so no flipping is needed.
 */
export interface TacticalOptions {
  mission?: Mission;
  /** Likely wave directions (defend missions), from likelyWaveDirections(). */
  waves?: WaveDirection[];
  /** First guess at the width in CSS pixels. Once the map is on screen it measures its real width
   *  (ResizeObserver) and redraws, so text is always TEXT_PX or more on screen. */
  size?: number;
  /** Zoom to the mission area (briefing) instead of showing the whole map. */
  focus?: boolean;
  /** Minimap mode: no labels, symbols, trees, grid letters, legend or scale bar. */
  compact?: boolean;
  /** Feature to emphasise (a mission's place). */
  highlight?: string;
  label?: string;
}

const NS = 'http://www.w3.org/2000/svg';
let uid = 0;

type Attrs = Record<string, string | number>;
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Attrs = {}, parent?: Element, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  parent?.appendChild(e);
  return e;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** Smallest text on the map, in real on-screen CSS pixels (QUALITY: no text under 14 px). */
const TEXT_PX = 14;
/** Monospace glyph width as a share of the font size, for label boxes. */
const CHAR_W = 0.62;
const polyD = (pts: V2[], close: boolean) => pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.z)}`).join('') + (close ? 'Z' : '');

/** Symbol families, coloured like a briefing board: civic, sport and open space, shops, transport. */
const FAMILY: Record<FeatureCategory, 'civic' | 'sport' | 'green' | 'shop' | 'transport'> = {
  school: 'civic', kindergarten: 'civic', hospital: 'civic', police: 'civic', fire_station: 'civic',
  sports_centre: 'sport', stadium: 'sport', pitch: 'sport', tennis: 'sport', swimming_pool: 'sport', playground: 'sport',
  park: 'green', forest: 'green',
  supermarket: 'shop', mall: 'shop', parking: 'shop',
  train_station: 'transport', bus_station: 'transport',
};

const MAJOR = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);
const MINOR = new Set(['service', 'footway', 'path', 'cycleway', 'steps', 'track', 'pedestrian']);

interface Box {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export class TacticalMap {
  readonly svg: SVGSVGElement;
  /** Compact (minimap) mode only: a separate transparent SVG for the live layer, stacked on top,
   *  so moving the aircraft never repaints the whole static map. */
  readonly live: SVGSVGElement | null = null;
  private dyn!: SVGGElement;
  /** Map metres per on-screen CSS pixel. Text and line sizes are multiples of it. */
  private u = 1;
  private half: number;
  /** The visible square, in map metres (the whole map, or the mission area when focused). */
  private view: { x0: number; z0: number; span: number };
  private full: { x0: number; z0: number; span: number };
  private pad: number;
  private lastAircraft: V2 | null = null;
  private boxes: Box[] = [];
  /** The width (CSS px) the map was last drawn for. */
  private drawnFor = 0;
  private highlightId: string | null = null;
  private resize: ResizeObserver | null = null;
  private readonly id = `tm${++uid}`;

  constructor(private map: MapData, private opts: TacticalOptions = {}) {
    const half = map.half;
    this.half = half;
    this.pad = half * 0.03;
    this.full = { x0: -half - this.pad, z0: -half - this.pad, span: 2 * (half + this.pad) };
    this.view = opts.focus && opts.mission ? focusView(opts.mission, this.full) : this.full;
    const v = this.view;
    this.svg = svg('svg', {
      viewBox: `${r1(v.x0)} ${r1(v.z0)} ${r1(v.span)} ${r1(v.span)}`,
      class: `tmap${opts.compact ? ' compact' : ''}`,
      role: 'img',
      'aria-label': opts.label ?? `Tactical map of ${map.name}`,
      preserveAspectRatio: 'xMidYMid meet',
    });
    if (opts.compact) {
      this.live = svg('svg', { viewBox: this.svg.getAttribute('viewBox')!, class: 'tmap-live', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' });
      this.dyn = svg('g', { class: 'tm-dyn' }, this.live);
    }
    this.highlightId = opts.highlight ?? null;
    this.render(opts.size ?? 560);
    // The map's CSS width is a share of its container, so the first guess is often off (a phone, a
    // narrow column). Measure the real width and redraw, so text is never under TEXT_PX on screen.
    if (!opts.compact && typeof ResizeObserver !== 'undefined') {
      this.resize = new ResizeObserver((entries) => {
        if (!this.svg.isConnected) {
          this.resize?.disconnect();
          return;
        }
        const w = entries[entries.length - 1]?.contentRect.width ?? 0;
        if (w > 0 && Math.abs(w - this.drawnFor) >= 1) this.render(w);
      });
      this.resize.observe(this.svg);
    }
  }

  /** Draws everything for a map shown `width` CSS pixels wide. */
  private render(width: number): void {
    const opts = this.opts;
    const v = this.view;
    const full = this.full;
    const id = this.id;
    this.drawnFor = width;
    const u = v.span / width; // map metres per CSS pixel
    this.u = u;
    this.boxes = [];
    const root = this.svg;
    root.replaceChildren();
    const defs = svg('defs', {}, root);
    const clip = svg('clipPath', { id: `${id}-clip` }, defs);
    svg('rect', { x: full.x0, y: full.z0, width: full.span, height: full.span }, clip);
    const wood = svg('pattern', { id: `${id}-wood`, width: 7 * u, height: 7 * u, patternUnits: 'userSpaceOnUse' }, defs);
    svg('rect', { width: 7 * u, height: 7 * u, class: 'tm-wood' }, wood);
    svg('circle', { cx: 2 * u, cy: 2 * u, r: 1.1 * u, class: 'tm-wood-dot' }, wood);
    svg('circle', { cx: 5.5 * u, cy: 5.5 * u, r: 1.1 * u, class: 'tm-wood-dot' }, wood);
    const hatch = svg('pattern', { id: `${id}-hatch`, width: 6 * u, height: 6 * u, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, defs);
    svg('line', { x1: 0, y1: 0, x2: 0, y2: 6 * u, class: 'tm-hatch', 'stroke-width': 1.6 * u }, hatch);

    svg('rect', { x: v.x0, y: v.z0, width: v.span, height: v.span, class: 'tm-outside' }, root);
    const g = svg('g', { 'clip-path': `url(#${id}-clip)` }, root);
    svg('rect', { x: full.x0, y: full.z0, width: full.span, height: full.span, class: 'tm-bg' }, g);
    this.drawGrid(g, this.pad);
    // Claim space for things labels must never cover: grid references, north arrow, scale bar,
    // hordes and the safehouse.
    const gridRefs = opts.compact ? [] : this.gridRefs();
    if (!opts.compact) this.reserveFurniture();
    if (opts.mission && !opts.compact) this.reserveMission(opts.mission);
    this.drawGround(g, id);
    this.drawRoads(g);
    this.drawBuildings(g);
    if (!opts.compact) this.drawTrees(g);
    this.drawBusRoutes(g);
    if (opts.mission) this.drawMission(g, opts.mission, id);
    if (opts.mission && !opts.compact) this.drawMissionLabels(g, opts.mission);
    if (!opts.compact) this.drawFeatures(g);
    // Grid references go on top of everything on the map, with a dark halo, so they always read.
    if (gridRefs.length) {
      const layer = svg('g', { class: 'tm-gridrefs' }, g);
      for (const r of gridRefs) svg('text', { ...r.attrs, class: 'tm-gridref', 'font-size': TEXT_PX * u, 'stroke-width': r1(4 * u) }, layer, r.text);
    }
    if (!opts.compact) {
      this.dyn = svg('g', { class: 'tm-dyn' }, root);
      this.drawFurniture(root);
    }
    if (this.highlightId) this.setHighlight(this.highlightId);
  }

  // ---------- base map ----------
  private drawGrid(g: SVGGElement, pad: number): void {
    const half = this.half;
    const step = half > 800 ? 200 : 100;
    const first = -Math.floor(half / step) * step;
    let d = '';
    for (let v = first; v <= half; v += step) d += `M${v} ${-half - pad}V${half + pad}M${-half - pad} ${v}H${half + pad}`;
    svg('path', { d, class: 'tm-grid', 'stroke-width': 0.8 * this.u }, g);
  }

  /**
   * Grid references along the top (letters) and left (numbers) of the view, like a map sheet.
   * They're counted from the map's own corner, so a zoomed briefing map uses the same squares.
   * Their space is reserved now; they're drawn last, on top of the map.
   */
  private gridRefs(): { text: string; attrs: Attrs }[] {
    const half = this.half;
    const step = half > 800 ? 200 : 100;
    const first = -Math.floor(half / step) * step;
    const u = this.u;
    const fs = TEXT_PX * u;
    const vw = this.view;
    const inset = 4 * u;
    const out: { text: string; attrs: Attrs }[] = [];
    let k = 0;
    for (let v = first; v < half; v += step, k++) {
      const mid = v + step / 2;
      const letter = String.fromCharCode(65 + (k % 26));
      // Letters stay clear of the north arrow (top right); numbers clear of the letters and the scale bar.
      if (mid > vw.x0 + fs * 2 && mid < vw.x0 + vw.span - 32 * u) {
        const y = vw.z0 + inset;
        this.boxes.push({ x0: mid - fs * 0.5, y0: y, x1: mid + fs * 0.5, y1: y + fs * 1.1 });
        out.push({ text: letter, attrs: { x: r1(mid), y: r1(y), 'text-anchor': 'middle', 'dominant-baseline': 'hanging' } });
      }
      if (mid > vw.z0 + fs * 2.5 && mid < vw.z0 + vw.span - 30 * u) {
        const x = vw.x0 + inset;
        const t = String(k + 1);
        this.boxes.push({ x0: x, y0: mid - fs * 0.6, x1: x + t.length * fs * CHAR_W + u, y1: mid + fs * 0.6 });
        out.push({ text: t, attrs: { x: r1(x), y: r1(mid), 'dominant-baseline': 'central' } });
      }
    }
    return out;
  }

  /** The north arrow and scale bar's corners: no label goes there. */
  private reserveFurniture(): void {
    const u = this.u;
    const v = this.view;
    this.boxes.push({ x0: v.x0 + v.span - 30 * u, y0: v.z0, x1: v.x0 + v.span, y1: v.z0 + 50 * u });
    const len = scaleLength(v.span);
    const label = `${len} m`;
    this.boxes.push({ x0: v.x0, y0: v.z0 + v.span - 30 * u, x1: v.x0 + 14 * u + len + 8 * u + label.length * TEXT_PX * CHAR_W * u, y1: v.z0 + v.span });
  }

  /** Horde circles and the safehouse: labels and symbols must not cover them. */
  private reserveMission(m: Mission): void {
    const u = this.u;
    for (const h of m.hordes) {
      const r = 30 + (h.cold > 0 ? 7.5 * u : 1 * u);
      this.boxes.push({ x0: h.centre.x - r, y0: h.centre.z - r, x1: h.centre.x + r, y1: h.centre.z + r });
    }
    if (m.safehouse) {
      const b = bounds(m.safehouse.poly);
      this.boxes.push({ x0: b.minX - 2 * u, y0: b.minZ - 2 * u, x1: b.maxX + 2 * u, y1: b.maxZ + 2 * u });
    }
  }

  private drawGround(g: SVGGElement, id: string): void {
    const parks: string[] = [];
    const woods: string[] = [];
    const water: string[] = [];
    for (const a of this.map.areas) {
      if (a.pts.length < 3) continue;
      (a.kind === 'water' ? water : a.kind === 'wood' ? woods : parks).push(polyD(a.pts, true));
    }
    // Places mapped only as an outline (no area of their own) still show as open ground.
    const areaIds = new Set(this.map.areas.map((a) => a.id));
    for (const f of mapFeatures(this.map)) {
      if (!f.pts || f.pts.length < 3 || areaIds.has(f.id)) continue;
      if (f.category === 'forest') woods.push(polyD(f.pts, true));
      else if (f.category === 'park') parks.push(polyD(f.pts, true));
    }
    if (parks.length) svg('path', { d: parks.join(''), class: 'tm-park' }, g);
    if (woods.length) svg('path', { d: woods.join(''), fill: `url(#${id}-wood)`, class: 'tm-woods' }, g);
    if (water.length) svg('path', { d: water.join(''), class: 'tm-water' }, g);
    // Outlines of sports grounds, schools, shops and the like.
    const outlines: string[] = [];
    for (const f of mapFeatures(this.map)) {
      if (f.pts && f.pts.length >= 3 && f.category !== 'park' && f.category !== 'forest') outlines.push(polyD(f.pts, true));
    }
    if (outlines.length) svg('path', { d: outlines.join(''), class: 'tm-grounds', 'stroke-width': 0.9 * this.u }, g);
  }

  private drawRoads(g: SVGGElement): void {
    const groups: Record<string, string[]> = { minor: [], street: [], major: [] };
    for (const r of this.map.roads) {
      if (r.pts.length < 2) continue;
      groups[MAJOR.has(r.kind) ? 'major' : MINOR.has(r.kind) ? 'minor' : 'street'].push(polyD(r.pts, false));
    }
    const u = this.u;
    const w = { minor: Math.max(1.5, 0.8 * u), street: Math.max(7, 2.2 * u), major: Math.max(10, 3.4 * u) };
    for (const k of ['minor', 'street', 'major'] as const) {
      if (groups[k].length) svg('path', { d: groups[k].join(''), class: `tm-road tm-road-${k}`, 'stroke-width': r1(w[k]) }, g);
    }
  }

  private drawBuildings(g: SVGGElement): void {
    const d: string[] = [];
    for (const b of this.map.buildings) if (b.pts.length >= 3) d.push(polyD(b.pts, true));
    if (d.length) svg('path', { d: d.join(''), class: 'tm-bldg' }, g);
  }

  private drawTrees(g: SVGGElement): void {
    const trees = this.map.trees ?? [];
    if (!trees.length) return;
    const r = 1.2 * this.u;
    const d = trees.map((p) => `M${r1(p.x - r)} ${r1(p.z)}a${r1(r)} ${r1(r)} 0 1 0 ${r1(2 * r)} 0a${r1(r)} ${r1(r)} 0 1 0 ${r1(-2 * r)} 0`).join('');
    svg('path', { d, class: 'tm-tree' }, g);
  }

  private drawBusRoutes(g: SVGGElement): void {
    const routes = this.map.busRoutes ?? [];
    const u = this.u;
    for (const r of routes) {
      const d = r.lines.map((l) => polyD(l, false)).join('');
      svg('path', { d, class: 'tm-bus', 'stroke-width': 2.2 * u, 'stroke-dasharray': `${6 * u} ${4 * u}` }, g);
      if (this.opts.compact || !r.ref) continue;
      // Tag the route once, at the middle of its longest line inside the map.
      const line = [...r.lines].sort((a, b) => b.length - a.length)[0];
      const p = line.find((q) => Math.abs(q.x) < this.half * 0.85 && Math.abs(q.z) < this.half * 0.85) ?? line[0];
      this.tag(g, p, `BUS ${r.ref}`, 'tm-bus-tag');
    }
  }

  /** A small boxed tag (used for bus route numbers). */
  private tag(g: SVGGElement, p: V2, text: string, cls: string): void {
    const u = this.u;
    const fs = TEXT_PX * u;
    const w = text.length * fs * CHAR_W + 8 * u;
    const h = fs + 6 * u;
    if (!this.reserve(p.x - w / 2, p.z - h / 2, p.x + w / 2, p.z + h / 2)) return;
    const t = svg('g', { class: cls, transform: `translate(${r1(p.x)} ${r1(p.z)})` }, g);
    svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 2 * u, 'stroke-width': u }, t);
    svg('text', { 'font-size': fs, 'text-anchor': 'middle', 'dominant-baseline': 'central' }, t, text);
  }

  /** Simple label placement: refuse anything that overlaps what's already there. */
  private reserve(x0: number, y0: number, x1: number, y1: number): boolean {
    const v = this.view;
    const m = 2 * this.u;
    if (x0 < v.x0 + m || y0 < v.z0 + m || x1 > v.x0 + v.span - m || y1 > v.z0 + v.span - m) return false; // would be cut off at the edge
    if (this.boxes.some((b) => x0 < b.x1 && x1 > b.x0 && y0 < b.y1 && y1 > b.y0)) return false;
    this.boxes.push({ x0, y0, x1, y1 });
    return true;
  }

  // ---------- places ----------
  private drawFeatures(g: SVGGElement): void {
    const u = this.u;
    const layer = svg('g', { class: 'tm-symbols' }, g);
    const anchorId = this.opts.mission?.anchor?.id ?? this.opts.highlight;
    const feats = [...mapFeatures(this.map)]
      .filter((f) => Math.abs(f.p.x) <= this.half && Math.abs(f.p.z) <= this.half)
      .sort((a, b) => (b.id === anchorId ? 1 : 0) - (a.id === anchorId ? 1 : 0) || CATEGORY_INFO[b.category].weight - CATEGORY_INFO[a.category].weight || (b.name ? 1 : 0) - (a.name ? 1 : 0) || (a.id < b.id ? -1 : 1))
      .slice(0, 80);
    const fs = TEXT_PX * u;
    for (const f of feats) {
      const code = CATEGORY_INFO[f.category].code;
      const w = Math.max(28, code.length * TEXT_PX * 0.68 + 10) * u;
      const h = (TEXT_PX + 6) * u;
      if (!this.reserve(f.p.x - w / 2 - 2 * u, f.p.z - h / 2 - 2 * u, f.p.x + w / 2 + 2 * u, f.p.z + h / 2 + 2 * u)) continue;
      const s = svg('g', { class: `tm-sym tm-${FAMILY[f.category]}`, transform: `translate(${r1(f.p.x)} ${r1(f.p.z)})`, 'data-feature': f.id }, layer);
      symbolFrame(s, f.category, w, h, u);
      svg('text', { 'font-size': fs, 'text-anchor': 'middle', 'dominant-baseline': 'central', y: 0.3 * u }, s, code);
      if (f.name && CATEGORY_INFO[f.category].weight >= 4) this.label(layer, f, h);
    }
  }

  private label(layer: SVGGElement, f: Feature, symH: number): void {
    const u = this.u;
    const fs = TEXT_PX * u;
    const text = f.name!.length > 28 ? `${f.name!.slice(0, 27)}…` : f.name!;
    const w = text.length * fs * CHAR_W;
    const y = f.p.z + symH / 2 + 3 * u;
    if (!this.reserve(f.p.x - w / 2, y, f.p.x + w / 2, y + fs * 1.1)) return;
    svg('text', { x: r1(f.p.x), y: r1(y), class: 'tm-label', 'font-size': fs, 'text-anchor': 'middle', 'dominant-baseline': 'hanging', 'stroke-width': 3 * u, 'data-feature': f.id }, layer, text);
  }

  /** Emphasise one place (e.g. the mission card under the pointer). Pass null to clear. */
  setHighlight(featureId: string | null): void {
    this.highlightId = featureId;
    for (const e of this.svg.querySelectorAll('.tm-sym.hl')) e.classList.remove('hl');
    this.svg.querySelector('.tm-hl-outline')?.remove();
    if (!featureId) return;
    const f = mapFeatures(this.map).find((x) => x.id === featureId);
    if (!f) return;
    for (const e of this.svg.querySelectorAll('.tm-sym')) if (e.getAttribute('data-feature') === featureId) e.classList.add('hl');
    const u = this.u;
    const ring = f.pts && f.pts.length >= 3
      ? svg('path', { d: polyD(f.pts, true), class: 'tm-hl-outline', 'stroke-width': 2.5 * u })
      : svg('circle', { cx: r1(f.p.x), cy: r1(f.p.z), r: 22 * u, class: 'tm-hl-outline', 'stroke-width': 2.5 * u });
    const symbols = this.svg.querySelector('.tm-symbols');
    if (symbols?.parentNode) symbols.parentNode.insertBefore(ring, symbols);
    else this.svg.insertBefore(ring, this.dyn);
  }

  // ---------- mission overlays ----------
  private drawMission(g: SVGGElement, m: Mission, id: string): void {
    const u = this.u;
    const layer = svg('g', { class: 'tm-mission' }, g);
    const compact = !!this.opts.compact;
    if (m.anchor?.pts && m.anchor.pts.length >= 3) svg('path', { d: polyD(m.anchor.pts, true), class: 'tm-anchor', 'stroke-width': 2 * u, 'stroke-dasharray': `${5 * u} ${3 * u}` }, layer);
    // Where the waves come from.
    if (m.waves && m.type === 'defend' && m.safehouse) {
      const c = m.safehouse.centre;
      const ring = `M${r1(c.x - m.waves.maxDist)} ${r1(c.z)}a${m.waves.maxDist} ${m.waves.maxDist} 0 1 0 ${2 * m.waves.maxDist} 0a${m.waves.maxDist} ${m.waves.maxDist} 0 1 0 ${-2 * m.waves.maxDist} 0Z` +
        `M${r1(c.x - m.waves.minDist)} ${r1(c.z)}a${m.waves.minDist} ${m.waves.minDist} 0 1 1 ${2 * m.waves.minDist} 0a${m.waves.minDist} ${m.waves.minDist} 0 1 1 ${-2 * m.waves.minDist} 0Z`;
      svg('path', { d: ring, class: 'tm-wavezone', 'fill-rule': 'evenodd', fill: `url(#${id}-hatch)` }, layer);
      for (const w of this.opts.waves ?? []) this.arrow(layer, w.from, w.to, m.waves.minDist * 0.45, compact ? null : `${w.compass.toUpperCase()}`);
    }
    // Escort: ambushes form ahead of the group, beside the route.
    if (m.route) {
      svg('path', { d: polyD(m.route, false), class: 'tm-ambush', 'stroke-width': 120 }, layer);
      svg('path', { d: polyD(m.route, false), class: 'tm-route-casing', 'stroke-width': 7 * u }, layer);
      svg('path', { d: polyD(m.route, false), class: 'tm-route', 'stroke-width': 3.2 * u, 'stroke-dasharray': `${9 * u} ${5 * u}` }, layer);
    }
    for (const h of m.hordes) {
      const cold = h.cold > 0;
      svg('circle', { cx: r1(h.centre.x), cy: r1(h.centre.z), r: 30, class: `tm-horde${cold ? ' cold' : ''}`, 'stroke-width': 1.6 * u }, layer);
      if (cold) svg('circle', { cx: r1(h.centre.x), cy: r1(h.centre.z), r: 30 + 6 * u, class: 'tm-coldring', 'stroke-width': 1.4 * u, 'stroke-dasharray': `${3 * u} ${3 * u}` }, layer);
      // Hostile marker: a diamond, as on a real overlay.
      const s = 6 * u;
      svg('path', { d: `M${r1(h.centre.x)} ${r1(h.centre.z - s)}l${r1(s)} ${r1(s)}l${r1(-s)} ${r1(s)}l${r1(-s)} ${r1(-s)}Z`, class: 'tm-hostile', 'stroke-width': u }, layer);
    }
    if (m.safehouse) svg('path', { d: polyD(m.safehouse.poly, true), class: 'tm-safehouse', 'stroke-width': 2.4 * u }, layer);
    if (m.home) {
      const s = 7 * u;
      const c = m.home.centre;
      svg('path', { d: `M${r1(c.x)} ${r1(c.z - s)}L${r1(c.x + s)} ${r1(c.z)}L${r1(c.x)} ${r1(c.z + s)}L${r1(c.x - s)} ${r1(c.z)}Z`, class: 'tm-home', 'stroke-width': 1.4 * u }, layer);
    }
    // Sheltering friendlies (clear missions).
    for (const sp of m.survivors) {
      if (sp.route) continue;
      svg('circle', { cx: r1(sp.start.x), cy: r1(sp.start.z), r: 3.5 * u, class: 'tm-friendly', 'stroke-width': u }, layer);
    }
    // The aircraft's orbit: centre mark and the circle itself (usually wider than the map).
    const oc = m.orbitCentre;
    svg('circle', { cx: r1(oc.x), cy: r1(oc.z), r: ORBIT.radius, class: 'tm-orbit', 'stroke-width': 1.6 * u, 'stroke-dasharray': `${10 * u} ${6 * u}` }, layer);
    const k = 7 * u;
    svg('path', { d: `M${r1(oc.x - k)} ${r1(oc.z)}H${r1(oc.x + k)}M${r1(oc.x)} ${r1(oc.z - k)}V${r1(oc.z + k)}`, class: 'tm-orbitmark', 'stroke-width': 1.4 * u }, layer);
    svg('circle', { cx: r1(oc.x), cy: r1(oc.z), r: k * 0.6, class: 'tm-orbitmark', 'stroke-width': 1.4 * u }, layer);
  }

  private arrow(g: SVGGElement, from: V2, to: V2, stopShort: number, text: string | null): void {
    const u = this.u;
    const dx = to.x - from.x;
    const dz = to.z - from.z;
    const L = Math.hypot(dx, dz) || 1;
    const ux = dx / L;
    const uz = dz / L;
    const end = { x: to.x - ux * stopShort, z: to.z - uz * stopShort };
    const start = { x: from.x, z: from.z };
    const hw = 6 * u;
    const hl = 11 * u;
    const base = { x: end.x - ux * hl, z: end.z - uz * hl };
    svg('path', { d: `M${r1(start.x)} ${r1(start.z)}L${r1(base.x)} ${r1(base.z)}`, class: 'tm-wave', 'stroke-width': 3 * u }, g);
    svg('path', { d: `M${r1(end.x)} ${r1(end.z)}L${r1(base.x - uz * hw)} ${r1(base.z + ux * hw)}L${r1(base.x + uz * hw)} ${r1(base.z - ux * hw)}Z`, class: 'tm-wave-head' }, g);
    if (text) {
      // Label a third of the way along, kept inside the view; it claims its space before place names.
      const fs = TEXT_PX * u;
      const w = text.length * fs * CHAR_W;
      const v = this.view;
      const x = Math.max(v.x0 + w / 2 + 4 * u, Math.min(v.x0 + v.span - w / 2 - 4 * u, start.x + (base.x - start.x) * 0.33));
      const y = Math.max(v.z0 + fs, Math.min(v.z0 + v.span - fs, start.z + (base.z - start.z) * 0.33));
      this.boxes.push({ x0: x - w / 2, y0: y - fs * 0.6, x1: x + w / 2, y1: y + fs * 0.6 });
      svg('text', { x: r1(x), y: r1(y), class: 'tm-wave-label', 'font-size': fs, 'text-anchor': 'middle', 'dominant-baseline': 'central', 'stroke-width': 3 * u }, g, text);
    }
  }

  private drawMissionLabels(g: SVGGElement, m: Mission): void {
    const u = this.u;
    const layer = svg('g', { class: 'tm-mlabels' }, g);
    const fs = TEXT_PX * u;
    /**
     * Tries above, below, then to either side of a thing `cx` by `cz` metres from its centre (half
     * width and height). Labels never overlap each other, hordes, the safehouse or the grid letters.
     */
    const put = (p: V2, text: string, cls: string, cx: number, cz = cx) => {
      const w = text.length * fs * CHAR_W;
      const h = fs * 1.25;
      const gap = 3 * u;
      // [left edge, top edge, text x, anchor]
      const spots: [number, number, number, 'middle' | 'start' | 'end'][] = [
        [p.x - w / 2, p.z - cz - gap - h, p.x, 'middle'],
        [p.x - w / 2, p.z + cz + gap, p.x, 'middle'],
        [p.x + cx + gap, p.z - h / 2, p.x + cx + gap, 'start'],
        [p.x - cx - gap - w, p.z - h / 2, p.x - cx - gap, 'end'],
      ];
      for (const [x0, y0, x, anchor] of spots) {
        if (!this.reserve(x0, y0, x0 + w, y0 + h)) continue;
        svg('text', { x: r1(x), y: r1(y0 + h * 0.8), class: `tm-mlabel ${cls}`, 'font-size': fs, 'text-anchor': anchor, 'stroke-width': r1(3 * u) }, layer, text);
        return;
      }
    };
    if (m.safehouse) {
      const b = bounds(m.safehouse.poly);
      const c = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
      put(c, 'SAFEHOUSE', 'safe', (b.maxX - b.minX) / 2 + 2 * u, (b.maxZ - b.minZ) / 2 + 2 * u);
    }
    if (m.home) put(m.home.centre, 'HOME', 'home', 9 * u);
    // Hordes at the same place share one label, so a cluster in a park reads as one group.
    const groups = new Map<string, Mission['hordes']>();
    for (const h of m.hordes) groups.set(h.label, [...(groups.get(h.label) ?? []), h]);
    for (const hs of groups.values()) {
      const c = { x: hs.reduce((s, h) => s + h.centre.x, 0) / hs.length, z: hs.reduce((s, h) => s + h.centre.z, 0) / hs.length };
      const spread = Math.max(...hs.map((h) => Math.hypot(h.centre.x - c.x, h.centre.z - c.z)));
      const n = hs.reduce((s, h) => s + h.count, 0);
      const cold = hs.reduce((s, h) => s + h.cold, 0);
      const what = hs.length > 1 ? `${hs.length} HORDES ×${n}` : `HORDE ×${n}`;
      put(c, cold ? `${what} · ${cold} COLD` : what, 'hostile', spread + 30 + 8 * u);
    }
    const shelter = m.survivors.find((s) => !s.route);
    if (shelter) put(shelter.start, 'FRIENDLIES', 'friendly', 6 * u);
    if (m.route && m.route.length > 2) put(m.route[Math.floor(m.route.length / 2)], 'AMBUSH ZONE', 'hostile', 64);
    // The orbit centre has its own mark and a legend entry; it needs no label.
  }

  // ---------- north arrow, scale bar ----------
  private drawFurniture(root: SVGSVGElement): void {
    const u = this.u;
    const v = this.view;
    const f = svg('g', { class: 'tm-furniture' }, root);
    // North arrow, top right.
    const nx = v.x0 + v.span - 18 * u;
    const ny = v.z0 + 10 * u;
    svg('path', { d: `M${r1(nx)} ${r1(ny)}l${r1(6 * u)} ${r1(18 * u)}l${r1(-6 * u)} ${r1(-5 * u)}l${r1(-6 * u)} ${r1(5 * u)}Z`, class: 'tm-north' }, f);
    svg('text', { x: r1(nx), y: r1(ny + 33 * u), 'font-size': TEXT_PX * u, 'text-anchor': 'middle', class: 'tm-furn-text', 'stroke-width': r1(3 * u) }, f, 'N');
    // Scale bar, bottom left: a round length near a fifth of the view.
    const len = scaleLength(v.span);
    const sx = v.x0 + 14 * u;
    const sy = v.z0 + v.span - 12 * u;
    svg('path', { d: `M${r1(sx)} ${r1(sy - 4 * u)}V${r1(sy)}H${r1(sx + len)}V${r1(sy - 4 * u)}M${r1(sx + len / 2)} ${r1(sy - 3 * u)}V${r1(sy)}`, class: 'tm-scale', 'stroke-width': 1.5 * u }, f);
    svg('text', { x: r1(sx + len + 5 * u), y: r1(sy), 'font-size': TEXT_PX * u, class: 'tm-furn-text', 'stroke-width': r1(3 * u) }, f, `${len} m`);
  }

  // ---------- live layer (HUD minimap) ----------
  /** Moves the aircraft, aim point and survivors. Cheap: only the live layer is rebuilt. */
  update(s: { aircraft?: V2; aim?: V2; survivors?: V2[] }): void {
    const u = this.u;
    const lim = this.half * 0.97;
    this.dyn.replaceChildren();
    for (const p of s.survivors ?? []) svg('circle', { cx: r1(p.x), cy: r1(p.z), r: 4 * u, class: 'tm-friendly live', 'stroke-width': u }, this.dyn);
    if (s.aim) {
      const k = 9 * u;
      const a = s.aim;
      svg('path', { d: `M${r1(a.x - k)} ${r1(a.z)}H${r1(a.x - k / 3)}M${r1(a.x + k / 3)} ${r1(a.z)}H${r1(a.x + k)}M${r1(a.x)} ${r1(a.z - k)}V${r1(a.z - k / 3)}M${r1(a.x)} ${r1(a.z + k / 3)}V${r1(a.z + k)}`, class: 'tm-aim', 'stroke-width': 2 * u }, this.dyn);
    }
    if (s.aircraft) {
      const a = s.aircraft;
      const prev = this.lastAircraft;
      this.lastAircraft = { ...a };
      const heading = prev && (prev.x !== a.x || prev.z !== a.z) ? Math.atan2(a.x - prev.x, -(a.z - prev.z)) : 0;
      const inside = Math.abs(a.x) <= lim && Math.abs(a.z) <= lim;
      if (inside) {
        svg('path', { d: `M0 ${r1(-9 * u)}L${r1(7 * u)} ${r1(7 * u)}L0 ${r1(3 * u)}L${r1(-7 * u)} ${r1(7 * u)}Z`, class: 'tm-aircraft', transform: `translate(${r1(a.x)} ${r1(a.z)}) rotate(${r1((heading * 180) / Math.PI)})` }, this.dyn);
      } else {
        // Off the map (the orbit is wider than the area): a pointer on the edge, toward the aircraft.
        const k = Math.max(Math.abs(a.x), Math.abs(a.z)) / lim;
        const e = { x: a.x / k, z: a.z / k };
        const ang = (Math.atan2(a.x, -a.z) * 180) / Math.PI;
        svg('path', { d: `M0 ${r1(-10 * u)}L${r1(8 * u)} ${r1(6 * u)}L${r1(-8 * u)} ${r1(6 * u)}Z`, class: 'tm-aircraft edge', transform: `translate(${r1(e.x)} ${r1(e.z)}) rotate(${r1(ang)})` }, this.dyn);
      }
    }
  }
}

/** A round scale-bar length near a fifth of the view. */
function scaleLength(span: number): number {
  return [50, 100, 200, 250, 500, 1000].reduce((best, L) => (Math.abs(L - span / 5) < Math.abs(best - span / 5) ? L : best), 100);
}

/** The square that frames a mission's area of operations (at least ~500 m across), inside the map. */
function focusView(m: Mission, full: { x0: number; z0: number; span: number }): { x0: number; z0: number; span: number } {
  const pts: [V2, number][] = [];
  for (const h of m.hordes) pts.push([h.centre, 75]);
  if (m.safehouse) pts.push([m.safehouse.centre, m.waves && m.type === 'defend' ? m.waves.maxDist * 0.8 : 90]);
  for (const p of m.route ?? []) pts.push([p, 70]);
  if (m.home) pts.push([m.home.centre, 70]);
  for (const s of m.survivors) pts.push([s.start, 45]);
  if (!pts.length) return full;
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const [p, r] of pts) {
    minX = Math.min(minX, p.x - r);
    maxX = Math.max(maxX, p.x + r);
    minZ = Math.min(minZ, p.z - r);
    maxZ = Math.max(maxZ, p.z + r);
  }
  const span = Math.max(maxX - minX, maxZ - minZ, 500) * 1.06;
  if (span >= full.span * 0.9) return full;
  const clamp = (v: number) => Math.max(full.x0, Math.min(full.x0 + full.span - span, v));
  return { x0: clamp((minX + maxX) / 2 - span / 2), z0: clamp((minZ + maxZ) / 2 - span / 2), span };
}

/** Frame shapes by family: civic = square, sport = rounded, open ground = circle-ish, shops = notched, transport = rail-ended. */
function symbolFrame(g: SVGGElement, c: FeatureCategory, w: number, h: number, u: number): void {
  const fam = FAMILY[c];
  const sw = 1.3 * u;
  if (fam === 'green') {
    svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: h / 2, 'stroke-width': sw }, g);
  } else if (fam === 'sport') {
    svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h, rx: 3 * u, 'stroke-width': sw }, g);
  } else if (fam === 'shop') {
    const k = 3.5 * u;
    svg('path', { d: `M${-w / 2 + k} ${-h / 2}H${w / 2 - k}L${w / 2} ${-h / 2 + k}V${h / 2 - k}L${w / 2 - k} ${h / 2}H${-w / 2 + k}L${-w / 2} ${h / 2 - k}V${-h / 2 + k}Z`, 'stroke-width': sw }, g);
  } else if (fam === 'transport') {
    svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h, 'stroke-width': sw }, g);
    svg('path', { d: `M${-w / 2 + 2 * u} ${-h / 2}V${h / 2}M${w / 2 - 2 * u} ${-h / 2}V${h / 2}`, 'stroke-width': sw, class: 'tm-sym-rail' }, g);
  } else {
    svg('rect', { x: -w / 2, y: -h / 2, width: w, height: h, 'stroke-width': sw }, g);
    if (c === 'hospital') svg('path', { d: `M${w / 2 - 4 * u} ${-h / 2 - 3 * u}v${6 * u}M${w / 2 - 7 * u} ${-h / 2}h${6 * u}`, 'stroke-width': 1.6 * u, class: 'tm-sym-cross' }, g);
  }
}

/** The briefing's map block: tactical map plus a legend for what's on it. */
export function briefingMap(map: MapData, mission: Mission, graph: RoadGraph): HTMLDivElement {
  const wrap = el('div', 'tmap-wrap briefing-map');
  const tm = new TacticalMap(map, { mission, focus: true, waves: likelyWaveDirections(mission, map, graph), size: Math.max(300, Math.min(420, window.innerWidth - 72)), label: `Tactical map: ${mission.title}` });
  wrap.appendChild(tm.svg);
  const legend = el('div', 'tmap-legend', undefined, wrap);
  const item = (cls: string, text: string) => {
    const i = el('span', 'tl-item', undefined, legend);
    el('span', `tl-key ${cls}`, undefined, i);
    el('span', undefined, text, i);
  };
  if (mission.safehouse) item('safe', 'Safehouse');
  if (mission.home) item('home', 'Home');
  if (mission.route) item('route', 'Route (ambushes ahead)');
  if (mission.hordes.length) item('hostile', 'Horde');
  if (mission.hordes.some((h) => h.cold > 0)) item('cold', 'Cold-blooded');
  if (mission.waves && mission.type === 'defend') item('wave', 'Waves from');
  if (mission.survivors.some((s) => !s.route)) item('friendly', 'Friendlies');
  item('orbit', 'Orbit, 1 km radius');
  if (map.busRoutes?.length) item('bus', 'Bus route');
  return wrap;
}

