import type { MapData, V2 } from '../map/types';
import type { RoadGraph } from '../map/roadGraph';
import type { WalkGrid } from '../map/grid';
import { dist } from '../map/geom';
import type { Mission } from '../sim/missions';

/**
 * "Training night": the tutorial's step logic, as a pure state machine with no DOM or three.js,
 * so it can be tested headless. The browser side (tutorial.ts) turns game events into inputs.
 */
export type StepId = 'intro' | 'aim' | 'fire25' | 'switch' | 'fire105' | 'polarity' | 'night' | 'friendlies' | 'done';
export const STEP_ORDER: readonly StepId[] = ['intro', 'aim', 'fire25', 'switch', 'fire105', 'polarity', 'night', 'friendlies', 'done'];

export type TutorialInput =
  | { type: 'start' }
  | { type: 'aimMoved'; metres: number }
  | { type: 'weapon'; weapon: string }
  | { type: 'fired'; weapon: string }
  | { type: 'impact'; weapon: string; kills: number }
  | { type: 'polarity'; polarity: number }
  | { type: 'sensor'; sensor: 'thermal' | 'night' }
  /** The camera's current field of view in degrees (measured by the browser side each frame). */
  | { type: 'lens'; fov: number }
  /** The crosshair is on a cold-blooded zombie (computed by the browser side). */
  | { type: 'onCold'; on: boolean }
  /** The DANGER CLOSE warning is showing. */
  | { type: 'danger'; on: boolean }
  | { type: 'friendlyHit' }
  | { type: 'tick'; dt: number };

/** How far the aim must travel to finish "look around" (metres on the ground). */
export const AIM_METRES = 90;
/** 25 mm rounds to fire (one second of trigger at 12 rounds a second). At least one must also hit. */
export const ROUNDS_25 = 12;
/** Seconds the crosshair must rest on the cold one / the friendlies. */
export const SPOT_TIME = 0.5;
export const DANGER_TIME = 1;
/** Seconds on thermal with the crosshair on the friendlies, looking at their ID panel. */
export const PANEL_TIME = 1;
/**
 * The widest view (degrees) that counts as a "narrow lens". Only the 25 mm zoomed in (2.5 degrees) is
 * this narrow: at the 105's 22 degrees, a zombie or a strobe is a pixel or two across.
 */
export const NARROW_FOV = 3;
/**
 * Seconds after a camera switch before looking counts: the switch shows static for 0.7 s (SWITCH_TIME in
 * game.ts), and the player should actually see the thing on the new camera.
 */
export const SENSOR_SETTLE = 0.8;
export const LENS_HINT = 'Press 1 and Z: small things need a narrow lens.';

export class TutorialSteps {
  step: StepId = 'intro';
  /** 0-1 progress within the current step (for the progress bar). */
  progress = 0;
  /** A short feedback line for the current step, or null. */
  note: string | null = null;
  weapon = '40';
  sensor: 'thermal' | 'night' = 'thermal';
  private aimed = 0;
  private rounds = 0;
  private hits25 = 0;
  private onColdFor = 0;
  private dangerFor = 0;
  private dangerOn = false;
  private coldOn = false;
  /** Camera field of view in degrees; wide until the browser side reports otherwise. */
  private fov = 99;
  /** Friendlies: 0 spot the strobes on night vision, 1 see the ID panel on thermal, 2 move off. */
  private stage = 0;
  private panelFor = 0;
  /** Seconds since the last camera switch. */
  private sinceSwitch = SENSOR_SETTLE;

  constructor(opts: { weapon?: string; sensor?: 'thermal' | 'night' } = {}) {
    if (opts.weapon) this.weapon = opts.weapon;
    if (opts.sensor) this.sensor = opts.sensor;
  }

  get index(): number {
    return STEP_ORDER.indexOf(this.step);
  }

  /** Number of teaching steps (not counting the intro and the end). */
  static readonly TEACHING_STEPS = STEP_ORDER.length - 2;

  get done(): boolean {
    return this.step === 'done';
  }

  /** Feed one input. Returns true if the step changed. */
  send(i: TutorialInput): boolean {
    // Track state that later steps depend on, whatever the current step.
    if (i.type === 'weapon') this.weapon = i.weapon;
    if (i.type === 'sensor' && i.sensor !== this.sensor) this.sinceSwitch = 0;
    if (i.type === 'sensor') this.sensor = i.sensor;
    if (i.type === 'tick') this.sinceSwitch += i.dt;
    if (i.type === 'danger') this.dangerOn = i.on;
    if (i.type === 'onCold') this.coldOn = i.on;
    if (i.type === 'lens') this.fov = i.fov;
    if (i.type === 'friendlyHit') this.note = 'CHECK FIRE! You hit a friendly. Ground patches them up this once; in a real sortie, that ends careers.';

    switch (this.step) {
      case 'intro':
        if (i.type === 'start') return this.advance();
        break;
      case 'aim':
        if (i.type === 'aimMoved') {
          this.aimed += Math.max(0, i.metres);
          this.progress = Math.min(1, this.aimed / AIM_METRES);
          if (this.aimed >= AIM_METRES) return this.advance();
        }
        break;
      case 'fire25':
        // Rounds alone aren't enough (you could hose down an empty road): at least one has to hit.
        if (i.type === 'fired') {
          if (i.weapon === '25') {
            this.rounds++;
            this.note = null;
          } else this.note = 'That was a bigger gun. Press 1 for the 25 mm first.';
        }
        if (i.type === 'impact' && i.weapon === '25' && i.kills > 0) this.hits25 += i.kills;
        this.progress = 0.75 * Math.min(1, this.rounds / ROUNDS_25) + (this.hits25 > 0 ? 0.25 : 0);
        if (this.rounds >= ROUNDS_25 && this.hits25 > 0) return this.advance();
        break;
      case 'switch':
        if (this.weapon === '105') return this.advance();
        break;
      case 'fire105':
        if (i.type === 'weapon' && i.weapon !== '105') this.note = 'Back to the 105: press 3 (or Q).';
        if (i.type === 'impact' && i.weapon === '105') {
          if (i.kills > 0) {
            this.note = null;
            return this.advance();
          }
          this.note = 'Missed. The 105 reloads in 4.5 seconds. Aim at the thick of the crowd and lead it.';
        }
        break;
      case 'polarity':
        if (i.type === 'polarity') return this.advance();
        if (i.type === 'sensor' && i.sensor === 'night') this.note = 'H only works on thermal. Press V to go back to thermal.';
        break;
      case 'night':
        // Dwell time only counts through a narrow lens, on night vision, with the crosshair on the cold one.
        if (i.type === 'tick') this.onColdFor = this.coldOn && this.narrow && this.settled && this.sensor === 'night' ? this.onColdFor + this.seen(i.dt) : 0;
        this.progress = (this.narrow ? 1 / 3 : 0) + (this.sensor === 'night' ? 1 / 3 : 0) + Math.min(1, this.onColdFor / SPOT_TIME) / 3;
        if (this.onColdFor >= SPOT_TIME) return this.advance();
        break;
      case 'friendlies':
        // 0: the strobes on night vision (DANGER CLOSE for a moment); 1: V back to thermal and the dark
        // ID panel, crosshair still on them; 2: move off.
        if (i.type === 'tick') {
          const looking = this.dangerOn && this.narrow && this.settled;
          if (this.stage === 0) {
            this.dangerFor = looking && this.sensor === 'night' ? this.dangerFor + this.seen(i.dt) : 0;
            if (this.dangerFor >= DANGER_TIME) this.stage = 1;
          } else if (this.stage === 1) {
            this.panelFor = looking && this.sensor === 'thermal' ? this.panelFor + this.seen(i.dt) : 0;
            if (this.panelFor >= PANEL_TIME) this.stage = 2;
          }
        }
        this.progress =
          this.stage === 0
            ? (1 / 3) * Math.min(1, this.dangerFor / DANGER_TIME)
            : this.stage === 1
              ? 1 / 3 + (1 / 3) * Math.min(1, this.panelFor / PANEL_TIME)
              : 2 / 3;
        if (this.stage === 2 && !this.dangerOn) return this.advance();
        break;
      case 'done':
        break;
    }
    return false;
  }

  /** Jump straight to the end (the "skip" button). */
  skip(): void {
    this.step = 'done';
    this.progress = 1;
    this.note = null;
  }

  private advance(): boolean {
    this.step = STEP_ORDER[Math.min(STEP_ORDER.length - 1, this.index + 1)];
    this.progress = 0;
    this.note = null;
    this.onColdFor = 0;
    this.dangerFor = 0;
    this.panelFor = 0;
    this.stage = 0;
    // Some steps are already satisfied by what the player did earlier.
    if (this.step === 'switch' && this.weapon === '105') this.advance();
    return true;
  }

  /** Is the camera zoomed in far enough to see one figure? */
  get narrow(): boolean {
    return this.fov <= NARROW_FOV;
  }

  /** Has the picture settled since the last camera switch? */
  private get settled(): boolean {
    return this.sinceSwitch >= SENSOR_SETTLE;
  }

  /** The part of a tick spent looking at a settled picture (so one long tick and many short ones agree). */
  private seen(dt: number): number {
    return Math.max(0, Math.min(dt, this.sinceSwitch - SENSOR_SETTLE));
  }

  /** Friendlies sub-stage: 0 strobes on night vision, 1 ID panel on thermal, 2 move off. */
  get friendliesStage(): number {
    return this.step === 'friendlies' ? this.stage : 0;
  }

  /** Is the player on track for this step, or doing something that blocks it? Used for hints. */
  hint(): string | null {
    if (this.note) return this.note;
    if (this.step === 'fire25' && this.weapon !== '25') return 'Press 1 to pick the 25 mm.';
    if (this.step === 'fire25' && this.rounds >= ROUNDS_25 && this.hits25 === 0) return 'Hits count, not rounds. Put the crosshair right on a zombie by the marker.';
    if (this.step === 'fire105' && this.weapon !== '105') return 'Press 3 (or Q) for the 105 mm.';
    if (this.step === 'polarity' && this.sensor !== 'thermal') return 'Press V to go back to thermal first.';
    if (this.step === 'night') {
      if (!this.narrow) return LENS_HINT;
      if (this.sensor !== 'night') return 'Now press V for night vision.';
      if (!this.coldOn) return 'Find the figure by the marker and put the crosshair on it.';
    }
    if (this.step === 'friendlies') {
      if (this.stage === 2) return this.dangerOn ? 'Good. Now move the crosshair off them.' : null;
      if (!this.narrow) return LENS_HINT;
      if (this.stage === 0) {
        if (this.sensor !== 'night') return 'Press V for night vision: the strobes show there.';
        if (!this.dangerOn) return 'Put the crosshair on the blinking lights by the marker.';
      }
      if (this.stage === 1) {
        if (this.sensor !== 'thermal') return 'DANGER CLOSE: hold fire. Now press V for thermal and look for their dark ID panel.';
        if (!this.dangerOn) return 'Keep the crosshair on them and look for the dark ID panel.';
      }
    }
    return null;
  }
}

/** The words on the coach card for each step. Static text we wrote (never map data). */
export const STEP_TEXT: Record<StepId, { title: string; body: string }> = {
  intro: {
    title: "You're the gunner.",
    body:
      "You're in a gunship circling your own neighbourhood at night, keeping the living alive. The camera sees heat: zombies show up warm and bright. Survivors carry infrared strobes. Nobody down there can see you, so try not to make that their problem.",
  },
  aim: {
    title: 'Look around',
    body: 'Move the mouse to slew the camera (click the picture if it doesn\'t respond). WASD or the arrow keys nudge it too. Find the warm figures by the marker.',
  },
  fire25: {
    title: 'Fire the 25 mm',
    body: 'Press 1 for the 25 mm: quick, precise, small bang. Put the crosshair on a zombie by the marker and hold the left mouse button until one drops.',
  },
  switch: {
    title: 'Switch guns',
    body: 'Q cycles the guns; 1, 2 and 3 pick one directly. The 40 mm (2) is the all-rounder. Pick the 105 mm (3): the big one.',
  },
  fire105: {
    title: 'Fire the 105 at the crowd',
    body: 'One shell, a big blast and a slow reload. Shells take a moment to land, so aim at the thick of the marked crowd and fire.',
  },
  polarity: {
    title: 'White-hot or black-hot',
    body: 'Press H to flip the thermal picture. Some gunners see better in black-hot. Nobody judges. Flip back any time.',
  },
  night: {
    title: 'The cold-blooded',
    body:
      "Some zombies run cold. On thermal they match the grass and nearly vanish; on a road they're just a dark smudge. Night vision sees light, not heat, and picks them up. One lurks by the marker: press 1 and Z for a narrow lens, then V for night vision, and put your crosshair on it.",
  },
  friendlies: {
    title: 'Friendlies and DANGER CLOSE',
    body:
      'The blinking lights are survivors: their infrared strobes show on night vision. Put your crosshair on them: DANGER CLOSE means hold fire. Then press V for thermal, where they wear a dark ID panel, and move off them.',
  },
  done: {
    title: 'Training complete',
    body: "You can aim, shoot, zoom, swap guns and cameras, and you haven't shelled a single neighbour. Probably. Your street is waiting.",
  },
};

/** Where things are on the training ground. */
export interface TrainingLayout {
  centre: V2;
  /** A loose group for the 25 mm. */
  scattered: V2;
  /** A tight crowd for the 105. */
  crowd: V2;
  /** Where the cold-blooded one lurks. */
  cold: V2;
  /** The friendlies with strobes. */
  friendlies: V2;
  /** Far outside the map: one zombie and one survivor the guns can't reach, so the exercise never "ends". */
  reserve: V2;
  reserveFriend: V2;
}

/**
 * Pick four spots near the middle of the map, well apart, on walkable ground. Deterministic.
 * Returns null if the map is too cramped (the sample town never is).
 */
export function planLayout(map: MapData, graph: RoadGraph, grid: WalkGrid): TrainingLayout | null {
  const mid = grid.nearestFree({ x: 0, z: 0 });
  for (const [rMin, rMax, gap] of [[60, 150, 95], [50, 200, 85], [40, 260, 75]]) {
    const cands: V2[] = [];
    for (let i = 0; i < graph.nodes.length; i++) {
      if (graph.comp[i] !== graph.mainComp) continue;
      const n = graph.nodes[i];
      const d = dist(n, mid);
      if (d < rMin || d > rMax) continue;
      const p = grid.nearestFree(n);
      if (!grid.isBlocked(p.x, p.z)) cands.push(p);
    }
    // Sort by angle around the middle so the four spots spread around the view.
    cands.sort((a, b) => Math.atan2(a.z - mid.z, a.x - mid.x) - Math.atan2(b.z - mid.z, b.x - mid.x));
    const picked: V2[] = [];
    for (const c of cands) {
      if (picked.every((p) => dist(p, c) >= gap)) picked.push(c);
      if (picked.length === 4) break;
    }
    if (picked.length < 4) continue;
    const far = map.half + 420;
    const centre = {
      x: picked.reduce((a, p) => a + p.x, 0) / 4,
      z: picked.reduce((a, p) => a + p.z, 0) / 4,
    };
    return { centre, scattered: picked[0], crowd: picked[1], cold: picked[2], friendlies: picked[3], reserve: { x: far, z: far }, reserveFriend: { x: -far, z: -far } };
  }
  return null;
}

/** A mission that never ends on its own: no time pressure worth mentioning, generous friendly-fire limit. */
export function trainingMission(map: MapData, l: TrainingLayout): Mission {
  return {
    type: 'clear',
    difficulty: 1,
    seed: 1,
    mapName: map.name,
    title: 'Training night',
    briefing: [],
    intel: [],
    timeLimit: 99 * 60 + 59,
    orbitCentre: l.centre,
    survivors: [
      { start: l.friendlies, route: null, delay: 0 },
      { start: { x: l.friendlies.x + 2, z: l.friendlies.z }, route: null, delay: 0 },
      { start: l.reserveFriend, route: null, delay: 0 },
    ],
    needHome: 0,
    hordes: [
      { centre: l.scattered, count: 6, cold: 0, label: 'training' },
      { centre: l.crowd, count: 14, cold: 0, label: 'training' },
      { centre: l.cold, count: 1, cold: 1, label: 'training' },
      { centre: l.reserve, count: 1, cold: 0, label: 'reserve' },
    ],
    friendlyFireLimit: 99,
  };
}
