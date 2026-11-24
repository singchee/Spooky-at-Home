import { describe, expect, it } from 'vitest';
import { AssetBank, decodePlan, MIN_RATE, reduceBuffer, SFX, VOICE_LINES, voiceAsset, type Fetcher, type VoiceLine } from '../src/audio/assets';
import { LOAD_WAIT, VoiceChannel } from '../src/audio/voice';

// Owner playtest 1: "I see comments at the bottom like they're coming in but there's no voiceover."
// Captions always show; the recorded line must play too, whatever the browser does with low sample
// rates, and when it really can't, the game must say so (console, and window.__spooky.audio()).

/** A decoded buffer: `seconds` of a 220 Hz tone at `rate` (what decodeAudioData returns at the context's rate). */
function toneBuf(seconds: number, rate: number, channels = 1): AudioBuffer {
  const length = Math.round(seconds * rate);
  const data = Array.from({ length: channels }, () => {
    const d = new Float32Array(length);
    for (let i = 0; i < length; i++) d[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
    return d;
  });
  return { duration: length / rate, length, sampleRate: rate, numberOfChannels: channels, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
}
const blank = (ch: number, len: number, rate: number) => {
  const data = Array.from({ length: ch }, () => new Float32Array(len));
  return { duration: len / rate, length: len, sampleRate: rate, numberOfChannels: ch, getChannelData: (c: number) => data[c] } as unknown as AudioBuffer;
};
/** Safari, as it has behaved: createBuffer throws NotSupportedError under 22,050 Hz. */
const safariCreateBuffer = (ch: number, len: number, rate: number): AudioBuffer => {
  if (rate < 22_050 || rate > 96_000) throw new DOMException('sampleRate is not in range', 'NotSupportedError');
  return blank(ch, len, rate);
};
const rms = (b: AudioBuffer) => Math.sqrt(b.getChannelData(0).reduce((a, v) => a + v * v, 0) / b.length);

/** A bank of 3 s voice files decoded at `ctxRate`, with this createBuffer. */
function bankWith(createBuffer: (ch: number, len: number, rate: number) => AudioBuffer, ctxRate = 48_000) {
  const fetcher: Fetcher = async () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) });
  const warnings: string[] = [];
  const bank = new AssetBank({ decodeAudioData: async () => toneBuf(3, ctxRate), createBuffer }, fetcher, 'audio/', 2, (m) => warnings.push(m));
  return { bank, warnings };
}

/** Just enough of an AudioContext for VoiceChannel: counts the buffers started on the radio bus. */
function fakeCtx() {
  const started: { buffer: AudioBuffer | null; at: number }[] = [];
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
  const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
  const ctx = {
    currentTime: 0,
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
    createBufferSource: () => {
      const s = {
        ...node(),
        buffer: null as AudioBuffer | null,
        onended: null,
        addEventListener() {},
        start(at: number) {
          started.push({ buffer: s.buffer, at });
        },
        stop() {},
      };
      return s;
    },
  };
  return { ctx, started };
}

describe('radio voice with a browser that refuses low sample rates (owner playtest 1)', () => {
  it('no buffer is ever reduced below 22,050 Hz', () => {
    for (const id of [...VOICE_LINES.map(voiceAsset), 'music/mission-calm', SFX.drone, SFX.fire105]) expect(decodePlan(id).maxRate).toBeGreaterThanOrEqual(MIN_RATE);
    expect(MIN_RATE).toBe(22_050);
  });

  it('every voice line still loads (none failed) when createBuffer throws under 22,050 Hz', async () => {
    const { bank, warnings } = bankWith(safariCreateBuffer);
    const ids = VOICE_LINES.map(voiceAsset);
    await bank.request(ids);
    expect(bank.failed(ids)).toBe(false);
    expect(bank.ready(ids)).toBe(true);
    for (const id of ids) {
      const b = bank.get(id)!;
      expect(b.sampleRate).toBeGreaterThanOrEqual(22_050);
      expect(b.duration).toBeCloseTo(3, 2);
    }
    expect(warnings).toEqual([]);
  });

  it('when createBuffer throws at every rate, the full-rate buffer is kept: never silence', async () => {
    const { bank } = bankWith(() => {
      throw new DOMException('nope', 'NotSupportedError');
    });
    await bank.request([voiceAsset('cleared-hot')]);
    const b = bank.get(voiceAsset('cleared-hot'))!;
    expect(b.sampleRate).toBe(48_000);
    expect(rms(b)).toBeGreaterThan(0.3);
  });

  it('a reduced voice line keeps its level (RMS within 2 % of the original)', () => {
    for (const rate of [44_100, 48_000, 96_000]) {
      const src = toneBuf(2, rate);
      const out = reduceBuffer(src, blank, decodePlan(voiceAsset('new-contacts')));
      expect(out.sampleRate).toBe(22_050);
      expect(Math.abs(rms(out) / rms(src) - 1)).toBeLessThan(0.02);
    }
  });

  it('the voice plays (a buffer starts on the radio bus) when createBuffer rejects low rates', async () => {
    const { bank } = bankWith(safariCreateBuffer);
    await bank.request([SFX.squelch, ...VOICE_LINES.map(voiceAsset)]);
    const { ctx, started } = fakeCtx();
    const warns: string[] = [];
    const ch = new VoiceChannel(ctx as unknown as AudioContext, {} as AudioNode, bank, () => undefined, undefined, (m) => warns.push(m));
    ch.say('cleared-hot');
    expect(ch.said).toBe(1);
    const voice = bank.get(voiceAsset('cleared-hot'));
    expect(started.some((s) => s.buffer === voice)).toBe(true);
    expect(ch.missedTotal).toBe(0);
    expect(warns).toEqual([]);
  });

  it('every voice line plays once its file is loaded', async () => {
    const { bank } = bankWith(safariCreateBuffer);
    await bank.request(VOICE_LINES.map(voiceAsset));
    for (const line of VOICE_LINES) {
      const { ctx, started } = fakeCtx();
      const ch = new VoiceChannel(ctx as unknown as AudioContext, {} as AudioNode, bank, () => undefined, undefined, () => undefined);
      ch.say(line as VoiceLine);
      expect(started.map((s) => s.buffer)).toContain(bank.get(voiceAsset(line)));
    }
  });
});

describe('a recorded line that cannot play says so (owner playtest 1)', () => {
  const stub = (status: string) => ({ get: () => null, status: () => status });

  it('a failed file: console warning (once per line) and a note in the debug list', () => {
    const { ctx, started } = fakeCtx();
    const warns: string[] = [];
    const ch = new VoiceChannel(ctx as unknown as AudioContext, {} as AudioNode, stub('failed'), () => undefined, undefined, (m) => warns.push(m));
    ch.say('new-contacts');
    ctx.currentTime = 20;
    ch.say('new-contacts');
    expect(started).toEqual([]);
    expect(ch.missedTotal).toBe(2);
    expect(ch.missed[0]).toMatchObject({ line: 'new-contacts', why: 'failed' });
    expect(warns).toHaveLength(1);
    expect(warns[0]).toMatch(/new-contacts.*can't play/);
  });

  it('a file still loading after LOAD_WAIT: noted as late, with a warning', () => {
    const { ctx } = fakeCtx();
    const warns: string[] = [];
    const ch = new VoiceChannel(ctx as unknown as AudioContext, {} as AudioNode, stub('loading'), () => undefined, undefined, (m) => warns.push(m));
    ch.say('rushers');
    ctx.currentTime = LOAD_WAIT / 2;
    ch.tick();
    expect(ch.missedTotal).toBe(0); // still worth waiting for
    ctx.currentTime = LOAD_WAIT + 0.1;
    ch.tick();
    expect(ch.missed).toEqual([expect.objectContaining({ line: 'rushers', why: 'late' })]);
    expect(warns).toHaveLength(1);
  });
});
