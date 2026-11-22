import type { Sim } from './sim';
import { WEAPONS } from './weapons';

/**
 * A simple autopilot gunner for tests and balance runs. It sees every zombie (including
 * cold-blooded ones), leads moving targets, and never fires close to friendlies.
 * It's a floor for difficulty, not a model of a human player.
 */
export interface BotSkill {
  /** Seconds between decisions. */
  thinkEvery: number;
  /** Random aim error at the target, metres (standard deviation). */
  aimError: number;
  /** Fire only the currently selected gun, paying a delay to switch (like a person). */
  oneGunAtATime: boolean;
  switchDelay: number;
  /** Always sees cold-blooded zombies? If false, it must switch to night vision to see them. */
  seesCold: boolean;
  /** Seconds lost switching cameras. */
  sensorSwitch: number;
  /** Only these guns (balance runs, e.g. a 105-only bot for spec 002). Unset: all three. */
  guns?: string[];
  /**
   * Sees only this far (metres) from where it's looking, like a person on a zoomed camera, and has to search:
   * the search help's circles first, then the briefed horde places, then a seeded sweep. Unset: sees the whole map.
   */
  view?: number;
}

export const SKILL: Record<'ace' | 'human', BotSkill> = {
  ace: { thinkEvery: 0.2, aimError: 0, oneGunAtATime: false, switchDelay: 0, seesCold: true, sensorSwitch: 0 },
  human: { thinkEvery: 0.45, aimError: 3.5, oneGunAtATime: true, switchDelay: 0.8, seesCold: false, sensorSwitch: 0.7 },
};
/** A human-skill bot that has to find what it shoots (owner's report: "I'm looking and looking and can't find them"). */
export const SEARCHER: BotSkill = { ...SKILL.human, view: 70 };
/** Seconds a searching bot looks at one spot before moving on. */
export const LOOK_DWELL = 2.5;

export class Bot {
  private timer = 0;
  private gun = '40';
  /** Which camera the bot is "looking through". */
  sensor: 'thermal' | 'night' = 'thermal';
  private sensorTime = 0;
  private switching = 0;
  private r: () => number;
  private skill: BotSkill;
  /** Where a searching bot (skill.view) is looking, and its search plan. */
  look: { x: number; z: number } | null = null;
  private lookT = 0;
  private plan = 0;
  constructor(private sim: Sim, skill: BotSkill | number = SKILL.ace) {
    this.skill = typeof skill === 'number' ? { ...SKILL.ace, thinkEvery: skill } : skill;
    let a = 0x9e3779b9 ^ sim.mission.seed;
    this.r = () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), a | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  step(dt: number): void {
    this.timer -= dt;
    this.switching = Math.max(0, this.switching - dt);
    this.sensorTime += dt;
    if (this.timer > 0) return;
    this.timer = this.skill.thinkEvery;
    const sim = this.sim;
    const view = this.skill.view;
    if (view) this.lookT += this.skill.thinkEvery;
    const inView = (z: { x: number; z: number }) => !view || (!!this.look && Math.hypot(z.x - this.look.x, z.z - this.look.z) <= view);
    const all = sim.zombies.filter((z) => z.alive && inView(z));
    const canSee = (z: { cold: boolean }) => this.skill.seesCold || this.sensor === 'night' || !z.cold;
    const visible = all.filter(canSee);
    if (view && !visible.length && (!this.look || this.lookT >= LOOK_DWELL * (this.sensor === 'night' ? 2 : 1))) {
      // Nothing here: look somewhere else. A person checks the marked search circles, then the briefed places, then sweeps.
      this.lookT = 0;
      const areas = sim.searchAreas();
      const places = [...sim.regroupPoints().map((g) => g.p), ...sim.mission.hordes.map((h) => h.centre)];
      const h = sim.map.half * 0.85;
      const k = this.plan++;
      if (areas.length) this.look = { ...areas[k % areas.length].p };
      else if (k % 3 !== 2 && places.length) this.look = { ...places[k % places.length] };
      else this.look = { x: (this.r() * 2 - 1) * h, z: (this.r() * 2 - 1) * h };
    }
    if (!this.skill.seesCold) {
      // Like a person: check night vision when thermal shows nothing (the briefing said cold ones are out
      // there), and go back to thermal after a look, because night vision is murkier.
      // A searching bot doesn't know cold ones are in view: it tries night vision on a quiet spot it has looked at a while.
      const hunch = view ? this.lookT >= LOOK_DWELL * 0.6 : all.length > 0;
      const wantNight = this.sensor === 'thermal' ? visible.length === 0 && hunch && this.sensorTime > 3 : this.sensorTime < 12 || visible.every((z) => !z.cold) === false;
      const next = wantNight ? 'night' : 'thermal';
      if (next !== this.sensor && this.sensorTime > 3) {
        this.sensor = next;
        this.sensorTime = 0;
        this.switching = Math.max(this.switching, this.skill.sensorSwitch);
        sim.noteSensorSwitch();
        return;
      }
    }
    const zs = visible;
    if (!zs.length) return;
    const friends = sim.survivors.filter((s) => s.alive && !s.home);
    const threatPts = friends.length ? friends : sim.mission.safehouse ? [sim.mission.safehouse.centre] : [];
    // Bucket zombies into 12 m cells to count clusters cheaply.
    const buckets = new Map<string, number>();
    const key = (x: number, z: number) => `${Math.floor(x / 12)},${Math.floor(z / 12)}`;
    for (const z of zs) buckets.set(key(z.x, z.z), (buckets.get(key(z.x, z.z)) ?? 0) + 1);
    const ac = sim.aircraft();
    let best: { x: number; z: number; score: number; cluster: number } | null = null;
    for (const z of zs) {
      const cluster = buckets.get(key(z.x, z.z)) ?? 1;
      let threat = Infinity;
      for (const p of threatPts) threat = Math.min(threat, Math.hypot(p.x - z.x, p.z - z.z));
      const score = cluster + (Number.isFinite(threat) ? 40 / (1 + threat / 10) : 0);
      if (!best || score > best.score) best = { x: z.x, z: z.z, score, cluster };
    }
    if (!best) return;
    let order = best.cluster >= 5 ? ['105', '40', '25'] : best.cluster >= 2 ? ['40', '25', '105'] : ['25', '40'];
    const guns = this.skill.guns;
    if (guns) order = order.filter((id) => guns.includes(id)).concat(guns.filter((id) => !order.includes(id)));
    for (const id of order) {
      if (this.skill.oneGunAtATime && id !== this.gun) {
        // A person switches to the gun they want, then waits for it.
        if (id === order[0] && this.switching <= 0) {
          this.gun = id;
          this.switching = this.skill.switchDelay;
        }
        continue;
      }
      if (this.switching > 0 || !sim.weaponReady(id)) continue;
      const w = WEAPONS.find((x) => x.id === id)!;
      const target = zs.reduce((a, z) => (Math.hypot(z.x - best!.x, z.z - best!.z) < 1 ? z : a), zs[0]);
      const tof = Math.hypot(target.x - ac.x, ac.y, target.z - ac.z) / w.speed;
      const e = this.skill.aimError * (this.sensor === 'night' ? 1.3 : 1);
      const aim = { x: target.x + target.vx * tof + (this.r() - 0.5) * 2 * e, z: target.z + target.vz * tof + (this.r() - 0.5) * 2 * e };
      const safe = friends.every((f) => Math.hypot(f.x - aim.x, f.z - aim.z) > w.radius * 1.6 + 4);
      if (!safe) continue;
      if (view) {
        // Keep the camera on what it's shooting.
        this.look = { x: target.x, z: target.z };
        this.lookT = 0;
      }
      sim.fire(id, aim);
      return;
    }
  }
}
