import * as THREE from 'three';
import type { MapData, V2 } from '../map/types';
import type { Sim, SimEvent } from '../sim/sim';
import { Bot, SKILL } from '../sim/bot';
import { WEAPONS, weaponById } from '../sim/weapons';
import { buildWorld, type World } from '../world/buildWorld';
import type { SensorId } from '../render/sensors';
import { SensorPost } from '../render/sensorPost';
import { GfxGovernor, tierFromQuery } from '../render/gfxGovernor';
import { AgentsView } from './agentsView';
import { Effects } from './effects';
import { Hud } from '../ui/hud';
import { briefingVisuals } from '../ui/briefingDiorama';
import { el } from '../ui/dom';
import { Sfx } from '../audio/sfx';
import { audio } from '../audio/engine';
import { measureThreat, threatIntensity } from '../audio/intensity';
import { VoiceDirector } from '../audio/voice';
import { waveCall } from './waveCall';
import { getSettings, onSettingsChange, updateSettings } from '../ui/settings';
import { openSettingsPanel } from '../ui/settingsPanel';
import { bestKey, bests, formatBest, formatTime, missionKind } from '../ui/bests';
import { gradeMission, scoreInput } from '../sim/score';
import { LINES, captionText, line } from '../sim/campaignText';
import { effectiveReduceFlicker, mouseAimDelta } from './input';
import { KEYS_SENTENCE, TOUCH_SENTENCE, keyAction, nextView, viewLabel, type ControlAction } from './controls';
import { TouchControls } from './touchControls';

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
  zombies?: () => (V2 & { cold: boolean })[];
  /** Advance exactly `dt` game seconds per rendered frame (null: real time), so a slow test machine sees every frame a 60 fps player would. */
  fixedStep?: (dt: number | null) => void;
  /** Hold or release the trigger, as holding the left button does (without needing pointer lock). */
  holdFire?: (on: boolean) => void;
  /** Where the aim point appears relative to the screen centre, CSS px (the camera kick, as last drawn). */
  aimOffset?: () => [number, number];
  /** Where a ground point appears on screen now, CSS px (the touch stick checks measure which way the aim moved). */
  screenOf?: (x: number, z: number) => [number, number];
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
/**
 * The camera looks in at this angle off vertical, from wherever the gunship is in its orbit (the
 * bearing follows the plane; the range is the plane's real slant range). The real orbit is steeper
 * (about 34 degrees at the centre); a constant, slightly shallower slant shows the walls of houses
 * and keeps figures upright on screen.
 */
const CAM_TILT_DEG = 40;
/**
 * Zoom multiplies the gun's own lens (WeaponDef.fov). Z or the ZOOM button toggles between 1 and Z_ZOOM;
 * the mouse wheel and a pinch step along ZOOM_LEVELS (out to a wider view, in to a closer one).
 */
const Z_ZOOM = 1.6;
const ZOOM_LEVELS = [0.45, 0.7, 1, Z_ZOOM, 2.4] as const;
/** The narrowest lens the camera allows, degrees at LENS_RANGE (below this a 25 mm burst would fill the screen). */
const MIN_FOV = 1.0;
/**
 * Lenses (WeaponDef.fov) are quoted at this slant range, metres. Nearer or further, the angle is
 * adjusted so the view covers the same ground: a person stays the same size on screen wherever you look.
 */
export const LENS_RANGE = 1800;
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
  private post: SensorPost;
  private gfx: GfxGovernor;
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
  /** Zoom per gun (1 = the gun's own lens), so each gun keeps the zoom you left it at. */
  private zoomOf: Record<string, number> = { '25': 1, '40': 1, '105': 1 };
  /** Wheel movement not yet turned into a zoom step. */
  private wheelAcc = 0;
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
  /** On-screen controls for touch screens (3.11). */
  private touch!: TouchControls;
  /** When the current screen (pause card, result card) appeared, performance.now() ms: some keys wait a moment. */
  private screenAt = 0;
  /** Paused and reading the briefing again (Esc or Back returns to the pause card). */
  private reviewing = false;

  constructor(private container: HTMLElement, private map: MapData, sim: Sim, private opts: GameOptions) {
    this.sim = sim;
    // No canvas antialiasing: the scene is multisampled in its own render target (SensorPost).
    this.renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.renderer.domElement.className = 'game-canvas';
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0.15, 0.05, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(-0.4, 1, 0.3);
    this.scene.add(sun);

    this.world = buildWorld(map, sim.mission.seed);
    this.scene.add(this.world.group, this.agents.group, this.effects.group);

    // Picture quality: ?gfx=high|low forces a tier; otherwise start high and drop to low if frames
    // run slow. Not under automation (unless ?gfx=auto), so test screenshots are always the full picture.
    const q = tierFromQuery(location.search);
    const automated = typeof navigator !== 'undefined' && navigator.webdriver && !/[?&]gfx=auto\b/.test(location.search);
    this.gfx = new GfxGovernor(q === 'auto' ? 'high' : q, q === 'auto' && !automated);
    this.post = new SensorPost(this.renderer, this.gfx.tier);

    this.hud = new Hud(container, map.attribution);
    this.hud.setMinimap(map, sim.mission);
    this.overlay = el('div', 'overlay', undefined, container);
    this.bot = opts.bot ? new Bot(sim, SKILL.human) : null;
    if (opts.sensor) this.sensor = opts.sensor;
    this.shownSensor = this.sensor;
    const applySettings = () => {
      this.calm = effectiveReduceFlicker(opts.reduceFlicker, getSettings());
      this.post.uniforms.calm.value = this.calm ? 1 : 0;
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
      hooks.zombies = () => this.sim.zombies.filter((z) => z.alive).map((z) => ({ x: z.x, z: z.z, cold: z.cold }));
      hooks.fixedStep = (dt) => {
        this.fixedDt = dt;
      };
      hooks.aimOffset = () => {
        const p = this.screenPos(this.aim, 0);
        const c = this.renderer.domElement;
        return [p.x - c.clientWidth / 2, p.y - c.clientHeight / 2];
      };
      hooks.screenOf = (x, z) => {
        const p = this.screenPos({ x, z }, 0);
        return [p.x, p.y];
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
  /** The mission briefing: before the mission, or again from the pause menu (`review`: read-only, Back returns). */
  private showBriefing(review = false): void {
    const m = this.sim.mission;
    this.briefingView?.dispose();
    this.overlay.replaceChildren();
    const card = el('div', 'card briefing', undefined, this.overlay);
    const visuals = briefingVisuals(this.map, m, this.sim.graph, this.sim.grid);
    this.briefingView = visuals;
    card.appendChild(visuals.el);
    el('div', 'card-kicker', `MISSION · DIFFICULTY ${m.difficulty} · SEED ${m.seed}`, card);
    el('h2', undefined, m.title, card);
    for (const line of m.briefing) el('p', undefined, line, card);
    for (const line of m.intel) el('p', 'intel', line, card);
    el('p', 'small', this.touch?.active ? TOUCH_SENTENCE : KEYS_SENTENCE, card);
    if (review) {
      const back = el('button', 'primary briefing-back', 'Back', card);
      back.addEventListener('click', () => this.showPause());
      this.overlay.style.display = 'flex';
      back.focus({ preventScroll: true });
      return;
    }
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
    this.showPause();
  }

  /** The pause menu (Esc): Resume, Briefing, Restart, Settings, Quit to menu. */
  private showPause(): void {
    this.reviewing = false;
    this.screenAt = performance.now();
    this.briefingView?.dispose();
    this.briefingView = null;
    this.overlay.replaceChildren();
    const card = el('div', 'card pause', undefined, this.overlay);
    el('h2', undefined, 'Paused', card);
    const resume = el('button', 'primary', 'Resume', card);
    resume.addEventListener('click', () => this.resume());
    // Training night has no briefing to re-read.
    if (this.sim.mission.briefing.length) {
      el('button', 'pause-briefing', 'Briefing', card).addEventListener('click', () => {
        this.reviewing = true;
        this.showBriefing(true);
      });
    }
    el('button', 'pause-restart', 'Restart mission', card).addEventListener('click', () => this.opts.onRetry());
    el('button', undefined, 'Settings', card).addEventListener('click', () => this.openSettings());
    el('button', undefined, 'Quit to menu', card).addEventListener('click', () => this.opts.onMenu());
    el('p', 'small', this.touch?.active ? 'Resume to play on.' : 'Esc resumes.', card);
    this.overlay.style.display = 'flex';
    resume.focus();
  }

  private resume(): void {
    if (this.screen !== 'paused') return;
    this.briefingView?.dispose();
    this.briefingView = null;
    this.reviewing = false;
    this.screen = 'playing';
    this.overlay.style.display = 'none';
    if (!this.touch.active) this.lockPointer();
  }

  /** The settings panel, over the pause screen. Game keys are ignored while it's open. */
  openSettings(): void {
    if (this.closeSettings || this.disposed) return;
    this.closeSettings = openSettingsPanel(this.container, { onClose: () => (this.closeSettings = null) });
  }

  private showResult(won: boolean, reason: string): void {
    this.screen = 'ended';
    this.screenAt = performance.now();
    this.reviewing = false;
    this.briefingView?.dispose();
    this.briefingView = null;
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
      // The key map lives in controls.ts (R gun, Q view, Esc pause menu, ...).
      const a = keyAction(k, this.screen, (performance.now() - this.screenAt) / 1000);
      if (a) this.perform(a);
    });
    this.touch = new TouchControls(this.container, canvas, {
      playing: () => this.screen === 'playing' && !this.disposed,
      nudge: (dx, dy) => this.nudgeAim(dx, dy),
      aimAt: (x, y) => this.aimAtScreen(x, y),
      setFiring: (on) => {
        this.sfx.unlock();
        this.firing = on && this.screen === 'playing';
      },
      cycleWeapon: () => this.perform('weapon-next'),
      cycleView: () => this.perform('view-next'),
      zoom: (dir) => this.zoomBy(dir),
      pause: () => this.perform('pause'),
      labels: () => ({ weapon: this.weapon, view: viewLabel({ sensor: this.sensor, polarity: this.polarity }), zoom: `×${this.zoom.toFixed(1)}` }),
    });
    // Zoom: the mouse wheel (or trackpad) steps along the zoom levels; pinch and the ZOOM button are in TouchControls.
    this.on(canvas, 'wheel', (e) => {
      if (this.screen !== 'playing') return;
      const we = e as WheelEvent;
      we.preventDefault();
      this.wheelAcc += we.deltaMode === 0 ? we.deltaY : we.deltaY * 40;
      if (Math.abs(this.wheelAcc) < 80) return;
      this.zoomBy(this.wheelAcc < 0 ? 1 : -1);
      this.wheelAcc = 0;
    });
    this.on(window, 'keyup', (e) => this.keys.delete((e as KeyboardEvent).key.toLowerCase()));
    this.on(window, 'blur', () => {
      this.keys.clear();
      this.firing = false;
    });
  }

  /** One player action, from a key or a touch button. */
  private perform(a: ControlAction): void {
    this.sfx.unlock();
    switch (a) {
      case 'mute':
        updateSettings({ muted: !getSettings().muted });
        return;
      case 'retry':
        return this.opts.onRetry();
      case 'next':
        return this.opts.onNext();
      case 'pause':
        return this.pause();
      case 'back':
        if (this.reviewing) this.showPause();
        else this.resume();
        return;
    }
    if (this.screen !== 'playing') return;
    const gun = this.weapon;
    if (a === 'weapon-1' || a === 'weapon-2' || a === 'weapon-3') this.weapon = WEAPONS[Number(a.slice(-1)) - 1].id;
    if (a === 'weapon-next') this.weapon = WEAPONS[(WEAPONS.findIndex((w) => w.id === this.weapon) + 1) % WEAPONS.length].id;
    if (this.weapon !== gun) this.opts.onAction?.({ type: 'weapon', weapon: this.weapon });
    if (a === 'camera' && this.switchLeft <= 0) this.setSensor(this.sensor === 'thermal' ? 'night' : 'thermal');
    if (a === 'polarity' && this.sensor === 'thermal') this.flipPolarity();
    if (a === 'view-next' && this.switchLeft <= 0) {
      // White-hot → black-hot → night vision → white-hot (controls.ts nextView).
      const v = nextView({ sensor: this.sensor, polarity: this.polarity });
      if (v.sensor !== this.sensor) {
        this.setSensor(v.sensor);
        // Back to white-hot under the switch cover, so it never shows as a flash of its own.
        if (v.polarity !== this.polarity) this.polarity = this.polarityShown = v.polarity;
      } else if (v.polarity !== this.polarity) this.flipPolarity();
    }
    if (a === 'zoom') this.zoomBy(0);
  }

  /** At most one white/black-hot flip per 0.35 s, so rapid tapping stays under 3 flashes a second. */
  private flipPolarity(): void {
    if (this.clock - this.lastFlip < 0.35) return;
    this.polarity = 1 - this.polarity;
    this.lastFlip = this.clock;
    this.opts.onAction?.({ type: 'polarity', polarity: this.polarity });
  }

  /**
   * The one zoom hook for keys, wheel and touch: 0 toggles between the gun's own lens and Z_ZOOM (Z, the
   * ZOOM button); 1 steps in and -1 steps out along ZOOM_LEVELS (wheel, pinch). Each gun keeps its zoom.
   */
  private zoomBy(dir: -1 | 0 | 1): void {
    if (this.screen !== 'playing') return;
    const z = this.zoom;
    if (dir === 0) {
      this.zoomOf[this.weapon] = z > 1.01 ? 1 : Z_ZOOM;
      return;
    }
    const next = dir > 0 ? ZOOM_LEVELS.find((l) => l > z + 1e-3) : [...ZOOM_LEVELS].reverse().find((l) => l < z - 1e-3);
    if (next !== undefined) this.zoomOf[this.weapon] = next;
  }

  /** Aim at a point on screen (client px): where the line of sight through it meets the ground. Touch: tap to aim. */
  private aimAtScreen(clientX: number, clientY: number): void {
    const r = this.renderer.domElement.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3());
    if (!hit) return;
    const lim = this.map.half;
    this.aim = { x: Math.max(-lim, Math.min(lim, hit.x)), z: Math.max(-lim, Math.min(lim, hit.z)) };
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

  /** The current gun's zoom (1 = its own lens). */
  private get zoom(): number {
    return this.zoomOf[this.weapon] ?? 1;
  }

  /** The lens for the current gun and zoom at slant range `range` (metres), degrees. */
  private lensFov(range: number): number {
    const atRef = Math.max(MIN_FOV, weaponById(this.weapon).fov / this.zoom);
    const half = Math.atan((Math.tan(THREE.MathUtils.degToRad(atRef / 2)) * LENS_RANGE) / Math.max(1, range));
    return THREE.MathUtils.radToDeg(half * 2);
  }

  /** Where the camera sits: on the gunship's bearing from the aim point, at its slant range, CAM_TILT_DEG off vertical. */
  private cameraPos(ac: { x: number; y: number; z: number }, out: THREE.Vector3): THREE.Vector3 {
    const dx = ac.x - this.aim.x;
    const dz = ac.z - this.aim.z;
    const flat = Math.hypot(dx, dz) || 1;
    const range = Math.hypot(dx, ac.y, dz);
    const tilt = THREE.MathUtils.degToRad(CAM_TILT_DEG);
    const across = Math.sin(tilt) * range;
    return out.set(this.aim.x + (dx / flat) * across, Math.cos(tilt) * range, this.aim.z + (dz / flat) * across);
  }

  /**
   * Where a round's tracer starts: the gunship's real position in its orbit, so rounds fly in along the
   * slant line from the plane and enter from the edge of the picture. The camera looks from a slightly
   * different slant (CAM_TILT_DEG), so the plane is normally just off screen; when the two lines nearly
   * coincide (the plane would sit inside the picture and rounds would pop out of the middle), the start
   * point swings around the target, at the same range, until it is just outside the field of view.
   * Rendering only: the flight time is still the sim's (range / WeaponDef.speed).
   */
  private tracerOrigin(from: { x: number; y: number; z: number }, to: V2): { x: number; y: number; z: number } {
    const cam = this.camera;
    const t = new THREE.Vector3(to.x, 1.5, to.z);
    const a = new THREE.Vector3(from.x, from.y, from.z).sub(t);
    const range = a.length();
    if (range < 1) return from;
    a.divideScalar(range);
    const c = cam.position.clone().sub(t).normalize();
    // Half the picture's diagonal field of view, plus a margin.
    const halfV = THREE.MathUtils.degToRad(cam.fov / 2);
    const need = Math.min(THREE.MathUtils.degToRad(30), Math.atan(Math.tan(halfV) * Math.hypot(1, cam.aspect)) + THREE.MathUtils.degToRad(1.5));
    const cosAC = THREE.MathUtils.clamp(a.dot(c), -1, 1);
    if (Math.acos(cosAC) >= need) return from;
    // Swing away from the camera's line of sight, in the plane holding both lines (sideways if they coincide).
    const w = a.clone().addScaledVector(c, -cosAC);
    if (w.lengthSq() < 1e-8) w.setFromMatrixColumn(cam.matrixWorld, 0).multiplyScalar(-1);
    w.normalize();
    const dir = c.multiplyScalar(Math.cos(need)).addScaledVector(w, Math.sin(need));
    return { x: t.x + dir.x * range, y: Math.max(from.y * 0.5, t.y + dir.y * range), z: t.z + dir.z * range };
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
    const range = cam.position.distanceTo(new THREE.Vector3(this.aim.x, 0, this.aim.z)) || 1;
    const mPerPx = (2 * range * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2))) / h;
    const fwd = new THREE.Vector3();
    cam.getWorldDirection(fwd);
    const right = new THREE.Vector3().crossVectors(fwd, cam.up).normalize();
    const flatF = new THREE.Vector2(fwd.x, fwd.z).normalize();
    const elev = Math.asin(Math.min(1, cam.position.y / range));
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
    const real = (now - this.last) / 1000;
    if (this.screen === 'playing' && document.visibilityState !== 'hidden') {
      const t = this.gfx.frame(real);
      if (t) this.post.setTier(t);
    }
    const dt = this.fixedDt ?? Math.min(0.1, real);
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
    this.touch.update(dt);
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
  /** Recorded radio voice: flavour under the on-screen radio text (src/audio/voice.ts). */
  private voice: VoiceDirector | null = null;

  private handleEvents(events: SimEvent[]): void {
    const now = this.clock;
    const kc = this.killCall;
    if (kc.next < 0) kc.next = this.sim.mission.seed % KILL_LINES.length;
    (this.voice ??= new VoiceDirector((line) => audio.say(line), this.sim.mission.seed)).update(events, this.sim);
    for (const e of events) {
      this.opts.onAction?.({ type: 'sim', event: e });
      switch (e.type) {
        case 'fire':
          this.effects.fire(e.weapon, this.tracerOrigin(e.from, e.to), e.to, e.tof, now);
          this.sfx.fire(e.weapon);
          break;
        case 'impact':
          this.effects.impact(e.weapon, e.x, e.z, now);
          this.agents.impact(e.x, e.z, weaponById(e.weapon).radius, now); // flinches, falls away from the blast, ducking
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
        case 'line': // spec 002: few-left / cold-leftovers, captioned (the spoken words, then the count) and voiced
          this.radio(captionText(line(e.id, e.id === 'few-left' ? `Nearly there: ${e.left} left.` : `${e.left} left, all cold-blooded.`)));
          if (LINES[e.id].recorded) audio.say(e.id);
          break;
        case 'result':
          audio.sting(e.won);
          this.showResult(e.won, e.reason);
          break;
      }
    }
    if (kc.at >= 0 && now - kc.at >= KILL_MERGE) {
      this.radio(KILL_LINES[kc.next](kc.n));
      this.voice?.bigKill();
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
    const fov = this.lensFov(Math.hypot(ac.x - this.aim.x, ac.y, ac.z - this.aim.z));
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
    this.cameraPos(ac, this.camera.position);
    this.camera.lookAt(this.aim.x, 0, this.aim.z);
    this.applyKick(fov);
    this.camera.updateProjectionMatrix();

    this.agents.update(this.sim, this.clock);
    this.effects.update(this.clock, dt);

    const u = this.post.uniforms;
    u.time.value = this.clock;
    u.mode.value = this.pictureSensor() === 'night' ? 1 : 0;
    this.polarityShown += Math.sign(this.polarity - this.polarityShown) * Math.min(Math.abs(this.polarity - this.polarityShown), dt * 4);
    u.polarity.value = this.polarityShown;
    u.washout.value = this.effects.washout;
    u.blank.value = this.switchCover();
    this.renderer.info.reset();
    this.post.render(this.scene, this.camera);

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.hud.update(this.sim.state(), this.sim.mission, this.weapon, this.sensor, this.polarity, this.zoom, this.switchLeft > 0, this.clock, this.dangerClose(), this.touch.active);
      this.hud.updateMinimap(ac, this.aim, this.sim.survivors.filter((s) => s.alive && !s.home), this.sim.regroupPoints().map((g) => g.p));
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
    // Spec 002 feel M1: a scattered horde's regroup point while its runners are out (map text: textContent in the HUD).
    for (const g of this.sim.regroupPoints()) out.push({ label: g.label, p: g.p });
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
    this.post.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  info() {
    return {
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      screen: this.screen,
      sensor: this.sensor,
      // 3.11: read by the controls checks in scripts/playtest.mjs.
      weapon: this.weapon,
      polarity: this.polarity,
      // Zoomed in past the gun's own lens (Z, ZOOM, pinch in); zoomLevel is the multiplier.
      zoom: this.zoom > 1.01,
      zoomLevel: this.zoom,
      gfx: this.post.tier,
      fov: Number(this.camera.fov.toFixed(2)),
      aim: { ...this.aim },
      touch: this.touch.active,
      reviewing: this.reviewing,
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    // Test hooks must not outlive this game (they'd point at a dead one).
    const hooks = window.__spooky as TestHooks | undefined;
    if (hooks) for (const k of ['fireAt', 'aimAt', 'survivors', 'zombies', 'fixedStep', 'holdFire', 'aimOffset', 'screenOf'] as const) delete hooks[k];
    cancelAnimationFrame(this.raf);
    audio.release('mission');
    this.offSettings();
    this.closeSettings?.();
    this.briefingView?.dispose();
    this.touch.dispose();
    for (const [t, type, fn] of this.listeners) t.removeEventListener(type, fn);
    if (document.pointerLockElement) document.exitPointerLock?.();
    this.world.dispose();
    this.agents.dispose();
    this.effects.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.hud.dispose();
    this.overlay.remove();
  }
}
