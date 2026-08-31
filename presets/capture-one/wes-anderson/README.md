# Wes Anderson — Capture One style

A pastel, symmetrical-cinema color grade: warm mustard/gold highlights,
dusty-teal shadows, lifted matte blacks, muted greens, and a pastel-pink
accent — the "Grand Budapest / Moonrise Kingdom" look.

## Install the ready-made style

1. Capture One → **Adjustments** panel → **Styles and Presets** tool.
2. Click the **⋮** menu (top-right of the tool) → **Import Style/Preset**.
3. Choose `Wes-Anderson.costyle` from this folder.
4. It shows up under **User Styles** as "Wes Anderson".

`.costyle` is Capture One's own packaged format and isn't publicly
documented, so this file is a best-effort hand build — if it fails to
import, use the recipe below instead (it's the same numbers, applied by
hand, and takes about a minute).

## Manual recipe (guaranteed to work, same result)

Dial these into a fresh variant, then save as a style yourself
(**Styles and Presets → + → New User Style**, check the tools you touched):

**White Balance**
- Temperature: as-shot **+300K** (warmer)
- Tint: **+4** (toward magenta)

**Exposure tool**
- Contrast: **-8**
- Brightness: **+5**
- Saturation: **-12**
- Black: **+6** (matte, faded-film lift)

**High Dynamic Range**
- Highlight: **-15** (soft roll-off, nothing clipped)
- Shadow: **+20** (hazy, lifted)

**Curve** (RGB, film-curve base), points as (input, output), 0–255:
- (0, 18) — raised black point
- (64, 70)
- (128, 132)
- (192, 198)
- (255, 245) — gently rolled highlight

**Color Balance** (wheels)
- Shadow: hue ≈195° (teal/cyan), amount 8%
- Midtone: hue ≈50° (warm gold), amount 5%
- Highlight: hue ≈45° (yellow/gold), amount 10%

**Color Editor / HSL**
- Yellow: Sat +10, Lum +5
- Orange/Skin: Sat +5, hue true (protect skin tones)
- Red: Sat -5, hue nudged toward orange
- Green: Sat -20, hue -10° (toward teal), Lum -5 (mute foliage)
- Aqua/Cyan: Sat +8 (supports the teal shadows)
- Blue: Sat -15, hue toward teal, Lum +5 (pastel sky)
- Magenta/Pink: Sat +12, Lum +8 (the signature pastel-pink pop)

**Clarity/Structure**
- Structure: **-3** (soft, not gritty)
- Clarity: 0

**Film Grain**
- Impact: 8, Type: Fine, Granularity: 50

**Vignetting**
- Amount: -8, Midpoint: 50, round + feathered

Leave capture sharpening near Capture One's defaults (Amount 150,
Radius 0.8) — this look is about color and contrast, not softness.

## Notes

- Push it further per-shot: warmer skin needs less Green desaturation;
  overcast shots often want +2 more Highlight-hue-45 and -5 Contrast.
- Best on daylight/overcast source light. Very cool/tungsten shots need
  the Temperature offset increased to compensate before the rest reads
  correctly.
