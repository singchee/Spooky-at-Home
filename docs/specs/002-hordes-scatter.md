# 002 — Shelled hordes scatter, then regroup (Clear missions)

*Status: ready* · *Owner: Game Director* · *Date: 22 Nov 2026*

**Mode: HOLD, with tight edges.** Build the owner's idea as asked: in Clear missions, a 105 round that lands on a horde sends the survivors running, and later they drift back to where the horde gathered. I'm adding three rules that the idea needs to stay fair, and leaving out everything that would spread it beyond Clear. **Class C:** it's a new enemy behaviour and a balance change well over 15%, and it widens the school guardrail gap. It needs the owner's yes before `/build`.

## Goal
In Clear missions, the 105 becomes the **opener**, not the whole fight. A shelled horde breaks into runners that you track down with the 40 mm and 25 mm while they're spread out. If you let them go, they regroup where the horde gathered, smaller and wiser to it. Clear then lasts long enough to be a mission (minutes, not seconds), and all three guns and both cameras do real work.

## Player story
"As the gunner, when my 105 round lands in the middle of the horde on the tennis courts, I want to see the ones it missed bolt down the side streets and across the grass, so that I have to choose: chase them with the 40 and 25 while they're split up, or wait for them to drift back to the courts and shell them again while the clock runs."

## The idea at its strongest
Today a Clear mission is "find a horde, drop one 105 round, next". The balance run after 3.15/3.16 (human-skill bot, sample town, 12 seeds) shows it: Clear is won 100% at every difficulty, with median lengths of 21 / 45 / 67 / 80 / 92 s for d1 to d5. QUALITY §3 wants a d5 win rate of 25–60% and lengths of 2–5 min (d1) to 4–8 min (d5). The cause is geometry, not tuning. A 105 round kills everything within 16 m, and half of what's out to 24 m (`KILL_REACH`). A horde spreads only 22 m (`HORDE_SPREAD`). One round therefore kills roughly three-quarters of a horde of any size, and a second round finishes it.

Backlog 1.10 is right that a real player is slower than the bot, because the bot never has to search. But a slower search doesn't fix the shape: the fight is still "find, one round, next". Scattering changes the shape. The 105's first hit stays as satisfying as it is now. What it leaves behind is a second, different problem: fast, spread-out targets that need leading, the smaller guns, and sometimes night vision. That's the gunship fantasy the game sells: the big gun breaks them up, the small guns finish the job.

It also fits the pillars unusually well. The runners flee down **your** streets and gardens, because buildings block movement since 3.15, so where they go depends on the real map (pillar 1). **Where** you drop the 105 decides which way they run, so shelling a horde from the wrong side can send runners towards the sheltering friendlies (pillar 2). And cold-blooded runners that reach grass fade on thermal, which is exactly the camera switch PLAN §5a wants to reward (pillar 3).

## Why HOLD, not EXPAND, REDUCE or CUT
- **Not EXPAND.** The bigger version is "every horde and wave reacts to fire" across all three mission types. Escort and Hold are close to their bands (Hold d5 is already at about 25%) and are tuned on top of unlimited 25 mm. Scattering waves there would unpick that work for no evidence of need. Scatter stays in Clear. The in-world reason is that hordes are milling and idle, so they startle, while waves are hungry and on the move, so they don't. If it works, waves are a later pitch.
- **Not REDUCE.** Scattering without regrouping is smaller, but it fails pillar 3. Clear needs every zombie dead, so runners that never come back turn the end of every mission into a hunt for the last cold one in a dark park. **Regrouping is what keeps scatter fair**, so it's part of the smallest version, not an extra.
- **Not CUT.** The alternatives below are cheaper, but none of them changes what the player does.

### Alternatives considered
| Alternative | Why not |
|---|---|
| **More, smaller hordes from the start** | The 105 still one-shots each group. The loop stays "find, shell, next", just with more steps. And hordes need room (130 m apart, clear of child places), which real maps run out of. That's why `hordeCount` is already capped at 6. |
| **Limit 105 ammo, or slow its reload** | It's a dial, not a verb. It changes Escort and Hold too, where the 105 is tuned. And it tells the player "don't use the fun gun" rather than giving them something new to do. I keep it as the **fallback** if scatter can't reach the bands on its own, but as a Clear-only time limit rather than a 105 nerf (see "How we'll know"). |
| **Wider hordes (bigger `HORDE_SPREAD`)** | It costs the same guardrail room as scatter, buys no new decision, and a horde stops looking like a horde. |
| **Shrink the 105's blast** | It changes every mission, and the 105's punch is the feel the owner asked for (3.17). |
| **Zombies take cover in buildings** | Ruled out. Buildings block movement now (3.15). |

## The rules (outcomes, not code; the Tech Lead designs it and the Balance Analyst picks the numbers)
1. **Only the 105 scatters, only in Clear, and only horde zombies.** A horde zombie that survives a 105 impact within about twice the lethal radius **runs**. The 40 and 25 never cause a scatter. Wave zombies (Escort, Hold) never scatter. Escort and Hold play **identically** to today, pinned by their existing fingerprints and trace hashes.
2. **They run away from where the round landed.** The direction is "away from the impact", with a small seeded wobble so they don't all run in one line. It's never random towards anything. The player controls it by where they aim: shell the far side of a horde and runners come towards you, and possibly towards the friendlies. That's the decision this feature adds. They run faster than a shamble for a few seconds, then slow down.
3. **They stay on a leash.** No runner ever goes farther than a fixed **scatter leash** from its horde's gathering point (starting value: 45 m; the walk grid and buildings shape the actual path). The leash is what keeps the guardrail a proof, and the briefing true: a runner from "the horde at Banksia Reserve" is still around Banksia Reserve.
4. **They always regroup.** After a seeded delay (starting values: 15–25 s, longer at higher difficulty), each runner shambles back to its horde's **own** gathering point. That's the anchor the briefing, tactical map and diorama already show, so no map marker ever points at an empty spot. A regrouped horde can be shelled and scattered again. **No zombie is ever scattered for good.**
5. **The guardrail gap grows to cover the leash.** `HORDE_CHILD_GAP` is recomputed as the farthest a horde zombie can ever be from its gathering point (now the leash, not just the wander) + `MAX_KILL_REACH` + `CHILD_FIRE_CLEARANCE`: 45 + 24 + 30 = **99 m** at the starting leash, up from 80 m. The same applies to the shelter spot and the drifting horde's path (`shelterSpotFor`). Runners never pick a destination inside that buffer, so they never run towards a school, kindergarten, childcare centre or playground. **If the wider gap costs too many Clear missions on real maps, the leash shrinks, never the gap.**
6. **One seeded stream, kept separate.** Scatter directions and regroup delays come from the seeded sim, on a stream of their own, so the same map, seed, settings and shots give the same scatter (hard rule 1). A Clear mission where nobody fires plays identically to today.
7. **The player is told, truthfully.**
   - **Briefing (Clear only):** one true sentence that shelled hordes scatter and regroup where they gathered. It's a rule, so it's always true. The Story Writer writes it.
   - **First scatter of the mission:** a radio text line naming the regroup place, for example "They're scattering. They'll drift back to {horde label}." It's true by construction because of rule 4. Text only for now, no new recordings.
   - **Pull forward two lines already written and recorded** from radio-script section C: `few-left` and `cold-leftovers`. They're the safety net against the "where's the last one" hunt that scatter makes more likely. Their triggers are already defined on `zombiesAlive` and `coldAlive`.

## Pillars served
1. **It's your place:** strong. Runners flee down real streets and gardens around real places (the tennis club, the park), and they regroup at the named place.
2. **Protect people:** strong. Where you put the 105 decides whether runners head for the friendlies. The guardrail is widened, not weakened.
3. **Read the picture:** **the main risk, with conditions.** Cold-blooded runners on grass fade on thermal and show on night vision. That's the intended skill, and fair **because** of the leash (they're near the named place) and regrouping (they come back). The risk is the **forest-sweep** template: up to 60% cold under trees, where night vision is murky. Condition: before sign-off, `/playtest` screenshots a scattered forest-sweep horde at d3 in all three views, and a human finds the cold runners. If they can't, forest-sweep gets a shorter regroup delay, not invisible runners.
4. **Fair and repeatable:** passes with rules 4 and 6. The intel stays true: the briefing's horde count, size, cold count and places are unchanged, and runners stay within the leash of the place named. Every mission stays winnable: regrouping means a player who can't chase can still wait and shell again, though at d4–5 the clock may not allow it.
5. **Darkly comic, never cruel:** passes. Zombies scattering from a 105 is slapstick. No people, groups or places are involved.

**No blocking clash**, given the forest condition under pillar 3.

## The one assumption
**The chase after a 105 hit is fun: tracking runners with the 40 and 25 feels like skill, not clean-up.** If it is, Clear gains minutes of good play and all three guns matter. If it isn't, scatter only adds waiting, or a hunt for the last few.

**What would prove it wrong:** in a human playtest, most testers, asked what they did after their first 105 hit, either say they **waited for the horde to come back and shelled it again** (the 105 is still the whole fight, just slower), or describe the end of the mission as **"hunting for the last one"**. A matching sign in the data is a median of more than 60 s from 5 zombies left to the win, in human runs.

## In scope / out of scope
**In:**
- Rules 1–7 above, for `classic-clear`, `clear-tennis`, `clear-park` and `forest-sweep`, at every difficulty.
- The recomputed `HORDE_CHILD_GAP`, the shelter and drift checks that use it, and the guardrail tests extended to match (see "How we'll know").
- The briefing sentence, the first-scatter radio text, and wiring `few-left` and `cold-leftovers` (text, plus voice where the recording exists).
- The balance bot playing Clear under scatter as it is (it already prefers the 40 and 25 for small clusters), plus a **105-only** bot variant used only to measure that chasing matters.
- Re-tuning Clear's time limits if the bands need it (Clear only).

**Out:**
- Scatter in Escort or Hold, or for wave zombies.
- Scatter from the 40 or 25.
- Any change to the 105's blast, ammo or reload.
- The **training tutorial**: its `fire105` step uses a Clear horde. Training opts out of scatter for now, so its scripted steps don't change underneath it. Teaching scatter in training is a follow-up (open question 3).
- The landing-page backdrop (it runs a Clear sim): out, but if it fires for show, `/playtest` should check it still looks right.
- New voice recordings (no spending).
- A HUD marker for runners. That's the Feel & Access Designer's call at `/plan`. The radio line and regrouping should be enough to test the assumption.

## Interactions with spec 001 (Three Nights)
- **Night one is Clear at d = B (1–3).** Today it lasts 21–67 s for the bot, well under the "a minute or two" spec 001 assumed. Scatter brings it into the 2–5 minute band. That's good for the arc (short, long, longest), and it adds about 2 minutes to a full campaign, still inside one session. Night one must stay **gentle**: d1 win rate 85–100%.
- **The cold reveal still holds.** On Gentle, night one at d1 has no cold zombies (`coldShare` 0), so scatter can't spoil night two's `first-cold`. Forest-sweep (always cold) is already last in night one's list.
- **Clear as a substitute** on night two, or night three (`classic-clear` at d5 on Hard when no defend builds): it uses the same rules and the same bands. Night three's "no lower than single Hold" rule doesn't apply to a Clear substitute.
- **Fingerprints:** scatter is sim behaviour, not mission data, so `missionFingerprint` doesn't change. But a night-one best set **before** scatter would be unbeatably fast. If any campaign record could exist from before this lands, the Tech Lead should make the rules change reset night-one bests. It's moot if both ship together.
- **The wider horde gap** can remove a tennis club or park as night one's anchor on maps where it sits near a school. The resolver already falls through to the next template, so the campaign still builds, but `/map-check` should report how often it happens.

## How we'll know it worked
**Tests (`npm test`):**
- Guardrail: the static gap test uses the leash: `max(HORDE_SPREAD, HORDE_WANDER, leash) + reach105 + CHILD_FIRE_CLEARANCE`.
- Guardrail, end to end: the existing "in play" test today runs with **nobody firing**, so scatter would never happen in it. Add a run with the human-skill bot firing every gun, including the 105, on the school-heavy town, Clear at d1, d3 and d5 for several seeds. **No zombie, scattered or not, is ever within the floor of a child place.**
- Leash: across Clear seeds and difficulties with the bot firing, no horde zombie is ever farther than the leash (plus the walk grid's nudge) from its gathering point.
- Regroup: in a Clear sim where one 105 is fired and nothing else, every surviving runner is back within the wander radius of its gathering point within the regroup delay plus a walking allowance.
- Determinism: same map, seed and scripted shots give an identical Clear trace. Escort and Hold fingerprints and trace hashes are unchanged. Clear with no input is unchanged.
- Intel: briefing horde counts, sizes and cold counts equal the sim's starting zombies (already true; pin it for scatter).

**Balance (`/balance`, human-skill bot, sample town, 12 seeds or more):**
| Measure | d1 | d5 |
|---|---|---|
| Bot win rate (Clear) | 85–100% | 25–60% |
| Median Clear length | 2–5 min | 4–8 min |
| Share of kills by the 40 + 25 (d3–d5) | — | **at least a third** (the 105 is the opener, not the whole fight) |
| **105-only bot** (waits for the regroup) | wins | **loses most** at d4–d5 (chasing has to matter) |
| Escort and Hold | unchanged (identical traces) | unchanged |

If the d5 band can't be reached without regroup delays so long that the end turns into a hunt, the lever is **Clear's time limit**, not the 105. Bring the numbers back to me before changing anything else.

**Map check (`/map-check`):** with the 99 m gap, every Clear template that builds on the sample town today still builds at every difficulty. On the school-heavy town and any real fixtures, report how many Clear missions and night-one anchors are lost. If it's more than a few, shrink the leash.

**Playtest (`/playtest`):** screenshots of a freshly scattered horde at t + 3 s and t + 15 s in white-hot, black-hot and night vision, at normal zoom and ×2, on `clear-park` and `forest-sweep` at d3. Warm runners, cold runners on grass and road, and fires must be told apart (pillar 3 condition).

**Human playtest (the assumption test), 3–5 people, Clear at d2 and d4, no prompting:**
- Asked **"After your first 105 hit, what did you do next, and was it fun?"**, most describe chasing runners with the 40 or 25 and say yes.
- Asked **"Which gun did the most work?"**, most do **not** say "the 105 only".
- Asked **"Did the end of the mission feel like a chase, or a hunt for the last one?"**, most say chase. Human median time from 5 left to the win is 60 s or less.
- Nobody says a cold runner was impossible to find.
- The owner plays one Clear at d2 on their own map and says whether it now feels like a fight.

## Open questions for the user
1. **Approve scatter for Clear missions (class C):** 105 hits scatter horde survivors, who regroup at their gathering point; Clear only; the guardrail gap widens from 80 m to about 99 m. I recommend yes.
2. **May runners head for the sheltering friendlies if you shell the horde from the wrong side?** I recommend yes. It turns where you aim the 105 into a protect-people decision, and the 25 mm is the gun made for working close to friendlies. The alternative is to steer runners away from the friendlies automatically. That's safer, but it removes the feature's best decision.
3. **Training stays without scatter for now?** I recommend yes, with a follow-up to teach "shell, then finish the runners with the 40" in training once the human playtest shows players like it.
4. **May the Balance Analyst change Clear's time limits (Clear only) to reach the bands?** I recommend yes. It's the agreed fallback lever, rather than weakening the 105.
5. **Pull `few-left` and `cold-leftovers` forward** from the section C backlog item into this build? They're already written and recorded, so this costs nothing. I recommend yes: they're the safety net against the last-straggler hunt.

---
## Technical design  *(added by tech-lead)*

*Reviewed against feat/phase-3 at ede92b6 (3.15 solid buildings, 3.16 bigger waves, spec 001 core merged). `npm run typecheck` is clean. Numbers marked "measured" come from probes run against this tree (a scratch copy with the gap set to 99 m), not from estimates.*

### 1. Where it lives
| File | Change |
|---|---|
| `src/sim/missions.ts` | New `SCATTER_LEASH = 45`. `HORDE_CHILD_GAP = Math.max(HORDE_SPREAD, HORDE_WANDER, SCATTER_LEASH) + MAX_KILL_REACH + CHILD_FIRE_CLEARANCE` (= 99). `shelterSpotFor` already uses the constant for the spot (+ `SHELTER_SPREAD`) and the drift segment, so it follows automatically. Clear briefings gain the Story Writer's scatter sentence (text only: `missionFingerprint` excludes text). |
| `src/sim/sim.ts` | Scatter lives here and nowhere else: a branch in `updateShells` (105 impacts only) that marks runners, and a branch in `updateZombies` that moves them. New optional `Zombie` fields `scatter` (0 none, 1 flee, 2 lurk, 3 return) and `scatterT`. New constructor option `{ scatter?: boolean }`, default `mission.type === 'clear'`. Its own stream: `mulberry32(hashString('scatter|' + map + '|' + seed + '|' + type + '|' + difficulty))`. A new `SimEvent` `{ type: 'line'; id: RadioLineId }` for `few-left` and `cold-leftovers`. The first scatter reuses the existing `radio` event. |
| `src/ui/tutorial.ts` | `new Sim(..., { scatter: false })`: Training opts out, one argument. |
| `src/game/game.ts` | One `case 'line'` that shows the caption and plays the voice clip where `recorded`. Nothing else. That keeps contact with the 3.9 sensor branch to a few lines. |
| `src/sim/bot.ts` | `BotSkill.guns?: string[]` so the balance runner can field a 105-only bot. The default is unchanged. |
| `tests/balance/balance.test.ts` | Gains a template dimension (the four Clear templates), kills by weapon (from `impact` events), and `SKILL=only105`. |

Layering: everything new is in `src/sim` (no three.js, no DOM). `tests/layering.test.ts` keeps guarding that.

### 2. Data flow
```
fire('105') → shell lands (updateShells)
  kills (unchanged, main rng) → for each surviving horde zombie, if mission scatters and d < 2 × r (32 m):
     scatter = 1, heading = away from impact + wobble (scatter rng), flee for FLEE_S, then lurk
     regroupAt = t + delay(d, difficulty, template) (scatter rng)
     first scatter of the mission → emit radio "…drift back to {label}"
updateZombies, per runner (survivor chase still comes first, unchanged):
  flee: move along heading at FLEE_MUL × speed
  lurk: shamble in place
  t ≥ regroupAt: return (walk to anchor at the normal shamble speed); within HORDE_WANDER → scatter = 0, goal = null (milling resumes)
  every scatter move passes isBlocked() AND the leash rule below
checkResult/state → zombiesAlive ≤ 5 → emit line few-left | cold-leftovers (once each)
```
**The leash rule (makes the guardrail a proof, not a hope).** A runner's move is accepted only if it ends within `SCATTER_LEASH` of its anchor's current position, *or* it reduces the distance to that anchor. Otherwise the runner slides along the leash as it does along walls, or stops and turns to lurk. For a still horde, that keeps every runner within 45 m of its gathering point. For the drifting horde the anchor moves along the segment centre → shelter. Distance to a segment is convex, so a step towards a point on the segment never takes a runner farther than 45 m from the segment. The guardrail already checks that segment with `HORDE_CHILD_GAP`. Milling (non-runner) movement is untouched, so no-input Clear is byte-identical.

**The regroup place on the radio has to be true.** For a still horde, use `h.label` (as briefed). For the drifting horde, once its anchor has moved more than `HORDE_WANDER`, use `placeLabel(map, anchor)` at the moment of the first scatter (runners regroup on the horde, which has moved). Map text reaches the screen through `hud.say`, so `textContent`.

### 3. Determinism
- All scatter randomness comes from the new stream. The main `rng` draw order is unchanged until the first 105 lands, so **Clear with no input is identical before and after the scatter commit.**
- Timers and speeds scale by `dt`. There's no wall-clock time. Regroup delays are seeded, not adaptive.
- **Correction to "How we'll know":** the wider gap changes Clear *mission generation* on purpose. Measured on the sample town: 60 of 240 Clear missions (4 templates × d1–5 × seeds 1–12) move a horde, the shelter spot or the drift line, including `classic-clear` d3 seed 42. On the school-heavy town it's 84 of 240. `missionFingerprint` doesn't include horde positions, so campaign night records still match. Clear's no-input trace is therefore locked **after** the gap commit and must not move in the scatter commit.

**Fingerprints and traces**
| Hash | Status |
|---|---|
| `EXPECTED_FINGERPRINT` (escort d3 s42, `4c4d8d66`) | must not change |
| `EXPECTED_DEFEND_FINGERPRINT` (`c7cefb39`) | must not change |
| `EXPECTED_DEFEND_TRACE` (`3be0b14`) | must not change |
| **New** `EXPECTED_ESCORT_TRACE` (escort d3 s42, 30 s, no input) | added in commit 1. The spec assumes Escort has a trace hash, but it doesn't today. Must not change afterwards. |
| **New** `EXPECTED_CLEAR_FINGERPRINT` + `EXPECTED_CLEAR_TRACE` (classic-clear d3 s42, 30 s, no input) | added in commit 1 with the 99 m gap (they differ from a pre-gap value by design; say so in the PR). Must not change in the scatter commit. |
| A scripted Clear trace (same seed, one 105 at a fixed point at t = 20 s, 40 s of play) | new in the scatter commit. Run twice it gives the same hash, and it differs from the no-input trace. |

**Bests:** nothing in `src/ui/bests.ts` or the campaign store has shipped (`main` has neither file). If 002 ships in the same release as 001, the stale-best risk is moot. `/preflight` confirms that. If they ship apart, add a rules tag to the Clear `bestKey` kind and bump the campaign store `VERSION`.

### 4. Failure modes (no new external input)
| Case | What happens |
|---|---|
| A real map where the 99 m gap leaves fewer than 2 horde spots | The generator already returns its own reason, and recon doesn't offer that template. Measured: **the sample town loses no Clear template at any difficulty** (0 of 240 fail at 80 m or at 99 m). On the school-heavy town the same 120 fail at both gaps (that town has no tennis club or forest), so the gap adds no failures. `/map-check` reports the real fixtures. If it's more than a few, shrink `SCATTER_LEASH`, never the gap (spec rule 5). |
| Runner boxed in by buildings | `isBlocked` slide, as for milling. If every way is blocked, it lurks, then returns (always allowed, because it shortens the leash). |
| Anchor itself unreachable from a runner (river) | The return phase uses straight-line steering, like milling. If no progress for `STUCK_S`, the runner drops to `scatter = 0` and mills where it is. That spot is still inside the leash, so the guardrail still holds. |
| Horde wiped except one runner | Normal. `few-left` / `cold-leftovers` fire. |

### 5. Performance
Per 105 impact there's one extra pass over living zombies (≤ 6 hordes × 33 at d5 ≈ 200). Per step it's O(1) per runner. That's far under 0.05 ms, and the 1,000-zombie budget test is unaffected (defend, no hordes). No render cost: runners are ordinary zombies (the view already shows fast movers as running).

### 6. Test plan (write these first, and watch the scatter ones fail before the sim change)
**Unit / sim (`tests/sim.test.ts`, `tests/scatter.test.ts`):**
1. *Only the 105, only Clear, only hordes*: a 40 and a 25 on a horde mark no runners. A 105 in a defend or escort sim marks none. `new Sim(.., { scatter: false })` marks none. **Fails first.**
2. *Away from the impact*: every runner's heading has a positive dot product with (runner − impact).
3. *Leash*: across the four Clear templates × d1/3/5 × 4 seeds with the human bot firing, every runner position is ≤ `SCATTER_LEASH` + 0.01 m from its horde's path (its centre, or the drift segment for the drifting horde).
4. *Regroup*: one 105 at t = 20 s, nothing else. Every surviving runner has `scatter === 0` and is within `HORDE_WANDER` + 2 m of its anchor by `regroupAt + leash / minSpeed + 5 s`.
5. *Determinism*: the hash table in §3.
6. *Intel*: briefing horde count, sizes and cold counts equal the sim's starting zombies, all templates (pinned here for scatter).
7. *Lines*: `few-left` fires once at ≤ 5 alive. `cold-leftovers` beats it when all the remaining are cold.

**Guardrail (`tests/guardrail.test.ts`):**
- The static test reads `SCATTER_LEASH` from the code: `Math.max(HORDE_SPREAD, HORDE_WANDER, SCATTER_LEASH) + reach105 + CHILD_FIRE_CLEARANCE`, and expects ≥ 99.
- **New "in play, firing" test**: school-heavy town, `classic-clear` and `clear-park` (the only Clear templates it builds), d1/d3/d5, seeds 1–4, step 1/30, 180 s. **Two shooters per run**: (a) `Bot(SKILL.human)`; (b) an adversary that fires every 105 at the point 12 m on the far side of a horde *from its nearest child place*, so runners flee straight at the school. Every living horde zombie is checked every step. `worst ≥ reach105 + CHILD_FIRE_CLEARANCE − 2` (the existing half-cell allowance). The adversary is the real proof, because the bot never aims to cause harm.

**Balance (`/balance`, `BALANCE=1 SEEDS=12`)**, per Clear template × d1–5: win %, median length, kill share by weapon, and the same with `SKILL=only105`. Procedure: (1) run at the starting numbers (`SCATTER_LEASH` 45, regroup 15–25 s scaled by difficulty, flee 3–4 s at ~2.2× shamble). (2) Tune only regroup delay and flee speed until the d1 and d5 bands and "40 + 25 ≥ ⅓ of kills at d3–5" hold. (3) If d5 still wins too often, the lever is Clear's `timeLimit` (owner approved), nothing else. (4) Escort and Hold rows must be identical to the pre-change run (same table, byte for byte). Report to the Game Director before any other lever.

**Playtest scenario (`/playtest`)**: `?type=clear&difficulty=3&seed=…&autostart=1` with the template hook. Use `__spooky.fireAt('105', horde)`, then screenshot at t + 3 s and t + 15 s in white-hot, black-hot and night vision, at normal zoom and ×2, on `clear-park` and `forest-sweep`. Also the pillar-3 forest check.

### 7. Smallest first step
**Commit 1: "Leash before scatter".** Add `SCATTER_LEASH` and the recomputed `HORDE_CHILD_GAP`, the static guardrail test reading the leash, the new escort trace hash, and the new Clear fingerprint and no-input trace (classic-clear d3 s42, post-gap). Escort, defend and defend-trace hashes stay unchanged in the same run. There's no sim behaviour change. This commit proves the go/no-go the spec cares about: what the wider gap costs on real maps (run `/map-check` on it). Commit 2 is the scatter itself, with tests 1–7 and the firing guardrail test, and the Clear hashes from commit 1 still pass.

### Verdict: **APPROVED WITH CHANGES**
1. Reword the determinism line: "Clear with no input is unchanged" holds across the scatter commit, not across the gap change, which moves 25% of sample-town Clear missions by design (measured).
2. The leash is a hard move rule measured from the horde's *path* (the anchor, or the drift segment), as in §2, not a soft target.
3. The firing guardrail test includes the adversarial 105 shooter, not only the bot.
4. Add an escort trace hash before anything changes (the spec assumes one exists).
5. Training opts out with a Sim option, not with mission data, so no fingerprint moves.
6. The regroup place named on the radio is the drifting horde's *current* place when that horde has moved (hard rule 9).
7. Land 002 before 003. Both edit `updateShells`/`updateZombies`, and 003 rebases on it.

## Feel & access  *(added by feel-designer)*

## Owner decision (22 Nov 2026)
Approved ("scatter ok"), with the four recommended answers: runners may scatter toward friendlies if shelled from the wrong side; Training night keeps today's hordes for now; the Balance Analyst may retune Clear's time limits; the recorded `few-left` and `cold-leftovers` lines are wired in.

---
## Feel & access review  *(feel-designer, /plan, 22 Nov 2026)*
Played on: desktop (keyboard and mouse) and the owner's Android tablet (stick, hold-to-fire, GUN / VIEW / ZOOM). Checked against today's HUD (`src/ui/hud.ts`), heat values (`HEAT` in `src/game/agentAnim.ts`) and blast effects (`src/game/effects.ts`).

**Runner markers: my call (the spec left it to me).** **No marker on individual runners.** Finding them with the right camera is the skill (pillar 3), and a marker on each one would turn the chase into clicking on labels. Instead, the player always knows **where they'll come back to** (M1 below). The leash keeps every runner within about 45 m of that point, so it's also where to look for them.

**Must fix**
- **M1. Show the regroup point in flight.** While any runner from a horde is out, show that horde's gathering point as an on-screen marker labelled with the horde label (the existing `setMarkers` path, `textContent` only; it's untrusted map text). Add it to the minimap too if that's cheap. Hide it once the horde has regrouped or is dead. Today the briefing and diorama show gathering points, but the in-flight HUD doesn't. Rule 4 ("they come back to the named place") is only fair if the player can find that place while flying. This is also the main help against hunting for the last one.
- **M2. The cold-blooded hint must work on touch.** The HUD says `COLD-BLOODED n (V: NIGHT VISION)`. On the tablet there's no V key, so it should name the button the player has (`VIEW: NIGHT VISION`). Use the same touch/keyboard switch the controls list already uses. This is an old bug, but scatter makes it matter: cold runners on grass become the main search.
- **M3. Runners must be seen leaving.** They bolt during the first seconds after a 105 hit, exactly when the round's smoke (about 2.4 s of fireball and smoke) and the night-vision washout cover the impact. If the burst of speed ends inside the smoke, the player sees the result but never *which way* they went. Requirement: **the direction of the runners can be read by t + 2 s in all three views.** Add a **t + 1 s and t + 2 s** screenshot to the `/playtest` set. If it fails, either lengthen the burst so runners come out of the smoke still sprinting, or thin the smoke for the 105 in Clear. Never add a marker for this.

**Should fix**
- **S1. Cold runner vs cold body in night vision.** Cold zombies are at ground heat alive or dead (`HEAT.cold`), so on thermal a cold runner and a cold body look the same, and in night vision the player tells them apart only by pose and movement. Add one `/playtest` forest-sweep night-vision shot with a cold body and a cold runner close together, at ×2. If a human can't tell which is alive, the forest-sweep regroup delay gets shorter (the spec's lever).
- **S2. Tune the chase for thumbs, not only for the bot.** The human-skill bot aims perfectly. Leading a sprinting runner with a touch stick in the 25 mm's 5° view is much harder. Keep the speed burst short (around 4 s or less) so the chase is about tracking a runner after it slows, not hitting a sprinter. **At least one human tester plays on a tablet**, and the owner's d2 test run is on the tablet. Add a tablet question to the human playtest: "Could you hit the runners with the stick?"
- **S3. A runner heading for the friendlies needs a tell that isn't only sound.** Rule 2 allows it on purpose (owner decision). Check that the existing `friendlies-under-attack` and `danger-close` cues show as radio text on screen as well as playing as voice, and fire early enough to react to (before contact, not at it).
- **S4. HUD words: add nothing else.** `HOSTILES n/total` and `COLD-BLOODED n` already cover the end of the mission. Don't add a "SCATTERED n" line. The marker from M1 carries the rest.

**Ideas**
- **I1. Last-straggler line (text only):** when 3 or fewer are left and nothing has been killed for 30 s, a text line names the nearest gathering point with runners still out ("Last of them are drifting back to {horde label}"). It's true by rule 4. Use it alongside `few-left` and `cold-leftovers`, not instead.
- **I2. Kill confirmation on a single runner:** a small tick on the crosshair for 0.3 s when a 40 or 25 round kills a runner. Fresh bodies already cool from white to grey, but a lone kill at 25 mm range is easy to miss on the tablet's smaller screen. It's a local effect, not a flash.

**Other checks: no findings**
- **Photosensitivity: pass.** There are no new effects, and the 105's 4.5 s reload limits how often it can land, so its washout and kick can't come faster than today. Re-shelling regrouped hordes adds rounds over a mission, not rounds per second.
- **Reduce flicker and motion: pass.** Nothing new moves the camera. The 105 kick already turns off with Reduce flicker or reduced motion.
- **Sound alone: pass**, if the first-scatter line, `few-left` and `cold-leftovers` all appear as text (the spec says they do).
- **Tone: pass.** Zombies scattering from a big shell is slapstick.

**Verdict: APPROVED WITH CHANGES.** Do M1 to M3 in the build. S1 and S2 go into the `/playtest` and human-playtest plans. None of these changes the sim, the guardrail or determinism.
