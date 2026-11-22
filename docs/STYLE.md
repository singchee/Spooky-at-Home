# Style guide — the look

*Owned by the Art Director. A night-time gunship sensor feed over a real suburb: eerie, stylish, darkly comic, never gory.*

## 1. Sensor values, not colours

Everything in the 3D scene writes three numbers into its colour channels; the camera filter (`src/render/sensors.ts`) decides how they look. Colour management is off.

| Channel | Means | Seen by |
|---|---|---|
| R | heat | thermal (white-hot / black-hot) |
| G | visible light | night vision |
| B | near-infrared (IR strobes) | night vision only |

### Palette (R heat, G visible)

| Thing | Heat | Visible | Notes |
|---|---|---|---|
| Ground | 0.20 | 0.07 | |
| Grass / park | 0.19 | 0.05 | cold-blooded zombies vanish here |
| Road | 0.33 | 0.10 | cold-blooded zombies show dark here |
| Warm zombie, head | **0.98** | 0.42 (pale skin) | the hottest thing on screen |
| Warm zombie, clothed body | ≈0.6–0.68 | 0.12–0.34 per zombie | |
| Warm zombie, hands and feet | ≈0.45–0.55 | | per-zombie ±0.05 |
| Survivor, head / body / limbs | 0.90 / ≈0.65 / 0.55 | skin 0.34, shirt 0.26–0.36, trousers 0.15–0.22 | |
| Survivor's cold ID panel | **0** | 0.38 | camera-facing square on the chest, thermal only |
| Survivor's IR strobe | 0 | 0 | B = 1, 0.3 s on in every 1 s, additive sprite |
| Cold-blooded zombie | **0.20 everywhere** | as warm | no warm part, no variation, ever |
| Body, fresh → 20 s | 0.50 → 0.23 | as alive | limbs cool first |

The display maps heat with `(R − 0.08) × 1.7`, so anything above ~0.67 is pure white on white-hot. Detail inside a warm body therefore lives in the 0.4–0.67 band: the head is the 0.98 peak, the clothed body and limbs sit just below white.

## 2. People

**Models (default).** Low-poly rigged characters (`public/models/`, see `CREDITS.md`): a shambling zombie and a civilian survivor, real human height (1.75 m), baked at load into vertex animation textures and drawn instanced (one draw call per kind). The zombie's cartoon head is shrunk to 0.62 so it reads as a person from above.

**Fallback.** If the models can't load, the procedural figures (`src/render/figureShader.ts`) draw instead: 13 bones, 76 vertices, about 2.7 m tall.

| Who | State (from the sim) | Animation |
|---|---|---|
| Zombie | wandering / milling | walk (shamble), speed-matched |
| | chasing (1.45× speed) | run with arms out |
| | fast (> 2.5 m/s: rush waves) | run or run with arms out (half each) |
| | stopped (on a survivor or the safehouse) | attack (clawing) |
| | near miss (blast within 3.5× its lethal radius) | hit reaction blended on top, ~0.6 s |
| | dead | death (falls away from the blast that killed it), then lies and cools |
| Survivor | standing | idle (looks around) |
| | standing with a zombie within 7 m, or a blast nearby (1.4 s) | cower: squat, hands over head |
| | walking / running | walk / run, speed-matched |
| | dead | death, then lies and cools; panel and strobe gone |

Crowd variety (visual only, hashed from the agent id): height ±8%, bulk ±12%, cadence ±8%, clip phase, clothing tones, limb heat. A crowd never marches in step.

## 3. Thermal detail rules

- Surfaces seen edge-on radiate less: heat falls toward ambient (0.2) by up to half at grazing angles. Every warm body gets a cooler outline, so overlapping bodies in a crowd stay separate.
- Hair insulates: the top of a survivor's head is cooler than the face.
- Never add warm parts to a cold-blooded zombie, and never put warm clutter on lawns.
- A body never lies inside a building: if its fall would cross a footprint it falls the other way (or sideways). Standing figures are drawn where the sim puts them; keeping them out of buildings is the sim's job.

## 4. Effects and timing

| Effect | Timing |
|---|---|
| State change (walk → run, etc.) | 0.25 s cross-fade |
| Death | clip plays once (~0.75 s zombie, ~2 s survivor), then holds |
| Body cooling | 20 s to 0.23 |
| IR strobe | 0.3 s on, 0.7 s off (1 Hz, under the 3-flash limit, a small dot) |
| Hit reaction | 70 ms jolt, eases back over ~0.6 s |

No gore: zombies fall and cool down. No blood, no dismemberment.

## 5. Budgets

- People: 3 draw calls total (zombies, survivors, strobes), whatever the count.
- Zombie model: 999 triangles, 564 vertices; survivor: 1,384 triangles, 823 vertices (+ panel). 300 zombies ≈ 300k triangles.
- Model files: under 1.5 MB together (now 0.36 MB).
- Visual-only randomness hashes the agent id; no `Math.random` in `src/game`, `src/map`, `src/sim`.

## 6. The intro ("The Late Bulletin")

Script and shot list: `docs/story/intro.md`. Code: `src/ui/intro.ts` (picture), `src/ui/introScript.ts` (timeline, captions). One WebGL context, everything drawn live; no video.

| Layer | Look |
|---|---|
| Command room | The briefing diorama's language: display colours (not sensor values), blocky flat-shaded boxes, light baked into vertex colours (monitor glow from the wall, a little from above and from the map table), far things darker. Near-black greens (`#0b0d0c`–`#2b3631`), accents from the UI palette: `--accent` green for safehouses and routes, `#5aa9ff` friendlies. |
| Commander Quill | Low-poly, plain dark green-grey jumper, grey hair in a bun, mug of tea, TV remote. No badges, flags, rank or insignia. The only lit (Lambert) figure, because she turns. |
| TV studio | Flat, invented channel: deep blue set, pale desk with a red stripe, bug **LATE**. Pruett is flat-shaded quads, mouth moves ~2.4 times a second while he talks (a small patch, not a flash). |
| Footage | Sensor values through the game's own shader: the sample town's sim and figures (never a real place), white-hot; the second feed crossfades to night vision over 1 s. |
| Sky | Sensor values, white-hot, from a camera on the street: cold sky black, roofs 0.23, walls 0.3, lit windows 0.44, chimneys 0.5, airframe 0.36–0.42, engines 0.8, exhausts **0.98** (the hottest thing up there). No strobes, no nav lights. |
| Text | HTML via textContent: lower third, ticker (≤ 60 px/s on screen), captions (always on, speaker in `--accent`), title in the landing page's type. TV graphics are mapped onto the TV with a CSS `matrix3d` and fade out as it shrinks, so no text is ever under 14 px. |

Timing rules: fade up 0.8 s; the dolly back is 5 s, ease-out; Quill's turn 1.6 s; every screen change is a crossfade ≥ 0.6 s; shot 3 → 4 is a 0.8 s dissolve (the last frame held under the new one); the title fades in over 0.8 s; the end fades out over 0.7 s. Reduced motion or "reduce flicker": no camera moves, five still slides (bulletin, room, Quill, mug down, sky) that dissolve over 0.7 s, same audio and captions.

Budget: under 20 draw calls a frame (room ≈ 10, footage ≈ 8 when it refreshes at 30 fps, sky 4); render targets: footage 480×320, studio 768×432, screen at ≤ 1.5× pixel ratio. The intro chunk loads only when played (≈ 13 KB gzipped).

## 7. Checking the look

`node scripts/look-figures.mjs --out reports/figures/<name>` (dev-only figure lab, `tools/figure-lab.html`): every pose at a 35° oblique view in white-hot, black-hot and night vision, zoomed views, a crowd, the real sample-town sim, and `scene=perf` for frame cost with 300 zombies. `models=0` shows the fallback figures.
