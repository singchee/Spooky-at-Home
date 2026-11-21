import * as THREE from 'three';

/**
 * GPU particles for tracers and explosions, drawn as instanced quads.
 *
 * The CPU writes a particle once, when it is born (start position and time, velocity, life, sizes,
 * kind, sensor colour). Its motion, growth, cooling and fade are worked out in the shader from
 * the game clock, so nothing is updated per particle per frame. Pools have a fixed capacity per
 * group: when a group is full, the particle closest to burning out is replaced, so memory and
 * draw calls never grow. Live particles are kept packed at the front of the buffers and only
 * those are drawn (some software renderers pay per instance, even for invisible ones).
 *
 * Colours are sensor values: R heat (thermal), G visible light (night vision), B near-infrared.
 */
export const PK = {
  flash: 0,
  fireball: 1,
  spark: 2,
  debris: 3,
  ring: 4,
  tracer: 5,
  fire: 6,
  smoke: 10,
} as const;

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  t0: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size0: number;
  size1: number;
  kind: number;
  seed: number;
  /** Sensor colour: heat, visible, near-IR (smoke: density scale in r). */
  r: number;
  g: number;
  b: number;
  /** Gravity (m/s²) for ballistic kinds; drag rate for fireball and smoke. */
  p: number;
}

/** One instanced quad mesh holding several particle groups (for example short-lived and long-lived). */
export class ParticlePool {
  readonly mesh: THREE.Mesh;
  readonly p0: Float32Array; // x, y, z, t0
  readonly vl: Float32Array; // vx, vy, vz, life
  readonly sk: Float32Array; // size0, size1, kind, seed
  readonly col: Float32Array; // r, g, b, param
  private group: Uint8Array;
  private groupCount: number[];
  private count = 0;
  private attrs: THREE.InstancedBufferAttribute[];
  private dirtyLo = Infinity;
  private dirtyHi = -1;
  private geo: THREE.InstancedBufferGeometry;
  readonly capacity: number;

  constructor(private groupCaps: number[], readonly material: THREE.ShaderMaterial) {
    const cap = groupCaps.reduce((a, b) => a + b, 0);
    this.capacity = cap;
    this.groupCount = groupCaps.map(() => 0);
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.setIndex(quad.index);
    this.geo.setAttribute('position', quad.attributes.position);
    this.p0 = new Float32Array(cap * 4);
    this.vl = new Float32Array(cap * 4);
    this.sk = new Float32Array(cap * 4);
    this.col = new Float32Array(cap * 4);
    this.group = new Uint8Array(cap);
    this.attrs = [this.p0, this.vl, this.sk, this.col].map((a) => new THREE.InstancedBufferAttribute(a, 4).setUsage(THREE.DynamicDrawUsage));
    ['aP0', 'aVL', 'aSK', 'aCol'].forEach((n, i) => this.geo.setAttribute(n, this.attrs[i]));
    this.geo.instanceCount = 0;
    this.mesh = new THREE.Mesh(this.geo, material);
    this.mesh.frustumCulled = false;
    quad.dispose();
  }

  private end(i: number): number {
    return this.p0[i * 4 + 3] + this.vl[i * 4 + 3];
  }

  private dirty(i: number): void {
    if (i < this.dirtyLo) this.dirtyLo = i;
    if (i > this.dirtyHi) this.dirtyHi = i;
  }

  spawn(group: number, s: ParticleSpec): void {
    let i: number;
    if (this.groupCount[group] < this.groupCaps[group]) {
      i = this.count++;
      this.groupCount[group]++;
      this.group[i] = group;
    } else {
      // Full: replace the particle in this group that would burn out soonest.
      i = -1;
      let best = Infinity;
      for (let k = 0; k < this.count; k++) {
        if (this.group[k] !== group) continue;
        const e = this.end(k);
        if (e < best) {
          best = e;
          i = k;
        }
      }
    }
    const o = i * 4;
    this.p0[o] = s.x;
    this.p0[o + 1] = s.y;
    this.p0[o + 2] = s.z;
    this.p0[o + 3] = s.t0;
    this.vl[o] = s.vx;
    this.vl[o + 1] = s.vy;
    this.vl[o + 2] = s.vz;
    this.vl[o + 3] = s.life;
    this.sk[o] = s.size0;
    this.sk[o + 1] = s.size1;
    this.sk[o + 2] = s.kind;
    this.sk[o + 3] = s.seed;
    this.col[o] = s.r;
    this.col[o + 1] = s.g;
    this.col[o + 2] = s.b;
    this.col[o + 3] = s.p;
    this.dirty(i);
  }

  /** Particles alive at `now` (born and not burned out), in one group or all, optionally of one kind. */
  live(now: number, group?: number, kind?: number): number {
    let n = 0;
    for (let i = 0; i < this.count; i++) {
      if (group !== undefined && this.group[i] !== group) continue;
      const age = now - this.p0[i * 4 + 3];
      if (age >= 0 && age < this.vl[i * 4 + 3] && (kind === undefined || this.sk[i * 4 + 2] === kind)) n++;
    }
    return n;
  }

  /** Slots in use: live particles plus ones waiting to be born (staggered smoke). */
  get used(): number {
    return this.count;
  }

  /** Drop burned-out particles (keeping the live ones packed), then upload what changed. */
  flush(now: number): void {
    this.material.uniforms.uTime.value = now;
    for (let i = this.count - 1; i >= 0; i--) {
      if (now < this.end(i)) continue;
      const last = --this.count;
      this.groupCount[this.group[i]]--;
      if (i !== last) {
        this.p0.copyWithin(i * 4, last * 4, last * 4 + 4);
        this.vl.copyWithin(i * 4, last * 4, last * 4 + 4);
        this.sk.copyWithin(i * 4, last * 4, last * 4 + 4);
        this.col.copyWithin(i * 4, last * 4, last * 4 + 4);
        this.group[i] = this.group[last];
        this.dirty(i);
      }
    }
    this.geo.instanceCount = this.count;
    if (this.dirtyHi < 0) return;
    const hi = Math.min(this.dirtyHi, this.count - 1);
    for (const a of this.attrs) {
      a.clearUpdateRanges();
      if (hi >= this.dirtyLo) a.addUpdateRange(this.dirtyLo * 4, (hi - this.dirtyLo + 1) * 4);
      a.needsUpdate = hi >= this.dirtyLo;
    }
    this.dirtyLo = Infinity;
    this.dirtyHi = -1;
  }

  dispose(): void {
    this.geo.dispose();
    this.material.dispose();
  }
}

const noiseGlsl = /* glsl */ `
  float hash21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
  float vnoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash21(i), hash21(i + vec2(1.0, 0.0)), u.x), mix(hash21(i + vec2(0.0, 1.0)), hash21(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  float fbm(vec2 p) { return 0.5 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 7.1) + 0.2 * vnoise(p * 4.01 + 3.7); }
`;

/** Texture-based noise for the particle shaders: one lookup instead of a dozen hashes per pixel. */
const texNoiseGlsl = /* glsl */ `
  uniform sampler2D uNoise;
  float tnoise(vec2 p) { return texture2D(uNoise, p * 0.125).r; } // value noise, lattice step 1
  float tfbm(vec2 p) { return texture2D(uNoise, p * 0.125).g; }   // three octaves of it
`;

let sharedNoise: THREE.DataTexture | null = null;
/**
 * A tileable 128 x 128 noise texture: R = value noise (8 cells across), G = 3-octave fBm.
 * Built from an integer hash, so it is identical on every run (no Math.random).
 */
export function noiseTexture(): THREE.DataTexture {
  if (sharedNoise) return sharedNoise;
  const N = 128;
  const hash = (x: number, y: number, o: number) => {
    let h = Math.imul(x, 0x27d4eb2d) ^ Math.imul(y, 0x165667b1) ^ Math.imul(o + 1, 0x9e3779b9);
    h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
    h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const value = (u: number, v: number, cells: number, o: number) => {
    const x = u * cells;
    const y = v * cells;
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const w = (a: number) => ((a % cells) + cells) % cells;
    const a = hash(w(ix), w(iy), o);
    const b = hash(w(ix + 1), w(iy), o);
    const c = hash(w(ix), w(iy + 1), o);
    const d = hash(w(ix + 1), w(iy + 1), o);
    return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
  };
  const data = new Uint8Array(N * N * 4);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      const u = i / N;
      const v = j / N;
      const n = value(u, v, 8, 0);
      const f = 0.5 * n + 0.3 * value(u, v, 16, 1) + 0.2 * value(u, v, 32, 2);
      const k = (j * N + i) * 4;
      data[k] = Math.round(n * 255);
      data[k + 1] = Math.round(f * 255);
      data[k + 2] = 0;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  sharedNoise = tex;
  return tex;
}

const vertexShader = /* glsl */ `
  uniform float uTime;
  attribute vec4 aP0;  // start x, y, z, birth time
  attribute vec4 aVL;  // velocity x, y, z, life
  attribute vec4 aSK;  // size0, size1, kind, seed
  attribute vec4 aCol; // sensor colour r, g, b, param (gravity or drag)
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vT;
  varying float vKind;
  varying float vSeed;
  varying float vAge;

  void main() {
    float age = uTime - aP0.w;
    float life = aVL.w;
    float t = age / max(life, 1e-3);
    vKind = aSK.z;
    vSeed = aSK.w;
    vCol = aCol;
    vT = t;
    vAge = age;
    vUv = position.xy * 2.0;
    if (age < 0.0 || t >= 1.0) { gl_Position = vec4(0.0, 0.0, -2.0, 1.0); return; } // not born yet or dead: culled
    float kind = aSK.z;
    vec3 v0 = aVL.xyz;
    float k = aCol.w;
    vec3 p;
    vec3 vNow;
    bool ballistic = kind > 1.5 && kind < 3.5 || abs(kind - 5.0) < 0.5;
    if (ballistic) {
      p = aP0.xyz + v0 * age + vec3(0.0, -0.5 * k * age * age, 0.0);
      vNow = v0 + vec3(0.0, -k * age, 0.0);
      p.y = max(p.y, 1.2); // debris lands rather than sinking
    } else {
      // Drag: fast at first, then drifting (fireball puffs billow out, smoke rises and slows).
      float d = max(k, 1e-3);
      p = aP0.xyz + v0 * (1.0 - exp(-d * age)) / d;
      vNow = v0 * exp(-d * age);
    }
    float grow = 1.0 - (1.0 - t) * (1.0 - t);
    float size = mix(aSK.x, aSK.y, grow);
    vec2 c = position.xy; // -0.5..0.5

    if (abs(kind - 4.0) < 0.5) {
      // Ground shockwave: a flat ring on the ground, above roads and craters.
      vec3 w = vec3(aP0.x + c.x * size, 1.75, aP0.z - c.y * size); // -y keeps the front face up
      gl_Position = projectionMatrix * viewMatrix * vec4(w, 1.0);
      return;
    }
    vec4 mv = viewMatrix * vec4(p, 1.0);
    if (kind > 1.5 && kind < 2.5 || abs(kind - 5.0) < 0.5) {
      // Streaks (sparks, tracers): a quad stretched from where it was a moment ago to where it is now.
      float streakT = abs(kind - 5.0) < 0.5 ? 0.045 : 0.07;
      vec4 tail = viewMatrix * vec4(p - vNow * streakT, 1.0);
      vec2 d = mv.xy - tail.xy;
      float len = length(d);
      vec2 dir = len > 1e-4 ? d / len : vec2(0.0, 1.0);
      vec2 perp = vec2(dir.y, -dir.x); // (perp, dir) must be right-handed, or the quad faces away and is culled
      vec3 q = mix(tail.xyz, mv.xyz, c.y + 0.5);
      q.xy += perp * c.x * size + dir * c.y * size;
      q.z += size * 2.0;
      gl_Position = projectionMatrix * vec4(q, 1.0);
      return;
    }
    if (abs(kind - 6.0) < 0.5) {
      // Flames: anchored at their base, taller than wide.
      mv.xy += vec2(c.x * size, (c.y + 0.35) * size * 1.15);
    } else {
      mv.xy += c * size;
    }
    // Pull billboards toward the camera so the ground doesn't slice off their lower half.
    mv.z += size * 0.6 + 2.0;
    gl_Position = projectionMatrix * mv;
  }
`;

const additiveFragment = /* glsl */ `
  uniform float uTime;
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vT;
  varying float vKind;
  varying float vSeed;
  varying float vAge;
  ${texNoiseGlsl}
  void main() {
    float r = length(vUv);
    float t = vT;
    bool streak = vKind > 1.5 && vKind < 2.5 || abs(vKind - 5.0) < 0.5;
    if (r > 1.0 && !streak && vKind < 5.5) discard; // round sprites: skip the quad's corners cheaply
    vec3 col = vec3(0.0);
    if (vKind < 0.5) {
      // Flash: a short, local glow. Never full-screen.
      float a = exp(-r * r * 5.0) * (1.0 - t) * (1.0 - t);
      col = vCol.rgb * a;
    } else if (vKind < 1.5) {
      // Fireball puff: turbulent noise with hot pockets and a ragged edge that thins as it cools.
      vec2 q = vUv * 1.8 + vSeed * 17.0;
      float n = tfbm(q + vec2(0.0, -vAge * 1.5));
      float n2 = tnoise(q * 3.1 - vAge * 2.0);
      float edgeR = 0.95 - 0.35 * t;
      float shape = 1.0 - smoothstep(edgeR * (0.45 + 0.5 * n), edgeR * (0.8 + 0.4 * n), r);
      float core = 1.0 - smoothstep(0.0, 0.7, r);
      float temp = shape * (0.45 + 0.55 * n2) * (0.6 + 0.7 * core);
      float heat = vCol.r * temp * pow(1.0 - t, 1.2);
      float vis = vCol.g * temp * pow(1.0 - t, 2.5) * (0.7 + 0.6 * core);
      col = vec3(heat, vis, vCol.b * temp * (1.0 - t));
    } else if (vKind < 2.5 || abs(vKind - 5.0) < 0.5) {
      // Spark or tracer streak: bright core line, soft sides.
      float across = 1.0 - abs(vUv.x);
      float a = across * across;
      float fade = abs(vKind - 5.0) < 0.5 ? 1.0 : (1.0 - t);
      col = vCol.rgb * a * fade;
    } else if (vKind < 3.5) {
      // Debris ember: a small glowing chunk that cools as it flies.
      float a = 1.0 - smoothstep(0.4, 1.0, r);
      col = vCol.rgb * a * pow(1.0 - t, 1.5);
    } else if (vKind < 4.5) {
      // Shockwave: a thin ring racing outward, kicked-up dust lit by the blast.
      float ang = atan(vUv.y, vUv.x);
      float wob = 0.85 + 0.3 * tnoise(vec2(cos(ang), sin(ang)) * 2.5 + vSeed * 20.0);
      float ring = exp(-pow((r - 0.82) / (0.06 + 0.1 * t), 2.0));
      col = vCol.rgb * ring * wob * (1.0 - t) * (1.0 - t);
    } else {
      // Lingering fire: a flickering tongue of flame with a hot core, cooling over its life.
      float n = tfbm(vec2(vUv.x * 1.5 + vSeed * 9.0, vUv.y * 1.2 - uTime * 2.2));
      // Round at the base, narrowing into a tongue that licks upward with the noise.
      vec2 q = vec2(vUv.x * (1.0 + 0.9 * max(vUv.y + 0.2, 0.0)), vUv.y + 0.3);
      float d = length(q) + 0.45 * (n - 0.5);
      float flame = 1.0 - smoothstep(0.25, 0.85, d);
      float core = 1.0 - smoothstep(0.0, 0.35, d);
      float flicker = 0.75 + 0.25 * sin(uTime * 13.0 + vSeed * 30.0) * sin(uTime * 7.3 + vSeed * 11.0);
      float fadeIn = smoothstep(0.0, 0.04, t);
      float cool = pow(1.0 - t, 1.4);
      col = vec3(vCol.r * cool * (flame + 0.5 * core), vCol.g * cool * (flame + core), 0.0) * flicker * fadeIn;
    }
    if (col.r + col.g + col.b < 0.002) discard;
    gl_FragColor = vec4(col, 1.0);
  }
`;

const smokeFragment = /* glsl */ `
  uniform float uTime;
  uniform float uThermal; // how much smoke dims heat (small: long-wave infrared passes through smoke)
  uniform float uVisible; // how much smoke dims visible light (large)
  uniform float uNir;     // how much smoke dims near-infrared
  varying vec2 vUv;
  varying vec4 vCol;
  varying float vT;
  varying float vSeed;
  varying float vAge;
  ${texNoiseGlsl}
  void main() {
    float r = length(vUv);
    if (r > 1.15) discard; // outside the puff: no noise work
    float n = tfbm(vUv * 1.3 + vSeed * 31.0 + vec2(vAge * 0.15, -vAge * 0.25));
    float n2 = tnoise(vUv * 3.7 - vSeed * 5.0 + vAge * 0.3);
    float body = 1.0 - smoothstep(0.2, 1.0, r + 0.4 * (n - 0.5));
    float lumps = smoothstep(0.2, 0.85, n * 0.75 + n2 * 0.35);
    float env = smoothstep(0.0, 0.15, vT) * pow(1.0 - vT, 1.3);
    float d = clamp(body * lumps * env * vCol.r, 0.0, 1.0);
    if (d < 0.004) discard;
    // Multiply blend: the scene behind is scaled per channel. G and B (night vision) drop a lot,
    // R (thermal) barely changes: smoke hides things from night vision but not from thermal.
    gl_FragColor = vec4(1.0 - d * uThermal, 1.0 - d * uVisible, 1.0 - d * uNir, 1.0);
  }
`;

/** Tracers, flashes, fireballs, sparks, debris, shockwaves and fires: added onto the scene. */
export function makeAdditiveMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uNoise: { value: noiseTexture() } },
    vertexShader,
    fragmentShader: additiveFragment,
    blending: THREE.AdditiveBlending,
    transparent: true,
    depthWrite: false,
  });
}

/** How strongly smoke dims each sensor channel at full density. */
export const SMOKE_DIM = { thermal: 0.05, visible: 0.78, nir: 0.68 } as const;

/** Smoke: multiplies the scene behind it (premultiplied multiply = dst × src per channel). */
export function makeSmokeMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uNoise: { value: noiseTexture() },
      uThermal: { value: SMOKE_DIM.thermal },
      uVisible: { value: SMOKE_DIM.visible },
      uNir: { value: SMOKE_DIM.nir },
    },
    vertexShader,
    fragmentShader: smokeFragment,
    blending: THREE.MultiplyBlending,
    premultipliedAlpha: true,
    transparent: true,
    depthWrite: false,
  });
}

/** Craters: scorched discs with a hot centre and ragged rim; heat per instance comes from instanceColor. */
export function makeCraterMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    vertexShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vSig;
      varying float vSeed;
      void main() {
        vUv = uv * 2.0 - 1.0;
        #ifdef USE_INSTANCING_COLOR
          vSig = instanceColor;
        #else
          vSig = vec3(0.4, 0.03, 0.0);
        #endif
        vSeed = fract(instanceMatrix[3].x * 0.137 + instanceMatrix[3].z * 0.071);
        gl_Position = projectionMatrix * viewMatrix * modelMatrix * instanceMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      varying vec2 vUv;
      varying vec3 vSig;
      varying float vSeed;
      ${noiseGlsl}
      void main() {
        float r = length(vUv);
        float ang = atan(vUv.y, vUv.x);
        float rim = 0.78 + 0.22 * vnoise(vec2(ang * 2.2 + vSeed * 40.0, vSeed * 9.0));
        if (r > rim) discard;
        float x = r / rim;
        // Hot centre fading to warm ground at the edge; a lighter ring of thrown-up earth on night vision.
        float heat = mix(vSig.r, 0.24, x * x) * (0.92 + 0.16 * vnoise(vUv * 3.0 + vSeed * 13.0));
        float vis = mix(vSig.g, 0.1, smoothstep(0.7, 1.0, x));
        gl_FragColor = vec4(heat, vis, 0.0, 1.0);
      }
    `,
  });
}
