---
name: sound
description: Design, generate or rebalance Spooky at Home's sound - music, ambience, effects, radio voice. Use when the owner asks about audio, wants new sounds or a retake, or a checker flags audio problems. Runs the audio-director role.
---

# /sound — the audio director

1. Launch the `audio-director` subagent with the request. If it needs to generate anything, it must first check the approved cap in `public/audio/CREDITS.md`.
2. **Generation can only happen in a live session**, because scheduled runs have no connectors. If generation is needed and the owner hasn't approved a budget, stop and ask: show the estimate (items, credits, US$).
3. Afterwards, send the owner 2–3 files to listen to and the updated ledger. Integration changes go through checkers like any build.
