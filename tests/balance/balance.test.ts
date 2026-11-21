import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { makeSampleTown } from '../../src/map/sample';
import { createSim } from '../../src/sim/setup';
import { Bot, SKILL } from '../../src/sim/bot';
import { MISSION_TYPES } from '../../src/sim/missions';

/**
 * Balance runner, skipped by default. Run: BALANCE=1 npx vitest run tests/balance
 * Prints a table of bot win rates and mission lengths per type x difficulty.
 */
const run = process.env.BALANCE ? describe : describe.skip;
const SEEDS = Number(process.env.SEEDS ?? 12);

run('balance', () => {
  it('bot results across seeds', () => {
    const map = makeSampleTown();
    const rows: string[] = [`bot skill: ${process.env.SKILL ?? 'human'}, seeds: ${SEEDS}`, 'type     d  win%  medianLen  lostSurv  ffHits  failures'];
    for (const type of MISSION_TYPES) {
      for (let d = 1; d <= 5; d++) {
        let wins = 0;
        const lens: number[] = [];
        let lost = 0;
        let ff = 0;
        let fails = 0;
        for (let seed = 1; seed <= SEEDS; seed++) {
          const r = createSim(map, { type, difficulty: d, seed });
          if (!r.ok) { fails++; continue; }
          const sim = r.sim;
          const bot = new Bot(sim, SKILL[(process.env.SKILL as 'ace' | 'human') ?? 'human']);
          while (sim.phase === 'running' && sim.t < 900) { bot.step(1 / 30); sim.step(1 / 30); }
          if (sim.phase === 'won') wins++;
          lens.push(sim.t);
          lost += sim.survivors.filter((s) => !s.alive).length;
          ff += sim.friendlyHits;
        }
        lens.sort((a, b) => a - b);
        rows.push(`${type.padEnd(8)} ${d}  ${String(Math.round((wins / SEEDS) * 100)).padStart(4)}  ${String(Math.round(lens[lens.length >> 1] ?? 0)).padStart(9)}  ${String(lost).padStart(8)}  ${String(ff).padStart(6)}  ${fails}`);
      }
    }
    mkdirSync('reports', { recursive: true });
    writeFileSync('reports/balance-latest.txt', rows.join('\n') + '\n');
  }, 600_000);
});
