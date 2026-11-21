import * as THREE from 'three';

/**
 * The camera filter. The 3D scene is drawn with sensor values in its colour channels
 * (R heat, G visible light, B near-infrared); this shader turns them into either a
 * thermal picture (white-hot or black-hot) or a green night-vision picture.
 */
export type SensorId = 'thermal' | 'night';

export const SensorShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    time: { value: 0 },
    mode: { value: 0 },
    polarity: { value: 0 },
    washout: { value: 0 },
    blank: { value: 0 },
    res: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float time, mode, polarity, washout, blank;
    uniform vec2 res;
    varying vec2 vUv;
    float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
    void main() {
      vec2 px = 1.0 / res;
      vec3 c = texture2D(tDiffuse, vUv).rgb;
      vec3 b = (texture2D(tDiffuse, vUv + vec2(px.x, 0.0)).rgb + texture2D(tDiffuse, vUv - vec2(px.x, 0.0)).rgb +
                texture2D(tDiffuse, vUv + vec2(0.0, px.y)).rgb + texture2D(tDiffuse, vUv - vec2(0.0, px.y)).rgb) * 0.25;
      c = mix(c, b, 0.3);
      float n = hash(floor(vUv * res) + fract(time) * vec2(91.7, 37.3)) - 0.5;
      vec2 d = vUv - 0.5;
      float vig = 1.0 - dot(d, d) * 1.1;
      vec3 outc;
      if (mode < 0.5) {
        float l = (c.r - 0.08) * 1.7;
        l = mix(l, 1.0 - l, polarity);
        l += n * 0.05;
        outc = vec3(l * vig);
      } else {
        float l = c.g * 3.0 + c.b * 3.0;
        l = l * (1.0 - washout * 0.6) + washout * 0.7;
        l += n * 0.15;
        outc = vec3(0.3, 1.0, 0.4) * l * vig;
      }
      outc = mix(outc, vec3(0.3 + n * 0.25), blank);
      gl_FragColor = vec4(clamp(outc, 0.0, 1.0), 1.0);
    }
  `,
};
