import { describe, expect, it } from 'vitest';
import { readdirSync } from 'node:fs';
import { AssetBank, bufferBytes, decodePlan, MUSIC, reduceBuffer, SFX, VOICE_LINES, voiceAsset, type Fetcher } from '../src/audio/assets';
import { TRACKS } from '../src/audio/recorded';

// BACKLOG 3.6b: phone audio memory. Decoded float PCM (length x channels x 4 bytes) is what a tab
// holds, so the decoded total of everything loaded at once must stay under the budget.
const BUDGET = 40e6;

/** [id, seconds, sample rate, channels] of every file in public/audio, as measured with ffprobe. */
const FILES: [string, number, number, number][] = [
  ['music/menu-theme', 60.024, 48000, 2],
  ['music/mission-calm', 60.024, 48000, 2],
  ['music/mission-overrun', 60.024, 48000, 2],
  ['music/mission-tense', 60.024, 48000, 2],
  ['music/sting-lose', 8.040, 48000, 2],
  ['music/sting-win', 8.040, 48000, 2],
  ['sfx/alarm', 2.038, 44100, 2],
  ['sfx/engine-drone', 10.031, 44100, 2],
  ['sfx/explosion-distant', 4.049, 44100, 2],
  ['sfx/fire-105mm', 4.049, 44100, 2],
  ['sfx/fire-25mm', 2.038, 44100, 2],
  ['sfx/fire-40mm', 2.038, 44100, 2],
  ['sfx/night-ambience', 20.036, 44100, 2],
  ['sfx/radio-squelch', 1.045, 44100, 2],
  ['voice/all-clear', 2.429, 44100, 1],
  ['voice/big-group', 2.926, 44100, 1],
  ['voice/campaign-thanks', 4.206, 44100, 1],
  ['voice/check-fire', 2.586, 44100, 1],
  ['voice/cleared-hot', 2.926, 44100, 1],
  ['voice/cold-blooded', 3.788, 44100, 1],
  ['voice/cold-leftovers', 3.004, 44100, 1],
  ['voice/danger-close', 2.351, 44100, 1],
  ['voice/doors-failing', 2.194, 44100, 1],
  ['voice/few-left', 3.318, 44100, 1],
  ['voice/ff-one-left', 2.586, 44100, 1],
  ['voice/first-cold', 3.239, 44100, 1],
  ['voice/forest-open', 3.553, 44100, 1],
  ['voice/former-neighbours', 2.194, 44100, 1],
  ['voice/friendlies-under-attack', 2.429, 44100, 1],
  ['voice/good-effect', 1.802, 44100, 1],
  ['voice/idle', 3.866, 44100, 1],
  ['voice/intro-cmd-1', 2.351, 44100, 1],
  ['voice/intro-cmd-2', 2.116, 44100, 1],
  ['voice/intro-cmd-3', 4.911, 44100, 1],
  ['voice/intro-cmd-4', 4.284, 44100, 1],
  ['voice/intro-cmd-5', 3.788, 44100, 1],
  ['voice/intro-cmd-6', 3.553, 44100, 1],
  ['voice/intro-ground', 3.474, 44100, 1],
  ['voice/intro-news-1', 4.911, 44100, 1],
  ['voice/intro-news-2', 4.441, 44100, 1],
  ['voice/intro-news-3', 4.676, 44100, 1],
  ['voice/landmark-open', 4.519, 44100, 1],
  ['voice/mission-complete', 3.553, 44100, 1],
  ['voice/mission-failed', 3.709, 44100, 1],
  ['voice/more-coming', 2.926, 44100, 1],
  ['voice/n1-close', 3.004, 44100, 1],
  ['voice/n1-open', 3.553, 44100, 1],
  ['voice/n2-close', 4.362, 44100, 1],
  ['voice/n2-open', 3.553, 44100, 1],
  ['voice/n3-close', 3.474, 44100, 1],
  ['voice/n3-open', 3.788, 44100, 1],
  ['voice/need-met', 2.926, 44100, 1],
  ['voice/new-contacts', 1.646, 44100, 1],
  ['voice/night-lost', 4.049, 44100, 1],
  ['voice/night-won-clean', 4.049, 44100, 1],
  ['voice/night-won-losses', 2.429, 44100, 1],
  ['voice/one-minute', 1.802, 44100, 1],
  ['voice/park-open', 2.847, 44100, 1],
  ['voice/previously', 2.508, 44100, 1],
  ['voice/rushers', 2.691, 44100, 1],
  ['voice/safehouse-hits', 3.082, 44100, 1],
  ['voice/shops-open', 3.709, 44100, 1],
  ['voice/splash-residents', 3.318, 44100, 1],
  ['voice/sports-open', 3.004, 44100, 1],
  ['voice/station-open', 3.709, 44100, 1],
  ['voice/survivor-home-kettle', 2.691, 44100, 1],
  ['voice/survivor-home-quieter', 3.474, 44100, 1],
  ['voice/survivor-lost', 2.038, 44100, 1],
  ['voice/survivors-moving', 4.127, 44100, 1],
  ['voice/tennis-open', 2.926, 44100, 1],
  ['voice/welcome-back', 3.082, 44100, 1],
];
const spec = new Map(FILES.map(([id, s, r, c]) => [id, { s, r, c }]));

const fakeBuf = (channels: number, length: number, rate: number, fill = 0): AudioBuffer => {
  const data = Array.from({ length: channels }, (_, c) => new Float32Array(length).fill(c === 0 ? fill : -fill / 5));
  return { duration: length / rate, length, sampleRate: rate, numberOfChannels: channels, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
};
const createBuf = (ch: number, len: number, rate: number) => fakeBuf(ch, len, rate);

/** A bank whose "decoder" returns a buffer shaped like the real file named in the URL. */
const makeBank = () => {
  const fetcher: Fetcher = async (url) => {
    const id = url.replace(/^audio\//, '').replace(/\.mp3$/, '');
    return { ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(id).buffer as ArrayBuffer };
  };
  const decoder = {
    decodeAudioData: async (data: ArrayBuffer) => {
      const f = spec.get(new TextDecoder().decode(data))!;
      return fakeBuf(f.c, Math.round(f.s * f.r), f.r);
    },
    createBuffer: createBuf,
  };
  return new AssetBank(decoder, fetcher, 'audio/', 1, () => undefined);
};

/** Everything the game can have loaded at once while `scene` is on screen (the other scene's music is released). */
const resident = (scene: 'menu' | 'mission'): string[] => {
  const other: string[] = scene === 'menu' ? TRACKS.mission.ids : TRACKS.menu.ids;
  return FILES.map(([id]) => id).filter((id) => !other.includes(id));
};

describe('decoded audio memory (3.6b)', () => {
  it('the measured file list is the whole of public/audio', () => {
    const have = ['music', 'sfx', 'voice'].flatMap((d) => readdirSync(`public/audio/${d}`).map((f) => `${d}/${f.replace(/\.mp3$/, '')}`)).sort();
    expect([...spec.keys()].sort()).toEqual(have);
  });

  it('before: decoding every file in full costs far more than a phone can spare', () => {
    const raw = FILES.reduce((n, [, s, r, c]) => n + Math.round(s * r) * c * 4, 0);
    console.log(`decoded in full: ${(raw / 1e6).toFixed(1)} MB`);
    expect(raw).toBeGreaterThan(BUDGET * 3);
  });

  for (const scene of ['menu', 'mission'] as const) {
    it(`after: with every file for the ${scene} screen loaded, the decoded total stays under ${BUDGET / 1e6} MB`, async () => {
      const bank = makeBank();
      const ids = resident(scene);
      await bank.request(ids);
      expect(bank.ready(ids)).toBe(true);
      const bytes = bank.decodedBytes();
      console.log(`decoded (${scene}): ${(bytes / 1e6).toFixed(1)} MB`);
      expect(bytes).toBeLessThan(BUDGET);
    });
  }

  it('going from the menu into a mission releases the menu theme: the total never holds both', async () => {
    const bank = makeBank();
    await bank.request(resident('menu'));
    const withMenu = bank.decodedBytes();
    bank.release(TRACKS.menu.ids);
    expect(bank.get(MUSIC.menu)).toBeNull();
    expect(bank.status(MUSIC.menu)).toBe('idle');
    await bank.request(TRACKS.mission.ids);
    expect(Math.max(withMenu, bank.decodedBytes())).toBeLessThan(BUDGET);
    await bank.request([MUSIC.menu]); // and it can come back
    expect(bank.get(MUSIC.menu)).not.toBeNull();
  });

  it('a file released while it is still loading is dropped when it lands, not kept', async () => {
    const bank = makeBank();
    const p = bank.request([MUSIC.menu]);
    bank.release([MUSIC.menu]);
    await p;
    expect(bank.get(MUSIC.menu)).toBeNull();
    expect(bank.decodedBytes()).toBe(0);
  });

  it('reduces music to mono 22.05 kHz with the same duration and average level', () => {
    const src = fakeBuf(2, 60 * 48_000, 48_000, 0.5); // L 0.5, R -0.1
    const out = reduceBuffer(src, createBuf, decodePlan(MUSIC.calm));
    expect(out.numberOfChannels).toBe(1);
    expect(out.sampleRate).toBe(22_050);
    expect(out.duration).toBeCloseTo(60, 3);
    expect(out.getChannelData(0)[1000]).toBeCloseTo(0.2, 5); // (0.5 + -0.1) / 2
    expect(bufferBytes(out)).toBeLessThan(bufferBytes(src) / 4);
  });

  it('keeps a low tone at its level and strongly attenuates one above the new Nyquist', () => {
    const rate = 48_000;
    const tone = (hz: number) => {
      const b = fakeBuf(1, rate, rate);
      const d = b.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.sin((2 * Math.PI * hz * i) / rate);
      return b;
    };
    const rms = (b: AudioBuffer) => Math.sqrt(b.getChannelData(0).reduce((a, v) => a + v * v, 0) / b.length);
    const plan = decodePlan(MUSIC.calm);
    expect(rms(reduceBuffer(tone(500), createBuf, plan))).toBeGreaterThan(0.69); // ~ 1/sqrt(2)
    expect(rms(reduceBuffer(tone(20_000), createBuf, plan))).toBeLessThan(0.3);
  });

  it('leaves a buffer alone when it cannot make one, or when nothing needs reducing', () => {
    const stereo = fakeBuf(2, 100, 48_000);
    expect(reduceBuffer(stereo, undefined, decodePlan(MUSIC.calm))).toBe(stereo);
    const mono = fakeBuf(1, 100, 16_000);
    expect(reduceBuffer(mono, createBuf, decodePlan(voiceAsset(VOICE_LINES[0])))).toBe(mono);
  });

  it('plans: music, beds and voice 22.05 kHz (never lower: owner playtest 1), other effects full rate, all mono', () => {
    expect(decodePlan(MUSIC.stingWin)).toEqual({ mono: true, maxRate: 22_050 });
    expect(decodePlan(SFX.drone).maxRate).toBe(22_050);
    expect(decodePlan(SFX.fire105).maxRate).toBe(44_100);
    expect(decodePlan(voiceAsset('all-clear')).maxRate).toBe(22_050);
  });
});
