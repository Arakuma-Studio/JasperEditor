# Spec 06: Colour grading (Lumetri-style), LUTs and scopes

Status: functional spec, v1 (2026-10-01), milestone M2. Audience: the implementers of work package
`wp-m2-color` and reviewers. Architecture contracts: `docs/ARCHITECTURE.md` §19.2 (colour), §19.6 (native
extensions), §19.10 (UI extension points). When this spec and ARCHITECTURE disagree, ARCHITECTURE wins.

This spec is original work for JasperEditor. "Lumetri" names the familiar Premiere panel layout only; no Adobe
code, math or assets are used.

---

## 0. How to read this spec

- Requirement ids `CG-NNN` (grade model, math, rendering), `LUT-NNN` (LUT assets), `SCP-NNN` (scopes),
  `CGU-NNN` (UI), `CGA-NNN` (agents/MCP). Cite them as `S06:CG-010`.
- Priorities: **P0** = required for M2 acceptance, **P1** = expected in M2 if time allows, **P2** = later.
- "Both export paths" = the native ffmpeg path and the Remotion path (ARCHITECTURE §9.5).

## 1. Goals

1. A per-clip grade that a colourist recognises: basic correction, creative LUT with intensity, RGB curves, three
   colour wheels.
2. **The grade never forces the slow Remotion export.** Graded media-only sequences export on the native path
   at close to ungraded speed.
3. Preview and both exports agree: identical maths, one baked 3D LUT per colour run, the same interpolation.
4. Agents can grade through MCP with the same parameters the UI uses.

Non-goals (M2): HSL secondary / qualifiers, vignette, sharpen, colour match, HDR/wide-gamut working spaces,
masks, adjustment-layer grading (adjustment clips remain unimplemented), scene-referred ACES pipelines.

## 2. Model

### 2.1 The `jasper.lumetri` effect

- **CG-001 (P0)** Grading is an ordinary effect instance (S01 §11) with id `jasper.lumetri`, version 1, category
  `Color Correction`, `appliesTo: 'video'`. A clip may carry several instances (stacked grades); each is a normal
  entry of `clip.effects` and is reordered, bypassed, copied and keyframed like any other effect.
- **CG-002 (P0)** Parameters (names are the contract; `group` = editor section):

| Group | Param | Type | Range (default) | Animatable |
|---|---|---|---|---|
| basic | `inputLut` | media (`mediaKinds: ['lut']`) | – (none) | hold |
| basic | `temperature` | number | −100…100 (0) | yes |
| basic | `tint` | number | −100…100 (0) | yes |
| basic | `exposure` | number, stops | −5…5 (0) | yes |
| basic | `contrast` | number | −100…100 (0) | yes |
| basic | `highlights` | number | −100…100 (0) | yes |
| basic | `shadows` | number | −100…100 (0) | yes |
| basic | `whites` | number | −100…100 (0) | yes |
| basic | `blacks` | number | −100…100 (0) | yes |
| basic | `saturation` | number, % | 0…200 (100) | yes |
| creative | `look` | media (`['lut']`) | – (none) | hold |
| creative | `lookIntensity` | number, % | 0…100 (100) | yes |
| creative | `vibrance` | number | −100…100 (0) | yes |
| curves | `curveMaster`, `curveRed`, `curveGreen`, `curveBlue` | curve | points in 0…1 (`[[0,0],[1,1]]`) | hold |
| wheels | `shadowsWheel`, `midtonesWheel`, `highlightsWheel` | vec2 in the unit disc | ([0,0]) | yes |
| wheels | `shadowsLevel`, `midtonesLevel`, `highlightsLevel` | number | −100…100 (0) | yes |

  A missing param takes its default (S01:FX-022 rule "missing = default"). Unknown extra params are preserved.
- **CG-003 (P0)** The existing colour effects `jasper.brightness-contrast`, `jasper.hue-saturation` and
  `jasper.black-white` keep their parameters and gain a colour op (§3.3) so they fuse with Lumetri runs and
  become native. Their M1 `native.filter` strings are removed: `eq` is a GPL filter that the shipped LGPL FFmpeg
  does not contain (ARCHITECTURE D-13), and `hue` does not match the preview maths.
- **CG-004 (P0)** A `media` param value is `{mediaId}` of a `lut` asset (S06:LUT). An offline or missing LUT is
  skipped (identity) and the clip shows the offline badge on the effect row; export warns `LUT_OFFLINE`.

### 2.2 Colour ops and runs

- **CG-010 (P0)** Every colour effect implements `EffectSpec.color.build(params, ctx) → ColorFn | null`
  (ARCHITECTURE §19.2): a pure, allocation-free function that transforms one RGB triple in place. Values are
  display-referred Rec.709/sRGB-encoded (what decoders deliver), 0…1; alpha is never touched. `null` means the
  params are the identity.
- **CG-011 (P0)** Consecutive enabled colour effects of a layer form a **colour run** (`effectRuns`). A non-colour
  effect (blur, crop, flip, corner pin…) ends the run. Each run is baked into one 3D LUT (`bakeColorRun`).
- **CG-012 (P0)** Lattice size 33 (tetrahedral interpolation) for preview and export. When a run references an
  imported LUT larger than 33, the export bake uses that size (cap 65); the preview stays at 33.
- **CG-013 (P0)** Animated params (keyframes) are evaluated per frame. Preview re-bakes when the evaluated params
  change (cache keyed by `colorRunKey`, LRU of 64 LUTs per layer); the native path uses per-frame runs (§4.2).

## 3. Reference maths

The maths below is normative for `jasper.lumetri@1`. Any change to it bumps `effectVersion` and adds a `migrate`
(S01:FX-021). Notation: `v` = encoded RGB, `L = decode(v) = v^2.4` (BT.1886 simplification), `encode(L) = L^(1/2.4)`,
`Y(v) = 0.2126 v_r + 0.7152 v_g + 0.0722 v_b`, `smooth(a, b, x)` = smoothstep, all clamps to 0…1 happen only where
stated.

### 3.1 Order of operations (CG-020, P0)

1. `inputLut` (full strength).
2. White balance, in linear light: gains `g = (1 + 0.30T + 0.15N, 1 − 0.30N, 1 − 0.30T + 0.15N)` with `T =
   temperature/100`, `N = tint/100`, normalised so `Y(g) = 1`; `L ← L · g`.
3. Exposure, in linear light: `L ← L · 2^exposure`. Re-encode.
4. Contrast around mid-grey on encoded values: `v ← 0.5 + (v − 0.5) · (1 + contrast/100)`.
5. Highlights / shadows (luma masks): `y = Y(v)`, `wH = smooth(0.45, 1, y)`, `wS = 1 − smooth(0, 0.55, y)`;
   `v ← v + 0.25·(highlights/100)·wH·(h>0 ? 1 − v : v)` and `v ← v + 0.25·(shadows/100)·wS·(s>0 ? 1 − v : v)`
   (positive values brighten the zone towards white, negative darken it towards black).
6. Whites / blacks (end points): `v ← b + v · (w − b)` with `b = 0.2·blacks/100`, `w = 1 + 0.2·whites/100`.
7. Saturation: `v ← y + (v − y) · saturation/100` (`y = Y(v)` of the current values).
8. `look` mixed with `lookIntensity` (`applyLutMix`).
9. Vibrance: `c = max(v) − min(v)`; `v ← y + (v − y) · (1 + (vibrance/100)·(1 − c))`.
10. Curves: `curveMaster` on every channel, then `curveRed/Green/Blue` per channel. Each curve is a monotone
    cubic (Fritsch–Carlson / PCHIP) through its points, flat-extrapolated outside the first/last point.
11. Colour wheels (lift / gamma / gain in encoded values). A wheel vec2 `(x, y)` (unit disc) gives hue
    `θ = atan2(y, x)` and amount `m = min(1, |(x, y)|)`; its RGB direction is `d_k = m · cos(θ − φ_k)` with
    `φ = (0°, 120°, 240°)`. Then per channel:
    - shadows (lift): `v ← v + (0.10·shadowsLevel/100 + 0.10·d_k)·(1 − v)`
    - midtones (gamma): `v ← v^(1 / max(0.05, 1 + 0.5·midtonesLevel/100 + 0.25·d_k))` (for `v > 0`)
    - highlights (gain): `v ← v · (1 + 0.5·highlightsLevel/100 + 0.25·d_k)`
12. Clamp to 0…1.

- **CG-021 (P0)** With every param at its default the function is the identity (bit-exact on lattice points).
- **CG-022 (P0)** For a neutral grey input (`r = g = b`), temperature > 0 makes `r > b` and tint > 0 makes `g`
  smaller than `r` and `b`; exposure +1 doubles linear light before clamping; saturation 0 gives `r = g = b`.
- **CG-023 (P0)** Brightness & Contrast, Hue/Saturation and Black & White colour ops reproduce their M1 preview
  semantics: B&C as S03:FX-040 (`out = k(in − ½) + ½ + b/200`), Hue/Sat as a hue rotation of the Rec.709 chroma
  plane plus saturation scaling around `Y`, B&W as `lerp(v, Y(v), amount)`.

### 3.2 Numerical limits (CG-025, P0)

The bake evaluates the function on the lattice in double precision and stores float32. Preview and native
export read the same table with tetrahedral interpolation (`applyLut` is the reference). The expected agreement
is ≤ 1/255 between the TS reference and the GL shader on 8-bit output, and ≤ 2/255 between the TS reference and
the native export after the YUV round trip (§7).

### 3.3 Existing effects (CG-026, P0)

The colour ops of CG-003 live next to the Lumetri op in `packages/project/src/registry/color-effects.ts`, which also
exports the Lumetri spec; `defaultEffectRegistry` includes them.

## 4. Rendering

### 4.1 Preview and the Remotion path (CG-040…046)

- **CG-040 (P0)** `packages/compositions` gains a WebGL2 colour stage: for a layer whose effect stack contains a
  colour run, the source picture is drawn into a `<canvas>` through a fragment shader that samples the run's baked
  LUT (3D texture, `texelFetch` of the 4 tetrahedron corners — the same interpolation as `applyLut`; no hardware
  trilinear filtering). Several runs = several passes. Non-colour effects keep their CSS/SVG stages in stack order
  around it.
- **CG-041 (P0)** The stage receives the source as a `CanvasImageSource` every frame: the video layer's frame
  (from `@remotion/media` `<Video>` / `OffthreadVideo` in renders, whatever 4.0.499 exposes — the package records
  the mechanism in `docs/research/remotion-4.0.499-notes.md`), a still's `<img>`, a composition/motion-graphic
  layer's rendered frame. The source element stays mounted (hidden) so Remotion's media scheduling is unchanged.
- **CG-042 (P0)** The Remotion render path renders the same stage in headless Chrome. The engine selects a
  `chromiumOptions.gl` that provides WebGL2 on the host (`angle` / `swangle` / `egl`, checked at start-up) and
  reports `features.color.remotionWebgl`. A render whose document contains colour effects on an engine without
  WebGL2 fails with `WEBGL_UNAVAILABLE` (never silently ungraded).
- **CG-043 (P0)** Performance: a graded 1080p layer adds ≤ 4 ms per frame in the Player on the reference machine
  (12-core CPU, integrated or no GPU; WebGL through SwiftShader must still reach ≥ 20 fps for one layer at
  half playback resolution). LUT bakes run off the render path (cache; a bake of 33³ must take < 15 ms).
- **CG-044 (P1)** Keyframed grades preview smoothly: bakes for upcoming frames are prepared during playback in
  a worker; if a bake is late the previous LUT is used for that frame (preview only; renders always wait).
- **CG-045 (P0)** WebGL context loss re-creates the stage; while unavailable the layer draws ungraded with a
  "Grade unavailable" warning chip on the Program monitor (preview only).
- **CG-046 (P1)** Colour stages honour straight alpha (sources with alpha keep it; LUT on unpremultiplied RGB).

### 4.2 Native export (CG-050…055)

- **CG-050 (P0)** The engine's colour native extension (`effectSupport` = `animated` for every effect with a
  colour op) bakes each run with the same TS code and writes `.cube` files to
  `<appdir>/cache/luts/<sha256(colorRunKey)>.cube` (content-addressed, reused across exports).
- **CG-051 (P0)** The filter text for a run is `format=rgba64le,lut3d=file='<path>':interp=tetrahedral,format=rgba`
  on the first effect of the run (`''` for the others). 16-bit processing avoids quantising before the LUT.
- **CG-052 (P0)** Animated runs: the extension samples the evaluated params per output frame (`sampleRuns` over
  the layer's `[f0, f1)`), bakes one LUT per distinct state and emits one `lut3d` per state with
  `enable='between(n,a,b)'` (frame numbers relative to the layer's first frame). At most 240 distinct LUTs per
  layer; above that the params are quantised to every 2nd, 4th… frame until it fits.
- **CG-053 (P0)** The planner no longer blocks colour effects; a graded media-only sequence plans `native`.
- **CG-054 (P0)** Every filter used exists in the LGPL FFmpeg (`lut3d`, `format`). No GPL filter (`eq`,
  `hqdn3d`, `perspective`, `boxblur`, `frei0r`) may appear in generated filter text; a unit test scans the
  builder output of the colour test fixtures for them.
- **CG-055 (P1)** Speed: a 1080p30 60 s export with one graded clip runs at ≥ 70 % of the same export ungraded.

## 5. LUT assets (LUT-001…010)

- **LUT-001 (P0)** `.cube` files (Adobe/Resolve dialect: `TITLE`, `LUT_3D_SIZE` ≤ 256 / `LUT_1D_SIZE`,
  `DOMAIN_MIN/MAX`, `LUT_3D_INPUT_RANGE`, comments) import like media (Import dialog, drag and drop, MCP
  `import_lut`). The engine registers them as kind `lut` via an asset prober (`registerAssetProber`) that parses
  them with `parseCube` and stores the header in `MediaAsset.lut`; invalid files fail the import with the
  parser's line-numbered message.
- **LUT-002 (P0)** The Project panel shows LUT items with a LUT icon, size (`33³`) and title; they cannot be
  placed on the timeline (existing rule) and can be dropped onto a clip → applies a Lumetri instance with the LUT
  as `look` (or sets `look` on the clip's first Lumetri instance).
- **LUT-003 (P0)** The client fetches the file from `/media/<key>` (immutable) and parses it once per session
  (cache by fingerprint); the engine reads it from disk.
- **LUT-004 (P1)** 1D LUTs are supported (per-channel); `.3dl` and Resolve `.dat` are P2.
- **LUT-005 (P0)** The LUT pickers in the Lumetri editor list the project's LUT items plus "Browse…" (import) and
  "None".

## 6. User interface

- **CGU-001 (P0)** **Lumetri Color panel** (`lumetri`, a new dock panel): edits the first `jasper.lumetri` instance
  of the selected clip (creates one on first edit, one undo step). Sections Basic Correction (input LUT, white
  balance, tone, saturation), Creative (look + intensity, vibrance), Curves (RGB curves editor with master/R/G/B
  tabs; click adds a point, drag moves, drag out / double-click removes; 64 points max), Color Wheels (three
  wheels with a level slider each, double-click resets). Every numeric control is a scrubbable slider with
  a stopwatch where animatable; scrubs are one undo step (existing `createScrub`).
- **CGU-002 (P0)** The same editor is registered as the Effect Controls editor of `jasper.lumetri`
  (`effectEditors`), hiding the curve and wheel rows (`hideParams`) while scalar rows keep their keyframe lanes.
- **CGU-003 (P0)** A **Color** workspace (Lumetri panel right, Scopes top-left, Program, Timeline) is added to the
  built-in workspaces.
- **CGU-004 (P1)** Copy/paste grade: clip context menu "Copy Grade" / "Paste Grade" (all colour effects of the clip,
  one undo step per paste target set).
- **CGU-005 (P1)** Before/after: a Program monitor toggle bypasses all colour effects of the selected clip in the
  preview only.

## 7. Scopes (SCP-001…006)

- **SCP-001 (P1)** **Lumetri Scopes panel** (`scopes`): waveform (luma and RGB parade), vectorscope (Rec.709 YUV
  with skin-tone line and 75 % targets) and histogram, switchable.
- **SCP-002 (P1)** Source "Selected clip (graded)": the colour stage's output canvas read back at ≤ 256 px wide,
  at most 15 times per second while playing, on every change while paused. Source "Program" (P2): the composite via
  an engine still when paused.
- **SCP-003 (P1)** Scope computation runs in a worker from the read-back RGBA; the panel draws on a canvas with
  design tokens only (no colour literals outside theme files, D-15).

## 8. Agents (CGA-001…005)

- **CGA-001 (P0)** Commands: grading uses the existing `effect.add` / `param.set` / keyframe commands with
  ParamPaths `["effect", fxId, "<param>"]`; curve values are `{curve: [[x, y], …]}` (validated, sorted, clamped).
- **CGA-002 (P0)** MCP tools (`apps/mcp/src/tools/color.ts`):
  - `import_lut {projectId, path}` → `{mediaId, size, title}`;
  - `grade_clip {projectId, clipId, basic?, creative?: {look?: mediaId|null, intensity?, vibrance?}, curves?,
    wheels?, instance?: 'first'|'new'}` → one transaction, returns the effect instance id and the applied values;
  - `get_grade {projectId, clipId}` → every colour effect with evaluated params at the playhead;
  - `copy_grade {projectId, fromClipId, toClipIds}`.
  Descriptions state the ranges and CG-020's order so an agent can reason about them.
- **CGA-003 (P0)** `render_frame` shows graded output (native still when eligible).

## 9. Acceptance tests

1. **Maths** (unit, `packages/project`): identity at defaults (CG-021); CG-022 direction checks; curves monotone
   and passing through their points; wheel directions (shadows wheel towards red raises `r` most in darks);
   B&C/Hue-Sat/B&W ops match their M1 formulas within 1e-6.
2. **LUT I/O**: `.cube` fixtures (33³ from a vendor-style file with comments and DOMAIN lines; a 1D file; broken
   files) import through the engine as kind `lut` with the right header; broken ones fail with a line number.
3. **Native parity** (engine, real ffmpeg): a 1080p test chart (`pnpm fixtures` gains `chart.png`: gradients,
   colour patches, skin tones) graded with a representative Lumetri setting + look LUT: the native still (PNG)
   differs from the TS reference (`applyLut` of the baked LUT on the decoded chart) by ≤ 2/255 per channel on 99.5 %
   of pixels and ≤ 4/255 max.
4. **Preview parity** (Playwright, Chrome): the Program monitor canvas for the same chart/grade (proxies off,
   full resolution) differs from the TS reference by ≤ 1/255 per channel on 99.5 % of pixels.
5. **Planner**: a sequence of graded video clips (static and keyframed grades) plans `native`; the builder output
   contains `lut3d` and none of the GPL filters (CG-054); a keyframed grade over 30 frames produces ≤ 30 `lut3d`
   instances with `enable` windows and the exported frames 0 and 29 match the stills of the start and end states.
6. **Remotion path**: a sequence with a graded clip and a text clip (forces Remotion) renders graded; on an engine
   without WebGL2 it fails with `WEBGL_UNAVAILABLE`.
7. **UI** (happy-dom): Lumetri panel creates the instance on first edit (one history entry), scrubbing exposure is
   one entry, the curves editor adds/moves/removes points and writes a sorted curve; Effect Controls shows the
   custom editor and hides the curve/wheel rows.
8. **MCP**: `import_lut` + `grade_clip` + `render_frame` on the fixture project produce a graded PNG and one
   `Agent: Grade clip` history entry.
9. **Performance**: CG-043 bake time and frame cost measured by a benchmark test (reported, fails above 2× budget).
