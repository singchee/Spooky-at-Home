# OpenFreeMap vector tiles as a replacement for the Overpass download

Research spike, 2026-11-22. Question: can OpenFreeMap vector tiles replace most of the slow Overpass download?
Scripts and raw outputs (not committed): the session scratchpad `ofm/` folder (`tiles.sh`, `compare.mjs`, `out-*.json`, `timing-*.log`).
Only the three public fixtures were used (`spooky_fixture.origin` of adelaide-cbd, west-hobart, gundagai).

## Verdict: (b) tiles for the map, plus a small Overpass query for the gaps

Tiles give buildings, roads with street names, parks, woods, water, pitches, most POIs and school/playground outlines
in **0.2 to 0.6 s** (2 to 4 requests, 49 to 353 KB gzipped), against 2½ to 5 minutes of queueing for Overpass.
They cannot replace Overpass entirely because:

- **`amenity=childcare` is not in the OpenMapTiles schema.** Adelaide's only day-care centre is missing from tiles, so the
  child-place guardrail (PLAN §9) would be blind to it. A guardrail input cannot be optional.
- No building type (`building=*`), no building names, no individual building ids, no trees, no street lamps, no bus routes.

A residual Overpass query (childcare/kindergarten/school outlines, `building=school|kindergarten`) is about **5 to 20 KB**
on the fixtures, but the earlier spike shows small queries queue as long as big ones (the "extras" and "highways" parts
waited 136 to 278 s and then failed with 504). Size does not help; it would still queue. See "Proposed design" for how
to live with that.

## 1. Terms and service (openfreemap.org, read 2026-11-22)

| Item | What it says |
|---|---|
| Cost, keys | "Using our public instance is completely free: there are no limits on the number of map views or requests. There's no registration, no user database, no API keys, and no cookies." |
| Commercial use | "Is commercial usage allowed? Yes." |
| Attribution | "Attribution is required. [...] If you are using alternative clients [...] you must add the following attribution: **OpenFreeMap © OpenMapTiles Data from OpenStreetMap**. You do not need to display the OpenFreeMap part, but it is nice if you do." |
| Licence | Project MIT; map data OpenStreetMap (ODbL); schema OpenMapTiles ("The map schema is unmodified OpenMapTiles"). |
| Automated use (ToS) | "You will not: [...] Collect data from the service in automated ways, except for offline downloads as described below." |
| Offline downloads (ToS) | Allowed "if each download is: at most 3,000 tiles or 50 MB; made with at most 4 parallel requests; sent with a unique User-Agent identifying your app." |
| Availability (ToS) | "provided 'as-is' [...] may discontinue it at any time without notice." No SLA. Served via Cloudflare. |
| CORS | `access-control-allow-origin: *`, so browsers may fetch tiles directly. |

TileJSON: `https://tiles.openfreemap.org/planet` (TileJSON 3.0.0, OpenMapTiles 3.16.0, minzoom 0, **maxzoom 14**).
Tile URLs are versioned per build: `https://tiles.openfreemap.org/planet/20261115_080022_pt/{z}/{x}/{y}.pbf`.
z15 returns HTTP 200 with an empty body, so z14 is the full-detail level. Builds are weekly (home page: "weekly full planet
downloads"); the current build is dated 2026-11-15. Tiles are gzip, `cache-control: max-age=315360000` (immutable per version).

Layers at z14: building (`render_height`, `render_min_height`, `colour`, `hide_3d` only), transportation (`class`,
`subclass`, `brunnel`, `service`, ...; **no name**), transportation_name (`name`, `class`, `ref`, road `route_N_*`),
landuse, landcover, park, water, waterway, poi (`class`, `subclass`, `name`, `rank`), housenumber, place, boundary,
plus label layers.

## 2. Timing and size (this cloud container, through the agent proxy)

Area: the game's 1.2 × 1.2 km square at z14 (tile width 1.8 to 2.0 km at these latitudes, so always 1 to 4 tiles).
Requests in parallel; "wall" is the whole set.

| Fixture | Tiles | Gzipped over the wire | Decoded PBF | Cold wall (TTFB per tile) | Warm wall | Decode (node) | Overpass fixture |
|---|---|---|---|---|---|---|---|
| adelaide-cbd | 2 | 353 KB | 619 KB | 0.46 s (0.31 to 0.36) | 0.21 s | 40 ms | 4.26 MB, queued minutes |
| west-hobart | 2 | 176 KB | 268 KB | 0.24 s (0.11 to 0.23) | 0.16 s | 28 ms | 2.18 MB, 259 s to first byte |
| gundagai | 4 | 49 KB | 70 KB | 0.55 s (0.31 to 0.51) | 0.19 s | 11 ms | 0.37 MB |

Cold runs were partly Cloudflare `MISS` (rural tiles), partly `HIT` (Adelaide). **Expected at home:** 0.3 to 1 s for the
download on ordinary broadband, about 1 to 2 s on a slow phone link for a dense city centre, plus well under 100 ms to decode.

## 3. Layer by layer against the Overpass fixture (as `parseOverpass` + `mapFeatures` + `childZones` see it)

Tile features in neighbouring tiles' buffers were de-duplicated by which tile holds their centre (or a segment's midpoint).

| Game need | adelaide-cbd | west-hobart | gundagai | Gap |
|---|---|---|---|---|
| Building footprints (fixture / tiles; fixture centroids inside a tile footprint) | 1486 / 1557; 98% | 2427 / 2456; 98% | 377 / 377; 99% | None worth noting. Buildings arrive merged into a few MultiPolygon features (67, 19, 3), so **no per-building OSM id**. |
| Building vertices (fixture / tiles) | 8907 / 9954 | 24389 / 22682 | 1808 / 2123 | No visible simplification at z14. |
| Height | 1179 of 1488 tagged; tiles give `render_height` (316 at the 5 m default) | 13 tagged; tiles all default | 0 tagged; tiles all default | OK: `render_height` = height, or levels × 3.66, else 5. |
| Building type (`house`, `school`...) and name | 152 houses, 229 named | 13 `building=school` | 295 houses | **Missing.** Used by roofs/windows (`world/buildings.ts`), survivor placement (`world/placement.ts`), diorama colours and the child-building guardrail (`recon.ts` l.93, `sim/missions.ts` l.197). |
| Road length (fixture / tiles, m) | 88.3 k / 89.5 k | 28.6 k / 29.1 k | 24.8 k / 26.6 k | Classes coarser: residential + unclassified + living_street = `minor`; footway/cycleway/steps in `path` subclass. Tiles add tram lines, `motorway` includes links. Lines are merged across ways (no way ids) and split at tile seams. |
| Street names (fixture names found in tiles) | 181 / 182 | 76 / 76 | 22 / 22 | Names live in a separate `transportation_name` layer: needs a geometric join onto road segments. |
| Parks, woods, water | park 64 k m² vs landcover park+grass ≈ 69 k m² | park 60 k m² vs park/grass/wood ≈ 76 k m² | park 219 k, water 12 k vs ≈ 197 k and 15 k | OK (park layer, landcover grass/wood, water). Tiles also have golf course, nature reserve. |
| Named places: park, supermarket, mall, hospital, police, fire station, sports centre, parking, bus station (names matched) | 34 of 35 named matched (miss: the childcare centre) | 9 of 9 | 6 of 7 (the school comes only as an unnamed outline) | Mostly OK as points (poi layer, OSM-derived ids). A school name can be missing when OSM tags only the grounds. |
| Pitches | 0 | 12 game / 16 landuse polygons + 15 POIs | 13 / 16 + 15 | OK (`landuse` class `pitch`; POI subclass = sport). Tennis is `pitch/tennis`; `club=tennis` is not in the schema (no fixture has one). |
| School / kindergarten / playground **outlines** (game zones matched by a tile polygon) | 13 / 14 | 13 / 15 | 3 / 3 | Schools and playgrounds come as `landuse` polygons. **Missed: Adelaide's `amenity=childcare` (584 m²)**; West Hobart's two misses are a 193 m² `building=school` and a 113 m² school playgroup building. |
| Trees, street lamps | 1141 trees, 526 lamps | none mapped | 32 trees | **Missing** (not in schema). Looks only. |
| Bus routes | 87 | 0 | 1 | **Missing** (route fields are road networks such as `AU:NSW:T`). |

Precision: extent 4096 over 1.8 to 2.0 km, so coordinates snap to a **0.44 to 0.49 m grid**; invisible at gunship altitude.
Clipping: every feature is clipped to its tile plus a buffer, so a building or road that crosses a tile seam arrives as two
pieces that must be de-duplicated (by tile ownership) and, for roads, re-joined.

## 4. Proposed design if we adopt it

1. Blocking load: TileJSON (cacheable) + 1 to 4 z14 tiles → `parseTiles()` producing the same `MapData`. Building ids from a
   hash of the rounded footprint; road ids from geometry; street names joined from `transportation_name` by nearest line.
2. Building `kind`: estimate from footprint area and height (the game already has defaults by kind).
3. Guardrail: one small Overpass query for `amenity~school|kindergarten|childcare` (way + relation outlines) and
   `building~school|kindergarten`, about 5 to 20 KB. Because it still queues for minutes, either (a) generate missions only
   once it answers, with tiles letting the player fly and see recon meanwhile, or (b) owner decision: accept tile-only child
   zones with a wider buffer around every unclassified building inside or next to a `landuse` school polygon. Option (a)
   keeps the guardrail exact; (b) does not cover stand-alone childcare centres like Adelaide's.
4. Trees, lamps and bus routes stay in the existing background "extras" query (2.7 MB for Adelaide, mostly bus routes).
5. Keep the Overpass path as the fallback: OpenFreeMap has no SLA.

## 5. Risks

- **Usage policy (needs a human decision).** The ToS forbids collecting data "in automated ways" except offline downloads,
  and the game reads tile geometry rather than drawing a slippy map. Our use (2 to 4 tiles per mission, on a player action,
  4 requests at most in parallel) is far inside the offline-download limits, but a browser cannot set a unique
  User-Agent. Recommend emailing info@openfreemap.org to confirm before shipping; self-hosting their weekly PMTiles is
  the fallback.
- **Plan change.** `docs/QUALITY.md` lists the only hosts the game may contact; `tiles.openfreemap.org` must be added there
  (hard rule 5), and the privacy note should say tile requests reveal the area to OpenFreeMap and Cloudflare.
- **Attribution.** On screen whenever a tile-based map is shown: "OpenFreeMap © OpenMapTiles Data from OpenStreetMap"
  (current string is "Map data © OpenStreetMap contributors (ODbL)"; OpenStreetMap must stay, OpenMapTiles must be added).
- **Determinism.** Same place + seed gives the same mission only while the tile build is the same. Builds change weekly
  and the URL carries the build name, so record it (e.g. `20261115_080022_pt`) with any saved or shared mission. Whether old
  builds stay online is unknown (the `planet/` index returns 403). Overpass is live data, so this is no worse than today.
- **Schema gaps** listed above; the childcare gap is the one that matters for the guardrail.
- **Service may disappear** without notice; keep the Overpass loader working.
