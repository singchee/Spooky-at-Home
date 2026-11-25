import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { blocks, entryT, hideDistance, HeightGrid, pointSegDist, prism, PrismIndex, segPolyDist, sightSegment } from '../src/world/sightline';
import { AIM_KEEP, CUT_MIN_TOP, Cutaway, cutHeight, FADE_TIME, STUMP } from '../src/world/cutaway';
import { GHOST } from '../src/world/shading';
import { CENTRE_PULL, GunshipOrbit, offVertical, orbitTarget, RM_FAR, RM_GAP, tallFactor, TALL_FROM, TALL_TO, TIGHT_RADIUS, turnHeading } from '../src/game/gunshipOrbit';
import { dangerCloseAt, edgePointer, MaskLatch, NearSet, roundTarget } from '../src/game/lineOfFire';
import { figureLean, FIGURE_LEAN_MAX, leanPoint } from '../src/render/modelShader';
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

  const C = { x: 0, z: 0 };
  const R = ORBIT.radius;
  const free = { reducedMotion: false, idle: 9 };
  it('eases dt-scaled: the same result in one step or many, within the speed caps', () => {
    const start = { cx: 0, cz: 0, r: 1000 };
    const aim = { x: 50, z: 0 };
    const a = new GunshipOrbit(start, aim);
    const b = new GunshipOrbit(start, aim);
    a.update(0.5, 1, C, aim, R, free);
    for (let i = 0; i < 30; i++) b.update(0.5 / 30, 1, C, aim, R, free);
    expect(a.shape.cx).toBeCloseTo(b.shape.cx, 1);
    expect(a.shape.r).toBeCloseTo(b.shape.r, 1);
    expect(a.shape.cx).toBeGreaterThan(0);
    expect(a.shape.cx).toBeLessThan(50);
    // A long jump is capped (no lurch).
    const c = new GunshipOrbit(start, aim);
    c.update(0.1, 1, C, { x: 5000, z: 0 }, R, free);
    expect(c.shape.cx).toBeLessThanOrEqual(16 + 1e-9);
    // A negative frame time (first frame) changes nothing.
    c.update(-0.05, 1, C, aim, R, free);
    expect(Number.isFinite(c.shape.cx)).toBe(true);
  });

  it('reduced motion: held while aiming; one cut once the aim is still, after a long move or a pause in firing', () => {
    const rm = (idle: number) => ({ reducedMotion: true, idle });
    const o = new GunshipOrbit({ cx: 0, cz: 0, r: 1000 }, { x: 0, z: 0 }, 0);
    o.update(0.1, 1, C, { x: 120, z: 0 }, R, rm(0));
    expect(o.shape).toEqual({ cx: 0, cz: 0, r: 1000 }); // the aim just moved: held
    for (let i = 0; i < 10; i++) o.update(0.1, 1, C, { x: 120, z: 0 }, R, rm(0));
    expect(o.cuts).toBe(0); // still firing, short move: held
    o.update(0.1, 1, C, { x: 120, z: 0 }, R, rm(1.5));
    expect(o.shape).toEqual(orbitTarget(1, C, { x: 120, z: 0 }, R)); // a pause in firing: one cut
    expect(o.cuts).toBe(1);
    const p = new GunshipOrbit({ cx: 0, cz: 0, r: 1000 }, { x: 0, z: 0 }, 1);
    const far = { x: RM_FAR + 1, z: 0 };
    for (let i = 0; i < 6; i++) p.update(0.1, 1, C, far, R, rm(0));
    expect(p.cuts).toBe(1); // a long aim move, once the aim is still: one cut, even mid-burst
  });

  it('reduced motion: "the aim is still" is judged by speed, the same at 30, 60 and 144 fps', () => {
    const cutTimes = (fps: number) => {
      const o = new GunshipOrbit({ cx: 0, cz: 0, r: 1000 }, { x: 0, z: 0 }, 0);
      // A slow drift (2 m/s, still for this purpose), then a 10 m/s pan, then a stop.
      const path = (t: number) => ({ x: t < 3 ? t * 2 : t < 20 ? 6 + (t - 3) * 10 : 176, z: 0 });
      let before = 0;
      const out: number[] = [];
      for (let f = 0; f <= fps * 25; f++) {
        const t = f / fps;
        o.update(1 / fps, 1, C, path(t), R, { reducedMotion: true, idle: 0 });
        if (o.cuts !== before) out.push(t);
        before = o.cuts;
      }
      return out;
    };
    const ref = cutTimes(60);
    expect(ref.length).toBeGreaterThan(0);
    for (const fps of [30, 144]) {
      const c = cutTimes(fps);
      expect(c.length).toBe(ref.length);
      c.forEach((t, i) => expect(Math.abs(t - ref[i])).toBeLessThan(0.05));
    }
  });

  it('reduced motion: panning across the edge of a high-rise district cuts at most once every 1.5 s', () => {
    // Tall west of x = 0, low east of it, with a ragged edge (the tall factor wobbles near the boundary).
    const kAt = (p: { x: number; z: number }) => (p.x < 10 * Math.sin(p.z / 7) ? 1 : p.x < 25 ? 0.3 + 0.2 * Math.sin(p.x) : 0);
    const runs: [string, (t: number) => { x: number; z: number }][] = [
      ['slow pan back and forth', (t) => ({ x: -200 + ((t * 20) % 400 < 200 ? (t * 20) % 400 : 400 - ((t * 20) % 400)) * 2, z: 0 })],
      ['fast circle over the edge', (t) => ({ x: Math.cos(t * 0.8) * 125, z: Math.sin(t * 0.8) * 125 })],
      ['pan with stops on both sides', (t) => ({ x: Math.max(-150, Math.min(150, Math.sin(t * 0.6) * 260)), z: 0 })],
    ];
    let total = 0;
    for (const [name, path] of runs) {
      for (const idle of [0, 5]) {
        const o = new GunshipOrbit({ cx: 0, cz: 0, r: 1000 }, path(0), 0);
        const cuts: number[] = [];
        let before = o.cuts;
        for (let f = 0; f < 60 * 40; f++) {
          const t = f / 60;
          const aim = path(t);
          o.update(1 / 60, kAt(aim), C, aim, R, { reducedMotion: true, idle });
          if (o.cuts !== before) cuts.push(t);
          before = o.cuts;
        }
        for (let i = 1; i < cuts.length; i++) expect(cuts[i] - cuts[i - 1], `${name}, idle ${idle}: cuts at ${cuts.join(', ')}`).toBeGreaterThanOrEqual(RM_GAP);
        total += cuts.length;
      }
    }
    expect(total).toBeGreaterThan(0); // the orbit does still change (at the stops)
  });

  it('the picture never flips: its up turns at a capped rate the short way round', () => {
    expect(turnHeading(0, Math.PI / 2, 0.5, 1)).toBeCloseTo(0.5);
    expect(turnHeading(3, -3, 10, 1)).toBeCloseTo(-3 + 2 * Math.PI); // across ±π, the short way
    expect(turnHeading(0, 0.1, 0.5, 1)).toBeCloseTo(0.1);
  });
});

describe('the line of fire: where rounds land, DANGER CLOSE, MASKED (3.39)', () => {
  const tower = box(15, 0, 10, 10, 60); // 10-20 m toward the gunship, 60 m tall
  it('a round meets the first building on the line: its wall, or its roof', () => {
    // Coming down from the gunship, the line is level with the tower's top at x = 40 (beyond it), then
    // meets the wall facing the gunship (x = 20) 30 m up.
    const t = entryT(tower, O, G);
    expect(t * G.y).toBeCloseTo(30);
    expect(O.x + (G.x - O.x) * t).toBeCloseTo(20);
    // A low block under the line: no contact.
    expect(entryT(box(15, 0, 10, 10, 6), O, G)).toBe(-1);
    // The aim point on a roof: the roof is hit.
    expect(entryT(box(0, 0, 40, 40, 9), O, G) * G.y).toBeCloseTo(9);
    // Near the edge of a small block, the wall facing the gunship is hit first (x = 5, 7.5 m up).
    expect(entryT(box(0, 0, 10, 10, 9), O, G) * G.y).toBeCloseTo(7.5);
    const idx = new PrismIndex([tower, box(60, 0, 10, 10, 200)], 400);
    const l = idx.landing(O, G);
    expect(l.building).toBe(1); // the taller tower further up the line is met first, on its x = 65 wall
    expect(l.x).toBeCloseTo(65);
    expect(l.y).toBeCloseTo(97.5);
    expect(new PrismIndex([tower], 400).landing({ x: -100, z: 0 }, G)).toEqual({ x: -100, y: 0, z: 0, building: -1 });
  });

  it('the MASKED impact mark sits on the ground exactly where tryFire sends the round', () => {
    const contact = new PrismIndex([tower], 400).landing(O, G); // meets the wall 30 m up at x = 20
    const rt = roundTarget(contact);
    expect(rt.blocked).toBe(true);
    expect(rt.mark).toEqual({ x: rt.fire.x, y: 0, z: rt.fire.z }); // on the ground, not on the wall
    expect(rt.fire.x).toBeCloseTo(20);
    const clear = roundTarget(new PrismIndex([tower], 400).landing({ x: -100, z: 0 }, G));
    expect(clear).toEqual({ fire: { x: -100, z: 0 }, mark: { x: -100, y: 0, z: 0 }, blocked: false });
  });

  it('an off-screen impact gets a pointer on the screen edge, toward it', () => {
    const e = edgePointer(2000, 360, 1280, 720, 28); // far right, level with the centre
    expect(e.x).toBeCloseTo(1252);
    expect(e.y).toBeCloseTo(360);
    expect(e.angle).toBeCloseTo(0);
    const d = edgePointer(640, -1000, 1280, 720, 28); // straight up
    expect(d.y).toBeCloseTo(28);
    expect(d.angle).toBeCloseTo(-Math.PI / 2);
    const c = edgePointer(-2000, 2000, 1280, 720, 28); // down-left: leaves through the bottom
    expect(c.y).toBeCloseTo(692);
    expect(c.x).toBeGreaterThanOrEqual(28);
  });

  it('DANGER CLOSE is judged where the round will land, not at the aim point', () => {
    const landing = new PrismIndex([tower], 400).landing(O, G); // lands at x = 20
    const nearWall = [{ x: 24, z: 0, alive: true }];
    const nearAim = [{ x: -6, z: 0, alive: true }];
    expect(dangerCloseAt(landing, nearWall, 3)).toBe(true); // 4 m from the impact, 24 m from the aim point
    expect(dangerCloseAt(O, nearWall, 3)).toBe(false); // the old test (at the aim point) missed it
    expect(dangerCloseAt(landing, nearAim, 3)).toBe(false); // the masked round never reaches them
    expect(dangerCloseAt(landing, [{ x: 24, z: 0, alive: false }], 3)).toBe(false);
  });

  it('MASKED switches on at once and off only after 0.3 s clear', () => {
    const m = new MaskLatch();
    expect(m.update(true, 1 / 60)).toBe(true);
    for (let i = 0; i < 17; i++) expect(m.update(false, 1 / 60)).toBe(true);
    m.update(true, 1 / 60);
    for (let i = 0; i < 17; i++) expect(m.update(false, 1 / 60)).toBe(true); // a blip restarts the wait
    expect(m.update(false, 2 / 60)).toBe(false);
  });

  it('markers near the aim: in inside 60 m, out beyond 68 m', () => {
    const n = new NearSet(60, 68);
    const mk = (x: number) => [{ label: 'SAFEHOUSE', p: { x, z: 0 } }];
    expect(n.update(mk(65), O)).toHaveLength(0);
    expect(n.update(mk(59), O)).toHaveLength(1);
    expect(n.update(mk(66), O)).toHaveLength(1); // held between 60 and 68
    expect(n.update(mk(69), O)).toHaveLength(0);
    expect(n.update(mk(66), O)).toHaveLength(0);
  });

  it('figures lean back on steep views only, and the strobe follows the same lean', () => {
    const a40 = (40 * Math.PI) / 180;
    expect(figureLean(Math.sin(a40), Math.cos(a40), 0)).toBeCloseTo(0, 5); // at 40°: none
    expect(figureLean(Math.sin(1), Math.cos(1), 0)).toBe(0); // flatter than 40°: none
    expect(figureLean(0, 1500, 0)).toBe(0); // straight down: no direction to lean in
    expect(figureLean(10, 1500, 0)).toBeCloseTo(FIGURE_LEAN_MAX); // nearly vertical: capped
    const k = figureLean(750, 1500, 0);
    expect(k).toBeGreaterThan(0);
    expect(k).toBeLessThan(FIGURE_LEAN_MAX);
    const head = leanPoint([0, 3, 0], 750, 1500, 0);
    expect(head[0]).toBeCloseTo(-3 * k); // away from the camera (camera is +x)
    expect(head[1]).toBe(3);
    expect(leanPoint([0, 0, 0], 750, 1500, 0)[0]).toBeCloseTo(0); // the feet stay put
  });
});

describe('the BLOCKED reticle tag (owner playtest 1: renamed from MASKED)', () => {
  it('reads BLOCKED, from one constant that the HUD, the style guide and the playtest all use', async () => {
    const { BLOCKED_TAG } = await import('../src/ui/hud');
    expect(BLOCKED_TAG).toBe('BLOCKED');
    const hud = readFileSync('src/ui/hud.ts', 'utf8');
    expect(hud).toMatch(/dataset\.mask = masked \? BLOCKED_TAG : ''/);
    expect(hud).not.toMatch(/'MASKED'/);
    const style = readFileSync('docs/STYLE.md', 'utf8');
    expect(style).toContain(`steady ${BLOCKED_TAG} tag above it`);
    expect(style).not.toMatch(/steady MASKED tag/);
    expect(readFileSync('scripts/playtest.mjs', 'utf8')).not.toMatch(/text !== 'MASKED'/);
  });

  it('keeps its look: amber, the tag drawn from data-mask above the crosshair, and the amber impact mark', () => {
    const css = readFileSync('src/style.css', 'utf8');
    expect(css).toMatch(/\.hud-cross\.masked \{ color: #ffb347; \}/);
    expect(css).toMatch(/\.hud-cross\.masked::before \{ content: attr\(data-mask\);[^}]*color: #ffb347;/);
    expect(css).toMatch(/\.hud-impact \{[^}]*border: 1\.5px solid #ffb347;/);
  });
});
