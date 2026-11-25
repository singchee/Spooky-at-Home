import { el } from './dom';
import { MAX_LANDMARKS, labelWidth, placeLandmarks, type LandmarkIn, type Rect } from './landmarks';

/**
 * Draws the in-flight landmark markers (BACKLOG 3.19; what and where: landmarks.ts). Sits under
 * the HUD panels in the HUD root, so nothing here changes hud.ts. Text goes in with textContent
 * only: names are OpenStreetMap text (CLAUDE.md rule 4).
 */

/** What labels must never cover: HUD panels, the OpenStreetMap credit, touch controls. */
const BLOCKERS = [
  '.hud-weapons', '.hud-mission', '.hud-radio:not(:empty)', '.hud-sensor', '.hud-keys', '.hud-attrib', '.hud-minimap', '.hud-switching',
  '.touch-controls:not([hidden]) .tc-stick', '.touch-controls:not([hidden]) .tc-btn', '.touch-controls:not([hidden]) .tc-fire',
].join(',');
/** Margin kept around each blocker, px. */
const MARGIN = 6;
/** How often the blockers are measured again (the radio panel grows and shrinks), seconds. */
const REMEASURE = 0.25;

interface Slot { root: HTMLDivElement; pin: HTMLSpanElement; label: HTMLSpanElement; text: string }

export class LandmarkLayer {
  readonly root: HTMLDivElement;
  private slots: Slot[] = [];
  private blockers: Rect[] = [];
  private measuredAt = -Infinity;
  private on = true;

  constructor(hudRoot: HTMLElement, private container: HTMLElement) {
    this.root = el('div', 'hud-landmarks');
    this.root.setAttribute('aria-hidden', 'true');
    hudRoot.prepend(this.root); // first child: every HUD panel paints over it
    for (let i = 0; i < MAX_LANDMARKS; i++) {
      const root = el('div', 'hud-landmark', undefined, this.root);
      root.hidden = true;
      this.slots.push({ root, pin: el('span', 'lm-pin', undefined, root), label: el('span', 'lm-label', undefined, root), text: '' });
    }
  }

  /** Settings → "Show landmarks". */
  setEnabled(on: boolean): void {
    this.on = on;
    this.root.hidden = !on;
  }

  /**
   * Place this frame's markers. `markers`: the mission's own markers (SAFEHOUSE, SURVIVORS, regroup
   * points) on screen this frame, which landmarks keep clear of.
   */
  update(items: LandmarkIn[], o: { now: number; zoom: number; viewHalf: number; markers: { x: number; y: number; visible: boolean }[] }): void {
    if (!this.on) return;
    const box = this.container.getBoundingClientRect();
    if (o.now - this.measuredAt > REMEASURE || o.now < this.measuredAt) {
      this.measuredAt = o.now;
      this.blockers = [...this.container.querySelectorAll(BLOCKERS)]
        .map((e) => e.getBoundingClientRect())
        .filter((r) => r.width > 0 && r.height > 0)
        .map((r) => ({ x0: r.left - box.left - MARGIN, y0: r.top - box.top - MARGIN, x1: r.right - box.left + MARGIN, y1: r.bottom - box.top + MARGIN }));
    }
    // A mission marker: its 100 px label above a diamond at the point (see .hud-marker).
    const mission = o.markers.filter((m) => m.visible).map((m) => ({ x0: m.x - 54, y0: m.y - 52, x1: m.x + 54, y1: m.y + 10 }));
    const placed = placeLandmarks(items, { width: box.width, height: box.height, blocked: [...this.blockers, ...mission], zoom: o.zoom, viewHalf: o.viewHalf });
    this.slots.forEach((s, i) => {
      const p = placed[i];
      s.root.hidden = !p;
      if (!p) return;
      if (s.text !== p.label) {
        s.label.textContent = p.label; // untrusted map text: textContent only
        s.label.style.width = `${labelWidth(p.label)}px`;
        s.text = p.label;
      }
      s.root.dataset.id = p.id;
      s.root.style.opacity = String(p.opacity);
      s.pin.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
      s.label.style.transform = `translate(${p.left}px, ${p.top}px)`;
    });
  }

  dispose(): void {
    this.root.remove();
  }
}
