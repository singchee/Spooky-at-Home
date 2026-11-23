/**
 * Recorded sound files (public/audio, served from the game's own origin): fetched and decoded
 * lazily after the first click or key press, cached as AudioBuffers, and never waited on. Anything
 * that fails to load (offline, a missing file, a browser that can't decode it) is simply absent:
 * whoever asked falls back to the generated sound. The first failure is logged once, as a warning.
 */

/** Music cues (60 s loops and 8 s stings). */
export const MUSIC = {
  menu: 'music/menu-theme',
  calm: 'music/mission-calm',
  tense: 'music/mission-tense',
  overrun: 'music/mission-overrun',
  stingWin: 'music/sting-win',
  stingLose: 'music/sting-lose',
} as const;

/** Sound effects and ambience beds. */
export const SFX = {
  drone: 'sfx/engine-drone',
  night: 'sfx/night-ambience',
  fire25: 'sfx/fire-25mm',
  fire40: 'sfx/fire-40mm',
  fire105: 'sfx/fire-105mm',
  explosion: 'sfx/explosion-distant',
  squelch: 'sfx/radio-squelch',
  alarm: 'sfx/alarm',
} as const;

/** The radio lines (file name = what is said). */
export const VOICE_LINES = [
  'cleared-hot',
  'new-contacts',
  'more-coming',
  'cold-blooded',
  'good-effect',
  'former-neighbours',
  'splash-residents',
  'danger-close',
  'check-fire',
  'survivor-lost',
  'survivor-home-kettle',
  'survivor-home-quieter',
  'friendlies-under-attack',
  'safehouse-hits',
  'rushers',
  'big-group',
  'all-clear',
  'survivors-moving',
  'mission-complete',
  'mission-failed',
  // Radio script section C, wired by spec 002 (Clear: the last few contacts).
  'few-left',
  'cold-leftovers',
] as const;
export type VoiceLine = (typeof VOICE_LINES)[number];

/** The intro's voiceover ("The Late Bulletin", docs/story/intro.md), played by src/ui/intro.ts. */
export const INTRO_VOICE = [
  'intro-news-1',
  'intro-news-2',
  'intro-news-3',
  'intro-cmd-1',
  'intro-cmd-2',
  'intro-cmd-3',
  'intro-cmd-4',
  'intro-cmd-5',
  'intro-cmd-6',
  'intro-ground',
] as const;
export const voiceAsset = (line: VoiceLine): string => `voice/${line}`;

export type AssetState = 'idle' | 'queued' | 'loading' | 'ready' | 'failed';

/** What decoding needs (an AudioContext, or a stand-in in tests). */
export interface Decoder {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  /** Optional (an AudioContext has it): needed to keep music loops as mono buffers. */
  createBuffer?(channels: number, length: number, sampleRate: number): AudioBuffer;
}

/**
 * What a decoded file is reduced to before it is kept (backlog 3.6b: the files decode to ~140 MB of
 * float PCM, enough to get a phone's tab killed). Everything is kept mono; music and the two long
 * beds are also reduced to 22.05 kHz (they sit under everything else, and a phone speaker has no
 * highs to lose), and radio voice to 16 kHz (speech, already band-limited by the radio filters).
 * Playback time is unchanged: a buffer's duration does not depend on its rate.
 */
export interface DecodePlan {
  mono: boolean;
  /** Highest sample rate kept (Hz); a higher-rate file is averaged down to it. */
  maxRate: number;
}
export function decodePlan(id: string): DecodePlan {
  if (id.startsWith('music/') || id === 'sfx/engine-drone' || id === 'sfx/night-ambience') return { mono: true, maxRate: 22_050 };
  if (id.startsWith('voice/')) return { mono: true, maxRate: 16_000 };
  return { mono: true, maxRate: 44_100 };
}

/**
 * Mixes the channels of a decoded buffer down to mono and averages it down to `maxRate` (each
 * output sample is the mean of the input span it covers: a box filter, enough to keep aliasing out
 * of music and speech). Same duration. Returns the buffer unchanged if nothing needs doing or the
 * decoder can't make buffers.
 */
export function reduceBuffer(buf: AudioBuffer, make: Decoder['createBuffer'], plan: DecodePlan): AudioBuffer {
  const rate = Math.min(buf.sampleRate, plan.maxRate);
  const sameRate = rate === buf.sampleRate;
  if (!make || !(buf.length > 0) || (sameRate && (!plan.mono || buf.numberOfChannels === 1))) return buf;
  const ratio = buf.sampleRate / rate;
  const len = sameRate ? buf.length : Math.max(1, Math.round(buf.length / ratio));
  const out = make.call(undefined, plan.mono ? 1 : buf.numberOfChannels, len, rate);
  const chans = Array.from({ length: buf.numberOfChannels }, (_, c) => buf.getChannelData(c));
  const groups = plan.mono ? [chans] : chans.map((c) => [c]);
  groups.forEach((src, o) => {
    const dst = out.getChannelData(o);
    for (let j = 0; j < len; j++) {
      const from = j * ratio;
      const to = Math.min(buf.length, from + ratio);
      let acc = 0;
      let wsum = 0;
      for (let i = Math.floor(from); i < to; i++) {
        const w = Math.min(i + 1, to) - Math.max(i, from);
        if (w <= 0) continue;
        let v = 0;
        for (const ch of src) v += ch[i];
        acc += (v / src.length) * w;
        wsum += w;
      }
      dst[j] = wsum > 0 ? acc / wsum : 0;
    }
  });
  return out;
}

/** Bytes a decoded buffer holds (32-bit floats). */
export const bufferBytes = (b: AudioBuffer): number => b.numberOfChannels * b.length * 4;
export type Fetcher = (url: string) => Promise<{ ok: boolean; status?: number; arrayBuffer(): Promise<ArrayBuffer> }>;

export interface AssetStats {
  ready: number;
  failed: number;
  pending: number;
}

/** Where the files are served from: next to the page (the build uses a relative base). */
const BASE = `${import.meta.env?.BASE_URL ?? './'}audio/`;

export class AssetBank {
  private buffers = new Map<string, AudioBuffer>();
  private states = new Map<string, AssetState>();
  private waiting: string[] = [];
  private active = 0;
  private warned = false;
  private settled = new Map<string, (() => void)[]>();
  private dropped = new Set<string>();

  constructor(
    private decoder: Decoder,
    private fetcher: Fetcher | null = typeof fetch === 'function' ? (u) => fetch(u) : null,
    private base = BASE,
    /** Files fetched and decoded at once (keeps decode memory and CPU spikes small). */
    private concurrency = 2,
    private warn: (msg: string) => void = (m) => console.warn(m),
  ) {}

  /** The decoded buffer, or null if it isn't loaded (yet, or ever). Never starts a load. */
  get(id: string): AudioBuffer | null {
    return this.buffers.get(id) ?? null;
  }

  status(id: string): AssetState {
    return this.states.get(id) ?? 'idle';
  }

  /** All of these are loaded. */
  ready(ids: readonly string[]): boolean {
    return ids.every((id) => this.buffers.has(id));
  }

  /** At least one of these failed to load (so a set that needs all of them never will). */
  failed(ids: readonly string[]): boolean {
    return ids.some((id) => this.states.get(id) === 'failed');
  }

  /**
   * Load these, in order, behind anything already waiting (or, with `first`, ahead of it: the
   * intro's voice can't wait behind the whole game's sound). Never throws or rejects; the promise
   * settles when each has either loaded or failed. Asking again for a file is free.
   */
  request(ids: readonly string[], first = false): Promise<void> {
    const waits: Promise<void>[] = [];
    const jump: string[] = [];
    for (const id of ids) {
      this.dropped.delete(id);
      const s = this.status(id);
      if (s === 'ready' || s === 'failed') continue;
      if (s === 'idle') {
        this.states.set(id, 'queued');
        if (first) jump.push(id);
        else this.waiting.push(id);
      } else if (s === 'queued' && first) {
        this.waiting.splice(this.waiting.indexOf(id), 1);
        jump.push(id);
      }
      waits.push(new Promise((res) => this.settled.set(id, [...(this.settled.get(id) ?? []), res])));
    }
    this.waiting.unshift(...jump);
    this.pump();
    return Promise.all(waits).then(() => undefined);
  }

  /**
   * Forget these decoded files and free their memory (a source still playing one keeps it alive until
   * it ends). They can be requested again later. Files still loading are left alone.
   */
  release(ids: readonly string[]): void {
    for (const id of ids) {
      const st = this.states.get(id);
      if (st === 'loading') this.dropped.add(id); // discarded when it lands
      else if (st === 'queued') {
        this.waiting.splice(this.waiting.indexOf(id), 1);
        this.states.delete(id);
        this.finish(id);
      } else if (st === 'ready') {
        this.buffers.delete(id);
        this.states.delete(id);
      }
    }
  }

  /** Total bytes of decoded audio held (for debug and the memory test). */
  decodedBytes(): number {
    let n = 0;
    for (const b of this.buffers.values()) n += bufferBytes(b);
    return n;
  }

  stats(): AssetStats {
    let ready = 0;
    let failed = 0;
    let pending = 0;
    for (const s of this.states.values()) {
      if (s === 'ready') ready++;
      else if (s === 'failed') failed++;
      else pending++;
    }
    return { ready, failed, pending };
  }

  private finish(id: string): void {
    for (const f of this.settled.get(id) ?? []) f();
    this.settled.delete(id);
  }

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      this.active++;
      this.states.set(id, 'loading');
      this.load(id)
        .then(
          (buf) => {
            if (this.dropped.delete(id)) {
              this.states.delete(id); // released while loading: nobody wants it now
              return;
            }
            this.buffers.set(id, buf);
            this.states.set(id, 'ready');
          },
          (e: unknown) => {
            this.states.set(id, 'failed');
            if (!this.warned) {
              this.warned = true;
              this.warn(`Spooky: recorded audio unavailable (${id}: ${e instanceof Error ? e.message : String(e)}); using generated sound.`);
            }
          },
        )
        .finally(() => {
          this.active--;
          this.finish(id);
          this.pump();
        });
    }
  }

  private async load(id: string): Promise<AudioBuffer> {
    if (!this.fetcher) throw new Error('no fetch');
    const res = await this.fetcher(`${this.base}${id}.mp3`);
    if (!res.ok) throw new Error(`HTTP ${res.status ?? '?'}`);
    const data = await res.arrayBuffer();
    const buf = await this.decoder.decodeAudioData(data);
    if (!buf || !(buf.duration > 0)) throw new Error('empty audio');
    return reduceBuffer(buf, this.decoder.createBuffer ? (c, l, r) => this.decoder.createBuffer!(c, l, r) : undefined, decodePlan(id));
  }
}
