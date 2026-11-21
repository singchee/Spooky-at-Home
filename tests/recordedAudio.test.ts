import { describe, expect, it, vi } from 'vitest';
import { AssetBank, MUSIC, SFX, VOICE_LINES, voiceAsset, type Fetcher, type VoiceLine } from '../src/audio/assets';
import { curve, fadeIn, fadeOut, LOOP_OVERLAP, loopTiming, passGain } from '../src/audio/loop';
import { RecordedScore, stemWeights, TRACKS } from '../src/audio/recorded';
import { vary, VoiceLimiter } from '../src/audio/samples';
import { MIN_GAP, PRIORITY, RULES, VoiceDirector, VoiceQueue, voiceWorld, type VoiceWorld } from '../src/audio/voice';
import { RETRIGGER_25, SAMPLE_PLAY, Sfx } from '../src/audio/sfx';
import { MAX_ONSETS_PER_SEC } from '../src/audio/music';
import { mulberry32 } from '../src/util/rng';
import { makeSampleTown } from '../src/map/sample';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import type { SimEvent } from '../src/sim/sim';
import { readdirSync } from 'node:fs';

// Recorded audio (public/audio): the loader, the looping and layering maths, the effects' variation
// and caps, and the radio voice's queue and choice of lines. The browser check in
// scripts/playtest.mjs ("audio") checks that the real files decode and play.

const buf = (duration: number) => ({ duration }) as AudioBuffer;
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('asset loader', () => {
  const setup = (failing: string[] = [], decodeFails = false) => {
    const fetched: string[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const fetcher: Fetcher = async (url) => {
      fetched.push(url);
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await flush();
      inFlight--;
      const bad = failing.some((f) => url.includes(f));
      return { ok: !bad, status: bad ? 404 : 200, arrayBuffer: async () => new ArrayBuffer(8) };
    };
    const decoder = { decodeAudioData: vi.fn(async () => (decodeFails ? Promise.reject(new Error('EncodingError')) : buf(2))) };
    const warn = vi.fn();
    const bank = new AssetBank(decoder, fetcher, 'audio/', 2, warn);
    return { bank, fetched, warn, decoder, maxInFlight: () => maxInFlight };
  };

  it('fetches each file once from the game origin, decodes and caches it, a couple at a time', async () => {
    const { bank, fetched, maxInFlight } = setup();
    const ids = [SFX.squelch, ...VOICE_LINES.map(voiceAsset)];
    await Promise.all([bank.request(ids), bank.request(ids)]);
    await bank.request([SFX.squelch]);
    expect(fetched.length).toBe(ids.length);
    expect(fetched.every((u) => /^audio\/(sfx|voice)\/[a-z0-9-]+\.mp3$/.test(u))).toBe(true);
    expect(maxInFlight()).toBeLessThanOrEqual(2);
    expect(bank.ready(ids)).toBe(true);
    expect(bank.get(SFX.squelch)?.duration).toBe(2);
    expect(bank.stats()).toEqual({ ready: ids.length, failed: 0, pending: 0 });
  });

  it('a missing file or a failed decode falls back silently: never throws, warns once, stays absent', async () => {
    for (const [failing, decodeFails] of [[[MUSIC.calm, MUSIC.tense], false], [[], true]] as const) {
      const { bank, warn } = setup([...failing], decodeFails);
      const ids = TRACKS.mission.ids;
      await expect(bank.request(ids)).resolves.toBeUndefined();
      expect(bank.ready(ids)).toBe(false);
      expect(bank.failed(ids)).toBe(true);
      expect(bank.get(MUSIC.calm)).toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      // A failed file is not fetched again and the score refuses to build from it (the engine keeps the generated one).
      await bank.request(ids);
      expect(() => new RecordedScore({} as AudioContext, {} as AudioNode, 'mission', bank)).toThrow();
    }
  });

  it('without fetch (or Web Audio) nothing is loaded and nothing throws', async () => {
    const bank = new AssetBank({ decodeAudioData: async () => buf(1) }, null, 'audio/', 2, () => undefined);
    await bank.request([SFX.alarm]);
    expect(bank.failed([SFX.alarm])).toBe(true);
  });

  it('every file the game asks for exists in public/audio (and no file goes unused)', () => {
    const want = [...Object.values(MUSIC), ...Object.values(SFX), ...VOICE_LINES.map(voiceAsset)].map((id) => `${id}.mp3`).sort();
    const have = ['music', 'sfx', 'voice'].flatMap((d) => readdirSync(`public/audio/${d}`).map((f) => `${d}/${f}`)).sort();
    expect(have).toEqual(want);
  });
});

describe('crossfaded loops', () => {
  it('mission layers (70 BPM, 60 s files) loop on whole bars with at least 1.5 s of crossfade', () => {
    const t = loopTiming(60.024, { beat: TRACKS.mission.beat });
    const bars = t.period / (TRACKS.mission.beat * 4);
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(1e-9);
    expect(t.overlap).toBeGreaterThanOrEqual(LOOP_OVERLAP);
    expect(t.overlap).toBeLessThan(2.5);
    expect(t.period + t.overlap).toBeCloseTo(60.024);
  });

  it('without a tempo the loop overlaps by 1.5 s; short files overlap by at most half their length', () => {
    expect(loopTiming(10)).toEqual({ period: 8.5, overlap: 1.5 });
    const short = loopTiming(2, { beat: 0.5 });
    expect(short.overlap).toBeLessThanOrEqual(1);
    expect(short.period).toBeGreaterThanOrEqual(1);
    expect(loopTiming(0).overlap).toBe(0);
    expect(loopTiming(NaN).overlap).toBe(0);
  });

  it('equal power: across every join the two passes always sum to the same loudness', () => {
    for (const [dur, beat] of [[60.024, 60 / 70], [60.024, 60 / 95], [10, 0], [20, 0]]) {
      const timing = loopTiming(dur, { beat: beat || undefined });
      // Steady state: pass k starts at k * period. Check power over two full periods after the first.
      for (let t = timing.period; t < 3 * timing.period; t += 0.01) {
        let power = 0;
        for (let k = 0; k < 4; k++) power += passGain(t - k * timing.period, dur, timing, k === 0) ** 2;
        expect(power).toBeCloseTo(1, 6);
      }
      expect(passGain(0, dur, timing, true)).toBe(1); // the first pass starts at full
      expect(passGain(0, dur, timing, false)).toBe(0); // later ones fade in from silence
    }
  });

  it('the scheduled curves are the same equal-power shapes, ending where they should', () => {
    const i = curve(fadeIn);
    const o = curve(fadeOut);
    expect(i[0]).toBe(0);
    expect(i[i.length - 1]).toBeCloseTo(1);
    expect(o[0]).toBe(1);
    expect(o[o.length - 1]).toBeCloseTo(0);
    for (let k = 0; k < i.length; k++) expect(i[k] ** 2 + o[k] ** 2).toBeCloseTo(1, 6);
  });
});

describe('recorded mission layers follow the threat', () => {
  it('calm at the start, tense in the middle, overrun at the top, always equal power', () => {
    let prevOverrun = 0;
    for (let x = 0; x <= 1.0001; x += 0.02) {
      const w = stemWeights(x, 'mission');
      expect(w.calm ** 2 + w.tense ** 2 + w.overrun ** 2).toBeCloseTo(1, 9);
      expect(w.overrun).toBeGreaterThanOrEqual(prevOverrun - 1e-12);
      prevOverrun = w.overrun;
    }
    expect(stemWeights(0.12, 'mission').calm).toBe(1); // the mission floor is calm
    expect(stemWeights(0.5, 'mission').tense).toBeGreaterThan(0.95);
    expect(stemWeights(1, 'mission').overrun).toBeCloseTo(1);
    expect(stemWeights(0.9, 'menu')).toEqual({ calm: 1, tense: 0, overrun: 0 });
    expect(stemWeights(NaN, 'mission').calm).toBe(1);
  });
});

describe('recorded effects', () => {
  it('each play varies a little in pitch and level (seeded), within bounds', () => {
    const rng = mulberry32(5);
    const plays = Array.from({ length: 50 }, () => vary(rng, 40, 1.5));
    for (const p of plays) {
      expect(Math.abs(1200 * Math.log2(p.rate))).toBeLessThanOrEqual(40 + 1e-9);
      expect(Math.abs(20 * Math.log10(p.gain))).toBeLessThanOrEqual(1.5 + 1e-9);
    }
    expect(new Set(plays.map((p) => p.rate.toFixed(4))).size).toBeGreaterThan(40);
    const again = mulberry32(5);
    expect(vary(again, 40, 1.5)).toEqual(plays[0]);
  });

  it('caps copies per sound, stealing the oldest; finished ones free their slot', () => {
    const lim = new VoiceLimiter<number>();
    expect(lim.admit('105', 1, 0, 4, 2)).toEqual([]);
    expect(lim.admit('105', 2, 0.1, 4, 2)).toEqual([]);
    expect(lim.admit('105', 3, 0.2, 4, 2)).toEqual([1]);
    expect(lim.count('105', 0.3)).toBe(2);
    expect(lim.admit('105', 4, 5, 9, 2)).toEqual([]); // the earlier ones have ended
    expect(lim.admit('40', 5, 5, 9, 2)).toEqual([]); // groups are separate
  });

  it('comfort: the 25 mm sample retriggers under 3 times a second, the alarm pulses 1.3 a second', () => {
    expect(1 / RETRIGGER_25).toBeLessThan(MAX_ONSETS_PER_SEC);
    expect(SAMPLE_PLAY[SFX.fire25].duration).toBeGreaterThan(RETRIGGER_25); // slices overlap: no gaps in a held burst
    expect(SAMPLE_PLAY[SFX.alarm].max).toBe(1);
  });

  it('uses the recorded sample when loaded and the synthesised sound when not', () => {
    const { out, made } = fakeOutput({ [SFX.fire105]: buf(4), [SFX.explosion]: buf(4) });
    const sfx = new Sfx(() => out);
    sfx.unlock();
    sfx.fire('105');
    sfx.impact('105');
    expect(made.buffers).toBe(2);
    expect(made.oscillators).toBe(0);
    sfx.fire('40'); // not loaded: synthesised
    expect(made.oscillators).toBe(1);
    sfx.muted = true;
    sfx.fire('105');
    expect(made.buffers).toBe(2);
  });

  it('the 25 mm keeps a synthesised crack per round and lays the recorded burst at most every RETRIGGER_25 s', () => {
    const { out, made, ctx } = fakeOutput({ [SFX.fire25]: buf(2) });
    const sfx = new Sfx(() => out);
    sfx.unlock();
    let rounds = 0;
    for (let t = 0; t < 2; t += 1 / 12) {
      ctx.currentTime = t;
      sfx.fire('25');
      rounds++;
    }
    expect(made.noise).toBe(rounds);
    expect(made.buffers).toBeGreaterThanOrEqual(4);
    expect(made.buffers).toBeLessThanOrEqual(Math.ceil(2 / RETRIGGER_25));
  });
});

describe('radio voice queue', () => {
  const dur = (line: VoiceLine) => (line === 'survivors-moving' ? 4 : 2.5);
  const run = (q: VoiceQueue, from: number, to: number, played: { line: VoiceLine; start: number; cut: boolean }[]) => {
    for (let t = from; t <= to + 1e-9; t += 0.05) {
      const n = q.poll(t);
      if (n) played.push({ line: n.line, start: t, cut: n.cut });
    }
  };

  it('one line at a time, with a quiet gap of at least MIN_GAP between lines', () => {
    const q = new VoiceQueue(dur);
    const played: { line: VoiceLine; start: number; cut: boolean }[] = [];
    q.say('new-contacts', 0);
    run(q, 0, 0.95, played);
    q.say('survivor-lost', 1); // waits for the gap after the first line
    run(q, 1, 7, played);
    q.say('survivor-home-kettle', 7);
    run(q, 7.05, 30, played);
    expect(played.map((p) => p.line)).toEqual(['new-contacts', 'survivor-lost', 'survivor-home-kettle']);
    for (let i = 1; i < played.length; i++) expect(played[i].start - (played[i - 1].start + dur(played[i - 1].line))).toBeGreaterThanOrEqual(MIN_GAP - 1e-9);
  });

  it('low-priority banter is dropped when the radio is busy; repeats inside the cooldown are dropped', () => {
    const q = new VoiceQueue(dur);
    q.say('new-contacts', 0);
    q.poll(0);
    expect(q.say('good-effect', 1)).toBe('dropped'); // busy
    expect(q.say('good-effect', 2.6)).toBe('dropped'); // free, but inside the gap
    expect(q.say('good-effect', 6)).toBe('queued');
    expect(q.poll(6)?.line).toBe('good-effect');
    expect(q.say('good-effect', 12)).toBe('dropped'); // cooldown
    expect(q.say('new-contacts', 9)).toBe('dropped'); // cooldown (15 s)
  });

  it('urgent calls cut in: CHECK FIRE stops banter and goes out at once', () => {
    const q = new VoiceQueue(dur);
    q.say('new-contacts', 0);
    q.poll(0);
    expect(q.say('check-fire', 1)).toBe('preempt');
    expect(q.poll(1)).toEqual({ line: 'check-fire', cut: true });
    // An urgent line never cuts another urgent line: it waits its turn.
    expect(q.say('friendlies-under-attack', 1.5)).toBe('queued');
    expect(q.poll(1.5)).toBeNull();
    expect(q.poll(1 + 2.5 + RULES['friendlies-under-attack'].gap!)?.line).toBe('friendlies-under-attack');
  });

  it('stale news is dropped, the queue stays short, and the end of a mission clears it', () => {
    const q = new VoiceQueue(dur);
    q.say('survivors-moving', 0);
    q.poll(0);
    q.say('new-contacts', 0.5);
    q.say('rushers', 0.6);
    q.say('safehouse-hits', 0.7);
    expect(q.say('all-clear', 0.8)).toBe('dropped'); // full, and it ranks no higher
    expect(q.say('survivor-lost', 0.9)).toBe('queued'); // ranks higher: replaces one
    expect(q.waiting).toBe(3);
    const played: { line: VoiceLine; start: number; cut: boolean }[] = [];
    run(q, 0.05, 30, played);
    expect(played[0].line).toBe('survivor-lost'); // highest priority first
    expect(played.length).toBeLessThan(3); // the rest went stale (waited > 6–8 s)
    q.say('more-coming', 31);
    q.clear();
    expect(q.poll(40)).toBeNull();
  });

  it('a line that has not loaded is never queued (the on-screen text carries it)', () => {
    const q = new VoiceQueue(() => 0);
    expect(q.say('cleared-hot', 0)).toBe('dropped');
  });

  it('under a random barrage of requests, lines never overlap and never come faster than the gap', () => {
    const rng = mulberry32(42);
    const q = new VoiceQueue(dur);
    const played: { line: VoiceLine; start: number; cut: boolean }[] = [];
    const ends: number[] = [];
    for (let t = 0; t < 600; t += 0.05) {
      if (rng() < 0.2) q.say(VOICE_LINES[Math.floor(rng() * VOICE_LINES.length)], t);
      const n = q.poll(t);
      if (n) {
        if (n.cut) ends[ends.length - 1] = t; // the cut line stops now
        played.push({ line: n.line, start: t, cut: n.cut });
        ends.push(t + dur(n.line));
      }
    }
    expect(played.length).toBeGreaterThan(40);
    for (let i = 1; i < played.length; i++) {
      expect(played[i].start).toBeGreaterThanOrEqual(ends[i - 1] - 1e-9);
      const r = RULES[played[i].line];
      if (!played[i].cut) expect(played[i].start - ends[i - 1]).toBeGreaterThanOrEqual((r.gap ?? MIN_GAP) - 1e-9);
      else expect(r.priority).toBe(PRIORITY.urgent);
    }
    // Banter never goes out more than ~ once per gap + line length, and cuts only come from urgent calls.
    expect(played.filter((p) => p.cut).every((p) => RULES[p.line].preempt)).toBe(true);
  });
});

describe('which line, when (truthful)', () => {
  const world = (p: Partial<VoiceWorld> = {}): VoiceWorld => ({ t: 0, running: true, defend: false, zombiesAlive: 5, coldAlive: 0, setOff: 0, integrity: 1, ...p });
  const wave = (kind: 'standard' | 'rush' | 'cold' | 'big', cold = 0): SimEvent => ({ type: 'wave', count: 10, cold, from: 'north', place: 'X', kind });

  it('maps events to lines', () => {
    const d = new VoiceDirector(() => undefined);
    expect(d.lineFor({ type: 'friendly-hit', x: 0, z: 0 })).toBe('check-fire');
    expect(d.lineFor({ type: 'danger-close' })).toBe('danger-close');
    expect(d.lineFor({ type: 'survivor-lost', x: 0, z: 0 })).toBe('survivor-lost');
    expect(d.lineFor({ type: 'survivor-home' })).toBe('survivor-home-kettle');
    expect(d.lineFor({ type: 'survivor-home' })).toBe('survivor-home-quieter');
    expect(d.lineFor({ type: 'radio', text: 'FRIENDLIES UNDER ATTACK! Contacts closing on the sheltering friendlies.' })).toBe('friendlies-under-attack');
    expect(d.lineFor({ type: 'radio', text: 'Something else' })).toBeNull();
    expect(d.lineFor({ type: 'result', won: true, reason: '' })).toBe('mission-complete');
    expect(d.lineFor({ type: 'result', won: false, reason: '' })).toBe('mission-failed');
    expect(d.lineFor({ type: 'impact', weapon: '105', x: 0, z: 0, kills: 9 })).toBeNull();
  });

  it('waves: rushers and big groups by kind; cold-blooded only the first time cold contacts appear', () => {
    const d = new VoiceDirector(() => undefined);
    expect(d.lineFor(wave('standard'))).toBe('new-contacts');
    expect(d.lineFor(wave('standard'))).toBe('more-coming');
    expect(d.lineFor(wave('rush'))).toBe('rushers');
    expect(d.lineFor(wave('big'))).toBe('big-group');
    expect(d.lineFor(wave('cold', 0))).not.toBe('cold-blooded'); // a "cold" wave with no cold contacts says nothing about them
    expect(d.lineFor(wave('big', 3))).toBe('cold-blooded');
    expect(d.lineFor(wave('cold', 7))).not.toBe('cold-blooded'); // already said
  });

  it('starts with cleared hot, and says cold-blooded at the start only if the mission has them', () => {
    const lines: VoiceLine[] = [];
    const fake = (cold: boolean) => ({ t: 0, phase: 'running' as const, zombies: [{ alive: true, cold }], survivors: [], mission: { type: 'clear' }, integrity: 1 });
    new VoiceDirector((l) => lines.push(l)).update([], fake(false) as never);
    expect(lines).toEqual(['cleared-hot']);
    lines.length = 0;
    new VoiceDirector((l) => lines.push(l)).update([], fake(true) as never);
    expect(lines).toEqual(['cleared-hot', 'cold-blooded']);
  });

  it('notices escorts setting off, the safehouse taking hits, and the last contact going down', () => {
    const d = new VoiceDirector(() => undefined);
    d.watch(world());
    expect(d.watch(world({ setOff: 3 }))).toEqual(['survivors-moving']);
    expect(d.watch(world({ setOff: 2 }))).toEqual([]); // one got home or was lost: not "moving"
    expect(d.watch(world({ setOff: 2, defend: true, integrity: 0.99 }))).toEqual([]);
    expect(d.watch(world({ setOff: 2, defend: true, integrity: 0.9 }))).toEqual(['safehouse-hits']);
    expect(d.watch(world({ setOff: 2, zombiesAlive: 0 }))).toEqual(['all-clear']);
    expect(d.watch(world({ setOff: 2, zombiesAlive: 0 }))).toEqual([]);
    expect(d.watch(world({ zombiesAlive: 0, running: false }))).toEqual([]);
  });

  it('big-kill banter takes turns, starting from the mission seed', () => {
    const a: VoiceLine[] = [];
    const d = new VoiceDirector((l) => a.push(l), 1);
    for (let i = 0; i < 4; i++) d.bigKill();
    expect(a).toEqual(['former-neighbours', 'splash-residents', 'good-effect', 'former-neighbours']);
  });

  it('in real missions every claim is true when it is made', () => {
    for (const [type, difficulty, seed] of [['clear', 1, 3], ['escort', 3, 7], ['defend', 4, 11], ['clear', 5, 2]] as const) {
      const r = createSim(makeSampleTown(), { type, difficulty, seed });
      if (!r.ok) throw new Error(r.reason);
      const sim = r.sim;
      const bot = new Bot(sim, SKILL.human);
      const said: { line: VoiceLine; w: VoiceWorld }[] = [];
      const d = new VoiceDirector((line) => said.push({ line, w: voiceWorld(sim) }), seed);
      while (sim.phase === 'running' && sim.t < 300) {
        bot.step(1 / 30);
        sim.step(1 / 30);
        d.update(sim.drainEvents(), sim);
      }
      expect(said[0].line).toBe('cleared-hot');
      const cold = said.filter((s) => s.line === 'cold-blooded');
      expect(cold.length).toBeLessThanOrEqual(1);
      for (const s of cold) expect(s.w.coldAlive).toBeGreaterThan(0);
      for (const s of said.filter((s) => s.line === 'all-clear')) expect(s.w.zombiesAlive).toBe(0);
      for (const s of said.filter((s) => s.line === 'survivors-moving')) expect(s.w.setOff).toBeGreaterThan(0);
      for (const s of said.filter((s) => s.line === 'safehouse-hits')) expect(s.w.defend && s.w.integrity < 1).toBe(true);
      if (difficulty <= 1) expect(cold.length).toBe(0); // easy missions have no cold-blooded contacts
      const end = said.filter((s) => s.line === 'mission-complete' || s.line === 'mission-failed');
      expect(end.length).toBe(sim.phase === 'running' ? 0 : 1);
      if (end.length) expect(end[0].line).toBe(sim.phase === 'won' ? 'mission-complete' : 'mission-failed');
    }
  });
});

/** A fake engine output recording what sound sources are made. */
function fakeOutput(samples: Record<string, AudioBuffer>) {
  const made = { buffers: 0, oscillators: 0, noise: 0 };
  const param = () => ({ value: 1, setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {}, cancelScheduledValues() {}, setTargetAtTime() {} });
  const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
  const noise = buf(1);
  const ctx = {
    currentTime: 0,
    sampleRate: 100,
    destination: node(),
    createGain: () => ({ ...node(), gain: param() }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
    createOscillator: () => {
      made.oscillators++;
      return { ...node(), type: 'sine', frequency: param(), start() {}, stop() {} };
    },
    createBufferSource: () => {
      const s = {
        ...node(),
        buffer: null as AudioBuffer | null,
        playbackRate: param(),
        start() {
          if (s.buffer === noise) made.noise++;
          else made.buffers++;
        },
        stop() {},
      };
      return s;
    },
  };
  // The engine's sample player, faked through the same context.
  const samplesPlayer = {
    play: (b: AudioBuffer, dest: AudioNode) => {
      const s = ctx.createBufferSource();
      s.buffer = b;
      s.connect(dest);
      s.start();
      return { start: 0, end: b.duration };
    },
  };
  const out = {
    ctx: ctx as unknown as AudioContext,
    sfx: node() as unknown as AudioNode,
    radio: node() as unknown as AudioNode,
    noise: noise,
    sample: (id: string) => samples[id] ?? null,
    samples: samplesPlayer as never,
  };
  return { out, made, ctx };
}
