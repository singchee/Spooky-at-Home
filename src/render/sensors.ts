import * as THREE from 'three';

/**
 * The camera filter. The 3D scene is drawn with sensor values in its colour channels
 * (R heat, G visible light, B near-infrared); this shader turns them into either a
 * thermal picture (white-hot or black-hot) or a green night-vision picture, and gives it a
 * sensor's character: slight softness, detail enhancement (the FLIR "halo" on every heat edge),
 * bright outlines on building and tree silhouettes, soft bloom on hot (or bright) things, film
 * grain, faint scanlines and a vignette. Everything works on sensor values before the display
 * mapping, so black-hot inverts the glow and outlines too, and night vision only blooms what
 * night vision can see (visible light and near-infrared: the survivors' strobes, never heat).
 *
 * Photosensitivity: grain is fine and averages out at any scale; scanlines and the slow roll are a
 * few per cent of brightness. With reduce flicker (`calm`) the grain is frozen, nothing rolls, and the
 * camera-switch cover is a flat fade instead of static. See docs/STYLE.md for the numbers.
 */
export type SensorId = 'thermal' | 'night';

export const SensorShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    /** Scene depth (perspective), for silhouette outlines. Only read when `edges` is 1. */
    tDepth: { value: null as THREE.Texture | null },
    /** Blurred bright parts: R = hot (thermal), G = bright (night vision). Only read when `bloom` > 0. */
    tBloom: { value: null as THREE.Texture | null },
    time: { value: 0 },
    mode: { value: 0 },
    polarity: { value: 0 },
    washout: { value: 0 },
    blank: { value: 0 },
    /** 1 = reduce flicker: the camera-switch cover is a flat, gentle fade instead of static noise. */
    calm: { value: 0 },
    /** Drawing-buffer size in device pixels, and device pixels per CSS pixel. */
    res: { value: new THREE.Vector2(1, 1) },
    pr: { value: 1 },
    /** Camera near and far planes (to turn depth into metres). */
    cNear: { value: 600 },
    cFar: { value: 6000 },
    /** Bloom strength (0 = off) and silhouette outlines (0/1). */
    bloom: { value: 1 },
    edges: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform sampler2D tDepth;
    uniform sampler2D tBloom;
    uniform float time, mode, polarity, washout, blank, calm, pr, cNear, cFar, bloom, edges;
    uniform vec2 res;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    float metres(vec2 uv) {
      float z = texture2D(tDepth, uv).x * 2.0 - 1.0;
      return 2.0 * cNear * cFar / (cFar + cNear - z * (cFar - cNear));
    }
    void main() {
      vec2 px = 1.0 / res;
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      // Sensor softness: a little of the 1-pixel neighbourhood.
      vec3 b1 = (texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb +
                 texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb) * 0.25;
      // Detail enhancement: the picture minus a wider blur (about 3 CSS px), added back. Every clear heat
      // edge gets a thin bright/dark halo (the FLIR look), scaled by its own contrast.
      vec2 w = px * 3.0 * pr;
      vec3 b2 = (texture2D(tDiffuse, vUv + vec2(w.x, w.y)).rgb + texture2D(tDiffuse, vUv + vec2(-w.x, w.y)).rgb +
                 texture2D(tDiffuse, vUv + vec2(w.x, -w.y)).rgb + texture2D(tDiffuse, vUv + vec2(-w.x, -w.y)).rgb) * 0.25;
      b2 = mix(b2, b1, 0.3);
      vec3 s = mix(c, b1, 0.3);
      // Coring: differences under about 0.015 (a cold-blooded zombie against grass is 0.01) get no boost,
      // so the halo never digs out something the sensor shouldn't see.
      vec3 dd = s - b2;
      s += dd * smoothstep(vec3(0.012), vec3(0.03), abs(dd)) * 0.85;
      // Silhouettes: a pixel in front of something more than a few metres further away (a roof edge
      // over the street behind it, a tree crown). People are too short to trip it, so a cold-blooded
      // zombie never gets an outline.
      float rim = 0.0;
      if (edges > 0.5) {
        vec2 e = px * 1.5 * pr;
        float dc = metres(vUv);
        float dn = max(max(metres(vUv + vec2(e.x, 0.0)), metres(vUv - vec2(e.x, 0.0))),
                       max(metres(vUv + vec2(0.0, e.y)), metres(vUv - vec2(0.0, e.y))));
        rim = smoothstep(4.5, 8.0, dn - dc);
      }
      vec3 bl = bloom > 0.0 ? texture2D(tBloom, vUv).rgb * bloom : vec3(0.0);
      // Grain: one value per CSS pixel, 30 new patterns a second (frozen with reduce flicker).
      float gt = floor(time * 30.0) * (1.0 - calm);
      vec2 cell = floor(gl_FragCoord.xy / max(pr, 1.0));
      float n = hash(cell + fract(gt * 0.618) * vec2(91.7, 37.3)) - 0.5;
      // Scanlines (every 3 CSS px) and a slow, faint rolling band (off with reduce flicker).
      float sl = 1.0 - 0.045 * (0.5 + 0.5 * sin(gl_FragCoord.y / max(pr, 1.0) * 2.0944));
      float roll = (1.0 - calm) * 0.025 * smoothstep(0.75, 1.0, 1.0 - abs(fract(vUv.y * 0.6 - time * 0.07) - 0.5) * 2.0);
      vec2 d = (vUv - 0.5) * vec2(res.x / res.y, 1.0);
      float vig = 1.0 - smoothstep(0.3, 1.05, length(d)) * 0.5;
      vec3 outc;
      if (mode < 0.5) {
        // Outlines lift a silhouette toward a bright line (below warm-body heat), whatever its own heat.
        float h = s.r + rim * (max(0.0, 0.44 - s.r) * 0.75 + 0.03) + bl.r;
        float l = (h - 0.08) * 1.7;
        l = mix(l, 1.0 - l, polarity);
        l += n * 0.06;
        outc = vec3((l * sl + roll) * vig);
      } else {
        float l = (s.g + s.b) * 3.0 + rim * 0.12 + bl.g;
        l = l * (1.0 - washout * 0.6) + washout * 0.7;
        l += n * 0.15;
        outc = vec3(0.3, 1.0, 0.4) * (l * sl + roll) * vig;
      }
      outc = mix(outc, vec3(0.3 + n * 0.25 * (1.0 - calm)), blank);
      gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
    }
  `,
};

/**
 * Bloom, step 1: the bright parts of the scene at reduced resolution (a 4-tap box filter, so the
 * downsampled picture doesn't sparkle). R = heat above warm-body level (thermal glow), G = visible
 * plus near-infrared light above street-lamp level (night-vision glow; strobes, fires, muzzle flashes).
 */
export const BrightShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    texel: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: SensorShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 texel;
    varying vec2 vUv;
    void main() {
      vec2 o = texel * 0.5;
      vec3 c = (texture2D(tDiffuse, vUv + vec2(o.x, o.y)).rgb + texture2D(tDiffuse, vUv + vec2(-o.x, o.y)).rgb +
                texture2D(tDiffuse, vUv + vec2(o.x, -o.y)).rgb + texture2D(tDiffuse, vUv + vec2(-o.x, -o.y)).rgb) * 0.25;
      float hot = max(c.r - 0.45, 0.0);
      float lit = max((c.g + c.b) * 3.0 - 1.0, 0.0);
      gl_FragColor = vec4(hot, lit, 0.0, 1.0);
    }
  `,
};

/** Bloom, steps 2 and 3: a 9-tap Gaussian blur along `dir` (texels). */
export const BlurShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    dir: { value: new THREE.Vector2(1, 0) },
  },
  vertexShader: SensorShader.vertexShader,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform vec2 dir;
    varying vec2 vUv;
    void main() {
      vec3 s = texture2D(tDiffuse, vUv).rgb * 0.2270;
      s += (texture2D(tDiffuse, vUv + dir * 1.3846).rgb + texture2D(tDiffuse, vUv - dir * 1.3846).rgb) * 0.3162;
      s += (texture2D(tDiffuse, vUv + dir * 3.2308).rgb + texture2D(tDiffuse, vUv - dir * 3.2308).rgb) * 0.0703;
      gl_FragColor = vec4(s, 1.0);
    }
  `,
};
