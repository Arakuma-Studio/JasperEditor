# Text animators: selectors, character transforms, text on a path

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** text-animators workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/text/src/selectors.rs` | `packages/project/src/text-animators/selectors.ts` | Range shapes, ease high/low, range_value, mode combine, SplitMix64, random order, value noise, wiggly selector (bit-exact, BigInt u64) |
| `crates/text/src/path_text.rs` | `packages/project/src/text-animators/path.ts` | PathMeasure, place, arc_positions (Path Options) |
| `crates/render/src/text.rs` | `packages/project/src/text-animators/evaluate.ts`, `place.ts` | CharXf, animator_selection, char_transforms, substitute, adjust_color, text_geom placement (tracking, line anchor, line spacing, anchor point grouping, path, per-character matrix) |
| `crates/color/src/lib.rs` | `packages/project/src/text-animators/evaluate.ts` | rgb_to_hsv / hsv_to_rgb |
| `crates/text/src/layout.rs` (`space_item`, `SCRIPT_SIZE`, `SCRIPT_OFFSET`) | `packages/compositions/src/layers/text/measure.ts`, `typography.ts` | tsume, optical and manual kerning spacing; superscript / subscript size and offset |
| `crates/text/src/lib.rs` (`glyph_affine`) | `packages/compositions/src/layers/text/typography.ts` | faux italic slant 0.21 |
| `crates/project/src/build.rs` (`text_anim_props`, `range_selector`, `wiggly_selector`, `expression_selector`) | `packages/project/src/text-animators/catalog.ts` | animator property list, companions, selector defaults |
| `crates/engine/presets/text_animators.json` | `packages/project/src/text-animators/presets.ts` | the eight preset ideas (typewriter, fade up characters, bounce in words, tracking in, scramble, blur in, jitter, drop in lines), re-authored |
