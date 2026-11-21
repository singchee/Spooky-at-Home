import { makeSampleTown } from '../map/sample';
import { buildRoadGraph } from '../map/roadGraph';
import { WalkGrid } from '../map/grid';
import type { V2 } from '../map/types';
import { dist } from '../map/geom';
import { Sim } from '../sim/sim';
import { weaponById } from '../sim/weapons';
import { mulberry32 } from '../util/rng';
import { Game, type GameAction } from '../game/game';
import { STEP_TEXT, TutorialSteps, planLayout, trainingMission, type StepId, type TrainingLayout } from './tutorialSteps';
import { el } from './dom';

/**
 * "Training night": a guided first sortie on the sample town. The Game runs as normal; a coach card
 * tells the player what to do next, and TutorialSteps decides when each step is done.
 */
export type TutorialExit = 'menu' | 'scout' | 'landing' | 'restart';

const DONE_KEY = 'spooky.training';

export function trainingDone(): boolean {
  try {
    return localStorage.getItem(DONE_KEY) === 'done';
  } catch {
    return false;
  }
}

function remember(): void {
  try {
    localStorage.setItem(DONE_KEY, 'done');
  } catch {
    /* private mode or blocked storage: fine, we just forget */
  }
}

export interface TutorialHandle {
  game: Game;
  steps: TutorialSteps;
  dispose(): void;
}

/** Which marker each step shows, and what it says. */
const MARKS: Partial<Record<StepId, { at: keyof TrainingLayout; label: string }>> = {
  aim: { at: 'scattered', label: 'CONTACTS' },
  fire25: { at: 'scattered', label: 'CONTACTS' },
  switch: { at: 'crowd', label: 'CROWD' },
  fire105: { at: 'crowd', label: 'CROWD' },
  night: { at: 'cold', label: 'CHECK HERE' },
  friendlies: { at: 'friendlies', label: 'FRIENDLIES' },
};

/** Keep each step's targets stocked, so the player can't run out of zombies to practise on. */
const STOCK: Partial<Record<StepId, { at: keyof TrainingLayout; n: number; cold: boolean }>> = {
  aim: { at: 'scattered', n: 4, cold: false },
  fire25: { at: 'scattered', n: 3, cold: false },
  switch: { at: 'crowd', n: 9, cold: false },
  fire105: { at: 'crowd', n: 9, cold: false },
  night: { at: 'cold', n: 1, cold: true },
};

export function startTutorial(parent: HTMLElement, onExit: (to: TutorialExit) => void): TutorialHandle {
  const map = makeSampleTown();
  const graph = buildRoadGraph(map);
  const grid = new WalkGrid(map);
  const layout = planLayout(map, graph, grid);
  if (!layout) throw new Error('no room for the training ground');
  const sim = new Sim(trainingMission(map, layout), map, graph, grid);
  const steps = new TutorialSteps();
  const rng = mulberry32(0x7a11);
  let exited = false;
  const exit = (to: TutorialExit) => {
    if (exited) return;
    exited = true;
    onExit(to);
  };

  const revive: { at: number; id: number }[] = [];
  let clock = 0;
  const onAction = (a: GameAction) => {
    if (a.type === 'weapon') steps.send({ type: 'weapon', weapon: a.weapon });
    else if (a.type === 'sensor') steps.send({ type: 'sensor', sensor: a.sensor });
    else if (a.type === 'polarity') steps.send({ type: 'polarity', polarity: a.polarity });
    else {
      const e = a.event;
      if (e.type === 'fire') steps.send({ type: 'fired', weapon: e.weapon });
      if (e.type === 'impact') steps.send({ type: 'impact', weapon: e.weapon, kills: e.kills });
      if (e.type === 'friendly-hit') {
        steps.send({ type: 'friendlyHit' });
        const s = sim.survivors.find((f) => !f.alive && Math.hypot(f.x - e.x, f.z - e.z) < 0.5);
        if (s) revive.push({ at: clock + 2.5, id: s.id });
      }
    }
    draw();
  };

  const game = new Game(parent, map, sim, {
    skipBriefing: true,
    onRetry: () => exit('restart'),
    onNext: () => exit('menu'),
    onMenu: () => exit('menu'),
    onAction,
  });
  steps.weapon = game.weaponId;
  steps.sensor = game.sensor;

  // ---------- coach card ----------
  const coach = el('div', 'coach', undefined, parent);
  coach.setAttribute('role', 'status');
  coach.setAttribute('aria-live', 'polite');
  const kicker = el('div', 'coach-kicker', undefined, coach);
  const title = el('h2', 'coach-title', undefined, coach);
  const body = el('p', 'coach-body', undefined, coach);
  const hint = el('p', 'coach-hint', undefined, coach);
  const bar = el('div', 'coach-bar', undefined, coach);
  const fill = el('span', undefined, undefined, bar);
  const row = el('div', 'coach-row', undefined, coach);
  const marker = el('div', 'coach-marker', undefined, parent);
  marker.setAttribute('aria-hidden', 'true');

  let shown: StepId | null = null;
  const draw = () => {
    if (steps.step !== shown) {
      shown = steps.step;
      const t = STEP_TEXT[steps.step];
      coach.dataset.step = steps.step;
      title.textContent = t.title;
      body.textContent = t.body;
      row.replaceChildren();
      if (steps.step === 'intro') {
        kicker.textContent = 'TRAINING NIGHT · SAMPLE TOWN';
        const go = el('button', 'primary', 'Start training', row);
        go.addEventListener('click', () => {
          steps.send({ type: 'start' });
          game.lockPointer();
          draw();
        });
        el('button', 'coach-skip', 'Skip tutorial', row).addEventListener('click', skip);
        go.focus({ preventScroll: true });
      } else if (steps.step === 'done') {
        kicker.textContent = 'TRAINING NIGHT · COMPLETE';
        remember();
        el('button', 'primary', 'Scout my neighbourhood', row).addEventListener('click', () => exit('scout'));
        el('button', undefined, 'Fly a mission', row).addEventListener('click', () => exit('menu'));
        el('button', undefined, 'Front page', row).addEventListener('click', () => exit('landing'));
        el('p', 'coach-small', 'Press Esc to free the mouse. Or stay and keep practising.', coach);
      } else {
        kicker.textContent = `TRAINING NIGHT · STEP ${steps.index} OF ${TutorialSteps.TEACHING_STEPS}`;
        el('button', 'coach-skip', 'Skip tutorial', row).addEventListener('click', skip);
      }
    }
    const h = steps.hint();
    hint.textContent = h ?? '';
    hint.classList.toggle('alarm', !!h && h.startsWith('CHECK FIRE'));
    bar.style.display = steps.step === 'intro' || steps.step === 'done' ? 'none' : '';
    fill.style.width = `${Math.round(steps.progress * 100)}%`;
  };
  const skip = () => {
    steps.skip();
    remember();
    exit('menu');
  };
  draw();

  // ---------- per-frame checks (own loop, dt-scaled) ----------
  let lastAim: V2 = game.aimPoint();
  let last = performance.now();
  let raf = 0;
  let stockWait = 0;
  let wasLocked = false;
  const tick = (now: number) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (game.screen !== 'playing') return;
    clock += dt;
    const aim = game.aimPoint();
    const moved = dist(aim, lastAim);
    lastAim = aim;
    // Grabbing the pointer by clicking the picture counts as "start".
    const locked = !!document.pointerLockElement;
    if (locked && !wasLocked && steps.step === 'intro') steps.send({ type: 'start' });
    wasLocked = locked;
    if (moved > 0) steps.send({ type: 'aimMoved', metres: moved });

    const live = sim.zombies.filter((z) => z.alive && Math.abs(z.x) < map.half);
    steps.send({ type: 'onCold', on: live.some((z) => z.cold && dist(z, aim) < 22) });
    const r = weaponById(game.weaponId).radius * 1.6 + 4; // same rule as the HUD's DANGER CLOSE
    steps.send({ type: 'danger', on: sim.survivors.some((s) => s.alive && !s.home && dist(s, aim) < r) });
    steps.send({ type: 'tick', dt });

    // Friendlies hit in training get patched up after a moment.
    for (let i = revive.length - 1; i >= 0; i--) {
      if (clock < revive[i].at) continue;
      const s = sim.survivors[revive[i].id];
      if (s) Object.assign(s, { alive: true, hp: 1, diedAt: -1 });
      revive.splice(i, 1);
    }

    // Restock this step's targets (after a short pause, so they don't pop up mid-blast).
    const need = STOCK[steps.step];
    const centre = need ? layout[need.at] : null;
    if (need && centre) {
      const have = live.filter((z) => z.cold === need.cold && dist(z, centre) < 60).length;
      stockWait = have < need.n ? stockWait + dt : 0;
      if (stockWait > 2) {
        stockWait = 0;
        for (let k = have; k < need.n + (need.cold ? 0 : 3); k++) spawn(sim, grid, centre, need.cold, rng);
      }
    }

    // Step marker.
    const mk = MARKS[steps.step];
    const p = mk ? game.screenPos(layout[mk.at] as V2) : null;
    marker.style.display = p?.visible ? 'block' : 'none';
    if (mk && p) {
      marker.textContent = mk.label;
      marker.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
    }
    draw();
  };
  raf = requestAnimationFrame(tick);

  return {
    game,
    steps,
    dispose: () => {
      cancelAnimationFrame(raf);
      game.dispose();
      coach.remove();
      marker.remove();
    },
  };
}

/** Add one zombie near a spot (the sim's own arrays are public; this is training-only plumbing). */
function spawn(sim: Sim, grid: WalkGrid, at: V2, cold: boolean, rng: () => number): void {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * 18;
  const p = grid.nearestFree({ x: at.x + Math.cos(a) * r, z: at.z + Math.sin(a) * r });
  const id = sim.zombies.reduce((m, z) => Math.max(m, z.id), 0) + 1;
  sim.zombies.push({ id, x: p.x, z: p.z, vx: 0, vz: 0, speed: (cold ? 1.1 : 1.3) + rng() * 0.6, cold, alive: true, diedAt: -1, home: at, goal: null });
}
