import * as THREE from 'three';
import type { Sim } from '../sim/sim';
import { FIGURE_SCALE, FigureBatch, STROBE_Y, StrobeSprites } from '../render/figureShader';
import { ANIM, bodyHeat, gaitAmp, gaitRate, hash01, survivorAnimState, zombieAnimState } from './agentAnim';

/**
 * Draws zombies and survivors as animated low-poly figures: one instanced draw call per kind, plus
 * one for the survivors' IR strobes (near-infrared-only sprites, invisible to thermal).
 * The CPU only writes a few numbers per agent each frame (position, heading, gait phase, state,
 * heat); the vertex shader in src/render/figureShader.ts does the animation.
 * Colours are sensor values (heat, visible, near-IR), not display colours.
 */
const MAX_Z = 2500;
const MAX_S = 32;
const VIS_WARM = 0.36;
const VIS_COLD = 0.34;
const VIS_SURVIVOR = 0.42;
/** Height of the figures' feet (matches the figure shader's uBase). */
const STROBE_BASE = 1.05;
const TAU = Math.PI * 2;

/** Per-agent animation memory that the sim doesn't keep: smoothed velocity, heading and gait phase. */
class Track {
  phase = new Float32Array(0);
  svx = new Float32Array(0);
  svz = new Float32Array(0);
  yaw = new Float32Array(0);
  speed = new Float32Array(0);
  px = new Float32Array(0);
  pz = new Float32Array(0);
  seen = new Uint8Array(0);

  ensure(n: number): void {
    if (n <= this.seen.length) return;
    const cap = Math.max(n, this.seen.length * 2, 64);
    const grow = <T extends Float32Array | Uint8Array>(a: T): T => {
      const b = new (a.constructor as { new (n: number): T })(cap);
      b.set(a);
      return b;
    };
    this.phase = grow(this.phase);
    this.svx = grow(this.svx);
    this.svz = grow(this.svz);
    this.yaw = grow(this.yaw);
    this.speed = grow(this.speed);
    this.px = grow(this.px);
    this.pz = grow(this.pz);
    this.seen = grow(this.seen);
  }
}

export class AgentsView {
  readonly group = new THREE.Group();
  private zombies = new FigureBatch('zombie', MAX_Z);
  private survivors = new FigureBatch('survivor', MAX_S);
  private strobes = new StrobeSprites(MAX_S);
  private zt = new Track();
  private st = new Track();
  private lastTime = -1;

  constructor() {
    this.group.add(this.zombies.mesh, this.survivors.mesh, this.strobes.mesh);
  }

  update(sim: Sim, time: number): void {
    // Animation timing follows the game clock, so it pauses with the game and is frame-rate independent.
    const dt = this.lastTime < 0 ? 0 : Math.min(0.1, Math.max(0, time - this.lastTime));
    this.lastTime = time;
    const ease = Math.min(1, dt * 5);

    const zs = sim.zombies;
    this.zt.ensure(zs.length);
    const start = Math.max(0, zs.length - MAX_Z);
    const { a, b, c } = this.zombies;
    const zt = this.zt;
    let k = 0;
    for (let i = start; i < zs.length; i++) {
      const z = zs[i];
      const seed = hash01(z.id);
      if (!zt.seen[i]) {
        zt.seen[i] = 1;
        zt.phase[i] = seed * TAU;
        zt.yaw[i] = seed * TAU;
        zt.svx[i] = z.vx;
        zt.svz[i] = z.vz;
      }
      const state = zombieAnimState(z);
      const v = Math.hypot(z.vx, z.vz);
      if (z.alive) {
        // Smooth the heading: the sim can change direction every step, a body turns over ~0.2 s.
        zt.svx[i] += (z.vx - zt.svx[i]) * ease;
        zt.svz[i] += (z.vz - zt.svz[i]) * ease;
        if (Math.hypot(zt.svx[i], zt.svz[i]) > 0.05) zt.yaw[i] = Math.atan2(zt.svx[i], zt.svz[i]);
        zt.phase[i] = (zt.phase[i] + dt * TAU * gaitRate(state, v)) % (TAU * 64);
      }
      const deadFor = z.alive ? 0 : sim.t - z.diedAt;
      const [core, limb] = bodyHeat(z.alive, z.cold, deadFor);
      const o = k * 4;
      a[o] = z.x;
      a[o + 1] = z.z;
      a[o + 2] = zt.yaw[i];
      a[o + 3] = zt.phase[i];
      b[o] = state;
      b[o + 1] = deadFor;
      b[o + 2] = gaitAmp(state, v);
      b[o + 3] = seed;
      c[o] = core;
      c[o + 1] = limb;
      c[o + 2] = z.cold ? VIS_COLD : VIS_WARM;
      c[o + 3] = 0;
      k++;
    }
    this.zombies.commit(k);
    this.zombies.material.uniforms.uTime.value = time;

    const ss = sim.survivors;
    const st = this.st;
    st.ensure(ss.length);
    const sb = this.survivors;
    let j = 0;
    let n = 0;
    for (let i = 0; i < ss.length; i++) {
      const s = ss[i];
      if (s.home || j >= MAX_S) continue;
      const seed = hash01(s.id + 7919);
      if (!st.seen[i]) {
        st.seen[i] = 1;
        st.px[i] = s.x;
        st.pz[i] = s.z;
        st.phase[i] = seed * TAU;
        st.yaw[i] = seed * TAU;
      }
      // Survivors have no velocity in the sim: measure it from how far they moved this frame.
      if (dt > 0) {
        const dx = s.x - st.px[i];
        const dz = s.z - st.pz[i];
        const inst = Math.hypot(dx, dz) / dt;
        st.speed[i] += (Math.min(6, inst) - st.speed[i]) * Math.min(1, dt * 6);
        if (inst > 0.2) {
          st.svx[i] += (dx / dt - st.svx[i]) * ease;
          st.svz[i] += (dz / dt - st.svz[i]) * ease;
          st.yaw[i] = Math.atan2(st.svx[i], st.svz[i]);
        }
        st.px[i] = s.x;
        st.pz[i] = s.z;
      }
      const state = survivorAnimState(s.alive, st.speed[i]);
      if (s.alive) st.phase[i] = (st.phase[i] + dt * TAU * gaitRate(state, st.speed[i])) % (TAU * 64);
      const deadFor = s.alive ? 0 : sim.t - s.diedAt;
      const [core, limb] = bodyHeat(s.alive, false, deadFor, true);
      const o = j * 4;
      sb.a[o] = s.x;
      sb.a[o + 1] = s.z;
      sb.a[o + 2] = st.yaw[i];
      sb.a[o + 3] = st.phase[i];
      sb.b[o] = state;
      sb.b[o + 1] = deadFor;
      sb.b[o + 2] = state === ANIM.dead ? 0 : gaitAmp(state, st.speed[i]);
      sb.b[o + 3] = seed;
      sb.c[o] = core;
      sb.c[o + 1] = limb;
      sb.c[o + 2] = VIS_SURVIVOR;
      sb.c[o + 3] = 0;
      j++;
      // A live survivor's strobe sits on the head; a dead one's is gone.
      if (s.alive) {
        const q = n * 3;
        this.strobes.pos[q] = s.x;
        this.strobes.pos[q + 1] = STROBE_BASE + STROBE_Y * FIGURE_SCALE;
        this.strobes.pos[q + 2] = s.z;
        n++;
      }
    }
    sb.commit(j);
    this.strobes.commit(n);
    sb.material.uniforms.uTime.value = time;
    // One 0.3 s blink a second: slow, and only a small dot, so never a flash hazard.
    this.strobes.material.uniforms.uBlink.value = time % 1 < 0.3 ? 1 : 0;
  }

  /** For tests and budgets: instances drawn per kind, and draw objects (one per kind). */
  get stats() {
    return { objects: this.group.children.length, zombies: this.zombies.count, survivors: this.survivors.count, strobes: this.strobes.count };
  }

  dispose(): void {
    this.zombies.dispose();
    this.survivors.dispose();
    this.strobes.dispose();
  }
}
