# Audio credits and provenance

Generated with ElevenLabs (owner's account, approved 22 Nov 2026, cap 50,000 credits).
- Music: Eleven Music v2.5 (instrumental prompts) · 7 cues incl. one pilot.
- Sound effects: ElevenLabs Sound Effects v3 · 8 effects.
- Radio voice: ElevenLabs v4 (`eleven_v4`), voice "Robert - Measured Thriller Narrator" (ElevenLabs voice library, voice_id `R5WgLZ1iq28vajcXtks0`, output `mp3_44100_128`) · 47 lines (20 pilot + 27 campaign).
- Spend: **10,059 credits (≈ US$1.84) of the 50,000 cap.** Flows: "Spooky at Home: audio pilot" (pilot, 7,912 credits) and "Spooky at Home: campaign radio lines" (batch 2, 2,147 credits).
Check the owner's ElevenLabs plan terms before any commercial release.

## Batch 2: campaign radio lines (21 Nov 2026)

Script: `docs/story/radio-script.md` (Story Writer). 27 of its 30 lines recorded, one take each. Not recorded: `dawn-thermal` and `reload-105` (held in the script), and `big-expected` (its text says "105", and the recording rules allow no numbers; it's waiting on a Story Writer or owner decision).

- **Estimate (estimate_only):** 27 lines, 2,128 prompt characters, ≈ 1.0 credit per character → **2,128 credits** (≈ US$0.39). The Story Writer's ≈ 1,310 left out the delivery tags, which are billed too.
- **Charged:** 2,128 credits for speech, plus 19 credits for one transcription check (below) = **2,147 credits**.
- **Prompt:** an inline delivery tag + the script text, the same pattern as the pilot lines (for example `[over the radio, calm and dry] Spooky, this is Ground. You're cleared hot.`). The tags aren't spoken.
- **Post-processing:** each file gain-normalised to −21 LUFS integrated (≈ the median of the 20 pilot lines, −20.85), with a −1.5 dBFS peak limiter, and re-encoded as mono 44.1 kHz 128 kb/s MP3 to match the pilot files. Measured result: −21.3 to −22.1 LUFS, peaks ≤ −1.9 dBFS.
- **Checks:** the text of every line was compared word for word with the script. `n1-open` was transcribed back (Scribe v1, 19 credits): "First night, spooky let's see what we're dealing with". That matches, apart from case and punctuation. The other 26 weren't transcribed: the estimate tool quoted ≈ 1 credit per file, but the charge was 19, so all 27 would have come to ≈ 513, over the 500-credit limit for this check. They need a human listen.

| File | Voiced text | Delivery tag | Voice | Model | Credits | Date | Running total |
|---|---|---|---|---|---|---|---|
| `voice/n1-open.mp3` | First night, Spooky. Let's see what we're dealing with. | `[over the radio, calm and dry]` | Robert | eleven_v4 | 86 | 21 Nov 2026 | 7,998 |
| `voice/n2-open.mp3` | Night two. People are still stuck out there. | `[over the radio, calm and serious]` | Robert | eleven_v4 | 79 | 21 Nov 2026 | 8,077 |
| `voice/n3-open.mp3` | Last night, Spooky. Get through this and we all go home. | `[over the radio, calm and steady]` | Robert | eleven_v4 | 90 | 21 Nov 2026 | 8,167 |
| `voice/previously.mp3` | Right, Spooky. Where were we. | `[over the radio, dry]` | Robert | eleven_v4 | 51 | 21 Nov 2026 | 8,218 |
| `voice/welcome-back.mp3` | Welcome back, Spooky. The night's not over. | `[over the radio, calm and dry]` | Robert | eleven_v4 | 74 | 21 Nov 2026 | 8,292 |
| `voice/first-cold.mp3` | Some of them are running cold tonight. Try night vision. | `[over the radio, calm, matter-of-fact]` | Robert | eleven_v4 | 95 | 21 Nov 2026 | 8,387 |
| `voice/n1-close.mp3` | First night down. They know we're here now. | `[over the radio, calm and dry]` | Robert | eleven_v4 | 74 | 21 Nov 2026 | 8,461 |
| `voice/n2-close.mp3` | Night two done. Get some sleep. Well, try. | `[over the radio, tired, dry half-smile]` | Robert | eleven_v4 | 82 | 21 Nov 2026 | 8,543 |
| `voice/n3-close.mp3` | Dawn patrol has the street. Spooky, go home. | `[over the radio, tired, warm and relieved]` | Robert | eleven_v4 | 87 | 21 Nov 2026 | 8,630 |
| `voice/campaign-thanks.mp3` | Residents' committee says thanks. Also, about the lawns. | `[over the radio, deadpan]` | Robert | eleven_v4 | 82 | 21 Nov 2026 | 8,712 |
| `voice/night-lost.mp3` | Not tonight. Same streets, same dead. Go again. | `[over the radio, calm and steady]` | Robert | eleven_v4 | 81 | 21 Nov 2026 | 8,793 |
| `voice/night-won-losses.mp3` | Not everyone made it tonight. | `[over the radio, quiet and slow]` | Robert | eleven_v4 | 62 | 21 Nov 2026 | 8,855 |
| `voice/night-won-clean.mp3` | Everyone safe, nobody singed. Textbook, Spooky. | `[over the radio, dry, quietly pleased]` | Robert | eleven_v4 | 86 | 21 Nov 2026 | 8,941 |
| `voice/tennis-open.mp3` | Tennis club's overrun. New balls, please. | `[over the radio, deadpan]` | Robert | eleven_v4 | 67 | 21 Nov 2026 | 9,008 |
| `voice/park-open.mp3` | Park's shut for the night. Nobody told them. | `[over the radio, deadpan]` | Robert | eleven_v4 | 70 | 21 Nov 2026 | 9,078 |
| `voice/forest-open.mp3` | They're in the trees and running cold. Thermal will sulk. | `[over the radio, dry]` | Robert | eleven_v4 | 79 | 21 Nov 2026 | 9,157 |
| `voice/shops-open.mp3` | Unexpected item in the bagging area. Several, actually. | `[over the radio, deadpan]` | Robert | eleven_v4 | 81 | 21 Nov 2026 | 9,238 |
| `voice/station-open.mp3` | Last service is in. Nobody's meeting them, so we are. | `[over the radio, calm and dry]` | Robert | eleven_v4 | 84 | 21 Nov 2026 | 9,322 |
| `voice/sports-open.mp3` | Home game tonight, Spooky. Let's keep a clean sheet. | `[over the radio, dry]` | Robert | eleven_v4 | 74 | 21 Nov 2026 | 9,396 |
| `voice/landmark-open.mp3` | Solid walls, neighbours inside. Let's keep tonight boring. | `[over the radio, calm and dry]` | Robert | eleven_v4 | 89 | 21 Nov 2026 | 9,485 |
| `voice/ff-one-left.mp3` | One more of those and they take the guns away. | `[over the radio, clipped and firm]` | Robert | eleven_v4 | 81 | 21 Nov 2026 | 9,566 |
| `voice/need-met.mp3` | That's enough home. Now let's get the rest. | `[over the radio, calm and focused]` | Robert | eleven_v4 | 78 | 21 Nov 2026 | 9,644 |
| `voice/few-left.mp3` | Nearly there. The last few are out there somewhere. | `[over the radio, calm and focused]` | Robert | eleven_v4 | 86 | 21 Nov 2026 | 9,730 |
| `voice/cold-leftovers.mp3` | What's left is running cold. Try night vision. | `[over the radio, calm, matter-of-fact]` | Robert | eleven_v4 | 85 | 21 Nov 2026 | 9,815 |
| `voice/one-minute.mp3` | One minute left on the clock. | `[over the radio, calm and focused]` | Robert | eleven_v4 | 64 | 21 Nov 2026 | 9,879 |
| `voice/doors-failing.mp3` | Doors won't take much more of that. | `[over the radio, calm, understated]` | Robert | eleven_v4 | 71 | 21 Nov 2026 | 9,950 |
| `voice/idle.mp3` | Spooky, you've gone quiet. Everything all right up there? | `[over the radio, gently teasing]` | Robert | eleven_v4 | 90 | 21 Nov 2026 | 10,040 |
| (transcription check of `n1-open`) | n/a | n/a | n/a | eleven_scribe_v1 | 19 | 21 Nov 2026 | **10,059** |
