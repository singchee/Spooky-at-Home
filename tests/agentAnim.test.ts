import { describe, expect, it } from 'vitest';
import { ANIM, HEAT, REACT_TIME, RUN_SPEED, ZOMBIE_RUN_SPEED, bodyHeat, gaitAmp, gaitRate, hash01, poseWeights, reactEnvelope, reactStrength, survivorAnimState, zombieAnimState } from '../src/game/agentAnim';
import * as THREE from 'three';
import { AgentsView, BODY_SINK_S, LOD_ENTER_PX, LOD_HEIGHT_M, LOD_STAY_PX, meanHeatWeight } from '../src/game/agentsView';
import { bakeModel } from '../src/render/characterModels';
import { DEATH_EASE, deathHeat } from '../src/game/agentAnim';
import { tinyRig } from './tinyRig';
import { FIGURE_SCALE, FigureBatch, HEAD_TOP, PART, buildFigureGeometry } from '../src/render/figureShader';
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
  it('bodies cool to near ground heat, limbs first', () => {
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
    expect(s.objects).toBe(3); // zombies, survivors, and the survivors' IR strobes
    expect(s.zombies).toBe(2500); // capped at the newest 2,500
    expect(s.survivors).toBe(32);
    view.dispose();
  });

  it('living first (spec 003): every living zombie is drawn however many bodies there are, bodies newest death first', () => {
    const view = new AgentsView({ models: false });
    // 3,000 bodies spawned AFTER 1,200 living ones: the old "newest 2,500 entries" rule would hide 1,700 of the living.
    const mk = (i: number, alive: boolean) => ({ id: i, x: i % 100, z: Math.floor(i / 100), vx: 0, vz: 0, speed: 1.4, cold: false, alive, diedAt: alive ? -1 : 1, home: null, goal: null });
    const zombies = [...Array.from({ length: 1200 }, (_, i) => mk(i, true)), ...Array.from({ length: 3000 }, (_, i) => mk(1200 + i, false))];
    const sim = { zombies, survivors: [], t: 10 };
    view.update(sim as never, 0);
    const drawn = () => (view as unknown as { drawn: number[] }).drawn;
    expect(drawn().length).toBe(2500);
    for (let i = 0; i < 1200; i++) expect(drawn()[i]).toBe(i);
    // Now living zombies die, in a known order: they are the newest bodies, so they're drawn ahead of the old ones.
    for (const i of [5, 900, 17]) Object.assign(zombies[i], { alive: false, diedAt: 11 });
    view.update(sim as never, 0.1);
    const d = drawn();
    expect(d.slice(0, 1197)).not.toContain(5);
    expect(d.slice(1197, 1200)).toEqual([900, 17, 5]); // newest death first (seen in index order within a frame, then reversed)
    expect(d.length).toBe(2500);
    expect(d).not.toContain(1200); // the oldest bodies are the ones left out
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

describe('figure rework (3.10): states, hit reactions, ducking', () => {
  it('fast zombies (rush waves, fast chasers) run; survivors standing under threat crouch', () => {
    expect(zombieAnimState(z({ vx: ZOMBIE_RUN_SPEED + 0.1 }))).toBe(ANIM.run);
    expect(zombieAnimState(z({ vx: 2.2, speed: 1.5 }))).toBe(ANIM.lunge);
    expect(survivorAnimState(true, 0, true)).toBe(ANIM.crouch);
    expect(survivorAnimState(true, 0, false)).toBe(ANIM.idle);
    expect(survivorAnimState(true, 3.2, true)).toBe(ANIM.run); // running beats cowering
    expect(gaitRate(ANIM.crouch, 0)).toBe(0);
  });

  it('pose weights: lunge is half a run, attack and crouch are their own blends', () => {
    expect(poseWeights(ANIM.run).run).toBe(1);
    expect(poseWeights(ANIM.lunge).run).toBeGreaterThan(0);
    expect(poseWeights(ANIM.lunge).run).toBeLessThan(1);
    expect(poseWeights(ANIM.attack)).toEqual({ run: 0, attack: 1, crouch: 0 });
    expect(poseWeights(ANIM.crouch).crouch).toBe(1);
  });

  it('a near miss makes zombies flinch: full strength close in, none beyond 3.5x the lethal radius', () => {
    expect(reactStrength(0, 7)).toBe(1);
    expect(reactStrength(7 * 1.2, 7)).toBe(1);
    expect(reactStrength(7 * 2.3, 7)).toBeGreaterThan(0);
    expect(reactStrength(7 * 3.5, 7)).toBe(0);
    // A sharp jolt that eases back and is over within REACT_TIME.
    expect(reactEnvelope(0)).toBe(0);
    expect(reactEnvelope(0.07)).toBeCloseTo(1);
    expect(reactEnvelope(0.4)).toBeLessThan(0.3);
    expect(reactEnvelope(REACT_TIME)).toBe(0);
  });

  it('bodies cool to near ground heat in about 20 s', () => {
    expect(HEAT.coolSeconds).toBe(20);
    expect(bodyHeat(false, false, 20)[0]).toBeCloseTo(HEAT.bodyEnd);
    expect(bodyHeat(false, false, 10)[0]).toBeGreaterThan(HEAT.bodyEnd + 0.1);
  });

  it('the view: blasts make nearby zombies flinch, bodies fall away from the blast, survivors duck', () => {
    const view = new AgentsView({ models: false });
    const mk = (id: number, x: number) => ({ id, x, z: 0, vx: 1, vz: 0, speed: 1.5, cold: false, alive: true, diedAt: -1, home: null, goal: null });
    const zombies = [mk(0, 10), mk(1, 100), mk(2, 1)];
    const survivors = [{ id: 0, x: -20, z: 0, alive: true, home: false, diedAt: -1 }]; // 20 m from the blast, 30 m from any zombie
    const sim = { zombies, survivors, t: 1 };
    view.update(sim as never, 0.9);
    Object.assign(zombies[2], { alive: false, diedAt: 1 }); // killed by the blast that lands now
    view.impact(0, 0, 7, 1);
    view.update(sim as never, 1.07);
    const batch = (view as unknown as { zombies: { c: Float32Array; b: Float32Array; a: Float32Array } }).zombies;
    expect(batch.c[0 * 4 + 3]).toBeGreaterThan(0.5); // zombie 0 (10 m away): flinching
    expect(batch.c[1 * 4 + 3]).toBe(0); // zombie 1 (100 m away): untouched
    // Zombie 2 died in the blast at x = 1: it falls toward +x (away), relative to its heading.
    const fallWorld = batch.b[2 * 4 + 3] + batch.a[2 * 4 + 2];
    expect(Math.sin(fallWorld)).toBeGreaterThan(0.9);
    const sb = (view as unknown as { survivors: { d: Float32Array } }).survivors;
    for (let f = 0; f < 10; f++) view.update(sim as never, 1.07 + f * 0.05);
    expect(sb.d[2]).toBeGreaterThan(0.9); // the survivor 20 m from a 40 mm blast is ducking
    for (let f = 0; f < 60; f++) view.update(sim as never, 1.6 + 1.5 + f * 0.05);
    expect(sb.d[2]).toBeLessThan(0.1); // and stands again once it has passed
    view.dispose();
  });

  it('frame-rate independent: the same game time gives the same pose at 30 and 144 fps', () => {
    const run = (fps: number) => {
      const view = new AgentsView({ models: false });
      const sim = { zombies: [{ id: 5, x: 0, z: 0, vx: 1.2, vz: 0, speed: 1.5, cold: false, alive: true, diedAt: -1, home: null, goal: null }], survivors: [], t: 0 };
      for (let f = 0; f <= 2 * fps; f++) view.update(sim as never, f / fps);
      const b = (view as unknown as { zombies: { a: Float32Array; b: Float32Array } }).zombies;
      const out = [b.a[3], b.b[1]];
      view.dispose();
      return out;
    };
    const [p30, amp30] = run(30);
    const [p144, amp144] = run(144);
    expect(p144).toBeCloseTo(p30, 3); // gait phase
    expect(amp144).toBeCloseTo(amp30, 2); // eased amplitude
  });

  it('bodies never lie inside a building, whichever way they would have fallen', () => {
    // A building from x = 1 to 12 m; zombies on its doorstep facing it, dying with and without a blast.
    const map = { buildings: [{ pts: [{ x: 1, z: -6 }, { x: 12, z: -6 }, { x: 12, z: 6 }, { x: 1, z: 6 }] }] };
    const inside = (x: number, z: number) => x > 1 && x < 12 && z > -6 && z < 6;
    for (let id = 0; id < 40; id++) {
      const view = new AgentsView({ models: false });
      const zz = { id, x: 0.5, z: (id % 9) - 4, vx: 1, vz: 0, speed: 1.5, cold: false, alive: true, diedAt: -1, home: null, goal: null };
      const sim = { zombies: [zz], survivors: [], t: 1, map };
      view.update(sim as never, 0.5);
      view.update(sim as never, 0.9);
      Object.assign(zz, { alive: false, diedAt: 1 });
      if (id % 2) view.impact(-1, zz.z, 3, 1); // blast behind it: "away" points into the wall
      view.update(sim as never, 1);
      const b = (view as unknown as { zombies: { a: Float32Array; b: Float32Array } }).zombies;
      const dir = b.a[2] + b.b[3];
      for (const t of [0.5, 1]) expect(inside(zz.x + Math.sin(dir) * 2.6 * t, zz.z + Math.cos(dir) * 2.6 * t)).toBe(false);
      view.dispose();
    }
  });
});


describe('crowd nights (spec 003): draw list caps, level of detail, death heat', () => {
  const mk = (i: number, alive: boolean, x = i % 100, z = Math.floor(i / 100)) => ({ id: i, x, z, vx: 0.5, vz: 0, speed: 1.4, cold: false, alive, diedAt: alive ? -1 : 1, home: null, goal: null });

  it('Huge: 800 living + 3,000 bodies: every living zombie drawn, at most 400 bodies, never more than 1,200 figures, oldest bodies sink out over >= 1 s', () => {
    const view = new AgentsView({ models: false, lod: { models: 400, bodies: 400 } });
    const zombies = [...Array.from({ length: 3000 }, (_, i) => mk(i, false)), ...Array.from({ length: 800 }, (_, i) => mk(3000 + i, true))];
    const sim = { zombies, survivors: [], t: 10 };
    const drawn = () => (view as unknown as { drawn: number[] }).drawn;
    let t = 0;
    view.update(sim as never, t);
    for (let i = 3000; i < 3800; i++) expect(drawn()).toContain(i);
    // A steady 90 kills a second (Feel's flash scenario B is 50+) for 3 s at 30 fps.
    const rested = new Set<number>();
    const lastSink = new Map<number, number>();
    let prev = new Set<number>(drawn());
    let faded = 0;
    for (let f = 0; f < 90; f++) {
      t += 1 / 30;
      sim.t += 1 / 30;
      for (let n = 0; n < 3; n++) zombies.push(mk(zombies.length, true));
      for (let n = 0; n < 3; n++) Object.assign(zombies[3000 + f * 3 + n], { alive: false, diedAt: sim.t });
      view.update(sim as never, t);
      const d = drawn();
      const now = new Set(d);
      const living = zombies.filter((z) => z.alive).length;
      expect(d.length).toBeLessThanOrEqual(1200);
      expect(d.length - living).toBeLessThanOrEqual(400);
      for (let i = 0; i < zombies.length; i++) if (zombies[i].alive) expect(now.has(i)).toBe(true);
      const sinkOf = (view as unknown as { sinkOf: Map<number, number> }).sinkOf;
      // A body that was drawn resting and is now gone must have sunk all the way first (never a vanish).
      for (const i of prev) {
        if (now.has(i) || zombies[i].alive || !rested.has(i)) continue;
        expect(lastSink.get(i) ?? 0, `body ${i}`).toBeGreaterThan(0.9);
        faded++;
      }
      for (const i of d) if (!zombies[i].alive) (sinkOf.has(i) ? lastSink.set(i, sinkOf.get(i)!) : rested.add(i));
      prev = now;
    }
    expect(BODY_SINK_S).toBeGreaterThanOrEqual(1);
    expect(faded).toBeGreaterThan(100);
    // Newest bodies are kept, oldest gone: the first bodies of all are long gone.
    expect(drawn()).not.toContain(0);
    view.dispose();
  });

  it('LOD parity: the same zombie gets identical heat and visible light in both batches; heights within 5%; mean heat weight recorded', () => {
    const model = bakeModel('tiny', tinyRig(), ['walk', 'idle']);
    const view = new AgentsView({ lod: { models: 1, bodies: 10 }, modelSet: { zombie: model, survivor: model } });
    const zombies = [mk(0, true, 0, 0), mk(1, true, 0, 0)];
    const sim = { zombies, survivors: [], t: 1 };
    // A camera 1,800 m away with a lens that makes a zombie ~40 px tall: one model (the cap), one figure.
    const cam = new THREE.PerspectiveCamera(1.6, 1.6, 600, 6000);
    cam.position.set(0, 1500, 1000);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    cam.updateProjectionMatrix();
    view.update(sim as never, 0, { camera: cam, height: 800 });
    view.update(sim as never, 0.1, { camera: cam, height: 800 });
    const st = view.stats;
    expect(st.modelZombies).toBe(1);
    expect(st.figureZombies).toBe(1);
    const fig = (view as unknown as { zombies: { c: Float32Array } }).zombies.c;
    const mod = (view as unknown as { zm: { d: Float32Array } }).zm.d;
    expect([mod[0], mod[1], mod[2]]).toEqual([fig[0], fig[1], fig[2]]);
    // On-screen height: the crowd figure batch stands as tall as the model (MODEL_HEIGHT x MODEL_DISPLAY_SCALE).
    const uScale = (view as unknown as { zombies: FigureBatch }).zombies.material.uniforms.uScale.value as number;
    expect(Math.abs((HEAD_TOP * uScale) / LOD_HEIGHT_M - 1)).toBeLessThan(0.05);
    // Normal missions keep their figure size.
    expect(((new AgentsView({ models: false }) as unknown as { zombies: FigureBatch }).zombies.material.uniforms.uScale.value as number)).toBe(FIGURE_SCALE);
    // Area-weighted mean heat weight of the figure (the model's is measured on the real model by the playtest).
    const w = meanHeatWeight(new FigureBatch('zombie', 1).mesh.geometry, 'aLimbT');
    expect(w).toBeGreaterThan(0);
    expect(w).toBeLessThan(1);
    view.dispose();
  });

  it('LOD cap and hysteresis: never more models than the cap; a zombie between the two thresholds keeps its batch', () => {
    const model = bakeModel('tiny', tinyRig(), ['walk', 'idle']);
    const view = new AgentsView({ lod: { models: 3, bodies: 10 }, modelSet: { zombie: model, survivor: model } });
    const zombies = Array.from({ length: 10 }, (_, i) => mk(i, true, i * 2, 0));
    const sim = { zombies, survivors: [], t: 1 };
    const cam = new THREE.PerspectiveCamera(1.6, 1.6, 100, 9000);
    const place = (range: number) => {
      cam.position.set(0, range * 0.8, range * 0.6);
      cam.lookAt(0, 0, 0);
      cam.updateMatrixWorld();
      cam.updateProjectionMatrix();
    };
    // Height on screen at a given range (the same sum AgentsView does).
    const px = (range: number) => (LOD_HEIGHT_M * cam.projectionMatrix.elements[5] * 400) / range;
    place(1800);
    expect(px(1800)).toBeGreaterThan(LOD_ENTER_PX);
    for (let f = 0; f < 3; f++) view.update(sim as never, f * 0.05, { camera: cam, height: 800 });
    expect(view.stats.modelZombies).toBe(3);
    // Back off until a zombie is between the thresholds: the models stay models, nobody new becomes one.
    const mid = (LOD_HEIGHT_M * cam.projectionMatrix.elements[5] * 400) / ((LOD_ENTER_PX + LOD_STAY_PX) / 2);
    place(mid);
    for (let f = 0; f < 5; f++) view.update(sim as never, 0.2 + f * 0.05, { camera: cam, height: 800 });
    expect(view.stats.modelZombies).toBe(3);
    // Past the stay threshold: all figures.
    place(mid * 1.5);
    view.update(sim as never, 0.6, { camera: cam, height: 800 });
    expect(view.stats.modelZombies).toBe(0);
    expect(view.stats.figureZombies).toBe(10);
    // Draw calls: one more than a normal mission (both zombie batches).
    expect(view.stats.objects).toBe(4);
    view.dispose();
  });

  it('death heat eases from live over 0.3 s (Feel M3), then follows the body cooling exactly', () => {
    expect(DEATH_EASE).toBeGreaterThanOrEqual(0.3);
    expect(deathHeat(false, false, 0)[0]).toBeCloseTo(HEAT.warmCore);
    expect(deathHeat(false, false, 0.15)[0]).toBeCloseTo((HEAT.warmCore + bodyHeat(false, false, 0.15)[0]) / 2, 2);
    expect(deathHeat(false, false, 0.3)).toEqual(bodyHeat(false, false, 0.3));
    expect(deathHeat(false, true, 0.1)).toEqual([HEAT.cold, HEAT.cold]);
    expect(deathHeat(true, false, -1)).toEqual(bodyHeat(true, false, -1));
  });
});
