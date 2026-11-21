import * as THREE from 'three';
import type { Sim } from '../sim/sim';

/** Draws zombies and survivors as instanced boxes. Colours are sensor values (heat, visible, near-IR). */
const MAX_Z = 2500;
const MAX_S = 32;
const WARM = new THREE.Color(0.95, 0.36, 0);
const COLD = new THREE.Color(0.205, 0.34, 0); // about the same heat as grass and ground
const SURVIVOR = new THREE.Color(0.9, 0.42, 0);
const PANEL = new THREE.Color(0.0, 0.42, 0); // cold ID panel: a dark square on thermal
const STROBE_ON = new THREE.Color(0, 0.05, 1); // near-IR: only night vision sees it
const STROBE_OFF = new THREE.Color(0, 0, 0);

export class AgentsView {
  readonly group = new THREE.Group();
  private zMesh: THREE.InstancedMesh;
  private sMesh: THREE.InstancedMesh;
  private panel: THREE.InstancedMesh;
  private strobe: THREE.InstancedMesh;
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private e = new THREE.Euler();
  private c = new THREE.Color();
  private v = new THREE.Vector3();
  private s = new THREE.Vector3(1, 1, 1);
  private disposables: { dispose(): void }[] = [];

  constructor() {
    const body = new THREE.BoxGeometry(1.2, 2.4, 0.8).translate(0, 1.2, 0);
    const mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    this.zMesh = new THREE.InstancedMesh(body, mat, MAX_Z);
    this.sMesh = new THREE.InstancedMesh(body, mat, MAX_S);
    const panelGeo = new THREE.BoxGeometry(1.1, 0.15, 1.1);
    const basic = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.panel = new THREE.InstancedMesh(panelGeo, basic, MAX_S);
    const strobeGeo = new THREE.SphereGeometry(0.7, 8, 6);
    this.strobe = new THREE.InstancedMesh(strobeGeo, basic, MAX_S);
    for (const im of [this.zMesh, this.sMesh, this.panel, this.strobe]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0;
      im.frustumCulled = false;
      this.group.add(im);
    }
    this.disposables.push(body, mat, panelGeo, basic, strobeGeo);
  }

  update(sim: Sim, time: number): void {
    const zs = sim.zombies;
    const start = Math.max(0, zs.length - MAX_Z);
    let k = 0;
    for (let i = start; i < zs.length; i++) {
      const z = zs[i];
      if (z.alive) {
        this.e.set(0, Math.atan2(z.vx, z.vz), 0);
        this.q.setFromEuler(this.e);
        this.m.compose(this.v.set(z.x, 0, z.z), this.q, this.s.set(1, 1, 1));
        this.c.copy(z.cold ? COLD : WARM);
      } else {
        // Bodies lie flat and cool down over about 40 seconds (cold-blooded ones were never warm).
        this.e.set(Math.PI / 2, (z.id * 1.7) % 6.28, 0);
        this.q.setFromEuler(this.e);
        this.m.compose(this.v.set(z.x, 0.45, z.z), this.q, this.s.set(1, 1, 1));
        const cool = Math.min(1, (sim.t - z.diedAt) / 40);
        this.c.setRGB(z.cold ? 0.2 : 0.9 - cool * 0.62, 0.22, 0);
      }
      this.zMesh.setMatrixAt(k, this.m);
      this.zMesh.setColorAt(k, this.c);
      k++;
    }
    this.zMesh.count = k;
    this.flag(this.zMesh);

    let j = 0;
    const blink = time % 1 < 0.15;
    for (const s of sim.survivors) {
      if (s.home || j >= MAX_S) continue;
      if (s.alive) {
        this.m.compose(this.v.set(s.x, 0, s.z), this.q.identity(), this.s.set(1, 1, 1));
        this.sMesh.setMatrixAt(j, this.m);
        this.sMesh.setColorAt(j, SURVIVOR);
        this.m.makeTranslation(s.x, 2.5, s.z);
        this.panel.setMatrixAt(j, this.m);
        this.panel.setColorAt(j, PANEL);
        this.m.makeTranslation(s.x, 3.3, s.z);
        this.strobe.setMatrixAt(j, this.m);
        this.strobe.setColorAt(j, blink ? STROBE_ON : STROBE_OFF);
      } else {
        this.e.set(Math.PI / 2, 0.4, 0);
        this.q.setFromEuler(this.e);
        this.m.compose(this.v.set(s.x, 0.45, s.z), this.q, this.s.set(1, 1, 1));
        this.sMesh.setMatrixAt(j, this.m);
        const cool = Math.min(1, (sim.t - s.diedAt) / 40);
        this.sMesh.setColorAt(j, this.c.setRGB(0.85 - cool * 0.55, 0.22, 0));
        this.m.makeScale(0, 0, 0);
        this.panel.setMatrixAt(j, this.m);
        this.strobe.setMatrixAt(j, this.m);
      }
      j++;
    }
    for (const im of [this.sMesh, this.panel, this.strobe]) {
      im.count = j;
      this.flag(im);
    }
  }

  private flag(im: THREE.InstancedMesh): void {
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }
}
