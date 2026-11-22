/**
 * Pure animation rules for zombies and survivors: which pose a sim agent is in, how fast its
 * legs cycle, how a blast makes it flinch, and how hot each part of its body is. No three.js here,
 * so it is unit-tested directly. The vertex shader in src/render/figureShader.ts turns these
 * numbers into motion. All of it is visual only: nothing here feeds back into the simulation.
 */

/** Animation states, as floats the shader can read. */
export const ANIM = {
  shamble: 0,
  lunge: 1,
  attack: 2,
  dead: 3,
  walk: 4,
  run: 5,
  idle: 6,
  crouch: 7,
} as const;
export type AnimState = (typeof ANIM)[keyof typeof ANIM];

/** The sim fields the zombie mapping needs (a subset of sim Zombie). */
export interface ZombieLike {
  alive: boolean;
  vx: number;
  vz: number;
  /** The zombie's base speed; the sim moves it at 1.45x this when chasing. */
  speed: number;
}

/** Below this ground speed (m/s) an agent counts as standing still. */
export const STILL = 0.05;
/** Survivors above this speed (m/s) are running; the sim uses 2.1 walking and 3.2 when zombies are close. */
export const RUN_SPEED = 2.7;
/** Zombies above this ground speed (m/s) sprint (rush waves, fast chasers) instead of lurching. */
export const ZOMBIE_RUN_SPEED = 2.5;
/** A standing survivor cowers when a live zombie is this close (metres). */
export const COWER_RANGE = 7;
/** Seconds a survivor stays ducked after a blast lands near them. */
export const DUCK_TIME = 1.4;

/**
 * Sim zombie → animation state.
 * - dead when not alive;
 * - attack when it has stopped: the sim only stops a live zombie when it is on a survivor
 *   (within 1.1 m) or hammering at the safehouse;
 * - run when it is moving fast (rush waves, fast zombies chasing);
 * - lunge when moving faster than its base speed (the sim's 1.45x chase speed);
 * - otherwise shamble (wandering, milling at a horde point, or following the flow field).
 */
export function zombieAnimState(z: ZombieLike): AnimState {
  if (!z.alive) return ANIM.dead;
  const v = Math.hypot(z.vx, z.vz);
  if (v < STILL) return ANIM.attack;
  if (v > ZOMBIE_RUN_SPEED) return ANIM.run;
  if (v > z.speed * 1.2) return ANIM.lunge;
  return ANIM.shamble;
}

/**
 * Survivor → animation state, from its measured ground speed (m/s). A survivor standing still
 * crouches (cowering, hands over head) when `threatened` (a zombie close, or a blast just landed
 * near), and otherwise stands alert.
 */
export function survivorAnimState(alive: boolean, speed: number, threatened = false): AnimState {
  if (!alive) return ANIM.dead;
  if (speed < 0.3) return threatened ? ANIM.crouch : ANIM.idle;
  return speed > RUN_SPEED ? ANIM.run : ANIM.walk;
}

/** Full gait cycles (two steps) per second at a ground speed. Zombies take short, dragging steps. */
export function gaitRate(state: AnimState, speed: number): number {
  switch (state) {
    case ANIM.dead:
    case ANIM.idle:
    case ANIM.crouch:
      return 0;
    case ANIM.attack:
      return 0.6; // feet shuffle a little while it claws
    case ANIM.shamble:
      return 0.3 + speed * 0.42;
    case ANIM.lunge:
      return 0.5 + speed * 0.45;
    case ANIM.run:
      return 0.55 + speed * 0.4; // zombies and survivors alike: ~1.8-1.9 Hz at 3.2 m/s
    default:
      return 0.35 + speed * 0.45; // survivors walking: ~1.3 Hz
  }
}

/** How strongly limbs swing, 0-1.2, from state and speed. */
export function gaitAmp(state: AnimState, speed: number): number {
  if (state === ANIM.dead || state === ANIM.idle || state === ANIM.crouch) return 0;
  if (state === ANIM.attack) return 0.25;
  return Math.min(1.2, 0.35 + speed * 0.4);
}

/**
 * Pose blend weights the shader mixes between, for an animation state: how much of the running
 * gait (long strides, pumping or flailing arms), the attack (clawing), and the crouch to use.
 * The view eases toward these, so changes of state blend over ~0.2 s instead of popping.
 */
export function poseWeights(state: AnimState): { run: number; attack: number; crouch: number } {
  return {
    run: state === ANIM.run ? 1 : state === ANIM.lunge ? 0.45 : 0,
    attack: state === ANIM.attack ? 1 : 0,
    crouch: state === ANIM.crouch ? 1 : 0,
  };
}

/** Hit reaction: how hard a near-miss blast makes a zombie flinch (0-1) at distance d from a blast of lethal radius r. */
export function reactStrength(d: number, r: number): number {
  const near = 1.2 * r;
  const far = 3.5 * r;
  if (d >= far) return 0;
  if (d <= near) return 1;
  const t = (d - near) / (far - near);
  return 1 - t * t * (3 - 2 * t);
}

/** Seconds a hit reaction lasts. */
export const REACT_TIME = 0.9;
/** Hit reaction envelope over time since the blast: a sharp 70 ms jolt, then easing back over ~0.6 s. */
export function reactEnvelope(age: number): number {
  if (age < 0 || age >= REACT_TIME) return 0;
  const rise = Math.min(1, age / 0.07);
  return rise * Math.exp(-Math.max(0, age - 0.07) * 5.5);
}

/** Thermal values (R channel). Live warm zombies are the hottest thing on screen. */
export const HEAT = {
  warmCore: 0.98,
  warmLimb: 0.5,
  survivorCore: 0.9,
  survivorLimb: 0.55,
  /** Ground and grass are 0.19-0.2: cold-blooded zombies vanish there and show dark on roads (0.33). */
  cold: 0.2,
  /** A fresh body starts noticeably cooler than a live zombie, then fades to just above ground temperature. */
  bodyStart: 0.5,
  bodyEnd: 0.23,
  coolSeconds: 20,
} as const;

/**
 * Heat of an agent's core (head, torso) and limb tips. Warm bodies have hot heads and torsos and
 * cooler hands and feet; cold-blooded zombies are uniform at ground heat, alive or dead.
 * Bodies cool over ~20 s and the limbs reach ground temperature first.
 */
export function bodyHeat(alive: boolean, cold: boolean, deadFor: number, survivor = false): [number, number] {
  if (cold) return [HEAT.cold, HEAT.cold];
  if (alive) return survivor ? [HEAT.survivorCore, HEAT.survivorLimb] : [HEAT.warmCore, HEAT.warmLimb];
  const cool = Math.min(1, Math.max(0, deadFor) / HEAT.coolSeconds);
  const core = HEAT.bodyStart - cool * (HEAT.bodyStart - HEAT.bodyEnd);
  const limb = Math.max(HEAT.bodyEnd, core - 0.12 * (1 - cool));
  return [core, limb];
}

/** Integer hash of an agent id → [0, 1). Gives each zombie a stable height, lean and gait. */
export function hash01(id: number): number {
  let h = (id | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
