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
  /** The crosshair is on a cold-blooded zombie (computed by the browser side). */
  | { type: 'onCold'; on: boolean }
  /** The DANGER CLOSE warning is showing. */
  | { type: 'danger'; on: boolean }
  | { type: 'friendlyHit' }
  | { type: 'tick'; dt: number };

/** How far the aim must travel to finish "look around" (metres on the ground). */
export const AIM_METRES = 90;
/** 25 mm rounds to fire (one second of trigger at 12 rounds a second). */
export const ROUNDS_25 = 12;
/** Seconds the crosshair must rest on the cold one / the friendlies. */
export const SPOT_TIME = 0.5;
export const DANGER_TIME = 1;

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
  private onColdFor = 0;
  private dangerFor = 0;
  private dangerSeen = false;
  private dangerOn = false;
  private coldOn = false;

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
    if (i.type === 'sensor') this.sensor = i.sensor;
    if (i.type === 'danger') this.dangerOn = i.on;
    if (i.type === 'onCold') this.coldOn = i.on;
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
        if (i.type === 'fired') {
          if (i.weapon === '25') {
            this.rounds++;
            this.progress = Math.min(1, this.rounds / ROUNDS_25);
            this.note = null;
            if (this.rounds >= ROUNDS_25) return this.advance();
          } else this.note = 'That was a bigger gun. Press 1 for the 25 mm first.';
        }
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
        // Dwell time only counts on night vision, with the crosshair on the cold one.
        if (i.type === 'tick') this.onColdFor = this.coldOn && this.sensor === 'night' ? this.onColdFor + i.dt : 0;
        this.progress = this.sensor === 'night' ? 0.5 + 0.5 * Math.min(1, this.onColdFor / SPOT_TIME) : 0;
        if (this.onColdFor >= SPOT_TIME) return this.advance();
        break;
      case 'friendlies':
        if (i.type === 'tick') {
          this.dangerFor = this.dangerOn ? this.dangerFor + i.dt : 0;
          if (this.dangerFor >= DANGER_TIME) this.dangerSeen = true;
        }
        this.progress = this.dangerSeen ? 0.5 : 0.5 * Math.min(1, this.dangerFor / DANGER_TIME);
        if (this.dangerSeen && !this.dangerOn) return this.advance();
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
    this.dangerSeen = false;
    // Some steps are already satisfied by what the player did earlier.
    if (this.step === 'switch' && this.weapon === '105') this.advance();
    return true;
  }

  /** Is the player on track for this step, or doing something that blocks it? Used for hints. */
  hint(): string | null {
    if (this.note) return this.note;
    if (this.step === 'fire25' && this.weapon !== '25') return 'Press 1 to pick the 25 mm.';
    if (this.step === 'fire105' && this.weapon !== '105') return 'Press 3 (or Q) for the 105 mm.';
    if (this.step === 'polarity' && this.sensor !== 'thermal') return 'Press V to go back to thermal first.';
    if (this.step === 'night' && this.sensor !== 'night') return 'Press V for night vision.';
    if (this.step === 'friendlies' && this.dangerSeen && this.dangerOn) return 'Good. Now move the crosshair off them.';
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
    body: 'Press 1 for the 25 mm: quick, precise, small bang. Put the crosshair on a zombie and hold the left mouse button.',
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
      "Some zombies run cold. On thermal they're as cool as the road, so they nearly vanish. One is lurking by the marker. Press V for night vision, which sees light instead of heat, and put your crosshair on it.",
  },
  friendlies: {
    title: 'Friendlies and DANGER CLOSE',
    body:
      'The blinking lights are survivors: their infrared strobes show on night vision, and on thermal they wear a dark ID panel. Put your crosshair on them and watch for DANGER CLOSE. That means hold fire. Then move off them.',
  },
  done: {
    title: 'Training complete',
    body: "You can aim, shoot, swap guns and cameras, and you haven't shelled a single neighbour. Probably. Your street is waiting.",
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
