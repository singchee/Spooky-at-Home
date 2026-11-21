import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { makeSampleTown } from '../map/sample';
import type { MapData } from '../map/types';
import { createSim } from '../sim/setup';
import type { Sim } from '../sim/sim';
import { buildWorld, type World } from '../world/buildWorld';
import { SensorShader } from '../render/sensors';
import { AgentsView } from '../game/agentsView';
import { Effects } from '../game/effects';
import { el } from './dom';
import { audio } from '../audio/engine';

/**
 * The front door: a live thermal picture of the sample town slowly orbiting behind the title,
 * three steps that explain the idea, and three ways in. Render-only, no HUD. The menu theme starts
 * on the first click or key press (browsers need a gesture) and carries on into the menu.
 */
export type LandingChoice = 'scout' | 'sample' | 'training';

export interface LandingOptions {
  /** A one-line notice above the title (e.g. after finishing training). Static text only. */
  notice?: string;
  /** Has the player finished Training night before? (Skipping it doesn't count.) */
  trained?: boolean;
}

export function showLanding(parent: HTMLElement, onChoose: (c: LandingChoice) => void, opts: LandingOptions = {}): () => void {
  const root = el('div', 'landing', undefined, parent);
  let backdrop: Backdrop | null = null;
  try {
    backdrop = new Backdrop(root);
  } catch {
    root.classList.add('no-webgl'); // static gradient fallback; the page still works
  }
  el('div', 'landing-shade', undefined, root);
  decor(root);

  const main = el('main', 'landing-content', undefined, root);
  if (opts.notice) el('p', 'landing-notice', opts.notice, main);
  el('div', 'landing-kicker', 'GUNSHIP · NIGHT SHIFT', main);
  const h1 = el('h1', 'landing-title', undefined, main);
  el('span', 'lt-1', 'SPOOKY', h1);
  el('span', 'lt-2', 'AT HOME', h1);
  el('p', 'landing-tagline', "The dead are shambling down your actual street. Luckily, you're circling overhead with a howitzer.", main);

  const steps = el('ol', 'landing-steps', undefined, main);
  const step = (n: string, title: string, desc: string) => {
    const li = el('li', undefined, undefined, steps);
    el('span', 'ls-num', n, li);
    const txt = el('span', 'ls-text', undefined, li);
    el('strong', undefined, title, txt);
    el('span', 'ls-desc', desc, txt);
  };
  step('1', 'Type your address', 'Any street, suburb or town.');
  step('2', 'We scout your area', 'Real streets, buildings and parks.');
  step('3', 'You fly overwatch', 'Get the neighbours home. Try not to shell the bakery.');

  const actions = el('div', 'landing-actions', undefined, main);
  const scout = el('button', 'primary la-scout', 'Scout my neighbourhood', actions);
  const sample = el('button', 'la-sample', 'Try the sample town', actions);
  const training = el('button', 'la-training', undefined, actions);
  el('span', 'la-label', 'Training night', training);
  el('span', 'la-sub', opts.trained ? '✓ done · fly it again' : 'first time? 3 minutes', training);
  // Shown only on touch screens (CSS: pointer: coarse): missions bring up on-screen controls there (3.11).
  el('p', 'landing-touch', 'On a touch screen, missions show a thumb stick and FIRE, GUN and VIEW buttons.', main);

  el('p', 'landing-privacy', 'Your search goes straight from your browser to OpenStreetMap. Nothing is stored.', main);
  el('p', 'landing-credit', 'Map data © OpenStreetMap contributors (ODbL)', main);

  let left = false;
  const choose = (c: LandingChoice) => () => {
    if (left) return;
    left = true;
    onChoose(c);
  };
  audio.claim('menu');
  const unlock = () => audio.unlock();
  root.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  scout.addEventListener('click', choose('scout'));
  sample.addEventListener('click', choose('sample'));
  training.addEventListener('click', choose('training'));

  return () => {
    window.removeEventListener('keydown', unlock);
    backdrop?.dispose();
    backdrop = null;
    root.remove();
  };
}

/** Gunship-camera framing drawn in CSS: corner brackets, a crosshair, and a readout. Decorative. */
function decor(root: HTMLElement): void {
  const d = el('div', 'landing-hud', undefined, root);
  d.setAttribute('aria-hidden', 'true');
  for (const c of ['tl', 'tr', 'bl', 'br']) el('span', `lh-corner ${c}`, undefined, d);
  const cross = el('div', 'lh-cross', undefined, d);
  el('span', 'lh-ring', undefined, cross);
  const read = el('div', 'lh-readout', undefined, d);
  el('span', 'lh-rec', 'IR  WHITE HOT', read);
  el('span', undefined, 'ORBIT LEFT · 1.0 KM', read);
  el('span', undefined, 'ALT 1,500 M', read);
}

const STEP = 1 / 60;

/** The live background: the sample town on the thermal camera, a slow orbit, zombies milling about. */
class Backdrop {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(9, 1, 200, 6000);
  private composer: EffectComposer;
  private sensorPass: ShaderPass;
  private world: World;
  private agents = new AgentsView();
  private effects = new Effects();
  private map: MapData = makeSampleTown();
  private sim: Sim;
  private seed = 4;
  private angle = 0.6;
  /** The horde the camera watches, and where it's looking (eases between hordes). */
  private horde = -1;
  private look: { x: number; z: number } | null = null;
  /** A lazy scripted gunner: picks off stragglers at the edge of the watched horde now and then. */
  private gunTimer = 2.5;
  private shots = 0;
  private burst = 0;
  private target: { x: number; z: number } | null = null;
  private clock = 0;
  private acc = 0;
  private last = performance.now();
  private boot = 1;
  private raf = 0;
  private disposed = false;
  private reduced: MediaQueryList | null;
  private onResize = () => this.resize();

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setPixelRatio(Math.min(1.5, window.devicePixelRatio));
    this.renderer.domElement.className = 'landing-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    container.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0.15, 0.05, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(-0.4, 1, 0.3);
    this.scene.add(sun);

    this.sim = this.newSim();
    this.world = buildWorld(this.map, 1);
    this.scene.add(this.world.group, this.agents.group, this.effects.group);

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.sensorPass = new ShaderPass(SensorShader);
    this.composer.addPass(this.sensorPass);

    this.reduced = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
    window.addEventListener('resize', this.onResize);
    this.resize();
    // Let the zombies spread out a little before the first frame, so the picture opens mid-scene.
    for (let i = 0; i < 60 * 4; i++) this.sim.step(STEP);
    this.sim.drainEvents();
    this.raf = requestAnimationFrame(this.frame);
  }

  private get still(): boolean {
    return !!this.reduced?.matches;
  }

  private newSim(): Sim {
    for (let tries = 0; tries < 5; tries++) {
      const r = createSim(this.map, { type: 'clear', difficulty: 5, seed: this.seed++ });
      if (r.ok) return r.sim;
    }
    throw new Error('no backdrop mission');
  }

  /** Now and then, shoot the straggler furthest from the watched horde's middle. Never with reduced motion. */
  private gunner(dt: number): void {
    if (this.still || this.horde < 0) return;
    const sim = this.sim;
    if (this.burst > 0 && this.target) {
      if (sim.fire('25', this.target)) this.burst--;
      return;
    }
    this.gunTimer -= dt;
    if (this.gunTimer > 0) return;
    this.gunTimer = 3.2 + (this.shots % 3) * 0.9;
    const c = sim.mission.hordes[this.horde].centre;
    let best: { x: number; z: number } | null = null;
    let bd = -1;
    for (const z of sim.zombies) {
      if (!z.alive) continue;
      const d = Math.hypot(z.x - c.x, z.z - c.z);
      if (d < 60 && d > bd) {
        bd = d;
        best = { x: z.x + z.vx * 0.5, z: z.z + z.vz * 0.5 };
      }
    }
    if (!best) return;
    this.target = best;
    this.shots++;
    if (this.shots % 2) sim.fire('40', best);
    else this.burst = 8;
  }

  private frame = (now: number): void => {
    if (this.disposed) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.clock += dt;
    // One lap every 4 minutes; stopped for reduced motion.
    if (!this.still) this.angle -= ((Math.PI * 2) / 240) * dt;
    this.acc += dt;
    while (this.acc >= STEP) {
      this.acc -= STEP;
      this.gunner(STEP);
      this.sim.step(STEP);
    }
    for (const e of this.sim.drainEvents()) {
      if (e.type === 'fire') this.effects.fire(e.weapon, e.from, e.to, e.tof, this.clock);
      if (e.type === 'impact') this.effects.impact(e.weapon, e.x, e.z, this.clock);
    }
    if (this.sim.phase !== 'running') {
      this.sim = this.newSim();
      this.horde = -1;
    }
    this.boot = Math.max(0, this.boot - dt / 1.4);
    this.render(dt);
  };

  private render(dt: number): void {
    const c = this.focus(dt);
    const R = 700;
    this.camera.position.set(c.x + Math.cos(this.angle) * R, 640, c.z + Math.sin(this.angle) * R);
    this.camera.lookAt(c.x, 0, c.z);
    this.agents.update(this.sim, this.clock);
    this.effects.update(this.clock, dt);
    const u = this.sensorPass.uniforms;
    u.time.value = this.clock;
    u.mode.value = 0;
    u.polarity.value = 0;
    u.washout.value = 0;
    u.blank.value = this.still ? 0 : this.boot;
    this.composer.render();
  }

  /** Ease the view toward the horde with the most zombies still standing, so there's always something shambling. */
  private focus(dt: number): { x: number; z: number } {
    const hordes = this.sim.mission.hordes;
    const alive = (i: number) =>
      this.sim.zombies.reduce((k, z) => k + (z.alive && Math.hypot(z.x - hordes[i].centre.x, z.z - hordes[i].centre.z) < 60 ? 1 : 0), 0);
    // Stay with the current horde until it's thinned out, then move on to the busiest one.
    if (this.horde < 0 || alive(this.horde) < 5) {
      let most = -1;
      for (let i = 0; i < hordes.length; i++) {
        const n = alive(i);
        if (i !== this.horde && n > most) {
          most = n;
          this.horde = i;
        }
      }
    }
    const best = hordes[this.horde]?.centre ?? this.sim.mission.orbitCentre;
    if (!this.look) this.look = { ...best };
    const k = Math.min(1, dt * 0.25);
    this.look.x += (best.x - this.look.x) * k;
    this.look.z += (best.z - this.look.z) * k;
    return this.look;
  }

  private resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    (this.sensorPass.uniforms.res.value as THREE.Vector2).set(w * pr, h * pr);
    this.camera.aspect = w / h;
    // Portrait screens are narrow: widen the lens so the town still reads.
    this.camera.fov = w / h < 1 ? 15 : 9;
    // On wide screens the text sits on the left, so shift the town into the right-hand side.
    // On phones the text fills the lower part, so lift the town into the top.
    if (w >= 900) this.camera.setViewOffset(w, h, -w * 0.18, 0, w, h);
    else this.camera.setViewOffset(w, h, 0, h * 0.3, w, h);
    this.camera.updateProjectionMatrix();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener('resize', this.onResize);
    this.world.dispose();
    this.agents.dispose();
    this.effects.dispose();
    this.sensorPass.dispose?.();
    this.composer.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
  }
}
