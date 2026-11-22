# Famous places: map credits

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL) 1.0.
https://www.openstreetmap.org/copyright · https://opendatacommons.org/licenses/odbl/1-0/

These files are a **derived database** of OpenStreetMap data, so they are offered under the same ODbL 1.0
licence, with the attribution above. Anyone may copy, adapt and share them under those terms.

| File | Place | Download date | Source |
|---|---|---|---|
| `new-york-midtown.json` | Times Square & Midtown, New York, United States | 2026-11-22 | overpass.kumi.systems |
| `paris-eiffel.json` | Eiffel Tower & Champ de Mars, Paris, France | 2026-11-22 | overpass.kumi.systems |

**Outstanding:** Sydney (Circular Quay & The Rocks), London (Tower of London & Tower Bridge), Tokyo (Shibuya Crossing)
and Rome (Colosseum) are planned (`ALL_PRESETS` in `src/map/presets.ts`) but not yet bundled: their core
query timed out or was refused (HTTP 502/504, empty reply) on every allowed attempt on 2026-11-22. A second
round on 2026-11-22 (overpass.kumi.systems, one request at a time, 61 s apart, 15 failures in total, including two
south/north half-core splits for Sydney and London) also failed for Sydney, London and Rome; Tokyo was not reached.
Retry from a machine with a working Overpass route.

Each file was downloaded once with the game's own core and extras queries (`src/map/overpass.ts`), a
1.2 km by 1.2 km area around the centre in its `spooky_preset` header. It was then reduced by
`scripts/build-presets.mjs`: only the tags the game reads were kept, coordinates were rounded to about
1 m, and religious sites, memorials and the like were stripped of their names so that no mission is
anchored on or labelled with one (`maps/preset-exclusions.json` in the repository lists what was changed). These are public landmark
areas; no private address or personal map is included.

To swap a place, download the two queries for a new centre, run `node scripts/build-presets.mjs <rawDir>`
and update `PRESETS` in `src/map/presets.ts` and the table above.
