# Three Nights: the campaign arc

*Story Writer, 21 Nov 2026. Status: **proposal, class C** (a new narrative feature). The owner approved writing it; building it still goes through `/pitch` → `/plan` → `/build`.*

One address, three nights, three sorties. It works on any neighbourhood because every night is built from what recon finds there, and every word Ground says is tied to a field the simulation really has (hard rule 9). Schools, kindergartens, childcare and playgrounds are never part of it (owner decision #11).

Companion documents: `docs/story/radio-script.md` (the lines) and `docs/story/voice.md` (how Ground and Spooky sound).

---

## 1. The arc in one paragraph

**Night one**, the dead turn up somewhere open (the tennis club, the park) and Spooky clears them while two neighbours hide nearby. **Night two**, the people who got stuck out (late shoppers, the last train's passengers) have to walk home through real streets, and the dead have learned to wait for them. Some run cold now. **Night three**, everyone falls back to the one solid building the whole street knows, and Spooky holds it until the dawn patrol arrives. The last line on the radio is Ground telling Spooky it's their turn to go home. The game is called *Spooky at Home*: the campaign ends with the gunship crew, after three nights of getting everyone else home, being sent home themselves.

The through-line is **getting people home**. The running gags are Ground's kettle and the residents' committee's growing list of complaints about the lawns.

---

## 2. Shape

- **One sortie per night, in the order PLAN §4 already sets:** clear → escort → hold. Three missions, roughly 10–15 minutes of play in total.
- **The player picks a campaign difficulty `B`:** *Gentle* (B = 1), *Standard* (B = 2), *Hard* (B = 3). Night `n` runs at difficulty `B + n − 1`, so it always rises and never passes 5.
- **Seeds:** night `n`'s mission seed is `hashString(\`campaign|${S}|${n}\`)`, where `S` is the campaign seed (the usual seed field, or `seedForPlace` for a real address). Same map + `S` + `B` → the same three missions (hard rule 1).
- **A night is won before the next one opens.** A lost night is replayed, and the replay is the identical mission (same seed). No penalty, no guilt and no "while you were away" losses.

---

## 3. Night by night

### Night one: "Lights out" (clear)

| | |
|---|---|
| **Templates, in order of preference** | `clear-tennis` → `clear-park` → `forest-sweep` → `classic-clear` |
| **Why this order** | Tennis courts and parks are flat, open ground: the gentlest place to learn. The forest always brings cold-blooded zombies (`coldHere = min(0.6, coldShare + 0.25)`, so never zero), which would spoil the night-two reveal on Gentle. It's only used if the map has no tennis club or park. |
| **What the player feels** | "So this is what it's like over my street." Discovery, low stakes. |
| **What Ground says** | `n1-open`, then `first-cold` if true (Standard and Hard) or else the template's flavour line, then the existing "cleared hot" line. |
| **Stakes (from the sim)** | Two sheltering friendlies (`mission.survivors.length === 2`); the nearest horde drifts toward them after a grace period. |

### Night two: "The long way home" (escort)

| | |
|---|---|
| **Templates** | `escort-shops` → `escort-station` → `classic-escort` |
| **What the player feels** | Responsibility. Neighbours walking down real streets the player knows. |
| **What changes** | Difficulty +1. **More** people to bring home, not fewer: the sim gives `4 + floor(d/2)` survivors, so the group grows with difficulty. (The brief suggested "fewer survivors"; the sim does the opposite, so the story says "more people stuck out there" instead. Intel stays true.) Waves arrive, ambush ahead of the leader and vary in kind. |
| **The cold reveal** | On Gentle, this is the first night with cold-blooded zombies (`coldShare` is 0 at difficulty 1 and 0.12 at difficulty 2). Ground's `first-cold` line plays **only when the data says so**: this night has cold contacts and no earlier night did. On Standard and Hard they're there from night one, and the line plays then instead. |
| **What Ground says** | On the night card: `previously` with the summary on screen. At sim start: `n2-open`, then `first-cold` if true (otherwise the template flavour), then cleared hot. |

### Night three: "Hold till dawn" (defend)

| | |
|---|---|
| **Templates** | `hold-sports` → `hold-landmark` → `classic-defend` |
| **What the player feels** | Last stand. The shortest night (195–225 s of hold) and the hardest: the biggest, most frequent waves of the campaign. |
| **What changes** | Difficulty +1 again. Waves of `6 + 4d` every `max(7, 20 − 2.6d)` s. Big waves are only mentioned if the plan has one (`waves.kinds.includes('big')`). |
| **The ending** | The defend win reason is already "Safehouse held until dawn patrol arrived." Ground's `dawn-thermal` line, then `n3-close` ("Dawn patrol has the street. Spooky, go home."), then `campaign-thanks` from the residents' committee, then the tally screen (§8). |

---

## 4. What changes between nights (the numbers)

All values come straight from `src/sim/missions.ts`. A builder can read them from the generated `Mission` and never needs to hard-code them; the table is here so the story can be checked against it.

| Night (Gentle, B = 1) | d | Mission | Key numbers | Cold-blooded share (`coldShare`) |
|---|---|---|---|---|
| 1 | 1 | clear | 2 hordes of 9; 270 s (300 s in a forest); 2 friendlies sheltering | 0 (forest: 0.25 for the hordes in the trees) |
| 2 | 2 | escort | 5 survivors, 3 must get home; 360–620 m walk; waves of 9 every 16.8 s; 480 s | 0.12 |
| 3 | 3 | defend | hold 195 s; waves of 18 every 12.2 s; 2 stragglers if a safe route exists | 0.18 |

| Night (Standard, B = 2) | d | Key numbers | `coldShare` |
|---|---|---|---|
| 1 | 2 | clear: 3 hordes of 12; 300 s | 0.12 |
| 2 | 3 | escort: 5 survivors, need 3; waves of 12 every 14.2 s; 510 s | 0.18 |
| 3 | 4 | defend: hold 210 s; waves of 22 every 9.6 s | 0.24 |

| Night (Hard, B = 3) | d | Key numbers | `coldShare` |
|---|---|---|---|
| 1 | 3 | clear: 4 hordes of 15; 330 s | 0.18 |
| 2 | 4 | escort: 6 survivors, need 3; waves of 15 every 11.6 s; 540 s | 0.24 |
| 3 | 5 | defend: hold 225 s; waves of 26 every 7 s | 0.30 |

A wave's cold count is `round(size × share)`: cold waves use 0.75 and rushes 0 (`WAVE_KINDS`). Anything the story says about escalation ("they know we're here now", "bigger tonight") is true because `d` strictly rises night to night for every `B`.

---

## 5. Building a night: templates, anchors and fallbacks

**Resolving a night** (deterministic, done for all three nights when the campaign starts, so the player sees three cards up front):

1. For each template in the night's preference list, take its candidate places from `templateAnchors(map, id, nightSeed)` (already filtered: playable, never near or around a school, kindergarten or playground).
2. Skip any place already used as an earlier night's anchor (same feature id).
3. Call `generateMission(map, graph, grid, { type: base, template, anchor, difficulty, seed: nightSeed })`. Take the first that returns `ok`.
4. Try at most 3 places per template, then move to the next template. The last template is always the classic one, which needs no place at all.

**If a whole night's mission type can't be built** (for example, every way home passes a school, so there's no escort; or zombies can't reach any building, so there's no hold):

| Night | Substitute, in order | Story impact |
|---|---|---|
| 2 (escort) | the unused clear templates (`forest-sweep`, `clear-park`, `clear-tennis`, `classic-clear`) | `n2-open` stays true: a clear mission always has 2 sheltering friendlies, so "people are still stuck out there" holds. Night two never becomes a defend mission, because a defend with no stragglers would make that line false. |
| 3 (defend) | `classic-clear`, then any unused clear template | The ending lines are written to be true for any mission type: `n3-open` and `n3-close` don't mention holding. `dawn-thermal` plays only if the dawn visual exists (see radio script). |
| 1 (clear) | `classic-escort`, then `classic-defend` | Rare: a clear only fails when there's no room for two hordes. |

**If no night can be built at all,** there's no campaign on this map. Show the generator's own reason (it's already in plain English) and offer single missions.

**Map lacks a place kind:** handled by the preference lists above. A map with only roads and houses plays all three nights as classic missions (`classic-clear`, `classic-escort`, `classic-defend`). The story still works because the night lines never name a place kind; only the template flavour lines do, and those play only for their own template.

**Recon kinds with no mission of their own:** sports grounds (`pitch`) only appear in the `hold-sports` "why" line, when one is beside the hall. Swimming pools, car parks and bus routes anchor nothing yet ("Last bus home", backlog 2.6, is the natural future night-two option for bus routes). Schools, kindergartens and playgrounds never anchor anything, and the campaign never adds them to a preference list (test below).

---

## 6. Carry-over: what the game remembers, and "previously on"

Between nights the game keeps a small record of each finished night **on the player's device only** (local storage), keyed by the map's seed (`seedForPlace`), **not** by `map.name`: for an address, the map name is the first two parts of Nominatim's label and can contain a house number. A "Forget this campaign" button clears it.

```
CampaignNightResult {
  night: 1 | 2 | 3
  template: TemplateId
  base: 'clear' | 'escort' | 'defend'
  anchorName?: string        // mission.anchor.name (OSM name or "the tennis club on X Street")
  safehouseName?: string     // mission.safehouse.name
  homeStreet?: string        // mission.home.street (escort only)
  hordeLabels: string[]      // mission.hordes[].label (clear only)
  won: boolean
  survivorsTotal: number     // SimState.survivorsTotal
  survivorsSaved: number     // scoreInput(...).survivorsSaved
  friendlyHits: number
  kills: number
  integrity: number          // 0..1, defend only
  hadCold: boolean           // sum(mission.hordes[].cold) > 0 || (mission.waves?.coldShare ?? 0) > 0
  grade: Grade
}
```

**"Previously on" (on-screen text, shown on the night card; Ground's voiced line is the slot-free `previously`):**

| After | Template (slots in braces) | Truth comes from |
|---|---|---|
| Night 1, clear | `Last night: {Place} cleared, {kills} down, {savedPhrase}.` | `{Place}` = `anchorName`, capitalised, or "the hordes" for `classic-clear`; `{savedPhrase}` = `savedPhrase()` in `src/sim/score.ts` ("both friendlies safe", "1 of 2 friendlies lost"), already tested |
| Night 2, escort | `Last night: {saved} of {total} walked home to a house on {homeStreet}.` | `survivorsSaved`, `survivorsTotal`, `homeStreet`; "all 5" when saved = total |
| Night 2, clear (substitute) | same as night 1 | |

Rule for every template: a number is printed only from a stored field, and a place only from a stored name. "1 survivor" / "2 survivors" is pluralised from the number.

---

## 7. Losing and replaying

- **A lost night is replayed as the identical mission** (same seed, same difficulty). Ground's `night-lost` line ("Not tonight. Same streets, same dead. Go again.") is true *because* the mission is deterministic. Pin it with a test (§9).
- **No downgrade, no skip, no lives.** If the player wants out, they leave the campaign; their record stays on the device until they forget it.
- **Winning with losses is still winning.** `night-won-losses` acknowledges it once, without blame.

---

## 8. The ending

On winning night three, in order:

1. The usual win sting and result screen (reason: the sim's own text).
2. `dawn-thermal`: "Sun's up. The streets are warming. Thermal's going flat." **Only if** the art director adds a short dawn fade, where the thermal contrast drops as the ground warms (real thermal crossover, PLAN §5a). Without that visual, cut the line rather than let it describe something the player can't see.
3. `n3-close`: "Dawn patrol has the street. Spooky, go home."
4. `campaign-thanks`: "Residents' committee says thanks. Also, about the lawns."
5. **The tally screen** (on-screen text only, every slot from the stored records):

```
THREE NIGHTS
Night one   {Place1} cleared. {savedPhrase1}.
Night two   {saved2} of {total2} walked home to {homeStreet2}.
Night three {SafehouseName3} held till dawn, {integrity3}% intact.{ stragglers phrase}
{Friendly fire: none in three nights. | Friendly fire: {n} incidents.}
```

Per-line variants where a night was a substitute come from that night's base type (clear/escort/defend phrasing as in §6). Integrity is `Math.round(integrity * 100)`. "None in three nights" only when the sum of `friendlyHits` across all three stored nights is 0.

---

## 9. Truth pins: tests a builder must add

Each narrative claim, the field that makes it true, and the test that keeps it true.

| Claim | Field | Test |
|---|---|---|
| Difficulty rises every night ("they know we're here now") | `B + n − 1` | For B in 1..3: night difficulties strictly increase and stay ≤ 5 |
| "Same streets, same dead" on replay | seed + determinism | Resolve a night twice: identical `Mission` (deep equal), and identical `SimState` after N steps with no input |
| `first-cold` plays only on the first night with cold-blooded zombies | `hadCold` | Play order across B = 1..3 on the sample town: line chosen iff this night `hadCold` and no earlier night did |
| `forest-open` "running cold" | `coldHere > 0` | Every generated `forest-sweep` mission has at least one horde labelled with the forest whose `cold > 0` |
| `big-expected` | `waves.kinds` | Line chosen iff `kinds.includes('big')` (arrival already pinned by `tests/waves.test.ts`) |
| `n2-open` "people are still stuck out there" | `survivors.length > 0` | Night two, including substitutes, always has survivors |
| No school, kindergarten or playground in the campaign | preference lists + `templateAnchors` | Preference lists contain no template whose anchors include a child category; every resolved night's anchor passes `nearChildPlace === false` (the guardrail test already covers templates) |
| Previously-on and tally numbers | stored records | Snapshot test: a scripted three-night run produces text whose numbers equal the stored fields |
| No address in any line | `map.name` unused | Campaign text never contains `map.name` (test with a map named "12, Example Street") |
| Voice lines carry no slots | radio script | Every recorded line id maps to fixed text with no `{`; on-screen variants may have slots |

---

## 10. Open questions for the owner

1. **Approve the arc** (class C): three nights, clear → escort → hold, campaign difficulty Gentle/Standard/Hard.
2. **Night three is the shortest sortie** (about 3–4 minutes) but the most intense. I think a short, hard finale works; if playtests want it longer, the Tech Lead could add a longer hold for the finale (a balance change, so also class C).
3. **The dawn fade** for the ending (an art-director job). Without it, `dawn-thermal` is cut.
4. **Name:** "Three Nights". (I avoided "Neighbourhood Watch": it's a real organisation.)
