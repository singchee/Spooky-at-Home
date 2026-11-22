import { mkdirSync, writeFileSync } from 'node:fs';
import { describe, it } from 'vitest';
import { makeSampleTown } from '../../src/map/sample';
import { buildRoadGraph } from '../../src/map/roadGraph';
import { WalkGrid } from '../../src/map/grid';
import { generateMission, type MissionOptions } from '../../src/sim/missions';
import { Sim } from '../../src/sim/sim';
import { Bot, SKILL, type BotSkill } from '../../src/sim/bot';

/**
 * Balance runner, skipped by default. Run: BALANCE=1 npx vitest run tests/balance
 * Prints a table of bot win rates and mission lengths per mission x difficulty, and for Clear the share of kills
 * by each gun (spec 002). Env: SEEDS (12), SKILL (human | ace | only105 | none), SCATTER=0 (Clear without
 * scatter, for before/after), ONLY (comma list of rows to run, e.g. "clear-park,forest-sweep"), OUT (file).
 * Escort and Hold rows are the same as before spec 002 (same seeds, same step).
 */
const run = process.env.BALANCE ? describe : describe.skip;
const SEEDS = Number(process.env.SEEDS ?? 12);
const ROWS: { name: string; opts: (d: number, seed: number) => MissionOptions }[] = [
  ...(['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'] as const).map((template) => ({
    name: template,
    opts: (difficulty: number, seed: number): MissionOptions => ({ type: 'auto', difficulty, seed, template }),
  })),
  { name: 'escort', opts: (difficulty, seed) => ({ type: 'escort', difficulty, seed }) },
  { name: 'defend', opts: (difficulty, seed) => ({ type: 'defend', difficulty, seed }) },
];

run('balance', () => {
  it('bot results across seeds', () => {
    const map = makeSampleTown();
    const graph = buildRoadGraph(map);
    const grid = new WalkGrid(map);
    const skillName = process.env.SKILL ?? 'human';
    const skill: BotSkill | null = skillName === 'none' ? null : skillName === 'only105' ? { ...SKILL.human, guns: ['105'] } : SKILL[skillName as 'ace' | 'human'];
    const scatter = process.env.SCATTER !== '0';
    const only = process.env.ONLY?.split(',');
    const rows: string[] = [
      `bot skill: ${skillName}, seeds: ${SEEDS}, scatter: ${scatter ? 'on' : 'off'}`,
      'mission        d  win%  medianLen  lostSurv  ffHits  failures   k105   k40   k25  40+25%',
    ];
    for (const row of ROWS) {
      if (only && !only.includes(row.name)) continue;
      for (let d = 1; d <= 5; d++) {
        let wins = 0;
        const lens: number[] = [];
        let lost = 0;
        let ff = 0;
        let fails = 0;
        const kills: Record<string, number> = { '105': 0, '40': 0, '25': 0 };
        for (let seed = 1; seed <= SEEDS; seed++) {
          const r = generateMission(map, graph, grid, row.opts(d, seed));
          if (!r.ok) { fails++; continue; }
          const sim = new Sim(r.mission, map, graph, grid, { scatter: scatter && r.mission.type === 'clear' });
          const bot = skill ? new Bot(sim, skill) : null;
          while (sim.phase === 'running' && sim.t < 900) {
            bot?.step(1 / 60);
            sim.step(1 / 60);
            for (const e of sim.drainEvents()) if (e.type === 'impact') kills[e.weapon] += e.kills;
          }
          if (sim.phase === 'won') wins++;
          lens.push(sim.t);
          lost += sim.survivors.filter((s) => !s.alive).length;
          ff += sim.friendlyHits;
        }
        lens.sort((a, b) => a - b);
        const all = kills['105'] + kills['40'] + kills['25'];
        const small = all ? Math.round(((kills['40'] + kills['25']) / all) * 100) : 0;
        rows.push(
          `${row.name.padEnd(13)} ${d}  ${String(Math.round((wins / SEEDS) * 100)).padStart(4)}  ${String(Math.round(lens[lens.length >> 1] ?? 0)).padStart(9)}  ${String(lost).padStart(8)}  ${String(ff).padStart(6)}  ${String(fails).padStart(8)}  ${String(kills['105']).padStart(5)} ${String(kills['40']).padStart(5)} ${String(kills['25']).padStart(5)}  ${String(small).padStart(6)}`,
        );
      }
    }
    mkdirSync('reports', { recursive: true });
    writeFileSync(process.env.OUT ?? 'reports/balance-latest.txt', rows.join('\n') + '\n');
  }, 3_600_000);
});
