/**
 * Figure lean (3.39), shared by the model figures (modelShader.ts), the procedural / crowd level-of-detail
 * figures (figureShader.ts) and the IR strobes (agentsView.ts): the camera rides the line of fire, often
 * steeper than the old 40° slant, where a standing figure would shrink to a blob. Each figure leans back,
 * away from the camera (a shear pivoting at the feet, so a body lying down barely moves), just enough to
 * keep the screen height it had at 40°.
 */
/** The most a figure leans back on a steep view (horizontal metres per metre of height). */
export const FIGURE_LEAN_MAX = 0.6;
/** Figures lean back to keep the screen height they would have seen from this many degrees off vertical. */
export const FIGURE_LEAN_REF_DEG = 40;
const LEAN_SIN = Math.sin((FIGURE_LEAN_REF_DEG * Math.PI) / 180);

/**
 * How far a figure leans back, away from the camera (horizontal metres per metre of height), given
 * the vector from its feet to the camera. LEAN_GLSL does the same sums on the GPU; the IR strobe
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

/** The same sums in GLSL: shears `p` (feet-relative, after yaw) for a figure whose feet are at `feet`. */
export function LEAN_GLSL(feet: string, p: string): string {
  return `{
      vec3 toCam = cameraPosition - ${feet};
      float hz = length(toCam.xz);
      if (hz > 1e-3) {
        float sv = hz / length(toCam);
        float cv = toCam.y / length(toCam);
        float lean = clamp((${LEAN_SIN.toFixed(6)} - sv) / max(cv, 0.2), 0.0, ${FIGURE_LEAN_MAX.toFixed(2)});
        ${p}.xz -= toCam.xz / hz * ${p}.y * lean;
      }
    }`;
}
