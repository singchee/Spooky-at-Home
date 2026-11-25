import * as THREE from 'three';
import type { Sim } from '../sim/sim';
import type { V2 } from '../map/types';
import { bounds, pointInPolygon } from '../map/geom';
import { FIGURE_SCALE, FigureBatch, HEAD_TOP, StrobeSprites } from '../render/figureShader';
import { loadCharacterModels, type BakedClip, type BakedModel, type CharacterModels } from '../render/characterModels';
import { MODEL_DISPLAY_SCALE, ModelBatch, clipRows, leanPoint } from '../render/modelShader';
import {
  ANIM,
  COWER_RANGE,
  DUCK_TIME,
  REACT_TIME,
  deathHeat,
  gaitAmp,
  gaitRate,
  hash01,
  poseWeights,
  reactEnvelope,
  reactStrength,
  survivorAnimState,
  zombieAnimState,
} from './agentAnim';

/**
 * Draws zombies and survivors as animated low-poly people: one instanced draw call per kind, plus
 * one for the survivors' IR strobes (near-infrared-only sprites, invisible to thermal).
 * The CPU only writes a few numbers per agent each frame (position, heading, gait phase, pose
 * weights, hit reaction, heat); the vertex shader in src/render/figureShader.ts poses the skeleton.
 * Colours are sensor values (heat, visible, near-IR), not display colours.
 *
 * Everything here is visual only and read-only on the sim. Per-agent variety comes from hashing the
 * agent id; blasts reported by the game (impact()) make nearby zombies flinch, bodies fall away from
 * the blast that killed them, and survivors duck.
 */
const MAX_Z = 2500;
const MAX_S = 32;
/** Visible-light (night vision) brightness scale per kind. */
const VIS_WARM = 0.36;
const VIS_COLD = 0.34;
const VIS_SURVIVOR = 0.42;
/** Height of the figures' feet (matches the figure shader's uBase). */
const STROBE_BASE = 1.05;
const TAU = Math.PI * 2;
/** Pose weights ease toward their targets at this rate (1/s): a state change blends over ~0.2 s. */
const POSE_RATE = 9;
/** Blasts remembered for hit reactions and ducking. */
const IMPACTS = 16;

const FIELDS = ['phase', 'svx', 'svz', 'yaw', 'speed', 'px', 'pz', 'run', 'atk', 'crouch', 'amp', 'fall', 'reactT', 'reactDir', 'reactAmt', 'duckT', 'clip', 'ctime', 'pclip', 'ptime', 'pblend', 'dyaw', 'lod', 'batch'] as const;

/**
 * Render level of detail (spec 003, crowd nights only). A zombie is a full character model while it stands at least
 * LOD_ENTER_PX tall on screen (and stays one down to LOD_STAY_PX, so one at the threshold doesn't flip every frame);
 * everyone else is the cheap procedural figure. Thresholds are screen pixels, so they hold for every gun's lens.
 */
export const LOD_ENTER_PX = 28;
export const LOD_STAY_PX = 22;
/** On-screen height used for the test: the model's standing height (both figures are within 5% of it). */
export const LOD_HEIGHT_M = 1.75 * MODEL_DISPLAY_SCALE;
/** Bodies the crowd cap removes sink out of sight over this long (Feel S4: a fade of 1 s or more, never a vanish). */
export const BODY_SINK_S = 1.2;
/** Over the body cap (a burst), the oldest sinking bodies finish within this long instead (never cut off half-sunk). */
export const BODY_SINK_FAST_S = 0.35;
/** How far a body sinks (metres): well under the ground and the roads. */
export const BODY_SINK_M = 1.6;

/** What the camera shows, for level of detail: the camera (with its projection up to date) and the canvas height in px. */
export interface LodView {
  camera: THREE.Camera & { projectionMatrix: THREE.Matrix4 };
  height: number;
}
type Field = (typeof FIELDS)[number];

/** Per-agent animation memory that the sim doesn't keep: smoothed velocity, heading, gait phase and pose. */
class Track {
  f = Object.fromEntries(FIELDS.map((k) => [k, new Float32Array(0)])) as Record<Field, Float32Array>;
  seen = new Uint8Array(0);
  /** 1 once the fall direction of a dead agent is chosen, 2 when a blast chose it. */
  fell = new Uint8Array(0);

  ensure(n: number): void {
    if (n <= this.seen.length) return;
    const cap = Math.max(n, this.seen.length * 2, 64);
    const grow = <T extends Float32Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as { new (n: number): T })(cap);
      b.set(a);
      return b;
    };
    for (const k of FIELDS) this.f[k] = grow(this.f[k]);
    this.seen = grow(this.seen);
    this.fell = grow(this.fell);
  }
}

interface Blast {
  x: number;
  z: number;
  r: number;
  t: number;
}

/** Wraps an angle to [-pi, pi]. */
const wrap = (a: number) => a - TAU * Math.round(a / TAU);

export class AgentsView {
  readonly group = new THREE.Group();
  private zombies = new FigureBatch('zombie', MAX_Z);
  private survivors = new FigureBatch('survivor', MAX_S);
  private strobes = new StrobeSprites(MAX_S);
  private zt = new Track();
  private st = new Track();
  private lastTime = -1;
  private blasts: Blast[] = [];
  private pending: Blast[] = [];
  /**
   * The draw list (spec 003): every living zombie first, then bodies newest death first, so a body never takes
   * a living zombie's place. `aliveIdx` holds the indices alive at the last frame (index order), `deadOrder`
   * the indices in the order they were seen to die (oldest first), and `drawn` this frame's list.
   */
  private aliveIdx: number[] = [];
  private deadOrder: number[] = [];
  private scanned = 0;
  private drawn: number[] = [];
  /** Crowd nights: bodies resting from deadOrder[restFrom] on; older ones sink out over BODY_SINK_S, then go. */
  private restFrom = 0;
  private sinking: { i: number; p: number; fast: boolean }[] = [];
  private sinkClock = -1;
  /** Level-of-detail candidates (indices and keys), reused every frame. */
  private candI = new Int32Array(0);
  private candK = new Float32Array(0);
  private sinkOf = new Map<number, number>();
  /** Crowd nights (spec 003): the model cap and the body cap; null for every other mission (single batch). */
  private readonly lod: { models: number; bodies: number; total?: number } | null;
  /** The character-model batches once the models have loaded (null: the procedural figures draw). */
  private zm: ModelBatch | null = null;
  private sm: ModelBatch | null = null;
  private disposed = false;
  /** Resolves true when the character models are drawing, false when the procedural figures stay. */
  readonly ready: Promise<boolean>;

  /**
   * `models: false` keeps the procedural figures (the fallback when the models can't load). `lod` (crowd nights)
   * keeps both zombie batches: up to `models` full models near the aim point, figures for the rest, and at most
   * `bodies` bodies drawn. `modelSet` hands in baked models directly (tests).
   */
  constructor(opts: { models?: boolean; lod?: { models: number; bodies: number; total?: number }; modelSet?: CharacterModels } = {}) {
    this.lod = opts.lod ? { ...opts.lod } : null;
    // Same size on screen either way (pillar 3): crowd figures stand as tall as the models.
    if (this.lod) this.zombies.material.uniforms.uScale.value = LOD_HEIGHT_M / HEAD_TOP;
    this.group.add(this.zombies.mesh, this.survivors.mesh, this.strobes.mesh);
    if (opts.modelSet) this.ready = Promise.resolve(this.useModels(opts.modelSet));
    else this.ready = opts.models === false ? Promise.resolve(false) : loadCharacterModels().then((m) => this.useModels(m));
  }

  /** Swap the procedural figures for the character models (same group slots, same draw-call count; with LOD, one more). */
  private useModels(m: CharacterModels | null): boolean {
    if (!m || this.disposed) return false;
    this.zm = new ModelBatch(m.zombie, 'zombie', this.lod ? Math.min(MAX_Z, this.lod.models) : MAX_Z);
    this.sm = new ModelBatch(m.survivor, 'survivor', MAX_S);
    this.group.remove(this.survivors.mesh);
    this.group.add(this.zm.mesh, this.sm.mesh);
    this.survivors.dispose();
    if (!this.lod) {
      this.group.remove(this.zombies.mesh);
      this.zombies.dispose();
    } else {
      // Same mean heat either way (pillar 3): scale the figure's heat weights to the model's area-weighted mean.
      const f = meanHeatWeight(this.zombies.mesh.geometry, 'aLimbT');
      const mw = meanHeatWeight(m.zombie.geometry, 'aHeatW');
      if (f > 0 && mw > 0) this.zombies.material.uniforms.uHeatW.value = mw / f;
    }
    // Clip choices are made fresh for every agent.
    this.zt.f.clip.fill(-1);
    this.st.f.clip.fill(-1);
    return true;
  }

  private walls: BuildingIndex | null = null;
  private wallsOf: unknown = null;

  /** Building footprints of the sim's map (indexed once per map); null when the sim has no map (tests). */
  private buildings(sim: Sim): BuildingIndex | null {
    const map = (sim as Partial<Sim>).map;
    if (!map?.buildings) return null;
    if (this.wallsOf !== map) {
      this.walls = new BuildingIndex(map.buildings.map((b) => b.pts));
      this.wallsOf = map;
    }
    return this.walls;
  }

  /**
   * A fall direction (world radians about +y from +z) whose lying body stays out of every building:
   * the preferred one if its middle and head end are clear, else the opposite, else either side.
   * The sim keeps agents outside buildings; this keeps the body drawn there too.
   */
  private clearFall(sim: Sim, x: number, z: number, dir: number): number {
    const walls = this.buildings(sim);
    if (!walls) return dir;
    const len = this.zm ? 1.75 * MODEL_DISPLAY_SCALE : 2.3 * FIGURE_SCALE;
    for (const d of [dir, dir + Math.PI, dir + Math.PI / 2, dir - Math.PI / 2]) {
      const sx = Math.sin(d);
      const sz = Math.cos(d);
      if (!walls.inside(x + sx * len * 0.5, z + sz * len * 0.5) && !walls.inside(x + sx * len, z + sz * len)) return d;
    }
    return dir;
  }

  /** True when the character models are drawing. */
  get usingModels(): boolean {
    return this.zm !== null;
  }

  /** A shell landed at (x, z) with lethal radius r, at game-clock time `time`. Visual only. */
  impact(x: number, z: number, r: number, time: number): void {
    const b = { x, z, r, t: time };
    this.pending.push(b);
    this.blasts.push(b);
    if (this.blasts.length > IMPACTS) this.blasts.shift();
  }

  /** `view`: the camera (level of detail; figures lean back on steep views and the strobe follows the head). */
  update(sim: Sim, time: number, view?: LodView): void {
    // Animation timing follows the game clock, so it pauses with the game and is frame-rate independent.
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const ease = Math.min(1, dt * 5);
    const pose = 1 - Math.exp(-dt * POSE_RATE);

    const zs = sim.zombies;
    this.zt.ensure(zs.length);
    const zf = this.zt.f;
    const list = this.drawList(sim, time);
    this.applyBlasts(sim);
    const lod = this.lod !== null && this.zm !== null;
    if (lod) this.chooseModels(sim, list, view);

    const { a, b, c, d } = this.zombies;
    let k = 0;
    let km = 0;
    for (const i of list) {
      const z = zs[i];
      const seed = hash01(z.id);
      if (!this.zt.seen[i]) {
        this.zt.seen[i] = 1;
        zf.phase[i] = seed * TAU;
        zf.yaw[i] = seed * TAU;
        zf.svx[i] = z.vx;
        zf.svz[i] = z.vz;
        zf.reactT[i] = -99;
      }
      const state = zombieAnimState(z);
      const v = Math.hypot(z.vx, z.vz);
      if (z.alive) {
        // Smooth the heading: the sim can change direction every step, a body turns over ~0.2 s.
        zf.svx[i] += (z.vx - zf.svx[i]) * ease;
        zf.svz[i] += (z.vz - zf.svz[i]) * ease;
        if (Math.hypot(zf.svx[i], zf.svz[i]) > 0.05) zf.yaw[i] = Math.atan2(zf.svx[i], zf.svz[i]);
        // Each zombie keeps its own cadence (±12%), so a crowd never marches in step.
        const cadence = 0.88 + 0.24 * hash01(z.id + 101);
        zf.phase[i] = (zf.phase[i] + dt * TAU * gaitRate(state, v) * cadence) % (TAU * 64);
      } else if (!this.zt.fell[i]) {
        // No blast to fall away from (or it was missed): mostly forward, sometimes back, a little to the side.
        this.zt.fell[i] = 1;
        // Models fall the way their death clip falls; the simple figures mostly forward, sometimes back.
        const rel = this.zm ? this.zm.model.deathDir : (hash01(z.id + 202) < 0.65 ? 0 : Math.PI) + (hash01(z.id + 303) - 0.5) * 0.9;
        zf.fall[i] = wrap(this.clearFall(sim, z.x, z.z, zf.yaw[i] + rel) - zf.yaw[i]);
      }
      const w = poseWeights(state);
      zf.run[i] += (w.run - zf.run[i]) * pose;
      zf.atk[i] += (w.attack - zf.atk[i]) * pose;
      zf.amp[i] += (gaitAmp(state, v) - zf.amp[i]) * pose;
      const deadFor = z.alive ? -1 : Math.max(0, sim.t - z.diedAt);
      // Dying eases from live heat over DEATH_EASE (Feel M3: no sharp darkening when a round kills dozens).
      const [core, limb] = deathHeat(z.alive, z.cold, deadFor);
      const react = z.alive ? reactEnvelope(time - zf.reactT[i]) * zf.reactAmt[i] : 0;
      const sink = z.alive ? 0 : (this.sinkOf.get(i) ?? 0);
      if (this.zm && (!lod || zf.lod[i] > 0)) {
        // A zombie that comes over from the figure batch picks its clip fresh.
        if (lod && zf.batch[i] !== 2) zf.clip[i] = -1;
        zf.batch[i] = 2;
        const name = !z.alive ? 'death' : state === ANIM.attack ? 'attack' : state === ANIM.run ? (seed < 0.5 ? 'run' : 'runArms') : state === ANIM.lunge ? 'runArms' : 'walk';
        const rate = name === 'attack' ? 0.85 + 0.3 * hash01(z.id + 17) : v;
        const hit = z.alive && zf.reactAmt[i] > 0 ? time - zf.reactT[i] : -1;
        this.writeModel(this.zm, this.zt, i, km, z.x, z.z, seed, name, rate, deadFor, hit, zf.reactAmt[i], dt, core, limb, z.cold ? VIS_COLD : VIS_WARM, sink);
        km++;
        continue;
      }
      zf.batch[i] = 1;
      const o = k * 4;
      a[o] = z.x;
      a[o + 1] = z.z;
      a[o + 2] = zf.yaw[i];
      a[o + 3] = zf.phase[i];
      b[o] = deadFor;
      b[o + 1] = zf.amp[i];
      b[o + 2] = seed;
      b[o + 3] = zf.fall[i];
      c[o] = core;
      c[o + 1] = limb;
      c[o + 2] = z.cold ? VIS_COLD : VIS_WARM;
      c[o + 3] = z.alive ? react : sink; // the shader reads the reaction on the living and the sink on bodies
      d[o] = zf.run[i];
      d[o + 1] = zf.atk[i];
      d[o + 2] = 0;
      d[o + 3] = zf.reactDir[i];
      k++;
    }
    if (this.zm) this.zm.commit(km);
    if (!this.zm || lod) {
      this.zombies.commit(k);
      this.zombies.material.uniforms.uTime.value = time;
    }

    const ss = sim.survivors;
    const st = this.st;
    st.ensure(ss.length);
    const sf = st.f;
    const sb = this.survivors;
    let j = 0;
    let n = 0;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (s.home || j >= MAX_S) continue;
      const seed = hash01(s.id + 7919);
      if (!st.seen[i]) {
        st.seen[i] = 1;
        sf.px[i] = s.x;
        sf.pz[i] = s.z;
        sf.phase[i] = seed * TAU;
        sf.yaw[i] = seed * TAU;
        sf.duckT[i] = -99;
      }
      // Survivors have no velocity in the sim: measure it from how far they moved this frame.
      if (dt > 0) {
        const dx = s.x - sf.px[i];
        const dz = s.z - sf.pz[i];
        const inst = Math.hypot(dx, dz) / dt;
        sf.speed[i] += (Math.min(6, inst) - sf.speed[i]) * Math.min(1, dt * 6);
        if (inst > 0.2) {
          sf.svx[i] += (dx / dt - sf.svx[i]) * ease;
          sf.svz[i] += (dz / dt - sf.svz[i]) * ease;
          sf.yaw[i] = Math.atan2(sf.svx[i], sf.svz[i]);
        }
        sf.px[i] = s.x;
        sf.pz[i] = s.z;
      }
      // Standing still with a zombie close by, or just after a blast nearby: crouch, hands over head.
      let threatened = time - sf.duckT[i] < DUCK_TIME;
      if (s.alive && !threatened && sf.speed[i] < 0.3) {
        for (const z of zs) {
          if (z.alive && Math.abs(z.x - s.x) < COWER_RANGE && Math.abs(z.z - s.z) < COWER_RANGE && Math.hypot(z.x - s.x, z.z - s.z) < COWER_RANGE) {
            threatened = true;
            break;
          }
        }
      }
      const state = survivorAnimState(s.alive, sf.speed[i], threatened);
      if (s.alive) sf.phase[i] = (sf.phase[i] + dt * TAU * gaitRate(state, sf.speed[i])) % (TAU * 64);
      else if (!st.fell[i]) {
        st.fell[i] = 1;
        const rel = this.sm ? this.sm.model.deathDir : (hash01(s.id + 404) < 0.5 ? 0 : Math.PI) + (hash01(s.id + 505) - 0.5) * 0.9;
        sf.fall[i] = wrap(this.clearFall(sim, s.x, s.z, sf.yaw[i] + rel) - sf.yaw[i]);
      }
      const w = poseWeights(state);
      sf.run[i] += (w.run - sf.run[i]) * pose;
      sf.crouch[i] += (w.crouch - sf.crouch[i]) * pose;
      sf.amp[i] += (gaitAmp(state, sf.speed[i]) - sf.amp[i]) * pose;
      const deadFor = s.alive ? -1 : Math.max(0, sim.t - s.diedAt);
      const [core, limb] = deathHeat(s.alive, false, deadFor, true);
      if (this.sm) {
        const name = !s.alive ? 'death' : state === ANIM.run ? 'run' : state === ANIM.walk ? 'walk' : state === ANIM.crouch ? 'crouch' : 'idle';
        this.writeModel(this.sm, st, i, j, s.x, s.z, seed, name, sf.speed[i], deadFor, -1, 0, dt, core, limb, VIS_SURVIVOR);
        j++;
        if (s.alive) {
          // The strobe sits on the baked top of the head, leaning with the body (modelShader.ts).
          const raw = this.modelPoint(this.sm, st, i, 0, seed);
          const cp = view?.camera.position;
          const hp = cp ? leanPoint(raw, cp.x - s.x, cp.y - this.sm.material.uniforms.uBase.value, cp.z - s.z) : raw;
          const q = n * 3;
          this.strobes.pos[q] = s.x + hp[0];
          this.strobes.pos[q + 1] = STROBE_BASE + hp[1] + 0.05; // just above the top of the head, as the simple figures do
          this.strobes.pos[q + 2] = s.z + hp[2];
          n++;
        }
        continue;
      }
      const o = j * 4;
      sb.a[o] = s.x;
      sb.a[o + 1] = s.z;
      sb.a[o + 2] = sf.yaw[i];
      sb.a[o + 3] = sf.phase[i];
      sb.b[o] = deadFor;
      sb.b[o + 1] = sf.amp[i];
      sb.b[o + 2] = seed;
      sb.b[o + 3] = sf.fall[i];
      sb.c[o] = core;
      sb.c[o + 1] = limb;
      sb.c[o + 2] = VIS_SURVIVOR;
      sb.c[o + 3] = 0;
      sb.d[o] = sf.run[i];
      sb.d[o + 1] = 0;
      sb.d[o + 2] = sf.crouch[i];
      sb.d[o + 3] = 0;
      j++;
      // A live survivor's strobe sits on top of the head (lower and further forward when crouching
      // or running); a dead one's is gone.
      if (s.alive) {
        const [up, fwd] = strobeOffset(sf.crouch[i], sf.run[i]);
        const q = n * 3;
        const raw: [number, number, number] = [Math.sin(sf.yaw[i]) * fwd * FIGURE_SCALE, up * FIGURE_SCALE, Math.cos(sf.yaw[i]) * fwd * FIGURE_SCALE];
        const cp = view?.camera.position;
        const hp = cp ? leanPoint(raw, cp.x - s.x, cp.y - STROBE_BASE, cp.z - s.z) : raw; // leans with the head (lean.ts)
        this.strobes.pos[q] = s.x + hp[0];
        this.strobes.pos[q + 1] = STROBE_BASE + hp[1];
        this.strobes.pos[q + 2] = s.z + hp[2];
        n++;
      }
    }
    if (this.sm) this.sm.commit(j);
    else {
      sb.commit(j);
      sb.material.uniforms.uTime.value = time;
    }
    this.strobes.commit(n);
    // One 0.3 s blink a second: slow, and only a small dot, so never a flash hazard.
    this.strobes.material.uniforms.uBlink.value = time % 1 < 0.3 ? 1 : 0;
  }

  /**
   * Character models: pick the clip for this agent's state, advance it (locomotion clips at the
   * agent's ground speed over the clip's stride), cross-fade from the previous clip over 0.25 s, and
   * blend a hit reaction on top while one is playing. Writes instance `k` of `batch`.
   */
  private writeModel(
    batch: ModelBatch, tr: Track, i: number, k: number, x: number, z: number, seed: number, name: string, speed: number,
    deadFor: number, hitAge: number, hitAmt: number, dt: number, core: number, limb: number, vis: number, sink = 0,
  ): void {
    const f = tr.f;
    const model = batch.model;
    const names = batch.clipNames;
    const want = model.clips[name] ?? model.clips[name === 'crouch' ? 'idle' : 'walk'] ?? model.clips[names[0]];
    const idx = names.indexOf(want.name);
    if (f.clip[i] !== idx) {
      if (f.clip[i] >= 0) {
        f.pclip[i] = f.clip[i];
        f.ptime[i] = f.ctime[i];
        f.pblend[i] = 1;
      } else f.pblend[i] = 0;
      if (want.name === 'death') {
        // Fall away from the blast that killed it: turn so the clip's fall direction points that way.
        f.dyaw[i] = tr.fell[i] ? f.yaw[i] + f.fall[i] - model.deathDir : f.yaw[i];
      }
      f.clip[i] = idx;
      f.ctime[i] = want.loop ? seed * want.duration : 0;
    }
    if (want.name === 'death') {
      f.ctime[i] = deadFor;
      f.yaw[i] += wrap(f.dyaw[i] - f.yaw[i]) * Math.min(1, dt * 14);
    } else {
      const rate = want.stride > 0 ? Math.min(1.8, Math.max(0.45, speed / want.stride)) : name === 'attack' ? speed : 1;
      f.ctime[i] += dt * rate * (0.92 + 0.16 * hash01(Math.floor(seed * 1e6) + 3));
    }
    f.ptime[i] += dt;
    f.pblend[i] = Math.max(0, f.pblend[i] - dt / (want.name === 'death' ? 0.15 : 0.25));
    let bClip: BakedClip = model.clips[names[f.pclip[i]]] ?? want;
    let bTime = f.ptime[i];
    let bW = f.pblend[i];
    const hit = model.clips.hit;
    if (hit && hitAge >= 0 && hitAge < hit.duration) {
      bClip = hit;
      bTime = hitAge;
      bW = Math.min(1, hitAmt * 1.3) * Math.min(1, hitAge / 0.05) * (1 - Math.max(0, (hitAge - hit.duration * 0.6) / (hit.duration * 0.4)));
    }
    const [a0, a1, af] = clipRows(want, f.ctime[i]);
    const [b0, b1, bf] = clipRows(bClip, bTime);
    const o = k * 4;
    batch.a[o] = x;
    batch.a[o + 1] = z;
    batch.a[o + 2] = f.yaw[i];
    batch.a[o + 3] = seed;
    batch.b[o] = a0;
    batch.b[o + 1] = a1;
    batch.b[o + 2] = af;
    batch.b[o + 3] = bW;
    batch.c[o] = b0;
    batch.c[o + 1] = b1;
    batch.c[o + 2] = bf;
    batch.c[o + 3] = deadFor >= 0 ? 1 : 0;
    batch.d[o] = core;
    batch.d[o + 1] = limb;
    batch.d[o + 2] = vis;
    batch.d[o + 3] = sink;
  }

  /** A tracked point of a model (0 head top, 1 chest) for agent i as last written, rotated and scaled as the shader does. */
  private modelPoint(batch: ModelBatch, tr: Track, i: number, which: number, seed: number): [number, number, number] {
    const model: BakedModel = batch.model;
    const names = batch.clipNames;
    const clip = model.clips[names[tr.f.clip[i]]];
    if (!clip) return [0, 1.8, 0];
    const [row0, row1, fr] = clipRows(clip, tr.f.ctime[i]);
    const P = model.points;
    const at = (r: number, c: number) => P[r * 6 + which * 3 + c];
    const lx = at(row0, 0) + (at(row1, 0) - at(row0, 0)) * fr;
    const ly = at(row0, 1) + (at(row1, 1) - at(row0, 1)) * fr;
    const lz = at(row0, 2) + (at(row1, 2) - at(row0, 2)) * fr;
    // Survivors' build in the shader: height 0.95-1.05 (r3), width 0.97-1.03 (r1).
    const r3 = (seed * 29.13 + 0.07) % 1;
    const s1 = (seed * 7.31 + 0.13) % 1;
    const h = (0.95 + 0.1 * r3) * MODEL_DISPLAY_SCALE;
    const w = (0.97 + 0.06 * s1) * MODEL_DISPLAY_SCALE;
    const yaw = tr.f.yaw[i];
    const c = Math.cos(yaw);
    const s = Math.sin(yaw);
    return [(lx * c + lz * s) * w, ly * h, (-lx * s + lz * c) * w];
  }

  /**
   * Living zombies first (all of them, up to MAX_Z), then bodies newest death first while there is room.
   * Read-only on the sim; costs O(living + new entries) a frame, never O(every body ever).
   */
  private drawList(sim: Sim, time = 0): number[] {
    const zs = sim.zombies;
    if (zs.length < this.scanned) {
      this.aliveIdx = [];
      this.deadOrder = [];
      this.scanned = 0;
      this.restFrom = 0;
      this.sinking = [];
      this.sinkClock = -1;
    }
    const alive = this.aliveIdx;
    let w = 0;
    for (let r = 0; r < alive.length; r++) {
      const i = alive[r];
      if (zs[i].alive) alive[w++] = i;
      else this.deadOrder.push(i);
    }
    alive.length = w;
    for (let i = this.scanned; i < zs.length; i++) (zs[i].alive ? alive : this.deadOrder).push(i);
    this.scanned = zs.length;
    const out = this.drawn;
    out.length = 0;
    for (let r = 0; r < alive.length && out.length < MAX_Z; r++) out.push(alive[r]);
    const dead = this.deadOrder;
    if (!this.lod) {
      for (let r = dead.length - 1; r >= 0 && out.length < MAX_Z; r--) out.push(dead[r]);
      return out;
    }
    // Crowd nights: `bodies` bodies, sinking ones included. Resting bodies leave room for the ones sinking out;
    // past it the oldest start to sink, and go once under. A burst can push the count over the body cap for a
    // moment: then the oldest sinking bodies speed up (BODY_SINK_FAST_S) rather than vanish half-sunk. The dead
    // came from the living, so living + bodies stays inside the figure total; only past that total is one cut.
    const cap = this.lod.bodies;
    const dt = this.sinkClock < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.sinkClock));
    this.sinkClock = time;
    const restMax = Math.max(0, cap - Math.max(60, Math.ceil(cap * 0.3))); // room to sink ~100 bodies a second
    while (dead.length - this.restFrom > restMax) this.sinking.push({ i: dead[this.restFrom++], p: 0, fast: false });
    const sink = this.sinking;
    const resting = dead.length - this.restFrom;
    let over = resting + sink.length - cap;
    for (let r = 0; r < sink.length && over > 0; r++, over--) sink[r].fast = true; // oldest first
    for (const b of sink) b.p = Math.min(1, b.p + dt / (b.fast ? BODY_SINK_FAST_S : BODY_SINK_S));
    const room = this.lod.total !== undefined ? Math.max(cap, this.lod.total - alive.length) : cap;
    let drop = 0;
    while (drop < sink.length && (sink[drop].p >= 1 || resting + sink.length - drop > room)) drop++;
    if (drop) sink.splice(0, drop);
    this.sinkOf.clear();
    for (let r = dead.length - 1; r >= this.restFrom && out.length < MAX_Z; r--) out.push(dead[r]);
    for (let r = sink.length - 1; r >= 0 && out.length < MAX_Z; r--) {
      out.push(sink[r].i);
      this.sinkOf.set(sink[r].i, sink[r].p);
    }
    return out;
  }

  /**
   * Level of detail: zombies tall enough on screen (with hysteresis) and inside the picture are model candidates;
   * the nearest the aim point win, up to the model cap. Without a view (tests, first frame) everyone is a figure.
   */
  private chooseModels(sim: Sim, list: number[], view?: LodView): void {
    const zf = this.zt.f;
    const zs = sim.zombies;
    if (this.candI.length < list.length) {
      this.candI = new Int32Array(Math.max(list.length, this.candI.length * 2, 256));
      this.candK = new Float32Array(this.candI.length);
    }
    const ci = this.candI;
    const ck = this.candK;
    let nc = 0;
    if (view && view.height > 0) {
      const cam = view.camera;
      cam.updateMatrixWorld();
      const e = cam.matrixWorld.elements;
      const p = cam.projectionMatrix.elements;
      const fy = p[5] * view.height * 0.5;
      for (const i of list) {
        const z = zs[i];
        const vx = z.x - e[12];
        const vy = 1 - e[13];
        const vz = z.z - e[14];
        const depth = -(vx * e[8] + vy * e[9] + vz * e[10]);
        if (depth <= 1) continue;
        const px = (LOD_HEIGHT_M * fy) / depth;
        if (px < (zf.lod[i] > 0 ? LOD_STAY_PX : LOD_ENTER_PX)) continue;
        const nx = ((vx * e[0] + vy * e[1] + vz * e[2]) * p[0]) / depth;
        const ny = ((vx * e[4] + vy * e[5] + vz * e[6]) * p[5]) / depth;
        if (Math.abs(nx) > 1.15 || Math.abs(ny) > 1.15) continue;
        ci[nc] = i;
        ck[nc] = nx * nx + ny * ny;
        nc++;
      }
    }
    for (const i of list) zf.lod[i] = 0;
    const n = Math.min(nc, this.lod!.models, this.zm!.capacity);
    if (nc <= n) {
      for (let r = 0; r < nc; r++) zf.lod[ci[r]] = 1;
      return;
    }
    // Only the nearest n matter: select them in place (quickselect on the key, ties by index), no sort, no objects.
    const less = (a: number, b: number) => ck[a] < ck[b] || (ck[a] === ck[b] && ci[a] < ci[b]);
    const swap = (a: number, b: number) => {
      const ti = ci[a];
      ci[a] = ci[b];
      ci[b] = ti;
      const tk = ck[a];
      ck[a] = ck[b];
      ck[b] = tk;
    };
    let lo = 0;
    let hi = nc - 1;
    while (lo < hi) {
      swap((lo + hi) >> 1, hi);
      let store = lo;
      for (let r = lo; r < hi; r++) if (less(r, hi)) swap(r, store++);
      swap(store, hi);
      if (store === n) break;
      if (store < n) lo = store + 1;
      else hi = store - 1;
    }
    for (let r = 0; r < n; r++) zf.lod[ci[r]] = 1;
  }

  /**
   * New blasts since the last frame: zombies near one flinch away from it (strongest wins), bodies
   * it killed fall away from it, and survivors near it duck.
   */
  private applyBlasts(sim: Sim): void {
    if (!this.pending.length) return;
    const zs = sim.zombies;
    const zf = this.zt.f;
    for (const bl of this.pending) {
      const reach = 3.5 * bl.r;
      for (const i of this.drawn) {
        const z = zs[i];
        const dx = z.x - bl.x;
        const dz = z.z - bl.z;
        if (Math.abs(dx) > reach || Math.abs(dz) > reach) continue;
        const dist = Math.hypot(dx, dz);
        const away = Math.atan2(dx, dz);
        if (!z.alive) {
          // Killed by this blast (the game reports it the frame it lands): thrown away from it.
          if (!this.zt.fell[i] && dist < 1.6 * bl.r) {
            this.zt.fell[i] = 2;
            zf.fall[i] = wrap(this.clearFall(sim, z.x, z.z, away) - zf.yaw[i]);
          }
          continue;
        }
        const s = reactStrength(dist, bl.r);
        if (s <= 0) continue;
        const left = reactEnvelope(bl.t - zf.reactT[i]) * zf.reactAmt[i];
        if (s > left || bl.t - zf.reactT[i] > REACT_TIME * 0.5) {
          zf.reactT[i] = bl.t;
          zf.reactAmt[i] = s;
          zf.reactDir[i] = wrap(away - zf.yaw[i]);
        }
      }
      const sf = this.st.f;
      this.st.ensure(sim.survivors.length);
      sim.survivors.forEach((s, i) => {
        if (s.alive && Math.hypot(s.x - bl.x, s.z - bl.z) < 4 * bl.r + 6) sf.duckT[i] = bl.t;
        else if (!s.alive && !this.st.fell[i] && Math.hypot(s.x - bl.x, s.z - bl.z) < 1.6 * bl.r) {
          this.st.fell[i] = 2;
          sf.fall[i] = wrap(this.clearFall(sim, s.x, s.z, Math.atan2(s.x - bl.x, s.z - bl.z)) - sf.yaw[i]);
        }
      });
    }
    this.pending.length = 0;
  }

  /** Level-of-detail parity (playtest): the figure's and the zombie model's area-weighted mean heat weight. */
  heatWeights(): { figure: number; model: number | null } {
    const scale = this.zombies.material.uniforms.uHeatW.value as number;
    return { figure: meanHeatWeight(this.zombies.mesh.geometry, 'aLimbT') * scale, model: this.zm ? meanHeatWeight(this.zm.model.geometry, 'aHeatW') : null };
  }

  /** For tests and budgets: instances drawn per kind, and draw objects (one per kind). */
  get stats() {
    return {
      objects: this.group.children.length,
      zombies: this.zm ? this.zm.count : this.zombies.count,
      survivors: this.sm ? this.sm.count : this.survivors.count,
      strobes: this.strobes.count,
      models: this.zm !== null,
      /** With level of detail: instances in each zombie batch. */
      modelZombies: this.zm ? this.zm.count : 0,
      figureZombies: this.zm && !this.lod ? 0 : this.zombies.count,
      drawnZombies: this.drawn.length,
    };
  }

  dispose(): void {
    this.disposed = true;
    this.zombies.dispose();
    this.survivors.dispose();
    this.strobes.dispose();
    // The baked models are shared and cached for the page's lifetime; only the batches go.
    this.zm?.dispose();
    this.sm?.dispose();
  }
}

/**
 * Area-weighted mean of a per-vertex heat weight (0 core ... 1 hands and feet) over a geometry's triangles: the
 * figure's `aLimbT` and the model's `aHeatW` must match closely, so a zombie reads equally hot as either (spec 003 LOD).
 */
export function meanHeatWeight(geo: THREE.BufferGeometry, attr: string): number {
  const pos = geo.attributes.position;
  const w = geo.getAttribute(attr);
  const idx = geo.index;
  const tris = idx ? idx.count / 3 : pos.count / 3;
  const v = (k: number) => (idx ? idx.getX(k) : k);
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let sum = 0;
  let area = 0;
  for (let t = 0; t < tris; t++) {
    const i0 = v(t * 3);
    const i1 = v(t * 3 + 1);
    const i2 = v(t * 3 + 2);
    a.fromBufferAttribute(pos, i0);
    b.fromBufferAttribute(pos, i1);
    c.fromBufferAttribute(pos, i2);
    const ar = b.sub(a).cross(c.sub(a)).length() / 2;
    sum += ar * ((w.getX(i0) + w.getX(i1) + w.getX(i2)) / 3);
    area += ar;
  }
  return area > 0 ? sum / area : 0;
}

/**
 * Where the top of a survivor's head is (metres up, metres forward, before FIGURE_SCALE), given
 * how much it is crouching and running; a close fit to what the shader does, so the strobe stays on the head.
 */
export function strobeOffset(crouch: number, run: number): [number, number] {
  const lean = 0.06 + 0.3 * run + 0.62 * crouch;
  const drop = 0.47 * crouch;
  const above = HEAD_TOP + 0.05 - 1.02; // head top above the waist (the chest's pivot)
  return [1.02 - drop + above * Math.cos(lean), above * Math.sin(lean)];
}

/** Building footprints in a coarse hash, for "would this point be inside a building?" (exact polygons). */
export class BuildingIndex {
  private cells = new Map<number, number[]>();
  private static readonly CELL = 25;

  constructor(private polys: V2[][]) {
    const C = BuildingIndex.CELL;
    polys.forEach((pts, k) => {
      if (pts.length < 3) return;
      const b = bounds(pts);
      for (let j = Math.floor(b.minZ / C); j <= Math.floor(b.maxZ / C); j++)
        for (let i = Math.floor(b.minX / C); i <= Math.floor(b.maxX / C); i++) {
          const key = i * 73856093 + j;
          const list = this.cells.get(key);
          if (list) list.push(k);
          else this.cells.set(key, [k]);
        }
    });
  }

  inside(x: number, z: number): boolean {
    const C = BuildingIndex.CELL;
    const list = this.cells.get(Math.floor(x / C) * 73856093 + Math.floor(z / C));
    return !!list && list.some((k) => pointInPolygon({ x, z }, this.polys[k]));
  }
}
