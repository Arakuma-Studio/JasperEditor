# Testing

```sh
pnpm test                                   # every package and app (vitest projects); GL tests run when a Chrome is found
pnpm vitest run <files> --maxWorkers=2      # targeted runs (shared machines)
pnpm verify                                 # lint + typecheck + test + build (the gate; CI runs the same)
JASPER_REQUIRE_ORACLES=1 pnpm test          # a missing ffmpeg/ffprobe fails instead of skipping (CI sets it)
JASPER_BLESS=1 pnpm vitest run <files>      # (re)write golden frames, fingerprints and pins, then review the diff
FUZZ=1 pnpm vitest run <files>              # 20× more fuzz cases; FUZZ_SEED=<n> for another seed
REMOTION_E2E=1 pnpm vitest run <files>      # suites that bundle the compositions and render with Remotion
pnpm perf                                   # the benchmarks, including the scale benchmark (§6)
```

The [suite audit](test-audit/README.md) records per-test contract decisions, cleanup,
regression probes and comparable whole-suite profiling. Its runner notes explain the
model package's conditional Linux thread pool and unchanged global worker limit.
Playwright workers use the engine’s native binary resolver, including the
prepared vendor directory; `JASPER_FFMPEG` and `JASPER_FFPROBE` override individual tools.
`JASPER_FFMPEG_VENDOR=0` disables automatic vendor selection.

Test-only helpers shared by every package live in **`@jasper/testkit`** (`packages/testkit`, a devDependency; never
imported by app code): golden frames (`@jasper/testkit/golden`), PNG and RGBA helpers (`/png`, `/image`), fuzzing
(`/fuzz`), ffmpeg/ffprobe oracles (`/oracle`) and headless WebGL (`/browser`). Its own tests are in
`packages/testkit/test`.

The remote-upload regression (`apps/engine/test/processing-remote-upload.test.ts`)
requires `rsync` and a POSIX shell. It transfers real bytes through the local SSH
protocol fixture; no remote host or SSH credentials are needed.

## 1. Kinds of tests

| Kind | Where | Notes |
|---|---|---|
| Unit | `<package>/test/*.test.ts(x)` | happy-dom for components, node elsewhere |
| Property | `fast-check` in the model (`packages/project/test/fuzz.test.ts`: invariants under random command sequences; `FUZZ=1` = 10,000 runs), interchange round trips, caption formats, time maths | |
| Robustness / fuzz | `*/test/fuzz.test.ts`, `packages/interchange/test/*.test.ts` | §4: every parser and loader |
| GL (WebGL2) | `packages/compositions/test/*-gl.test.ts` | headless Chrome on ANGLE/SwiftShader; `FX_GL=0` skips; output checks described in §3 |
| Golden frames | `packages/compositions/test/golden-scenes.e2e.test.ts`, fingerprints in `fx-gl` / `transition-gl`, `fx-motion-blur-gl` | §2 |
| Oracle | engine export, loudness, probe tests | §5 |
| Remotion renders | `*.e2e.test.ts` with `REMOTION_E2E=1` | bundling ≈ 15–40 s; needs ffmpeg and a Chrome |
| Playwright | `e2e/*.spec.ts` (`pnpm e2e`) | the built app end to end; the preparation also installs whisper-tiny.en from the pinned, sha256-verified catalogue into `target/speech-models` (or `JASPER_SPEECH_MODELS_DIR`) for `e2e/script-fix.spec.ts`, which fails without it |
| Performance | `scripts/performance.mjs` (`pnpm perf`), timing budgets in tests | §6 |

Opt-in switches: `REMOTION_E2E=1` (Remotion renders), `FUZZ=1` (long fuzz), `PERF=1` (exact budgets), `MG_E2E=1`
(motion-graphics bundles). CI (`.github/workflows/ci.yml`) runs `pnpm lint`,
`pnpm typecheck`, `pnpm test --maxWorkers=2` and `pnpm build` on every push and pull request with ffmpeg from apt
and `JASPER_REQUIRE_ORACLES=1`, no GPU (SwiftShader), no LGPL FFmpeg and none of the opt-in suites; it uploads
`test-results/` (golden and fuzz failure artefacts) when a step fails.

MCP text and behaviour have their own eval, on real agents: [`apps/mcp/eval`](../apps/mcp/eval/README.md). It calls paid
models on Orquester-managed accounts, so the gate runs only its unit tests and the byte budget.

## 2. Golden frames

A golden test renders a frame and compares it with a committed PNG:

```ts
import { expectGolden, Tolerance } from '@jasper/testkit/golden';
expectGolden(join(here, 'goldens', 'scenes', `${name}.png`), frame /* Rgba8 */, Tolerance.BROWSER);
```

- **Metrics** (ported from FilmCraft's testkit): per-pixel differences over the four channels in 8-bit levels —
  largest absolute difference, mean, the 99th percentile of the per-pixel maximum channel difference, PSNR and the
  number of differing pixels. A tolerance names the limits that must all hold:

  | Tolerance | PSNR ≥ | max ≤ | p99 ≤ | Use |
  |---|---|---|---|---|
  | `EXACT` | ∞ | 0 | 0 | bit-identical pins |
  | `RENDER` | 45 dB | 12 | 2 | CPU renders against CPU-made references (FilmCraft's default) |
  | `GL` | 40 dB | 24 | 3 | WebGL2 output across Chrome / ANGLE versions and GPUs |
  | `BROWSER` | 36 dB | 64 | 6 | whole Chrome pages (Remotion stills: DOM compositing, text rasterisation) |

- **On failure** the actual frame, the expected frame and a ×8 difference image (alpha differences show in every
  channel) go to `test-results/golden-failures/<name>.{actual,expected,diff}.png` (`JASPER_TEST_RESULTS` moves
  `test-results/`). The message has the metrics and the tolerance.
- **Blessing.** `JASPER_BLESS=1` writes the references instead of comparing (only when the pixels changed), refuses
  a PNG above `MAX_GOLDEN_BYTES` (50 KB; render a smaller or simpler scene — the motion-blur perspective warps are a
  documented 128 KB exception). **Look at every re-blessed PNG before committing it**
  (`git diff --stat`, then open the files).
- **Fingerprints** (`expectFingerprints(file, record, ±levels)`; the records under `goldens/` are excluded from Biome so each case stays on one line) are FilmCraft's compact form for large matrices: the
  4×4 mean-RGB grid of a frame (`fingerprint`, 48 numbers) per case in a JSON record, one case per line. **Pins**
  (`expectPins`) are exact values (checksums, counts). Both bless with `JASPER_BLESS=1`; `{complete: true}` also
  reports stale entries.

What is covered:

| Suite | Cases | Gate |
|---|---|---|
| `golden-scenes.e2e.test.ts` (scenes in `test/golden/scenes.ts`) | 256×144 Remotion stills of procedural scenes (generated pictures, a generated movie, the repository's Inter): Motion + Opacity, Crop + Corner Pin, every blend mode (CSS modes stacked, each GPU-composited mode on its own), combined canvas scopes (`combo-*`: stacked GPU blends, an adjustment layer over a GPU blend and between two, linear light around an adjustment layer, 3D with a blend and an adjustment layer, the HDR display transform with an inner scope — each checked against a computed reference before its golden; compositor workstream), masks, an adjustment layer, a nest, Lumetri, a colour run, a linear working space, S-Log3 interpretation, text, a text animator, shapes (rectangle, ellipse, vector star), a 3D layer, Time Remapping, Liquify + Wave Warp, burned-in captions, a Cross Dissolve, and one GPU effect of every effect family | `REMOTION_E2E=1` |
| `fx-gl.test.ts` → `goldens/fx-fingerprints.json` | every GPU effect at its defaults **and** with every parameter moved off its default (`@perturbed`), on a test card, frame 12 | Chrome present |
| `transition-gl.test.ts` → `goldens/transition-fingerprints.json` | every GPU transition two-sided over two cards at p = 0.25 / 0.5 / 0.75 (±4 levels) | Chrome present |
| `fx-motion-blur-gl.test.ts` → `goldens/motion-blur/*.png` | 36 static cases (motion blur off or nothing moving) must equal the pre-motion-blur output; blessed from that output — their pixel checksums equal the former `baseline.json` pins | Chrome present |

Native-vs-Remotion parity: `apps/engine/test/native-animated.test.ts` (keyframed Motion / Opacity / crop, and the keyframe
assistant's eases — a cubic overshoot preset, multi-point bounces, a rebuilt spatial path — and a path controller:
native corners ≤ 0.1 px from the shared evaluator on every frame without Remotion; SSIM ≥ 0.98 against Remotion with
`REMOTION_E2E=1`), `apps/engine/test/trim-paths-export.e2e.test.ts` (`REMOTION_E2E=1`: Trim Paths animations and
trim tracers exported on the hybrid layer-bake and Remotion paths, compared frame by frame and with the evaluated
tips and trims), `apps/engine/test/golden-parity.e2e.test.ts` (static compositor scenes exported natively and
by Remotion, compared with each other and with goldens), `apps/engine/test/crop-order-parity.e2e.test.ts` (Crop in
stack order and Edge Feather, export vs Remotion and vs the shared feather profile; `REMOTION_E2E=1`) and
`apps/engine/test/crop-order-native.test.ts` (the same on the native path against computed pixels, no Chrome).
`apps/engine/test/blur-repeat-edge.e2e.test.ts` (`REMOTION_E2E=1`: Gaussian Blur with Repeat Edge Pixels on a clip and
on adjustment layers — edge pixels of a flat frame equal its centre, and the export equals Remotion and preview stills).
`apps/engine/test/adjustment-transform-parity.e2e.test.ts` (`REMOTION_E2E=1`, a Chrome with HTML-in-Canvas: geometric
effects on adjustment layers — Transform static, zoomed out, with opacity / crop / Screen, keyframed with a 360°
shutter, capped; S_Shake with Reflect or no wrap, with keyframed Tint, Hue/Saturation, Black & White; S19; every
LONG_PACK transition kit around its cut — exported natively vs Remotion; `adjustment-transform-native.test.ts`,
`adjustment-shake-tint-native.test.ts` and `adjustment-kits-native.test.ts` are its native half against computed pixels
and the planner's choice, no Chrome; `automation-kits-export.e2e.test.ts` exports each kit family end to end).
`apps/engine/test/fps-conform.e2e.test.ts` (`REMOTION_E2E=1`: frame-coded sources at five frame-rate conversions, a speed and a hold, exported natively, through the layer bake and by Remotion and rendered as preview stills — every frame's source frame equals the time model's, and patch colours agree; `fps-conform-native.test.ts` is its native half in the default suite).
`apps/engine/test/blend-export.test.ts` checks a native
Multiply / half-opacity Normal / Difference stack against independently calculated pixels, plus literal kernel
vectors for transparent layer pixels, stencil clearing and inactive-frame passthrough.

## 3. GL tests

The GL suites render through the production GPU host in headless Chrome, using
`packages/compositions/test/gl-browser.ts` for browser discovery, bundling and SwiftShader setup. They compare
readback pixels with independent reference vectors, committed fingerprints or golden frames. The retained cases
cover orientation, premultiplied alpha, colour transforms, effect output and transitions. Shader changes require
a working Chrome/software-GL environment; a missing browser or an opt-out is untested behavior, not a pass.

## 4. Fuzzing and robustness

The rule: **any input either parses or fails with the parser's typed error** (an error class it declares, or the
result object it documents) — never an uncaught `TypeError` / `RangeError` / `SyntaxError`, never a hang. Register a
target with one line in the package's `test/fuzz.test.ts` (or `fuzz-parsers.test.ts`):

```ts
import { bytesTarget, describeFuzz, jsonTarget, textTarget } from '@jasper/testkit/fuzz';

describeFuzz('@jasper/project captions', [
	textTarget('SRT', seeds, parseSrt, CaptionFormatError),            // text in, typed error out
	bytesTarget('EBU STL', stlSeeds, parseStl, CaptionFormatError),    // bytes
	jsonTarget('effect preset', presetSeeds, (v) => isResult(parseEffectPreset(v))), // never throws
]);
```

Each target runs its seeds, truncations of every seed (32 cut points plus the edges), seeded xorshift mutations
(bytes: bit flips, random bytes, extreme 32-bit fields, cuts, span delete / insert / copy, splices of other seeds;
text: lines dropped, duplicated and swapped, numbers replaced by `NaN`, `1e309`, `-0`, 2³¹…, tokens and odd
characters; JSON: nodes replaced, deleted, re-typed, arrays emptied or grown, `__proto__` / `constructor` keys, deep
nesting) and a fast-check property over arbitrary inputs of its kind. Options: `iterations`, `properties`,
`slowMs` (default 2 s per input: CPU in the synchronous runner, elapsed time in the asynchronous runner),
`check` (assert something about a successful result). Failing inputs are written to
`test-results/fuzz-failures/<target>-<seed>-<phase>-<n>.*` and the message names the seed; reproduce with
`FUZZ_SEED=<n>`. `runFuzzTarget` / `runFuzzTargetSync` / `assertFuzzSync` run a target outside `describeFuzz`
(the interchange tests use `assertFuzzSync` through `expectOnlyInterchangeErrors`).

Targets:

| Package | Targets |
|---|---|
| `@jasper/project` (`test/fuzz-parsers.test.ts`) | SRT, WebVTT, SCC, MCC, TTML / DFXP, EBU STL, caption sniffing; `.cube`, `.3dl`, `.spi1d`, `.spi3d`, `.csp`, LUT sniffing; the OCIO YAML subset, OCIO configs (parse, list, convert), ASC CDL XML; SVG → shape layers, SVG path data; Lottie (text and document); glTF, GLB, OBJ; Radiance `.hdr` (`three-d-hdr.test.ts`); image-sequence grouping; timecode entry; project load / migrate / repair (a loaded project must satisfy every invariant), migrate; effect presets and preset files; clipboard payloads; source-range sidecars; transcript JSON; Essential Sound settings |
| `@jasper/interchange` (`test/fuzz.test.ts` + per-format tests) | any bytes sniffed, and read as each of FCP7, FCPXML, OTIO, EDL, AAF (CFB), OMF, ALE → `project.importTimeline` into a project (no internal error, no invariant violation) |
| `@jasper/expressions` | expression source: compile, syntax check, evaluation on a document |
| `@jasper/engine` (`test/fuzz.test.ts`) | ZIP (imports; motion-graphics bundles — extraction never leaves its destination), dotLottie, Lottie `.json` files, Photoshop documents, ffprobe JSON (the mapped probe must satisfy the media schema), bundle manifests and `package.json`, upload file names |
| `@jasper/config`, `@jasper/api` | runtime/config and event/transaction entry-point schemas: arbitrary-JSON properties in `packages/config/test/config.test.ts` and `packages/api/test/api.test.ts` |
| `@jasper/testkit` | the PNG decoder |

Bugs the fuzzing found and fixed are pinned by `packages/project/test/fuzz-regressions.test.ts` and
`apps/engine/test/fuzz-regressions.test.ts` (wp-note `golden-fuzz`).

## 5. Oracles (ffmpeg / ffprobe)

ffmpeg and ffprobe are external processes for fixtures and checks; never linked or shipped. `@jasper/testkit/oracle`
finds them: `JASPER_FFMPEG` / `JASPER_FFPROBE` (an explicit path; set but wrong is an error), then `PATH`, then
well-known install directories. A test that needs a missing tool skips with `SKIPPED (<context>): …`;
**`JASPER_REQUIRE_ORACLES=1`** turns every such skip into a failure.

```ts
import { compareVideos, measureLoudness, oraclesAvailable, probePackets, requireTool } from '@jasper/testkit/oracle';
describe.runIf(oraclesAvailable('ffmpeg', 'ffprobe'))('…', () => {          // throws at collection when required
	it('…', (ctx) => { const ff = requireTool('ffmpeg', 'my test', ctx); … });  // skips (or fails) inside a test
});
```

| Helper | Measures |
|---|---|
| `measureLoudness(file)` | EBU R128 via `ebur128=framelog=verbose:peak=true`: integrated, LRA, threshold, true peak, and momentary / short-term / running values every 100 ms |
| `compareVideos(ref, dist)` | PSNR (average, minimum, per frame) and SSIM (all planes, per frame) via ffmpeg's `psnr` / `ssim` on yuv444p |
| `probePackets`, `probeFrames`, `probeStreams`, `compareTables` | ffprobe packet / frame tables (pts, dts, duration, size, key, picture type, size, samples) compared field by field |
| `decodeFrames(file)` | decoded frames as RGBA8 for golden comparisons |
| `ffmpeg(args)` | fixture generation |

## 6. Performance

`pnpm perf` (`scripts/performance.mjs`, [docs/performance.md](performance.md)) runs the benchmarks one after
another; the micro section includes the scale benchmark below. Each benchmark also runs alone with
`pnpm exec tsx <file>` and records its results next to it.

**Scale benchmark** (`packages/session/bench/scale.ts`, results in `scale.results.json`): a 200-sequence, ~5,000-clip
project (`packages/project/bench/scale-project.ts`, built through the real command system: footage with linked
audio, titles, solids, stills, shapes, GPU effects with keyframes, Lumetri, opacity keyframes, transitions,
markers), timed for load (parse + migrate + zod + invariants), migration from schema v1, a full invariant check, a
small and a 300-clip edit through `EditorSession`, undo, redo, a render snapshot (one sequence and all 200), scene
resolution at a frame, and the autosave serialisation. Each operation has a budget (reference-machine milliseconds,
scaled by the host's measured load factor of `scripts/perf/budget.ts` unless `PERF=1`; `JASPER_PERF_NO_BUDGET=1` never fails); the script exits
non-zero when one is exceeded. `SCALE_SEQUENCES=<n>` runs a smaller project without writing results.

Timing assertions in tests use load-tolerant budgets the same way; CI does not set `PERF=1`.
