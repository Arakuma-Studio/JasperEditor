# Pachislop: looks, colourways and the style check

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks library, 2026-11-02

| Upstream path | Local path | What |
|---|---|---|
| `src/presets/lint.ts` | `packages/project/src/title-looks/lint.ts` | L*a*b* conversion, element sampling, spectrum and banding detection, and the contrast, hue family, rim thickness, hard shadow, span and no-op rules |
| `src/presets/colourways.ts` (`COLOURWAY_DEFS`, colour rules) | `packages/project/src/title-looks/factory/colorways.ts` | Roles of a colourway and the rules: blue and green take silver, red takes gold, red stays hue 0, gold runs to brown, rings alternate light and dark, tinted shadows. Hex values of white, gold, silver, red, blue, green and purple |
| `src/presets/factory.ts` (`ladderBase`, `ladderEffects`) | `packages/project/src/title-looks/factory/looks/pachinko-arcade.ts` | The five-layer outline stack of the gold ladder look |
| `src/presets/factory.ts` (`f-neon`, `f-neon-knockout`) | `packages/project/src/title-looks/factory/looks/neon-retro.ts` | Structure of the neon looks: a hot core, a saturated sheath and two falloffs of light |
| `src/presets/factory.ts` (`f-rainbow-kakutei`, `GRADIENTS.rainbowFill`, `f-fx-jackpot` rays and sparkles) | `packages/project/src/title-looks/factory/looks/pachinko-arcade.ts` | The rainbow face with a white band in a ladder of metal rings, and rays behind a ladder face with glints |
| `src/presets/factory.ts` (`brushLook`, `f-brush-kasure`) | `packages/project/src/title-looks/factory/looks/brush.ts` | Brush looks: an ink face with a thin metal line, a dark line and a light frame; dry brush that breaks its frame up with the ink, over a glow |
| `src/presets/factory.ts` (`blackGloss`, `glassLook`, `f-lightning-blue`, `f-fire-gekiatsu`, `f-chrome`) | `packages/project/src/title-looks/factory/looks/{luxury,playful,gaming,horror,sports}.ts` | Structures of Black Lacquer (black gloss face, metal rim, glow), Candy Glass (glass face, light line, tinted frame, gloss cap), Arc Charge (bevelled face with lightning), Cursed Flame (fire behind a framed face) and Champion Chrome |
| `src/presets/factory.ts` (`surfaceGold3D` depth-fade walls, `ぷっくり` inflate candy, slanted box plates) | `packages/project/src/title-looks/factory/looks/three-d.ts` | The 3D looks as drawn depth: walls fading to dark, an inflated domed face with a gloss cap, stacked slanted plates |
| `src/presets/templates.ts` (`Template`, `build()`) | `packages/project/src/title-looks/factory/templates/`, `packages/project/src/commands/handlers/title-template.ts` | The idea of a template that builds finished, fully editable layers |
| `src/presets/user.ts` (`PresetFile`, `.pslot-styles.json`) | `packages/project/src/title-looks/user-looks.ts` | A versioned file of looks for import and export |
| `src/presets/types.ts` (`StylePreset`, `Colourway`) | `packages/project/src/title-looks/factory/build.ts` | The separation of a look's structure from its colour |

## Changes made when porting

- Pachislop's 3D looks build a solid in its 3D renderer. Here a look is an appearance (TL-055), so the 3D category draws its
  depth with the look's own layers (Extrude, Bevel, metal, plates) and renders on every path a look does.
- A name of Pachislop's that refers to a real title (its slanted box plates) is replaced with a descriptive one.
- Nothing that names a real title, person or product was brought over. Looks are renamed under generic descriptive names, and
  sample text is new. `packages/project/test/title-look-library.test.ts` checks a list of banned names.
- Colours are explicit roles. Pachislop classifies each element by its lightness when a colourway is applied; here the look
  states the role, so nothing is guessed (TL-051).
- The lint had no tests: every rule now has tests that trip it and tests that do not. Thresholds are for video, not stills:
  `MIN_DELTA_L` 15 (was 12), a rim minimum of 2 px at 1080p scaled to the real text size (was 5 % of the size).
- A hard shadow only counts on letters with no outline, because a hard block behind an inked ring is a drawn extrusion.
- Fixes are serializable commands, one undoable transaction. Pachislop's were functions over a layer.
- Backdrop contrast is a rendered check: the caller measures and `lintAppearance` compares; with no measurement the check is
  reported as unmeasured, never as passed.
- Issues carry codes, severities, an i18n template and arguments, measured and expected values.
- User looks live in the engine's library, written atomically and validated with zod, not in `localStorage`.
- Templates are data, positioned in fractions of the frame, and expand through ordinary commands in one transaction.
