import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { makeSampleTown } from '../map/sample';
import { createSim } from '../sim/setup';
import type { Sim } from '../sim/sim';
import { buildWorld, type World } from '../world/buildWorld';
import { SensorShader } from '../render/sensors';
import { AgentsView } from '../game/agentsView';
import { audio, type ClipHandle } from '../audio/engine';
import { INTRO_VOICE, SFX } from '../audio/assets';
import { wantsStill as stillNow, buildMotionNote } from './motion';
import { el } from './dom';
import { rememberIntro } from './introSeen';
import {
  BEAT,
  CHANNEL_BUG,
  INTRO_END,
  INTRO_LINES,
  LOWER_THIRD,
  MUTE_AT,
  SQUELCH_AT,
  TICKER_MAX_PX_S,
  captionAt,
  easeOut,
  quadMatrix,
  ramp,
  shotAt,
  slideAt,
  speakingAt,
  tickerText,
  type SlideId,
} from './introScript';

/**
 * "The Late Bulletin": the 44 s intro (docs/story/intro.md), drawn live in one WebGL context.
 *
 * Shot 1: a chunky TV in the dark showing an invented bulletin: the newsreader in a flat-shaded
 * studio, and a LIVE inset of white-hot footage from our own renderer (the sample town's sim and
 * figures through the game's sensor shader: never a real place). Shot 2: a slow dolly back reveals
 * a wall of monitors in a blocky command room (the briefing diorama's look: display colours, light
 * baked into vertex colours). Shot 3: Commander Quill turns; the monitors follow her words. Shot 4:
 * Spooky circles overhead, seen from the street on a white-hot ground camera. Shot 5: the title.
 *
 * Text (lower third, ticker, captions, title) is HTML via textContent. Sound is the recorded
 * voiceover through the shared audio engine, started at the script's times; captions are always
 * on, so it works muted or before sound is unlocked. Reduced motion or "reduce flicker": no camera
 * moves, a slideshow of key frames that dissolve into each other, with the same audio.
 * Photosensitivity: every change is a dissolve or a slow move; nothing flashes.
 */

// ---------------------------------------------------------------------------------------------
// Geometry: flat-shaded blocks with colours baked in (like the briefing diorama)
// ---------------------------------------------------------------------------------------------

type V3 = [number, number, number];
type Shade = (n: THREE.Vector3, c: THREE.Vector3) => number;

const hexRGB = (hex: number): V3 => [((hex >> 16) & 255) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];

class Mesher {
  pos: number[] = [];
  col: number[] = [];
  uv: number[] = [];
  uvB: number[] = [];
  slot: number[] = [];
  private n = new THREE.Vector3();
  private c = new THREE.Vector3();
  private e1 = new THREE.Vector3();
  private e2 = new THREE.Vector3();
  constructor(private shade: Shade | null = null) {}

  /** A quad a-b-c-d (counter-clockwise seen from its front). `rgb` is a colour (or sensor values). */
  quad(a: V3, b: V3, c: V3, d: V3, rgb: V3, o: { uv?: number[]; uvB?: number[]; slot?: number } = {}): void {
    this.e1.set(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    this.e2.set(c[0] - a[0], c[1] - a[1], c[2] - a[2]);
    this.n.crossVectors(this.e1, this.e2).normalize();
    this.c.set((a[0] + c[0]) / 2, (a[1] + c[1]) / 2, (a[2] + c[2]) / 2);
    const s = this.shade ? this.shade(this.n, this.c) : 1;
    const uv = o.uv ?? [0, 0, 1, 1];
    const uvB = o.uvB ?? uv;
    const corner = (q: number[], k: number) => [k === 0 || k === 3 ? q[0] : q[2], k < 2 ? q[1] : q[3]];
    for (const k of [0, 1, 2, 0, 2, 3]) {
      const p = [a, b, c, d][k];
      this.pos.push(...p);
      this.col.push(rgb[0] * s, rgb[1] * s, rgb[2] * s);
      this.uv.push(...corner(uv, k));
      this.uvB.push(...corner(uvB, k));
      this.slot.push(o.slot ?? -1);
    }
  }

  /** A box centred at (x, y, z), turned `ry` about its vertical axis. `skip` leaves out faces ('-z', 'top'...). */
  box(x: number, y: number, z: number, sx: number, sy: number, sz: number, hex: number | V3, ry = 0, skip: string[] = []): void {
    const rgb = typeof hex === 'number' ? hexRGB(hex) : hex;
    const cs = Math.cos(ry);
    const sn = Math.sin(ry);
    const P = (dx: number, dy: number, dz: number): V3 => [x + (dx * cs + dz * sn) * sx * 0.5, y + dy * sy * 0.5, z + (-dx * sn + dz * cs) * sz * 0.5];
    const faces: [string, V3, V3, V3, V3][] = [
      ['+z', P(-1, -1, 1), P(1, -1, 1), P(1, 1, 1), P(-1, 1, 1)],
      ['-z', P(1, -1, -1), P(-1, -1, -1), P(-1, 1, -1), P(1, 1, -1)],
      ['+x', P(1, -1, 1), P(1, -1, -1), P(1, 1, -1), P(1, 1, 1)],
      ['-x', P(-1, -1, -1), P(-1, -1, 1), P(-1, 1, 1), P(-1, 1, -1)],
      ['top', P(-1, 1, 1), P(1, 1, 1), P(1, 1, -1), P(-1, 1, -1)],
      ['bottom', P(-1, -1, -1), P(1, -1, -1), P(1, -1, 1), P(-1, -1, 1)],
    ];
    for (const [id, a, b, c, d] of faces) if (!skip.includes(id)) this.quad(a, b, c, d, rgb);
  }

  /** A gable-roofed house: walls `w`×`h`×`d`, ridge along x, roof peak `rh` above the walls. */
  house(x: number, z: number, w: number, h: number, d: number, rh: number, wall: V3, roof: V3, ry = 0): void {
    this.box(x, h / 2, z, w, h, d, wall, ry, ['bottom']);
    const cs = Math.cos(ry);
    const sn = Math.sin(ry);
    const P = (dx: number, y: number, dz: number): V3 => [x + dx * cs + dz * sn, y, z - dx * sn + dz * cs];
    const hw = w / 2 + 0.3;
    const hd = d / 2 + 0.4;
    this.quad(P(-hw, h, hd), P(hw, h, hd), P(hw, h + rh, 0), P(-hw, h + rh, 0), roof);
    this.quad(P(hw, h, -hd), P(-hw, h, -hd), P(-hw, h + rh, 0), P(hw, h + rh, 0), roof);
    this.quad(P(hw, h, hd), P(hw, h, -hd), P(hw, h + rh, 0), P(hw, h + rh, 0), wall);
    this.quad(P(-hw, h, -hd), P(-hw, h, hd), P(-hw, h + rh, 0), P(-hw, h + rh, 0), wall);
  }

  build(extra = false): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.uv, 2));
    if (extra) {
      g.setAttribute('uvB', new THREE.Float32BufferAttribute(this.uvB, 2));
      g.setAttribute('slot', new THREE.Float32BufferAttribute(this.slot, 1));
    }
    g.computeVertexNormals();
    g.computeBoundingSphere();
    return g;
  }
}

/** A flat screen facing +z, centred at (x, y, z), turned `ry`. */
function screen(m: Mesher, x: number, y: number, z: number, w: number, h: number, o: { uv?: number[]; uvB?: number[]; slot?: number } = {}, ry = 0): void {
  const cs = Math.cos(ry);
  const sn = Math.sin(ry);
  const P = (dx: number, dy: number): V3 => [x + dx * cs, y + dy, z - dx * sn];
  m.quad(P(-w / 2, -h / 2), P(w / 2, -h / 2), P(w / 2, h / 2), P(-w / 2, h / 2), [1, 1, 1], o);
}

// ---------------------------------------------------------------------------------------------
// The monitors' pictures: one canvas atlas (gun silhouettes, map table, standby, orbit)
// ---------------------------------------------------------------------------------------------

const ATLAS = 1024;
/** Atlas regions in pixels: [x, y, w, h]. */
const REG = {
  tableIdle: [0, 0, 512, 288],
  tableLive: [512, 0, 512, 288],
  standby: [0, 288, 256, 144],
  g25: [256, 288, 256, 144],
  g40: [512, 288, 256, 144],
  g105: [768, 288, 256, 144],
  orbit: [0, 432, 256, 144],
  status: [256, 432, 256, 144],
} as const;
type Region = keyof typeof REG;
/** UV rectangle [u0, v0, u1, v1] of a region (canvas y runs down; flipY puts v up). */
const uvOf = (r: Region): number[] => {
  const [x, y, w, h] = REG[r];
  return [x / ATLAS, 1 - (y + h) / ATLAS, (x + w) / ATLAS, 1 - y / ATLAS];
};

/** Deterministic 0..1 hash (visual only). */
const hash = (i: number): number => {
  const s = Math.sin(i * 127.1 + 311.7) * 43758.5453;
  return s - Math.floor(s);
};

function drawAtlas(): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = cv.height = ATLAS;
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, ATLAS, ATLAS);
  const panel = (r: Region, bg: string) => {
    const [x, y, w, h] = REG[r];
    g.fillStyle = bg;
    g.fillRect(x, y, w, h);
    return [x, y, w, h] as const;
  };
  const ink = '#cfe9d4';
  const dim = 'rgba(184, 255, 138, 0.16)';
  // Standby: a calm dark panel with a faint grid.
  for (const r of ['standby', 'status'] as const) {
    const [x, y, w, h] = panel(r, '#0c1411');
    g.strokeStyle = dim;
    g.lineWidth = 1;
    for (let i = 1; i < 8; i++) {
      g.beginPath();
      g.moveTo(x + (w * i) / 8, y);
      g.lineTo(x + (w * i) / 8, y + h);
      g.stroke();
    }
    for (let i = 1; i < 4; i++) {
      g.beginPath();
      g.moveTo(x, y + (h * i) / 4);
      g.lineTo(x + w, y + (h * i) / 4);
      g.stroke();
    }
    if (r === 'status') {
      g.fillStyle = 'rgba(184, 255, 138, 0.55)';
      for (let i = 0; i < 6; i++) g.fillRect(x + 20, y + 22 + i * 18, 40 + hash(i) * 150, 7);
    }
  }
  // Orbit schematic: a ring with the gunship on it.
  {
    const [x, y, w, h] = panel('orbit', '#0c1411');
    g.strokeStyle = 'rgba(231, 239, 233, 0.7)';
    g.lineWidth = 3;
    g.setLineDash([10, 8]);
    g.beginPath();
    g.arc(x + w / 2, y + h / 2, h * 0.36, 0, Math.PI * 2);
    g.stroke();
    g.setLineDash([]);
    g.fillStyle = '#e7efe9';
    g.beginPath();
    g.arc(x + w / 2 + h * 0.36, y + h / 2, 7, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#b8ff8a';
    g.fillRect(x + w / 2 - 4, y + h / 2 - 4, 8, 8);
  }
  // The three guns, small to very large: plain silhouettes, labelled.
  const gun = (r: Region, label: string, barrel: number, thick: number, body: number) => {
    const [x, y, w, h] = panel(r, '#0e1713');
    g.fillStyle = ink;
    const cy = y + h * 0.42;
    const bx = x + w * 0.16;
    g.fillRect(bx, cy - body / 2, body * 1.3, body); // breech
    g.fillRect(bx + body * 1.3, cy - thick / 2, barrel, thick); // barrel
    g.fillRect(bx + body * 1.3 + barrel - 8, cy - thick / 2 - 2, 8, thick + 4); // muzzle
    g.fillRect(bx + body * 0.2, cy + body / 2, body * 0.5, h * 0.12); // mount
    g.font = 'bold 34px ui-monospace, Menlo, Consolas, monospace';
    g.textBaseline = 'alphabetic';
    g.fillText(label, x + 16, y + h - 16);
    g.font = 'bold 18px ui-monospace, Menlo, Consolas, monospace';
    g.fillStyle = 'rgba(207, 233, 212, 0.7)';
    g.fillText('MM', x + 22 + label.length * 21, y + h - 17);
  };
  gun('g25', '25', 112, 8, 24);
  gun('g40', '40', 124, 14, 34);
  gun('g105', '105', 132, 26, 52);
  // The map table: a generic street grid (no real map); the live version adds friendlies and safehouses.
  for (const r of ['tableIdle', 'tableLive'] as const) {
    const [x, y, w, h] = panel(r, '#0f1a15');
    g.fillStyle = '#1c2c23';
    for (let i = 0; i < 9; i++)
      for (let j = 0; j < 5; j++) {
        if (hash(i * 7 + j) < 0.18) continue;
        g.fillRect(x + 14 + i * 55, y + 14 + j * 55, 41, 41);
      }
    g.fillStyle = '#2b5638';
    g.fillRect(x + 14 + 3 * 55, y + 14 + 55, 96, 41); // a park
    g.strokeStyle = 'rgba(194, 144, 63, 0.75)';
    g.lineWidth = 5;
    g.beginPath();
    g.moveTo(x, y + 14 + 2 * 55 - 7);
    g.lineTo(x + w, y + 14 + 2 * 55 - 7);
    g.moveTo(x + 14 + 5 * 55 - 7, y);
    g.lineTo(x + 14 + 5 * 55 - 7, y + h);
    g.stroke();
    if (r === 'tableLive') {
      // Safehouses: green house shapes. Friendlies: blue diamonds. All steady.
      for (const [hx, hy] of [[130, 70], [390, 205]]) {
        g.fillStyle = '#b8ff8a';
        g.beginPath();
        g.moveTo(x + hx - 16, y + hy);
        g.lineTo(x + hx, y + hy - 16);
        g.lineTo(x + hx + 16, y + hy);
        g.lineTo(x + hx + 16, y + hy + 16);
        g.lineTo(x + hx - 16, y + hy + 16);
        g.closePath();
        g.fill();
      }
      g.fillStyle = '#5aa9ff';
      for (const [fx, fy] of [[200, 110], [255, 160], [320, 95], [92, 190], [440, 120]]) {
        g.beginPath();
        g.moveTo(x + fx, y + fy - 12);
        g.lineTo(x + fx + 12, y + fy);
        g.lineTo(x + fx, y + fy + 12);
        g.lineTo(x + fx - 12, y + fy);
        g.closePath();
        g.fill();
      }
      g.strokeStyle = 'rgba(184, 255, 138, 0.8)';
      g.lineWidth = 4;
      g.setLineDash([12, 9]);
      g.beginPath();
      g.moveTo(x + 200, y + 110);
      g.lineTo(x + 255, y + 160);
      g.lineTo(x + 390, y + 205);
      g.stroke();
      g.setLineDash([]);
    }
  }
  return cv;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

/** Wall monitors: each shows the bulletin or a standby picture, and crossfades to its live picture. */
const wallShader = {
  vertex: /* glsl */ `
    attribute vec2 uvB;
    attribute float slot;
    uniform float on[4];
    varying vec2 vA;
    varying vec2 vB;
    varying float vK;
    varying float vNews;
    void main() {
      vA = uv;
      vB = uvB;
      float k = 0.0;
      if (slot > -0.5 && slot < 0.5) k = on[0];
      else if (slot > 0.5 && slot < 1.5) k = on[1];
      else if (slot > 1.5 && slot < 2.5) k = on[2];
      else if (slot > 2.5) k = on[3];
      vK = k;
      // Slots 1-3 (the gun monitors) show the bulletin until they change.
      vNews = slot > 0.5 ? 1.0 : 0.0;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`,
  fragment: /* glsl */ `
    uniform sampler2D atlas;
    uniform sampler2D news;
    uniform float bright;
    varying vec2 vA;
    varying vec2 vB;
    varying float vK;
    varying float vNews;
    void main() {
      vec3 idle = vNews > 0.5 ? texture2D(news, vA).rgb : texture2D(atlas, vA).rgb;
      vec3 live = texture2D(atlas, vB).rgb;
      gl_FragColor = vec4(mix(idle, live, vK) * bright, 1.0);
    }`,
};

/** The two feed monitors: white-hot, and (slot 1) crossfading to night vision. */
const feedShader = {
  vertex: /* glsl */ `
    attribute float slot;
    varying vec2 vUv;
    varying float vS;
    void main() { vUv = uv; vS = slot; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
    uniform sampler2D white;
    uniform sampler2D night;
    uniform float k;
    uniform float bright;
    varying vec2 vUv;
    varying float vS;
    void main() {
      vec3 c = mix(texture2D(white, vUv).rgb, texture2D(night, vUv).rgb, vS > 0.5 ? k : 0.0);
      gl_FragColor = vec4(c * bright, 1.0);
    }`,
};

/** The last step: the current picture, dissolving from a held one. */
const composeShader = {
  vertex: /* glsl */ `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragment: /* glsl */ `
    uniform sampler2D cur;
    uniform sampler2D held;
    uniform float k;
    uniform float fade;
    varying vec2 vUv;
    void main() {
      vec3 c = mix(texture2D(held, vUv).rgb, texture2D(cur, vUv).rgb, k);
      gl_FragColor = vec4(c * fade, 1.0);
    }`,
};

// ---------------------------------------------------------------------------------------------
// The room (display colours, the briefing diorama's look)
// ---------------------------------------------------------------------------------------------

const TV = { x: 0, y: 1.36, z: 1.44, w: 1.12, h: 0.63 };
const QUILL = { x: -0.95, z: 2.55 };
const TABLE = { x0: -2.2, x1: 1.0, z0: 3.0, z1: 4.4, y: 0.92 };

/** Light baked into the room: monitor glow from the wall, a little from the map table and above. */
const roomShade: Shade = (n, c) => {
  const wall = Math.max(0, -n.z) * 0.55 + Math.max(0, n.z) * 0.38 + Math.max(0, n.y) * 0.3 + 0.32;
  const fall = Math.max(0.42, Math.min(1.05, 1.12 - c.z * 0.075));
  return wall * fall;
};

interface Quill {
  group: THREE.Group;
  armR: THREE.Group;
  elbowR: THREE.Group;
  armL: THREE.Group;
  elbowL: THREE.Group;
  handL: THREE.Object3D;
  head: THREE.Group;
  mug: THREE.Mesh;
}

function buildQuill(mat: THREE.Material): Quill {
  const group = new THREE.Group();
  const mesh = (f: (m: Mesher) => void) => {
    const m = new Mesher();
    f(m);
    return new THREE.Mesh(m.build(), mat);
  };
  const SKIN = 0xb98a6c;
  const JUMPER = 0x3b4a41;
  const TROUSERS = 0x1d2124;
  const HAIR = 0x9fa3a1;
  group.add(
    mesh((m) => {
      for (const s of [-1, 1]) {
        m.box(s * 0.1, 0.42, 0, 0.15, 0.8, 0.17, TROUSERS);
        m.box(s * 0.1, 0.04, 0.04, 0.16, 0.08, 0.27, 0x0e0f10);
      }
      m.box(0, 0.88, 0, 0.38, 0.16, 0.24, TROUSERS);
      m.box(0, 1.13, 0, 0.46, 0.56, 0.26, JUMPER);
      m.box(0, 1.39, 0, 0.36, 0.08, 0.22, JUMPER);
      m.box(0, 1.46, 0, 0.11, 0.08, 0.11, SKIN);
    }),
  );
  const head = new THREE.Group();
  head.position.set(0, 1.5, 0);
  head.add(
    mesh((m) => {
      m.box(0, 0.12, 0, 0.2, 0.25, 0.22, SKIN);
      m.box(0, 0.11, 0.12, 0.04, 0.06, 0.04, SKIN);
      for (const s of [-1, 1]) {
        m.box(s * 0.05, 0.145, 0.111, 0.035, 0.022, 0.01, 0x15110f);
        m.box(s * 0.05, 0.175, 0.111, 0.05, 0.014, 0.01, 0x55504b);
      }
      m.box(0, 0.06, 0.111, 0.06, 0.012, 0.01, 0x6a4038);
      // Short grey hair with a bun: plain, no insignia anywhere.
      m.box(0, 0.255, -0.02, 0.205, 0.045, 0.22, HAIR);
      m.box(0.03, 0.235, 0.09, 0.15, 0.03, 0.05, HAIR); // a side-swept fringe
      m.box(0, 0.15, -0.1, 0.21, 0.2, 0.04, HAIR);
      for (const s of [-1, 1]) m.box(s * 0.103, 0.18, -0.03, 0.02, 0.12, 0.15, HAIR);
      m.box(0, 0.2, -0.14, 0.09, 0.08, 0.06, HAIR); // the bun
    }),
  );
  group.add(head);
  const arm = (side: number) => {
    const shoulder = new THREE.Group();
    shoulder.position.set(side * 0.28, 1.38, 0);
    shoulder.add(mesh((m) => m.box(0, -0.15, 0, 0.11, 0.32, 0.12, JUMPER)));
    const elbow = new THREE.Group();
    elbow.position.set(0, -0.3, 0);
    elbow.add(
      mesh((m) => {
        m.box(0, -0.13, 0, 0.1, 0.27, 0.1, JUMPER);
        m.box(0, -0.31, 0, 0.08, 0.09, 0.08, SKIN);
      }),
    );
    const hand = new THREE.Object3D();
    hand.position.set(0, -0.33, 0.02);
    elbow.add(hand);
    shoulder.add(elbow);
    group.add(shoulder);
    return { shoulder, elbow, hand };
  };
  const r = arm(-1);
  const l = arm(1);
  // The remote in her right hand (pointing along the forearm).
  r.hand.add(mesh((m) => m.box(0, -0.02, 0.03, 0.045, 0.15, 0.025, 0x0c0c0c)));
  // The mug: its own mesh in the room, following her left hand until she puts it down.
  const mug = mesh((m) => {
    const R = 0.045;
    const H = 0.1;
    for (let i = 0; i < 8; i++) {
      const a0 = (i / 8) * Math.PI * 2;
      const a1 = ((i + 1) / 8) * Math.PI * 2;
      const p = (a: number, y: number): V3 => [Math.cos(a) * R, y, Math.sin(a) * R];
      m.quad(p(a1, 0), p(a0, 0), p(a0, H), p(a1, H), hexRGB(0xd9d3c4));
      m.quad(p(a1, H), p(a0, H), [0, H, 0], [0, H, 0], hexRGB(0x5a3a24)); // tea
    }
    m.box(R + 0.015, H * 0.55, 0, 0.02, 0.06, 0.015, 0xd9d3c4);
  });
  return { group, armR: r.shoulder, elbowR: r.elbow, armL: l.shoulder, elbowL: l.elbow, handL: l.hand, head, mug };
}

interface Room {
  scene: THREE.Scene;
  quill: Quill;
  wallMat: THREE.ShaderMaterial;
  feedMat: THREE.ShaderMaterial;
  atlas: THREE.CanvasTexture;
}

function buildRoom(newsTex: THREE.Texture, white: THREE.Texture, night: THREE.Texture): Room {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x030504);
  const m = new Mesher(roomShade);
  // Shell: floor, the monitor wall, side walls, ceiling.
  m.quad([-8, 0, 12], [8, 0, 12], [8, 0, -0.3], [-8, 0, -0.3], hexRGB(0x111814));
  m.quad([-8, 0, -0.3], [8, 0, -0.3], [8, 4.4, -0.3], [-8, 4.4, -0.3], hexRGB(0x131c18));
  m.quad([-8, 4.4, -0.3], [8, 4.4, -0.3], [8, 4.4, 12], [-8, 4.4, 12], hexRGB(0x070a09));
  m.quad([-8, 0, 12], [-8, 0, -0.3], [-8, 4.4, -0.3], [-8, 4.4, 12], hexRGB(0x0d1310));
  m.quad([8, 0, -0.3], [8, 0, 12], [8, 4.4, 12], [8, 4.4, -0.3], hexRGB(0x0d1310));
  // Monitor casings on the wall (two rows of five) and a frame round the whole bank.
  const COLS = [-3, -1.5, 0, 1.5, 3];
  const ROWS = [2.32, 3.22];
  for (const y of ROWS) for (const x of COLS) m.box(x, y, -0.18, 1.42, 0.82, 0.2, 0x1a2420);
  m.box(0, 4.0, -0.2, 8.0, 0.12, 0.25, 0x222c27);
  m.box(0, 1.84, -0.2, 8.0, 0.08, 0.25, 0x222c27);
  // The console desk under the wall, the TV on it, and the two feed monitors.
  m.box(0, 0.44, 1.1, 5.2, 0.88, 1.1, 0x1d2622);
  m.box(0, 0.9, 1.1, 5.3, 0.05, 1.2, 0x2b3631);
  m.box(TV.x, 1.35, 1.12, 1.36, 0.94, 0.6, 0x2c322f); // the TV: chunky, a little old
  m.box(TV.x, 1.35, 0.72, 1.1, 0.74, 0.3, 0x232826);
  m.box(TV.x, TV.y - TV.h / 2 - 0.09, 1.43, 0.5, 0.05, 0.02, 0x151917); // speaker grille
  m.box(TV.x + 0.56, TV.y - TV.h / 2 - 0.09, 1.43, 0.012, 0.012, 0.01, [0.3, 0.55, 0.28]); // steady power light
  for (const x of [1.95, 1.15]) {
    m.box(x, 1.2, 1.15, 0.82, 0.52, 0.08, 0x1a2420, -0.12);
    m.box(x, 0.98, 1.2, 0.08, 0.14, 0.08, 0x1a2420);
  }
  // Keyboards and a lamp on the right of the desk.
  m.box(-1.5, 0.94, 1.45, 0.6, 0.03, 0.2, 0x2a332e);
  m.box(1.55, 0.94, 1.5, 0.7, 0.03, 0.2, 0x2a332e);
  // Side consoles and two staff, seen as silhouettes against the glow.
  for (const s of [-1, 1]) {
    const cx = s * 3.6;
    m.box(cx, 0.42, 1.3, 1.6, 0.84, 0.8, 0x1a221e);
    m.box(cx, 1.05, 1.05, 1.1, 0.42, 0.06, 0x1a2420, -s * 0.15);
    const sx = cx + s * 0.1;
    m.box(sx, 0.5, 2.15, 0.5, 0.06, 0.5, 0x0a0d0c); // seat
    m.box(sx, 0.85, 2.4, 0.5, 0.65, 0.06, 0x0a0d0c); // chair back
    m.box(sx, 0.25, 2.15, 0.06, 0.5, 0.06, 0x0a0d0c);
    m.box(sx, 0.86, 2.15, 0.42, 0.62, 0.26, 0x07090a); // body
    m.box(sx, 1.3, 2.13, 0.2, 0.24, 0.22, 0x07090a); // head
    m.box(sx - s * 0.16, 0.98, 1.85, 0.08, 0.08, 0.4, 0x07090a); // arm to the keys
  }
  // The map table: a block with a glowing top (the top is a screen, below).
  m.box((TABLE.x0 + TABLE.x1) / 2, TABLE.y / 2 - 0.03, (TABLE.z0 + TABLE.z1) / 2, TABLE.x1 - TABLE.x0, TABLE.y - 0.06, TABLE.z1 - TABLE.z0, 0x161e1a);
  m.box((TABLE.x0 + TABLE.x1) / 2, TABLE.y - 0.02, (TABLE.z0 + TABLE.z1) / 2, TABLE.x1 - TABLE.x0 + 0.1, 0.05, TABLE.z1 - TABLE.z0 + 0.1, 0x2a3530, 0, ['top']);
  const shell = new THREE.Mesh(m.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  scene.add(shell);

  // Screens. Wall: slot 0 the map table, 1-3 the guns, -1 steady.
  const atlas = new THREE.CanvasTexture(drawAtlas());
  atlas.anisotropy = 4;
  const w = new Mesher();
  const SW = 1.3;
  const SH = 0.73;
  const full = [0, 0, 1, 1];
  const wallSlots: [number, number, { uv: number[]; uvB?: number[]; slot: number }][] = [
    [-3, ROWS[0], { uv: uvOf('status'), slot: -1 }],
    [-1.5, ROWS[0], { uv: full, uvB: uvOf('g25'), slot: 1 }],
    [0, ROWS[0], { uv: full, uvB: uvOf('g40'), slot: 2 }],
    [1.5, ROWS[0], { uv: full, uvB: uvOf('g105'), slot: 3 }],
    [3, ROWS[0], { uv: uvOf('standby'), slot: -1 }],
    [-3, ROWS[1], { uv: uvOf('orbit'), slot: -1 }],
    [3, ROWS[1], { uv: uvOf('status'), slot: -1 }],
  ];
  for (const [x, y, o] of wallSlots) screen(w, x, y, -0.075, SW, SH, o);
  for (const s of [-1, 1]) screen(w, s * 3.6 - s * 0.0, 1.05, 1.085, 0.96, 0.34, { uv: uvOf(s < 0 ? 'standby' : 'orbit'), slot: -1 }, -s * 0.15);
  // The map table's top: dim streets, then friendlies and safehouses.
  w.quad([TABLE.x0 + 0.06, TABLE.y + 0.005, TABLE.z1 - 0.06], [TABLE.x1 - 0.06, TABLE.y + 0.005, TABLE.z1 - 0.06], [TABLE.x1 - 0.06, TABLE.y + 0.005, TABLE.z0 + 0.06], [TABLE.x0 + 0.06, TABLE.y + 0.005, TABLE.z0 + 0.06], [1, 1, 1], { uv: uvOf('tableIdle'), uvB: uvOf('tableLive'), slot: 0 });
  const wallMat = new THREE.ShaderMaterial({
    uniforms: { atlas: { value: atlas }, news: { value: newsTex }, on: { value: [0, 0, 0, 0] }, bright: { value: 0.82 } },
    vertexShader: wallShader.vertex,
    fragmentShader: wallShader.fragment,
  });
  scene.add(new THREE.Mesh(w.build(true), wallMat));

  // The bulletin on the TV and two more wall monitors.
  const nw = new Mesher();
  screen(nw, TV.x, TV.y, TV.z, TV.w, TV.h);
  for (const x of [-1.5, 0, 1.5]) screen(nw, x, ROWS[1], -0.075, SW, SH);
  const newsMat = new THREE.MeshBasicMaterial({ map: newsTex, color: 0xe8e8e8 });
  scene.add(new THREE.Mesh(nw.build(), newsMat));

  // The two feed monitors on the desk.
  const f = new Mesher();
  screen(f, 1.15, 1.22, 1.195, 0.72, 0.42, { slot: 0 }, -0.12);
  screen(f, 1.95, 1.22, 1.195, 0.72, 0.42, { slot: 1 }, -0.12);
  const feedMat = new THREE.ShaderMaterial({
    uniforms: { white: { value: white }, night: { value: night }, k: { value: 0 }, bright: { value: 0.9 } },
    vertexShader: feedShader.vertex,
    fragmentShader: feedShader.fragment,
  });
  scene.add(new THREE.Mesh(f.build(true), feedMat));

  // Quill: real (simple) lighting, since she turns: glow from the monitors, an underlight from the table.
  const quillMat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
  const quill = buildQuill(quillMat);
  quill.group.position.set(QUILL.x, 0, QUILL.z);
  scene.add(quill.group, quill.mug);
  scene.add(new THREE.AmbientLight(0xffffff, 0.7));
  const glow = new THREE.DirectionalLight(0xdfeee6, 1.0);
  glow.position.set(0, 2.6, -2);
  const table = new THREE.DirectionalLight(0xc8ffd0, 0.75);
  table.position.set(0.3, -0.6, 3);
  const top = new THREE.DirectionalLight(0xffffff, 0.35);
  top.position.set(-1, 3, 2);
  scene.add(glow, table, top);
  return { scene, quill, wallMat, feedMat, atlas };
}

// ---------------------------------------------------------------------------------------------
// The studio inside the TV (display colours, flat): the newsreader and a LIVE inset
// ---------------------------------------------------------------------------------------------

/** The LIVE inset, as fractions of the TV picture (x from the left, y from the top). */
const INSET = { x0: 0.43, x1: 0.85, y0: 0.1, y1: 0.62 };

function buildStudio(footage: THREE.Texture): { scene: THREE.Scene; camera: THREE.OrthographicCamera; head: THREE.Group; mouth: THREE.Mesh } {
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(0, 16, 9, 0, -10, 10);
  const m = new Mesher();
  const flat = (x0: number, y0: number, x1: number, y1: number, hex: number, z = 0) => m.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z], hexRGB(hex));
  // Backdrop: deep blue, darker below, with tall soft panels.
  m.quad([0, 0, -1], [16, 0, -1], [16, 9, -1], [0, 9, -1], hexRGB(0x0e1d31));
  for (let i = 0; i < 6; i++) flat(0.4 + i * 2.7, 2.2, 2.4 + i * 2.7, 9, i % 2 ? 0x13283f : 0x112339, -0.9);
  // A blocky skyline at night behind him (made up).
  for (let i = 0; i < 10; i++) flat(i * 0.8, 2.2, i * 0.8 + 0.7, 3.0 + hash(i + 3) * 1.6, 0x0a1626, -0.8);
  // Pruett: dark suit, white collar, red tie.
  flat(1.6, 0, 6.4, 3.6, 0x252a33, 0);
  m.quad([2.2, 3.6, 0], [5.8, 3.6, 0], [5.2, 4.3, 0], [2.8, 4.3, 0], hexRGB(0x2c323c));
  m.quad([3.5, 2.4, 0.1], [4.5, 2.4, 0.1], [4.8, 4.3, 0.1], [3.2, 4.3, 0.1], hexRGB(0xe6e3db));
  m.quad([3.85, 2.2, 0.2], [4.15, 2.2, 0.2], [4.25, 4.0, 0.2], [3.75, 4.0, 0.2], hexRGB(0x9b2f2a));
  flat(3.6, 4.0, 4.4, 4.8, 0xb88c70, 0.05);
  // Desk: pale front with a red stripe (an invented channel's colours).
  flat(0, 0, 16, 1.7, 0xc9ced6, 0.5);
  flat(0, 1.55, 16, 1.7, 0xe7eaee, 0.55);
  flat(0, 0.55, 16, 0.75, 0x9b2f2a, 0.55);
  // The LIVE inset's frame.
  const fx0 = INSET.x0 * 16;
  const fx1 = INSET.x1 * 16;
  const fy0 = (1 - INSET.y1) * 9;
  const fy1 = (1 - INSET.y0) * 9;
  flat(fx0 - 0.08, fy0 - 0.08, fx1 + 0.08, fy1 + 0.08, 0xe8ecef, 0.6);
  const body = new THREE.Mesh(m.build(), new THREE.MeshBasicMaterial({ vertexColors: true }));
  scene.add(body);
  const inset = new THREE.Mesh(new THREE.PlaneGeometry(fx1 - fx0, fy1 - fy0), new THREE.MeshBasicMaterial({ map: footage }));
  inset.position.set((fx0 + fx1) / 2, (fy0 + fy1) / 2, 0.7);
  scene.add(inset);
  // His head: flat-shaded facets, slick hair with a side parting.
  const h = new Mesher();
  const hq = (pts: number[][], hex: number) => h.quad(pts[0] as V3, pts[1] as V3, pts[2] as V3, pts[3] as V3, hexRGB(hex));
  hq([[-0.85, -0.1, 0], [0, -0.1, 0], [0, 2.0, 0], [-0.85, 2.0, 0]], 0xcf9f80);
  hq([[0, -0.1, 0], [0.85, -0.1, 0], [0.85, 2.0, 0], [0, 2.0, 0]], 0xdcae8f);
  hq([[-0.85, 1.75, 0.1], [0.85, 1.75, 0.1], [0.8, 2.35, 0.1], [-0.8, 2.35, 0.1]], 0x3a2c22);
  hq([[-0.95, 0.9, 0.1], [-0.8, 0.9, 0.1], [-0.8, 2.1, 0.1], [-0.95, 2.0, 0.1]], 0x3a2c22);
  hq([[0.8, 0.9, 0.1], [0.95, 0.9, 0.1], [0.95, 2.0, 0.1], [0.8, 2.1, 0.1]], 0x3a2c22);
  hq([[-0.6, 2.05, 0.15], [0.3, 1.75, 0.15], [0.85, 1.9, 0.15], [-0.3, 2.3, 0.15]], 0x4a3a2c);
  for (const s of [-1, 1]) {
    hq([[s * 0.42 - 0.13, 1.15, 0.2], [s * 0.42 + 0.13, 1.15, 0.2], [s * 0.42 + 0.13, 1.27, 0.2], [s * 0.42 - 0.13, 1.27, 0.2]], 0x1a1412);
    hq([[s * 0.42 - 0.2, 1.43, 0.2], [s * 0.42 + 0.2, 1.43, 0.2], [s * 0.42 + 0.18, 1.5, 0.2], [s * 0.42 - 0.18, 1.5, 0.2]], 0x3a2c22);
  }
  hq([[-0.08, 0.7, 0.2], [0.12, 0.7, 0.2], [0.05, 1.2, 0.2], [0.0, 1.2, 0.2]], 0xb8876a);
  const head = new THREE.Group();
  head.add(new THREE.Mesh(h.build(), body.material));
  const mouth = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.2), new THREE.MeshBasicMaterial({ color: 0x4a2420 }));
  mouth.position.set(0.02, 0.42, 0.25);
  head.add(mouth);
  head.position.set(4.0, 4.75, 0.3);
  scene.add(head);
  return { scene, camera, head, mouth };
}

// ---------------------------------------------------------------------------------------------
// The night sky: Spooky circling, from a white-hot camera on the street (sensor values: R heat)
// ---------------------------------------------------------------------------------------------

function buildSky(): { scene: THREE.Scene; camera: THREE.PerspectiveCamera; plane: THREE.Group; centre: THREE.Vector3 } {
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0.02, 0.02, 0); // cold sky: black on white-hot
  const m = new Mesher();
  // Houses either side of the street, warm windows, cool roofs (roofs radiate to the night sky).
  const wall: V3 = [0.3, 0.06, 0];
  const roof: V3 = [0.23, 0.05, 0];
  for (let i = 0; i < 7; i++) {
    const z = -40 - i * 11;
    for (const s of [-1, 1]) {
      const x = s * (11 + hash(i * 2 + s) * 2);
      const h = 5 + hash(i + 9) * 1.5;
      m.house(x, z, 8, h, 9, 3.2, wall, roof);
      // Lit windows (people inside, warm) facing the street.
      for (const wy of [1.6, h - 1.4]) for (const wz of [-2.2, 2.2]) {
        const fx = x - s * 4.01;
        m.quad([fx, wy - 0.5, z + wz + (s > 0 ? 0.6 : -0.6)], [fx, wy - 0.5, z + wz - (s > 0 ? 0.6 : -0.6)], [fx, wy + 0.5, z + wz - (s > 0 ? 0.6 : -0.6)], [fx, wy + 0.5, z + wz + (s > 0 ? 0.6 : -0.6)], [0.44, 0.1, 0]);
      }
      m.box(x + s * 1.5, h + 3.4, z - 2, 0.7, 2.2, 0.7, [0.5, 0.05, 0]); // chimney, a little warm
    }
  }
  // A blocky tree (cool: no warm clutter).
  m.box(6.5, 7, -52, 5, 5, 5, [0.21, 0.03, 0]);
  m.box(6.5, 2.5, -52, 0.6, 5, 0.6, [0.22, 0.03, 0]);
  const ground = new THREE.Mesh(m.build(), new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }));
  scene.add(ground);
  // Spooky: a blocky four-engined gunship. Engines white-hot, airframe cooler.
  const p = new Mesher();
  const AIR: V3 = [0.42, 0.05, 0];
  const WING: V3 = [0.36, 0.05, 0];
  p.box(0, 0, 0, 4, 4.2, 26, AIR);
  p.box(0, -0.4, 14, 3.2, 3.2, 3, AIR); // nose
  p.box(0, 0.6, -15, 2.6, 3, 5, AIR);
  p.box(0, 4.0, -16, 0.6, 6, 4.5, WING); // fin
  p.box(0, 1.2, -16.5, 15, 0.4, 3, WING); // tailplane
  p.box(0, 2.0, 2, 40, 0.6, 4.2, WING); // wing
  for (const x of [-12, -6, 6, 12]) {
    p.box(x, 1.2, 3.5, 1.6, 1.6, 5, [0.8, 0.06, 0]);
    p.box(x, 1.2, 0.4, 1.2, 1.2, 1.4, [0.98, 0.06, 0]); // exhaust: the hottest thing up there
  }
  const plane = new THREE.Group();
  plane.add(new THREE.Mesh(p.build(), ground.material));
  plane.scale.setScalar(1.9);
  scene.add(plane);
  const camera = new THREE.PerspectiveCamera(46, 1, 1, 3000);
  camera.position.set(0, 1.7, 0);
  const centre = new THREE.Vector3(0, 230, -300);
  camera.lookAt(0, 85, -170);
  return { scene, camera, plane, centre };
}

// ---------------------------------------------------------------------------------------------
// The news footage: the sample town on the game's own renderer (never a real place)
// ---------------------------------------------------------------------------------------------

const SIM_STEP = 1 / 60;

class Footage {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(10, 1.5, 50, 4000);
  readonly world: World;
  readonly agents = new AgentsView();
  private sim: Sim;
  private centre = { x: 0, z: 0 };
  private acc = 0;
  clock = 0;

  constructor() {
    const map = makeSampleTown();
    let sim: Sim | null = null;
    for (let seed = 11; seed < 20 && !sim; seed++) {
      const r = createSim(map, { type: 'clear', difficulty: 4, seed });
      if (r.ok) sim = r.sim;
    }
    if (!sim) throw new Error('no footage mission');
    this.sim = sim;
    this.scene.background = new THREE.Color(0.15, 0.05, 0);
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.95));
    const sun = new THREE.DirectionalLight(0xffffff, 0.5);
    sun.position.set(-0.4, 1, 0.3);
    this.scene.add(sun);
    this.world = buildWorld(map, 1);
    this.scene.add(this.world.group, this.agents.group);
    // Let them spread out a little first, then watch the biggest group shamble.
    for (let i = 0; i < 60 * 3; i++) this.sim.step(SIM_STEP);
    this.sim.drainEvents();
    let best = -1;
    for (const h of this.sim.mission.hordes) {
      const n = this.sim.zombies.filter((z) => z.alive && Math.hypot(z.x - h.centre.x, z.z - h.centre.z) < 40).length;
      if (n > best) {
        best = n;
        this.centre = { ...h.centre };
      }
    }
  }

  /** Advance the sim (unless still) and place the camera: a slow, steady drift, no cuts. */
  update(dt: number, still: boolean): void {
    if (!still) {
      this.acc += Math.min(0.1, dt);
      while (this.acc >= SIM_STEP) {
        this.acc -= SIM_STEP;
        this.sim.step(SIM_STEP);
        this.clock += SIM_STEP;
      }
      this.sim.drainEvents();
    }
    const a = 0.7 + this.clock * 0.012;
    const R = 170;
    this.camera.position.set(this.centre.x + Math.cos(a) * R, 150, this.centre.z + Math.sin(a) * R);
    this.camera.lookAt(this.centre.x, 0, this.centre.z);
    this.agents.update(this.sim, this.clock);
  }

  dispose(): void {
    this.world.dispose();
    this.agents.dispose();
  }
}

// ---------------------------------------------------------------------------------------------
// Camera framing for the room (works for any aspect: wide screens and phones)
// ---------------------------------------------------------------------------------------------

interface Pose {
  target: V3;
  /** Width and height (m) that must fit; `pw`: the width that must fit on a portrait screen. */
  w: number;
  h: number;
  pw: number;
  /** Direction from target to camera (normalised on use). */
  dir: V3;
}

const POSE: Record<'tvFar' | 'tvNear' | 'wide' | 'quill', Pose> = {
  tvFar: { target: [TV.x, TV.y - 0.02, TV.z], w: 1.5, h: 0.88, pw: 1.3, dir: [0, 0, 1] },
  tvNear: { target: [TV.x, TV.y - 0.02, TV.z], w: 1.38, h: 0.8, pw: 1.2, dir: [0, 0, 1] },
  wide: { target: [0, 1.9, 1.5], w: 8.4, h: 3.9, pw: 4.4, dir: [-0.04, 0.36, 1] },
  quill: { target: [-0.1, 1.42, 2.3], w: 4.7, h: 2.65, pw: 3.4, dir: [-0.1, 0.42, 1] },
};
const FOV = 38;

function lerpPose(a: Pose, b: Pose, k: number): Pose {
  const l = (x: number, y: number) => x + (y - x) * k;
  const l3 = (x: V3, y: V3): V3 => [l(x[0], y[0]), l(x[1], y[1]), l(x[2], y[2])];
  // Size in log space: a dolly feels even all the way.
  const g = (x: number, y: number) => Math.exp(l(Math.log(x), Math.log(y)));
  return { target: l3(a.target, b.target), w: g(a.w, b.w), h: g(a.h, b.h), pw: g(a.pw, b.pw), dir: l3(a.dir, b.dir) };
}

function placeCamera(cam: THREE.PerspectiveCamera, p: Pose, aspect: number): void {
  const tv = Math.tan(THREE.MathUtils.degToRad(FOV / 2));
  const w = aspect < 1 ? p.pw : p.w;
  const dist = Math.max(p.h / 2 / tv, w / 2 / (tv * aspect));
  const d = new THREE.Vector3(...p.dir).normalize();
  cam.position.set(p.target[0] + d.x * dist, p.target[1] + d.y * dist, p.target[2] + d.z * dist);
  cam.lookAt(p.target[0], p.target[1], p.target[2]);
}

/** The room pose at time t (normal mode). */
function roomPoseAt(t: number): Pose {
  if (t < BEAT.dollyStart) return lerpPose(POSE.tvFar, POSE.tvNear, ramp(t, 0, BEAT.dollyStart));
  if (t < BEAT.turnEnd) return lerpPose(POSE.tvNear, POSE.wide, easeOut(t, BEAT.dollyStart, BEAT.dollyEnd));
  return lerpPose(POSE.wide, POSE.quill, ramp(t, BEAT.turnEnd, BEAT.sky));
}

/** The still pose for a slide (reduced motion). */
function slidePose(s: SlideId): Pose {
  if (s === 'bulletin') return POSE.tvNear;
  if (s === 'room') return POSE.wide;
  return lerpPose(POSE.wide, POSE.quill, 0.7);
}

// ---------------------------------------------------------------------------------------------
// The player
// ---------------------------------------------------------------------------------------------

/** Wait this long at most for the first line's file before starting (it plays muted if late). */
const PREP_MAX = 2;

let live = 0;
/** Intros alive (the leak check reads it). */
export const liveIntros = (): number => live;

export type IntroEnd = 'ended' | 'skipped';

export interface IntroHook {
  state(): { t: number; shot: string; slide: string; still: boolean; caption: string; speaker: string; drawCalls: number; started: boolean; ticker: number; tvText: number; title: number };
  fixedStep(dt: number | null): void;
  seek(t: number): void;
}

class IntroPlayer {
  readonly root: HTMLDivElement;
  private renderer: THREE.WebGLRenderer;
  private room: Room;
  private studio: ReturnType<typeof buildStudio>;
  private sky: ReturnType<typeof buildSky>;
  private footage: Footage;
  private camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 200);
  private rt: Record<'raw' | 'white' | 'night' | 'studio' | 'cur' | 'held' | 'skyRaw', THREE.WebGLRenderTarget>;
  private sensor: FullScreenQuad;
  private sensorMat: THREE.ShaderMaterial;
  private compose: FullScreenQuad;
  private composeMat: THREE.ShaderMaterial;
  private t = 0;
  private started = false;
  private prepT = 0;
  private last = 0;
  private raf = 0;
  private disposed = false;
  private fixed: number | null = null;
  private still: boolean;
  private view: string = '';
  private dissolve: { t0: number; dur: number } | null = null;
  private played = new Set<string>();
  private clips: ClipHandle[] = [];
  private tvClips: ClipHandle[] = [];
  private size = { w: 0, h: 0, pr: 1 };
  private footAcc = 0;
  private footDrawn = false;
  private drawCalls = 0;
  private cleanups: (() => void)[] = [];
  // DOM
  private tv: HTMLDivElement;
  private tvBase = { w: 0, h: 0 };
  private ticker: HTMLSpanElement;
  private tickerX = 0;
  private tickerW = 0;
  private tickerSpeed = 30;
  private cap: HTMLDivElement;
  private capWho: HTMLSpanElement;
  private capText: HTMLSpanElement;
  private capKey = '';
  private title: HTMLDivElement;
  private radio: HTMLDivElement;
  private bars: HTMLSpanElement[] = [];
  private hud: HTMLDivElement;
  private opacity = { tv: -1, title: -1, radio: -1, hud: -1, root: -1 };
  private mugRest: THREE.Vector3 | null = null;
  private v = new THREE.Vector3();

  constructor(
    parent: HTMLElement,
    private onEnd: (how: IntroEnd) => void,
    private onRestart?: () => void,
  ) {
    this.still = stillNow();
    this.root = el('div', 'intro', undefined, parent);
    this.root.setAttribute('role', 'region');
    this.root.setAttribute('aria-label', 'Intro: The Late Bulletin');
    if (this.still) this.root.classList.add('still');

    const rt = (w: number, h: number, samples = 0) => new THREE.WebGLRenderTarget(w, h, { samples, depthBuffer: true });
    this.rt = { raw: rt(480, 320, 4), white: rt(480, 320), night: rt(480, 320), studio: rt(768, 432, 4), cur: rt(16, 16, 4), held: rt(16, 16), skyRaw: rt(16, 16, 4) };
    this.sensorMat = new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(SensorShader.uniforms), vertexShader: SensorShader.vertexShader, fragmentShader: SensorShader.fragmentShader });
    this.sensor = new FullScreenQuad(this.sensorMat);
    this.composeMat = new THREE.ShaderMaterial({
      uniforms: { cur: { value: null }, held: { value: null }, k: { value: 1 }, fade: { value: 0 } },
      vertexShader: composeShader.vertex,
      fragmentShader: composeShader.fragment,
    });
    this.compose = new FullScreenQuad(this.composeMat);

    this.footage = new Footage();
    this.studio = buildStudio(this.rt.white.texture);
    this.room = buildRoom(this.rt.studio.texture, this.rt.white.texture, this.rt.night.texture);
    this.sky = buildSky();
    // WebGL last: nothing above holds GPU memory yet, so if this throws there's nothing to free.
    this.renderer = new THREE.WebGLRenderer({ antialias: false, powerPreference: 'low-power' });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.info.autoReset = false;
    this.renderer.domElement.className = 'intro-canvas';
    this.renderer.domElement.setAttribute('aria-hidden', 'true');
    this.root.appendChild(this.renderer.domElement);

    // The TV's on-screen graphics (HTML, mapped onto the TV screen).
    this.tv = el('div', 'intro-tv', undefined, this.root);
    this.tv.setAttribute('aria-hidden', 'true');
    el('span', 'itv-bug', CHANNEL_BUG, this.tv);
    const liveTag = el('span', 'itv-live', 'LIVE', this.tv);
    liveTag.style.left = `${INSET.x0 * 100 + 1.2}%`;
    liveTag.style.top = `${INSET.y0 * 100 + 2}%`;
    const lower = el('div', 'itv-lower', undefined, this.tv);
    el('span', 'itv-name', LOWER_THIRD.name, lower);
    el('span', 'itv-place', LOWER_THIRD.place, lower);
    const tick = el('div', 'itv-ticker', undefined, this.tv);
    this.ticker = el('span', 'itv-tick', `${tickerText()}${tickerText()}`, tick);

    // Shot 4: the ground camera's frame and the radio waveform.
    this.hud = el('div', 'intro-hud', undefined, this.root);
    this.hud.setAttribute('aria-hidden', 'true');
    for (const c of ['tl', 'tr', 'bl', 'br']) el('span', `lh-corner ${c}`, undefined, this.hud);
    el('span', 'ih-read', 'GROUND CAM · IR WHITE HOT', this.hud);
    this.radio = el('div', 'intro-radio', undefined, this.root);
    this.radio.setAttribute('aria-hidden', 'true');
    el('span', 'ir-label', 'GROUND · RADIO', this.radio);
    const wave = el('span', 'ir-wave', undefined, this.radio);
    for (let i = 0; i < 14; i++) this.bars.push(el('span', 'ir-bar', undefined, wave));

    this.title = el('div', 'intro-title', undefined, this.root);
    el('span', 'lt-1', 'SPOOKY', this.title);
    el('span', 'lt-2', 'AT HOME', this.title);

    // Captions: always on (the intro works muted, and before sound is unlocked).
    this.cap = el('div', 'intro-cap', undefined, this.root);
    this.cap.setAttribute('aria-live', 'polite');
    this.capWho = el('span', 'ic-who', '', this.cap);
    this.capText = el('span', 'ic-text', '', this.cap);

    const skip = el('button', 'intro-skip', 'Skip intro', this.root);
    skip.setAttribute('aria-label', 'Skip intro (Esc, Space or Enter)');
    skip.addEventListener('click', (e) => {
      e.stopPropagation();
      this.finish('skipped');
    });
    // Why the pictures are still, when only the device asks: a note with "Play animated" / "Always".
    const note = this.still && this.onRestart ? buildMotionNote(() => this.onRestart?.()) : null;
    if (note) {
      note.classList.add('intro-motion-note');
      this.root.appendChild(note);
      note.addEventListener('pointerup', (e) => e.stopPropagation());
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof Element && e.target.closest('.motion-note')) return; // its buttons keep Enter and Space
      if (e.key === 'Escape' || e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
        e.preventDefault();
        if (!e.repeat) this.finish('skipped');
      }
    };
    window.addEventListener('keydown', onKey);
    this.cleanups.push(() => window.removeEventListener('keydown', onKey));
    // A tap or click anywhere skips too.
    this.root.addEventListener('pointerup', () => this.finish('skipped'));
    const onResize = () => this.resize();
    window.addEventListener('resize', onResize);
    this.cleanups.push(() => window.removeEventListener('resize', onResize));

    audio.claim('menu');
    void audio.preload([...INTRO_VOICE.map((id) => `voice/${id}`), SFX.squelch]);
    this.hook();
    live++;
    this.resize();
    skip.focus({ preventScroll: true });
    this.raf = requestAnimationFrame(this.frame);
  }

  private hook(): void {
    if (typeof navigator === 'undefined' || !navigator.webdriver) return;
    const h: IntroHook = {
      state: () => ({
        t: this.t,
        shot: shotAt(this.t),
        slide: slideAt(this.t),
        still: this.still,
        caption: this.capText.textContent ?? '',
        speaker: this.capWho.textContent ?? '',
        drawCalls: this.drawCalls,
        started: this.started,
        ticker: this.tickerX,
        tvText: Number(this.tv.style.opacity || 0),
        title: Number(this.title.style.opacity || 0),
      }),
      fixedStep: (dt) => {
        this.fixed = dt;
      },
      seek: (t) => {
        this.started = true;
        this.t = Math.max(0, Math.min(INTRO_END - 0.01, t));
        for (const l of INTRO_LINES) if (l.start < this.t) this.played.add(l.id);
      },
    };
    (window.__spooky as unknown as Record<string, unknown> | undefined)!.intro = h;
  }

  private resize(): void {
    const w = this.root.clientWidth || window.innerWidth;
    const h = this.root.clientHeight || window.innerHeight;
    // Pixel ratio capped so a tablet keeps its frame rate.
    const pr = Math.min(1.5, window.devicePixelRatio || 1, 2400 / Math.max(w, h));
    if (w === this.size.w && h === this.size.h && pr === this.size.pr) return;
    this.size = { w, h, pr };
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    const W = Math.round(w * pr);
    const H = Math.round(h * pr);
    for (const k of ['cur', 'held', 'skyRaw'] as const) this.rt[k].setSize(W, H);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.sky.camera.aspect = w / h;
    // Phones: a wider lens, so the gunship and the rooftops both fit.
    this.sky.camera.fov = w / h < 1 ? 70 : 46;
    this.sky.camera.updateProjectionMatrix();
    // The TV's graphics are laid out at the size the TV has on screen at the start (text >= 14 px).
    placeCamera(this.camera, POSE.tvFar, w / h);
    const q = this.tvQuad();
    this.tvBase = { w: Math.max(200, q ? q[1][0] - q[0][0] : w), h: Math.max(112, q ? q[3][1] - q[0][1] : h) };
    this.tv.style.width = `${this.tvBase.w}px`;
    this.tv.style.height = `${this.tvBase.h}px`;
    this.tv.style.setProperty('--u', `${this.tvBase.w / 100}px`);
    this.tickerW = this.ticker.scrollWidth / 2;
    // The ticker's speed on screen never passes TICKER_MAX_PX_S (the TV is biggest near the end of shot 1).
    placeCamera(this.camera, POSE.tvNear, w / h);
    const qn = this.tvQuad();
    const grow = qn ? (qn[1][0] - qn[0][0]) / this.tvBase.w : 1;
    this.tickerSpeed = (TICKER_MAX_PX_S * 0.8) / Math.max(1, grow);
  }

  /** The TV screen's corners on screen (CSS px), or null if any is behind the camera. */
  private tvQuad(): [number, number][] | null {
    const out: [number, number][] = [];
    for (const [dx, dy] of [[-1, 1], [1, 1], [1, -1], [-1, -1]]) {
      this.v.set(TV.x + (dx * TV.w) / 2, TV.y + (dy * TV.h) / 2, TV.z).project(this.camera);
      if (this.v.z > 1) return null;
      out.push([((this.v.x + 1) / 2) * this.size.w, ((1 - this.v.y) / 2) * this.size.h]);
    }
    return out;
  }

  private frame = (now: number): void => {
    this.raf = 0;
    if (this.disposed) return;
    const real = this.last ? Math.min(0.1, (now - this.last) / 1000) : 0;
    this.last = now;
    if (!this.started) {
      // Give the first line a moment to load, so it isn't missed (captions run either way).
      this.prepT += real;
      const first = `voice/${INTRO_LINES[0].id}`;
      if (this.prepT >= PREP_MAX || audio.has(first) || audio.unavailable(first) || this.fixed !== null) this.started = true;
    }
    const dt = this.started ? (this.fixed ?? real) : 0;
    this.t += dt;
    if (this.t >= INTRO_END) {
      this.finish('ended');
      return;
    }
    this.resize();
    this.sound();
    this.render(dt);
    this.overlay(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  /** Voice at the script's times. A line whose moment has passed (a seek, a stall) is skipped, not played late. */
  private sound(): void {
    const t = this.t;
    if (!this.started) return;
    for (const l of INTRO_LINES) {
      if (this.played.has(l.id) || t < l.start) continue;
      this.played.add(l.id);
      if (t - l.start > 0.35) continue;
      const c = audio.clip(`voice/${l.id}`, l.voice);
      if (c) {
        this.clips.push(c);
        if (l.voice === 'tv') this.tvClips.push(c);
      }
    }
    if (!this.played.has('mute') && t >= MUTE_AT) {
      this.played.add('mute');
      for (const c of this.tvClips) c.stop(0.12);
    }
    if (!this.played.has('squelch') && t >= SQUELCH_AT) {
      this.played.add('squelch');
      if (t - SQUELCH_AT < 0.35) {
        const c = audio.clip(SFX.squelch, 'squelch');
        if (c) this.clips.push(c);
      }
    }
  }

  private render(dt: number): void {
    const t = this.t;
    const r = this.renderer;
    r.info.reset();
    const slide = slideAt(t);
    const view = this.still ? slide : t < BEAT.sky ? 'room' : 'sky';
    if (this.view && view !== this.view) {
      // A dissolve: hold the last picture and fade the new one in over it.
      [this.rt.cur, this.rt.held] = [this.rt.held, this.rt.cur];
      this.dissolve = { t0: t, dur: this.still ? BEAT.slideDissolve : BEAT.dissolve };
    }
    this.view = view;
    const inRoom = this.still ? slide !== 'sky' : t < BEAT.sky;

    if (inRoom) {
      // Footage and studio at up to 30 frames a second (they're small pictures).
      this.footAcc += dt;
      if (this.footAcc >= 1 / 30 || !this.footDrawn) {
        this.footDrawn = true;
        this.footage.update(this.footAcc, this.still);
        this.footAcc = 0;
        r.setRenderTarget(this.rt.raw);
        r.render(this.footage.scene, this.footage.camera);
        this.sensorPass(this.rt.raw, this.rt.white, 0, this.footage.clock);
        if (t > BEAT.night - 2 || this.still) this.sensorPass(this.rt.raw, this.rt.night, 1, this.footage.clock);
        this.animateStudio(t);
        r.setRenderTarget(this.rt.studio);
        r.render(this.studio.scene, this.studio.camera);
      }
      this.animateRoom(t, slide);
      placeCamera(this.camera, this.still ? slidePose(slide) : roomPoseAt(t), this.size.w / this.size.h);
      r.setRenderTarget(this.rt.cur);
      r.render(this.room.scene, this.camera);
    } else {
      const s = this.sky;
      const a = (this.still ? 0.3 : 0.3 + (t - BEAT.sky) * 0.16) + Math.PI;
      const R = 80 * Math.min(1, (this.size.w / this.size.h) * 1.6);
      s.plane.position.set(s.centre.x + Math.cos(a) * R, s.centre.y, s.centre.z + Math.sin(a) * R * 0.8);
      // Heading along the circle, banked into the turn (Spooky orbits to the left).
      s.plane.rotation.set(0, 0, 0);
      s.plane.rotation.y = -a;
      s.plane.rotateZ(-0.35);
      r.setRenderTarget(this.rt.skyRaw);
      r.render(s.scene, s.camera);
      this.sensorPass(this.rt.skyRaw, this.rt.cur, 0, this.still ? 0 : t);
    }
    // Compose: the current picture over the held one while dissolving; fade up from black at the start.
    let k = 1;
    if (this.dissolve) {
      k = ramp(t, this.dissolve.t0, this.dissolve.t0 + this.dissolve.dur);
      if (k >= 1 || t < this.dissolve.t0) this.dissolve = null;
    }
    const u = this.composeMat.uniforms;
    u.cur.value = this.rt.cur.texture;
    u.held.value = this.rt.held.texture;
    u.k.value = k;
    u.fade.value = this.started ? ramp(t, 0, BEAT.fadeUp) : 0;
    r.setRenderTarget(null);
    this.compose.render(r);
    this.drawCalls = r.info.render.calls;
  }

  private sensorPass(src: THREE.WebGLRenderTarget, dst: THREE.WebGLRenderTarget, mode: number, time: number): void {
    const u = this.sensorMat.uniforms;
    u.tDiffuse.value = src.texture;
    u.mode.value = mode;
    u.polarity.value = 0;
    u.washout.value = 0;
    u.blank.value = 0;
    u.calm.value = 1;
    u.time.value = time;
    (u.res.value as THREE.Vector2).set(src.width, src.height);
    this.renderer.setRenderTarget(dst);
    this.sensor.render(this.renderer);
  }

  private animateStudio(t: number): void {
    const { head, mouth } = this.studio;
    // He talks through his lines, and carries on silently after the mute.
    const talking = speakingAt(t)?.speaker === 'PRUETT' || (t >= MUTE_AT && t < 18.6);
    const still = this.still;
    head.rotation.z = still ? 0 : Math.sin(t * 0.9) * 0.025;
    head.position.y = 4.75 + (still ? 0 : Math.sin(t * 1.7) * 0.03);
    // Mouth: open and close at about 2.5 a second while he talks (a small patch, not a flash).
    const open = talking && !still ? 0.5 + 0.5 * Math.sin(t * Math.PI * 2 * 2.4) : 0.2;
    mouth.scale.y = 0.25 + open * 0.9;
  }

  private animateRoom(t: number, slide: SlideId): void {
    const q = this.room.quill;
    const S = this.still;
    // Before the turn: back to the camera, watching the TV. Then she turns to face us.
    const turn = S ? (slide === 'bulletin' || slide === 'room' ? 0 : 1) : ramp(t, BEAT.turnStart, BEAT.turnEnd);
    q.group.rotation.y = Math.PI * (1 - turn) + 0.25 * turn;
    // Right arm: raises the remote at the TV, then lowers it.
    const up = S ? 0 : ramp(t, BEAT.remoteUp, BEAT.remoteUp + 0.45) * (1 - ramp(t, 15.5, 16.1));
    q.armR.rotation.x = 0.05 - up * 1.45;
    q.armR.rotation.z = -up * 0.5;
    q.elbowR.rotation.x = -0.12 - up * 0.2;
    // Left arm: holds the mug at her chest, then puts it down on the table (line 9).
    const down = S ? (slide === 'mug' ? 1 : 0) : ramp(t, BEAT.mugDown, BEAT.mugDown + 0.7);
    const back = S ? (slide === 'mug' ? 1 : 0) : ramp(t, BEAT.mugDown + 0.8, BEAT.mugDown + 1.5);
    q.armL.rotation.x = (-0.1 - 0.55 * down) * (1 - back) + 0.05 * back;
    q.elbowL.rotation.x = (-1.9 + 1.5 * down) * (1 - back) - 0.12 * back;
    // A small nod while she talks.
    const talk = speakingAt(t);
    q.head.rotation.x = !S && talk?.speaker === 'COMMANDER QUILL' ? Math.sin(t * 2.1) * 0.04 : 0;
    q.group.updateMatrixWorld(true);
    if (down < 1 || (!S && t < BEAT.mugDown + 0.7)) {
      q.handL.getWorldPosition(this.v);
      q.mug.position.set(this.v.x, this.v.y - 0.06, this.v.z);
      this.mugRest = null;
    } else {
      if (!this.mugRest) {
        q.handL.getWorldPosition(this.v);
        this.mugRest = new THREE.Vector3(this.v.x, TABLE.y, Math.max(TABLE.z0 + 0.08, this.v.z));
      }
      q.mug.position.copy(this.mugRest);
    }
    // Monitors follow her words: crossfades, never cuts.
    // (The same crossfades in still mode: they're dissolves, not motion.)
    const on = this.room.wallMat.uniforms.on.value as number[];
    on[0] = ramp(t, BEAT.markers, BEAT.markers + 0.6);
    for (let i = 0; i < 3; i++) on[i + 1] = ramp(t, BEAT.guns[i], BEAT.guns[i] + 0.6);
    this.room.feedMat.uniforms.k.value = ramp(t, BEAT.night, BEAT.night + BEAT.nightFade);
  }

  /** HTML on top: the TV graphics (mapped onto the TV), captions, radio, title. */
  private overlay(dt: number): void {
    const t = this.t;
    // TV graphics: only while the TV is big enough to read; they fade out as the camera pulls back.
    let tvOp = 0;
    if ((this.still ? slideAt(t) === 'bulletin' : t < BEAT.dollyEnd) && this.started) {
      const q = this.tvQuad();
      if (q) {
        const scale = (q[1][0] - q[0][0]) / this.tvBase.w;
        tvOp = Math.max(0, Math.min(1, (scale - 0.55) / 0.3)) * ramp(t, 0.2, 1.0);
        if (tvOp > 0) this.tv.style.transform = quadMatrix(this.tvBase.w, this.tvBase.h, q);
      }
    }
    this.setOpacity('tv', this.tv, tvOp);
    if (!this.still && tvOp > 0) {
      this.tickerX = (this.tickerX + this.tickerSpeed * dt) % Math.max(1, this.tickerW);
      this.ticker.style.transform = `translateX(${-this.tickerX.toFixed(1)}px)`;
    } else if (this.still) {
      // Still: the ticker doesn't scroll; it shows the bin-night item from line 3 on.
      const at = t >= 5.8 ? this.ticker.textContent!.indexOf('BIN NIGHT') : 0;
      this.ticker.style.transform = `translateX(${-this.ticker.scrollWidth * (at / this.ticker.textContent!.length)}px)`;
    }

    const c = captionAt(t);
    const key = c ? `${c.speaker}|${c.text}` : '';
    if (key !== this.capKey) {
      this.capKey = key;
      this.capWho.textContent = c?.speaker ?? '';
      this.capText.textContent = c?.text ?? '';
      this.cap.classList.toggle('on', !!c);
      this.cap.classList.toggle('cue', !!c && !c.speaker);
    }

    // Shot 4: the ground camera's frame and the radio waveform (Ground's voice).
    const radioOp = ramp(t, BEAT.sky + 0.2, BEAT.sky + 0.8) * (1 - ramp(t, BEAT.title, BEAT.title + 0.6));
    this.setOpacity('radio', this.radio, radioOp);
    this.setOpacity('hud', this.hud, radioOp);
    if (radioOp > 0) {
      const g = speakingAt(t)?.speaker === 'GROUND';
      this.bars.forEach((b, i) => {
        const lvl = g && !this.still ? 0.25 + 0.75 * Math.abs(Math.sin(t * 2.3 + i * 0.9) * Math.sin(t * 1.3 + i * 0.37)) : g ? 0.5 : 0.08;
        b.style.transform = `scaleY(${lvl.toFixed(2)})`;
      });
    }
    this.setOpacity('title', this.title, ramp(t, BEAT.title, BEAT.title + 0.8));
    this.setOpacity('root', this.root, 1 - ramp(t, BEAT.fadeOut, INTRO_END));
  }

  private setOpacity(k: keyof IntroPlayer['opacity'], e: HTMLElement, v: number): void {
    const r = Math.round(v * 100) / 100;
    if (this.opacity[k] === r) return;
    this.opacity[k] = r;
    e.style.opacity = String(r);
    e.style.visibility = r > 0 ? 'visible' : 'hidden';
  }

  finish(how: IntroEnd): void {
    if (this.disposed) return;
    rememberIntro('seen');
    this.dispose();
    this.onEnd(how);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    live--;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    for (const c of this.clips) c.stop(0.15);
    this.clips = [];
    this.tvClips = [];
    for (const f of this.cleanups) f();
    this.cleanups = [];
    const free = (s: THREE.Object3D) =>
      s.traverse((o) => {
        const mesh = o as THREE.Mesh;
        mesh.geometry?.dispose();
        const mat = mesh.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
    this.footage.dispose();
    free(this.room.scene);
    free(this.studio.scene);
    free(this.sky.scene);
    this.room.atlas.dispose();
    for (const r of Object.values(this.rt)) r.dispose();
    this.sensor.dispose();
    this.sensorMat.dispose();
    this.compose.dispose();
    this.composeMat.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.root.remove();
    const hooks = window.__spooky as unknown as Record<string, unknown> | undefined;
    if (hooks) delete hooks.intro;
  }
}

/**
 * Play the intro over `parent`. Start it from a click or key press (sound needs a gesture; without
 * one it plays muted, with captions). `onEnd` runs once, after everything is freed. If WebGL isn't
 * available it ends at once ('skipped').
 */
export function playIntro(parent: HTMLElement, onEnd: (how: IntroEnd) => void): { dispose(): void } {
  try {
    // "Play animated" (the still-frames note) swaps in a fresh, animated player.
    let p: IntroPlayer;
    const make = (): IntroPlayer => new IntroPlayer(parent, onEnd, () => {
      p.dispose();
      try {
        p = make();
      } catch {
        rememberIntro('seen');
        onEnd('skipped');
      }
    });
    p = make();
    return { dispose: () => p.dispose() };
  } catch (e) {
    console.warn(`Spooky: intro unavailable (${(e as Error).message})`);
    rememberIntro('seen');
    parent.querySelector('.intro')?.remove();
    queueMicrotask(() => onEnd('skipped'));
    return { dispose: () => undefined };
  }
}
