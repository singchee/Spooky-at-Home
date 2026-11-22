# Style guide — the look

**Quality bar.** Commercial thermal gunship games: oblique slant view, people 30-50 px tall, grain, scanlines, vignette, soft bloom, bright outlines, textured ground. We match the *fidelity*, never the HUD, names, layout, characters or assets.

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

### Ground texture (src/render/groundShader.ts, shader only, world-space)

| Surface | Heat texture | Lines |
|---|---|---|
| Road (asphalt) | patches ±0.03, grit ±0.012 (range about 0.29-0.41 with cracks) | worn seam network (13 m cells, +0.04), fine cracks in worn patches (high tier) |
| Ground (yards, verges) | patches ±0.02, grit ±0.008 | faint seams (16 m cells, +0.012) |
| Grass, woods | mottle ±0.013 only | none: never warm clutter on lawns |
| Water | flat | none |

Limits are enforced by `tests/sensorLook.test.ts`. Lines fade out before they would shimmer at wide lenses. Street-lamp pools (G only) fade quadratically from about 0.16 at the lamp to 0 at 11 m.

### Display mapping

- **Thermal:** `l = (heat - 0.08) * 1.7`; black-hot is `1 - l`. Grey, no tint. Polarity eases over 0.25 s (no hard flip).
- **Night vision:** `l = (G + B) * 3`, tinted `(0.3, 1.0, 0.4)`. Blasts wash it out (`washout`), never a hard cut.

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

## 6. Checking the look

`node scripts/look-figures.mjs --out reports/figures/<name>` (dev-only figure lab, `tools/figure-lab.html`): every pose at a 35° oblique view in white-hot, black-hot and night vision, zoomed views, a crowd, the real sample-town sim, and `scene=perf` for frame cost with 300 zombies. `models=0` shows the fallback figures.

## 7. The sensor picture (post-processing, src/render/sensorPost.ts)

All of it works on sensor values *before* the display mapping, so black-hot inverts glow and outlines with everything else, and night vision only blooms what night vision can see.

| Effect | Setting | Why |
|---|---|---|
| Softness | 30% of the 1-px neighbourhood | Sensors are soft; hides aliasing |
| Detail enhancement (FLIR halo) | picture minus a ~3 CSS px blur, ×0.85, **cored**: differences under ~0.012 get nothing, full boost from 0.03 | Every clear heat edge gets a thin halo. Coring means a cold-blooded zombie on grass (0.01) is never dug out |
| Silhouette outlines | depth jump of 4.5-8 m behind a pixel lifts it toward heat 0.44 (and +0.12 on night vision) | Bright edges on roofs and tree crowns. People are too short to trip it, so coldies never get an outline |
| Bloom | heat above 0.45 (thermal), G+B above 1/3 (night vision); half-res (high) or quarter-res (low), 9-tap Gaussian ×2; strength 1.0 | Soft glow on warm bodies, fires, strobes. Never from heat on night vision |
| Grain | one value per CSS px, 30 new patterns/s; ±0.03 thermal, ±0.075 night vision | Film/sensor grain; averages out at any scale |
| Scanlines | every 3 CSS px, 4.5% deep | Faint |
| Rolling band | 2.5% brighter, drifts down slowly (~14 s per pass) | Life in the picture |
| Vignette | up to 50% darker in the far corners | Lens |
| **Reduce flicker** | grain frozen, no rolling band; switch cover is a flat fade | Setting in src/ui/settings.ts |

## 8. Camera

- **Slant:** the camera looks in **40° off vertical**, on the gunship's bearing (it turns with the orbit) at the gunship's real slant range. You see the walls of houses.
- **Lenses** (`WeaponDef.fov`, degrees at 1.8 km; at other ranges the angle is adjusted so the view covers the same ground, so a person is the same size wherever you look):

| Gun | Lens | Ground covered (height) | Person on a 1080 px screen |
|---|---|---|---|
| 25 mm | 1.6° | ~50 m | ~36 px |
| 40 mm (default) | 2.0° | ~63 m | ~27 px |
| 105 mm | 6° | ~190 m | ~10 px |

- **Zoom:** everything goes through `Game.zoomBy(-1|0|1)`. Z or the ZOOM button toggles ×1 ↔ ×1.6; the mouse wheel and a pinch step along ×0.45, ×0.7, ×1, ×1.6, ×2.4. Each gun remembers its own zoom. The narrowest lens is 1.0° (25 mm zoomed: a person is ~65 px). People are drawn at `MODEL_DISPLAY_SCALE` 1.7 (about 3 m: exaggerated on purpose so they read), tuned with these lenses.
- **Near/far:** 600 m / 6000 m. Roads sit 1 m above the ground plane and areas 0.4 m (no z-fighting at this near plane).
- **105 kick:** at most 5 px, one damped swing (0.4 s), off with reduced motion or reduce flicker.
- **Tracers come in from off screen:** rounds fly from the gunship's real orbit position along its slant line to the impact (flight time = the sim's range / `WeaponDef.speed`). The camera's slant differs from the plane's, so the plane sits just off the picture; if the two lines nearly coincide, the tracer's start swings around the target (same range) until it is just outside the field of view. Rounds never pop out of the middle of the screen.

## 9. Photosensitivity (non-negotiable)

- No full-screen flashes; at most 3 flashes a second anywhere; `node scripts/playtest.mjs --only safety` must pass (WCAG 2.3.1 general flash threshold).
- Bloom, grain, scanlines and the rolling band must never add a flash: grain is fine-grained, scanlines and the band are a few per cent.

## 10. Performance

| Tier | Resolution | Scene MSAA | Bloom | Outlines | Fine cracks |
|---|---|---|---|---|---|
| high | up to 2 device px per CSS px | 4× (when float targets can be multisampled) | half-res | yes | yes |
| low | 1 device px per CSS px | none | quarter-res | no | no |

The game starts on high and drops to low once (never back) when frames average over ~31 ms after warm-up. `?gfx=high` or `?gfx=low` forces a tier. The post adds 4 draw calls (bright pass, 2 blurs, filter); the whole frame stays well under the 150 budget (aim ≤ 40).

## 11. HUD rules

- HTML overlay, not post-processed: always crisp. Smallest text 14 px. Map text with `textContent` only.
- OpenStreetMap attribution always visible on a real map.
- HUD layout is not part of the sensor picture; change it only through its own work.

## 12. Briefing art

Owner decision (22 Nov): richer OpenStreetMap buildings in game; no Google photoreal tiles; blocky stylised dioramas in briefings.

