import * as THREE from 'three';
import { weaponById } from '../sim/weapons';

/** Tracers, blasts and craters. Craters glow hot and cool over ~25 s, like real impact sites on thermal. */
interface Tracer { mesh: THREE.Mesh; from: THREE.Vector3; to: THREE.Vector3; t0: number; tof: number }
interface Blast { mesh: THREE.Mesh; t0: number; r: number }
interface Crater { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial; t0: number }

export class Effects {
  readonly group = new THREE.Group();
  private tracers: Tracer[] = [];
  private blasts: Blast[] = [];
  private craters: Crater[] = [];
  private sphere = new THREE.SphereGeometry(1, 10, 8);
  private disc = new THREE.CircleGeometry(1, 16).rotateX(-Math.PI / 2);
  private tracerMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.85, 1, 0.15) });
  /** Night-vision washout, 0-1: eases up after blasts and decays, never a hard full-screen flash. */
  washout = 0;
  private washTarget = 0;
  shake = 0;

  fire(weapon: string, from: { x: number; y: number; z: number }, to: { x: number; z: number }, tof: number, now: number): void {
    const size = weapon === '105' ? 1.8 : weapon === '40' ? 1.1 : 0.6;
    const mesh = new THREE.Mesh(this.sphere, this.tracerMat);
    mesh.scale.setScalar(size);
    this.group.add(mesh);
    this.tracers.push({ mesh, from: new THREE.Vector3(from.x, from.y - 30, from.z), to: new THREE.Vector3(to.x, 0.5, to.z), t0: now, tof });
  }

  impact(weapon: string, x: number, z: number, now: number): void {
    const w = weaponById(weapon);
    const mat = new THREE.MeshBasicMaterial({ color: new THREE.Color(1, 1, 0.7), transparent: true });
    const mesh = new THREE.Mesh(this.sphere, mat);
    mesh.position.set(x, 1, z);
    this.group.add(mesh);
    this.blasts.push({ mesh, t0: now, r: w.radius * 0.8 });
    const cmat = new THREE.MeshBasicMaterial({ color: new THREE.Color(0.95, 0.03, 0) });
    const crater = new THREE.Mesh(this.disc, cmat);
    crater.scale.setScalar(Math.max(1.2, w.radius * 0.45));
    crater.position.set(x, 1.4 + (this.craters.length % 10) * 0.02, z);
    this.group.add(crater);
    this.craters.push({ mesh: crater, mat: cmat, t0: now });
    if (this.craters.length > 150) {
      const old = this.craters.shift()!;
      this.group.remove(old.mesh);
      old.mat.dispose();
    }
    this.washTarget = Math.min(0.9, this.washTarget + w.washout);
    if (weapon === '105') this.shake = Math.max(this.shake, 0.25);
  }

  update(now: number, dt: number): void {
    this.tracers = this.tracers.filter((t) => {
      const k = (now - t.t0) / t.tof;
      if (k >= 1) {
        this.group.remove(t.mesh);
        return false;
      }
      t.mesh.position.lerpVectors(t.from, t.to, k);
      return true;
    });
    this.blasts = this.blasts.filter((b) => {
      const age = now - b.t0;
      if (age > 0.8) {
        this.group.remove(b.mesh);
        (b.mesh.material as THREE.Material).dispose();
        return false;
      }
      b.mesh.scale.setScalar(b.r * Math.min(1, age / 0.15 + 0.2));
      (b.mesh.material as THREE.MeshBasicMaterial).opacity = 1 - age / 0.8;
      return true;
    });
    for (const c of this.craters) {
      const cool = Math.min(1, (now - c.t0) / 25);
      c.mat.color.setRGB(0.95 - cool * 0.7, 0.03, 0);
    }
    // Ease washout toward its target (≈0.15 s rise), and let the target decay.
    this.washout += (this.washTarget - this.washout) * Math.min(1, dt * 7);
    this.washTarget = Math.max(0, this.washTarget - dt * 0.6);
    this.shake = Math.max(0, this.shake - dt);
  }

  dispose(): void {
    for (const c of this.craters) c.mat.dispose();
    for (const b of this.blasts) (b.mesh.material as THREE.Material).dispose();
    this.sphere.dispose();
    this.disc.dispose();
    this.tracerMat.dispose();
  }
}
