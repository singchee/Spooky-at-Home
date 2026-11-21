---
name: review-code
description: Independent code review of the current branch for Spooky at Home, by a reviewer agent with fresh context. Use after building or fixing and before preflight, or when the user asks for a review.
---

# /review-code — independent review

1. Work out the diff range: default `main...HEAD`, or the argument given.
2. Launch the `code-reviewer` subagent. Give it the diff range and the spec path if there is one, but **not your own opinion of the code**; it should read the code unanchored.
3. Save its output to `reports/review-YYYY-MM-DD-<branch>.md`.
4. Show the user the blockers and should-fix items. Offer to send blockers through `/fix-bug`. If the reviewer flagged any weakened tests (gate integrity), always show those by name, even when they're intentional.
