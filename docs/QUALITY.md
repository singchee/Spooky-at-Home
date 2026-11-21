# Quality gates — what "good enough to release" means

*The checks every release must pass, the budgets we hold, and the test hooks that let agents play the game*

## 1. Gates (all must pass for `/release`)

| # | Gate | How it's checked | Active from |
|---|---|---|---|
| G1 | Type check clean | `npm run typecheck` | now |
| G2 | Unit and simulation tests pass | `npm test` | now |
| G3 | Production build succeeds | `npm run build` | now |
| G4 | **Deterministic missions:** same map + seed + settings → identical mission | Snapshot-hash test in `tests/` | phase 1 |
| G5 | **Every mission can be generated:** each type × difficulty 1–5 × every map fixture produces a valid mission (route exists, spawns reachable, safehouse found) | `/map-check` | phase 1 (sample), phase 2 (real fixtures) |
| G6 | **Plays end to end:** a scripted bot can both win and lose each mission type | `/playtest` | phase 1 |
| G7 | No browser console errors during a playtest | `/playtest` | phase 1 |
| G8 | Within performance budgets (§2) | `/playtest` | phase 1 |
| G9 | Code review has no open "blocker" findings | `/review-code` | now |
| G10 | Balance within target bands (§3), or band change approved by you | `/balance` | phase 1, bands set after first playtests |

## 2. Budgets

| Budget | Limit | Why |
|---|---|---|
| Simulation step, 1,000 zombies, headless | < 4 ms | Leaves room for rendering within a 16 ms frame |
| Draw calls, sample town | < 150 | Merged buildings, instanced zombies |
| JavaScript download (gzipped) | < 400 KB | Loads fast on home broadband |
| Map download + build, 1.2 km square | < 15 s | Player patience |
| **Full-screen flashes** | **≤ 3 per second** | Photosensitive epilepsy guideline (WCAG 2.3.1 "Three Flashes"). The 25 mm gun fires 12/s, so its flashes must stay local, never full-screen |
| Smallest on-screen text | 14 px | Readability |

## 3. Balance target bands (provisional; set after phase 1 playtests)

| Measure | Difficulty 1 | Difficulty 5 |
|---|---|---|
| Bot win rate | 85–100% | 25–60% |
| Median mission length | 2–5 min | 4–8 min |
| Survivors lost when won (escort) | ≤ 1 | ≤ half |
| Time in most-used camera (human playtest) | < 80% | < 80% |

The bot is a floor, not a player model: it aims perfectly and has no sense of fun. Bands guide tuning; they are not the goal.

## 4. Network allow-list

Only these hosts may be contacted by the game:
- `overpass-api.de`, `overpass.kumi.systems`: OpenStreetMap features
- `nominatim.openstreetmap.org`: address search (max 1 request/second)
- `s3.amazonaws.com/elevation-tiles-prod`: terrain (phase 4)

## 5. Test hooks (the contract that lets agents play)

Phase 1 must provide:

**Headless simulation** (`src/sim/`), runnable in Node with no three.js:
```ts
createSim(map: MapData, opts: { type, difficulty, seed }): Sim
sim.step(dtSeconds): void
sim.fire(weaponId, target: V2): void
sim.setSensor(id): void
sim.state(): { phase, time, result, zombiesAlive, survivorsAlive, survivorsHome, friendlyHits, ... }
```

**Bot** (`src/sim/bot.ts`): a simple autopilot that picks targets away from friendlies, used by `/balance` and G6.

**Browser hook**: in dev and test builds, `window.__spooky` exposes the same `state()`, plus `ready` and `screenshotMode`. URL parameters such as `?map=sample&type=escort&difficulty=2&seed=7&autostart=1` skip the menu.

## 6. Map fixtures

`maps/fixtures/` holds saved OpenStreetMap downloads of **public places chosen for variety**: inner city, outer suburb, rural town, hilly area, coastal. Never the user's own street. They're used by `/map-check` and G5. Overpass is blocked from the cloud dev container, so fixtures are added either by downloading them on your machine (overpass-turbo.eu → Export → raw JSON) or by allowing the Overpass host in the environment.
