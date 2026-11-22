# Intro: "The Late Bulletin"

*Story Writer + Audio Director, 22 Nov 2026. A 44-second intro before the first menu: TV news about the outbreak, a pull-back to a dark command room, and the commander's order. Read `docs/story/voice.md` first. This file is the script, the shot list, the cast and the price of the two ways to make it. Nothing is built yet.*

## Rules this intro keeps

- **Everything is invented.** No real network, channel, logo, newsreader, military unit, insignia or politician. The bulletin, the newsreader and the commander are made up for this game. Uniforms are plain, with no badges, flags or rank patches.
- **No real place.** The voiced script says only "suburbs across the city". The game is set in the player's own suburb, so the intro never names a town, a country or a street.
- **Darkly comic, never cruel, no gore.** The jokes are about bin night, the news and the commander's manner. The dead are "the dead" and "them". Nobody is hurt on screen.
- **Not a copy of any game's intro.** The beats come from the owner's brief: news on a TV, pull back, the order.
- **Photosensitivity (`docs/QUALITY.md`, WCAG 2.3.1):** no full-screen flash, nothing flickers faster than 3 times a second, no TV static, no muzzle flashes, no strobing lights. Every cut is a dissolve or a slow move. Screens change with crossfades of at least 0.5 s.
- **Skippable from the first second:** a "Skip" button and Esc, Enter, Space or a tap all skip from t = 0. The intro plays once, on first launch; the menu gets a "Watch intro" button.
- **Captions for every spoken line**, with the speaker's name. Sound cues are captioned in brackets. Captions are on by default and forced on when the game is muted or the browser blocks sound, so the intro **works muted**: the lower third and the ticker tell the same story.
- **Audio starts only after a user gesture** (the landing page's Start button). If the browser still blocks it, the intro plays muted with captions.
- **OpenStreetMap attribution** (hard rule 7) is shown whenever footage built from a real map is on screen (shots 1 and 4, if they use one).

## Cast

| Character | Who they are | Voice (ElevenLabs library) | Why this voice |
|---|---|---|---|
| **Barnaby Pruett**, newsreader | Presents *The Late Bulletin* on an invented channel (the on-screen bug just says **LATE**). Polished, unflappable and slightly too cheerful about bin night. Only in the intro. | "Nigel - Authoritative warm, deep tone" · `zbod282p00fUaynRSnne` · Australian, middle-aged male, described as a late-night news and radio voice | Sounds like a late-night bulletin without copying any real presenter. The Australian accent fits the game's British/Australian flavour. A newsreader voice also makes the bin-night line land deadpan. I left out a library voice that described itself as a news anchor with decades on air, in case it's a real presenter's clone. |
| **Commander Hester Quill** | Runs the night from a dark command room. Brisk and dry, no speeches. She hands the player to Ground. Only in the intro. | "Eryn - Strong Female Military Commander" · `wa4sQVgbDDzUDEzJwch3` · American, middle-aged female, made for tactical game roles | Commanding without shouting, and clearly different from both Pruett and Ground. That matters because her last line hands straight over to Ground. |
| **Ground** | The existing controller (`voice.md`). One line, over the radio. | "Robert - Measured Thriller Narrator" · `R5WgLZ1iq28vajcXtks0` (the house voice) | Same voice as all 47 in-game lines. |

Spooky still has no voice: the player is Spooky.

`voice.md` says new characters need the owner's approval. The owner asked for this newsreader and this commander, and both stay in the intro. Two wording calls follow `voice.md`, not the brief's exact words:
- The brief says "civilians". The voiced line says "survivors", because `voice.md` avoids "civilians" as cold and clinical.
- The brief says "pilot the Spooky". The commander says "You're taking Spooky up tonight", because in the game the player is Spooky's gunner, and that line works for either reading.

## Script and timeline

94 spoken words (the limit is 100). Times are from the start of the intro and use the measured length of each recorded file. The intro ends at **44.0 s**.

| # | File | Speaker | Delivery tag (sent, not spoken) | Spoken text = caption text | Starts | Length |
|---|---|---|---|---|---|---|
| 1 | `voice/intro-news-1.mp3` | PRUETT | `[polished TV newsreader, bright and slightly too cheerful]` | Good evening. Reports tonight of the dead walking in suburbs across the city. | 0.6 | 4.91 s |
| 2 | `voice/intro-news-2.mp3` | PRUETT | `[TV newsreader, calm and reassuring]` | Stay indoors, lock your doors, and please don't approach them. | 5.8 | 4.44 s |
| 3 | `voice/intro-news-3.mp3` | PRUETT | `[TV newsreader, cheerful, as if it's good news]` | The council confirms bin night goes ahead as normal. And now, the weather— | 10.5 | 4.68 s |
| 4 | `voice/intro-cmd-1.mp3` | COMMANDER QUILL | `[low, brisk and dry]` | Right. That's enough news. | 15.6 | 2.35 s |
| 5 | `voice/intro-cmd-2.mp3` | COMMANDER QUILL | `[steady, matter-of-fact]` | You're taking Spooky up tonight. | 18.3 | 2.12 s |
| 6 | `voice/intro-cmd-3.mp3` | COMMANDER QUILL | `[steady and serious]` | Ground teams are out on the streets. Keep them safe, and get the survivors home. | 20.7 | 4.91 s |
| 7 | `voice/intro-cmd-4.mp3` | COMMANDER QUILL | `[dry, matter-of-fact]` | Three guns, small to very large. Mind the friendlies. | 25.9 | 4.28 s |
| 8 | `voice/intro-cmd-5.mp3` | COMMANDER QUILL | `[calm, matter-of-fact]` | Thermal finds the warm ones. Night vision finds the rest. | 30.5 | 3.79 s |
| 9 | `voice/intro-cmd-6.mp3` | COMMANDER QUILL | `[dry, with half a smile]` | Questions? Good. Ground will talk you in. | 34.6 | 3.55 s |
| 10 | `voice/intro-ground.mp3` | GROUND | `[over the radio, calm and dry]` | Spooky, Ground. Kettle's on. Let's get them home. | 38.7 | 3.47 s |

Captioned sound cues: `[TV muted]` at 15.2, `[radio click]` at 38.4.

**Why each line is true (hard rule 9).** The game has three guns (25 mm, 40 mm and 105 mm), which is "small to very large". Friendly fire is counted, and too much of it ends the mission, which is "mind the friendlies". Cold-blooded dead vanish on thermal over grass but show in night vision, which is "night vision finds the rest", the same advice as `first-cold`. Survivors walk home to safehouses, which is "get the survivors home". Ground teams are the friendlies with IR strobes. The intro names no place and no number.

## Shot list

| Shot | Time | Picture | Sound | Flash safety |
|---|---|---|---|---|
| **1. The Late Bulletin** | 0.0–10.5 | Fade up from black over 0.8 s. A chunky low-poly TV on a desk fills the frame, with a slow push-in. On screen: Pruett at a plain desk (flat-shaded, half the screen) and a **LIVE** inset of white-hot aerial footage of the dead shuffling along a suburban street, rendered by the game's own sensor shader. Lower third: **BARNABY PRUETT** / **LIVE: SUBURBS ACROSS THE CITY**. Channel bug: **LATE**. A slow ticker (≤ 60 px/s): *STAY INDOORS · LOCK YOUR DOORS · DO NOT APPROACH · BIN NIGHT GOES AHEAD AS NORMAL · RESIDENTS' COMMITTEE "DISAPPOINTED" ·* | Lines 1–3. A low TV-room hum; the menu theme starts very low. | No static, no cuts inside the TV. The footage is steady with no gunfire. |
| **2. Pull back** | 10.5–15.6 | A continuous 5 s ease-out dolly back through the TV bezel. The TV turns out to be one of a wall of monitors in a dark, blocky command room in the briefing-diorama style. A map table glows with a generic street grid (no real map). Two staff sit at consoles as silhouettes. At 15.2 a hand with a remote mutes the TV; Pruett carries on silently. | End of line 3, cut off on "weather—" by the mute. `[TV muted]` caption. | No light changes during the move. Monitor glow is steady. |
| **3. The order** | 15.6–38.2 | Commander Quill, a low-poly figure in a plain dark jumper with no insignia and a mug of tea, turns from the monitors to face the camera. Slow push-in. Monitors behind her follow the lines: **line 6**, the map table lights up steady friendly markers and safehouse icons; **line 7**, three monitors show plain gun silhouettes labelled 25 · 40 · 105; **line 8**, two monitors show the same street, white-hot then night vision, as a 1 s crossfade; **line 9**, she puts the mug down. | Lines 4–9. Music swells gently under line 9. | Markers are steady (no blinking strobes). The sensor change is a crossfade, never a cut to bright. |
| **4. Radio** | 38.2–42.2 | Dissolve to the night sky over the suburb. Spooky's silhouette circles slowly, seen from the ground, with a small radio waveform in the corner. | `sfx/radio-squelch.mp3` at 38.4, then line 10, through the game's radio filter. | No muzzle flashes, no tracers. |
| **5. Title** | 42.2–44.0 | **SPOOKY AT HOME** fades in, holds, and dissolves into the landing/menu. | The music resolves. | A fade, not a flash. |

## Two ways to make it: prices

All prices are **estimate-only calls** made on 22 Nov 2026. Nothing was generated to get them.

### A. Motion graphics built in the game (recommended)

HTML/CSS for the TV, lower third, ticker, captions and title. three.js for the command room, built from the briefing-diorama blocks, the low-poly commander and the camera moves. The inset news footage and shot 4 come from the game's own renderer and sensor shaders. Sound is the 10 voice files above plus the existing `music/menu-theme.mp3` and `sfx/radio-squelch.mp3`.

| Item | Credits | US$ |
|---|---|---|
| Voiceover, 10 lines, eleven_v4, 863 billed characters (≈ 1.0 credit per character, confirmed on two lines) | **863** (spent, see the ledger) | ≈ 0.16 |
| Music and SFX | 0 (existing assets) | 0 |
| Video | 0 | 0 |
| **Total** | **863** | **≈ 0.16** |

- **Download:** the 10 voice files are 0.62 MB; the code is tens of kB. Nothing else is new.
- **Look:** the same blocky diorama and sensor palette as the briefings and the game, so the intro sets up the game's own style.
- **Editability:** change a caption, timing or shot in code. A changed line costs about 1 credit per character to re-record.
- **Flash safety:** fully under our control and testable with the playtest's flash checks.
- **Cost of building it:** builder time. It's a class C feature, so it goes through `/pitch` → `/plan` → `/build`.

### B. Rendered clips from ElevenLabs video models

I read the model guide first. Seedance 2.5 is the default text-to-video model. Its defaults are a **5 s clip, 720p, 16:9, with generated audio on**, and those are the settings priced here. Four shots were priced on Seedance 2.5: the TV news, the pull back, the commander's turn and the aerial thermal. The pull back was also priced on three cheaper models. Shot 5 (title) would stay in HTML either way.

| Shot (5 s each) | Seedance 2.5 | Seedance 2.5 Flash | Kling 2.5 Turbo | LTX v2 Fast |
|---|---|---|---|---|
| 1. TV news | 14,003 | ≈ 9,162 | ≈ 2,121 | ≈ 1,454 |
| 2. Pull back to the command room | 14,003 | 9,162 | 2,121 | 1,454 |
| 3. Commander turns | 14,003 | ≈ 9,162 | ≈ 2,121 | ≈ 1,454 |
| 4. Aerial thermal / gunship | 14,003 | ≈ 9,162 | ≈ 2,121 | ≈ 1,454 |
| **Video, 4 shots** | **56,013 (≈ US$10.18)** | **36,647 (≈ US$6.66)** | **8,483 (≈ US$1.54)** | **5,817 (≈ US$1.06)** |
| + voiceover (same as A) | 863 | 863 | 863 | 863 |
| **Total** | **56,876** | **37,510** | **9,346** | **6,680** |

"≈" means the price was measured on shot 2 and applied to the others, which use the same model at the same settings. Seedance 2.5 was priced on all four shots, and all four came out at the same figure. Runway Gen-4 Turbo would need a start-frame image generated first, so it wasn't priced.

- **Budget:** 39,078 credits are left under the 50,000 cap after the voiceover. **Seedance 2.5 doesn't fit**: even 3 shots (42,010) would go over. Seedance Flash would use 94% of what's left. Four 5 s clips cover only 20 of the 44 s, so the rest would be held frames or graphics anyway. Every re-render to fix one shot costs the same again.
- **Download:** 720p H.264 runs at about 2–4 Mb/s, so a 20–44 s edit is **about 6–15 MB**, against 0.62 MB for A. It's heavy on mobile data, and it plays before the game is even reached.
- **Look next to the game:** photoreal or generic "AI cinematic" footage. It won't match the sensor-value palette or the blocky briefing dioramas, so the intro would promise a different-looking game from the one that follows. Text inside the clips comes out garbled, so the lower third and the ticker would be overlaid in HTML anyway. Characters drift between clips, and the models tend to add real-looking insignia, logos or news-studio branding, which every frame would need checking for.
- **Flash safety:** not under our control. Lights, screens and "TV" content can flicker. Each clip needs a frame-by-frame flash check, and a failed check means a re-render.
- **Editing:** ffmpeg 6 is installed here, so the clips can be cut and muxed with the voiceover. But changing a line's timing means re-cutting, and changing a picture means re-rendering.

### Recommendation

**A.** It matches the game's look, costs 863 credits in total (already spent), adds 0.6 MB, can be edited in code, and keeps flash safety under our control. Use B only if the owner wants a photoreal trailer for outside the game, such as a store page, and then only with Kling or LTX and a separate budget.

## Status

- Voiceover recorded and normalised (see `public/audio/CREDITS.md`, batch 3). Each line was recorded once; none needed a retake. **A human needs to listen to it**, especially for the delivery of lines 3, 4 and 9.
- Not built: the intro player, its captions, the skip control or the menu's "Watch intro" button. That's a class C feature for `/pitch` once the owner picks A or B.
