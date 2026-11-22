import * as THREE from 'three';

/**
 * Low-poly human figures with a skeleton that is animated entirely in the vertex shader.
 *
 * The figure is built once in code from 13 bones (pelvis, chest, head, upper arms, forearms with
 * hands, thighs, shins, feet) plus a cold ID panel for survivors, as one small indexed mesh. Every
 * vertex knows its bone; joint rings (elbows, knees, ankles) are shared half-and-half between the
 * two bones they join, so limbs bend without cracking. Each instance carries a few numbers (position,
 * heading, gait phase, time since death, pose weights for running, attacking and crouching, a
 * hit-reaction pulse, heat, a per-agent seed) and the shader poses the whole skeleton from them, so
 * one instanced draw call animates thousands of figures with no skinning on the CPU.
 *
 * Output colours are sensor values (R heat, G visible light, B near-infrared), not display colours.
 * See docs/STYLE.md for the palette and proportions.
 */
export const PART = {
  pelvis: 0,
  torso: 1,
  head: 2,
  upperArmL: 3,
  forearmL: 4,
  upperArmR: 5,
  forearmR: 6,
  thighL: 7,
  shinL: 8,
  footL: 9,
  thighR: 10,
  shinR: 11,
  footR: 12,
  panel: 13,
} as const;

/** Figures are drawn larger than life (about 2.7 m) so their poses read from the gunship. */
export const FIGURE_SCALE = 1.4;

// Rest pose joints, metres before scaling: standing, facing +z, feet at y = 0, +x is the figure's left.
// Proportions are stylised for reading from above at an angle: broad shoulders over a narrow waist,
// a slightly large head, long arms with a gap between arm and body.
const J = {
  hipC: 0.95, // pelvis pivot (centre between the hips)
  waist: 1.02, // chest pivot
  neck: 1.6, // head pivot
  shoX: 0.29,
  shoY: 1.53,
  elbY: 1.22,
  wriY: 0.96,
  handY: 0.82,
  armX: 0.3,
  hipX: 0.11,
  hipY: 0.93,
  kneeX: 0.115,
  kneeY: 0.5,
  ankX: 0.12,
  ankY: 0.09,
} as const;
const THIGH = J.hipY - J.kneeY;
const SHIN = J.kneeY - J.ankY;
const CHEST_BOTTOM = 1.0;
const CHEST_TOP = 1.62;
/** Top of the head above the feet in the rest pose, metres before scaling. */
export const HEAD_TOP = 1.95;

/**
 * Cold ID panel: side length and height of its centre (mid-chest), metres before scaling. It is
 * narrower than the chest (~0.5 m there), so warm shoulders, head, arms and hips frame it.
 */
export const PANEL_SIZE = 0.34;
export const PANEL_Y = 1.38;
/** The panel is drawn as if this much nearer the camera, so its own body never hides it. */
const PANEL_PULL = 0.9;
/** Height of a survivor's IR strobe above the feet (on top of the head), metres before scaling. */
export const STROBE_Y = HEAD_TOP + 0.05;

/** Collects vertices and outward-facing triangles for the figure, each vertex tagged with its bone. */
class FigureBuilder {
  pos: number[] = [];
  part: number[] = [];
  pivot: number[] = [];
  heatW: number[] = [];
  weight: number[] = [];
  idx: number[] = [];

  /** Adds a vertex: bone, its joint, heat weight (0 core … 1 hands and feet), and how much of its bone's own bend it takes. */
  v(x: number, y: number, z: number, part: number, pivot: readonly number[], heatW: number, w = 1): number {
    this.pos.push(x, y, z);
    this.part.push(part);
    this.pivot.push(pivot[0], pivot[1], pivot[2]);
    this.heatW.push(heatW);
    this.weight.push(w);
    return this.pos.length / 3 - 1;
  }

  /** Four vertices round a centre: front, left, back, right (a diamond seen from above). */
  ring(cx: number, cy: number, cz: number, rx: number, rz: number, part: number, pivot: readonly number[], heatW: number, w = 1): number[] {
    return [
      this.v(cx, cy, cz + rz, part, pivot, heatW, w),
      this.v(cx + rx, cy, cz, part, pivot, heatW, w),
      this.v(cx, cy, cz - rz, part, pivot, heatW, w),
      this.v(cx - rx, cy, cz, part, pivot, heatW, w),
    ];
  }

  /** Four vertices at the corners of a rectangle (a box section): front-left, back-left, back-right, front-right. */
  box(cx: number, cy: number, cz: number, hx: number, hz: number, part: number, pivot: readonly number[], heatW: number): number[] {
    return [
      this.v(cx + hx, cy, cz + hz, part, pivot, heatW),
      this.v(cx + hx, cy, cz - hz, part, pivot, heatW),
      this.v(cx - hx, cy, cz - hz, part, pivot, heatW),
      this.v(cx - hx, cy, cz + hz, part, pivot, heatW),
    ];
  }

  /** A triangle, wound so its face points away from `inside`. */
  tri(a: number, b: number, c: number, inside: readonly number[]): void {
    const P = (i: number) => new THREE.Vector3(this.pos[i * 3], this.pos[i * 3 + 1], this.pos[i * 3 + 2]);
    const A = P(a);
    const n = P(b).sub(A).cross(P(c).sub(A));
    const centroid = A.add(P(b)).add(P(c)).divideScalar(3);
    const out = centroid.sub(new THREE.Vector3(inside[0], inside[1], inside[2]));
    if (n.dot(out) >= 0) this.idx.push(a, b, c);
    else this.idx.push(a, c, b);
  }

  /** The tube between two rings of four. */
  bridge(r0: number[], r1: number[], inside: readonly number[]): void {
    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4;
      this.tri(r0[i], r0[j], r1[j], inside);
      this.tri(r0[i], r1[j], r1[i], inside);
    }
  }

  /** Closes a ring of four with two triangles. */
  cap(r: number[], inside: readonly number[]): void {
    this.tri(r[0], r[1], r[2], inside);
    this.tri(r[0], r[2], r[3], inside);
  }

  /** Closes a ring of four to a point. */
  fan(r: number[], tip: number, inside: readonly number[]): void {
    for (let i = 0; i < 4; i++) this.tri(r[i], r[(i + 1) % 4], tip, inside);
  }
}

/**
 * The rest pose: standing, facing +z, feet at y = 0, about 1.93 m tall (drawn at FIGURE_SCALE).
 * 76 vertices and 116 triangles (80 and 118 with the survivor's panel).
 */
export function buildFigureGeometry(withSurvivorKit: boolean): THREE.BufferGeometry {
  const b = new FigureBuilder();
  const P0 = [0, J.hipC, 0];
  const W = [0, J.waist, 0];
  const N = [0, J.neck, 0];

  // Torso: one tube of four box sections. The crotch ring belongs to the pelvis; the waist, upper
  // chest and the base of the neck belong to the chest. Broad upper chest, sloping shoulders, a
  // narrower waist: reads as a person (not a box) from above. Heat weights: the clothed body sits
  // between the hot head and the cool hands and feet.
  const pel = b.box(0, 0.84, -0.005, 0.18, 0.11, PART.pelvis, P0, 0.8);
  const waist = b.box(0, CHEST_BOTTOM, 0, 0.22, 0.12, PART.torso, W, 0.74);
  const chest = b.box(0, 1.51, 0.015, 0.27, 0.14, PART.torso, W, 0.66);
  const neckBase = b.box(0, CHEST_TOP, 0.0, 0.16, 0.1, PART.torso, W, 0.62);
  b.bridge(pel, waist, [0, 0.95, 0]);
  b.bridge(waist, chest, [0, 1.25, 0]);
  b.bridge(chest, neckBase, [0, 1.5, 0]);
  b.cap(neckBase, [0, 1.5, 0]);

  // Head: an octahedron whose lowest point is the neck and whose front point is the face; slightly
  // large, so it stays a distinct shape (and the hottest spot) above the shoulders.
  const hc = [0, 1.79, 0.02];
  const hTop = b.v(0, HEAD_TOP, 0.0, PART.head, N, 0);
  const hNeck = b.v(0, 1.57, -0.01, PART.head, N, 0.1);
  const hRing = [
    b.v(0, 1.77, 0.17, PART.head, N, 0),
    b.v(0.14, 1.8, 0.0, PART.head, N, 0),
    b.v(0, 1.81, -0.13, PART.head, N, 0),
    b.v(-0.14, 1.8, 0.0, PART.head, N, 0),
  ];
  b.fan(hRing, hTop, hc);
  b.fan(hRing, hNeck, hc);

  for (const s of [1, -1]) {
    const L = s > 0;
    // Arm: shoulder ring (capped), elbow ring shared with the forearm, wrist ring, and a hand that tapers to the fingertips.
    const ua = L ? PART.upperArmL : PART.upperArmR;
    const fa = L ? PART.forearmL : PART.forearmR;
    const S = [s * J.shoX, J.shoY, 0];
    const E = [s * J.armX, J.elbY, 0];
    const sh = b.ring(s * J.shoX, J.shoY + 0.04, 0, 0.085, 0.085, ua, S, 0.74);
    const el = b.ring(s * J.armX, J.elbY, 0, 0.062, 0.062, fa, E, 0.84, 0.5);
    const wr = b.ring(s * J.armX, J.wriY, 0.005, 0.05, 0.045, fa, E, 0.93);
    const tip = b.v(s * J.armX, J.handY, 0.02, fa, E, 1);
    b.cap(sh, [s * J.shoX, J.shoY - 0.1, 0]);
    b.bridge(sh, el, [s * J.armX, (J.shoY + J.elbY) / 2, 0]);
    b.bridge(el, wr, [s * J.armX, (J.elbY + J.wriY) / 2, 0]);
    b.fan(wr, tip, [s * J.armX, J.wriY - 0.04, 0]);

    // Leg: hip ring (inside the pelvis), knee ring shared with the shin, ankle ring shared with the foot, and a wedge of a shoe.
    const th = L ? PART.thighL : PART.thighR;
    const sn = L ? PART.shinL : PART.shinR;
    const ft = L ? PART.footL : PART.footR;
    const H = [s * J.hipX, J.hipY, 0];
    const K = [s * J.kneeX, J.kneeY, 0];
    const A = [s * J.ankX, J.ankY, 0];
    const hp = b.ring(s * J.hipX, 0.95, 0, 0.1, 0.1, th, H, 0.82);
    const kn = b.ring(s * J.kneeX, J.kneeY, 0.01, 0.072, 0.072, sn, K, 0.9, 0.5);
    const an = b.ring(s * J.ankX, J.ankY + 0.01, 0, 0.055, 0.055, ft, A, 0.96, 0.5);
    b.bridge(hp, kn, [s * J.hipX, (0.95 + J.kneeY) / 2, 0]);
    b.bridge(kn, an, [s * J.kneeX, (J.kneeY + J.ankY) / 2, 0]);
    const toeO = b.v(s * (J.ankX + 0.05), 0, 0.19, ft, A, 1);
    const toeI = b.v(s * (J.ankX - 0.04), 0, 0.19, ft, A, 1);
    const fIn = [s * J.ankX, 0.065, 0.08]; // inside the shoe wedge, between its top and its sole
    // an: 0 front, 1 left (+x), 2 back, 3 right (-x); outer is +x on the left leg, -x on the right.
    // No sole: it is never seen from above.
    const out = L ? an[1] : an[3];
    const inn = L ? an[3] : an[1];
    b.tri(an[0], toeO, toeI, fIn);
    b.tri(out, toeO, an[0], fIn);
    b.tri(inn, an[0], toeI, fIn);
  }

  if (withSurvivorKit) {
    // Cold ID panel: a dark square on thermal, worn mid-chest. It is a flat square that the shader
    // turns to face the camera and draws just in front of the body, so from any heading it shows
    // as a dark square inside the warm outline (head and shoulders above, arms beside, hips below).
    // Its pivot is its centre.
    const h = PANEL_SIZE / 2;
    const C = [0, PANEL_Y, 0];
    const q = [b.v(-h, PANEL_Y - h, 0, PART.panel, C, 0), b.v(h, PANEL_Y - h, 0, PART.panel, C, 0), b.v(h, PANEL_Y + h, 0, PART.panel, C, 0), b.v(-h, PANEL_Y + h, 0, PART.panel, C, 0)];
    b.idx.push(q[0], q[1], q[2], q[0], q[2], q[3]);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(b.part, 1));
  g.setAttribute('aPivot', new THREE.Float32BufferAttribute(b.pivot, 3));
  // 0 at the head and chest, 1 at the hands and feet: extremities run cooler on thermal.
  g.setAttribute('aLimbT', new THREE.Float32BufferAttribute(b.heatW, 1));
  g.setAttribute('aW', new THREE.Float32BufferAttribute(b.weight, 1));
  g.setIndex(b.idx);
  g.computeVertexNormals();
  return g;
}

const f = (x: number) => x.toFixed(4);
const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uKind;   // 0 zombies, 1 survivors
  uniform float uBase;   // height of the feet above the map's zero (roads sit at 1 m)
  uniform float uScale;  // overall size: larger than life so figures read from the gunship
  attribute float aPart;
  attribute vec3 aPivot;
  attribute float aLimbT;
  attribute float aW;
  attribute vec4 iA; // x, z, heading, gait phase (radians)
  attribute vec4 iB; // seconds since death (-1 alive), gait amplitude, seed 0-1, fall direction (body frame, radians)
  attribute vec4 iC; // core heat, limb heat, visible-light scale, hit reaction 0-1
  attribute vec4 iD; // run weight, attack weight, crouch weight, hit direction (body frame, radians)
  varying vec3 vSig;

  mat3 rotX(float a) { float c = cos(a), s = sin(a); return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c); }
  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
  float eq(float v, float k) { return 1.0 - step(0.5, abs(v - k)); }

  // Thigh and knee angles for one leg (s = +1 left, -1 right). Positive thigh swings the leg back;
  // positive knee folds the shin back.
  vec2 legAngles(float s, float sw, float cw, float amp, float runW, float crouch, float zombie, float limpSide, float limpAmt) {
    float fwd = s * sw;                 // > 0: this leg is ahead
    float swing = max(0.0, s * cw);     // > 0: this leg is swinging forward (foot lifted)
    float limp = 1.0 - limpAmt * step(0.0, s * limpSide);   // the dragged leg: short, stiff steps
    float stride = amp * mix(0.36, 0.62, runW) * limp;
    float thigh = -stride * fwd - crouch * 1.3 - zombie * 0.14 - 0.25 * runW * swing;
    float knee = 0.05 + zombie * 0.16 + amp * mix(0.55, 1.35, runW) * swing * limp + runW * 0.5 * max(0.0, -fwd) + crouch * 2.15;
    return vec2(thigh, knee);
  }
  float legHeight(vec2 a) { return ${f(THIGH)} * cos(a.x) + ${f(SHIN)} * cos(a.x + a.y) + ${f(J.ankY)}; }

  void main() {
    float age = iB.x;
    float dead = step(0.0, age);
    float amp = iB.y;
    float seed = iB.z;
    float fallDir = iB.w;
    float runW = iD.x;
    float atk = iD.y;
    float crouch = iD.z;
    float reactDir = iD.w;
    float zombie = 1.0 - step(0.5, uKind);
    float r1 = fract(seed * 7.31 + 0.13);
    float r2 = fract(seed * 13.77 + 0.41);
    float r3 = fract(seed * 29.13 + 0.07);
    float r4 = fract(seed * 53.91 + 0.29);
    float r5 = fract(seed * 97.37 + 0.61);
    float r6 = fract(seed * 151.7 + 0.83);
    float ph = iA.w;
    float sw = sin(ph);
    float cw = cos(ph);

    float part = aPart;
    float isPelvis = eq(part, 0.0);
    float isChest = eq(part, 1.0);
    float isHead = eq(part, 2.0);
    float isUA = eq(part, 3.0) + eq(part, 5.0);
    float isFA = eq(part, 4.0) + eq(part, 6.0);
    float isTh = eq(part, 7.0) + eq(part, 10.0);
    float isSh = eq(part, 8.0) + eq(part, 11.0);
    float isFt = eq(part, 9.0) + eq(part, 12.0);
    float isPanel = eq(part, 13.0);
    float isArm = isUA + isFA;
    float isLeg = isTh + isSh + isFt;
    // +1 for the left limbs (+x), -1 for the right.
    float side = (eq(part, 3.0) + eq(part, 4.0) + eq(part, 7.0) + eq(part, 8.0) + eq(part, 9.0)) * 2.0 - 1.0;

    // ---- Death: knees buckle, the body topples (accelerating like gravity), bounces once, limbs splay.
    float buckle = dead * smoothstep(0.0, 0.25, age);
    float ft = clamp((age - 0.06) / 0.6, 0.0, 1.0);
    float fall = dead * ft * ft;
    float settle = dead * smoothstep(0.5, 1.1, age);
    float bounce = dead * sin(clamp((age - 0.66) / 0.24, 0.0, 1.0) * 3.1416) * 0.08;
    float live = 1.0 - fall;
    float react = iC.w * (1.0 - dead);
    float sink = iC.w * dead;   // bodies: how far through sinking out of sight (spec 003 body cap), 0-1
    float idleW = (1.0 - dead) * (1.0 - clamp(amp * 3.0, 0.0, 1.0)) * (1.0 - crouch) * (1.0 - zombie);

    // ---- Legs (both, so the standing leg sets the hip height and the feet stay on the ground).
    float limpSide = r1 > 0.5 ? 1.0 : -1.0;
    float limpAmt = zombie * (0.3 + 0.45 * r5);
    vec2 legL = legAngles(1.0, sw, cw, amp, runW, crouch, zombie, limpSide, limpAmt);
    vec2 legR = legAngles(-1.0, sw, cw, amp, runW, crouch, zombie, limpSide, limpAmt);
    // Buckling knees on death; lying, the legs straighten with one knee bent.
    vec2 buck = vec2(-0.55, 0.9) * buckle * (1.0 - settle);
    legL += buck;
    legR += buck;
    float bentL = r4 > 0.5 ? 1.0 : 0.0;
    legL = mix(legL, vec2(-0.25 * bentL, 0.9 * bentL + 0.05), settle);
    legR = mix(legR, vec2(-0.25 * (1.0 - bentL), 0.9 * (1.0 - bentL) + 0.05), settle);
    float drop = (${f(J.hipY)} - max(legHeight(legL), legHeight(legR))) * (1.0 - fall);
    vec2 leg = side > 0.0 ? legL : legR;
    float legSplay = side * (0.03 + zombie * 0.05 + 0.12 * crouch + settle * (0.12 + 0.25 * r3));
    mat3 rThigh = rotZ(legSplay) * rotX(leg.x);
    mat3 rShin = rotX(leg.y);
    mat3 rFoot = rotX(-(leg.x + leg.y) * 0.85 * (1.0 - settle) + settle * 0.6);

    // ---- Pelvis and chest.
    float pTwist = 0.14 * amp * sw * live;
    float pRoll = (0.05 * amp * cw + zombie * 0.06 * limpAmt * limpSide * sw) * live;
    mat3 rPelvis = rotY(pTwist) * rotZ(pRoll);
    float claw = sin(uTime * 7.5 + seed * 40.0);
    float leanZ = 0.4 + 0.25 * r4 + 0.22 * runW + atk * (0.18 + 0.12 * claw);
    float leanS = 0.06 + 0.3 * runW + 0.62 * crouch;
    float lean = mix(leanS, leanZ, zombie);
    lean = mix(lean + 0.35 * buckle, 0.0, settle);
    float roll = mix(0.035 * amp * sw, 0.13 * amp * sw + (r1 - 0.5) * 0.25, zombie) * (1.0 - settle);
    float twist = mix(-0.2 * amp * sw, 0.1 * amp * sw, zombie) * (1.0 - settle);
    // A blast throws the upper body away from it, then it recovers.
    vec2 push = vec2(sin(reactDir), cos(reactDir));
    mat3 rReact = rotX(0.6 * react * push.y) * rotZ(-0.6 * react * push.x);
    mat3 rChest = rReact * rotY(twist) * rotZ(roll) * rotX(lean);

    // ---- Head: zombies loll and bob; survivors look around when standing; a blast snaps it back.
    float hPitch = mix(-lean * 0.7 - 0.05, -lean * 0.55 + 0.12 * sin(ph * 2.0) + atk * 0.3 * sin(uTime * 7.5 + seed * 40.0 + 1.3), zombie);
    hPitch += -0.55 * react;
    float hYaw = idleW * 0.8 * sin(uTime * 0.9 + seed * 20.0) + settle * (r5 - 0.5) * 2.0;
    float hRoll = zombie * (r2 - 0.5) * 0.8 * (1.0 - 0.5 * atk);
    mat3 rHead = rotY(hYaw) * rotZ(hRoll) * rotX(hPitch * (1.0 - settle));

    // ---- Arms. Target pitches are relative to the world (0 hanging, -1.57 straight ahead, -3.14 up);
    //      the chest's lean is taken off so the arms keep their aim however hunched the body is.
    float rs = side > 0.0 ? r5 : r6;
    float zReach = -(1.2 + 0.3 * r2) + (rs - 0.5) * 0.4 - 0.25 * runW + 0.2 * amp * sin(ph + side * 1.3);
    zReach = mix(zReach, -1.05 - 0.8 * side * sw, runW * runW);                 // sprinters flail
    float dangle = step(0.72, r3) * step(0.0, side);                                // some let one arm hang
    zReach = mix(zReach, -0.15 + 0.3 * side * sw * amp, dangle * (1.0 - runW));
    zReach = mix(zReach, -1.8 + 0.75 * sin(uTime * 7.5 + seed * 40.0 + side * 2.1), atk); // clawing
    float sReach = amp * (0.45 + 0.5 * runW) * side * sw - 0.2 * runW;            // swing opposite the legs
    sReach = mix(sReach, -0.5 + 0.06 * sin(uTime * 1.3 + seed * 9.0), idleW);         // alert: hands up
    sReach = mix(sReach, -2.65, crouch);                                              // cowering: hands over head
    float reach = mix(sReach, zReach, zombie);
    reach = mix(reach, -2.5, react * 0.6);
    reach = mix(reach, -2.4, buckle * (1.0 - settle) * 0.6);                          // flung up as it falls
    reach = mix(reach, rs > 0.5 ? -2.75 : -0.35, settle);                             // lying: overhead or by its side
    float armPitch = reach - lean;
    float abd = mix(0.08 + 0.32 * crouch + 0.05 * idleW, 0.1 + 0.22 * r4 + 0.15 * atk, zombie) + 0.5 * react;
    abd = mix(abd, 0.3 + 0.9 * rs, settle);
    float elbowS = mix(mix(-0.3 - 0.25 * amp, -1.55, runW), -1.15, idleW);
    elbowS = mix(elbowS, -2.3, crouch);
    float elbowZ = -0.15 - 0.3 * r1 - 0.7 * runW * runW - 0.45 * atk * (0.5 + 0.5 * claw);
    float elbow = mix(mix(elbowS, elbowZ, zombie), -0.3 * rs, settle);
    mat3 rUpper = rotZ(side * abd) * rotX(armPitch);
    mat3 rFore = rotX(elbow);

    // ---- Skin the vertex: its own bone (joint rings take half), then each parent up to the pelvis.
    vec3 corner = (position - aPivot) * isPanel * (1.0 - dead);
    vec3 p = mix(position, aPivot, isPanel);
    vec3 n = normal;
    if (isLeg > 0.5) {
      vec3 A = vec3(side * ${f(J.ankX)}, ${f(J.ankY)}, 0.0);
      vec3 K = vec3(side * ${f(J.kneeX)}, ${f(J.kneeY)}, 0.0);
      vec3 H = vec3(side * ${f(J.hipX)}, ${f(J.hipY)}, 0.0);
      if (isFt > 0.5) { p = A + mix(p - A, rFoot * (p - A), aW); n = mix(n, rFoot * n, aW); }
      if (isFt + isSh > 0.5) {
        float w = isSh > 0.5 ? aW : 1.0;
        p = K + mix(p - K, rShin * (p - K), w);
        n = mix(n, rShin * n, w);
      }
      p = H + rThigh * (p - H);
      n = rThigh * n;
    } else if (isPelvis < 0.5) {
      if (isArm > 0.5) {
        vec3 E = vec3(side * ${f(J.armX)}, ${f(J.elbY)}, 0.0);
        vec3 S = vec3(side * ${f(J.shoX)}, ${f(J.shoY)}, 0.0);
        if (isFA > 0.5) { p = E + mix(p - E, rFore * (p - E), aW); n = mix(n, rFore * n, aW); }
        p = S + rUpper * (p - S);
        n = rUpper * n;
      }
      if (isHead > 0.5) {
        vec3 N = vec3(0.0, ${f(J.neck)}, 0.0);
        p += zombie * vec3(0.0, -0.05, 0.1);     // zombies' heads jut forward of the shoulders
        p = N + rHead * (p - N);
        n = rHead * n;
      }
      vec3 W = vec3(0.0, ${f(J.waist)}, 0.0);
      p = W + rChest * (p - W);
      n = rChest * n;
    }
    vec3 P0 = vec3(0.0, ${f(J.hipC)}, 0.0);
    p = P0 + rPelvis * (p - P0);
    n = rPelvis * n;

    // ---- The whole body: sink onto the standing leg, get shoved by a blast, per-agent build, fall, heading.
    p.y -= drop;
    p.xz += push * 0.3 * react;
    float h = mix(0.95 + 0.1 * r3, 0.9 + 0.2 * r3, zombie);
    float w = mix(1.0, 0.92 + 0.22 * r1, zombie);
    p *= vec3(w, h, w);
    mat3 rFall = rotY(fallDir) * rotX(fall * 1.5708 - bounce) * rotY(-fallDir);
    p = rFall * p;
    n = rFall * n;
    p.y += 0.13 * fall;
    // A dead survivor's panel is gone: collapse it to a point.
    if (dead > 0.5 && isPanel > 0.5) p = vec3(0.0);
    p *= uScale;
    mat3 rYaw = rotY(iA.z + zombie * (r4 - 0.5) * 0.3 * live);
    p = rYaw * p;
    n = normalize(rYaw * n);

    vec4 world = modelMatrix * vec4(iA.x + p.x, uBase + p.y - sink * ${f(1.6)}, iA.y + p.z, 1.0);
    vec4 mv = viewMatrix * world;
    if (isPanel > 0.5) {
      mv.xy += corner.xy * uScale;                                  // a square facing the camera
      mv.xyz += normalize(-mv.xyz) * ${f(PANEL_PULL)};               // just in front of its own body
    }
    gl_Position = projectionMatrix * mv;

    // ---- Sensor values.
    // Surfaces seen edge-on radiate less (emissivity falls at grazing angles), so each figure has a
    // cooler outline and rounded shading: overlapping bodies stay separate in a crowd.
    vec3 V = normalize(cameraPosition - world.xyz);
    float facing = max(dot(n, V), 0.0);
    float edge = mix(0.5, 1.0, smoothstep(0.05, 0.7, facing));
    // Heat: head and chest hottest, cooling down the limbs to the hands and feet. Some zombies have
    // bare forearms (hotter), some sleeves (cooler); limb heat varies a little between zombies.
    float sleeves = step(0.5, r6);
    float hw = aLimbT + isFA * (sleeves * 0.04 - (1.0 - sleeves) * 0.15 * step(aLimbT, 0.95));
    float warm = clamp((iC.y - 0.2) / 0.3, 0.0, 1.0);    // 0 for cold-blooded zombies: no variation at all
    float limbHeat = iC.y + (r2 - 0.5) * 0.1 * warm;
    float heat = mix(iC.x, limbHeat, clamp(hw, 0.0, 1.0));
    heat = 0.2 + (heat - 0.2) * edge;
    // Visible light: clothes and skin under soft moonlight from above. Zombie clothes are grimy and
    // vary a lot (a crowd of individuals on night vision); survivors' are a little brighter.
    float skin = isHead + isFA * step(0.99, aLimbT) + isFA * (1.0 - sleeves) * zombie * step(aLimbT, 0.95);
    float shirt = mix(mix(0.26, 0.36, r5), mix(0.12, 0.34, r5), zombie);
    float trousers = mix(mix(0.15, 0.22, r6), mix(0.09, 0.25, r3), zombie);
    float albedo = (isChest + isUA + isFA) * shirt + (isPelvis + isTh + isSh) * trousers + isFt * 0.08;
    albedo = mix(albedo, mix(0.34, 0.42, zombie), clamp(skin, 0.0, 1.0));   // zombies' pale skin glows on night vision
    float moon = clamp(dot(n, normalize(vec3(-0.35, 1.0, 0.45))), 0.0, 1.0);
    float vis = albedo * (0.45 + 0.55 * moon) * mix(0.8, 1.0, edge) * (iC.z / 0.36);
    float nir = 0.0;
    if (isPanel > 0.5) { heat = 0.0; vis = iC.z * 0.9; }                         // cold ID panel: thermal only
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
      uBase: { value: 1.05 },
      uScale: { value: FIGURE_SCALE },
    },
    vertexShader,
    fragmentShader,
  });
}

/** Per-instance floats: four vec4s (see the shader's iA-iD). */
const PER = 4;

/** One instanced mesh of animated figures: geometry, material and per-instance buffers. */
export class FigureBatch {
  readonly mesh: THREE.Mesh;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly c: Float32Array;
  readonly d: Float32Array;
  private geo: THREE.InstancedBufferGeometry;
  private attrs: THREE.InstancedBufferAttribute[];
  readonly material: THREE.ShaderMaterial;

  constructor(kind: 'zombie' | 'survivor', readonly capacity: number) {
    const base = buildFigureGeometry(kind === 'survivor');
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setIndex(base.index);
    for (const name of Object.keys(base.attributes)) this.geo.setAttribute(name, base.attributes[name]);
    this.a = new Float32Array(capacity * PER);
    this.b = new Float32Array(capacity * PER);
    this.c = new Float32Array(capacity * PER);
    this.d = new Float32Array(capacity * PER);
    this.attrs = [this.a, this.b, this.c, this.d].map((arr) => new THREE.InstancedBufferAttribute(arr, PER).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('iA', this.attrs[0]);
    this.geo.setAttribute('iB', this.attrs[1]);
    this.geo.setAttribute('iC', this.attrs[2]);
    this.geo.setAttribute('iD', this.attrs[3]);
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
      if (count > 0) at.addUpdateRange(0, count * PER);
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

/**
 * Survivors' IR strobes: one additive point sprite each, one draw call. They write near-infrared
 * only (R = 0 heat, G = 0 visible, B = strobe), and add rather than cover, so the thermal picture
 * is untouched by them (the panel and warm head show through) while night vision sees the blink.
 * Each sprite is about STROBE_M metres across, but never smaller than STROBE_MIN_PX pixels.
 */
const STROBE_M = 1.1;
const STROBE_MIN_PX = 4;
export class StrobeSprites {
  readonly mesh: THREE.Points;
  readonly material: THREE.ShaderMaterial;
  /** x, y, z per strobe. */
  readonly pos: Float32Array;
  private geo = new THREE.BufferGeometry();
  private attr: THREE.BufferAttribute;

  constructor(readonly capacity: number) {
    this.pos = new Float32Array(capacity * 3);
    this.attr = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('position', this.attr);
    this.geo.setDrawRange(0, 0);
    this.material = new THREE.ShaderMaterial({
      uniforms: { uBlink: { value: 0 }, uSize: { value: STROBE_M }, uMinPx: { value: STROBE_MIN_PX }, uViewH: { value: 720 } },
      vertexShader: /* glsl */ `
        uniform float uSize, uMinPx, uViewH;
        void main() {
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_Position = projectionMatrix * mv;
          // World size to pixels: projection[1][1] is 1 / tan(fov / 2); uViewH is the drawing-buffer height.
          gl_PointSize = max(uMinPx, uSize * projectionMatrix[1][1] * uViewH * 0.5 / -mv.z);
        }
      `,
      fragmentShader: /* glsl */ `
        uniform float uBlink;
        void main() {
          vec2 d = gl_PointCoord - 0.5;
          float r = dot(d, d) * 4.0;          // 0 centre, 1 at the edge
          float a = clamp(1.0 - r, 0.0, 1.0);
          gl_FragColor = vec4(0.0, 0.0, uBlink * a * (0.35 + 0.65 * a), 1.0);
        }
      `,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.mesh = new THREE.Points(this.geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 3;
    // Sprite size is in pixels of whatever it is drawn into (the composer's target, or the canvas).
    const size = new THREE.Vector2();
    this.mesh.onBeforeRender = (renderer) => {
      const rt = renderer.getRenderTarget();
      this.material.uniforms.uViewH.value = rt ? rt.height : renderer.getDrawingBufferSize(size).y;
    };
  }

  get count(): number {
    return this.geo.drawRange.count;
  }

  /** Draw the first `count` strobes from `pos`. */
  commit(count: number): void {
    this.geo.setDrawRange(0, count);
    this.attr.clearUpdateRanges();
    if (count > 0) this.attr.addUpdateRange(0, count * 3);
    this.attr.needsUpdate = true;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}
