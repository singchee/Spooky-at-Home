---
name: pitch
description: Turn a feature idea for Spooky at Home into a judged, written spec. Use when the user proposes a new feature, mission type, weapon, camera, enemy or mechanic. Runs the Game Director role.
---

# /pitch — idea to spec

1. If the idea is unclear, ask the user **one** question at most, then proceed.
2. Launch the `game-director` subagent with the idea in the user's own words, plus pointers to `PLAN.md` and `docs/specs/`. Ask it to judge the idea (EXPAND / HOLD / REDUCE / CUT) and, if it goes ahead, write the spec.
3. Show the user the director's verdict in a few lines: the mode, the one assumption, any pillar clashes, and the spec path.
4. If the verdict is CUT, or there's a pillar clash, the user decides. Don't proceed on your own.
5. Suggest `/plan <spec>` as the next step.
