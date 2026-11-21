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
*See "Technical design (tech-lead, 21 Nov 2026)" at the end of the file. It was appended there because other people were editing this file at the same time.*

## Feel & access  *(added by feel-designer)*

## Owner decision (2026-11-21)
Approved as specced: the name "Three Nights", the longer finale (about 4.5 minutes, campaign only), replaying a won night, "Fly Three Nights" as the main choice after recon, and recording the lines within the ElevenLabs cap. Upgrades between nights are deferred until after human playtests. The dawn fade is cut for now.

---
## Feel & access review  *(feel-designer, 21 Nov 2026)*

*The empty "Feel & access" heading above is left as it was so I don't edit the middle of the file while the Tech Lead is also appending. This section replaces it.*

**Scope.** This spec, `docs/story/campaign.md`, `radio-script.md` and `voice.md`, checked against what's on `feat/phase-3` today: the HUD radio log (`src/ui/hud.ts`), the result screen (`Game.showResult`), Reduce flicker (`src/ui/settings.ts`, `game.ts`), the flash meter (`scripts/playtest.mjs`), blast effects and weapons. The owner plays on an **Android tablet as well as desktop**, and touch controls are coming in `feat/3.11-controls`, so the campaign screens are reviewed as touch screens too, not only as mouse screens.

**Summary.** The design is kind to the player. A lost night replays identically, there are no lives, the tally leads with people rather than kills, and every voiced line has written text. Three gaps need closing before `/build` signs off. (1) The current result screen can't host a campaign: after a loss it offers "Next mission" (and the N key), which would skip a night. (2) Several new voiced lines play while the HUD is hidden, so today they would have **no caption at all**. (3) Nobody has checked the campaign on a tablet. The finale's longer, staged shape is good for feel. Its last push needs a visible tell beyond the voice line, and a flash check that matches unlimited 25 mm.

### Must fix

**M1. A campaign result screen, not the single-mission one.** Today `showResult` offers "Next mission / Retry / Menu", and N works after a loss. In a campaign, that breaks "a night is won before the next one opens".
- **Lost:** the primary button is **"Fly night two again"** (R), with **"Back to the nights"** beside it. No next or skip, and N does nothing. This button is the visible version of Ground's `night-lost` "Go again", so the prompt never depends on sound.
- **Won, first time:** the primary is **"Night three"** (N). Then **"Fly it again for a better grade"** and **"Back to the nights"**.
- **Won night three:** the only way on is **"See the three nights"** (to the tally).
- **Replay of an already-won night:** the primary is "Back to the nights". If the replay is lost, say so on the card, from the stored record: **"Night one stays won · best B"**. A loss must never look like it took the win away.
- Focus goes to the primary button, as it does today. The key hint line lists only keys that do something on this screen, and none on touch (see M3).

**M2. Captions everywhere a voice line can play, not only in the HUD.** The HUD radio log is the only caption surface, and it sits under the overlay. That means `previously`, `welcome-back`, `night-lost`, `n1-close`, `n2-close`, `night-won-*`, `n3-close` and `campaign-thanks` would all be spoken over a card with no caption. Rules:
- **Overlay screens get a caption line.** The night card, campaign screen, result card and tally each show one, in the Ground style: "GROUND: Dawn patrol has the street. Spooky, go home." It's text, 15 px or larger, and stays until the screen closes.
- **The caption includes the spoken words.** Where the on-screen variant is different text (`previously`, `welcome-back`, `need-met`, `few-left`), show the voiced sentence and then the slot text. For example: "Right, Spooky. Where were we." then "Last night: 4 of 5 walked home to a house on {street}." A deaf player should get everything a hearing player gets.
- **Caption order matches audio order.** Today `start()` writes "...You're cleared hot." the moment the mission starts. In a campaign it must come after the night opener and the extra line, as the radio script orders them.
- **A caption appears when its line starts playing.** If the P2/P3 rules drop a line, drop its caption too, so the screen and the speaker agree. In text-only mode (before recordings), the same priority rules decide which captions show.
- **Captions are the recordings' transcripts.** One table maps line id to caption text. The Audio Director checks each recording against it (transcribe and compare) and fixes any mismatch in the table, not just in the audio.

**M3. Check it on the owner's tablet, with touch.** This is the main way in now, and the owner plays on an Android tablet.
- `/playtest` screenshots the campaign screen, night card, result card and tally at **1280×800 and 800×1280** (tablet) and **390×844 and 844×390** (phone), with no overlap or clipping. Long real names must wrap (`overflow-wrap: anywhere`), never get cut off.
- **Every campaign button is at least 48 px tall**, like the landing page buttons, and has room between it and its neighbours.
- **The HUD captions must not sit under thumbs or touch controls.** Today the radio log is bottom-left (`bottom: 52px`), which is exactly where a touch stick or fire button usually goes. Agree caption placement with `feat/3.11-controls` before either merges. On touch, captions move above the control zone or to the top centre.
- **No keyboard letters on touch devices** in any new campaign text or key hint ("R retry", "N next"). The HUD's existing "(V: NIGHT VISION)" belongs to 3.11, but the campaign must not add more.

**M4. A flash check that matches the finale.** Unlimited 25 mm (the finale is tuned on top of it) removes the 60-round pause that used to cap sustained fire. The flash meter's 25 mm scenario only runs for 2 s. Add two scenarios to the photosensitivity checks: (a) **25 mm held for 10 s, zoomed**, in white-hot, black-hot and night vision; (b) **"last push"**, with the 105, 40 mm and 25 mm mixed into a dense crowd at the safehouse for 10 s, in night vision (washout stacks there). Both must stay within the limits: 3 flashes a second, and less than 25% of the screen flashing (QUALITY §2). Run at least one of them at the tablet viewport, because a small screen makes local flashes a bigger share of it.

**M5. The ending is player-paced and calm.** Nothing in the ending sequence or the tally advances on a timer. The result card waits for the player, and the tally opens on "See the three nights". Ground's two end lines play on the card that shows their captions. Every new screen (campaign, night cards, tally, grade reveal) obeys `effectiveReduceFlicker`, so the setting or the OS reduced-motion preference. With it on, nothing types out, counts up, scales or pulses: text appears at once. With it off, the most allowed is a single fade of 0.3 s or longer. No new full-screen flash, colour cut or vignette pulse anywhere in the campaign, including "last push" warnings. When the dawn fade is built, it must change contrast slowly (2 s or longer, no reversals) and play after the win only, as the spec already says.

### Should fix

**S1. Ease the radio jam at mission start.** On night three, the sequence is `n3-open` (~3.5 s), then `big-expected` (~3.5 s), then `cleared-hot`. The first wave is called at **3 s** (`FIRST_WAVE`), so four lines and four captions stack up while the clock runs and stragglers walk in. Under the 3 s P2 drop rule, it isn't even clear which ones survive. Better: play the **night opener on the night card or briefing**, when the player is reading and the audio is already unlocked by the click, with its caption on the card. That leaves only the truth line (`first-cold` / `big-expected`) and `cleared-hot` for the start of the sortie. The intel stays true and gets heard.

**S2. Captions must stay up long enough to read.** The log keeps 5 lines for 12 s, but a burst of 5 lines (wave calls, merged kill calls, `safehouse-hits`) can push out a line that has been up for under 2 s. That will happen in the finale's last push. Rules: every caption stays up for at least max(3 s, 0.4 s per word). The oldest **non-alarm** line drops first. A P1 line (`CHECK FIRE`) stays at least 5 s. Phone portrait shows 3 lines, so the log never covers the middle of the picture (backlog 1.12/2.10).

**S3. The last push needs a visible tell, and the right timing.** It's the finale's peak and the place most losses will happen. Pillar 3 says it can't arrive on the voice alone.
- `big-group`'s on-screen variant gives true data from the wave: **"Big group inbound from the north-east. 13 running cold."** The bearing comes from the spawn centre relative to the safehouse, and the cold count from the spawned wave. The voice stays slot-free.
- **Keep a clear lull of about 10 s or more** before the last push, with no other wave arriving. A breath before the storm is the best tell this genre has, and the `big` kind's 1.5× gap already points that way. Pin it alongside "big wave can reach the doors".
- **When it arrives matters for feel.** An unopposed big wave should reach the doors with about **25–50 s left**. Any later and the peak is cut off by dawn; any earlier and the last half-minute fizzles. That's for the Balance Analyst to confirm.
- `doors-failing` is deferred (section C), so give the HUD its own state as well. When integrity is below 50%, SAFEHOUSE turns to the alarm style, with text (not colour only), for example "SAFEHOUSE 43% · DOORS FAILING".

**S4. Hot clutter at the doors after four minutes.** Every 105 leaves 6 fires that last 14–20 s, and its craters take 25 s to cool. After 4.5 minutes of shelling one building, the area where the last push arrives is full of heat. Before `/playtest` signs off, take screenshots of a Hard finale at about t = 240 s in **white-hot, black-hot and night vision**, at normal zoom and ×2. Check that a live zombie, a cold-blooded zombie, a straggler and a fire/crater can be told apart. If fires read as zombies in white-hot, they need to cool faster or burn dimmer. That's an Art Director call, and it's covered by the existing rule "hot but below live-zombie white".

**S5. Mark the stragglers in the finale's opening.** HUD markers exist only for escort survivors (`Game.markers`). The finale opens with two stragglers walking in through the first, lighter waves, and on thermal the only extra help is the danger-close crosshair. Add a **STRAGGLERS** marker while they're out. It's cheap, it fits the "Don't hit them" briefing, and it keeps friendly-fire losses in the opening minute fair.

**S6. A loss should explain itself.** On the loss card, show the sim's reason, then **how far the player got, from true data**: "Held 3:52 of 4:30", "2 of 3 home", "Friendly fire 3/3". On a defend night, add when the doors broke. A 4.5-minute night lost at 3:52 has to feel like "nearly, and I know why". The identical replay makes that a promise the player can act on.

**S7. Retrying must be quick and quiet.** Retry is one press from the loss card to flying (the briefing can be one "Start" press, already focused). `previously` plays the **first time a night card opens in a session**, not on every retry ("Once per night card" in the radio script would replay "Where were we" after every loss, right after "Go again"). `n*-open` is already first-attempt only.

**S8. One "best" per night.** In a campaign, the result card shows **the night's best** ("Night one best: B · NEW BEST"). It doesn't show the single-mission personal best line from `bests()`. Otherwise one card shows two different bests and the replay goal blurs. The tally labels each night's line as the kept best run, so a player who just replayed and did worse isn't confused by different numbers. *(For the Tech Lead: today `bestKey` uses `m.mapName`, which campaign.md §6 rules out as a key because it can contain a house number. Campaign nights should not write to it.)*

**S9. Night cards: state in words, contrast kept.** Each card shows its state as a text label: **WON · grade**, **NEXT**, or **LOCKED · win night two first**. Don't show it with colour or dimming alone: a locked card's text still meets 4.5:1. Keyboard and screen readers land on the NEXT card's button first. The cards stack on narrow screens.

**S10. Entering and leaving the campaign.**
- **Difficulty pick:** each choice has one true line, for example "Gentle: cold-blooded zombies from night two." "Hard: the last night is the hardest mission in the game." Say what changing difficulty does to an existing campaign: a separate record, or a restart with confirmation. That's for the Tech Lead to choose.
- **Coming back:** after recon, the main button reads **"Continue Three Nights · Night 2 of 3"** when a record exists. `welcome-back` plays here, with its caption (M2).
- **Pause in a campaign:** "Quit to menu" becomes **"Leave this night"**, with the small line "Nothing is recorded. The night waits for you." That makes the "no guilt" rule visible.
- **"Forget this campaign"** asks for confirmation in words ("Forget all three nights on this map? This can't be undone."). It is never one tap, which matters on touch.

**S11. Fairness on touch.** The balance bands come from a bot with perfect aim. Hard night three is already at about 25% for that bot. Thumbs on a tablet are not a mouse. Before release, someone plays the **Gentle and Standard finales on a tablet with the 3.11 controls**, and the owner's own tablet playtest counts. If Gentle's finale isn't comfortably winnable on touch, raise it with the Balance Analyst before release rather than after.

**S12. Tone: one existing kill line contradicts the spec's pillar 5 claim.** `KILL_LINES` in `src/game/game.ts` includes "Neighbourhood watch, upgraded." The campaign makes it play more often, and the spec says the name was avoided because it's a real organisation. Hand it to the Story Writer for a swap. It's text only, not a recording.

### Ideas

- **I1. A dawn beat.** When the hold clock hits zero, show "DAWN" in the HUD and cold guns for about 2 s, then the result card. The last zombie standing at 0:00 becomes a moment instead of a cut. It's not a flash, and it works without the dawn fade.
- **I2. Show which caption is live.** Add a small marker on the line Ground is speaking right now, so a player with the sound off can match a caption to the moment.
- **I3. A "Larger text" setting** (HUD and captions at 18 px) for tablets held at arm's length and for phones.
- **I4. Finale timer wording:** "DAWN 4:30" instead of "HOLD 4:30" on night three only. It's the same number with more story, and no extra words.
- **I5. The tally shows each grade as a letter and a word** ("B · solid"), so it never relies on the grade colour.

### Checklist summary
| Area | Finding |
|---|---|
| Enter, leave, progress | Good bones (cards up front, identical replay, keep best). Needs the campaign result flow (M1), worded card states (S9), continue/leave/forget wording (S10) and one "best" (S8). |
| Finale pacing and readability | Short-long-long, with a lighter opening, is right. The last push needs a visible tell, a lull and arrival timing (S3), a heat-clutter check (S4) and straggler markers (S5). |
| Captions | Every line has text, but off-HUD screens have no caption surface (M2). Start-of-mission jam (S1), minimum read time (S2). |
| Reduced motion / flicker | No new full-screen effects proposed, which is good. New screens must follow the setting, and the ending must be player-paced (M5). |
| Photosensitivity | Existing checks are good. They need re-running for unlimited 25 mm and the last push (M4). |
| Text size on phone and tablet | 14 px minimum holds in the CSS. Untested at tablet sizes with touch controls; captions are under the thumbs (M3). |
| Losing feels fair | Mostly yes (identical replay, no lives, no guilt). Make the loss card explain itself (S6), make retry quick (S7), and test the finale on touch (S11). |
| Sound alone | `night-lost`'s prompt and the last push both need visible equivalents (M1, S3). Everything else already has text. |

**Verdict: APPROVED WITH CHANGES.** M1–M5 must be in the build, and `/playtest` should confirm them, before the campaign merges. The S items should land in the same build where they're cheap (S1, S2, S5, S7, S8, S9, S10 are mostly wording and layout). Otherwise they go on the backlog before the human playtest, because S3, S6 and S11 directly affect the "did night three feel like a finale?" question.

---
## Technical design  *(tech-lead, 21 Nov 2026)*

**Checked against:** `feat/phase-3` at `eae6ed3`, including the 3.6 merge and the 27 recorded lines. I read `src/sim/missions.ts`, `sim.ts`, `score.ts`, `setup.ts`, `src/ui/bests.ts`, `recon.ts`, `menu.ts`, `src/game/game.ts`, `src/main.ts`, `src/audio/voice.ts`, `assets.ts` and `engine.ts`, plus the diffs on `feat/3.11-controls`, `feat/3.12-place-cache` and `feat/3.6-recorded-audio`. `npm run typecheck` is clean. On `npm test`, the only failures were timeouts and the 4 ms step budget, under a load average of about 20 from other agents; `eae6ed3` has since raised two of those time limits. I also ran two headless probes against the real sim (numbers under "Finale" below).

**Summary.** Most of the campaign can be built from pure functions over things the code already has: `generateMission`, `templateAnchors`, `gradeMission`, the seeded RNG and the wave kinds. Two pieces are genuinely new. (1) **The finale's wave schedule.** It can't be a parameter tweak, because waves spawned in the last 60 to 90 s of today's Hold never reach the doors (measured below). (2) **The campaign result flow** inside `Game`. Everything else is new files with no shared code to conflict with.

### 1. Where it lives

| Path | New or changed | What | Layer / merge order |
|---|---|---|---|
| `src/sim/campaign.ts` | **new** | `nightSeed`, `nightDifficulty`, preference and substitute lists, `planCampaign()` (resolves all three nights), `missionFingerprint()`, `mapFingerprint()`, and the record reducer `applyRun()` with `betterRun()` | Pure. No DOM, storage or clock. |
| `src/sim/campaignText.ts` | **new** | Line ids and their caption text (the transcripts table, feel M2), `cardLines` / `startLines` / `endLines` choosers, `previouslyOn()`, `tally()`, and `resultActions()`, which decides the result card's buttons (feel M1) as data | Pure |
| `src/sim/missions.ts` | changed | `MissionOptions.finale?: boolean`, `WavePlan.schedule?: WaveSlot[]`, `finaleSchedule()`, and a branch in `buildDefend` when `finale` is set. **Nothing changes when `finale` is absent.** | Pure |
| `src/sim/sim.ts` | changed | A new private `updateSchedule(dt)`, used only when `mission.waves.schedule` exists. The `wave` event gains an optional `push?: true`. **`updateWaves` is untouched.** | Pure. 3.11 also changes `sim.ts`, but only the weapons part, so the two don't overlap. |
| `src/ui/campaignStore.ts` | **new** | Storage on the device: injected `KeyValueStore` (same pattern as `Bests`), validation, size cap, forget. Imports types only from `src/sim`. | Browser |
| `src/ui/campaign.ts` | **new** | The campaign screen (difficulty choice, three night cards, Forget with confirmation), the tally screen, and card captions. Maps `resultActions()` to callbacks. | DOM |
| `src/ui/recon.ts`, `src/ui/menu.ts` | changed (small) | An optional `onCampaign` handler, plus a "Fly Three Nights" / "Continue Three Nights · Night 2 of 3" block above "Suggested missions". `menu.ts` passes it through. | **After 3.12**, which reworks both files. This adds one handler and one block. |
| `src/main.ts` | changed | `campaign(map, S)` and `playNight(ctx, n)`, beside `play()`. URL hooks for playtests (§7). | |
| `src/game/game.ts` | changed (small) | One optional `GameOptions.night?: NightHooks` (below). With it set: the briefing kicker comes from the hook, the opening radio lines are said before "cleared hot", the result card is drawn from a view model (no single-mission best), and the pause button reads "Leave this night". **No other paths change.** | **After 3.11**, which changes keys and the Esc pause in the same file |
| `src/audio/assets.ts`, `voice.ts`, `engine.ts` | changed | Register the section A and B ids with `RULES`. Add a separate `CAMPAIGN_VOICE` list that is requested when the campaign screen opens, **not** in the unlock-time `bank.request(VOICE_LINES…)`. Add `VoiceDirector` support for opening lines. | 3.6 is merged. Do this last (step 6). |
| Not touched | | `src/render`, `src/world`, `agentsView`, `effects`, `briefingDiorama`, `tutorial*` (3.7, 3.9 and 3.10 territory) | |

```ts
// src/game/game.ts: the whole campaign surface inside Game
export interface NightHooks {
  kicker: string;                         // "NIGHT 2 OF 3 · THE LONG WAY HOME · DIFFICULTY 3"
  openingLines: CaptionedLine[];          // said in order before "cleared hot" (S1: at most one line)
  leaveLabel: string;                     // "Leave this night"
  /** Called once when the sim ends. Records the run and returns the card to show. No bests() write. */
  onEnd(state: SimState, score: Score): ResultView;
}
export interface ResultView {
  kicker: string; bestLine: string; note?: string;          // "Night one stays won · best B"
  lines: CaptionedLine[];                                    // Ground's end lines, captioned on the card (M2)
  buttons: { label: string; key?: 'r' | 'n'; primary?: boolean; run(): void }[];  // keys map only to buttons that exist
}
```

**Layering: no violation.** `src/sim/campaign*.ts` import only `src/map/*` (recon, types), `src/util/rng` and `src/sim/*`. `betterRun` is written in `campaign.ts` using `rank()` from `score.ts`. It must **not** import `isBetter` from `src/ui/bests.ts`, because sim must never depend on ui. Add `tests/layering.test.ts` (§7). It doesn't exist today.

### 2. Data flow

```
recon screen ── S (start.seed; seedForPlace(place) for a scouted place) ──▶ campaign screen
                                                                     │ B chosen (1|2|3)
                     planCampaign(map, graph, grid, S, B)  ◀─────────┘  (pure, once per map+S+B)
                       for n in 1..3: seed = hashString(`campaign|${S}|${n}`), d = B+n−1
                       prefs → templateAnchors(map, id, seed) minus used anchors, ≤3 each → generateMission
                       → substitutes → NightPlan{ options, mission, template, anchorId, fp, hadCold }
                       all three nights or { ok:false, reason } (generator's own words)
                                     │
campaignStore.get(placeKey, B) ──▶ reconcile(plan, record): drop any night whose fp ≠ plan fp, and every night after it
                                     │
night card ─ cardLines() captions + audio.say ─▶ createSim(map, night.options) ─▶ Game{ night hooks }
                                     │                                  │ sim ends
                                     │        onEnd(state, score) ─▶ applyRun(record, n, fp, run)  (pure)
                                     │                                  └▶ campaignStore.put()   (ui)
                                     ▼
                  tally(plan, record) ─▶ tally screen (textContent only)
```

**What's stored, and what isn't (a change to campaign.md §6).** The record holds **numbers only**: per night `{ fp, tries, best?: { grade, time, survivorsTotal, survivorsSaved, friendlyHits, kills, integrity } }`. No anchor names, street names, coordinates or `map.name`. Names for previously-on and the tally come from the **re-resolved plan**, which is identical by determinism. So the text is true by construction, and the device holds no street names. `fp = missionFingerprint(mission)`, a hash of type, template, anchor id, seed, difficulty, time limit, rounded safehouse and home centres, and survivor count. It detects a map that changed under a saved campaign. That can happen through a 3.12 "Refresh", or through 3.12 renaming `map.name`, which feeds the generator's RNG.

- **Storage key:** `spooky.campaign.v1` → `{ [placeKey]: { updated, levels: { [B]: { nights: [...] } } } }`, where `placeKey = \`${S}:${mapFingerprint(map)}\``. `mapFingerprint` hashes `half`, the building, road and feature counts, and the first road's first point rounded to 1 m. The sample town and a loaded file can both have S = 1, so `S` alone isn't unique.
- **One record per difficulty** (answers feel S10). Changing B starts a separate campaign, and the old one stays. "Forget this campaign" removes **every B** for this place, after a worded confirmation.
- **Best run:** `betterRun(a, b)` compares grade, then time; a tie keeps the old run. Only won runs are stored as `best`. A loss only increments `tries` and **never removes a win**. Night n is open when n = 1 or night n−1 has a `best`. `tries === 0` gates `n*-open`. `first-cold` comes from the plan (`hadCold` per night), so it needs no storage.
- **Single-mission bests:** campaign nights **never** write `bests()` (feel S8). The night-three finale is a different mission from single-mission Hold, so writing it would corrupt that record.

### 3. Seeds and determinism

- **Seeds per night:** `nightSeed(S, n) = hashString(\`campaign|${S}|${n}\`)`. B is not in the seed, as campaign.md specifies. The generator and Sim mix in `map.name`, type, template, anchor and d as they do today. A lost night replays `createSim(map, night.options)`, with the same options object, so "Same streets, same dead" is literally true (pinned in §7).
- **No unseeded randomness and no clock in `src/sim`.** The finale schedule uses its own stream, `mulberry32(hashString(\`finale|${map.name}|${seed}|${template}|${anchor}|${d}\`))`. The defend mission's main RNG stream is therefore unchanged: night three has the **same safehouse and stragglers** as the single-mission Hold with that seed, plus a longer hold and a different schedule. `Date.now()` appears only in `campaignStore` (the `updated` field, used to trim old places). Nothing in mission logic reads it.
- **Frame rate:** scheduled slots fire when sim time `t ≥ at`. They don't count frames. `Game` steps the sim at a fixed 1/60 s, so a slot fires within one step of its time. The test runs the same schedule at 1/30 s and 1/60 s and gets the same slots in the same order.
- **One risk to note, not blocking:** the generator hashes `map.name`. When 3.12 lands, scouted maps are renamed to the suburb label, so their missions change once. The fp check catches that, and a campaign saved before the rename resets with a one-line notice (§5).

### 4. Finale: night three (amendment 1) as data

**Measured on the sample town** (headless, no gunner, integrity pinned at 1 so the doors never fall):
- Today's Hold spawns waves whose first zombie reaches the doors **70 to 160 s after spawning**. Over seeds 1–3 at d3–d5, 2 to 4 of the 8 or 9 waves that actually spawned **never reached the doors before dawn**. The Game Director's "fizzle" was right.
- A big wave spawned 130–160 m away *by walking distance* (flow field × 3 m) arrives as follows: **lead zombie 67–95 s, median 78–114 s** after spawning. That's an effective lead pace of 1.6–2.05 m/s and a median pace of 1.3–1.8 m/s at d3–d5. Every zombie arrived. The band holds 9–10 road nodes on the sample town.

**The plan is data on the mission.** `WavePlan.schedule` holds every wave's time, kind and size. The Sim follows it, and it's exactly what the test inspects.

```ts
export interface WaveSlot {
  at: number;            // sim seconds
  kind: WaveKind;
  size: number;          // multiplier on WavePlan.size (WAVE_KINDS[kind].size already folded in)
  push?: true;           // the last push: ignores maxAlive, spawns at `from`
  from?: V2[];           // push only: spawn points in seeded preference order, walking distance in band
}
// WavePlan.kinds = schedule.map(s => s.kind), so waveIntel, the tactical map and `big-expected` keep working unchanged.
```

**Starting numbers (the Balance Analyst tunes the constants, and the tests pin the outcomes):**

| Part | Rule (constants in one `FINALE` table in `missions.ts`) |
|---|---|
| Hold | `FINALE.hold = 270` s at every d (3–5) |
| Opening, t < 60 s | Waves every `every × 1.3`, size × 0.6, kinds `standard`/`rush` only. The stragglers walk in during this part, as they do today. |
| Build | Seeded kinds (`standard`, `rush`, `cold` where cold exists, **no `big`**). Size ramps from 0.8 to 1.0, waves every `every`. |
| Lull | No slot in the `FINALE.lull = 12` s before the push (feel S3) |
| Last push | Kind `big`, size 1.7, `push: true`. `from` = up to 3 road nodes with walking distance 110–170 m, clear of `noWaveSpawn`. Spawns at `pushAt = hold − FINALE.arriveLeft − ⌈path / FINALE.leadPace⌉`, with `arriveLeft = 35` s and `leadPace = 1.6` m/s. On the sample town that puts it at roughly t = 130 s: "Big group inbound from the north-east" with about 140 s to go, and the doors hit with 35–55 s left. |
| After the push | `rush` slots only, and only while they can still arrive (`at ≤ hold − 100`, tunable) |

**Sim rules for a schedule.** Slots spawn in order. A slot that can't spawn (`alive ≥ maxAlive`, or no spawn candidates) retries every 1 s, and the slots after it wait behind it. Nothing is ever dropped, so the intel stays true. The push ignores `maxAlive` and goes ahead of any waiting slots when its time comes. It spawns at the first `from` point that isn't within `MIN_SPAWN_GAP` of an active straggler, or failing that at the last one. At d5 the most alive at once is `maxAlive + push` = 205 + 44 ≈ 250, a quarter of the 1,000-zombie budget.

**When the push can't arrive, the generator says so.** If no road node has a walking distance in the band (widening to 90–220 m once), or if `pushAt < 60`, `buildDefend` returns `ok:false` with a reason. The campaign resolver then moves to the next anchor or template, ending with `classic-clear`. **A finale is never built with a push that can't reach the doors.**

**Single missions stay identical.** Step 1 adds a committed fingerprint for single-mission defend, beside the existing escort fingerprint `be9b7fe7`, **before** `missions.ts` or `sim.ts` change. It also adds a Sim trace hash (state after 1,800 steps, no input). Both must still pass after steps 2–6.

### 5. Failure modes for external inputs

| Input | Missing | Malformed | Huge |
|---|---|---|---|
| **OSM map** (scouted, cached by 3.12, or a file) | No place kinds: the preference lists fall through to the classic templates. If a night still can't be built: substitutes (campaign.md §5). If **any** night has no mission at all: no campaign, shown with that night's generator reason, plus the single missions. A campaign is three nights or none; there's no two-night version. | Names are untrusted: `textContent` only, CSS `overflow-wrap:anywhere` (feel M3). Names never reach storage (§2). `featureName` never emits a house number. | `menu.ts` already caps maps at 6,000 buildings. Planning makes at most 3 attempts per template, **≤ 30 `generateMission` calls in the worst case** (pinned by a counter, not a timer). It runs once per map+S+B and is memoised by the campaign screen, never by the recon screen. Show "Planning three nights…" after a paint. |
| **Saved campaign** (localStorage) | Blocked or unavailable: in memory for the session, with one line: "This browser won't keep campaign progress." | Corrupt JSON, wrong `v`, or a bad field: that place's entry is ignored and rebuilt fresh, and the app never throws. Field validation follows `Bests.valid`. **fp mismatch** (the map changed since): that night and every later one are reset, with "The streets have changed since you last flew here, so these nights start fresh." | At most 20 places, oldest `updated` trimmed first. About 150 bytes per night, so under 30 KB in total. A quota error keeps the record in memory, with the same line as "blocked". |
| **Voice files** | 3.6's loader already falls back to text only. Captions never depend on audio (M2). | Same as missing | 27 files, about 1.3 MB. They're **lazy**: requested when the campaign screen opens, not on the first click for every player. |
| **Network** | Nothing new. No new hosts. | | |

### 6. Performance (QUALITY §2)

- **Sim step, 1,000 zombies, < 4 ms:** unchanged per step. The finale peaks at about 250 alive. The schedule check costs O(1) per step, and the push's spawn points are found at generation time, not in the Sim. The finale runs 270 s instead of 225 s, so whole-mission tests and `/balance` get about 20% longer.
- **Draw calls < 150, JS < 400 KB gz:** no new meshes. The new UI and sim code is an estimated 25–30 KB raw, about 8 KB gzipped.
- **Planning time (no budget exists yet; I propose ≤ 1 s on a full 1.2 km map):** the probe measured about 10 ms per `generateMission` on the sample town under heavy load. A typical plan makes 3–8 calls, so 0.1–0.8 s on a real map. The worst case is 30 calls, about 2–3 s on a real map, behind the "Planning…" status. `/playtest` records it, and if it's over budget the fix is to stop at the first `ok` per template (already the rule) and drop to 2 attempts per template.
- **Map download + build < 15 s:** unaffected.
- **Flashes ≤ 3/s:** no new effects, but feel M4's last-push scenario must be run (§7).

### 7. Test plan (failing first)

**Unit and simulation (Node, `npm test`):**

| File | Test (name it this) |
|---|---|
| `tests/sim.test.ts` | `committed fingerprint: sample-town defend d3 seed 42 has not changed`, and `a single-mission defend plays identically (trace hash)`. **Added first and green**, so they lock single missions before anything changes. |
| `tests/campaign.test.ts` | `night difficulty rises every night and never passes 5` (B 1..3) · `night seeds are hashString(campaign|S|n)` · `planning is deterministic: same map+S+B gives deep-equal plans` · `a replayed night is the identical Mission and the identical SimState after 600 steps` · `all three nights resolve on the sample town at B 1..3` · `no anchor is used twice` · `no preference or substitute list holds a template anchored on a child category, and every resolved anchor passes nearChildPlace === false` · `night two always has survivors (substitutes too)` · `roads-and-houses map plays three classic nights` · `a map with no connected roads has no campaign and gives the generator's reason` · `planning makes at most 30 generateMission calls` · `first-cold is chosen iff this night hadCold and no earlier night did (B 1..3)` · `big-expected is chosen iff waves.kinds includes big, and always on a finale night three` |
| `tests/campaign.test.ts` (reducer) | `a win is stored as best; a better replay replaces it; a worse one doesn't` · `a loss increments tries and never removes a win` · `night n opens only after night n−1 is won` · `an fp mismatch resets that night and every later one` |
| `tests/campaignText.test.ts` | `previously-on and tally numbers equal the stored fields` (snapshot from a scripted three-night bot run) · `"none in three nights" iff the friendly-hit sum is 0` · `pluralises 1 survivor / 2 survivors` · `no campaign text contains map.name` (map named "12, Example Street") · `every voiced line id has slot-free caption text (no "{", no digits)` · `result actions: lost → replay (R) + back, with no next and no N; first win → next (N) + replay + back; night-three win → tally only; a lost replay of a won night says "stays won · best X"` |
| `tests/finale.test.ts` | `finale schedule invariants, d3..5 × seeds 1..20`: hold 270; sorted; exactly one `push`, of kind big; no other slot in the 12 s before it; the opening 60 s spawns ≤ 0.7× single Hold's opening; `kinds` includes big; `waveIntel` names a big wave · `the last push reaches the doors, unopposed, with 25–60 s left, and at least half its zombies arrive before dawn` (integrity pinned to 1 each step, zombies tracked by id range) · `push spawn points avoid noWaveSpawn and active stragglers` · `same slots at dt 1/30 and 1/60` · `a capable bot can win the finale at d3 on some seed; doing nothing loses` (G6) · `a finale whose push can't arrive is rejected with a reason` (synthetic map with the safehouse cut off beyond 280 m) |
| `tests/campaignStore.test.ts` | `round-trips through a fake store` · `corrupt JSON or wrong version starts fresh without throwing` · `blocked or full storage keeps progress in memory` · `keeps at most 20 places, oldest first out` · `forget removes every difficulty for the place` · `the stored JSON contains no feature names, street names, coordinates or map.name` |
| `tests/layering.test.ts` | `src/sim and src/map import neither three nor the DOM, and src/sim has no Math.random or Date` (scans the source text) |
| `tests/recordedAudio.test.ts` | Step 6 removes the 19 section A and B ids from `AWAITING_CAMPAIGN`. The 8 section C ids stay until their own backlog item. **Fix the test's comment** ("spec 001's build must empty this list"), because spec 001 rules section C out. That's a separate commit, named in the PR (hard rule 8). It isn't a weakening. |
| `tests/balance/balance.test.ts` | Add `finale` rows (BALANCE=1) for d3–5. `/balance` gate: finale bot win rate ≥ single Hold at the same d; d5 within 25–60%; median length 4–5 min; **measured on top of 3.11's unlimited 25 mm**. |

**Playtest scenarios (`/playtest`, `scripts/playtest.mjs`):** URL hooks `?screen=campaign&level=2` (sample town) and `?map=sample&campaign=2&night=3&autostart=1&bot=1`, plus a test-only `__spooky.campaignSeed(record)` that loads a stored record so the tally can be screenshotted. Scenarios: campaign screen → fly night 1 with the bot → win card → night 2 card; lose a night → only the replay and back actions are shown, and N does nothing; the tally screen; all at feel M3's four viewports; feel M4's two flash scenarios (25 mm held 10 s; the last push at the doors in night vision); feel S4's heat-clutter screenshots at t ≈ 240 s. No console errors (G7).

### 8. Smallest first step

**Commit 1: "Campaign: plan three nights, headless."** It adds `src/sim/campaign.ts` (`nightSeed`, `nightDifficulty`, the preference and substitute lists, `planCampaign`, `missionFingerprint`; night three is **plain defend** for now), `tests/campaign.test.ts` (the planning, determinism, replay-identical, guardrail and substitute tests above), the defend fingerprint and trace hash in `tests/sim.test.ts`, and `tests/layering.test.ts`. No UI, storage or game changes, and it conflicts with no in-flight branch. Write the tests first and watch them fail on the missing module. The commit proves that three deterministic, guardrail-clean nights come out of every map we have, and that a replay is the same mission.

**Then:** **2.** The finale schedule in `missions.ts` and `sim.ts`, with `tests/finale.test.ts`, then `/balance`, **after 3.11 merges**. **3.** `applyRun` and `campaignStore`. **4.** `campaignText` (lines, previously-on, tally, result actions). **5.** UI: `campaign.ts`, the recon/menu block **after 3.12**, the `Game.night` hooks **after 3.11**, and `main.ts`. Lines are text-only captions at this point. **6.** Voice: register the A and B ids, lazy `CAMPAIGN_VOICE`, `VoiceDirector` opening lines, shrink `AWAITING_CAMPAIGN`.

### 9. Notes for other roles
- **Story Writer:** `big-expected`'s voiced text says "105". The audio director held it back, and it stays text-only until it's reworded and recorded. The opener lines move to the night card if feel S1 is accepted. `campaignText` keeps that placement as data (`cardLines` vs `startLines`), so either choice is a one-line change.
- **3.12 owner:** the campaign takes `S` from the recon screen's `start.seed`. For a scouted place that should be `seedForPlace(place)`. Today `menu.ts` passes the custom form's seed (default 1). If 3.12 doesn't make that change, step 5 does it in one line in `scoutPlace`. Identity doesn't depend on it, because `mapFingerprint` keeps places apart.
- **Map Checker:** `maps/fixtures/` is empty, so "every map fixture" (G5) means the sample town plus the synthetic variants in `tests/campaign.test.ts`, until real fixtures are added.
- **Feel review:** this design takes M1 (the `resultActions` view model), M2 (one caption table, card captions), S3 (lull, push tell via the existing `big` wave call plus `push: true`), S7 (`previously` once per session per card), S8 (per-night best only) and S10 (one record per B, worded Forget).

### Verdict: **APPROVED WITH CHANGES**

Build it as designed above, with these changes:
1. **The stored record holds numbers only.** Names come from the re-resolved plan, and an fp check resets a night if the map has changed. This replaces the name fields in campaign.md §6.
2. **The finale's waves are an explicit `WavePlan.schedule`,** with a guaranteed push that is placed and timed by walking distance. The generator **rejects** a finale whose push can't arrive, and the resolver falls through to the next option. Single-mission defend is locked by a fingerprint and a trace hash **before** any change.
3. **Three nights or no campaign.**
4. **One record per difficulty.** "Forget" clears every difficulty for the place.
5. **Campaign nights never write `bests()`.**
6. **`Game` gets one optional `night` hook and a view-model result card.** Build it after 3.11. Change recon and menu after 3.12. Don't touch render, world, diorama or tutorial.
7. **Campaign voice files load lazily.** Section C ids stay in `AWAITING_CAMPAIGN`, and the test's comment is corrected in its own commit.
8. **Add `tests/layering.test.ts`.**
