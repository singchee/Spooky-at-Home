import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import type { MapData, V2 } from '../map/types';
import type { Sim, SimEvent } from '../sim/sim';
import { Bot, SKILL } from '../sim/bot';
import { WEAPONS, weaponById } from '../sim/weapons';
import { buildWorld, type World } from '../world/buildWorld';
import { SensorShader, type SensorId } from '../render/sensors';
import { AgentsView } from './agentsView';
import { Effects } from './effects';
import { Hud } from '../ui/hud';
import { briefingVisuals } from '../ui/briefingDiorama';
import { el } from '../ui/dom';
import { Sfx } from '../audio/sfx';
import { audio } from '../audio/engine';
import { measureThreat, threatIntensity } from '../audio/intensity';
import { waveCall } from './waveCall';
import { getSettings, onSettingsChange, updateSettings } from '../ui/settings';
import { openSettingsPanel } from '../ui/settingsPanel';
import { bestKey, bests, formatBest, formatTime, missionKind } from '../ui/bests';
import { gradeMission, scoreInput } from '../sim/score';
import { effectiveReduceFlicker, mouseAimDelta } from './input';

/** The browser game: renders the simulation, handles input, camera, sound and screens. */
export interface GameOptions {
  bot?: boolean;
  skipBriefing?: boolean;
  sensor?: SensorId;
  onRetry(): void;
  onNext(): void;
  onMenu(): void;
  /** Optional listener for player actions and sim events (used by the tutorial). */
  onAction?(a: GameAction): void;
  /**
   * Reduce flicker (photosensitivity): no 105 camera kick, and the camera-switch static becomes a
   * gentle fade. When not given, it follows the player's setting live (which defaults to the OS
   * "reduce motion" preference).
   */
  reduceFlicker?: boolean;
  /** A practice run (Training night): no grade or personal best. Defaults to true for a mission with no briefing. */
  practice?: boolean;
}

/** Extra hooks on window.__spooky, installed only under browser automation (see the Game constructor). */
interface TestHooks {
  fireAt?: (weapon: string, x?: number, z?: number) => boolean;
  aimAt?: (x: number, z: number) => void;
  survivors?: () => V2[];
  /** Live zombies (test-only), so tests can aim at real targets instead of reading pixels. */
  zombies?: () => V2[];
  /** Advance exactly `dt` game seconds per rendered frame (null: real time), so a slow test machine sees every frame a 60 fps player would. */
  fixedStep?: (dt: number | null) => void;
  /** Hold or release the trigger, as holding the left button does (without needing pointer lock). */
  holdFire?: (on: boolean) => void;
  /** Where the aim point appears relative to the screen centre, CSS px (the camera kick, as last drawn). */
  aimOffset?: () => [number, number];
}

/** The OS asks for reduced motion (live: it can change while the page is open). */
const reducedMotionQuery: MediaQueryList | null = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;

/** What the player just did, or what the simulation just reported. */
export type GameAction =
  | { type: 'weapon'; weapon: string }
  | { type: 'sensor'; sensor: SensorId }
  | { type: 'polarity'; polarity: number }
  | { type: 'sim'; event: SimEvent };

type Screen = 'briefing' | 'playing' | 'paused' | 'ended';
/** One audio context for the whole page; browsers limit how many can exist. */
const sharedSfx = new Sfx();
const STEP = 1 / 60;
const SWITCH_TIME = 0.7;
/** Reduce flicker: the switch cover fades in over this long before the picture changes, then fades out. */
const CALM_RISE = 0.18;
/** Big-kill radio calls. They take turns (starting from the mission seed), so the same line never plays twice running. */
const KILL_LINES: readonly ((n: number) => string)[] = [
  (n) => `Good effect on target, ${n} down. That's a lot of former neighbours.`,
  (n) => `Splash ${n}. The residents' committee will want a word.`,
  (n) => `${n} down. Someone's going to need a very big rake.`,
  (n) => `That's ${n} fewer at the bus stop. Nice shooting.`,
  (n) => `${n} down in one go. Neighbourhood watch, upgraded.`,
];
/** Blasts landing this close together (seconds) are reported as one call with the combined count. */
const KILL_MERGE = 1.5;

export class Game {
  readonly sim: Sim;
  readonly renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  // Near plane far out: the camera is ~1.8 km away, and this keeps roads from flickering into the ground.
  private camera = new THREE.PerspectiveCamera(10, 1, 600, 6000);
  private composer: EffectComposer;
  private sensorPass: ShaderPass;
  private world: World;
  private agents = new AgentsView();
  private effects = new Effects();
  private hud: Hud;
  private sfx = sharedSfx;
  private bot: Bot | null;
  private overlay: HTMLDivElement;
  private raycaster = new THREE.Raycaster();
  private aim: V2;
  private weapon = '40';
  sensor: SensorId = 'thermal';
  private polarity = 0;
  /** Displayed polarity eases toward the chosen one over ~0.25 s, so H never makes a hard full-screen flip. */
  private polarityShown = 0;
  private lastFlip = -1;
  private zoom = false;
  private switchLeft = 0;
  private firing = false;
  private keys = new Set<string>();
  screen: Screen = 'briefing';
  private acc = 0;
  private last = 0;
  private clock = 0;
  private hudTimer = 0;
  private audioTimer = 0;
  private raf = 0;
  private disposed = false;
  private listeners: [EventTarget, string, EventListener][] = [];
  /** Reduce flicker (see GameOptions.reduceFlicker); follows the setting live. */
  private calm = false;
  get reduceFlicker(): boolean {
    return this.calm;
  }
  /** Closes the settings panel when it's open over the pause screen. */
  private closeSettings: (() => void) | null = null;
  private offSettings: () => void;
  /** The camera the picture shows; with reduce flicker it changes under the fade, not before it. */
  private shownSensor: SensorId = 'thermal';
  private camRight = new THREE.Vector3();
  private camUp = new THREE.Vector3();
  /** Test hook only (see TestHooks.fixedStep): seconds per frame, or null for real time. */
  private fixedDt: number | null = null;
  /** The briefing's map and 3D diorama (disposed when the briefing closes). */
  private briefingView: { dispose(): void } | null = null;

  constructor(private container: HTMLElement, private map: MapData, sim: Sim, private opts: GameOptions) {
    this.sim = sim;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0.15, 0.05, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(-0.4, 1, 0.3);
    this.scene.add(sun);

    this.world = buildWorld(map, sim.mission.seed);
    this.scene.add(this.world.group, this.agents.group, this.effects.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.sensorPass = new ShaderPass(SensorShader);
    this.composer.addPass(this.sensorPass);

    this.hud = new Hud(container, map.attribution);
    this.hud.setMinimap(map, sim.mission);
    this.overlay = el('div', 'overlay', undefined, container);
    this.bot = opts.bot ? new Bot(sim, SKILL.human) : null;
    if (opts.sensor) this.sensor = opts.sensor;
    this.shownSensor = this.sensor;
    const applySettings = () => {
      this.calm = effectiveReduceFlicker(opts.reduceFlicker, getSettings());
      this.sensorPass.uniforms.calm.value = this.calm ? 1 : 0;
    };
    applySettings();
    this.offSettings = onSettingsChange(applySettings);
    const m = sim.mission;
    this.aim = m.route ? { ...m.route[0] } : m.safehouse ? { ...m.safehouse.centre } : { ...m.orbitCentre };

    this.bindInput();
    audio.claim('mission'); // the mission score and engine drone (start on the first click or key)
    this.resize();
    if (opts.skipBriefing) this.start();
    else this.showBriefing();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
    // Test hooks for the automated flash checks and screenshots (scripts/playtest.mjs). Only under
    // browser automation (navigator.webdriver), so real players never get them.
    const hooks = window.__spooky as TestHooks | undefined;
    if (typeof navigator !== 'undefined' && navigator.webdriver && hooks) {
      hooks.fireAt = (w, x, z) => this.fireAt(w, x === undefined || z === undefined ? this.aim : { x, z });
      hooks.aimAt = (x, z) => {
        this.aim = { x, z };
      };
      hooks.survivors = () => this.sim.survivors.filter((s) => s.alive && !s.home).map((s) => ({ x: s.x, z: s.z }));
      hooks.zombies = () => this.sim.zombies.filter((z) => z.alive).map((z) => ({ x: z.x, z: z.z }));
      hooks.fixedStep = (dt) => {
        this.fixedDt = dt;
      };
      hooks.aimOffset = () => {
        const p = this.screenPos(this.aim, 0);
        const c = this.renderer.domElement;
        return [p.x - c.clientWidth / 2, p.y - c.clientHeight / 2];
      };
      hooks.holdFire = (on) => {
        this.firing = on && this.screen === 'playing';
      };
    }
  }

  /** Test hook: fire `weapon` at a ground point now, if it is loaded (see the constructor). */
  fireAt(weapon: string, p: V2): boolean {
    if (this.disposed || this.screen !== 'playing') return false;
    return this.sim.fire(weapon, { ...p });
  }

  // ---------- screens ----------
  private showBriefing(): void {
    const m = this.sim.mission;
    this.overlay.replaceChildren();
    const card = el('div', 'card briefing', undefined, this.overlay);
    const visuals = briefingVisuals(this.map, m, this.sim.graph, this.sim.grid);
    this.briefingView = visuals;
    card.appendChild(visuals.el);
    el('div', 'card-kicker', `MISSION · DIFFICULTY ${m.difficulty} · SEED ${m.seed}`, card);
    el('h2', undefined, m.title, card);
    for (const line of m.briefing) el('p', undefined, line, card);
    for (const line of m.intel) el('p', 'intel', line, card);
    el('p', 'small', 'Controls: mouse to aim (click to capture the pointer) · hold left click to fire · Q or 1/2/3 switch gun · V switch camera · H white-hot/black-hot · Z zoom · WASD nudge aim · M mute · Esc pause.', card);
    const go = el('button', 'primary', 'Start mission', card);
    go.addEventListener('click', () => {
      this.sfx.unlock();
      this.start();
      this.lockPointer();
    });
    this.overlay.style.display = 'flex';
  }

  private start(): void {
    this.briefingView?.dispose();
    this.briefingView = null;
    this.screen = 'playing';
    this.overlay.style.display = 'none';
    this.hud.say(`Spooky, Ground. ${this.sim.mission.title}. You're cleared hot.`, this.clock);
  }

  private pause(): void {
    if (this.screen !== 'playing') return;
    this.screen = 'paused';
    this.firing = false;
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.overlay.replaceChildren();
    const card = el('div', 'card', undefined, this.overlay);
    el('h2', undefined, 'Paused', card);
    el('p', 'small', 'R restarts the mission.', card);
    const resume = el('button', 'primary', 'Resume', card);
    resume.addEventListener('click', () => {
      this.screen = 'playing';
      this.overlay.style.display = 'none';
      this.lockPointer();
    });
    const settings = el('button', undefined, 'Settings', card);
    settings.addEventListener('click', () => this.openSettings());
    const menu = el('button', undefined, 'Quit to menu', card);
    menu.addEventListener('click', () => this.opts.onMenu());
    this.overlay.style.display = 'flex';
    resume.focus();
  }

  /** The settings panel, over the pause screen. Game keys are ignored while it's open. */
  openSettings(): void {
    if (this.closeSettings || this.disposed) return;
    this.closeSettings = openSettingsPanel(this.container, { onClose: () => (this.closeSettings = null) });
  }

  private showResult(won: boolean, reason: string): void {
    this.screen = 'ended';
    this.firing = false;
    this.closeSettings?.();
    document.exitPointerLock?.();
    const s = this.sim.state();
    const m = this.sim.mission;
    this.overlay.replaceChildren();
    const card = el('div', `card result ${won ? 'won' : 'lost'}`, undefined, this.overlay);
    el('div', 'card-kicker', won ? 'MISSION COMPLETE' : 'MISSION FAILED', card);
    const practice = this.opts.practice ?? m.briefing.length === 0;
    if (!practice) {
      const score = gradeMission(scoreInput(m, s));
      const head = el('div', 'result-head', undefined, card);
      const big = el('div', `grade grade-${score.grade}`, score.grade, head);
      big.setAttribute('aria-label', `Grade ${score.grade}`);
      const words = el('div', 'result-words', undefined, head);
      el('h2', undefined, reason, words);
      el('p', 'grade-reason', score.reason, words);
      // Personal best: wins only, stored in this browser.
      const key = bestKey(m.mapName, missionKind(m.template, m.type), m.difficulty);
      if (won) {
        const r = bests().record(key, { grade: score.grade, time: s.t });
        if (r.isNew) el('p', 'best new-best', r.previous ? `NEW BEST · was ${r.previous.grade} ${formatTime(r.previous.time)}` : 'NEW BEST', words);
        else el('p', 'best', formatBest(r.best), words);
      } else {
        const b = bests().get(key);
        el('p', 'best', b ? formatBest(b) : 'No best yet on this mission', words);
      }
    } else {
      el('h2', undefined, reason, card);
    }
    const stats = [
      `Time ${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')}`,
      `Kills ${s.kills} from ${s.shots} rounds${s.kills ? ` (${(s.shots / s.kills).toFixed(1)} rounds per kill)` : ''}`,
      `Friendly-fire incidents ${s.friendlyHits}`,
    ];
    if (s.survivorsTotal && m.type === 'clear') stats.push(`Friendlies alive ${s.survivorsAlive}/${s.survivorsTotal}`);
    else if (s.survivorsTotal) stats.push(`Survivors home ${s.survivorsHome}/${s.survivorsTotal}`);
    if (m.type === 'defend') stats.push(`Safehouse ${Math.round(s.integrity * 100)}% intact`);
    const list = el('ul', 'result-stats', undefined, card);
    for (const t of stats) el('li', undefined, t, list);
    // After a win the way on is the next mission; after a loss, another go.
    const row = el('div', 'row', undefined, card);
    const next = el('button', won ? 'primary' : undefined, 'Next mission', row);
    const retry = el('button', won ? undefined : 'primary', 'Retry', row);
    if (won) row.appendChild(retry);
    else row.insertBefore(retry, next);
    next.addEventListener('click', () => this.opts.onNext());
    retry.addEventListener('click', () => this.opts.onRetry());
    el('button', undefined, 'Menu', row).addEventListener('click', () => this.opts.onMenu());
    el('p', 'small', `Keys: ${won ? 'N next mission · R retry' : 'R retry · N next mission'}`, card);
    this.overlay.style.display = 'flex';
    (won ? next : retry).focus();
  }

  // ---------- input ----------
  private on(t: EventTarget, type: string, fn: EventListener): void {
    t.addEventListener(type, fn);
    this.listeners.push([t, type, fn]);
  }

  lockPointer(): void {
    try {
      const p = this.renderer.domElement.requestPointerLock?.() as unknown;
      if (p instanceof Promise) p.catch(() => undefined);
    } catch {
      /* not available (e.g. headless) */
    }
  }

  private bindInput(): void {
    const canvas = this.renderer.domElement;
    this.on(window, 'resize', () => this.resize());
    this.on(canvas, 'mousedown', (e) => {
      if (this.screen !== 'playing') return;
      this.sfx.unlock();
      if (document.pointerLockElement !== canvas) {
        this.lockPointer();
        return;
      }
      if ((e as MouseEvent).button === 0) this.firing = true;
    });
    this.on(window, 'mouseup', () => (this.firing = false));
    this.on(document, 'pointerlockchange', () => {
      if (document.pointerLockElement !== canvas && this.screen === 'playing') this.pause();
    });
    this.on(window, 'mousemove', (e) => {
      if (document.pointerLockElement !== canvas || this.screen !== 'playing') return;
      const me = e as MouseEvent;
      // Some browsers send a bogus huge jump under pointer lock (e.g. on click); ignore it.
      if (Math.abs(me.movementX) > 300 || Math.abs(me.movementY) > 300) return;
      const [dx, dy] = mouseAimDelta(me.movementX, me.movementY, getSettings());
      this.nudgeAim(dx, dy);
    });
    this.on(window, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      if (this.closeSettings) return; // the settings panel has the keyboard
      const k = ke.key.toLowerCase();
      this.keys.add(k);
      this.sfx.unlock();
      // Toggles fire once per press: holding a key must never strobe the screen (photosensitivity).
      if (ke.repeat) return;
      if (this.screen === 'ended') {
        if (k === 'r') this.opts.onRetry();
        if (k === 'n') this.opts.onNext();
        return;
      }
      if (k === 'escape' && this.screen === 'playing') this.pause();
      if (k === 'm') updateSettings({ muted: !getSettings().muted });
      if (this.screen === 'paused' && k === 'r') this.opts.onRetry();
      if (this.screen !== 'playing') return;
      const gun = this.weapon;
      if (k === '1' || k === '2' || k === '3') this.weapon = WEAPONS[Number(k) - 1].id;
      if (k === 'q') this.weapon = WEAPONS[(WEAPONS.findIndex((w) => w.id === this.weapon) + 1) % WEAPONS.length].id;
      if (this.weapon !== gun) this.opts.onAction?.({ type: 'weapon', weapon: this.weapon });
      if (k === 'v' && this.switchLeft <= 0) this.setSensor(this.sensor === 'thermal' ? 'night' : 'thermal');
      // At most one white/black-hot flip per 0.35 s, so rapid tapping stays under 3 flashes a second.
      if (k === 'h' && this.sensor === 'thermal' && this.clock - this.lastFlip >= 0.35) {
        this.polarity = 1 - this.polarity;
        this.lastFlip = this.clock;
        this.opts.onAction?.({ type: 'polarity', polarity: this.polarity });
      }
      if (k === 'z') this.zoom = !this.zoom;
    });
    this.on(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
    this.on(window, 'blur', () => {
      this.keys.clear();
      this.firing = false;
    });
  }

  private manualSensor = false;

  /** Switch camera. Called by the player (V key) or the test hook; overrides the bot's choice. */
  setSensor(s: SensorId, manual = true): void {
    if (manual) this.manualSensor = true;
    if (s === this.sensor) return;
    this.sensor = s;
    this.switchLeft = SWITCH_TIME;
    this.opts.onAction?.({ type: 'sensor', sensor: s });
  }

  /** The ground point the camera is aimed at (a copy). */
  aimPoint(): V2 {
    return { ...this.aim };
  }

  /** The selected gun's id. */
  get weaponId(): string {
    return this.weapon;
  }

  /** Where a ground point appears on screen, in CSS pixels. */
  screenPos(p: V2, y = 4): { x: number; y: number; visible: boolean } {
    const v = new THREE.Vector3(p.x, y, p.z).project(this.camera);
    const c = this.renderer.domElement;
    return { x: ((v.x + 1) / 2) * c.clientWidth, y: ((1 - v.y) / 2) * c.clientHeight, visible: v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1 };
  }

  /** Move the aim point on the ground by a screen-space amount, so it feels the same at any zoom. */
  private nudgeAim(dx: number, dy: number): void {
    const cam = this.camera;
    const h = this.renderer.domElement.clientHeight || 1;
    const ac = this.sim.aircraft();
    const range = Math.hypot(this.aim.x - ac.x, ac.y, this.aim.z - ac.z);
    const mPerPx = (2 * range * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
    const flatF = new THREE.Vector2(fwd.x, fwd.z).normalize();
    const elev = Math.asin(Math.min(1, ac.y / range));
    this.aim.x += right.x * dx * mPerPx - flatF.x * (dy * mPerPx) / Math.max(0.3, Math.sin(elev));
    this.aim.z += right.z * dx * mPerPx - flatF.y * (dy * mPerPx) / Math.max(0.3, Math.sin(elev));
    const lim = this.map.half;
    this.aim.x = Math.max(-lim, Math.min(lim, this.aim.x));
    this.aim.z = Math.max(-lim, Math.min(lim, this.aim.z));
  }

  // ---------- loop ----------
  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = this.fixedDt ?? Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    if (this.screen === 'playing') this.clock += dt;

    if (this.screen === 'playing') {
      const kx = (this.keys.has('d') || this.keys.has('arrowright') ? 1 : 0) - (this.keys.has('a') || this.keys.has('arrowleft') ? 1 : 0);
      const ky = (this.keys.has('s') || this.keys.has('arrowdown') ? 1 : 0) - (this.keys.has('w') || this.keys.has('arrowup') ? 1 : 0);
      if (kx || ky) this.nudgeAim(kx * 400 * dt, ky * 400 * dt);
      this.acc += dt;
      while (this.acc >= STEP) {
        this.acc -= STEP;
        this.bot?.step(STEP);
        if (this.bot) this.sensorFromBot();
        if (this.firing && this.switchLeft <= 0) this.tryFire();
        this.sim.step(STEP);
      }
      this.handleEvents(this.sim.drainEvents());
      this.switchLeft = Math.max(0, this.switchLeft - dt);
    }
    this.render(dt);
    // The score follows the threat, about four times a second.
    this.audioTimer -= dt;
    if (this.audioTimer <= 0) {
      this.audioTimer = 0.25;
      audio.setIntensity(this.screen === 'playing' ? threatIntensity(measureThreat(this.sim)) : 0.1);
    }
  };

  private sensorFromBot(): void {
    if (this.bot && !this.manualSensor && this.bot.sensor !== this.sensor) this.setSensor(this.bot.sensor, false);
  }

  private tryFire(): void {
    if (!this.sim.weaponReady(this.weapon)) return;
    this.raycaster.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = this.raycaster.intersectObjects(this.world.pickables, false)[0];
    const p = hit ? { x: hit.point.x, z: hit.point.z } : this.aim;
    this.sim.fire(this.weapon, p);
  }

  /** Kills waiting to be called in (merged over KILL_MERGE seconds), and which line goes next. */
  private waveCall = 0;
  private killCall = { n: 0, at: -1, next: -1 };

  private handleEvents(events: SimEvent[]): void {
    const now = this.clock;
    const kc = this.killCall;
    if (kc.next < 0) kc.next = this.sim.mission.seed % KILL_LINES.length;
    for (const e of events) {
      this.opts.onAction?.({ type: 'sim', event: e });
      switch (e.type) {
        case 'fire':
          this.effects.fire(e.weapon, e.from, e.to, e.tof, now);
          this.sfx.fire(e.weapon);
          break;
        case 'impact':
          this.effects.impact(e.weapon, e.x, e.z, now);
          this.sfx.impact(e.weapon);
          // A big blast opens a call; anything else that lands in the next moment joins its count.
          if (kc.at >= 0) kc.n += e.kills;
          else if (e.kills >= 5) {
            kc.n = e.kills;
            kc.at = now;
          }
          break;
        case 'friendly-hit':
          this.radio('CHECK FIRE! CHECK FIRE! Friendly down!', true);
          break;
        case 'danger-close':
          this.radio('Danger close! Mind the friendlies.');
          break;
        case 'survivor-lost':
          this.radio("We've lost one of the survivors.");
          break;
        case 'survivor-home':
          this.radio("One survivor home. Kettle's on.");
          break;
        case 'wave':
          this.radio(waveCall(e, this.waveCall++));
          break;
        case 'radio':
          this.radio(e.text);
          break;
        case 'result':
          audio.sting(e.won);
          this.showResult(e.won, e.reason);
          break;
      }
    }
    if (kc.at >= 0 && now - kc.at >= KILL_MERGE) {
      this.radio(KILL_LINES[kc.next](kc.n));
      kc.next = (kc.next + 1) % KILL_LINES.length;
      kc.at = -1;
      kc.n = 0;
    }
  }

  private radio(text: string, alarm = false): void {
    this.hud.say(text, this.clock, alarm);
    if (alarm) this.sfx.alarm();
    else this.sfx.radio();
  }

  private render(dt: number): void {
    const ac = this.sim.aircraft();
    const w = weaponById(this.weapon);
    const fov = w.fov / (this.zoom ? 2 : 1);
    if (this.bot && this.screen === 'playing') {
      // In bot mode, the camera follows the action so screenshots show something useful.
      const live = this.sim.zombies.filter((z) => z.alive);
      const f = this.sim.survivors.find((s) => s.alive && !s.home);
      const target = f ?? live[0];
      if (target) {
        this.aim.x += (target.x - this.aim.x) * Math.min(1, dt * 2);
        this.aim.z += (target.z - this.aim.z) * Math.min(1, dt * 2);
      }
    }
    this.camera.fov = fov;
    this.camera.position.set(ac.x, ac.y, ac.z);
    this.camera.lookAt(this.aim.x, 0, this.aim.z);
    this.applyKick(fov);
    this.camera.updateProjectionMatrix();

    this.agents.update(this.sim, this.clock);
    this.effects.update(this.clock, dt);

    const u = this.sensorPass.uniforms;
    u.time.value = this.clock;
    u.mode.value = this.pictureSensor() === 'night' ? 1 : 0;
    this.polarityShown += Math.sign(this.polarity - this.polarityShown) * Math.min(Math.abs(this.polarity - this.polarityShown), dt * 4);
    u.polarity.value = this.polarityShown;
    u.washout.value = this.effects.washout;
    u.blank.value = this.switchCover();
    this.renderer.info.reset();
    this.composer.render();

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.hud.update(this.sim.state(), this.sim.mission, this.weapon, this.sensor, this.polarity, this.zoom, this.switchLeft > 0, this.clock, this.dangerClose());
      this.hud.updateMinimap(ac, this.aim, this.sim.survivors.filter((s) => s.alive && !s.home));
    }
    this.hud.setMarkers(this.markers());
  }

  /**
   * The 105's camera kick: one damped swing of at most SHAKE_MAX_PX screen pixels, converted to
   * metres at the aim point with the current field of view and range. Off with reduced motion or
   * reduce flicker.
   */
  private applyKick(fovDeg: number): void {
    if (this.reduceFlicker || reducedMotionQuery?.matches) return;
    const k = this.effects.shakePx(this.clock);
    if (!k.x && !k.y) return;
    const cam = this.camera;
    const h = this.renderer.domElement.clientHeight || 1;
    const range = cam.position.distanceTo(new THREE.Vector3(this.aim.x, 0, this.aim.z));
    const mPerPx = (2 * range * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2))) / h;
    cam.updateMatrixWorld();
    this.camRight.setFromMatrixColumn(cam.matrixWorld, 0);
    this.camUp.setFromMatrixColumn(cam.matrixWorld, 1);
    const t = new THREE.Vector3(this.aim.x, 0, this.aim.z)
      .addScaledVector(this.camRight, k.x * mPerPx)
      .addScaledVector(this.camUp, k.y * mPerPx);
    cam.lookAt(t);
  }

  /** Which camera the picture shows this frame (with reduce flicker it changes once the fade has covered it). */
  private pictureSensor(): SensorId {
    if (this.switchLeft <= 0 || !this.reduceFlicker || this.switchLeft <= SWITCH_TIME - CALM_RISE) this.shownSensor = this.sensor;
    return this.shownSensor;
  }

  /** How much the camera-switch cover hides the picture, 0-1. */
  private switchCover(): number {
    const left = this.switchLeft;
    if (left <= 0) return 0;
    // Normal: static that cuts in and fades out smoothly.
    if (!this.reduceFlicker) return Math.min(1, (left / SWITCH_TIME) * 1.6);
    // Reduce flicker: a flat grey that eases in, swaps the picture underneath, then eases out.
    const ease = (x: number) => x * x * (3 - 2 * x);
    const since = SWITCH_TIME - left;
    return since < CALM_RISE ? ease(since / CALM_RISE) : ease(Math.min(1, left / (SWITCH_TIME - CALM_RISE)));
  }

  /** True when the current gun would endanger a friendly at the aim point. */
  private dangerClose(): boolean {
    const r = weaponById(this.weapon).radius * 1.6 + 4;
    return this.sim.survivors.some((s) => s.alive && !s.home && Math.hypot(s.x - this.aim.x, s.z - this.aim.z) < r);
  }

  private markers() {
    const m = this.sim.mission;
    const out: { label: string; p: V2 }[] = [];
    if (m.safehouse) out.push({ label: 'SAFEHOUSE', p: m.safehouse.centre });
    if (m.home) out.push({ label: 'HOME', p: m.home.centre });
    const moving = this.sim.survivors.filter((s) => s.alive && !s.home);
    if (moving.length && m.type === 'escort') {
      out.push({ label: 'SURVIVORS', p: { x: moving.reduce((a, s) => a + s.x, 0) / moving.length, z: moving.reduce((a, s) => a + s.z, 0) / moving.length } });
    }
    const wpx = this.renderer.domElement.clientWidth;
    const hpx = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();
    return out.map((o) => {
      v.set(o.p.x, 4, o.p.z).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      return { label: o.label, x: ((v.x + 1) / 2) * wpx, y: ((1 - v.y) / 2) * hpx, visible };
    });
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    (this.sensorPass.uniforms.res.value as THREE.Vector2).set(w * pr, h * pr);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  info() {
    return { drawCalls: this.renderer.info.render.calls, triangles: this.renderer.info.render.triangles, screen: this.screen, sensor: this.sensor };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Test hooks must not outlive this game (they'd point at a dead one).
    const hooks = window.__spooky as TestHooks | undefined;
    if (hooks) for (const k of ['fireAt', 'aimAt', 'survivors', 'zombies', 'fixedStep', 'holdFire', 'aimOffset'] as const) delete hooks[k];
    cancelAnimationFrame(this.raf);
    audio.release('mission');
    this.offSettings();
    this.closeSettings?.();
    this.briefingView?.dispose();
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.world.dispose();
    this.agents.dispose();
    this.effects.dispose();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.hud.dispose();
    this.overlay.remove();
  }
}
