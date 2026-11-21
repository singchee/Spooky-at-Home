# Pylon Turn — build plan and architecture

*A gunship game that builds its missions from a real neighbourhood map*

## 1. What we are building

You are the sensor and gun operator in a gunship circling above a neighbourhood at night. You see the ground through a black-and-white thermal camera (warm things show bright). You switch between three guns and complete missions against zombie hordes. **The main feature:** you type in an address, the game downloads that area's streets and buildings from OpenStreetMap (the free, volunteer-built world map), and it builds a mission from what is actually there: the local school becomes the safehouse, the park becomes where the horde gathers, and real street names appear in the briefing.

"Pylon turn" is the name of the real flying manoeuvre: a constant-bank circle that keeps one side of the aircraft pointed at one spot on the ground. The game's name, art, user interface and missions are all our own. It belongs to the gunship genre but copies no existing game.

## 2. Key decisions (ranked, with reasons)

| # | Decision | Choice | Why | What would change it |
|---|---|---|---|---|
| 1 | Engine / platform | **Browser game: TypeScript + three.js + Vite** | No install. The player's browser downloads map data directly, so nothing runs on a server. You can share a game with a link. It is fast to iterate with Claude Code in the cloud. | You want photo-real colour views of your actual house → Unreal or Unity with Cesium and Google Photorealistic 3D Tiles (see §7). |
| 2 | Visual style | **Thermal camera (white-hot / black-hot)** | It is authentic to the genre. It also **hides the low detail of map data**: OpenStreetMap gives building outlines and heights, not textures, and in thermal view a plain block looks right. | Same as above. |
| 3 | Map source | **OpenStreetMap through the Overpass API** (a public query service) **+ Nominatim** (OpenStreetMap's address search) | Free, no account or key, worldwide, and has building heights, road types, street names, parks, schools and hospitals. | Areas with poor map coverage → fill the gaps with procedurally generated houses. |
| 4 | Mission creation | **Fixed rules with a seed, not AI-generated** | Rules guarantee every mission can be won: the route exists, the spawn points are reachable, the timings are fair. The same address + seed always gives the same mission, so you can replay it and share it. | An optional AI layer may later *rewrite the briefing text only* (§6, phase 5), never the mission logic. |
| 5 | Enemies and civilians | Zombies are enemies. Survivors carry flashing infrared markers and **hitting them fails the mission.** | This keeps targets unambiguous over a real neighbourhood, and the rules of engagement (rules about when you may fire) become a gameplay skill. | — |

**The assumption everything rests on:** a stylised thermal view of map outlines will feel like *your* neighbourhood. Street layout, building heights and real street names usually carry recognition, and roof textures do not. **What would prove it wrong:** you load your own suburb in phase 2 and it doesn't feel like home. If so, phase 5's terrain and imagery options become the priority.

## 3. Architecture

```
┌────────────── MENU ───────────────┐
│ address / "lat, lon" | sample town │
│ | upload saved map file            │
│ mission type · difficulty · seed   │
└───────────────┬────────────────────┘
                ▼
┌──────────── MAP SOURCE ─────────────────────────────────────┐
│ geocode()  → Nominatim (address → lat/lon)                  │
│ fetchOverpass() → OpenStreetMap features in a ~1 km square  │
│ parseOverpass() → MapData  (local metres, origin = centre)  │
│ makeSampleTown() → MapData (offline, used by tests)          │
└───────────────┬─────────────────────────────────────────────┘
                ▼  MapData {buildings, roads, areas, pois}
   ┌────────────┼──────────────────┬───────────────────────┐
   ▼            ▼                  ▼                       ▼
World builder  Road network        Walk grid               Mission generator
(3D meshes:    (junctions + A*     (3 m cells: blocked     (seeded rules: picks
 extruded       route finding,     by buildings/water;     safehouse, home, route,
 buildings,     for survivors)     zombie "flow field" =   spawn points, waves,
 roads, parks)                     path-to-target map)     briefing text)
   └────────────┴──────────┬───────┴───────────────────────┘
                           ▼
┌──────────────────── GAME LOOP (60 fps) ───────────────────────┐
│ Orbit camera: aircraft circles; aim point stays fixed to the   │
│   ground as you fly (as a real sensor does)                    │
│ Weapons: 25/40/105 mm · rate of fire · reload · shell flight   │
│   time (you must lead moving targets)                          │
│ Agents: zombies (follow flow field, mill, attack) · survivors  │
│   (walk route home, panic)                                     │
│ Effects: blasts, craters that glow then cool, bodies cool      │
│ Rules: win/lose, friendly-fire check, timers, scoring          │
│ Thermal filter: greyscale, polarity, sensor noise, vignette    │
│ HUD: weapon, ammo, objective, radio log, crosshair per gun     │
└────────────────────────────────────────────────────────────────┘
```

**Where the code lives**

| Folder | What it does |
|---|---|
| `src/map/` | Coordinate conversion, OpenStreetMap download/parse, sample town, road network, walk grid |
| `src/world/` | Turns MapData into 3D meshes (merged into a few draw calls for speed) |
| `src/render/` | Thermal camera filter |
| `src/game/` | Game loop, weapons, agents, effects, mission generator, scoring |
| `src/ui/` | Menu, HUD, briefing and debrief screens |
| `src/audio/` | Sound effects made in code (later: recorded crew voice lines) |
| `tests/` | Rule-based tests: coordinate conversion, route finding, and that every mission type can be won on the sample map at every difficulty |

**Rule-based vs AI-generated parts.** All of version 1 is rule-based and repeatable. If an AI briefing writer is added later, it gets the finished mission as input and may only return text. A checker rejects any output that names streets or places not in the mission. If it fails or times out, the game uses the template text.

## 4. How a map becomes a mission

| Map feature (from OpenStreetMap) | Becomes |
|---|---|
| School, hospital, police, fire station, community centre | Safehouse / survivors' starting point |
| Houses 300–800 m away by road | "Home" destination for escort missions |
| Road network | Survivors' route home (shortest path), shown on the map |
| Parks, reserves, edges of the map | Where hordes gather and waves enter |
| Street and place names | Briefing text ("Get four survivors from Wattle Hill Primary to a house on Banksia Street") |
| Building heights | Cover: tall buildings block shots, so you have to time your orbit |

**Mission types**

| Type | Goal | Fail if | Version |
|---|---|---|---|
| **Clear the horde** | Destroy every horde before time runs out; friendlies are sheltering nearby | Time runs out, or you hit friendlies | 1 |
| **Get them home** (escort) | Survivors walk from the safehouse to a home by road while waves close in; at least half must arrive | Too few arrive, or 2+ friendly-fire kills | 1 |
| **Hold the safehouse** | Stop waves reaching the building until the timer ends | Building's integrity reaches zero | 1 |
| Evacuation | Keep a landing zone clear until a helicopter lands | — | 2 |
| Find the nest | Zombies come from a hidden source; scout with the narrow zoom | — | 2 |
| Convoy | Escort vehicles on the main roads (faster, longer routes) | — | 2 |

**Difficulty (1–5) adjusts:** horde size, how often waves come, route length, zombie speed, how many friendlies are near targets, and time limits. **Campaign:** a chain of missions on the same map using one seed (clear → escort → hold), so one address gives a short story.

## 5. Weapons

| Gun | Field of view | Rate of fire | Magazine / reload | Shell flight time* | Blast radius | Role |
|---|---|---|---|---|---|---|
| 25 mm | narrow, 5° | 12/s | 60 / 3 s | ~2 s | 3.5 m | Precise; close to friendlies |
| 40 mm | medium, 10° | 2.5/s | 8 / 3.5 s | ~2.5 s | 7 m | General use |
| 105 mm | wide, 22° | 1 per 4 s | 1 / 4.5 s | ~4.5 s | 18 m | Hordes; dangerous near friendlies |

*From a slant range of about 2.2 km. The delay is deliberate: you have to lead moving targets. **Controls:** mouse aims (click to capture the pointer), hold the mouse button to fire, `Q` or `1/2/3` to switch guns, `Z` to zoom, `H` to switch white-hot/black-hot, `R` to restart.

## 6. Delivery phases

| Phase | What you get | Done when |
|---|---|---|
| **0. Scaffold** *(in progress)* | Repo, build tooling, tests, map loader, sample town | `npm test` passes; sample map loads |
| **1. Playable slice** | Sample town; orbit + thermal camera; 3 guns; zombies and survivors; 3 mission types; HUD; win/lose | You can play all 3 mission types end to end in the browser |
| **2. Your neighbourhood** | Address search → download → mission; save/load map files; loading progress; handling for missing or partial map data | Your own suburb loads in under 15 s and produces a winnable mission of each type |
| **3. Feel** | Crew radio voice lines, better sound, screen shake, scoring and grades, campaign chain | Playtest: "feels like a gunship" |
| **4. Depth** | Vehicles, evacuation/nest/convoy missions, day/night, ground height from elevation data | — |
| **5. Optional extras** | AI briefing writer (with checker), photo-real tiles experiment, shareable mission links | Each is a separate yes/no decision |

## 7. Connectors and services

| Service | Needed? | What for | Notes |
|---|---|---|---|
| **GitHub** | **Yes** | Hosting the repo | This cloud session cannot create repos. You create an empty private repo `pylon-turn`, then I attach it and push. |
| **OpenStreetMap: Overpass + Nominatim** | **Yes (no connector, no key)** | Map data and address search | Called from your browser at play time. These sites are blocked from this cloud container, so I test with the sample town and saved map files. To test real downloads here, the environment would need `overpass-api.de` and `nominatim.openstreetmap.org` allowed. Their usage rules: keep requests small, at most 1 address search per second, and credit OpenStreetMap on screen. |
| **ElevenLabs** | Useful, phase 3 (**already connected**) | Crew radio callouts ("Good hits", "Check fire, friendlies!") and sound effects | Generate about 30–60 short lines once and save them in the repo. Uses your credits, so I'll confirm the list before generating. |
| **Elevation tiles (AWS Terrarium)** | Optional, phase 4 | Hills and valleys | Free, no key, reachable from here. |
| **Blender MCP** | **Not yet; low value for version 1** | Letting Claude model 3D assets in Blender | Needs Blender running on *your* computer with a local Claude session, not this cloud one. From 2 km away a zombie is a few pixels, so simple shapes or free CC0 (public-domain) asset packs such as Kenney and Quaternius are enough. Worth adding in phase 4 for a detailed aircraft or vehicles. |
| **Claude API key** | Optional, phase 5 | Flavour text for briefings | Added through the environment's credential form, never put in code. |
| Google Maps / Photorealistic 3D Tiles, Mapbox | **Not recommended for now** | Photo-real or styled maps | Need an API key and billing. Their terms limit caching and offline use, so check the current terms before relying on them [UNVERIFIED]. This is the route only if the photo-real look becomes a must-have. |
| Figma | Not needed | — | It also failed to connect in this session. |

## 8. Risks and what we do about them

| Risk | Likelihood | Early warning | What we do | Risk that remains |
|---|---|---|---|---|
| Overpass is slow, rate-limited or down | Medium | Downloads time out | Second server; save each map to a file to reload; sample town fallback | First load of a new place still needs the service |
| Patchy map data (missing buildings, rural areas) | High outside cities | Few buildings returned | Warn the player; fill empty blocks with procedurally generated houses (phase 2) | Filled-in areas won't match reality |
| Big, dense areas run slowly | Medium | Frame rate drops on load | Cap the play area at ~1.2 km; merge building meshes; draw zombies as one batch | Very old laptops may struggle |
| **Privacy: your home's location** | Real | — | Map files from your area go in `maps/private/` (excluded from git); keep the repo private; sharing a mission link would reveal the location, so it stays opt-in | You decide what to share |
| Tone: firing on a real neighbourhood | Low–medium | Unease in playtesting | Fictional zombies only; no real groups or people; protecting civilians is the core rule | It's a matter of taste |

**Premortem** (imagine it has failed 18 months from now and ask why): the most likely cause is the game working perfectly on the sample town but feeling flat on real maps, because messy real road data breaks routes and spawn points. **Early warning:** in phase 2, test 5 real suburbs of different kinds (inner city, outer suburb, rural town, hilly area, coastal) before building anything else.
