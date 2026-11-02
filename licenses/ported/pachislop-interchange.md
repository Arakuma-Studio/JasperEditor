# Pachislop: interchange and delivery

- **Upstream:** https://github.com/SafEight/pachislop
- **Commit:** `dd952d0`
- **Licence:** `LicenseRef-Pachislop`
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks interchange stream, 2026-11-02

| Upstream path | Local path | What |
|---|---|---|
| `src/io/psd.ts` (`stackPlan`, `titleParts`, `resolutionInfo`, section-divider records) | `apps/engine/src/export/delivery/psd-plan.ts`, `psd-job.ts`, `psd-writer.ts` | Each picture rendered alone into the frame; a baked layer standing in for what is below it; a title split into rims, face and `fx`; groups as flat records with their end marker |
| `src/io/psStyle.ts` (`psdStyles`, `aslStyles`, `layerSource`, the `GrdT.decode` extension) | `apps/engine/src/title-looks/ps-styles.ts` | Reading the layer styles of a `.psd` and an `.asl`, and the Shape Burst decoder |
| `src/io/psStyle.ts` (`convertPsStyle`, `colorHex`, `gradientStops`, `gradientFill`, `toPx`, stroke ordering) | `packages/project/src/title-looks/ps-style.ts` | Colour models to sRGB, gradient stops and angles, units, strokes ordered by reach, shadow angles, Scale Effects |
| `src/ui/PsStyleImport.tsx`, `src/ui/PsStyleDialog.tsx` | `apps/web/src/delivery/LayerStyleDialog.tsx` | The per-style dialog: confirm the reference size, see what mapped |
| `src/io/export.ts` (`measure`, `alphaBounds`, `touchesEdge`, probing on an enlarged canvas) | `apps/engine/src/export/delivery/alpha.ts`, `trim.ts`, `frames.ts` | Measured trim with a margin, on a canvas larger than the frame |
| `src/io/imageSplit.ts` (`labelIslands`, `clusterIslands`, `partsOf`, `cutParts`, `CUT_PAD`, `CUT_ALIGN`) | `packages/project/src/image-split/index.ts` | Alpha islands on a working grid, merge distance, cut at full resolution |
| `src/ui/SplitImageDialog.tsx` | `apps/web/src/delivery/SplitImageDialog.tsx` | Tinted parts, click and Shift-click to merge and split |

## Changes made when porting

- PSD: blockers and the list of what is baked come before anything is written; upstream's warnings arrive after the
  download. Upstream builds the file in one synchronous buffer with every layer in memory; here each layer goes through
  ag-psd alone, its channels go to a scratch file, and the file is streamed together, written atomically, in a cancellable
  job with capped memory. Frames come from the shared compositions and a clip's blend mode and opacity go on the layer.
- A look's parts keep every other layer at zero opacity, so rims keep their growth instead of having widths rewritten.
- Layer styles: values pass a zod schema at the boundary and every effect lands in the report: `mapped`, `approximated` or
  `unsupported`, by name. Overlays stack as `face` layers instead of being mixed into one colour, so they stay editable. Layer
  types are looked up in the catalogue, so a missing type is reported rather than assumed.
- File sizes, style counts and lengths read from a file are capped, and a lying length ends the read with a named skip.
- Measured trim: the union over every frame of an animated clip, since upstream exports stills.
- Split: pixels are straight bytes moved by the engine, 8 or 16 bits, decoded and encoded by ffmpeg. Upstream reads and
  encodes through a canvas, which premultiplies and loses the colour of low-alpha pixels.
