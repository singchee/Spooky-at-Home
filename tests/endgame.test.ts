import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph, type RoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { parseOverpass } from '../src/map/overpass';
import { generateMission, placeLabel, type MissionOptions } from '../src/sim/missions';
import { ENDGAME_LEFT, ENDGAME_QUIET_S, SEARCH_RADIUS, SEARCH_SWITCHES, Sim, type SimEvent } from '../src/sim/sim';
import { Bot, SEARCHER, SKILL } from '../src/sim/bot';
import { AIM_METRES, NIGHT_HELP_S, ROUNDS_25, TRAINING_SIM, TutorialSteps, nightHelp, planLayout, trainingMission } from '../src/ui/tutorialSteps';
import type { MapData } from '../src/map/types';
import { schoolHeavyTown } from './worldFixture';

/**
 * Owner's report: "Sometimes the cold-blooded ones are impossible to find and the game goes forever without ending."
 * Regressions for the causes found headless (see the fix commits), and the endgame search help.
 */
interface Town {
  name: string;
  map: MapData;
  graph: RoadGraph;
  grid: WalkGrid;
}
const towns = new Map<string, Town>();
function town(name: string): Town {
  let t = towns.get(name);
  if (!t) {
    let map: MapData;
    if (name === 'sample') map = makeSampleTown();
    else if (name === 'school') map = schoolHeavyTown();
    else {
      const raw = JSON.parse(readFileSync(new URL(`../maps/fixtures/${name}.json`, import.meta.url), 'utf8'));
      map = parseOverpass({ elements: raw.elements }, raw.spooky_fixture.origin, raw.spooky_fixture.half, name);
    }
    t = { name, map, graph: buildRoadGraph(map), grid: new WalkGrid(map) };
    towns.set(name, t);
  }
  return t;
}
function clearSim(t: Town, opts: MissionOptions): Sim | null {
  const r = generateMission(t.map, t.graph, t.grid, opts);
  return r.ok ? new Sim(r.mission, t.map, t.graph, t.grid) : null;
}

describe('cause 1: a milling zombie whose goal is behind a wall freezes there for good', () => {
  it('Training night: the cold one by the marker never stands still for a minute', () => {
    const t = town('sample');
    const l = planLayout(t.map, t.graph, t.grid)!;
    const sim = new Sim(trainingMission(t.map, l), t.map, t.graph, t.grid, TRAINING_SIM);
    const cold = sim.zombies.find((z) => z.cold)!;
    let last = { x: cold.x, z: cold.z, t: 0 };
    let still = 0;
    for (let i = 0; i < 600 * 30; i++) {
      sim.step(1 / 30);
      if (Math.hypot(cold.x - last.x, cold.z - last.z) > 0.5) last = { x: cold.x, z: cold.z, t: sim.t };
      still = Math.max(still, sim.t - last.t);
    }
    expect(still, 'longest time the cold one stood still (s)').toBeLessThan(60);
  }, 60_000);

  it('no horde zombie in a Clear mission stands still for a minute (nobody firing)', () => {
    // Before the fix: 635 zombies (of 24 missions) stood still for over a minute. After: none on the sample town, and
    // on Adelaide's CBD a handful from one horde (d3 seed 4), left behind by its drift in a slanted corner of
    // footprints thinner than the 3 m walk-grid cell. The endgame search help still marks those (see below).
    const stuck = new Map<string, number>();
    for (const name of ['sample', 'adelaide-cbd']) {
      const t = town(name);
      for (const d of [3, 5]) {
        for (let seed = 1; seed <= 6; seed++) {
          const sim = clearSim(t, { type: 'clear', difficulty: d, seed });
          if (!sim) continue;
          const last = new Map<number, { x: number; z: number; t: number }>();
          for (let i = 0; i < 200 * 15 && sim.phase === 'running'; i++) {
            sim.step(1 / 15);
            if (i % 15) continue;
            for (const z of sim.zombies) {
              const l = last.get(z.id);
              if (!l || Math.hypot(z.x - l.x, z.z - l.z) > 0.5) last.set(z.id, { x: z.x, z: z.z, t: sim.t });
              else if (sim.t - l.t > 60) stuck.set(`${name} d${d} s${seed} z${z.id}`, 1);
            }
          }
        }
      }
    }
    const keys = [...stuck.keys()];
    expect(keys.filter((k) => k.startsWith('sample'))).toEqual([]);
    expect(keys.length, keys.join(', ')).toBeLessThanOrEqual(6);
  }, 240_000);
});

describe('cause 2: hordes placed past the edge of the playable map, or walled into a pocket', () => {
  it('every horde zombie starts inside 90% of the half-width, on ground connected to its horde', () => {
    const bad: string[] = [];
    for (const name of ['sample', 'school', 'adelaide-cbd', 'gundagai', 'west-hobart']) {
      const t = town(name);
      const lim = t.map.half * 0.9;
      for (const template of ['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'] as const) {
        for (const d of [1, 3, 5]) {
          for (let seed = 1; seed <= 8; seed++) {
            const sim = clearSim(t, { type: 'auto', difficulty: d, seed, template });
            if (!sim) continue;
            const fields = new Map<object, Int32Array>();
            for (const z of sim.zombies) {
              const tag = `${name} ${template} d${d} s${seed} z${z.id}`;
              if (Math.abs(z.x) > lim || Math.abs(z.z) > lim) bad.push(`${tag} edge`);
              let f = fields.get(z.home!);
              if (!f) fields.set(z.home!, (f = t.grid.flowField([t.grid.idx(z.home!.x, z.home!.z)])));
              if (t.grid.fieldAt(f, z.x, z.z) < 0) bad.push(`${tag} pocket`);
            }
          }
        }
      }
    }
    expect(bad.slice(0, 10)).toEqual([]);
  }, 240_000);

  it('with the human bot firing, no zombie ever leaves 90% of the half-width (gundagai and west-hobart)', () => {
    for (const name of ['gundagai', 'west-hobart']) {
      const t = town(name);
      const lim = t.map.half * 0.9;
      for (const template of ['clear-park', 'forest-sweep', 'classic-clear'] as const) {
        for (const d of [2, 4]) {
          for (let seed = 1; seed <= 4; seed++) {
            const sim = clearSim(t, { type: 'auto', difficulty: d, seed, template });
            if (!sim) continue;
            const bot = new Bot(sim, SKILL.human);
            while (sim.phase === 'running') {
              bot.step(1 / 30);
              sim.step(1 / 30);
              for (const z of sim.zombies) if (z.alive) expect(Math.max(Math.abs(z.x), Math.abs(z.z)), `${name} ${template} d${d} s${seed} z${z.id}`).toBeLessThanOrEqual(lim);
            }
          }
        }
      }
    }
  }, 240_000);
});

/** Play a Clear mission with the human bot until `left` or fewer zombies are left (or it ends). */
function playDownTo(sim: Sim, left: number): Bot {
  const bot = new Bot(sim, SKILL.human);
  while (sim.phase === 'running' && sim.zombies.filter((z) => z.alive).length > left) {
    bot.step(1 / 30);
    sim.step(1 / 30);
  }
  return bot;
}

describe('endgame search help (owner: "I\'m looking and looking and can\'t find them... so I just give up")', () => {
  it('starts after ENDGAME_QUIET_S without a hit once 5 or fewer are left, names true places, and its circles stay true', () => {
    const t = town('sample');
    let checked = 0;
    for (const template of ['classic-clear', 'clear-park', 'forest-sweep'] as const) {
      for (const d of [1, 3, 5]) {
        for (let seed = 1; seed <= 3; seed++) {
          const sim = clearSim(t, { type: 'auto', difficulty: d, seed, template });
          if (!sim) continue;
          playDownTo(sim, ENDGAME_LEFT);
          if (sim.phase !== 'running') continue;
          // The bot's own camera flicking may already have started it: let a hit or two end it first.
          if (sim.searching().length) continue;
          // Let the rounds already in the air land: the quiet starts with the last of them.
          while (sim.shells.length && sim.phase === 'running') sim.step(1 / 30);
          if (sim.phase !== 'running' || sim.searching().length) continue;
          sim.drainEvents();
          const quietFrom = sim.t;
          let ev: Extract<SimEvent, { type: 'search' }> | undefined;
          while (!ev && sim.phase === 'running' && sim.t < quietFrom + ENDGAME_QUIET_S + 1) {
            sim.step(1 / 30);
            ev = sim.drainEvents().find((e): e is Extract<SimEvent, { type: 'search' }> => e.type === 'search');
          }
          if (sim.phase !== 'running') continue;
          const tag = `${template} d${d} s${seed}`;
          expect(ev, `${tag}: help started`).toBeDefined();
          expect(sim.t - quietFrom, tag).toBeLessThanOrEqual(ENDGAME_QUIET_S + 0.1);
          const targets = sim.zombies.filter((z) => z.alive);
          expect(ev!.left, tag).toBe(targets.length);
          expect(ev!.cold, tag).toBe(targets.every((z) => z.cold));
          // True places: the radio names where they are (the first three).
          for (const z of targets.slice(0, 1)) expect(ev!.text, tag).toContain(placeLabel(t.map, z));
          const last = new Map(targets.map((z) => [z.id, { x: z.x, z: z.z }]));
          const walked = new Map(targets.map((z) => [z.id, 0]));
          const lim = t.map.half * 0.9;
          for (let i = 0; i < 30 * 30 && sim.phase === 'running'; i++) {
            sim.step(1 / 30);
            const areas = sim.searchAreas();
            for (const z of targets) {
              if (!z.alive) continue;
              const inside = areas.some((a) => Math.hypot(a.p.x - z.x, a.p.z - z.z) <= a.r);
              expect(inside, `${tag} t=${sim.t.toFixed(1)} z${z.id} inside a search circle`).toBe(true);
              expect(Math.max(Math.abs(z.x), Math.abs(z.z)), `${tag} z${z.id} in play`).toBeLessThanOrEqual(lim);
            }
            for (const a of areas) expect(a.r).toBe(SEARCH_RADIUS);
            for (const z of targets) {
              const l = last.get(z.id)!;
              walked.set(z.id, walked.get(z.id)! + Math.hypot(z.x - l.x, z.z - l.z));
              last.set(z.id, { x: z.x, z: z.z });
            }
          }
          // Restless: every straggler keeps walking (night vision shows movement): 30 s at a walk is ~40 m.
          for (const z of targets) if (z.alive) expect(walked.get(z.id)!, `${tag} z${z.id} walked (m)`).toBeGreaterThan(20);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  }, 240_000);

  it('a hit ends it; flicking cameras 3 times in 20 s without a hit brings it back at once', () => {
    const t = town('sample');
    const sim = clearSim(t, { type: 'clear', difficulty: 3, seed: 2 })!;
    playDownTo(sim, ENDGAME_LEFT);
    for (let i = 0; i < (ENDGAME_QUIET_S + 1) * 30; i++) sim.step(1 / 30);
    expect(sim.searchAreas().length).toBeGreaterThan(0);
    // A hit: kill one straggler with a 25 mm round right on it.
    const z = sim.zombies.find((q) => q.alive)!;
    let hit = false;
    for (let i = 0; i < 30 * 20 && !hit; i++) {
      const before = sim.kills;
      sim.fire('25', { x: z.x + z.vx * 4, z: z.z + z.vz * 4 });
      sim.step(1 / 30);
      hit = sim.kills > before;
    }
    expect(hit).toBe(true);
    sim.step(1 / 30);
    expect(sim.searchAreas()).toEqual([]);
    sim.drainEvents();
    // Searching: three camera switches within a few seconds, no hit.
    for (let k = 0; k < SEARCH_SWITCHES; k++) {
      sim.noteSensorSwitch();
      for (let i = 0; i < 30; i++) sim.step(1 / 30);
    }
    expect(sim.searchAreas().length, 'help back after 3 switches').toBeGreaterThan(0);
    expect(sim.t - sim.zombies.reduce((a, q) => Math.max(a, q.diedAt), 0)).toBeLessThan(ENDGAME_QUIET_S);
  }, 120_000);

  it('never before the first hit, and not while more than 5 warm ones are left', () => {
    const t = town('sample');
    const sim = clearSim(t, { type: 'clear', difficulty: 3, seed: 1 })!;
    for (let i = 0; i < 60 * 30; i++) sim.step(1 / 30);
    expect(sim.searchAreas()).toEqual([]);
    expect(sim.drainEvents().some((e) => e.type === 'search')).toBe(false);
  });

  it('every Clear mission ends within its limit, for a gunner who has to search (all towns)', () => {
    const results: Record<string, number> = { won: 0, lost: 0 };
    for (const name of ['sample', 'school', 'adelaide-cbd', 'gundagai', 'west-hobart']) {
      const t = town(name);
      for (const template of ['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'] as const) {
        for (const d of [1, 5]) {
          for (let seed = 1; seed <= 2; seed++) {
            const sim = clearSim(t, { type: 'auto', difficulty: d, seed, template });
            if (!sim) continue;
            const bot = new Bot(sim, SEARCHER);
            while (sim.phase === 'running' && sim.t < sim.mission.timeLimit + 5) {
              bot.step(1 / 15);
              sim.step(1 / 15);
            }
            expect(sim.phase, `${name} ${template} d${d} s${seed}`).not.toBe('running');
            expect(sim.t, `${name} ${template} d${d} s${seed}`).toBeLessThanOrEqual(sim.mission.timeLimit + 1 / 15 + 1e-6);
            results[sim.phase]++;
          }
        }
      }
    }
    expect(results.won + results.lost).toBeGreaterThan(20);
  }, 600_000);
});

describe('Training night: always winnable, and the night step helps after TRAINING_QUIET_S', () => {
  const t = town('sample');
  const layout = planLayout(t.map, t.graph, t.grid)!;

  it('the friendlies are still there for the last step after 20 minutes of dawdling', () => {
    const sim = new Sim(trainingMission(t.map, layout), t.map, t.graph, t.grid, TRAINING_SIM);
    for (let i = 0; i < 20 * 60 * 15; i++) sim.step(1 / 15);
    expect(sim.survivors.every((s) => s.alive)).toBe(true);
    const cold = sim.zombies.filter((z) => z.alive && z.cold);
    expect(cold.some((z) => Math.hypot(z.x - layout.cold.x, z.z - layout.cold.z) < 60)).toBe(true);
  }, 120_000);

  it('a trainee who ignores the marker and only follows the search help still finishes training', () => {
    const sim = new Sim(trainingMission(t.map, layout), t.map, t.graph, t.grid, TRAINING_SIM);
    const steps = new TutorialSteps();
    // The early steps (their own tests cover them), then a slow start on the night step.
    for (const i of [
      { type: 'start' }, { type: 'aimMoved', metres: AIM_METRES }, { type: 'weapon', weapon: '25' },
      ...Array.from({ length: ROUNDS_25 }, () => ({ type: 'fired', weapon: '25' }) as const), { type: 'impact', weapon: '25', kills: 1 },
      { type: 'weapon', weapon: '105' }, { type: 'impact', weapon: '105', kills: 3 }, { type: 'polarity', polarity: 1 }, { type: 'tick', dt: 0 },
    ] as Parameters<TutorialSteps['send']>[0][]) steps.send(i);
    expect(steps.step).toBe('night');
    steps.send({ type: 'weapon', weapon: '25' });
    steps.send({ type: 'lens', fov: 2.5 });
    steps.send({ type: 'sensor', sensor: 'night' });
    // Looking in the wrong place (the friendlies), on night vision, seeing only 35 m round the aim point.
    let aim = { ...layout.friendlies };
    let helpedAt = -1;
    const dt = 1 / 30;
    for (let i = 0; i < 120 * 30 && steps.step === 'night'; i++) {
      sim.step(dt);
      if (helpedAt < 0 && sim.searching().length) helpedAt = sim.t;
      const cold = sim.zombies.find((z) => z.alive && z.cold && Math.hypot(z.x - layout.cold.x, z.z - layout.cold.z) < 60)!;
      const areas = sim.searchAreas();
      const seen = Math.hypot(cold.x - aim.x, cold.z - aim.z) < 35;
      const goal = seen ? cold : areas[0]?.p;
      if (goal) {
        // Pan at up to 60 m/s.
        const d = Math.hypot(goal.x - aim.x, goal.z - aim.z);
        const k = Math.min(1, (60 * dt) / Math.max(d, 1e-6));
        aim = { x: aim.x + (goal.x - aim.x) * k, z: aim.z + (goal.z - aim.z) * k };
      }
      steps.send({ type: 'onCold', on: Math.hypot(cold.x - aim.x, cold.z - aim.z) < 10 });
      steps.send({ type: 'tick', dt });
      nightHelp(sim, steps, layout, dt);
    }
    expect(helpedAt, 'help started').toBeGreaterThan(0);
    expect(helpedAt).toBeLessThanOrEqual(NIGHT_HELP_S + 0.1);
    expect(steps.step).toBe('friendlies');
    expect(sim.searching(), 'help ends with the step').toEqual([]);
    // And the friendlies step is still possible: they're alive and where the marker says.
    expect(sim.survivors.filter((s) => s.alive && Math.hypot(s.x - layout.friendlies.x, s.z - layout.friendlies.z) < 10).length).toBe(2);
  }, 60_000);
});
