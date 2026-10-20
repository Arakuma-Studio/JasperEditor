# wp-m2-color — Lumetri-style colour grading, LUT assets, Lumetri/Scopes panels, colour on the native path

Spec: `docs/specs/06-color-grading.md` (S06). Contracts: ARCHITECTURE §19.2 (colour), §19.6 (native extensions),
§19.7 (asset probers, capabilities), §19.9 (MCP), §19.10 (web extension points), D-21.

## What was built

| Area | Where | Requirements |
|---|---|---|
| `jasper.lumetri@1` spec + reference maths (one monomorphic closure; WB/exposure as an exact encoded gain) | `packages/project/src/color/lumetri.ts`, `registry/color-effects.ts` | CG-001/002/010/020/021/022 |
| PCHIP tone curves (Fritsch–Carlson, flat extrapolation, normalisation, ≤ 64 points) | `packages/project/src/color/curves.ts` | CG-020 step 10 |
| Colour ops of Brightness & Contrast / Hue-Saturation (CSS `hueRotate`·`saturate` matrices) / Black & White; their `eq`/`hue` native strings removed | `registry/color-effects.ts`, `registry/effects.ts` | CG-003/023/026 |
| `.cube` prober (kind `lut`, header, `INVALID_LUT` with line numbers) | `apps/engine/src/color/prober.ts` | LUT-001/004 |
| Colour native extension: baked runs (same TS bake), content-addressed `<appdir>/cache/luts/`, `lut3d` on the first effect of a run, per-frame `enable` windows for keyframed grades (≤ 240 per layer, quantised above), imported LUT > 33 raises the lattice (cap 65), GPL-filter scan | `apps/engine/src/color/extension.ts`, `routes/color.ts` | CG-050…054, CG-012/013 |
| `features.color {lut3d, remotionWebgl}`; start-up WebGL2 probe of the render browser over `chromiumOptions.gl` candidates; the probed `gl` on every render; `WEBGL_UNAVAILABLE` | `routes/color.ts`, `apps/engine/src/remotion/service.ts` | CG-042 |
| CPU colour pass (identical maths, per-code-value tables) chosen automatically when WebGL2 is a software rasterizer (SwiftShader/llvmpipe); `localStorage['jasper:color-stage']` forces `webgl`/`cpu` | `packages/compositions/src/color/cpu.ts` | CG-043 |
| WebGL2 colour stage: `texelFetch` tetrahedral shader (= `applyLut` = `lut3d`), RGB32F 3D LUT textures (LRU 64/context), bake LRU 64/layer, LUT asset loader (once per URL), context-loss handling + "Grade unavailable" chip, before/after bypass, graded solids, `ColorCanvas` for any `CanvasImageSource` | `packages/compositions/src/color/*`, `layers/{LayerBox,VideoLayer,StillLayer,SolidLayer}.tsx` | CG-040/041/043/045/046, CGU-005 |
| Lumetri Color panel, Effect Controls editor (`effectEditors`, hides curves/wheels), curves editor, colour wheels, sliders, LUT pickers, Color workspace, Copy/Paste Grade, Apply as Look, LUT drop on clips, Lumetri Scopes (waveform/parade/vectorscope/histogram in a worker) | `apps/web/src/color/*`, `panels/lumetri`, `panels/scopes`, `commands/color.ts`, `PropertyRow.tsx` | CGU-001…005, LUT-002/005, SCP-001…003 |
| MCP `import_lut`, `grade_clip`, `get_grade`, `copy_grade` + `COLOR_GUIDE` | `apps/mcp/src/tools/color.ts` | CGA-001…003 |
| Fixtures: `chart.png` (ramps, hue field, 24-patch checker, skin tones, wedge), `look-33.cube`, `tone-1d.cube`, broken cubes | `scripts/fixtures/color.mjs` | §9 tests 2–4 |

The frame-source mechanism of Remotion 4.0.499 (canvas `createEffect` effects on `@remotion/media` `<Video>` and
`<Img>`, `onVideoFrame` for `<OffthreadVideo>`) is recorded in `docs/research/remotion-4.0.499-notes.md`.

## Deviations from the spec / contracts

- **CG-051 filter text.** The native path uses `lut3d=file='…':interp=tetrahedral` on the layer's 8-bit RGBA frames
  with the baked table written **+0.5/255** (so `lut3d`'s truncating 8-bit store rounds to nearest), instead of
  `format=rgba64le,lut3d=…,format=rgba`. Measured on the chart with FFmpeg 6.1 and 7.1: the `rgba64le` round trip
  through swscale is not exact (`v<<8` in, `round(v/256)` out) and left 25 % of pixels one code value off (max 2);
  the 8-bit variant equals the TS reference on 100.000 % of pixels. The layer is already 8-bit when effects run, so
  16-bit processing bought nothing. Cache files are keyed `sha256("u8r:" + colorRunKey)`.
- **WB/exposure** are evaluated as the mathematically identical gain on encoded values (`(v^2.4·k)^(1/2.4) = v·k^(1/2.4)`);
  the midtones gamma uses `exp(e·ln v)` (same value to 1e-15, 2× faster than `Math.pow` in V8) — bake budget.
- **"None" for media params** is `{mediaId: ''}` (`ParamValue` has no `null`); INV-006 accepts it.
- **Highlights/shadows** (CG-020 step 5) use one luma mask computed from the step's input for both adjustments,
  applied highlights first.
- **CPU pass on software WebGL** (CG-040 says WebGL2): on this GPU-less host the WebGL path is dominated by the
  texture upload and the WebGL→2D read-back of Remotion's effect chain, not by the shader; the same tetrahedral maths
  on the CPU is 2–3× faster, so it is used when the WebGL2 renderer is a software one. Both backends are tested
  against the TS reference (e2e, 100 % exact). Renders still require WebGL2 (CG-042 semantics unchanged).
- **LUT_OFFLINE** is logged in the export job log (extensions cannot add plan warnings); the grade skips the LUT.
- **Text clips** have no colour stage (DOM text); a graded text clip renders ungraded on the Remotion path (no
  native path for text either). Graded animated images show their first frame (frame-accurate animated images are
  S03:KND-040). Composition clips: the mg package feeds its pre-rendered frame into `ColorCanvas`.

## Contract changes (additive; each listed under `Contract-Change:` in the commit)

- `packages/project/src/render/snapshot.ts`: media handles for `{mediaId}` effect params (LUT assets).
- `packages/project/src/invariants.ts`: INV-006 accepts `{mediaId: ''}`.
- `packages/project/src/color/lut.ts`: allocation-free `applyLut` (identical arithmetic); `index.ts` exports
  `color/curves`, `color/lumetri`, `registry/color-effects`.
- `packages/compositions/src/types.ts`: `RenderOptions.colorBypassClipIds?`; `SequenceComposition.tsx` wraps the
  tracks in `ColorDocContext.Provider` (one hunk); `LayerBox` gains optional `effects`/`overlay` props.
- `apps/web/src/import/assets.ts`, `apps/mcp/src/media.ts`: copy `RegisteredMedia.lut` into the asset.
- `packages/project/test/keyframe-effect.test.ts`: M1 colour native-string assertions replaced (no `eq`/`hue`).

## Licences

No new dependency. Filters used on the native path: `lut3d` (LGPL, present in `vendor/ffmpeg-lgpl`). The
`matssmile_clean_v1.cube` used in the validation below is the trailer's own look (not shipped, not a test fixture).

## How to test

```
pnpm fixtures
pnpm vitest run --project @jasper/project --project @jasper/compositions --project @jasper/engine --project @jasper/web
REMOTION_E2E=1 pnpm vitest run --project @jasper/engine apps/engine/test/color-remotion.test.ts   # Remotion path, headless Chrome
```

## Current engine checks

`apps/engine/test/color.test.ts` checks a native still at −1 EV and an exported video's authored −1/0 EV
keyframes. `apps/engine/test/color-remotion.test.ts` checks −1 EV through a nested composition on the Remotion
path. Their expected pixels come directly from S06 §3: decode `v^2.4`, multiply by `2^EV`, then re-encode,
which gives `v * 2^(EV/2.4)`. They do not call the production LUT baker or sampler to calculate expectations.
The native still retains the ≤ 2/255 on 99.5 %, max 4 budget; Remotion retains ≤ 2/255 on 99.5 %. Animated
video retains its mean-error budget for H.264 encoding. The planner's native-path and GPL-filter checks remain.
These current analytic checks do not reproduce the representative multi-control grade measurements below.

## Historical measurements

The following measurements used the original scenarios and oracles. Their parity numbers are per channel
against the TypeScript reference (`applyLut` of the baked 33³ LUT, rounded); they are not results for the current
analytic exposure checks:

| Check (S06 §9) | Result |
|---|---|
| 1 Maths (`packages/project/test/color.test.ts`, 22 tests incl. fast-check properties) | pass; 33³ full-grade bake ≈ 5–15 ms CPU (reported by the test, fails above 30 ms) |
| 2 LUT I/O (engine): 33³ vendor cube with comments/DOMAIN, 1D, broken files with line numbers | pass |
| 3 Native still vs TS reference (chart, representative grade + look LUT 80 %) | **100.000 % exact**, max 1 (budget ≤ 2 on 99.5 %, max 4) |
| 4 Preview (Program monitor layer canvas, Playwright/Chrome) vs TS reference | **100.000 % exact** with the CPU pass and with the forced WebGL2 shader (budget ≤ 1 on 99.5 %) |
| 5 Planner/builder: graded clips plan native, one `lut3d`, no GPL filter; keyframed grade over 30 frames → 30 `lut3d` windows; exported frames 0/29 match the start/end stills | pass |
| 6 Remotion path (headless Chrome, `REMOTION_E2E=1`): graded chart + text still | **100.000 % exact**, max 0; WebGL2 found with Remotion's default `gl` (ANGLE → SwiftShader); `WEBGL_UNAVAILABLE` with `JASPER_REMOTION_GL=off` |
| 7 UI (happy-dom) | pass (web agent tests: `color-lumetri.test.tsx` 15, `color-scopes.test.ts` 9) |
| 8 MCP: import_lut + grade_clip + render_frame graded, one `Agent: Grade clip` change | pass (`apps/mcp/test/color.test.ts`, 12) |
| 9 Performance | see below |

Performance (host: 12 cores, no GPU, load average 15–50 from other agents during the measurements):
- Bake: see test 1. Native export of a 10 s 1080p30 clip: ungraded 8.8–9.2 s, graded (Lumetri + look) 13.2–13.3 s
  (≈ 68 % of ungraded speed; CG-055 asks ≥ 70 %, P1); a grade keyframed over all 300 frames (150 LUTs after
  quantisation) 36.7 s.
- Preview colour pass in headless Chrome (SwiftShader): WebGL2 1080p 255 ms / 960×540 63 ms per frame; CPU pass
  1080p 125 ms / 960×540 22 ms (≈ 45 fps at half resolution, CG-043 asks ≥ 20). The ≤ 4 ms/frame budget for 1080p
  needs a hardware GPU; not reachable on this machine (the shader itself took 8 ms; upload + read-back dominate).

### Real-footage validation (MatsSmile T02, amber reception, `raw/crudo.mp4` 5.8–10.13 s)

The raw shot was graded in the editor (dev servers, Program monitor) with one Lumetri instance: the trailer's show
look `matssmile_clean_v1.cube` as Look at 100 %, the pro master curve (0/0 0.2/0.22 0.42/0.5 0.62/0.66 0.8/0.8 1/1),
and basic/wheel values matched to the pro grade `grade/out/T02.mov` (coordinate search on 5 frames, like a colourist
matching a reference): temperature −100, tint +40, exposure +0.6, contrast −30, highlights +60, shadows −60,
whites +20, saturation 81.3 %, vibrance 18.8, midtones level +10, midtones wheel (−0.25, −0.225), shadows wheel
(−0.1, 0.175). CIEDE2000 / PSNR, 848×480, sequence frames 20/60/80/100 (frame 40: the Player decoded the
neighbouring source frame 213 instead of 214 — a pre-existing preview seek offset on this VFR-ish phone file, not a
colour difference; excluded):

| Frame | preview vs native still | preview vs pro T02 | native vs pro T02 | raw vs pro T02 |
|---|---|---|---|---|
| 20 | ΔE00 mean 0.94, p95 1.79, PSNR 44.0 dB | 4.89 (median 4.16) | 5.09 | 23.82 |
| 60 | ΔE00 mean 0.77, p95 1.61, PSNR 45.7 dB | 3.31 (median 2.05) | 3.16 | 21.22 |
| 80 | ΔE00 mean 0.68, p95 1.46, PSNR 47.7 dB | 2.65 (median 1.88) | 2.52 | 21.28 |
| 100 | ΔE00 mean 0.66, p95 1.44, PSNR 47.6 dB | 2.48 (median 1.77) | 2.34 | 21.17 |

Decode baseline with the grade bypassed (frame 60): preview vs native ΔE00 mean 0.71, PSNR 44.6 dB — the
preview/export difference on real H.264 footage is the browser's (WebCodecs) vs FFmpeg's YUV→RGB decode, not the
grade (on RGB sources the two paths are identical). The pro grade also includes upscaling, de-judder, denoise,
grain and a keyframed AE-ramp fix (frame 20), which a static per-clip grade does not reproduce.
Side-by-side (raw | JasperEditor | pro): `/tmp/wp-m2-color-shots/matssmile-T02-f60-raw-ours-pro.png`.

## Open issues

- CG-043 ≤ 4 ms/frame at 1080p needs a GPU; on a GPU-less host the CPU pass gives ~8 fps at 1080p, ~45 fps at
  half resolution. CG-044 (worker pre-bakes for keyframed playback) is not built: bakes run synchronously (~5–15 ms).
- CG-055: graded native export ≈ 68 % of ungraded speed (P1 target 70 %); keyframed grades with many states are
  slow (one `lut3d` node per state) and write one ~1 MB `.cube` per state into `<appdir>/cache/luts/` — no GC pass
  for that cache yet.
- LUT_OFFLINE is only logged in the job log (no plan warning API for extensions).
- Text clips and animated images: no colour stage (see deviations). `.3dl`/Resolve `.dat` (LUT-P2) not supported.
- Web (from the UI implementer): wheel level sliders in the Lumetri panel have no stopwatch (Effect Controls has
  them); LUT drag over the timeline still shows the insert indicator; double-click on empty curve space leaves two
  undo entries; scopes source "Program" (P2) not built. Touched outside owned paths: `panels/program/ProgramMonitor.tsx`
  (before/after), `panels/project/{ProjectPanel.tsx,model.ts}` (LUT items), `panels/timeline/TimelinePanel.tsx`
  (LUT drop, ~4 lines; transitions owns this file), `panels/effects/drag.ts` (Native filter uses `effectBadges`).
- The preview seek offset of one frame seen on `crudo.mp4` at sequence frame 40 is an M1 Player issue worth a
  ticket (not colour).
