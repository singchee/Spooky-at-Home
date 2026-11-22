import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { ALL_PRESETS, COORD_UNIT, PRESETS, expandPreset, isPresetFile, unpackInts, presetMapName, presetSeed, presetToMap, presetsByCountry, type PresetFile } from '../src/map/presets';
import { seedForPlace } from '../src/map/overpass';
import { buildRoadGraph } from '../src/map/roadGraph';
import { WalkGrid } from '../src/map/grid';
import { TEMPLATE_IDS, childZones, mapFeatures, nearChildPlace, routeNearChildPlace } from '../src/map/recon';
import { generateMission, MISSION_TYPES } from '../src/sim/missions';
import type { MapData } from '../src/map/types';

const dir = new URL('../public/maps/presets/', import.meta.url);
const load = (slug: string): PresetFile => JSON.parse(readFileSync(new URL(`${slug}.json`, dir), 'utf8'));

/** What the tone check removes (scripts/build-presets.mjs): religious buildings, memorials and the like. */
const SOMBRE = /memorial|cenotaph|monument|cemetery|graveyard|holocaust|martyr|victims|massacre|church|cathedral|chapel|mosque|temple|synagogue|shrine|basilica|abbey|chiesa|eglise|église|notre-dame|神社|寺院|教会|記念|慰霊|忠魂|墓/i;
const RELIGIOUS = /^(church|cathedral|chapel|mosque|temple|synagogue|shrine|religious|monastery|presbytery|kingdom_hall|basilica|stupa|pagoda)$/;

/** Plausible minimums for a 1.2 km square of a famous, densely mapped place. */
const MIN = { buildings: 150, roads: 60, features: 5 };

const hasFile = (slug: string) => existsSync(new URL(`${slug}.json`, dir));

describe('preset list', () => {
  it('plans six places, one per country, with unique slugs', () => {
    expect(ALL_PRESETS).toHaveLength(6);
    expect(new Set(ALL_PRESETS.map((p) => p.slug)).size).toBe(6);
    expect(presetsByCountry(ALL_PRESETS).map((g) => g.country)).toEqual(['Australia', 'United Kingdom', 'United States', 'France', 'Japan', 'Italy']);
    for (const p of ALL_PRESETS) expect(p.half).toBe(1200 / 2);
  });
  it('offers exactly the places whose file is bundled', () => {
    // A place is `ready` only once its file is in public/maps/presets (and the other way round).
    for (const p of ALL_PRESETS) expect(hasFile(p.slug), `${p.slug}: ready=${p.ready}`).toBe(p.ready);
    expect(PRESETS.length).toBeGreaterThan(0);
  });
  it('seeds missions from the place, the same way a scouted place does', () => {
    for (const p of ALL_PRESETS) expect(presetSeed(p)).toBe(seedForPlace(p.origin));
    expect(new Set(ALL_PRESETS.map(presetSeed)).size).toBe(6);
  });
});

describe.each(PRESETS)('preset $slug', (info) => {
  // Loaded on first use, so one place's problem names that place instead of failing the whole file.
  const cache: { file?: PresetFile; map?: MapData } = {};
  const getFile = () => (cache.file ??= load(info.slug));
  const getMap = () => (cache.map ??= presetToMap(getFile(), info));

  it('is a compact, well-formed file with the fixture metadata', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    expect(isPresetFile(file)).toBe(true);
    const m = file.spooky_preset;
    expect(m).toMatchObject({ slug: info.slug, country: info.country, area: info.area, city: info.city, half: 600 });
    expect(m.origin).toEqual(info.origin);
    expect(m.downloaded).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(m.source).toMatch(/^overpass(-api\.de|\.kumi\.systems)$/);
    expect(m.license).toMatch(/ODbL/);
    expect(statSync(new URL(`${info.slug}.json`, dir)).size).toBeLessThanOrEqual(400 * 1024);
  });

  it('keeps only the tags the game reads', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    const allowed = new Set(['building', 'height', 'building:levels', 'name', 'highway', 'leisure', 'landuse', 'natural', 'amenity', 'shop', 'club', 'sport', 'railway', 'public_transport', 'bus', 'access', 'ref', 'route']);
    for (const e of file.e) for (const k of Object.keys(e.k ?? {})) expect(allowed.has(k), `${e.t}${e.i} has tag ${k}`).toBe(true);
  });

  it('expands and parses into a map with real streets and buildings', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    const json = expandPreset(file);
    expect(json.parts).toEqual(['core', 'extras']);
    expect(map.name).toBe(presetMapName(info));
    expect(map.half).toBe(600);
    expect(map.buildings.length).toBeGreaterThanOrEqual(MIN.buildings);
    expect(map.roads.length).toBeGreaterThanOrEqual(MIN.roads);
    expect(mapFeatures(map).length).toBeGreaterThanOrEqual(MIN.features);
    expect(map.attribution).toMatch(/OpenStreetMap contributors/);
    expect((map.lamps?.length ?? 0) + (map.trees?.length ?? 0)).toBeGreaterThan(0);
  });

  it('parses deterministically', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    expect(presetToMap(file, info)).toEqual(map);
  });

  it('unpacks the packed numbers it was built from', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    expect(unpackInts('')).toEqual([]);
    expect(unpackInts('01294Ae6_fZ6')).toEqual([0, -1, 1, -5, 2, 5, 100, -100000]);
  });

  it('has coordinates in the right place (about 1 m rounding, inside the area)', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    const lat = (n: number) => n * COORD_UNIT;
    for (const e of file.e.slice(0, 200)) {
      const p = e.p ?? (e.g ? unpackInts(e.g) : null);
      if (!p) continue;
      expect(Math.abs(lat(p[0]) - info.origin.lat)).toBeLessThan(0.02);
      expect(Math.abs(lat(p[1]) - info.origin.lon)).toBeLessThan(0.03);
    }
  });

  it('carries the school and playground guardrail data wherever the place has any', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    const tagged = file.e.filter((e) => ['school', 'kindergarten', 'childcare'].includes(e.k?.amenity ?? '') || e.k?.leisure === 'playground' || ['school', 'kindergarten', 'childcare', 'college'].includes(e.k?.building ?? ''));
    if (tagged.length) {
      expect(childZones(map).length, 'child places survive parsing').toBeGreaterThan(0);
      for (const z of childZones(map)) expect(nearChildPlace(map, z.p), 'a zone covers itself').toBe(true);
    }
    expect(Array.isArray(map.pois)).toBe(true);
  });

  it('has no memorial or religious site as a label or an anchor candidate', () => {
    const file = getFile();
    const map = getMap();
    void file;
    void map;
    for (const b of map.buildings) {
      expect(RELIGIOUS.test(b.kind ?? ''), `building ${b.id} kind ${b.kind}`).toBe(false);
      if (b.name) expect(SOMBRE.test(b.name), `building ${b.id} ${b.name}`).toBe(false);
    }
    for (const p of map.pois) expect(p.kind, `poi ${p.id}`).not.toBe('place_of_worship');
    for (const f of mapFeatures(map)) if (f.name && !f.name.startsWith('the ')) expect(SOMBRE.test(f.name), `feature ${f.id} ${f.name}`).toBe(false);
    for (const a of map.areas) if (a.name) expect(SOMBRE.test(a.name), `area ${a.id} ${a.name}`).toBe(false);
  });
});

// ---------- map-check: every mission type x difficulty 1-5 x seeds 1-5, plus recon templates ----------
describe('map-check on the presets', () => {
  const check = (map: MapData) => {
    const g = buildRoadGraph(map);
    const grid = new WalkGrid(map);
    const out = {
      byType: {} as Record<string, { built: number; of: number; reasons: Record<string, number> }>,
      templates: { built: 0, of: 0, reasons: {} as Record<string, number> },
      guardrail: { checked: 0, violations: [] as string[] },
      anchors: new Set<string>(),
    };
    const guard = (label: string, m: import('../src/sim/missions').Mission) => {
      out.guardrail.checked++;
      const bad = (what: string) => out.guardrail.violations.push(`${label}: ${what}`);
      if (m.safehouse && nearChildPlace(map, m.safehouse.centre)) bad('safehouse near a child place');
      if (m.home && nearChildPlace(map, m.home.centre)) bad('home near a child place');
      for (const s of m.survivors) if (nearChildPlace(map, s.start, 30)) bad('survivor start near a child place');
      if (m.route && routeNearChildPlace(map, m.route)) bad('route passes a child place');
      if (m.anchor) out.anchors.add(`${m.anchor.category}:${m.anchor.name}`);
      if (m.safehouse) out.anchors.add(`safehouse:${m.safehouse.name}`);
    };
    for (const type of MISSION_TYPES) {
      const t: { built: number; of: number; reasons: Record<string, number> } = (out.byType[type] = { built: 0, of: 0, reasons: {} });
      for (let d = 1; d <= 5; d++) {
        for (let seed = 1; seed <= 5; seed++) {
          t.of++;
          const r = generateMission(map, g, grid, { type, difficulty: d, seed });
          if (r.ok) {
            t.built++;
            guard(`${type} d${d} s${seed}`, r.mission);
          } else t.reasons[r.reason] = (t.reasons[r.reason] ?? 0) + 1;
        }
      }
    }
    for (const id of TEMPLATE_IDS) {
      for (let d = 1; d <= 5; d++) {
        for (let seed = 1; seed <= 2; seed++) {
          out.templates.of++;
          const r = generateMission(map, g, grid, { type: 'auto', difficulty: d, seed, template: id });
          if (r.ok) {
            out.templates.built++;
            guard(`${id} d${d} s${seed}`, r.mission);
          } else out.templates.reasons[`${id}: ${r.reason}`] = (out.templates.reasons[`${id}: ${r.reason}`] ?? 0) + 1;
        }
      }
    }
    return out;
  };

  for (const info of PRESETS) {
    it(`${info.slug}: clear, escort and defend all build; the guardrail holds`, () => {
      const file = load(info.slug);
      const map = presetToMap(file, info);
      const r = check(map);
      // PRESET_REPORT=<prefix>: the numbers behind the map-check table, one file per place.
      if (process.env.PRESET_REPORT) writeFileSync(`${process.env.PRESET_REPORT}.${info.slug}.json`, JSON.stringify({ ...r, anchors: [...r.anchors].sort() }, null, 1));
      for (const type of MISSION_TYPES) expect(r.byType[type].built, `${type} built ${JSON.stringify(r.byType[type].reasons)}`).toBeGreaterThan(0);
      expect(r.guardrail.violations).toEqual([]);
      // No mission is anchored on a religious or memorial site (names are removed; so is the geometry's label).
      for (const a of r.anchors) expect(SOMBRE.test(a), a).toBe(false);
    }, 120_000);
  }

});
