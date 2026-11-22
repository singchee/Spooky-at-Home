import { describe, expect, it } from 'vitest';
import { busGains, duckGains, DuckEnvelope, DUCK, perceptual } from '../src/audio/mix';
import { FLOOR, IntensitySmoother, NEAR_M, measureThreat, threatIntensity, type ThreatSnapshot } from '../src/audio/intensity';
import { BPM, fastestOnsetsPerSec, layerWeights, MAX_ONSETS_PER_SEC } from '../src/audio/music';
import { Mixer } from '../src/audio/mixer';
import { defaultSettings, updateSettings, _resetSettingsForTests } from '../src/ui/settings';
import { WEAPONS } from '../src/sim/weapons';
import { makeSampleTown } from '../src/map/sample';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import type { Sim } from '../src/sim/sim';

// Sound can't be heard in a headless test. These check the rules that drive it; the browser check
// (scripts/playtest.mjs, "audio") checks the real AudioContext, node counts and mute.

describe('volume from settings', () => {
  it('composes bus gains from the sliders, squared so half way sounds about half as loud', () => {
    const s = { ...defaultSettings(), masterVolume: 1, musicVolume: 1, sfxVolume: 0.5, radioVolume: 0, muted: false };
    const g = busGains(s);
    expect(g.master).toBe(1);
    expect(g.sfx).toBeCloseTo(0.25);
    expect(g.radio).toBe(0);
    expect(g.music).toBeGreaterThan(0);
    expect(g.music).toBeLessThan(g.sfx * 4); // music sits under the guns
  });
  it('muted silences the master and nothing else', () => {
    const s = defaultSettings();
    const on = busGains(s);
    const off = busGains({ ...s, muted: true });
    expect(off.master).toBe(0);
    expect({ ...off, master: on.master }).toEqual(on);
  });
  it('never makes a gain outside 0..1, whatever the input', () => {
    for (const v of [-1, 0, 0.3, 1, 7, NaN]) {
      expect(perceptual(v)).toBeGreaterThanOrEqual(0);
      expect(perceptual(v)).toBeLessThanOrEqual(1);
    }
    expect(perceptual(0.2)).toBeLessThan(perceptual(0.6));
  });
  it('the mixer follows settings changes live, including mute', () => {
    _resetSettingsForTests();
    const { ctx, params } = fakeContext();
    const mixer = new Mixer(ctx);
    const master = params[0]; // the first gain made is the master
    expect(master.value).toBeCloseTo(busGains(defaultSettings()).master);
    updateSettings({ muted: true });
    expect(master.target).toBe(0);
    updateSettings({ muted: false, masterVolume: 0.5 });
    expect(master.target).toBeCloseTo(0.25);
    mixer.dispose();
    updateSettings({ masterVolume: 1 });
    expect(master.target).toBeCloseTo(0.25); // unsubscribed
    _resetSettingsForTests();
  });
});

describe('ducking', () => {
  const run = (env: DuckEnvelope, seconds: number, every: number, d: readonly [number, number]) => {
    const dt = 1 / 100;
    const levels: number[] = [];
    let next = 0;
    for (let t = 0; t < seconds; t += dt) {
      if (every > 0 && t >= next) {
        env.trigger(d[0], d[1]);
        next += every;
      }
      levels.push(env.step(dt));
    }
    return levels;
  };

  it('dips fast and recovers smoothly after a 105 blast', () => {
    const env = new DuckEnvelope();
    const levels = run(env, 4, 0, DUCK.impact['105']);
    expect(levels.every((l) => l === 0)).toBe(true);
    env.trigger(...DUCK.impact['105']);
    const after = run(env, 4, 0, DUCK.impact['105']);
    expect(after[9]).toBeCloseTo(DUCK.impact['105'][0], 2); // within 0.1 s
    const back = after.findIndex((l, i) => i > 10 && l === 0);
    expect(back / 100).toBeGreaterThan(1.5); // no snap back
    expect(back / 100).toBeLessThan(3.2);
    // Smooth: the release never moves more than 1/release per second.
    for (let i = 11; i < after.length; i++) expect(after[i - 1] - after[i]).toBeLessThanOrEqual(0.01 / env.release + 1e-9);
  });

  it('holds one steady dip under sustained fire instead of pumping (comfort)', () => {
    for (const w of WEAPONS.filter((w) => w.interval > 0)) {
      const d = DUCK.fire[w.id];
      const levels = run(new DuckEnvelope(), 6, w.interval, d).slice(100);
      const swing = Math.max(...levels) - Math.min(...levels);
      expect(swing, `${w.id} mm`).toBeLessThan(0.02);
    }
  });

  it('a small shot never lifts a bigger dip early', () => {
    const env = new DuckEnvelope();
    env.trigger(0.9, 1);
    for (let i = 0; i < 20; i++) env.step(0.01);
    env.trigger(0.2, 0.2);
    for (let i = 0; i < 20; i++) env.step(0.01);
    expect(env.level).toBeCloseTo(0.9);
  });

  it('duck gains stay audible', () => {
    expect(duckGains(0)).toEqual({ music: 1, ambience: 1 });
    expect(duckGains(1).music).toBeGreaterThan(0.3);
    expect(duckGains(5).ambience).toBe(duckGains(1).ambience);
  });
});

const calm: ThreatSnapshot = { phase: 'running', contacts: 0, nearContacts: 0, attackers: 0, timeLeft: 600, timeLimit: 600, integrity: 1 };

describe('score intensity from mission state', () => {
  it('is zero when the mission is over and a low floor when nothing is happening', () => {
    expect(threatIntensity({ ...calm, phase: 'won', nearContacts: 40 })).toBe(0);
    expect(threatIntensity({ ...calm, phase: 'lost' })).toBe(0);
    expect(threatIntensity(calm)).toBeCloseTo(FLOOR);
  });
  it('rises with contacts near friendlies, and stays within 0..1', () => {
    let prev = 0;
    for (const n of [0, 1, 3, 8, 20, 200]) {
      const x = threatIntensity({ ...calm, nearContacts: n });
      expect(x).toBeGreaterThanOrEqual(prev);
      expect(x).toBeLessThanOrEqual(1);
      prev = x;
    }
    expect(prev).toBeGreaterThan(0.5);
  });
  it('a crowd far away adds a little; the same crowd closing on friendlies adds a lot', () => {
    const far = threatIntensity({ ...calm, contacts: 40 });
    expect(far).toBeGreaterThan(threatIntensity(calm));
    expect(threatIntensity({ ...calm, contacts: 40, nearContacts: 10 })).toBeGreaterThan(far + 0.25);
  });
  it('friendlies under attack push it hard; everything at once is near full', () => {
    expect(threatIntensity({ ...calm, nearContacts: 3, attackers: 1 })).toBeGreaterThan(0.7);
    const worst = threatIntensity({ phase: 'running', contacts: 100, nearContacts: 50, attackers: 10, timeLeft: 0, timeLimit: 600, integrity: 0 });
    expect(worst).toBeGreaterThan(0.95);
    expect(worst).toBeLessThanOrEqual(1);
  });
  it('the clock only adds urgency in the last minute', () => {
    expect(threatIntensity({ ...calm, timeLeft: 300 })).toBeCloseTo(threatIntensity(calm));
    expect(threatIntensity({ ...calm, timeLeft: 10 })).toBeGreaterThan(threatIntensity({ ...calm, timeLeft: 50 }));
  });
  it('a damaged safehouse raises it', () => {
    expect(threatIntensity({ ...calm, integrity: 0.4 })).toBeGreaterThan(threatIntensity(calm) + 0.2);
  });

  it('reads contacts near friendlies and biters from the sim', () => {
    const zombie = (x: number, z: number, alive = true) => ({ x, z, alive });
    const sim = {
      phase: 'running' as const,
      t: 100,
      integrity: 1,
      mission: { type: 'escort', timeLimit: 300 },
      survivors: [
        { x: 0, z: 0, alive: true, home: false },
        { x: 500, z: 0, alive: true, home: true }, // home: not a friendly to protect any more
      ],
      zombies: [zombie(1, 0), zombie(30, 0), zombie(59, 0), zombie(10, 0, false), zombie(500, 1)],
    } as unknown as Sim;
    const t = measureThreat(sim);
    expect(t.contacts).toBe(4);
    // Weighted by closeness: 1 m, 30 m and 59 m away; the one by the survivor who made it home doesn't count.
    expect(t.nearContacts).toBeCloseTo(3 - (1 + 30 + 59) / NEAR_M);
    expect(t.attackers).toBe(1);
    expect(t.timeLeft).toBe(200);
  });

  it('counts contacts at the safehouse door in a defend mission', () => {
    const sim = {
      phase: 'running' as const,
      t: 0,
      integrity: 0.8,
      mission: { type: 'defend', timeLimit: 300, safehouse: { centre: { x: 100, z: 100 } } },
      survivors: [],
      zombies: [{ x: 110, z: 100, alive: true }, { x: 150, z: 100, alive: true }, { x: 400, z: 0, alive: true }],
    } as unknown as Sim;
    const t = measureThreat(sim);
    expect(t.contacts).toBe(3);
    expect(t.nearContacts).toBeCloseTo(2 - (10 + 50) / NEAR_M);
    expect(t.attackers).toBe(1);
    expect(t.integrity).toBe(0.8);
  });

  it('follows a real mission played by the bot: calm at the start, tense when it matters, deterministic', () => {
    const trace = () => {
      const r = createSim(makeSampleTown(), { type: 'escort', difficulty: 3, seed: 7 });
      if (!r.ok) throw new Error(r.reason);
      const sim = r.sim;
      const bot = new Bot(sim, SKILL.human);
      const out: number[] = [];
      let k = 0;
      while (sim.phase === 'running' && sim.t < 400) {
        bot.step(1 / 30);
        sim.step(1 / 30);
        if (++k % 8 === 0) out.push(threatIntensity(measureThreat(sim))); // about 4 times a second
      }
      return out;
    };
    const a = trace();
    expect(a.length).toBeGreaterThan(20);
    expect(a.every((x) => x >= 0 && x <= 1)).toBe(true);
    expect(Math.max(...a)).toBeGreaterThan(a[0] + 0.15);
    expect(trace()).toEqual(a);
  }, 30_000); // plays a whole mission; 5 s is too tight when the machine is busy

  it('is smoothed: swells in seconds, settles more slowly, never jumps', () => {
    const s = new IntensitySmoother(0);
    s.step(1, 0.25);
    expect(s.value).toBeCloseTo(s.rise * 0.25);
    for (let i = 0; i < 40; i++) s.step(1, 0.25);
    expect(s.value).toBe(1);
    s.step(0, 0.25);
    expect(1 - s.value).toBeCloseTo(s.fall * 0.25);
    expect(s.fall).toBeLessThan(s.rise);
  });
});

describe('score layers', () => {
  it('crossfade with intensity: calm is drone and pad, full threat brings the drums', () => {
    for (let x = 0; x <= 1.0001; x += 0.05) {
      const w = layerWeights(x, 'mission');
      for (const v of Object.values(w)) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
    const lo = layerWeights(FLOOR, 'mission');
    const hi = layerWeights(1, 'mission');
    expect(lo.pad).toBe(1);
    expect(lo.pulse).toBe(0);
    expect(lo.tension).toBe(0);
    expect(hi.tension).toBe(1);
    expect(hi.pulse).toBe(1);
    let prev = -1;
    for (let x = 0; x <= 1; x += 0.05) {
      const p = layerWeights(x, 'mission').pulse;
      expect(p).toBeGreaterThanOrEqual(prev);
      prev = p;
    }
  });
  it('the menu theme is calmer: no pulse or drums, whatever the intensity', () => {
    for (const x of [0, 0.5, 1]) {
      const w = layerWeights(x, 'menu');
      expect(w.pulse).toBe(0);
      expect(w.tension).toBe(0);
    }
    expect(BPM.menu).toBeLessThan(BPM.mission);
  });
  it('never starts notes faster than 3 a second (comfort)', () => {
    expect(MAX_ONSETS_PER_SEC).toBeLessThanOrEqual(3);
    for (const m of ['menu', 'mission'] as const) expect(fastestOnsetsPerSec(m)).toBeLessThan(MAX_ONSETS_PER_SEC);
  });
});

/** Just enough of an AudioContext for the mixer: records each gain's value and latest target. */
function fakeContext() {
  const params: { value: number; target: number }[] = [];
  const param = () => {
    const p = {
      value: 1,
      target: NaN,
      setTargetAtTime(v: number) {
        p.target = v;
      },
    };
    return p;
  };
  const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
  const ctx = {
    currentTime: 0,
    destination: {},
    createGain: () => {
      const gain = param();
      params.push(gain);
      return { ...node(), gain };
    },
    createDynamicsCompressor: () => ({ ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }),
  };
  return { ctx: ctx as unknown as AudioContext, params };
}
