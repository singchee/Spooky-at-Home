import * as THREE from 'three';
import { mergeGeometries, mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Low-poly human figures animated entirely in the vertex shader.
 *
 * The figure is built once in code (torso, head, two arms, two legs, plus an ID panel and IR strobe
 * for survivors) and merged into one geometry. Every vertex knows its body part and that part's
 * joint (pivot). Each instance carries its position, heading, gait phase, animation state, time
 * since death, heat and a per-agent random seed. The shader swings the limbs about their joints,
 * leans and sways the torso, and tips the whole body over when it dies, so one instanced draw
 * call animates thousands of zombies with no per-frame skinning on the CPU.
 *
 * Output colours are sensor values (R heat, G visible light, B near-infrared), not display colours.
 */
export const PART = { torso: 0, head: 1, armL: 2, armR: 3, legL: 4, legR: 5, panel: 6, strobe: 7 } as const;

/** Figures are drawn ~20% larger than life (about 2.7 m) so their poses read from the gunship. */
export const FIGURE_SCALE = 1.2;

/** Floats per instance in each per-instance attribute (iA, iB, iC are all vec4). */
export const FIGURE_STRIDE = 4;

const HIP_Y = 1.0;
const SHOULDER_Y = 1.76;
const NECK_Y = 1.82;

function tagPart(geo: THREE.BufferGeometry, part: number, pivot: THREE.Vector3, limbLen: number): THREE.BufferGeometry {
  // Indexed and lean: the vertex shader does all the work, so fewer vertices = more zombies.
  geo.deleteAttribute('uv');
  let g = geo;
  if (!g.index) {
    g.deleteAttribute('normal');
    g = mergeVertices(g);
    geo.dispose();
  }
  g.computeVertexNormals();
  const pos = g.attributes.position;
  const n = pos.count;
  const aPart = new Float32Array(n).fill(part);
  const aPivot = new Float32Array(n * 3);
  const aLimbT = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    aPivot.set([pivot.x, pivot.y, pivot.z], i * 3);
    // 0 at the joint, 1 at the hand or foot: extremities run cooler on thermal.
    aLimbT[i] = limbLen > 0 ? Math.min(1, Math.max(0, (pivot.y - pos.getY(i)) / limbLen)) : 0;
  }
  g.setAttribute('aPart', new THREE.BufferAttribute(aPart, 1));
  g.setAttribute('aPivot', new THREE.BufferAttribute(aPivot, 3));
  g.setAttribute('aLimbT', new THREE.BufferAttribute(aLimbT, 1));
  return g;
}

/**
 * The rest pose: standing, facing +z, feet at y = 0, about 2.25 m tall. Proportions are a little
 * exaggerated (big head, broad shoulders, long arms) so the silhouette reads from 1.8 km.
 */
export function buildFigureGeometry(withSurvivorKit: boolean): THREE.BufferGeometry {
  const parts: THREE.BufferGeometry[] = [];
  // Torso: a box tapered toward the waist.
  const torso = new THREE.BoxGeometry(0.7, SHOULDER_Y + 0.06 - HIP_Y, 0.38);
  const tp = torso.attributes.position;
  for (let i = 0; i < tp.count; i++) if (tp.getY(i) < 0) tp.setX(i, tp.getX(i) * 0.7);
  torso.translate(0, (HIP_Y + SHOULDER_Y + 0.06) / 2, 0);
  parts.push(tagPart(torso, PART.torso, new THREE.Vector3(0, HIP_Y, 0), 0));

  const head = new THREE.IcosahedronGeometry(0.26, 0).scale(1, 1.1, 1).translate(0, NECK_Y + 0.2, 0.03);
  parts.push(tagPart(head, PART.head, new THREE.Vector3(0, NECK_Y, 0), 0));

  for (const side of [1, -1]) {
    // Limbs are open-ended four-sided prisms: their ends are hidden or too small to see.
    const arm = new THREE.CylinderGeometry(0.1, 0.075, 0.82, 4, 1, true).translate(side * 0.44, SHOULDER_Y - 0.41, 0);
    parts.push(tagPart(arm, side > 0 ? PART.armL : PART.armR, new THREE.Vector3(side * 0.44, SHOULDER_Y, 0), 0.82));
    const leg = new THREE.CylinderGeometry(0.15, 0.1, HIP_Y, 4, 1, true).translate(side * 0.17, HIP_Y / 2, 0);
    parts.push(tagPart(leg, side > 0 ? PART.legL : PART.legR, new THREE.Vector3(side * 0.17, HIP_Y, 0), HIP_Y));
  }

  if (withSurvivorKit) {
    // Cold ID panel worn on the head (a dark square on thermal) and an IR strobe above it.
    const panel = new THREE.BoxGeometry(0.72, 0.08, 0.56).translate(0, NECK_Y + 0.5, 0);
    parts.push(tagPart(panel, PART.panel, new THREE.Vector3(0, NECK_Y, 0), 0));
    const strobe = new THREE.OctahedronGeometry(0.5, 0).translate(0, NECK_Y + 1.15, 0);
    parts.push(tagPart(strobe, PART.strobe, new THREE.Vector3(0, NECK_Y, 0), 0));
  }
  const merged = mergeGeometries(parts, false);
  parts.forEach((p) => p.dispose());
  if (!merged) throw new Error('figure geometry failed to merge');
  return merged;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uKind;   // 0 zombies, 1 survivors
  uniform float uBlink;  // survivors' IR strobe: 1 on, 0 off
  uniform float uBase;   // height of the feet above the map's zero (roads sit at 1 m)
  uniform float uScale;  // overall size: a little larger than life so figures read from 1.8 km
  attribute float aPart;
  attribute vec3 aPivot;
  attribute float aLimbT;
  attribute vec4 iA; // x, z, heading, gait phase (radians)
  attribute vec4 iB; // state, seconds since death, gait amplitude, seed 0-1
  attribute vec4 iC; // core heat, limb heat, visible light, unused
  varying vec3 vSig;

  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
  float eq(float v, float k) { return 1.0 - step(0.5, abs(v - k)); }

  void main() {
    float state = iB.x;
    float age = iB.y;
    float amp = iB.z;
    float seed = iB.w;
    float ph = iA.w;
    float r1 = fract(seed * 7.31 + 0.13);
    float r2 = fract(seed * 13.77 + 0.41);
    float r3 = fract(seed * 29.13 + 0.07);
    float r4 = fract(seed * 53.91 + 0.29);
    float zombie = 1.0 - step(0.5, uKind);
    float lunge = eq(state, 1.0);
    float attack = eq(state, 2.0);
    float dead = eq(state, 3.0);
    float run = eq(state, 5.0);
    float part = aPart;
    float isArm = eq(part, 2.0) + eq(part, 3.0);
    float isLeg = eq(part, 4.0) + eq(part, 5.0);
    float isHeadKit = eq(part, 1.0) + step(5.5, part);
    float side = (eq(part, 2.0) + eq(part, 4.0)) * 2.0 - 1.0; // +1 left (+x), -1 right

    // Death: a ~0.6 s fall, accelerating like gravity, forward or backward by seed.
    float f = dead * clamp(age / 0.6, 0.0, 1.0);
    float fall = f * f;
    float fallDir = r2 > 0.5 ? 1.0 : -1.0;

    float sw = sin(ph);
    // Legs: zombies drag one leg (a limp), survivors stride evenly.
    float limp = mix(1.0, 0.35 + 0.5 * r1, zombie * step(side, 0.0));
    float legA = amp * (0.42 + 0.2 * lunge + 0.15 * run) * sw * side * limp;
    mat3 rLeg = rotZ(side * (0.05 * zombie + 0.2 * fall)) * rotX(legA);

    // Arms. Zombies: raised forward, bobbing with each lurch, clawing when they attack.
    float zPitch = -(1.15 + 0.3 * r2) - 0.25 * lunge + 0.22 * amp * sin(ph + side * 1.2);
    zPitch = mix(zPitch, -0.35 + 0.15 * sw, step(0.7, r3) * step(0.0, side)); // some let one arm hang
    zPitch += attack * 0.6 * sin(uTime * 9.0 + seed * 40.0 + side * 1.9);
    // Survivors: arms down, swinging opposite the legs; bigger swing and bent forward when running.
    float sPitch = -side * amp * (0.55 + 0.3 * run) * sw - 0.3 * run;
    float pitch = mix(sPitch, zPitch, zombie);
    pitch = mix(pitch, -2.8, f); // flung over the head as the body goes down
    mat3 rArm = rotZ(side * (0.07 + 0.12 * r4 * zombie + 0.45 * f)) * rotX(pitch);

    // Torso: zombies stoop and lurch side to side; an attack bobs them forward.
    float lean = mix(0.04 + 0.2 * run, 0.15 + 0.3 * r4 + 0.2 * lunge + attack * (0.25 + 0.15 * sin(uTime * 9.0 + seed * 40.0)), zombie);
    lean *= 1.0 - f;
    float roll = mix(0.04 * amp * sw, 0.16 * amp * sw + (r1 - 0.5) * 0.22, zombie) * (1.0 - f);
    float twist = mix(-0.14, 0.1, zombie) * amp * sw * (1.0 - f);
    mat3 rTorso = rotY(twist) * rotZ(roll) * rotX(lean);
    // Head: zombies loll to one side.
    mat3 rHead = rotZ(zombie * (r2 - 0.5) * 0.8) * rotX(mix(-0.1, -0.2 + 0.12 * sin(ph * 2.0), zombie));

    vec3 p = position;
    vec3 n = normal;
    if (isArm > 0.5) { p = aPivot + rArm * (p - aPivot); n = rArm * n; }
    if (isHeadKit > 0.5) { p = aPivot + rHead * (p - aPivot); n = rHead * n; }
    if (isLeg > 0.5) { p = aPivot + rLeg * (p - aPivot); n = rLeg * n; }
    else { vec3 waist = vec3(0.0, ${HIP_Y.toFixed(2)}, 0.0); p = waist + rTorso * (p - waist); n = rTorso * n; }
    // Bob: a lurching dip on the dragged step for zombies, a light bounce for survivors.
    p.y += amp * mix(0.05 * abs(cos(ph)), 0.08 * abs(sin(ph)), zombie) * (1.0 - f);

    // Fall over about the feet, then lie flat (lifted so the body rests on the ground, not in it).
    mat3 rFall = rotX(fallDir * fall * 1.5708);
    p = rFall * p;
    n = rFall * n;
    p.y += 0.2 * fall;
    // A dead survivor's panel and strobe are gone: collapse them to a point.
    if (dead > 0.5 && part > 5.5) p = vec3(0.0);

    // Per-agent variety: height, build and a crab-wise heading offset.
    float h = mix(0.95 + 0.1 * r3, 0.9 + 0.24 * r3, zombie);
    float w = mix(1.0, 0.9 + 0.22 * r1, zombie);
    p *= vec3(w, h, w) * uScale;
    mat3 rYaw = rotY(iA.z + zombie * (r4 - 0.5) * 0.35);
    p = rYaw * p;
    n = normalize(rYaw * n);

    vec4 world = modelMatrix * vec4(iA.x + p.x, uBase + p.y, iA.y + p.z, 1.0);
    gl_Position = projectionMatrix * viewMatrix * world;

    // Sensor values. Heat: core (head, torso) hottest, limbs cooling toward hands and feet.
    float limbW = isArm + isLeg > 0.5 ? 0.72 + 0.28 * aLimbT : 0.6 * eq(part, 0.0);
    float heat = mix(iC.x, iC.y, limbW) * (0.94 + 0.06 * max(n.y, 0.0));
    // Visible light: soft moonlight from above gives the figure some shape on night vision.
    float shade = 0.6 + 0.4 * clamp(n.y * 0.7 + 0.35, 0.0, 1.0);
    float vis = iC.z * shade;
    float nir = 0.0;
    if (part > 5.5 && part < 6.5) { heat = 0.0; vis = 0.42 * shade; }          // cold ID panel
    if (part > 6.5) { heat = 0.22; vis = 0.05 * uBlink; nir = uBlink; }         // IR strobe: night vision only
    vSig = vec3(heat, vis, nir);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vSig;
  void main() { gl_FragColor = vec4(vSig, 1.0); }
`;

export function makeFigureMaterial(kind: 'zombie' | 'survivor'): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uKind: { value: kind === 'zombie' ? 0 : 1 },
      uBlink: { value: 0 },
      uBase: { value: 1.05 },
      uScale: { value: FIGURE_SCALE },
    },
    vertexShader,
    fragmentShader,
  });
}

/** One instanced mesh of animated figures: geometry, material and per-instance buffers. */
export class FigureBatch {
  readonly mesh: THREE.Mesh;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly c: Float32Array;
  private geo: THREE.InstancedBufferGeometry;
  private attrs: THREE.InstancedBufferAttribute[];
  readonly material: THREE.ShaderMaterial;

  constructor(kind: 'zombie' | 'survivor', readonly capacity: number) {
    const base = buildFigureGeometry(kind === 'survivor');
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setIndex(base.index);
    for (const name of Object.keys(base.attributes)) this.geo.setAttribute(name, base.attributes[name]);
    this.a = new Float32Array(capacity * 4);
    this.b = new Float32Array(capacity * 4);
    this.c = new Float32Array(capacity * 4);
    this.attrs = [this.a, this.b, this.c].map((arr) => new THREE.InstancedBufferAttribute(arr, 4).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iA', this.attrs[0]);
    this.geo.setAttribute('iB', this.attrs[1]);
    this.geo.setAttribute('iC', this.attrs[2]);
    this.geo.instanceCount = 0;
    this.material = makeFigureMaterial(kind);
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.geo.instanceCount;
  }

  /** Mark the first `count` instances as changed and draw them. */
  commit(count: number): void {
    this.geo.instanceCount = count;
    for (const at of this.attrs) {
      at.clearUpdateRanges();
      if (count > 0) at.addUpdateRange(0, count * 4);
      at.needsUpdate = true;
    }
  }

  /** Per figure: vertices the shader animates, and triangles drawn. */
  get cost(): { vertices: number; triangles: number } {
    return { vertices: this.geo.attributes.position.count, triangles: (this.geo.index?.count ?? this.geo.attributes.position.count) / 3 };
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
