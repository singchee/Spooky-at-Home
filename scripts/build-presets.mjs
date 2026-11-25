// Builds public/maps/presets/<slug>.json from raw Overpass answers (BACKLOG 3.27).
// Usage: node scripts/build-presets.mjs <rawDir> [--out public/maps/presets]
//   <rawDir> holds <key>.core.json and <key>.extras.json: the answers of the game's own core and
//   extras queries (src/map/overpass.ts buildQuery), downloaded once per place from an allowed
//   Overpass host. This keeps only the tags the game reads, rounds coordinates to 1e-5 degrees
//   (about 1 m), delta-codes them (format: src/map/presets.ts) and applies the tone filter
//   (no memorial, religious or disaster site as a mission anchor or label). Writes a report of
//   what was dropped to maps/preset-exclusions.json so a checker can audit it.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';

const rawDir = process.argv[2];
const outDir = process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'public/maps/presets';
if (!rawDir) throw new Error('usage: node scripts/build-presets.mjs <rawDir> [--out dir]');

const PLACES = {
  sydney: { slug: 'sydney-circular-quay', country: 'Australia', city: 'Sydney', area: 'Circular Quay & The Rocks', origin: { lat: -33.8585, lon: 151.212 } },
  london: { slug: 'london-tower', country: 'United Kingdom', city: 'London', area: 'Tower of London & Tower Bridge', origin: { lat: 51.507, lon: -0.0757 } },
  nyc: { slug: 'new-york-midtown', country: 'United States', city: 'New York', area: 'Times Square & Midtown', origin: { lat: 40.756, lon: -73.9845 } },
  paris: { slug: 'paris-eiffel', country: 'France', city: 'Paris', area: 'Eiffel Tower & Champ de Mars', origin: { lat: 48.8565, lon: 2.297 } },
  tokyo: { slug: 'tokyo-shibuya', country: 'Japan', city: 'Tokyo', area: 'Shibuya Crossing', origin: { lat: 35.663, lon: 139.701 } },
  rome: { slug: 'rome-colosseum', country: 'Italy', city: 'Rome', area: 'Colosseum', origin: { lat: 41.8905, lon: 12.4925 } },
};
const HALF = 600;
const SOURCE = process.env.PRESET_SOURCE ?? 'overpass.kumi.systems';
const DATE = process.env.PRESET_DATE ?? new Date().toISOString().slice(0, 10);

// Every tag src/map/overpass.ts reads (parseOverpass, featureCategory, areaKind, buildingHeight, bus routes).
const KEEP = ['building', 'height', 'building:levels', 'name', 'highway', 'leisure', 'landuse', 'natural', 'amenity', 'shop', 'club', 'sport', 'railway', 'public_transport', 'bus', 'access', 'ref', 'route'];
const RELIGIOUS_BUILDING = /^(church|cathedral|chapel|mosque|temple|synagogue|shrine|religious|monastery|presbytery|kingdom_hall|basilica|stupa|pagoda)$/;
const SOMBRE_NAME = /memorial|cenotaph|monument|war grave|9\/11|ground zero|cemetery|graveyard|holocaust|martyr|victims|massacre|disaster|church|cathedral|chapel|mosque|temple|synagogue|shrine|basilica|abbey|chiesa|eglise|église|notre-dame|神社|寺院|教会|記念|慰霊|忠魂|墓/i;

const q = (n) => Math.round(n * 1e5);
// Whole numbers as text: zigzag, then 5 bits per character with a continue bit (src/map/presets.ts unpackInts).
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_';
const pack = (ints) => {
  let out = '';
  for (const v of ints) {
    let z = v < 0 ? -v * 2 - 1 : v * 2;
    while (z >= 32) {
      out += DIGITS[(z % 32) + 32];
      z = Math.floor(z / 32);
    }
    out += DIGITS[z];
  }
  return out;
};
const flat = (pts) => {
  const out = [];
  let la = 0;
  let lo = 0;
  for (const g of pts) {
    if (!g) continue;
    const a = q(g.lat);
    const b = q(g.lon);
    out.push(a - la, b - lo);
    la = a;
    lo = b;
  }
  return pack(out);
};

const exclusions = {};

function cleanTags(tags, key, el) {
  const t = {};
  for (const k of KEEP) if (tags[k] !== undefined) t[k] = tags[k];
  const en = tags['name:en'];
  if (en && /^[\x20-\x7eÀ-ɏ]+$/.test(en)) t.name = en;
  const log = (why) => ((exclusions[key] ??= []).push({ id: `${el.type[0]}${el.id}`, why, name: tags.name ?? tags['name:en'] }));
  // Tone: no memorial, religious or disaster site as a mission anchor or label.
  const religious = tags.amenity === 'place_of_worship' || RELIGIOUS_BUILDING.test(tags.building ?? '') || !!tags.religion;
  const sombre = !tags.highway && !!t.name && SOMBRE_NAME.test(t.name); // street names are left alone
  if (religious || sombre || tags.historic === 'memorial' || tags.memorial) {
    const isBuilding = !!t.building;
    if (religious || tags.historic === 'memorial' || tags.memorial) log(isBuilding ? 'building neutralised (no name, no amenity)' : 'dropped');
    else log(isBuilding ? 'name removed' : 'dropped (sombre name)');
    if (isBuilding) {
      t.building = 'yes';
      delete t.name;
      delete t.amenity;
      return t;
    }
    return null;
  }
  return t;
}

function compact(key, raw) {
  const e = [];
  const trees = [];
  const lamps = [];
  const prev = { trees: [0, 0], lamps: [0, 0] };
  const add = (list, which, lat, lon) => {
    const a = q(lat);
    const b = q(lon);
    list.push(a - prev[which][0], b - prev[which][1]);
    prev[which] = [a, b];
  };
  const dropped = { tags: 0 };
  for (const el of raw) {
    const tags = el.tags ?? {};
    if (el.type === 'node') {
      if (tags.natural === 'tree') {
        add(trees, 'trees', el.lat, el.lon);
        continue;
      }
      if (tags.highway === 'street_lamp') {
        add(lamps, 'lamps', el.lat, el.lon);
        continue;
      }
      const k = cleanTags(tags, key, el);
      if (!k || !Object.keys(k).length) continue;
      e.push({ t: 'n', i: el.id, p: [q(el.lat), q(el.lon)], k });
    } else if (el.type === 'way') {
      if (!el.geometry || el.geometry.length < 2) continue;
      const k = cleanTags(tags, key, el);
      if (!k || !Object.keys(k).length) continue;
      e.push({ t: 'w', i: el.id, g: flat(el.geometry), k });
    } else if (el.type === 'relation') {
      if (tags.route === 'bus') {
        const m = (el.members ?? [])
          .filter((x) => x.type === 'way' && x.geometry && (!x.role || x.role === 'forward' || x.role === 'backward'))
          .map((x) => ({ r: x.ref, ...(x.role ? { o: x.role } : {}), g: flat(x.geometry) }))
          .filter((x) => x.g.length >= 4); // members clipped away by the bbox come back empty
        const k = {};
        for (const n of ['ref', 'name', 'route']) if (tags[n] !== undefined) k[n] = tags[n];
        if (m.length) e.push({ t: 'r', i: el.id, k, m });
      } else {
        const k = cleanTags(tags, key, el);
        if (!k || !Object.keys(k).length) continue;
        const outer = (el.members ?? [])
          .filter((x) => x.type === 'way' && x.geometry && (!x.role || x.role === 'outer'))
          .map((x) => ({ r: x.ref, ...(x.role ? { o: x.role } : {}), g: flat(x.geometry) }));
        e.push({ t: 'r', i: el.id, k, ...(el.center ? { p: [q(el.center.lat), q(el.center.lon)] } : {}), ...(outer.length ? { m: outer } : {}) });
      }
    }
  }
  return { e, trees: pack(trees), lamps: pack(lamps), dropped };
}

mkdirSync(outDir, { recursive: true });
const sizes = {};
for (const [key, p] of Object.entries(PLACES)) {
  if (!existsSync(`${rawDir}/${key}.core.json`)) {
    console.warn(`skipping ${key}: raw download missing`);
    continue;
  }
  const core = JSON.parse(readFileSync(`${rawDir}/${key}.core.json`, 'utf8')).elements;
  // The extras (trees, street lamps, bus routes) are looks only; a place whose extras download kept
  // failing ships without them. Missions never use them.
  const hasExtras = existsSync(`${rawDir}/${key}.extras.json`);
  if (!hasExtras) console.warn(`${key}: no extras download, built from the core alone`);
  const extras = hasExtras ? JSON.parse(readFileSync(`${rawDir}/${key}.extras.json`, 'utf8')).elements : [];
  const { e, trees, lamps } = compact(key, [...core, ...extras]);
  const file = {
    spooky_preset: {
      slug: p.slug,
      name: `${p.area}, ${p.city}`,
      country: p.country,
      area: p.area,
      city: p.city,
      origin: p.origin,
      half: HALF,
      downloaded: DATE,
      source: SOURCE,
      license: 'Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0',
    },
    e,
    trees,
    lamps,
  };
  const text = JSON.stringify(file);
  writeFileSync(`${outDir}/${p.slug}.json`, text);
  sizes[p.slug] = { extras: hasExtras, bytes: text.length, elements: e.length };
}
writeFileSync('maps/preset-exclusions.json', JSON.stringify(exclusions, null, 1)); // kept out of public/: an audit list, not a game file
console.log(JSON.stringify(sizes, null, 1));
for (const [k, v] of Object.entries(exclusions)) console.log(k, v.length, 'tone exclusions');
