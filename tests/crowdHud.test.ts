import { describe, expect, it } from 'vitest';
import { BURST_GAP, BurstCounter, COUNTER_HZ, MULT_FADE, TALLY_IN, TALLY_MAX, TALLY_MIN, TALLY_OUT, tallyFor, tallyOpacity } from '../src/ui/crowdHud';
import { CrowdBests, crowdBestKey } from '../src/ui/crowdBests';
import { CROWD_KILL_LINES, FrameStats } from '../src/game/crowdMode';
import { defaultCrowdSize } from '../src/ui/recon';

/** Spec 003 Feel M1-M4 and S1: the crowd HUD's rules (the DOM side is checked by the playtest). */
describe('crowd HUD rules', () => {
  it('tallies only for the 105 and the 40 at 5 kills or more (Feel M2); the 25 mm sums its burst', () => {
    expect(TALLY_MIN).toBe(5);
    expect(tallyFor('105', 5)).toBe(true);
    expect(tallyFor('40', 12)).toBe(true);
    expect(tallyFor('105', 4)).toBe(false);
    expect(tallyFor('25', 30)).toBe(false);
    const b = new BurstCounter();
    for (let i = 0; i < 24; i++) b.add(i % 3, i, 0, i / 12); // 24 rounds at 12/s, 24 kills, last one at x = 23
    expect(b.flush(23 / 12 + 0.1)).toBeNull(); // still firing
    expect(b.flush(23 / 12 + BURST_GAP + 0.01)).toEqual({ kills: 24, x: 23, z: 0 });
    expect(b.flush(10)).toBeNull();
  });

  it('at most 3 on screen, fades of 0.3 s or more, never a pop; with Reduce flicker they appear and go at once', () => {
    expect(TALLY_MAX).toBe(3);
    expect(TALLY_IN).toBeGreaterThanOrEqual(0.3);
    expect(TALLY_OUT).toBeGreaterThanOrEqual(0.3);
    expect(MULT_FADE).toBeGreaterThanOrEqual(0.3);
    const t = { t0: 10, out: -1 };
    expect(tallyOpacity(t, 10, false)).toBe(0);
    expect(tallyOpacity(t, 10.15, false)).toBeCloseTo(0.5);
    expect(tallyOpacity(t, 11, false)).toBe(1);
    expect(tallyOpacity({ t0: 10, out: 11 }, 11.2, false)).toBeCloseTo(0.5);
    expect(tallyOpacity(t, 10, true)).toBe(1);
    expect(tallyOpacity({ t0: 10, out: 11 }, 11, true)).toBe(0);
  });

  it('the kill counter changes at most about 4 times a second (Feel S1)', () => {
    expect(COUNTER_HZ).toBeLessThanOrEqual(4);
  });

  it('crowd kill lines are about zombies, doors and dawn: no people, no "massacre" words (pillar 5)', () => {
    for (const f of CROWD_KILL_LINES) {
      const s = f(47);
      expect(s).toContain('47');
      expect(s).not.toMatch(/neighbour|resident|shopper|commuter|massacre|exterminat|slaughter|body count/i);
    }
  });
});

describe('crowd personal bests', () => {
  const store = () => {
    const m = new Map<string, string>();
    return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
  };
  it('per map fingerprint and crowd size; a higher score is a new best', () => {
    const s = store();
    const b = new CrowdBests(s);
    const big = crowdBestKey('abc123', 'big');
    expect(big).not.toMatch(/Sampleton/);
    expect(b.record(big, { score: 100, kills: 50, shot: 9 }).isNew).toBe(true);
    expect(b.record(big, { score: 90, kills: 60, shot: 20 }).isNew).toBe(false);
    expect(b.record(crowdBestKey('abc123', 'huge'), { score: 50, kills: 50, shot: 9 }).isNew).toBe(true);
    const again = new CrowdBests(s);
    expect(again.get(big)).toEqual({ score: 100, kills: 50, shot: 9 });
  });
  it('a corrupt or blocked store is just empty', () => {
    const bad = new CrowdBests({ getItem: () => '{not json', setItem: () => { throw new Error('blocked'); } });
    expect(bad.get('x|big')).toBeNull();
    expect(bad.record('x|big', { score: 1, kills: 1, shot: 1 }).isNew).toBe(true);
    expect(new CrowdBests(null).get('x')).toBeNull();
  });
});

describe('frame stats (dev readout)', () => {
  it('median fps, the worst whole second and the longest frame', () => {
    const f = new FrameStats();
    for (let i = 0; i < 120; i++) f.add(1000 / 60);
    for (let i = 0; i < 45; i++) f.add(50);
    const s = f.get();
    expect(s.medianFps).toBeCloseTo(60, 0);
    expect(s.worst1sFps).toBeLessThan(40);
    expect(s.maxFrameMs).toBe(50);
  });
});

describe('crowd size default (spec 003 §4)', () => {
  it('tablets and phones (coarse pointer) start on Big, everything else on Huge', () => {
    const g = globalThis as { matchMedia?: unknown };
    const old = g.matchMedia;
    try {
      g.matchMedia = (q: string) => ({ matches: q === '(pointer: coarse)' });
      expect(defaultCrowdSize()).toBe('big');
      g.matchMedia = () => ({ matches: false });
      expect(defaultCrowdSize()).toBe('huge');
      g.matchMedia = undefined;
      expect(defaultCrowdSize()).toBe('huge');
    } finally {
      g.matchMedia = old;
    }
  });
});
