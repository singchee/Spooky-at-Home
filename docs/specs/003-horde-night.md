# 003 — Horde Night: a crowd mode for the joy of the big gun

*Status: approved, awaiting /plan* · *Owner: Game Director* · *Date: 22 Nov 2026*

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

## Feel & access  *(added by feel-designer)*

## Owner decision (22 Nov 2026)
Approved, with **a maximum of 1,200 zombies on screen** ("max 1200 size"). The sizes become Big (600 at once, tablet default) and Huge (1,200 at once, desktop default); Insane (2,000) is dropped. Fixed-length runs, normal ammo, the performance budget and the menu placement below Three Nights are approved as recommended. The Story Writer proposes the name.
