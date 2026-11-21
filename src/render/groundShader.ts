import type * as THREE from 'three';

/**
 * Procedural surface texture for the flat, unlit ground materials (no image files, no extra draw calls).
 * It edits the material's sensor values in place, in world space, so the texture is fixed to the map
 * (it never crawls or flickers as the camera moves):
 *   asphalt  a network of thin warm cracks and seams (Voronoi cell edges), patchy heat, fine grit;
 *   ground   (yards, verges, lots) patchy heat and faint seams;
 *   grass    (parks, woods) a very fine, faint mottle, and nothing else: cold-blooded zombies sit at
 *            ground heat and must stay lost on grass (PLAN §5a), so nothing warm is ever added there.
 * Heat changes are small and centred on the surface's own value (see docs/STYLE.md for the ranges).
 * Lines thinner than about a pixel fade out (using screen-space derivatives), so wide lenses don't shimmer.
 */
export type SurfaceKind = 'asphalt' | 'ground' | 'grass';

interface KindParams {
  /** Seam network cell size, metres (fine cracks are about a quarter of it), and crack strength (heat added on a crack). */
  cell: number;
  crack: number;
  /** Large heat patches (±, heat units) and fine grit (±). */
  patch: number;
  grit: number;
  /** How much the texture also shows in visible light (night vision), as a fraction. */
  visible: number;
}

const KINDS: Record<SurfaceKind, KindParams> = {
  asphalt: { cell: 13, crack: 0.04, patch: 0.03, grit: 0.012, visible: 0.5 },
  ground: { cell: 16, crack: 0.012, patch: 0.02, grit: 0.008, visible: 0.45 },
  grass: { cell: 1, crack: 0, patch: 0.007, grit: 0.006, visible: 0.6 },
};

/** GLSL: hash, value noise and Voronoi edge distance (shared with nothing else, kept here). */
const NOISE = /* glsl */ `
  varying vec3 vSurfPos;
  uniform vec4 uSurf;   // cell size (m), crack heat, patch heat, grit heat
  uniform float uSurfVis;
  uniform float uSurfFine;
  uniform float uSurfDetail;
  float sHash(vec2 p) { p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.x); }
  vec2 sHash2(vec2 p) { return vec2(sHash(p), sHash(p + 17.31)); }
  float sNoise(vec2 p) {
    vec2 i = floor(p); vec2 f = fract(p); vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(sHash(i), sHash(i + vec2(1.0, 0.0)), u.x), mix(sHash(i + vec2(0.0, 1.0)), sHash(i + vec2(1.0, 1.0)), u.x), u.y);
  }
  // Roughly the distance to the nearest Voronoi cell edge (cell units): half the gap between the nearest
  // and second-nearest jittered cell centres, from one 3 x 3 search (cheap enough for phones).
  float sVoronoiEdge(vec2 p) {
    vec2 n = floor(p); vec2 f = fract(p);
    float d1 = 8.0; float d2 = 8.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 g = vec2(float(i), float(j));
      vec2 r = g + 0.15 + 0.7 * sHash2(n + g) - f;
      float d = dot(r, r);
      if (d < d1) { d2 = d1; d1 = d; } else if (d < d2) { d2 = d; }
    }
    return 0.5 * (sqrt(d2) - sqrt(d1));
  }
`;

const APPLY = /* glsl */ `
  {
    vec2 sp = vSurfPos.xz;
    float heat = diffuseColor.r;
    // Water and anything very cold stays flat.
    float live = smoothstep(0.12, 0.17, heat);
    float blot = (sNoise(sp / 23.0) * 0.65 + sNoise(sp / 7.0) * 0.35) - 0.5;
    float grit = sNoise(sp / 0.9) - 0.5;
    float dh = (blot * 2.0 * uSurf.z + grit * 2.0 * uSurf.w) * live;
    float crackLine = 0.0;
    if (uSurf.y > 0.0) {
      // Wiggle the lines a little so they read as cracks, not tiles.
      vec2 warp = vec2(sNoise(sp / 2.7), sNoise(sp / 2.7 + 5.2)) - 0.5;
      // Long seams (cells of uSurf.x metres) and, only in worn patches, finer cracks (a quarter the size).
      vec2 cp = sp / uSurf.x + warp * 0.18;
      float pxL = length(fwidth(cp));
      float wL = 0.012 + pxL * 0.75;
      // Fade lines out when their cells get small on screen (no shimmer at wide lenses).
      float cL = (1.0 - smoothstep(wL * 0.5, wL, sVoronoiEdge(cp))) * (1.0 - smoothstep(0.03, 0.12, pxL));
      // Seams come and go along their length.
      crackLine = cL * smoothstep(0.3, 0.55, sNoise(sp / 11.0 + 3.1));
      // Fine cracks (asphalt, high detail only), only where the surface is worn.
      if (uSurfFine > 0.0 && uSurfDetail > 0.5) {
        vec2 fp = sp / (uSurf.x * 0.28) + warp * 0.35;
        float pxF = length(fwidth(fp));
        float wF = 0.03 + pxF * 0.75;
        float cF = (1.0 - smoothstep(wF * 0.5, wF, sVoronoiEdge(fp))) * (1.0 - smoothstep(0.08, 0.25, pxF));
        crackLine = max(crackLine, cF * smoothstep(0.58, 0.72, sNoise(sp / 6.0 + 9.7)) * 0.7 * uSurfFine);
      }
      dh += crackLine * uSurf.y * live;
    }
    diffuseColor.r = heat + dh;
    // Visible light (night vision): the same patches, and cracks a little darker (shadowed).
    diffuseColor.g *= 1.0 + uSurfVis * (dh / max(heat, 0.05)) * 1.5 - crackLine * uSurfVis * 0.35;
  }
`;

/** Shared by every textured surface: 1 = full detail (fine cracks), 0 = the cheap path (set by SensorPost's tier). */
export const surfaceDetail = { value: 1 };

/**
 * Add the procedural texture to a flat (unlit) sensor material. Call once per material; safe with
 * vertex colours, and composes with an existing onBeforeCompile (e.g. the world's edge fade).
 * Returns the material.
 */
export function applySurfaceTexture<M extends THREE.MeshBasicMaterial>(material: M, kind: SurfaceKind): M {
  const k = KINDS[kind];
  const prev = material.onBeforeCompile.bind(material);
  const prevKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uSurf = { value: [k.cell, k.crack, k.patch, k.grit] };
    shader.uniforms.uSurfVis = { value: k.visible };
    shader.uniforms.uSurfFine = { value: kind === 'asphalt' ? 1 : 0 };
    shader.uniforms.uSurfDetail = surfaceDetail;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vSurfPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvSurfPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${NOISE}`)
      .replace('#include <color_fragment>', `#include <color_fragment>\n${APPLY}`);
  };
  material.customProgramCacheKey = () => `${prevKey()}|surface-${kind}`;
  material.needsUpdate = true;
  return material;
}

/** The texture's largest heat offsets per kind, for the style guide and tests: [lowest, highest]. */
export function surfaceHeatRange(kind: SurfaceKind): [number, number] {
  const k = KINDS[kind];
  const sway = k.patch + k.grit;
  return [-sway, sway + k.crack];
}

/**
 * Street-lamp pools (night vision only: visible light, no heat): fade the flat disc to a soft
 * pool, brightest under the lamp. The disc's own radius (metres, in its local XZ) sets the falloff.
 */
export function applyLampFalloff(material: THREE.MeshBasicMaterial, radius: number): void {
  const prev = material.onBeforeCompile.bind(material);
  const prevKey = material.customProgramCacheKey.bind(material);
  material.onBeforeCompile = (shader, renderer) => {
    prev(shader, renderer);
    shader.uniforms.uLampR = { value: radius };
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLampXZ;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLampXZ = position.xz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vLampXZ;\nuniform float uLampR;')
      .replace('#include <color_fragment>', '#include <color_fragment>\n{ float q = clamp(1.0 - length(vLampXZ) / uLampR, 0.0, 1.0); diffuseColor.rgb *= q * q * 1.9; }');
  };
  material.customProgramCacheKey = () => `${prevKey()}|lamp-pool`;
  material.needsUpdate = true;
}
