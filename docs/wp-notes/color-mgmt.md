# color-mgmt — colour management, HDR, LUT formats, custom OCIO

Workstream `color-mgmt` of the parity programme. It adds sequence working spaces, colour interpretation of media and
clips, camera log curves and gamuts, PQ / HLG with BT.2390 tone mapping, linear-light compositing, HDR exports with
metadata, every common LUT format, custom OpenColorIO configs, Lumetri HDR White / HDR Specular and an HDR scale for
the scopes. color-grade owns the rest of Lumetri and the scopes; imports owns the Interpret Footage dialog, which
gets a Colour section here.

## 1. Model

- **Working space** — `sequence.settings.workingColorSpace` (was `z.literal('rec709')`, now a string checked by
  INV-COLOR). The ids are `rec709` (default), `srgb`, `rec2020`, `p3d65`, `displayp3`, `rec2100-pq` and
  `rec2100-hlg`.
- **Sequence colour settings** — `settings.color` (optional, `SequenceColorSchema`; absent fields take read-time
  defaults):
  - `linearize` (Linearize Working Space; the UI and MCP offer it as the `<space>-linear` choices);
  - `blendLinear` (Blend Using 1.0 Gamma);
  - `autoToneMap` (Auto Tone Map Media, on by default);
  - `sdrWhiteNits` (HDR graphics white, 80–400, default 203 = BT.2408);
  - `hdrPeakNits` (the PQ mastering peak, 203–10 000, default 1000).
- **Colour interpretation** — `asset.interpretation.color` for media (Interpret Footage ▸ Colour) and
  `clip.colorInterpretation` for clips (the clip wins). Every field is optional; absent means automatic:
  - `space`: a `COLOR_SPACES` id (else taken from the stream tags);
  - `ocio`: `{configId, space}`, a space of an imported OCIO config;
  - `range`: tv / pc for log curves and LUTs;
  - `toneMap`;
  - `peakNits`: the PQ content peak (else MaxCLL or the mastering peak, else 1000);
  - `inputLut`: a `lut` media item applied first.
- **Media** — new media kind `color-config`, which holds a self-contained `.jocio` bundle with
  `asset.colorConfig = {name, spaces, roles, …}`. `VideoStream.hdr` carries the mastering display and MaxCLL /
  MaxFALL found by the probe. `LutInfo.format` covers every LUT format, plus `shaperSize`.
- **Commands** (all undoable; refusals are tested):
  - `sequence.updateSettings {workingColorSpace, color}`;
  - `media.interpretColor {mediaIds, color: patch | null}`;
  - `clip.setColorInterpretation {clipIds, color}`.

  `effect.add` refuses internal effects. `clip.place` refuses `color-config` media. New Sequence from HDR media picks
  the matching HDR working space.
- **Invariants and repairs** — `colorIssues` / `repairColor` (INV-COLOR):
  - unknown spaces are reset;
  - dangling LUT and OCIO references are dropped;
  - stray copies of the internal input effect are removed.

  No `CURRENT_SCHEMA_VERSION` bump.

## 2. Colour science (`packages/project/src/color/cms/`)

**Transfer functions** (`transfer.ts`):
- sRGB, BT.1886 (2.4), gamma 2.2 / 2.6, the BT.709 / BT.2020 OETFs;
- SMPTE ST 2084 PQ;
- ARIB STD-B67 / BT.2100 HLG, with the system gamma `1.2 + 0.42·log10(Lw/1000)`;
- ACEScct and ACEScc.

**Camera log curves** (`log.ts`, 18). Each one comes from the maker's published document, cited in the file header:
- Sony: S-Log, S-Log2, S-Log3;
- Panasonic: V-Log;
- Canon: Canon Log, Canon Log 2, Canon Log 3;
- ARRI: LogC3 (EI 800), LogC4;
- Apple Log;
- DJI: D-Log;
- RED: Log3G10;
- Blackmagic: Film Gen 5 and DaVinci Intermediate;
- Fujifilm: F-Log, F-Log2;
- Nikon: N-Log;
- Kodak: Cineon.

Signal domains are 10-bit code value or IRE-normalised. `signalFromNormalized` makes one formula serve both limited-
and full-range files.

**Gamuts** (`gamut.ts`, 16):
- BT.709, BT.2020, P3-D65, P3-DCI;
- ACES AP0 and AP1;
- S-Gamut3, S-Gamut3.Cine, V-Gamut, Cinema Gamut;
- ARRI Wide Gamut 3 and 4;
- D-Gamut, REDWideGamutRGB, Blackmagic Wide Gamut Gen 5, DaVinci Wide Gamut.

Matrices are built with the RP 177 normalised primary matrix. White points are adapted with Bradford.

**HDR** (`hdr.ts`):
- the BT.2390-10 EETF, applied to max(RGB) as a ratio so hue is kept;
- ACES Reference Gamut Compression 1.0 with the published per-channel thresholds and limits, used for scene gamuts;
- luminance-preserving desaturation into a display gamut;
- reference white 203 cd/m², with R = cd/m² ÷ 203.

**Transforms** (`transform.ts`):
- `inputTransformFn(source → working)` and `outputTransformFn(working → output)`.
- Scene-referred sources go through the BT.2408 OOTF (Y^0.2, so 18 % grey lands at 26 cd/m²). They are tone mapped
  with the EETF when the target cannot hold them.
- `gradeSpace`: Lumetri grades HDR in a signal normalised to HDR White, following FilmCraft `grade.rs`.

## 3. Pipeline

- **Composite signal.** The composite holds the working space's encoded signal.
- **Input transforms.** Every source gets the internal colour effect `jasper.color-input`, which the render snapshot
  prepends to the layer's colour run. It is baked with the rest of the run into the existing 33³ tetrahedral LUT, so
  preview (GL colour stage), native export (`lut3d`) and Remotion all run the same maths with no new renderer path.
  Run keys gain `workingKey(info)`, which is `''` for the default Rec. 709 settings, so existing projects and caches
  are unchanged.
- **Graphics.** Text, shapes, solids, captions, mattes and the background are treated as SDR BT.709. They are
  converted when the working space differs, and SDR white maps to `sdrWhiteNits` in an HDR space.
- **Signal proxies.** Media whose tags make the browser convert colours (HDR, BT.2020, P3) are marked
  `browserDecodable: false`. Their proxy converts YUV → R'G'B' with the file's own matrix and is tagged BT.709, so
  R'G'B' is unchanged and the preview sees the same signal as ffmpeg.
- **Display stage** (`compositions/src/color/DisplayStage.tsx`). This is preview only. The Program monitor captures
  the composite through HTML-in-Canvas and draws it through the display LUT:
  - Rec. 2020 / P3 working spaces are mapped into Rec. 709 primaries;
  - HDR working spaces are tone mapped with BT.2390 into a 65³ LUT.

  Renders keep the working signal. A real HDR display output is not done (§7).
- **Linear-light compositing** (Blend Using 1.0 Gamma, or Linearize).
  - Every layer is composited by the GL compositor (`fx/composite.tsx`). Each pass decodes the stored stack and the
    layer with the working curve (`cm_toLinear`), blends, and re-encodes. The stack therefore stays stored encoded in
    RGBA8, and rgba16f intermediates are not needed: precision is that of the encoded signal.
  - Chrome never fires `paint` on an HTML-in-Canvas canvas nested inside another one. I measured this on Chrome 150:
    no paint event for the inner canvas, not even after `requestPaint()`. So all tracks of a linear run share **one**
    blend scope under the lowest track (`linearGroupItemsAt`). The upper tracks' transition mattes are drawn as
    matte items. An adjustment layer starts a new run.
  - Every `<HtmlInCanvas>` of the compositions now goes through `ScopedHtmlInCanvas` (`fx/canvas-scope.tsx`):
    - a render that would nest two scopes fails at once with **CANVAS_NESTED**, naming both, instead of the old
      58-second "waiting for first paint" timeout;
    - the Player shows such content without the inner chain, with a chip;
    - the display stage steps aside, with a chip, whenever a scope registers inside it.
  - The native compositor blends encoded values, so the planner refuses the native path for linear blending and the
    Remotion path renders it.
- **Exports** (`apps/engine/src/color/output.ts`).
  - Output space: the working space, or any output space chosen in Export ▸ Colour Space.
  - Every path (native, hybrid, Remotion) ends with `outputFilters`, which applies the working → output LUT plus the
    frame tags, and with the encoder's tags and pixel format.
  - 10-bit output: ProRes (`prores_ks`), AV1 (SVT-AV1; libaom also 12-bit) and VP9 (also 12-bit).
  - HDR metadata:
    - SVT-AV1 gets `mastering-display` and `content-light`;
    - MP4 / MOV get ISO BMFF `mdcv` / `clli` boxes patched into the sample entry after the encode (`hdr-boxes.ts`;
      chunk offsets move when `moov` precedes `mdat`).
  - Planner warnings: `HDR_8BIT` and `HDR_METADATA_UNSUPPORTED`.
  - 10-bit H.264 is refused.
  - Stills of HDR sequences are the display rendition, through the same LUT.
- **LUTs.**
  - `.cube`: 1D-only, and 1D shaper + 3D with correct shaper and input-range semantics.
  - `.3dl`: reader and writer; blue changes fastest; non-uniform mesh shaper.
  - `.spi1d`, `.spi3d`, `.csp`.
  - Interpolation is tetrahedral on every path: CPU, the GL colour stage, `fx_lut3d` for GPU-effect LUT parameters
    (now `texelFetch` tetrahedral), and ffmpeg `lut3d=interp=tetrahedral`.
- **Custom OCIO** (`color/ocio/`).
  - `.ocio` imports become `.jocio` bundles: the config text plus every referenced LUT/CDL file.
  - The parser is a YAML subset. It reads v1/v2 colour spaces, display colour spaces, view transforms, roles and
    displays, and the transforms listed in `config.ts`.
  - Anything unsupported (ACES output transforms, looks, context variables) is reported and **refuses** the
    conversion. It never passes colours through.
  - Media can be interpreted as a space of a config, related through its interchange roles.
  - S_OCIOTransform gets `Config: Custom` (`config`, `configFile`, `fromSpace`, `toSpace`). The conversion is baked
    into a 33³ LUT and bound like any LUT parameter.
- **Lumetri.** HDR White (after Input LUT) and HDR Specular (after Blacks) appear in HDR sequences (`lumetriHdrFn`).
- **Scopes.** The waveform and parade get a cd/m² scale for PQ / HLG sequences (toggle, remembered). The scopes read
  the selected clip's graded picture, which is in the working signal, so the scale is exact.

## 4. Usage

- **Properties ▸ Colour** (no clip selected), or **Sequence ▸ Sequence Settings ▸ Colour**: working space (with the
  linear variants), Blend Using 1.0 Gamma, Auto Tone Map Media. The dialog also has HDR graphics white (100 cd/m² =
  51 % PQ / 63 % HLG … 300 cd/m²) and the PQ mastering peak.
- **Project panel ▸ Interpret Footage ▸ Colour.** This is imports' dialog; the Colour section is order 60, after
  Loop. The fields:
  - the detected space;
  - an override (log profiles included);
  - range, tone mapping, PQ peak, input LUT;
  - or a space of an imported OCIO config.

  **Clip ▸ Colour Space…** sets the same fields on selected clips.
- **Export:**
  - Colour Space (Working or any output space);
  - Bit Depth (Automatic = 10-bit for HDR and ProRes; 8 / 10 / 12);
  - MaxCLL / MaxFALL for HDR outputs.

  The choice is remembered per sequence.
- **Import:**
  - `.cube`, `.3dl`, `.spi1d`, `.spi3d`, `.csp` (LUT media);
  - `.ocio` (colour config).
- **MCP** (`apps/mcp/src/tools/color-mgmt.ts`):
  - `list_color_spaces`, `get_color_settings`, `set_working_color_space`;
  - `interpret_footage_color`, `set_clip_color_space`, `import_ocio_config`;
  - the `COLOR_MGMT_GUIDE` resource;
  - `grade_clip` gains `hdrWhite` / `hdrSpecular`;
  - `start_export` gains `video.colorSpace`, `bitDepth` and `hdrMetadata`.

## 5. Verified behaviour (measured)

**`packages/project/test/color-mgmt-science.test.ts`** (32). Every result below was measured by the test:
- **PQ** against ST 2084 reference values: 100 / 1000 / 10 000 cd/m² → 0.5081 / 0.7518 / 1.0.
- **HLG** against BT.2100: OETF(1/12) = 0.5, and the system gamma.
- **Log curves:**
  - published reference points for every log curve (18 % grey and 90 % white code values);
  - encode/decode round trips across the range.
- **Bradford** D65 → D50 against Lindbloom.
- **Gamut matrices:** BT.709 → BT.2020 against BT.2087.
- **Gamut handling:**
  - P3 lies inside BT.2020;
  - RGC leaves in-gamut colours unchanged, compresses towards the published limits, and is monotonic.
- **BT.2390 EETF:** identity below the knee, the target peak reached, monotonic.
- **Transforms:** input and output transforms are inverse where defined.

**`packages/project/test/color-mgmt-luts.test.ts`** (16):
- `.cube` 1D-only and shaper + 3D;
- `.3dl` read/write round trip;
- `.spi1d`, `.spi3d`, `.csp`;
- tetrahedral sampling equals brute-force tetrahedra;
- the input range is honoured;
- malformed files are refused (fuzz).

**`color-mgmt-ocio.test.ts`** (12): v1/v2 configs, roles, displays and views, every transform kind, CDL, refusal of
unsupported transforms, YAML depth limits.

**`color-mgmt-model.test.ts`** (16): commands with undo/redo and refusals, invariants and repairs, the snapshot input
effect, Lumetri HDR.

**`packages/compositions/test/blend-gl.test.ts`** (GL, headless Chrome): the compositor blends in linear light of
BT.1886, sRGB and PQ, and matches the TS maths.

**`packages/compositions/test/color-mgmt.test.tsx`** (5): linear-run planning and the nested-canvas guard (render
error, Player fallback).

**`apps/engine/test/color-mgmt.test.ts`** (9, real LGPL ffmpeg, ffprobe):
- HLG working space → AV1 10-bit: BT.2100 HLG tags, graphics white at 75 % HLG, mastering metadata.
- PQ → ProRes: `smpte2084` tags, plus `mdcv` / `clli` boxes read back by ffprobe.
- PQ exported as Rec. 709: BT.2390 tone mapped and tagged BT.709.
- Rec. 2020 SDR: BT.709 red converted (BT.2087).
- 10-bit H.264 refused.
- HDR stills: the display rendition.
- An HLG source is detected from its tags, its HDR metadata is probed, and it is tone mapped into Rec. 709.
- A `.3dl` look grades like its `.cube` twin.
- An offline input LUT gives the plan warning `LUT_OFFLINE` naming the clip (one more test, 9 in all).

**`apps/engine/test/color-mgmt-remotion.test.ts`** (REMOTION_E2E=1, Chrome 150):
- PQ + Blend Using 1.0 Gamma, with a 50 % white solid over black and a text layer. The still is the display
  rendition:
  - corner **190.0** (expected 190.4; encoded blending would give 69.2);
  - text maximum **230** (expected 230.3).
- An adjustment layer between linear-light tracks fails with **CANVAS_NESTED** in seconds.

**`apps/web/test/color-mgmt.test.tsx`** (5): the dialog, the Interpret Footage section commands, the export colour
choice. **`apps/mcp/test/color-mgmt.test.ts`**: the tools end to end on an engine.

**`e2e/color-mgmt.spec.ts`** (Playwright, built app, HTML-in-Canvas on):
- Properties ▸ Colour → Rec. 2100 PQ: the Program monitor shows graphics white through the display transform
  (> 225, expected 230; the raw signal would be 148).
- Blend Using 1.0 Gamma: the monitor shows the linear-light mix, 130 ± 3 (encoded: 74), with the display stage's
  chip.
- Export ▸ ProRes, Working, Automatic, MaxCLL 203 (Remotion path):
  - `yuv422p10le`, `smpte2084` / `bt2020` / `bt2020nc`;
  - Mastering display and Content light level side data, with MaxCLL 203;
  - the centre pixel is 130 ± 3.

  Screenshots: `test-results/color-mgmt-*.png`.

**Regressions checked.** The keyframes-blend Remotion e2e, the edit-structure render e2e and the fx render e2e all
pass with the scope changes (44 tests).

## 6. Comparison with the references

- **FilmCraft `crates/color`.**
  - **Equal:** S-Log3, V-Log, Canon Log 2/3, LogC3, LogC4, Apple Log and D-Log (ported); the BT.2390 EETF;
    desaturation; the HDR grading signal; the `.cube` / `.3dl` semantics.
  - **Better:**
    - more curves and gamuts (S-Log/S-Log2, Canon Log, RED, Blackmagic Gen 5, DaVinci, Fujifilm, Nikon, Cineon,
      ACEScc/cct);
    - per-channel ACES RGC 1.0 parameters (FilmCraft used one threshold/limit);
    - Bradford adaptation;
    - P3 / sRGB working spaces;
    - `.spi1d` / `.spi3d` / `.csp`;
    - HDR metadata written into the files.
- **EffectCraft `crates/effects/src/{ocio,ocio_config}.rs`.**
  - **Equal:** the v1 config subset.
  - **Better:**
    - v2 display colour spaces and view transforms;
    - ExponentWithLinear, LogCamera, FixedFunction, ExposureContrast, Allocation;
    - Builtins for every camera curve we have;
    - self-contained bundles;
    - refusal instead of a pass-through.
  - **Not ported:** ICC (`icc.rs`). It was optional in the scope.
- **Premiere Pro.** Sources: helpx.adobe.com "Color management in Premiere Pro", "Sequence settings — Color", "Interpret
  footage", "HDR workflows", and "Lumetri Color panel — HDR White / HDR Specular".
  - **Matched:** working spaces Rec. 709 / Rec. 2100 PQ / HLG plus the wide-gamut SDR spaces; Linearize Working Space;
    Blend Using 1.0 Gamma; Auto Tone Map Media; HDR Graphics White (100 / 203 / 300); Interpret Footage ▸ Colour
    Space Override; log auto-detection from tags.
  - **Our choices where Adobe's behaviour is undocumented:**
    - 203 cd/m² as SDR white (BT.2408);
    - BT.2390 on max(RGB) for tone mapping;
    - ACES RGC for scene gamuts.

## 7. Limits

- **HDR display output.** Not implemented: it needs HDR display hardware and an HDR canvas in Electron/Chrome. The
  Program monitor shows HDR tone mapped to Rec. 709.
- **Display stage step-aside and scope nesting: lifted by the compositor workstream**
  ([compositor.md](compositor.md)). Stacks whose scopes would nest (Blend Using 1.0 Gamma around adjustment layers,
  GPU blends with adjustment layers or 3D runs, DOM layers with effects under scopes) are drawn by one flat compositor,
  and the display transform runs as its last step instead of stepping aside.
- **Linearize Working Space** = linear-light compositing. GPU effects and Lumetri still see the encoded working signal.
- **Linear-light compositing** renders on the Remotion path only; the native compositor blends encoded values, and the
  planner refuses native.
- **Composite precision.** The composite is 8-bit (DOM / native RGBA8). HDR working spaces keep PQ / HLG encoded
  precision, not float.
- **No HEVC Main10** in the LGPL ffmpeg build: kvazaar is 8-bit only. HDR exports use ProRes, AV1 or VP9.
- **VP9 / WebM** carries the colour tags but no mastering / MaxCLL metadata (warning `HDR_METADATA_UNSUPPORTED`).
- **MaxCLL / MaxFALL** are user-entered, not measured from the frames.
- **Custom OCIO in S_OCIOTransform** is a 33³ LUT over 0…1 inputs. Scene-linear values above 1 clip there; the input
  interpretation path uses the exact function. ACES output transforms (RRT/ODT), looks and context variables are
  refused.
- **EXR / Radiance HDR stills** are read as their sRGB-decoded 8-bit signal (imports' float stills are decoded by the
  browser).
- **Offline LUT or colour config.** A LUT or colour config that is offline (grades, input LUTs, OCIO
  interpretations) skips the colour step that uses it. The export plan warns `LUT_OFFLINE` and names the clips
  (tested); the render log says the same. This is the M2 behaviour for Lumetri LUTs, now announced.
- **Effect colour parameters** (e.g. a fill colour) are working-space values, not converted from Rec. 709.
