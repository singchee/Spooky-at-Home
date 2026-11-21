import type { V2 } from '../map/types';
import { polylineLength } from '../map/geom';
import type { Mission } from '../sim/missions';
import type { BriefingDiorama } from './briefingDiorama';
import { el } from './dom';
import { getSettings, onSettingsChange } from './settings';
import { blendPose, easeInOut, markTourSeen, pointAlong, stopAt, tourTimeline, type Pose, type TourMark, type TourStop, type TourTimeline } from './briefingTour';
import { TOUR_TEXT } from './briefingTourText';

/**
 * The walk-through's view: drives the diorama's camera through the stops (briefingTour.ts), shows
 * each stop's caption (textContent only: names come from OpenStreetMap), highlights the subject on
 * both the diorama and the tactical map, and offers Skip / Replay. Under reduced motion or Reduce
 * flicker there is no camera flight: the stops are a stepped list with Back / Next that cut
 * between framings. Dragging or turning the model hands the camera to the player.
 */

/** Slow turn during a hold, radians per second (about the free turntable's speed). */
const DRIFT = 0.06;
/** Turn between stops that don't ask for a particular side, radians. */
const STEP_TURN = 0.5;

const reducedMotionQuery: MediaQueryList | null = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const wantsStill = () => !!reducedMotionQuery?.matches || getSettings().reduceFlicker;

type Finish = 'end' | 'skip' | 'interrupt';

/** Test-only controls (see the constructor). */
interface TourHook {
  times(): { t0: number; move: number; hold: number }[];
  total(): number;
  /** Jump the flight to tour time t (starts it if it isn't playing). */
  seek(t: number): void;
  /** Hold the clock still (the camera keeps drawing). */
  freeze(on: boolean): void;
  /** Run the clock k times faster (still dt-scaled). */
  rate(k: number): void;
}

export class BriefingTour {
  readonly el: HTMLDivElement;
  private mode: 'anim' | 'steps';
  private state: 'playing' | 'done' = 'done';
  private t = 0;
  /** Stepped list: the stop shown, or stops.length for the whole area. */
  private idx = 0;
  private shown = -2;
  private raf = 0;
  private last = 0;
  private tl: TourTimeline;
  private azs: number[] = [];
  private azEnd = 0;
  private disposed = false;
  private cleanups: (() => void)[] = [];
  private visited: string[] = [];
  private stepEl: HTMLSpanElement;
  private capEl: HTMLParagraphElement;
  private ctrl: HTMLDivElement;
  private list: HTMLOListElement;
  private items: HTMLLIElement[] = [];
  private mapLayer: MapTourLayer | null;

  constructor(
    private dio: BriefingDiorama | null,
    mapBlock: HTMLElement | null,
    private stops: TourStop[],
    private mission: Mission,
    startDone: boolean,
  ) {
    this.tl = tourTimeline(stops);
    this.el = el('div', 'tour');
    this.el.setAttribute('role', 'region');
    this.el.setAttribute('aria-label', TOUR_TEXT.ui.region);
    this.el.dataset.stops = stops.map((s) => s.id).join(',');
    this.el.dataset.total = this.tl.total.toFixed(1);
    const bar = el('div', 'tour-bar', undefined, this.el);
    this.stepEl = el('span', 'tour-step', '', bar);
    this.capEl = el('p', 'tour-cap', '', bar);
    this.capEl.setAttribute('aria-live', 'polite');
    this.ctrl = el('div', 'tour-ctrl', undefined, this.el);
    this.list = el('ol', 'tour-list', undefined, this.el);
    this.list.setAttribute('aria-label', TOUR_TEXT.ui.listLabel);
    for (const s of stops) this.items.push(el('li', `tour-item ${s.kind}`, s.caption, this.list));
    this.mapLayer = mapBlock ? MapTourLayer.attach(mapBlock) : null;

    if (dio) dio.onInteract = () => this.interrupt();
    const onKey = (e: KeyboardEvent) => this.onKey(e);
    window.addEventListener('keydown', onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey));
    const motion = () => this.syncMode();
    if (reducedMotionQuery) {
      reducedMotionQuery.addEventListener('change', motion);
      this.cleanups.push(() => reducedMotionQuery.removeEventListener('change', motion));
    }
    this.cleanups.push(onSettingsChange(motion));

    this.mode = wantsStill() ? 'steps' : 'anim';
    if (this.mode === 'steps') this.goTo(startDone ? stops.length : 0);
    else if (startDone) this.finish('skip', false);
    else this.play();
    markTourSeen(mission);

    // Test hooks for scripts/playtest.mjs, only under browser automation (navigator.webdriver), as in Game:
    // a slow headless machine can hold a stop still for a screenshot, or run the clock faster.
    if (typeof navigator !== 'undefined' && navigator.webdriver) {
      const hook: TourHook = {
        times: () => this.tl.segs.map((s) => ({ t0: s.t0, move: s.move, hold: s.hold })),
        total: () => this.tl.total,
        seek: (t) => {
          if (this.mode !== 'anim') return;
          if (this.state !== 'playing') this.play();
          this.t = t;
          this.apply();
        },
        freeze: (on) => {
          this.frozen = on;
        },
        rate: (k) => {
          this.rate = k;
        },
      };
      (this.el as HTMLElement & { tourHook?: TourHook }).tourHook = hook;
    }
  }

  private frozen = false;
  private rate = 1;

  // ---------- animated tour ----------

  /** Start (or restart) the flight from the first stop. */
  play(): void {
    if (this.disposed) return;
    if (this.mode === 'steps') {
      this.goTo(0);
      return;
    }
    this.state = 'playing';
    this.t = 0;
    this.last = 0;
    this.shown = -2;
    this.visited = [];
    this.planAzimuths();
    this.renderControls();
    this.apply();
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  /** The camera's heading at each stop: wave stops look in from where the waves come; the rest turn gently onward. */
  private planAzimuths(): void {
    let a = this.dio?.azimuth ?? 0;
    this.azs = this.stops.map((s, i) => {
      if (i > 0) {
        a = s.lookFrom ? Math.atan2(s.lookFrom.z - s.focus.p.z, s.lookFrom.x - s.focus.p.x) : a + DRIFT * this.tl.segs[i - 1].hold + STEP_TURN;
      }
      return a;
    });
    const n = this.stops.length - 1;
    this.azEnd = this.azs[n] + DRIFT * (this.tl.segs[n].hold + this.tl.total - this.tl.settleAt);
  }

  private tick = (now: number): void => {
    this.raf = 0;
    if (this.disposed || this.state !== 'playing' || this.mode !== 'anim') return;
    const dt = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.frozen) this.t += dt * this.rate;
    if (this.t >= this.tl.total) {
      this.finish('end');
      return;
    }
    this.apply();
    this.raf = requestAnimationFrame(this.tick);
  };

  /** Camera, caption and highlight for the current time. */
  private apply(): void {
    const i = stopAt(this.tl, this.t);
    if (i >= 0 && i !== this.shown) this.show(i);
    const s = i >= 0 ? this.stops[i] : null;
    if (s?.path) {
      const seg = this.tl.segs[i];
      const at = this.routePoint(s, Math.max(0, this.t - seg.t0 - seg.move) / seg.hold);
      this.dio?.setMark(s.mark, at);
      this.mapLayer?.moveDot(at);
    }
    if (!this.dio) return;
    this.dio.setPose(this.poseAt(this.t));
  }

  private routePoint(s: TourStop, k: number): V2 {
    return pointAlong(s.path!, easeInOut(k) * polylineLength(s.path!));
  }

  /** The camera at tour time t: holds drift slowly, moves ease between stops, and it ends on the free turntable's view. */
  private poseAt(t: number): Pose {
    const { segs, settleAt, total } = this.tl;
    if (t >= settleAt) {
      const n = segs.length - 1;
      return blendPose(this.holdPose(n, segs[n].hold), this.dio!.overviewPose(this.azEnd, 0.98), easeInOut((t - settleAt) / (total - settleAt)));
    }
    const i = Math.max(0, stopAt(this.tl, t));
    const seg = segs[i];
    const local = t - seg.t0;
    if (local < seg.move) return blendPose(this.holdPose(i - 1, segs[i - 1].hold), this.holdPose(i, 0), easeInOut(local / seg.move));
    return this.holdPose(i, local - seg.move);
  }

  /** Stop i's camera, `h` seconds into its hold. */
  private holdPose(i: number, h: number): Pose {
    const dio = this.dio!;
    const s = this.stops[i];
    const hold = this.tl.segs[i].hold;
    const az = this.azs[i] + DRIFT * h;
    if (s.kind === 'area') {
      // Establishing shot: from high and wide, settling down onto the whole area.
      const from = dio.overviewPose(this.azs[i], 1.18);
      const to = dio.overviewPose(this.azs[i] + DRIFT * hold, 1.02);
      return blendPose({ ...from, dist: from.dist * 1.3 }, to, easeInOut(h / hold));
    }
    if (s.kind === 'orbit') {
      const o = dio.overviewPose(az, s.elev);
      return { ...o, dist: o.dist * 1.08 };
    }
    if (s.path) return dio.framePose({ ...s.focus, p: this.routePoint(s, h / hold) }, az, s.elev);
    return dio.framePose(s.focus, az, s.elev);
  }

  /** Caption, step counter, labels and highlights for stop i. */
  private show(i: number): void {
    this.shown = i;
    const s = this.stops[i];
    this.capEl.textContent = s.caption;
    this.stepEl.textContent = TOUR_TEXT.ui.step(i + 1, this.stops.length);
    this.el.dataset.stop = s.id;
    this.el.dataset.index = String(i);
    if (this.visited[this.visited.length - 1] !== s.id) this.visited.push(s.id);
    this.el.dataset.visited = this.visited.join(',');
    this.dio?.setFocusLabels(s.labels, s.kind === 'area' ? 5 : null);
    this.dio?.setMark(s.mark, s.path?.[0]);
    this.mapLayer?.set(s.mark, wantsStill());
    this.items.forEach((li, k) => {
      li.classList.toggle('cur', k === i);
      if (k === i) li.setAttribute('aria-current', 'step');
      else li.removeAttribute('aria-current');
    });
  }

  private clearStop(): void {
    this.shown = -2;
    this.dio?.setFocusLabels([]);
    this.dio?.setMark(null);
    this.mapLayer?.set(null, true);
    this.el.dataset.stop = '';
    this.el.dataset.index = '';
    for (const li of this.items) {
      li.classList.remove('cur');
      li.removeAttribute('aria-current');
    }
  }

  /**
   * The tour stops: at its natural end (the camera is already on the free turntable's view), when
   * skipped (cut to the whole area), or when the player grabs the model (it eases out while they turn it).
   */
  private finish(why: Finish, remember = true): void {
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    const wasPlaying = this.state === 'playing';
    this.state = 'done';
    this.el.dataset.ended = why;
    if (remember) markTourSeen(this.mission);
    if (this.dio) {
      if (why === 'interrupt' && wasPlaying) this.dio.releasePose({ ease: true, idle: true });
      else if (why === 'end') this.dio.resetView(this.azEnd);
      else this.dio.resetView();
    }
    this.clearStop();
    this.capEl.textContent = '';
    this.stepEl.textContent = '';
    this.renderControls();
  }

  skip(): void {
    if (this.mode === 'anim' && this.state === 'playing') this.finish('skip');
    else if (this.mode === 'steps') this.goTo(this.stops.length);
  }

  /** The player dragged or turned the model: they have the camera now. */
  private interrupt(): void {
    if (this.mode === 'anim' && this.state === 'playing') this.finish('interrupt');
    // Stepped list: keep the stop's framing and let them turn it (no camera flight).
    else if (this.mode === 'steps') this.dio?.releasePose({ ease: false, idle: true });
  }

  private onKey(e: KeyboardEvent): void {
    if (this.mode !== 'anim' || this.state !== 'playing' || !this.el.isConnected) return;
    if ((e.key !== ' ' && e.key !== 'Enter') || e.altKey || e.ctrlKey || e.metaKey || e.repeat) return;
    // A focused button, link or field keeps its own Space and Enter.
    const t = e.target instanceof Element ? e.target : null;
    if (t?.closest('button, a[href], input, select, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
    this.finish('skip');
  }

  // ---------- stepped list (reduced motion) ----------

  /** Cut to stop k's framing (no animation); k = stops.length is the whole area. */
  private goTo(k: number): void {
    const n = this.stops.length;
    this.idx = Math.max(0, Math.min(n, k));
    this.state = 'done';
    if (this.idx === n) {
      this.clearStop();
      this.dio?.resetView();
      this.stepEl.textContent = TOUR_TEXT.ui.whole;
      this.capEl.textContent = '';
    } else {
      this.show(this.idx);
      const s = this.stops[this.idx];
      this.dio?.setPose(this.stillPose(s));
    }
    this.renderControls();
  }

  /** A stop's framing for the stepped list: the hold's opening shot (a route is framed whole). */
  private stillPose(s: TourStop): Pose {
    const dio = this.dio!;
    const az = s.lookFrom ? Math.atan2(s.lookFrom.z - s.focus.p.z, s.lookFrom.x - s.focus.p.x) : dio.azimuth;
    if (s.kind === 'area') return dio.overviewPose(az, 1.05);
    if (s.kind === 'orbit') return dio.overviewPose(az, s.elev);
    if (s.path) {
      const xs = s.path.map((p) => p.x);
      const zs = s.path.map((p) => p.z);
      const c = { x: (Math.min(...xs) + Math.max(...xs)) / 2, z: (Math.min(...zs) + Math.max(...zs)) / 2 };
      const r = Math.hypot(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs)) / 2 + 40;
      return dio.framePose({ p: c, r, y: 2 }, az, 1.0);
    }
    return dio.framePose(s.focus, az, s.elev);
  }

  /** Reduced motion or Reduce flicker changed: switch between the flight and the stepped list. */
  private syncMode(): void {
    const want = wantsStill() ? 'steps' : 'anim';
    if (want === this.mode || this.disposed) return;
    const at = this.state === 'playing' ? Math.max(0, stopAt(this.tl, this.t)) : this.stops.length;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.mode = want;
    if (want === 'steps') this.goTo(at);
    else this.finish('skip', false);
  }

  // ---------- controls ----------

  private renderControls(): void {
    const n = this.stops.length;
    this.el.dataset.mode = this.mode;
    this.el.dataset.state = this.mode === 'steps' ? 'steps' : this.state;
    this.el.classList.toggle('steps', this.mode === 'steps');
    this.ctrl.replaceChildren();
    const btn = (cls: string, text: string, fn: () => void, extra?: (b: HTMLButtonElement) => void) => {
      const b = el('button', `tour-btn ${cls}`, text, this.ctrl);
      b.type = 'button';
      b.addEventListener('click', fn);
      extra?.(b);
      return b;
    };
    if (this.mode === 'steps') {
      btn('tour-back', TOUR_TEXT.ui.back, () => this.goTo(this.idx - 1), (b) => (b.disabled = this.idx <= 0));
      btn('tour-next', this.idx === n - 1 ? TOUR_TEXT.ui.whole : TOUR_TEXT.ui.next, () => this.goTo(this.idx + 1), (b) => (b.disabled = this.idx >= n));
      if (this.idx >= n) this.stepEl.textContent = TOUR_TEXT.ui.whole;
    } else if (this.state === 'playing') {
      btn('tour-skip', TOUR_TEXT.ui.skip, () => this.skip(), (b) => {
        b.setAttribute('aria-keyshortcuts', 'Space Enter');
        b.title = TOUR_TEXT.ui.skipKeys;
      });
    } else {
      btn('tour-replay', TOUR_TEXT.ui.replay, () => this.play());
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const f of this.cleanups) f();
    this.cleanups = [];
    if (this.dio) this.dio.onInteract = null;
    this.mapLayer?.remove();
    this.mapLayer = null;
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------------------------
// The tactical map's highlight: a transparent SVG stacked over the map with the same viewBox (map
// metres), so the map itself is never redrawn. It pulses slowly in CSS (off under reduced motion).
// ---------------------------------------------------------------------------------------------

const NS = 'http://www.w3.org/2000/svg';
function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}
const r1 = (n: number) => Math.round(n * 10) / 10;

class MapTourLayer {
  private dot: SVGCircleElement | null = null;
  private constructor(private svgEl: SVGSVGElement) {}

  static attach(block: HTMLElement): MapTourLayer | null {
    const base = block.querySelector('svg.tmap');
    const vb = base?.getAttribute('viewBox');
    if (!vb) return null;
    const s = svg('svg', { viewBox: vb, class: 'tmap-tour', 'aria-hidden': 'true', preserveAspectRatio: 'xMidYMid meet' }, block);
    return new MapTourLayer(s);
  }

  /** Metres per CSS pixel (to size dots in screen terms). */
  private get u(): number {
    const span = Number(this.svgEl.getAttribute('viewBox')!.split(' ')[2]);
    return span / Math.max(1, this.svgEl.clientWidth || 400);
  }

  set(m: TourMark | null, still: boolean): void {
    this.svgEl.replaceChildren();
    this.dot = null;
    this.svgEl.classList.toggle('still', still);
    if (!m) return;
    const g = svg('g', { class: 'tt-pulse' }, this.svgEl);
    const u = this.u;
    if (m.kind === 'ring') svg('circle', { cx: r1(m.p.x), cy: r1(m.p.z), r: r1(Math.max(m.r, 10 * u)), class: `tt-ring ${m.tone}` }, g);
    else if (m.kind === 'area') svg('rect', { x: r1(m.box.x0), y: r1(m.box.z0), width: r1(m.box.x1 - m.box.x0), height: r1(m.box.z1 - m.box.z0), class: 'tt-area' }, g);
    else if (m.kind === 'path') {
      svg('path', { d: m.pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p.x)} ${r1(p.z)}`).join(''), class: 'tt-path' }, g);
      this.dot = svg('circle', { cx: r1(m.pts[0].x), cy: r1(m.pts[0].z), r: r1(7 * u), class: 'tt-dot' }, this.svgEl);
    } else if (m.kind === 'orbit') {
      svg('circle', { cx: r1(m.c.x), cy: r1(m.c.z), r: m.r, class: 'tt-orbit' }, g);
      svg('circle', { cx: r1(m.c.x), cy: r1(m.c.z), r: r1(16 * u), class: 'tt-ring safe' }, g);
    }
  }

  moveDot(p: V2): void {
    this.dot?.setAttribute('cx', String(r1(p.x)));
    this.dot?.setAttribute('cy', String(r1(p.z)));
  }

  remove(): void {
    this.svgEl.remove();
  }
}
