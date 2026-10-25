# imports — Lottie, SVG, PDF/AI, PSD, image sequences, still formats, Interpret Footage, Lottie export

Workstream `imports` of the parity program. Everything a user or an agent can change is an undoable document command
(`packages/project`), shown by the Program monitor and the Remotion renders (`packages/compositions`), rendered by the
native export (the `imports` native extension and the decode helpers in `apps/engine/src/imports/`), with UI, MCP
tools and tests. Ported code: `licenses/ported/imports.md` (the Lottie export mapping, after EffectCraft's
`crates/lottie`, MIT OR Apache-2.0). New dependencies (all permissive): `ag-psd` 31.0.2 (MIT, engine), `pdfjs-dist`
4.10.38 (Apache-2.0, engine and compositions; 4.x because 5+ needs Node 22), `lottie-web` 5.13.0 (MIT, compositions).

## 1. Model (schema additions, all optional, no version bump)

`packages/project/src/schema/media.ts`, every field optional on `MediaAsset`:

| Field | Meaning |
|---|---|
| `interpretation` | Interpret Footage: `frameRate` (assume this rate), `pixelAspect` (conform to), `fieldOrder` (`progressive` / `upper` / `lower`), `alpha` (`{mode: straight / premultiplied / ignore, matte?, invert?}`), `loop` (1…1000). Absent field = the file's value. |
| `vector` | SVG / PDF / Illustrator still: `format` `svg`/`pdf`, size at 100 % (CSS px / PDF points), `page`, `pageCount`, `source` `svg`/`pdf`/`ai`. |
| `lottie` | Lottie header: `fps`, `inFrame`, `outFrame`, size, version, name, layer count, dotLottie origin, player warnings. |
| `imageSequence` | The numbered stills a clip was conformed from: pattern, directory, first/last number, frames, missing numbers, still format, import rate. |
| `layered` | Photoshop document header: `psd`/`psb`, size, layer count, colour mode, bit depth. |
| `layerSource` | A layer imported on its own: document, layer name, index, enclosing groups. |
| `VideoStream.fieldOrder` | ffprobe's field order (`tt`/`tb` = upper first, `bb`/`bt` = lower first). |

The **time model** (`packages/project/src/interpret/model.ts`): a clip's content times (`sourceIn`, keyframes, remap
`source`) are *interpreted media time*. The file is read at `fileTime = (t mod loopPeriod) · scale`, `scale = assumed /
file rate`. Uninterpreted media have no map, so every existing document reads exactly as before. The interpreted
duration (`mediaDurationFlicks`) is what placement, trims, invariants (INV-005), Speed/Duration and the Project panel
use; `mediaDisplaySize` (rotation, then the pixel aspect ratio stretches the stored width) is every path's layer box.
Video clips whose media has a time map go through the frame-exact `retime` pipeline of workstream `time` (mediabunny
in the preview, FFV1 intermediates on the native path), so an assumed rate picks exactly the file frame
`floor(fileTime · fileRate)`.

**Pixel interpretation** (`pixelInterpretation`, `pixelVariantKey`, `pixelInterpretationFilters`): deinterlace with
`bwdif` (send_frame, field parity, LGPL), then alpha: `format=rgba`, `lutrgb=a=maxval` (ignore), `unpremultiply`
(premultiplied over black) or a `geq` formula `C = (C' − (1 − α)·M)/α` (matted with colour M), `lutrgb=a=negval`
(invert). The canonical key (e.g. `fo=upper;a=premultiplied;m=000000;inv=1`) names the cached derivative.

Invariants: INV-012 reports interpretation sections the media cannot carry; `repairDocument` drops them
(`drop-interpretation`). Nested-sequence content keys include interpretation / vector / Lottie descriptors.

## 2. Commands

| Command | Owner | What |
|---|---|---|
| `media.interpret {mediaIds, interpretation}` | `imports` | Absent field = unchanged, `null` = back to the file's value; `loop: 1` and a straight non-inverted alpha are normalised away. Clips that would show time past the new media end are trimmed (warning `W_CLIPS_TRIMMED`, result `trimmedClipIds`); frame holds past the end move to the last frame; a clip whose In point is past the new end and time-remapped clips that would leave the media are refused (`E_OUT_OF_MEDIA`). |
| `media.register` (changed) | core | Deduplication compares the PDF page too: the pages of one file are different media. |

Layered imports are not a new command: `layeredImportCommands` (`interpret/layered.ts`, pure) builds the commands of
one transaction — `bin.create` "‹doc› Layers", one `media.register` per chosen layer (`layerSource`), and for
**Sequence** a `sequence.create` of the document size, one `track.add` + `clip.place` per layer (bottom layer
lowest), `param.set` position `[left + w/2, top + h/2]`, opacity (layer × fill), `clip.update {blendMode, enabled}`,
a Track Matte Key (Matte Alpha, reading the base layer's track) for clipping masks, isolating groups (blend mode other
than Pass Through, opacity < 100 %, group mask) as nested sequences, pass-through groups flattened into the parent.
Photoshop blend modes map to the same-named editor blend modes (keyframes-blend list); Linear Dodge = Add,
Pass Through = Normal; `psdBlendMode` maps every ag-psd name and notes unknown ones.

## 3. Engine (`apps/engine/src/imports/`, routes `routes/imports.ts`)

- **Probers** (`probers.ts`): Lottie `.json` (only when it parses as Lottie) and `.lottie` (dotLottie ZIP: manifest,
  first animation, images embedded); SVG/SVGZ (`svgDocumentSize` from the `svg` subsystem), PDF and `.ai`
  (`pdfjs-dist` page sizes, `/Rotate` and CropBox applied; password-protected PDFs refused); PSD/PSB (`ag-psd`
  headers, ffprobe fallback). Still formats through ffmpeg's LGPL build: EXR (half/float, shown with the sRGB transfer
  via `-apply_trc iec61966_2_1`), 16-bit TIFF, TGA (alpha), BMP, 10-bit DPX, HEIC/HEIF (an HEVC still in an HEIF container), JPEG XL,
  Radiance HDR (zscale to sRGB). `BROWSER_IMAGE_CODECS` decides what a browser can show.
- **Interpreted pictures** (`variants.ts`, job kind `interpret`): `display` = full-size straight-alpha PNG of a still
  (16-bit for deep sources; PSDs via our compositor when the file has no real merged image), `proxy` = 720p preview of
  an interpreted video (VP9 with alpha when it has one), `master` = full-size ProRes 4444/422 HQ for the Remotion
  path. Cached by fingerprint + variant key; `POST /api/media/:key/variants` (idempotent), `GET
  /media/:key/variant/:kind?v=`, event `media.variant.ready`. Child jobs of an export run with `cpuSlots 0`,
  `parentId` (no deadlock while the export holds every slot).
- **Image sequences** (`sequence.ts`, job `image-sequence`): from one frame path (siblings found), a list of paths,
  or uploads (`purpose: 'sequence-frame'`); grouped by `groupImageSequences` (last digit run, padding kept apart,
  widths that outgrow their padding stay one sequence); conformed through an ffconcat list to a lossless FFV1
  mezzanine at the chosen rate (`bgra` 8-bit, `gbrp16le`/`gbrap16le` deep, `gray`, `yuv`), gaps hold the previous
  frame. The asset is ordinary video afterwards (posters, filmstrips, proxies, every export path).
- **Layers** (`layered.ts`, `psd.ts`, `raster.ts`, job `layers`): every layer extracted as a PNG with its layer mask
  and vector mask (4×4 supersampled coverage rasteriser) applied to alpha, registered as media; groups, visibility,
  opacity × fill opacity, blend mode, clipping, bounds, notes for what cannot be carried. Merged Layers composites the
  chosen layers with the shared blend kernel (`makeBlendKernel`).
- **Native export** (`extension.ts`, `export/native.ts`, `retime/*`, `audio/decode.ts`): decoder args and source
  filters for video and stills, `display` PNGs for stills ffmpeg's image2 demuxer cannot loop (HEIC/PSD), time maps
  for the retime planner (`fileTimeOf`) and audio (seek to the file time, `asetrate` by the time scale so the sound
  follows the picture like a rate change, `-stream_loop` for loops). Lottie and vector clips are DOM layers: the native path bakes them with the layer-bake service (the same
  composition as the preview), the Remotion path draws them directly. `adaptRemotionDoc` gives Remotion renders the
  interpreted `master` / `display` pictures and signed loader URLs.
- **Lottie export** (`lottie-export.ts`, `POST /api/imports/lottie/export`): reads stills (display PNG when needed)
  and Lottie documents, runs the pure exporter, writes `.json` or dotLottie v1 (`manifest.json` +
  `animations/<id>.json`, stored ZIP).

`pdfjs-dist` stays external in the engine bundle (it loads its worker module from its own files) and is staged with
the runtime closure by the desktop packager; checked by running `dist/engine.mjs` and registering a PDF.

## 4. Preview and Remotion renders (`packages/compositions`)

- `LottieLayer`: lottie-web's SVG renderer (lazy-loaded), document from `/media/<key>/lottie.json`,
  `goToAndStop(frame, true)` with `frame = lottieFrameAt(info, fileSeconds)` — Frame Sampling like footage, so a 25
  fps animation in a 29.97 sequence shows whole Lottie frames; `delayRender` until the DOM and images are loaded.
- `VectorLayer`: SVG as a sandboxed `<img>` (no scripts, no external resources; the engine serves it with
  `default-src 'none'`), PDF pages drawn by pdf.js into a canvas; the picture is made at `vectorRasterScale` × its size
  (largest Motion scale over the clip, rounded up to a power of two, picture ≤ 8192 px) and shown at its size, so a
  300 % scale stays sharp.
- Interpreted media: stills show the engine's `display` PNG, interpreted videos the `proxy` (preview) / `master`
  (render); while it is made, a "Preparing preview picture" card. `RetimedVideo` and `AudioLayer` read file time
  through `fileTimeOf` / `mappedAudioUrl` (mediabunny decode of the file pieces, resampled).
- Posters in the Project panel: SVG is its own poster, PDF pages and Lottie frames are drawn in the page.

## 5. UI (`apps/web/src/imports/`, `commands/imports.ts`)

- **Interpret Footage…** (Clip ▸ Modify, the Project panel's Modify section, the timeline clip menu): a section
  registry (`registerInterpretSection({id, title, order, applies, component, commands?})`) with Frame Rate (10),
  Pixel Aspect Ratio (20, Premiere's presets), Field Order (30), Alpha Channel (40: Premultiply Alpha with matte
  colour, Ignore Alpha Channel, Invert Alpha Channel) and Loop (50). OK applies the `media.interpret` patch and every
  section's own commands in one transaction. **`color-mgmt` adds its Colour section here** with `order > 50` and its
  own `commands`.
- **File ▸ Import** (and drops): numbered stills → Image Sequence prompt (groups, missing frames, frame rate; default
  the active sequence's); a multi-page PDF / AI → page prompt; a PSD → Import Layered File (Merge All Layers / Merged
  Layers / Individual Layers / Sequence, layer list top first, notes). The layers' commands join the import's single
  transaction (one undo step). Timeline documents keep going to the interchange importer.
- **File ▸ Import SVG as Shape Layer…** and the Project panel's **Create Shape Layer** on SVG items use
  `svgToShapeContents` (shapes §7) and add a vector shape clip at the playhead (warnings for what shapes cannot
  express).
- **File ▸ Export ▸ Lottie…**: format (`.json` / `.lottie`), range (entire / In–Out), then the layer count, a
  download link and the list of what was not carried.
- The media runtime requests interpreted pictures and repeats the (idempotent) request until the picture is ready,
  so a ready event that raced the answer cannot leave a still pending.

## 6. Agents (MCP `apps/mcp/src/tools/imports.ts`, guide `IMPORTS_GUIDE`)

`get_media_interpretation`, `interpret_footage` (fps as a number or rational; null resets), `detect_image_sequence`,
`import_image_sequence`, `list_document_layers`, `import_layered_document` (merged-all / merged / individual /
sequence), `import_pdf_pages`, `export_lottie`. Lottie, SVG and the still formats import with `import_media`;
`svg_to_shape` (shapes) converts SVG markup. Strict arguments (unknown keys rejected); `media.interpret` is in
`describe_commands`. Every control of the new dialogs has a stable automation id (checked in `e2e/imports.spec.ts`).

## 7. Lottie export (`packages/project/src/lottie/export.ts`)

Lottie `v` 5.12.0. Shape clips (vector contents: paths, rect/ellipse/polystar, fills, strokes with dashes, gradient fills and strokes,
groups with transforms, trim paths, repeaters, offset paths, round corners, pucker & bloat, twist, zig zag, merge
paths), shape/solid clips, text (font, size,
tracking, leading, justification, fill/stroke, text animators with one range selector), stills (embedded PNG/JPEG),
nested sequences (precomps), Lottie clips (their document as a precomp). Transforms, opacity, masks (mode, opacity,
expansion, feather as `f`), Gaussian Blur (`ty` 29), blend modes with a Lottie code, sequence markers. Keyframes:
hold, linear and Bézier eases converted exactly — our ease is influence + slope (relative to the average speed), so
`o = (influence, influence·slope)` and `i = (1 − influence, 1 − influence·slope)`; spatial `to`/`ti` from the
effective tangents; roving keys and expressions are baked one key per frame. Layer timing: `st = start − sourceIn /
F / rate`, `sr = 1 / rate`. Everything else is a warning (≈40 distinct messages: effects, video/audio, adjustment
layers, captions, reverse, time remap, styled runs, text on path, stroke taper/wave, Above Previous composite,
multi-camera…).

## 8. Verified behaviour

| Area | How it was verified (all measured) |
|---|---|
| Model / commands | `packages/project/test/imports-interpret.test.ts` (13): rates, display size with PAR + rotation, field-order mapping, variant keys round-trip (property), LGPL-only filters, file pieces cover ranges and agree with `fileTimeOf` (property), `media.interpret` set/reset/normalise/undo, trim with warning, refusals, repair, snapshot time map + retime + handle. |
| Formats | `imports-formats.test.ts` (14): sequence grouping (examples + fuzz), Lottie parse (validation + JSON fuzz + mutation fuzz), frame sampling, Lottie export layer types/warnings/range, **ease oracle**: the exported cubic-Bézier reproduces our keyframe evaluation within 0.005 (opacity 0–100) at 61 sample times; PDF page dedupe; PSD Sequence/Individual commands applied to a document with invariants clean. |
| Engine | `apps/engine/test/imports.test.ts` (9 declarations, real ffmpeg): stored ZIP wire/CRC + deflate + caller read cap, PSD aliases, probing of every fixture format, Lottie/SVG/PDF sources and pages, image-sequence conform (framemd5: frame 7 = frame 6, 12 frames, 1 s at 12 fps), PSD extraction (Badge group 80 %, blend modes, hidden layer, merged picture), EXR linear→sRGB display PNG with actual sub-8-bit precision, TIFF16 display PNG, Lottie export with embedded still + precomp + dotLottie, and **Alpha Channel on the native export** at a premultiplied (64,32,16)@α128 picture: straight → (32,16,8), premultiplied → (64,32,16), ignore → (64,32,16), ignore + invert → black, each ±5. |
| Native vs Remotion | `apps/engine/scripts/verify-imports.ts` against a live engine (720p, both paths exported, frames compared, mean \|Δ\| in 8-bit levels): Lottie 0.04–0.06, SVG at 300 % + PDF page 0.85, EXR 0.22–0.25, TGA 0.17–0.19, DPX 0.62, PSD 0.03–0.04, HEIC 0.22, JPEG XL 0.20–0.22, image sequence 0.00, 16-bit sequence 0.00, interlaced (deinterlaced) 0.06, anamorphic 0.71–0.73, premultiplied 0.18, assumed-rate conform 1.00 and **12/12 frames show the expected file frame on both paths** (frame code read). `cd apps/engine && pnpm exec tsx scripts/verify-imports.ts --engine http://127.0.0.1:<port>` |
| UI | `apps/web/test/imports.test.tsx` (11): dialog sections and one-undo apply, section registry with extra commands, prompts, import-flow expansion of PDF pages + PSD layers, variants requested / followed to ready / re-asked without events, Lottie export dialog. `packages/compositions/test/imports-layers.test.tsx` (4): Lottie frame with assumed rate and loop, vector picture scale. |
| MCP | `apps/mcp/test/imports.test.ts` (7) through the protocol. |
| Real app | `e2e/imports.spec.ts` on the built app (Chrome) **6/6**: Program monitor draws EXR + SVG + Lottie; PDF page prompt → two items; PSD → Sequence with blend modes; 11 numbered PNGs → one 12-frame clip with 7 held; Interpret Footage (25 fps, loop 2) in one undo step, all automation ids stable; Lottie export downloads a 5.12.0 document with text and precomp layers. Frames looked at: `/tmp/impt/verify/*` (Lottie identical on both paths, interlaced box without combing, anamorphic stretched). |

## 9. Comparison with the references

| | effectcraft | filmcraft | JasperEditor |
|---|---|---|---|
| Lottie import | converted into editable comps/layers (`crates/lottie/import.rs`); features without a native equivalent are lost | — | played frame-exactly by lottie-web (every feature lottie-web draws, expressions included) on all paths; not editable as layers (see Limits) |
| Lottie export | comps → Lottie with warnings, parenting, track mattes, some effects, text as glyphs optionally | — | sequences → Lottie with ≈40 warnings, exact eases (oracle-tested), shapes incl. repeaters/trim/offset, text animators, precomps, Lottie-in-Lottie; no parenting/track mattes (our model has neither as layer links) |
| SVG / PDF | own parsers + rasteriser, continuously rasterised, layers of AI files | — | browser SVG + pdf.js at the shown scale (power-of-two picture), page choice, SVG → shape layer; AI layers are not split |
| PSD | own reader, text layers, smart objects, writer for fixtures | — | ag-psd; flattened / merged / individual / Sequence with blend modes, opacity × fill, groups (nested when isolating), layer + vector masks, clipping masks; adjustment layers / styles noted |
| Image sequences | footage kind `Sequence` | numbering, gaps hold the previous frame, PNG/JPEG/TIFF/BMP/WebP/GIF | numbering (padding-aware), gaps held, any ffmpeg still incl. EXR/DPX 10/16-bit, conformed losslessly so every path and proxy work |
| Interpret Footage | rate, PAR, fields as separate fields (2× rate), alpha straight/premultiplied/ignore + matte, loop | export field order only | rate, PAR, field order (deinterlaced), alpha incl. invert, loop — in preview and every export path, extensible sections |
| Still formats | `image` crate + exr | still decoders | ffmpeg LGPL: EXR, TIFF 16, TGA, BMP, DPX, HEIC, JPEG XL, HDR, PSD |

## 10. Adobe sources (research)

- Premiere Pro, *Interpret footage*: helpx.adobe.com/premiere-pro/using/interpreting-footage.html (Frame Rate "Use
  Frame Rate from File / Assume this frame rate", Pixel Aspect Ratio "Conform to", Field Order, Alpha Channel
  "Premultiply / Ignore / Invert Alpha Channel"; Modify ▸ Interpret Footage).
- After Effects, *Import and interpret footage items*: helpx.adobe.com/after-effects/using/importing-interpreting-footage-items.html
  (Premultiplied – Matted With Color, Loop N times, Separate Fields).
- Premiere Pro, *Importing still images* / *Import numbered still-image sequences* / *Import layered Photoshop files*
  (Merge All Layers, Merged Layers, Individual Layers, Sequence; layer selection):
  helpx.adobe.com/premiere-pro/using/importing-still-images.html.
- Premiere Pro, *Supported file formats*: helpx.adobe.com/premiere-pro/using/supported-file-formats.html.
- Premiere Pro, *Pixel aspect ratios and frame aspect ratios* (D1/DV NTSC 0.9091, PAL 1.0940, widescreen variants,
  HD anamorphic 1.333, DVCPRO HD 1.5, anamorphic 2:1): helpx.adobe.com/premiere-pro/using/aspect-ratios.html.
- After Effects, *Create shapes from vector layers*: helpx.adobe.com/after-effects/using/creating-shapes-masks.html.
- Lottie: lottie-spec 1.0 (lottie.github.io/lottie-spec), LottieFiles "lottie-docs"; dotLottie 1.0 (dotlottie.io/spec).
- Adobe *Photoshop File Formats Specification* (through ag-psd), [PKWARE APPNOTE 6.3.10](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT) §§4.3.7/12/16 (ZIP wire fields), ISO/IEC 23008-12 (HEIF fixture writer).
- [W3C sRGB transfer](https://www.w3.org/TR/css-color-4/#color-conversion-code): scene-linear .25 maps to ≈.5371 (≈137/255); the imports display oracle uses a coarse ±1 code bound and verifies smaller-than-8-bit differences through independent RGB48 decoding. This is a format/precision oracle, not a pin of the FFmpeg option spelling.

**Undocumented by Adobe; our choices:** frame holds past a shortened media move to the last frame and other clips are
trimmed rather than left showing missing frames; ffmpeg's `tb`/`bt` count as upper/lower first (ffmpeg's own encoders
tag top-field-first frames `tb`); deinterlacing is one frame per frame (`bwdif` send_frame), Premiere's behaviour in a
progressive sequence; Lottie frames are sampled (floor), like footage; the image-sequence frame rate defaults to the
active sequence's.

## 11. Limits

- Lottie clips are not editable layers; the player's own random sequence drives `wiggle` and random selectors; GIF /
  WebP animations cannot be interpreted (they play natively in the browser).
- PDF fonts that are not embedded fall back to pdf.js's standard fonts; Illustrator layers are not split; EPS is not
  read.
- PSD: CMYK, Lab and multichannel layers are refused by ag-psd (the flattened picture still imports through ffmpeg);
  adjustment layers, layer styles, smart-object updates and text editability are not carried (noted in the dialog);
  clipped layers use the base layer's alpha through a Track Matte Key (the base layer's opacity does not fade the
  clipped one as in Photoshop); a group's blend mode applies to its nested sequence.
- Deinterlacing on the retime path runs per decoded chunk (`bwdif` at a chunk boundary sees one neighbour).
- An assumed frame rate on variable-frame-rate media scales its timestamps (no CFR conform).
- Lottie and vector media have no engine derivatives (poster, filmstrip sprite, proxy): their posters are drawn in
  the page, and their timeline clips show no filmstrip thumbnails.
- Lottie export has no layer parenting or track mattes (the editor has no layer links of that kind) and plays a
  looping Lottie clip once.
- Project Manager (collect / consolidate), listed in `docs/gaps.md` under imports, is not part of this workstream's
  scope and is not done.
