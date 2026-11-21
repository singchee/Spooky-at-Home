---
name: map-check
description: Stress-test the Spooky at Home map pipeline and mission generator against every saved real-map fixture and deliberately broken maps. Use after any change in src/map or mission generation, and before every release.
---

# /map-check — break the maps before players do

1. Launch the `map-checker` subagent.
2. Show the user: G5 pass/fail, the failure table, and the smallest reproducing input for each failure.
3. Send each failure through `/fix-bug`, using the reproducing input as the failing test.
4. If the subagent suggests new kinds of area to cover, ask the user whether to add fixtures. They have to be public places, downloaded on the user's machine or with the Overpass host allowed.
