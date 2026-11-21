---
name: preflight
description: Run every Spooky at Home release gate and collect the evidence before a release. Use before /release, or when the user asks "is this ready?".
---

# /preflight — every gate, with evidence

1. Run G1–G3 yourself: `npm run typecheck`, `npm test`, `npm run build`. Record the results.
2. Work out which checks the branch's changes need (table in `docs/CREW.md`). Re-use reports in `reports/` **only if they were made against the current HEAD commit**. Otherwise run the checks again, launching the needed subagents in parallel.
3. Build the gate table, G1–G10. Mark each gate that isn't active yet as "n/a (from phase N)", never as pass.
4. Run `npm run -s classify` and add the class and its reasons to the report. Checkers' findings can raise the class, never lower it.
5. Verdict: **READY** (all active gates pass) or **NOT READY** (list the failures). Write `reports/preflight-<commit>.md`.
6. Never mark a gate as passed without its evidence. If a check couldn't run (e.g. no network for fixtures), say so explicitly.
7. Privacy and licensing checklist (a fail here blocks READY):
   - No coordinates, addresses or map files of the owner's area in the diff (`git diff main... -- . ':!maps/private'`); fixtures are public places chosen for variety.
   - OpenStreetMap credit is visible on every screen that shows real map data (game, recon, briefing diorama, walk-through).
   - Every third-party asset (audio, 3D models, fonts) has a source, licence and spend line in `public/audio/CREDITS.md` or `public/models/CREDITS.md`, and the licence allows redistribution in a public web game.
   - Network calls only to the hosts in `docs/QUALITY.md`; stored places stay in the browser and are never sent anywhere.
   - Nothing names or depicts a school, kindergarten, childcare centre or playground as a mission location (decision #11).

