# Style guide: the sensor look

*Kept by the Art Director. A night-time gunship sensor feed over a real suburb: eerie, stylish, darkly comic, never gory. Update this file whenever the look changes.*

**Quality bar.** Commercial thermal gunship games (oblique slant view, people 30-50 px tall, grain, scanlines, vignette, soft bloom, bright outlines, textured ground). We match the *fidelity*, never the HUD, names, layout, characters or assets.

## 1. The sensor-value contract (PLAN §5a)

Colours in the 3D scene are **sensor values**, not colours. Colour management is off; the renderer outputs `LinearSRGBColorSpace`.

| Channel | Carries | Seen by |
|---|---|---|
| R | heat | thermal (white-hot / black-hot) |
| G | visible light | night vision |
| B | near-infrared (IR strobes, lamps' IR) | night vision |

### Heat palette (R)

| Thing | Heat | Notes |
|---|---|---|
| Warm zombie (core / limbs) | 0.98 / 0.5 | **Always the brightest thing on thermal.** |
| Survivor (core / limbs) | 0.9 / 0.55 | Cold ID panel on the chest (`PANEL_SIZE` 0.34 m) |
| Cold-blooded zombie | 0.2 | Equal to ground: vanishes on grass, a dark smudge on roads |
| Fresh body → cooled | 0.5 → 0.23 over 40 s | No blood, ever. They fall and cool. |
| Road (asphalt) | 0.33 | texture ±0.042, cracks up to +0.04 (range 0.29-0.41) |
| Ground (yards, verges) | 0.2 | texture ±0.028, faint seams +0.012 |
| Grass (park) / wood | 0.19 / 0.2 | texture ±0.013 only, no lines (never warm clutter on lawns) |
| Water | 0.1 | flat |
| Trees | 0.235 | lit |
| Buildings | 0.25-0.35 before lighting | Lambert-lit; on screen they read about 0.1-0.2 (cool roofs) |

The texture limits are enforced by `tests/sensorLook.test.ts` (grass texture ≤ 0.015 either way; the coolest road patch stays ≥ 0.08 above a cold-blooded zombie; nothing on the ground gets within 0.5 of warm-zombie heat).

### Visible light (G) and near-IR (B)

- Ground 0.07, road 0.1, park 0.05, wood 0.035. Street-lamp pools add G up to about 0.16 at the centre, fading quadratically to 0 at 11 m (soft pools, not discs). Murky between lamps: that is the design.
- IR strobes are B only (no heat, no visible light): they must stay invisible on thermal and saturate night vision to white when on (0.3 s of every second).

## 2. Display mapping (src/render/sensors.ts)

- **Thermal:** `l = (heat - 0.08) * 1.7`; black-hot is `1 - l`. Grey, no tint. Polarity eases over 0.25 s (no hard flip).
- **Night vision:** `l = (G + B) * 3`, tinted `(0.3, 1.0, 0.4)`. Blasts wash it out (`washout`), never a hard cut.

## 3. The sensor picture (post-processing, src/render/sensorPost.ts)

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

## 4. Camera

- **Slant:** the camera looks in **40° off vertical**, on the gunship's bearing (it turns with the orbit) at the gunship's real slant range. You see the walls of houses.
- **Lenses** (`WeaponDef.fov`, degrees at 1.8 km; at other ranges the angle is adjusted so the view covers the same ground, so a person is the same size wherever you look):

| Gun | Lens | Ground covered (height) | Person on a 1080 px screen |
|---|---|---|---|
| 25 mm | 1.6° | ~50 m | ~36 px |
| 40 mm (default) | 2.2° | ~69 m | ~27 px |
| 105 mm | 6° | ~190 m | ~10 px |

- **Zoom:** Z toggles ×1.6; the mouse wheel and a two-finger pinch step ×1.15 between ×0.45 (wider) and ×2.4. Each gun remembers its own zoom. The narrowest lens is 1.0° (25 mm zoomed: a person is ~60 px).
- **Near/far:** 600 m / 6000 m. Roads sit 1 m above the ground plane and areas 0.4 m (no z-fighting at this near plane).
- **105 kick:** at most 5 px, one damped swing (0.4 s), off with reduced motion or reduce flicker.

## 5. Figures

Owned by the figures work (src/render/figureShader.ts). About 2.25 m tall in the rest pose, drawn at ×1.2, so they read at the default lens. A figure must read at the default 40 mm view; detail that only shows at the 25 mm zoomed in is a bonus.

## 6. Effect timings (src/game/effects.ts)

| | 25 mm | 40 mm | 105 mm |
|---|---|---|---|
| Local flash | 9 m, 0.07 s | 22 m, 0.1 s | 50 m, 0.14 s |
| Fireball life | 0.6 s | 1.3 s | 2.4 s |
| Fires | none | 10-15 s | 14-20 s |
| Craters | cool over ~25 s | | |

Camera switch: 0.7 s of static (reduce flicker: a gentle fade). Night-vision washout rises in ~0.1 s, falls over ~1-2 s.

## 7. Photosensitivity (non-negotiable)

- No full-screen flashes; at most 3 flashes a second anywhere; `node scripts/playtest.mjs --only safety` must pass (WCAG 2.3.1 general flash threshold).
- Bloom, grain, scanlines and the rolling band must never add a flash: grain is fine-grained, scanlines and the band are a few per cent.

## 8. Performance

| Tier | Resolution | Scene MSAA | Bloom | Outlines | Fine cracks |
|---|---|---|---|---|---|
| high | up to 2 device px per CSS px | 4× (when float targets can be multisampled) | half-res | yes | yes |
| low | 1 device px per CSS px | none | quarter-res | no | no |

The game starts on high and drops to low once (never back) when frames average over ~31 ms after warm-up. `?gfx=high` or `?gfx=low` forces a tier. The post adds 4 draw calls (bright pass, 2 blurs, filter); the whole frame stays well under the 150 budget (aim ≤ 40).

## 9. HUD rules

- HTML overlay, not post-processed: always crisp. Smallest text 14 px. Map text with `textContent` only.
- OpenStreetMap attribution always visible on a real map.
- HUD layout is not part of the sensor picture; change it only through its own work.

## 10. Briefing art

Owner decision (22 Nov): richer OpenStreetMap buildings in game; no Google photoreal tiles; blocky stylised dioramas in briefings.
