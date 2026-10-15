# Sound Design / SFX layer (wp-note)

Spec: [`docs/specs/12-sound-design.md`](../specs/12-sound-design.md). Inspiration (ideas only, no code):
`github.com/Bodila51/opus-sound-layer` (MIT).

Each phase appends its design notes, usage, verified behaviour (with the commands that measured it), limits and
known bugs below.

## Phase 0: pre-existing audio bugs

### WP0.1 preview

Scope: `packages/compositions/src/audio/*`, `packages/compositions/src/layers/AudioLayer.tsx`, `apps/web/src/audio/*`
(preview mix graph, worklets, effect slots, scrubbing, voice-over, automation, browser decode, audio engine ops).

**Design: preview latency compensation = the export's plan.** `planMixLatency(mix, latencyOf, masterExtra)`
(`packages/compositions/src/audio/graph.ts`) is the `OfflineMixer` algorithm: strips in processing order; `inLat` =
latest arrival of the strip's inputs, `preLat` / `postLat` after the pre / post-fader inserts; every output and send
route gets `delay = inLat(target) − tap latency`; `total` = the Mix's `postLat` (+ the preview loudness limiter's
latency while normalisation is on). `MixGraph` applies it: each route into a bus is a `DelayRoute` (a DelayNode only
when the delay is > 0), the read-ahead is published (`graph.latency`, `onLatency`) and `AudioLayer` starts every clip's
media `graph.clipLead(clip)` early (read-ahead + its own clip-effect latency, the existing `compensate()`), so the
Mix output lines up with the picture. Each stage is evaluated at the time of the samples it processes
(`stripStageTimes`: pre inserts `t + total − inLat`, fader / mute / pre sends `t + total − preLat`, post inserts
`t + total − preLat`, pan / puck / post sends `t + total − postLat`; clip nodes and Remotion's per-clip volume
`t + total`), exactly the export's times. Preview slot latency comes from the processor itself
(`registerPreviewInsert(id, factory, latency)`; `installAudioFxPreview` passes `effectLatency(effect, ctx.sampleRate)`).
Alternatives rejected: per-track scheduling offsets cannot align a strip that reaches the Mix by two paths (output and
a send through a submix with an insert); delaying the picture is not possible with Remotion's player.

**Voice-over.** `takeRange` / `captureSampleAt` / `voiceoverLatencySeconds` / `assembleTake`
(`apps/web/src/audio/voiceover.ts`): the take starts at the capture sample of the record point plus the round trip =
Program monitor `baseLatency + outputLatency` (the capture context's only as a fallback) + input device latency
(`MediaTrackSettings.latency`, Chrome) + Preferences ▸ Audio ▸ Voice-Over Record ▸ **Latency Offset** (ms, −500…500,
default 0; `audioPrefs.voiceOver.latencyOffsetMs`). The frame → capture-sample mapping uses the lower envelope of the
frame-report / capture-clock pairs within ±1 s plus one capture-clock step (gcd of the readings, capped by the
offsets' 90th-percentile spread): reports are never early and the capture clock lags by less than one step, so this
undoes both jitters, and a stalled report cannot pull it.

#### Findings

| # | Finding | Verdict | Regression test (failed before → passes) |
|---|---|---|---|
| 1 | Track / submix / Mix insert latency not compensated in the preview (documented limit): a 256-sample Mix reverb put the whole preview 256 samples late; a 2048-sample track insert put that track 43 ms behind the others | **fixed** (plan + DelayNode routes + read-ahead + stage times) | `packages/compositions/test/audio-preview-oracle.test.ts` "identical to the export, sample for sample" (before: best lag 256, max \|Δ\| 1.17; after: lag 0, max \|Δ\| < 1e-4); `audio-preview-latency.test.ts` (plan = `OfflineMixer.latency` and every route aligned, 200 random topologies) |
| 2 | Preview loudness limiter (normalisation on) delayed the whole mix by its look-ahead, uncompensated | **fixed** (counted in the read-ahead while enabled) | oracle "loudness normalisation" (before: lag ≠ 0) |
| 3 | Re-enabling loudness normalisation replayed the limiter's stale look-ahead audio (a 5 ms burst of old audio) | **fixed** (fresh limiter on enable) | `audio-worklet-limiter.test.ts` "re-enabled after a bypass" (before: stale peak 0.5) |
| 4 | Sends into a 5.1 submix used a fixed front-centre puck in the preview; the export pans them with the strip's puck | **fixed** (preview uses the strip's puck, at the send's tap time) | oracle (A2 sends to a 5.1 submix with the puck at −80/−60; with the old puck max \|Δ\| 0.093) |
| 5 | Clip gain + Volume above +24 dB (Remotion's volume limit, `MAX_PREVIEW_GAIN`) was clamped in the preview; the export applies it all (Audio Gain goes to +96 dB, e.g. Normalize Max Peak of a quiet take) | **fixed** (`clipGainExcess`: the graph applies the rest, before the slots or after them for clips with effects) | oracle (+30 dB on A2 and on A3 with a clip effect; without the fix max \|Δ\| 0.34); `audio-preview-latency.test.ts` clip-gain case |
| 6 | Clip-effect latency was converted at a hard-coded 48 kHz | **fixed** (context rate) — no audible case measured (the Player's context is 48 kHz) | `audio-preview-latency.test.ts` "preview slot latency" (96 kHz) |
| 7 | Voice-over input latency not compensated (documented limit) | **fixed** | `apps/web/test/voiceover-latency.test.ts`: simulated 25 ms input + 40 ms output latency, report jitter, 480-sample capture buffer → clap within one buffer; without the input term it lands 1200 samples off; property over output 0–200 ms, input 0–100 ms, buffers 256–1024, 60/120 Hz reports (300 runs) |
| 8 | Voice-over located the record point from the single first frame report at/after it: one stalled report shifted the whole take by the stall | **fixed** (lower envelope of the pairs within ±1 s) | `voiceover-latency.test.ts` "a late frame report (stall)" |
| 9 | Voice-over used the capture context's output latency, not the Program monitor's (the context the talent hears) | **fixed** (playback context first) | `voiceover-latency.test.ts` "user offset and the capture-context fallback" |
| 10 | Reverse audio scrubbing near the sequence start played content after the playhead (window clamped to 0 but kept its length, then reversed) | **fixed** (`scrubWindow`) | `apps/web/test/audio-scrub-window.test.ts` (frame 1: old window [0, 1920) → [0, 1600); frame 0: none) |
| 11 | Sequence ▸ Loudness Normalization ▸ Analyze showed a result even when storing it was refused (read-only project) | **fixed** (refusal raised to the dialog) | `apps/web/test/audio-engine-ops.test.ts` |
| 12 | Strip edits made after the preview graph was built were never heard (it kept the strips of its last topology rebuild): adding a track / submix / Mix effect, a static fader, pan or send-level change, mute — silent until a routing change or reload. Found by the real-app run below (an added Hard Limiter and Amplify −20 dB did nothing) | **fixed** (`MixGraph.update` always takes the new strips) | oracle "edits after the graph is built are heard" (before: lag −256, the insert absent) |
| 13 | Preview effect slots glided from the catalogue defaults to the instance's values over the first 20–100 ms (Amplify −40 dB started at 0 dB); WP0.2 fixed the export's `EffectSlot`, the preview's `FxSlotCore` had the same flaw (reported by WP0.2) | **fixed** (the first instance snaps; later edits still glide) | `packages/compositions/test/audio-fx-slot-start.test.ts` (before: first quantum 0.499 instead of 0.005) |
| 14 | A new preview slot processed its first quanta with no effect at all (pass-through, no latency) until the instance arrived by message: a short unprocessed burst whenever a slot was created (and a flaky oracle) | **fixed** (the instance comes with the node in `processorOptions`) | `audio-fx-slot-start.test.ts` "processes its first quantum with the instance it was created with" (before: 0.5) |
| R1 | Non-finite limiter ceiling → NaN output | **rejected**: `TruePeakLimiter` stays finite (the test passed before); a finite fallback is kept as defence | `audio-worklet-limiter.test.ts` (regression only) |
| R2 | Reversed clip whose content reaches before the media start: `browserOpenClip` (and the engine's `decode.ts`, `adelay` after `areverse`) put the silence at the start | **rejected as unreachable**: audio transition handles are limited to available media (`clipHandles`) and `sourceIn ≥ 0`, so the content range never starts before 0; noted for the engine audit | — |
| R3 | `faderToDb(NaN)` returns +15 dB | **rejected**: needs a pointer-down on a zero-height fader | — |
| R4 | Automation is recorded at picture time while the talent hears the output later | **rejected**: Premiere records the same way; not a defect | — |
| R5 | `FxSlotCore` forces `enabled: true` | **rejected**: `buildAudioMix` and the slot chains pass enabled effects only | — |
| R6 | STFT inserts (FFT Filter, Click Remover…) differ from the export by up to ≈ −43 dB in the ≈ 0.2 s after an onset | **rejected as a latency bug**: their frame phase follows where processing started (two exports with different range starts differ the same way); aligned (lag 0) and identical (< 3e-4) after the onset | oracle "frame-based (STFT) inserts" |

#### Verified (measured)

- `pnpm vitest run packages/compositions/test/audio-preview-latency.test.ts packages/compositions/test/audio-worklet-limiter.test.ts apps/web/test/audio-scrub-window.test.ts apps/web/test/voiceover-latency.test.ts apps/web/test/audio-engine-ops.test.ts apps/web/test/audio-mix.test.ts --maxWorkers=2`: all pass.
- `pnpm vitest run packages/compositions/test/audio-preview-oracle.test.ts --maxWorkers=2` (headless Chrome,
  OfflineAudioContext with the real worklets vs `renderMixToBuffers`): 3 passed. Scene: 3 noise tracks, A1 → S1
  (−3 dB, post-fader Hard Limiter), A2 pre-fader send to S1 and post-fader send to a 5.1 submix, A3 panned, Mix
  Convolution Reverb, clip effect on A3, +30 dB clip gain on A2 / A3. Exact set (limiters + convolution, read-ahead 1004
  samples): max |preview − export| < 1e-4 over 0.6 s, lag 0. The same scene against the pre-fix graph: lag 256, max
  |Δ| 1.17 (STFT set: lag 534). Now 4 tests (with the "edits after the graph is built" case), run 3 times in a row:
  4 passed each time.
- Real app (built stack, `E2E_PORT=48100 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p0-preview.spec.ts`,
  headless Chrome, the Program monitor's AudioContext tapped at its destination): a click every 0.5 s on A1 (Hard
  Limiter track insert, 374 samples) and on A2. Before fixes 1 and 12 the tap measured pairs of single clicks
  (0.354) 374 samples apart; after: one click of 0.707 (both tracks summed) every 24 000 samples. 2 passed (with the
  Preferences ▸ Audio Latency Offset row, screenshot `test-results/e2e-sound-p0/preferences-audio.png`).
  `e2e/audio-mix.spec.ts -g "Audio Meters|Voice-over"`: 2 passed (the fake-microphone take lands on A3 as
  "Voice-over 1" in one "Record Voice-over" step).
- Not run here: a real microphone (none on this machine); voice-over timing is verified by simulation only.

### WP0.2 audio core

Scope: `packages/project/src/audio/*`, `packages/project/src/essential/*`, the audio and essential command handlers,
the audio parts of `transitions.ts` / `audio-fade.ts`, `apps/engine/src/audio/*`, `packages/audio-fx/src/*` and
`packages/audio-dsp/src/*`. The preview side (`packages/compositions/src/audio`, `AudioLayer.tsx`, `apps/web/src/audio`)
belongs to the parallel preview package, so the two documented latency limits (track-insert preview latency,
voice-over input latency) are not handled here.

Method: the code was read for the bug classes that spec 12 §0 lists, plus the classes in P0-R1. Two read-only audit
passes (audio-fx effects; audio-dsp, Essential Sound and the mix fingerprint) ran scratch scripts, and every
candidate was reproduced numerically. Each confirmed bug got a regression test, which was run against the unfixed
code and failed, then against the fix and passed. For the fixes in `audio-fx`, `essential`, `audio-dsp`,
Scientific, Convolution and Delay this was done by checking out the old file, running the test, and restoring the
fix.

#### Findings

| # | Area | Finding | Status | Regression test |
|---|---|---|---|---|
| 1 | engine decode | **Reversed clips were exported 250 ms off.** `-t` reads 0.25 s past the span, and `areverse` played that extra first. Content past the media end, or a head handle reaching before 0, also came out on the wrong side. Fix: `atrim` + `apad` to the exact span before `areverse`; a reversed lead is no longer delayed in. | fixed | `apps/engine/test/audio-decode.test.ts` (4 tests, real ffmpeg ramp signal) |
| 2 | mixer | **Reversed clips: export volume, pan and clip-effect automation were one frame off the preview.** The export used `duration − local`; the preview and every keyframe writer (Clip Mixer, auto-duck) use `contentTimeAt`'s `duration − 1 − local`. | fixed | `audio-mix.test.ts` › "reversed clips: export volume and pan follow the preview content time" |
| 3 | mix plan | **Solo walk stopped at strips already kept by another seed.** With `A1 (solo) → S1 → S2 (solo)` and `A3 → S1`, A3 was silenced. Fix: one visited set per walk. | fixed | `audio-mix.test.ts` › "solo: a strip reached from one soloed strip…" |
| 4 | mixer | **Aliasing varispeed of synthetic tones.** A Bars and Tone / leader clip sped past Nyquist was generated at `sr / rate` and folded down (1 kHz × 30 → audible 18 kHz alias). It is now silent, like the band-limited resampling of media. | fixed | `audio-mix.test.ts` › "a synthetic tone sped up past Nyquist is silent" |
| 5 | fingerprint | **`mixFingerprint` ignored Interpret Footage** (assumed frame rate, loop), so a stale loudness analysis read as current. It is hashed only when set, so existing analyses stay current. | fixed | `audio-mix.test.ts` › "mixFingerprint changes when Interpret Footage changes…" |
| 6 | invariants | `repairAudioMix` let an invalid send shadow a valid send with the same id (`seen` updated before the validity check); truncation to 5 sends now leaves a note. `repairDocument` renames duplicate ids first, so this was latent through the public path. | fixed | `audio-mix.test.ts` › "repairDocument keeps a valid send whose id an invalid duplicate used first" |
| 7 | audio-dsp | **Whole-programme true peak missed the last 16 samples** (the interpolator lag), e.g. a transient at the end of a short SFX. `TruePeakDetector.flush()` / `LoudnessMeter.flush()` push the tail through; used by `blockTruePeak`, `measureLoudness`, the export mixdown and normalisation. Live meters don't flush. | fixed | `oversample.test.ts` › "true peak at the end of a programme" (2 tests) |
| 8 | engine service | Normalising media shorter than one 400 ms gating block failed as `SILENT`. It is now `TOO_SHORT` with the duration and true peak. | fixed | `apps/engine/test/audio-mix.test.ts` › "refuses to normalise audio shorter than one 400 ms gating block…" |
| 9 | essential | Auto-Match on an unmeasurable clip shorter than 400 ms said "silent"; it now says "shorter than 400 ms". | fixed | `essential.test.ts` › "Auto-Match skips an unmeasurable clip shorter than 400 ms…" |
| 10 | essential | **Setting the SFX type reset the clip's own pan to 0**, and Clear Audio Type / Pan off did too. Pan is now an offset like Clip Volume, as the module header always said. | fixed | `essential.test.ts` › "the SFX type keeps the clip's own pan…" |
| 11 | essential | **Clamp then undo.** Clip Volume +15 over a +10 level capped at +15; switching it off gave 0, not 10. A −96 dB (−∞) fade keyframe came back at −90. What the fader range clamps away is now kept per value (`EssentialSound.residual`) and given back. | fixed | `essential.test.ts` › "Clip Volume on/off restores levels the fader range clamped…" |
| 12 | essential | **One out-of-range stored field reset all Essential Sound settings to defaults** (gain, volume and effects were then reconciled from the wrong state). Now: clamp first, then fall back per section. | fixed | `essential.test.ts` › "one out-of-range stored field does not reset…" |
| 13 | essential | `applyPreset` with invalid explicit `settings` silently applied the defaults; it now refuses with `E_INVALID_PARAM` (out-of-range numbers are clamped like every other setting). | fixed | `essential.test.ts` › "applyPreset refuses invalid explicit settings…" |
| 14 | essential | `loudness.targetLufs` had no range: 500 was accepted and Auto-Match then set +96 dB. It is limited to −60…0 LUFS (schema and clamp). | fixed | `essential.test.ts` › "the loudness target is limited to −60…0 LUFS" |
| 15 | audio-fx host | **Every hosted effect glided from its spec defaults to its values over the first 20–100 ms of each clip and export** (Amplify −40 dB started at 0 dB; a keyframed Hard Limiter ceiling of −12 dB let −1.5 dBFS through). Fix: the slot snaps at construction and at its first control point after a reset. | fixed | `audio-fx/test/regressions-p0.test.ts` › "hosted effects start at their parameter values" (2 tests) |
| 16 | Dynamics | **Compressor make-up was applied after the limiter** (make-up +12 dB with the limiter at −6 dB gave −2 dBFS peaks). Make-up now belongs to the compressor stage, before the limiter. `transferDb` matches. | fixed | `regressions-p0` › "make-up gain cannot push the output over the limiter threshold" |
| 17 | Scientific Filter | **Steep or narrow designs were silent** (Butterworth LP order 12 at 20 Hz: −692 dB in the pass band). The whole cascade gain sat on section 0 (≈ 1e-35) under the 1e-30 state flush. Each section is now normalised at a pass-band reference frequency. | fixed | `regressions-p0` › "Scientific Filter › passes its pass band" (5 designs) |
| 18 | Scientific Filter | Raising `order` (keyframable) brought back stale state in sections that came back into use (a −23.7 dBFS burst on silence). Those sections now start from zero. | fixed | `regressions-p0` › "sections that come back after an order change start from silence" |
| 19 | 5.1 inserts | **Surround Reverb, Mastering, Loudness Meter and Auto Gain ignored channels 2–5** (no Dry/Wet or output gain on C/LFE/Ls/Rs, no maximiser there, a C-only signal metered −∞, the LFE counted for Auto Gain). They now process every channel; meters and Auto Gain use the BS.1770 weights; the centre feeds the Surround Reverb. | fixed | `regressions-p0` › "5.1 inserts process every channel" (4 tests) |
| 20 | Multiband | Crossovers stopped 1–16 ramp steps short of their target (1000 Hz settled at ≈ 990 Hz) because they were redesigned only while gliding. One more redesign now runs after the glide. | fixed | `regressions-p0` › "Multiband Compressor crossovers reach their target" |
| 21 | Convolution | Room Size changed the wet level non-monotonically (−1.4 dB at 33 %): linear-interpolation decimation loses a ratio-dependent part of the energy. The resampled impulse is now energy-matched. | fixed | `regressions-p0` › "Convolution Reverb Room Size keeps the wet energy" |
| 22 | Delay | Tempo mode silently clamped to 4 s (a whole note at 30 BPM = 8 s). The line now holds a whole note at 20 BPM (12 s). | fixed | `regressions-p0` › "Delay in tempo mode" |
| 23 | Remix | Unbounded allocation: the API accepted 4 h of music, which means a beats² similarity matrix (≈ 3 GB per hour at 200 BPM) plus the decoded range, enough to crash the engine. The analysed range is now capped at 30 min (`MAX_REMIX_SOURCE_SECONDS`). | fixed | `packages/api/test/api.test.ts` › "caps the analysed music range" |
| R1 | ducking | `audio.autoDuck` replaces every Volume keyframe of the target, not only those inside the regions. | rejected | Adobe documents this: Generate Keyframes removes the keyframes added before it and replaces them on every regeneration ([Adobe: automatic audio ducking](https://helpx.adobe.com/premiere-pro/how-to/automatic-audio-ducking.html)). The schema already says so. |
| R2 | ducking | Zero-length, overlapping or edge regions | rejected | `duckKeyframes` filters `b ≤ a`, merges ramps that touch, and clamps to the clip with edge keyframes; read and covered by the audio-dsp ducking tests. |
| R3 | fades | Fade longer than the clip, or 0-frame fades (NaN in `audioFadeGain`) | rejected | One-sided fades are `min(duration, clip)`. `Transition.duration` is an int ≥ 1 in the schema, and two-sided ones go through `fitTransitionDuration`. Unreachable. |
| R4 | export | Normalisation or limiter skipped on some outputs | rejected | Every export path takes its audio from one `renderMixdown` (loudness gain, then the true-peak limiter on the final mix). Analyses run `withoutLoudness` on purpose. There are no stems. |
| R5 | loudness | Short media gives NaN or passes trivially | rejected | Below 400 ms, integrated loudness is −∞ (null in the API), never NaN. Normalisation gain is 0 for a non-finite measure. Only the messages were wrong (#8, #9). |
| R6 | varispeed | Media clips | rejected | The rate change is `asetrate` followed by SoX / swr `aresample`, which low-pass filter. Pitch Shifter drops bins above Nyquist. |
| R7 | resampler | Off-by-one, aliasing | rejected | Measured −84 to −139 dB aliasing at 48→44.1, 192→8 and 96→22.05 kHz; impulses land within ±0.5 sample; lengths are `round()`. |
| R8 | effects | Block-size dependence, latency, reset | rejected | Swept 22.05/96/192 kHz, 1/2/6 channels, parameters at 0/5/95/100 %. Impulse delay equals the reported latency for every latent effect; `reset()` equals a fresh instance. |
| R9 | biquads, WAV, sync | Instability; hostile WAV; empty or NaN sync input | rejected | Max pole radius 0.99999999999 over every type × 4 rates × extreme f/Q/gain. 20 000 mutated WAVs only throw, with no hang or unbounded allocation (`decodeWav` has no app caller). Sync returns null or works. |
| R10 | thinning | `thinPoints` / `writeLaneKeyframes` | rejected | RDP keeps every dropped point within the tolerance, and `minInterval` is documented to override it except for the last point. Automation outside the pass is kept with ε-guard keyframes. |

#### Verified behaviour (measured, this branch)

The commands below, run on the shared host (load ≈ 110 on 16 cores):

- `pnpm vitest run apps/engine/test/audio-decode.test.ts apps/engine/test/audio-crossfade.test.ts apps/engine/test/gaps-audio-channels.test.ts apps/engine/test/audio-mix.test.ts --maxWorkers=2 --testTimeout=900000`
  passed 15 of 15. These are real ffmpeg exports: balance, sends, 5.1, normalisation within 0.15 LU, and the reversed decode
  alignment within 3 samples.
- The fail-before / pass-after evidence for every row above is the regression test named in it. The `audio-fx` rows
  were run with the old file checked out: 2 + 1 + 4 + 4 + 1 + 1 + 1 failures before, all passing after.
- `pnpm vitest run packages/project packages/audio-fx packages/audio-dsp packages/api --maxWorkers=2 --testTimeout=600000`
  ran 1953 tests in 165 files: 1953 passed, 3 failed. The 3 failures were the tests' own timeouts or perf budgets
  under load 110 (sync GCC-PHAT 60 s / 30 s timeouts, Pitch Shifter 8× realtime) in files this package does not touch.
  Rerun alone, `pnpm vitest run packages/audio-dsp/test/sync.test.ts …` passed 12 of 12 and
  `packages/audio-fx/test/reverb-pitch.test.ts` passed 13 of 13.
- `pnpm vitest run apps/mcp/test/audio-fx.test.ts apps/web/test/panel-input-validation.test.ts packages/compositions/test/audio-fx-preview.test.ts packages/audio-dsp/test/sync.test.ts --maxWorkers=1`
  passed 28 of 28 (dependants of the Essential Sound and effect-host changes).
- `pnpm lint` passed. `pnpm --filter <pkg> typecheck` passed for project, audio-dsp, audio-fx, api, engine, mcp and
  compositions. The workspace `pnpm typecheck` stops at a pre-existing error in
  `apps/web/test/clip-extensions.test.tsx` (`refs` on `TransactionResult`, from commit 48a90b6c on main), which this
  package does not touch.

#### Limits and notes for the next packages

- **Preview counterpart of #15.** `packages/compositions/src/audio/fx-processor.ts` (the preview AudioWorklet chain) uses
  the same `setEffects`-then-`automate` pattern, so the preview probably has the same start-of-clip glide. It is
  outside WP0.2's scope; the preview package should check it. Until then the export no longer glides and the preview may.
- #11 stores `residual` on `AudioClip.essential` (an optional field of the loose Essential Sound object; no schema bump).
  Only the commands manage it.
- #10 changes Pan to an offset: an SFX clip's pan is now `own pan + Essential Sound Pan` (clamped ±100, losslessly), not
  overwritten.
- #19: the Surround Reverb sends the 5.1 centre into the reverb, with its wet on L/R. Mastering's reverb and widener
  stay L/R. LFE gets the exciter, which does nothing there (it is a 3 kHz high-pass).
- #21: a mono Convolution instance still varies by ≈ 0.6 dB between 100 % and 10 % Room Size. That comes from the
  correlation of the decorrelated L/R impulses; the resampling is not band-limited.
- #23: music longer than 30 minutes can't be remixed (a validation error names the limit).
- `mixFingerprint` doesn't follow expressions that drive clip volume from other layers. Audio-effect parameters refuse
  expressions; clip Volume through an expression is the remaining (rare) gap.

### Phase 0 verification

Branch `feat/sd-p0-verify` (from `feat/sound-design` 3e79efd1). Three read-only review passes covered the WP0.1 and
WP0.2 diffs (preview graph and AudioLayer; project / essential / audio-fx / audio-dsp / api; web, engine, MCP and docs
consumers). Every confirmed defect below got a regression test that was run against the unfixed code (failed) and
the fix (passed).

#### Findings and fixes

| # | Finding | Fix | Regression test (before → after) |
|---|---|---|---|
| V1 | `pnpm typecheck` red: `apps/web/test/clip-extensions.test.tsx` read `refs` from a `TransactionResult` without narrowing (from main 48a90b6c). The type is right (a discriminated union; `refs` exists only when `ok`), the test was wrong | the test narrows with `if (!added.ok) throw …` like its siblings | `pnpm typecheck` passes; the file's 5 tests pass |
| V2 | **Introduced by WP0.1:** with any read-ahead (a latent track / submix / Mix insert, or loudness normalisation) every audio clip that starts during playback lost its first `read-ahead` samples, at every cut. Audio Sequences were not premounted, so a clip's source was created only when the picture reached it and could not start early (`compensate()` took its late branch) | audio Sequences are premounted by `max(2 s, lead)` (`lead` = `MixGraph.clipLead`), with an empty pointer-less layout so Remotion premounts them; the FrameWindow span includes it | `e2e/sound-p0-preview.spec.ts` "a clip that starts mid-playback is heard from its first sample": a 0.25 click on the first sample of a clip at frame 40 (A1 has a Hard Limiter, 374 samples). Before: no click anywhere near 64 064 samples. After: a click of 0.1768 (= 0.25 · −3 dB pan law) at exactly 64 064, in two runs |
| V3 | Essential Sound residual keyed by keyframe id was lost by split / duplicate / paste / remix / nest (`reidentifyClipChildren` renames keyframes) | residual keys follow the renamed Volume / Pan keyframes | `essential.test.ts` "a split keeps the clamp residual…" (before: right half `[0, 0]`, after `[10, 8]`) |
| V4 | A residual was given back after the user moved the level (Effect Controls, Clip Mixer): Volume 10, Clip Volume +15, user sets 0, Clip Volume off → −5 dB instead of −15 (pan: 50 instead of 80) | a residual applies only while its value still sits on the bound it was clamped to; residuals are capped at the range width | `essential.test.ts` "a level the user moved after the clamp…" (before −5, after −15 / 80); "a hostile stored residual is bounded" (defence: passed before too) |
| V5 | `residual` was writable and listed as a setting (`essentialSound.set {"residual.pan.value": …}` accepted, then overwritten; `get_essential_sound` returned it) | refused by `setEssentialValue`, left out of `essentialKeys` and of `get_essential_sound` | `essential.test.ts` "residual is not a setting" |
| V6 | Essential Sound ▸ Auto-Match on clips shorter than 400 ms still said "The clips are silent": the web op threw away the command's per-clip reasons, so WP0.2 #9 never reached the editor | `autoMatchLoudness` returns the command's per-clip result; `autoMatchMessage` words it (matched / silent / shorter than 400 ms); nothing matched is an error toast (panel and menu command) | `apps/web/test/essential-auto-match.test.ts` (new API; the old code returned only the measurements) |
| V7 | Clip Mixer (`clipLaneValue`) read reversed clips one frame off: `duration − local` while the preview, the export mixer (WP0.2 #2) and the keyframe writers use `duration − 1 − local` | uses `contentTimeAt` | `apps/web/test/audio-mix.test.ts` "Clip Mixer reads a reversed clip…" (before −13, after −14 dB) |
| V8 | A reversed decode window entirely before the media start (empty span): `atrim=duration=0` means "no limit", so 0.25 s of the file came out reversed instead of silence | trims and pads in input samples (`atrim=end_sample=n`, `apad=whole_len=n`), an empty span is cut to nothing | `apps/engine/test/audio-decode.test.ts` "a reversed window entirely before the media start is silence" (before: non-silent). Latent: WP0.1 R2 found no handle that reaches before 0 |
| V9 | TOO_SHORT "with the duration and true peak" (WP0.2 #8): the job queue keeps only code and message, so the true peak never reached a client | the message carries both and names Normalize Max Peak | `apps/engine/test/audio-mix.test.ts` TOO_SHORT case (message regexes) |
| V10 | MCP docs: `normalize_media_loudness` neither mentioned TOO_SHORT / SILENT nor hinted correctly (always "check the media is online"); `auto_match_loudness` said only "silent clips"; `set_essential_sound` and the guide did not say that Clip Volume and the SFX Pan are offsets; `remix_audio` did not mention the 30-minute cap and answered it with a "steady beat" hint; the web Remix showed a raw zod message | code-specific hints, descriptions and guide text; MCP and web check the 30-minute cap before calling the engine with a clear message; `wp-notes/audio-fx.md` and the `model.ts` header describe Pan as an offset | `apps/mcp/test/audio-fx.test.ts` 3/3 |
| V11 | `ClipNodes.connect` set a new clip's pan / trim / level at the picture time and at 30 fps, then glided to the read-ahead time's values | connects at the read-ahead time with the sequence rate | covered by the oracle and the e2e runs (no unit harness for Web Audio in Node) |

Rejected or recorded as limits (not fixed): losing the first `read-ahead` samples right after Play or a seek (a source
cannot start before the play press; documented in `wp-notes/audio-fx.md` §6); route DelayNodes may replay up to
`read-ahead` of pre-seek audio after a seek, and a read-ahead change during playback re-creates every clip's media
player (both suspected from the code, not measured; recorded in `wp-notes/audio-fx.md` §6); `Delay` allocates 12 s
per channel per instance (≈ 4.6 MB stereo 48 kHz; bounded, reset zero-fills it); `flush()` of the true-peak meters is
not idempotent, but every caller flushes once at the end; old projects with keyframed SFX pan saved before WP0.2 get
every keyframe shifted when Pan is switched off (the old code wrote one key; Phase 0 is unreleased, no migration).
The preview transport limits and the SFX Pan reading were taken up by the close-out below (C1–C4).

#### Gate (measured, this branch, shared host with 16 cores)

- `pnpm lint`: passed (Biome 2563 files, check-tokens / anime / layers / assets ok). `pnpm notices --check`: current
  (150 packages, 31 ported records).
- `pnpm typecheck`: passed after V1 (19 workspace projects).
- First full `pnpm test` (load 20–120 from other agents): 5 233 passed, 26 failed, 493 skipped in 578 files (31
  files failed). Every failing file was rerun alone (`pnpm vitest run <file> --maxWorkers=1`, load 7–72): all 31
  passed. The failures were timeouts and budgets under load (STACK_TRACE_ERROR timeouts, `beforeAll` hooks over
  120–300 s, Pitch Shifter 8× realtime, a 20 000-instance mesh refusal measured at 21.3 s for a 20 s budget,
  interchange fuzz inputs at 2.7–3.4 s for a 2 s limit, avc3 playback 24 / 33 of 45 frames), plus
  `apps/mcp/test/audio-fx.test.ts`, which ran while V10 was half-written and passed 3/3 afterwards.
- After the fixes, `pnpm verify` twice on the final code (lint and typecheck green both times; `pnpm test` then stopped
  the chain): run 1 (load 44–57) 5 363 passed, 4 failed in 3 files (Pitch Shifter 8× realtime budget, avc3 playback
  frame counts, a 5 s tracking timeout); run 2 (load 10 → 56) 5 363 passed, 4 failed in 4 files (timeouts of 120 s /
  180 s / 5 s in `audio-fx/registry`, `audio-fx-preview`, `camtrack-solve`, and the Pitch Shifter budget). All 7 files
  rerun alone afterwards (`pnpm vitest run <file> --maxWorkers=1`, load 12–34): all passed (13/13, 2/2, 8/8 + 1
  skipped, 5/5, 2/2, 12/12). No test was changed to get there. `pnpm notices --check`: current.
- `pnpm build` (the step after test in `verify`, run on its own on the final code): passed.

#### Real app (built stack, measured)

`pnpm build`, then `E2E_PORT=48301 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/sound-p0-preview.spec.ts` (headless
Chrome; the tap now routes everything any node sends to the speakers through one bus per context; the old tap
recorded only the first node connected to the destination, which after V2 was not the whole mix): 5 passed.

- Preview, A1 (Hard Limiter insert, 374 samples) and A2 play the same click track: one click of 0.7071 every 24 000
  samples (both tracks summed, aligned to the sample). One run of the 5 under load 60–75 showed a Remotion resync (a
  4 885-sample jump); rerun alone twice it passed.
- Export of the same sequence (native path, MP4/AAC), audio decoded with
  `ffmpeg -i sound-p0-insert.mp4 -map 0:a:0 -ac 1 -af pan=mono|c0=c0 -ar 48000 -f f32le -`: six clicks at exactly
  0, 24 000, 48 000, 72 000, 96 000 and 120 000 samples, 0.699–0.702 (0.58 for the first, AAC's start), so the
  track insert's latency is compensated in the export and preview and export agree on timing to the sample.
- Clip head at a cut: see V2.
- Screenshots looked at: `test-results/e2e-sound-p0/essential-sound-sfx.png` (Essential Sound on an SFX clip:
  Loudness, Creative, Pan, Clip Volume, Mute) and `preferences-audio.png` (Preferences ▸ Audio ▸ Voice-Over Record ▸
  Latency Offset 0 ms with its explanation).

Phase 0 "Done when": every confirmed bug of WP0.1, WP0.2 and this verification has a regression test that failed
before and passes after (V5's and V4's hostile-residual tests are defence and passed before); the sample-level oracle
`packages/compositions/test/audio-preview-oracle.test.ts` (4 tests) passes; the voice-over alignment test
`apps/web/test/voiceover-latency.test.ts` (6 tests) lands within one buffer under simulated input latency.

### Phase 0 close-out

Branch `feat/sd-p0-closeout` (from `feat/sound-design` e9b8b01a). Scope: the preview limits the verification left
(`packages/compositions/src/audio/*`, `AudioLayer.tsx`, `SequenceComposition.tsx`, `previews.tsx`) and the SFX Pan
reading of older projects (`packages/project/src/essential/*`, `invariants.ts`, the essential handlers).

**Design: the graph follows Remotion's transport.** Remotion (4.0.499) suspends the AudioContext while paused,
anchors audio to the picture (`audioSyncAnchor`: context time of sequence time 0), dispatches `changed` on that anchor
at a seek (every media player then drops its queued buffers and reschedules), and on Play starts the picture once
the context's output timestamp passes the resume time (`waitUntilActuallyResumed`) with a 30 ms fade-in.
`MixGraph.attachSync` (wired by `MixGraphDriver` from the shared audio context and `usePlayingState`) uses exactly those:

- **Primed start** (C1). After a seek while paused (Remotion's `changed` with the context suspended), at load, and
  when the read-ahead changes while paused, the next Play is *primed*: the graph flushes (below), moves Remotion's
  anchor later by the wait `W` = read-ahead + the largest clip-effect latency (`primedAnchor`, ≤ 0.5 s), so every
  source starts at the play position instead of `W` before it, and reports the context's output timestamp `W` late
  until the program reaches the output (an instance shim of `getOutputTimestamp`, cleared as soon as it has), so the
  picture's first frame waits for the program's first sample. The program gets Remotion's own 30 ms fade-in at its
  start (`START_FADE`, a gain after the device fold). A plain pause and Play is not primed: the audio in flight is
  the continuation, and the context resumes it seamlessly. Rejected: delaying the sources (audio late for the whole
  play), pre-rendering the pre-roll (the media is decoded by Remotion's players, not reachable here), holding the
  picture with Remotion's buffering state (it suspends the audio too).
- **Flush at seeks** (C2). `MixGraph.flush()` gives every route delay a fresh delay line and every effect slot (track,
  submix, Mix, clip) and the loudness limiter a fresh processor, so nothing of the old position is in flight or rings
  on: paused, before the primed start; playing, after a 3 ms fade-out of the graph output (`FLUSH_FADE`).
- **Held read-ahead** (C3). The read-ahead follows the plan while paused and is held while playing: a latency change
  during playback (an insert added or removed, normalisation toggled) never re-creates the clips' media players
  (`AudioLayer` keys them on `MixGraph.epoch`, which only moves while paused). The audio in flight is kept: a longer
  route delay appends a segment (`liveDelaySegments`: that much silence, then the audio continues), a shorter one
  shortens the last segments, slots of unchanged effects keep their processors (`SlotChain.sync` reuses them by
  instance id), and a plan shorter than the held read-ahead is padded at the Mix (`pad`). Stage times use the held
  read-ahead (`stripStageTimes(…, readAhead)`). Until playback stops the Mix is late by an added latency (inter-track
  alignment stays exact); at the stop the read-ahead takes the plan's and the next Play is primed.
- **SFX Pan of older builds** (C4). Builds before WP0.2 #10 (on `main` since 2026-10-07, so projects exist) wrote the
  Pan value into the clip's pan: the static value, or one keyframe at the playhead. The offset reading shifted every
  keyframe by −value when Pan was switched off. Settings now carry `panOffset: true` (optional, written by every
  command, not a setting: refused by `essentialSound.set`, left out of `essentialKeys` and `get_essential_sound`).
  Settings without it whose Pan the offset would misread (`legacyPanApplied`: SFX, Pan on, value ≠ 0, and the pan is
  keyframed or not equal to the value) are an `INV-ESSENTIAL` issue; `repairDocument` (`migrate-essential-pan`) and
  every Essential Sound command (`audioClips`) switch the section off with its value kept, so the pan stays as saved
  and switching it on later is a plain offset. An untouched static pan (equal to the value) already reads the same as
  an offset and only gets the marker on the next write (Pan off gives 0, as the old build did). No schema bump: the
  marker is optional, `AudioClip.essential` is `unknown` and the settings schema loose, so older builds keep it.

#### Findings

| # | Item (from the verification) | Verdict | Regression test (before → after) |
|---|---|---|---|
| C1 | Right after Play the first read-ahead samples were lost | **fixed** (primed start) | `e2e/sound-p0-transport.spec.ts` "Play: the first samples…": a click 30 ms after the play position with 41.6 ms of read-ahead (Hard Limiters with 20 ms look-ahead on A1 and the Mix). Before: first click heard at +0.280 s (the 0.03 s one lost). After: at +0.0716 s = W 0.0416 + 0.03, 0.68–0.71; picture − audio equals the no-latency baseline within 7 ms (without the output-timestamp shim it was 40–42 ms off: measured with the shim disabled) |
| C2a | After a seek while paused, Play first played the graph's pre-seek audio (suspected) | **confirmed, fixed** (flush) | same spec, "Play after a seek while paused": pause inside a tone, seek to silence, Play. Before: max 0.352 within 1 ms of the start. After: 0 |
| C2b | After a seek while playing, the pre-seek audio went on for the read-ahead (suspected) | **confirmed, fixed** (fade + flush) | same spec, "seek during playback": before, the tone ran 44.2 ms past Remotion's stop of the old buffers; after, it ends at the stop (−0.02 ms). Offline: `packages/compositions/test/audio-preview-transport.test.ts` "a seek flushes…" (delay lines and a Convolution Reverb tail silent from the next quantum) |
| C3 | A latency change while playing re-created every clip's media player (suspected dropout) | **confirmed, fixed** (held read-ahead, live routes, slot reuse) | same spec, "a latency change during playback" (a 2nd Hard Limiter added to A1 while playing, Δ = 998 samples): before, one gap of 1996 samples (41.6 ms, three runs at low load; the players were re-created); after, 998 samples (Δ, the minimum for a longer latency). Offline: `audio-preview-transport.test.ts` add / remove cases: one gap ≤ Δ, then the new mix exact (< 1e-4) right after it (late by Δ when added, aligned when removed); both fail with fresh delay lines or re-created slots |
| C4 | SFX Pan saved before it was an offset: Pan off shifted every keyframe | **confirmed defect, fixed** (read-time migration) | `packages/project/test/essential.test.ts` "Essential Sound Pan saved by builds where it was not an offset" (6 tests, one a fast-check property over 60 old states). Before: keys `[-50, 20, 50]` became `[-70, 0, 30]`; 5 of 6 failed (the untouched static case already read the same). Real app: same e2e spec, a project file edited to the old form and reopened: keys unchanged, the Pan section shows off, on/off gives `[-30, 40, 70]` and back |

#### Limits (measured where stated)

- A seek *during playback* still loses the first read-ahead after it (plus Remotion's own decode time): the picture
  jumps at once, so the sources cannot start early. Most seeks pause first (TL-832: ruler, keyboard), so the primed
  start covers them; typed timecodes and marker clicks seek while playing.
- A primed start waits `W` (≤ 0.5 s; 41.6 ms in the tests) before the picture moves; above 0.5 s it is not primed
  (the read-ahead is lost as before).
- An insert added while playing leaves the Mix late by its latency until playback stops (inter-track alignment
  exact; 20.8 ms in the test). Removing one keeps alignment (padding).
- Seeks shorter than Remotion's anchor tolerance (0.1 s + output latency) while paused are not seeks for Remotion:
  it keeps its queued buffers, and so does the graph (the audio continues from where it was; Remotion's behaviour).
- The getOutputTimestamp shim relies on Remotion 4.0.499's `waitUntilActuallyResumed`; the e2e sync check fails if
  an upgrade stops using it.
- Under heavy load (load average 80–125 on the 16-core host) Remotion re-anchors and reschedules every player during
  playback and its buffer scheduling falls behind; the e2e plays again (up to 3 times) when that happens around the
  measured moment. The pre-fix build showed the same reschedules under the same load.

#### Verified (commands and results)

PLACEHOLDER-VERIFIED

## Phase 1: sound library

### WP1.1b descriptors, judge and Jasper Synth

Scope: `packages/audio-fx` only (pure; imports `@jasper/audio-dsp` and nothing else). Spec 12 §2.1, P1-R2, P1-R3.

Files: `src/analysis/sound-descriptors.ts` (`analyzeSound`), `src/analysis/sound-judge.ts` (`judgeSound`, the type
ids and `DEFAULT_TYPE_PROFILES`), `src/synth/kit.ts` (PRNG and DSP blocks), `src/synth/recipes.ts` (19 recipes),
`src/synth/render.ts` (`renderSynth`, catalogue); tests `test/sound-descriptors.test.ts`, `sound-judge.test.ts`,
`sound-synth.test.ts`, `sound-oracle.test.ts`. Everything is exported from `@jasper/audio-fx`.

#### API (for the engine library, the taxonomy and ranking)

```ts
const SOUND_DESCRIPTORS_VERSION = 1;          // bump = re-analyse indexed sounds
const MAX_ANALYSIS_SECONDS = 120, MAX_ONSET_SECONDS = 30, MAX_SPECTRAL_FRAMES = 1500, MAX_SOUND_CHANNELS = 32;
const MIN_SOUND_SAMPLE_RATE = 1000, MAX_SOUND_SAMPLE_RATE = 768_000, DESCRIPTOR_FLOOR_DB = -120;
const OCTAVE_BAND_CENTRES_HZ: readonly number[];   // [125, 250, 500, 1000, 2000, 4000, 8000]
function analyzeSound(channels: Float32Array[], sampleRate: number): SoundDescriptors;  // throws SoundAnalysisError
class SoundAnalysisError extends Error { readonly code: 'E_INVALID_PARAM' }
interface SoundDescriptors {
  durationSec: number; peakSec: number; onsetSec: number; riseMs: number; decayMs: number; decays: boolean;
  tailSec: number; centroidHz: number; rolloff85Hz: number; below150Share: number; above6kShare: number;
  flatness: number; octaveBandsDb: number[] /*7*/; pitchMidi: number | null; pitchConfidence: number;
  onsetCount: number; integratedLufs: number | null; maxMomentaryLufs: number | null; truePeakDb: number | null;
  stereoWidth: number; headQuietSec: number; loopable: boolean;
}

const SOUND_TYPE_IDS: readonly ['hit','boom','riser','reverse','transition','whoosh','swish','glitch','ui','click',
  'key','tick','tap','pop','thump','paper','chime','shimmer','zap','ambience','roomtone'];
type SoundTypeId = (typeof SOUND_TYPE_IDS)[number];
interface SoundTypeProfile { minDurSec: number; maxDurSec: number; maxRiseMs: number | null; mustDecay: boolean;
  maxBelow150Share: number; maxAbove6kShare: number; maxFlatness: number | null; singleHit: boolean;
  minMaxMomentaryLufs: number }
type JudgeReason = 'boomy'|'hissy'|'noisy'|'soft-attack'|'non-decaying'|'too-long'|'too-short'|'clipped'|'multi-hit'|'quiet';
const JUDGE_REASONS: readonly JudgeReason[];  const CLIPPED_TRUE_PEAK_DB = 0.3;
interface JudgeResult { ok: boolean; score: number; reasons: JudgeReason[] }
function judgeSound(d: SoundDescriptors, profile: SoundTypeProfile): JudgeResult;   // never throws
const DEFAULT_TYPE_PROFILES: Readonly<Record<SoundTypeId, SoundTypeProfile>>;

const SYNTH_SAMPLE_RATE = 48_000, SYNTH_VARIANTS = 8, SYNTH_VERSION = 1;
const SYNTH_RECIPES: readonly SynthRecipe[];   // {id: 'synth.<type>', type, title, render(rng, sr)}
function renderSynth(recipeId: string, seed: number): SynthSound;  // throws SynthError (E_INVALID_PARAM)
interface SynthSound { recipe: string; type: SoundTypeId; title: string; seed: number; sampleRate: number;
  channels: Float32Array[] /*stereo, peak −1 dBFS*/ }
function synthCatalogue(): { recipe: string; type: SoundTypeId; seed: number; title: string }[];  // 19 × 8
function synthRecipe(id: string): SynthRecipe | undefined;
class SplitMix32 { constructor(seed: number); nextU32(): number; unit(): number; bipolar(): number; … }
```

The library source of a synth sound is `{type: 'synth', recipe: 'synth.<type>', seed}`; render it with
`renderSynth(recipe, seed)` and encode with `@jasper/audio-dsp`'s `encodeWav`. The project taxonomy carries its own
`SoundTypeProfile` objects of the same shape and passes them to `judgeSound`.

#### Descriptor definitions (decisions)

| Field | Definition |
|---|---|
| envelope | mean power over channels in 2 ms windows (4 hops of `round(0.5 ms · sr)` samples), one per hop |
| `peakSec` | centre of the loudest window; when several windows tie (an impulse is in 4), the centre of the run |
| `onsetSec` | first point within 30 dB of the peak, interpolated in dB |
| `riseMs` | 10 → 90 % amplitude (−20 → −0.915 dB) of a reference level = the loudest 10 ms (20-point moving mean) of the envelope; t90 = first point reaching it, t10 = last point before it under −20 dB. The 10 ms reference keeps a fluctuating sustain (noise) from moving the 90 % point to its loudest 2 ms instant |
| `decayMs`, `decays` | peak → first point 20 dB under the peak; without one, `decays = false` and `decayMs` = peak → end |
| `tailSec` | peak → last point within 60 dB of the peak |
| active span | first … last envelope point within 60 dB of the peak; the spectrum, width and onsets use it |
| spectrum | Welch average of Hann frames (`2^k ≥ 40 ms`, 2048 at 48 kHz, 50 % overlap) over the active span; channels transformed in pairs with one complex FFT and summed; at most 1500 evenly spaced frames |
| `centroidHz`, `rolloff85Hz` | centroid and 85 % point of the average **power** spectrum (power, not magnitude: a step at the edge of a sound splatters low-level broadband magnitude that moved a sine's magnitude centroid 8 % off) |
| `below150Share`, `above6kShare` | power below 150 Hz / above 6 kHz ÷ all power |
| `flatness` | Wiener entropy (geometric ÷ arithmetic mean) of the average power spectrum over 50 Hz … min(16 kHz, 0.45·sr), bins floored 120 dB under the strongest. Long-term on purpose: P1-R2 wants white noise ≈ 1; a per-frame flatness of white noise is ≈ 0.56 (power) or ≈ 0.85 (magnitude) |
| `octaveBandsDb` | mean square in each octave (fc/√2 … fc·√2) over the active span, dBFS (a full-scale sine reads −3.01); each FFT bin counts with the share of its width inside the band (whole-bin edges gave white noise −0.28 dB steps); floor −120 |
| `pitchMidi`, `pitchConfidence` | YIN (de Cheveigné & Kawahara, JASA 111(4), 2002): mono mix box-decimated to ≤ 48 kHz, 50 Hz … 4.2 kHz, threshold 0.15, parabolic refinement, up to 16 frames over the first second of the active span (frames 40 dB under the peak skipped). Confidence = 1 − median aperiodicity; pitch = median f0 of voiced frames (aperiodicity < 0.2), null unless confidence ≥ 0.7 and at least half the frames are voiced. Confidence is always a number |
| `onsetCount` | SuperFlux-style (Böck & Widmer, DAFx 2013): third-octave band energies from 60 Hz (≥ 4 bins per band), 20 ms frames, 50 % hop; flux = Σ bands of the rise in dB over the max of the two previous frames, each band capped at 30 dB, floor 80 dB under the loudest band. A peak counts when it is a ±2-frame maximum, ≥ 12 dB and ≥ 25 % of the largest flux, the frame is within 40 dB of the loudest frame, the frame energy rises ≥ 3 dB over the two before it (an abrupt stop splatters into empty bands but loses energy; a sweep or tremolo moves energy between bands), and ≥ 50 ms after the previous onset. A swell with no attack has 0 |
| `integratedLufs`, `maxMomentaryLufs`, `truePeakDb` | `@jasper/audio-dsp` `LoudnessMeter` (BS.1770-4, 5.1 weights for 6 channels), the input padded with silence to whole 100 ms blocks and at least 400 ms, so the end of a sound and a sound shorter than 400 ms are measured; `null` for −∞ (silence, nothing through the gates) |
| `stereoWidth` | E(side) ÷ (E(mid) + E(side)) of channels 0 and 1 over the active span: 0 mono, 0.5 uncorrelated or one-sided, 1 anti-phase; 0 for mono |
| `headQuietSec` | first sample (any channel) ≥ 1 % (−40 dB) of the sample peak ÷ sr, **rounded down** to 0.1 ms, so placement (§2.3) never trims an audible sample |
| `loopable` | ≥ 1 s, no quiet head (< 5 ms), the first and last 100 ms within 3 dB of each other and neither more than 10 dB under the whole, and the wrap jump (last → first sample) ≤ 4 × the RMS sample step near both ends, per channel |

Quantisation: seconds 0.0001 (0.1 ms), ms 0.1, Hz 1, dB / LUFS / MIDI 0.01, shares, flatness, confidence and width
0.001; never −0.

Robustness: `channels` must be an array of `Float32Array` (≤ 32) and `sampleRate` a finite number in 1 kHz … 768 kHz,
else `SoundAnalysisError` (`E_INVALID_PARAM`). Samples are **sanitised**: NaN and ±Infinity count as 0 (copied only
when present); channels of different lengths are padded with silence; empty, silent, one-sample, mono, stereo, 5.1 and
huge finite values (±3.4e38) all give defined, finite, quantised results. Input longer than 120 s is analysed over its
first 120 s (`durationSec` is the real length); onsets over at most 30 s of the active span.

#### Judge

Reasons, each against a profile field: `too-short`/`too-long` (`durationSec`), `soft-attack` (`riseMs > maxRiseMs`),
`non-decaying` (`mustDecay && !decays`), `boomy` (`below150Share`), `hissy` (`above6kShare`), `noisy` (`flatness >
maxFlatness`), `multi-hit` (`singleHit && onsetCount > 1`), `quiet` (`maxMomentaryLufs` null or under the floor) and
`clipped` (`truePeakDb > +0.3 dBTP`: PCM samples never exceed 0 dBFS, so overs that large mean a waveform squared off
at full scale; a proxy, since descriptors carry no sample-run count). Values on a limit pass; non-finite limits are not
checked. `ok` = no reason; `score` = Π (1 − weight × severity) with severity = distance outside the limit ÷ a scale,
clamped to 0.25 … 1 (weights 0.4 … 0.6); reasons in the fixed `JUDGE_REASONS` order.

`DEFAULT_TYPE_PROFILES` (no published reference exists for these thresholds; they are chosen from what each type is,
and checked against the synth kit; the starter-kit package should check them on real recordings):

| Type | dur (s) | max rise (ms) | decays | max <150 | max >6k | max flat | single | min max-M (LUFS) | Why |
|---|---|---|---|---|---|---|---|---|---|
| hit | 0.05–6 | 25 | ✓ | 0.6 | 0.5 | — | ✓ | −40 | a strike: fast attack, one onset, body allowed but not sub-dominated |
| boom | 0.2–10 | 60 | ✓ | 1 | 0.25 | — | ✓ | −45 | low by definition (never "boomy"), long tail, no fizz |
| riser | 0.5–30 | — | — | 0.6 | 0.6 | — | — | −45 | swells: no attack or decay requirement |
| reverse | 0.3–12 | — | — | 0.6 | 0.6 | — | — | −45 | a reversed tail ends at its peak |
| transition | 0.2–12 | — | — | 0.7 | 0.6 | — | — | −45 | any sweep or composite |
| whoosh | 0.15–6 | — | — | 0.5 | 0.7 | — | — | −45 | filtered noise: noise allowed, sub not |
| swish | 0.05–3 | — | — | 0.3 | 0.85 | — | — | −45 | short and bright |
| glitch | 0.03–5 | — | — | 0.5 | 0.7 | — | — | −45 | stutters: several onsets expected |
| ui | 0.01–2 | 30 | ✓ | 0.3 | 0.6 | — | — | −50 | blips: crisp, short, may be two notes |
| click | 0.002–1 | 6 | ✓ | 0.3 | 0.85 | — | ✓ | −55 | a few ms transient; bright allowed; short sounds read low in 400 ms momentary |
| key | 0.005–1 | 10 | ✓ | 0.4 | 0.7 | — | ✓ | −55 | one key press (a press+release pair is two onsets) |
| tick | 0.002–1 | 6 | ✓ | 0.3 | 0.85 | — | ✓ | −55 | like click, often tonal |
| tap | 0.01–1.5 | 12 | ✓ | 0.5 | 0.6 | — | ✓ | −55 | finger/knuckle on a surface |
| pop | 0.01–1.5 | 15 | ✓ | 0.5 | 0.5 | — | ✓ | −50 | bubble/cork: tonal blip |
| thump | 0.05–3 | 25 | ✓ | 0.95 | 0.25 | — | ✓ | −45 | low and dull, but a pure sub (> 95 %) is a boom |
| paper | 0.05–6 | — | — | 0.3 | 0.85 | — | — | −50 | crackle trains: many onsets, noisy |
| chime | 0.2–10 | 40 | ✓ | 0.3 | 0.5 | 0.3 | — | −45 | tonal and ringing out: flatness limits noise |
| shimmer | 0.3–12 | — | — | 0.2 | 0.85 | 0.5 | — | −50 | high, tonal-ish texture |
| zap | 0.05–3 | 30 | — | 0.5 | 0.6 | — | — | −45 | electric sweep: attack yes, decay optional |
| ambience | 2–3600 | — | — | 0.8 | 0.6 | — | — | −60 | beds: long, low allowed, quiet allowed |
| roomtone | 2–3600 | — | — | 0.9 | 0.6 | — | — | −75 | very quiet by nature |

#### Jasper Synth

`SplitMix32` (Steele, Lea & Flood, OOPSLA 2014, 32-bit) seeded with FNV-1a(recipe id) ⊕ seed·0x9e3779b1; no
`Math.random`, no clock. Each recipe draws its parameters from the generator and renders stereo float64 work buffers
through `kit.ts` (white noise, phase-continuous sines, band-limited additive saw, RBJ biquads from
`@jasper/audio-dsp` with time-varying cutoff, envelopes, equal-power pan), then `finish`: 25 Hz high-pass, raised-cosine
fades, sample peak normalised to −1 dBFS, Float32. Recipes: hit (pitch-dropping body + ring + bandpassed noise
transient), boom (40–56 Hz drop + low rumble), riser (swept bandpass noise + rising tone, power-curve swell), reverse
(reversed noise/tone decay), transition (down-sweep + falling tone), whoosh / swish (bell-enveloped swept noise, panned
across), glitch (square, sample-and-hold and bit-crushed grains), ui (two blips), click, key (click + body + thock),
tick, tap (three modes), pop (upward glide), thump (sub drop + knock), paper (Poisson crackles over rustle), chime
(bell partials 1, 2, 2.76, 4.07, 5.4), shimmer (12–20 drifting, trembling high partials), zap (band-limited saw
sweep). Bit-exactness relies on V8's fdlibm `Math.sin/exp/pow/log`, identical on every platform for a given Node; the
pinned hashes tell when that (or a recipe) changes: then bump `SYNTH_VERSION` and repin.

#### Verified (measured, this branch, shared host, load 17–48 on 16 cores)

- `pnpm vitest run packages/audio-fx/test/sound-synth.test.ts packages/audio-fx/test/sound-judge.test.ts packages/audio-fx/test/sound-descriptors.test.ts --maxWorkers=3`:
  88 passed. Includes: impulses at 7 positions (48 kHz) and at 22.05/44.1/96 kHz → `peakSec` within 1 ms; exponential
  decays τ = 50/100/250 ms → `decayMs` = τ·ln 10 within 3 % (sine) / 20 % (noise) and the −60 dB tail; sines 110 Hz …
  2637 Hz → centroid within 2 %, MIDI within 0.05 (440 Hz → 69.00), confidence > 0.9; white noise → flatness > 0.95,
  centroid 12 kHz, above-6 kHz share 0.75, octave steps 3.01 ± 0.3 dB; pink noise (exact 1/f, 20 Hz–20 kHz) →
  below-150 share 0.292 and above-6 kHz share 0.174 within 0.015, octave bands equal within 0.5 dB; brown noise
  share; a 100 ms linear ramp → rise 80 ms ± 3; hit counting (1, 2, 4 hits; a swell ≤ 1; a tone that stops = 1);
  −20 dBFS stereo 1 kHz sine → −20.0 LUFS / dBTP; widths 0 / 0.5 / 1; loopable cases; 5.1; NaN/±Inf sanitised
  equals zeros; > 120 s input; invalid arguments refused; two fast-check properties (120 runs of structured random
  input over 0–6 channels, 0–12 000 samples, 6 rates, 4 amplitudes; 150 runs of arbitrary float32 arrays with NaN,
  ±Inf and extremes): never throws, every output finite and on its grid. Judge: every reason alone, limits inclusive,
  ordering and score monotonicity, odd profiles, the 21 profiles' sanity. Synth: 19 recipes = the 19 effect types,
  SplitMix32 reference sequence, pinned sha256 per recipe (8 seeds), refusals, and **all 152 variants accepted by the
  judge for their own type**.
- `JASPER_REQUIRE_ORACLES=1 pnpm vitest run packages/audio-fx/test/sound-oracle.test.ts`: 5 passed against
  `/usr/bin/ffmpeg` (ours / ffmpeg): white noise centroid 11965 / 11964.8 Hz, rolloff 20391 / 20364.2 Hz; 1 kHz sine
  1000 / 1000.5, 1008 / 1007.8; 500 Hz + 3 kHz 1750 / 1716.9, 3000 / 3000.0; flat band 1–4 kHz 2501 / 2491.5,
  3563 / 3547.9; `ebur128`: I −13.56 / −13.567 LUFS, max momentary −8.99 / −8.995 LUFS, TP −0.33 / −0.33 dBTP.
- Synth margins, all 8 seeds per type (measured by a scratch script rendering and analysing the catalogue; profile
  limit in brackets; every score 1):

| type | durationSec | riseMs max | below150 max | above6k max | flatness max | onsets | maxMomentary min | score min |
|---|---|---|---|---|---|---|---|---|
| hit | 0.7121–1.193 (0.05–6) | 0.8 (25) | 0.527 (0.6) | 0.029 (0.5) | 0.065 (—) | 1–1 (single) | -17.19 (-40) | 1 |
| boom | 1.9191–3.285 (0.2–10) | 5 (60) | 0.996 (1) | 0 (0.25) | 0 (—) | 1–1 (single) | -9.22 (-45) | 1 |
| riser | 1.5507–3.3863 (0.5–30) | 1360.9 (—) | 0 (0.6) | 0.071 (0.6) | 0.215 (—) | 0–0 | -9.16 (-45) | 1 |
| reverse | 1.277–2.4395 (0.3–12) | 1281.8 (—) | 0.007 (0.6) | 0.049 (0.6) | 0.135 (—) | 0–1 | -11.64 (-45) | 1 |
| transition | 0.9187–1.7061 (0.2–12) | 320.2 (—) | 0.119 (0.7) | 0.048 (0.6) | 0.155 (—) | 0–2 | -9.53 (-45) | 1 |
| whoosh | 0.5893–1.0339 (0.15–6) | 248.6 (—) | 0 (0.5) | 0.114 (0.7) | 0.301 (—) | 0–2 | -9.62 (-45) | 1 |
| swish | 0.1531–0.3646 (0.05–3) | 64.1 (—) | 0 (0.3) | 0.516 (0.85) | 0.426 (—) | 1–1 | -14.95 (-45) | 1 |
| glitch | 0.228–0.4869 (0.03–5) | 83.1 (—) | 0.055 (0.5) | 0.003 (0.7) | 0.003 (—) | 1–4 | -9.62 (-45) | 1 |
| ui | 0.2502–0.3494 (0.01–2) | 1.7 (30) | 0 (0.3) | 0 (0.6) | 0 (—) | 2–2 | -12.85 (-50) | 1 |
| click | 0.0522–0.073 (0.002–1) | 0 (6) | 0 (0.3) | 0.115 (0.85) | 0.081 (—) | 1–1 (single) | -25.44 (-55) | 1 |
| key | 0.0928–0.1402 (0.005–1) | 0 (10) | 0.026 (0.4) | 0.107 (0.7) | 0.177 (—) | 1–1 (single) | -24.68 (-55) | 1 |
| tick | 0.0375–0.0598 (0.002–1) | 0 (6) | 0 (0.3) | 0.028 (0.85) | 0.006 (—) | 1–1 (single) | -22.62 (-55) | 1 |
| tap | 0.1949–0.2871 (0.01–1.5) | 1.8 (12) | 0.011 (0.5) | 0 (0.6) | 0 (—) | 1–1 (single) | -21.56 (-55) | 1 |
| pop | 0.0837–0.1832 (0.01–1.5) | 1 (15) | 0.006 (0.5) | 0 (0.5) | 0 (—) | 1–1 (single) | -19.25 (-50) | 1 |
| thump | 0.4323–0.7377 (0.05–3) | 0.7 (25) | 0.853 (0.95) | 0 (0.25) | 0.001 (—) | 1–1 (single) | -15.98 (-45) | 1 |
| paper | 0.6525–1.2624 (0.05–6) | 125.2 (—) | 0 (0.3) | 0.145 (0.85) | 0.089 (—) | 6–11 | -16.95 (-50) | 1 |
| chime | 2.2456–3.7795 (0.2–10) | 1.6 (40) | 0 (0.3) | 0.004 (0.5) | 0 (0.3) | 1–1 | -10.06 (-45) | 1 |
| shimmer | 1.862–2.8312 (0.3–12) | 819 (—) | 0 (0.2) | 0.122 (0.85) | 0 (0.5) | 0–2 | -8.09 (-50) | 1 |
| zap | 0.2211–0.3985 (0.05–3) | 2.1 (30) | 0.02 (0.5) | 0.002 (0.6) | 0.002 (—) | 1–1 | -11.33 (-45) | 1 |

- Speed (measured, scratch script, load ≈ 47): `analyzeSound` on 60 s of stereo noise 1.5–5.2 s (load-dependent);
  render + analyse of one synth sound ≈ 100 ms at load 17.
- `JASPER_REQUIRE_ORACLES=1 pnpm vitest run packages/audio-fx --maxWorkers=2`: 16 files, 229 tests passed (the whole
  package, old and new). `pnpm typecheck` (whole workspace) and `pnpm lint` (Biome, tokens, anime, layers, assets) pass.
- Module-level tables (`SYNTH_RECIPES`, `DEFAULT_TYPE_PROFILES`, …) are `@__PURE__`-annotated so the preview worklet
  and web bundles, which import `@jasper/audio-fx` for the effect chain, can drop them.

#### Limits and notes for the next packages

- Noisy sounds: `peakSec`, `decayMs` and `tailSec` follow the spec's 2 ms window, so on noise the peak is the
  loudest 2 ms fluctuation (≈ +2 dB over the trend) and `decayMs` can be ≈ 15–20 % short. `riseMs` uses the 10 ms
  reference and is not affected.
- `onsetCount` is a heuristic: crackly or rattling tails count as several onsets (correct for paper and debris, a
  possible false `multi-hit` for a hit with a rattle). Swells and sweeps read 0–2.
- `clipped` is a true-peak proxy; flat-topped runs below +0.3 dBTP are not detected.
- `pitchMidi` looks only at the first second of the active span (sweeps report their start, if any).
- Analysis is capped at 120 s; a 2-minute stereo file takes a few seconds under load. The engine's `sound-index` job
  should run it off the request path.
- The judge profiles are reasoned defaults checked only against the synth kit; real recordings (the starter kit) may
  need tuning, which the taxonomy can do without touching this package.

## Phase 2: cues and placement

## Phase 3: proposals and review

## Phase 4: mixing

## Phase 5: Sound Check

## Phase 6: packs, cue sources, completion
