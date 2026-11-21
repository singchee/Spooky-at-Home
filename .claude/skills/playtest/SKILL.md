---
name: playtest
description: Run Spooky at Home for real - build, headless browser, screenshots of each camera, bot plays each mission to a win and a loss, budgets measured. Use after changes to gameplay, rendering or UI, before preflight, or when the user asks whether the game works.
---

# /playtest — prove it runs

1. Launch the `qa-playtester` subagent. Tell it what changed (one sentence plus file list) so its exploratory testing targets the right area, and whether a person will look at the screenshots (deviceScaleFactor 2) or only agents (1).
2. When it returns, show the user the gate table (G6–G8), a screenshot of each camera, and the bugs found.
3. Offer to send bugs through `/fix-bug`.

Add `--report-only` to skip exploratory testing and just run the gates.
