# Compositions follow-up cleanup

Baseline: `8b4c8936`. Scope: 74 files, 440 named test declarations. Parameterized and registry-driven families count once per declaration, not once per generated runtime case.

The earlier [partition 1](compositions1.md), [partition 2](compositions2.md), and [independent GL review](gl-review.md) already contain test-by-test contract sources, independent pixel/oracle evidence, non-test callers, stable seams and uniqueness analysis for the existing renderer. Their historical deletion totals are not this pass's totals. The current inventory below includes only declarations present at this pass's baseline; current follow-up decisions supersede their older disposition where stated. Additional sound-design tests are reviewed against the independently documented Phase 0/4/6 contracts in [sound-design.md](../wp-notes/sound-design.md).

Disposition totals: **6 DELETE, 2 CONSOLIDATE (removed), 8 REWRITE, 11 OPTIMIZE, 413 KEEP**. Eight named declarations are removed; 432 survive. No expected pixel reference, sample tolerance, supported effect, random-topology count or required gate is weakened.

## Follow-up decisions and six-bar evidence

- **A — private automation tests:** Delete all five tests in `audio-automation.test.ts`. Exact one-point schedules, point counts, sample-grid point representation, classifier booleans and comparison with the same algorithm's coarse mode fail the stable-seam/refactor bar. The ramp tolerance imports its expected threshold from the implementation. Passing NaN into a private callback is not a supported entry-point contract. The actual Chrome `audio-preview-mix-oracle` is the stronger owner: it measures the 24 dB dip, build sweep, clip/track levels, and stereo/5.1 pan at every sample against the export. The sound-design work note records this owner detecting the original coarse automation and cusp failures. This also removes the same-file-only `curvePoints` export, private classifier export and algorithm tuning constant exports.
- **B — legacy keyframe comparison:** Delete the unclocked, continuously playing Amplify test. Production playback now supplies `SlotClock`; the old 1.5 dB approximation is superseded by the exact slot-clock sweep and real graph sample oracle. Paused scrubbing does not continuously process a one-second signal using periodic clockless playback messages. Failure is independent-contract/unique-owner bars. Static all-effect quantum parity survives.
- **C — latency example consolidation:** Remove the single-track and combined fixed plan examples. The surviving 200-topology property checks every route's nonnegative delay and arrival conservation against the independent offline mixer; the Chrome oracle verifies actual clip/track/submix/Mix/limiter timing in samples. The examples add no distinct stable behavior and assert private plan fields. No assertions move because the property already checks their relevant invariants.
- **T — texture sweeps:** Rewrite the default sweep as `opaque input stays opaque with default texture settings`: retain its unique all-generator alpha assertion, which RGB-only fingerprints cannot replace, and remove its arbitrary standard-deviation threshold (stronger default/perturbed committed RGB fingerprint owner). Rewrite the temporal sweep as `animated defaults change over time while still textures stay still`: compare frames 30 and 70 once, retaining the unique static/animated contract while removing undocumented `step < 30` and `far > step` thresholds and duplicate intermediate renders. This halves temporal draws from 84 to 42. Retain precise parameter, seed, still-noise-paint, alpha, jitter-period and characteristic-pixel contracts. Both retained sweeps still need generator discovery, the independent static-generator set and the small fixture size. This changes neither shader output nor golden references.
- **S — effect slot parity:** The independent contract is preview/export audio consistency (AGENTS §4; sound-design Phase 4). Stimuli are deterministic input noise and declared effect instances; expected samples come from the separate export adapter, which can disagree with worklet message handling, snapping or control-clock advancement. The seam is slot message/audio samples, not collaborator calls. Refactoring message internals or processors preserves it. Static all-effect chunk parity and clocked Scientific Filter automation detect different adapter failures. Remove the counterexample run asserting how the obsolete clockless slot differs; the exact current-output assertion survives unchanged.
- **M — real Web Audio mix:** AGENTS §4 and sound-design Phases 0/4 require the same delivered audio from preview and export. Expected data come from the independently running offline mixer plus fixed 24 dB and nonzero-input checks. Real Chrome audio graph samples are the stable boundary; private node layout can change. Static latency/STFT/limiter cases and automated clip/track/pan cases detect different failures and cannot supersede one another. Remove two complete legacy frame-clock renders that were only logged, with no assertions. Remove now-unused harness `frame`/`exact` clock modes and playing toggle. The lag search now starts at zero and abandons only candidates whose nonnegative accumulated error already exceeds the best; it still evaluates every potentially winning candidate and preserves all lag/sample assertions.
- **P — canvas capture:** Independent source is the documented HTML-in-Canvas video-capture regression (prior partition 2; production `SequenceComposition` installs the shim). Expected green/magenta pixels are literal painted colors. Real Chrome late-draw readback is the stable seam and detects broken context forwarding or lost video frames; no other default-gate test isolates the installed shim in real Chrome after a first host paint. Rewrite the fixture to independently capture both requested low-latency and ordinary contexts at the host origin, preserving both exact pixel assertions. The baseline red case followed translated sibling placement, not the context kind: swapping positions made the other context fail; swapping DOM/draw order, resetting/applying the SDK matrix, full layout repaint and SwiftShader did not fix it. Native source pixels and geometry were correct; removing the shim produced the same placement failure. This is a separate native Chrome 156 clipping limitation, not evidence of a Jasper shim failure. Wait for actual paint events and two compositor frames instead of fixed 800 ms sleeps, close capture images/pages, and keep contexts isolated. A real wrong-receiver `original.call(proto, …)` mutant fails with Illegal invocation; restored code passes. Removing the shim does **not** fail on Chrome 156, so the historical desynchronization defect is not claimed reproduced here, and no option-shape assertion is added. The actual production installer is imported/called by a tiny browser entry and loaded through the existing bundler; evaluating the installer source text is removed, so extracting private helpers remains a behavior-preserving refactor. Actual compositor translation/multi-layer validation is still pending the later heavy slot; native translated sibling capture is not claimed fixed or covered success.
- **Q — serial AudioContext loading:** The documented resume/suspend race and Remotion clock-advance requirement (prior partition 2; sound-design Phase 0) are observed through real native promise settlement and output timestamps. Those values are independent of the installer implementation; they expose a stalled resume or picture clock. Preserve all native race stimuli and both outcome assertions. Load the actual production module using a tiny browser entry through the existing bundler instead of evaluating its function text, so private helper extraction does not break the test. This is the lowest live-browser owner of the overlapping lifecycle contract; graph waveform fixtures do not exercise live context suspend/resume races. Remove both production comments requiring installer self-containment for tests; no production API/global is added.
- **G — anchor guard:** The sound-design Phase 6 work note specifies refusing transient later anchors, confirming real drift after 0.3 s of regular frames, dropping picture frames without jumping audio, accepting an earlier anchor, and refusing delayed-frame asks. Expected anchor/event/frame values are fixed by those scenarios, observed through the real graph's Remotion sync boundary. Changing internal bookkeeping leaves them valid. The four tests detect distinct externally audible clock errors beyond static sample parity. Rewrite the real-drift case to expect 9–10 frames at 30 fps from the documented 0.3 s, instead of importing `ANCHOR_CONFIRM` from the implementation. The old assertion changed alongside a bad threshold.
- **L — latency/transport mathematics:** Source: sound-design Phase 0 insert-latency and transport regressions; public `registerPreviewInsert` contract. The 200-topology property independently compares the export mixer's latency and checks route conservation; literal held-read-ahead, gain-limit, sample-rate, segment-order and primed-anchor examples cover different contracts and hostile-entry failure handling. These are numeric scheduling boundaries used by the real graph, not Web Audio collaborator call shapes. Renderer internals may change while the time/delay/gain results remain fixed. Real graph fixtures do not exhaust DAGs, 96 kHz registration or repeated anchor shifts.
- **R — transport waveform ownership:** Sound-design Phases 0/6 specify silence after a seek, one gap of added latency, preserved buffers when topology grows, and held read-ahead after an insert is removed. Real Chrome waveform samples, literal gap bounds and separate export samples independently detect those failures and survive node/plan refactors. Remove only assertions on the private plan in the three live-edit cases; keep every sample, silence, gap and public read-ahead assertion. Delete the production `latencyPlan` getter after confirming all callers are tests; oracle metadata reads production `latency` instead. The dynamic waveform cases have distinct failure modes beyond static latency and pure DAG properties.
- **F — remaining named texture cases:** Shader parameter semantics and determinism/alpha contracts in the shader framework and earlier per-test ledger. Literal color/alpha endpoints, hand-painted coordinates, repeat/seed and jitter-period relationships are independent oracles. Actual GPU output survives renderer refactors. These parameter interactions differ from default/perturbed image pins.

## Removed support and production seams

The browser-sound owner removes the last test consumer of `globalThis.__jasperTransportLog`. A repository caller search finds only that test, the graph sink, its exported type and the historical work note. Remove the global logger, `TransportLogEntry` export/re-export, log calls and arguments/locals used only for logging. Anchor, buffering, priming, delay and restart behavior is unchanged. The anchor guard remains independently tested; browser-sound retains audible waveform/playhead contracts. Six timing constants with no external callers are now private. The unused test-only `latencyPlan` getter and unused browser-helper lead arrays are also removed. Each completed offline graph is disposed: production `fx-inserts.liveSlots` retains strong slot references until disposal, so leaving those test graphs alive retained their nodes and processors across cases. Output AudioBuffers and recorded read-ahead values survive disposal; no graph is shared between cases. No dependency, snapshot or licensed media asset is removed.

The shader compile-budget suite is intentionally retained: [shader framework §17.9](../wp-notes/fx-shader-framework.md#179-swiftshader-compile-budget) independently specifies compiling/linking/drawing every unique effect/transition program plus noise-library stress programs within the configured 5 s reference budget. Pixel correctness alone cannot detect browser stalls. Family GL tests that restart Chrome to bound SwiftShader memory remain isolated; without measured evidence that reuse is safe, sharing their mutable GPU state would trade reliability for speculative speed.

## Current test-by-test disposition

For retained unchanged rows marked **prior ledger**, the cited existing per-case record supplies all six behavioral-bar requirements, the production caller, oracle, failure witness and validation command. The exact current test name below identifies that witness; dynamically expanded cases retain their complete existing input family. Sound rows use the specific six-bar group above plus their explicit failure scenario below.

### packages/compositions/test/anime-template-layer.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| draws the "not installed" card for unknown templates, whatever their stamp (S11:ATP-010) | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/audio-anchor-guard.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a frame committed late (one or two asks for a later anchor): refused, the players are not told | OPTIMIZE | §G: a frame committed late (one or two asks for a later anchor): refused, the players are not told |
| the picture behind for real (asked on every frame, frames regular): it catches up, the audio does not move | REWRITE | §G: the picture behind for real (asked on every frame, frames regular): it catches up, the audio does not move |
| asked on every frame while the frames come late (a busy main thread): only refused | OPTIMIZE | §G: asked on every frame while the frames come late (a busy main thread): only refused |
| an earlier anchor (the picture ahead of the audio clock) is taken and the players are told | OPTIMIZE | §G: an earlier anchor (the picture ahead of the audio clock) is taken and the players are told |

### packages/compositions/test/audio-automation.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a flat stretch is one point at the horizon | DELETE | §A: a flat stretch is one point at the horizon |
| a −24 dB stop-before dip (30 ms ramps) is followed within the tolerance, corners on its keyframes | DELETE | §A: a −24 dB stop-before dip (30 ms ramps) is followed within the tolerance, corners on its keyframes |
| hostile values are scheduled as 0, never NaN | DELETE | §A: hostile values are scheduled as 0, never NaN |
| the graph applies a clip level that changes over time (Volume keyframes, fades, nested gain) | DELETE | §A: the graph applies a clip level that changes over time (Volume keyframes, fades, nested gain) |
| pieces end on sample frames and go down to one sample at a cusp (the 5.1 panner centre gain, a square root) | DELETE | §A: pieces end on sample frames and go down to one sample at a cusp (the 5.1 panner centre gain, a square root) |

### packages/compositions/test/audio-fx-preview.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| $id: identical samples (128-sample quanta vs. irregular mixer blocks) | KEEP | §S: $id: identical samples (128-sample quanta vs. irregular mixer blocks) |
| keyframed parameters: preview (frame-rate updates) stays close to the export (32-sample control rate) | DELETE | §B: keyframed parameters: preview (frame-rate updates) stays close to the export (32-sample control rate) |

### packages/compositions/test/audio-fx-slot-clock.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a keyframed build sweep: identical to the export slot, sample for sample | OPTIMIZE | §S: a keyframed build sweep: identical to the export slot, sample for sample |

### packages/compositions/test/audio-fx-slot-start.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| the first quantum is at the instance value (Amplify −40 dB), not a glide from 0 dB | KEEP | Sound-design Phase 0: initial −40 dB samples, keyed start, click-free edit or actual worklet constructor startup; fixed signal/gain oracle detects the named distinct lifecycle failure. |
| keyframed: the first quantum is at the keyframe value | KEEP | Sound-design Phase 0: initial −40 dB samples, keyed start, click-free edit or actual worklet constructor startup; fixed signal/gain oracle detects the named distinct lifecycle failure. |
| an edit while playing still glides (no click) | KEEP | Sound-design Phase 0: initial −40 dB samples, keyed start, click-free edit or actual worklet constructor startup; fixed signal/gain oracle detects the named distinct lifecycle failure. |
| processes its first quantum with the instance it was created with | KEEP | Sound-design Phase 0: initial −40 dB samples, keyed start, click-free edit or actual worklet constructor startup; fixed signal/gain oracle detects the named distinct lifecycle failure. |

### packages/compositions/test/audio-preview-latency.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a track insert: the other tracks are delayed to it and the graph reads ahead by it | CONSOLIDATE | §C: a track insert: the other tracks are delayed to it and the graph reads ahead by it |
| pre/post-fader sends, a submix insert, Mix inserts and the limiter | CONSOLIDATE | §C: pre/post-fader sends, a submix insert, Mix inserts and the limiter |
| equals the export mixer for any topology, and every route arrives aligned (property) | KEEP | §L: equals the export mixer for any topology, and every route arrives aligned (property) |
| hostile latencies (NaN, negative, Infinity) count as 0; dangling and backward routes are ignored | KEEP | §L: hostile latencies (NaN, negative, Infinity) count as 0; dangling and backward routes are ignored |
| each stage is evaluated at the time of the samples it processes (the export times) | KEEP | §L: each stage is evaluated at the time of the samples it processes (the export times) |
| preview slot latency comes from the registered measurement; no slot or disabled = 0 | KEEP | §L: preview slot latency comes from the registered measurement; no slot or disabled = 0 |
| clip gain above Remotion's +24 dB volume limit is left to the graph (the export applies all of it) | KEEP | §L: clip gain above Remotion's +24 dB volume limit is left to the graph (the export applies all of it) |
| stage times follow the read-ahead the sources use, not only the plan | KEEP | §L: stage times follow the read-ahead the sources use, not only the plan |
| a longer route delay while audio flows appends silence; a shorter one skips from the end | KEEP | §L: a longer route delay while audio flows appends silence; a shorter one skips from the end |
| live route delays: total = target, the kept audio is never reordered (property) | KEEP | §L: live route delays: total = target, the kept audio is never reordered (property) |
| a primed start moves Remotion's anchor by the wait, from Remotion's own value | KEEP | §L: a primed start moves Remotion's anchor by the wait, from Remotion's own value |

### packages/compositions/test/audio-preview-mix-oracle.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| ${kind}: solver gain, room send, stop-before dip and build sweep | OPTIMIZE | §M: ${kind}: solver gain, room send, stop-before dip and build sweep |
| pan sweeps: strip pan, clip pan, the 5.1 puck of a track and of a send, a 5.1 submix pan | OPTIMIZE | §M: pan sweeps: strip pan, clip pan, the 5.1 puck of a track and of a send, a 5.1 submix pan |

### packages/compositions/test/audio-preview-oracle.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| track, submix, Mix and clip effect latency: identical to the export, sample for sample | OPTIMIZE | §M: track, submix, Mix and clip effect latency: identical to the export, sample for sample |
| edits after the graph is built are heard: inserts, faders, pan (same topology) | OPTIMIZE | §M: edits after the graph is built are heard: inserts, faders, pan (same topology) |
| frame-based (STFT) inserts: aligned; identical once past the onset transient | OPTIMIZE | §M: frame-based (STFT) inserts: aligned; identical once past the onset transient |
| loudness normalisation: the preview limiter latency is part of the read-ahead | OPTIMIZE | §M: loudness normalisation: the preview limiter latency is part of the read-ahead |

### packages/compositions/test/audio-preview-transport.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a seek flushes what the graph holds: nothing of the old position after it (delay lines and a reverb tail) | OPTIMIZE | Sound-design Phase 0/6: real Chrome audio samples with an event in flight; export/silence/held-buffer oracle for this exact seek/insert/topology contract, beyond static sample parity. |
| an insert added during playback: one gap of its latency, the read-ahead held, then the new mix late by it | REWRITE | Sound-design Phase 0/6: real Chrome audio samples with an event in flight; export/silence/held-buffer oracle for this exact seek/insert/topology contract, beyond static sample parity. |
| a track added during playback (Hear proposal, an agent): every strip keeps its state, nothing is lost | REWRITE | Sound-design Phase 0/6: real Chrome audio samples with an event in flight; export/silence/held-buffer oracle for this exact seek/insert/topology contract, beyond static sample parity. |
| an insert removed during playback: the Mix is padded to the held read-ahead and stays aligned | REWRITE | Sound-design Phase 0/6: real Chrome audio samples with an event in flight; export/silence/held-buffer oracle for this exact seek/insert/topology contract, beyond static sample parity. |

### packages/compositions/test/audio-primed-clock.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| the e2e trace: a call 85 ms into the resume, while Chrome still said suspended, does not cut the wait | KEEP | Sound-design Phase 0 primed-start trace: independent browser/output timestamp world and Remotion resume protocol; this named timing/stall/clear scenario detects early picture start, independent of clock implementation. |
| Remotion reading after the clock started (21 ms) still waits until the program is at the output | KEEP | Sound-design Phase 0 primed-start trace: independent browser/output timestamp world and Remotion resume protocol; this named timing/stall/clear scenario detects early picture start, independent of clock implementation. |
| Chrome’s transient {currentTime, 0} past the end does not end the wait early | KEEP | Sound-design Phase 0 primed-start trace: independent browser/output timestamp world and Remotion resume protocol; this named timing/stall/clear scenario detects early picture start, independent of clock implementation. |
| property: never before the program reaches the output, at most one poll after, whatever else calls | KEEP | Sound-design Phase 0 primed-start trace: independent browser/output timestamp world and Remotion resume protocol; this named timing/stall/clear scenario detects early picture start, independent of clock implementation. |
| a stall during the wait: the resume after it waits only for what is left | KEEP | Sound-design Phase 0 primed-start trace: independent browser/output timestamp world and Remotion resume protocol; this named timing/stall/clear scenario detects early picture start, independent of clock implementation. |
| no wait: timestamps pass through; clear() ends a wait | KEEP | Sound-design Phase 0 primed-start trace: independent browser/output timestamp world and Remotion resume protocol; this named timing/stall/clear scenario detects early picture start, independent of clock implementation. |

### packages/compositions/test/audio-worklet-limiter.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| re-enabled after a bypass it starts clean (no stale look-ahead audio) | KEEP | Sound-design Phase 0: real worklet output must stay silent after bypass reset / finite and ceiling-bounded with invalid config; literal silence/ceiling oracle, unique message lifecycle. |
| a non-finite ceiling falls back to −1 dBTP instead of producing NaN | KEEP | Sound-design Phase 0: real worklet output must stay silent after bypass reset / finite and ceiling-bounded with invalid config; literal silence/ceiling oracle, unique message lifecycle. |

### packages/compositions/test/blend-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| GL compositor = blendPixel: %s | KEEP | [prior ledger 2](compositions2.md) |
| color-mgmt: Blend using 1.0 gamma composites in linear light of the working curve | KEEP | [prior ledger 2](compositions2.md) |
| Dissolve keeps about opacity × pixels and changes with the seed | KEEP | [prior ledger 2](compositions2.md) |
| places a moved half-size layer and composites mattes | KEEP | [prior ledger 2](compositions2.md) |
| stencil and silhouette act on the stack below | KEEP | [prior ledger 2](compositions2.md) |
| Chrome CSS mix-blend-mode = blendPixel: %s | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/captions.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| draws the caption page active at the selected frame | KEEP | [prior ledger 1, current named scenario](compositions1.md) |
| hidden caption tracks are not drawn | KEEP | [prior ledger 1](compositions1.md) |
| karaoke highlight colours the words spoken so far | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/capture-safe-canvas.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| captures late draws from low-latency and ordinary canvases | REWRITE | §P: captures late draws from low-latency and ordinary canvases |

### packages/compositions/test/color-mgmt.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a render refuses an unsupported nested canvas and identifies both scopes | KEEP | [prior ledger 2, current named scenario](compositions2.md) |

### packages/compositions/test/color.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| reuses an imported LUT when a render URL is re-signed | KEEP | [prior ledger 2](compositions2.md) |
| a malformed LUT settles as unavailable instead of blocking the render | KEEP | [prior ledger 2](compositions2.md) |
| matches the independent project LUT reference and leaves alpha untouched | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/compositions.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| computes fps, size and duration from the document | KEEP | [prior ledger 2](compositions2.md) |
| computes asset metadata for the Source monitor | KEEP | [prior ledger 2](compositions2.md) |
| renders the Media Offline card for offline media | KEEP | [prior ledger 2](compositions2.md) |
| plays the proxy of an original the browser cannot decode, and renders it off-thread | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/compositor-player.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| video under an adjustment layer and a GL blend: the decoded frames reach the compositor | KEEP | [prior ledger 2](compositions2.md) |
| a nest with effects whose nested sequence nests scopes draws as a canvas source | KEEP | [prior ledger 2](compositions2.md) |
| an adjustment layer over a 3D run | KEEP | [prior ledger 2](compositions2.md) |
| the HDR display transform keeps running while a GL blend scope draws inside it | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/compositor.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a GL blend-mode track over an adjustment layer with GPU effects | KEEP | [prior ledger 1](compositions1.md) |
| an adjustment layer limited by its crop and opacity over a GL blend (the scope mix, padded layout) | KEEP | [prior ledger 1](compositions1.md) |
| a DOM layer with GPU effects under a GL blend-mode track | KEEP | [prior ledger 1](compositions1.md) |
| a DOM layer with GPU effects under an adjustment layer with GPU effects | KEEP | [prior ledger 1](compositions1.md) |
| a GPU transition between DOM layers under an adjustment layer | KEEP | [prior ledger 1](compositions1.md) |
| a visible DOM track read as a Track Matte under an adjustment layer | KEEP | [prior ledger 1](compositions1.md) |
| linear-light blending with a DOM layer with GPU effects between the blended tracks | KEEP | [prior ledger 1](compositions1.md) |
| a 3D run over a GL blend-mode track = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| a GL blend-mode track over a 3D run = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| an adjustment layer with GPU effects over a 3D run = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| a 3D run over an adjustment layer with GPU effects = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| two GL blend-mode tracks separated by a 3D run = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| a nest with GPU effects whose nested sequence nests scopes, under a GL blend (canvas source) | KEEP | [prior ledger 1](compositions1.md) |
| a nest whose nested sequence holds a GL blend, under an adjustment layer with GPU effects | KEEP | [prior ledger 1](compositions1.md) |
| parity: an adjustment layer whose GPU blur pads its layout (soft borders) over video | KEEP | [prior ledger 1](compositions1.md) |
| parity: a GL blend mode over video and a rotated DOM text layer | KEEP | [prior ledger 1](compositions1.md) |
| parity: Stencil Alpha over video reveals the background | KEEP | [prior ledger 1](compositions1.md) |
| parity: a 3D run over video | KEEP | [prior ledger 1](compositions1.md) |
| parity: linear-light blending of video, text and a translucent solid | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/edit-structure-render.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| draws a nested sequence at the nested frame, scaled by the nest clip, at 2× speed | KEEP | [prior ledger 2](compositions2.md) |
| applies an adjustment layer to the tracks below (CSS mode, then canvas mode with opacity and crop) | KEEP | [prior ledger 2](compositions2.md) |
| limits an adjustment layer to its Opacity mask (wp masks) | KEEP | [prior ledger 2](compositions2.md) |
| draws Bars and Tone and the counting leader | KEEP | [prior ledger 2](compositions2.md) |
| holds a frame of a moving video | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fonts-ready.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a text layer is not mounted (no fallback-font paint, no measuring) until its face loads | KEEP | [prior ledger 1](compositions1.md) |
| a face that fails to load counts as settled: the text renders with the fallback stack | KEEP | [prior ledger 1](compositions1.md) |
| faces already loaded on the page never hide the layer again (no blink on a new document) | KEEP | [prior ledger 1](compositions1.md) |
| keeps a pending weight unready after another weight of the same family loads | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-compile-budget.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| every effect and transition program compiles within ${BASE_BUDGET} ms (× host load unless PERF=1) | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| matches golden pixels for ${id} at default and perturbed settings | KEEP | [prior ledger 1, current named scenario](compositions1.md) |
| keeps the picture upright and premultiplied alpha intact | KEEP | [prior ledger 1](compositions1.md) |
| glow: threshold → half-res blur → light, drawn into the padding | KEEP | [prior ledger 1](compositions1.md) |
| generator: a gradient over the layer box | KEEP | [prior ledger 1](compositions1.md) |
| drop shadow: offset into the padding, under the layer | KEEP | [prior ledger 1](compositions1.md) |
| time samples: the source over earlier frames | KEEP | [prior ledger 1](compositions1.md) |
| media params are bound with their size; missing media read as size 0 | KEEP | [prior ledger 1](compositions1.md) |
| colour runs on the shared host match the LUT (tetrahedral, the colour stage shader) | KEEP | [prior ledger 1](compositions1.md) |
| half-float intermediates keep values above 1 | KEEP | [prior ledger 1](compositions1.md) |
| ping-pong outputs: update passes read the previous contents under the same name | KEEP | [prior ledger 1](compositions1.md) |
| absolute pass sizes (a 1×1 lookup pass) | KEEP | [prior ledger 1](compositions1.md) |
| mipmapped outputs and source: textureLod at a coarse level averages | KEEP | [prior ledger 1](compositions1.md) |
| ivec2 uniforms | KEEP | [prior ledger 1](compositions1.md) |
| lut media params bind .cube LUTs as 3D textures (identity when none) | KEEP | [prior ledger 1](compositions1.md) |
| u_sampleCount / u_sampleOffsets / u_sampleValid are bound in passes that do not sample | KEEP | [prior ledger 1](compositions1.md) |
| one-direction Gaussian Blur runs as a GPU stand-in in the chain (vertical only) | KEEP | [prior ledger 1](compositions1.md) |
| Transform: Shutter Angle motion blur from the params at sub-frame times | KEEP | [prior ledger 1](compositions1.md) |
| a shader that does not compile throws FxShaderError with the driver log | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-keying-matte-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Screen Keyer: keys the screen, keeps the foreground, keys a 50 % mix by half and despills it | KEEP | [prior ledger 2](compositions2.md) |
| Screen Keyer: clip white, gain, views, status | KEEP | [prior ledger 2](compositions2.md) |
| Screen Keyer: inside mask forces opacity, outside mask transparency (roto objects) | KEEP | [prior ledger 2](compositions2.md) |
| Screen Keyer: foreground colour suppression and source crops | KEEP | [prior ledger 2](compositions2.md) |
| Refine Soft Matte: feathers the edge, Shift Edge grows it, Invert inverts, view edge region tints | KEEP | [prior ledger 2](compositions2.md) |
| Key Cleaner: keeps opaque pixels, raises alpha contrast of soft ones | KEEP | [prior ledger 2](compositions2.md) |
| Advanced Spill Suppressor: Standard finds green and removes it; Ultra respects Tolerance | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-layers.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| without WebGL2 the preview bypasses shader effects visibly (chip), never silently | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-motion-blur-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| motion blur off or no motion: identical to the pre-wave-5 output (golden frames) | KEEP | [prior ledger 2](compositions2.md) |
| fast moves smear continuously: no gaps or periodic peaks across the smear | KEEP | [prior ledger 2](compositions2.md) |
| deterministic: same pixels on re-render and in any frame order (no frame-random jitter) | KEEP | [prior ledger 1](compositions1.md) |
| a different seed changes the grain of a capped smear | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-object-matte-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| states: no object passes through, a matte cuts out, outside the span is transparent | KEEP | [prior ledger 2](compositions2.md) |
| Shift Edge moves the edge by 10 px per 100 %, Feather softens, Contrast hardens | KEEP | [prior ledger 2](compositions2.md) |
| Reduce Chatter averages towards the neighbouring frames | KEEP | [prior ledger 2](compositions2.md) |
| motion blur smears the edge along the neighbours’ motion | KEEP | [prior ledger 2](compositions2.md) |
| views: alpha, overlay and boundary | KEEP | [prior ledger 2](compositions2.md) |
| decontamination removes the background colour from soft edges | KEEP | [prior ledger 2](compositions2.md) |
| Object Blur: mosaic / fill inside, everything else, matte view | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-player.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a paused video frame goes through the shader chain (headless <Video> → FxPicture) | KEEP | [prior ledger 1](compositions1.md) |
| a freeze frame shows the frozen source frame | KEEP | [prior ledger 1](compositions1.md) |
| a still with a padded drop shadow, and a paused param edit redraws it | KEEP | [prior ledger 1](compositions1.md) |
| Transform Shutter Angle motion blur from the keyframes, as in renders | KEEP | [prior ledger 1](compositions1.md) |
| a shape (DOM layer) runs its shader effects through HTML-in-Canvas | KEEP | [prior ledger 1](compositions1.md) |
| without HTML-in-Canvas the DOM layer shows a chip and draws unprocessed | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-premiere-adjust-color-keying-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Auto Levels / Auto Contrast / Auto Color stretch a low-contrast ramp to black and white | KEEP | [prior ledger 1](compositions1.md) |
| Convolution Kernel, Extract, Levels, Lighting Effects, ProcAmp | KEEP | [prior ledger 1](compositions1.md) |
| blurs: camera, channel (alpha pads), compound (map), directional (one axis), interlace (vertical only) | KEEP | [prior ledger 1](compositions1.md) |
| Sharpen and Unsharp Mask overshoot at an edge; Unsharp Mask respects its threshold | KEEP | [prior ledger 1](compositions1.md) |
| Invert channels and Blend With Original | KEEP | [prior ledger 1](compositions1.md) |
| Arithmetic, Calculations, Compound Arithmetic, Blend, Set Matte, Solid Composite | KEEP | [prior ledger 1](compositions1.md) |
| colour corrections change what they should | KEEP | [prior ledger 1](compositions1.md) |
| Image Control: Color Balance (RGB), Color Pass, Color Replace, Gamma Correction | KEEP | [prior ledger 1](compositions1.md) |
| Ultra Key removes the key colour, keeps other colours, and shows its matte | KEEP | [prior ledger 1](compositions1.md) |
| Color Key, Luma Key, Non Red Key, Alpha Adjust, Remove Matte | KEEP | [prior ledger 1](compositions1.md) |
| Difference Matte, Image Matte Key and Track Matte Key use their media layers | KEEP | [prior ledger 1](compositions1.md) |
| Drop Shadow and Radial Shadow draw into the padding | KEEP | [prior ledger 1](compositions1.md) |
| Bevel Alpha / Bevel Edges light the upper-left and shade the lower-right; Basic 3D; Transform; Edge Feather | KEEP | [prior ledger 1](compositions1.md) |
| Cineon Converter maps the 10-bit black/white points to black/white | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-psdg-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| neutral defaults leave the picture untouched | KEEP | [prior ledger 2](compositions2.md) |
| Distort | KEEP | [prior ledger 1](compositions1.md) |
| Generate | KEEP | [prior ledger 2](compositions2.md) |
| Noise & Grain | KEEP | [prior ledger 2](compositions2.md) |
| Stylize | KEEP | [prior ledger 2](compositions2.md) |
| Transition bin | KEEP | [prior ledger 2](compositions2.md) |
| Time: Echo combines the current frame with earlier frames | KEEP | [prior ledger 2](compositions2.md) |
| Video: text burn-ins | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-psdg-light-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| vignette: identity at Amount 0, darkens or lightens the corners only | KEEP | [prior ledger 2](compositions2.md) |
| vignette keeps alpha (transparent stays transparent) | KEEP | [prior ledger 2](compositions2.md) |
| glow: light around bright areas, spilling into the padding | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-render.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| solid + generator: the gradient fills the layer | KEEP | [prior ledger 1](compositions1.md) |
| still + drop shadow: the shadow is drawn outside the layer box (padding) | KEEP | [prior ledger 1](compositions1.md) |
| video + half-opacity generator: the decoded frame goes through the chain upright | KEEP | [prior ledger 1](compositions1.md) |
| time remap: a freeze frame shows the source at the frozen frame | KEEP | [prior ledger 1](compositions1.md) |
| time samples: an earlier frame is decoded for its own frame (deterministic) | KEEP | [prior ledger 1](compositions1.md) |
| time samples compose with remaps: an echo below a freeze shows the frozen picture | KEEP | [prior ledger 1](compositions1.md) |
| params at sub-frame times: Transform Shutter Angle motion-blurs keyframed motion | KEEP | [prior ledger 1](compositions1.md) |
| shape (DOM layer, HTML-in-Canvas) + drop shadow | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sapphire-adjust-composite-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| adjust effects: one characteristic pixel each | KEEP | [prior ledger 2](compositions2.md) |
| S_OCIOTransform encodes 18% gray at published reference levels | KEEP | [prior ledger 2](compositions2.md) |
| alpha is kept and the Mask block blends effect and source | KEEP | [prior ledger 2](compositions2.md) |
| S_Layer: blend modes, opacity, swap, matte, result controls | KEEP | [prior ledger 2](compositions2.md) |
| S_MathOps: per-channel operations, alpha as a channel unless All Opaque | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: identity preserves the original edge | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: %s grows the matte | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: %s shrinks the matte | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: Matte output is an opaque grayscale mask | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: Invert selects the original exterior | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: Post Blur softens the edge | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOps: noise follows Seed and Jitter Frames deterministically | KEEP | [prior ledger 2](compositions2.md) |
| S_MatteOpsComp: the grown matte composites the layer over the Background | KEEP | [prior ledger 2](compositions2.md) |
| S_EdgeFlash: light crosses the edge both ways, composite and outputs | KEEP | [prior ledger 2](compositions2.md) |
| S_ZComp: the nearer picture wins, Invert Z, anti-alias blend, no depth = A over B | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-adjust-composite.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| media masks preserve outside pixels and composites reveal their background | KEEP | [prior ledger 1, current named scenario](compositions1.md) |

### packages/compositions/test/fx-sapphire-blur-sharpen-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_Blur: identity at 0, a smooth ramp across an edge, Mix With Source restores the source | KEEP | [prior ledger 2](compositions2.md) |
| transparent input stays transparent; Soft Borders draw into the padding | KEEP | [prior ledger 2](compositions2.md) |
| S_RackDefocus: a bright point becomes a uniform disc (circle) or a polygon | KEEP | [prior ledger 2](compositions2.md) |
| S_DefocusPrism: highlights become coloured rings (channels at different radii) | KEEP | [prior ledger 2](compositions2.md) |
| S_Sharpen leaves flat areas alone; S_Median removes salt-and-pepper noise | KEEP | [prior ledger 2](compositions2.md) |
| S_Deband smooths the steps of a banded gradient but keeps real edges | KEEP | [prior ledger 2](compositions2.md) |
| S_BlurDirectional streaks along its angle only | KEEP | [prior ledger 2](compositions2.md) |
| S_ZDefocus / S_ZBlur: only what is away from the focal depth is blurred | KEEP | [prior ledger 2](compositions2.md) |
| S_Beauty keys skin tones (Show: Skin Detect Mask) | KEEP | [prior ledger 2](compositions2.md) |
| S_EdgeBlur finds edges (Show: Edges) and S_Convolve stamps its kernel | KEEP | [prior ledger 2](compositions2.md) |
| random parts are deterministic: FreeLens shake and AdvancedDefocus grain | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-distort-warp-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| %s preserves transparent input at its defaults | KEEP | [prior ledger 2](compositions2.md) |
| %s identity settings return the source | KEEP | [prior ledger 2](compositions2.md) |
| %s enlarges the centre disc | KEEP | [prior ledger 1, current named scenario](compositions1.md) |
| negative fish-eye amounts shrink the disc and preserve visible pixels | KEEP | [prior ledger 2](compositions2.md) |
| S_WarpTransform moves the picture and pads the layer to keep it | KEEP | [prior ledger 1](compositions1.md) |
| S_WarpCornerPin: inside the quad the picture, outside transparent | KEEP | [prior ledger 1](compositions1.md) |
| S_WarpPolar draws a disk: transparent outside the outer radius, the picture inside | KEEP | [prior ledger 1](compositions1.md) |
| S_Shake: deterministic per seed, different seeds differ, moves over time, pads small layers | KEEP | [prior ledger 1](compositions1.md) |
| random and animated warps: seeds and time change the picture deterministically | KEEP | [prior ledger 1](compositions1.md) |
| S_WarpDrops ripples around the bright spots of the Centers map only | KEEP | [prior ledger 1](compositions1.md) |
| S_Distort follows the Lens: a flat lens changes nothing, the dots lens warps | KEEP | [prior ledger 1](compositions1.md) |
| S_DistortRGB separates the channels at lens edges | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sapphire-distort-warp.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a warp moves a small still outside its box (padding), into the sequence frame | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-film-grain-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| %s Mix with Orig = 1 returns the input | KEEP | [prior ledger 2](compositions2.md) |
| %s is deterministic and follows Seed | KEEP | [prior ledger 2](compositions2.md) |
| %s changes from frame to frame | KEEP | [prior ledger 2](compositions2.md) |
| fully transparent input stays transparent (filters; S_Grunge renders over its background) | KEEP | [prior ledger 2](compositions2.md) |
| S_Vignette darkens the corners, keeps the centre | KEEP | [prior ledger 2](compositions2.md) |
| S_Grain adds zero-mean noise of the stock amplitude | KEEP | [prior ledger 2](compositions2.md) |
| S_BleachBypass desaturates | KEEP | [prior ledger 2](compositions2.md) |
| S_VintageColor2Strip has no true blue | KEEP | [prior ledger 2](compositions2.md) |
| S_VintageColor3Strip keeps saturated colours, Show: Pure Colors shows the separations | KEEP | [prior ledger 2](compositions2.md) |
| S_JpegDamage quantises in 8×8 blocks (a smooth gradient becomes stepped) | KEEP | [prior ledger 2](compositions2.md) |
| S_ScanLines draws periodic dark lines; Lines Sharpness 0 removes them | KEEP | [prior ledger 2](compositions2.md) |
| S_FilmBurn: the flashes light the picture; with every element off it is the input | KEEP | [prior ledger 2](compositions2.md) |
| S_TVDamage Turn Off = 1 ends on black | KEEP | [prior ledger 2](compositions2.md) |
| S_Grunge draws stamps (Grunge Only shows them alone) | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-film-grain.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_DigitalDamage freeze shows the held frame (time sample) | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sapphire-glows-lighting-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| %s adds light next to a bright source and leaves far black alone | KEEP | [prior ledger 1](compositions1.md) |
| S_Glow: Width X stretches the glow horizontally; Show Threshold shows the threshold image | KEEP | [prior ledger 1](compositions1.md) |
| S_Glow pads the canvas and lights transparent pixels outside the layer box (Expand Borders) | KEEP | [prior ledger 1](compositions1.md) |
| S_GlowDarks and S_GlowOrthicon darken (around) their sources | KEEP | [prior ledger 1](compositions1.md) |
| S_Rays casts light away from Center; S_Streaks smears the brights | KEEP | [prior ledger 1](compositions1.md) |
| S_LensFlare draws its hotspot at the Hotspot point; S_LensFlareAutoTrack finds the bright dot | KEEP | [prior ledger 1](compositions1.md) |
| S_DropShadow draws the shifted shadow outside the layer box, under the layer | KEEP | [prior ledger 1](compositions1.md) |
| S_SpotLight lights the aim point and leaves the rest at the ambient level | KEEP | [prior ledger 1](compositions1.md) |
| S_Light3D relights the relief of the image (no Normals clip) | KEEP | [prior ledger 1](compositions1.md) |
| S_BokehLights is deterministic and changes with the seed | KEEP | [prior ledger 1](compositions1.md) |
| S_Flashbulbs is deterministic per frame and changes between frames | KEEP | [prior ledger 1](compositions1.md) |
| S_LightLeak drifts over time | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sapphire-glows-lighting-render.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_DropShadow on a still is drawn outside the layer box | KEEP | [prior ledger 2](compositions2.md) |
| S_Flashbulbs (time-dependent) differs between frames | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-paint-kaleido-edges-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Mix with Orig = 1 gives the input back | KEEP | [prior ledger 1](compositions1.md) |
| kaleidoscopes and tiles are the identity at Kaleido Amount 0 / unit zoom | KEEP | [prior ledger 1](compositions1.md) |
| S_Kaleido:Squares mirrors the picture around the centre | KEEP | [prior ledger 1](compositions1.md) |
| edges: a black\|white step lights up only at the edge; direction and colour follow the edge side | KEEP | [prior ledger 1](compositions1.md) |
| halftones: black where the picture is black, paper where it is white | KEEP | [prior ledger 1](compositions1.md) |
| posterize quantises a ramp into a few levels | KEEP | [prior ledger 1](compositions1.md) |
| emboss keeps a flat picture and shades a relief from the light side | KEEP | [prior ledger 1](compositions1.md) |
| transparent input stays transparent | KEEP | [prior ledger 1](compositions1.md) |
| seeded strokes: deterministic, different per seed, stable over time unless jittered | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sapphire-render-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_Zap: a bright bolt over the source, deterministic, animated by Wiggle and re-drawn by Seed | KEEP | [prior ledger 2](compositions2.md) |
| S_Zap: Jitter Frames re-draws the bolt each period, constant inside a period without wiggle | KEEP | [prior ledger 2](compositions2.md) |
| characteristic pixels: gradients, grid, shape, laser beam | KEEP | [prior ledger 2](compositions2.md) |
| alpha: generators keep a transparent input transparent (Copy From Input); light adds alpha (Affect Alpha) | KEEP | [prior ledger 2](compositions2.md) |
| every random generator is deterministic and re-seeded by Seed | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-stylize-other-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| transparent input stays transparent | KEEP | [prior ledger 1](compositions1.md) |
| colour effects keep the alpha of a half-transparent input | KEEP | [prior ledger 2](compositions2.md) |
| Mix with Orig = 1 returns the input | KEEP | [prior ledger 2](compositions2.md) |
| S_BandPass: a flat picture becomes the Offset Darks grey; edges stand out | KEEP | [prior ledger 2](compositions2.md) |
| S_ColorFuse: no LUT = identity, a built-in look, and a 2D LUT image (strip) inverting colours | KEEP | [prior ledger 2](compositions2.md) |
| S_DogVision: red seen yellow-blue is a dark yellow | KEEP | [prior ledger 2](compositions2.md) |
| S_Mosaic: blocks of the average colour | KEEP | [prior ledger 2](compositions2.md) |
| S_PixelMosh: the hold frame pushed by the block motion; without samples the source | KEEP | [prior ledger 2](compositions2.md) |
| S_PixelSort: columns sorted dark → bright downwards (reversed on request), threshold matte | KEEP | [prior ledger 2](compositions2.md) |
| S_PseudoColor: black stays black, mid tones turn saturated | KEEP | [prior ledger 2](compositions2.md) |
| seeded and animated effects are deterministic; the seed and Phase Speed change them | KEEP | [prior ledger 2](compositions2.md) |
| S_RomanTile: tiles of the picture set in grout of the Grout Color | KEEP | [prior ledger 2](compositions2.md) |
| S_Solarize: colours above the threshold are inverted | KEEP | [prior ledger 2](compositions2.md) |
| S_StripSlide: Amount 0 = the picture, 1 = the Background (transparent without one) | KEEP | [prior ledger 2](compositions2.md) |
| S_Zebrafy: black stays black, 1/(2·Frequency) luminance turns white | KEEP | [prior ledger 2](compositions2.md) |
| S_ZFog: depth from the ZBuffer (type/use) or the fallback; exponential density | KEEP | [prior ledger 2](compositions2.md) |
| the Mask input restricts the effect (and inverts) | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-stylize-other.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_PixelMosh: the held frame moshed by the zoom, deterministic across renders | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sapphire-textures-clouds-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| draws a non-flat, opaque texture with default params | REWRITE | §T: draws a non-flat, opaque texture with default params |
| animates continuously: small change per frame, more over seconds (still textures stay still) | REWRITE | §T: animates continuously: small change per frame, more over seconds (still textures stay still) |
| is deterministic; the Seed param and the instance seed change the pattern | KEEP | §F: is deterministic; the Seed param and the instance seed change the pattern |
| combine, background brightness, output opacity and mix with original | KEEP | §F: combine, background brightness, output opacity and mix with original |
| tiles: a tile sits on the layer centre; Invert swaps it | KEEP | §F: tiles: a tile sits on the layer centre; Invert swaps it |
| spots: without warp, spots on the cell centres and gaps on the corners | KEEP | §F: spots: without warp, spots on the cell centres and gaps on the corners |
| moire: the rings are centred on A Center (bright crest at phase 0) | KEEP | §F: moire: the rings are centred on A Center (bright crest at phase 0) |
| clouds perspective: past the horizon the clouds fade to their mean | KEEP | §F: clouds perspective: past the horizon the clouds fade to their mean |
| plasma and neurons: the glow adds light around the lines | KEEP | §F: plasma and neurons: the glow adds light around the lines |
| noise paint: Jitter Frames re-randomises the strokes only every N frames | KEEP | §F: noise paint: Jitter Frames re-randomises the strokes only every N frames |

### packages/compositions/test/fx-sapphire-time-flicker-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| remaps draw the remapped input; Swap Fields Yes Up1 moves it up one pixel | KEEP | [prior ledger 2](compositions2.md) |
| S_GetFrame blends towards the next frame by the fraction of Get Frame | KEEP | [prior ledger 2](compositions2.md) |
| S_Trails: Max keeps old and new, Ave weights by Prev Brightness, transparent stays transparent | KEEP | [prior ledger 2](compositions2.md) |
| S_TimeAverage averages the window; S_TimeWarpRGB takes each channel from its own frame | KEEP | [prior ledger 2](compositions2.md) |
| S_MotionDetect is black without motion and shows the difference with it | KEEP | [prior ledger 2](compositions2.md) |
| S_NearestColor keeps the colour nearest to Match Color (blue) | KEEP | [prior ledger 2](compositions2.md) |
| S_TimeSlice / S_TimeDisplace pick each region’s frame | KEEP | [prior ledger 2](compositions2.md) |
| S_CutToDissolve mixes the two sides inside the window and passes through outside | KEEP | [prior ledger 2](compositions2.md) |
| S_RepairFrames replaces the bad frame by the in-between of its neighbours | KEEP | [prior ledger 2](compositions2.md) |
| S_Retime interpolates along the motion (not a cross-fade) and can show the flow vectors | KEEP | [prior ledger 2](compositions2.md) |
| S_FieldRemove deinterlaces combs only | KEEP | [prior ledger 2](compositions2.md) |
| S_Flicker scales the colours per frame; the seed changes the pattern | KEEP | [prior ledger 2](compositions2.md) |
| flicker remove/match tools hold or copy the measured level | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/fx-sapphire-time-flicker.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_FreezeFrame holds the first frame of each group; S_ReverseClip plays backwards | KEEP | [prior ledger 1](compositions1.md) |
| S_Trails is deterministic under out-of-order renders | KEEP | [prior ledger 1](compositions1.md) |
| S_FlickerRemove flattens the frame-to-frame brightness of a flickering clip | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-sim-warp-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| preserves premultiplied alpha across simulation effects | KEEP | [prior ledger 1, current named scenario](compositions1.md) |
| weather: rain, snow, bubbles, drizzle, star burst | KEEP | [prior ledger 1](compositions1.md) |
| particles: types, seek = play, gravity, floor, guides, 2D direction, mercury | KEEP | [prior ledger 1](compositions1.md) |
| cards: Card Dance, Card Wipe, Pixel Polly | KEEP | [prior ledger 1](compositions1.md) |
| shatter: intact at rest for every pattern, breaks, render modes, wireframes | KEEP | [prior ledger 1](compositions1.md) |
| pixel effects: Ball Action, Scatterize, Hair | KEEP | [prior ledger 1](compositions1.md) |
| surfaces: Foam, Wave World, Caustics | KEEP | [prior ledger 1](compositions1.md) |
| Particle Playground: cannon seek, gravity, wall, repel, text, layer exploder | KEEP | [prior ledger 1](compositions1.md) |
| distort: Displacement Map, Optics Compensation, Polar, Bezier Warp, Reshape, Smear | KEEP | [prior ledger 1](compositions1.md) |
| warps: Mesh Warp, Liquify, Puppet | KEEP | [prior ledger 1](compositions1.md) |
| ${c.id}: deterministic${c.seeded === false ? '' : ', seeded'}${c.animated === false ? '' : ', animated'} | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/fx-warp-stabilizer-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| No Motion locks the frame (${method}) | KEEP | [prior ledger 1](compositions1.md) |
| Subspace Warp renders through its mesh | KEEP | [prior ledger 1](compositions1.md) |
| Stabilize Only leaves the uncovered edge transparent; no analysis passes through | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/golden-scenes.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| ${scene.name}: ${scene.covers} | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/imports-layers.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| samples the Lottie frame at the clip time | KEEP | [prior ledger 1](compositions1.md) |
| follows an assumed frame rate and a loop (Interpret Footage) | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/lottie-assets.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| evicts failed reads so a repaired document can load | KEEP | [prior ledger 1](compositions1.md) |
| rejects non-object JSON instead of passing it to the player | KEEP | [prior ledger 1](compositions1.md) |
| rejects a missing picture instead of returning an empty SVG | KEEP | [prior ledger 1](compositions1.md) |
| rejects a stalled renderer instead of waiting indefinitely | KEEP | [prior ledger 1, current named scenario](compositions1.md) |

### packages/compositions/test/lumetri-spatial-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| HSL Secondary corrects only the selected colors and supports Invert | KEEP | [prior ledger 2](compositions2.md) |
| HSL key softness covers half of the hue and lightness transition bands | KEEP | [prior ledger 2](compositions2.md) |
| Show Mask preserves selected color or white and marks excluded pixels gray or black | KEEP | [prior ledger 2](compositions2.md) |
| three-way highlight level brightens neutral midgray by the documented gain | KEEP | [prior ledger 2](compositions2.md) |
| HSL eyedroppers select the picked colors through the rendered mask | KEEP | [prior ledger 2](compositions2.md) |
| vignette darkens or lightens corners, keeps the center and follows roundness | KEEP | [prior ledger 2](compositions2.md) |
| Denoise fills speckle holes of the key; Blur softens its edge | KEEP | [prior ledger 2](compositions2.md) |
| Sharpen raises edge contrast, negative Sharpen softens; HSL Sharpen only inside the key | KEEP | [prior ledger 2](compositions2.md) |
| transparent pixels stay transparent | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/masks-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| GL coverage equals the CPU rasteriser: ${name} | KEEP | [prior ledger 1](compositions1.md) |
| Opacity masks and a masked effect inside the effect chain | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/masks-render.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Opacity masks: every pixel equals the CPU coverage (the native kernel’s) within 2/255 | KEEP | [prior ledger 1](compositions1.md) |
| a masked effect applies inside its mask only | KEEP | [prior ledger 1](compositions1.md) |
| Track Matte Key reads a hidden track: alpha, luma and reverse | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/mg-host-remote.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| applies metadata overrides and clamps seeks after configuration changes | KEEP | [prior ledger 1, current named scenario](compositions1.md) |
| reports page failures as typed errors, one line, never a stack | KEEP | [prior ledger 1](compositions1.md) |
| reaches the text probe through the port: locate, hide, restore, fonts | KEEP | [prior ledger 1](compositions1.md) |
| the agent takes its port only from the embedding window, and knows no other operation | KEEP | [prior ledger 1](compositions1.md) |
| replaces localStorage, sessionStorage and document.cookie only where the real ones throw | KEEP | [prior ledger 1](compositions1.md) |
| refuses metadata that would size layers and buffers by the page’s word | KEEP | [prior ledger 1](compositions1.md) |
| a page that answers configure with garbage is a protocol error, not a crash | KEEP | [prior ledger 1](compositions1.md) |
| error codes and messages from the page are bounded and mapped to known codes | KEEP | [prior ledger 1](compositions1.md) |
| a page that never answers times out; replies to unknown or reused ids are ignored | KEEP | [prior ledger 1](compositions1.md) |
| measurements are matched to what was asked and scrubbed | KEEP | [prior ledger 1](compositions1.md) |
| font sources may only point at bundle files of the editor’s origin, data: or https: | KEEP | [prior ledger 1](compositions1.md) |
| fonts are bounded in count and bytes, and unsafe faces are dropped | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/previews.test.tsx

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| unmounts only the live clips whose whole span is covered | KEEP | [prior ledger 2](compositions2.md) |
| audio previews never play over a live clip (no double audio) | KEEP | [prior ledger 2](compositions2.md) |
| property: no live audio clip overlaps a usable span, and usable ⊆ the rendered spans | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/retime-frames.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| CFR: forward, backward and random access show the right frame | KEEP | [prior ledger 1](compositions1.md) |
| full-size decode, reverse across GOPs | KEEP | [prior ledger 1](compositions1.md) |
| an AAC track with encoder priming does not shift the frames (media time 0 = ffmpeg start_time) | KEEP | [prior ledger 1](compositions1.md) |
| VFR: frames by their real timestamps | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/retime-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Frame Sampling and Frame Blending match the CPU exactly (±1 rounding) | KEEP | [prior ledger 1](compositions1.md) |
| Optical Flow at w = ${w}: picture matches the CPU reference and moving-scene truth | KEEP | [prior ledger 1, current named scenario](compositions1.md) |

### packages/compositions/test/serial-audio-context.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| overlapping resume and suspend settle and advance the audio clock | REWRITE | §Q: overlapping resume and suspend settle and advance the audio clock |

### packages/compositions/test/text-animators.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| a typewriter reveals left to right; the rest state equals plain text glyph extents | KEEP | [prior ledger 1](compositions1.md) |
| position / rotation / fill colour / blur animators move and paint each character | KEEP | [prior ledger 1](compositions1.md) |
| a range selector on the first half selects only those characters | KEEP | [prior ledger 1](compositions1.md) |
| Path Options: characters follow a mask path (perpendicular) | KEEP | [prior ledger 1](compositions1.md) |
| per-character 3D flip and a wiggly selector render deterministically | KEEP | [prior ledger 1](compositions1.md) |
| variable font axes: style wght and an animated wght offset change the stroke weight | KEEP | [prior ledger 1](compositions1.md) |
| stroke, fill & stroke order, blur and inter-character blending render | KEEP | [prior ledger 1](compositions1.md) |
| Expression Selector: textIndex selects every other character (QuickJS in the renderer) | KEEP | [prior ledger 1](compositions1.md) |
| an expression on an animator property drives it (bound in the snapshot) | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/text-probe.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| finds copy split into spans and rows, ignoring whitespace, case and *markup* | KEEP | [prior ledger 2](compositions2.md) |
| hides the located text for the on-canvas editor and restores it | KEEP | [prior ledger 2](compositions2.md) |
| records the fonts the bundle registers through FontFace, with absolute URLs | KEEP | [prior ledger 2](compositions2.md) |
| a page without the probe reports every text as not found | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/three-d-advanced.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| unlit %s = Classic 3D (CPU reference) | KEEP | [prior ledger 1](compositions1.md) |
| shadow maps: the caster darkens the floor where Classic 3D puts its shadow | KEEP | [prior ledger 1](compositions1.md) |
| extruded text: walls widen the silhouette, the hole stays open, walls take the fill colour | KEEP | [prior ledger 1](compositions1.md) |
| environment light: the background is the environment ahead, the mirror reflects the one behind | KEEP | [prior ledger 1](compositions1.md) |
| depth of field: the layer in focus stays sharp, the far one is blurred | KEEP | [prior ledger 1](compositions1.md) |
| 3D model layer: a lit cube shows three differently shaded faces in its base colour | KEEP | [prior ledger 1](compositions1.md) |
| GGX: a shiny surface shows a highlight under a point light | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/three-d-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| %s | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/three-d-render.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| %s = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| a two-layer run: camera, spot light, shadow = the CPU reference | KEEP | [prior ledger 1](compositions1.md) |
| a 2D video below a 3D run is the run's backdrop (the camera tracker case) | KEEP | [prior ledger 1](compositions1.md) |
| Advanced 3D: the run renders lit with a shadow map, and extruded text shows its walls | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/transition-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| renders ${id} with both, single and reversed sides | KEEP | [prior ledger 2, current named scenario](compositions2.md) |
| shows A at progress 0 and B at 1 for ${id} | KEEP | [prior ledger 2, current named scenario](compositions2.md) |
| matches golden pixels at progress 0.25, 0.5 and 0.75 for ${id} | KEEP | [prior ledger 2, current named scenario](compositions2.md) |
| places the side pictures through their matrices and opacity | KEEP | [prior ledger 2](compositions2.md) |
| binds image params (Gradient Wipe / VR Gradient Wipe Custom Gradient; none or missing → built-in) | KEEP | [prior ledger 2](compositions2.md) |
| Push: the border is never visible at progress 0 or 1 (it travels between the clips) | KEEP | [prior ledger 2](compositions2.md) |
| S_MochaWhip follows the incoming side's planar track (Track Mode Off: as without a track) | KEEP | [prior ledger 2](compositions2.md) |
| Custom Completion replaces the timing; off keeps the linear ramp | KEEP | [prior ledger 2](compositions2.md) |
| reads both sides in one shader (S_DissolveLuma) | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/transition-player.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Push follows the playhead while scrubbing | KEEP | [prior ledger 1](compositions1.md) |
| Iris Round over a video side: B in the circle, the decoded video outside | KEEP | [prior ledger 1](compositions1.md) |
| S_DissolveLuma: the white half of A already shows B | KEEP | [prior ledger 1](compositions1.md) |
| a shape side is captured through HTML-in-Canvas | KEEP | [prior ledger 1](compositions1.md) |
| without HTML-in-Canvas a DOM side falls back to a dissolve with a chip | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/transition-premiere-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| draws the characteristic pixels of every Premiere transition | KEEP | [prior ledger 2](compositions2.md) |
| draws the characteristic pixels of Premiere 26's modern transitions | KEEP | [prior ledger 2](compositions2.md) |
| keeps the random transitions deterministic per instance | KEEP | [prior ledger 2](compositions2.md) |
| morphs a moved square instead of cross-fading it (Morph Cut) | KEEP | [prior ledger 2](compositions2.md) |
| Morph Cut interpolates a jump cut through optical flow (textured shot) | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/transition-render.e2e.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| Push: B enters from the left and pushes A out to the right | KEEP | [prior ledger 1](compositions1.md) |
| Push: at progress 1 (the last frame of a fade at a tail) the border has left the far edge | KEEP | [prior ledger 1](compositions1.md) |
| Gradient Wipe: a Custom Gradient image replaces the built-in ramp (dark areas first) | KEEP | [prior ledger 1](compositions1.md) |
| Iris Round: B inside a growing circle; Reverse closes A instead | KEEP | [prior ledger 1](compositions1.md) |
| one-sided: an iris at the tail of the last clip opens onto transparency (the black background) | KEEP | [prior ledger 1](compositions1.md) |
| S_DissolveLuma: the bright half of A switches to B first | KEEP | [prior ledger 1](compositions1.md) |
| Cross Zoom: mostly A early, B at the end | KEEP | [prior ledger 1](compositions1.md) |
| a video side goes through its chain (upright decoded frames), a shape side through HTML-in-Canvas | KEEP | [prior ledger 1](compositions1.md) |
| the built-in Cross Dissolve keeps its ramps (no stage) | KEEP | [prior ledger 1](compositions1.md) |

### packages/compositions/test/transition-sapphire-dissolves-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| single-sided fades start or end at transparency | KEEP | [prior ledger 2, current named scenario](compositions2.md) |
| S_Dissolve is a cross fade; S_DissolveFilm keeps the highlights longer | KEEP | [prior ledger 2](compositions2.md) |
| S_DissolveLuma switches the pixels in the order of the chosen luma pattern | KEEP | [prior ledger 2](compositions2.md) |
| S_DissolveSpeckle and S_DissolveStatic show A and B in patches mid-way | KEEP | [prior ledger 2](compositions2.md) |
| the light dissolves add light mid-way (brighter than the plain dissolve) | KEEP | [prior ledger 2](compositions2.md) |
| Mix with Dissolve 1 gives the plain dissolve | KEEP | [prior ledger 2](compositions2.md) |
| random dissolves are deterministic and follow the seed | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/transition-sapphire-swish-other-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| S_SwishPan: half-way the outgoing clip fills the left half, the incoming one the right (Left) | KEEP | [prior ledger 2](compositions2.md) |
| S_SwishPan: the motion blur smears the seam over many pixels in the middle of a span | KEEP | [prior ledger 2](compositions2.md) |
| S_Swish3D: zooms the outgoing clip (Z Dist 0.5) and dissolves around Fade Mid Time | KEEP | [prior ledger 2](compositions2.md) |
| S_CardFlip: the outgoing card turns away, the incoming one turns in (edge-on in the middle) | KEEP | [prior ledger 2](compositions2.md) |
| S_StripSlideTransition: Top Down slides the top strips off first | KEEP | [prior ledger 2](compositions2.md) |
| S_FilmRoll: half-way the frame line crosses the middle, A above and B below | KEEP | [prior ledger 2](compositions2.md) |
| S_FlutterCut: each frame shows the clip of the TS pattern (with colour frames) | KEEP | [prior ledger 2](compositions2.md) |
| S_TVChannelChange: black / static in the dead time, clean pictures at the ends | KEEP | [prior ledger 2](compositions2.md) |
| S_HyperPull / S_HyperPush: the outgoing clip before the dissolve, the incoming one after | KEEP | [prior ledger 2](compositions2.md) |
| S_WhipLash: cuts in the middle; the Whip Out styles land differently | KEEP | [prior ledger 2](compositions2.md) |
| S_MochaWhip: without a mask it is a plain whip; a mask whips a cut-out of B in front | KEEP | [prior ledger 2](compositions2.md) |
| S_ParallaxStripsTransition and S_FilmBurnTransition are deterministic per seed | KEEP | [prior ledger 2](compositions2.md) |
| works at single clip edges (from / to transparency) without NaNs | KEEP | [prior ledger 2](compositions2.md) |

### packages/compositions/test/transition-sapphire-wipes-gl.test.ts

| Test declaration (expanded cases share its contract) | Outcome | Evidence / unique failure witness |
| --- | --- | --- |
| %s moves monotonically from A to B | KEEP | [prior ledger 2](compositions2.md) |
| S_WipeLine: B enters along Angle, with a centred border and a glow | KEEP | [prior ledger 1](compositions1.md) |
| shape wipes: In shrinks the outgoing clip, Out grows the incoming clip | KEEP | [prior ledger 1](compositions1.md) |
| S_WipeClock sweeps from Angle Open clockwise or counter-clockwise | KEEP | [prior ledger 1](compositions1.md) |
| wedges: one from the side, two meeting in the middle, four merging into an X | KEEP | [prior ledger 1](compositions1.md) |
| Reverse plays the wipe backwards (B enters from the other side) | KEEP | [prior ledger 1](compositions1.md) |
| is transparent where a missing side shows (one-sided fade) | KEEP | [prior ledger 1](compositions1.md) |
| Grad Add makes a pattern travel across the frame along Grad Angle | KEEP | [prior ledger 1](compositions1.md) |
| Grow and Shrink differ; every tile shape draws its own pattern | KEEP | [prior ledger 1](compositions1.md) |
| random wipes are deterministic per seed and change with Seed | KEEP | [prior ledger 1](compositions1.md) |

## Validation and measurements

The integrator's full baseline completed with 7,911 runtime cases (7,661 passed, 2 failed, 248 skipped), in 35:11.47 at two workers. The compositions failure is the ordinary magenta control pixel of the retained capture test on Chrome 156; the low-latency green pixel passed. This is investigated as a baseline defect, never deleted to make the gate pass. The other failure is the engine cache privileged-permission fixture, owned elsewhere. Targeted Biome on all 13 changed TypeScript files passed (83 ms); `git diff --check` passed. No test/build/typecheck workload ran during baseline measurement. The narrow capture command `JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm exec vitest run packages/compositions/test/capture-safe-canvas.test.ts --maxWorkers=2 --reporter=default` passes twice on Node 20.19.0 / Chrome 156 (file times 476 and 482 ms); its wrong-receiver mutant fails, and restored source passes. Unrelated native translated-sibling clipping remains a documented platform limitation pending real compositor validation. Audio/GL runtime validation, further mutation checks and paired subset timings are queued in the integration resource schedule; exact commands/results will follow. The full-suite final measurement and remote integration belong to the integration report.
