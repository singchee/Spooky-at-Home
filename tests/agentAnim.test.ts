import { describe, expect, it } from 'vitest';
import { ANIM, HEAT, RUN_SPEED, bodyHeat, gaitAmp, gaitRate, hash01, survivorAnimState, zombieAnimState } from '../src/game/agentAnim';
import { AgentsView } from '../src/game/agentsView';
import { FigureBatch, PART, buildFigureGeometry } from '../src/render/figureShader';
import { makeSampleTown } from '../src/map/sample';
import { createSim } from '../src/sim/setup';

const z = (o: Partial<{ alive: boolean; vx: number; vz: number; speed: number }>) => ({ alive: true, vx: 0, vz: 0, speed: 1.5, ...o });

describe('zombie animation state (sim zombie → pose)', () => {
  it('a dead zombie falls, whatever its last velocity', () => {
    expect(zombieAnimState(z({ alive: false, vx: 3 }))).toBe(ANIM.dead);
  });
  it('a live zombie that has stopped is attacking (the sim only stops it on a survivor or the safehouse)', () => {
    expect(zombieAnimState(z({ vx: 0, vz: 0 }))).toBe(ANIM.attack);
  });
  it('milling (0.45x) and wandering (1x) speeds shamble', () => {
    expect(zombieAnimState(z({ vx: 1.5 * 0.45 }))).toBe(ANIM.shamble);
    expect(zombieAnimState(z({ vz: -1.5 }))).toBe(ANIM.shamble);
  });
  it('the sim chase speed (1.45x) lunges', () => {
    expect(zombieAnimState(z({ vx: 1.5 * 1.45 * 0.6, vz: 1.5 * 1.45 * 0.8 }))).toBe(ANIM.lunge);
  });
  it('matches what the real sim produces: chasing zombies near a survivor lunge or attack', () => {
    const r = createSim(makeSampleTown(), { type: 'escort', difficulty: 3, seed: 11 });
    if (!r.ok) throw new Error(r.reason);
    const sim = r.sim;
    const seen = new Set<number>();
    for (let i = 0; i < 60 * 90 && sim.phase === 'running'; i++) {
      sim.step(1 / 60);
      for (const zz of sim.zombies) {
        const st = zombieAnimState(zz);
        seen.add(st);
        if (!zz.alive) expect(st).toBe(ANIM.dead);
        else {
          const near = sim.survivors.some((s) => Math.hypot(s.x - zz.x, s.z - zz.z) < 27); // sim chases within 25 m (2 m slack for this step)
          if (st === ANIM.lunge) expect(near).toBe(true); // only chasers move above base speed
        }
      }
    }
    expect(seen.has(ANIM.shamble)).toBe(true);
  });
});

describe('survivor animation state', () => {
  it('maps speed to idle / walk / run, and death to dead', () => {
    expect(survivorAnimState(true, 0)).toBe(ANIM.idle);
    expect(survivorAnimState(true, 2.1)).toBe(ANIM.walk);
    expect(survivorAnimState(true, 3.2)).toBe(ANIM.run);
    expect(survivorAnimState(true, RUN_SPEED + 0.01)).toBe(ANIM.run);
    expect(survivorAnimState(false, 3.2)).toBe(ANIM.dead);
  });
  it('panicking survivors step faster than walking ones; zombies lunge faster than they shamble', () => {
    expect(gaitRate(ANIM.run, 3.2)).toBeGreaterThan(gaitRate(ANIM.walk, 2.1));
    expect(gaitRate(ANIM.lunge, 2.4)).toBeGreaterThan(gaitRate(ANIM.shamble, 1.6));
    expect(gaitRate(ANIM.dead, 3)).toBe(0);
    expect(gaitAmp(ANIM.dead, 3)).toBe(0);
    expect(gaitAmp(ANIM.idle, 0)).toBe(0);
  });
});

describe('body heat', () => {
  it('warm zombies: hot core, cooler limbs, still the hottest thing (hotter than a fresh crater 0.58)', () => {
    const [core, limb] = bodyHeat(true, false, 0);
    expect(core).toBe(HEAT.warmCore);
    expect(limb).toBeLessThan(core);
    expect(core).toBeGreaterThan(0.58);
  });
  it('cold-blooded zombies sit at ground heat, uniform, alive or dead', () => {
    expect(bodyHeat(true, true, 0)).toEqual([HEAT.cold, HEAT.cold]);
    expect(bodyHeat(false, true, 5)).toEqual([HEAT.cold, HEAT.cold]);
  });
  it('bodies cool over ~40 s to near ground heat, limbs first', () => {
    const fresh = bodyHeat(false, false, 0);
    const mid = bodyHeat(false, false, 20);
    const old = bodyHeat(false, false, 60);
    expect(fresh[0]).toBeCloseTo(HEAT.bodyStart);
    expect(mid[0]).toBeLessThan(fresh[0]);
    expect(old[0]).toBeCloseTo(HEAT.bodyEnd);
    expect(fresh[1]).toBeLessThan(fresh[0]);
    expect(old[1]).toBeCloseTo(old[0]);
  });
});

describe('per-zombie variety', () => {
  it('hash01 is stable, in [0, 1) and spread out', () => {
    expect(hash01(42)).toBe(hash01(42));
    const vals = Array.from({ length: 2000 }, (_, i) => hash01(i));
    expect(Math.min(...vals)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...vals)).toBeLessThan(1);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    expect(Math.abs(mean - 0.5)).toBeLessThan(0.03);
  });
});

describe('AgentsView', () => {
  it('draws 1,500+ zombies in one object per kind, with bounded instance counts', () => {
    const view = new AgentsView();
    const zombies = Array.from({ length: 3000 }, (_, i) => ({
      id: i, x: i % 100, z: Math.floor(i / 100), vx: i % 3 ? 1 : 0, vz: 0, speed: 1.4, cold: i % 5 === 0, alive: i % 7 !== 0, diedAt: 1, home: null, goal: null,
    }));
    const survivors = Array.from({ length: 50 }, (_, i) => ({ id: i, x: i, z: 0, alive: true, home: false, diedAt: -1 }));
    const sim = { zombies, survivors, t: 10 };
    for (let f = 0; f < 5; f++) view.update(sim as never, f / 30);
    const s = view.stats;
    expect(s.objects).toBe(2);
    expect(s.zombies).toBe(2500); // capped at the newest 2,500
    expect(s.survivors).toBe(32);
    view.dispose();
  });
});

describe('figure geometry', () => {
  it('has every body part, each vertex tagged with its part and joint', () => {
    const g = buildFigureGeometry(true);
    const parts = new Set(Array.from(g.attributes.aPart.array as Float32Array));
    for (const p of Object.values(PART)) expect(parts.has(p)).toBe(true);
    expect(g.attributes.aPivot.count).toBe(g.attributes.position.count);
    expect(g.attributes.aLimbT.count).toBe(g.attributes.position.count);
    g.dispose();
  });
  it('stays lean enough for thousands of animated instances (vertices are skinned in the shader)', () => {
    const b = new FigureBatch('zombie', 10);
    expect(b.mesh.geometry.index).not.toBeNull(); // the merged figure is indexed: drop the index and the mesh breaks apart
    expect(b.cost.vertices).toBeLessThan(120);
    expect(b.cost.triangles).toBeLessThan(120);
    b.dispose();
  });
});
