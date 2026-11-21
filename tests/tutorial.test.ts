import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { dist } from '../src/map/geom';
import { Sim } from '../src/sim/sim';
import { AIM_METRES, DANGER_TIME, ROUNDS_25, SPOT_TIME, STEP_ORDER, STEP_TEXT, TutorialSteps, planLayout, trainingMission } from '../src/ui/tutorialSteps';

/** Play the whole tutorial the way a person would. */
function playThrough(t: TutorialSteps): void {
  t.send({ type: 'start' });
  t.send({ type: 'aimMoved', metres: AIM_METRES });
  t.send({ type: 'weapon', weapon: '25' });
  for (let i = 0; i < ROUNDS_25; i++) t.send({ type: 'fired', weapon: '25' });
  t.send({ type: 'weapon', weapon: '105' });
  t.send({ type: 'fired', weapon: '105' });
  t.send({ type: 'impact', weapon: '105', kills: 4 });
  t.send({ type: 'polarity', polarity: 1 });
  t.send({ type: 'sensor', sensor: 'night' });
  t.send({ type: 'onCold', on: true });
  t.send({ type: 'tick', dt: SPOT_TIME + 0.01 });
  t.send({ type: 'danger', on: true });
  t.send({ type: 'tick', dt: DANGER_TIME + 0.01 });
  t.send({ type: 'danger', on: false });
}

describe('TutorialSteps', () => {
  it('starts at the intro and every step has coach text', () => {
    const t = new TutorialSteps();
    expect(t.step).toBe('intro');
    for (const s of STEP_ORDER) expect(STEP_TEXT[s].title.length).toBeGreaterThan(0);
  });

  it('walks through every step in order and finishes', () => {
    const t = new TutorialSteps();
    const seen: string[] = [t.step];
    const orig = t.send.bind(t);
    t.send = (i) => {
      const changed = orig(i);
      if (changed) seen.push(t.step);
      return changed;
    };
    playThrough(t);
    expect(seen).toEqual([...STEP_ORDER]);
    expect(t.done).toBe(true);
  });

  it('ignores inputs that belong to later steps', () => {
    const t = new TutorialSteps();
    t.send({ type: 'aimMoved', metres: 500 });
    t.send({ type: 'fired', weapon: '25' });
    expect(t.step).toBe('intro');
    t.send({ type: 'start' });
    t.send({ type: 'polarity', polarity: 1 });
    t.send({ type: 'sensor', sensor: 'night' });
    expect(t.step).toBe('aim');
  });

  it('look around: needs enough aim movement, with progress along the way', () => {
    const t = new TutorialSteps();
    t.send({ type: 'start' });
    t.send({ type: 'aimMoved', metres: AIM_METRES / 2 });
    expect(t.step).toBe('aim');
    expect(t.progress).toBeCloseTo(0.5);
    t.send({ type: 'aimMoved', metres: -1000 }); // negative movement never counts backwards
    expect(t.progress).toBeCloseTo(0.5);
    t.send({ type: 'aimMoved', metres: AIM_METRES / 2 });
    expect(t.step).toBe('fire25');
  });

  it('fire the 25: only 25 mm rounds count, and a hint says to press 1', () => {
    const t = new TutorialSteps();
    t.send({ type: 'start' });
    t.send({ type: 'aimMoved', metres: AIM_METRES });
    expect(t.hint()).toMatch(/Press 1/);
    for (let i = 0; i < 30; i++) t.send({ type: 'fired', weapon: '40' });
    expect(t.step).toBe('fire25');
    expect(t.hint()).toMatch(/25 mm/);
    t.send({ type: 'weapon', weapon: '25' });
    for (let i = 0; i < ROUNDS_25 - 1; i++) t.send({ type: 'fired', weapon: '25' });
    expect(t.step).toBe('fire25');
    expect(t.note).toBeNull();
    t.send({ type: 'fired', weapon: '25' });
    expect(t.step).toBe('switch');
  });

  it('switch: advances on the 105, and is skipped if the 105 is already selected', () => {
    const t = new TutorialSteps();
    t.send({ type: 'start' });
    t.send({ type: 'aimMoved', metres: AIM_METRES });
    t.send({ type: 'weapon', weapon: '25' });
    for (let i = 0; i < ROUNDS_25; i++) t.send({ type: 'fired', weapon: '25' });
    t.send({ type: 'weapon', weapon: '40' });
    expect(t.step).toBe('switch');
    t.send({ type: 'weapon', weapon: '105' });
    expect(t.step).toBe('fire105');

    const u = new TutorialSteps({ weapon: '105' });
    u.send({ type: 'start' });
    u.send({ type: 'aimMoved', metres: AIM_METRES });
    // Firing the 25 while the tracked weapon is 105 can't happen in the game, but the step logic only
    // looks at the round's own gun, so force it.
    for (let i = 0; i < ROUNDS_25; i++) u.send({ type: 'fired', weapon: '25' });
    expect(u.step).toBe('fire105');
  });

  it('fire the 105: a miss gives a hint, a hit advances', () => {
    const t = new TutorialSteps();
    t.send({ type: 'start' });
    t.send({ type: 'aimMoved', metres: AIM_METRES });
    for (let i = 0; i < ROUNDS_25; i++) t.send({ type: 'fired', weapon: '25' });
    t.send({ type: 'weapon', weapon: '105' });
    t.send({ type: 'impact', weapon: '40', kills: 3 });
    expect(t.step).toBe('fire105');
    t.send({ type: 'impact', weapon: '105', kills: 0 });
    expect(t.step).toBe('fire105');
    expect(t.hint()).toMatch(/Missed/);
    t.send({ type: 'impact', weapon: '105', kills: 2 });
    expect(t.step).toBe('polarity');
    expect(t.note).toBeNull();
  });

  it('night vision: dwell only counts on night vision with the crosshair on the cold one', () => {
    const t = new TutorialSteps();
    playUpTo(t, 'night');
    expect(t.hint()).toMatch(/Press V/);
    t.send({ type: 'onCold', on: true });
    t.send({ type: 'tick', dt: 5 }); // on thermal: doesn't count
    expect(t.step).toBe('night');
    expect(t.progress).toBe(0);
    t.send({ type: 'sensor', sensor: 'night' });
    expect(t.progress).toBe(0.5);
    t.send({ type: 'tick', dt: SPOT_TIME * 0.6 });
    t.send({ type: 'onCold', on: false });
    t.send({ type: 'tick', dt: 0.01 }); // looking away resets the dwell
    t.send({ type: 'onCold', on: true });
    t.send({ type: 'tick', dt: SPOT_TIME * 0.6 });
    expect(t.step).toBe('night');
    t.send({ type: 'tick', dt: SPOT_TIME * 0.6 });
    expect(t.step).toBe('friendlies');
  });

  it('friendlies: must see DANGER CLOSE for a moment, then move off', () => {
    const t = new TutorialSteps();
    playUpTo(t, 'friendlies');
    t.send({ type: 'danger', on: true });
    t.send({ type: 'tick', dt: DANGER_TIME / 2 });
    t.send({ type: 'danger', on: false });
    expect(t.step).toBe('friendlies'); // a glance isn't enough
    t.send({ type: 'tick', dt: 0.1 });
    t.send({ type: 'danger', on: true });
    t.send({ type: 'tick', dt: DANGER_TIME });
    expect(t.step).toBe('friendlies');
    expect(t.hint()).toMatch(/move the crosshair off/);
    t.send({ type: 'danger', on: false });
    expect(t.done).toBe(true);
  });

  it('a friendly hit shows CHECK FIRE but never ends the tutorial', () => {
    const t = new TutorialSteps();
    playUpTo(t, 'friendlies');
    t.send({ type: 'friendlyHit' });
    expect(t.hint()).toMatch(/CHECK FIRE/);
    expect(t.step).toBe('friendlies');
  });

  it('skip jumps to the end from anywhere', () => {
    for (const s of STEP_ORDER) {
      const t = new TutorialSteps();
      playUpTo(t, s);
      t.skip();
      expect(t.done).toBe(true);
    }
  });

  it('time spent between steps is frame-rate independent (many small ticks = one big tick)', () => {
    const a = new TutorialSteps();
    const b = new TutorialSteps();
    playUpTo(a, 'friendlies');
    playUpTo(b, 'friendlies');
    a.send({ type: 'danger', on: true });
    b.send({ type: 'danger', on: true });
    for (let i = 0; i < 120; i++) a.send({ type: 'tick', dt: DANGER_TIME / 100 });
    b.send({ type: 'tick', dt: DANGER_TIME * 1.2 });
    a.send({ type: 'danger', on: false });
    b.send({ type: 'danger', on: false });
    expect(a.done).toBe(true);
    expect(b.done).toBe(true);
  });
});

describe('training ground on the sample town', () => {
  const map = makeSampleTown();
  const graph = buildRoadGraph(map);
  const grid = new WalkGrid(map);
  const layout = planLayout(map, graph, grid)!;

  it('finds four separate, walkable spots near the middle', () => {
    expect(layout).not.toBeNull();
    const spots = [layout.scattered, layout.crowd, layout.cold, layout.friendlies];
    for (const s of spots) {
      expect(grid.isBlocked(s.x, s.z)).toBe(false);
      expect(dist(s, layout.centre)).toBeLessThan(260);
    }
    for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) expect(dist(spots[i], spots[j])).toBeGreaterThanOrEqual(75);
    // The guns can never reach the reserve agents (aim is clamped to the map; the 105's reach is ~30 m).
    expect(Math.min(layout.reserve.x, layout.reserve.z)).toBeGreaterThan(map.half + 100);
  });

  it('is deterministic', () => {
    expect(planLayout(map, graph, grid)).toEqual(layout);
  });

  it('never ends by itself, even if the player clears every reachable zombie or shells the friendlies', () => {
    const sim = new Sim(trainingMission(map, layout), map, graph, grid);
    const cold = sim.zombies.filter((z) => z.cold);
    expect(cold.length).toBe(1);
    expect(dist(cold[0], layout.cold)).toBeLessThan(40);
    // Kill everything reachable, and both visible friendlies.
    for (const z of sim.zombies) if (Math.abs(z.x) < map.half) z.alive = false;
    for (const s of sim.survivors) if (Math.abs(s.x) < map.half) s.alive = false;
    for (let i = 0; i < 60 * 120; i++) sim.step(1 / 60);
    expect(sim.phase).toBe('running');
  });

  it('keeps the zombies away from the friendlies on their own', () => {
    const sim = new Sim(trainingMission(map, layout), map, graph, grid);
    for (let i = 0; i < 60 * 180; i++) sim.step(1 / 60);
    expect(sim.survivors.every((s) => s.alive)).toBe(true);
    expect(sim.phase).toBe('running');
  });
});

function playUpTo(t: TutorialSteps, target: string): void {
  const inputs: Parameters<TutorialSteps['send']>[0][] = [
    { type: 'start' },
    { type: 'aimMoved', metres: AIM_METRES },
    { type: 'weapon', weapon: '25' },
    ...Array.from({ length: ROUNDS_25 }, () => ({ type: 'fired', weapon: '25' }) as const),
    { type: 'weapon', weapon: '105' },
    { type: 'impact', weapon: '105', kills: 3 },
    { type: 'polarity', polarity: 1 },
    { type: 'tick', dt: 0 },
  ];
  for (const i of inputs) {
    if (t.step === target) return;
    t.send(i);
  }
  if (t.step !== target) {
    t.send({ type: 'sensor', sensor: 'night' });
    t.send({ type: 'onCold', on: true });
    t.send({ type: 'tick', dt: SPOT_TIME + 0.01 });
    t.send({ type: 'sensor', sensor: 'thermal' });
    t.send({ type: 'onCold', on: false });
  }
  if (t.step !== target && target === 'done') {
    t.send({ type: 'danger', on: true });
    t.send({ type: 'tick', dt: DANGER_TIME + 0.01 });
    t.send({ type: 'danger', on: false });
  }
  expect(t.step).toBe(target);
}
