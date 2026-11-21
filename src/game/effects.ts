import * as THREE from 'three';
import { weaponById } from '../sim/weapons';
import { mulberry32, type Rng } from '../util/rng';
import { PK, ParticlePool, makeAdditiveMaterial, makeCraterMaterial, makeSmokeMaterial } from '../render/particleShader';

/**
 * Tracers, layered explosions and craters in three draw calls, however long you fire:
 *  1. glow (additive GPU particles): tracer streaks, a brief local flash, a noisy fireball that
 *     expands and cools, spark and debris arcs, a ground shockwave ring, and (40/105) small fires
 *     that keep burning and cooling for 10-20 s;
 *  2. smoke (multiply-blended GPU particles): dims visible light and near-IR a lot and heat
 *     hardly at all, like real smoke, so it hides things from night vision but not thermal;
 *  3. craters: scorched discs that glow hot and cool over ~25 s.
 * Particles live in fixed ring buffers, so memory and draw calls stay flat.
 */
const CAP_TRACERS = 256;
const CAP_SHORT = 4096;
const CAP_FIRES = 256;
const CAP_SMOKE = 1536;
const MAX_BLASTS = 64;
const MAX_CRATERS = 150;
const REG_TRACER = 0;
const REG_SHORT = 1;
const REG_FIRE = 2;
/** Light drift for smoke, metres per second. */
const WIND = { x: 1.1, z: 0.5 };

interface Profile {
  flash: { size: number; life: number };
  fireballs: number;
  fbSize: [number, number];
  fbLife: number;
  sparks: number;
  sparkSpeed: number;
  sparkWidth: number;
  debris: number;
  ring: number;
  smoke: number;
  smokeSize: [number, number];
  smokeLife: number;
  smokeRise: number;
  fires: number;
  fireLife: [number, number];
  fireSize: [number, number];
  tracerWidth: number;
}

/** Explosion layers per gun, scaled 25 → 40 → 105. */
export const BLAST_PROFILES: Record<'25' | '40' | '105', Profile> = {
  '25': {
    flash: { size: 9, life: 0.07 }, fireballs: 3, fbSize: [2, 6.5], fbLife: 0.6,
    sparks: 7, sparkSpeed: 18, sparkWidth: 0.5, debris: 3, ring: 12,
    smoke: 2, smokeSize: [4, 11], smokeLife: 4, smokeRise: 3,
    fires: 0, fireLife: [0, 0], fireSize: [0, 0], tracerWidth: 0.7,
  },
  '40': {
    flash: { size: 22, life: 0.1 }, fireballs: 7, fbSize: [4, 18], fbLife: 1.3,
    sparks: 18, sparkSpeed: 34, sparkWidth: 0.9, debris: 9, ring: 40,
    smoke: 7, smokeSize: [8, 30], smokeLife: 9, smokeRise: 5,
    fires: 2, fireLife: [10, 15], fireSize: [3.5, 6], tracerWidth: 1.0,
  },
  '105': {
    flash: { size: 50, life: 0.14 }, fireballs: 14, fbSize: [10, 42], fbLife: 2.4,
    sparks: 40, sparkSpeed: 60, sparkWidth: 1.4, debris: 20, ring: 110,
    smoke: 16, smokeSize: [20, 75], smokeLife: 14, smokeRise: 10,
    fires: 6, fireLife: [14, 20], fireSize: [6, 10], tracerWidth: 1.6,
  },
};
const profileOf = (weapon: string): Profile => BLAST_PROFILES[weapon as '25'] ?? BLAST_PROFILES['25'];

interface Crater { x: number; z: number; t0: number; r: number; y: number }

export class Effects {
  readonly group = new THREE.Group();
  private glow = new ParticlePool([CAP_TRACERS, CAP_SHORT, CAP_FIRES], makeAdditiveMaterial());
  private smoke = new ParticlePool([CAP_SMOKE], makeSmokeMaterial());
  private craters: Crater[] = [];
  private blastTimes: number[] = [];
  private disc = new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2);
  private craterMat = makeCraterMaterial();
  private craterMesh = new THREE.InstancedMesh(this.disc, this.craterMat, MAX_CRATERS);
  private m = new THREE.Matrix4();
  private c = new THREE.Color();
  private nextCraterY = 0;
  private rng: Rng = mulberry32(0x5f3759df);
  private now = 0;
  /** Night-vision washout, 0-1: eases up after blasts and decays, never a hard full-screen flash. */
  washout = 0;
  private washTarget = 0;
  shake = 0;

  constructor() {
    this.craterMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.craterMesh.count = 0;
    this.craterMesh.frustumCulled = false;
    this.craterMesh.setColorAt(0, this.c.setRGB(0, 0, 0)); // allocate the colour buffer
    // Draw order: craters (opaque), then glow added on top, then smoke dimming everything behind it.
    this.glow.mesh.renderOrder = 1;
    this.smoke.mesh.renderOrder = 2;
    this.group.add(this.craterMesh, this.glow.mesh, this.smoke.mesh);
  }

  fire(weapon: string, from: { x: number; y: number; z: number }, to: { x: number; z: number }, tof: number, now: number): void {
    const sx = from.x;
    const sy = from.y - 30;
    const sz = from.z;
    const ty = 1.5;
    this.glow.spawn(REG_TRACER, {
      x: sx, y: sy, z: sz, t0: now,
      vx: (to.x - sx) / tof, vy: (ty - sy) / tof, vz: (to.z - sz) / tof, life: tof,
      size0: profileOf(weapon).tracerWidth, size1: profileOf(weapon).tracerWidth, kind: PK.tracer, seed: this.rng(),
      r: 0.95, g: 1.0, b: 0.35, p: 0,
    });
  }

  impact(weapon: string, x: number, z: number, now: number): void {
    const w = weaponById(weapon);
    const P = profileOf(weapon);
    const R = w.radius;
    const rnd = this.rng;
    const g = this.glow;

    // 1. Flash: brief and local.
    g.spawn(REG_SHORT, {
      x, y: 2, z, t0: now, vx: 0, vy: 0, vz: 0, life: P.flash.life,
      size0: P.flash.size * 0.6, size1: P.flash.size, kind: PK.flash, seed: rnd(), r: 0.55, g: 0.9, b: 0.3, p: 1,
    });
    // 2. Fireball: puffs billow out and up, hot and bright, then cool.
    for (let i = 0; i < P.fireballs; i++) {
      const a = rnd() * Math.PI * 2;
      const up = 0.3 + rnd() * 0.7;
      const sp = R * (1.2 + rnd() * 1.6);
      g.spawn(REG_SHORT, {
        x: x + Math.cos(a) * R * 0.2 * rnd(), y: 1.5 + rnd() * R * 0.2, z: z + Math.sin(a) * R * 0.2 * rnd(), t0: now + rnd() * 0.05,
        vx: Math.cos(a) * sp * (1 - up * 0.5), vy: sp * up, vz: Math.sin(a) * sp * (1 - up * 0.5),
        life: P.fbLife * (0.7 + rnd() * 0.5), size0: P.fbSize[0] * (0.7 + rnd() * 0.6), size1: P.fbSize[1] * (0.7 + rnd() * 0.6),
        kind: PK.fireball, seed: rnd(), r: 0.26, g: 0.36, b: 0.1, p: 3,
      });
    }
    // 3. Sparks (fast, bright streaks) and debris (slower glowing chunks), both arcing under gravity.
    for (let i = 0; i < P.sparks + P.debris; i++) {
      const spark = i < P.sparks;
      const a = rnd() * Math.PI * 2;
      const el = 0.35 + rnd() * 0.9; // radians above the horizon
      const sp = P.sparkSpeed * (spark ? 0.55 + rnd() * 0.6 : 0.3 + rnd() * 0.35);
      g.spawn(REG_SHORT, {
        x, y: 1.6, z, t0: now,
        vx: Math.cos(a) * Math.cos(el) * sp, vy: Math.sin(el) * sp, vz: Math.sin(a) * Math.cos(el) * sp,
        life: spark ? 0.45 + rnd() * 0.6 : 1.1 + rnd() * 1.1,
        size0: spark ? P.sparkWidth : P.sparkWidth * (1.2 + rnd()), size1: spark ? P.sparkWidth * 0.6 : P.sparkWidth,
        kind: spark ? PK.spark : PK.debris, seed: rnd(),
        r: spark ? 0.85 : 0.5, g: spark ? 0.5 : 0.07, b: spark ? 0.2 : 0, p: spark ? 45 : 35,
      });
    }
    // 4. Ground shockwave ring.
    g.spawn(REG_SHORT, {
      x, y: 0, z, t0: now, vx: 0, vy: 0, vz: 0, life: weapon === '25' ? 0.3 : 0.5,
      size0: P.ring * 0.15, size1: P.ring, kind: PK.ring, seed: rnd(), r: 0.2, g: 0.24, b: 0.03, p: 1,
    });
    // 5. Smoke rising from the blast, emerging as the fireball fades.
    for (let i = 0; i < P.smoke; i++) {
      const a = rnd() * Math.PI * 2;
      const d = rnd() * R * 0.45;
      this.smoke.spawn(0, {
        x: x + Math.cos(a) * d, y: 2 + rnd() * R * 0.3, z: z + Math.sin(a) * d, t0: now + P.fbLife * (0.4 + rnd() * 0.5),
        vx: WIND.x + Math.cos(a) * R * 0.15, vy: P.smokeRise * (0.6 + rnd() * 0.6), vz: WIND.z + Math.sin(a) * R * 0.15,
        life: P.smokeLife * (0.7 + rnd() * 0.5), size0: P.smokeSize[0] * (0.7 + rnd() * 0.5), size1: P.smokeSize[1] * (0.7 + rnd() * 0.5),
        kind: PK.smoke, seed: rnd(), r: 0.85, g: 0, b: 0, p: 0.3,
      });
    }
    // 6. Small fires (40 and 105) that burn on and cool, each trailing a thin smoke column.
    for (let i = 0; i < P.fires; i++) {
      const a = rnd() * Math.PI * 2;
      const d = R * (0.15 + rnd() * 0.6);
      const fx = x + Math.cos(a) * d;
      const fz = z + Math.sin(a) * d;
      const life = P.fireLife[0] + rnd() * (P.fireLife[1] - P.fireLife[0]);
      const size = P.fireSize[0] + rnd() * (P.fireSize[1] - P.fireSize[0]);
      g.spawn(REG_FIRE, {
        x: fx, y: 1.2, z: fz, t0: now + 0.2 + rnd() * 0.4, vx: 0, vy: 0, vz: 0, life,
        size0: size, size1: size * 0.8, kind: PK.fire, seed: rnd(), r: 0.34, g: 0.3, b: 0, p: 1,
      });
      for (let s = 1.5; s < life - 1; s += 2.4) {
        this.smoke.spawn(0, {
          x: fx, y: 2 + size * 2, z: fz, t0: now + s,
          vx: WIND.x * 1.5, vy: 2.5 + rnd(), vz: WIND.z * 1.5, life: 6 + rnd() * 2,
          size0: size * 0.8, size1: size * 3.5, kind: PK.smoke, seed: rnd(), r: 0.35 * (1 - s / life) + 0.1, g: 0, b: 0, p: 0.15,
        });
      }
    }

    if (this.blastTimes.length >= MAX_BLASTS) this.blastTimes.shift();
    this.blastTimes.push(now);
    if (this.craters.length >= MAX_CRATERS) this.craters.shift();
    this.nextCraterY = (this.nextCraterY + 1) % 10;
    this.craters.push({ x, z, t0: now, r: Math.max(1.2, R * 0.45), y: 1.4 + this.nextCraterY * 0.02 });
    this.washTarget = Math.min(0.9, this.washTarget + w.washout);
    if (weapon === '105') this.shake = Math.max(this.shake, 0.25);
  }

  /** For tests: objects drawn and live instances per kind (capped, so draw calls stay flat). */
  get stats() {
    const now = this.now;
    return {
      objects: this.group.children.length,
      tracers: this.glow.live(now, REG_TRACER),
      blasts: this.blastTimes.filter((t) => now - t >= 0 && now - t < BLAST_PROFILES['105'].fbLife * 1.2).length,
      craters: this.craterMesh.count,
      glow: this.glow.live(now),
      fires: this.glow.live(now, REG_FIRE),
      smoke: this.smoke.live(now),
    };
  }
  static readonly LIMITS = {
    tracers: CAP_TRACERS,
    blasts: MAX_BLASTS,
    craters: MAX_CRATERS,
    glow: CAP_TRACERS + CAP_SHORT + CAP_FIRES,
    fires: CAP_FIRES,
    smoke: CAP_SMOKE,
  };

  update(now: number, dt: number): void {
    this.now = now;
    this.glow.flush(now);
    this.smoke.flush(now);

    this.craters.forEach((c, i) => {
      this.m.makeScale(c.r, 1, c.r).setPosition(c.x, c.y, c.z);
      this.craterMesh.setMatrixAt(i, this.m);
      // Hot but below live-zombie white, then cooling to ground temperature.
      const cool = Math.min(1, (now - c.t0) / 25);
      this.craterMesh.setColorAt(i, this.c.setRGB(0.58 - cool * 0.36, 0.03, 0));
    });
    this.craterMesh.count = this.craters.length;
    this.craterMesh.instanceMatrix.needsUpdate = true;
    if (this.craterMesh.instanceColor) this.craterMesh.instanceColor.needsUpdate = true;

    // Ease washout toward its target (≈0.15 s rise), and let the target decay.
    this.washout += (this.washTarget - this.washout) * Math.min(1, dt * 7);
    this.washTarget = Math.max(0, this.washTarget - dt * 0.6);
    this.shake = Math.max(0, this.shake - dt);
  }

  dispose(): void {
    this.glow.dispose();
    this.smoke.dispose();
    this.disc.dispose();
    this.craterMat.dispose();
    this.craterMesh.dispose();
  }
}
