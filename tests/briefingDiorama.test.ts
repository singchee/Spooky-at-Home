import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { makeSampleTown } from '../src/map/sample';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { polygonArea } from '../src/map/geom';
import { mapFeatures, TEMPLATE_IDS, MISSION_TEMPLATES } from '../src/map/recon';
import { generateMission, likelyWaveDirections, type Mission } from '../src/sim/missions';
import { ORBIT } from '../src/sim/sim';
import { focusView } from '../src/ui/tacticalMap';
import {
  arrowShape,
  buildDioramaScene,
  clipPolygon,
  clipPolyline,
  dioramaExtent,
  labelSpecs,
  missionOverlay,
  orbitSchematic,
  placeLabels,
  type LabelIn,
  type Rect,
} from '../src/ui/briefingDiorama';

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
const box: Rect = { x0: 0, z0: 0, x1: 100, z1: 100 };

describe('diorama extent', () => {
  it('is the briefing tactical map’s focus square, trimmed to the map', () => {
    const half = map.half;
    const pad = half * 0.03;
    for (const [name, m] of MISSIONS) {
      const r = dioramaExtent(map, m);
      const v = focusView(m, { x0: -half - pad, z0: -half - pad, span: 2 * (half + pad) });
      expect(r.x0, name).toBeCloseTo(Math.max(-half, v.x0));
      expect(r.z1, name).toBeCloseTo(Math.min(half, v.z0 + v.span));
      expect(r.x0).toBeGreaterThanOrEqual(-half);
      expect(r.x1).toBeLessThanOrEqual(half);
      expect(r.z0).toBeGreaterThanOrEqual(-half);
      expect(r.z1).toBeLessThanOrEqual(half);
      expect(r.x1 - r.x0).toBeGreaterThan(400);
      // Every horde and the safehouse are in the model.
      for (const h of m.hordes) expect(h.centre.x >= r.x0 && h.centre.x <= r.x1 && h.centre.z >= r.z0 && h.centre.z <= r.z1, name).toBe(true);
      if (m.safehouse) expect(m.safehouse.centre.x >= r.x0 && m.safehouse.centre.x <= r.x1).toBe(true);
    }
  });
});

describe('clipping to the diorama box', () => {
  it('clips polygons (inside: unchanged; across the edge: the inside part; outside: nothing)', () => {
    const sq = (x: number, z: number, s: number) => [{ x, z }, { x: x + s, z }, { x: x + s, z: z + s }, { x, z: z + s }];
    expect(polygonArea(clipPolygon(sq(10, 10, 20), box))).toBeCloseTo(400);
    expect(polygonArea(clipPolygon(sq(90, 90, 20), box))).toBeCloseTo(100);
    expect(polygonArea(clipPolygon(sq(-50, 40, 60), box))).toBeCloseTo(10 * 60);
    expect(clipPolygon(sq(200, 200, 10), box)).toEqual([]);
  });

  it('clips polylines into the pieces inside the box', () => {
    const across = clipPolyline([{ x: -50, z: 50 }, { x: 150, z: 50 }], box);
    expect(across).toHaveLength(1);
    expect(across[0][0]).toEqual({ x: 0, z: 50 });
    expect(across[0][1]).toEqual({ x: 100, z: 50 });
    // Out, back in, out again: two pieces.
    const zig = clipPolyline([{ x: 50, z: 50 }, { x: 50, z: 150 }, { x: 70, z: 150 }, { x: 70, z: 50 }], box);
    expect(zig).toHaveLength(2);
    expect(zig[0]).toEqual([{ x: 50, z: 50 }, { x: 50, z: 100 }]);
    expect(zig[1]).toEqual([{ x: 70, z: 100 }, { x: 70, z: 50 }]);
    expect(clipPolyline([{ x: -10, z: -10 }, { x: -20, z: 50 }], box)).toEqual([]);
  });
});

describe('mission overlays in 3D', () => {
  it('match the mission: hordes, cold rings, route, friendlies, home, safehouse, waves, orbit', () => {
    for (const [name, m] of MISSIONS) {
      const b = dioramaExtent(map, m);
      const waves = likelyWaveDirections(m, map, graph);
      const o = missionOverlay(m, waves, b);
      expect(o.discs.length, name).toBe(m.hordes.length);
      expect(o.discs.filter((d) => d.cold).length).toBe(m.hordes.filter((h) => h.cold > 0).length);
      expect(o.friendlies.length).toBe(m.survivors.filter((s) => !s.route).length);
      expect(!!o.home).toBe(!!m.home);
      expect(!!o.safehouse).toBe(!!m.safehouse);
      expect(o.orbit).toEqual({ c: m.orbitCentre, r: ORBIT.radius });
      if (m.route) {
        expect(o.route.length, name).toBeGreaterThan(0);
        for (const piece of o.route) for (const p of piece) expect(p.x >= b.x0 - 1e-6 && p.x <= b.x1 + 1e-6 && p.z >= b.z0 - 1e-6 && p.z <= b.z1 + 1e-6).toBe(true);
      } else expect(o.route).toEqual([]);
      if (m.type === 'defend') {
        expect(o.waveZone).not.toBeNull();
        expect(o.arrows.length, name).toBeGreaterThan(0);
        expect(o.arrows.length).toBeLessThanOrEqual(waves.length);
      } else expect(o.arrows).toEqual([]);
      if (m.anchor?.pts) expect(o.anchor?.length).toBeGreaterThanOrEqual(3);
    }
  });

  it('wave arrows stop short of the safehouse and start inside the model', () => {
    const a = arrowShape({ x: -40, z: 50 }, { x: 80, z: 50 }, 20, box)!;
    expect(a.tip.x).toBeCloseTo(60);
    expect(a.start).toEqual({ x: 0, z: 50 });
    expect(a.head[0]).toEqual(a.tip);
    expect(arrowShape({ x: 40, z: 50 }, { x: 80, z: 50 }, 20, box)).toBeNull();
  });

  it('the orbit ring is a schematic that fits over the model, centred on the real orbit centre', () => {
    for (const [, m] of MISSIONS) {
      const b = dioramaExtent(map, m);
      const o = orbitSchematic(m.orbitCentre, b);
      expect(o.r).toBeLessThanOrEqual(ORBIT.radius);
      expect(o.r).toBeLessThanOrEqual((b.x1 - b.x0) / 2);
      expect(o.y).toBeGreaterThan(0);
      expect(o.c.x).toBeGreaterThanOrEqual(b.x0);
      expect(o.c.x).toBeLessThanOrEqual(b.x1);
    }
  });
});

describe('labels', () => {
  it('label the mission places and only public landmarks (never anything else, e.g. a typed address)', () => {
    const names = new Set(mapFeatures(map).map((f) => f.name).filter(Boolean));
    for (const [name, m] of MISSIONS) {
      const b = dioramaExtent(map, m);
      const specs = labelSpecs(map, m, likelyWaveDirections(m, map, graph), b);
      expect(specs.some((s) => s.text === 'SAFEHOUSE')).toBe(!!m.safehouse);
      expect(specs.some((s) => s.text === 'HOME')).toBe(!!m.home);
      expect(specs.some((s) => s.kind === 'hostile'), name).toBe(m.hordes.length > 0);
      if (m.anchor) expect(specs.some((s) => s.kind === 'anchor'), name).toBe(true);
      for (const s of specs) {
        expect(s.text.length).toBeLessThanOrEqual(26);
        if (s.kind === 'place') {
          expect(names.has(s.text.replace(/…$/, '')) || [...names].some((n) => n!.startsWith(s.text.replace(/…$/, ''))), s.text).toBe(true);
          expect(s.p.x >= b.x0 && s.p.x <= b.x1 && s.p.z >= b.z0 && s.p.z <= b.z1).toBe(true);
        }
      }
      // Most important first.
      for (let i = 1; i < specs.length; i++) expect(specs[i - 1].priority).toBeGreaterThanOrEqual(specs[i].priority);
    }
  });

  const item = (id: string, x: number, y: number, priority: number, w = 80, h = 24, visible = true): LabelIn => ({ id, x, y, w, h, priority, visible });
  const overlaps = (a: { left: number; top: number }, aw: number, b: { left: number; top: number }, bw: number, h = 24) =>
    a.left < b.left + bw && a.left + aw > b.left && a.top < b.top + h && a.top + h > b.top;

  it('never overlap, stay on the canvas, and drop the least important when crowded', () => {
    const items: LabelIn[] = [];
    for (let i = 0; i < 40; i++) items.push(item(`l${i}`, 40 + ((i * 37) % 320), 40 + ((i * 53) % 320), 100 - i));
    const out = placeLabels(items, 400, 400);
    const shown = out.filter((o) => o.shown);
    expect(shown.length).toBeGreaterThan(5);
    expect(shown.length).toBeLessThan(40);
    for (const o of shown) {
      expect(o.left).toBeGreaterThanOrEqual(4);
      expect(o.top).toBeGreaterThanOrEqual(4);
      expect(o.left + 80).toBeLessThanOrEqual(396);
      expect(o.top + 24).toBeLessThanOrEqual(396);
    }
    for (let i = 0; i < shown.length; i++) for (let j = i + 1; j < shown.length; j++) expect(overlaps(shown[i], 80, shown[j], 80)).toBe(false);
    // The most important label always gets a spot.
    expect(out.find((o) => o.id === 'l0')!.shown).toBe(true);
  });

  it('tries above, then the sides, then below; keeps last frame’s side; hides points behind the camera', () => {
    const [a] = placeLabels([item('a', 200, 200, 1)], 400, 400);
    expect(a.side).toBe('above');
    expect(a.top + 24).toBeLessThanOrEqual(200);
    // Near the top edge there's no room above: it goes to the right.
    const [b] = placeLabels([item('b', 200, 20, 1)], 400, 400);
    expect(b.side).toBe('right');
    // Two labels on the same point: the second goes elsewhere.
    const two = placeLabels([item('hi', 200, 200, 2), item('lo', 200, 200, 1)], 400, 400);
    expect(two[0].side).toBe('above');
    expect(two[1].shown).toBe(true);
    expect(two[1].side).not.toBe('above');
    const [c] = placeLabels([item('c', 200, 200, 1)], 400, 400, new Map([['c', 'below']]));
    expect(c.side).toBe('below');
    const [d] = placeLabels([item('d', 200, 200, 1, 80, 24, false)], 400, 400);
    expect(d.shown).toBe(false);
  });
});

describe('the model', () => {
  it('is a handful of merged meshes (≤ 15 draw calls), builds fast, and has no broken geometry', () => {
    for (const [name, m] of MISSIONS) {
      const t0 = performance.now();
      const built = buildDioramaScene(map, m, likelyWaveDirections(m, map, graph));
      const ms = performance.now() - t0;
      const meshes: THREE.Mesh[] = [];
      built.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      });
      expect(meshes.length, name).toBeGreaterThan(0);
      expect(meshes.length, name).toBeLessThanOrEqual(15);
      expect(ms, name).toBeLessThan(300);
      for (const mesh of meshes) {
        const pos = mesh.geometry.getAttribute('position').array as Float32Array;
        const col = mesh.geometry.getAttribute('color').array as Float32Array;
        expect(pos.length % 9).toBe(0);
        expect(col.length / 4).toBe(pos.length / 3);
        expect(pos.every(Number.isFinite)).toBe(true);
        expect(col.every((v) => v >= 0 && v <= 1.2)).toBe(true);
        mesh.geometry.dispose();
        (mesh.material as THREE.Material).dispose();
      }
    }
  });

  it('is the same every time for the same map and mission (no randomness)', () => {
    const m = MISSIONS[0][1];
    const a = buildDioramaScene(map, m, []);
    const b = buildDioramaScene(map, m, []);
    const arrays = (x: typeof a) => {
      const out: number[][] = [];
      x.group.traverse((o) => {
        if ((o as THREE.Mesh).isMesh) out.push([...((o as THREE.Mesh).geometry.getAttribute('color').array as Float32Array)]);
      });
      return out;
    };
    expect(arrays(a)).toEqual(arrays(b));
  });
});
