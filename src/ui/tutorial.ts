import { makeSampleTown } from '../map/sample';
import { buildRoadGraph } from '../map/roadGraph';
import { WalkGrid } from '../map/grid';
import type { V2 } from '../map/types';
import { dist } from '../map/geom';
import { Sim } from '../sim/sim';
import { weaponById } from '../sim/weapons';
import { mulberry32 } from '../util/rng';
import { Game, LENS_RANGE, type GameAction } from '../game/game';
import { STEP_TEXT, TOUCH_GLOSSARY, TutorialSteps, planLayout, trainingMission, type StepId, type TrainingLayout } from './tutorialSteps';
import { el } from './dom';

/**
 * "Training night": a guided first sortie on the sample town. The Game runs as normal; a coach card
 * tells the player what to do next, and TutorialSteps decides when each step is done.
 */
export type TutorialExit = 'menu' | 'scout' | 'landing' | 'restart';

/** "Been through Training night", finished or skipped: value 'done' (the original key, kept as is). */
const SEEN_KEY = 'spooky.training';
/** How it went, tracked separately: 'completed' or 'skipped'. */
const RESULT_KEY = 'spooky.training.result';
export type TrainingStatus = 'completed' | 'skipped' | null;

export function trainingStatus(): TrainingStatus {
  try {
    const r = localStorage.getItem(RESULT_KEY);
    return r === 'completed' || r === 'skipped' ? r : null;
  } catch {
    return null;
  }
}

/** Has the player finished Training night (not just skipped it)? */
export function trainingDone(): boolean {
  return trainingStatus() === 'completed';
}

function remember(result: 'completed' | 'skipped'): void {
  try {
    localStorage.setItem(SEEN_KEY, 'done');
    // Skipping a replay never takes away a finished training.
    if (result === 'completed' || trainingStatus() !== 'completed') localStorage.setItem(RESULT_KEY, result);
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

/** The crosshair counts as "on" the cold one within this many metres. */
const ON_COLD_METRES = 10;

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
  // Training keeps today's hordes: shelled hordes don't scatter here yet (spec 002, open question 3).
  const sim = new Sim(trainingMission(map, layout), map, graph, grid, { scatter: false });
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
  // Touch screens: which button stands for the keys the steps name.
  const glossary = el('p', 'coach-small coach-touch', TOUCH_GLOSSARY, coach);
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
        remember('completed');
        el('button', 'primary', 'Scout my neighbourhood', row).addEventListener('click', () => exit('scout'));
        el('button', undefined, 'Fly a mission', row).addEventListener('click', () => exit('menu'));
        el('button', undefined, 'Front page', row).addEventListener('click', () => exit('landing'));
        // Shown over the pause screen: this reveals the game's own Resume button underneath.
        el('button', 'coach-stay', 'Keep practising', row).addEventListener('click', () => coach.classList.add('dismissed'));
        el('p', 'coach-small', 'Press Esc to free the mouse and choose. Or stay and keep practising.', coach);
      } else {
        kicker.textContent = `TRAINING NIGHT · STEP ${steps.index} OF ${TutorialSteps.TEACHING_STEPS}`;
        el('button', 'coach-skip', 'Skip tutorial', row).addEventListener('click', skip);
      }
    }
    const h = steps.hint();
    hint.textContent = h ?? '';
    hint.classList.toggle('alarm', !!h && h.startsWith('CHECK FIRE'));
    bar.style.display = steps.step === 'intro' || steps.step === 'done' ? 'none' : '';
    glossary.hidden = !game.info().touch || steps.step === 'done';
    fill.style.width = `${Math.round(steps.progress * 100)}%`;
  };
  const skip = () => {
    steps.skip();
    remember('skipped');
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
    // While paused, the coach shrinks to its title (or, once done, becomes the main card).
    const paused = game.screen === 'paused';
    coach.classList.toggle('paused', paused);
    if (!paused) coach.classList.remove('dismissed');
    if (game.screen !== 'playing') {
      coach.classList.remove('aside');
      return;
    }
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
    const coldOn = live.some((z) => z.cold && dist(z, aim) < ON_COLD_METRES);
    steps.send({ type: 'onCold', on: coldOn });
    const r = weaponById(game.weaponId).radius * 1.6 + 4; // same rule as the HUD's DANGER CLOSE
    const dangerOn = sim.survivors.some((s) => s.alive && !s.home && dist(s, aim) < r);
    steps.send({ type: 'danger', on: dangerOn });
    steps.send({ type: 'lens', fov: lensFov(game, sim, aim) });
    steps.send({ type: 'tick', dt });

    // Friendlies hit in training get patched up after a moment.
    for (let i = revive.length - 1; i >= 0; i--) {
      if (clock < revive[i].at) continue;
      sim.revive(revive[i].id);
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
        for (let k = have; k < need.n + (need.cold ? 0 : 3); k++) spawn(sim, centre, need.cold, rng);
      }
    }

    // Step marker. On the night step it follows the cold one itself, so it marks what you're looking for.
    const mk = MARKS[steps.step];
    let spot: V2 | null = mk ? (layout[mk.at] as V2) : null;
    if (spot && steps.step === 'night') {
      const c = spot;
      const cold = live.filter((z) => z.cold && dist(z, c) < 60).sort((a, b) => dist(a, c) - dist(b, c))[0];
      if (cold) spot = cold;
    }
    const p = spot ? game.screenPos(spot) : null;
    marker.style.display = p ? 'block' : 'none';
    if (!mk || !p) coach.classList.remove('aside');
    if (mk && p) {
      // Off screen: pin the marker to the edge, with an arrow pointing the way.
      const w = parent.clientWidth || innerWidth;
      const h = parent.clientHeight || innerHeight;
      let x = Math.max(70, Math.min(w - 70, p.x));
      let y = Math.max(70, Math.min(h - 40, p.y));
      const edge = !p.visible || x !== p.x || y !== p.y;
      // Keep the coach card and the marker apart. A spot on screen under the card would be hidden,
      // so the card moves to the other side; a marker pinned to the edge slides clear of the card instead.
      const pr = parent.getBoundingClientRect();
      const rectOf = () => {
        const c = coach.getBoundingClientRect();
        return { l: c.left - pr.left, t: c.top - pr.top, r: c.right - pr.left, b: c.bottom - pr.top };
      };
      if (!coach.classList.contains('aside')) home = rectOf();
      const aside = !edge && !!home && overlaps(markerBox(x, y), home, coach.classList.contains('aside') ? 24 : 8);
      coach.classList.toggle('aside', aside);
      if (edge) {
        // Slide along the edge to the nearer side of the card; if there's no room (a full-width card on a
        // phone), step off the edge to just past the card.
        const c = rectOf();
        if (overlaps(markerBox(x, y), c, 8)) {
          const left = c.l - 68;
          const right = c.r + 68;
          const fits = (v: number) => v >= 70 && v <= w - 70;
          const side = [left, right].filter(fits).sort((a, b) => Math.abs(a - p.x) - Math.abs(b - p.x))[0];
          if (side !== undefined) x = side;
          else y = c.t + c.b < h ? c.b + MARKER_ABOVE + 8 : c.t - MARKER_BELOW - 8;
        }
      }
      marker.classList.toggle('edge', edge);
      if (edge) marker.style.setProperty('--a', `${Math.atan2(p.y - y, p.x - x).toFixed(2)}rad`);
      // Once the crosshair is inside the ring (or on the target), the ring fades so it can't hide the target.
      const onIt = (steps.step === 'night' && coldOn) || (steps.step === 'friendlies' && dangerOn);
      marker.classList.toggle('inside', !edge && (onIt || Math.hypot(p.x - w / 2, p.y - h / 2) < 40));
      if (marker.textContent !== mk.label) marker.textContent = mk.label;
      marker.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    }
    draw();
  };
  /** Where the coach card sits when it isn't moved aside (measured while it's there). */
  let home: Rect | null = null;
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

/** Add one zombie near a spot. */
function spawn(sim: Sim, at: V2, cold: boolean, rng: () => number): void {
  const a = rng() * Math.PI * 2;
  const r = Math.sqrt(rng()) * 18;
  sim.addZombie({ x: at.x + Math.cos(a) * r, z: at.z + Math.sin(a) * r }, cold, at);
}

interface Rect {
  l: number;
  t: number;
  r: number;
  b: number;
}

/** The marker's label sits above its point, the ring (or edge arrow) on it: see .coach-marker in style.css. */
const MARKER_ABOVE = 45;
const MARKER_BELOW = 20;
const markerBox = (x: number, y: number): Rect => ({ l: x - 60, t: y - MARKER_ABOVE, r: x + 60, b: y + MARKER_BELOW });
const overlaps = (a: Rect, b: Rect, pad: number): boolean => a.l < b.r + pad && a.r > b.l - pad && a.t < b.b + pad && a.b > b.t - pad;

/**
 * The camera's lens in degrees (at LENS_RANGE, as guns quote it), measured from the picture itself: how many
 * pixels a 10 m stretch of ground across the line of sight covers at the aim point. (The game keeps its zoom
 * state private.)
 */
function lensFov(game: Game, sim: Sim, aim: V2): number {
  const ac = sim.aircraft();
  const dx = aim.x - ac.x;
  const dz = aim.z - ac.z;
  const flat = Math.hypot(dx, dz) || 1;
  // The camera's right axis is level, so a ground segment at right angles to the flat view direction faces it square-on.
  const ox = (-dz / flat) * 5;
  const oz = (dx / flat) * 5;
  const a = game.screenPos({ x: aim.x - ox, z: aim.z - oz }, 0);
  const b = game.screenPos({ x: aim.x + ox, z: aim.z + oz }, 0);
  const px = Math.hypot(b.x - a.x, b.y - a.y);
  const h = game.renderer.domElement.clientHeight;
  if (!px || !h) return 99;
  // Lenses are quoted at LENS_RANGE: the game widens or narrows the angle with range so the view covers
  // the same ground, so measure the ground covered and convert at that range.
  return (2 * Math.atan((10 * h) / (2 * LENS_RANGE * px)) * 180) / Math.PI;
}
