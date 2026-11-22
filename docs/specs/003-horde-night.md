# 003 — Horde Night: a crowd mode for the joy of the big gun

*Status: ready* · *Owner: Game Director* · *Date: 22 Nov 2026*

**Mode: REDUCE.** The owner asked for "a mode where there are just insane numbers of zombies just for the satisfaction of shooting them down." I'm building the smallest version that tests whether **density** is the satisfaction. That means one five-minute run where your street floods with zombies towards a real landmark and you hold them off until dawn, with a kill counter, a multiplier and a "best shot". There are no new guns, enemies, upgrades or explosions, and the mode is not endless. **Class C:** it's a new mode, it adds a performance budget to QUALITY §2, and it's a taste call. It needs the owner's yes before `/build`. *(Working title: the Story Writer names it; see open question 5.)*

## Goal
Give the player a run where the screen fills with heat signatures coming down streets they know, and every 105 round takes out dozens at once. It's the Zombie Gunship power fantasy the owner keeps pointing at, kept fair, kept on their own map, and kept smooth on the owner's Android tablet.

## Player story
"As the gunner, when I've had a long day, I want to watch my own high street fill with zombies shambling towards the sports centre and drop a 105 into the thick of them, see '×47' over the crater and the pile cool from white to grey, so that I finish five minutes later with a number I want to beat, not a mission I had to think hard about."

## The idea at its strongest
Today a Hold at d5 peaks at about 240 zombies alive, in waves of up to 37. Every gun's kill depends on how many zombies are inside its blast. So the most direct way to make shooting feel good is to **pack the blast**: dense streams that fill the street from kerb to kerb, so a 105 kills 30 to 80 and a 40 mm burst cuts a lane through them. That's the satisfaction lever. It costs no new weapon, effect or enemy, only more bodies in the right places.

Two things make it better than "Hold with the numbers turned up":
- **Density scales the player's kill rate too.** A 105 kills an area, so twice as many zombies per metre of street means twice as many kills per round. Bigger crowds feel bigger without being proportionally harder. That's why crowd size can be a device setting without wrecking balance.
- **Your street, packed.** Streams come down real roads from named directions towards a real landmark. "They're coming down Banksia Street and across the oval" is a briefing you can only get from your own map (pillar 1).

## Why REDUCE, not EXPAND, HOLD or CUT
- **Not HOLD (taking "insane" literally).** Ten thousand zombies on screen at once would need a new render path, and it would fail the owner's own device first. My bet (the assumption below) is that a few hundred to a couple of thousand on screen, fed by dense streams and adding up to thousands over a run, *reads* as insane. The playtest tells us if I'm wrong, and the crowd-size setting tells us how much the device ceiling matters.
- **Not EXPAND.** The bigger versions all rest on different assumptions and carry real risk. An **endless** mode always ends in a loss, so the last memory of a "satisfaction" mode would be failure. **Upgrades** carry the same fairness cost as spec 001's deferred question. **Exploding zombies, car chain reactions or new enemy types** multiply flashes with crowd size (a photosensitivity risk, see below) and need balance of their own. Each of these is a later pitch if this one works.
- **Not CUT.** The owner asked for it directly. It answers the Critic's Replay score with a score to beat. And it's mostly reuse: Hold's flow field, spawn guardrails and doors, plus spec 001's wave schedule.

## The mode (outcomes, not code; the Tech Lead designs it and the Balance Analyst picks the numbers)

### 1. Shape of a run
- **Hold till dawn, five minutes, fixed.** The doors of a real landmark hold the people sheltering inside. **Lose** if the doors fall. **Win** at dawn. Either way you get a score. It's not endless. Every run can be won (pillar 4), and a good run ends on the crescendo, not on a loss.
- **The crowd builds on a schedule, not in response to how you're doing.** The schedule runs on time only, so the same map, seed and crowd size always give the same run (hard rule 1), and the briefing can say truthfully what's coming. Rough arc:

| Part | Roughly | What happens |
|---|---|---|
| Warm-up | 0:00–0:45 | Two streams, thin. Learn the approaches. |
| Build | 0:45–3:30 | Streams thicken and a third and fourth direction open. Density climbs. |
| Lull | ~10 s | Nothing new arrives: the breath before the storm (as in spec 001's finale). |
| Dawn surge | last ~75 s | The densest streams of the run, from every named direction, timed so they **reach the doors before dawn** if nobody stops them. |

- **Streams, not blobs.** Zombies arrive as continuous streams along roads, spreading across the street's width rather than walking single file. Fewer directions, more bodies per metre: that's what packs the blast.
- **All warm, no stragglers.** The briefing says it, and it's true: nobody is out on the streets but them, so it's **weapons free**. There are no friendlies to hit and no cold-blooded zombies in this first version (see "Pillars", item 3).
- **One difficulty.** No 1–5 dial. Crowd size (§4) is the only setting. This mode is for fun, so it should be winnable by most players on their first or second try.

### 2. What makes it feel good (the satisfaction kit)
Every item uses what exists or adds something small. Nothing here adds flashes.
1. **Kill counter.** A large running total on the HUD.
2. **Shot tally.** A small number ("×47") appears over the impact point of any round that kills 5 or more. It fades in and out (no pop or pulse), at most a few on screen at once. It's text on the HUD layer (`textContent`). The Feel & Access Designer owns the exact look.
3. **Multiplier tied to the doors (pillar 2 in the score).** Score = kills × the current multiplier (×1 to ×5). The multiplier climbs while the doors are untouched and drops when zombies reach them. Protecting the people is how you score, not just how you avoid losing. The Balance Analyst sets the steps.
4. **Best shot.** The run remembers its biggest single kill ("Best shot: 61, one 105, Banksia Street"). This is the stat people will screenshot. The street name is untrusted map text: `textContent` only.
5. **Piles that cool.** Bodies stay where they fall and cool from white to grey on thermal, so the streets you've worked show it. This uses the existing cooling, with a cap per crowd size (§4).
6. **Sound weight.** Impacts that kill more get a heavier layered sound, using existing assets mixed by kill count. The Audio Director owns it. No new recordings and no spending.
7. **Radio.** Ground's existing kill lines, plus a few new **text-only** lines for this mode from the Story Writer (start, lull, surge, dawn). No recordings in this version.
8. **End card.** It leads with the people ("The doors held. Everyone inside saw the dawn." / "The doors gave at 3:52."), then score, kills, best shot, best multiplier and the personal best. A personal best is kept **per map and crowd size**, since scores across sizes don't compare.

### 3. Guns and ammo: unchanged
**Same guns, same magazines, same reloads as normal play** (25 mm: 60 rounds and 3 s, the owner's decision of 22 Nov). Reasons:
- **The rhythm is the skill.** Swapping 25 → 40 → 105 while one reloads is the gunship dance, and in a crowd every round counts more, not less.
- **It keeps the photosensitivity risk flat.** Flashes come from rounds landing, and the guns' fire rate, not the crowd size, sets how many rounds land per second. Keeping the reloads means this mode can't flash more than a normal Hold. The Feel review of spec 001 (M4) flagged unlimited 25 mm as the thing that removes the pause on sustained flashes.
- **Density already gives "more".** A 105 into a packed street does what extra ammo would, without changing the guns the owner tuned.

If the owner wants more generosity, the lever I'd offer is **not** more rounds. It's a slightly shorter 105 reload during the dawn surge only, as open question 2.

### 4. Crowd size and the performance plan
**Crowd size is a setting the player chooses, not something the device changes silently.** The game picks a sensible default for the device, and the player can change it. It's part of the run's identity (map + seed + crowd size → identical run), it's fixed for the whole run, and personal bests are kept separately for each size. That keeps hard rule 1 and pillar 4 intact: a tablet and a desktop on the same setting play the identical run.

| Crowd size | Most alive at once | Total over the run (≈) | Default for | Bodies left on the ground (cap) |
|---|---|---|---|---|
| **Big** | 600 | 3,000 | tablets and phones | 400 |
| **Huge** | 1,200 | 6,000 | desktop | 1,000 |
| **Insane** | 2,000 | 10,000 | nobody (opt-in, with "for strong computers") | 1,500 |

*(For scale: the busiest Hold today peaks at about 240 alive and about 300 over a run. These are starting numbers; the Tech Lead may move them to meet the frame-rate targets, and must tell me if Big has to drop below about 400.)*

**Outcomes the Tech Lead must hit (they design how):**
- **Simulation cost follows the living, not the dead.** Dead zombies leave the per-step work, so the 10,000th kill costs the sim nothing. Crowd zombies only follow the doors' flow field, which already costs O(1) each, and do no per-survivor scan (there are no survivors in the field). Spawns trickle in over several steps, never 200 in one frame. A spatial grid is used only if profiling shows shell impacts or anything else scanning every zombie matters.
- **New sim budget (QUALITY §2, class C):** one headless step with **2,000 living crowd zombies takes under 4 ms**, alongside the existing 1,000-zombie budget. Normal missions are unchanged.
- **Render: living zombies first, always.** Today the renderer draws the last 2,500 entries of the zombie list, dead or alive, so in this mode corpses would push live zombies off screen. **A living zombie is never left undrawn to make room for a body.** Bodies fill whatever is left, up to the crowd size's cap, and the oldest fade out first.
- **Render level of detail.** The full character model (about 1,000 triangles) is used only where a zombie is big enough on screen to show it, for example in the zoomed 25 mm view. Everywhere else a cheap figure is drawn (the procedural figure or an impostor). Each crowd size has a maximum number of full models (starting at about 150 on Big and 400 on Huge). Draw calls stay **under 150**.
- **Level of detail never changes what you can see (pillar 3).** A distant cheap figure has the same heat, the same visible brightness and the same size on screen as the model it stands in for. A zombie can't get easier or harder to spot because of which way it was drawn.
- **No silent downgrade mid-run.** If a run struggled (frame rate low for a sustained stretch), the end card suggests the next size down, in words. It never changes the crowd while you play.

**Frame-rate targets (the owner's own devices are the gate; the cloud browser has no GPU, see QUALITY §2):**

| Device | Crowd size | During the dawn surge, 105 view and zoomed 25 mm |
|---|---|---|
| Owner's Android tablet (mid-range) | **Big** | median **≥ 30 fps**, and no 1 s stretch below **24 fps** |
| Owner's desktop or laptop | **Huge** | median **≥ 55 fps**, and no 1 s stretch below **40 fps** |
| Any | Insane | best effort, no target |

A dev-only frame-time readout (or `window.__spooky` stats) shows median and worst 1 s, so the owner can read it off the screen. The cloud playtest tracks regressions only: draw calls, triangles drawn, and the sim step budget.

### 5. Where it's played
- **Anchored on a real landmark with open ground**, using the Hold anchors in this order: sports centre or stadium (`hold-sports`: ovals and car parks make the best open ground for big streams), then police, fire station or hospital (`hold-landmark`), then the classic safehouse fallback. The run is built from the scouted place, as the suggested missions are.
- **Streams come from 3–4 named directions** on real roads, 250–450 m out. The briefing names them ("down Banksia Street, across Ironbark Oval"), and **every stream really comes from a named direction** (intel is always true, hard rule 9).
- **School guardrail, made stronger for crowds.** Today a wave is checked where it **spawns**, then walks on. In this mode the player fires along the whole approach, so the rule is: **no zombie, at any moment of the run, is ever within reach of a 105 round landing within 30 m of a school, kindergarten, childcare centre or playground** (the floor is about 54 m: `MAX_KILL_REACH` + `CHILD_FIRE_CLEARANCE`). The crowds' paths route around child places, and a stream is only placed where its whole walk to the doors stays clear. **If an anchor can't be fed by enough clear approaches, the mode isn't offered on that anchor**; it moves to the next one, and failing all, it says why (the generator's own words). The gap is never shrunk to make a map fit.

### 6. How it's reached
- **On the recon screen,** after scouting a place: a separate entry below "Fly Three Nights" and the suggested missions, with one line of description ("Five minutes. Thousands of them. Just shooting."), plus a crowd-size choice with the device's default selected. It's always available, with no unlock.
- **On the sample town** through the same route the sample missions use, so it can be played without scouting.
- **A URL hook for tests** (for example `?mode=crowd&size=big&autostart=1&bot=1`), like the existing ones.
- **Not** in Three Nights, Training or the landing backdrop.

## Pillars served
1. **It's your place:** strong. Crowds fill real streets, the briefing names real approaches, and the doors you defend belong to a real landmark.
2. **Protect people:** kept, deliberately. A pure kill-count mode would clash with "people matter more than the kill count", so the run is about the people inside. The doors decide win or lose, the multiplier punishes letting them reach the doors, and the end card leads with the people. **Mild tension remains:** this is the one mode where kills are the headline number. I think that's acceptable for a mode the owner asked for by name, and it's why it sits **below** Three Nights in the menu, not above it.
3. **Read the picture:** reduced, not broken. With all-warm crowds the skill is **which stream is closest to the doors** and **live crowd vs cooling pile**, not finding faint targets. Two conditions apply. (a) Bodies must cool to below live-zombie white, the existing rule, so a live zombie in a pile always reads as live. (b) Level of detail must never change what you can see (§4). No cold-blooded zombies in this version, and the briefing says so truthfully. A cold stream is a later option.
4. **Fair and repeatable:** passes. There's a fixed schedule; crowd size is a setting that's part of the run's identity and fixed for the run; there's no adaptive difficulty and no mid-run downgrade; every run can be won; the briefing's directions are true.
5. **Darkly comic, never cruel: the main risk, with conditions.** A mode built around mass kills in your real suburb is where tone can slip. Conditions:
   - **Zombies only**, and the jokes are about zombies, the doors and dawn. **No line or name frames the crowd as a real group of people** (commuters, shoppers, pub-goers, "former neighbours"). The existing kill line "That's a lot of former neighbours" should not play in this mode; the Story Writer gives it mode-specific swaps.
   - **No gore, and no "massacre", "extermination" or similar words** in any UI or score label. "Kills", "best shot" and "piles" are fine.
   - **The thermal look does the work.** Piles are heat shapes cooling to grey, not bodies in detail.
   - The Critic and a human tester are asked directly whether it felt mean (see "How we'll know").

**Photosensitivity (QUALITY §2, a blocker if missed).** The risk is many explosions at once. Because the guns are unchanged (§3), rounds landing per second can't rise with crowd size. The new risks are per-**kill** effects, which do scale with the crowd: death effects, shot tallies and the multiplier. **None of them may change brightness sharply.** Shot tallies and multiplier changes fade (0.3 s or longer), never pulse, and appear at once with Reduce flicker on. No new full-screen effect of any kind.

**No blocking clash**, given the tone conditions under pillar 5 and the photosensitivity rule.

## The one assumption
**The satisfaction comes from density, many kills per shot in streets you know, not from raw on-screen numbers. A few hundred on screen at once, fed by dense streams and adding up to thousands, already feels "insane".** If that's true, the tablet's Big setting delivers the fantasy and we never need a render rewrite. If it's false, the device ceiling is the real limit, or density isn't the fun at all.

**What would prove it wrong:**
- **The ceiling is the limit:** the owner plays Big on the tablet and Huge on the desktop, and says only Huge (or Insane) felt like what they asked for. Then the next step is the render work to push Big higher, not more features.
- **Density isn't the fun:** testers stop before about 3 minutes, don't start a second run, or describe it as "Hold, but more". Then the satisfaction needs something else (chains, upgrades, a different shape), and that's a new pitch.

## In scope / out of scope
**In:**
- The mode as in §1–§6: a five-minute hold till dawn on a real landmark, streams on a time-only schedule, one difficulty, all warm, weapons free.
- The satisfaction kit (§2): kill counter, shot tallies, a door-linked multiplier, best shot, cooling piles, sound weight by kill count from existing assets, text-only radio lines, an end card leading with people, a personal best per map and crowd size.
- Crowd size (Big, Huge, Insane) with a device default, fixed per run.
- The performance work in §4: dead zombies out of the per-step work, living zombies always drawn, level of detail with equal heat and brightness, body caps, the new sim budget, and a dev-only frame-time readout.
- The stronger in-play school guardrail (§5) for this mode.
- The recon-screen entry, the sample town and the URL hook (§6).

**Out:**
- Endless play, upgrades, unlocks, currency, online leaderboards or sharing.
- New guns, changed ammo or reloads, exploding zombies, car or fuel chain reactions, new enemy types, cold-blooded streams.
- New voice recordings or any other spending.
- Any change to Clear (including spec 002's scatter), Escort, single-mission Hold, Three Nights (spec 001) or Training. **Their fingerprints and trace hashes stay identical.**
- Raising the 1,000-zombie budget or the render caps for normal missions.
- Firing on the safehouse itself costing anything (same as Hold today; a possible follow-up).

## Depends on other work
| Dependency | Effect |
|---|---|
| **Spec 001's wave schedule** (`WavePlan.schedule`, finale step 2) | The natural way to express this mode's time-only schedule and the "surge reaches the doors" rule. Build on it if it has landed; the Tech Lead decides otherwise. |
| **3.10 character models** (in progress) | Level of detail needs the models and the procedural fallback both working. |
| **3.11 controls** (touch fire, 25 mm reverted to 60 + reload) | Tune on top of 3.11. The tablet test needs touch controls. |
| **3.15 buildings block movement** | Streams follow real streets because of it. Tune after it lands. |
| **3.6b audio memory on tablets** | Tablet frame rate and memory are judged together. If 3.6b isn't done, note it in the tablet test. |

## How we'll know it worked
**Tests (`npm test`):**
- **Determinism:** same map, seed and crowd size give an identical run (trace hash after the full schedule, no input). Changing only the crowd size changes the run.
- **Other modes untouched:** the escort, defend and campaign fingerprints and trace hashes are unchanged.
- **Guardrail, every step:** on the school-heavy town, for every crowd size and several seeds, with the bot firing every gun, **no living zombie is ever** within the floor of a child place, checked at **every step**, not only at spawn. An anchor that can't meet it isn't offered, and the reason says so.
- **Intel:** every stream spawns from a direction the briefing names. "All warm" and "nobody out there but them" are pinned (no cold zombies, no survivors in the field).
- **The surge arrives:** unopposed, the dawn surge reaches the doors before dawn, at every crowd size.
- **Budget:** a headless step with 2,000 living crowd zombies takes under 4 ms; per-step cost doesn't grow with the number of dead.
- **Render rules (headless where possible):** with more bodies than the cap, every living zombie is still in the draw list; bodies past the cap are oldest-first gone.

**Balance (`/balance`, bot, sample town, 12 seeds or more, per crowd size):**
| Measure | Target |
|---|---|
| Bot win rate | **≥ 80%** at every crowd size (this is a fun mode) |
| Doing nothing | loses at every crowd size (G6) |
| Median kills per 105 round during the build and surge | **30–80** (the satisfaction number) |
| Total kills, winning runs | roughly the table in §4 (crowds really do add up to thousands) |
| Win rate, Big vs Huge vs Insane | within 15 points of each other (density scales the kill rate, so size shouldn't decide who wins) |

**Playtest (`/playtest`):**
- **Flash meter:** 10 s of the dawn surge with all three guns into the densest stream, in white-hot, black-hot and night vision, at desktop size and the tablet viewport (1280×800). Within 3 flashes a second and under 25% of the screen. Also a 10 s scenario of over 50 kills a second, to prove per-kill effects don't flash.
- **Screenshots** at the surge in all three views, at normal zoom and ×2, with fresh piles: a live zombie standing in a cooling pile must be told apart from the pile (pillar 3 condition).
- **Level-of-detail check:** the same zombie drawn as a model and as a cheap figure has the same brightness on all three views, within a small tolerance.
- Draw calls under 150 at the surge, at every crowd size. Triangle counts are recorded for regression. No console errors.

**On the owner's devices (the gate for frame rate):** the frame-rate table in §4, read from the dev readout during the dawn surge.

**Human playtest (the assumption test), the owner plus 3–5 people, no prompting:**
- The owner plays **Big on the tablet** and **Huge on the desktop**, and is asked: **"Is this what you asked for?"** and **"Did the tablet one feel insane?"**
- At least 3 of 5 testers **start a second run** without being asked.
- Median human run lasts **4 minutes or more** (they reach the surge), and most first or second runs reach dawn.
- Asked **"What was the best moment?"**, most describe a big shot into a packed street, not something unrelated to the crowd.
- Asked **"Did anything feel mean or uncomfortable?"**, nobody says yes about the tone. If anyone does, it goes to the Critic and the Story Writer before release.
- **Critic re-review:** Replay up by at least one point.

## Open questions for the user
1. **Approve the mode (class C):** a five-minute hold till dawn at a real landmark, crowds on a fixed schedule, one difficulty, scored by kills and a door-linked multiplier, **not endless**. I recommend yes. If you specifically want endless, say so; I'd make it a follow-up once we see whether people replay this.
2. **Ammo: keep normal-play guns and reloads** (25 mm 60 + 3 s) in this mode? I recommend yes, for the rhythm and the photosensitivity reason in §3. The alternative I'd accept is a shorter 105 reload during the dawn surge only, not more 25 mm.
3. **Crowd sizes and defaults:** Big (600 at once, about 3,000 a run) by default on tablets, Huge (1,200 at once, about 6,000) on desktop, Insane (2,000 at once, about 10,000) opt-in only. Do these numbers match what you pictured by "insane"? If you pictured far more on the tablet, tell me now; it changes the render work, not the design.
4. **A new performance budget in QUALITY §2** (2,000 living crowd zombies under 4 ms) and frame-rate targets on your tablet (≥ 30 fps) and desktop (≥ 55 fps)? I recommend yes. You're the only one who can measure the real frame rate.
5. **Name:** "Horde Night" is a working title. The Story Writer proposes the real one, with one rule: it's about the zombies or the night, never a real group of people. Any favourites?
6. **Where it sits:** a separate entry on the recon screen, below "Fly Three Nights" and the suggested missions, and always available? I recommend yes. The story stays the front door, and this is the side door you take when you just want to shoot.

---
## Technical design  *(added by tech-lead)*

*Reviewed against feat/phase-3 at ede92b6, with the owner's cap applied (Big 600, Huge 1,200, no Insane). "Measured" means probed headless on this tree, on a 4-core cloud machine under load ~4.*

### 0. What the code says today (it shapes the design)
- **The sim is already cheap enough.** Measured: one defend step with 1,200 living zombies takes 0.73 ms; with 2,000 living, 0.56 ms; with 1,200 living + 6,000 dead entries, 0.40 ms; with 2,000 + 10,000 dead, 0.49 ms (plus a 25 mm round every 5 steps). There are no survivors, so the per-zombie survivor scan costs nothing, and dead entries cost one `alive` check each. The 4 ms budget is not the risk.
- **The real sim gap is the crowd's shape, not speed.** `grid.downhill` steers every zombie to the centre of the best neighbouring cell, so a stream folds into **single file** within a few cells. "Kerb to kerb" (the whole satisfaction lever) needs a separation pass, and that pass is what the spatial grid is for.
- **Doors:** today each zombie at the wall drains `integrity` by 0.02/s, so 1,200 at the doors would break in within a second. Crowd door damage needs its own capped rule.
- **Spec 001's `WavePlan.schedule` has not landed** (no `schedule` in `src/sim`). The crowd schedule is its own data (§2).
- **Renderer:** `AgentsView` draws `zombies.slice(-2500)` dead or alive, and `useModels` throws the procedural batch away. LOD needs both batches alive at once.
- **3.9 (feat/3.9-sensor-look)** narrows the gun FOVs (105: 6°, 40: 2.2°, 25: 1.6°), adds `src/render/gfxGovernor.ts` and rewrites much of `game.ts`. 003 builds after it merges, with LOD thresholds in **screen pixels**, never per gun.

### 1. Where it lives
| File | Change |
|---|---|
| `src/sim/crowd.ts` (new) | `CROWD_SIZES` (`big`: maxAlive 600, bodies 400, models 150; `huge`: 1,200 / 1,000 / 400), `CROWD_SCHEDULE` (data, §2), `CrowdPlan` type, `generateCrowd(map, g, grid, { seed, size, anchor? }) → MissionResult`. Uses `findAnchor` (`hold-sports`, then `hold-landmark`) and `safehouseFromFeature` / `findSafehouse`, exported from `missions.ts` unchanged. |
| `src/sim/missions.ts` | `Mission.crowd?: CrowdPlan`. **The type stays `'defend'`, and `MISSION_TYPES` is untouched.** Adding a fourth type would change every `type: 'auto'` pick (`pick(rng, MISSION_TYPES)`) for everyone. `likelyWaveDirections` returns the plan's streams when `m.crowd` is set (true intel), so the tactical map, tour and diorama get their arrows with no change of their own. |
| `src/map/grid.ts` | `flowField(sources, avoid?: Uint8Array)`: an optional mask treated as blocked. Existing callers are unchanged. |
| `src/map/recon.ts` | `childMask(map, grid, buffer): Uint8Array` marks the cells whose nearest point is within `buffer` of a child zone. |
| `src/sim/sim.ts` | (a) `living`: a derived index, below. (b) Crowd mode when `mission.crowd` is set: a spawner instead of `updateWaves`, the no-go mask in movement, a separation pass, capped door damage, and `crowdStats` (kills, multiplier, best shot `{kills, weapon, place}`) in `state()`. |
| `src/sim/setup.ts` | `createCrowdSim(map, { seed, size })`. |
| `src/game/agentsView.ts` | The draw list and LOD (§5). Constructor `{ lod?: { models, bodies } }`. |
| `src/ui/crowdHud.ts`, `src/ui/crowdEnd.ts`, `src/ui/crowdBests.ts` (new) | Counter, tallies (a reused element pool), end card, and bests keyed by map + size. `textContent` only. |
| `src/game/game.ts` | **One gated block**: `if (sim.mission.crowd)` → crowd HUD, end card, `KILL_LINES` swap, no grade or single-mission best, `AgentsView` LOD options, frame stats in `info()`. |
| `src/ui/recon.ts`, `src/ui/menu.ts`, `src/main.ts` | One entry plus a size choice (default: `matchMedia('(pointer: coarse)')` → Big, else Huge). `MenuChoice.crowd?: 'big' \| 'huge'`. `play()` calls `createCrowdSim` when it's set. URL hook `?mode=crowd&size=big\|huge&seed=N&autostart=1&bot=1`. |

Layering: the sim, map and crowd generator stay three.js- and DOM-free. LOD lives only in `src/game`.

### 2. Data flow
```
recon/URL → generateCrowd(map, seed, size)
   anchor (hold-sports → hold-landmark → classic safehouse)
   noGo   = childMask(map, grid, MAX_KILL_REACH + CHILD_FIRE_CLEARANCE + cell·√2/2)   (≈ 56 m)
   doors  = perimeterCells(safehouse) minus noGo        → none left: next anchor
   field  = flowField(doors, noGo)                      (paths never enter noGo)
   streams: 3–4 road nodes 250–450 m out, field > 0, not in noGo, sectors ≥ 2 apart,
            each { at, compass, street = placeLabel }, walk time = field·cell·1.1 / slowest speed
   surge feasibility: surgeStart + max walk time ≤ DAWN − 10 s, else drop that stream / next anchor
   → Mission{ type 'defend', timeLimit 300, safehouse, crowd: { size, streams, schedule, doors } }
Sim (crowd):
   spawner: per stream, rate(t) from the schedule × size → accumulator → ≤ 8 spawns/step,
            jitter ±6 m across the road (reject blocked/noGo); over maxAlive → dropped, not queued
   per living zombie: downhill(field) + separation (3 m bucket grid) → tryMove (blocked | noGo rejected)
   at doors (field == 0): integrity −= min(atDoors, doors.cap) · doors.rate · dt; multiplier steps down
   impact event (exists) → kills per round → tally / best shot / multiplier (sim-side, deterministic)
Game: AgentsView(draw list + LOD) · crowd HUD · end card · bests(map, size)
```
**The schedule as data** (Balance Analyst owns the numbers): `CROWD_SCHEDULE: { from: s; to: s; streams: number; rate: number /* × size.peakRate, per open stream */ }[]`. Rows: warm-up 0–45 (2 streams, thin), build 45–210 (rising to 4), lull (~10 s, rate 0), surge (last ~75 s, all streams, peak). It's a pure function of `t`, so the briefing can quote it. **Spawns over `maxAlive` are dropped, not deferred.** Deferring would make the crowd answer how fast the player kills (the spec says time only). `state().crowdDropped` exposes the count to balance.

**`living`:** an index array of live zombies in id order. At the start of each step, entries appended to `zombies` since the last step are added (this catches tests and Training pushing directly). At the end of any step with a death, dead entries are removed by stable compaction, never by swap-remove. Every per-zombie loop in `updateShells`, `updateZombies`, `updateWaves` and `state()` iterates `living`. Order is preserved, so the main rng is drawn in exactly today's order, and **the defend trace hash and escort fingerprint prove it.** `zombies` stays append-only (ids = indices) for the renderer and tests.

### 3. Determinism
- Map + seed + size → identical run, at the game's fixed 1/60 step. The crowd generator uses `mulberry32(hashString('crowd|' + map + '|' + seed + '|' + anchor + '|' + size))`, and the spawn jitter uses its own sim stream. There's no difficulty dial (`CROWD_DIFFICULTY = 3` is fixed for speeds).
- No wall-clock time and no frame rate anywhere in the sim. LOD, tallies and frame stats are render-only and never feed back. The 3.9 governor may change picture quality, never the crowd.
- The separation pass reads a bucket grid built at the start of the step (not updated as zombies move). The result is order-independent and deterministic.
- Fingerprints: `EXPECTED_FINGERPRINT`, `EXPECTED_DEFEND_FINGERPRINT`, `EXPECTED_DEFEND_TRACE` and (after 002) the escort and Clear traces and the campaign fingerprints all stay unchanged. JSON omits the absent `crowd` key.

### 4. Failure modes
| Input | Missing / malformed / huge |
|---|---|
| Map without a sports centre or landmark | Classic safehouse fallback. If none, the generator's own reason ("No hospital, police station…"), shown on recon where the entry would be. |
| Anchor with a child place within ~56 m of its doors, or fewer than 3 streams clear of `noGo` | Next anchor. If all fail: "There's no way in to {place} that keeps clear of schools and playgrounds, so there's no Horde Night here." (Story Writer's words, `textContent`.) The gap is never shrunk. |
| Surge can't reach the doors in time from any stream | That stream is dropped. Fewer than 3 left → next anchor. |
| Huge real map (6,000 buildings) | `childMask` is O(cells × child zones, box-culled), computed once per generation and cached per map, like `childSafeCost`. Grid n² ≤ ~440² = 194k cells. |
| Saved bests from a different map version | Keyed by `mapFingerprint` + size, never the typed name (the privacy rule, as in the campaign store). Unparseable store → empty. |

### 5. Render: draw list, LOD, caps
- **Draw list** (all modes): first every `living` zombie, then bodies newest-first up to `bodies` (crowd) or until `MAX_Z` (normal). Huge: 1,200 + 1,000 = 2,200 ≤ `MAX_Z` 2,500, so `MAX_Z` stays. Normal missions draw the same set as today (they never exceed 2,500 entries). Only instance order changes. `applyBlasts` iterates the draw list, not `slice(-2500)`.
- **Bodies past the cap** sink into the ground over 1 s (Feel S4). That's a `deadFor`-driven offset in both shaders, with no transparency and no brightness step. By the time a body hits the cap it has already cooled close to ground heat (20 s).
- **LOD** (crowd only, so normal missions keep their single batch and draw-call count): the `ModelBatch` and the procedural `FigureBatch` both stay alive. Per frame, project each drawn zombie. If its on-screen height is ≥ 28 px (enter) or ≥ 22 px (stay), it's a model candidate. Candidates nearest the aim point first, up to `models` (150 / 400). Everyone else is a figure. A zombie that changes batch picks its clip fresh (`clip = -1`). Thresholds are in pixels, so they survive 3.9's FOV changes. On the 3.9 `low` tier the model cap may halve: LOD is value-identical, so that changes nothing a player can see.
- **Same picture either way:** both batches get identical `core`, `limb` and `vis` from `bodyHeat`. On-screen height: model 1.75 × `MODEL_DISPLAY_SCALE` 1.5 = 2.63 m against figure `HEAD_TOP` 1.95 × `FIGURE_SCALE` 1.4 = 2.73 m. That's 4% today, and it must stay within 5%. The area-weighted mean heat of each geometry (from `aHeatW` against figure part weights) must match within 0.03.
- **Feel M3 (darkening flash):** render-only. `bodyHeat` eases from live to `bodyStart` over 0.3 s instead of in one frame. It applies in every mode, because it's visual only and the sim is untouched.

### 6. Performance against QUALITY §2
| Budget | Estimate | Gate |
|---|---|---|
| Sim step, crowd | today ~0.5–0.7 ms at 1,200–2,000 living. Separation adds ~60k neighbour checks per step at 1,200 (est. +0.3 ms); the spawner is negligible. **Est. ≤ 1.5 ms.** | New QUALITY §2 row: *"Simulation step, 2,000 living crowd zombies + 6,000 dead entries, headless: < 4 ms"*. It keeps the owner-approved 2,000 as headroom over the 1,200 cap. The existing 1,000-zombie row is unchanged. |
| Draw calls | today's count + 1 (the second zombie batch in crowd mode) | < 150 at the surge, both sizes (`info().drawCalls`). |
| Triangles | Huge ≤ 400 models × ~1k + 1,800 figures × < 120 ≈ 0.62 M; Big ≈ 0.25 M | recorded for regression only. |
| CPU per frame in `AgentsView` | ~2,200 instance writes plus 1,200 projections, est. 1–2 ms desktop and 3–5 ms tablet. This is the tablet's real risk, more than the GPU. | On-device table in §4 plus Feel S3 (no frame > 50 ms in the second after a 30+ kill). |
| JS size | about +6 KB gzipped | < 400 KB. |
| Flashes | rounds landing per second unchanged (same guns) | meter scenarios below. |

**Frame stats:** `Game` keeps a ring buffer of real frame times. `info().frames = { medianFps, worst1sFps, maxFrameMs }`. `?fps=1` shows them as a small dev overlay (Feel's 14 px minimum applies). The cloud playtest records draw calls, triangles and the sim budget only.

### 7. Test plan (write these first; 1–4 fail before the crowd code exists)
**Sim (`tests/crowd.test.ts`):**
1. *Determinism*: same map, seed and size → same trace hash after 300 s with no input. Big and Huge differ.
2. *Guardrail every step*: school-heavy town and sample town, both sizes, seeds 1–4, `Bot(SKILL.human)` firing, step 1/30. **Every living zombie, every step**, is ≥ `MAX_KILL_REACH + CHILD_FIRE_CLEARANCE` (54 m) from every child place, with no −2 m allowance (the mask is conservative by half a cell diagonal). Plus `schoolHeavyTown({ playgroundBesideSafehouse: true })` → that anchor isn't offered, and the reason names schools and playgrounds.
3. *Intel*: every spawned zombie's nearest stream origin is a named stream, within 6 m + one step. No cold zombies, no survivors, and the briefing says both.
4. *Surge arrives*: no input → zombies reach the doors before `DAWN − 5 s`, and the run is lost (G6), at both sizes.
5. *Budget*: 2,000 living crowd zombies (separation on) + 6,000 dead entries, 60 steps, < 4 ms per step. A second run with 0 dead entries must be within 20% of it (the dead cost nothing).
6. *Kerb to kerb*: in a 30 s window of a build-phase stream, the median distance of zombies from the stream's road centreline is > 2 m (it's single file today).
7. *Other modes untouched*: the existing escort and defend fingerprints, defend trace, and the 002 escort and Clear traces pass unchanged. The existing 1,000-zombie budget test still pushes into `sim.zombies` and still measures real work (via the `living` catch-up).
8. *Spawn trickle*: never more than 8 spawns in one step.

**Render (`tests/agentAnim.test.ts`, headless with a fake sim):**
9. 1,200 living + 3,000 dead: all 1,200 living are in the draw list, bodies ≤ cap, the oldest go first.
10. LOD parity: the same zombie written to both batches has identical `core`/`limb`/`vis`. Height ratio and mean-heat parity are within the tolerances in §5.
11. LOD cap: never more than `models` instances in the model batch, and a zombie at the threshold doesn't flip every frame (hysteresis).

**Playtest (`/playtest`)**, at `?mode=crowd&size=big|huge&seed=1&autostart=1&bot=1&fps=1`, at 1280×800 and desktop:
- **Flash A** (spec): 10 s of the surge, all three guns into the densest stream, in white-hot, black-hot and NV: ≤ 3 flashes/s and < 25% of the screen.
- **Flash B** (spec): a scripted > 50 kills/s for 10 s (`fireAt` the 40 and 105 into a stream held at the cap).
- **Flash C** (Feel M3): the 25 mm zoomed ×2 on a packed stream, a 105 into it. The meter counts darkening transitions as well.
- Screenshots: the surge in three views at ×1 and ×2, a live zombie inside a fresh pile, and an LOD pair (one zombie straddling the threshold) with mean brightness within 3%.
- `drawCalls < 150` at the surge, triangles recorded, no console errors.

**Balance (`/balance`)**: the crowd runner per size, 12 seeds. Win rate, doing nothing, kills per 105 round in build and surge, total kills, `crowdDropped`, and the Big against Huge gap (≤ 15 points).

### 8. Smallest first step
**Commit 1: "Living first" (no behaviour change).** Add `Sim.living` (stable compaction plus catch-up) used by every per-zombie loop. Change the `AgentsView` draw list to living first, then bodies newest-first. Tests: render test 9, budget test 5 in its normal-mission form (1,000 living + 6,000 dead, < 4 ms), and every existing fingerprint and trace unchanged. That proves two of the spec's four performance outcomes on today's code and removes the 2,500-entry bug the mode depends on.
**Commit 2** is the headless crowd (`crowd.ts`, the mask, field, spawner, separation and doors), with tests 1–8. That's where the design's real claims (guardrail every step, kerb-to-kerb, surge timing) are proven before any UI exists. LOD, HUD and the recon entry come after, once 3.9 has merged.

### Verdict: **APPROVED WITH CHANGES**
1. Separation (a 3 m bucket grid, crowd mode only) is **required**, not "only if profiling shows". The reason is the single-file shape of the flow field, not cost (measured: the sim is already 0.5–0.7 ms).
2. Crowd door damage is capped data in `CrowdPlan.doors`. Today's per-zombie drain would end a run in a second.
3. The schedule is the mode's own data (spec 001's schedule hasn't landed). Spawns over the cap are dropped, not queued, so it stays time-only.
4. The mode is `type: 'defend'` + `crowd`. `MISSION_TYPES` stays unchanged.
5. Guardrail by construction: a child no-go mask in both the flow field and every move, checked every step at 54 m with no allowance.
6. Update the tables to the owner's cap: remove Insane from §4, the balance table and the frame-rate table. QUALITY §2 gets the 2,000-living row above (headroom over 1,200).
7. LOD thresholds in screen pixels, both batches kept, and parity tests on heat and height. The death-heat ease (0.3 s) answers Feel M3 without touching the sim.
8. Build order: 002 first, then 3.9 merges, then 003 commits 3 and later (`game.ts`). Commits 1–2 don't touch `game.ts`.
9. Feel S6 (does 1,200 count living or drawn?) goes to the owner. The render design fits either: with a 1,200-drawn cap, the Huge body cap is lowered.

## Feel & access  *(added by feel-designer)*

## Owner decision (22 Nov 2026)
Approved, with **a maximum of 1,200 zombies on screen** ("max 1200 size"). The sizes become Big (600 at once, tablet default) and Huge (1,200 at once, desktop default); Insane (2,000) is dropped. Fixed-length runs, normal ammo, the performance budget and the menu placement below Three Nights are approved as recommended. The Story Writer proposes the name.

---
## Feel & access review  *(feel-designer, /plan, 22 Nov 2026)*
Reviewed against the owner's cap (Big 600 on the tablet, Huge 1,200 on desktop, no Insane), today's HUD (`src/ui/hud.ts`), heat values (`HEAT` in `src/game/agentAnim.ts`), blast effects (`src/game/effects.ts`) and gun rates (25 mm 12/s, 40 mm 2.5/s, 105 one round per 4.5 s).

**Must fix**
- **M1. Tallies and counters must be readable on top of a white-hot crowd.** Pale text over a kerb-to-kerb white-hot stream disappears, and so does dark text over a black-hot one. Every number in the satisfaction kit (kill counter, multiplier, `×N` tallies, best shot) gets a solid dark outline or backing plate that holds in white-hot, black-hot and night vision. Size: at least 14 px everywhere, and at least 18 px for tallies and the multiplier at the 1280×800 tablet viewport. The `/playtest` surge screenshots must show a tally sitting on the densest part of the crowd in all three views.
- **M2. Cap how often tallies appear.** In a packed street the 25 mm (radius 3 m, 12 rounds a second) can kill 5 or more per round. With the spec's "any round that kills 5 or more", that means up to 12 tallies a second: unreadable noise, and a flicker risk. Rules:
  - Only the **105 and 40** make tallies.
  - A **25 mm burst** adds up into one tally, shown when the player lets go of fire (or when the magazine runs dry), at the burst's last impact.
  - **No more than 3 tallies on screen.** A new one fades out the oldest (0.3 s or longer), never pops it.
  - With Reduce flicker on, tallies appear and disappear at once. That's already in the spec; keep it.
- **M3. The flash meter must count darkening too.** WCAG 2.3.1 counts a pair of opposite brightness changes, not only flashes of light. When a 105 or 40 round kills dozens in one frame, every live zombie in the blast drops from heat 0.98 to 0.5 instantly (`HEAT.bodyStart`). In the zoomed 25 mm view at ×2, a packed stream can fill a large part of the screen, so that's a sharp darkening over a big area right after the blast's flash. Add to the `/playtest` flash meter: **zoomed 25 mm at ×2 into the densest stream, in white-hot and black-hot**, measuring both directions. If it fails, ease the heat drop at death over 0.3 s or more in this mode. That's a rendering change only, so the sim and determinism are untouched.
- **M4. The multiplier drop needs a tell before it happens and a visible one when it does (pillar 3, and nothing by sound alone).** The doors marker turns to an alarm state when zombies get within a set distance of the doors, **before** the multiplier drops. When it drops, the multiplier number changes with a fade and a radio text line appears. The tell is never only a sound or only a colour: the text changes too.

**Should fix**
- **S1. Keep the kill counter calm.** At 50 kills a second, a big number changing every frame is a blur. Update it no more than about 4 times a second, or let it roll up smoothly. With Reduce flicker or reduced motion on, it doesn't roll; it steps at most 4 times a second.
- **S2. Show only words this mode needs.** The HUD shows **DAWN m:ss**, **DOORS %**, **KILLS**, the **×N** multiplier and the score. Remove `FRIENDLY FIRE 0/N` and `FRIENDLIES` (there's nobody to hit, and "0/N" reads like a bug in a weapons-free mode). Remove `CONTACTS`: a count of 1,100 alive tells the player nothing. Put the kill counter and multiplier at the top centre, clear of the stick, the fire area and the GUN / VIEW / ZOOM buttons. Check it with a 1280×800 screenshot.
- **S3. No stutter at the best moment.** On the tablet, a hitch right when a 105 kills 60 feels worse than a low average frame rate. Add to the tablet gate: **no frame over 50 ms in the second after a 105 impact that kills 30 or more**. For the Tech Lead: today `hud.update` rebuilds its DOM every frame (`replaceChildren`). Tallies should be a small pool of reused elements moved with `transform`, not new nodes for each kill.
- **S4. Bodies fade out, they don't vanish.** When the body cap removes the oldest bodies, each one fades over a second or more. Hundreds of bodies vanishing one by one at the cap shimmer across the streets you've worked. Also check in the `/playtest` night-vision screenshots that a live zombie in a fresh pile reads as live. Thermal is covered (0.98 against 0.5 or less); night vision isn't.
- **S5. Cap the layered impact sound (Audio Director).** Sound weight should grow with the kill count up to a ceiling, not play one voice per kill. It should never be the only cue: the tally (M1) is its visual twin.
- **S6. Confirm what the owner's 1,200 cap counts.** I read "max 1200 size" as **1,200 living zombies**. At Huge that's up to 1,200 living plus 1,000 bodies, about 2,200 figures drawn. If the owner meant 1,200 figures in total, the Huge body cap has to drop. One question to the owner, through the Chief, before `/build`. The Tech Lead should also take Insane out of the tables in §4, the balance table and the end-card wording.

**Tone: pass, with conditions.** The pillar 5 conditions are right: the "former neighbours" swap, no "massacre" or "extermination", and the end card leading with the people. Two additions:
- Label the counter **KILLS**, never "BODY COUNT".
- A tally is `×47` and nothing else. No "47 KILLS!" floats over the crater.

**Ideas**
- **I1. Vibration on the tablet:** a short pulse (`navigator.vibrate`, 40–60 ms) on a 105 impact. It's off when Reduce flicker or reduced motion is on, and it has its own setting. It needs no network.
- **I2. Stream arrows on the minimap**, one per named direction, so the player can see "which stream is closest to the doors" (the skill this mode keeps) at a glance.
- **I3. Burst tally as a toy:** M2's 25 mm burst total ("×23") makes the small gun's sweep through a crowd add up to something.

**Other checks: no findings**
- **Photosensitivity from blasts: pass.** The guns are unchanged, so rounds landing per second, the 105 kick and the night-vision washout stay at Hold levels. Per-kill effects are the new risk; M2 and M3 deal with it.
- **Reduce flicker and motion:** covered by the spec plus M2 and S1.
- **Thermal clutter:** bodies cool from 0.5 to 0.23, which is below road heat (0.33), so worked streets read as darker smudges under hot live crowds in both polarities. The LOD rule (same heat and size on screen) keeps distant live zombies the hottest thing in view. Fine as specified, given S4.

**Verdict: APPROVED WITH CHANGES.** Do M1 to M4 in the build. M3's extra meter case must pass before release (QUALITY §2 blocker). S6 is one question for the owner before `/build`.

## Owner decision (22 Nov 2026, clarifying "max 1,200")
**1,200 includes bodies**: at most 1,200 zombie figures drawn at once, living and dead together. The build sets each size's living cap and body cap inside that total (bodies fade out over at least 1 s when the cap removes them, per Feel S4). The sim budget (2,000 living + 6,000 dead under 4 ms) stays as headroom.

## Build note: flash scenario B's target
Scenario B keeps the spec's **over 50 kills a second sustained over 10 s** and adds **at least one 1-second window of 150+ kills** (the opening burst), so the gate is strictly harder than the spec's and needs no owner sign-off. B now holds fire until Huge is at its 800 cap, opens with the 105 on the densest cell and brings the 40 and 25 onto the same spot: the browser run reached 74.9 kills a second over 10 s and a best second of 291, and passed the flash limits (≤ 3 flashes a second, < 25% of the screen). An earlier build commit proposed lowering the sustained target to 35/s; that is withdrawn.
