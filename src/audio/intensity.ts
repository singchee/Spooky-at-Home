/**
 * How tense the score should be (0..1), from the mission state. Pure: reads the simulation, never
 * changes it, and uses no randomness, so tests can check it headless.
 */
import type { Sim, SimState } from '../sim/sim';

/** What the score listens to. All counts are plain numbers so tests can build one by hand. */
export interface ThreatSnapshot {
  phase: SimState['phase'];
  /** Live zombies anywhere on the map. */
  contacts: number;
  /**
   * Contacts closing on a friendly (or on the safehouse in a defend mission), weighted by how close:
   * one zombie right beside a friendly counts 1, one NEAR_M away counts 0.
   */
  nearContacts: number;
  /** Zombies close enough to be hurting a friendly, or at the safehouse door. */
  attackers: number;
  /** Seconds left on the mission clock, and its full length. */
  timeLeft: number;
  timeLimit: number;
  /** Safehouse integrity, 0..1 (1 when there is no safehouse). */
  integrity: number;
}

/** Contacts start to count as closing in from this far from a friendly (metres). */
export const NEAR_M = 150;
/** A contact this close to a friendly is attacking them (a little over the sim's 1.6 m bite). */
export const BITE_M = 2.5;
/** Contacts this close to the safehouse centre count as attacking it. */
export const DOOR_M = 25;
/** The last this-many seconds on the clock add urgency. */
export const URGENT_S = 60;
/** The score never goes fully calm while a mission is running. */
export const FLOOR = 0.12;

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/**
 * Combine the threats. Each one closes part of the remaining gap to 1, so they add up without
 * ever going over, and one maxed-out threat alone does not pin the score to full.
 */
export function threatIntensity(t: ThreatSnapshot): number {
  if (t.phase !== 'running') return 0;
  const crowd = 1 - Math.exp(-Math.max(0, t.contacts) / 30);
  const near = 1 - Math.exp(-Math.max(0, t.nearContacts) / 4);
  const attack = t.attackers > 0 ? Math.min(1, 0.7 + 0.15 * t.attackers) : 0;
  const urgency = t.timeLimit > 0 ? clamp01(1 - t.timeLeft / URGENT_S) : 0;
  const damage = 1 - clamp01(t.integrity);
  const calm = (1 - FLOOR) * (1 - 0.3 * crowd) * (1 - 0.55 * near) * (1 - 0.75 * attack) * (1 - 0.25 * urgency) * (1 - 0.5 * damage);
  return clamp01(1 - calm);
}

/** Read the threat from a running simulation (zombies near friendlies, friendlies being bitten, time left). */
export function measureThreat(sim: Pick<Sim, 'zombies' | 'survivors' | 'mission' | 'phase' | 't' | 'integrity'>): ThreatSnapshot {
  const friendlies = sim.survivors.filter((s) => s.alive && !s.home);
  const house = sim.mission.type === 'defend' ? sim.mission.safehouse?.centre : undefined;
  let contacts = 0;
  let nearContacts = 0;
  let attackers = 0;
  for (const z of sim.zombies) {
    if (!z.alive) continue;
    contacts++;
    let d = Infinity;
    for (const s of friendlies) d = Math.min(d, Math.hypot(z.x - s.x, z.z - s.z));
    let door = false;
    if (house) {
      const dh = Math.hypot(z.x - house.x, z.z - house.z);
      d = Math.min(d, dh);
      door = dh < DOOR_M;
    }
    if (d < NEAR_M) nearContacts += 1 - d / NEAR_M;
    if (door || d < BITE_M) attackers++;
  }
  const timeLimit = sim.mission.timeLimit;
  return {
    phase: sim.phase,
    contacts,
    nearContacts,
    attackers,
    timeLeft: Math.max(0, timeLimit - sim.t),
    timeLimit,
    integrity: sim.integrity,
  };
}

/**
 * Smooths the target so the score swells in a few seconds and settles over longer, never jumping.
 * Rates are per second of 0..1.
 */
export class IntensitySmoother {
  value: number;
  constructor(
    start = 0,
    readonly rise = 0.35,
    readonly fall = 0.08,
  ) {
    this.value = start;
  }
  step(target: number, dt: number): number {
    const t = clamp01(target);
    if (t > this.value) this.value = Math.min(t, this.value + this.rise * dt);
    else this.value = Math.max(t, this.value - this.fall * dt);
    return this.value;
  }
}
