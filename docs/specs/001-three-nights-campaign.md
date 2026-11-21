# 001 — Three Nights: a three-sortie campaign over your own street

*Status: draft* · *Owner: Game Director* · *Date: 21 Nov 2026*

**Mode: HOLD, with two amendments.** Build the Story Writer's campaign as designed in `docs/story/campaign.md`, `docs/story/radio-script.md` and `docs/story/voice.md`. The two amendments are both about mission shape: (1) a longer, staged finale on night three, and (2) replaying a won night to beat your grade. **Class C:** it's a new narrative feature, it changes balance for the finale, and recording the lines costs credits. It needs the owner's yes before `/build`.

## Goal
After recon, the player can fly **Three Nights**: three linked sorties over their own neighbourhood (clear, then escort, then hold), each one harder than the last. Every night is built from real places, and between nights Ground's "previously on" summary names the real street people walked home to. The campaign ends with "Spooky, go home." This gives the game a beginning, a middle and an end, so it feels like a proper game rather than a menu of one-off missions. That's the owner's Zombie Gunship comparison, and it answers the Critic's two weakest scores, Gameplay 6 and Replay 4.

## Player story
"As the gunner, when I've just seen my own streets in thermal, I want one more night that's a bit worse than the last and remembers what I did, so that I finish the night with a story about my street: I cleared the park, walked five people home down a street I know, and held the library till dawn."

## The idea at its strongest
A single mission over your street is a novelty, but three nights make it a story. The design is unusually sound for a story feature. Each night re-uses a mission the simulator already builds and tests, every spoken line is tied to a field the sim really has, and a lost night replays as the identical mission, so "Same streets, same dead. Go again." is literally true. Difficulty rises every night (`B + n − 1`), cold-blooded zombies are introduced at the right moment on Gentle, and the people you protect grow in number. The whole run takes about 12–17 minutes. That's one browser session: Poki's 2026 survey (scout report, item 10) puts typical sessions at 11–20 minutes. The cost is mostly glue and words, not new systems.

## Why HOLD, not EXPAND or REDUCE
- **Not EXPAND.** The obvious bigger version is Zombie Gunship-style progression: earn points, upgrade guns between nights. That rests on a different assumption ("players come back for power") and brings a large fairness cost (every night has to stay winnable with the starting kit). It also needs a taste call from the owner. Test the arc first; if it doesn't hold players, progression is the next pitch (open question 5).
- **Not REDUCE.** The design is already close to the smallest version that tests the assumption. It needs the chaining, the carry-over text and the ending; without them it's just three missions in a row, and the test would prove nothing. The one thing I take out of *this* spec is the wiring of the eight general in-mission lines (radio script section C: `ff-one-left`, `need-met`, `few-left`, `cold-leftovers`, `one-minute`, `doors-failing`, `reload-105`, `idle`). They help every mission, not just the campaign, so they become their own backlog item. Record them in the same session, though: one spend approval and one consistent take of Ground's voice.

## Pillars served
1. **It's your place:** strong. Each night is anchored to a real recon place where one exists (the tennis club, the park, the shops, the station, the sports hall). Previously-on and the tally name real places and streets, on screen only (`textContent`, hard rule 4).
2. **Protect people:** strong. The through-line is getting people home. The tally leads with people saved and friendly fire, not kills.
3. **Read the picture:** helped. On Gentle, cold-blooded zombies first appear on night two, and Ground's line points the player to night vision. **One condition:** the dawn fade (when it's built) must play only *after* the win. Thermal contrast must never drop while the player still has to find threats, or it becomes unfair-invisible.
4. **Fair and repeatable:** strong by design. Seeds come from `campaign|S|n`, replays are identical, and spoken lines play only when the data makes them true. **The one risk:** Hard night three runs at difficulty 5, already the hardest mission in the game (the bot wins Hold d5 only about 25% of the time, BACKLOG 1.9). Amendment 1 must not push it below that. That's a blocker condition, checked by `/balance`.
5. **Darkly comic, never cruel:** passes. The jokes are about the zombies, the kettle and a fictional residents' committee. No school, kindergarten, childcare or playground is ever used. "Neighbourhood Watch" was avoided as a name because it's a real organisation.

No pillar clash.

## The one assumption
**A short story with rising stakes over your own streets is what makes players want to fly the next sortie.** The Critic's low scores and the owner's comparison would then come from missing *structure*, not from missing systems (upgrades, unlocks, endless modes).

**What would prove it wrong:** in a human playtest on testers' own addresses, most testers stop after night one, or can't say what changed between nights ("it was the same thing three times"). Then story isn't the gap; progression or variety is, and open question 5 moves up.

## Mission shape: the two amendments

### Amendment 1: night three gets longer and builds (resolves campaign.md §10, question 2)
**Recommendation: lengthen it.** The campaign finale should hold for **about 4.5 minutes (≈ 270 s) at every campaign difficulty**, not today's 195–225 s. The extra time is shaped, not just more of the same. Reasons:
- **The pacing is short, long, short.** Night one can be over in a minute or two, night two runs 5–8 minutes, and then the finale is the second-shortest sortie of the three. A last stand should be the longest held breath.
- **It's under the quality band.** QUALITY §3 targets a median mission length of 4–8 minutes at difficulty 5. Hard night three (225 s, 3 m 45 s) can't reach that even if the player survives to the end.
- **The current last minute probably fizzles.** Waves spawn 180–340 m out and zombies walk at roughly 1.3–2.3 m/s, so a wave can need 80–260 s to reach the doors. In a 195 s hold, waves spawned in the last minute or two may never arrive before dawn. The finale's peak would then be zombies walking towards a building they'll never reach. *(I worked this out from the numbers in `src/sim/missions.ts` and `src/sim/sim.ts`; the Balance Analyst should confirm it with a sim trace.)*

**The shape I want (outcomes, not code; the Tech Lead and Balance Analyst choose the numbers):**

| Part | Roughly | What happens | What Ground says |
|---|---|---|---|
| Stragglers in | first ~60 s | The two stragglers walk in (if the mission has them). Waves are lighter than the night's peak. | `n3-open`, `big-expected`, `cleared-hot` |
| The build | middle | The varied waves (rush, cold, standard), climbing to the night's difficulty | existing wave calls |
| Last push | final ~60 s | A **guaranteed big wave** that is placed and timed so it **can reach the doors before dawn**. It's the finale's peak. | `big-group`; dawn at zero |

- **Only campaign night three changes.** Single-mission Hold keeps its current length and balance, so nothing already tuned moves.
- **Not harder overall, just longer and shaped.** The finale's bot win rate must be **no lower than today's single-mission Hold at the same difficulty**, and within the QUALITY §3 band. The lighter opening pays for the extra length.
- **Intel stays true.** The briefing says how long to hold and that a big wave is coming. Because the last push always exists, `big-expected` becomes always true on night three. Pin that with a test.
- If the Story Writer wants a word for the last push in the briefing, it's theirs to write. Nothing new needs recording.

### Amendment 2: replay a won night for a better grade
After a night is won, the campaign screen lets you fly it again. It's the identical mission, the same challenge every time, like Spelunky's daily (scout item 7). The night's stored record keeps your **best** run, and the tally shows each night's grade. It's cheap (the records and grades already exist), and it's the most direct answer to Replay 4 inside this feature. Previously-on and the tally read from the kept record, so the text stays true.

## In scope / out of scope
**In:**
- The campaign exactly as in `campaign.md` §2–§9: choosing Gentle, Standard or Hard; three night cards built up front; template preference lists, substitutes and fallbacks; "no campaign on this map" with the generator's reason; identical replay of a lost night; on-device records keyed by `seedForPlace` (never `map.name`) with a "Forget this campaign" button; previously-on text; the ending sequence and the THREE NIGHTS tally.
- Amendment 1 (the staged night-three finale) and amendment 2 (replay a won night, keep the best, show grades in the tally).
- **Where it lives:** after recon, **"Fly Three Nights"** is the first, most prominent choice, and the three suggested single missions sit below it. Recommended, but it's a taste call (open question 4).
- Wiring the radio script's section A (campaign spine) and section B (template flavour) lines, with the P1/P2/P3 rules. Until the recordings exist, these lines show as on-screen radio text only.
- Every truth-pin test in `campaign.md` §9, plus: night three always has a big wave in its last minute that reaches the doors (or could, unopposed); every night of the campaign builds on every map fixture at B = 1, 2 and 3 (G5 extended); the bot can win and lose each night (G6).

**Out:**
- Wiring radio script section C (the eight general in-mission lines). That's a separate backlog item; record them now, wire them later.
- Upgrades, unlocks, currency or any between-night power (open question 5).
- The dawn fade visual. It's an Art Director item; until it exists, `dawn-thermal` is cut, as the Story Writer specified.
- Carrying world state between nights (craters, survivors on the roof, horde routes that react). That's scout idea 4's bigger version and a later pitch, if this one works.
- Sharing, result cards or links.
- Bus routes ("Last bus home", 2.6) as a night-two option. It slots into the night-two preference list when it exists.

## Depends on other in-flight work
| Dependency | Status | Effect on this spec |
|---|---|---|
| **Unlimited 25 mm** (`feat/3.11-controls`) | in flight, not merged | `reload-105` stays held, and the radio script's "no 25 mm reload lines" rule assumes it. **Tune the finale (amendment 1) on top of unlimited 25 mm**: it changes how fast players clear waves, so balancing without it would be wasted work. |
| **Dawn fade** (Art Director) | not built, no backlog item | `dawn-thermal` is cut until it exists, and the ending works without it. When it's built, it plays after the win only (pillar 3 condition above). I recommend opening the item; it's the emotional payoff of "Hold till dawn". |
| **Recorded audio wiring** (3.6) | in progress | Campaign lines need the radio playback and priority queue. If 3.6 isn't ready, ship the lines as on-screen text first. |
| **Recording ~28 new lines** (ElevenLabs) | needs owner approval (spending, class C) | About 1,400 credits, roughly US$0.30, by the Story Writer's estimate. The campaign can ship text-only first. |
| **School guardrail gaps** (3.8) | todo | The campaign relies on `templateAnchors` and the route guardrails. 3.8 should land first, or with this. |
| **Grades and personal bests** (2.11) | in progress (T2) | The tally's grades and amendment 2 need them. |
| **"Hello, home" flyover** (3.7) | todo | Not required. If it lands, it's the natural opening for night one. |

## How we'll know it worked
- **Tests:** every truth pin in `campaign.md` §9 passes, plus the new pins above (night three's big wave always present and able to arrive; `big-expected` always true on night three; replaying a won night is identical; the tally uses the kept best record).
- **Balance (`/balance`):** each night's bot win rate is in the QUALITY §3 band for its difficulty. The finale's win rate is no lower than single-mission Hold at the same difficulty. The finale's median length is about 4–5 minutes at every B. Measured with unlimited 25 mm.
- **Human playtest (the assumption test):** 3–5 people, each on their own address, Standard difficulty, no prompting:
  - at least 4 of 5 start night two straight after night one;
  - at least 3 of 5 finish all three nights in one sitting;
  - asked "what changed between nights?", most name something real (more people, the cold ones, the safehouse);
  - asked "did night three feel like a finale?", most say yes;
  - at least one replays a won night for a better grade without being asked.
- **Critic re-review:** Gameplay and Replay each up by at least one point.
- **The owner:** plays it through and says whether it now feels like a proper game.

## Open questions for the user
1. **Approve the campaign (class C):** three nights, clear, then escort, then hold, with Gentle/Standard/Hard, under the name "Three Nights"? I recommend yes.
2. **Lengthen night three** to about 4.5 minutes, building to a guaranteed last push, for the campaign only? This is a balance change, so class C. I recommend yes (amendment 1).
3. **Spend about 1,400 ElevenLabs credits (≈ US$0.30)** to record the 28 lines marked "Record now" in one session, including the 8 general lines that will be wired later? I recommend yes. The 2 held lines wait for the 25 mm change and the dawn fade.
4. **Make "Fly Three Nights" the main thing after recon,** with single missions below it? I recommend yes. It's the clearest way to say "this is the game".
5. **Taste check, for later rather than now:** do you want Zombie Gunship-style upgrades between nights? I recommend waiting until the playtest above shows whether the story alone brings people back.
6. **Open the dawn-fade item for the Art Director now?** I recommend yes, with the rule that it only plays after the win.

---
## Technical design  *(added by tech-lead)*

## Feel & access  *(added by feel-designer)*

## Owner decision (2026-11-21)
Approved as specced: the name "Three Nights", the longer finale (about 4.5 minutes, campaign only), replaying a won night, "Fly Three Nights" as the main choice after recon, and recording the lines within the ElevenLabs cap. Upgrades between nights are deferred until after human playtests. The dawn fade is cut for now.
