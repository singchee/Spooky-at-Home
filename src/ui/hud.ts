import type { SimState } from '../sim/sim';
import type { Mission } from '../sim/missions';
import { WEAPONS } from '../sim/weapons';
import { fmtTime } from '../sim/missions';
import { el } from './dom';

/** Static crosshair artwork per gun (constants we wrote, not map data). */
const CROSSHAIRS: Record<string, string> = {
  '25': '<svg viewBox="-50 -50 100 100"><path d="M-40 0H-8M8 0H40M0 -40V-8M0 8V40" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M-20 -3V3M20 -3V3M-3 -20H3M-3 20H3" stroke="currentColor" stroke-width="1.5"/></svg>',
  '40': '<svg viewBox="-50 -50 100 100"><path d="M-30 -18V-30H-18M18 -30H30V-18M30 18V30H18M-18 30H-30V18" stroke="currentColor" stroke-width="2" fill="none"/><circle r="2" fill="currentColor"/></svg>',
  '105': '<svg viewBox="-50 -50 100 100"><circle r="36" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M-48 0H-12M12 0H48M0 -48V-12M0 12V48" stroke="currentColor" stroke-width="1.5"/></svg>',
};

export interface HudMarker { label: string; x: number; y: number; visible: boolean }

export class Hud {
  readonly root: HTMLDivElement;
  private weapons: HTMLDivElement;
  private objective: HTMLDivElement;
  private timer: HTMLDivElement;
  private radio: HTMLDivElement;
  private sensor: HTMLDivElement;
  private cross: HTMLDivElement;
  private switching: HTMLDivElement;
  private markers: HTMLDivElement;
  private lines: { text: string; t: number }[] = [];
  private lastWeapon = '';

  constructor(parent: HTMLElement, attribution: string) {
    this.root = el('div', 'hud', undefined, parent);
    this.weapons = el('div', 'hud-weapons', undefined, this.root);
    const tr = el('div', 'hud-mission', undefined, this.root);
    this.timer = el('div', 'hud-timer', undefined, tr);
    this.objective = el('div', 'hud-objective', undefined, tr);
    this.radio = el('div', 'hud-radio', undefined, this.root);
    this.sensor = el('div', 'hud-sensor', undefined, this.root);
    this.cross = el('div', 'hud-cross', undefined, this.root);
    this.switching = el('div', 'hud-switching', 'SENSOR SWITCH', this.root);
    this.markers = el('div', 'hud-markers', undefined, this.root);
    el('div', 'hud-attrib', attribution, this.root);
    el('div', 'hud-keys', 'Mouse aim · hold click fire · Q/1-3 gun · V camera · H white/black hot · Z zoom · Esc pause', this.root);
  }

  say(text: string, now: number): void {
    this.lines.push({ text, t: now });
    if (this.lines.length > 5) this.lines.shift();
  }

  update(s: SimState, m: Mission, weapon: string, sensor: string, polarity: number, zoom: boolean, switching: boolean, now: number): void {
    // Weapons
    this.weapons.replaceChildren();
    for (const w of WEAPONS) {
      const st = s.weapons.find((x) => x.id === w.id)!;
      const row = el('div', `hud-w${w.id === weapon ? ' active' : ''}`, undefined, this.weapons);
      el('span', 'hud-wname', w.name, row);
      el('span', 'hud-wammo', st.reloading > 0 ? `RELOAD ${st.reloading.toFixed(1)}` : `${st.ammo}/${w.magazine}`, row);
    }
    // Mission
    this.timer.textContent = m.type === 'defend' ? `HOLD ${fmtTime(s.timeLeft)}` : `TIME ${fmtTime(s.timeLeft)}`;
    const obj: string[] = [];
    if (m.type === 'clear') obj.push(`HOSTILES ${s.zombiesAlive}/${s.zombiesTotal}`);
    else obj.push(`CONTACTS ${s.zombiesAlive}`);
    if (m.type === 'escort') obj.push(`HOME ${s.survivorsHome}/${s.survivorsTotal} (NEED ${s.needHome})`, `MOVING ${s.survivorsAlive}`);
    if (m.type === 'defend') obj.push(`SAFEHOUSE ${Math.round(s.integrity * 100)}%`);
    if (m.type === 'clear' && s.survivorsTotal) obj.push(`FRIENDLIES ${s.survivorsAlive}`);
    obj.push(`FRIENDLY FIRE ${s.friendlyHits}/${m.friendlyFireLimit}`);
    this.objective.replaceChildren(...obj.map((o) => el('div', undefined, o)));
    // Radio
    this.lines = this.lines.filter((l) => now - l.t < 12);
    this.radio.replaceChildren(...this.lines.map((l) => el('div', undefined, l.text)));
    // Sensor and crosshair
    this.sensor.textContent = `${sensor === 'thermal' ? (polarity ? 'IR  BLACK HOT' : 'IR  WHITE HOT') : 'NIGHT VISION'}${zoom ? '  ×2' : ''}`;
    this.root.dataset.sensor = sensor;
    if (weapon !== this.lastWeapon) {
      this.cross.innerHTML = CROSSHAIRS[weapon] ?? ''; // static artwork constant, safe
      this.lastWeapon = weapon;
    }
    this.switching.style.display = switching ? 'block' : 'none';
  }

  setMarkers(ms: HudMarker[]): void {
    this.markers.replaceChildren(
      ...ms.filter((m) => m.visible).map((m) => {
        const d = el('div', 'hud-marker', m.label);
        d.style.transform = `translate(${Math.round(m.x)}px, ${Math.round(m.y)}px)`;
        return d;
      }),
    );
  }

  dispose(): void {
    this.root.remove();
  }
}
