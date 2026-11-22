import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { BlurShader, BrightShader, SensorShader } from './sensors';
import type { GfxTier } from './gfxGovernor';
import { surfaceDetail } from './groundShader';

/**
 * The sensor picture, drawn after the 3D scene:
 *   1. the scene (sensor values) into a float render target, with a depth texture;
 *   2. its hot / bright parts, downsampled (half resolution on `high`, quarter on `low`);
 *   3-4. a separable blur of those (bloom);
 *   5. the camera filter (src/render/sensors.ts) to the screen.
 * Five draw calls on top of the scene. Owns its render targets and materials; call dispose().
 */
export class SensorPost {
  /** The camera filter's uniforms (mode, polarity, washout, blank, calm, time...). */
  readonly uniforms: typeof SensorShader.uniforms;
  private scene: THREE.WebGLRenderTarget;
  private bloomA: THREE.WebGLRenderTarget;
  private bloomB: THREE.WebGLRenderTarget;
  private finalMat: THREE.ShaderMaterial;
  private brightMat: THREE.ShaderMaterial;
  private blurMat: THREE.ShaderMaterial;
  private quad: FullScreenQuad;
  private css = { w: 1, h: 1 };
  tier: GfxTier;
  /** Bloom strength on the high tier (the low tier uses a little less: its bloom is blurrier). */
  static readonly BLOOM = 1.0;

  /** `maxPixelRatio` caps the resolution on the high tier (the landing page's background uses 1.5). */
  constructor(private renderer: THREE.WebGLRenderer, tier: GfxTier, private maxPixelRatio = 2) {
    this.tier = tier;
    const depthTexture = new THREE.DepthTexture(1, 1);
    this.scene = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, depthTexture });
    const opts = { type: THREE.HalfFloatType, depthBuffer: false };
    this.bloomA = new THREE.WebGLRenderTarget(1, 1, opts);
    this.bloomB = new THREE.WebGLRenderTarget(1, 1, opts);
    const mat = (s: { uniforms: Record<string, THREE.IUniform>; vertexShader: string; fragmentShader: string }) =>
      new THREE.ShaderMaterial({ uniforms: THREE.UniformsUtils.clone(s.uniforms), vertexShader: s.vertexShader, fragmentShader: s.fragmentShader, depthTest: false, depthWrite: false });
    this.finalMat = mat(SensorShader);
    this.brightMat = mat(BrightShader);
    this.blurMat = mat(BlurShader);
    this.uniforms = this.finalMat.uniforms as typeof SensorShader.uniforms;
    this.quad = new FullScreenQuad(this.finalMat);
    this.applyTier();
  }

  /** Switch quality tier (resolution, multisampling, bloom size, outlines). */
  setTier(t: GfxTier): void {
    if (t === this.tier) return;
    this.tier = t;
    this.applyTier();
  }

  private applyTier(): void {
    const high = this.tier === 'high';
    const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
    this.renderer.setPixelRatio(high ? Math.min(this.maxPixelRatio, dpr) : 1);
    // Multisampling a float target needs EXT_color_buffer_float; without it, stay unsampled rather than black.
    const samples = high && this.renderer.extensions.has('EXT_color_buffer_float') ? 4 : 0;
    if (samples !== this.scene.samples) {
      this.scene.samples = samples;
      this.scene.dispose(); // re-created at the next render with the new sample count
    }
    this.uniforms.edges.value = high ? 1 : 0;
    surfaceDetail.value = high ? 1 : 0;
    this.uniforms.bloom.value = high ? SensorPost.BLOOM : SensorPost.BLOOM * 0.85;
    this.setSize(this.css.w, this.css.h);
  }

  /** Size in CSS pixels (call after renderer.setSize). */
  setSize(w: number, h: number): void {
    this.css = { w, h };
    this.renderer.setSize(w, h);
    const pr = this.renderer.getPixelRatio();
    const W = Math.max(1, Math.round(w * pr));
    const H = Math.max(1, Math.round(h * pr));
    this.scene.setSize(W, H);
    const div = this.tier === 'high' ? 2 : 4;
    const bw = Math.max(1, Math.round(W / div));
    const bh = Math.max(1, Math.round(H / div));
    this.bloomA.setSize(bw, bh);
    this.bloomB.setSize(bw, bh);
    (this.brightMat.uniforms.texel.value as THREE.Vector2).set(1 / W, 1 / H);
    this.uniforms.res.value.set(W, H);
    this.uniforms.pr.value = pr;
  }

  render(scene: THREE.Scene, camera: THREE.PerspectiveCamera): void {
    const r = this.renderer;
    const u = this.uniforms;
    u.cNear.value = camera.near;
    u.cFar.value = camera.far;
    r.setRenderTarget(this.scene);
    r.clear();
    r.render(scene, camera);
    // Bloom: bright pass, then blur across and down.
    this.quad.material = this.brightMat;
    this.brightMat.uniforms.tDiffuse.value = this.scene.texture;
    r.setRenderTarget(this.bloomA);
    this.quad.render(r);
    this.quad.material = this.blurMat;
    const bw = this.bloomA.width;
    const bh = this.bloomA.height;
    this.blurMat.uniforms.tDiffuse.value = this.bloomA.texture;
    (this.blurMat.uniforms.dir.value as THREE.Vector2).set(1.4 / bw, 0);
    r.setRenderTarget(this.bloomB);
    this.quad.render(r);
    this.blurMat.uniforms.tDiffuse.value = this.bloomB.texture;
    (this.blurMat.uniforms.dir.value as THREE.Vector2).set(0, 1.4 / bh);
    r.setRenderTarget(this.bloomA);
    this.quad.render(r);
    // The camera filter, to the screen.
    this.quad.material = this.finalMat;
    u.tDiffuse.value = this.scene.texture;
    u.tDepth.value = this.scene.depthTexture;
    u.tBloom.value = this.bloomA.texture;
    r.setRenderTarget(null);
    this.quad.render(r);
  }

  dispose(): void {
    this.scene.depthTexture?.dispose();
    this.scene.dispose();
    this.bloomA.dispose();
    this.bloomB.dispose();
    this.finalMat.dispose();
    this.brightMat.dispose();
    this.blurMat.dispose();
    this.quad.dispose();
  }
}
