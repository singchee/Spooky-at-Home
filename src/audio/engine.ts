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
import { AssetBank, MUSIC, SFX, VOICE_LINES, voiceAsset, type AssetStats, type VoiceLine } from './assets';
import { BED_IDS, playRecordedSting, RecordedBed, RecordedScore, trackIds } from './recorded';
import { SamplePlayer } from './samples';
import { DUCK_VOICE, SQUELCH, VoiceChannel, type VoiceLogEntry } from './voice';

/** What sound effects need: the context, where to plug in, and the extras the engine offers. */
export interface SfxOutput {
  ctx: AudioContext;
  sfx: AudioNode;
  radio: AudioNode;
  noise?: AudioBuffer;
  duck?(depth: number, hold: number): void;
  /** Pump the music and drone down on the audio clock (Mixer.punch). */
  punch?(p: { depth: number; attack: number; hold: number; release: number }): void;
  radioStatic?(dur: number): void;
  kit?: Kit;
  resume?(): void;
  /** A recorded sample, if it has loaded (null: use the generated sound). */
  sample?(id: string): AudioBuffer | null;
  samples?: SamplePlayer;
}

/** A released scene lingers this long (ms) in case the next screen claims it again (e.g. Retry). */
const RELEASE_GRACE = 400;
const TICK_MS = 50;

/** How a one-off recorded clip is heard (the intro): through a TV's speaker, in the room, or over the radio. */
export type ClipVoice = 'tv' | 'room' | 'radio' | 'squelch';
export interface ClipHandle {
  /** Audio-clock time the clip ends. */
  end: number;
  /** Stop it now with a short fade (no click). Safe to call twice. */
  stop(fade?: number): void;
}

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
  /** Which parts are playing from the recorded files rather than generated. */
  recorded: { score: boolean; bed: boolean };
  assets: AssetStats | null;
  /** Decoded recorded audio held in memory, bytes. */
  assetBytes: number;
  voice: { said: number; overlaps: number; onAir: VoiceLine | null; waiting: number; log: VoiceLogEntry[] } | null;
  /** One-off clips (the intro): id, audio-clock start and end (end = when it really stopped). */
  clips: { id: string; start: number; end: number }[];
}

export class AudioEngine {
  private ctx: AudioContext | null = null;
  private mixer: Mixer | null = null;
  private noise: AudioBuffer | null = null;
  private sfxKit: Kit | null = null;
  private score: Score | null = null;
  private ambience: Ambience | null = null;
  private bed: RecordedBed | null = null;
  private bank: AssetBank | null = null;
  private samples: SamplePlayer | null = null;
  private voice: VoiceChannel | null = null;
  private fadingOut: { tick(now: number): void; done: boolean }[] = [];
  private clipLog: { id: string; start: number; end: number }[] = [];
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
      this.loadRecorded(ctx, this.mixer);
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

  /**
   * Fetch and decode the recorded files in the background (never awaited): the radio squelch and
   * first line, this screen's music, the effects, the rest of the voice, then the other music.
   * Until (or unless) a file arrives, its generated stand-in plays.
   */
  private loadRecorded(ctx: AudioContext, mixer: Mixer): void {
    const bank = (this.bank = new AssetBank(ctx));
    this.samples = new SamplePlayer(ctx, this.count);
    this.voice = new VoiceChannel(ctx, mixer.radio, bank, (d, h) => mixer.duck(d, h), this.count);
    const other: ScoreMode = this.scene === 'menu' ? 'mission' : 'menu';
    void bank.request([SFX.squelch, voiceAsset('cleared-hot')]);
    void bank.request(trackIds(this.scene));
    void bank.request([SFX.fire25, SFX.fire40, SFX.fire105, SFX.explosion, SFX.alarm, ...BED_IDS]);
    void bank.request(VOICE_LINES.map(voiceAsset));
    void bank.request([...trackIds(other), MUSIC.stingWin, MUSIC.stingLose]);
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
    this.voice?.hush(); // a retry or quit: this mission's radio goes with it
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
    if (!this.ctx || !this.mixer) return;
    if (this.bank && playRecordedSting(this.ctx, this.mixer.music, this.bank, won, this.count)) {
      // The recorded sting is a full cue: the score steps back while it plays.
      if (this.score instanceof RecordedScore) this.score.dip(0.3, 6);
    } else playSting(this.ctx, this.mixer.music, won, this.count);
  }

  /** A radio voice line (queued: one at a time, never overlapping; see voice.ts). */
  say(line: VoiceLine): void {
    this.voice?.say(line);
  }

  /** Fetch these recorded files ahead of everything else waiting (e.g. the intro's voice). */
  preload(ids: readonly string[]): Promise<void> {
    return this.bank?.request(ids, true) ?? Promise.resolve();
  }

  /** Is this recorded file loaded (false: still loading, failed, or no sound at all)? */
  has(id: string): boolean {
    return !!this.bank?.get(id);
  }

  /** Has this file failed to load (or is there no sound)? Then nobody should wait for it. */
  unavailable(id: string): boolean {
    return !this.ctx || !this.bank || this.bank.status(id) === 'failed';
  }

  /**
   * Play a recorded file once, now, on the voice (radio volume) bus: 'tv' through a small
   * speaker's band, 'room' clean, 'radio' through the radio band, 'squelch' as the radio click.
   * Music ducks under it. Null if sound is off or the file isn't loaded: the caller carries on
   * (captions say the same thing).
   */
  clip(id: string, voice: ClipVoice): ClipHandle | null {
    const { ctx, mixer, bank, sfxKit } = this;
    const buf = bank?.get(id);
    if (!ctx || !mixer || !sfxKit || !buf) return null;
    const chain: AudioNode[] = [];
    const band = (hp: number, lp: number) => {
      const h = ctx.createBiquadFilter();
      h.type = 'highpass';
      h.frequency.value = hp;
      const l = ctx.createBiquadFilter();
      l.type = 'lowpass';
      l.frequency.value = lp;
      chain.push(h, l);
    };
    if (voice === 'tv') band(320, 5200);
    else if (voice === 'radio') band(260, 4200);
    const g = ctx.createGain();
    g.gain.value = voice === 'squelch' ? SQUELCH.gain : voice === 'tv' ? 0.75 : 0.9;
    chain.push(g);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    let node: AudioNode = src;
    for (const n of chain) node = node.connect(n);
    node.connect(mixer.radio);
    if (!sfxKit.adopt(src, ...chain)) return null;
    const t = ctx.currentTime + 0.02;
    const [offset, length] = voice === 'squelch' ? [SQUELCH.offset, SQUELCH.length] : [0, buf.duration];
    const entry = { id, start: t, end: t + length };
    src.start(t, offset, length);
    src.stop(entry.end + 0.02);
    this.clipLog.push(entry);
    if (this.clipLog.length > 40) this.clipLog.shift();
    if (voice !== 'squelch') mixer.duck(DUCK_VOICE, length + 0.2);
    let stopped = false;
    return {
      end: entry.end,
      stop: (fade = 0.08) => {
        if (stopped) return;
        stopped = true;
        const now = ctx.currentTime;
        if (now >= entry.end) return;
        entry.end = Math.max(entry.start, now + fade);
        try {
          g.gain.cancelScheduledValues(now);
          g.gain.setValueAtTime(g.gain.value, now);
          g.gain.linearRampToValueAtTime(0, now + fade);
          src.stop(now + fade + 0.01);
        } catch {
          /* already ended */
        }
      },
    };
  }

  /** The buses for sound effects (unlocks the context). Null if Web Audio is unavailable. */
  output(): SfxOutput | null {
    if (!this.unlock() || !this.ctx || !this.mixer || !this.noise || !this.sfxKit) return null;
    const { ctx, mixer, noise, sfxKit } = this;
    let hiss = 0;
    return {
      ctx,
      sfx: mixer.weapons,
      radio: mixer.radio,
      noise,
      kit: sfxKit,
      duck: (d, h) => mixer.duck(d, h),
      punch: (p) => mixer.punch(p),
      radioStatic: (dur) => radioStatic(ctx, mixer.radio, noise, dur, (hiss += 0.37), sfxKit),
      resume: () => this.unlock(),
      sample: (id) => this.bank?.get(id) ?? null,
      samples: this.samples ?? undefined,
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
      this.score = this.recordedScore(this.scene) ?? new GeneratedScore(ctx, mixer.music, this.scene, this.seq++, this.count);
      this.score.setIntensity(this.intensity);
    }
    if (this.scene === 'mission' && !this.ambience) {
      this.ambience = new Ambience(ctx, mixer.ambience, noise, this.seq++, this.count);
    } else if (this.scene !== 'mission' && this.ambience) {
      this.ambience.stop(2);
      this.fadingOut.push(this.ambience);
      this.ambience = null;
      if (this.bed) {
        this.bed.stop(2);
        this.fadingOut.push(this.bed);
        this.bed = null;
      }
    }
  }

  /** The recorded score for a scene, if its files have loaded (else null: play the generated one). */
  private recordedScore(mode: ScoreMode, start?: number, fadeIn?: number): RecordedScore | null {
    const { ctx, mixer, bank } = this;
    if (!ctx || !mixer || !bank || !bank.ready(trackIds(mode))) return null;
    try {
      return new RecordedScore(ctx, mixer.music, mode, bank, this.count, start, fadeIn);
    } catch {
      return null;
    }
  }

  /**
   * Files that arrive after a scene started take over from the generated stand-ins: the recorded
   * score crossfades in over a few seconds, and the recorded drone and night air are layered over
   * a quieter generated bed.
   */
  private upgrade(): void {
    const { ctx, mixer, bank } = this;
    if (!ctx || !mixer || !bank) return;
    if (this.score instanceof GeneratedScore && !this.score.done && bank.ready(trackIds(this.score.mode))) {
      const next = this.recordedScore(this.score.mode, this.score.intensity, 1.5);
      if (next) {
        next.setIntensity(this.intensity);
        this.score.stop(3);
        this.fadingOut.push(this.score);
        this.score = next;
      }
    }
    if (this.ambience && !this.bed && bank.ready(BED_IDS)) {
      try {
        this.bed = new RecordedBed(ctx, mixer.ambience, bank, this.count);
        this.ambience.blend(0.35);
      } catch {
        this.bed = null;
      }
    }
  }

  private tick(): void {
    const ctx = this.ctx;
    if (!ctx || !this.mixer) return;
    const now = ctx.currentTime;
    const dt = Math.max(0, Math.min(0.25, now - this.last));
    this.last = now;
    this.mixer.tick(dt);
    this.upgrade();
    this.score?.tick(now);
    this.ambience?.tick(now);
    this.bed?.tick(now);
    this.voice?.tick();
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
      recorded: { score: this.score instanceof RecordedScore, bed: !!this.bed },
      assets: this.bank?.stats() ?? null,
      assetBytes: this.bank?.decodedBytes() ?? 0,
      voice: this.voice
        ? { said: this.voice.said, overlaps: this.voice.overlaps(), onAir: this.voice.queue.current?.line ?? null, waiting: this.voice.queue.waiting, log: this.voice.log.slice(-12) }
        : null,
      clips: this.clipLog.slice(-12),
    };
  }

  /** Test hook (browser automation only, like the game's): window.__spooky.audio() reads the engine. */
  private exposeHook(): void {
    if (typeof navigator === 'undefined' || !navigator.webdriver || typeof window === 'undefined') return;
    const hooks = window.__spooky as unknown as Record<string, unknown> | undefined;
    if (hooks && !hooks.audio) hooks.audio = () => this.debug();
    if (hooks && !hooks.audioSay) hooks.audioSay = (line: VoiceLine) => this.say(line);
  }
}

/** The one engine for the page. */
export const audio = new AudioEngine();
