# Backlog — what the crew builds next

*Ordered list of work. The crew takes the top unblocked item. You approve new phases; the Game Director keeps this ordered within a phase.*

Status: `todo` · `in-progress` · `waiting-on-you` · `done`

## Phase 1 — playable slice (approved)

| # | Item | Needs checks | Status |
|---|---|---|---|
| 1.1 | Road network (junctions, A* routing, largest connected network) and walk grid (blocked cells, zombie flow field) in `src/map` | review, map-check | done (PR, in review) |
| 1.2 | Mission generator: Clear, Get them home, Hold the safehouse; seeded; briefing text from real names; determinism snapshot test (G4) | review, map-check | done (PR, in review) |
| 1.3 | Headless simulation `src/sim`: zombies (warm and cold-blooded), survivors, weapons with shell flight time, damage, friendly fire, win/lose; plus the bot | review, balance | done (PR, in review) |
| 1.4 | 3D world builder and the 3-value sensor render (heat, visible brightness, near-infrared), with thermal (white/black-hot) and night-vision filters | review, playtest | done (PR, in review) |
| 1.5 | Orbit camera, ground-stabilised aiming, firing, blasts, cooling craters and bodies | review, playtest | done (PR, in review) |
| 1.6 | HUD, menu, briefing and debrief screens, OpenStreetMap credit; `window.__spooky` test hook and URL parameters | review, playtest | done (PR, in review) |
| 1.7 | `scripts/playtest.mjs` (headless browser smoke test) and balance runner; activate gates G4–G8 | review | done (PR, in review) |
| 1.8 | **Phase 1 sign-off:** full `/preflight`, `/balance`, screenshots → **escalate to you to play it** (moving to phase 2 is class C) | all | waiting-on-you |

### Found during phase 1 (for the owner's playtest)
| # | Item | Status |
|---|---|---|
| 1.9 | **Get them home difficulty curve is flat**: the human-like bot wins 30–50% at every difficulty. Needs your playtest before tuning | waiting-on-you |
| 1.10 | Clear the horde is quick for the bot (21–76 s) because it never has to search; real players will be slower. Re-measure with your playtest | waiting-on-you |
| 1.11 | "Build this place" (address → real map) can't be tested in the cloud container: OpenStreetMap hosts are blocked. Test on your machine, or allow the hosts | waiting-on-you |

## Phase 2 — your neighbourhood (not yet approved)
Address search → download → mission (basic version already in phase 1); real-map fixtures; procedural fill for empty areas. Scout ideas to consider: `docs/ideas/2026-11-21-scout.md`.
