# Incoming integration: composition contracts

Audit base: incoming `2d364873..69c96e3b`, integrated as `b5303967`, source checkpoint `99d57175`.
This supplement supersedes the earlier composition ledger only for the six explicitly listed files. It audits
**29 named declarations** (35 runtime cases), including two pre-existing audio declarations whose
files changed upstream. A generated case family is one named declaration, not five independent audit rows.

Current decisions: **16 DELETE, 7 REWRITE, 3 KEEP, 2 CONSOLIDATE, 1 OPTIMIZE**. The original CPU-reference family
becomes two small independent pixel tests; the net declaration decrease is therefore 17, not the sum of DELETE
and CONSOLIDATE. The final six-file scope has12 named declarations/14 runtime cases in five surviving files.
Test/support LOC is net−112, including the new actual-browser fixture; three unnecessary exports of local helpers
are removed without changing runtime behavior. Assertions were not removed to conceal a legitimate failure.

## Contract and seam evidence for every surviving owner

The numbered columns are the user's six retention requirements. The independently documented contracts are
[preview/export fidelity](../../AGENTS.md), [Sound Design Phase 4/6](../specs/12-sound-design.md),
[audio crossfades](../wp-notes/audio-crossfades.md), [playback audio](../wp-notes/wma-preview.md),
[structural sharing](../ARCHITECTURE.md), and [Smooth Slide's documented model and labelled assumptions](../wp-notes/smooth-slide.md).
An assumption explicitly adopted by the project is a contract for Jasper's renderer; this does not assert exact
matching to an unavailable commercial plug-in.

| Owner | 1: independent contract | 2: recognizable failure | 3: independent oracle | 4: stable seam | 5: refactor resistance | 6: unique protection |
| --- | --- | --- | --- | --- | --- | --- |
| Audio mix: track/clip solver/room/dip/build (REWRITE) | Spec12 Phase4 preview equals delivered mix; dip is audible | Live preview omits or mistimes a bus/clip envelope or effect | Separately executed real offline mixer PCM against real playing Web Audio/Worklets; independent energy drop, unchanged sample bound | Actual rendered PCM from the real graph and public offline mixer | No command-result fields, graph topology or collaborator counts pinned | Track and clip paths differ in where envelopes/effects run; unit commands cannot establish audio wiring/timing |
| Audio mix: asymmetric off-centre Custom Fade + two edge fades (REWRITE) | Crossfade note and Phase4 sample parity, including handles | Preview handles, clip time or asymmetric outgoing/incoming gain are wrong | Two actual PCM execution paths, non-silence witness, unchanged full-sample 1e-4 limit | Rendered PCM | No curve-model output is used as its own expected value | Only playing Worklet-vs-offline owner of this crossfade/handle combination; model tests own exact curve math, engine owns encoded envelope |
| Audio mix: pan sweeps (KEEP) | Spec12 Phase6 sample-exact pan automation | Clip/strip/send/5.1 submix pan uses wrong clock or matrix | Separate offline and live output arrays with full-sample bound | Actual multiroute audio output | Output comparison survives graph/helper rearrangement | Distinct clip-content vs sequence clocks and stereo/5.1 fold routes; static pan/matrix tests cannot establish those runtime combinations |
| Program AudioLayer playback selection (REWRITE; resolver consolidated) | Playback-audio note: selected stream WAV; pending means silence | Program selects wrong stream, loses audio or plays pending audio | Independently generated110/220Hz tones, measured frequency bands and real PCM energy; exact silence while pending | Real Source/Program previews in Chromium | No mocks or media props inspected; actual PCM and decoded picture survive media-component, cache and prefetch changes | Covers selection AND component wiring; engine derivative bytes and web media state do not select what the renderer plays |
| Source AssetComposition playback selection (REWRITE) | Source monitor plays first playback stream, retaining video picture muted; pending silent | Source uses undecodable original, wrong first stream or pending audio | First AC-3 stream110Hz/WMA220Hz, decoded red/blue frames and real PCM/silence | Actual Source preview picture/PCM | No stream-index sentinel, mock or incidental DOM tree pinned | Source monitor is a separate production entry from Program AudioLayer |
| Updated render-document transition (REWRITE) | Documented transition-only edit regression; Program must display new transition params | Stabilizer retains old track when only direction changes | Literal requested `up` value | Production-consumed render-document stabilizer's output | No unchanged clip/track reference identity pinned | Render/export tests build fresh documents and would miss a stale previous-document reuse |
| Smooth Slide push/easing/head/tail/Reverse/edge smoothing (REWRITE owner) | Slide note's push directions, Penner In Quad and missing-side transparency | Direction, easing, Reverse, missing-side or active edge-smoothing wiring is ignored | Literal red/blue/transparent RGBA; In Quad quarter travel1/16 versus Linear1/4; High3px seam weights2/3:1/3 | Actual GPU host readback | No CPU geometry helper, uniform/pass inventory or shader source inspection | Default fingerprints do not move every control; model math alone cannot catch GPU use/side binding |
| Smooth Slide dolly/floor reflection (REWRITE owner) | Note's midpoint Dolly1 scale1/2 and reflected floor opacity0.6 | Dolly ignored, reflection missing/above picture/wrong side | Literal clear/picture/floor RGBA samples | Actual GPU readback | Fixed documented scene outputs tolerate different pose/planner/shader internals | Distinct geometry/alpha effect absent from default no-dolly/no-reflection fingerprints |
| Smooth Slide heavy endpoints (KEEP) | Start/end exactly source A/B even with dolly/reflection/AA/blur | Nonzero shutter/reflection contaminates an endpoint | Independent fixture's generated ramp at identity, unchanged <=3 channel bound | Whole actual GPU frame | No implementation-derived poses or pass structure | Generic default endpoint tests do not exercise all heavy controls/directions together |
| Smooth Slide shutter smear (KEEP) | Motion Blur creates interframe instances; wider shutter smears more | Off is blurred, blur ignored or shutter angle ignored | Sharp red/blue seam has no mixed pixels; 180-degree smear nonzero, 720-degree wider | Actual GPU frame samples | Measures output, not sample count/uniform shape | Default fingerprints and CPU easing do not distinguish off/angle wiring |
| Smooth Slide reflection-only blur (REWRITE) | Blurriness softens reflected pictures, leaving main picture unchanged | Blur disabled or accidentally applied to main picture | Hard alpha1/0.6 regions are independently documented; both must exist; reflection changes >50, picture unchanged | Actual sharp/soft GPU output | Removes the production CPU reference mask | Distinct multi-pass routing obligation; geometry/default fingerprints do not establish reflection-only processing |
| Smooth Slide interactive preview/export (OPTIMIZE) | AGENTS fidelity; Player preview equals export still | Preview context/interactive render differs from exported transition | Separately captured live Player and Remotion still at identical declared frame, unchanged >=98% within4/255 and mean<1.5 | Actual public Player/renderStill boundary | Stable capture synchronization does not inspect expected pixels or private render topology | Engine exports own encoded span/mux wiring; GL owns shader controls; neither exercises the live Player's preview context |

All playback mocks are deleted. The real browser fixture uses generated VP9 + AC-3 and WMA originals plus
float-PCM playback copies. The Program selects its second stream, the Source selects the first, pending media
stays silent while its decoded picture advances. Existing `compositions.test.tsx` owns ordinary/mandatory proxy
URL selection; unchanged P0 real-PCM workflows own ordinary AudioLayer wiring.
It observes Web Audio destination energy/frequency and literal red/blue video pixels; request paths are diagnostic only, so
benign caching/prefetch changes remain free. It never asserts
Remotion's private workaround index. A sampled meter accumulates actual energy and its dominant frequency through playback, so a late observation
cannot mistake completed audio for silence. The known-tone copies are actual FFmpeg decodes of the originals.
Fresh pages isolate JavaScript/audio state; one context reuses only immutable fixture resources, with distinct
HTML URLs for mode/kind/ready-state combinations. This costs more than
the former mocked input checks; the real unsupported-codec wiring contract justifies that cost.

## Every audited original declaration

Paths below are relative to `packages/compositions/test/`; line numbers refer to checkpoint `99d57175`.

| Path:line and original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| `audio-preview-mix-oracle.test.ts:394` — `${kind}: solver gain, room send, stop-before dip and build sweep` | REWRITE | Remove private command-result target/count pins and dead results plumbing; keep actual energy and complete live/offline PCM parity, justified above |
| `audio-preview-mix-oracle.test.ts:433` — audio crossfades: an asymmetrical off-centre Custom Fade, Exponential / Constant Power fades | REWRITE | Remove envelope expectations calculated with the same production fade functions and duplicate subwindow scans; whole output bound covers every region |
| `audio-preview-mix-oracle.test.ts:476` — pan sweeps: strip pan, clip pan, the 5.1 puck of a track and of a send, a 5.1 submix pan | KEEP | Distinct runtime pan-clock/routing owner above |
| `crop-order.test.ts:53` — nests a crop where it sits: before or after a flip | DELETE | Private stage order; engine crop native/parity pixels own stack behavior |
| `crop-order.test.ts:63` — a feathered crop draws its hard clip-path here (the feather is the chain’s) | DELETE | Exact private CSS string; actual feathered pixels own output |
| `crop-order.test.ts:70` — Mirror → Crop and Crop → Mirror give the steps in that order | DELETE | Planner step inventory; real Mirror/Crop parity scenes distinguish the outputs |
| `crop-order.test.ts:80` — a hard crop after the last shader effect stays a CSS stage after the chain (still in order) | DELETE | Internal CSS-vs-GPU partition is not a user contract |
| `crop-order.test.ts:86` — a crop with Edge Feather takes the chain as the shader stand-in, alone or anywhere in the stack | DELETE | Private identity/step list; real feather pixel witness remains |
| `crop-order.test.ts:102` — keeps the feathered path on frames where a keyframed feather evaluates to 0 | DELETE | Private path choice; real keyed feather export/parity spans0→positive |
| `crop-order.test.ts:108` — without WebGL the feathered crop falls back to its hard clip with the chip | DELETE | Private bypass/style shape; existing `fx-layers.test.tsx` owns the visible no-WebGL2 warning; `fx-player.e2e.test.ts` owns the HTML-in-Canvas fallback |
| `crop-order.test.ts:115` — a failed stand-in shader degrades to the hard crop as a CSS stage, with the failure chip | DELETE | Private mocked failed-predicate/step list; `fx-gl.test.ts` owns actual `FxShaderError`/driver-log failure, and `fx-layers.test.tsx` owns generic visible GPU unavailability |
| `crop-order.test.ts:122` — a crop before a pixel-mixing effect that precedes a colour run takes the chain (the colour stage would cut later) | DELETE | Private chain choice; real Crop/Blur order pixel scenes establish the actual distinction |
| `crop-order.test.ts:136` — cropChainSpec only applies to Crop | DELETE | Internal helper branch restatement; rendered output remains covered |
| `crop-order.test.ts:143` — the stand-in’s uniforms are the insets and the feather in canvas pixels | DELETE | Private uniform layout; real feather scale/profile pixels own values |
| `crop-order.test.ts:153` — a DOM layer with a feathered crop draws through its own canvas (the feather runs in the chain) | DELETE | Private boolean; real DOM image feather follows the same production branch as text |
| `crop-order.test.ts:177` — crops leave the chain unless an effect that mixes pixels follows them (then a hard cut stays in place) | DELETE | Private effect-list rewrite; actual adjustment layer/Crop/Blur output owners remain |
| `crop-order.test.ts:185` — the region: hard windows intersect, feathered ones are kept with their feather, flips after mirror them | DELETE | Internal region-object shape; actual adjustment/flip/feather pixels retained |
| `crop-order.test.ts:200` — loads with Crop first and renders it first, as v7 did | CONSOLIDATE | Model `migration-v8-crop.test.ts` owns migration; real native/parity output owns rendering; remove duplicated migration + private pipeline execution |
| `playback-audio.test.tsx:55` — picks the clip stream’s playback WAV, falls back to the first, is null while not ready | CONSOLIDATE | Selected-stream/pending cases move to actual browser Program owner; ordinary/proxy URL selection remains in compositions.test.tsx and ordinary real PCM in P0. Impossible stream5 has no independent contract; Source first-stream selection covers the normal fallback use |
| `playback-audio.test.tsx:67` — takes the audio track off <Video> of such media only | DELETE | Arbitrary impossible stream sentinel; Source composition retains muted picture/playback selection |
| `playback-audio.test.tsx:75` — plays the playback audio of the clip’s stream, never the undecodable original | REWRITE | Actual Program preview checks stream frequency/energy, pending silence and decoded red/blue frame seeks |
| `playback-audio.test.tsx:93` — an audio file plays its first playback stream; a video plays its picture muted plus the playback audio | REWRITE | Actual Source audio-only/video previews verify first-stream frequency, PCM/pending silence and decoded picture; remove mocks and arbitrary internal stream-index value |
| `stabilize-transitions.test.ts:23` — takes the new transitions of a track whose clips did not change | REWRITE | Keep literal updated direction; remove unchanged clip identity pin |
| `stabilize-transitions.test.ts:32` — keeps the previous track object when nothing on it changed | DELETE | Object identity change detector; no independent user-visible performance budget |
| `transition-smooth-slide-gl.test.ts:182` — `matches the CPU reference: ${name}` | REWRITE | Five model-derived frame expectations replaced by two concise independent pixel owners above; dead CPU mirror removed by model workstream |
| `transition-smooth-slide-gl.test.ts:189` — ends: progress0 is exactly A and1 exactly B, even with dolly, reflection and High smoothing | KEEP | Whole-frame heavy endpoint owner above |
| `transition-smooth-slide-gl.test.ts:216` — motion blur smears the seam; a wider shutter smears more; Off is sharp | KEEP | Independent visible smear/shutter ordering above |
| `transition-smooth-slide-gl.test.ts:241` — Blurriness softens only the reflection | REWRITE | Independent nonempty alpha-region witnesses replace model-derived mask |
| `transition-smooth-slide-parity.e2e.test.ts:185` — `${name}: the Player matches the export render at every checked frame` | OPTIMIZE | Preserve unique live-preview boundary; engine encoded-span owner retains fullspan, so two representative interior frames replace12 repetitions |

## Removed infrastructure and validation

The entire crop-order unit file is removed. `CROP_FEATHER_GPU` and the two adjustment-layer crop helpers are local
implementation details with no external production callers, so their unnecessary exports are removed. Crossfade
result/ID plumbing and its imported production fade-oracle functions are gone. No golden is re-blessed by cleanup,
no production behavior changes, and no tolerance increases. The model workstream separately removes the CPU-only
Smooth Slide reference functions once their last GL test caller disappears.

Root baseline (Node20.19, two workers, required oracles, Chrome156) passed all33 active cases in these files;
the two opt-in Player cases were skipped. File spans from its JSON: audio13.510s, crop0.085s, playback0.045s,
stabilizer0.037s, SmoothSlideGL1.339s. These overlapping spans exclude different startup portions and must not be
summed into process wall time or compared to an isolated command as a speedup.

## Measured validation and remaining limits

Machine: the shared Linux x64 host with 8 AMD EPYC-Genoa vCPUs and 15 GiB RAM; Node 20.19.0 / pnpm 10.34.5,
Vitest 4.1.11, Chrome 156, system FFmpeg 6.1.1, two Vitest workers. Root reserved this stage without other agent
suites. Filesystem/build caches were not flushed. One original baseline and two post-change samples are
measurements, not a statistical confidence interval or an end-to-end CI estimate.

The original six-file command, with `REMOTION_E2E=1`, passed35/35 cases. Its final task-owned byte snapshots were
restored exactly after the baseline (recorded SHA256s/backup under the evidence directory); no stash was used.
The post-change command passed14/14 cases in five surviving files twice. It includes the stronger real-codec
browser tests, not just test deletion.

| Metric | Original | Post sample1 | Post sample2 |
| --- | ---: | ---: | ---: |
| Whole command GNU wall time |83.06s|50.98s|52.49s|
| Child user+system CPU |114.72s|70.72s|71.07s|
| Largest single-process RSS |1,631,964KiB|1,464,320KiB|1,463,144KiB|
| Player parity test bodies (cut + head) |47.711s|6.080s|6.115s|

Mean observed post wall time51.735s is31.325s/37.71% below this baseline; the two post samples differ by1.51s.
The final explicit High3px seam pixel assertion was added afterward during review and checked separately; the
50.98/52.49s figures describe that earlier measured checkpoint, not an identical final-source claim.

Meaningful infrastructure changes:12 repeated Player/still frames become one representative interior frame for
each of two distinct live preview paths (cut30/head7); the engine encoded-export owner keeps all13 span/baseline
frames. One public Remotion browser is reused for immutable still rendering, while each capture uses a fresh
render page. PNG conversion uses the existing PNG decoder and retains the same RGB24 comparison channels,
>=98% within4/255 and mean<1.5. Actual Player seek acknowledgement, image decode and stable consecutive paint
captures replace a300ms sleep and expected-image filtering; no failed scenario is replayed. Both retained
preview/still frames were pixel-identical in both post runs. The audio crossfade retains its complete1e-4
sample bound (observed worst1.70e-5); its duplicate production-envelope/subwindow scans are gone.

Real playback costs more than the former0.045s mocked file: post file time 25.418 s, with two owner cases and six
independent codec/readiness scenarios. An earlier prototype took37.462s; immutable context reuse with fresh
pages reduced its repeated infrastructure work. This prototype comparison is indicative, not an isolated
causal performance claim because its oracle/setup also changed. Stream identity is now measured PCM frequency,
not a private component prop or HTTP prefetch inventory. Shared state is immutable; each page has a new React
root and audio contexts, and owned processes/pages/temp files are closed/removed.

The tests deliberately do not establish bare Remotion Player cadence. A temporary ordinary AAC/MP4 control
produced live PCM (RMS 0.0637) but ended at held frame 4/5, matching the AC-3 fixture's frame 4 / PCM 0.0625 behavior.
Those exact ordinary control observations are recorded in `clock-ordinary-{program,source}.json`. A later
combined four-scenario diagnostic exceeded its 30 s test envelope after recording three observations; it is not a
passing gate. Actual SourceMonitor and ProgramMonitor both use `PlaybackDriver`; retained P0/P6 application
workflows own continuity. The composition owner separately seeks0→20 to verify real red/blue decoded pictures,
then plays once through the public ended event to verify PCM or silence. This isolates the independently claimed
composition/codec contract without changing production transport.

Four actual production mutations failed their intended assertions, then source bytes were restored:

- Force every Slide direction left: Right's literal red/blue pixels fail.
- Remove the real preview clip fade: crossfade PCM error0.3998678 exceeds1e-4.
- Source selects stream2 instead of the first: actual210.9375Hz exceeds the first-stream130Hz upper bound.
- Reuse a track despite changed transition params: output remains`left`, expected`up`.

The combined restoration/changed-golden command passed8 selected cases in six files (37.17s);590 cases were
explicitly filtered, not executed. It covers all four restored mutant owners, actual crop-corner-pin golden,
and the three generic Smooth Slide catalogue/endpoints/fingerprint owners. No golden was blessed. Actual
composition TypeScript passed with the declared compiler and a4GiB heap; scoped Biome/diff checks passed.

Setup failures were investigated, not deleted to go green: the first prototype used the render field`fps` where
the editing command expects`frameRate`;12fps was then correctly refused, so the fixture uses allowed 30 fps.
A TypeScript tuple-union spread error was corrected with explicit coordinate access. The original time-bounded
bare-Player frame wait was replaced only after the ordinary-codec control established the same non-app clock
behavior. Failed prototype reports remain archived, and no timeout was increased or failure/rejection filter added.

Rerunnable measured command (same six filters before/after; the deleted crop filter simply selects no file;
GNU time records are the matching `compositions-<phase>.time` files):

```sh
env -u NODE_OPTIONS REMOTION_E2E=1 JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm exec vitest run \
  packages/compositions/test/audio-preview-mix-oracle.test.ts \
  packages/compositions/test/crop-order.test.ts \
  packages/compositions/test/playback-audio.test.tsx \
  packages/compositions/test/stabilize-transitions.test.ts \
  packages/compositions/test/transition-smooth-slide-gl.test.ts \
  packages/compositions/test/transition-smooth-slide-parity.e2e.test.ts \
  --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/jasper-test-cleanup/incoming-wave2/compositions-after3.json
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/compositions typecheck
```

The exact mutation/restoration/selected-golden argv, output, JSON reports and source-restoration evidence live
under`/tmp/jasper-test-cleanup/incoming-wave2/compositions-*`. This workstream did not run all unchanged opt-in
rendering, native Rust, packaged desktop or extended fuzz suites. Root's integrated gates remain separately required.



## Incoming golden changes (preserved, not blessed by cleanup)

The second remote integration changes `goldens/scenes/crop-corner-pin.png` and adds three
`jasper.smooth-slide@0.25/0.5/0.75` fingerprint rows. No existing transition fingerprints were changed.
Both old and incoming crop PNGs were inspected visually: the incoming card has the four-edge feather band that
the former hard-cropped picture lacked, matching the incoming fix for the scene's existing Feather6 setting.
An independent decoded comparison found2,515 changed pixels inside x38…205/y16…103 of the256×144 frame; the rest
is unchanged. Old SHA256 `86d741f442571c82309ad0d5519280cee9f690e40eeefb27b2e1be969f7c0775`, incoming
`ec346807bc52839499655109b8c77ba2690eb97a12954b45e020b6e3a5488a4e`. Raw PNGs and comparison metadata are under
`/tmp/jasper-test-cleanup/incoming-wave2/compositions-artifacts/`. This is an upstream rendering correction,
not a cleanup-authored golden update or evidence that all unchanged golden suites ran.

The final actual render PNGs (`cut-30`, `head-7`, crop and blue decoded codec frames) were inspected. Both Slide
preview/still pairs are retained in `compositions-artifacts/`; the actual crop decodes identically to the
incoming golden under both the repository PNG decoder and external FFmpeg (RGBA SHA256
`2e87539838bd526d7b2463c92206d02ff9f1cfbd251a00083965a04a94472863`). No fixture, golden or test output binary is
committed by this cleanup.

Final review's active High3px smoothing witness passed twice on the final source (one selected GL owner,
four other cases filtered):2.66s and2.80s whole runner time. The adjacent seam pixels are independently
[170,0,85,255] and[85,0,170,255]. Final declared composition TypeScript passed again after that addition;
all nine changed code files passed Biome, and the staged diff passed whitespace checks. These checks are
recorded in `compositions-edge-repeat{1,2}.log`, `compositions-typecheck-final.log` and
`compositions-final-short-status.json`. Final playback observations include117.1875Hz for the first110Hz
stream and210.9375Hz for220Hz; all three pending scenarios measured exactly zero energy.
