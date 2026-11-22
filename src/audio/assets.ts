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

/** The long music loops (60 s stems) are kept mono once decoded: half the memory, and they are mixed under everything else. */
export const keepsMono = (id: string): boolean => id.startsWith('music/') && !id.includes('sting');

/** Averages the channels of a decoded buffer into a new mono one. Returns the buffer unchanged if it can't. */
export function toMono(buf: AudioBuffer, make: Decoder['createBuffer']): AudioBuffer {
  if (!make || !(buf.numberOfChannels > 1)) return buf;
  const out = make.call(undefined, 1, buf.length, buf.sampleRate);
  const dst = out.getChannelData(0);
  const n = buf.numberOfChannels;
  dst.set(buf.getChannelData(0));
  for (let c = 1; c < n; c++) {
    const src = buf.getChannelData(c);
    for (let i = 0; i < dst.length; i++) dst[i] += src[i];
  }
  if (n > 1) for (let i = 0; i < dst.length; i++) dst[i] /= n;
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

  private pump(): void {
    while (this.active < this.concurrency && this.waiting.length) {
      const id = this.waiting.shift()!;
      this.active++;
      this.states.set(id, 'loading');
      this.load(id)
        .then(
          (buf) => {
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
          for (const f of this.settled.get(id) ?? []) f();
          this.settled.delete(id);
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
    return keepsMono(id) ? toMono(buf, this.decoder.createBuffer ? (c, l, r) => this.decoder.createBuffer!(c, l, r) : undefined) : buf;
  }
}
