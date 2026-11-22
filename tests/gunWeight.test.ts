import { describe, expect, it } from 'vitest';
import { FIRE_WEIGHT, Gate, IMPACT_WEIGHT, MIN_GAP, noiseEnvelope, PUNCH, punchGain, renderWeight, RETRIGGER_25, subEnvelope, SUB_FLOOR, subFreq, WEAPON_EQ, type Gun, type Weight, type WeightEvent } from '../src/audio/weight';
import { Sfx } from '../src/audio/sfx';
import { SFX } from '../src/audio/assets';
import { MAX_ONSETS_PER_SEC } from '../src/audio/music';
import { mulberry32 } from '../src/util/rng';
import type { SfxOutput } from '../src/audio/engine';

// Gun weight (src/audio/weight.ts): the synthesised sub, body and impact boom under the guns. Headless
// can't judge how they sound; these check the levels, the comfort caps and the headroom.

const GUNS: Gun[] = ['25', '40', '105'];
const all = (): [string, Weight][] => [
  ...GUNS.map((g) => [`fire ${g}`, FIRE_WEIGHT[g]] as [string, Weight]),
  ...Object.entries(IMPACT_WEIGHT).map(([g, w]) => [`impact ${g}`, w!] as [string, Weight]),
];
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, to - from));
};
const db = (x: number) => 20 * Math.log10(x);

describe('gun weight: levels', () => {
  it('every layer has a sane gain, an attack that cannot click, and stays in the sub band', () => {
    for (const [name, w] of all()) {
      expect(w.sub.gain, name).toBeGreaterThan(0);
      expect(w.sub.gain, name).toBeLessThanOrEqual(0.6);
      expect(w.body.gain, name).toBeGreaterThan(0);
      expect(w.body.gain, name).toBeLessThanOrEqual(0.4);
      expect(w.sub.attack, name).toBeGreaterThanOrEqual(0.005); // ≥ 5 ms: no click
      expect(w.sub.from, name).toBeLessThanOrEqual(150);
      expect(w.sub.to, name).toBeGreaterThanOrEqual(SUB_FLOOR);
      expect(w.sub.to, name).toBeLessThan(w.sub.from); // drops in pitch
      expect(w.sub.to, name).toBeLessThanOrEqual(80);
      expect(w.body.lp, name).toBeLessThanOrEqual(600);
      expect(SUB_FLOOR).toBeGreaterThanOrEqual(WEAPON_EQ.highpass - 2); // the bus high-pass doesn't eat the layer
    }
  });

  it('scales with the gun: subtle under the 25 mm, heavy under the 105', () => {
    const [a, b, c] = GUNS.map((g) => FIRE_WEIGHT[g]);
    expect(a.sub.gain).toBeLessThan(b.sub.gain);
    expect(b.sub.gain).toBeLessThan(c.sub.gain);
    expect(b.sub.dur).toBeLessThan(c.sub.dur);
    expect(c.sub.to).toBeLessThan(b.sub.to);
    expect(IMPACT_WEIGHT['25']).toBeUndefined(); // 25 mm rounds land 12 a second: no boom
    expect(IMPACT_WEIGHT['40']!.sub.gain).toBeLessThan(IMPACT_WEIGHT['105']!.sub.gain);
  });

  it('the impact boom comes just after the flash and is low-passed', () => {
    for (const g of ['40', '105'] as const) {
      const w = IMPACT_WEIGHT[g]!;
      expect(w.sub.delay).toBeGreaterThan(0);
      expect(w.sub.delay).toBeLessThanOrEqual(0.15);
      expect(w.body.delay).toBe(w.sub.delay);
      expect(w.body.lp).toBeLessThanOrEqual(250);
    }
  });

  it('envelopes: zero before the delay and after the end, peak at the set gain, pitch ends where set', () => {
    const s = FIRE_WEIGHT['105'].sub;
    expect(subEnvelope(s, -0.01)).toBe(0);
    expect(subEnvelope(s, s.attack)).toBeCloseTo(s.gain, 5);
    expect(subEnvelope(s, s.dur + 0.01)).toBe(0);
    expect(subEnvelope(s, s.dur - 1e-6)).toBeLessThan(0.002);
    expect(subFreq(s, 0)).toBeCloseTo(s.from);
    expect(subFreq(s, s.dur)).toBeCloseTo(s.to);
    const n = IMPACT_WEIGHT['105']!.body;
    expect(noiseEnvelope(n, n.delay)).toBeCloseTo(n.gain);
    expect(noiseEnvelope(n, n.delay - 0.01)).toBe(0);
  });

  it('the punch dips the music, holds briefly, and is back to full within about a second', () => {
    for (const p of Object.values(PUNCH)) {
      expect(p.depth).toBeGreaterThan(0);
      expect(p.depth).toBeLessThanOrEqual(0.6);
      expect(p.attack).toBeGreaterThanOrEqual(0.005); // a ramp, not a step: no click
      expect(punchGain(p, p.attack + p.hold / 2)).toBeCloseTo(1 - p.depth);
      expect(punchGain(p, p.attack + p.hold + p.release)).toBe(1);
      expect(p.attack + p.hold + p.release).toBeLessThanOrEqual(1.2);
    }
    expect(PUNCH.impact105.depth).toBeGreaterThan(PUNCH.fire105.depth);
  });
});

describe('gun weight: comfort', () => {
  it('no weight layer retriggers 3 or more times a second; the 25 mm follows its recorded burst', () => {
    for (const [name, w] of all()) {
      expect(w.gap, name).toBeGreaterThanOrEqual(MIN_GAP);
      expect(1 / w.gap, name).toBeLessThan(MAX_ONSETS_PER_SEC);
    }
    expect(FIRE_WEIGHT['25'].gap).toBe(RETRIGGER_25);
    expect(FIRE_WEIGHT['25'].sub.dur).toBeGreaterThan(RETRIGGER_25); // overlaps: a steady floor, no gaps
  });

  it('the gate admits one per gap per key', () => {
    const g = new Gate();
    let n = 0;
    for (let t = 0; t < 10; t += 1 / 12) if (g.admit('fire25', t, RETRIGGER_25)) n++;
    expect(n).toBeLessThanOrEqual(Math.ceil(10 / RETRIGGER_25));
    expect(n).toBeGreaterThanOrEqual(Math.floor(10 / (RETRIGGER_25 + 1 / 12)));
    expect(g.admit('impact105', 0, MIN_GAP)).toBe(true); // keys are separate
    expect(g.admit('impact105', 0.1, MIN_GAP)).toBe(false);
  });
});

describe('gun weight: headroom', () => {
  // 10 s held 25 mm (12 a second), a 40 mm volley (2.5 a second) landing 1.5 s later, a 105 fired at
  // 3 s landing at 6 s, and a second 105 at 7.5 s landing at 9 s right on top of 40 mm impacts.
  const timeline = (): WeightEvent[] => {
    const ev: WeightEvent[] = [];
    for (let t = 0; t < 10; t += 1 / 12) ev.push({ at: t, gun: '25', kind: 'fire' });
    for (let t = 6; t < 10; t += 0.4) ev.push({ at: t, gun: '40', kind: 'fire' }, { at: t + 1.5, gun: '40', kind: 'impact' });
    ev.push({ at: 3, gun: '105', kind: 'fire' }, { at: 6, gun: '105', kind: 'impact' });
    ev.push({ at: 7.5, gun: '105', kind: 'fire' }, { at: 9, gun: '105', kind: 'impact' });
    return ev;
  };
  const SR = 8000;
  const shelf = 10 ** (WEAPON_EQ.shelfDb / 20); // worst case: the whole layer boosted by the shelf

  it('the new layers alone never reach full scale on the weapon bus, even after the low shelf', () => {
    const x = renderWeight(timeline(), 10.5, SR, mulberry32(7));
    expect(peak(x) * shelf).toBeLessThan(1);
  });

  it('the 25 mm weight is a floor, not a wall: well under the 105 blast', () => {
    const burst = renderWeight(timeline().filter((e) => e.gun === '25'), 10.5, SR, mulberry32(3));
    const blast = renderWeight([{ at: 0, gun: '105', kind: 'impact' }], 2, SR, mulberry32(3));
    const r25 = rms(burst, SR, 9 * SR);
    expect(db(r25)).toBeLessThan(-18);
    expect(db(r25)).toBeGreaterThan(-40); // but there
    expect(db(rms(blast, 0, Math.round(0.6 * SR)))).toBeGreaterThan(db(r25) + 6);
  });

  it('a held 25 mm burst never drops out between retriggers (the layers overlap)', () => {
    const burst = renderWeight(timeline().filter((e) => e.gun === '25'), 10.5, SR, mulberry32(5));
    const win = Math.round(0.05 * SR);
    let quietest = Infinity;
    for (let i = SR; i + win < 9 * SR; i += win) quietest = Math.min(quietest, rms(burst, i, i + win));
    expect(db(quietest)).toBeGreaterThan(-50);
  });
});

/** A fake engine output that counts what Sfx makes and records the punches. */
function fake(samples: Record<string, AudioBuffer> = {}) {
  const made = { oscillators: 0, noise: 0, buffers: 0, subGains: [] as number[] };
  const punches: { at: number; depth: number }[] = [];
  const param = (onSet?: (v: number) => void) => ({
    value: 1,
    setValueAtTime() {},
    linearRampToValueAtTime(v: number) {
      onSet?.(v);
    },
    exponentialRampToValueAtTime() {},
    cancelScheduledValues() {},
    setTargetAtTime() {},
  });
  const node = () => ({ connect: (n: unknown) => n, disconnect() {} });
  const noise = { duration: 1 } as AudioBuffer;
  const ctx = {
    currentTime: 0,
    sampleRate: 100,
    destination: node(),
    createBuffer: () => ({ getChannelData: () => new Float32Array(100) }),
    createGain: () => ({ ...node(), gain: param((v) => made.subGains.push(v)) }),
    createBiquadFilter: () => ({ ...node(), type: '', frequency: param(), Q: param() }),
    createOscillator: () => {
      made.oscillators++;
      return { ...node(), type: 'sine', frequency: param(), start() {}, stop() {} };
    },
    createBufferSource: () => {
      const s = { ...node(), buffer: null as AudioBuffer | null, playbackRate: param(), start() { if (s.buffer === noise) made.noise++; }, stop() {} };
      return s;
    },
  };
  const out = {
    ctx: ctx as unknown as AudioContext,
    sfx: node() as unknown as AudioNode,
    radio: node() as unknown as AudioNode,
    noise,
    duck() {},
    punch: (p: { depth: number }) => punches.push({ at: ctx.currentTime, depth: p.depth }),
    sample: (id: string) => samples[id] ?? null,
    samples: { play: () => { made.buffers++; return { start: 0, end: 1 }; } },
  } as unknown as SfxOutput;
  return { ctx, out, made, punches };
}

describe('gun weight: played by Sfx', () => {
  it('a 10 s held 25 mm burst lays its weight at most every RETRIGGER_25 s, and every round keeps its crack', () => {
    const { ctx, out, made } = fake({ [SFX.fire25]: { duration: 2 } as AudioBuffer });
    const sfx = new Sfx(() => out);
    sfx.unlock();
    let rounds = 0;
    for (let t = 0; t < 10; t += 1 / 12, rounds++) {
      ctx.currentTime = t;
      sfx.fire('25');
    }
    const weights = made.oscillators; // one sub per weight layer
    expect(weights).toBeGreaterThanOrEqual(Math.floor(10 / (RETRIGGER_25 + 1 / 12)));
    expect(weights).toBeLessThanOrEqual(Math.ceil(10 / RETRIGGER_25));
    expect(made.noise).toBe(rounds + weights); // a crack per round + a body per weight
  });

  it('the 105 punches the music on firing and harder on landing, never more than once per MIN_GAP', () => {
    const { ctx, out, punches } = fake();
    const sfx = new Sfx(() => out);
    sfx.unlock();
    sfx.fire('105');
    ctx.currentTime = 0.1;
    sfx.impact('105'); // too soon after the last punch: gated
    ctx.currentTime = 3;
    sfx.impact('105');
    sfx.fire('40');
    sfx.impact('40');
    sfx.fire('25');
    expect(punches).toEqual([
      { at: 0, depth: PUNCH.fire105.depth },
      { at: 3, depth: PUNCH.impact105.depth },
    ]);
  });

  it('the weight plays under the recorded files and under the generated stand-ins alike, and not when muted', () => {
    for (const loaded of [true, false]) {
      const { out, made, punches } = fake(loaded ? { [SFX.fire105]: { duration: 4 } as AudioBuffer, [SFX.explosion]: { duration: 4 } as AudioBuffer } : {});
      const sfx = new Sfx(() => out);
      sfx.unlock();
      sfx.fire('105');
      sfx.impact('105');
      expect(made.oscillators).toBe(2);
      expect(made.subGains).toContain(FIRE_WEIGHT['105'].sub.gain);
      expect(made.subGains).toContain(IMPACT_WEIGHT['105']!.sub.gain);
      expect(made.buffers).toBe(loaded ? 2 : 0);
      sfx.muted = true;
      const before = { ...made, n: punches.length };
      (out.ctx as unknown as { currentTime: number }).currentTime = 5;
      sfx.fire('105');
      sfx.impact('105');
      expect(made.oscillators).toBe(before.oscillators);
      expect(made.noise).toBe(before.noise);
      expect(punches.length).toBe(before.n);
    }
  });

  it('works on a bare AudioContext (no engine: no punch, no samples), as before', () => {
    const { ctx, made } = fake();
    const sfx = new Sfx(() => ctx as unknown as AudioContext);
    sfx.unlock();
    expect(() => {
      sfx.fire('105');
      sfx.impact('105');
      sfx.fire('25');
    }).not.toThrow();
    expect(made.oscillators).toBe(3);
  });
});
