import * as THREE from 'three';

/**
 * Shader additions for the world's materials (MeshBasicMaterial only: world colours are sensor
 * values, so nothing is lit at draw time; shape shading is baked into vertex colours).
 *
 * - Edge fade: within the last few tens of metres of the map and beyond it, every surface fades
 *   to a neutral value, so the 105's wide view shows the town dissolving into featureless ground
 *   instead of ending at a hard line. The ground past the edge gets a faint, blurry texture so it
 *   reads as more land, out of reach, rather than a void.
 * - Windows: a procedural window grid on walls. Only the visible-light channel (G) changes, so
 *   night vision gets lit and dark windows while thermal stays exactly as it was.
 */
export interface FadeOpts {
  /** Half the playable square, metres. */
  half: number;
  /** What everything fades to (sensor values). Additive materials fade to black. */
  to: readonly [number, number, number];
  /** Faint low-frequency texture past the edge (the ground only). */
  noise?: boolean;
  /** Procedural windows on walls (buildings only; needs the `wall` attribute). */
  windows?: boolean;
  /**
   * The building cut-away (3.39; buildings only, needs the `wall` and `bid` attributes): per building,
   * texel bid of this texture holds (fade 0-1, top, cut height). 'solid' draws everything below the cut
   * line; 'ghost' draws what is above it as a see-through wall with bright edges (a transparent material).
   */
  cut?: { tex: THREE.Texture; part: 'solid' | 'ghost' };
}

/**
 * The see-through part of a cut building (tune after play): front-face opacity (owner: 35-50%, it must
 * still read as solid cover), edge opacity, and the edge's sensor value (road-warm, a lit-window glow).
 */
export const GHOST = { wall: 0.45, edge: 0.9, edgeSig: [0.33, 0.17, 0] as const };
const GHOST_WALL = GHOST.wall.toFixed(3);
const GHOST_EDGE = GHOST.edge.toFixed(3);
const GHOST_SIG = GHOST.edgeSig.map((v) => v.toFixed(3)).join(', ');

/** Fade starts this far inside the edge and is complete this far outside it (metres). */
export const FADE_RANGE = [-50, 25] as const;

/** Same formula as the shader: 0 inside the map, 1 once fully faded. */
export function edgeFade(x: number, z: number, half: number): number {
  const dx = Math.abs(x) - half;
  const dz = Math.abs(z) - half;
  const e = Math.hypot(Math.max(dx, 0), Math.max(dz, 0)) + Math.min(Math.max(dx, dz), 0);
  const t = Math.min(1, Math.max(0, (e - FADE_RANGE[0]) / (FADE_RANGE[1] - FADE_RANGE[0])));
  return t * t * (3 - 2 * t);
}

const VERT_PARS = /* glsl */ `
varying vec3 vSwWorld;
#if defined(SW_WINDOWS) || defined(SW_CUT)
attribute vec4 wall;
varying vec4 vWall;
#endif
#ifdef SW_CUT
attribute float bid;
uniform highp sampler2D uCut;
varying float vCutH;
varying float vCutF;
#endif
`;

const VERT_MAIN = /* glsl */ `
{
  vec4 sw = vec4(transformed, 1.0);
  #ifdef USE_INSTANCING
    sw = instanceMatrix * sw;
  #endif
  sw = modelMatrix * sw;
  vSwWorld = sw.xyz;
  #if defined(SW_WINDOWS) || defined(SW_CUT)
    vWall = wall;
  #endif
  #ifdef SW_CUT
    int cutId = int(bid + 0.5);
    int cutW = textureSize(uCut, 0).x;
    vec4 cut = texelFetch(uCut, ivec2(cutId % cutW, cutId / cutW), 0);
    float cutE = cut.r * cut.r * (3.0 - 2.0 * cut.r);
    vCutF = cutE;
    // The cut line sweeps down from just above the top to the stump as the building fades.
    vCutH = cutE < 0.001 ? 1e5 : mix(cut.g + 0.5, cut.b, cutE);
    #ifdef SW_GHOST
      if (cutE < 0.001) gl_Position = vec4(0.0, 0.0, 2.0, 1.0);   // not cut: outside the clip volume, no fill cost
    #endif
  #endif
}
`;

const FRAG_PARS = /* glsl */ `
uniform float uSwHalf;
uniform vec2 uSwRange;
uniform vec3 uSwTo;
varying vec3 vSwWorld;
#if defined(SW_WINDOWS) || defined(SW_CUT)
varying vec4 vWall;
#endif
#ifdef SW_CUT
varying float vCutH;
varying float vCutF;
#endif
float swHash(vec3 p) { return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453); }
float swNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = swHash(vec3(i, 1.0));
  float b = swHash(vec3(i + vec2(1.0, 0.0), 1.0));
  float c = swHash(vec3(i + vec2(0.0, 1.0), 1.0));
  float d = swHash(vec3(i + vec2(1.0, 1.0), 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
`;

/*
 * wall = (u: metres along the wall, wall length, wall-top height, style + seed)
 * style 0: no windows; 1: house; 2: shops, offices and flats. The fractional part seeds which
 * windows are lit. Windows fade to their average brightness once they are smaller than a few
 * pixels, so the wide views don't shimmer.
 */
const FRAG_WINDOWS = /* glsl */ `
#ifdef SW_WINDOWS
{
  float style = floor(vWall.w + 0.001);
  if (style > 0.5) {
    // Whole numbers only: an interpolated float fed to the hash would vary per pixel and speckle.
    float seed = floor(fract(vWall.w) * 64.0);
    bool big = style > 1.5;
    float cellW = big ? 4.0 : 3.4;
    float floorH = big ? 3.6 : 3.0;
    float n = floor(vWall.y / cellW);
    float lu = (vWall.x - (vWall.y - n * cellW) * 0.5) / cellW;
    float col = floor(lu);
    float fx = fract(lu);
    float ly = vSwWorld.y / floorH;
    float row = floor(ly);
    float fy = fract(ly);
    float halfW = big ? (row < 0.5 ? 0.44 : 0.33) : 0.28;
    float inX = step(abs(fx - 0.5), halfW) * step(0.0, col) * step(col, n - 1.0);
    float inY = step(0.25, fy) * step(fy, 0.8) * step((row + 0.75) * floorH, vWall.z);
    float win = inX * inY;
    float h = swHash(vec3(mod(col, 37.0), mod(row, 23.0), seed));
    float litP = big ? (row < 0.5 ? 0.45 : 0.28) : 0.3;
    float lit = step(h, litP);
    float glow = 0.3 + 0.3 * fract(h * 17.0);
    float g = diffuseColor.g;
    float sharp = mix(g, g * 0.35 + lit * glow, win);
    float cover = 2.0 * halfW * 0.55;
    float avg = mix(g, g * 0.35 + litP * 0.45, cover);
    float px = max(fwidth(lu), fwidth(ly) * floorH / cellW);
    diffuseColor.g = mix(sharp, avg, smoothstep(0.12, 0.4, px));
  }
}
#endif
`;

/*
 * The cut-away. Solid: nothing above the cut line. Ghost: only what is above it, as a faint wall
 * (front faces) with brighter edges at the roof line, the corners and the cut line, all scaled by the
 * fade. Blending only ever mixes toward a wall or edge value (never above heat 0.34), so the ghost
 * can't create a hot spot, and it lowers contrast under it rather than raising it: a cold-blooded
 * zombie on grass stays hidden.
 */
const FRAG_CUT = /* glsl */ `
#ifdef SW_CUT
  #ifdef SW_GHOST
  if (vCutF < 0.001 || vSwWorld.y <= vCutH) discard;
  #else
  if (vSwWorld.y > vCutH) discard;
  #endif
#endif
`;

const FRAG_GHOST = /* glsl */ `
#ifdef SW_GHOST
{
  float fy = max(fwidth(vSwWorld.y), 1e-4);
  float edge = 1.0 - smoothstep(0.7, 1.7, (vSwWorld.y - vCutH) / fy);
  // Front faces (walls and roofs) stay partly opaque: still cover, not a hole. Back faces: edges only.
  float fill = gl_FrontFacing ? ${GHOST_WALL} : 0.0;
  if (vWall.y > 0.0) {
    float fu = max(fwidth(vWall.x), 1e-4);
    edge = max(edge, 1.0 - smoothstep(0.7, 1.7, (vWall.z - vSwWorld.y) / fy));
    edge = max(edge, 1.0 - smoothstep(0.7, 1.7, min(vWall.x, vWall.y - vWall.x) / fu));
  }
  // Not scaled by the fade: the cut line itself sweeps down over FADE_TIME, a smooth wipe.
  float a = mix(fill, ${GHOST_EDGE}, edge);
  if (a < 0.003) discard;
  outgoingLight = mix(outgoingLight, vec3(${GHOST_SIG}), edge);
  diffuseColor.a = a;
}
#endif
`;

const FRAG_FADE = /* glsl */ `
{
  vec2 dd = abs(vSwWorld.xz) - vec2(uSwHalf);
  float e = length(max(dd, 0.0)) + min(max(dd.x, dd.y), 0.0);
  float f = smoothstep(uSwRange.x, uSwRange.y, e);
  vec3 to = uSwTo;
  #ifdef SW_NOISE
    float nz = swNoise(vSwWorld.xz / 70.0) * 0.65 + swNoise(vSwWorld.xz / 23.0) * 0.35 - 0.5;
    to += vec3(0.03, 0.035, 0.0) * nz * smoothstep(0.0, 400.0, e);
  #endif
  outgoingLight = mix(outgoingLight, to, f);
}
`;

let uid = 0;

/** Adds the edge fade (and optionally windows or ground texture) to a world material. */
export function patchMaterial<M extends THREE.MeshBasicMaterial>(mat: M, o: FadeOpts): M {
  const id = ++uid;
  const defines: Record<string, string> = {};
  if (o.noise) defines.SW_NOISE = '';
  if (o.windows) defines.SW_WINDOWS = '';
  if (o.cut) defines.SW_CUT = '';
  if (o.cut?.part === 'ghost') defines.SW_GHOST = '';
  mat.defines = { ...(mat.defines ?? {}), ...defines };
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSwHalf = { value: o.half };
    sh.uniforms.uSwRange = { value: new THREE.Vector2(FADE_RANGE[0], FADE_RANGE[1]) };
    sh.uniforms.uSwTo = { value: new THREE.Vector3(...o.to) };
    if (o.cut) sh.uniforms.uCut = { value: o.cut.tex };
    sh.vertexShader = sh.vertexShader.replace('#include <common>', `#include <common>\n${VERT_PARS}`).replace('#include <project_vertex>', `#include <project_vertex>\n${VERT_MAIN}`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>\n${FRAG_PARS}`)
      .replace('#include <clipping_planes_fragment>', `#include <clipping_planes_fragment>\n${FRAG_CUT}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${FRAG_WINDOWS}`)
      .replace('#include <opaque_fragment>', `${FRAG_GHOST}\n${FRAG_FADE}\n#include <opaque_fragment>`);
  };
  // Each patched material has its own uniforms baked in at compile time: keep programs apart.
  mat.customProgramCacheKey = () => `sw-${id}-${o.noise ? 1 : 0}${o.windows ? 1 : 0}${o.cut ? o.cut.part : ''}`;
  return mat;
}
