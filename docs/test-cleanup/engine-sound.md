# Engine sound test audit

Scope: all 40 original engine test files whose basenames start audio/sound/music, excluding sound-check*, sounds-*, sound-semantic*, and sound-packs (owned by other workstreams). This ledger identifies all 188 direct static test declarations plus two generated fuzz tests; table-driven/loop expansions are described with their source rows, and generated fuzz cases remain in the owning file. It does not count runtime parameter expansions as independent static declarations.

The source of the independent contracts below is `docs/specs/12-sound-design.md`, the referenced requirement/work package in `docs/wp-notes/sound-design.md`, architecture D-51/D-52, and the cited external audio standards. Production owners are relative to `apps/engine/`. Each row inherits its file’s explicit six-bar evidence, with the named scenario identifying the unique failure. DELETE and removed CONSOLIDATE rows state their failed bar and surviving owner instead.

No DSP algorithms, schema, migrations, persisted data, public package exports, authentication, or command behavior changed. A real-worker failure probe exposed a decoder bug: a failed or missing child produced silent success. The bounded reader fix now propagates typed failures; the fail-before evidence and new contract regression are recorded below. Removed exports are private engine-module internals with no non-test external consumer: delivery table/cache/cache size/cache key/correction helper; measurement mode/count diagnostics and test-only Worker interface/factory type exports; PCM byte helper; solo-tail bounds. Production entry points continue using the same code. Worker factory/scheduling injection and per-call timeout overrides are removed. The private module resolver and its environment-key constant are no longer exported, and unused environment/base/startup-argument parameters are removed; genuine environment configuration goes through the production factory. Real Worker URL fixtures provide fault isolation, and stale-mix race synchronization remains because its data-preservation behavior has unique protection.

## `apps/engine/test/audio-beats-metre.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-beats-metre.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E11 / WP6.5b item 10. Production owner: `src/audio/beats.ts and routes/audio-fx.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Wrong tempo octave, misplaced waltz downbeats, metre cache contamination, invalid metre accepted. **3 Independent oracle:** Hand-generated 150-BPM and accented 3/4 click positions; literal metres/error codes. **4 Stable seam:** Authenticated beats HTTP response. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure beat analysis cannot protect route cachedOnly semantics or cache keys per metre.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| a 150 BPM click reads 150 BPM, not 75 | KEEP | Uniquely exercises this named scenario at the stated seam: a 150 BPM click reads 150 BPM, not 75. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a waltz: 3 beats per bar detected, forced 3 the same, forced 4 no bar; metres cached apart; 400s | KEEP | Uniquely exercises this named scenario at the stated seam: a waltz: 3 beats per bar detected, forced 3 the same, forced 4 no bar; metres cached apart; 400s. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/audio-classify.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-classify.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-R3 / WP6.3. Production owner: `src/audio/classify.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Auto Tag mislabels real audio, ignores clip source range, caches wrong range, or mishandles silence/item failures. **3 Independent oracle:** Hand-labelled real LJ speech, starter recordings, and separately seeded held-out material; ≥90% requirement. **4 Stable seam:** Classification HTTP job and its result. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Raw classifier API checks cannot protect FFmpeg decoding/resampling, real compressed speech/effect labels, batching and persistent classification cache. This is the sole full labelled acceptance owner; the audio-motion workstream removes repeated generated music/ambience/synth loops below it. The contract is ≥90% aggregate on each labelled split, not100% per case.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| labelled set: ≥ 90 % on the tuning and on the held-out set (confusion matrices printed) | KEEP | Uniquely exercises this named scenario at the stated seam: labelled set: ≥ 90 % on the tuning and on the held-out set (confusion matrices printed). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| route: clips, item errors, silence, long media windows, refusals | KEEP | Uniquely exercises this named scenario at the stated seam: route: clips, item errors, silence, long media windows, refusals. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/audio-crossfade.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-crossfade.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: S10:TUI-052. Production owner: `src/audio/mixdown.ts / @jasper/project OfflineMixer`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Export has a gap/level bump or wrong fade law. **3 Independent oracle:** Generated 1kHz/1.5kHz tones, constant-power laws and literal half-gain midpoint. **4 Stable seam:** Native export decoded PCM. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** DSP fade units do not exercise transition handles and native export integration.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| exports a constant-power crossfade between two tones without a gap or a level bump > 0.5 dB | KEEP | Uniquely exercises this named scenario at the stated seam: exports a constant-power crossfade between two tones without a gap or a level bump > 0.5 dB. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| exports a constant-gain crossfade with half of each tone at the cut | KEEP | Uniquely exercises this named scenario at the stated seam: exports a constant-gain crossfade with half of each tone at the cut. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/audio-decode.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-decode.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: Sound-design WP0.2 / documented clip content-time contract. Production owner: `src/audio/decode.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Reversed clip is shifted, wrong head/tail silence, empty window hangs/decodes unrelated media. **3 Independent oracle:** A ramp encodes known source time into every sample; literal In/Out and silent intervals. **4 Stable seam:** FFmpeg output of clip decode arguments. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Native full exports are too coarse to isolate exact reverse-window edge and missing-handle contracts.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| a forward clip decodes its content span sample-exactly | KEEP | Uniquely exercises this named scenario at the stated seam: a forward clip decodes its content span sample-exactly. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a reversed clip starts at its source out point (not 250 ms past it) | KEEP | Uniquely exercises this named scenario at the stated seam: a reversed clip starts at its source out point (not 250 ms past it). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a reversed clip whose tail handle reaches before the media start ends in silence | KEEP | Uniquely exercises this named scenario at the stated seam: a reversed clip whose tail handle reaches before the media start ends in silence. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a reversed window entirely before the media start is silence (phase 0 verification) | KEEP | Uniquely exercises this named scenario at the stated seam: a reversed window entirely before the media start is silence (phase 0 verification). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a reversed clip whose head handle reaches past the media end starts in silence | KEEP | Uniquely exercises this named scenario at the stated seam: a reversed clip whose head handle reaches past the media end starts in silence. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## New decoder failure regression

`apps/engine/test/audio-decode.test.ts`, `a decoder failure reaches the caller as $code instead of silence`: **KEEP**, one new table declaration with two actual child-process cases. **1 Independent contract:** AGENTS §0 requires child-process failures to become job errors, never successful silent work; existing native tool errors use `TOOL_FAILED` and `BINARY_MISSING`. **2 Real regression:** FFmpeg exits unsuccessfully or cannot start, but mixer/measurement returns silence. **3 Independent oracle:** an actual Node child explicitly exits7; a unique nonexistent executable cannot start. Literal error codes and exit7 can disagree with implementation. **4 Stable seam:** `ClipReader.read` rejects and real engine worker propagates the error. **5 Refactor resistance:** no private callbacks, scheduling shape, or fake process results are asserted. **6 Unique protection:** the existing worker PCM parity test now protects serialization/recovery after a decoder error, while these lower reader cases isolate the nonzero-exit and ENOENT classifications without building the engine. Both cases failed on the original owner; no existing test checked actual raw decoder process failures. Intentional reader close still stops partial decoding without reporting its own kill as failure.

Fail-before artifacts: `/tmp/jasper-engine-sound-validation/worker-before-fix.json` (worker returned silent PCM instead of rejecting); `/tmp/jasper-engine-sound-validation/decode-before-fix.json` (both direct cases returned0). These are local validation artifacts, not generated fixtures committed to Git.

## `apps/engine/test/audio-deliver.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-deliver.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: S04:RN-032 / WP note Fix: lossy-codec true-peak headroom and loudness convergence; delivery speed. Production owner: `src/audio/deliver.ts and src/audio/mixdown.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Wrong headroom, uncorrected codec overshoot, audible correction step, limiter prevents target without report, cached delivery changes audio or reuses the wrong target, uncaught encoder failure. **3 Independent oracle:** Documented headroom table literals; specified LUFS/true-peak limits, independently read PCM; deterministic repeat relation. **4 Stable seam:** Production delivery API and written/encoded audio. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Export integration owns mux/planner wiring; these tests uniquely own delivery convergence, codec round-trip, impossible target, correction continuity and error propagation.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| is 0 for PCM and grows as the bit rate falls; 5.1 is judged per channel pair | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| hold the corrected hop fully down over ±3 hops and ramp in and out without a step | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| lands a loud mix within 0.1 LU of the target where one pass fell ≈ 0.7 LU short; the ceiling holds | KEEP | Uniquely exercises this named scenario at the stated seam: lands a loud mix within 0.1 LU of the target where one pass fell ≈ 0.7 LU short; the ceiling holds. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| says when the ceiling makes the target impossible (a steady tone pushed into the limiter) | KEEP | Uniquely exercises this named scenario at the stated seam: says when the ceiling makes the target impossible (a steady tone pushed into the limiter). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a mix that needs no limiting is delivered sample-exact as before (one pass: gain, limiter idle) | KEEP | Uniquely exercises this named scenario at the stated seam: a mix that needs no limiting is delivered sample-exact as before (one pass: gain, limiter idle). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| ${codec} ${kbps} kb/s: the decoded audio meets −1 dBTP and lands within ±0.5 LU of −14 LUFS | KEEP | Uniquely exercises this named scenario at the stated seam: ${codec} ${kbps} kb/s: the decoded audio meets −1 dBTP and lands within ±0.5 LU of −14 LUFS. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the limiter is scale-invariant: gain g at ceiling c is c × gain g − c at 0 dBFS (the alternatives’ gain prediction) | KEEP | Uniquely exercises this named scenario at the stated seam: the limiter is scale-invariant: gain g at ceiling c is c × gain g − c at 0 dBFS (the alternatives’ gain prediction). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a second delivery of the same mix starts from the first (one pass, one encode, the same result); the cache is bounded | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| an encode that fails is reported, never an unhandled rejection; the encodes run at most `parallel` at once | REWRITE | Retains encoder failure propagation through the real delivery path. Injects failure at the stable FFmpeg AAC encoder protocol rather than a private scratch-file prefix; removes a concurrency assertion whose immediate rejection never exercised concurrent encodes. |

## `apps/engine/test/audio-fx.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-fx.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: S04 audio rendering and Essential Sound; P6-E11 remix. Production owner: `src/audio/mixdown.ts, service.ts, remix.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Export omits/reorders DSP, loses reverse/pan, remix duration is wrong, Auto-Match measures wrong stage. **3 Independent oracle:** Known generated tones/gain/polarity, generated 120-BPM song, independently measured exported LUFS/duration. **4 Stable seam:** Native export and analyze/remix HTTP APIs. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure DSP tests do not exercise clip effects, clip gain order, source analysis and export plan integration.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume) | KEEP | Uniquely exercises this named scenario at the stated seam: exports clip effects natively with exact DSP gains (Amplify, Invert, Channel Volume). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively | KEEP | Uniquely exercises this named scenario at the stated seam: a hard limiter caps the exported peak; a reversed clip with pan and a reverb exports natively. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| plans a 48 s generated song to 30 s and commits it; the export is 30 s long | KEEP | Uniquely exercises this named scenario at the stated seam: plans a 48 s generated song to 30 s and commits it; the export is 30 s long. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| measures the clip (source levels, with its effects) and matches −23 LUFS in the export | KEEP | Uniquely exercises this named scenario at the stated seam: measures the clip (source levels, with its effects) and matches −23 LUFS in the export. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/audio-mix.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-mix.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: S04 audio mix / BS.775 / BS.1770 / AGENTS error handling. Production owner: `src/audio/service.ts and mixdown.ts; routes/audio.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Wrong pre-fader mute/send, channel fold, normalization target, analysis scope, short-audio failure code or derived-media switch. **3 Independent oracle:** Independent tones, channel-energy expectations, ffmpeg loudness oracle, typed TOO_SHORT error. **4 Stable seam:** Export PCM, analyze/normalize HTTP result, media.derive command. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Other audio tests omit surround/pre-fader routing, source-vs-sequence scope and normalize-media job replacement.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| balance hard left, a submix with a pre-fader send of a muted track, at 44.1 kHz | KEEP | Uniquely exercises this named scenario at the stated seam: balance hard left, a submix with a pre-fader send of a muted track, at 44.1 kHz. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a 5.1 Mix exports discrete 5.1 (puck rear left → Ls) and folds to stereo with BS.775 | KEEP | Uniquely exercises this named scenario at the stated seam: a 5.1 Mix exports discrete 5.1 (puck rear left → Ls) and folds to stereo with BS.775. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| two-pass loudness normalisation reaches the target within 0.1 LU under the true-peak ceiling | KEEP | Uniquely exercises this named scenario at the stated seam: two-pass loudness normalisation reaches the target within 0.1 LU under the true-peak ceiling. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| audio effects without an export processor block every path by name | KEEP | Uniquely exercises this named scenario at the stated seam: audio effects without an export processor block every path by name. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| measures the sequence, soloed tracks and clips (source levels without gain) | KEEP | Uniquely exercises this named scenario at the stated seam: measures the sequence, soloed tracks and clips (source levels without gain). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| refuses to normalise audio shorter than one 400 ms gating block as too short, not as silent | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| normalises a media into a WAV version and audio clips switch to it in one step | KEEP | Uniquely exercises this named scenario at the stated seam: normalises a media into a WAV version and audio clips switch to it in one step. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/audio-publish.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/audio-publish.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: AGENTS §0 preserve work on filesystem failure / atomic publication. Production owner: `src/audio/publish.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Partial cross-device copy overwrites good audio, permission failure loses source, successful copy leaves wrong bytes. **3 Independent oracle:** Literal old/new file bytes with filesystem EXDEV/ENOSPC/EACCES fault isolation. **4 Stable seam:** Published file bytes and filesystem error. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** No stronger test forces these filesystem failures; mocked filesystem injects faults but never supplies the asserted file-preservation behavior.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| preserves existing audio if a cross-device copy runs out of disk space | KEEP | Uniquely exercises this named scenario at the stated seam: preserves existing audio if a cross-device copy runs out of disk space. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| reports a rename permission failure and preserves both files | KEEP | Uniquely exercises this named scenario at the stated seam: reports a rename permission failure and preserves both files. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| publishes the complete audio across filesystems and removes its scratch file | KEEP | Uniquely exercises this named scenario at the stated seam: publishes the complete audio across filesystems and removes its scratch file. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/music-picture.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/music-picture.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E11 / WP-E7. Production owner: `src/audio/beats.ts, remix.ts; sound-design/plan.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Drop misses hero frame, remix clicks/chops, End on Bar is early/abrupt, hostile anchors accepted. **3 Independent oracle:** Generated C-major song/drop at known bar, sample correlation and bar-time/fade bounds. **4 Stable seam:** Beats/remix HTTP and exported decoded audio. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure remix/beat tests cannot protect coordinated bar/drop timing through applied commands and final export.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| the beats route reports the key (C major) and the drop at bar 17 | KEEP | Uniquely exercises this named scenario at the stated seam: the beats route reports the key (C major) and the drop at bar 17. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| an anchored remix lands the drop on the hero frame within 1 ms in the export; its joints are clean | KEEP | Uniquely exercises this named scenario at the stated seam: an anchored remix lands the drop on the hero frame within 1 ms in the export; its joints are clean. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a plain remix of the generated test music: the joints cause no CLICK or EDGE finding | KEEP | Uniquely exercises this named scenario at the stated seam: a plain remix of the generated test music: the joints cause no CLICK or EDGE finding. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| End on Bar: the exported music ends within a frame of the bar line, faded | KEEP | Uniquely exercises this named scenario at the stated seam: End on Bar: the exported music ends within a frame of the bar line, faded. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| hostile inputs are refused with typed errors | KEEP | Uniquely exercises this named scenario at the stated seam: hostile inputs are refused with typed errors. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-beds.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-beds.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E12 / spec12 ambience beds and room tone. Production owner: `src/sound-design/beds.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Loop seams click, proposal applies without user, gap fill is silent/wrong spectrum, tight dialogue loses handle room tone. **3 Independent oracle:** Known scene cuts/pauses, independently measured joint levels and noise floor, typed errors. **4 Stable seam:** Bed/room-tone HTTP jobs, committed doc, check and decoded export. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Lower command/DSP tests cannot protect library selection, handle analysis, proposal policy and exported seamless loop integration.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| 3 scenes × a 4 s ambience over 20 s: looped pieces with crossfades, one edit, a clean Sound Check, a seamless export | KEEP | Uniquely exercises this named scenario at the stated seam: 3 scenes × a 4 s ambience over 20 s: looped pieces with crossfades, one edit, a clean Sound Check, a seamless export. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| an agent proposes it, the user accepts it; the plan route and its refusals | KEEP | Uniquely exercises this named scenario at the stated seam: an agent proposes it, the user accepts it; the plan route and its refusals. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| Sound Check: SILENCE in the dialogue gap → "Fill it with room tone" (pink, the floor match) → gone | KEEP | Uniquely exercises this named scenario at the stated seam: Sound Check: SILENCE in the dialogue gap → "Fill it with room tone" (pink, the floor match) → gone. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| an agent proposes the fill; the proposal check says it fixes the SILENCE (item room-tone) | KEEP | Uniquely exercises this named scenario at the stated seam: an agent proposes the fill; the proposal check says it fixes the SILENCE (item room-tone). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| dialogue trimmed tight to the words: the floor and its own room tone come from the media's handles | KEEP | Uniquely exercises this named scenario at the stated seam: dialogue trimmed tight to the words: the floor and its own room tone come from the media's handles. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the fill route: the gaps, the floor, the candidates by spectral distance, the gain | KEEP | Uniquely exercises this named scenario at the stated seam: the fill route: the gaps, the floor, the candidates by spectral distance, the gain. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-copy-codec.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-copy-codec.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: WP6.5b managed PCM copy / P6-E9. Production owner: `src/sounds/pad.ts and service.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Copy loses integer precision or changes samples/silence; seeking misses exact source samples. **3 Independent oracle:** Literal PCM codec expectations and full external FFmpeg decode; every source sample compared; three distinct seek windows. **4 Stable seam:** Managed WAV output and ffprobe codec. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Long registration/take tests cover service policy; this is the narrow owner of 16/24/float/FLAC/Vorbis copy fidelity. Six rows remain: s16/s24 WAV, s16/s24 FLAC, f32 WAV, Vorbis.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| picks the narrowest exact PCM from the decoder output | KEEP | Uniquely exercises this named scenario at the stated seam: picks the narrowest exact PCM from the decoder output. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| estimates the copy size (header and one spare second included) and never returns NaN | DELETE | Fails independent-oracle/stable-seam bar: repeats estimator formula including incidental4096-byte header and spare second. Real byte-cap/low-disk fallback survives in sound-long-exact. |
| %s → %s copy with lead and trailing silence | OPTIMIZE | Same contract/output oracle retained. PCM cases keep full source comparison plus three distinct seek windows; lifecycle cases advance controlled time instead of sleeping. |

## `apps/engine/test/sound-design-bed.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-bed.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R2 / WP4.1b. Production owner: `src/sound-design/bed.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** SFX leaks into bed, speed/pan/gain lost, wrong content cache key or stale offline measurement survives relink. **3 Independent oracle:** Linear mix decomposition, independent full-span reference and literal speech/band expectations. **4 Stable seam:** Measurement API over real mix renders. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Solver tests consume measurements; they do not independently verify excluded stems, relative keys, gain independence and relink invalidation.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| the bed excludes every SFX clip and equals a whole-sequence render over each window; only clusters are rendered | KEEP | Uniquely exercises this named scenario at the stated seam: the bed excludes every SFX clip and equals a whole-sequence render over each window; only clusters are rendered. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| each sound alone at 0 dB equals its contribution to the full mix less its gain (speed, pan, gain honoured) | KEEP | Uniquely exercises this named scenario at the stated seam: each sound alone at 0 dB equals its contribution to the full mix less its gain (speed, pan, gain honoured). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a second measurement is served from the caches with the same result | KEEP | Uniquely exercises this named scenario at the stated seam: a second measurement is served from the caches with the same result. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the same sound placed the same way elsewhere is rendered once (relative key, exact) | KEEP | Uniquely exercises this named scenario at the stated seam: the same sound placed the same way elsewhere is rendered once (relative key, exact). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| cache keys do not depend on entity ids: the same edit with fresh ids is served from the caches | KEEP | Uniquely exercises this named scenario at the stated seam: cache keys do not depend on entity ids: the same edit with fresh ids is served from the caches. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a bed measured with its media offline is not served after relinking | KEEP | Uniquely exercises this named scenario at the stated seam: a bed measured with its media offline is not served after relinking. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| reports sounds the mix does not play | KEEP | Uniquely exercises this named scenario at the stated seam: reports sounds the mix does not play. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-cues.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-cues.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P2-R6 / spec12 §2.8 / WP2.3. Production owner: `src/routes/sound-design.ts; sound-design/engine-cues.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Stored/inline envelopes differ, source/range defaults drift, unauthorized access or malformed-body crash. **3 Independent oracle:** Literal event frames/anchors from deterministic project; authenticated errors; documented cross-surface equivalence. **4 Stable seam:** Cues HTTP response and web suggestion adapter. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Project derivation units own event algorithms, while these cases own HTTP serialization, stored-doc lookup, auth and adapter-option agreement. Fuzz targets retain typed-failure/no-crash contract.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| derives every event of the Phase 2 fixture (inline envelope) with frames, timecodes, reasons and stats | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| reads a stored project by id, marks suggestions already stored, honours options | KEEP | Uniquely exercises this named scenario at the stated seam: reads a stored project by id, marks suggestions already stored, honours options. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| refuses bad bodies with typed errors (never 500) | KEEP | Uniquely exercises this named scenario at the stated seam: refuses bad bodies with typed errors (never 500). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| needs the token in token mode (401 without it) | KEEP | Uniquely exercises this named scenario at the stated seam: needs the token in token mode (401 without it). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| expression-driven motion, the sequence density, dialogue, ranges and sources agree | KEEP | Uniquely exercises this named scenario at the stated seam: expression-driven motion, the sequence density, dialogue, ranges and sources agree. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-delivery.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-delivery.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R4 / D-51 / AGENTS data-loss race prevention. Production owner: `src/sound-design/delivery.ts and apply-guard.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Wrong delivery level, music masks speech, agent bypasses review, stale measurement overwrites concurrent edit. **3 Independent oracle:** Preset literals −14/−23 LUFS, independent ffmpeg measurement/stems; unchanged doc on concurrent edit. **4 Stable seam:** Authenticated delivery/proposal HTTP, stored revision and export PCM. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** General proposal tests cannot protect delivery-specific measurement-to-commit races or the measured music/voice separation. Race hooks remain necessary fault synchronization; they do not implement the expected refusal.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| apply (web): one transaction; the export meets −14 LUFS ±1 and −1 dBTP; music ≥ 8 LU under the voice | KEEP | Uniquely exercises this named scenario at the stated seam: apply (web): one transaction; the export meets −14 LUFS ±1 and −1 dBTP; music ≥ 8 LU under the voice. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| propose (broadcast-r128): a proposal the agent may not accept; the editor applies it | KEEP | Uniquely exercises this named scenario at the stated seam: propose (broadcast-r128): a proposal the agent may not accept; the editor applies it. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| apply: an edit of the mix while it measures is a CONFLICT (retryable) and nothing is applied | KEEP | Uniquely exercises this named scenario at the stated seam: apply: an edit of the mix while it measures is a CONFLICT (retryable) and nothing is applied. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| apply: an edit of the mix between the check and the apply (the race) is a CONFLICT too; nothing applied | KEEP | Uniquely exercises this named scenario at the stated seam: apply: an edit of the mix between the check and the apply (the race) is a CONFLICT too; nothing applied. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| typed refusals before a job starts | KEEP | Uniquely exercises this named scenario at the stated seam: typed refusals before a job starts. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-grammar.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-grammar.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E10 / WP-E6. Production owner: `src/sound-design/plan.ts; project sound/grammar.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Fast typing plays every letter, palette voice ignored, calm picks hits, music cuts unsuppressed, tick fallback pitched, typing duck omitted. **3 Independent oracle:** Literal word-start units, octave/semitone runs, controlled pool/material/personality; duck attenuation. **4 Stable seam:** Pure planner result and applied proposal document. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Export fixture protects default audio pitch/voice; these remaining cases uniquely vary fast typing, flat/off controls, material coherence, personality, fallback and proposal ducking.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| fast typing: one key per word start, each a distinct sibling take, at rate 1 (no varispeed) | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| a 4-card stagger climbs 0 / +1 / +2 / +3 st by varispeed and the cards share a group | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| the clicks share one sound and one level: no varispeed, no gain jitter | KEEP | Uniquely exercises this named scenario at the stated seam: the clicks share one sound and one level: no varispeed, no gain jitter. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a cut inside music is dropped under balanced with its reason; the cut outside music is kept | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| palette coherence: the impacts keep the material of the first one (metal); without materials rotation wins | KEEP | Uniquely exercises this named scenario at the stated seam: palette coherence: the impacts keep the material of the first one (metal); without materials rotation wins. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a personality moves the picks: calm leaves the hits out of cut cues and is sparse by default | KEEP | Uniquely exercises this named scenario at the stated seam: a personality moves the picks: calm leaves the hits out of cut cues and is sparse by default. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a typewriter filled with ticks (no key recording) is typing, not a climbing run: speed 1, one type | KEEP | Uniquely exercises this named scenario at the stated seam: a typewriter filled with ticks (no key recording) is typing, not a climbing run: speed 1, one type. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| is deterministic | DELETE | Fails unique protection: repeats deterministic planner evaluation already owned by sound-design-plan seed test and plan-levels same-seed gains. |
| keys at rate 1, the run pitched by varispeed, one click level, the duck under typing; one transaction | KEEP | Uniquely exercises this named scenario at the stated seam: keys at rate 1, the run pitched by varispeed, one click level, the duck under typing; one transaction. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-heard-speech.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-heard-speech.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4 dialogue guard / P6-R3 / WP6.5b solver. Production owner: `src/sound-design/bed.ts and voice.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Solver guards dialogue that the mix actually mutes or misses quiet audible speech. **3 Independent oracle:** Known 4–8s speech and literal audible/muted/ducked cases. **4 Stable seam:** Measurement speechOverlap from rendered dialogue. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Dialogue-consistency fixture checks VAD ranges but not clip/track gain automation audibility.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| speech under the click, unless the dialogue is muted, ducked out or its track muted there | KEEP | Uniquely exercises this named scenario at the stated seam: speech under the click, unless the dialogue is muted, ducked out or its track muted there. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-measure-crash.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-measure-crash.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: AGENTS §0 worker failures terminate jobs / WP6.5b item7. Production owner: `src/sound-design/measure-pool.ts; rebalance.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Dead worker leaves rebalance hanging/applied or permanently poisons engine. **3 Independent oracle:** Worker exits3; literal MEASURE_FAILED/retryable, stored revision3; repeat job remains responsive. **4 Stable seam:** Real crashing worker → HTTP job failure and unchanged revision. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pool units cannot protect propagation to queue/API and preservation of saved document.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| fails the rebalance job with MEASURE_FAILED (retryable); nothing applied; the engine keeps working | KEEP | Uniquely exercises this named scenario at the stated seam: fails the rebalance job with MEASURE_FAILED (retryable); nothing applied; the engine keeps working. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-measure-worker.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-measure-worker.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: WP6.5b item7 worker equivalence/lifecycle; AGENTS §0. Production owner: `src/sound-design/measure-pool.ts and measure-worker.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Worker transfer corrupts PCM/bands, startup fallback silently hides broken bundle, crash/timeout/cancel hangs or strands siblings. **3 Independent oracle:** Bit-exact thread/worker equivalence; literal cancellation/timeout/tool error codes; controlled time. **4 Stable seam:** Measurer run result/error and Worker message/exit lifecycle protocol. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Real crash API owns queue propagation; these cases own transport parity, restart, sibling migration, cancellation grace and idle/resource lifecycle. Real Worker URL fixtures induce actual module failures, hangs and uncaught exceptions. Successful fallback/recovery computes documented octave-band silence through the actual bundled or in-thread DSP. Filesystem events synchronize message receipt; parent-only virtual clocks advance documented defaults. No result-echo mocks, private worker counts or configurable test scheduling remain.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| measureSfxEvents: every measurement and the bed clusters are equal, bit for bit | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| a bed render: the PCM is the same, sample for sample (transferred back) | CONSOLIDATE (owner) | Keeps actual nonzero PCM/true-peak parity and absorbs TOOL_FAILED propagation/recovery using a real failing executable followed by the actual bundled DSP. Removes the fake failed-op reply owner. |
| cancelling a render on the worker rejects at once and leaves the pool usable | DELETE | Fails stable synchronization/unique protection: a5ms abort does not establish receipt or in-flight work. The real Worker URL cancellation owner waits for receipt, verifies JOB_CANCELLED, advances the documented five-second grace, and verifies actual DSP recovery. |
| resolves the worker module: env, bundle, tsx source, or none | CONSOLIDATE (removed) | Private lookup results and synthetic module-base/startup-argument inputs fail the stable-seam/refactor bar. The existing fallback owner now configures the actual production factory with `off` and `0`, requires literal silence-band output and no failed-worker warning, and closes/restores the shared instance and environment. The real rebalance crash workflow owns custom-path configuration through actual jobs, typed failures and unchanged revision. Source/bundle lookup details need no dedicated unit. The resolver/key exports and unused env/base/argv parameters are removed. |
| no worker can start: measures in-thread | CONSOLIDATE (owner) | The real production factory honors `off` and `0` without startup warnings and returns literal silence bands. Missing-module and never-ready Worker URL fixtures verify the same real DSP fallback plus the documented120s deadline, without constructor throw stubs or timing options. Public factory shutdown and environment restoration keep cases isolated; the separate HTTP crash owner verifies custom-path selection and queue/error/revision propagation. |
| a worker that crashes: its requests fail with MEASURE_FAILED (retryable), the next one gets a new worker | DELETE | Fails unique protection/stable seam: fake factory/count assertions duplicate the real crashing-rebalance HTTP regression. Real uncaught-error URL fixture additionally verifies a succeeding actual-DSP request after restart. |
| an uncaught error in the worker: the same (never a hung request) | REWRITE | Real Node Worker throws after receiving its operation; expect MEASURE_FAILED/retryable, then independently specified silent-PCM output from a replacement production worker. No factory, lastMode or canned success response. |
| a failed op keeps its code (an ffmpeg failure is a TOOL_FAILED), the worker stays | CONSOLIDATE (removed) | Moved to the real bed-render parity owner: a real executable fails the FFmpeg invocation and yields TOOL_FAILED, then a real render succeeds with exact PCM parity. Deletes the mock error payload that supplied its asserted code. |
| a timeout ends the worker; its other requests move to a new one and complete | REWRITE | Three real Worker operations exercise default two-worker capacity; the first stalls, its sibling migrates after the documented600s deadline and computes actual DSP. FS events synchronize dispatch; clocks replace custom timeout/size hooks. |
| cancel rejects at once; a worker that does not stop within the grace is ended | REWRITE | A real Worker ignores cancellation after receipt; caller gets JOB_CANCELLED immediately, and a pending successor completes on actual DSP after the fixed five-second grace. Pre-aborted signal is also refused. No synthetic cancel-call shape. |
| a worker that never starts: in-thread after the start timeout | CONSOLIDATE (removed) | Merged into startup-fallback owner using a real module that never posts ready and the production120s timeout. Actual DSP output replaces lastMode/fake-worker state checks. |
| at most `size` workers; idle ones are stopped; close interrupts what runs | REWRITE | Real Worker receipt IDs establish the documented two-worker bound, a new ID after30s idle establishes retirement, and closing a real received/stalled operation yields INTERRUPTED. Fixed defaults replace all constructor scheduling overrides. |

## `apps/engine/test/sound-design-mix.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-mix.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R3 / WP4.2a. Production owner: `src/sound-design/bed.ts; project commands; audio/mixdown.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Stop-before timing wrong, build clicks, dry UI routed to reverb, room return leaks into bed or solo misses tail. **3 Independent oracle:** Known tone dip timing/depth; spectral increase; bounded sample differences; linear wet-minus-dry decomposition. **4 Stable seam:** Native export and mix PCM. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Lower commands/DSP cannot protect routing and automation through final mixer and solo analysis.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| the music dips −24 dB from 0.25 s before the hero (30 ms ramps) and is back 20 ms after it | KEEP | Uniquely exercises this named scenario at the stated seam: the music dips −24 dB from 0.25 s before the hero (30 ms ramps) and is back 20 ms after it. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the spectral centroid of the music rises over the build and returns after the hero | KEEP | Uniquely exercises this named scenario at the stated seam: the spectral centroid of the music rises over the build and returns after the hero. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a 220 Hz tone through the sweep has no click (third difference ≪ a step) | KEEP | Uniquely exercises this named scenario at the stated seam: a 220 Hz tone through the sweep has no click (third difference ≪ a step). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the hit sends into the SFX Room (its tail is in the mix); the interface click is dry | KEEP | Uniquely exercises this named scenario at the stated seam: the hit sends into the SFX Room (its tail is in the mix); the interface click is dry. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the bed has no room return of the effects; each sound alone (with its tail) is its contribution to the mix | KEEP | Uniquely exercises this named scenario at the stated seam: the bed has no room return of the effects; each sound alone (with its tail) is its contribution to the mix. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-motion.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-motion.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-R1/R2 / WP6.5b item12 / spec12 engine cues. Production owner: `src/sound-design/motion.ts, engine-cues.ts; audio/beats.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Move/land mistimed, stale visual curve, source fast path differs, scene speed mapping wrong, beat snapping or cancellation/refusals fail. **3 Independent oracle:** Generated box known frames31/60, known scene cut and click grid; independent render/reference pipeline. **4 Stable seam:** Motion/cue/visual/check HTTP jobs and optimized decode vs full render. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure pixel-analysis tests cannot protect source decode/render planning, cached HTTP state and cue anchors through applied speed.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| motion-analysis: the box starts moving at frame 31 and stops at 60 (±2), cached the second time | CONSOLIDATE (owner) | One workflow retains the source-specified output assertions and owns the merged scenario; avoids an order-dependent or redundant second execution. |
| the visual route (view_sound_timeline) carries the measured curve once analysed, null before and after an edit | CONSOLIDATE (removed) | Merged into moving-box workflow; removes dependency on preceding test assigning analysedProject, no extra analysis startup. |
| untouched footage is decoded at the analysis size: the same curve, events and cues as the full render | KEEP | Uniquely exercises this named scenario at the stated seam: untouched footage is decoded at the analysis size: the same curve, events and cues as the full render. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| pixel cues: pending with the job ids first, then moves and lands that resolve back to their frames | KEEP | Uniquely exercises this named scenario at the stated seam: pixel cues: pending with the job ids first, then moves and lands that resolve back to their frames. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| scene cuts: the shot change at media 2 s is a cut at frame 60, at 30 when the clip plays at 200 % | KEEP | Uniquely exercises this named scenario at the stated seam: scene cuts: the shot change at media 2 s is a cut at frame 60, at 30 when the clip plays at 200 %. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| POST /api/audio/beats on a click track: 120 BPM, beats within 5 ms, downbeats; cached; typed refusals | KEEP | Uniquely exercises this named scenario at the stated seam: POST /api/audio/beats on a click track: 120 BPM, beats within 5 ms, downbeats; cached; typed refusals. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| beat cues of an Essential music clip within ±1 frame of the clicks; snapToBeats moves a move ≤ 2 frames | KEEP | Uniquely exercises this named scenario at the stated seam: beat cues of an Essential music clip within ±1 frame of the clicks; snapToBeats moves a move ≤ 2 frames. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the plan job measures picture motion inline and plans its cues | KEEP | Uniquely exercises this named scenario at the stated seam: the plan job measures picture motion inline and plans its cues. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| Sound Check: a derived cue on the measured landing passes NO_PICTURE_EVENT, one on a still picture does not | REWRITE | Known generated landing frame60 replaces a previous test's mutable analysis result. Real motion analysis and check findings retain distinct measured/still/unanalysed picture contracts with an independent literal oracle. |
| cancellation, refusals and the range cap | KEEP | Uniquely exercises this named scenario at the stated seam: cancellation, refusals and the range cap. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| perf: one minute of 1080p footage | DELETE | Fails regression/oracle/unique bar: only succeeded/schema, no motion/performance assertion; generated4s box/cue tests protect real output. |

## `apps/engine/test/sound-design-overlap.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-overlap.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R2 / WP6.5b solver summed headroom. Production owner: `src/sound-design/levels.ts and bed.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Two individually safe heroes sum over ceiling or ambient masking is omitted. **3 Independent oracle:** Literal −1dBTP ceiling, independent combined/stem rendering and band-energy arithmetic. **4 Stable seam:** Solved gains applied then real mixer output. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure solver properties do not verify measured profiles/gains through the real routed mix.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| the summed true peak of the overlapping heroes stays under the ceiling; the rain counts in their bed | KEEP | Uniquely exercises this named scenario at the stated seam: the summed true peak of the overlapping heroes stays under the ceiling; the rain counts in their bed. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-peak.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-peak.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: spec12 §2.7 / Final verification B. Production owner: `src/sound-design/peak.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Peak ignores clip In, scans beyond cap, reverses unsupported audio or misreports silence. **3 Independent oracle:** Known generated click1.9137s /10.5s plus browser-equivalent decode; literal120s cap and typed errors. **4 Stable seam:** Detect Peak HTTP output. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** DSP peak unit tests do not protect stored clip range resolution, media decoding, cap and route refusals.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| finds the peak of the clip’s part of its media, as the browser measures it; one sample | KEEP | Uniquely exercises this named scenario at the stated seam: finds the peak of the clip’s part of its media, as the browser measures it; one sample. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| searches the first 120 s of a longer clip and says so | KEEP | Uniquely exercises this named scenario at the stated seam: searches the first 120 s of a longer clip and says so. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| refuses with typed errors | KEEP | Uniquely exercises this named scenario at the stated seam: refuses with typed errors. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-plan-bench.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-measure-worker.test.ts apps/engine/test/sound-design-plan-mix.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: Historical WP6.5b benchmark (nongating). Production owner: `src/sound-design/measure-pool.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Could pass with incorrect placements; only asserts requested execution diagnostic. **3 Independent oracle:** No independent performance threshold or placement oracle. **4 Stable seam:** Diagnostic lastMode only. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Worker configuration/parity is protected by sound-design-measure-worker; actual plan behavior by sound-design-plan*. Benchmark did not protect performance.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| first plan with every style option (${MODE}) | DELETE | Fails regression/oracle/unique bar: no wall/event-loop budget and only lastMode equality. Worker configuration/parity and actual plan acceptance remain. |

## `apps/engine/test/sound-design-plan-cue-sources.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-plan-cue-sources.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: WP3.3b / spec12 §2.8. Production owner: `src/sound-design/plan.ts and @jasper/api request schema`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Planner derives unrequested sources; HTTP accepts empty/unknown cue-source lists. **3 Independent oracle:** Literal cut-only/transition-only results; allowed source vocabulary. **4 Stable seam:** Pure cue collection; invalid schema moved to HTTP owner. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Project derivation owns event generation; this owns plan style-to-source filtering. Invalid-body checks now live in sound-design-plan route refusal owner.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| derives only from the chosen sources (default: all) | KEEP | Uniquely exercises this named scenario at the stated seam: derives only from the chosen sources (default: all). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the request schema takes known derivation sources only | CONSOLIDATE (removed) | Moved unknown/empty cueSources cases to existing HTTP typed-refusal test in sound-design-plan; no schema-only execution. |

## `apps/engine/test/sound-design-plan-levels.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-plan-levels.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R2 / WP4.1b. Production owner: `src/sound-design/plan-levels.ts and plan.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Report names nonexistent preview IDs, selected alternative applies wrong gain, accepted plan misses cache reuse. **3 Independent oracle:** Documented achieved-or-limited condition; accepted chosen alternative must equal its advertised solved gain. **4 Stable seam:** Plan report, proposal accept and committed clip gains. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Rebalance owns existing clips; this uniquely owns preview refs/alternatives and one-transaction application of planned sounds.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| every event reaches its target lift or reports a limit; items apply their gains; deterministic; timed | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| the editor accepts every place item: one transaction, every sound at its solved gain (sfx.level by solver) | KEEP | Uniquely exercises this named scenario at the stated seam: the editor accepts every place item: one transaction, every sound at its solved gain (sfx.level by solver). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-plan-mix.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-plan-mix.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R3/R4 / WP4.2a. Production owner: `src/sound-design/plan.ts, plan-levels.ts and delivery.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Style options disappear from accepted plan or stored loudness is measured before planned sounds. **3 Independent oracle:** Literal enabled room/delivery/dips/builds and −14 preset; fresh analysis within0.1 of stored value. **4 Stable seam:** Accepted proposal doc and fresh measured mix. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Default plan tests do not enable the whole style; single apply-and-remeasure workflow covers the effects of formerly repeated metadata-only plans.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| proposes the setup items and one stop-before / build item per hero; deterministic | CONSOLIDATE (removed) | Metadata-only setup/ref shape checks duplicate applied outcome. Surviving apply workflow checks room/delivery/dips/builds plus fresh final mix measurement; generic seed test remains. |
| the editor accepts every placement: one transaction with the room, the delivery, the dips and the builds | CONSOLIDATE (owner) | One workflow retains the source-specified output assertions and owns the merged scenario; avoids an order-dependent or redundant second execution. |

## `apps/engine/test/sound-design-plan.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-plan.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P3-R3 / spec12 §2.8 / D-51. Production owner: `src/sound-design/plan.ts and routes/sound-design.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Plan picks disallowed sources, duplicates filled cues, loses proposal dependencies, agent applies without policy, cancel leaves proposal, invalid input starts jobs. **3 Independent oracle:** Literal source/palette/dialogue/cue eligibility/caps; deterministic same-seed relation; revision/permission codes. **4 Stable seam:** Pure planner/draft and authenticated HTTP proposal apply. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Project ranking/cue units do not own planner composition or engine registration/review-policy integration. Fuzz remains for malformed requests and terminal jobs.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| derives the fixture’s cues and gives each a ranked, rotated sound with alternatives; deterministic by seed | KEEP | Uniquely exercises this named scenario at the stated seam: derives the fixture’s cues and gives each a ranked, rotated sound with alternatives; deterministic by seed. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| puts palette sounds first | KEEP | Uniquely exercises this named scenario at the stated seam: puts palette sounds first. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| honours the sources: synth only, or recordings only (cues no recording fits are skipped NO_SOUND) | KEEP | Uniquely exercises this named scenario at the stated seam: honours the sources: synth only, or recordings only (cues no recording fits are skipped NO_SOUND). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| respects dialogue: no cut cue under words, a hero under words becomes support | KEEP | Uniquely exercises this named scenario at the stated seam: respects dialogue: no cut cue under words, a hero under words becomes support. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| plans stored unfilled cues and derived ones once; skips filled, muted, silence and near-duplicates; explicit ids | KEEP | Uniquely exercises this named scenario at the stated seam: plans stored unfilled cues and derived ones once; skips filled, muted, silence and near-duplicates; explicit ids. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| caps the cues (LIMIT) and the alternatives | KEEP | Uniquely exercises this named scenario at the stated seam: caps the cues (LIMIT) and the alternatives. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| is a valid proposal: setup first, place items requiring their setup, alternatives, why-lines; accepting one places it | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| stores a proposal (nothing applied), same picks for the same seed; agents are refused accept; the editor applies one transaction | KEEP | Uniquely exercises this named scenario at the stated seam: stores a proposal (nothing applied), same picks for the same seed; agents are refused accept; the editor applies one transaction. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| an allowed agent may accept; sources and explicit cue ids are honoured | KEEP | Uniquely exercises this named scenario at the stated seam: an allowed agent may accept; sources and explicit cue ids are honoured. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| cancels: a cancelled plan leaves no proposal | KEEP | Uniquely exercises this named scenario at the stated seam: cancels: a cancelled plan leaves no proposal. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| refuses bad requests with typed errors before a job starts | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |

## `apps/engine/test/sound-design-rebalance.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-rebalance.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4-R2 / D-51 / WP6.5b stale mix race. Production owner: `src/sound-design/rebalance.ts and apply-guard.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Rebalance overwrites hand gains/concurrent edits, applies unapproved proposal, Auto gain needs two undo steps. **3 Independent oracle:** User-gain preservation; literal CONFLICT/refusal codes; exactly one revision for applied edit. **4 Stable seam:** Authenticated rebalance job, applied clip gains and revisions. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Delivery races have different transaction targets; these uniquely cover unchanged SFX plus concurrently changed bed and disabled autoGain restoration.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| apply: one transaction; every event reaches its target lift or says what limited it; idempotent | KEEP | Uniquely exercises this named scenario at the stated seam: apply: one transaction; every event reaches its target lift or says what limited it; idempotent. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| propose: a proposal with one item per changed clip; agents may not accept; the editor applies it | KEEP | Uniquely exercises this named scenario at the stated seam: propose: a proposal with one item per changed clip; agents may not accept; the editor applies it. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| an edit while the job runs: CONFLICT (retryable), nothing applied by the job | KEEP | Uniquely exercises this named scenario at the stated seam: an edit while the job runs: CONFLICT (retryable), nothing applied by the job. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| autoGain: Essential Sound ▸ Auto gain on hands the named clips back in the rebalance transaction (one undo step) | KEEP | Uniquely exercises this named scenario at the stated seam: autoGain: Essential Sound ▸ Auto gain on hands the named clips back in the rebalance transaction (one undo step). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| explicit clip ids and a range; typed refusals before a job starts | KEEP | Uniquely exercises this named scenario at the stated seam: explicit clip ids and a range; typed refusals before a job starts. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-design-tail.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-design-tail.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P4 solo-tail documented decay laws and0.5–6s bounds. Production owner: `src/sound-design/bed.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Measurement truncates reverb/delay or ignores bus/master tail; saturation causes unbounded render. **3 Independent oracle:** Literal independent decay/pre-delay/feedback results; fixed bounds, disabled effects zero. **4 Stable seam:** Tail duration calculation consumed by solo measurement. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Room integration covers one studio reverb; these uniquely cover convolution, tempo/multitap/feedback/keyframed tails and cap. Expected values no longer invoke production constants/log formula.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| reverbs: decay + pre-delay; convolution: its impulse + pre-delay | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| delays and echoes: the delay times the repeats their feedback takes to fall 60 dB | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| disabled and tail-less effects add nothing | KEEP | Uniquely exercises this named scenario at the stated seam: disabled and tail-less effects add nothing. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| walks the clip, its track, the submixes it sends to and the Mix | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |

## `apps/engine/test/sound-dialogue-consistency.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-dialogue-consistency.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-R3 / WP6.3. Production owner: `src/sound-design/voice.ts, engine-cues.ts, plan.ts, bed.ts, check.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** A consumer treats pause as dialogue or misses VAD, mismatching all other user surfaces. **3 Independent oracle:** Real LJ spoken intervals and known pause, literal suppressed/kept cuts; cross-consumer interval equality. **4 Stable seam:** VAD through cue/plan/solver/check consumers. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Individual VAD and cue units cannot protect coherent reuse by all consumers after source/sequence mapping.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| every consumer reads the same ranges | KEEP | Uniquely exercises this named scenario at the stated seam: every consumer reads the same ranges. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-export-credits.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-export-credits.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: spec12 §2.11 / P6-E13. Production owner: `src/export/planner.ts and service.ts; sound credits`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Export credits inaudible clips/omits required licenses, serves traversal path, overwrites destination credits, or mux audio differs from offline mix. **3 Independent oracle:** Literal license/count/range and serialization bytes; independent output-vs-offline sample equality. **4 Stable seam:** Export plan warning data, sidecar bytes, served paths, decoded PCM. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Project credit units own text formatting; these own export-range filtering, authenticated file serving, destination collision handling and mux fidelity. Warning prose removed; CSV/TXT bytes remain format contracts.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| W_SOUND_CREDITS when a heard sound needs a credit and no sidecar is written; none with one or outside the range | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| W_SOUND_SHARE_ALIKE when a heard sound is CC BY-SA (spec 12 P6-E13), with a sidecar too; none outside its range | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| W_SOUND_CHECK_STALE (info) for a stale or failed stored Sound Check, none for a current pass | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| writes the credits of what the export plays (Markdown), serves it and lists it in the result | KEEP | Uniquely exercises this named scenario at the stated seam: writes the credits of what the export plays (Markdown), serves it and lists it in the result. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| TXT and CSV, only-attribution scope, range-restricted, next to a destination file without overwriting | KEEP | Uniquely exercises this named scenario at the stated seam: TXT and CSV, only-attribution scope, range-restricted, next to a destination file without overwriting. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| no file when no library sound is heard; the result says so and repeats the sound warnings | KEEP | Uniquely exercises this named scenario at the stated seam: no file when no library sound is heard; the result says so and repeats the sound warnings. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| SFX + SFX Room + stop-before automation + normalisation: the exported PCM equals renderMixdown | KEEP | Uniquely exercises this named scenario at the stated seam: SFX + SFX Room + stop-before automation + normalisation: the exported PCM equals renderMixdown. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-grammar-export.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-grammar-export.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E10 done-when. Production owner: `src/sound-design/plan.ts; audio graph/export`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Final export ignores run pitch/voice gain or Sound Check flags intentional one-voice repetition. **3 Independent oracle:** Independent frequency/level measurement: known1kHz pops climb0/1/2/3st; clicks equal; literal speed1. **4 Stable seam:** Plan→user accept→export PCM and Sound Check. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure planner cannot protect actual encoded audio/DSP; shared setup renders once for all assertions.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| the 4-card stagger climbs 0 / +1 / +2 / +3 semitones | KEEP | Uniquely exercises this named scenario at the stated seam: the 4-card stagger climbs 0 / +1 / +2 / +3 semitones. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the clicks share one sound and one level, measured | KEEP | Uniquely exercises this named scenario at the stated seam: the clicks share one sound and one level, measured. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| Sound Check does not call the one click voice a REPEAT (the same sound every time is the rule) | KEEP | Uniquely exercises this named scenario at the stated seam: Sound Check does not call the one click voice a REPEAT (the same sound every time is the rule). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the keys are takes of the typing run at speed 1, never the same take twice in a row | KEEP | Uniquely exercises this named scenario at the stated seam: the keys are takes of the typing run at speed 1, never the same take twice in a row. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-listen.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-listen.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E6/E7 / spec12 §4. Production owner: `src/sound-design/listen.ts and visual.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Agent listening misses/misattributes sound, chance level wrong, out-of-range event leak, misleading model availability. **3 Independent oracle:** Literal clip/cue attribution and event timing, brute-force chance oracle, ≥90% held-under-music detection. **4 Stable seam:** Listening HTTP report and spectrogram. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Event-DSP units cannot protect attribution to project clips/cues and audible contributions; check suite does not return listening transcript/spectrogram protocol.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| says the sounds were not named when tags are asked without the Describe-it search model (P6-E14) | KEEP | Uniquely exercises this named scenario at the stated seam: says the sounds were not named when tags are asked without the Describe-it search model (P6-E14). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| attributes every sound to its clip and cue, matches the cuts and reports chance levels | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| hears ≥ 90 % of placed sounds that sit 6 dB under the music | KEEP | Uniquely exercises this named scenario at the stated seam: hears ≥ 90 % of placed sounds that sit 6 dB under the music. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| refuses bad requests with typed errors | KEEP | Uniquely exercises this named scenario at the stated seam: refuses bad requests with typed errors. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the visual route draws the mix spectrogram when asked | KEEP | Uniquely exercises this named scenario at the stated seam: the visual route draws the mix spectrogram when asked. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| times a 10-minute sequence | DELETE | Fails independent-oracle/unique bar: only confirms requested duration; ordinary listening attribution/detection/range tests protect behavior. |

## `apps/engine/test/sound-long-exact.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-long-exact.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: WP6.5b long sound registration / P6-E9. Production owner: `src/sounds/service.ts and pad.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Long lossy file is skipped, seek offset loses sample alignment, registration nondeterministic, low space destroys source. **3 Independent oracle:** Independent125s Vorbis full decode/trim/cue sample positions; content-address identity and literal cap fallback. **4 Stable seam:** Registration HTTP managed file and decoded native export. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Short copy/take tests cannot protect >120s registration policy, streaming behavior and service fallback paths.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| a 125 s Ogg Vorbis sound: a PCM copy with lead silence, seek-exact at an In point, peak exactly on the frame | KEEP | Uniquely exercises this named scenario at the stated seam: a 125 s Ogg Vorbis sound: a PCM copy with lead silence, seek-exact at an In point, peak exactly on the frame. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| registration stays deterministic: the same sound again, or into another project, is the same copy | KEEP | Uniquely exercises this named scenario at the stated seam: registration stays deterministic: the same sound again, or into another project, is the same copy. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| over the byte cap or without the free disk space, the sound is registered as it is and the response says why | KEEP | Uniquely exercises this named scenario at the stated seam: over the byte cap or without the free disk space, the sound is registered as it is and the response says why. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-music-plan.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-music-plan.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E11 / WP-E7. Production owner: `src/sound-design/plan.ts; audio/beats.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Plan ignores opt-out, mistunes alternatives or stops music off the downbeat. **3 Independent oracle:** Generated C-major music/chime MIDI70, literal A4 tuning and bar6s; measured pitch and dip placement. **4 Stable seam:** Style plan/proposal, accepted document and decoded export. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Pure tuning/beat units do not protect style options and proposal commands through real mix output.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| with the style off the chime keeps its pitch and the stop its 0.25 s | KEEP | Uniquely exercises this named scenario at the stated seam: with the style off the chime keeps its pitch and the stop its 0.25 s. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the chime (MIDI 70) over C major plays an in-key note within ±1 st; the stop ramp ends on the downbeat | KEEP | Uniquely exercises this named scenario at the stated seam: the chime (MIDI 70) over C major plays an in-key note within ±1 st; the stop ramp ends on the downbeat. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-placement-export.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-placement-export.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P2-R4/R5 sample-accurate placement / spec12 §2.3. Production owner: `src/sounds/pad.ts; project place command; audio/decode.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Rounding/rate changes place a click off the exact frame. **3 Independent oracle:** Known source impulse sample and cue frame→sample arithmetic at supported rational FPS/rates. **4 Stable seam:** Placed command result then native exported PCM. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Project placement arithmetic tests cannot protect decode/resampling/mux sample alignment. FPS rows retain integer/fractional/drop-frame conversion regimes.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| %s fps: every click peak lands on its cue frame with 0 samples of error | KEEP | Uniquely exercises this named scenario at the stated seam: %s fps: every click peak lands on its cue frame with 0 samples of error. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a click 0.45 s into the sound lands on its cue frame at rates 0.98 … 1.02 (native export) | KEEP | Uniquely exercises this named scenario at the stated seam: a click 0.45 s into the sound lands on its cue frame at rates 0.98 … 1.02 (native export). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-profile.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-profile.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E8 reference profile / sharing/privacy policy. Production owner: `src/sound-design/profile.ts and check.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Profile leaks paths, compares itself without leave-one-out, misses wrong soundtrack, corrupt file crashes library, agent deletes without user. **3 Independent oracle:** Generated films have known cut/click/range statistics; literal license-free numeric profile; typed import/approval errors. **4 Stable seam:** Profiles/check HTTP, serialized profile and managed files. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Lower metric/scoring units cannot protect engine analysis, identity, import/export compatibility and policy. Generic report prose assertions removed.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| a profile of three generated films gives the expected ranges; a 1 s file is skipped | KEEP | Uniquely exercises this named scenario at the stated seam: a profile of three generated films gives the expected ranges; a 1 s file is skipped. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a matching sequence passes every row; a seeded mismatch is flagged by the right rows with timecodes | REWRITE | Retains the named independently specified behavior; removes incidental prose/private shape or copied formulas. Corrections read WAV bytes, TOO_SHORT uses HTTP422/code, request-source negatives move to HTTP, and retargeted cached delivery is verified on decoded audio. |
| a profile holding this very sequence scores it leave-one-out; a missing profile is a warning | KEEP | Uniquely exercises this named scenario at the stated seam: a profile holding this very sequence scores it leave-one-out; a missing profile is a warning. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| export → import round-trips; hostile files are refused; a damaged library file is moved aside | KEEP | Uniquely exercises this named scenario at the stated seam: export → import round-trips; hostile files are refused; a damaged library file is moved aside. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| rename; an agent’s delete asks the user (refused without an editor window); the editor deletes | KEEP | Uniquely exercises this named scenario at the stated seam: rename; an agent’s delete asks the user (refused without an editor window); the editor deletes. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-tail.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-tail.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: Historical Fix: SFX tail truncation / P6-E9. Production owner: `src/sounds/service.ts and pad.ts; sound-design/check.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Frame rounding clips tail, old copies are not repairable, INEXACT is silent, intentional user trim misdiagnosed. **3 Independent oracle:** Literal source-head/tail sample equality and exact cue frame; targeted old head-only copy. **4 Stable seam:** Registered bytes, typed findings/fixes, command apply and decoded export. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Copy unit tests do not exercise legacy project provenance, repair proposal/re-register/swap and actual playback after fix.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| %s fps: every click is rendered sample for sample to its −60 dB end | KEEP | Uniquely exercises this named scenario at the stated seam: %s fps: every click is rendered sample for sample to its −60 dB end. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| registration pads silence after a sound that ends abruptly, in front of one that starts at once | KEEP | Uniquely exercises this named scenario at the stated seam: registration pads silence after a sound that ends abruptly, in front of one that starts at once. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a head-only copy cut at its peak: OUT_OF_SYNC "cut" with a safe re-register + swap; applied, the sound plays whole | KEEP | Uniquely exercises this named scenario at the stated seam: a head-only copy cut at its peak: OUT_OF_SYNC "cut" with a safe re-register + swap; applied, the sound plays whole. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a tail cut after the peak: TRUNCATED; a sound gone from the library is re-planned on its own media instead | KEEP | Uniquely exercises this named scenario at the stated seam: a tail cut after the peak: TRUNCATED; a sound gone from the library is re-planned on its own media instead. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a sound registered as it is (its copy over the size cap): an INEXACT information; an exact copy has none | KEEP | Uniquely exercises this named scenario at the stated seam: a sound registered as it is (its copy over the size cap): an INEXACT information; an exact copy has none. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a clip shortened on purpose (room left in its media) is not reported | KEEP | Uniquely exercises this named scenario at the stated seam: a clip shortened on purpose (room left in its media) is not reported. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## `apps/engine/test/sound-takes-plan.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-takes-plan.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E9 takes first variation pool. Production owner: `src/sound-design/plan.ts; project variant selection`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Planner chooses whole multi-hit recording or cut take, ignores sibling alternatives. **3 Independent oracle:** Known clean sibling take IDs and excluded tail-cut recording; adjacent picks differ. **4 Stable seam:** Planner selected sounds and alternatives. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** Project pickVariant owns rotation itself; retained engine selection test owns offering/ranking clean takes. Direct pickVariant repeat test deleted.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| fills the typewriter keys with takes of the typing run, never the same take twice in a row | KEEP | Uniquely exercises this named scenario at the stated seam: fills the typewriter keys with takes of the typing run, never the same take twice in a row. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a long run of repeated cues cycles through every take before one comes back (pickVariant) | DELETE | Fails unique/layer-ownership bar: calls project pickVariant directly; project sound-takes and sound-design-place own full-cycle rotation and properties. |

## `apps/engine/test/sound-takes.test.ts`

Validation target: `pnpm exec vitest run apps/engine/test/sound-takes.test.ts --maxWorkers=2`. Deletion/consolidation risk is low where classified: the row identifies its surviving behavioral owner. Retained tests continue observing the named contract; changed assertions remove incidental coupling.

Contract/source: P6-E9 / compatibility before takes/materials. Production owner: `src/sounds/index-job.ts, service.ts and pad.ts`.

Six-bar evidence for surviving rows: **1 Independent contract:** the requirement above specifies the named behavior. **2 Real regression:** Bad segmentation, wrong take/provenance/range, dropped old index, stale take file leaks or exact placement wrong. **3 Independent oracle:** Hand-generated8-key/10-click recordings, literal range/padding/cut rejection; external decoded sample comparison. **4 Stable seam:** Take library HTTP, source range bytes, managed index and native export. **5 Refactor resistance:** assertions observe returned state/errors/bytes and named semantics rather than helper identity or internal call sequence (private counters/prose removed where changed). **6 Unique protection:** DSP segmentation tests cannot protect persistent indexing, response expansion, decoded source extraction, registration and applied take export.

| Original test name | Disposition | Scenario-specific reason / surviving owner |
| --- | --- | --- |
| a typing run gives 8 joined key presses, each judged as one key (the recording stays multi-hit) | KEEP | Uniquely exercises this named scenario at the stated seam: a typing run gives 8 joined key presses, each judged as one key (the recording stays multi-hit). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| ten clicks in digital silence give 10 clean takes; the 11th, cut by the end of the file, is recorded as cut | KEEP | Uniquely exercises this named scenario at the stated seam: ten clicks in digital silence give 10 clean takes; the 11th, cut by the end of the file, is recorded as cut. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| no takes for a type that is not single-hit, for one sample or for silence | KEEP | Uniquely exercises this named scenario at the stated seam: no takes for a type that is not single-hit, for one sample or for silence. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| entryTakes: single-hit types only (not other types, not untyped sounds), judged with singleHit off | KEEP | Uniquely exercises this named scenario at the stated seam: entryTakes: single-hit types only (not other types, not untyped sounds), judged with singleHit off. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| rows count a recording’s offered takes and leave them out; takes=true ranks the clean takes as rows | KEEP | Uniquely exercises this named scenario at the stated seam: rows count a recording’s offered takes and leave them out; takes=true ranks the clean takes as rows. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| material filter and its facet | KEEP | Uniquely exercises this named scenario at the stated seam: material filter and its facet. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a take id names a take entry: the recording’s licence and source, its own descriptors and judge | KEEP | Uniquely exercises this named scenario at the stated seam: a take id names a take entry: the recording’s licence and source, its own descriptors and judge. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| visual data of a take covers the take alone (cached by the index, recomputed when gone) | KEEP | Uniquely exercises this named scenario at the stated seam: visual data of a take covers the take alone (cached by the index, recomputed when gone). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| the audio of a take is exactly its range of the recording (WAV and FLAC sources) | KEEP | Uniquely exercises this named scenario at the stated seam: the audio of a take is exactly its range of the recording (WAV and FLAC sources). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| registers a copy of the take’s range with lead and trailing silence; provenance names the recording | KEEP | Uniquely exercises this named scenario at the stated seam: registers a copy of the take’s range with lead and trailing silence; provenance names the recording. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| refuses a cut take (never offered) and an unknown one | KEEP | Uniquely exercises this named scenario at the stated seam: refuses a cut take (never offered) and an unknown one. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a registered take placed on a cue peaks on the cue frame in the exported audio (measured, 4 rates) | KEEP | Uniquely exercises this named scenario at the stated seam: a registered take placed on a cue peaks on the cue frame in the exported audio (measured, 4 rates). Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| a full re-index gives the same snapshot and the same takes | KEEP | Uniquely exercises this named scenario at the stated seam: a full re-index gives the same snapshot and the same takes. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| an index written before takes and materials loads, asks for a re-index and gets them | KEEP | Uniquely exercises this named scenario at the stated seam: an index written before takes and materials loads, asks for a re-index and gets them. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |
| pruning removes take files the index no longer lists | KEEP | Uniquely exercises this named scenario at the stated seam: pruning removes take files the index no longer lists. Its oracle and distinct failure are listed above; narrower units do not own this integration/configuration/range. |

## Generated fuzz tests

These two named tests are generated by `describeFuzz`, in addition to the direct declarations above. Both KEEP decisions inherit AGENTS §0 and docs/testing §4: arbitrary incoming requests must either succeed with a valid public result or return a typed failure and terminate jobs; no internal exception, crash or hang. The independent oracle is the HTTP/status/error/result-schema contract, the seam is the HTTP request/job result, and neither statement names production helpers. This survives implementation refactors. Ordinary valid/refusal examples do not protect arbitrary structural mutations and truncations.

| Path | Runtime name | Disposition | Unique failure |
| --- | --- | --- | --- |
| `apps/engine/test/sound-design-cues.test.ts` | cue derivation request: never an untyped throw or a hang | KEEP | Mutated inline project envelope/options produce HTTP5xx or invalid successful cue response. |
| `apps/engine/test/sound-design-plan.test.ts` | sound design plan request: never an untyped throw or a hang | KEEP | Mutated stored-project plan request throws, starts a nonterminating job or returns an invalid result. |

## Removed work and infrastructure

- Managed-copy codec matrix: full decode comparisons, all six source formats, silence/padding, deterministic bytes and output-codec assertions survive. PCM seek windows shrink24→3 per row (126 fewer FFmpeg subprocess launches across six rows). The removed sample positions cover the same seek operation and expose no distinct local branch.
- One optional plan benchmark file and optional one-minute motion/ten-minute listening probes removed: none had performance budgets or unique behavior assertions. Historical measured results retain their baseline revision, with obsolete runnable commands removed.
- Mix-style plan fixture runs one plan/accept/remeasure workflow instead of three plan jobs. The deleted metadata test asserted incidental item/command layout and repeated generic seed determinism. The owner requires stop/build counts>0 and verifies applied bus/preset/records and final measured loudness.
- Motion/visual assertions are one workflow with locally scoped analysis/project IDs, removing the prior inter-test handoff.
- No fixture, snapshot, mock module, package dependency or runner config became orphaned: deleted benchmark used helpers also used by retained real-engine cases; remaining packages continue using all installed dependencies.
- Removed obsolete transport-global documentation as requested by the compositions/browser workstreams; production transport observables remain their own responsibility.

## Validation and timings

The authoritative root baseline completed with Node20.19.0:7,661 passed,248 skipped,2 unrelated failures (`engine/cache` removal as root and browser canvas capture). Wall2,111.47s (Vitest2,109.71s). No owned baseline test failed. File phases below come from that completed JSON, including hooks but excluding import overhead; same root command: `JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm test --maxWorkers=2`; Node20.19.0 / pnpm10.34.5; Linux x86_64, AMD EPYC-Genoa virtual CPU, 8 cores, 15 GiB RAM. Controlled Node20 before/after pairs and changed-target validation follow below; no full-suite speedup or CI reduction is inferred from those pairs.

| Original file | Baseline test phase | Disposition of cost |
| --- | ---: | --- |
| `audio-classify.test.ts` |46.825 s| Retain sole full ≥90% labelled acceptance; raw classifier API cases own malformed/rate boundaries and duplicate generated loops are removed below this layer. |
| `sound-grammar-export.test.ts` |2.681 s| Retain one real plan→accept→export setup for four independent audio/intentional-repetition contracts; pure planning cannot observe encoded pitch/level. |
| `music-picture.test.ts` |23.150 s| Retain generated music key/drop/remix/bar-end audio alignment and failure paths. |
| `sound-beds.test.ts` |22.553 s| Retain seamless loops, room-tone floor/handles, review policy and measured output; units cannot prove the assembled audio. |
| `sound-design-plan-mix.test.ts` |12.945 s| Consolidate three plan jobs into the single accepted-plan/remeasure owner. |
| `sound-copy-codec.test.ts` |13.646 s| Eliminate 126 equivalent FFmpeg seek launches; full source-byte/format/silence comparison remains. |
| `sound-design-measure-worker.test.ts` |2.253 s| Retain real thread parity and replace fake lifecycle scheduling with real Worker URL fixtures plus virtual advancement of documented deadlines. |

### Completed validation

All commands used Node20.19.0/pnpm10.34.5 and the unchanged runner configuration with `--maxWorkers=2`; oracle runs set `JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome`. The host is Linux x86_64, AMD EPYC-Genoa virtual CPU,8 cores/15GiB RAM. The root's authoritative baseline has no owned failures; its two unrelated failures are identified above.

- Before the owner fix, `pnpm exec vitest run apps/engine/test/sound-design-measure-worker.test.ts --maxWorkers=2 -t 'a bed render' --reporter=json --outputFile=/tmp/jasper-engine-sound-validation/worker-before-fix.json` failed because actual child failure resolved as silent PCM.
- Before the owner fix, `pnpm exec vitest run apps/engine/test/audio-decode.test.ts --maxWorkers=2 -t 'decoder failure' --reporter=json --outputFile=/tmp/jasper-engine-sound-validation/decode-before-fix.json` failed both actual-process cases, each returning0.
- After the fix, `pnpm exec vitest run apps/engine/test/audio-decode.test.ts apps/engine/test/sound-design-measure-worker.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-engine-sound-validation/worker-decode-fixed.json` passed15 tests.
- The changed-target command below ran17 files:99 passed,1 failed. The failed motion Sound Check test still referenced the preceding test's removed mutable `analysed` variable. Replacing it with the generated fixture's independently known landing frame60 removed that final cross-test dependency. The full affected motion file plus the real crashing-worker job workflow then passed10/10: `pnpm exec vitest run apps/engine/test/sound-design-motion.test.ts apps/engine/test/sound-design-measure-crash.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-engine-sound-validation/motion-crash.json`. Combined, every changed-target scenario and the additional job-crash workflow passed after correction; the initial failed command is retained as evidence, not reported green.
- Both regression probes failed the intended assertions: advancing managed-copy lead padding by1 sample broke exact decoded byte count; omitting local delivery correction returned sample0.5 instead of0.353973. Commands: `pnpm exec vitest run apps/engine/test/sound-copy-codec.test.ts --maxWorkers=2 -t 's16.wav' --reporter=json --outputFile=/tmp/jasper-engine-sound-mutations/copy-lead-one-sample-late.json`; `pnpm exec vitest run apps/engine/test/audio-deliver.test.ts --maxWorkers=2 -t 'attenuates the corrected audio' --reporter=json --outputFile=/tmp/jasper-engine-sound-mutations/corrections-omitted.json`. Both mutations were restored in `finally`; no mutant is committed.
- `pnpm --filter @jasper/engine typecheck` passed. Targeted `pnpm exec biome check` for all changed TypeScript files and `git diff --check` passed. The original commit's remaining changed files already passed targeted Biome checks.
- No new flaky outcomes occurred across the repeated worker/copy runs. Cancellation/timeout/start/idle cases use receipt barriers and controlled clocks, never real arbitrary sleeps. Root integration owns full lint/typecheck/test/build and opt-in suite accounting; this branch does not claim those global gates.

Exact changed-target command:

```sh
pnpm exec vitest run apps/engine/test/audio-decode.test.ts apps/engine/test/audio-deliver.test.ts apps/engine/test/audio-mix.test.ts apps/engine/test/sound-copy-codec.test.ts apps/engine/test/sound-design-cues.test.ts apps/engine/test/sound-design-grammar.test.ts apps/engine/test/sound-design-measure-worker.test.ts apps/engine/test/sound-design-motion.test.ts apps/engine/test/sound-design-plan-cue-sources.test.ts apps/engine/test/sound-design-plan-levels.test.ts apps/engine/test/sound-design-plan-mix.test.ts apps/engine/test/sound-design-plan.test.ts apps/engine/test/sound-design-tail.test.ts apps/engine/test/sound-export-credits.test.ts apps/engine/test/sound-listen.test.ts apps/engine/test/sound-profile.test.ts apps/engine/test/sound-takes-plan.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-engine-sound-validation/changed.json
```

### Controlled before/after performance

A fresh Vitest process ran `pnpm exec vitest run apps/engine/test/sound-copy-codec.test.ts apps/engine/test/sound-design-measure-worker.test.ts --maxWorkers=2 --reporter=json --outputFile=<label>.json` under `/usr/bin/time -v`, alternating baseline/final/baseline/final. Baseline restored those two test files and `measure-pool.ts` from8b4c8936, then restored final versions in `finally`; all other files, including the decoder failure fix, stayed identical in both variants. Same Node, runner, worker allocation and FFmpeg binaries; warm filesystem caches, fresh worker/esbuild bundles per invocation. A concurrent validator/render slot was active on the shared host; 1-minute load averages ranged1.54–1.86. This is a bounded, representative two-file comparison, not an isolated machine benchmark or whole-suite/CI measurement.

| Invocation | Baseline wall | Final wall | Copy file phase before/after | Worker file phase before/after |
| --- | ---: | ---: | --- | --- |
| Pair1 |33.893s|25.017s|14.640s /4.625s|2.166s /4.327s|
| Pair2 |34.386s|24.456s|14.727s /4.727s|2.180s /4.305s|
| Mean |34.139s|24.737s|14.684s /4.676s|2.173s /4.316s|

Measured mean saving:9.403s (**27.54%**) per two-file invocation. Total user+system CPU means49.665s→43.705s (5.960s lower); maximum resident memory varied617,856–656,748KiB across runs, with no memory improvement claimed. All four runs passed; baseline20 runtime tests, final15. The copied-codec scenarios preserve all six input codecs and exact full samples, silence, output codec, determinism and three representative seek positions while removing126 equivalent FFmpeg launches. Its file phase fell10.008s (~68.2%). The real Worker URL lifecycle coverage costs2.143s more than the former fake-worker version: this uniquely exercises actual loader/start/crash/transfer/failure/deadline/recovery paths without keeping unused production injection options. No arbitrary sleeps or retry masking were introduced.

Full-suite baseline wall is2,111.47s; final full-suite wall and CI impact belong to the root integration report and are not extrapolated here. The slowest remaining owned baseline files are the46.825s labelled classifier acceptance,23.150s music-picture workflow and22.553s assembled-bed contracts; their unique retained behavior is identified in their per-file audit. Four controlled pairs are insufficient to quantify global CI variance or cold-machine startup. Raw reports and resource measurements remain under `/tmp/jasper-engine-sound-measure/`.

### Scope totals

All188 original static declarations are dispositioned:143 KEEP,26 REWRITE,1 OPTIMIZE,10 CONSOLIDATE (4 owners/6 removed),8 DELETE. Two existing generated fuzz declarations remain KEEP. One genuinely new table declaration (2 runtime cases) protects the verified decoder-failure bug; it is separate from original dispositions. One original40-file test (`sound-design-plan-bench.test.ts`) is removed. Test LOC281 added/775 removed, net **−494** versus8b4c8936. No snapshots/dependencies/configuration/fixture assets became orphaned. Removed dead production seams are listed above; the bounded decoder change is the only changed production behavior. No remote actions are performed by this workstream.

Direct static declaration dispositions (the two generated fuzz tests above add two KEEP decisions): CONSOLIDATE (owner)=4, CONSOLIDATE (removed)=6, DELETE=8, KEEP=143, OPTIMIZE=1, REWRITE=26.


### Final resolver consolidation

A final caller census found that only the dedicated resolver unit supplied fake
module-base/startup arguments; the production singleton called the resolver with
its defaults. Remove those overrides and the now-unused environment-map argument,
internalize the helper/key, and delete that implementation-facing declaration.
The existing fallback owner exercises the actual production factory with both
`JASPER_SD_MEASURE_WORKER=off` and `0`, requiring literal silence-band values and
no worker-start failure warning. It closes the shared instance before/after each
configuration and restores the prior environment in `finally`. The separate real
rebalance crash workflow supplies an actual custom worker path, observes typed
job failures and verifies no revision/data change. These public outcomes survive
lookup refactors without asserting filenames, fake startup arrays or helper URLs.

Validation used Node20.19.0/pnpm10.34.5, two workers and required oracles:

- `env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm exec vitest run apps/engine/test/sound-design-measure-worker.test.ts apps/engine/test/sound-design-measure-crash.test.ts --maxWorkers=2`: **8/8 passed**, 20.36s runner; seven worker cases plus the real HTTP crash/revision workflow.
- Removing the actual off guard produced the intended failure: DSP still returned
  silence, but the public factory logged a failed attempt to start an `off` file.
  The surviving owner failed its empty-warning assertion, rather than a private
  resolver-shape assertion. Source was restored in `finally`; the selected
  fallback owner then passed. Reports: `/tmp/jasper-test-cleanup/measure-resolver/factory-off-{mutant,restored}.{log,json}`.
- `env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/engine typecheck`: **passed**, 31.71s using the repository's actual TypeScript compiler. The heap argument also replaces the host's unrelated compiler-interception preload for this command; no type checks are suppressed.
- A one-off real tsx process discovered the source worker, computed the literal
  seven-band silence result through it and emitted no fallback warnings (3.43s).
  This checked genuine dev startup while removing the synthetic arguments; no
  permanent child-process startup test or new production hook was added.

No whole-suite or scoped speedup is inferred from this follow-up. It removes one
named/runtime execution while moving its unique configuration assertions to an
existing behavioral owner. The extra explicit singleton/environment cleanup is
included in the final test LOC total above.
