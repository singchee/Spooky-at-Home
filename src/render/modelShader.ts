import * as THREE from 'three';
import type { BakedModel } from './characterModels';

/**
 * Instanced drawing of a baked character model (see src/render/characterModels.ts): one draw call
 * for every zombie (or every survivor). Per instance the CPU writes its position, heading, a seed,
 * two texture rows and a blend for the clip it is playing, the same for a second clip it is blending
 * from (state changes, hit reactions), and its heat. The vertex shader fetches the baked positions
 * and normals and turns them into sensor values (R heat, G visible light, B near-infrared).
 *
 * Survivors also get the cold ID panel: a camera-facing square on the baked chest point, drawn just
 * in front of the body, exactly as the procedural figures do it.
 */

/**
 * How much larger than real height the models are drawn (1 = 1.75 m people). The figures are tiny
 * from the current 1.8 km orbit (about 5 px at the 40 mm); the new oblique camera should size them,
 * and this is the one knob if they still need exaggerating for readability (the old figures were 2.7 m, i.e. ~1.55).
 */
export const MODEL_DISPLAY_SCALE = 1.7; // readability first: real 1.75 m figures read as specks from the gunship; tuned with the 3.9 camera (~27 px at the 40 mm default on a 1080 px screen)
/** Side of the survivors' cold ID panel, metres (about two thirds of the chest's width). */
export const MODEL_PANEL_SIZE = 0.28;
/** The panel is drawn as if this much nearer the camera, so its own body never hides it. */
const PANEL_PULL = 0.9;

/** The most a figure leans back on a steep view (horizontal metres per metre of height). */
export const FIGURE_LEAN_MAX = 0.6;
/** Figures lean back to keep the screen height they would have seen from this many degrees off vertical. */
export const FIGURE_LEAN_REF_DEG = 40;
const LEAN_SIN = Math.sin((FIGURE_LEAN_REF_DEG * Math.PI) / 180);

/**
 * How far a figure leans back, away from the camera (horizontal metres per metre of height), given
 * the vector from its feet to the camera. The vertex shader below does the same sums; the IR strobe
 * (agentsView.ts) uses this so it stays on the leaning head.
 */
export function figureLean(toCamX: number, toCamY: number, toCamZ: number): number {
  const hz = Math.hypot(toCamX, toCamZ);
  if (hz <= 1e-3) return 0;
  const L = Math.hypot(hz, toCamY);
  return Math.max(0, Math.min(FIGURE_LEAN_MAX, (LEAN_SIN - hz / L) / Math.max(toCamY / L, 0.2)));
}

/** Lean point (x, y, z), relative to the feet, the way the shader does: away from the camera by y * lean. */
export function leanPoint(p: [number, number, number], toCamX: number, toCamY: number, toCamZ: number): [number, number, number] {
  const lean = figureLean(toCamX, toCamY, toCamZ);
  const hz = Math.hypot(toCamX, toCamZ);
  if (!lean || hz <= 1e-3) return p;
  return [p[0] - (toCamX / hz) * p[1] * lean, p[1], p[2] - (toCamZ / hz) * p[1] * lean];
}

const vertexShader = /* glsl */ `
  uniform highp sampler2D uPos;
  uniform highp sampler2D uNrm;
  uniform float uKind;   // 0 zombies, 1 survivors
  uniform float uBase;   // height of the feet above the map's zero (roads sit at 1 m)
  uniform float uScale;  // overall size (1 = real height)
  attribute float aVid;
  attribute float aHeatW;
  attribute float aRegion;
  attribute float aPanel;
  attribute vec2 aCorner;
  attribute vec4 iA; // x, z, heading, seed 0-1
  attribute vec4 iB; // clip A: row, next row, fraction; weight of clip B
  attribute vec4 iC; // clip B: row, next row, fraction; 1 when dead
  attribute vec4 iD; // core heat, limb heat, visible-light scale, unused
  varying vec3 vSig;

  mat3 rotY(float a) { float c = cos(a), s = sin(a); return mat3(c, 0.0, -s, 0.0, 1.0, 0.0, s, 0.0, c); }
  vec3 tp(float row) { return texelFetch(uPos, ivec2(int(aVid), int(row)), 0).xyz; }
  vec3 tn(float row) { return texelFetch(uNrm, ivec2(int(aVid), int(row)), 0).xyz; }

  void main() {
    float seed = iA.w;
    float zombie = 1.0 - step(0.5, uKind);
    float dead = iC.w;
    float r1 = fract(seed * 7.31 + 0.13);
    float r2 = fract(seed * 13.77 + 0.41);
    float r3 = fract(seed * 29.13 + 0.07);
    float r5 = fract(seed * 97.37 + 0.61);
    float r6 = fract(seed * 151.7 + 0.83);

    vec3 p = mix(mix(tp(iB.x), tp(iB.y), iB.z), mix(tp(iC.x), tp(iC.y), iC.z), iB.w);
    vec3 n = mix(mix(tn(iB.x), tn(iB.y), iB.z), mix(tn(iC.x), tn(iC.y), iC.z), iB.w);
    n = normalize(n + vec3(0.0, 1e-4, 0.0));

    // Per-agent build: zombies vary more (height and bulk), so a crowd is a crowd of individuals.
    float h = mix(0.95 + 0.1 * r3, 0.92 + 0.16 * r3, zombie);
    float w = mix(0.97 + 0.06 * r1, 0.9 + 0.24 * r1, zombie);
    p *= vec3(w, h, w) * uScale;
    if (aPanel > 0.5 && dead > 0.5) p = vec3(0.0, -50.0, 0.0);  // a dead survivor's panel is gone
    mat3 rYaw = rotY(iA.z);
    p = rYaw * p;
    n = rYaw * n;

    // 3.39: the camera rides the line of fire, often steeper than the old 40° slant, where a standing
    // figure would shrink to a blob. Lean it back, away from the camera (a shear, pivot at the feet, so
    // a body lying down barely moves), just enough to keep the screen height it had at 40°.
    vec3 toCam = cameraPosition - vec3(iA.x, uBase, iA.y);
    float hz = length(toCam.xz);
    if (hz > 1e-3) {
      float sv = hz / length(toCam);        // sin of the angle off vertical
      float cv = toCam.y / length(toCam);   // cos
      float lean = clamp((${LEAN_SIN.toFixed(6)} - sv) / max(cv, 0.2), 0.0, ${FIGURE_LEAN_MAX.toFixed(2)});   // = figureLean()
      p.xz -= toCam.xz / hz * p.y * lean;
    }
    vec4 world = modelMatrix * vec4(iA.x + p.x, uBase + p.y, iA.y + p.z, 1.0);
    vec4 mv = viewMatrix * world;
    if (aPanel > 0.5) {
      mv.xy += aCorner * ${(MODEL_PANEL_SIZE / 2).toFixed(4)} * uScale;   // a square facing the camera
      mv.xyz += normalize(-mv.xyz) * ${PANEL_PULL.toFixed(2)};           // just in front of its own body
    }
    gl_Position = projectionMatrix * mv;

    // Surfaces seen edge-on radiate less (emissivity falls at grazing angles): each body gets a cooler
    // outline and rounded shading, so overlapping bodies stay separate in a crowd.
    vec3 V = normalize(cameraPosition - world.xyz);
    float facing = max(dot(n, V), 0.0);
    float edge = mix(0.5, 1.0, smoothstep(0.05, 0.7, facing));
    // Heat: head hottest (the 0.98 peak), clothed body a little cooler, hands and feet coolest.
    float warm = clamp((iD.y - 0.2) / 0.3, 0.0, 1.0);   // 0 for cold-blooded zombies: uniform 0.2, no variation
    float limbHeat = iD.y + (r2 - 0.5) * 0.1 * warm;
    float heat = mix(iD.x, limbHeat, aHeatW);
    heat = 0.2 + (heat - 0.2) * edge;
    // Visible light: skin, tops, trousers and shoes under soft moonlight; tones vary per agent.
    float top = mix(mix(0.26, 0.36, r5), mix(0.12, 0.34, r5), zombie);
    float legs = mix(mix(0.15, 0.22, r6), mix(0.09, 0.25, r3), zombie);
    float skin = mix(0.34, 0.42, zombie);   // zombies' pale skin glows on night vision
    float albedo = aRegion < 0.5 ? skin : aRegion < 1.5 ? top : aRegion < 2.5 ? legs : aRegion < 3.5 ? 0.08 : 0.06;   // shoes, hair
    float moon = clamp(dot(n, normalize(vec3(-0.35, 1.0, 0.45))), 0.0, 1.0);
    float vis = albedo * (0.45 + 0.55 * moon) * mix(0.8, 1.0, edge) * (iD.z / 0.36);
    if (aPanel > 0.5) { heat = 0.0; vis = iD.z * 0.9; }   // cold ID panel: thermal only
    vSig = vec3(heat, vis, 0.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying vec3 vSig;
  void main() { gl_FragColor = vec4(vSig, 1.0); }
`;

/** Floats per instance attribute (four vec4s). */
const PER = 4;

/** One instanced mesh of a baked model: geometry, material and per-instance buffers. */
export class ModelBatch {
  readonly mesh: THREE.Mesh;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly c: Float32Array;
  readonly d: Float32Array;
  readonly material: THREE.ShaderMaterial;
  /** The model's clip names, in a fixed order (an agent's clip is an index into this). */
  readonly clipNames: string[];
  private geo: THREE.InstancedBufferGeometry;
  private attrs: THREE.InstancedBufferAttribute[];

  constructor(readonly model: BakedModel, kind: 'zombie' | 'survivor', readonly capacity: number) {
    this.clipNames = Object.keys(model.clips);
    const src = model.geometry;
    const nV = src.attributes.position.count;
    const extra = kind === 'survivor' ? 4 : 0;
    const total = nV + extra;
    const copy = (name: string, size: number) => {
      const out = new Float32Array(total * size);
      out.set(src.attributes[name].array as Float32Array);
      return out;
    };
    const position = copy('position', 3);
    const normal = copy('normal', 3);
    const vid = copy('aVid', 1);
    const heatW = copy('aHeatW', 1);
    const region = copy('aRegion', 1);
    const panel = new Float32Array(total);
    const corner = new Float32Array(total * 2);
    const index = Array.from(src.index!.array as ArrayLike<number>);
    if (extra) {
      // The panel: four corners on the baked chest point.
      const cs = [-1, -1, 1, -1, 1, 1, -1, 1];
      for (let k = 0; k < 4; k++) {
        const i = nV + k;
        vid[i] = model.chestCol;
        panel[i] = 1;
        corner[i * 2] = cs[k * 2];
        corner[i * 2 + 1] = cs[k * 2 + 1];
        normal[i * 3 + 2] = 1;
      }
      index.push(nV, nV + 1, nV + 2, nV, nV + 2, nV + 3);
    }
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setIndex(index);
    this.geo.setAttribute('position', new THREE.BufferAttribute(position, 3));
    this.geo.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
    this.geo.setAttribute('aVid', new THREE.BufferAttribute(vid, 1));
    this.geo.setAttribute('aHeatW', new THREE.BufferAttribute(heatW, 1));
    this.geo.setAttribute('aRegion', new THREE.BufferAttribute(region, 1));
    this.geo.setAttribute('aPanel', new THREE.BufferAttribute(panel, 1));
    this.geo.setAttribute('aCorner', new THREE.BufferAttribute(corner, 2));
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
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uPos: { value: model.pos },
        uNrm: { value: model.nrm },
        uKind: { value: kind === 'zombie' ? 0 : 1 },
        uBase: { value: 1.05 },
        uScale: { value: MODEL_DISPLAY_SCALE },
      },
      vertexShader,
      fragmentShader,
    });
    this.mesh = new THREE.Mesh(this.geo, this.material);
    this.mesh.frustumCulled = false;
  }

  get count(): number {
    return this.geo.instanceCount;
  }

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
    return { vertices: this.geo.attributes.position.count, triangles: (this.geo.index?.count ?? 0) / 3 };
  }

  /** Disposes this batch's geometry and material; the baked textures belong to the model. */
  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

/** Where a clip is at `time` seconds: the two texture rows to blend and the fraction between them. */
export function clipRows(clip: { row: number; frames: number; duration: number; loop: boolean; fps: number }, time: number): [number, number, number] {
  if (clip.loop) {
    const f = (((time / clip.duration) % 1) + 1) % 1 * clip.frames;
    const f0 = Math.floor(f) % clip.frames;
    return [clip.row + f0, clip.row + ((f0 + 1) % clip.frames), f - Math.floor(f)];
  }
  const f = Math.min(clip.frames - 1, Math.max(0, time * clip.fps));
  const f0 = Math.min(clip.frames - 1, Math.floor(f));
  return [clip.row + f0, clip.row + Math.min(clip.frames - 1, f0 + 1), f - f0];
}
