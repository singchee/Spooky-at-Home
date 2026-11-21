---
name: build
description: Implement a reviewed Spooky at Home spec on a branch, test-first, then hand off to the checkers. Use when a spec has status ready, or the user asks to build a planned feature.
---

# /build — implement a spec

1. Read the spec, including the Technical design and Feel & access sections, and the `CLAUDE.md` hard rules.
2. Create the branch `feat/NNN-short-name` from an up-to-date `main`.
3. Work in small commits. For each piece: write the failing test first (unit or headless sim), make it pass, then commit.
4. Run `npm run typecheck && npm test` before every commit. Never weaken a test to get green.
5. When done, pick the checks this change needs from the table in `docs/CREW.md`. **Launch them in parallel as subagents** (`code-reviewer`, `qa-playtester`, `balance-analyst`, `map-checker`); don't review your own work.
6. Send each finding marked Blocker or Must fix through `/fix-bug`. Show the user the rest, grouped by severity.
7. Update the spec status to `built` and summarise for the user: what changed, check results, and anything left open.
