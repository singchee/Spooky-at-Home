import type { SimState } from '../sim/sim';
import type { Mission } from '../sim/missions';
import { WEAPONS } from '../sim/weapons';
import { fmtTime } from '../sim/missions';
import type { MapData, V2 } from '../map/types';
import { el } from './dom';
import { TacticalMap } from './tacticalMap';
import { HotkeyStrip } from './hotkeys';
import { coldHint } from '../game/controls';

/** Static crosshair artwork per gun (constants we wrote, not map data). */
const SHAPES: Record<string, string> = {
  '25': '<path d="M-40 0H-8M8 0H40M0 -40V-8M0 8V40M-20 -3V3M20 -3V3M-3 -20H3M-3 20H3"/>',
  '40': '<path d="M-30 -18V-30H-18M18 -30H30V-18M30 18V30H18M-18 30H-30V18"/><circle r="2"/>',
  '105': '<circle r="36"/><path d="M-48 0H-12M12 0H48M0 -48V-12M0 12V48"/>',
};
/** Dark underlay + light line, so the crosshair reads on both white-hot and black-hot pictures. */
const CROSSHAIRS: Record<string, string> = Object.fromEntries(
  Object.entries(SHAPES).map(([k, p]) => [
    k,
    `<svg viewBox="-50 -50 100 100" fill="none"><g stroke="#000" stroke-width="5" opacity="0.75">${p}</g><g stroke="currentColor" stroke-width="1.8">${p}</g></svg>`,
  ]),
);

export interface HudMarker { label: string; x: number; y: number; visible: boolean }

/**
 * Training night's mission (tutorialSteps.ts) carries this: the HUD hides the clock and the
 * friendly-fire count, and leaves out the placeholders parked off the map to keep the mission open.
 */
export interface TrainingHud { reserveHostiles: number; reserveFriendlies: number }
export type TrainingMission = Mission & { training?: TrainingHud };

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
  private lines: { text: string; t: number; alarm: boolean }[] = [];
  private lastWeapon = '';
  private keys: HotkeyStrip;

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
    this.keys = new HotkeyStrip(this.root);
  }

  say(text: string, now: number, alarm = false): void {
    this.lines.push({ text, t: now, alarm });
    if (this.lines.length > 5) this.lines.shift();
  }

  update(s: SimState, m: Mission, weapon: string, sensor: string, polarity: number, zoom: number, switching: boolean, now: number, danger = false, touch = false): void {
    // Weapons
    this.weapons.replaceChildren();
    for (const w of WEAPONS) {
      const st = s.weapons.find((x) => x.id === w.id)!;
      const row = el('div', `hud-w${w.id === weapon ? ' active' : ''}`, undefined, this.weapons);
      el('span', 'hud-wname', w.name, row);
      el('span', 'hud-wammo', st.reloading > 0 ? `RELOAD ${st.reloading.toFixed(1)}` : `${st.ammo}/${w.magazine}`, row);
    }
    // Mission
    const training = (m as TrainingMission).training;
    // Training night has no clock and no friendly-fire limit: "99:57" and "0/99" read like bugs.
    this.timer.hidden = !!training;
    this.timer.textContent = m.crowd ? `DAWN ${fmtTime(s.timeLeft)}` : m.type === 'defend' ? `HOLD ${fmtTime(s.timeLeft)}` : `TIME ${fmtTime(s.timeLeft)}`;
    const obj: string[] = [];
    if (m.crowd) {
      // Crowd nights (Feel S2): only the words this mode needs. KILLS, the multiplier and the score are top centre.
      obj.push(`DOORS ${Math.round(s.integrity * 100)}%`);
    } else if (training) {
      // The far-off placeholders that keep the training mission open aren't counted.
      obj.push(`CONTACTS ${Math.max(0, s.zombiesAlive - training.reserveHostiles)}`);
      const friends = Math.max(0, s.survivorsAlive - training.reserveFriendlies);
      if (friends) obj.push(`FRIENDLIES ${friends}`);
    } else if (m.type === 'clear') obj.push(`HOSTILES ${s.zombiesAlive}/${s.zombiesTotal}`);
    else obj.push(`CONTACTS ${s.zombiesAlive}`);
    if (!training && !m.crowd) {
      if (m.type === 'escort') obj.push(`HOME ${s.survivorsHome}/${s.survivorsTotal} (NEED ${s.needHome})`, `MOVING ${s.survivorsAlive}`);
      if (m.type === 'defend') obj.push(`SAFEHOUSE ${Math.round(s.integrity * 100)}%`);
      if (m.type === 'clear' && s.survivorsTotal) obj.push(`FRIENDLIES ${s.survivorsAlive}`);
    }
    if (s.coldAlive > 0) obj.push(coldHint(s.coldAlive, sensor, touch));
    if (!training && !m.crowd) obj.push(`FRIENDLY FIRE ${s.friendlyHits}/${m.friendlyFireLimit}`);
    this.objective.replaceChildren(...obj.map((o) => el('div', undefined, o)));
    // Radio
    this.lines = this.lines.filter((l) => now - l.t < 12);
    this.radio.replaceChildren(...this.lines.map((l) => el('div', l.alarm ? 'alarm' : undefined, l.text)));
    // Sensor and crosshair
    this.sensor.textContent = `${sensor === 'thermal' ? (polarity ? 'IR  BLACK HOT' : 'IR  WHITE HOT') : 'NIGHT VISION'}${Math.abs(zoom - 1) > 0.01 ? `  ×${zoom.toFixed(1)}` : ''}`;
    this.root.dataset.sensor = sensor;
    if (weapon !== this.lastWeapon) {
      this.cross.innerHTML = CROSSHAIRS[weapon] ?? ''; // static artwork constant, safe
      this.lastWeapon = weapon;
    }
    this.switching.style.display = switching ? 'block' : 'none';
    this.cross.classList.toggle('danger', danger);
    this.cross.dataset.label = danger ? 'DANGER CLOSE' : '';
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

  private minimap: TacticalMap | null = null;

  /** Small tactical map in the corner (W2): the mission overlay plus aircraft, aim point and survivors. */
  setMinimap(map: MapData, mission: Mission): void {
    const box = el('div', 'hud-minimap', undefined, this.root);
    this.minimap = new TacticalMap(map, { mission, compact: true, size: 180, label: 'Minimap' });
    box.appendChild(this.minimap.svg);
    if (this.minimap.live) box.appendChild(this.minimap.live);
  }

  updateMinimap(aircraft: V2, aim: V2, survivors: V2[], regroup: V2[] = []): void {
    this.minimap?.update({ aircraft, aim, survivors, regroup });
  }

  dispose(): void {
    this.keys.dispose();
    this.root.remove();
  }
}
