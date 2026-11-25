import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { distToSegment } from '../src/map/geom';
import { generateMission, HORDE_WANDER, SCATTER_LEASH, type Mission, type MissionOptions } from '../src/sim/missions';
import { Sim, type SimEvent, type Zombie } from '../src/sim/sim';
import { Bot, SKILL } from '../src/sim/bot';
import type { V2 } from '../src/map/types';

/** Spec 002: in Clear missions a 105 round scatters the horde zombies it doesn't kill; they regroup later. */
const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);
const CLEAR_TEMPLATES = ['classic-clear', 'clear-tennis', 'clear-park', 'forest-sweep'] as const;

function mission(opts: MissionOptions): Mission {
  const r = generateMission(map, graph, grid, opts);
  if (!r.ok) throw new Error(r.reason);
  return r.mission;
}
const sim = (opts: MissionOptions, o?: { scatter?: boolean; drift?: boolean }) => new Sim(mission(opts), map, graph, grid, o);
const runners = (s: Sim) => s.zombies.filter((z) => z.alive && (z.scatter ?? 0) > 0);
/** Fire one gun at a point and play until it lands (and a moment more). */
function shoot(s: Sim, gun: string, at: V2): SimEvent[] {
  expect(s.fire(gun, at)).toBe(true);
  const ev: SimEvent[] = [];
  for (let i = 0; i < 300 && !ev.some((e) => e.type === 'impact'); i++) {
    s.step(1 / 30);
    ev.push(...s.drainEvents());
  }
  return ev;
}
/** The point of the most crowded horde: its gathering point. */
const hordeAt = (s: Sim): V2 => ({ ...s.mission.hordes.reduce((a, h) => (h.count > a.count ? h : a)).centre });
/** Where a horde zombie may be: its gathering point, or the drifting horde's line to the sheltering friendlies (as Sim picks it). */
function hordePaths(m: Mission): Map<string, [V2, V2]> {
  const out = new Map<string, [V2, V2]>();
  const shelter = m.survivors.find((s) => !s.route);
  let drifter = -1;
  if (shelter && m.hordes.length) {
    drifter = 0;
    m.hordes.forEach((h, k) => {
      if (Math.hypot(h.centre.x - shelter.start.x, h.centre.z - shelter.start.z) < Math.hypot(m.hordes[drifter].centre.x - shelter.start.x, m.hordes[drifter].centre.z - shelter.start.z)) drifter = k;
    });
  }
  m.hordes.forEach((h, k) => out.set(`${h.centre.x},${h.centre.z}`, [h.centre, k === drifter ? shelter!.start : h.centre]));
  return out;
}

describe('spec 002: shelled hordes scatter, then regroup (Clear only)', () => {
  it('1. only the 105 scatters, only in Clear, only horde zombies; Training can opt out', () => {
    for (const gun of ['40', '25']) {
      const s = sim({ type: 'clear', difficulty: 3, seed: 4 });
      shoot(s, gun, hordeAt(s));
      expect(runners(s).length, gun).toBe(0);
    }
    for (const type of ['escort', 'defend'] as const) {
      const s = sim({ type, difficulty: 3, seed: 4 });
      for (let i = 0; i < 300; i++) s.step(1 / 30); // the first wave is on the ground
      const z = s.zombies.find((x) => x.alive)!;
      shoot(s, '105', { x: z.x + 20, z: z.z });
      expect(s.zombies.filter((x) => (x.scatter ?? 0) > 0).length, type).toBe(0);
    }
    const off = sim({ type: 'clear', difficulty: 3, seed: 4 }, { scatter: false });
    shoot(off, '105', hordeAt(off));
    expect(runners(off).length).toBe(0);
    // ...and the same shot with scatter on does make runners.
    const on = sim({ type: 'clear', difficulty: 3, seed: 4 });
    shoot(on, '105', hordeAt(on));
    expect(runners(on).length).toBeGreaterThan(0);
  });

  it('2. runners head away from where the round landed, and a radio line names the true regroup place', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const s = sim({ type: 'clear', difficulty: 3, seed });
      const ev = shoot(s, '105', hordeAt(s));
      const hit = ev.find((e) => e.type === 'impact')!;
      if (hit.type !== 'impact') throw new Error();
      const rs = runners(s);
      expect(rs.length).toBeGreaterThan(0);
      for (const z of rs) {
        const d = z.scatterDir!;
        expect(d.x * (z.x - hit.x) + d.z * (z.z - hit.z), `seed ${seed} zombie ${z.id}`).toBeGreaterThan(0);
      }
      const line = ev.find((e) => e.type === 'radio' && /scattering/i.test(e.text));
      expect(line, `seed ${seed}`).toBeTruthy();
      const labels = s.regroupPoints().map((p) => p.label);
      expect(labels.length).toBeGreaterThan(0);
      if (line?.type === 'radio') expect(labels.some((l) => line.text.includes(l))).toBe(true);
    }
  });

  it('3. leash: with the bot firing, no runner is ever farther than SCATTER_LEASH from its horde path', () => {
    let checked = 0;
    for (const template of CLEAR_TEMPLATES) {
      for (const d of [1, 3, 5]) {
        for (let seed = 1; seed <= 4; seed++) {
          const s = sim({ type: 'auto', difficulty: d, seed, template });
          const paths = hordePaths(s.mission);
          const homes = new Map<Zombie, [V2, V2]>();
          for (const z of s.zombies) homes.set(z, paths.get(`${z.home!.x},${z.home!.z}`)!);
          const bot = new Bot(s, SKILL.human);
          let worst = 0;
          while (s.phase === 'running' && s.t < 150) {
            bot.step(1 / 30);
            s.step(1 / 30);
            for (const z of s.zombies) {
              if (!z.alive || !z.scatter) continue;
              const [a, b] = homes.get(z)!;
              worst = Math.max(worst, distToSegment(z, a, b));
              checked++;
            }
          }
          expect(worst, `${template} d${d} s${seed}`).toBeLessThanOrEqual(SCATTER_LEASH + 0.01);
        }
      }
    }
    expect(checked).toBeGreaterThan(10_000);
  }, 300_000);

  it('4. regroup: after one 105 and nothing else, every runner is back milling at its gathering point', () => {
    let scattered = 0;
    for (const d of [1, 3, 5]) {
      for (let seed = 1; seed <= 4; seed++) {
        // Without the drifting horde: it is never the target here, and once it overran the friendlies the sim stopped
        // and the waits below never ended (the test hung). Every assertion is unchanged.
        const s = sim({ type: 'clear', difficulty: d, seed }, { drift: false });
        // Not the horde that drifts to the friendlies (its anchor moves and it may chase them): a still one.
        const paths = hordePaths(s.mission);
        const still = s.mission.hordes.filter((h) => { const [a, b] = paths.get(`${h.centre.x},${h.centre.z}`)!; return a === b; });
        const target = still.reduce((a, h) => (h.count > a.count ? h : a)).centre;
        while (s.t < 20) s.step(1 / 30);
        shoot(s, '105', target);
        const rs = runners(s);
        if (!rs.length) continue; // a small horde can die to one round
        scattered += rs.length;
        const minSpeed = Math.min(...rs.map((z) => z.speed));
        const by = Math.max(...rs.map((z) => z.scatterT!)) + SCATTER_LEASH / minSpeed + 5;
        while (s.t < by) s.step(1 / 30);
        for (const z of rs) {
          if (!z.alive) continue;
          expect(z.scatter, `d${d} s${seed} zombie ${z.id}`).toBe(0);
          expect(Math.hypot(z.x - target.x, z.z - target.z), `d${d} s${seed} zombie ${z.id}`).toBeLessThanOrEqual(HORDE_WANDER + 2);
        }
        expect(s.regroupPoints().length).toBe(0);
      }
    }
    expect(scattered).toBeGreaterThan(15);
  }, 120_000);

  it('5. determinism: the same scripted shots give the same Clear, and a shot really changes it', () => {
    const trace = (fireAt20: boolean) => {
      const s = sim({ type: 'clear', difficulty: 3, seed: 42 });
      const at = hordeAt(s);
      while (s.t < 60) {
        if (fireAt20 && s.t >= 20 && s.shots === 0) s.fire('105', at);
        s.step(1 / 60);
      }
      const q = (v: number) => Math.round(v * 1000);
      return JSON.stringify({ st: s.state(), z: s.zombies.map((z) => [z.id, q(z.x), q(z.z), z.alive ? 1 : 0, z.scatter ?? 0]) });
    };
    const a = trace(true);
    expect(trace(true)).toBe(a);
    expect(trace(false)).not.toBe(a);
  });

  it('6. intel: briefed horde sizes and cold counts are exactly the zombies the sim starts with, every Clear template', () => {
    for (const template of CLEAR_TEMPLATES) {
      for (const d of [1, 3, 5]) {
        for (const seed of [1, 7]) {
          const s = sim({ type: 'auto', difficulty: d, seed, template });
          const m = s.mission;
          expect(s.zombies.length).toBe(m.hordes.reduce((a, h) => a + h.count, 0));
          m.hordes.forEach((h) => {
            const mine = s.zombies.filter((z) => z.home!.x === h.centre.x && z.home!.z === h.centre.z);
            expect(mine.length, `${template} d${d} s${seed} ${h.label}`).toBe(h.count);
            expect(mine.filter((z) => z.cold).length).toBe(h.cold);
          });
        }
      }
    }
  });

  it('7. lines: few-left fires once at 5 or fewer; cold-leftovers beats it when all that is left is cold', () => {
    const lines = (coldOnly: boolean) => {
      const s = sim({ type: 'auto', difficulty: 3, seed: 2, template: 'forest-sweep' });
      const cold = s.zombies.filter((z) => z.cold).slice(0, 4);
      const keep = coldOnly ? cold : [...cold, s.zombies.find((z) => !z.cold)!];
      expect(cold.length).toBe(4);
      for (const z of s.zombies) if (!keep.includes(z)) z.alive = false;
      const out: string[] = [];
      for (let i = 0; i < 90; i++) {
        s.step(1 / 30);
        for (const e of s.drainEvents()) if (e.type === 'line') out.push(`${e.id}:${e.left}`);
      }
      return out;
    };
    expect(lines(false)).toEqual(['few-left:5']);
    expect(lines(true)).toEqual(['cold-leftovers:4']);
  });
});
