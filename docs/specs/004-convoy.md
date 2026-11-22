# 004 — Convoy: keep the trucks rolling down your main road

*Status: approved, awaiting /plan* · *Owner: Game Director* · *Date: 22 Nov 2026*

**Mode: REDUCE.** The owner asked: "Cover mode? Protect a military convoy." I'm building the smallest version that tests whether a convoy plays differently from Escort. That means one recon template: 3–5 fictional ground-team trucks drive in on one main road and out on another, they **stop for anything on the road ahead**, and they lose health while they're stopped. There are no new guns or enemies, the trucks don't shoot back, the player can't choose the route, and there's no pickup stop. **It's an Escort variant, not a fourth mission type.** **Likely class C:** it's a new mission variant, and the look of the vehicles and the "military" framing are taste calls. Run `npm run -s classify` to confirm. It needs the owner's yes before `/build`. *(Working title: the Story Writer names it, see open question 4.)*

## Goal
Give the player a mission where the job is **keeping the road ahead clear**, not keeping a group safe. The trucks can't leave the road. They take the main roads of the player's own suburb and stop dead when the road is blocked. The gunner works 100–200 m ahead of the lead truck, with a 105 that's dangerous to use near them.

## Player story
"As the gunner, when Ground's three trucks turn off the highway onto my high street, I want to see the cold smudge standing in the road two blocks ahead and clear it before the lead truck gets there, so that the convoy never stops and every truck makes it out past the station."

## The idea at its strongest
Escort is about people on foot. They spread out, they can be grabbed from any side, and the player works **around** the group. A convoy turns that inside out:
- **Rails, not a crowd.** Trucks drive on real main roads (OSM `highway` = trunk, primary, secondary, tertiary). Their path is fixed and known, so the threat is **ahead**, at a place you can read on the map ("they'll reach the Smith Street lights in 40 seconds").
- **Stopping is the danger.** A moving truck is mostly safe. A stopped truck is a target. Every zombie on the road ahead is a cost in time first and in health second. This rewards reading the picture early (pillar 3) over reacting late.
- **The big gun is double-edged.** The 105 is the best way to clear a crowd blocking the road, and it's **danger close** near the trucks. You use it far ahead and the 25 mm close in. That's a real decision Escort doesn't make you take this sharply.
- **It shows off the map.** The route is your suburb's arterial roads, from the edge of the map and back out. The briefing names them, and the tactical map draws them.
- **The people are still the point (pillar 2).** The trucks are Ground's own team. "Ground" has been the voice in every briefing, and now the player covers them. In the end, the convoy is carrying people out (see open question 1).

## Why REDUCE, not EXPAND, HOLD or CUT
- **Not CUT.** It's the owner's request. It adds a mission shape the game lacks (fixed path, forward threat, danger close). It's mostly reuse: Escort's waves, ambushes, friendly-fire rule, road graph and child-place routing.
- **Not HOLD as "a fourth mission type".** The Tech Lead's warning holds, and I checked it. `generateMission` picks `type: 'auto'` with `pick(rng, MISSION_TYPES)` (`src/sim/missions.ts:258`), so adding a fourth entry changes every "auto" mission for every player. A convoy is Escort's goal ("enough of them get out") with a different thing being escorted, so it's `type: 'escort'` plus a convoy plan, offered through a **new recon template**. This is the same pattern as spec 003's `defend` + `crowd`. `MISSION_TYPES`, every fingerprint and the Three Nights plans stay unchanged.
- **Not EXPAND.** The bigger versions are all worth a later pitch, and each one rests on a different assumption: route choice at junctions, a pickup stop at a real landmark, trucks that fire back, dismounted crews, and a convoy night in the campaign. First we find out if "keep it rolling" is fun.

## The mode (outcomes, not code; the Tech Lead designs it, the Balance Analyst picks the numbers)

### 1. The convoy
- **3 to 5 trucks** by difficulty (start at d1–2: 3, d3–4: 4, d5: 5), about 20 m apart, driving one behind the other.
- **Cruise speed** is slow enough that the mission lasts (start at about 5 m/s, 18 km/h). They're driving carefully through a dead town.
- **Slow and stop.** Each truck looks at the road ahead of it. If a zombie is in its **slow zone** (start at 40 m ahead, within the road's width plus a margin), it slows. If one is in its **stop zone** (start at 12 m), it stops. When the zone is clear, it moves off again after a short beat (about 1 s). Following trucks keep their spacing and stop behind a stopped truck. The Balance Analyst may turn "a zombie" into "N zombies" if one straggler stopping the convoy proves too harsh.
- **Health, not lives.** Each truck has health (start at 100). Every zombie in contact with a truck drains it (start at 2 per zombie per second). Zombies can't keep up with a truck moving at cruise speed, so the damage happens almost entirely while it's slowed or stopped. That's the rule the player learns: **keep them moving.**
- **A truck at 0 is out of action, not destroyed.** Tone: "Truck two's dead in the water. Crew are buttoned up, we'll come back for them." It stops for good, and the trucks behind it go around it. No one dies on screen and nothing explodes (photosensitivity, tone).
- **Trucks don't run zombies over** in this version. Zombies block them, which is the whole mechanic. Whether trucks can push through a lone zombie at low speed is open question 3.

### 2. Win and lose
- **Win:** enough trucks reach the exit point. Start with all but one (3 → 2, 4 → 3, 5 → 4). The Balance Analyst sets this.
- **Lose:** too many trucks are out of action for the target to be met, or the time limit runs out, or the friendly-fire limit is reached (Escort's rule, 2 incidents).
- **Time limit:** set so a convoy that's never stopped arrives with a wide margin (start at drive time × 2 + 60 s). The generator checks it. The time limit is a backstop, not the main pressure; the main pressure is truck health.
- **Doing nothing loses** at every difficulty (balance goal G6). The waves and ambushes ahead have to be able to stop the convoy and wear it down.

### 3. Danger close (pillar 3: you can see it before you fire)
- **Friendly fire works as it does now:** a round whose blast reaches a truck is a friendly-fire incident and damages the truck. The 105's reach makes it the gun that triggers this. The 40 mm does too, only closer in, and the 25 mm almost never does.
- **The warning comes before the shot, not after.** When the aim point is within a gun's danger-close distance of any truck, the HUD says **DANGER CLOSE** in text, next to the reticle. The trucks' outline marker changes too, so it's never shown by colour alone. Firing is still allowed; this is the player's call. Feel & Access owns the look.
- **The briefing tells the truth:** "The trucks are armoured but not against a 105. Anything closer than about N m is danger close." N is the real number the sim uses (hard rule 9).

### 4. The route
- **Main roads only.** The route goes from a road node near the map edge on one side to a road node near the edge on another side (at least 90° apart in compass bearing). It uses road classes trunk, primary, secondary and tertiary. Short connectors on smaller roads are allowed only if that's the only way to join two main roads (start at no more than 20% of the route). Motorways are left out (they're often fenced and far from the action).
- **Long enough to matter:** at least about 3 minutes of driving at cruise speed (start at 900–1,500 m, rising with difficulty). If no route qualifies, the template isn't offered on that map, and the generator says why in its own words ("There aren't enough main roads through here for a convoy.").
- **The orbit has to fit.** The whole route sits inside the area the gunship can see and fire on. If the edge nodes are outside the playable orbit, the Tech Lead pulls the start and exit inward.
- **Checkpoints:** three named waypoints along the route (about 25%, 50% and 75%), each labelled with the cross street or the nearest real place (`placeLabel`). They exist for reading, not for the rules: the tactical map, the briefing tour and the radio ("Passing the Banksia Street lights") use them. Names are untrusted map text, so they're shown with `textContent` only.
- **Seeded:** the same map, seed and difficulty always give the same route.

### 5. Guardrails for child places (made stronger, because the gunner fires along the whole route)
- **The route keeps clear of child places** by at least **the 105 floor plus the trucks' contact distance**. Spec 003 put the floor at about 54 m (`MAX_KILL_REACH` + `CHILD_FIRE_CLEARANCE`); this rule adds a few metres for the width of the road and the truck. Today's 50 m Escort gap isn't enough, because here the player shells the zombies that are standing on the route. Escort's gap doesn't change; the convoy uses its own, larger one. A route that can't keep that gap isn't offered. **The gap is never shrunk to make a map fit.**
- **Waves and ambushes** follow the existing Escort spawn guardrails. They also have to keep the same gap along their walk to the route, not only where they spawn. The Tech Lead decides whether the child no-go mask from spec 003 is the way to do it.
- **Test:** with the bot firing every gun across several seeds on the school-heavy town, **no impact of any gun lands within `CHILD_FIRE_CLEARANCE` of a child place.**

### 6. How it looks (pillar 3: the trucks read in every sensor)
- **Thermal:** the engine block at the front of each truck is the hottest thing on the road (white in white-hot, black in black-hot). The cabin is warm, and the tyres and exhaust are warm after driving. A truck that has been stopped a while keeps its hot engine, so you can always tell a stopped truck from a wreck. Each roof carries the **cold ID panel** friendlies already wear (dark in white-hot, light in black-hot), using the same words in the rules of engagement.
- **Night vision:** an **IR strobe on each roof**, the same rate and size as the survivors' strobes (already within the photosensitivity limits). Five trucks mean five strobes. The flash meter checks they don't line up into one bigger flash (offset phases, or a cap on how many show at once).
- **Not cruel, not real:** plain, unmarked trucks with no insignia, unit names, flags or real-army markings. On the radio they're "the trucks", "Ground", "truck two". The Art Director owns the look and keeps it fictional.
- **Size on screen:** a truck is far bigger than a zombie, so the threat is the zombies *around and in front of* it. The art must make sure a zombie standing beside a hot engine still reads as a separate heat shape at normal zoom (a screenshot check).

### 7. HUD and briefing
- **HUD** (text first, with the Escort elements it doesn't need removed):
  - one entry per truck showing health as a number **and** a bar (for example `T1 82`), plus `OUT` when a truck is out of action
  - convoy state **in words**: `ROLLING`, `SLOWING` or `STOPPED · road blocked at {checkpoint or street}`
  - distance to the exit (`EXIT 640 m`), the time, and `FRIENDLY FIRE n/2`
  - `DANGER CLOSE` when the aim point is in range (§3)
  - Put it all clear of the stick, the fire area and the GUN / VIEW / ZOOM buttons at 1280×800. There are **no new controls**: touch play is unchanged.
- **Briefing (always true):** where they come in and where they leave ("in on Princes Highway from the south, out on Station Road to the east"), the main streets on the way, the number of trucks and the target, the stop rule ("They'll stop for anything on the road. A stopped truck is a target."), the danger-close distance, and the existing wave, ambush and cold-blooded intel. The checkpoints the briefing names are the ones the HUD and radio use.
- **Tactical map and briefing tour:** draw the route, the entry and exit arrows, and the three checkpoints. The tour flies the route from entry to exit, pausing on each checkpoint. Wave directions use the existing `likelyWaveDirections`, and they're true.
- **Radio:** a few new **text-only** lines from the Story Writer (rolling, slowing, stopped, truck out of action, checkpoint passed, out the other side). No recordings.

### 8. How it's reached
- **A new recon template** (base `escort`, working id `convoy-main-road`). It's offered on maps that have a qualifying main-road route (§4), and it's anchored on the route, not on a feature. Its weight sits below the anchored Escort templates and above the classic ones, so it shows up without crowding out the place-based missions.
- **Sample town:** it already has primary and secondary roads, so the convoy can be played without scouting.
- **URL hook for tests:** `?template=convoy-main-road&seed=N&difficulty=d&autostart=1&bot=1`, like the existing template hook.
- **Not** in Three Nights (spec 001), Horde Night (spec 003), Training or the landing backdrop. Their plans and fingerprints stay identical.

## Pillars served
1. **It's your place:** strong. The convoy drives your real arterial roads, from the edge of the map and back out. The briefing, the checkpoints and the "stopped at" text all use real street names.
2. **Protect people:** served if the trucks are people, not cargo. That's why they're Ground's own team, and why open question 1 recommends they carry evacuees. Wins and losses count trucks that got out, never kills.
3. **Read the picture:** strong, and it's the core of the mode. The threat is on a known road ahead, so reading early wins. Cold-blooded zombies on warm roads (a dark smudge) are exactly the kind of read this mode rewards. Trucks read in thermal and night vision. Danger close is warned before the shot.
4. **Fair and repeatable:** passes. There's a seeded route and no adaptive difficulty. The generator checks an unopposed run finishes in time. The briefing's route, checkpoints and danger-close distance are the ones the sim uses.
5. **Darkly comic, never cruel:** passes with conditions. The trucks are fictional and unmarked. Nobody dies on screen: a truck out of action is "buttoned up". The jokes are about zombies and traffic ("Somebody tell the dead about give-way rules."). No real army, unit or place is cast as anything but the route.

**Photosensitivity:** the guns are unchanged. The only new risk is several roof strobes in one view, which §6 and the flash meter cover. **No blocking clash.**

## The one assumption
**A convoy that stops for anything on the road ahead, and is only hurt while stopped, makes the player work *ahead* of their charge instead of *around* it, and that difference is enough to feel like a new mission, not "Escort with trucks".**

**What would prove it wrong:**
- **Shot pattern:** in human and bot runs, most kills still happen within about 30 m of the trucks (reacting) rather than ahead of the lead truck along the route (reading). Then the stop rule isn't creating forward pressure, and the slow and stop zones or the cruise speed are wrong.
- **Words:** asked how it differed from getting survivors home, testers say "it's the same, with trucks", or they say the stopping was annoying rather than tense.

## In scope / out of scope
**In:**
- The convoy (§1): 3–5 trucks, slow and stop zones, health, and trucks put out of action without dying on screen
- Win and lose (§2)
- Danger close with a pre-fire warning (§3)
- Main-road routes from edge to edge with three named checkpoints (§4)
- The stronger child-place gap for the route and wave walk-ins (§5)
- The thermal and night-vision look with roof panels and strobes (§6)
- The HUD, briefing, tactical map, tour and text radio (§7)
- The recon template, the sample town and the URL hook (§8)

**Out:**
- A fourth `MISSION_TYPES` entry
- Route choice or rerouting by the player
- Trucks that shoot, ram or carry the player's ammo
- Dismounted crews
- A pickup stop at a landmark
- A convoy night in Three Nights
- New guns or enemy types
- Voice recordings or any spending
- Any change to the classic or anchored Escort, Clear, Hold, Horde Night, Three Nights or Training. **Their fingerprints and trace hashes stay identical.**

## Depends on other work
| Dependency | Effect |
|---|---|
| **3.15 buildings block movement** | Waves come down real streets towards the route. Tune after it lands. |
| **3.11 touch controls** | The tablet test needs them. The convoy adds no controls. |
| **Spec 003's child no-go mask** (if built first) | The natural way to guard wave walk-ins (§5). The Tech Lead decides. |
| **3.10 character models / Art Director** | Truck models with heat zones. A placeholder box with the right heat zones is fine for the balance and assumption test. |

## How we'll know it worked
**Tests (`npm test`):**
- **Determinism:** the same map, seed and difficulty give the same route, checkpoints and trace hash.
- **Nothing else moves:** `MISSION_TYPES` is unchanged. Every existing fingerprint and trace (classic, escort, defend, Clear/002, campaign/001, crowd/003) is unchanged. A `type: 'auto'` mission is identical before and after.
- **Route rules:** at least 80% of the route length is on trunk, primary, secondary or tertiary roads. Entry and exit are near the edge and at least 90° apart. The length is within the band. Every point of the route is at least the convoy gap (§5) from every child place.
- **Guardrail in play:** on the school-heavy town, several seeds, with the bot firing every gun, no impact ever lands within `CHILD_FIRE_CLEARANCE` of a child place.
- **Stop rule:** a zombie placed in the stop zone stops the lead truck, and the trucks behind it stop at their spacing. Clearing it lets them all move off. A truck at cruise speed takes (near) zero damage from a zombie walking alongside it.
- **Winnable:** with no zombies at all, the convoy reaches the exit before the time limit with at least a 50% margin.
- **Intel:** the entry, exit, checkpoints and danger-close distance in the briefing match the sim's values.

**Balance (`/balance`, bot, sample town plus a real-map fixture, 12 seeds or more, each difficulty):**
| Measure | Target |
|---|---|
| Bot win rate by difficulty | inside the Escort bands for the same difficulty (Balance Analyst's table) |
| Doing nothing | loses at every difficulty (G6) |
| Runs where the convoy stops at least once | ≥ 90% (stopping is really the mechanic) |
| Share of the run spent stopped (winning runs) | 10–30% (it hurts, but it's not a traffic jam) |
| Bot kills **ahead of the lead truck** along the route (more than 30 m in front) | ≥ 50% (the assumption, as a number) |
| Friendly-fire incidents per bot run, median | ≤ 0.5 (danger close is avoidable) |

**Playtest (`/playtest`)**, at the URL hook, at desktop and 1280×800:
- Screenshots of the convoy stopped and swarmed in white-hot, black-hot and night vision, at ×1 and ×2: each truck reads as a friendly (panel or strobe), and a zombie beside an engine reads as a separate heat shape.
- **Flash meter:** five trucks' strobes in night vision, plus a 105 danger-close impact. Under 3 flashes a second and under 25% of the screen.
- The `DANGER CLOSE` warning shows when the aim point is in range.
- The HUD is clear of the touch controls at 1280×800, with no console errors.

**Human playtest (the assumption test), the owner plus 3–5 people, no prompting:**
- The question: **"How was this different from getting the survivors home?"** It worked if most answers are about clearing the road ahead or keeping them moving, not "the same, with trucks".
- Also ask: "Did the trucks stopping feel tense or annoying?" It worked if most say tense.
- The Critic re-reviews mission variety, and the score should go up.

## Open questions for the user
1. **What's in the trucks?** You said "military convoy". I recommend **Ground's own trucks, plain and unmarked, carrying evacuees out of town**. It keeps the military look you asked for and keeps the mission about people (pillar 2). It also gives Ground a nice turn, from the voice in your ear to the people you're covering. The alternative is a supply run with crew only. That's fine, but it's colder.
2. **Approve it as an Escort variant through a new recon template, not a fourth mission type?** I recommend yes. A fourth type would change every "auto" mission for everyone, and this way nothing existing changes.
3. **Can a truck push through a lone zombie?** I recommend **no** for the first version. Every zombie on the road stops the convoy, which is the clearest test of the assumption. If testers find one straggler stopping the convoy annoying rather than tense, the Balance Analyst makes it "N zombies or more".
4. **Name:** the Story Writer proposes it. Working title "Convoy". The rule: about the road or the night, never a real unit or army.
5. **Later, if it works:** a pickup stop at a real landmark halfway (a mid-route hold) and a convoy night in Three Nights. I recommend waiting until the human playtest answers question 1 of "How we'll know".

---
## Technical design  *(added by tech-lead)*

## Feel & access  *(added by feel-designer)*

## Owner decision (22 Nov 2026)
Approved with the Game Director's recommendations: Ground's trucks carry evacuees; built as an Escort variant through a template; a single zombie can stop a truck in v1. Queued after Horde Night (003) and the campaign's finale and screens (001).
