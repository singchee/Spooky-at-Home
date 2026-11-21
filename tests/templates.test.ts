import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { distToSegment, pointInPolygon } from '../src/map/geom';
import { MISSION_TEMPLATES, TEMPLATE_IDS, type TemplateId } from '../src/map/recon';
import { generateMission, likelyWaveDirections, type Mission } from '../src/sim/missions';
import { createSim } from '../src/sim/setup';
import { Bot, SKILL } from '../src/sim/bot';
import type { Sim } from '../src/sim/sim';
import type { Building, MapData, Road, V2 } from '../src/map/types';

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

  it('guardrail (PLAN §9, issue #11): no safehouse, anchor or horde within 50 m of a school, kindergarten or playground', () => {
    // Every template, difficulty and seed, on the sample town and on a town whose only landmark is a school.
    const schoolTown = schoolOnlyTown();
    const towns = [
      { m: map, g: graph, w: grid, mustBuild: true },
      { m: schoolTown, g: buildRoadGraph(schoolTown), w: new WalkGrid(schoolTown), mustBuild: false },
    ];
    for (const { m: town, g, w, mustBuild } of towns) {
      const zones = childPlaces(town);
      expect(zones.length, town.name).toBeGreaterThan(0);
      let built = 0;
      for (const id of TEMPLATE_IDS) {
        for (let d = 1; d <= 5; d++) {
          for (let seed = 1; seed <= 5; seed++) {
            const r = generateMission(town, g, w, { type: 'auto', difficulty: d, seed, template: id });
            if (!r.ok) {
              expect(mustBuild, `${town.name} ${id} d${d} s${seed}: ${r.reason}`).toBe(false);
              continue;
            }
            built++;
            const at = `${town.name} ${id} d${d} s${seed}`;
            const m = r.mission;
            if (m.safehouse) expect(nearestChildPlace(zones, m.safehouse.centre), `${at} safehouse ${m.safehouse.name}`).toBeGreaterThanOrEqual(50);
            if (m.anchor) expect(nearestChildPlace(zones, m.anchor.p), `${at} anchor ${m.anchor.name}`).toBeGreaterThanOrEqual(50);
            for (const h of m.hordes) expect(nearestChildPlace(zones, h.centre), `${at} horde at ${h.label}`).toBeGreaterThanOrEqual(50);
          }
        }
      }
      // The school-only town still gets missions: just not at the school.
      expect(built, town.name).toBeGreaterThan(TEMPLATE_IDS.length);
    }
    // The school is the biggest building in the middle of that town, and it is never the safehouse.
    for (const type of ['escort', 'defend'] as const) {
      const r = generateMission(schoolTown, buildRoadGraph(schoolTown), new WalkGrid(schoolTown), { type, difficulty: 3, seed: 1 });
      expect(r.ok && r.mission.safehouse!.name, type).not.toMatch(/school/i);
    }
  }, 120_000);

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

const rect = (x0: number, z0: number, x1: number, z1: number): V2[] => [{ x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 }, { x: x0, z: z1 }];

/** A synthetic grid town (local metres only) whose one landmark is a school in the middle, its biggest building. */
function schoolOnlyTown(): MapData {
  const roads: Road[] = [];
  const buildings: Building[] = [];
  for (let i = -4; i <= 4; i++) {
    const ns: V2[] = [];
    const ew: V2[] = [];
    for (let j = -4; j <= 4; j++) {
      ns.push({ x: i * 100, z: j * 100 });
      ew.push({ x: j * 100, z: i * 100 });
    }
    roads.push({ id: `ns${i}`, pts: ns, kind: 'residential', width: 7, name: `Street ${i + 5}` });
    roads.push({ id: `ew${i}`, pts: ew, kind: 'residential', width: 7, name: `Avenue ${i + 5}` });
  }
  let id = 0;
  for (let bx = -4; bx < 4; bx++) {
    for (let bz = -4; bz < 4; bz++) {
      if (bx === 0 && bz === 0) continue; // the school's block
      const x0 = bx * 100;
      const z0 = bz * 100;
      for (const [dx, dz] of [[20, 15], [60, 15], [20, 75], [60, 75]]) buildings.push({ id: `h${id++}`, pts: rect(x0 + dx, z0 + dz, x0 + dx + 12, z0 + dz + 10), height: 6, kind: 'house' });
    }
  }
  buildings.push({ id: 'school-hall', pts: rect(20, 30, 80, 70), height: 9, kind: 'school', name: 'Gridville High School' });
  const grounds = rect(8, 8, 92, 92);
  return {
    name: 'Gridville (school only)', half: 450, buildings, roads, areas: [], attribution: 'test',
    pois: [{ id: 'school', p: { x: 50, z: 50 }, kind: 'school', name: 'Gridville High School' }],
    features: [{ id: 'f-school', category: 'school', name: 'Gridville High School', p: { x: 50, z: 50 }, pts: grounds }],
  };
}

/** Schools, kindergartens and playgrounds, worked out here independently of the code under test. */
function childPlaces(town: MapData): { p: V2; pts?: V2[] }[] {
  const out: { p: V2; pts?: V2[] }[] = [];
  for (const f of town.features ?? []) if (['school', 'kindergarten', 'playground'].includes(f.category)) out.push({ p: f.p, pts: f.pts });
  for (const p of town.pois) if (['school', 'kindergarten', 'playground'].includes(p.kind)) out.push({ p: p.p });
  for (const b of town.buildings) if (['school', 'kindergarten'].includes(b.kind)) out.push({ p: b.pts[0], pts: b.pts });
  return out;
}

/** Metres from a point to the nearest child place (0 inside one). */
function nearestChildPlace(zones: { p: V2; pts?: V2[] }[], p: V2): number {
  let best = Infinity;
  for (const z of zones) {
    best = Math.min(best, Math.hypot(p.x - z.p.x, p.z - z.p.z));
    if (!z.pts) continue;
    if (pointInPolygon(p, z.pts)) return 0;
    for (let i = 0, j = z.pts.length - 1; i < z.pts.length; j = i++) best = Math.min(best, distToSegment(p, z.pts[j], z.pts[i]));
  }
  return best;
}
