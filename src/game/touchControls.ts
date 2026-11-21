import { el } from '../ui/dom';
import { TAP_MAX_MS, TAP_MAX_PX, pinchStep, stickDeflection, stickNudge } from './controls';

/**
 * On-screen controls for phones and tablets (3.11, owner: "When accessed via mobile I can't control").
 *
 * Shown when the device is touch-primary (`pointer: coarse`), and switched on live by the first touch
 * on a desktop (or off again by a real mouse click). Pointer events throughout, one pointer per control,
 * so the thumb stick and FIRE work at the same time.
 *
 *   left thumb    a stick: press and drag to move the aim, speed proportional to deflection (scaled by dt)
 *   right thumb   FIRE (hold for continuous fire), GUN (cycle gun), VIEW (white-hot, black-hot, night vision)
 *                 and ZOOM; a pause button (II) at the top
 *   the picture   tap to aim at that spot; pinch to zoom in or out a step
 *
 * The game passes in what each control does (TouchActions), so this file holds no game logic and
 * game.ts only wires it up. No flashing: a held button just stays lit (reduce flicker).
 */
export interface TouchActions {
  /** Is a mission being played right now (not briefing, paused or ended)? */
  playing(): boolean;
  /** Move the aim by a screen-space amount (px), like the mouse does. */
  nudge(dx: number, dy: number): void;
  /** Aim at a point on screen (client px). */
  aimAt(clientX: number, clientY: number): void;
  setFiring(on: boolean): void;
  cycleWeapon(): void;
  cycleView(): void;
  /** -1 zoom out a step, 1 in, 0 toggle (the button). */
  zoom(dir: -1 | 0 | 1): void;
  pause(): void;
  /** Labels for the GUN, VIEW and ZOOM buttons, e.g. "40", "WH" and "×2". */
  labels(): { weapon: string; view: string; zoom: string };
}

/** The OS says the main pointer is a finger. */
export function touchPrimary(): boolean {
  try {
    return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  } catch {
    return false;
  }
}

export class TouchControls {
  readonly root: HTMLDivElement;
  /** Touch controls are on (touch-primary device, or a touch has happened). */
  active: boolean;
  private stick: HTMLDivElement;
  private knob: HTMLDivElement;
  private fire: HTMLButtonElement;
  private gunLabel: HTMLSpanElement;
  private viewLabel: HTMLSpanElement;
  private zoomLabel: HTMLSpanElement;
  private stickId: number | null = null;
  private stickVec: [number, number] = [0, 0];
  private fireId: number | null = null;
  /** Touches on the picture itself: for tap-to-aim and pinch. */
  private surfaceTouches = new Map<number, { x: number; y: number; x0: number; y0: number; t0: number }>();
  private pinchFrom = 0;
  private multi = false;
  private listeners: [EventTarget, string, EventListener, AddEventListenerOptions | undefined][] = [];

  constructor(private container: HTMLElement, surface: HTMLElement, private act: TouchActions) {
    this.active = touchPrimary();
    this.root = el('div', 'touch-controls', undefined, container);
    this.stick = el('div', 'tc-stick', undefined, this.root);
    // Pointer-only (keyboard players have WASD), so assistive tech skips it.
    this.stick.setAttribute('aria-hidden', 'true');
    this.knob = el('div', 'tc-knob', undefined, this.stick);
    const pad = el('div', 'tc-pad', undefined, this.root);
    this.fire = this.button(pad, 'tc-fire', 'FIRE', 'Fire (hold)');
    const gun = this.button(pad, 'tc-gun', 'GUN', 'Switch gun');
    this.gunLabel = el('span', 'tc-sub', '', gun);
    const view = this.button(pad, 'tc-view', 'VIEW', 'Switch view: white-hot, black-hot, night vision');
    this.viewLabel = el('span', 'tc-sub', '', view);
    const zoom = this.button(pad, 'tc-zoom', 'ZOOM', 'Zoom');
    this.zoomLabel = el('span', 'tc-sub', '', zoom);
    this.button(this.root, 'tc-pause', 'II', 'Pause menu');

    // ----- stick -----
    this.on(this.stick, 'pointerdown', (e) => {
      const p = e as PointerEvent;
      p.preventDefault();
      if (this.stickId !== null) return;
      this.stickId = p.pointerId;
      this.capture(this.stick, p.pointerId);
      this.moveStick(p);
    });
    this.on(this.stick, 'pointermove', (e) => {
      if ((e as PointerEvent).pointerId === this.stickId) this.moveStick(e as PointerEvent);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.on(this.stick, t, (e) => {
        if ((e as PointerEvent).pointerId === this.stickId) this.releaseStick();
      });
    }

    // ----- buttons -----
    this.on(this.fire, 'pointerdown', (e) => {
      const p = e as PointerEvent;
      p.preventDefault();
      this.fireId = p.pointerId;
      this.capture(this.fire, p.pointerId);
      this.fire.classList.add('down');
      if (this.act.playing()) this.act.setFiring(true);
    });
    for (const t of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      this.on(this.fire, t, (e) => {
        if ((e as PointerEvent).pointerId === this.fireId) this.releaseFire();
      });
    }
    this.tap(gun, () => this.act.cycleWeapon());
    this.tap(view, () => this.act.cycleView());
    this.tap(zoom, () => this.act.zoom(0));
    this.tap(this.root.querySelector('.tc-pause')!, () => this.act.pause());

    // ----- the picture: tap to aim, pinch to zoom -----
    this.on(surface, 'pointerdown', (e) => {
      const p = e as PointerEvent;
      if (p.pointerType !== 'touch' || !this.active) return;
      p.preventDefault(); // no emulated mouse events: they would try to capture the pointer
      this.surfaceTouches.set(p.pointerId, { x: p.clientX, y: p.clientY, x0: p.clientX, y0: p.clientY, t0: performance.now() });
      if (this.surfaceTouches.size >= 2) {
        this.multi = true;
        this.pinchFrom = this.pinchDistance();
      }
    });
    this.on(surface, 'pointermove', (e) => {
      const p = e as PointerEvent;
      const t = this.surfaceTouches.get(p.pointerId);
      if (!t) return;
      t.x = p.clientX;
      t.y = p.clientY;
      if (this.surfaceTouches.size >= 2 && this.act.playing()) {
        const d = this.pinchDistance();
        const step = pinchStep(this.pinchFrom, d);
        if (step) {
          this.act.zoom(step);
          this.pinchFrom = d;
        }
      }
    });
    const lift = (e: Event) => {
      const p = e as PointerEvent;
      const t = this.surfaceTouches.get(p.pointerId);
      if (!t) return;
      this.surfaceTouches.delete(p.pointerId);
      const tap = e.type === 'pointerup' && !this.multi && performance.now() - t.t0 <= TAP_MAX_MS && Math.hypot(p.clientX - t.x0, p.clientY - t.y0) <= TAP_MAX_PX;
      if (tap && this.act.playing()) this.act.aimAt(p.clientX, p.clientY);
      if (!this.surfaceTouches.size) this.multi = false;
    };
    this.on(surface, 'pointerup', lift);
    this.on(surface, 'pointercancel', lift);

    // ----- which kind of device: the first touch switches the controls on, a real mouse click off -----
    this.on(
      window,
      'pointerdown',
      (e) => {
        const t = (e as PointerEvent).pointerType;
        if (t === 'touch' && !this.active) this.setActive(true);
        else if (t === 'mouse' && this.active) this.setActive(false);
      },
      { capture: true },
    );
    // iOS Safari's own pinch-zoom of the page, while playing with touch.
    this.on(document, 'gesturestart', (e) => {
      if (this.active) e.preventDefault();
    });
    this.setActive(this.active);
  }

  /** Per frame: move the aim by the stick (scaled by dt), refresh labels, show or hide. */
  update(dt: number): void {
    const show = this.active && this.act.playing();
    if (this.root.hidden === show) this.root.hidden = !show;
    if (!show) {
      if (this.stickId !== null) this.releaseStick();
      if (this.fireId !== null) this.releaseFire();
      return;
    }
    const [dx, dy] = stickNudge(this.stickVec, dt);
    if (dx || dy) this.act.nudge(dx, dy);
    const l = this.act.labels();
    if (this.gunLabel.textContent !== l.weapon) this.gunLabel.textContent = l.weapon;
    if (this.viewLabel.textContent !== l.view) this.viewLabel.textContent = l.view;
    if (this.zoomLabel.textContent !== l.zoom) this.zoomLabel.textContent = l.zoom;
  }

  setActive(on: boolean): void {
    this.active = on;
    this.container.classList.toggle('touch-mode', on);
    if (!on) {
      this.releaseStick();
      this.releaseFire();
    }
    this.update(0);
  }

  dispose(): void {
    for (const [t, type, fn, o] of this.listeners) t.removeEventListener(type, fn, o);
    this.container.classList.remove('touch-mode');
    this.root.remove();
  }

  // ---------- helpers ----------
  private on(t: EventTarget, type: string, fn: EventListener, o?: AddEventListenerOptions): void {
    t.addEventListener(type, fn, o);
    this.listeners.push([t, type, fn, o]);
  }

  private button(parent: HTMLElement, cls: string, text: string, label: string): HTMLButtonElement {
    const b = el('button', `tc-btn ${cls}`, undefined, parent);
    b.type = 'button';
    b.setAttribute('aria-label', label);
    el('span', 'tc-main', text, b);
    return b;
  }

  /** Act on the finger going down (games want instant response); keyboard activation (Enter/Space) works too. */
  private tap(b: HTMLElement, f: () => void): void {
    this.on(b, 'pointerdown', (e) => {
      e.preventDefault();
      b.classList.add('down');
      if (this.act.playing()) f();
    });
    for (const t of ['pointerup', 'pointercancel', 'pointerleave']) this.on(b, t, () => b.classList.remove('down'));
    this.on(b, 'click', (e) => {
      if ((e as MouseEvent).detail === 0 && this.act.playing()) f();
    });
  }

  private capture(target: HTMLElement, id: number): void {
    try {
      target.setPointerCapture(id);
    } catch {
      /* the pointer is already gone */
    }
  }

  private moveStick(p: PointerEvent): void {
    const r = this.stick.getBoundingClientRect();
    const radius = r.width / 2;
    const dx = p.clientX - (r.left + radius);
    const dy = p.clientY - (r.top + r.height / 2);
    this.stickVec = stickDeflection(dx, dy, radius);
    const k = Math.min(1, radius / Math.max(1, Math.hypot(dx, dy)));
    this.knob.style.transform = `translate(${Math.round(dx * k)}px, ${Math.round(dy * k)}px)`;
    this.stick.classList.add('down');
  }

  private releaseStick(): void {
    this.stickId = null;
    this.stickVec = [0, 0];
    this.knob.style.transform = '';
    this.stick.classList.remove('down');
  }

  private releaseFire(): void {
    if (this.fireId !== null) this.act.setFiring(false);
    this.fireId = null;
    this.fire.classList.remove('down');
  }

  private pinchDistance(): number {
    const [a, b] = [...this.surfaceTouches.values()];
    return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
  }
}
