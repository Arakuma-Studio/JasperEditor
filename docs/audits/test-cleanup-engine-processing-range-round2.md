# Engine range, colour and smooth-path cleanup (round 2)

Decision record written before edits. Scope: the three newly merged test files below, plus unused smooth-path test seams. Read owners: processing `service.ts`, `proc/runner.ts`, `proc/filters.ts`, `proc/smoothpath/{math,step}.ts`, media `{service,sidecar}.ts`, routes `{media,processing}.ts`; independent requirements: S07 PRC-015–020, PST-005 and acceptance 3b/11. Commands: `pnpm exec vitest run apps/engine/test/processing-range.test.ts apps/engine/test/processing-colour-range.test.ts apps/engine/test/smoothpath.test.ts --maxWorkers=1`; targeted Biome and engine typecheck. Parent owns repository gates.

Every retained/reworked entry below identifies all six bar items: requirement; observable failure; independent oracle; stable seam; refactor resilience; unique owner. The named parameter dimensions represent every generated test, not merely representative cases. No snapshots are used.

## processing-range.test.ts

- REWRITE `processes exactly the source frames [12, 48): result range, registry record, frame-exact content`: PRC-015 explicitly requires exclusive range processing, result and persisted provenance. Detects wrong seek/end, lost provenance or wrong rendered frames. Oracle is fixed frame codes [12,13,29,47], 36 frames, and submitted range. HTTP job/result, documented media-index storage and decoded file are stable seams; changes to queue/process internals do not change observations. Project source-range tests cannot observe engine seeks/persistence. Remove title copy assertion and narrow filename to the independently required frame range (not entire naming punctuation). Risk low; verify focused suite.
- REWRITE `a clip swapped onto the ranged version exports the same source frames on the native path, and back`: PRC-016 and acceptance 11 require unchanged exported source frames. Detects renderer misinterpreting ranged source offsets. Oracle is fixed fixture codes [20,21,29,39]. HTTP export/download plus decoded artifact is the stable owner (replace the internal ExportService file lookup with the public /renders/:jobId/output endpoint); independent of document field representation. Remove document `sourceIn/start/mediaId` checks and export-plan preflight because project source-range tests own document transformation and the actual export proves planning. Existing source-range E2E checks UI wiring/render-frame, not native encoded output. Risk low; focused suite.
- KEEP `reports the sidecar next to a file registered by path (trailer grade format)`: PRC-019 requires discovering the sibling JSON and returning `RegisteredMedia.sourceHint`. Detects filesystem discovery/registration integration losing metadata or leaking a hint to plain media. Independent literal trailer sidecar input/expected public response. Public registration is stable across parser/storage refactors. Project parser tests do not read sibling files through registration. Risk low; focused suite.
- REWRITE `deletes an engine-managed copy no project uses: file, record and derivatives`: PRC-018 permits only unreferenced managed copies to be discarded. Detects leaked managed files/registry or deletion of the user's original. Oracle is HTTP deleted status, missing registered media, managed copy removed and source retained. Public registration/deletion and actual filesystem effects survive registry refactors. Cache tests own derivative cleanup; rename this test to stop claiming it checks derivatives. Risk low; focused suite.
- REWRITE `never deletes the user's own files, processed versions or media a stored project uses`: PRC-018 forbids deleting these three categories. Detects destructive deletes or wrong refusal codes using three distinct ownership conditions. Independently fixed API reason codes and file existence observe public HTTP/storage behavior, not collaborators. Remains valid after service/registry refactors; no stronger owner exercises all deletion refusals. Replace the fake `{format,key}` project blob with a real DocBuilder project envelope containing the registered media, so the assertion does not pin the current substring scanner. Risk medium (data safety); focused suite.

## processing-colour-range.test.ts

- DELETE generated-filter-text cases `deshake crop`, `deshake keep`, `deblock`, `atadenoise`, `nlmeans`, `to yuv444p`, `to yuv444p16le from tv`, `to rgb48 from yuv`: filter string syntax is a change detector and a weaker duplicate of decoded black/white/chroma contracts below. A valid RGB-only or non-scale pipeline should pass. Remove `scalesWithoutRange`, graph table and filter-builder/type imports. Risk low; measured matrix remains.
- DELETE `the fixture itself decodes to 0 / 255, achromatic`: verifies test setup rather than product. Preserve its prerequisite check during fixture setup so a broken oracle cannot produce misleading product failures. Risk low.
- REWRITE all `${name} · ${fx.name} · ${range}-range source` cases, recipes `vid.stab`, `smooth path`, `smooth path (OpenCV.js warp)`, `deshake crop`, `deshake keep`, `deblock + atadenoise + vid.stab`, `nlmeans + deshake crop`, `dejudder + deshake crop`, `deblock + fftdnoiz + dejudder + smooth path`, each available LGPL/system encoder and both `tv`/`pc` inputs: PRC-020 explicitly specifies black <=2, white >=253 and achromatic deviation <=6 across these conversion paths. Detects the documented FFmpeg range regression, crushed highlights or colour cast. Independent generated neutral patches and specified decoded thresholds are not production-derived. `runProc` is the real CLI runner boundary; decoded media is stable across graph and worker refactors. Each range/filter/backend dimension exercises different conversion code/FFmpeg behavior; no other test measures these endpoints. Deduplicate repeated decoder invocation when encoder already is the LGPL decoder; fail explicitly if decoder fails/truncates instead of accepting empty statistics. Risk medium numerical regression; focused suite.

## smoothpath.test.ts

Disposition of the private math tests follows (DELETE except the two explicitly marked REWRITE). Their helper return layouts, seeded inlier counts or exact implementation formulas do not independently prove encoded output; real runner tests below are stronger owners of background tracking, smoothing, cap, cuts and warp. Risk low for duplicated behavior; no independent isolated contract requires exporting these private algorithm stages. Remove fixture-only `rng`, `sim`, `apply`, `jerk` and imports.

- `recovers an exact similarity by least squares`: private fitting stage; background tracking/output owner remains.
- `RANSAC follows the background and ignores a moving subject (40 % of the points)`: exact inlier count/determinism pins private fit; real moving-subject fixture remains.
- `gaussSmooth keeps constants and holds the edges; sigma 0 copies`: private smoothing shape; decoded smooth movement remains.
- `lineFit is the least-squares line`: private numerical helper; not a public algorithm API.
- `cameraPath accumulates frame-to-frame motion about the centre`: private coordinate representation; measured camera travel remains.
- `corrections map the actual camera onto the smoothed one (identity for an already smooth path)`: private matrices; independently measured output remains.
- `bordersHidden / minimalZoom find the smallest zoom, never above the cap`: formula copied from the private margin/search; cap owner remains.
- `smooths a jerky reframe into an even move within the zoom cap`: duplicates real reframe output.
- `falls back to the largest smoothing that fits when the cap is too small, and says so`: duplicates runner fallback report, and its second oracle is another call to the same planner.
- REWRITE `releases the locks only when even a tiny smoothing with them needs more than the cap`: a real PST-005 policy is trapped at a test-only planner export; REWRITE into the existing runner fallback scenario with locked vertical motion and a tight cap, observing reported effective locks. The fixture has a 6px vertical bump in a 480px-high frame; a 101% cap allows less than 2.4px vertical correction, so holding the fitted vertical line cannot fit. No additional test is introduced.
- `a cut splits the shot: each segment gets its own path and zoom (a jump across the cut would not fit)`: duplicates real cut fixture/sidecar contract.
- REWRITE `borders 'keep' never zooms`: real PST-005 contract trapped at a test-only export; REWRITE its assertion into existing OpenCV keep-border colour-runner scenario, using sidecar zoom=100. No additional run or test.
- `backward maps convert exactly to the vid.stab warp transform`: compares two production math functions; actual backend output equivalence remains.
- DELETE `the operator reframe (frames 30–50) is not a cut; the shot change at frame 404 is`: hardcoded sibling-workspace media, silently skipped elsewhere; synthetic reframe/cut runner cases provide reproducible true/false-cut coverage. Remove absolute CRUDO path and fixture-existence skip.

Survivors:

- REWRITE `tracks the background (not the subject), evens out the reframe within the zoom cap`: PST-005 and acceptance 3b specify travel within 1.5px, capped zoom, reduced speed and independently measured output jumps <=2px. Failures are subject tracking, ineffective stabilization and excessive cropping. Fixture crop path (independent generator) plus column-profile output measurements are independent oracles. Runner sidecar/output is stable through tracker/math refactors. This is the unique acceptance owner; remove progress-note regex, debug logs and internal tracking failure-count assertion. Risk medium numerical behavior; focused suite.
- REWRITE `explains and falls back when the cap is too small`: PST-005 requires reducing smoothing under max zoom and reporting effective settings. Detects ignored cap or silent unchanged smoothing. Fixed requested settings bound reported settings independently; the sidecar is the documented processing protocol. Works after algorithm refactors; owns fallback/lock-release user settings rather than duplicating the successful reframe. Replace exact note wording with structured fallback data and carry the locked-motion case here. Risk medium; focused suite.
- REWRITE `warps the same with the vid.stab WASM kernel and the OpenCV.js fallback`: PST-005 promises equivalent stabilization with optional WASM and configurable OpenCV warp. Detects coordinate/sign/crop divergence between real backends. Encoded pixel PSNR and independently measured motion compare observable outputs, using a fixed tolerance, not expected production transform matrices. Runner config/output and reported selected engine are stable seams; no other test compares kernel outputs. Remove redundant exact zoom equality and debug logging. Risk medium; focused suite.
- REWRITE `a shot with a cut is stabilised per segment (own path and zoom), the cut found by the de-judder guard`: PST-005 requires cut at the input shot boundary, own travel and own capped zoom. Detects treating a cut as motion or sharing crop across shots. Independent fixture concatenation at frame 45 and known mirrored path supply expected segment/travel values. Protocol sidecar is stable across cut-detector/planner refactors; this uniquely owns real cut detection plus per-shot report. Remove note wording and debug logs. Risk medium; focused suite.

## Seam/support audit before removal

`steps.ts` is the only production caller of `createSmoothPathStep`, passing only the process step. No caller uses exported default constants, tracking constants, `SmoothPathFrameStep.plan/warpEngine`, nor optional track size/thread/worker/wasm/warp/cut-threshold injection overrides. Remove those unused exports/getters/options and keep the documented `JASPER_SMOOTHPATH_WARP` runtime override. In `math.ts`, `step.ts` needs only `Similarity`, `IDENTITY_SIM`, `ransacSimilarity`, `backwardToVsTransform`, `planSegmentedSmoothPath`, `SegmentPlan`, `SegmentedPlan`; make remaining declarations module-private. Keep algorithm code itself and all default runtime behavior.

Validation outcomes will be appended after execution.

## Implemented changes and initial checks

All recorded pruning/rewrite decisions are implemented. No algorithm or user-facing processing behavior changed. Removed 22 unused exports from smooth-path math, the three unused exported step constants, the optional injection parameter/types, and the `plan`/`warpEngine` getters. The runtime warp environment variable remains supported. No fixtures were deleted because the retained measured runner contracts consume them.

Targeted Biome passed on all five modified TS files. `git diff --check` passed. The initial suite was started before edits; missing `reframe.mp4` generation took 183 seconds on the shared host and the original suite then reported four skipped cases; the default hook timeout is the likely setup failure (final diagnostics pending). The hook now has the same explicit 600-second budget as the image-processing tests. This is a test-harness preparation fix, not deletion of a failing retained contract. Final baseline and rerun results follow when the running suite completes.

## Exact generated colour case inventory

Original literal title expression: `${name} · ${fx.name} · ${range}-range source`. Every row is REWRITE under all six justifications above: PRC-020; black/white/chroma failure; independent patch thresholds; real runner/output seam; graph/worker refactor resilience; unique recipe × encoder-version × source-range conversion. `tv` exercises input expansion from limited range and `pc` exercises preservation of full range; LGPL 7.1 and system 6.1 have different scale defaults. A system-only or bundled-only machine instantiates just the corresponding rows. On this host both are present.

| Exact generated title | Disposition | Unique conversion path |
| --- | --- | --- |
| `vid.stab · lgpl · tv-range source` | REWRITE | WASM RGB stabilization |
| `vid.stab · lgpl · pc-range source` | REWRITE | WASM RGB stabilization |
| `vid.stab · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | WASM RGB stabilization |
| `vid.stab · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | WASM RGB stabilization |
| `smooth path · lgpl · tv-range source` | REWRITE | RGB smooth-path crop |
| `smooth path · lgpl · pc-range source` | REWRITE | RGB smooth-path crop |
| `smooth path · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | RGB smooth-path crop |
| `smooth path · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | RGB smooth-path crop |
| `smooth path (OpenCV.js warp) · lgpl · tv-range source` | REWRITE | OpenCV keep-border warp; also PST-005 zoom stays 100% |
| `smooth path (OpenCV.js warp) · lgpl · pc-range source` | REWRITE | OpenCV keep-border warp; also PST-005 zoom stays 100% |
| `smooth path (OpenCV.js warp) · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | OpenCV keep-border warp; also PST-005 zoom stays 100% |
| `smooth path (OpenCV.js warp) · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | OpenCV keep-border warp; also PST-005 zoom stays 100% |
| `deshake crop · lgpl · tv-range source` | REWRITE | deshake crop/resize, the recorded range regression |
| `deshake crop · lgpl · pc-range source` | REWRITE | deshake crop/resize, the recorded range regression |
| `deshake crop · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | deshake crop/resize, the recorded range regression |
| `deshake crop · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | deshake crop/resize, the recorded range regression |
| `deshake keep · lgpl · tv-range source` | REWRITE | deshake uncropped output |
| `deshake keep · lgpl · pc-range source` | REWRITE | deshake uncropped output |
| `deshake keep · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | deshake uncropped output |
| `deshake keep · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | deshake uncropped output |
| `deblock + atadenoise + vid.stab · lgpl · tv-range source` | REWRITE | deblock and temporal denoise before RGB warp |
| `deblock + atadenoise + vid.stab · lgpl · pc-range source` | REWRITE | deblock and temporal denoise before RGB warp |
| `deblock + atadenoise + vid.stab · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | deblock and temporal denoise before RGB warp |
| `deblock + atadenoise + vid.stab · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | deblock and temporal denoise before RGB warp |
| `nlmeans + deshake crop · lgpl · tv-range source` | REWRITE | spatial denoise before deshake crop |
| `nlmeans + deshake crop · lgpl · pc-range source` | REWRITE | spatial denoise before deshake crop |
| `nlmeans + deshake crop · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | spatial denoise before deshake crop |
| `nlmeans + deshake crop · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | spatial denoise before deshake crop |
| `dejudder + deshake crop · lgpl · tv-range source` | REWRITE | frame retiming before deshake crop |
| `dejudder + deshake crop · lgpl · pc-range source` | REWRITE | frame retiming before deshake crop |
| `dejudder + deshake crop · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | frame retiming before deshake crop |
| `dejudder + deshake crop · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | frame retiming before deshake crop |
| `deblock + fftdnoiz + dejudder + smooth path · lgpl · tv-range source` | REWRITE | frequency denoise/filter-frame fusion before smooth path |
| `deblock + fftdnoiz + dejudder + smooth path · lgpl · pc-range source` | REWRITE | frequency denoise/filter-frame fusion before smooth path |
| `deblock + fftdnoiz + dejudder + smooth path · system 6.1.1-3ubuntu5 · tv-range source` | REWRITE | frequency denoise/filter-frame fusion before smooth path |
| `deblock + fftdnoiz + dejudder + smooth path · system 6.1.1-3ubuntu5 · pc-range source` | REWRITE | frequency denoise/filter-frame fusion before smooth path |

The initial run may have loaded later files after edits in this shared checkout. It is initial-run evidence, not a clean immutable baseline; the final root-run repository gates are authoritative for the completed cleanup.
