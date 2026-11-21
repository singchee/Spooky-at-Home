/**
 * Figure lab: a dev-only test scene for the animated people (zombies and survivors), drawn through the
 * real AgentsView and the real sensor filter, at an oblique gunship view. Not part of the game build:
 * run `npm run dev` and open /tools/figure-lab.html?scene=poses&mode=white. scripts/look-figures.mjs
 * takes the screenshots.
 *
 * URL parameters:
 *   scene  poses (every animation, labelled) | crowd (a synthetic crowd) | sim (the real sample-town sim)
 *   mode   white | black | night            (thermal white-hot, black-hot, night vision)
 *   tilt   camera angle off vertical, degrees (default 35)
 *   az     camera heading, degrees (default 8: the camera is south of the scene, rows read left to right)
 *   px     how tall a standing figure is on screen, pixels (default 32 at a 1080-high view, scaled to the window)
 *   t      the moment to show, seconds (agents are simulated from 0 to t at 60 steps a second)
 *   seed, type, difficulty  for scene=sim
 *   labels 0 to hide the labels
 *   models 0 to draw the procedural fallback figures instead of the character models
 * Everything is deterministic: the same URL draws the same frame.
 */
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { AgentsView } from '../src/game/agentsView';
import { SensorShader } from '../src/render/sensors';
import { buildWorld, SIG } from '../src/world/buildWorld';
import { makeSampleTown } from '../src/map/sample';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import { weaponById } from '../src/sim/weapons';
import type { MissionType } from '../src/sim/missions';
import type { Sim } from '../src/sim/sim';

THREE.ColorManagement.enabled = false;

const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const scene = q.get('scene') ?? 'poses';
const mode = q.get('mode') ?? 'white';
const tilt = THREE.MathUtils.degToRad(num('tilt', 35));
const az = THREE.MathUtils.degToRad(num('az', 8));
const T = num('t', 2.4);
const showLabels = q.get('labels') !== '0';

/** Stable pseudo-random numbers for the lab's own layout (never Math.random: the lab must repeat exactly). */
const h01 = (i: number, k = 0) => {
  let h = Math.imul(i ^ 0x2c1b3c6d, 0x297a2d39) ^ Math.imul(k + 0x9e37, 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h ^= h >>> 13;
  return (h >>> 0) / 4294967296;
};

interface LabZombie {
  id: number;
  x: number;
  z: number;
  vx: number;
  vz: number;
  speed: number;
  cold: boolean;
  alive: boolean;
  diedAt: number;
  home: null;
  goal: null;
}
interface LabSurvivor {
  id: number;
  x: number;
  z: number;
  alive: boolean;
  home: boolean;
  diedAt: number;
}
/** A scripted agent: where it is and what it's doing at time t. */
interface Script {
  label?: string;
  at: (t: number) => { x: number; z: number; vx: number; vz: number; alive: boolean; diedAt: number };
}

/** Walks along heading `deg` at `v` m/s, arriving at (x, z) at time T; stops at `stopAt`; dies at `dieAt`. */
function walker(x: number, z: number, deg: number, v: number, stopAt = Infinity, dieAt = Infinity): Script['at'] {
  const a = THREE.MathUtils.degToRad(deg);
  const dx = Math.sin(a);
  const dz = Math.cos(a);
  const end = Math.min(T, stopAt, dieAt);
  return (t) => {
    const tt = Math.min(t, end);
    const moving = t < Math.min(stopAt, dieAt);
    return { x: x + dx * v * (tt - end), z: z + dz * v * (tt - end), vx: moving ? dx * v : 0, vz: moving ? dz * v : 0, alive: t < dieAt, diedAt: t < dieAt ? -1 : dieAt };
  };
}

const zScripts: (Script & { speed: number; cold: boolean })[] = [];
const sScripts: Script[] = [];
const impacts: { x: number; z: number; r: number; t: number }[] = [];
let focus = new THREE.Vector3(0, 1, 5);

if (scene === 'poses') {
  // Row A, on a road: every zombie animation. Row B, on grass: survivors, and coldies for comparison.
  const xs = (i: number) => -27 + i * 6;
  const rowA = 0;
  const rowB = 13;
  const Z = (label: string, at: Script['at'], speed = 1.6, cold = false) => zScripts.push({ label, at, speed, cold });
  Z('shamble', walker(xs(0), rowA, 90, 1.0));
  Z('lunge (chase)', walker(xs(1), rowA, 90, 2.3));
  Z('run (rusher)', walker(xs(2), rowA, 90, 3.3, Infinity), 2.6);
  Z('attack', walker(xs(3), rowA, 90, 1.0, T - 1.5));
  Z('hit-react', walker(xs(4), rowA, 90, 1.0));
  impacts.push({ x: xs(4) + 0.5, z: rowA - 3, r: 1.5, t: T - 0.18 });
  Z('falling 0.3 s', walker(xs(5), rowA, 90, 1.0, Infinity, T - 0.3));
  Z('body 1 s', walker(xs(6), rowA, 90, 1.0, Infinity, T - 1));
  Z('body 10 s', walker(xs(7), rowA, 90, 1.0, Infinity, T - 10));
  Z('body 20 s', walker(xs(8), rowA, 90, 1.0, Infinity, T - 20));
  Z('coldie (road)', walker(xs(9), rowA, 90, 1.0), 1.4, true);
  Z('coldie (grass)', walker(xs(0), rowB, 90, 1.0), 1.4, true);
  Z('zombie (grass)', walker(xs(1), rowB, 90, 1.0));
  const S = (label: string, at: Script['at']) => sScripts.push({ label, at });
  S('survivor idle', walker(xs(3), rowB, 0, 0));
  S('walk', walker(xs(4), rowB, 90, 2.1));
  S('run', walker(xs(5), rowB, 90, 3.2));
  S('crouch (cower)', walker(xs(6) + 0.6, rowB, 270, 0));
  Z('', walker(xs(6) - 0.5, rowB, 90, 1.0, T - 1.2));
  S('dead', walker(xs(7), rowB, 90, 2.1, Infinity, T - 2));
  S('body 20 s', walker(xs(8), rowB, 90, 2.1, Infinity, T - 20));
  focus = new THREE.Vector3(0, 1, rowB / 2);
} else if (scene === 'perf') {
  // The phone budget case: `n` zombies (default 300) and 32 survivors on screen at once, all moving.
  const n = num('n', 300);
  for (let i = 0; i < n; i++) {
    const r = 45 * Math.sqrt(h01(i, 1));
    const a = h01(i, 2) * Math.PI * 2;
    const dieAt = i % 13 === 3 ? T - 1 - 8 * h01(i, 5) : Infinity;
    zScripts.push({ at: walker(Math.cos(a) * r, Math.sin(a) * r * 0.7, h01(i, 4) * 360, 0.5 + 2.6 * h01(i, 3), Infinity, dieAt), speed: 1.5, cold: i % 6 === 5 });
  }
  for (let i = 0; i < 32; i++) sScripts.push({ at: walker(-30 + i * 2, 20, 90, i % 2 ? 2.1 : 3.2) });
  focus = new THREE.Vector3(0, 1, 0);
} else if (scene === 'crowd') {
  // ~45 zombies milling over a road and its verges, a few coldies and bodies, two attacking a survivor.
  for (let i = 0; i < 46; i++) {
    const r = 16 * Math.sqrt(h01(i, 1));
    const a = h01(i, 2) * Math.PI * 2;
    const cx = Math.cos(a) * r;
    const cz = Math.sin(a) * r * 0.75;
    const v = 0.5 + h01(i, 3) * 0.9;
    const deg = h01(i, 4) * 360;
    const cold = i % 6 === 5;
    const dieAt = i % 11 === 3 ? T - 1 - 8 * h01(i, 5) : Infinity;
    zScripts.push({ at: walker(cx, cz, deg, v, Infinity, dieAt), speed: 1.5, cold });
  }
  for (let i = 0; i < 6; i++) zScripts.push({ at: walker(20 + i * 1.3, -6 + (i % 3) * 1.1, 70, 3.2), speed: 2.6, cold: false });
  sScripts.push({ label: 'survivor', at: walker(-12, 9, 0, 0) });
  zScripts.push({ at: walker(-13.1, 9.4, 90, 1.2, T - 1), speed: 1.5, cold: false });
  zScripts.push({ at: walker(-11, 8.5, 250, 1.2, T - 1.3), speed: 1.5, cold: false });
  sScripts.push({ label: 'survivor', at: walker(4, 13, 100, 3.2) });
  focus = new THREE.Vector3(2, 1, 2);
}

// ---------- renderer, camera, sensor filter (as the game does it) ----------
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.info.autoReset = false;
renderer.setPixelRatio(1);
const W = innerWidth;
const H = innerHeight;
renderer.setSize(W, H);
document.body.appendChild(renderer.domElement);
const scene3 = new THREE.Scene();
scene3.background = new THREE.Color(0.15, 0.05, 0);
scene3.add(new THREE.AmbientLight(0xffffff, 0.95));
const sun = new THREE.DirectionalLight(0xffffff, 0.5);
sun.position.set(-0.4, 1, 0.3);
scene3.add(sun);
const FOV = 10;
const camera = new THREE.PerspectiveCamera(FOV, W / H, 5, 20000);
const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene3, camera));
const pass = new ShaderPass(SensorShader);
composer.addPass(pass);
pass.uniforms.mode.value = mode === 'night' ? 1 : 0;
pass.uniforms.polarity.value = mode === 'black' ? 1 : 0;
(pass.uniforms.res.value as THREE.Vector2).set(W, H);

const view = new AgentsView({ models: q.get('models') !== '0' });
const usingModels = await view.ready;
scene3.add(view.group);
type WithImpact = { impact?: (x: number, z: number, r: number, time: number) => void };

let sim: Sim | null = null;
if (scene === 'sim') {
  const map = makeSampleTown();
  const r = createSim(map, { type: (q.get('type') ?? 'clear') as MissionType, difficulty: num('difficulty', 3), seed: num('seed', 7) });
  if (!r.ok) throw new Error(r.reason);
  sim = r.sim;
  const world = buildWorld(map, sim.mission.seed);
  scene3.add(world.group);
} else {
  // Lab ground: base ground, a grass verge (parks sit at 0.4 m) and a road band (roads at 1 m), as in the game.
  const strip = (w: number, d: number, y: number, z: number, sig: [number, number, number]) => {
    const g = new THREE.PlaneGeometry(w, d).rotateX(-Math.PI / 2).translate(0, y, z);
    const m = new THREE.MeshBasicMaterial({ color: new THREE.Color(...sig) });
    scene3.add(new THREE.Mesh(g, m));
  };
  strip(400, 400, 0, 0, SIG.ground);
  strip(90, 60, 0.4, 6, SIG.park);
  strip(90, 7, 1.0, 0, SIG.road);
  if (scene === 'crowd') strip(7, 60, 1.0, 6, SIG.road);
}

// ---------- run the agents from 0 to T ----------
const DT = 1 / 60;
const zs: LabZombie[] = zScripts.map((s, i) => ({ id: i * 7 + 3, ...s.at(0), speed: s.speed, cold: s.cold, home: null, goal: null }));
const ss: LabSurvivor[] = sScripts.map((s, i) => {
  const p = s.at(0);
  return { id: i, x: p.x, z: p.z, alive: p.alive, home: false, diedAt: p.diedAt };
});
const fake = { zombies: zs, survivors: ss, t: 0 };
const bot = sim ? new Bot(sim, SKILL.human) : null;
const pending = [...impacts];
const steps = Math.round(T / DT);
for (let k = 0; k <= steps; k++) {
  const t = k * DT;
  if (sim && bot) {
    if (k > 0) {
      bot.step(DT);
      sim.step(DT);
    }
    for (const e of sim.drainEvents()) if (e.type === 'impact') (view as WithImpact).impact?.(e.x, e.z, weaponById(e.weapon).radius, t);
    view.update(sim, t);
    continue;
  }
  fake.t = t;
  zScripts.forEach((s, i) => Object.assign(zs[i], s.at(t)));
  sScripts.forEach((s, i) => {
    const p = s.at(t);
    Object.assign(ss[i], { x: p.x, z: p.z, alive: p.alive, diedAt: p.diedAt });
  });
  while (pending.length && pending[0].t <= t) {
    const im = pending.shift()!;
    (view as WithImpact).impact?.(im.x, im.z, im.r, t);
  }
  view.update(fake as never, t);
}

if (sim) {
  // Look at the densest group of live zombies (or the first survivor if there are none).
  const live = sim.zombies.filter((z) => z.alive);
  let best = -1;
  for (const z of live) {
    const n = live.filter((o) => Math.hypot(o.x - z.x, o.z - z.z) < 25).length;
    if (n > best) {
      best = n;
      focus = new THREE.Vector3(z.x, 1, z.z);
    }
  }
  if (!live.length && sim.survivors[0]) focus = new THREE.Vector3(sim.survivors[0].x, 1, sim.survivors[0].z);
}

// ---------- camera: `tilt` off vertical, sized so a standing figure is `px` pixels tall ----------
// A fixed nominal figure (2.7 m drawn, the game's figure size before this rework), so before/after shots use the same camera.
const STAND_M = 2.7;
const apparent = STAND_M * Math.sin(tilt) + 0.55 * Math.cos(tilt);
if (q.has('fx')) focus.x = num('fx', 0);
if (q.has('fz')) focus.z = num('fz', 0);
const px = num('px', 32) * (H / 1080);
const dist = (apparent * H) / (2 * Math.tan(THREE.MathUtils.degToRad(FOV / 2)) * px);
camera.position.set(focus.x + Math.sin(az) * Math.sin(tilt) * dist, focus.y + Math.cos(tilt) * dist, focus.z + Math.cos(az) * Math.sin(tilt) * dist);
camera.lookAt(focus);
camera.updateProjectionMatrix();
renderer.info.reset();
composer.render();

// ---------- labels (plain text, under each labelled figure) ----------
const title = document.createElement('div');
title.className = 'lab-title';
title.textContent = `${scene} · ${usingModels ? "models" : "procedural"} · ${mode === 'night' ? 'night vision' : mode === 'black' ? 'thermal black-hot' : 'thermal white-hot'} · ${num('tilt', 35)}° off vertical · figure ≈${num('px', 32)} px @1080 · t=${T}s`;
document.body.appendChild(title);
if (showLabels) {
  const put = (text: string, x: number, z: number) => {
    const p = new THREE.Vector3(x, 1, z).project(camera);
    const d = document.createElement('div');
    d.className = 'lab-label';
    d.textContent = text;
    d.style.left = `${((p.x + 1) / 2) * W}px`;
    d.style.top = `${((1 - p.y) / 2) * H + 10}px`;
    document.body.appendChild(d);
  };
  zScripts.forEach((s) => s.label && put(s.label, s.at(T).x, s.at(T).z));
  sScripts.forEach((s) => s.label && scene === 'poses' && put(s.label, s.at(T).x, s.at(T).z));
}
const info: Record<string, unknown> = { drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, stats: view.stats };
if (scene === 'perf') {
  // Frame cost: the view's per-agent update (CPU) and a full render with the sensor pass, waited
  // for with a 1-pixel read so the GPU work is counted. Software GL in the cloud: compare runs, not devices.
  const gl = renderer.getContext();
  const px1 = new Uint8Array(4);
  const frames = num('frames', 60);
  let cpu = 0;
  const t0 = performance.now();
  for (let f = 1; f <= frames; f++) {
    const t = T + f * DT;
    fake.t = t;
    zScripts.forEach((s, i) => Object.assign(zs[i], s.at(Math.min(t, T))));
    const c0 = performance.now();
    view.update(fake as never, t);
    cpu += performance.now() - c0;
    composer.render();
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px1);
  }
  info.perf = { frames, msPerFrame: +((performance.now() - t0) / frames).toFixed(2), cpuUpdateMs: +(cpu / frames).toFixed(3) };
}
(window as unknown as { __lab: unknown }).__lab = { ready: true, info, view };
