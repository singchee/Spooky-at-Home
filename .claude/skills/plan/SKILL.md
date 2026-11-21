---
name: plan
description: Review a Spooky at Home spec before building - technical design plus feel and accessibility. Use after /pitch, or when the user says a spec is ready to plan. Runs the Tech Lead and Feel & Access Designer roles in parallel.
---

# /plan — review a spec before building

Argument: the spec path, e.g. `docs/specs/004-night-vision.md`. If none is given, use the newest spec whose status is `draft`.

1. Launch **in parallel**, in one message, the `tech-lead` and `feel-designer` subagents, each pointed at the spec. Each appends its own section and verdict.
2. If either says **BLOCKED**, stop and show the user the reason.
3. If there are **APPROVED WITH CHANGES** items, make the spec edits yourself, then set the spec's status to `ready`.
4. Tell the user: both verdicts in one line each, the first commit to make, and the tests that must exist. Next step: `/build <spec>`.
