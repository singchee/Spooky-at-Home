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

| 3.29 | Tech abilities (owner idea, later; pairs with 3.28 upgrades): radar, motion sensors, target indicators, targeted bombing run. Chief's note: anything that shows every zombie undercuts the sensor game and the cold-blooded mechanic (pillar 3), so make them limited and readable: a motion-sensor pulse on a cooldown that shows movers for a few seconds (a counter to cold-blooded that still needs the right camera), Ground marking targets with an IR designator visible in night vision, and a called-in bombing run on a long cooldown with a danger-close check, the school guardrail and flash-safety limits. **Owner, 22 Nov: a loadout of 2 slots chosen per mission**, picked on the briefing screen; the briefing's true intel (cold-blooded share, wave directions, convoy route) is what makes the choice interesting, and the walk-through can hint at it. Unlocked abilities widen the pool; the 2-slot limit stays. | pitch, plan, balance, feel | later |

| 3.30 | Motion override (owner): Settings "Motion: follow my device / full / reduced", and on the intro slideshow a note "Showing still frames because your device asks for reduced motion · Play animated". Device setting stays the default | review, playtest, feel | next (Sonnet) |
| 3.31 | Intro update (owner, later): besides the guns, cover the vision features (white hot, black hot, night vision, cold-blooded, zoom). Needs a script revision and new voice lines within the ElevenLabs cap | story, sound, playtest | later |
| 3.32 | Bug: cold-blooded stragglers can be impossible to find and the game seems endless (owner). Reproduce, fix causes, add endgame help (radio names the area, soft search circle, restless stragglers) | review, balance, playtest | in-progress |

| 3.33 | Friendly tracking boxes (owner idea, maybe an upgrade): corner-bracket boxes around friendlies, like body-cam / targeting-pod tracking, in every sensor. Chief's note: telling friend from foe is part of the skill (ID panel in thermal, IR strobe in night vision), so: always on in Training and difficulty 1; an "IFF tracker" unlock in the campaign / Horde Night (pairs with 3.28/3.29); and an accessibility toggle in Settings for anyone who needs it. Boxes must never flash, must follow the friendly smoothly, and must not cover the zombie next to them | pitch, feel, playtest | later |

| 3.34 | Menu and UI restyle, military feel (owner: "menus are very generic"): landing, scout, recon, briefing, settings, pause, result and campaign screens as one system: ops-terminal panels, stencil headings, mission-card "dossiers", stamped status tags, map grid textures, monospace data readouts, sensor-green/amber accents. Rules: our own style (no copying Zombie Gunship's or any real military's insignia, unit names or classification markings), readable (contrast, ≥14 px, ≥48 px touch targets), works in reduced motion, one style guide in docs/STYLE.md | visuals, feel, playtest | later (Art Director) |

| 3.35 | Shorter briefings (owner: "too wordy"): (1) one short **spoken** briefing per mission type (Clear, Escort, Defend, Convoy, Horde Night), recorded once by Commander Quill or Ground, generic so it's true on every map (no names or numbers in the audio); (2) the specifics shown **on the map** (labels, counts, arrows, route) via the walk-through, with at most one short line of text per stop; (3) the full written intel kept behind a "Details" toggle so nothing true is lost. Story Writer trims, Audio Director records (price first), Art Director lays out | story, sound, visuals, feel | later |

| 3.36 | Bosses (owner idea, later): big, fast, tough, maybe flying; each announced on the radio. Chief's notes: every boss must be readable in every sensor from its shape and heat alone (a Brute: double size, hotter core; a Sprinter: lean, leaves a heat trail; a Tank: multi-hit with **visible** damage stages, e.g. cooling patches as it's hit, so toughness is fair in thermal; a flying type, e.g. a swarm of infected birds or bats, only if it stays readable at gunship distance and never flickers). Radio: a short recorded warning per type ("Big one inbound…") plus a true on-screen caption with where it comes from (intel always true, rule 9). Spawned on a schedule, never inside school buffers; one boss at a time at first. Pairs with the loadout (3.29): intel about a boss shapes the 2 slots **Chief's candidate list (22 Nov), owner likes it, especially the Digger:** first build Cold Front (chills nearby zombies cold-blooded; night vision counter), Last Bus (rolls a real OSM bus route, unloads zombies at stops) and the Digger (owner's pick: underground, warm trail on the asphalt, surfaces near friendlies, never inside a school buffer); then Shepherd (leads formations; kill it to break the horde), Splitter (splits into sprinters under the 105), Ride-on Ron (mower, fast over lawns), Digger (underground, warm trail on the asphalt), Flying-fox colony (the flying type), Hot Rod (burning, floods white hot). Rejected: a Mimic that looks like a survivor (makes friendly fire unfair). | pitch, plan, balance, feel, sound | later |

| 3.37 | Landmark markers only show in the 105's wide view (the 25/40 lenses are too narrow to contain a landmark): add edge-of-screen indicators for nearby off-screen landmarks (small arrow + name), same declutter and child-place rules | playtest, feel | todo |
| 3.38 | Tool: `npm run -s classify` diffs against main, so phase-branch work inherits unrelated findings; `--base <branch>` fails inside git merge-base. Fix the base option so a branch can be classified against its own base | review | done |

| 3.39 | High-rise visibility (owner: New York "all high rise, can't see anything"). **See-through cut-away** (owner OK) so the street is always visible, **plus** honesty about the line of fire: the camera follows the gun's true line of fire; the gunship flies a tighter, steeper orbit over tall blocks; reticle shows MASKED when a building is in the way | review, playtest, feel | in-progress (Art Director) |
| 3.41 | Buildings block shots in the sim: rounds travel from the gunship's real position and hit the first building on the line (roof or wall); MASKED reticle state from the sim; balance runs; school guardrail check that rooftop impacts keep the child-place clearance; after Horde Night merges (same file) | plan, review, balance, playtest | todo (after 003) |
| 3.40 | Swap the New York preset centre to the Central Park edge (open ground for hordes, city around it); after the 4-city download batch finishes (fair use) | map-check, playtest | todo |

| 3.42 | World campaign through the famous places (owner idea): a fixed tour (e.g. Sydney → London → Paris → Rome → Tokyo → New York), each city a short chain of missions built around its landmark area. Chief's note: because preset maps are fixed, these missions can be **hand-tuned** (positions, waves, bosses, radio lines) like Zombie Gunship's levels, unlike the generated Three Nights; reuse spec 001's campaign engine (planning, saved progress, previously-on, tally) and cutscene-free radio briefings (3.35); bosses (3.36) as city finales; loadout unlocks (3.29) as rewards. Same rules: tone exclusions, school guardrail, intel always true | pitch, plan, balance, story, sound | next after Three Nights screens |

| 3.43 | Finish the Sydney, London, Rome and Tokyo presets: two cloud rounds failed (kumi 502/504 after 2–5 min; overpass-api.de resets connections from the cloud). Retry in a quiet window (night UTC), or from the owner's connection via a "Save this map file" export on the recon screen (new, small: exports the downloaded map as a file the build step accepts). Note: scripts/build-presets.mjs rewrites maps/preset-exclusions.json from only the places it finds, so merge, don't overwrite, the New York and Paris entries | map-check, playtest | todo |
| 3.44 | Finer walk grid (or sub-cell wall tests) so zombies can't wedge in footprints thinner than 3 m (about 4 still stuck on Adelaide CBD after 3.32) | review, balance | todo |
| 3.45 | Horde Night difficulty after the owner plays it. Balance run (12 seeds × 6 maps): the bot won 100% with doors at 40–60% on most maps; Huge on the sample town was tight (lowest 3%). Within spec bands but probably easy for the bot. Options if the owner finds it too easy: raise Big toward 3,000 total; Huge is already at the 1,200-figure cap, so raise its total, not its living cap. Do not shorten the 105 reload or soften the doors to move numbers | owner playtest, balance | waiting on owner playtest |

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
