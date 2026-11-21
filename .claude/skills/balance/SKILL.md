---
name: balance
description: Measure Spooky at Home mission fairness and difficulty across many seeds, difficulties, mission types and maps with the headless bot. Use after changes to missions, weapons, agents or difficulty, or when the user asks if missions are too hard or too easy.
---

# /balance — fair and fun, measured

1. Launch the `balance-analyst` subagent. Pass along any user complaint (e.g. "escort feels impossible on difficulty 3") as the focus.
2. Show the user: G10 pass/fail, the table, the worst seeds with their cause, and the recommended changes with predicted effects.
3. **Tuning values are a matter of taste: ask the user before applying them.** If approved, apply them as a normal commit and re-run `/balance` to confirm the predicted effect actually happened.
