# Lottie export mapping (workstream imports)

- **Upstream:** https://github.com/storytold/effectcraft (commit `2fadd14`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** workstream `imports`, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/lottie/src/export.rs` | `packages/project/src/lottie/export.ts` | exporter structure: one warning per feature Lottie cannot carry, precomp assets for nested compositions, base64 image assets, layer timing (`ip`/`op`/`st`/`sr`), mask modes, blend-mode code table, composition markers — TypeScript, mapped onto the editor's sequences and clips |
| `crates/lottie/src/anim.rs` | `packages/project/src/lottie/export.ts` (`prop`, `bake`) | keyframe export: hold keys, normalised Bézier `o`/`i` from the temporal ease, spatial `to`/`ti`, `r6` rounding — rewritten for our influence/slope ease |
| `crates/lottie/src/shapes.rs` | `packages/project/src/lottie/export.ts` (`shapeItems`, `shapeValue`, `strokeFields`, `shapeTransform`, `gradientValue`) | shape contents → Lottie shape items (groups, paths, fills, strokes, gradients, trim, repeater, offset, round corners) |
| `crates/lottie/src/text.rs` | `packages/project/src/lottie/export.ts` (`textDocument`, `fontName`, `textAnimators`) | text document (`t.d.k`), font list, text animators |
| `crates/lottie/src/export.rs` (`to_dotlottie`) | `apps/engine/src/imports/lottie-export.ts` | dotLottie v1 layout (`manifest.json` + `animations/<id>.json`) |

Notes: the Lottie parser and validator (`packages/project/src/lottie/parse.ts`), the ZIP reader (from the PKWARE
APPNOTE), the PSD, PDF and SVG handling (ag-psd, pdf.js, the shapes workstream's SVG converter) and everything else in
this workstream are our own work; EffectCraft's Lottie *import* (Lottie → editable layers) was not ported — the editor
plays Lottie documents with lottie-web instead.
