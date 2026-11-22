# Radio script: new Ground lines

*Story Writer, 21 Nov 2026. For the `audio-director` to record within the owner's cap, and for builders to wire to the events named here. Companion to `docs/story/campaign.md` and `docs/story/voice.md`.*

## Rules for every line

- **Recorded lines carry no slots.** No street names, no place names, no numbers. A recorded line has to be true every time it plays (hard rule 9), and real names must never be sent to a voice service: the player's map stays in their browser. Where a moment needs a name or a number, the **on-screen text** (the HUD radio log) carries it, and the voice says the slot-free version.
- On-screen text with slots goes on screen with `textContent` only (hard rule 4). Slots come only from the fields named in the table.
- **Priority:** **P1** interrupts anything and always plays (safety). **P2** is queued and dropped if it can't start within 3 s (mission state). **P3** is flavour, dropped if any line played in the last 4 s.
- **Mission start:** at most one campaign line (night opener), one extra line, then `cleared-hot`. For the extra slot, truth-bearing lines (`first-cold`, `big-expected`) beat the template flavour line. **Mission end:** at most two voiced lines after the sting.
- **No 25 mm reload lines:** the 25 mm has unlimited ammo. The 40 mm and 105 mm still reload; one line covers that (`reload-105`).

---

## New lines (30)

"Words" counts the voiced text. "Record" says whether the audio director should record it now.

### A. The campaign spine

| # | id | Voiced text | Words | On-screen text (slots) | When it plays: event / condition | Pri | Repeats | Record |
|---|---|---|---|---|---|---|---|---|
| 1 | `n1-open` | First night, Spooky. Let's see what we're dealing with. | 9 | same | Campaign night 1, sim start, before `cleared-hot` | P2 | First attempt of the night only | Yes |
| 2 | `n2-open` | Night two. People are still stuck out there. | 8 | same | Campaign night 2, sim start. True because night 2 always has `mission.survivors.length > 0` (campaign §5) | P2 | First attempt only | Yes |
| 3 | `n3-open` | Last night, Spooky. Get through this and we all go home. | 11 | same | Campaign night 3, sim start. Mentions no mission type, so it's true for a substitute too | P2 | First attempt only | Yes |
| 4 | `previously` | Right, Spooky. Where were we. | 5 | Previously-on summary from stored results (campaign §6): `Last night: {saved} of {total} walked home to a house on {homeStreet}.` | Night card for nights 2 and 3 opens | P3 | Once per night card | Yes |
| 5 | `welcome-back` | Welcome back, Spooky. The night's not over. | 7 | `Welcome back, Spooky. Night {n} of 3 is still waiting.` (`n` = first unwon night) | A saved campaign is opened in a new session. Replaces `previously` that time | P3 | Once per session | Yes |
| 6 | `first-cold` | Some of them are running cold tonight. Try night vision. | 10 | same | Sim start, when this night `hadCold` (`Σ hordes[].cold > 0` or `waves.coldShare > 0`) and no earlier night did. Single missions: never (the briefing intel covers it) | P2 | Once per campaign | Yes |
| 7 | `big-expected` | There's a big one coming tonight. Save a 105 for it. | 11 | same | Night 3 sim start, iff `mission.waves.kinds.includes('big')` | P2 | Once per night | Yes |
| 8 | `n1-close` | First night down. They know we're here now. | 8 | same | Night 1 won (`result.won`). True: difficulty rises every night | P3 | Once | Yes |
| 9 | `n2-close` | Night two done. Get some sleep. Well, try. | 8 | same | Night 2 won | P3 | Once | Yes |
| 10 | `dawn-thermal` | Sun's up. The streets are warming. Thermal's going flat. | 9 | same | Night 3 won, during the dawn fade | P3 | Once | **Hold:** only if the dawn fade visual is built (campaign §8) |
| 11 | `n3-close` | Dawn patrol has the street. Spooky, go home. | 8 | same | Night 3 won, after `dawn-thermal` | P2 | Once | Yes |
| 12 | `campaign-thanks` | Residents' committee says thanks. Also, about the lawns. | 8 | same | Tally screen opens. True: by night 3 the player has fired, so there are craters | P3 | Once | Yes |
| 13 | `night-lost` | Not tonight. Same streets, same dead. Go again. | 8 | same | Campaign night lost (`result.won === false`). True because a replay is the identical mission (seed + determinism, pinned by test) | P2 | Every loss (it's the replay prompt) | Yes |
| 14 | `night-won-losses` | Not everyone made it tonight. | 5 | `Not everyone made it tonight: {saved} of {total} safe.` | Any mission won with `survivorsTotal > 0` and `survivorsSaved < survivorsTotal` | P2 | Once per mission | Yes |
| 15 | `night-won-clean` | Everyone safe, nobody singed. Textbook, Spooky. | 6 | same | Any mission won with `survivorsSaved === survivorsTotal` and `friendlyHits === 0` | P3 | Once per mission | Yes |

### B. Template flavour (one per recon mission)

Plays at sim start after the night opener (campaign) or after `cleared-hot` (single missions). The place's real name is already in the briefing and the on-screen title; these lines never name it, so a real place is never the punchline.

| # | id | Voiced text | Words | When: `mission.template` | Pri | Repeats | Record |
|---|---|---|---|---|---|---|---|
| 16 | `tennis-open` | Tennis club's overrun. New balls, please. | 6 | `clear-tennis` | P3 | Once per mission | Yes |
| 17 | `park-open` | Park's shut for the night. Nobody told them. | 8 | `clear-park` | P3 | Once per mission | Yes |
| 18 | `forest-open` | They're in the trees and running cold. Thermal will sulk. | 10 | `forest-sweep`. True: forest hordes always have `cold > 0` (`coldHere ≥ 0.25`), and under trees they match the ground on thermal | P3 | Once per mission | Yes |
| 19 | `shops-open` | Unexpected item in the bagging area. Several, actually. | 8 | `escort-shops` | P3 | Once per mission | Yes |
| 20 | `station-open` | Last service is in. Nobody's meeting them, so we are. | 10 | `escort-station` (train or bus: "service" covers both) | P3 | Once per mission | Yes |
| 21 | `sports-open` | Home game tonight, Spooky. Let's keep a clean sheet. | 9 | `hold-sports` | P3 | Once per mission | Yes |
| 22 | `landmark-open` | Solid walls, neighbours inside. Let's keep tonight boring. | 8 | `hold-landmark` | P3 | Once per mission | Yes |

Classic missions keep the existing `cleared-hot` only.

### C. In-mission moments the current 20 lines don't cover

| # | id | Voiced text | Words | On-screen text (slots) | Trigger (sim event / `SimState` condition) | Pri | Repeats | Record |
|---|---|---|---|---|---|---|---|---|
| 23 | `ff-one-left` | One more of those and they take the guns away. | 10 | same | `friendly-hit` event when `friendlyHits === mission.friendlyFireLimit − 1`; plays right after `check-fire`. True: the next incident ends the mission ("You are relieved of the guns") | P1 | Once per mission | Yes |
| 24 | `need-met` | That's enough home. Now let's get the rest. | 8 | `{survivorsHome} home, {survivorsAlive} still walking.` | Escort: `survivorsHome` reaches `needHome` while `survivorsAlive > 0` (someone still out). True: from here only the clock or friendly fire can fail it | P2 | Once per mission | Yes |
| 25 | `few-left` | Nearly there. The last few are out there somewhere. | 9 | `Nearly there: {zombiesAlive} left.` | Clear: `zombiesAlive` drops to 5 or fewer (and > 0), unless `cold-leftovers` applies | P2 | Once per mission | Yes |
| 26 | `cold-leftovers` | What's left is running cold. Try night vision. | 8 | `{zombiesAlive} left, all cold-blooded.` | Clear: `0 < zombiesAlive ≤ 5` and `coldAlive === zombiesAlive`. Beats `few-left` | P2 | Once per mission | Yes |
| 27 | `one-minute` | One minute left on the clock. | 6 | same | `timeLeft` crosses 60 s while `phase === 'running'` (all three types; in a hold it's good news, and still true) | P2 | Once per mission | Yes |
| 28 | `doors-failing` | Doors won't take much more of that. | 7 | `Safehouse at {round(integrity×100)}%.` | Defend: `integrity` crosses below 0.5 | P2 | Once per mission | Yes |
| 29 | `reload-105` | 105's reloading. The 25 never does. | 6 | same | The 105 is selected and its `reloading` goes from 0 to > 0 while a zombie is within 25 m of a survivor who's still out (`alive && !home`) | P3 | Once per night | **Hold:** only once the unlimited-ammo 25 mm is merged (on `feat/phase-3` the 25 still has a 60-round magazine, so the line would be false there) |
| 30 | `idle` | Spooky, you've gone quiet. Everything all right up there? | 9 | same | No `fire` event for 30 s while `zombiesAlive > 0`. Never in Training night | P3 | Once per mission | Yes |

**Record now: 28 lines. Hold: 2** (`dawn-thermal`, `reload-105`), each waiting on a change that makes it true.

---

## On-screen only (no recording, no credits)

These carry slots, so they are never voiced:
- the previously-on summaries and the three-night tally (`campaign.md` §6 and §8);
- night cards: `Night {n} of 3 · {Lights out | The long way home | Hold till dawn}` above `mission.title`;
- the slot variants listed in the tables above.

---

## Existing recordings: where each fits

The 20 lines in `public/audio/voice/` (filenames are the ids). I can't hear them here, so the audio director should confirm each recording's words are true at its trigger; in particular, that none speaks a number or a place.

| Existing id | Event it suits |
|---|---|
| `cleared-hot` | Sim start (every mission) |
| `check-fire` | `friendly-hit` (P1) |
| `danger-close` | `danger-close` |
| `friendlies-under-attack` | the sim's `radio` event for sheltering friendlies |
| `survivor-lost` | `survivor-lost` |
| `survivor-home-kettle`, `survivor-home-quieter` | `survivor-home`, alternating |
| `survivors-moving` | Escort: the first survivor sets off (`t ≥ survivors[0].delay`) |
| `new-contacts`, `more-coming` | `wave` with `kind: 'standard'`, alternating |
| `rushers` | `wave` with `kind: 'rush'` |
| `cold-blooded` | `wave` with `kind: 'cold'` |
| `big-group` | `wave` with `kind: 'big'` |
| `good-effect`, `splash-residents`, `former-neighbours` | the merged kill call (5+ down in one blast) |
| `safehouse-hits` | Defend: `integrity` falling (first drop) |
| `all-clear` | Clear won |
| `mission-complete`, `mission-failed` | `result` |

---

## Credit estimate

`public/audio/CREDITS.md` records the spend (7,912 credits ≈ US$1.45 for 35 items, so about **US$0.18 per 1,000 credits**) but not a per-character rate. This estimate assumes **1 credit per character**, ElevenLabs' standard text-to-speech rate for its multilingual-class models; the audio director should confirm with `estimate_only` before generating.

| | Lines | Characters | Credits |
|---|---|---|---|
| Record now | 28 | 1,310 | ≈ 1,310 |
| Held (record later) | 2 | 91 | ≈ 90 |
| **All 30, one take each** | 30 | 1,401 | **≈ 1,400** |
| With retakes on a third of them | | | ≈ 1,870 |

At about US$0.25–0.35, that brings the running total from 7,912 to roughly **9,300–9,800 of the 50,000 cap** (under 4% of what's left). The 20 existing lines average 2.8 s; these are similar length, so the whole new set is about 1.5 minutes of audio.

Direction for the session: the same voice as the existing 20 ("Robert - Measured Thriller Narrator"), so Ground sounds like one person. See `docs/story/voice.md` for delivery notes.

---

## Recordings: wiring table (audio director, 21 Nov 2026)

27 lines recorded in Ground's voice ("Robert - Measured Thriller Narrator", `eleven_v4`). Each is mono 44.1 kHz 128 kb/s MP3 at −21 LUFS (spend in `public/audio/CREDITS.md`). They aren't wired yet: `src/audio` belongs to another team right now. The priority and repeat rules are in the tables above; the triggers below are short forms of those.

| id | File | Length | Trigger | Pri |
|---|---|---|---|---|
| `n1-open` | `public/audio/voice/n1-open.mp3` | 3.6 s | Campaign night 1, sim start, before `cleared-hot`; first attempt only | P2 |
| `n2-open` | `public/audio/voice/n2-open.mp3` | 3.6 s | Campaign night 2, sim start; first attempt only | P2 |
| `n3-open` | `public/audio/voice/n3-open.mp3` | 3.8 s | Campaign night 3, sim start; first attempt only | P2 |
| `previously` | `public/audio/voice/previously.mp3` | 2.5 s | Night card for nights 2 and 3 opens (summary text on screen) | P3 |
| `welcome-back` | `public/audio/voice/welcome-back.mp3` | 3.1 s | Saved campaign opened in a new session; replaces `previously` that time | P3 |
| `first-cold` | `public/audio/voice/first-cold.mp3` | 3.2 s | Sim start, first campaign night with `hadCold`; never in single missions | P2 |
| `n1-close` | `public/audio/voice/n1-close.mp3` | 3.0 s | Night 1 won | P3 |
| `n2-close` | `public/audio/voice/n2-close.mp3` | 4.4 s | Night 2 won | P3 |
| `n3-close` | `public/audio/voice/n3-close.mp3` | 3.5 s | Night 3 won (after `dawn-thermal` once that exists) | P2 |
| `campaign-thanks` | `public/audio/voice/campaign-thanks.mp3` | 4.2 s | Campaign tally screen opens | P3 |
| `night-lost` | `public/audio/voice/night-lost.mp3` | 4.0 s | Campaign night lost (`result.won === false`); every loss | P2 |
| `night-won-losses` | `public/audio/voice/night-won-losses.mp3` | 2.4 s | Mission won, `0 < survivorsSaved < survivorsTotal` (count on screen) | P2 |
| `night-won-clean` | `public/audio/voice/night-won-clean.mp3` | 4.0 s | Mission won, all survivors saved and `friendlyHits === 0` | P3 |
| `tennis-open` | `public/audio/voice/tennis-open.mp3` | 2.9 s | Sim start, `mission.template === 'clear-tennis'` | P3 |
| `park-open` | `public/audio/voice/park-open.mp3` | 2.8 s | Sim start, `clear-park` | P3 |
| `forest-open` | `public/audio/voice/forest-open.mp3` | 3.6 s | Sim start, `forest-sweep` | P3 |
| `shops-open` | `public/audio/voice/shops-open.mp3` | 3.7 s | Sim start, `escort-shops` | P3 |
| `station-open` | `public/audio/voice/station-open.mp3` | 3.7 s | Sim start, `escort-station` | P3 |
| `sports-open` | `public/audio/voice/sports-open.mp3` | 3.0 s | Sim start, `hold-sports` | P3 |
| `landmark-open` | `public/audio/voice/landmark-open.mp3` | 4.5 s | Sim start, `hold-landmark` | P3 |
| `ff-one-left` | `public/audio/voice/ff-one-left.mp3` | 2.6 s | `friendly-hit` when `friendlyHits === friendlyFireLimit − 1`, right after `check-fire` | P1 |
| `need-met` | `public/audio/voice/need-met.mp3` | 2.9 s | Escort: `survivorsHome` reaches `needHome` while `survivorsAlive > 0` | P2 |
| `few-left` | `public/audio/voice/few-left.mp3` | 3.3 s | Clear: `0 < zombiesAlive ≤ 5`, unless `cold-leftovers` applies | P2 |
| `cold-leftovers` | `public/audio/voice/cold-leftovers.mp3` | 3.0 s | Clear: `0 < zombiesAlive ≤ 5` and `coldAlive === zombiesAlive` (beats `few-left`) | P2 |
| `one-minute` | `public/audio/voice/one-minute.mp3` | 1.8 s | `timeLeft` crosses 60 s while `phase === 'running'` | P2 |
| `doors-failing` | `public/audio/voice/doors-failing.mp3` | 2.2 s | Defend: `integrity` crosses below 0.5 | P2 |
| `idle` | `public/audio/voice/idle.mp3` | 3.9 s | No `fire` event for 30 s while `zombiesAlive > 0`; never in Training night | P3 |

**Not recorded (no file yet):**
- `dawn-thermal`: held until the dawn fade visual is built.
- `reload-105`: held until the unlimited-ammo 25 mm is merged.
- `big-expected`: marked "Yes" above, but its voiced text says "Save a **105** for it". That's a number, which the recording rule at the top of this file doesn't allow (it's also a pronunciation risk: "one hundred and five" or "one-oh-five"). Story Writer or owner: either confirm the weapon name is fine to voice, or reword it (for example "Save the big gun for it."). It's about 90 credits to record once decided.
