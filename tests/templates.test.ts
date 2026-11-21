import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { pointInPolygon } from '../src/map/geom';
import { MISSION_TEMPLATES, TEMPLATE_IDS, type TemplateId } from '../src/map/recon';
import { generateMission, likelyWaveDirections, type Mission } from '../src/sim/missions';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import type { Sim } from '../src/sim/sim';

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);
const ANCHORED = TEMPLATE_IDS.filter((id) => MISSION_TEMPLATES[id].anchors.length > 0);

const build = (template: TemplateId, difficulty: number, seed: number): Mission => {
  const r = generateMission(map, graph, grid, { type: 'auto', difficulty, seed, template });
  if (!r.ok) throw new Error(`${template} d${difficulty} s${seed}: ${r.reason}`);
  return r.mission;
};

function play(sim: Sim, bot: Bot | null, maxT = 900): Sim {
  while (sim.phase === 'running' && sim.t < maxT) {
    bot?.step(1 / 30);
    sim.step(1 / 30);
  }
  return sim;
}

describe('mission templates on the sample town (G5 for templates)', () => {
  it('every template builds a valid mission at every difficulty and several seeds', () => {
    for (const id of TEMPLATE_IDS) {
      for (let d = 1; d <= 5; d++) {
        for (let seed = 1; seed <= 3; seed++) {
          const m = build(id, d, seed);
          const t = MISSION_TEMPLATES[id];
          expect(m.type, id).toBe(t.base);
          expect(m.briefing.length).toBeGreaterThan(2);
          expect(m.intel).toHaveLength(1);
          if (t.base === 'escort') expect(m.route!.length).toBeGreaterThan(2);
          if (t.base === 'clear') expect(m.hordes.length).toBeGreaterThanOrEqual(2);
          if (t.base !== 'clear') expect(m.safehouse).toBeDefined();
          if (t.anchors.length) {
            expect(m.template).toBe(id);
            expect(m.anchor?.name).toBeTruthy();
            expect(m.title).toContain(m.anchor!.name);
          }
          for (const h of m.hordes) expect(grid.isBlocked(h.centre.x, h.centre.z), `${id} horde in a building`).toBe(false);
        }
      }
    }
  });

  it('uses the real place: hordes on the courts, in the woods; the safehouse is the hall or the shop', () => {
    const tennis = build('clear-tennis', 3, 1);
    expect(tennis.hordes.filter((h) => pointInPolygon(h.centre, tennis.anchor!.pts!)).length).toBeGreaterThanOrEqual(1);
    expect(tennis.hordes.some((h) => h.label === 'Orchard Tennis Club')).toBe(true);
    const woods = build('forest-sweep', 3, 1);
    expect(woods.hordes.filter((h) => h.label === 'Grevillea Woods').length).toBeGreaterThanOrEqual(2);
    expect(build('hold-sports', 3, 1).safehouse!.name).toBe('Ironbark Sports Centre');
    expect(build('escort-shops', 3, 1).safehouse!.name).toBe('Sampleton Plaza');
    expect(build('escort-school', 3, 1).safehouse!.name).toBe('Wattle Hill Primary School');
  });

  it('forest sweep has more cold-blooded contacts, and the intel says so with the true numbers', () => {
    for (let d = 1; d <= 5; d++) {
      const m = build('forest-sweep', d, 2);
      const classic = generateMission(map, graph, grid, { type: 'clear', difficulty: d, seed: 2 });
      const share = (h: Mission['hordes']) => h.reduce((s, x) => s + x.cold, 0) / h.reduce((s, x) => s + x.count, 0);
      expect(classic.ok && share(m.hordes) > share(classic.mission.hordes), `d${d}`).toBe(true);
      const inWoods = m.hordes.filter((h) => h.label === 'Grevillea Woods');
      const cold = inWoods.reduce((s, h) => s + h.cold, 0);
      const total = inWoods.reduce((s, h) => s + h.count, 0);
      expect(cold).toBeGreaterThan(0);
      expect(m.intel[0]).toContain(`${cold} of the ${total} contacts in Grevillea Woods are cold-blooded`);
    }
  });

  it('intel is truthful for every template: it mentions cold-blooded contacts exactly when there are some', () => {
    for (const id of TEMPLATE_IDS) {
      for (const d of [1, 4]) {
        const m = build(id, d, 3);
        const r = createSim(map, { type: 'auto', difficulty: d, seed: 3, template: id });
        if (!r.ok) throw new Error(r.reason);
        play(r.sim, null, 60);
        const saysCold = !/no cold-blooded/.test(m.intel[0]);
        const hasCold = r.sim.zombies.some((z) => z.cold) || (m.waves?.coldShare ?? 0) > 0;
        expect(saysCold, `${id} d${d}`).toBe(hasCold);
      }
    }
  }, 60_000);

  it('guardrail: the school escort is about adults only', () => {
    for (let seed = 1; seed <= 3; seed++) {
      const m = build('escort-school', 2, seed);
      expect(m.briefing[0]).toMatch(/adults/);
      expect(m.briefing.join(' ')).not.toMatch(/\b(child|children|kids?|pupils?|students?)\b/i);
    }
  });

  it('is deterministic, and leaves non-template missions unchanged', () => {
    for (const id of ANCHORED) expect(JSON.stringify(build(id, 3, 7))).toBe(JSON.stringify(build(id, 3, 7)));
    const plain = generateMission(map, graph, grid, { type: 'escort', difficulty: 3, seed: 42 });
    expect(plain.ok && plain.mission.template).toBe(undefined);
    // Classic templates are exactly the custom-menu missions.
    const classic = generateMission(map, graph, grid, { type: 'escort', difficulty: 3, seed: 42, template: 'classic-escort' });
    expect(JSON.stringify(classic)).toBe(JSON.stringify(plain));
  });

  it('a chosen anchor is honoured, and a bad one gets a clear reason', () => {
    const ok = generateMission(map, graph, grid, { type: 'clear', difficulty: 2, seed: 1, template: 'clear-park', anchor: 'f-p3,3' });
    expect(ok.ok && ok.mission.anchor!.name).toBe('Kestrel Reserve');
    const bad = generateMission(map, graph, grid, { type: 'clear', difficulty: 2, seed: 1, template: 'clear-park', anchor: 'nope' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toMatch(/Recon found no park/);
    const mismatch = generateMission(map, graph, grid, { type: 'escort', difficulty: 2, seed: 1, template: 'clear-park' });
    expect(mismatch.ok).toBe(false);
    const unknown = generateMission(map, graph, grid, { type: 'auto', difficulty: 2, seed: 1, template: 'kids-at-school' as TemplateId });
    expect(unknown.ok).toBe(false);
  });

  it('defend templates expose likely wave directions for the tactical map', () => {
    const m = build('hold-sports', 3, 1);
    const dirs = likelyWaveDirections(m, map, graph);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs.length).toBeLessThanOrEqual(3);
    for (const w of dirs) expect(Math.hypot(w.from.x - w.to.x, w.from.z - w.to.z)).toBeGreaterThan(150);
    expect(likelyWaveDirections(build('clear-tennis', 3, 1), map, graph)).toEqual([]);
  });

  for (const id of ['clear-tennis', 'forest-sweep', 'hold-sports', 'escort-shops'] as TemplateId[]) {
    it(`${id}: a capable gunner wins on difficulty 1, and doing nothing loses on 3`, () => {
      const r = createSim(map, { type: 'auto', difficulty: 1, seed: 2, template: id });
      if (!r.ok) throw new Error(r.reason);
      play(r.sim, new Bot(r.sim, SKILL.human));
      expect(r.sim.phase, r.sim.reason).toBe('won');
      const idle = createSim(map, { type: 'auto', difficulty: 3, seed: 2, template: id });
      if (!idle.ok) throw new Error(idle.reason);
      play(idle.sim, null);
      expect(idle.sim.phase, idle.sim.reason).toBe('lost');
    }, 60_000);
  }
});
