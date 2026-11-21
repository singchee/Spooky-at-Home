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
import { el } from '../ui/dom';
import { Sfx } from '../audio/sfx';

/** The browser game: renders the simulation, handles input, camera, sound and screens. */
export interface GameOptions {
  bot?: boolean;
  skipBriefing?: boolean;
  sensor?: SensorId;
  onRetry(): void;
  onNext(): void;
  onMenu(): void;
}

type Screen = 'briefing' | 'playing' | 'paused' | 'ended';
/** One audio context for the whole page; browsers limit how many can exist. */
const sharedSfx = new Sfx();
const STEP = 1 / 60;
const SWITCH_TIME = 0.7;

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
  private raf = 0;
  private disposed = false;
  private listeners: [EventTarget, string, EventListener][] = [];

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
    this.overlay = el('div', 'overlay', undefined, container);
    this.bot = opts.bot ? new Bot(sim, SKILL.human) : null;
    if (opts.sensor) this.sensor = opts.sensor;
    const m = sim.mission;
    this.aim = m.route ? { ...m.route[0] } : m.safehouse ? { ...m.safehouse.centre } : { ...m.orbitCentre };

    this.bindInput();
    this.resize();
    if (opts.skipBriefing) this.start();
    else this.showBriefing();
    this.last = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  // ---------- screens ----------
  private showBriefing(): void {
    const m = this.sim.mission;
    this.overlay.replaceChildren();
    const card = el('div', 'card', undefined, this.overlay);
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
    const menu = el('button', undefined, 'Quit to menu', card);
    menu.addEventListener('click', () => this.opts.onMenu());
    this.overlay.style.display = 'flex';
  }

  private showResult(won: boolean, reason: string): void {
    this.screen = 'ended';
    this.firing = false;
    document.exitPointerLock?.();
    const s = this.sim.state();
    this.overlay.replaceChildren();
    const card = el('div', `card ${won ? 'won' : 'lost'}`, undefined, this.overlay);
    el('div', 'card-kicker', won ? 'MISSION COMPLETE' : 'MISSION FAILED', card);
    el('h2', undefined, reason, card);
    const stats = [
      `Time ${Math.floor(s.t / 60)}:${String(Math.floor(s.t % 60)).padStart(2, '0')}`,
      `Kills ${s.kills} from ${s.shots} rounds${s.shots ? ` (${(s.kills / s.shots).toFixed(1)} per round)` : ''}`,
      `Friendly-fire incidents ${s.friendlyHits}`,
    ];
    if (s.survivorsTotal && this.sim.mission.type === 'clear') stats.push(`Friendlies alive ${s.survivorsAlive}/${s.survivorsTotal}`);
    else if (s.survivorsTotal) stats.push(`Survivors home ${s.survivorsHome}/${s.survivorsTotal}`);
    for (const t of stats) el('p', 'small', t, card);
    const row = el('div', 'row', undefined, card);
    el('button', 'primary', 'Retry', row).addEventListener('click', () => this.opts.onRetry());
    el('button', undefined, 'Next mission', row).addEventListener('click', () => this.opts.onNext());
    el('button', undefined, 'Menu', row).addEventListener('click', () => this.opts.onMenu());
    this.overlay.style.display = 'flex';
  }

  // ---------- input ----------
  private on(t: EventTarget, type: string, fn: EventListener): void {
    t.addEventListener(type, fn);
    this.listeners.push([t, type, fn]);
  }

  private lockPointer(): void {
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
      this.nudgeAim(me.movementX, me.movementY);
    });
    this.on(window, 'keydown', (e) => {
      const ke = e as KeyboardEvent;
      const k = ke.key.toLowerCase();
      this.keys.add(k);
      // Toggles fire once per press: holding a key must never strobe the screen (photosensitivity).
      if (ke.repeat) return;
      if (this.screen === 'ended') {
        if (k === 'r') this.opts.onRetry();
        if (k === 'n') this.opts.onNext();
        return;
      }
      if (k === 'escape' && this.screen === 'playing') this.pause();
      if (k === 'm') this.sfx.muted = !this.sfx.muted;
      if (this.screen === 'paused' && k === 'r') this.opts.onRetry();
      if (this.screen !== 'playing') return;
      if (k === '1' || k === '2' || k === '3') this.weapon = WEAPONS[Number(k) - 1].id;
      if (k === 'q') this.weapon = WEAPONS[(WEAPONS.findIndex((w) => w.id === this.weapon) + 1) % WEAPONS.length].id;
      if (k === 'v' && this.switchLeft <= 0) this.setSensor(this.sensor === 'thermal' ? 'night' : 'thermal');
      // At most one white/black-hot flip per 0.35 s, so rapid tapping stays under 3 flashes a second.
      if (k === 'h' && this.sensor === 'thermal' && this.clock - this.lastFlip >= 0.35) {
        this.polarity = 1 - this.polarity;
        this.lastFlip = this.clock;
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
    const dt = Math.min(0.1, (now - this.last) / 1000);
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

  private handleEvents(events: SimEvent[]): void {
    const now = this.clock;
    for (const e of events) {
      switch (e.type) {
        case 'fire':
          this.effects.fire(e.weapon, e.from, e.to, e.tof, now);
          this.sfx.fire(e.weapon);
          break;
        case 'impact':
          this.effects.impact(e.weapon, e.x, e.z, now);
          this.sfx.impact(e.weapon);
          if (e.kills >= 5) this.radio(`Good effect on target, ${e.kills} down. That's a lot of former neighbours.`);
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
          this.radio(`New contacts: ${e.count} from the ${e.from}${e.cold ? `, ${e.cold} of them cold-blooded` : ''}.`);
          break;
        case 'radio':
          this.radio(e.text);
          break;
        case 'result':
          this.showResult(e.won, e.reason);
          break;
      }
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
    const sh = this.effects.shake;
    this.camera.lookAt(this.aim.x + Math.sin(this.clock * 90) * sh * 8, 0, this.aim.z + Math.cos(this.clock * 77) * sh * 8);
    this.camera.updateProjectionMatrix();

    this.agents.update(this.sim, this.clock);
    this.effects.update(this.clock, dt);

    const u = this.sensorPass.uniforms;
    u.time.value = this.clock;
    u.mode.value = this.sensor === 'night' ? 1 : 0;
    this.polarityShown += Math.sign(this.polarity - this.polarityShown) * Math.min(Math.abs(this.polarity - this.polarityShown), dt * 4);
    u.polarity.value = this.polarityShown;
    u.washout.value = this.effects.washout;
    // Switch static fades out smoothly instead of cutting off.
    u.blank.value = Math.min(1, (this.switchLeft / SWITCH_TIME) * 1.6);
    this.renderer.info.reset();
    this.composer.render();

    this.hudTimer -= dt;
    if (this.hudTimer <= 0) {
      this.hudTimer = 0.1;
      this.hud.update(this.sim.state(), this.sim.mission, this.weapon, this.sensor, this.polarity, this.zoom, this.switchLeft > 0, this.clock, this.dangerClose());
    }
    this.hud.setMarkers(this.markers());
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
    this.disposed = true;
    cancelAnimationFrame(this.raf);
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
