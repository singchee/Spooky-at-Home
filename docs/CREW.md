# The crew — who keeps the game good

*How the agent team is organised, what each role checks, and how work flows between them*

Modelled on Garry Tan's **gstack** (slash-command roles for Claude Code), adapted for a game. A gunship has a crew where each seat watches something different. This harness does the same for the codebase.

## The design principle: agents for checking, not for typing

gstack's own November 2026 test found that adding its roles **did not raise how many bugs Claude fixed** (58 of 100 with it vs 61 of 99 without). Its value was the workflow: reviews, evidence and release gates. (Source: gstack README; we did not re-run the test.)

So this crew is built the same way:
- **Building is done by one main session** with the spec in front of it. Splitting the typing across several "engineer" agents adds handoffs without adding skill.
- **Checking is done by separate agents with fresh context.** A reviewer who didn't write the code isn't anchored on the author's reasoning. That independence is where extra agents pay for themselves.
- **Every check leaves evidence** (a report file and a summary in the pull request) so a human can see what was checked, not just be told it was.

## Roster

| Command | Role (crew seat) | Question it answers | Can edit code? | Agent file |
|---|---|---|---|---|
| `/pitch` | **Game Director** (aircraft commander) | Is this worth building, and does it fit the game? | Specs only | `game-director` |
| `/plan` | **Tech Lead** (navigator) | Will this design work, and how do we test it? | Specs only | `tech-lead` |
| `/plan` | **Feel & Access Designer** (sensor operator) | Is it readable, satisfying and accessible to play? | Specs only | `feel-designer` |
| `/build` | **Builder** (main session) | — | Yes | — |
| `/fix-bug` | **Bug Fixer** (main session, strict loop) | What exactly broke, and is it proven fixed? | Yes | — |
| `/review-code` | **Code Reviewer** (flight engineer) | What bugs pass the tests but break the game? | No | `code-reviewer` |
| `/playtest` | **QA Playtester** (gunner) | Does it actually run and play, end to end? | No (writes reports) | `qa-playtester` |
| `/balance` | **Balance Analyst** (fire control officer) | Are missions fair and fun across seeds and difficulties? | No (writes reports) | `balance-analyst` |
| `/map-check` | **Map Checker** (scout) | Does the mission generator survive messy real maps? | No (writes reports) | `map-checker` |
| `/preflight` + `/release` | **Release Engineer** (loadmaster) | Has everything been checked, with evidence? | Version and changelog only | — |
| `/chief` | **Chief of Staff**: your single point of contact | What's next, who does it, and what needs you? | Builds and coordinates; never signs off its own work | main session |
| `/scout` | **Scout** (looks ahead) | What are others doing, and what would bring players back? Ethics guardrail: no manipulative hooks | No (writes idea reports) | `scout` |
| `/debrief` | **Debrief** (whole crew) | What went wrong this week, and which crew roles earned their keep? | Docs only | — |

**Later, when the phase arrives:**
- `/voice`: Audio Producer, phase 3. Writes crew radio lines and generates them with ElevenLabs only after you approve the list and the credit cost.
- `/assets`: 3D Artist, phase 4. Uses a Blender MCP connection on your own computer.

## How work flows

**You talk only to the Chief of Staff.** It briefs you, calls the other roles as needed, and checks in when something needs you. You can still call any command directly.

```
            YOU (CEO: direction, taste, money)
                 ▲  check-ins, decisions
                 ▼
          CHIEF OF STAFF (/chief, main session)
                 │ delegates
                 ▼
idea ──/pitch──► spec (docs/specs/NNN-name.md)
                    │
                 /plan  (tech + feel review; both must approve)
                    │
                 /build ──► branch with commits + tests
                    │
     ┌──────────────┼──────────────┬─────────────┐
 /review-code    /playtest      /balance     /map-check     (run in parallel,
     │              │              │             │           only those the change touches)
     └──── findings ─► /fix-bug loop ◄── findings ┘
                    │
                /preflight  (all gates green, evidence collected)
                    │
                 /release  (PR with evidence → you merge)
                    │
                /debrief  (weekly)
```

**Bugs reported by you** go straight to `/fix-bug`. It must reproduce the bug as a failing test before it changes any code.

## Which checks a change needs

| Change touches | Required checks |
|---|---|
| `src/map/**` | review-code, map-check |
| `src/game/**`, `src/sim/**` | review-code, playtest, balance |
| `src/render/**`, `src/world/**` | review-code, playtest (with screenshots of each camera) |
| `src/ui/**`, `index.html`, CSS | review-code, playtest |
| Docs only | none |

## Who decides

**The crew runs on its own; `docs/AUTONOMY.md` sets the limits.** In short:
- **Class A/B** (fixes, tests, refactors, building items you already approved): the crew builds, checks, fixes minor findings and merges, with two keys: the builder plus an independent checker. Then it tells you in the digest.
- **Class C** (taste, scope, spending, new services, weakening tests, its own rules, next phase): draft PR + `needs-you` issue, then it works on something else.
- **Class D** (main broken, secret or privacy leak, runaway): safe action, then stop and alert.
- The class comes from fixed rules (`tools/classify-change.ts`); agents can only raise it.
- The **Chief of Staff** (`/chief`) runs one work cycle whenever you say "keep going", and twice a day on a schedule. **Pause the crew** by opening an issue with the label `crew-paused`.

## Keeping the crew honest
- `/debrief` tracks, per check: findings raised, findings that were real, and bugs that escaped to you anyway. A role that finds nothing real for 4 weeks gets simplified or cut. A check that only makes things *look* checked is worse than no check.
- Watch for Goodhart's law (when a measure becomes a target, it stops being a good measure). If balance agents tune missions to hit a win-rate number, the number improves and the fun may not. Human playtest notes outrank bot statistics.
