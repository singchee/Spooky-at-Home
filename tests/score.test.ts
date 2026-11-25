import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import { ammoScore, gradeMission, parTime, rank, scoreInput, timeScore, type ScoreInput } from '../src/sim/score';

const clean: ScoreInput = { won: true, type: 'escort', time: 200, par: 220, survivorsTotal: 5, survivorsSaved: 5, friendlyHits: 0, shots: 40, kills: 40, integrity: 1 };
const g = (patch: Partial<ScoreInput>) => gradeMission({ ...clean, ...patch });

describe('mission grades (S/A/B/C/D)', () => {
  it('a quick, clean, accurate escort with everyone home is an S, and the reason says why in one line', () => {
    const s = g({});
    expect(s.grade).toBe('S');
    expect(s.reason).toBe('S: all survivors home, zero friendly fire, quick and accurate');
    expect(s.reason).not.toMatch(/\n/);
  });

  it('the example line: all home, no friendly fire, but slow is an A that says "a bit slow"', () => {
    const s = g({ time: 220 * 1.3 });
    expect(s.grade).toBe('A');
    expect(s.reason).toBe('A: all survivors home, zero friendly fire, a bit slow');
  });

  it('survivors saved weigh the most: losing people costs more than being slow or wasteful', () => {
    const slow = g({ time: 220 * 1.5 }); // as slow as it gets
    const wasteful = g({ shots: 400, kills: 40 }); // 10 rounds per kill
    const lost = g({ survivorsSaved: 3 });
    expect(lost.points).toBeLessThan(slow.points);
    expect(lost.points).toBeLessThan(wasteful.points);
    expect(lost.reason).toContain('3 of 5 home');
  });

  it('friendly fire is a heavy penalty and caps the grade at B', () => {
    const s = g({ friendlyHits: 1 });
    expect(s.grade).toBe('B');
    expect(s.reason).toContain('one friendly-fire incident');
    expect(rank(g({ friendlyHits: 1, time: 220 * 1.4 }).grade)).toBeGreaterThan(rank('B'));
  });

  it('a perfect score with someone lost is still not an S', () => {
    const s = g({ survivorsTotal: 6, survivorsSaved: 5, time: 10, shots: 1, kills: 50 });
    expect(s.points).toBeGreaterThanOrEqual(90);
    expect(s.grade).toBe('A');
  });

  it('a lost mission is always D, and says it failed', () => {
    const s = g({ won: false, survivorsSaved: 1 });
    expect(s.grade).toBe('D');
    expect(s.reason).toBe('D: mission failed, 1 of 5 home, zero friendly fire');
  });

  it('never gets worse for saving more people, and never better for more friendly fire', () => {
    for (let saved = 0; saved < 5; saved++) expect(g({ survivorsSaved: saved + 1 }).points).toBeGreaterThanOrEqual(g({ survivorsSaved: saved }).points);
    expect(g({ friendlyHits: 1 }).points).toBeLessThan(g({}).points);
  });

  it('clear and defend missions describe their own stakes', () => {
    expect(g({ type: 'clear', survivorsTotal: 2, survivorsSaved: 2 }).reason).toMatch(/^S: both friendlies safe, zero friendly fire/);
    expect(g({ type: 'clear', survivorsTotal: 2, survivorsSaved: 1 }).reason).toContain('1 of 2 friendlies lost');
    // Defend: the hold time is fixed, so time never counts; the safehouse does.
    const held = g({ type: 'defend', survivorsTotal: 0, survivorsSaved: 0, time: 999, par: 195 });
    expect(held.grade).toBe('S');
    expect(held.reason).toBe('S: safehouse untouched, zero friendly fire, accurate shooting');
    const battered = g({ type: 'defend', survivorsTotal: 2, survivorsSaved: 2, integrity: 0.4 });
    expect(rank(battered.grade)).toBeGreaterThan(rank('A'));
    expect(battered.reason).toContain('safehouse 40% intact, stragglers safe');
  });

  it('time and rounds per kill score from 1 down to 0', () => {
    expect(timeScore(100, 100)).toBe(1);
    expect(timeScore(150, 100)).toBe(0);
    expect(timeScore(125, 100)).toBeCloseTo(0.5);
    expect(ammoScore(0, 0)).toBe(1);
    expect(ammoScore(15, 10)).toBe(1);
    expect(ammoScore(60, 10)).toBe(0);
  });

  it('is a pure function: the same result always earns the same grade', () => {
    expect(JSON.stringify(g({ time: 260 }))).toBe(JSON.stringify(g({ time: 260 })));
  });

  it('grades real games: a capable gunner earns a high grade, and doing nothing earns a D', () => {
    const map = makeSampleTown();
    for (const type of ['clear', 'escort', 'defend'] as const) {
      const r = createSim(map, { type, difficulty: 1, seed: 2 });
      if (!r.ok) throw new Error(r.reason);
      const bot = new Bot(r.sim, SKILL.human);
      while (r.sim.phase === 'running' && r.sim.t < 900) {
        bot.step(1 / 30);
        r.sim.step(1 / 30);
      }
      const s = gradeMission(scoreInput(r.sim.mission, r.sim.state()));
      expect(rank(s.grade), `${type}: ${s.reason}`).toBeLessThanOrEqual(rank('A'));
      expect(parTime(r.sim.mission)).toBeGreaterThan(0);

      const idle = createSim(map, { type, difficulty: 3, seed: 2 });
      if (!idle.ok) throw new Error(idle.reason);
      while (idle.sim.phase === 'running' && idle.sim.t < 900) idle.sim.step(1 / 30);
      expect(gradeMission(scoreInput(idle.sim.mission, idle.sim.state())).grade, type).toBe('D');
    }
  }, 120_000);
});
