import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocks, hideDistance, HeightGrid, pointSegDist, prism, PrismIndex, segPolyDist, sightSegment } from '../src/world/sightline';
import { AIM_KEEP, CUT_MIN_TOP, Cutaway, cutHeight, FADE_TIME, STUMP } from '../src/world/cutaway';
import { GHOST } from '../src/world/shading';
import { CENTRE_PULL, GunshipOrbit, offVertical, orbitTarget, RM_FAR, tallFactor, TALL_FROM, TALL_TO, TIGHT_RADIUS, turnHeading } from '../src/game/gunshipOrbit';
import { ORBIT } from '../src/sim/sim';
import { presetToMap } from '../src/map/presets';
import { makeSampleTown } from '../src/map/sample';
import { buildBuildings } from '../src/world/buildings';

/** A w x d box centred at (x, z). */
const box = (x: number, z: number, w: number, d: number, top: number) =>
  prism([{ x: x - w / 2, z: z - d / 2 }, { x: x + w / 2, z: z - d / 2 }, { x: x + w / 2, z: z + d / 2 }, { x: x - w / 2, z: z + d / 2 }], top);

// The gunship 1500 m up, 1000 m east of the aim point at the origin (about 34° off vertical).
const G = { x: 1000, y: 1500, z: 0 };
const O = { x: 0, z: 0 };

describe('line-of-sight maths (3.39)', () => {
  it('the sight line climbs toward the gunship: its ground track to height h is h * across / up long', () => {
    const [a, b] = sightSegment(O, G, 30);
    expect(a).toEqual(O);
    expect(b.x).toBeCloseTo(20);
    expect(b.z).toBeCloseTo(0);
    // From a body's height, the same top is reached sooner.
    expect(sightSegment(O, G, 30, 1.5)[1].x).toBeCloseTo((28.5 / 1498.5) * 1000);
  });

  it('distances between points, segments and polygons', () => {
    expect(pointSegDist({ x: 0, z: 5 }, { x: -1, z: 0 }, { x: 1, z: 0 })).toBeCloseTo(5);
    expect(pointSegDist({ x: 4, z: 3 }, { x: -1, z: 0 }, { x: 1, z: 0 })).toBeCloseTo(Math.hypot(3, 3));
    const sq = box(10, 0, 4, 4, 50).pts;
    expect(segPolyDist({ x: 0, z: 0 }, { x: 20, z: 0 }, sq)).toBe(0); // crosses it
    expect(segPolyDist({ x: 10, z: 0 }, { x: 10, z: 0 }, sq)).toBe(0); // inside it
    expect(segPolyDist({ x: 0, z: 5 }, { x: 20, z: 5 }, sq)).toBeCloseTo(3); // runs past 3 m away
  });

  it('a tower between the gunship and the aim point blocks it; the same tower behind the aim point, or too low, does not', () => {
    expect(blocks(box(15, 0, 10, 10, 60), O, G)).toBe(true); // 10-20 m toward the plane, 60 m tall
    expect(blocks(box(-15, 0, 10, 10, 60), O, G)).toBe(false); // on the far side
    expect(blocks(box(15, 0, 10, 10, 6), O, G)).toBe(false); // the line is at 6.7 m by the time it gets there
    expect(blocks(box(15, 30, 10, 10, 60), O, G)).toBe(false); // off to the side
    expect(hideDistance(box(15, 30, 10, 10, 60), O, G)).toBeCloseTo(25);
  });

  it('the index finds the nearest blocker, and a lower (cut) top lets the line through', () => {
    const towers = [box(15, 0, 10, 10, 60), box(40, 0, 10, 10, 200), box(0, 60, 10, 10, 300)];
    const idx = new PrismIndex(towers, 500);
    expect(idx.blocker(O, G)).toBe(0);
    expect(idx.blocker(O, G, 0, (k) => (k === 0 ? 3 : towers[k].top))).toBe(1);
    expect(idx.blocker(O, G, 0, () => 3)).toBe(-1);
    expect(idx.blocker({ x: -200, z: -200 }, G)).toBe(-1);
  });

  it('city height: the median of built cells, nothing where little is built', () => {
    const towers = [];
    for (let i = -4; i <= 4; i++) for (let j = -4; j <= 4; j++) towers.push(box(i * 30, j * 30, 20, 20, 60));
    const g = new HeightGrid(400, 20, towers);
    expect(g.tallness(O)).toBeCloseTo(60);
    expect(g.tallness({ x: 380, z: 380 })).toBe(0);
    const lone = new HeightGrid(400, 20, [box(0, 0, 20, 20, 150)]);
    expect(lone.tallness(O)).toBe(0); // a lone tower in a suburb is not a high-rise district
  });

  it('the sample town is low-rise and Midtown is high-rise (so only Midtown changes orbit)', () => {
    const ny = presetToMap(JSON.parse(readFileSync('public/maps/presets/new-york-midtown.json', 'utf8')));
    const town = makeSampleTown();
    const grid = (m: typeof ny) => new HeightGrid(m.half, 20, buildBuildings(m.buildings, 1).prisms);
    const t = grid(town);
    for (const p of [O, { x: 0, z: 110 }, { x: 110, z: 0 }, { x: -110, z: 0 }]) expect(tallFactor(t.tallness(p))).toBeLessThan(0.05);
    const n = grid(ny);
    expect(tallFactor(n.tallness({ x: -93, z: 59 }))).toBe(1);
  });
});

describe('the cut-away (3.39)', () => {
  const towers = [box(15, 0, 10, 10, 60), box(-15, 0, 10, 10, 60), box(30, 30, 10, 10, 60), box(15, 0.5, 4, 4, 8)];
  it('cuts only tall buildings that hide the aim point, above the line of sight, fading over FADE_TIME', () => {
    const c = new Cutaway(towers, 400);
    c.update(G, [{ p: O, r: AIM_KEEP }], FADE_TIME / 2);
    expect(c.fade[0]).toBeCloseTo(0.5);
    for (let i = 0; i < 10; i++) c.update(G, [{ p: O, r: AIM_KEEP }], 1 / 60);
    c.update(G, [{ p: O, r: AIM_KEEP }], FADE_TIME);
    expect(Array.from(c.fade)).toEqual([1, 0, 0, 0]); // behind, aside and low buildings stay solid
    expect(towers[3].top).toBeLessThan(CUT_MIN_TOP);
    // Cut at the line of sight from the near edge of the kept area: 10 m away, 8 m kept => 2 m * 1.5 => the stump.
    expect(c.solidTop(0)).toBeCloseTo(STUMP);
    expect(c.coverer(O, G, 1.5)).toBe(-1); // nothing solid covers the aim point now
    expect(c.blocker(O, G, 1.5)).toBe(0); // but the tower is still there: MASKED
    // Aim elsewhere: it comes back, over the same time.
    c.update(G, [{ p: { x: -300, z: 0 }, r: AIM_KEEP }], FADE_TIME / 2);
    expect(c.fade[0]).toBeCloseTo(0.5);
    c.update(G, [{ p: { x: -300, z: 0 }, r: AIM_KEEP }], FADE_TIME);
    expect(c.fade[0]).toBe(0);
    expect(c.solidTop(0)).toBe(60);
  });

  it('cuts no lower than the line of sight needs', () => {
    const far = box(60, 0, 10, 10, 200);
    // 55 m from the aim point, minus 8 m kept: the sight line is at 47 * 1.5 = 70.5 m there.
    expect(cutHeight(far, { p: O, r: AIM_KEEP }, G)).toBeCloseTo(70.5);
    expect(cutHeight(box(15, 0, 10, 10, 60), { p: O, r: AIM_KEEP }, G)).toBe(STUMP);
  });

  it('the ghost stays partly opaque cover and can never make a hot spot or reveal a cold-blooded zombie', () => {
    expect(GHOST.wall).toBeGreaterThanOrEqual(0.35);
    expect(GHOST.wall).toBeLessThanOrEqual(0.5);
    expect(GHOST.edgeSig[0]).toBeLessThanOrEqual(0.34); // far below a warm zombie (0.98)
    // Alpha blending mixes both pixels toward the same value: the contrast left is (1 - a) of the original.
    const grass = 0.19;
    const cold = 0.2;
    for (const a of [GHOST.wall, GHOST.edge]) {
      const mix = (v: number) => v * (1 - a) + GHOST.edgeSig[0] * a;
      expect(Math.abs(mix(cold) - mix(grass))).toBeLessThanOrEqual(Math.abs(cold - grass) + 1e-12);
    }
  });
});

describe('the gunship orbit (3.39)', () => {
  it('tall factor: 0 over low-rise, 1 over high-rise, smooth and rising in between', () => {
    expect(tallFactor(0)).toBe(0);
    expect(tallFactor(TALL_FROM)).toBe(0);
    expect(tallFactor(TALL_TO)).toBe(1);
    expect(tallFactor(200)).toBe(1);
    let prev = 0;
    for (let h = TALL_FROM; h <= TALL_TO; h += 0.5) {
      const k = tallFactor(h);
      expect(k).toBeGreaterThanOrEqual(prev);
      expect(k - prev).toBeLessThan(0.08);
      prev = k;
    }
  });

  it('low-rise flies the sim orbit exactly; high-rise a moderate, steeper orbit around the aim', () => {
    const c = { x: 100, z: -50 };
    const aim = { x: 300, z: 200 };
    expect(orbitTarget(0, c, aim, ORBIT.radius)).toEqual({ cx: 100, cz: -50, r: ORBIT.radius });
    const t = orbitTarget(1, c, aim, ORBIT.radius);
    expect(t.r).toBe(TIGHT_RADIUS);
    expect(t.cx).toBeCloseTo(100 + 200 * CENTRE_PULL);
    const deg = offVertical(TIGHT_RADIUS, ORBIT.altitude);
    expect(deg).toBeGreaterThan(20); // moderate: never near vertical, the moment in the orbit still matters
    expect(deg).toBeLessThan(offVertical(ORBIT.radius, ORBIT.altitude));
  });

  it('eases dt-scaled: the same result in one step or many, within the speed caps', () => {
    const start = { cx: 0, cz: 0, r: 1000 };
    const target = { cx: 50, cz: 0, r: 900 };
    const a = new GunshipOrbit(start, { x: 0, z: 0 });
    const b = new GunshipOrbit(start, { x: 0, z: 0 });
    a.update(0.5, target, { x: 0, z: 0 }, { reducedMotion: false, idle: 9 });
    for (let i = 0; i < 30; i++) b.update(0.5 / 30, target, { x: 0, z: 0 }, { reducedMotion: false, idle: 9 });
    expect(a.shape.cx).toBeCloseTo(b.shape.cx, 1);
    expect(a.shape.r).toBeCloseTo(b.shape.r, 1);
    expect(a.shape.cx).toBeGreaterThan(0);
    expect(a.shape.cx).toBeLessThan(50);
    // A long jump is capped (no lurch).
    const c = new GunshipOrbit(start, { x: 0, z: 0 });
    c.update(0.1, { cx: 5000, cz: 0, r: 1000 }, { x: 0, z: 0 }, { reducedMotion: false, idle: 9 });
    expect(c.shape.cx).toBeLessThanOrEqual(16 + 1e-9);
    // A negative frame time (first frame) changes nothing.
    c.update(-0.05, target, { x: 0, z: 0 }, { reducedMotion: false, idle: 9 });
    expect(Number.isFinite(c.shape.cx)).toBe(true);
  });

  it('reduced motion: no continuous change; one cut after a long aim move or a pause in firing', () => {
    const o = new GunshipOrbit({ cx: 0, cz: 0, r: 1000 }, { x: 0, z: 0 });
    const target = { cx: 120, cz: 0, r: 750 };
    o.update(0.1, target, { x: 20, z: 0 }, { reducedMotion: true, idle: 0 });
    expect(o.shape).toEqual({ cx: 0, cz: 0, r: 1000 }); // firing, short move: held
    o.update(0.1, target, { x: 20, z: 0 }, { reducedMotion: true, idle: 1.5 });
    expect(o.shape).toEqual(target); // a pause in firing: one cut
    const p = new GunshipOrbit({ cx: 0, cz: 0, r: 1000 }, { x: 0, z: 0 });
    p.update(0.1, target, { x: RM_FAR + 1, z: 0 }, { reducedMotion: true, idle: 0 });
    expect(p.shape).toEqual(target); // a long aim move: one cut, even mid-burst
  });

  it('the picture never flips: its up turns at a capped rate the short way round', () => {
    expect(turnHeading(0, Math.PI / 2, 0.5, 1)).toBeCloseTo(0.5);
    expect(turnHeading(3, -3, 10, 1)).toBeCloseTo(-3 + 2 * Math.PI); // across ±π, the short way
    expect(turnHeading(0, 0.1, 0.5, 1)).toBeCloseTo(0.1);
  });
});
