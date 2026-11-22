# Backlog — what the crew builds next

*Ordered list of work. The crew takes the top unblocked item. You approve new phases; the Game Director keeps this ordered within a phase.*

Status: `todo` · `in-progress` · `waiting-on-you` · `done`

## Phase 1 — playable slice (approved)

| # | Item | Needs checks | Status |
|---|---|---|---|
| 1.1 | Road network (junctions, A* routing, largest connected network) and walk grid (blocked cells, zombie flow field) in `src/map` | review, map-check | done (PR, in review) |
| 1.2 | Mission generator: Clear, Get them home, Hold the safehouse; seeded; briefing text from real names; determinism snapshot test (G4) | review, map-check | done (PR, in review) |
| 1.3 | Headless simulation `src/sim`: zombies (warm and cold-blooded), survivors, weapons with shell flight time, damage, friendly fire, win/lose; plus the bot | review, balance | done (PR, in review) |
| 1.4 | 3D world builder and the 3-value sensor render (heat, visible brightness, near-infrared), with thermal (white/black-hot) and night-vision filters | review, playtest | done (PR, in review) |
| 1.5 | Orbit camera, ground-stabilised aiming, firing, blasts, cooling craters and bodies | review, playtest | done (PR, in review) |
| 1.6 | HUD, menu, briefing and debrief screens, OpenStreetMap credit; `window.__spooky` test hook and URL parameters | review, playtest | done (PR, in review) |
| 1.7 | `scripts/playtest.mjs` (headless browser smoke test) and balance runner; activate gates G4–G8 | review | done (PR, in review) |
| 1.8 | **Phase 1 sign-off:** full `/preflight`, `/balance`, screenshots → **escalate to you to play it** (moving to phase 2 is class C) | all | waiting-on-you |

### Found during phase 1 (for the owner's playtest)
| # | Item | Status |
|---|---|---|
| 1.9 | **Difficulty needs a human.** After tonight's fixes: doing nothing loses almost every mission; the human-like bot wins most (Get them home 88–100%, Hold the safehouse d5 25%). The bot finds targets instantly, so you'll find it harder. Needs your playtest before more tuning | waiting-on-you |
| 1.10 | Clear the horde is quick for the bot (21–76 s) because it never has to search; real players will be slower. Re-measure with your playtest | waiting-on-you |
| 1.12 | Phone-width HUD: the sensor label overlaps the radio log at 390 px and 320 px. Hit the 2-round fix limit, so it's parked (the game is mouse-and-keyboard for now) | waiting-on-you |
| 1.11 | "Build this place" (address → real map) can't be tested in the cloud container: OpenStreetMap hosts are blocked. Test on your machine, or allow the hosts | waiting-on-you |

## Phase 3 — in progress (22 Nov)
Four parallel teams on `feat/phase-3`: T1 sound (generated soundtrack, engine drone, mixer), T2 stakes (grades, personal bests, varied waves, settings panel), T3 way in (address flow, loading readout, errors, polish), T4 map detail. **Scheduled runs: don't pick these items up.**

### Decision (owner, 22 Nov): building detail
- **In game:** richer OpenStreetMap buildings and street detail (option 1: free, works anywhere, private). **No Google Photorealistic 3D Tiles**: cost, terms (logo and credits on screen, no caching, unclear whether a thermal filter may alter the imagery) and the realism/tone risk.
- **Briefings:** a clean "blocky" 3D model of the mission area, slowly orbiting, beside the tactical map (backlog 3.5).

| # | Item | Needs checks | Status |
|---|---|---|---|
| 3.5 | Briefing diorama: blocky 3D model of the mission area with landmark labels and mission markers | review, playtest, feel | merged to phase 3 |
| 3.6 | Recorded audio wired in (ElevenLabs music, effects, 20 radio lines; generated score as fallback) | review, playtest, player-test | merged to phase 3 |
| 3.6b | Audio memory on phones: decoded audio is about 140 MB (five 60 s stereo music stems). Stream or mono-mix the music so a tablet isn't killed for memory | review, playtest | todo (before release) |
| 3.7 | Guided briefing walk-through (was the "Hello, home" flyover; owner: "the briefing doesn't walk through the area") | review, playtest, feel | merged to phase 3 (schools never labelled) |
| 3.8 | School guardrail gaps: escort routes avoid schools, straggler starts clear of them, wider horde spacing (owner decision #11) | review, map-check | merged to phase 3 |
| 3.9 | Sensor look: slanted, zoomed-in gunship camera; grain, scanlines, bloom, hot edges; textured ground (owner: "just blocks", bar: Zombie Gunship quality, no copying) | review, playtest, feel | in-progress |
| 3.10 | People: rigged 3D zombie and survivor models (npm package, licence chain to confirm), instanced animation, thermal body heat | review, playtest, feel, licence | in-progress |
| 3.11 | Controls: touch controls on phones and tablets, on-screen hotkeys (R weapon, Q view, Esc pause/briefing), unlimited 25 mm | review, playtest, feel, balance | in-progress |
| 3.12 | Remember places on this device; suburb-level place names (no house numbers); real load timings | review, playtest | merged to phase 3 |
| 3.13 | World dressing: roofs, parked cars, rooftop clutter | review, playtest | done in T4 (map detail) |
| 3.14 | Three Nights campaign (spec 001, owner approved) | plan, review, playtest, feel, balance | core merged; review round 1 PASS (checker re-review); finale + screens next |
| 3.15 | Zombies walk into buildings and vanish: buildings must block movement (owner playtest, 22 Nov) | review, balance, map-check | in-progress |
| 3.16 | Waves too small at level 2: more and bigger hordes per difficulty (owner playtest) | balance, player-test | in-progress |
| 3.17 | Gun sounds: more weight and bass; the 25/40/105 sound hollow (owner playtest) | playtest, player-test | todo |
| 3.18 | Rounds arrive from the gunship off-screen, not from mid-screen (owner playtest; with 3.9) | playtest, feel | in-progress |
| 3.19 | HUD markers on landmarks from the map analysis (tennis club, park…); never schools or other child places (decision #11) | review, playtest, feel | todo |
| 3.20 | Per-server time limit (45–60 s) for the map download: today a slow fallback server can hold the readout for 4+ minutes before saying "busy" (measured by 3.12) | review, playtest | todo |
| 3.21 | "Load a saved map file" guesses the map centre from all coordinates in a raw export and can lose most of a town (Gundagai fixture: 377 → 24 buildings); read the fixture's stored centre | review, map-check | todo |
| 3.22 | Load timing on the owner's own connection (cloud timings are unrepresentative: the main Overpass server reset every request from the cloud) | owner | todo |

| 3.24 | Generator bug: an anchored clear (e.g. tennis club) can build with 0 hordes at the place while its briefing names it ("0 hordes are on the courts"); the campaign now rejects these, single missions don't | review, map-check | todo |
| 3.25 | Campaign store nits: first read throws → save overwrites with this session's places; clock going backwards can trim the newest place; an older build overwrites v2 data | review | todo |

| 3.26 | Estimated wait while OpenStreetMap prepares the area ("Usually about 1–3 min · 0:42 so far"), from this device's own past loads | review, playtest | merged to phase 3 |

**Owner, 22 Nov (map source):** Overpass stays the only map source. The OpenFreeMap hybrid is dropped (research kept in docs/research/openfreemap-trial.md); no new host for the game.

| 3.28 | Upgrade path (owner idea, later): rate of fire, ammunition, damage, splash; tougher zombies as difficulty rises. Chief's note: prefer upgrades that are trade-off choices (e.g. faster 25 mm but overheats) and difficulty from count, speed and types rather than hit points (sponges undercut the one-shot 105 and can't be read in thermal); earned in the campaign and Horde Night only. Decide after human playtests (spec 001 already defers upgrades). | pitch, balance, player-test | later |

| 3.29 | Tech abilities (owner idea, later; pairs with 3.28 upgrades): radar, motion sensors, target indicators, targeted bombing run. Chief's note: anything that shows every zombie undercuts the sensor game and the cold-blooded mechanic (pillar 3), so make them limited and readable: a motion-sensor pulse on a cooldown that shows movers for a few seconds (a counter to cold-blooded that still needs the right camera), Ground marking targets with an IR designator visible in night vision, and a called-in bombing run on a long cooldown with a danger-close check, the school guardrail and flash-safety limits. | pitch, plan, balance, feel | later |

**Owner, 22 Nov:** the 25 mm stays at 60 rounds then reload ("unlimited" was a misunderstanding); 3.11 reverts it.

### Decision (owner, 22 Nov): schools are left out of the game
No school, kindergarten, childcare or playground missions, and none near them (#11 closed).


## Phase 2 — your neighbourhood, for real (approved by owner in chat, 22 Nov)

| # | Item | Needs checks | Status |
|---|---|---|---|
| 2.1 | W1 Landing page + Training night tutorial | review, playtest, feel, player-test | done (PR, checked) |
| 2.2 | W2 Recon (extended OSM features incl. schools, sports, tennis, forests, bus routes), mission matching (3 suggested missions), tactical map + minimap | review, map-check, playtest | done (PR, checked) |
| 2.3 | W3 Animated zombies (procedural shader animation) + layered explosions, smoke, fires | review, playtest, feel | done (PR, checked) |
| 2.4 | W4 Map detail: trees, parked cars, roof shapes, pools, field markings, lit windows | review, playtest | in-progress (phase 3 teams, branch feat/phase-3) |
| 2.5 | W5 Music and voice (service choice pending) | feel, player-test | waiting-on-you |
| 2.6 | "Last bus home" bus-route escort | — | later |
| 2.8 | **Way in from the front page** (polish): "Try the sample town" opens recon; "Brief me" builds the typed address; plain-English errors; a staged loading readout; the front-page button no longer overlaps the recon title | review, playtest, player-test | in-progress (phase 3 teams, branch feat/phase-3) |
| 2.9 | **Small polish**: hide TIME and FRIENDLY FIRE in training; fade the map edge at the 105's view; vary "Other suggestions"; wording for bad coordinates | review, playtest | in-progress (phase 3 teams, branch feat/phase-3) |
| 2.10 | **Phone layout** (parked: the game is mouse-and-keyboard for now): HUD radio/sensor/minimap overlaps; coach card on short wide screens | playtest | parked |
| 2.11 | **Grades and personal bests** (new feature; critic: replay 4/10) | — | in-progress (phase 3 team T2, owner said go) |
| 2.12 | **Settings panel**: volume, mouse sensitivity, invert-Y, Reduce flicker toggle, key bindings (new feature) | — | in-progress (phase 3 team T2, owner said go) |
| 2.13 | **Your street in the sky**: a "your address" pin on recon and minimap; one mission per map built on your home (new feature; privacy check needed) | — | waiting-on-you |
| 2.7 | School evacuation missions (guardrails pending) | — | waiting-on-you |

### Earlier phase 2 notes
Address search → download → mission (basic version already in phase 1); real-map fixtures; procedural fill for empty areas. Scout ideas to consider: `docs/ideas/2026-11-21-scout.md`.
