---
name: preflight
description: Run every Spooky at Home release gate and collect the evidence before a release. Use before /release, or when the user asks "is this ready?".
---

# /preflight — every gate, with evidence

1. Run G1–G3 yourself: `npm run typecheck`, `npm test`, `npm run build`. Record the results.
2. Work out which checks the branch's changes need (table in `docs/CREW.md`). Re-use reports in `reports/` **only if they were made against the current HEAD commit**. Otherwise run the checks again, launching the needed subagents in parallel.
3. Build the gate table, G1–G10. Mark each gate that isn't active yet as "n/a (from phase N)", never as pass.
4. Verdict: **READY** (all active gates pass) or **NOT READY** (list the failures). Write `reports/preflight-<commit>.md`.
5. Never mark a gate as passed without its evidence. If a check couldn't run (e.g. no network for fixtures), say so explicitly.
