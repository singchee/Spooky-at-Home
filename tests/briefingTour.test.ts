import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { dist, polylineLength } from '../src/map/geom';
import { CATEGORY_INFO, mapFeatures, MISSION_TEMPLATES, TEMPLATE_IDS } from '../src/map/recon';
import { FIRST_WAVE, generateMission, likelyWaveDirections, placeLabel, type Mission } from '../src/sim/missions';
import { noWaveSpawn, ORBIT } from '../src/sim/sim';
import { createSim } from '../src/sim/setup';
import { dioramaExtent, planTour } from '../src/ui/briefingDiorama';
import {
  angleDelta,
  blendPose,
  framingDist,
  pointAlong,
  stopAt,
  tourKey,
  tourTimeline,
  type Pose,
  type StopKind,
  type TourStop,
} from '../src/ui/briefingTour';
import { clipName, metres, thousands } from '../src/ui/briefingTourText';

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);
const gen = (type: 'clear' | 'escort' | 'defend' | 'auto', difficulty: number, seed: number, template?: (typeof TEMPLATE_IDS)[number]): Mission | null => {
  const r = generateMission(map, graph, grid, { type, difficulty, seed, template });
  return r.ok ? r.mission : null;
};

// Every mission type at three difficulties and several seeds, plus every recon template built around a place.
const MISSIONS: [string, Mission][] = [];
for (const type of ['clear', 'escort', 'defend'] as const) {
  for (const d of [1, 3, 5]) {
    for (const seed of [1, 7, 42]) {
      const m = gen(type, d, seed);
      if (m) MISSIONS.push([`${type} d${d} s${seed}`, m]);
    }
  }
}
for (const id of TEMPLATE_IDS.filter((t) => MISSION_TEMPLATES[t].anchors.length > 0)) {
  for (const seed of [1, 2]) {
    const m = gen('auto', 3, seed, id);
    if (m) MISSIONS.push([`recon ${id} s${seed}`, m]);
  }
}
const tours = new Map(MISSIONS.map(([name, m]) => [name, planTour(map, m, graph, grid)]));

/** Where each kind of stop may come in the walk-through. */
const RANK: Record<StopKind, number> = { area: 0, safehouse: 1, home: 1, survivors: 2, friendlies: 2, stragglers: 2, horde: 3, waves: 3, route: 3, orbit: 4 };
/** Numbers said in a caption (with thousands separators and decimals). */
const numbersIn = (s: string): number[] => (s.match(/\d[\d,]*(\.\d+)?/g) ?? []).map((x) => Number(x.replace(/,/g, '')));
/** The value of a "{name} {number}" style claim in a briefing line. */
const briefingMatch = (m: Mission, re: RegExp): RegExpMatchArray | null => m.briefing.map((l) => l.match(re)).find(Boolean) ?? null;
const sector = (from: { x: number; z: number }, to: { x: number; z: number }) => Math.round((((Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI + 360) % 360) / 45) % 8;
const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];

describe('walk-through stops', () => {
  it('covers every mission type and recon template', () => {
    const types = new Set(MISSIONS.map(([, m]) => m.type));
    expect([...types].sort()).toEqual(['clear', 'defend', 'escort']);
    expect(MISSIONS.some(([, m]) => m.template)).toBe(true);
  });

  it('visits area → safehouse/home → people → each threat → orbit, in that order', () => {
    for (const [name, m] of MISSIONS) {
      const stops = tours.get(name)!;
      expect(stops[0].kind, name).toBe('area');
      expect(stops[stops.length - 1].kind, name).toBe('orbit');
      for (let i = 1; i < stops.length; i++) expect(RANK[stops[i].kind], `${name}: ${stops.map((s) => s.kind)}`).toBeGreaterThanOrEqual(RANK[stops[i - 1].kind]);
      const kinds = stops.map((s) => s.kind);
      const ids = stops.map((s) => s.id);
      expect(new Set(ids).size, name).toBe(ids.length);
      if (m.type === 'clear') {
        // One stop per horde place (hordes at one place share a label and a stop), and the friendlies.
        expect(kinds.filter((k) => k === 'horde').length, name).toBe(new Set(m.hordes.map((h) => h.label)).size);
        expect(kinds, name).toContain('friendlies');
      }
      if (m.type === 'escort') expect(kinds, name).toEqual(['area', 'home', 'survivors', 'route', 'orbit']);
      if (m.type === 'defend') {
        expect(kinds.slice(0, 2), name).toEqual(['area', 'safehouse']);
        expect(kinds.filter((k) => k === 'waves').length, name).toBe(likelyWaveDirections(m, map, graph).length);
        expect(kinds.includes('stragglers'), name).toBe(m.survivors.length > 0);
      }
    }
  });

  it('is built from the mission alone: the same mission gives the same tour', () => {
    for (const [name, m] of MISSIONS.slice(0, 6)) {
      const again = planTour(map, m, graph, grid);
      expect(again.map((s) => [s.id, s.caption]), name).toEqual(tours.get(name)!.map((s) => [s.id, s.caption]));
    }
  });

  it('runs 15–20 s, with every stop on screen long enough to read', () => {
    for (const [name, stops] of tours) {
      const tl = tourTimeline(stops);
      expect(tl.total, name).toBeGreaterThanOrEqual(15);
      expect(tl.total, name).toBeLessThanOrEqual(20);
      tl.segs.forEach((s, i) => {
        expect(s.move + s.hold, `${name} stop ${i}`).toBeGreaterThanOrEqual(1.95);
        if (i) expect(s.t0, name).toBeCloseTo(tl.segs[i - 1].t0 + tl.segs[i - 1].move + tl.segs[i - 1].hold);
      });
      // Every stop comes up, in order, as the clock runs.
      const seen: number[] = [];
      for (let t = 0; t < tl.total; t += 0.05) {
        const i = stopAt(tl, t);
        if (i >= 0 && seen[seen.length - 1] !== i) seen.push(i);
      }
      expect(seen, name).toEqual(stops.map((_, i) => i));
    }
  });

  it('frames every subject inside the diorama', () => {
    for (const [name, m] of MISSIONS) {
      const b = dioramaExtent(map, m);
      for (const s of tours.get(name)!) {
        const p = s.focus.p;
        expect(p.x >= b.x0 - 1 && p.x <= b.x1 + 1 && p.z >= b.z0 - 1 && p.z <= b.z1 + 1, `${name} ${s.id}`).toBe(true);
        expect(s.focus.r, `${name} ${s.id}`).toBeGreaterThan(0);
      }
    }
  });
});

describe('walk-through captions are true (hard rule 9)', () => {
  const check = (name: string, m: Mission, s: TourStop) => {
    const c = s.caption;
    const where = `${name} ${s.id}: "${c}"`;
    expect(c.length, where).toBeLessThanOrEqual(120);
    let allowed: number[] = [];
    switch (s.kind) {
      case 'area': {
        const b = dioramaExtent(map, m);
        const across = Math.round(Math.max(b.x1 - b.x0, b.z1 - b.z0) / 50) * 50;
        expect(c, where).toContain(`${thousands(across)} m`);
        allowed = [across];
        // Landmarks named are real, public, named places inside the model; never schools and the like.
        const inside = mapFeatures(map).filter((f) => f.name && f.p.x >= b.x0 && f.p.x <= b.x1 && f.p.z >= b.z0 && f.p.z <= b.z1);
        for (const f of mapFeatures(map)) {
          if (!f.name || !c.includes(clipName(f.name))) continue;
          expect(inside.some((g) => g.name === f.name), where).toBe(true);
        }
        for (const f of inside) if (['school', 'kindergarten', 'playground'].includes(f.category)) expect(c.includes(f.name!), where).toBe(false);
        const named = inside.filter((f) => !['school', 'kindergarten', 'playground'].includes(f.category) && CATEGORY_INFO[f.category].weight >= 4);
        if (named.length) expect(named.some((f) => c.includes(clipName(f.name!))), `${where} names no landmark`).toBe(true);
        break;
      }
      case 'safehouse': {
        const hold = briefingMatch(m, /Hold it for (\d+:\d\d)\./)![1];
        expect(c, where).toContain(`Hold it for ${hold}.`);
        expect(c.toLowerCase(), where).toContain(clipName(m.safehouse!.name).toLowerCase());
        allowed = hold.split(':').map(Number);
        break;
      }
      case 'home': {
        const street = briefingMatch(m, /a house on (.+?), about/)![1];
        expect(street, where).toBe(m.home!.street);
        expect(c, where).toContain(`a house on ${clipName(street)}.`);
        const need = Number(briefingMatch(m, /If fewer than (\d+) make it home/)![1]);
        expect(c, where).toContain(`at least ${need} of the ${m.survivors.length}`);
        allowed = [need, m.survivors.length];
        break;
      }
      case 'survivors': {
        const n = Number(briefingMatch(m, /(\d+) (?:survivors|late-night shoppers|passengers)/)![1]);
        expect(n, where).toBe(m.survivors.length);
        const delay = Math.min(...m.survivors.map((x) => x.delay));
        expect(c, where).toContain(`${n} survivors holed up at ${clipName(m.safehouse!.name)}`);
        expect(c, where).toContain(`${delay} s after you start`);
        // The sim agrees: nobody moves before then.
        const r = createSim(map, { type: m.type, difficulty: m.difficulty, seed: m.seed, template: m.template, anchor: m.anchor?.id });
        if (!r.ok) throw new Error(r.reason);
        const start = r.sim.survivors.map((x) => ({ x: x.x, z: x.z }));
        for (let t = 0; t < delay - 0.2; t += 0.1) r.sim.step(0.1);
        r.sim.survivors.forEach((x, i) => expect(dist(x, start[i]), where).toBeLessThan(0.5));
        allowed = [n, delay];
        break;
      }
      case 'friendlies': {
        const sheltering = m.survivors.filter((x) => !x.route);
        const place = briefingMatch(m, /sheltering near (.+)\. Mind your aim\./)![1];
        expect(c, where).toContain(`${sheltering.length} friendlies sheltering near ${clipName(place)}.`);
        // ...and that place really is near them: a horde gathers there, close by.
        const at = m.hordes.filter((h) => h.label === place);
        expect(Math.min(...at.map((h) => dist(h.centre, sheltering[0].start))), where).toBeLessThan(200);
        allowed = [sheltering.length];
        break;
      }
      case 'stragglers': {
        const street = briefingMatch(m, /stragglers are on their way in along (.+)\. Don't hit them\./)![1];
        expect(c, where).toContain(`${m.survivors.length} stragglers walking in along ${clipName(street)}.`);
        allowed = [m.survivors.length];
        break;
      }
      case 'horde': {
        const k = Number(s.id.slice(5));
        const places = [...new Set(m.hordes.map((h) => h.label))];
        const hs = m.hordes.filter((h) => h.label === places[k]);
        const count = hs.reduce((n, h) => n + h.count, 0);
        const cold = hs.reduce((n, h) => n + h.cold, 0);
        expect(c, where).toContain(clipName(places[k]));
        expect(c, where).toContain(hs.length > 1 ? `${hs.length} hordes at` : `Horde of ${count} at`);
        if (hs.length > 1) expect(c, where).toContain(`${count} in all`);
        if (cold) expect(c, where).toMatch(new RegExp(`\\. ${cold} (of them run cold|cold-blooded|running cold)`));
        else expect(c, where).not.toMatch(/cold/);
        allowed = [hs.length, count, cold];
        break;
      }
      case 'waves': {
        const i = Number(s.id.slice(4));
        const w = likelyWaveDirections(m, map, graph)[i];
        expect(c, where).toContain(`Waves come from the ${w.compass}`);
        // Each place named is what the sim announces for a wave spawning at a road node it may use, in that direction.
        const ref = m.safehouse!.centre;
        const banned = noWaveSpawn(map, graph);
        const field = grid.flowField(grid.perimeterCells(m.safehouse!.poly));
        const lim = map.half * 0.95;
        const announced = new Set<string>();
        graph.nodes.forEach((n, j) => {
          if (graph.comp[j] !== graph.mainComp || banned[j] || Math.abs(n.x) > lim || Math.abs(n.z) > lim) return;
          const r = dist(n, ref);
          if (r < m.waves!.minDist || r > m.waves!.maxDist || grid.fieldAt(field, n.x, n.z) <= 0) return;
          if (COMPASS[sector(ref, n)] === w.compass) announced.add(placeLabel(map, n));
        });
        const around = c.match(/, around (.+?)\./)?.[1];
        if (around) for (const p of around.split(/, | and /)) expect([...announced].map(clipName), where).toContain(p);
        if (i === 0) expect(c, where).toContain(`First one ${FIRST_WAVE} s after you start.`);
        allowed = i === 0 ? [FIRST_WAVE] : [];
        break;
      }
      case 'route': {
        const length = Number(briefingMatch(m, /about (\d+) m away by road/)![1]);
        expect(length, where).toBe(Math.round(polylineLength(m.route!) / 10) * 10);
        expect(c, where).toContain(`about ${thousands(length)} m by road`);
        const via = briefingMatch(m, /, via (.+)\.$/)?.[1];
        if (via) expect(c, where).toContain(`via ${via.split(/, | and /).map(clipName).join(', ').replace(/, ([^,]*)$/, ' and $1')}.`);
        else expect(c, where).not.toContain('via');
        allowed = [length];
        break;
      }
      case 'orbit': {
        expect(c, where).toContain(clipName(placeLabel(map, m.orbitCentre)));
        expect(c, where).toContain(`${metres(ORBIT.radius)} out, ${thousands(ORBIT.altitude)} m up`);
        // The direction is the sim's: seen from above (north up, x east, z south), the gunship turns this way.
        const r = createSim(map, { type: m.type, difficulty: m.difficulty, seed: m.seed, template: m.template, anchor: m.anchor?.id });
        if (!r.ok) throw new Error(r.reason);
        const a0 = r.sim.aircraft(0);
        const a1 = r.sim.aircraft(1);
        const o = m.orbitCentre;
        // Cross product of successive positions about the centre: with z pointing south, negative = anticlockwise on the map.
        const cross = (a0.x - o.x) * (a1.z - o.z) - (a0.z - o.z) * (a1.x - o.x);
        expect(c, where).toContain(cross < 0 ? 'anticlockwise' : 'clockwise');
        allowed = [...numbersIn(metres(ORBIT.radius)), ORBIT.altitude];
        break;
      }
    }
    // No number in a caption that the mission doesn't back up (place names may carry their own digits).
    const nameDigits = new Set(numbersIn([...map.roads.map((r) => r.name ?? ''), ...mapFeatures(map).map((f) => f.name ?? ''), m.safehouse?.name ?? ''].join(' ')));
    for (const n of numbersIn(c)) expect(allowed.includes(n) || nameDigits.has(n), `${where}: ${n} isn't from the mission`).toBe(true);
  };

  it('says only what the mission data says, for every stop of every mission', () => {
    for (const [name, m] of MISSIONS) for (const s of tours.get(name)!) check(name, m, s);
  });

  it('the first wave really comes when the caption says', () => {
    const m = MISSIONS.find(([, x]) => x.type === 'defend')![1];
    const r = createSim(map, { type: 'defend', difficulty: m.difficulty, seed: m.seed });
    if (!r.ok) throw new Error(r.reason);
    let first = -1;
    for (let i = 0; i < 200 && first < 0; i++) {
      r.sim.step(0.05);
      if (r.sim.drainEvents().some((e) => e.type === 'wave')) first = r.sim.t;
    }
    expect(first).toBeGreaterThan(0);
    expect(Math.abs(first - FIRST_WAVE)).toBeLessThan(0.15);
  });

  it('never names the map itself (a typed address can name a map) and keeps names short', () => {
    for (const [name, stops] of tours) {
      for (const s of stops) {
        if (map.name.length > 3) expect(s.caption.includes(map.name), `${name} ${s.id}`).toBe(false);
        expect(s.caption, `${name} ${s.id}`).not.toMatch(/undefined|NaN|null/);
      }
    }
  });
});

describe('walk-through camera maths', () => {
  const a: Pose = { x: 0, y: 0, z: 0, dist: 400, az: 3, elev: 1, shift: 0.1 };
  const b: Pose = { x: 200, y: 10, z: -100, dist: 200, az: -3, elev: 0.6, shift: 0 };
  it('moves start and end exactly on the stops, turning the short way round', () => {
    const s = blendPose(a, b, 0);
    const e = blendPose(a, b, 1);
    expect(s.x).toBeCloseTo(a.x);
    expect(s.dist).toBeCloseTo(a.dist);
    expect(e.x).toBeCloseTo(b.x);
    expect(e.dist).toBeCloseTo(b.dist);
    expect(Math.cos(e.az)).toBeCloseTo(Math.cos(b.az));
    // 3 → -3 rad is a 0.28 rad turn through π, not 6 rad the long way.
    expect(Math.abs(angleDelta(3, -3))).toBeCloseTo(Math.PI * 2 - 6);
    const half = blendPose(a, b, 0.5);
    expect(Math.abs(half.az - 3)).toBeLessThan(0.2);
    // A long move rises a little in the middle (a flyover).
    expect(half.dist).toBeGreaterThan(Math.sqrt(a.dist * b.dist));
  });

  it('frames bigger subjects from further away, and narrow pictures from further still', () => {
    expect(framingDist(100, 1, 30)).toBeGreaterThan(framingDist(50, 1, 30));
    expect(framingDist(100, 0.5, 30)).toBeGreaterThan(framingDist(100, 1, 30));
  });

  it('walks along a polyline', () => {
    const pts = [{ x: 0, z: 0 }, { x: 100, z: 0 }, { x: 100, z: 50 }];
    expect(pointAlong(pts, 0)).toEqual({ x: 0, z: 0 });
    expect(pointAlong(pts, 120)).toEqual({ x: 100, z: 20 });
    expect(pointAlong(pts, 999)).toEqual({ x: 100, z: 50 });
  });

  it('remembers tours per mission, not per map', () => {
    const [, m1] = MISSIONS[0];
    const m2 = { ...m1, seed: m1.seed + 1 };
    expect(tourKey(m1)).not.toBe(tourKey(m2));
    expect(tourKey(m1)).toBe(tourKey({ ...m1 }));
  });
});
