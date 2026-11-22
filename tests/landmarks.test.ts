import { describe, expect, it } from 'vitest';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { CHILD_CATEGORIES, CHILD_KINDS, MISSION_TEMPLATES, TEMPLATE_IDS, isChildPlaceKind } from '../src/map/recon';
import type { MapData } from '../src/map/types';
import { generateMission, type Mission } from '../src/sim/missions';
import { LANDMARK_MAX_CHARS, MAX_LANDMARKS, labelWidth, landmarkList, landmarkOpacity, placeLandmarks, reticleRects, type LandmarkIn, type Rect } from '../src/ui/landmarks';

const map = makeSampleTown();
const graph = buildRoadGraph(map);
const grid = new WalkGrid(map);
const mission = (type: 'clear' | 'escort' | 'defend', seed = 7, template?: (typeof TEMPLATE_IDS)[number]): Mission => {
  const r = generateMission(map, graph, grid, { type: template ? 'auto' : type, difficulty: 3, seed, template });
  if (!r.ok) throw new Error(r.reason);
  return r.mission;
};
const anchored = TEMPLATE_IDS.find((id) => MISSION_TEMPLATES[id].anchors.length > 0)!;
const MISSIONS: [string, Mission][] = [
  ['clear', mission('clear')],
  ['escort', mission('escort')],
  ['defend', mission('defend')],
  [`recon ${anchored}`, mission('clear', 1, anchored)],
];
const CHILD_WORDS = /school|kindergarten|childcare|child care|playground|nursery|preschool|creche|crèche|college/i;

/** The sample town plus every kind of child place, named and as other kinds named after one. */
function withChildPlaces(m: MapData): MapData {
  const features = [...(m.features ?? [])];
  const pois = [...m.pois];
  let k = 0;
  for (const c of CHILD_CATEGORIES) features.push({ id: `cf${k}`, category: c, name: `Test ${c} ${k}`, p: { x: 300 + k * 40, z: -300 } }), k++;
  for (const kind of [...CHILD_KINDS, 'childcare', 'playground']) pois.push({ id: `cp${k}`, p: { x: -300 + k * 40, z: 300 }, kind, name: `Little Acorns ${k}` }), k++;
  // Places filed as something else but named after (or sitting inside) a child place.
  features.push({ id: 'oval', category: 'pitch', name: 'Wattle Hill Primary School Oval', p: { x: 0, z: 420 } });
  features.push({ id: 'kc', category: 'sports_centre', name: 'Busy Bees Childcare Centre', p: { x: 40, z: 420 } });
  pois.push({ id: 'lib-in-school', p: { ...features.find((f) => f.category === 'school')!.p }, kind: 'library', name: 'Reading Room' });
  pois.push({ id: 'lib', p: { x: 120, z: -60 }, kind: 'library', name: 'Sampleton Library' });
  return { ...m, features, pois };
}

describe('landmark markers (3.19)', () => {
  const rich = withChildPlaces(map);

  it('never lists a school, kindergarten, childcare, college or playground, by kind, by name or by position', () => {
    const childIds = new Set([
      ...(rich.features ?? []).filter((f) => isChildPlaceKind(f.category)).map((f) => f.id),
      ...rich.pois.filter((p) => isChildPlaceKind(p.kind)).map((p) => p.id),
      'oval', 'kc', 'lib-in-school',
    ]);
    for (const [name, m] of MISSIONS) {
      const list = landmarkList(rich, m);
      expect(list.length, name).toBeGreaterThan(3);
      for (const l of list) {
        expect(childIds.has(l.id), `${name}: ${l.id} ${l.label}`).toBe(false);
        expect(l.label, name).not.toMatch(CHILD_WORDS);
      }
    }
    // The sample town's real school and playground are on the map: never listed.
    const labels = landmarkList(map, MISSIONS[0][1]).map((l) => l.label);
    expect(labels.some((t) => /Wattle Hill|Playground/.test(t))).toBe(false);
  });

  it('lists public places: sports, shops, station, police, hospital, library', () => {
    const labels = landmarkList(rich, MISSIONS[0][1]).map((l) => l.label);
    for (const want of ['Orchard Tennis Club', 'Sampleton Plaza', 'Sampleton Police Station', 'St Kestrel Hospital', 'Sampleton Library']) expect(labels).toContain(want);
    expect(new Set(labels).size).toBe(labels.length); // mapped twice → one marker
    for (const t of labels) expect(t.length).toBeLessThanOrEqual(LANDMARK_MAX_CHARS);
  });

  it('never contains the typed address', () => {
    const typed = '12 Orchard Tennis Club Lane, Sampleton';
    const withAddr: MapData = { ...rich, pois: [...rich.pois, { id: 'addr', p: { x: 0, z: 0 }, kind: 'library', name: typed }, { id: 'addr2', p: { x: 5, z: 5 }, kind: 'police', name: '12 orchard tennis club lane' }] };
    for (const [name, m] of MISSIONS) {
      const list = landmarkList(withAddr, m, { typed });
      for (const l of list) {
        expect(l.id, name).not.toMatch(/^addr/);
        expect(l.label.toLowerCase(), name).not.toContain('12 orchard');
      }
    }
    // Without the typed text the game never has it: the address isn't a map feature, so it can't be listed.
    for (const [, m] of MISSIONS) expect(landmarkList(rich, m).some((l) => /^addr/.test(l.id))).toBe(false);
  });

  it('puts the place the mission is built around first, then places near the action', () => {
    const [, m] = MISSIONS[3];
    expect(m.anchor).toBeTruthy();
    const list = landmarkList(map, m);
    expect(list[0].id).toBe(m.anchor!.id);
    expect(landmarkList(map, m)).toEqual(list); // deterministic
  });

  describe('declutter', () => {
    const W = 1280;
    const H = 720;
    const many: LandmarkIn[] = Array.from({ length: 30 }, (_, i) => ({ id: `l${i}`, label: `Place number ${i}`, priority: 30 - i, x: 80 + (i % 6) * 200, y: 60 + Math.floor(i / 6) * 140, visible: true, aimDist: 20 }));
    const panels: Rect[] = [{ x0: 10, y0: 10, x1: 200, y1: 110 }, { x0: 1080, y0: 10, x1: 1270, y1: 120 }];
    const hit = (a: Rect, b: Rect) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

    it(`shows at most ${MAX_LANDMARKS}, none overlapping each other, a panel, the reticle area or the edge`, () => {
      const out = placeLandmarks(many, { width: W, height: H, blocked: panels, zoom: 1, viewHalf: 100 });
      expect(out.length).toBe(MAX_LANDMARKS);
      const boxes = out.map((o) => ({ x0: o.left, y0: o.top, x1: o.left + labelWidth(o.label), y1: o.top + 20 }));
      boxes.forEach((b, i) => {
        expect(b.x0).toBeGreaterThanOrEqual(0);
        expect(b.y0).toBeGreaterThanOrEqual(0);
        expect(b.x1).toBeLessThanOrEqual(W);
        expect(b.y1).toBeLessThanOrEqual(H);
        for (const p of [...panels, ...reticleRects(W, H)]) expect(hit(b, p), `${out[i].id}`).toBe(false);
        boxes.forEach((c, j) => j !== i && expect(hit(b, c)).toBe(false));
      });
      // Most relevant first: the top-priority place that fits is kept.
      expect(out.map((o) => o.id)).toContain('l2');
    });

    it('fades with distance from the aim point and with zoom; hidden, behind-camera or faded places are dropped', () => {
      expect(landmarkOpacity(10, 100, 1)).toBe(1);
      expect(landmarkOpacity(100, 100, 1)).toBeLessThan(1);
      expect(landmarkOpacity(200, 100, 1)).toBe(0);
      expect(landmarkOpacity(10, 100, 4)).toBeLessThan(landmarkOpacity(10, 100, 1));
      expect(landmarkOpacity(10, 100, 4)).toBeGreaterThanOrEqual(0.5); // still readable
      const far = many.map((m) => ({ ...m, aimDist: 500 }));
      expect(placeLandmarks(far, { width: W, height: H, blocked: [], zoom: 1, viewHalf: 100 })).toEqual([]);
      const hidden = many.map((m) => ({ ...m, visible: false }));
      expect(placeLandmarks(hidden, { width: W, height: H, blocked: [], zoom: 1, viewHalf: 100 })).toEqual([]);
    });

    it('never puts a pin in the reticle area', () => {
      const centre: LandmarkIn = { id: 'c', label: 'Dead centre', priority: 99, x: W / 2 + 10, y: H / 2 - 10, visible: true, aimDist: 1 };
      expect(placeLandmarks([centre], { width: W, height: H, blocked: [], zoom: 1, viewHalf: 100 })).toEqual([]);
    });
  });
});
