# Backlog — what the crew builds next

*Ordered list of work. The crew takes the top unblocked item. You approve new phases; the Game Director keeps this ordered within a phase.*

Status: `todo` · `in-progress` · `waiting-on-you` · `done`

## Phase 1 — playable slice (approved)

| # | Item | Needs checks | Status |
|---|---|---|---|
| 1.1 | Road network (junctions, A* routing, largest connected network) and walk grid (blocked cells, zombie flow field) in `src/map` | review, map-check | todo |
| 1.2 | Mission generator: Clear, Get them home, Hold the safehouse; seeded; briefing text from real names; determinism snapshot test (G4) | review, map-check | todo |
| 1.3 | Headless simulation `src/sim`: zombies (warm and cold-blooded), survivors, weapons with shell flight time, damage, friendly fire, win/lose; plus the bot | review, balance | todo |
| 1.4 | 3D world builder and the 3-value sensor render (heat, visible brightness, near-infrared), with thermal (white/black-hot) and night-vision filters | review, playtest | todo |
| 1.5 | Orbit camera, ground-stabilised aiming, firing, blasts, cooling craters and bodies | review, playtest | todo |
| 1.6 | HUD, menu, briefing and debrief screens, OpenStreetMap credit; `window.__spooky` test hook and URL parameters | review, playtest | todo |
| 1.7 | `scripts/playtest.mjs` (headless browser smoke test) and balance runner; activate gates G4–G8 | review | todo |
| 1.8 | **Phase 1 sign-off:** full `/preflight`, `/balance`, screenshots → **escalate to you to play it** (moving to phase 2 is class C) | all | todo |

## Phase 2 — your neighbourhood (not yet approved)
Address search → download → mission; save/load map files; real-map fixtures; procedural fill for empty areas.
