import * as THREE from 'three';
import type { MapData, V2 } from '../map/types';
import { ORBIT, type Sim, type SimEvent } from '../sim/sim';
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
import { reducedMotion } from '../ui/motion';
import { openSettingsPanel } from '../ui/settingsPanel';
import { bestKey, bests, formatBest, formatTime, missionKind } from '../ui/bests';
import { gradeMission, scoreInput } from '../sim/score';
import { LINES, captionText, line } from '../sim/campaignText';
import { effectiveReduceFlicker, mouseAimDelta } from './input';
import { KEYS_SENTENCE, TOUCH_SENTENCE, keyAction, nextView, viewLabel, type ControlAction } from './controls';
import { TouchControls } from './touchControls';
import { LandmarkLayer } from '../ui/landmarkLayer';
import { landmarkList, type Landmark } from '../ui/landmarks';
import { GunshipOrbit, offVertical, orbitTarget, tallFactor, turnHeading } from './gunshipOrbit';
import { AIM_KEEP, type Keep } from '../world/cutaway';
import { dangerCloseAt, edgePointer, MaskLatch, NearSet, roundTarget } from './lineOfFire';

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
  /**
   * Line of sight at a ground point (3.39), from where the gunship is now: `masked` when a building
   * stands between the gunship and a body there (the reticle's MASKED), `covered` when what is drawn
   * solid after the cut-away still hides it; `cut` counts the buildings cut away now.
   */
  sight?: (x: number, z: number) => { masked: boolean; covered: boolean; cut: number };
  /** The gunship's orbit as drawn (3.39): centre, radius, position, degrees off vertical at the aim, the city's height there. */
  orbit?: () => { cx: number; cz: number; r: number; gunship: { x: number; y: number; z: number }; offVertical: number; tallness: number; masked: boolean };
  /** Turn the cut-away off or on (test-only: before/after screenshots of the same moment). */
  cutaway?: (on: boolean) => void;
  /** Where a ground point appears on screen now, CSS px (the touch stick checks measure which way the aim moved). */
  screenOf?: (x: number, z: number) => [number, number];
  /** The places that may get a landmark marker (3.19), most relevant first. */
  landmarks?: () => { id: string; label: string; x: number; z: number }[];
}


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
 * The camera looks along the gun's real line of fire (3.39): from the gunship (gunshipOrbit.ts) to
 * the aim point, so what you see is what you could hit. Figures lean back a little on steep views
 * (modelShader.ts) so they read as they did at the old fixed 40° slant.
 * The picture's up turns at most this fast (rad/s) when the line is near vertical (no flip overhead).
 */
const HEADING_RATE = 0.5;
/** A body's height above the ground for the MASKED test, metres (roads sit at 1 m). */
const SIGHT_Y = 1.5;
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
  /** In-flight landmark markers (3.19): public places from the recon, never child places. */
  private landmarks: LandmarkLayer;
  private landmarkPlaces: Landmark[];
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
  /** The gunship as drawn (3.39): flies the sim's orbit over low-rise ground, a tighter, steeper one over tall blocks. */
  private orbit!: GunshipOrbit;
  private gunship = { x: 0, y: ORBIT.altitude, z: 0 };
  /** The picture's up, a ground heading (radians), and whether it has been set yet. */
  private heading = 0;
  private headingSet = false;
  /** Game clock at the last round fired (reduced motion only changes the orbit between bursts). */
  private lastShot = -99;
  /** A building stands between the gunship and the aim point (the reticle's MASKED, latched: off 0.3 s after clear). */
  private masked = false;
  private maskLatch = new MaskLatch();
  /** Where a round fired now would land: the first building on the line of fire, or the aim point (y 0). */
  private landing: { x: number; y: number; z: number; building: number } = { x: 0, y: 0, z: 0, building: -1 };
  /** Mission markers near the aim that the cut-away keeps in sight (added inside 60 m, dropped beyond 68 m). */
  private nearMarkers = new NearSet(60, 68);
  /** Test hook only: the cut-away can be switched off for comparison screenshots. */
  private cutawayOn = true;
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
    this.landmarks = new LandmarkLayer(this.hud.root, container);
    this.landmarkPlaces = landmarkList(map, sim.mission);
    this.overlay = el('div', 'overlay', undefined, container);
    this.bot = opts.bot ? new Bot(sim, SKILL.human) : null;
    if (opts.sensor) this.sensor = opts.sensor;
    this.shownSensor = this.sensor;
    const applySettings = () => {
      this.calm = effectiveReduceFlicker(opts.reduceFlicker, getSettings());
      this.post.uniforms.calm.value = this.calm ? 1 : 0;
      this.landmarks.setEnabled(getSettings().showLandmarks);
    };
    applySettings();
    this.offSettings = onSettingsChange(applySettings);
    const m = sim.mission;
    this.aim = m.route ? { ...m.route[0] } : m.safehouse ? { ...m.safehouse.centre } : { ...m.orbitCentre };
    const k0 = this.tallK();
    this.orbit = new GunshipOrbit(orbitTarget(k0, m.orbitCentre, this.aim, ORBIT.radius), this.aim, k0);

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
      hooks.sight = (x, z) => {
        const c = this.world.cutaway;
        return { masked: c.blocker({ x, z }, this.gunship, SIGHT_Y) >= 0, covered: c.coverer({ x, z }, this.gunship, SIGHT_Y) >= 0, cut: c.cutCount };
      };
      hooks.cutaway = (on) => {
        this.cutawayOn = on;
      };
      hooks.orbit = () => {
        const g = this.gunship;
        return { ...this.orbit.shape, gunship: { ...g }, offVertical: offVertical(Math.hypot(g.x - this.aim.x, g.z - this.aim.z), g.y), tallness: this.world.cutaway.heights.tallness(this.aim), masked: this.masked };
      };
      hooks.landmarks = () => this.landmarkPlaces.map((l) => ({ id: l.id, label: l.label, x: l.p.x, z: l.p.z }));
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

  /**
   * Capture the mouse for aiming (desktop). Never with touch controls on: while the pointer is locked, Chrome
   * reports every pointer event, touches included, at (0, 0), so the stick read "up" wherever it was touched
   * and a tap aimed at the corner of the picture (owner, Android tablet, after "Start mission").
   */
  lockPointer(): void {
    if (this.touch?.active) return;
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
      // Touch controls switching on let go of the mouse (below): that is no reason to pause.
      if (document.pointerLockElement !== canvas && this.screen === 'playing' && !this.touch.active) this.pause();
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
      // A touch on a screen that had the mouse captured (e.g. a touchscreen laptop): let go of the mouse,
      // or every touch would read as (0, 0).
      activeChanged: (on) => {
        if (on && document.pointerLockElement) document.exitPointerLock?.();
      },
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

  /** 0 over low-rise ground, 1 over high-rise blocks: how tight the gunship's orbit is around the aim. */
  private tallK(): number {
    return tallFactor(this.world.cutaway.heights.tallness(this.aim));
  }

  /**
   * Fly the gunship (3.39) and put the camera on it, looking along the line of fire at the aim point.
   * The orbit angle is the sim's; the orbit's centre and radius ease toward the tight one over tall
   * blocks (dt-scaled; with reduced motion only in one cut, between bursts or after a long aim move).
   */
  private flyCamera(dt: number): void {
    const m = this.sim.mission;
    const ac = this.sim.aircraft();
    const angle = Math.atan2(ac.z - m.orbitCentre.z, ac.x - m.orbitCentre.x);
    const idle = this.firing ? 0 : this.clock - this.lastShot;
    this.orbit.update(dt, this.tallK(), m.orbitCentre, this.aim, ORBIT.radius, { reducedMotion: reducedMotion(), idle });
    this.gunship = this.orbit.position(angle, ac.y);
    const g = this.gunship;
    const dx = this.aim.x - g.x;
    const dz = this.aim.z - g.z;
    // Picture up = away from the gunship along the ground; near vertical that direction swings fast,
    // so there it turns at a capped rate instead of flipping.
    const target = Math.atan2(dx, dz);
    const deg = offVertical(Math.hypot(dx, dz), g.y);
    const t = Math.max(0, Math.min(1, (deg - 6) / 8));
    if (!this.headingSet || t >= 1) this.heading = target;
    else this.heading = turnHeading(this.heading, target, HEADING_RATE * (1 + 12 * t * t), dt);
    this.headingSet = true;
    this.camera.position.set(g.x, g.y, g.z);
    this.camera.up.set(Math.sin(this.heading), 0, Math.cos(this.heading));
  }

  /**
   * Where a round's tracer starts: the gunship, so rounds fly in along its slant line. The camera rides
   * on that line too (3.39), so a tracer from the plane itself would pop out of the middle of the
   * picture: the start point swings around the target, at the same range, until it is just outside the
   * field of view, and rounds enter from the edge of the picture.
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
    cam.updateMatrixWorld();
    const right = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 0);
    const up = new THREE.Vector3().setFromMatrixColumn(cam.matrixWorld, 1);
    // Screen up on the ground (the view's forward on an oblique view; still defined looking straight down).
    const flatF = new THREE.Vector2(up.x, up.z).normalize();
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

  /**
   * Fire at the aim point. Buildings stop rounds: a round meeting one on the line of fire lands on
   * the ground under that point (the same rule the MASKED impact mark and DANGER CLOSE use; BACKLOG
   * 3.41 moves it into the sim).
   */
  private tryFire(): void {
    if (!this.sim.weaponReady(this.weapon)) return;
    this.sim.fire(this.weapon, roundTarget(this.world.cutaway.index.landing(this.aim, this.gunship)).fire);
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
          // Rendering only: the round comes from the gunship as drawn; the flight time is still the sim's.
          this.effects.fire(e.weapon, this.tracerOrigin(this.gunship, e.to), e.to, e.tof, now);
          this.lastShot = now;
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
    this.flyCamera(Math.max(0, dt));
    const g = this.gunship;
    const fov = this.lensFov(Math.hypot(g.x - this.aim.x, g.y, g.z - this.aim.z));
    this.camera.fov = fov;
    this.camera.lookAt(this.aim.x, 0, this.aim.z);
    this.applyKick(fov);
    this.camera.updateProjectionMatrix();
    const markerPts = this.markerPoints();
    this.updateCutaway(Math.max(0, dt), markerPts);

    this.agents.update(this.sim, this.clock, this.camera.position);
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
      this.hud.update(this.sim.state(), this.sim.mission, this.weapon, this.sensor, this.polarity, this.zoom, this.switchLeft > 0, this.clock, this.dangerClose(), this.touch.active, this.masked);
      this.hud.updateMinimap(this.sim.aircraft(), this.aim, this.sim.survivors.filter((s) => s.alive && !s.home), this.sim.regroupPoints().map((g) => g.p));
    }
    const markers = this.markers(markerPts);
    this.hud.setMarkers(markers);
    // MASKED: a small steady mark where the round would actually hit (the HUD: never see-through).
    // On the ground where the blast will be (the same point tryFire hands the sim); a steady edge
    // pointer toward it when that is off screen.
    const rt = roundTarget(this.landing);
    if (this.masked && rt.blocked) {
      const sp = this.screenPos(rt.fire, rt.mark.y);
      const c = this.renderer.domElement;
      this.hud.setImpactMark(sp.visible ? { x: sp.x, y: sp.y } : edgePointer(sp.x, sp.y, c.clientWidth, c.clientHeight));
    } else this.hud.setImpactMark(null);
    this.updateLandmarks(fov, markers);
  }

  /**
   * The cut-away (3.39), subtle on purpose: only buildings hiding the aim point, or a mission marker
   * near it, fade, and only above the line of sight (cutaway.ts). And the reticle's MASKED state: a
   * building on the line of fire to the aim point, judged on whole buildings, never the cut-away.
   */
  private updateCutaway(dt: number, markerPts: { label: string; p: V2 }[]): void {
    const keep: Keep[] = this.cutawayOn ? [{ p: this.aim, r: AIM_KEEP }] : [];
    const near = this.nearMarkers.update(markerPts, this.aim);
    if (this.cutawayOn) for (const mk of near) keep.push({ p: mk.p, r: 6 });
    const c = this.world.cutaway;
    c.update(this.gunship, keep, dt);
    this.masked = this.maskLatch.update(c.blocker(this.aim, this.gunship, SIGHT_Y) >= 0, dt);
    this.landing = c.index.landing(this.aim, this.gunship);
  }

  /** Landmark markers this frame (3.19): projected here, decluttered and drawn by the layer. */
  private updateLandmarks(fovDeg: number, markers: { x: number; y: number; visible: boolean }[]): void {
    const c = this.renderer.domElement;
    const range = this.camera.position.distanceTo(new THREE.Vector3(this.aim.x, 0, this.aim.z));
    const viewHalf = range * Math.tan(THREE.MathUtils.degToRad(fovDeg / 2)) * Math.max(1, (c.clientWidth || 1) / (c.clientHeight || 1));
    const items = this.landmarkPlaces.map((l) => {
      const s = this.screenPos(l.p, 2);
      return { id: l.id, label: l.label, priority: l.priority, x: s.x, y: s.y, visible: s.visible, aimDist: Math.hypot(l.p.x - this.aim.x, l.p.z - this.aim.z) };
    });
    this.landmarks.update(items, { now: performance.now() / 1000, zoom: this.zoom, viewHalf, markers });
  }

  /**
   * The 105's camera kick: one damped swing of at most SHAKE_MAX_PX screen pixels, converted to
   * metres at the aim point with the current field of view and range. Off with reduced motion or
   * reduce flicker.
   */
  private applyKick(fovDeg: number): void {
    if (this.reduceFlicker || reducedMotion()) return;
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
    return dangerCloseAt(this.landing, this.sim.survivors, weaponById(this.weapon).radius);
  }

  private markers(out: { label: string; p: V2 }[]) {
    const wpx = this.renderer.domElement.clientWidth;
    const hpx = this.renderer.domElement.clientHeight;
    const v = new THREE.Vector3();
    return out.map((o) => {
      v.set(o.p.x, 4, o.p.z).project(this.camera);
      const visible = v.z < 1 && Math.abs(v.x) < 1 && Math.abs(v.y) < 1;
      return { label: o.label, x: ((v.x + 1) / 2) * wpx, y: ((1 - v.y) / 2) * hpx, visible };
    });
  }

  /** The mission's markers on the ground (safehouse, home, the escort group, regroup points). */
  private markerPoints() {
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
    return out;
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
      masked: this.masked,
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
    if (hooks) for (const k of ['fireAt', 'aimAt', 'survivors', 'zombies', 'fixedStep', 'holdFire', 'aimOffset', 'screenOf', 'landmarks', 'sight', 'orbit', 'cutaway'] as const) delete hooks[k];
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
