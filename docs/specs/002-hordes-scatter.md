# 002 — Shelled hordes scatter, then regroup (Clear missions)

*Status: approved, awaiting /plan* · *Owner: Game Director* · *Date: 22 Nov 2026*

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
