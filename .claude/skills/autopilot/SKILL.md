---
name: autopilot
description: Run one unattended work cycle of the Spooky at Home crew - check for pause, apply your answered decisions, pick the next item, build, check, fix minor issues, merge what policy allows, escalate the rest, and post a digest. Used by the scheduled task; can also be run by hand.
---

# /autopilot — one unattended crew cycle

Follow `docs/AUTONOMY.md` exactly. If anything here conflicts with it, AUTONOMY.md wins. Repo: `singchee/Spooky-at-Home`. All GitHub calls go through `gh api repos/singchee/Spooky-at-Home/...` (REST only).

## 0. Pre-checks (stop early if any fail)
1. **Pause:** `gh api 'repos/singchee/Spooky-at-Home/issues?labels=autopilot-paused&state=open'`. If any are open → post "paused, no work done" to the digest and stop.
2. **Sync:** `git fetch origin && git checkout main && git pull --ff-only`. `npm ci` if the lockfile changed.
3. **Health of main:** run `npm run typecheck && npm test && npm run build`, and check the latest CI run on main. If red → **class D**: find the last merged PR that broke it, revert it on a `fix/revert-…` branch, push, merge once CI passes, open an URGENT `needs-you` issue, and stop.

## 1. Read your answers
For each open `needs-you` issue: if the newest comment is from the repo owner and newer than the crew's last comment, act on it:
- approve → finish and merge the parked draft PR (or do the approved change);
- reject → close the draft PR with the reason;
- anything else → interpret it, and reply on the issue with what you'll do.
Comment what you did, then close the issue. An owner's answer counts as approval only for exactly what it covers.

## 2. Pick work (in this order, one item)
1. Blocker findings from the last run's reports.
2. Open issues labelled `bug` (up to 3 fixes this run, via `/fix-bug`).
3. The top `todo` item in `docs/BACKLOG.md` whose phase is approved. Set it to `in-progress` in the same branch.
Skip items marked `waiting-on-you`. If nothing is workable → post "idle: waiting on you for …" to the digest and stop.

## 3. Do the work
- No spec yet → `/pitch` (if the director recommends CUT or flags a pillar clash → class C escalation, then pick other work).
- Spec in `draft` → `/plan`. BLOCKED → class C.
- Spec `ready` → `/build` on `feat/NNN-…` (or `fix/…` for bugs). It runs the independent checkers.
- **Minor findings** (Should fix, Nit, Must fix that doesn't change scope): fix them via `/fix-bug`, at most **2 rounds** per finding. Still failing after 2 rounds → class C.

## 4. Decide and merge
1. `/preflight` → must say READY.
2. `npm run -s classify` → rule-based class. If any checker flagged a scope, taste, safety or privacy issue, raise to C (never lower).
3. **A or B:** push, open the PR (body: three plain lines, gate table, class with reasons, report links), wait for CI green (`gh api …/commits/<sha>/check-runs`), squash-merge (`PUT …/pulls/<n>/merge` with `merge_method=squash`). Then confirm main is still green; if not → class D revert.
4. **C:** push, open the PR as a **draft**, and open a `needs-you` issue in the AUTONOMY.md §4 format. Set the backlog item to `waiting-on-you`. Don't merge.

## 5. Report
1. Comment on the pinned `Crew digest` issue (create it if missing, label `crew-digest`). Sections: **Merged (A)**, **Merged — veto window open (B)**, **Waiting on you (C)**, **Stopped (D)**, **Next up**. One line each with a link.
2. Final message of the run: if anything was escalated, start with **"NEEDS YOU:"** followed by the issue titles, so the phone notification shows it. Otherwise start with "Crew run done:" and the one-line digest.

## Hard limits
- One backlog item, or 3 bug fixes, per run.
- Never push to `main` directly, never force-push, never merge a draft PR, never edit protected files outside class C.
- Never spend money or credits; never add connectors, hosts or API keys.
- If you're unsure which class something is, it's C.
