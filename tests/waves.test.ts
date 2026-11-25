import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { TEMPLATE_IDS } from '../src/map/recon';
import { FIRST_WAVE, WAVE_KINDS, generateMission, planWaveKinds, waveIntel, type Mission, type WaveKind } from '../src/sim/missions';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import type { SimEvent } from '../src/sim/sim';
import { mulberry32 } from '../src/util/rng';
import { waveCall } from '../src/game/waveCall';

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);
type WaveEvent = Extract<SimEvent, { type: 'wave' }>;

function missionOf(type: 'escort' | 'defend', d: number, seed: number): Mission {
  const r = generateMission(map, graph, grid, { type, difficulty: d, seed });
  if (!r.ok) throw new Error(r.reason);
  return r.mission;
}

describe('waves vary within a mission', () => {
  it('the plan is seeded: same seed, same order; and it follows its rules', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const a = planWaveKinds(mulberry32(seed), 12, 240, seed % 2 === 0);
      expect(planWaveKinds(mulberry32(seed), 12, 240, seed % 2 === 0)).toEqual(a);
      expect(a[0]).toBe('standard');
      expect(a.slice(0, 2)).not.toContain('big');
      for (let i = 1; i < a.length; i++) if (a[i] !== 'standard') expect(a[i], `seed ${seed} wave ${i}`).not.toBe(a[i - 1]);
      if (seed % 2) expect(a).not.toContain('cold');
      if (a.length >= 4) expect(a.some((k) => k !== 'standard')).toBe(true);
      // Every planned wave arrives inside the horizon.
      const t = a.slice(1).reduce((s, k) => s + 12 * WAVE_KINDS[k].gap, FIRST_WAVE);
      expect(t).toBeLessThanOrEqual(240);
    }
  });

  it('missions carry a deterministic sequence with a mix of kinds, and a different seed changes it', () => {
    const a = missionOf('defend', 3, 5);
    expect(missionOf('defend', 3, 5).waves!.kinds).toEqual(a.waves!.kinds);
    expect(new Set(a.waves!.kinds).size).toBeGreaterThan(1);
    const seqs = new Set([1, 2, 3, 4, 5, 6].map((s) => missionOf('defend', 3, s).waves!.kinds!.join()));
    expect(seqs.size).toBeGreaterThan(3);
  });

  it('cold waves only where cold-blooded zombies live (difficulty 2 and up), so difficulty 1 intel stays true', () => {
    for (let seed = 1; seed <= 6; seed++) {
      for (const type of ['escort', 'defend'] as const) {
        expect(missionOf(type, 1, seed).waves!.kinds).not.toContain('cold');
        expect(missionOf(type, 1, seed).intel[0]).toMatch(/no cold-blooded/);
      }
    }
  });

  it('intel tells the truth about the mix: it names exactly the kinds in the plan, and says nothing when waves do not vary', () => {
    const names: Record<Exclude<WaveKind, 'standard'>, RegExp> = { rush: /rush/, cold: /cold-blooded wave/, big: /big wave/ };
    for (const type of ['escort', 'defend'] as const) {
      for (let d = 1; d <= 5; d++) {
        for (let seed = 1; seed <= 4; seed++) {
          const m = missionOf(type, d, seed);
          const kinds = new Set(m.waves!.kinds);
          const line = m.intel.find((l) => /waves won't all look alike/.test(l)) ?? '';
          for (const k of ['rush', 'cold', 'big'] as const) expect(names[k].test(line), `${type} d${d} s${seed} ${k}`).toBe(kinds.has(k));
          if (kinds.size > 1) expect(line).toMatch(/^Intel: the waves won't all look alike\. Expect a mix: /);
        }
      }
    }
    expect(waveIntel({ every: 10, size: 5, coldShare: 0, minDist: 1, maxDist: 2, maxAlive: 9, kinds: ['standard', 'standard'] })).toEqual([]);
    expect(waveIntel({ every: 10, size: 5, coldShare: 0, minDist: 1, maxDist: 2, maxAlive: 9 })).toEqual([]);
    expect(waveIntel({ every: 10, size: 5, coldShare: 0, minDist: 1, maxDist: 2, maxAlive: 9, kinds: ['standard', 'rush', 'standard', 'cold'] })).toEqual([
      "Intel: the waves won't all look alike. Expect a mix: a small rush of fast lungers and a mostly cold-blooded wave.",
    ]);
  });

  it('every template with waves gets the same truthful intel', () => {
    for (const id of TEMPLATE_IDS) {
      const r = generateMission(map, graph, grid, { type: 'auto', difficulty: 3, seed: 2, template: id });
      if (!r.ok || !r.mission.waves) continue;
      expect(r.mission.intel.slice(1), id).toEqual(waveIntel(r.mission.waves));
    }
  });

  it('in play, waves arrive in the planned order with the planned make-up, and every kind the intel promises shows up', () => {
    for (const type of ['escort', 'defend'] as const) {
      for (const [d, seed] of [[1, 1], [3, 2], [4, 3]]) {
        const r = createSim(map, { type, difficulty: d, seed });
        if (!r.ok) throw new Error(r.reason);
        const sim = r.sim;
        const bot = new Bot(sim, SKILL.human);
        const seen: WaveEvent[] = [];
        while (sim.phase === 'running' && sim.t < 900) {
          bot.step(1 / 30);
          sim.step(1 / 30);
          for (const e of sim.drainEvents()) if (e.type === 'wave') seen.push(e);
        }
        const w = sim.mission.waves!;
        const plan = w.kinds!;
        seen.forEach((e, i) => {
          expect(e.kind, `${type} d${d} wave ${i}`).toBe(plan[i] ?? 'standard');
          const k = WAVE_KINDS[e.kind];
          if (e.count === Math.max(1, Math.round(w.size * k.size))) expect(e.cold).toBe(Math.round(e.count * (k.cold ?? w.coldShare)));
        });
        if (sim.phase === 'won') for (const k of new Set(plan)) expect(seen.some((e) => e.kind === k), `${type} d${d}: ${k} never came`).toBe(true);
      }
    }
  }, 180_000);

  it('rushers are faster and all warm; big waves are bigger', () => {
    const r = createSim(map, { type: 'defend', difficulty: 3, seed: 1 });
    if (!r.ok) throw new Error(r.reason);
    const sim = r.sim;
    const bot = new Bot(sim, SKILL.human); // keeps the safehouse standing until the big wave
    const byKind = new Map<WaveKind, { speed: number[]; cold: number; count: number }>();
    while (sim.phase === 'running' && sim.t < 200) {
      const before = sim.zombies.length;
      bot.step(1 / 30);
      sim.step(1 / 30);
      for (const e of sim.drainEvents()) {
        if (e.type !== 'wave') continue;
        const fresh = sim.zombies.slice(before);
        const k = byKind.get(e.kind) ?? { speed: [], cold: 0, count: 0 };
        k.speed.push(...fresh.map((z) => z.speed));
        k.cold += fresh.filter((z) => z.cold).length;
        k.count = Math.max(k.count, fresh.length);
        byKind.set(e.kind, k);
      }
    }
    const avg = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    const std = byKind.get('standard')!;
    const rush = byKind.get('rush');
    const big = byKind.get('big');
    expect(rush && big, 'this seed has a rush and a big wave').toBeTruthy();
    expect(avg(rush!.speed)).toBeGreaterThan(avg(std.speed) * 1.25);
    expect(rush!.cold).toBe(0);
    expect(big!.count).toBeGreaterThan(std.count);
  }, 60_000);

  it('waves come from different directions: never the same compass sector as either of the last two, where the map allows', () => {
    const r = createSim(map, { type: 'defend', difficulty: 3, seed: 4 });
    if (!r.ok) throw new Error(r.reason);
    const sim = r.sim;
    const from: string[] = [];
    while (sim.phase === 'running' && sim.t < 120) {
      sim.step(1 / 30);
      for (const e of sim.drainEvents()) if (e.type === 'wave') from.push(e.from);
    }
    expect(from.length).toBeGreaterThan(5);
    for (let i = 1; i < from.length; i++) expect(from[i], `wave ${i}: ${from.join(', ')}`).not.toBe(from[i - 1]);
  });

  it('the radio names the kind and the place, and varies its wording', () => {
    const base = { type: 'wave' as const, count: 7, cold: 0, from: 'north', place: 'Elm Street' };
    const rush = waveCall({ ...base, kind: 'rush' }, 0);
    expect(rush).toMatch(/rush/i);
    expect(rush).toContain('Elm Street');
    expect(waveCall({ ...base, kind: 'cold', cold: 5 }, 0)).toMatch(/cold/i);
    expect(waveCall({ ...base, kind: 'big' }, 0)).toMatch(/big/i);
    expect(waveCall({ ...base, kind: 'standard' }, 0)).not.toMatch(/rush|big/i);
    for (const kind of ['standard', 'rush', 'cold', 'big'] as const) {
      const lines = new Set([0, 1, 2].map((n) => waveCall({ ...base, kind }, n)));
      expect(lines.size, kind).toBe(3);
      for (const l of lines) expect(l).toContain('Elm Street');
    }
  });
});
