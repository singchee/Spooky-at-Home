/**
 * The page's one audio engine: a single shared AudioContext (made on the first click or key press,
 * as browsers require), the mixer, the score and the mission ambience.
 *
 * Screens say what they want with claim()/release(): the landing page claims the 'menu' theme, a
 * game claims 'mission'. When a game is torn down its mission score and engine drone fade out and
 * every node is freed; the calmer menu theme comes back. A retry re-claims within the grace period,
 * so the score carries on instead of restarting.
 */
import { Mixer } from './mixer';
import { GeneratedScore, playSting, type Score, type ScoreMode } from './music';
import { Ambience, radioStatic } from './ambience';
import { Kit } from './kit';

/** What sound effects need: the context, where to plug in, and the extras the engine offers. */
export interface SfxOutput {
  ctx: AudioContext;
  sfx: AudioNode;
  radio: AudioNode;
  noise?: AudioBuffer;
  duck?(depth: number, hold: number): void;
  radioStatic?(dur: number): void;
  kit?: Kit;
  resume?(): void;
}

/** A released scene lingers this long (ms) in case the next screen claims it again (e.g. Retry). */
const RELEASE_GRACE = 400;
const TICK_MS = 50;

export interface AudioDebug {
  contexts: number;
  state: string;
  scene: ScoreMode;
  playing: ScoreMode | null;
  ambience: boolean;
  /** Sources currently alive (scheduled or sounding). */
  voices: number;
  fading: number;
  intensity: number;
  gains: ReturnType<Mixer['read']> | null;
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private noise: AudioBuffer | null = null;
  private sfxKit: Kit | null = null;
  private score: Score | null = null;
  private ambience: Ambience | null = null;
  private fadingOut: { tick(now: number): void; done: boolean }[] = [];
  private scene: ScoreMode = 'menu';
  private intensity = 0;
  private releaseTimer: ReturnType<typeof setTimeout> | undefined;
  private last = 0;
  private seq = 1;
  private failed = false;
  /** AudioContexts made on this page (must stay at most 1). */
  contexts = 0;
  /** Live sources across score, ambience and sound effects. */
  voices = 0;
  private count = (d: number) => {
    this.voices += d;
  };

  constructor(private makeContext: () => AudioContext = () => new AudioContext({ latencyHint: 'interactive' })) {}

  /** Make (or wake) the shared context. Call from a click or key press. Safe to call often. */
  unlock(): boolean {
    this.exposeHook();
    if (this.ctx) {
      if (this.ctx.state === 'suspended' && !document.hidden) this.ctx.resume().catch(() => undefined);
      return true;
    }
    if (this.failed) return false;
    try {
      const ctx = this.makeContext();
      this.contexts++;
      this.ctx = ctx;
      this.mixer = new Mixer(ctx);
      // Two seconds of white noise: texture for gunfire, wind, city hum and radio hiss (not game logic).
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.sfxKit = new Kit(ctx, this.count);
      this.last = ctx.currentTime;
      setInterval(() => this.tick(), TICK_MS); // page-lived, like the context
      document.addEventListener('visibilitychange', this.onVisibility);
      if (ctx.state === 'suspended') ctx.resume().catch(() => undefined);
      this.startScene();
      return true;
    } catch {
      this.failed = true; // no Web Audio here: play on in silence
      this.ctx = null;
      return false;
    }
  }

  /** A hidden tab goes quiet (and stops using the CPU); it picks up again when shown. */
  private onVisibility = () => {
    if (!this.ctx) return;
    if (document.hidden) this.ctx.suspend().catch(() => undefined);
    else this.ctx.resume().catch(() => undefined);
  };

  /** This screen wants this score. Starts now if sound is unlocked, otherwise on the first gesture. */
  claim(scene: ScoreMode): void {
    this.exposeHook();
    clearTimeout(this.releaseTimer);
    this.releaseTimer = undefined;
    if (scene !== this.scene) this.intensity = 0;
    this.scene = scene;
    this.startScene();
  }

  /** This screen is going. After a short grace, fall back to the menu theme (freeing the mission's nodes). */
  release(scene: ScoreMode): void {
    if (scene !== this.scene || scene === 'menu') return;
    clearTimeout(this.releaseTimer);
    this.releaseTimer = setTimeout(() => {
      this.releaseTimer = undefined;
      this.scene = 'menu';
      this.intensity = 0;
      this.startScene();
    }, RELEASE_GRACE);
  }

  /** Threat level for the score, 0..1 (smoothed inside the score). */
  setIntensity(x: number): void {
    this.intensity = x;
    this.score?.setIntensity(x);
  }

  duck(depth: number, hold: number): void {
    this.mixer?.duck(depth, hold);
  }

  /** A short musical cue at the end of a mission. */
  sting(won: boolean): void {
    if (this.ctx && this.mixer) playSting(this.ctx, this.mixer.music, won, this.count);
  }

  /** The buses for sound effects (unlocks the context). Null if Web Audio is unavailable. */
  output(): SfxOutput | null {
    if (!this.unlock() || !this.ctx || !this.mixer || !this.noise || !this.sfxKit) return null;
    const { ctx, mixer, noise, sfxKit } = this;
    let hiss = 0;
    return {
      ctx,
      sfx: mixer.sfx,
      radio: mixer.radio,
      noise,
      kit: sfxKit,
      duck: (d, h) => mixer.duck(d, h),
      radioStatic: (dur) => radioStatic(ctx, mixer.radio, noise, dur, (hiss += 0.37), sfxKit),
      resume: () => this.unlock(),
    };
  }

  private startScene(): void {
    const { ctx, mixer, noise } = this;
    if (!ctx || !mixer || !noise) return;
    if (!this.score || this.score.mode !== this.scene) {
      if (this.score) {
        this.score.stop(this.scene === 'menu' ? 2.5 : 1.2);
        this.fadingOut.push(this.score);
      }
      this.score = new GeneratedScore(ctx, mixer.music, this.scene, this.seq++, this.count);
      this.score.setIntensity(this.intensity);
    }
    if (this.scene === 'mission' && !this.ambience) {
      this.ambience = new Ambience(ctx, mixer.ambience, noise, this.seq++, this.count);
    } else if (this.scene !== 'mission' && this.ambience) {
      this.ambience.stop(2);
      this.fadingOut.push(this.ambience);
      this.ambience = null;
    }
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.mixer) return;
    const now = ctx.currentTime;
    const dt = Math.max(0, Math.min(0.25, now - this.last));
    this.last = now;
    this.mixer.tick(dt);
    this.score?.tick(now);
    this.ambience?.tick(now);
    for (const f of this.fadingOut) f.tick(now);
    this.fadingOut = this.fadingOut.filter((f) => !f.done);
  }

  debug(): AudioDebug {
    return {
      contexts: this.contexts,
      state: this.ctx?.state ?? 'none',
      scene: this.scene,
      playing: this.score?.mode ?? null,
      ambience: !!this.ambience,
      voices: this.voices,
      fading: this.fadingOut.length,
      intensity: this.score?.intensity ?? 0,
      gains: this.mixer?.read() ?? null,
    };
  }

  /** Test hook (browser automation only, like the game's): window.__spooky.audio() reads the engine. */
  private exposeHook(): void {
    if (typeof navigator === 'undefined' || !navigator.webdriver || typeof window === 'undefined') return;
    const hooks = window.__spooky as unknown as Record<string, unknown> | undefined;
    if (hooks && !hooks.audio) hooks.audio = () => this.debug();
  }
}

/** The one engine for the page. */
export const audio = new AudioEngine();
