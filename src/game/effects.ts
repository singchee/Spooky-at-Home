import * as THREE from 'three';
import { weaponById } from '../sim/weapons';

/**
 * Tracers, blasts and craters, each drawn as ONE instanced mesh so the draw-call count stays
 * flat however long you fire. Craters glow hot and cool over ~25 s, like real impact sites.
 */
const MAX_TRACERS = 256;
const MAX_BLASTS = 64;
const MAX_CRATERS = 150;

interface Tracer { from: THREE.Vector3; to: THREE.Vector3; t0: number; tof: number; size: number }
interface Blast { x: number; z: number; t0: number; r: number }
interface Crater { x: number; z: number; t0: number; r: number; y: number }

export class Effects {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private blasts: Blast[] = [];
  private craters: Crater[] = [];
  private sphere = new THREE.SphereGeometry(1, 10, 8);
  private disc = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
  private tracerMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  // Additive: fading a blast's colour to black fades it out, with no per-instance opacity needed.
  private blastMat = new THREE.MeshBasicMaterial({ color: 0xffffff, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false });
  private craterMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private tracerMesh = new THREE.InstancedMesh(this.sphere, this.tracerMat, MAX_TRACERS);
  private blastMesh = new THREE.InstancedMesh(this.sphere, this.blastMat, MAX_BLASTS);
  private craterMesh = new THREE.InstancedMesh(this.disc, this.craterMat, MAX_CRATERS);
  private m = new THREE.Matrix4();
  private c = new THREE.Color();
  private v = new THREE.Vector3();
  private nextCraterY = 0;
  /** Night-vision washout, 0-1: eases up after blasts and decays, never a hard full-screen flash. */
  washout = 0;
  private washTarget = 0;
  shake = 0;

  constructor() {
    for (const im of [this.tracerMesh, this.blastMesh, this.craterMesh]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      im.setColorAt(0, this.c.setRGB(0, 0, 0)); // allocate the colour buffer
      this.group.add(im);
    }
  }

  fire(weapon: string, from: { x: number; y: number; z: number }, to: { x: number; z: number }, tof: number, now: number): void {
    if (this.tracers.length >= MAX_TRACERS) this.tracers.shift();
    const size = weapon === '105' ? 1.8 : weapon === '40' ? 1.1 : 0.6;
    this.tracers.push({ from: new THREE.Vector3(from.x, from.y - 30, from.z), to: new THREE.Vector3(to.x, 0.5, to.z), t0: now, tof, size });
  }

  impact(weapon: string, x: number, z: number, now: number): void {
    const w = weaponById(weapon);
    if (this.blasts.length >= MAX_BLASTS) this.blasts.shift();
    this.blasts.push({ x, z, t0: now, r: w.radius * 0.8 });
    if (this.craters.length >= MAX_CRATERS) this.craters.shift();
    this.nextCraterY = (this.nextCraterY + 1) % 10;
    this.craters.push({ x, z, t0: now, r: Math.max(1.2, w.radius * 0.45), y: 1.4 + this.nextCraterY * 0.02 });
    this.washTarget = Math.min(0.9, this.washTarget + w.washout);
    if (weapon === '105') this.shake = Math.max(this.shake, 0.25);
  }

  /** For tests: objects drawn and live instances per kind (capped, so draw calls stay flat). */
  get stats() {
    return { objects: this.group.children.length, tracers: this.tracerMesh.count, blasts: this.blastMesh.count, craters: this.craterMesh.count };
  }
  static readonly LIMITS = { tracers: MAX_TRACERS, blasts: MAX_BLASTS, craters: MAX_CRATERS };

  update(now: number, dt: number): void {
    this.tracers = this.tracers.filter((t) => now - t.t0 < t.tof);
    this.tracers.forEach((t, i) => {
      this.v.lerpVectors(t.from, t.to, (now - t.t0) / t.tof);
      this.m.makeScale(t.size, t.size, t.size).setPosition(this.v);
      this.tracerMesh.setMatrixAt(i, this.m);
      this.tracerMesh.setColorAt(i, this.c.setRGB(0.85, 1, 0.15));
    });
    this.tracerMesh.count = this.tracers.length;

    this.blasts = this.blasts.filter((b) => now - b.t0 < 0.8);
    this.blasts.forEach((b, i) => {
      const age = now - b.t0;
      const s = b.r * Math.min(1, age / 0.15 + 0.2);
      this.m.makeScale(s, s, s).setPosition(b.x, 1, b.z);
      this.blastMesh.setMatrixAt(i, this.m);
      const f = 1 - age / 0.8;
      this.blastMesh.setColorAt(i, this.c.setRGB(f, f, 0.7 * f));
    });
    this.blastMesh.count = this.blasts.length;

    this.craters.forEach((c, i) => {
      this.m.makeScale(c.r, 1, c.r).setPosition(c.x, c.y, c.z);
      this.craterMesh.setMatrixAt(i, this.m);
      // Hot but below live-zombie white, then cooling to ground temperature.
      const cool = Math.min(1, (now - c.t0) / 25);
      this.craterMesh.setColorAt(i, this.c.setRGB(0.58 - cool * 0.36, 0.03, 0));
    });
    this.craterMesh.count = this.craters.length;

    for (const im of [this.tracerMesh, this.blastMesh, this.craterMesh]) {
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
    }
    // Ease washout toward its target (≈0.15 s rise), and let the target decay.
    this.washout += (this.washTarget - this.washout) * Math.min(1, dt * 7);
    this.washTarget = Math.max(0, this.washTarget - dt * 0.6);
    this.shake = Math.max(0, this.shake - dt);
  }

  dispose(): void {
    this.sphere.dispose();
    this.disc.dispose();
    this.tracerMat.dispose();
    this.blastMat.dispose();
    this.craterMat.dispose();
    this.tracerMesh.dispose();
    this.blastMesh.dispose();
    this.craterMesh.dispose();
  }
}
