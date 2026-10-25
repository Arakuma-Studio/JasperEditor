# Incoming engine rendering tests

Scope: the four rendering files introduced between `2d364873` and `69c96e3b`,
reviewed after integration at `99d57175`. This is a separate incoming inventory:
**13 named declarations**, expanding to **23 cases** with `REMOTION_E2E=1`.
These are all new declarations, not additions to the original 5,722 inventory.

Disposition: **3 REWRITE, 5 OPTIMIZE, 5 CONSOLIDATE**. Nine declarations survive;
the paired crop cases expand to eight executions. Native crop has six executions,
Smooth Slide export one, spatial export one: **16 executions**, retaining all
meaningful original render scenarios. No production behavior, dependency, golden,
pixel tolerance widening or required CI gate changes.

## Behavioral evidence

Every surviving case below has an independent requirement in AGENTS §4 and the
linked work note; the row names its additional exact obligation and credible bug.
Its seam is the real engine HTTP job/output interface and actual decoded PNG/MOV
bytes. The parity oracle is the separately executed Program composition, whose
agreement with the exported artifact is itself a documented requirement. Native
crop additionally uses original asset bytes and the separately implemented Program
edge profile; independent lower numerical integration pins that scalar profile.
Spatial positioning uses literal geometric coordinates. Native FFmpeg masks do not
call the scalar Program profile, so either implementation can disagree with the other. These
observations survive changes to private planners, wrappers, collaborator calls and effect plans.
The final column identifies the distinct backend/behavior; another case does not
supersede it merely by exercising the same effect name.

| Original declaration | Disposition | Independent source and recognizable failure | Oracle and unique surviving protection |
| --- | --- | --- | --- |
| `apps/engine/test/crop-order-native.test.ts` — Crop → Flip mirrors the cut window; Flip → Crop cuts the flipped picture | OPTIMIZE | [Crop order](../wp-notes/crop-order.md) §1: standard effects execute in stored order before Motion. Sorting Crop first incorrectly exposes/cuts opposite pixels. | Every native lossless pixel equals the original asymmetric asset mirrored through the independently specified cut interval, exact tolerance zero. Both orders are required to distinguish the obsolete Crop-first behavior. |
| Same file — Edge Feather multiplies the alpha by the shared profile (exact edges, ≤ 2/255) | OPTIMIZE | Crop note A1–A4: the inward linear feather is box-filtered in layer pixels, four edges multiply. Ignoring feather or applying it in output percentages gives the wrong ramp/corners. | Uses production-used `cropEdgeCoverage` for the four documented edges rather than retaining the test-only `cropCoverageAt` wrapper. Native FFmpeg evaluates separate expressions; lower numerical integration independently pins the Program scalar profile. All RGB pixels remain within 2/255, with a literal half-opacity witness. This owns native static feather, not the profile unit algorithm. |
| Same file — a feathered crop before a flip is mirrored with its feather | OPTIMIZE | Crop note §1/A4: the entire already-feathered image is flipped. Mirroring only hard bounds or moving Crop to the front incorrectly positions the ramp. | The independently pinned Program edge profile at mirrored coordinates, all native pixels ≤2/255. The static unflipped case cannot detect a detached feather. |
| Same file — keyframed Edge Feather is evaluated per frame | OPTIMIZE | Crop note §3: feather animation is evaluated at content time, including a zero initial value. Freezing at zero/default/first key produces a hard edge at frame 15. | Explicit keys 0→60 at frames 0→30 imply feather 30 at frame 15; the separately implemented Program ramp, all native pixels ≤2/255. Static cases cannot detect frozen/time-shifted parameters. |
| Same file — a feathered crop on a sub-pixel layer (kernel path) is the profile resampled at the layer’s offset | OPTIMIZE | Crop note §3 and D-34: the native sub-pixel compositor samples the feathered layer at its actual offset. Dropping source-chain alpha or treating the shift as whole pixels gives incorrect edges. | Four-neighbor bilinear mean of the independently pinned Program ramp at a half-pixel translation, every pixel ≤3/255. Other native cases do not enter this kernel path. |
| Same file — Edge Feather fades the adjustment in from the crop edges: original + coverage · (adjusted − original) | CONSOLIDATE | Crop note §3: adjustment coverage mixes the original composite and the adjusted composite; only later flips move the crop region. Alpha-masking the result to black, feathering the wrong region, or treating both orders alike changes real pixels. | One workflow reuses its immutable original/graded baselines, the separate Program ramp and independently specified flip intervals; every RGB pixel ≤3/255 for feather and ≤1/255 for hard-order cases. This owns native adjustment compositing, distinct from an ordinary layer's alpha. |
| Same file — a flip after the crop mirrors the region; a flip before it does not | CONSOLIDATE | Same adjustment-order contract as above. Its original and graded renders duplicated the preceding test exactly. | Both complete per-pixel order assertions move into the independent adjustment workflow. Two duplicate reference renders and one execution disappear; no mutable state is shared between tests. |
| `apps/engine/test/crop-order-parity.e2e.test.ts` — `${scene.name}: export = Remotion` | REWRITE | Crop note §3/§6 and AGENTS §4: native/hybrid export must match the Program renderer, including effect order, animation, sub-pixel placement and adjustment layers. Wrong bakes/CSS-to-canvas handoffs can pass all model tests. | Keeps all 11 actual scenes and their unmodified PSNR/max/p99 parity limits. Removes the production-derived duplicate profile oracle: the native differential pixel owner above and independent profile unit owner pin that math. Three effect-order pairs now render/compare within their own cases; five other scenes remain separate. Every named scene is mapped below. |
| Same file — the stack order changes the picture (Crop → X differs from X → Crop) | CONSOLIDATE | Crop note §1: noncommuting Flip/Mirror/Blur must retain order. The old test read a results map populated by previous tests. | All three original `maxAbs >64` comparisons survive inside their respective paired render cases, eliminating cross-test order dependence. This physical difference rejects both paths silently reverting to Crop-first. |
| `apps/engine/test/smooth-slide-export.test.ts` — native export: the span is baked (hybrid), no blocker | CONSOLIDATE | D-35 public export routing for GPU transitions. This repeated the generic public-plan GPU contract using another registry entry. | Existing `apps/engine/test/export.test.ts` — keeps the built-in transitions native and bakes only the span of a GPU transition owns the generic plan; the stronger surviving Smooth Slide encoded-output owner verifies both one-/two-sided Slide spans actually render through hybrid and Remotion. Removed private graphics-group shape/ID assertions add no contract. |
| Same file — without a span renderer the export goes to Remotion with a blocker naming Smooth Slide | CONSOLIDATE | D-35/AGENTS §4: missing native span support must route safely and name the blocking feature. No Slide-specific branch exists here. | Existing `apps/engine/test/gpu-spans.test.ts` — without a span renderer (no layer-bake extension) a GPU transition still sends the export to Remotion exercises the same configuration with a real transition and checks its ID/name. It catches the identical routing/refusal regression. |
| Same file — hybrid and Remotion exports of a heavy Smooth Slide match the composition frame by frame | REWRITE | [Smooth Slide](../wp-notes/smooth-slide.md) §2/§5; AGENTS §4: both encoded paths preserve a two-sided cut with dolly/reflection/blur and a one-sided upper-track head. Wrong span bounds, dropped controls, stale/static bakes or faulty mux timing alter frames. | Keeps both real MOVs and all 13 independently rendered composition reference frames. Contrasting red/blue solids replace incidental dense texture; the upper orange head and transition controls remain. Both outputs now face the original fixed hybrid bound (≥99% within 3/255), replacing the self-adjusting MOV-derived tolerance. Public job completion replaces polling; selected video frames are decoded in one process per MOV and PNG references use the existing decoder. Model/GL tests cannot verify export scheduling, bakes, encoding and mux alignment. |
| `apps/engine/test/spatial-points.e2e.test.ts` — a Transform with a curved Position path: export = composition = the evaluator (layer-box arc length) | REWRITE | [Spatial points](../wp-notes/spatial-points.md) §1/§5: effect points travel at constant speed in layer pixels. Omitting the non-square layer metric puts a rendered point elsewhere even if preview and export agree on the same bug. | Replace the production `evaluate` oracle and fixture-only metric-vs-naive assertion with a radius 240 px quarter-circle. Literal centroids at frames 0/15/30 are `(400,360)`, `(470.294372515,190.294372515)`, `(640,120)`; centroid error stays <1 px. Three full-frame parity checks retain ≥99% RGB samples within 3/255. Lower model tests own detailed spatial interpolation; this is the distinct actual shader/render/export consumer. |

### Every generated crop scene

The rewritten family retains these physical scenes; paired cases own their data
locally and keep every original render and parity assertion.

| Original generated case | Surviving owner and unique failure |
| --- | --- |
| crop-then-flip | Flip order pair: native hard crop before a flip, visibly distinct from reverse order. |
| flip-then-crop | Same independent pair: crops the already flipped source. |
| feather | Static all-edge feather on a DOM image; native/Program parity. |
| feather-then-flip | Already feathered source flips with its ramp. |
| feather-keyframed | Future positive feather must select/evaluate the correct render path despite initial zero. |
| feather-subpixel | Scaled/rotated feather with native sub-pixel resampling. |
| mirror-then-crop | Mirror order pair: hybrid bake retains a trailing crop. |
| crop-then-mirror | Same pair: the Mirror consumes a cropped source. |
| crop-then-blur | Blur order pair: blur samples the cropped source. |
| blur-then-crop | Same pair: a crop cuts the already blurred source. |
| adjustment-feather | Feather and later vertical flip limit an adjustment over the existing picture. |

## Infrastructure and cost

Native crop uses 320×180 rather than 1280×720. No resolution-specific requirement
exists for this effect; percentages, feather in layer pixels, fractional bounds,
animation and the half-pixel compositor path all remain. Every output pixel is
still checked. The original synthetic pattern is encoded directly, actual HTTP
PNG bytes use the existing testkit decoder, and generated media use the existing
owned temporary-directory cleanup. No unused fixture or new test-only production
API remains.

The two immutable adjustment reference images now live inside one test, reducing
native still renders 13→11 without order dependence. Crop parity keeps all 11 scenes
but groups the three meaningful order pairs, reducing 12 executions→8. Its final
results-map test and repeated production profile oracle are removed.



The original Smooth Slide Remotion-MOV bound was calculated from the same MOV's
non-transition frames; uniform degradation could loosen the expected bound. That
oracle fails independence. The rewritten case retains actual encoded-path wiring
with a minimal contrasting-solid fixture and the existing fixed hybrid bound on
both paths. No output from the implementation chooses its own acceptable error.
Detailed texture/image-source behavior remains in the independently checked GL
families and real Player parity owner.

## Runtime validation and measurements

All four original files passed with the opt-in flag: **23/23 cases**. Both final
runs passed **16/16 cases**, with no unexpected skip, unhandled error or retry.
The three targeted production mutations failed their intended pixel assertions;
after byte-exact restoration all three selected cases passed. Other cases were
filtered only for the mutation/restoration experiment, not the full validations.
Actual engine TypeScript passed; changed-file Biome and diff checks passed.

| Workload (GNU command wall) | Original | Final | Repeat |
| --- | ---: | ---: | ---: |
| Three files with the opt-in flag unset |22.12 s|1.57 s|—|
| All four files, `REMOTION_E2E=1`, two workers |129.88 s|89.27 s|85.41 s|
| Aggregate child CPU, opt-in workload |282.43 s|224.27 s|223.85 s|
| Largest single-process RSS, opt-in workload |2,119,736 KiB|1,793,240 KiB|1,604,380 KiB|

The first complete post run saved **40.61 s /31.27%** command wall time; the repeat
saved 44.47 s /34.24% against the same original sample. Disabled-file startup saved
20.55 s /92.90%: cumulative worker import time fell 39.12→0.273 s. The original two
cheap planner cases were consolidated into existing required owners; all remaining
opt-in cases are still explicitly registered as skipped when the existing flag is
unset. No meaningful case moved outside its gate.

These are scoped observations, not an overall-suite or CI estimate. Node 20.19.0,
pnpm 10.34.5, Vitest 4.1.11, two workers, Chrome 156.0.8078.47, system FFmpeg 6.1.1 for
independent decode and the verified vendored LGPL 7.1.5 engine binaries were the
same. Machine: Linux x64, eight EPYC-Genoa vCPUs, 15 GiB RAM, no swap. Other agents
held heavy work during the measurements. The first source bundle was cold in this
worktree; later runs reused compiler/bundler caches. No filesystem cache was
flushed, and there is one original sample/two final samples rather than a confidence
interval. Cache warming contributes to the observed delta. Largest-process RSS
is not aggregate simultaneous process-tree memory.

Case-body/file spans (JSON end minus start, excluding parts of setup/import):

| File | Original | Final | Repeat |
| --- | ---: | ---: | ---: |
| Native crop |4.941 s|1.514 s|1.955 s|
| Crop parity |58.700 s|39.022 s|38.874 s|
| Smooth Slide |101.567 s|64.338 s|64.240 s|
| Spatial points |38.274 s|16.722 s|16.621 s|

Smooth Slide remains the expensive owner: it encodes two 80-frame 720p MOVs and
compares all 13 Program reference frames across the cut, the one-sided head and
restored underlying picture. The simple colored inputs retain dolly, reflection,
blur, easing and shutter parameters. Every hybrid frame was 100% within 3/255;
every Remotion frame exceeded 99% (worst 99.41%). Neither output chooses a baseline
error that relaxes its own threshold. No fixed tolerance widened.

Native crop still checks every output pixel, including adjustment regions.
All 22 crop artifact PNGs were byte-identical to the original in **both** final
runs (44 comparisons), validating the shared-browser/frame grouping change.
The spatial export had centroid errors 0/0.416/0 px and 100% of samples within 3/255
of the Program at frames 0/15/30. Selected actual crop, Slide and spatial PNGs were
visually inspected by the integration owner; no golden was blessed.

| Actual production mutation | Intended failure observed |
| --- | --- |
| Native `isFeatheredCrop` returns false |23,200 incorrect pixels, worst 255, against the unchanged 2/255 bound. |
| Baked transition starts at 1 instead of 0 |Hybrid frame 32 share 0.33635, below 0.99; job/render succeeds and real pixel comparison fails. |
| `effectParamMetric` returns undefined |Spatial midpoint moves to (450,213.5), error 30.828 px, despite preview/export parity remaining 100%. |

The mutations are semantically disjoint and were applied together in one selected
three-case run. Native feather affects no crop-free Slide/spatial fixture; the
metric affects no unanimated Slide/crop point; span shifting affects transitions,
not the ordinary spatial effect or crop. Thus each failure names the independently
changed behavior. Source digests before/after/restoration are recorded, all three
restore exactly. Dependency resolution points to this worktree's project and
compositions sources; dev engines build those sources into new owned appdirs,
never an old packaged bundle. No production change is committed.

The existing production-used shared browser serves independent reference renders
and is closed in `afterAll` before the engine. Batched video extraction is bounded
to 13 selected frames per Slide MOV (about 36 MiB each); PNG references use the
existing decoder. That bounded buffer trades memory for fewer decode processes;
the observed largest-process peaks above decreased, while aggregate peak memory
was not measured. Native PNG subprocesses and repeated adjustment baselines are
removed, and owned temporary directories clean up remaining generated inputs.

Exact principal commands (Node 20 PATH was selected before invocation):

```sh
renderFiles=(
  apps/engine/test/crop-order-native.test.ts
  apps/engine/test/crop-order-parity.e2e.test.ts
  apps/engine/test/smooth-slide-export.test.ts
  apps/engine/test/spatial-points.e2e.test.ts
)
env -u NODE_OPTIONS -u JASPER_E2E_PORT REMOTION_E2E=1 \
  JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  JASPER_TEST_RESULTS=/tmp/jasper-test-cleanup/incoming-wave2/render/final-optin-artifacts \
  pnpm exec vitest run "${renderFiles[@]}" --maxWorkers=2 \
  --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/incoming-wave2/render/final-optin.json
# Same four-file command repeated with final-optin-repeat outputs.
env -u NODE_OPTIONS -u REMOTION_E2E -u JASPER_E2E_PORT \
  JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm exec vitest run "${renderFiles[@]:1}" --maxWorkers=2 \
  --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/incoming-wave2/render/final-default.json
# Mutation and restoration commands selected these three real physical owners:
env -u NODE_OPTIONS REMOTION_E2E=1 JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm exec vitest run "${renderFiles[0]}" "${renderFiles[2]}" "${renderFiles[3]}" \
  --maxWorkers=2 -t 'Edge Feather multiplies alpha|hybrid and Remotion MOVs|a curved Transform exports' \
  --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/incoming-wave2/render/restored.json
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/engine typecheck
pnpm exec biome check "${renderFiles[@]}"
git diff --check
```

GNU time wraps each principal invocation in the raw command records. Evidence is
under `/tmp/jasper-test-cleanup/incoming-wave2/render/`: baseline/final/repeat logs,
JSON and GNU timing files; mutation/restoration results; source restoration hashes;
module-resolution proof; crop artifact comparisons; and the exact argv/environment
records. The original all-four-file run temporarily used byte-restored `99d57175`
tests, with the optimized native file restored in Python `finally`. The first two
original helper/plan cases were not silently omitted from that baseline.

Final changes: **−144 test/support LOC**, four named declarations/seven executions
removed by consolidation, no production/dependency/configuration changes. The
project owner separately removes the now-unused `cropCoverageAt` wrapper and its
self-restating unit. Root owns the integrated full default/lint/build/browser gates;
this workstream does not claim those complete.
