---
name: release
description: Ship a Spooky at Home branch - version bump, changelog, push and open a pull request whose body carries the preflight evidence. Use only after /preflight says READY, or when the user explicitly says to ship anyway.
---

# /release — ship with evidence

1. Check that `reports/preflight-<HEAD>.md` exists and says READY. If it doesn't, run `/preflight`. If it still fails, stop unless the user says "ship anyway"; then record that override in the PR.
2. Bump the version in `package.json` (patch for fixes, minor for features), and add a `CHANGELOG.md` entry written for players: what's new or fixed, in plain words.
3. Commit, then push the branch with `git push -u origin <branch>` (retry network failures up to 4 times with backoff).
4. Open a PR through `gh api repos/singchee/Spooky-at-Home/pulls`. The body has:
   - three plain lines: what changed, why, and the risk;
   - the gate table from preflight;
   - links to the review, playtest, balance and map-check reports, with key screenshots;
   - any gate overrides or weakened tests, by name.
5. Give the user the PR link. **Don't merge**; the user merges.
