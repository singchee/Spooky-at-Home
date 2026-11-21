---
name: debrief
description: Weekly retrospective for Spooky at Home - what shipped, what escaped, test and balance trends, and whether each crew role earned its keep. Use weekly or when the user asks how the project is going.
---

# /debrief — what did we learn?

Look back over the last 7 days (or the period the user gives):

1. **Shipped:** merged PRs and closed specs (`git log`, `docs/specs/`).
2. **Escaped bugs:** bugs the user found that the checks missed. For each, which check *should* have caught it, and what change would make it catch the next one?
3. **Check value:** for each crew role, findings raised, how many were real (led to a fix), and false alarms. Flag any role with no real findings for 4 weeks as a candidate to simplify or cut.
4. **Trends:** test count, test runtime, flaky tests, bundle size, simulation step time, and balance drift since last week.
5. **One change:** recommend the single change to the process or the crew that would help most next week.

Write `docs/debriefs/YYYY-MM-DD.md` (committed: it's the project's memory) and give the user a five-line summary.
