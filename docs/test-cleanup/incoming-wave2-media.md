# Incoming media and relink tests

This ledger audits `2d364873..69c96e3b`, integrated at `99d57175`, in four
engine test files, followed by three existing imports declarations at `572cf0ed`.
All **34 named declarations** were read with their production owners: **22 incoming
declarations and 12 existing declarations**. The root's unmodified incoming baseline
ran the initial 31 successfully; the three late imports owners also passed at the
earlier default checkpoint. Dispositions are **8 KEEP, 14 REWRITE, 5 OPTIMIZE,
5 CONSOLIDATE and 2 DELETE**; 27 declarations survive.
A consolidation decision includes a removed duplicate whose contract is named
below. Moving four HTTP tests preserves their declarations and independent contracts.

## Independent sources and stable boundaries

The following facts apply to every retained row in the corresponding file; the
individual rows supply the independently expected result, recognizable regression
and unique ownership required by the other three behavioral-bar requirements.

| File | Independent source and stable boundary | Refactor resistance |
| --- | --- | --- |
| `apps/engine/test/audio-crossfade.test.ts` | S10:TUI-052, AGENTS §4 and [the declared audio crossfade curves](../wp-notes/audio-crossfades.md#the-curves-packagesprojectsrcaudio-fadets). Observe actual native export jobs and decoded frequency contributions. The Custom Fade family is Jasper's documented design, with its Premiere mapping assumptions explicitly labelled in that note. | Output energy and literal spectrum checkpoints permit planner, mixer, decoder and automation refactors; no production fade evaluator supplies the expected gains. |
| `apps/engine/test/interchange.test.ts` | [Interchange](../wp-notes/interchange.md), security review DATA-3, and [Link Media's verification/results contracts](../wp-notes/link-media.md). Observe HTTP requests, real jobs, delivered files, registered media and applied project transactions. | Compare protocol codes, authored timeline data, actual sentinels/essence/files and semantic result fields. Do not count internal calls or pin incidental English messages. |
| `apps/engine/test/link-media.test.ts` | [Link Media search order, verification and bounds](../wp-notes/link-media.md#3-relink-others-automatically): the engine scan service accepts a validated request and returns the public `RelinkScanResult`. The actual filesystem is real; registration/probing and fingerprints are dependency inputs. | Observe selected paths, ambiguity, confirmation state and requested bounds. Tests tolerate different caches, worker counts and traversal implementations. They do not assert registration calls, helper array order or an invented runtime budget. |
| `apps/engine/test/playback-audio.test.ts` | [Playback audio](../wp-notes/wma-preview.md): registration/probe classification, per-stream 32-bit float WAV at the original rate/channel count, cache lifecycle, visible errors/cancellation, and export's original-source sample timeline. S04:CA-001/003/004 and MS-002 specify the storage/serving boundaries. | Observe HTTP metadata/raw WAV bytes, documented cache artifacts, job/status outcomes and independently decoded export PCM. No production WAV parser, FFmpeg argument inventory or private call counter is an oracle. Fault fixtures only isolate the external decoder's failure/abort; the real derivative/job/status/cleanup code produces the asserted outcomes. |

The six-bar justification for a retained row is thus its named independent source
and boundary above, its independent oracle/regression/unique owner below, and the
output-based refactor tolerance above. These are test-level decisions, rather than
coverage percentages. Lower parser/model/queue tests remain owners of their own
algorithms and do not substitute for the actual wiring/artifacts named here.

## Test-by-test decisions

Names below are the original declarations at `99d57175`; rewritten or moved
owners are identified explicitly. Existing declarations were re-read; their rows
supersede earlier audit rows only where changed here.

### `apps/engine/test/audio-crossfade.test.ts`

| Original test | Disposition | Independent oracle, detectable regression and unique protection |
| --- | --- | --- |
| exports a constant-power crossfade between two tones without a gap or a level bump > 0.5 dB | KEEP | A steady two-tone reference must retain energy within the specified 0.5 dB bound; the span contains cosine/sine contributions, rather than a cut. Real spectral/energy measurements catch dropped transitions, wrong outgoing/incoming gains and gaps. The constant-gain/Custom Fade rows require different curves; model-only gain tests cannot establish that the native export consumes the transition. |
| exports a constant-gain crossfade with half of each tone at the cut | KEEP | Each distinct tone has literal half-amplitude at the cut. A constant-power substitution fails; the energy-flat owner intentionally permits its different 0.707 midpoint and cannot supersede this specified curve. Real exported PCM is the boundary. |
| exports an off-centre asymmetrical Custom Fade on the curves it asks for (Premiere port) | REWRITE | Remove `fadeShapeGain` from expected results. Literal incoming/outgoing gains at five declared progress points follow the documented mathematical family, independently evaluated outside production. The asymmetric shape and five-frame cut offset must reach the native mixer, with the other tone absent outside the span. Reusing the incoming shape for the outgoing side, ignoring curvature, or centring the span fails. Fixed crossfades/model-only tests cannot prove this export wiring. |

### `apps/engine/test/interchange.test.ts`

| Original test | Disposition | Independent oracle, detectable regression and unique protection |
| --- | --- | --- |
| exports FCP7 XML as a job and imports it back by path with the media registered | KEEP | The authored clip intervals and marker at frame 12 survive an actual FCP7 file round trip; imported media have usable engine locators. Wrong engine file handling, registration or transaction construction fails independently of lower XML parsing/format conversion. Pure round-trip properties do not exercise these jobs/files. |
| never overwrites an existing file at the destination (security review DATA-3) | KEEP | An existing literal sentinel remains byte-identical; existing side folders force free destination stems `(3)` and `(4)`. Clobbering either user file or using a colliding side-folder stem fails. Format correctness does not protect this filesystem/data-loss boundary. |
| AAF with embedded audio: the essence is decoded by ffmpeg and comes back as WAV files | KEEP | Real delivered AAF has the independent CFB signature and round-trips nonzero 48 kHz/16-bit WAV essence into registered media. An apparently successful job with missing, silent or unregistered embedded audio fails. The pure AAF parser cannot prove actual extraction/FFmpeg/service wiring. |
| OMF with separate AIFF files broken out to mono, written next to the document | KEEP | Actual adjacent audio files are mono/24-bit and import without missing media. Ignoring breakout/bit-depth settings or writing unusable file references fails. Embedded AAF and stereo WAV owners cannot supersede this separate-essence OMF contract. |
| per-track EDLs and the pre-render plan | KEEP | The authored one-video-track document yields its public `_V1.edl` artifact, and a simple no-prerender input gives the declared unsupported/empty plan. Wrong format routing/artifact naming or an erroneous prerender requirement fails. Other export formats do not invoke EDL routing. |
| imports a document whose media is elsewhere as offline placeholders, then links them (one and by folder) | REWRITE | Preserve the actual XML import → missing media → single-file confirmation → folder scan → transaction/invariants workflow. The job now returns literal summary counts, while its full result is fetched through the project-scoped route. File names and placeholder semantics are authored expectations, not a copied planner result. The new anchor case does not test initial missing-media import or applying its full result to a real document. |
| refuses garbage with a named error | REWRITE | Unknown binary bytes require `415 / INTERCHANGE_UNSUPPORTED`; a recognized EDL name with no events requires `422 / INTERCHANGE_PARSE`. Replace the old any-`INTERCHANGE_*` match so a different domain failure cannot count as success. Lower parsers do not establish HTTP status/code mapping. |

### `apps/engine/test/link-media.test.ts`

The four HTTP cases below now live in `interchange.test.ts`, using that file's
existing real server and immutable registered-media inputs. Every request creates
its own placeholder; no test consumes another test's result or mutable document.
The direct scan file imports `temp.ts`, avoiding full engine initialization.

| Original test | Disposition | Independent oracle, detectable regression and unique protection |
| --- | --- | --- |
| one located Windows file relinks the others by the folder mapping, relative path, same folder and search | REWRITE | One real tree now includes an outside-search-root relative audio file, moved same-folder/deeper files, two ambiguous candidates and a genuinely missing file. Literal ID/path/step outputs catch wrong mapping/precedence/selection. Selected size/media-start criteria must accept unknown placeholder metadata despite nonzero candidate metadata. Pure planner tests do not walk/register a real tree; the HTTP anchor test does not exercise all these fallback/ambiguity conditions. |
| the project-relative path finds media whose absolute path does not map | CONSOLIDATE | Its unique outside-search-root relative witness is in the first scan. Keeping this separate tree/request would duplicate the same service/path contract. The surviving owner still cannot find that voice file through mapping or the search root, so losing relative resolution fails. |
| verifies the match properties: a wrong duration or kind is rejected, File Extension off finds a transcode | KEEP | Literal found/not-found/needs-confirm results distinguish too-short files, guessed stream-kind differences, explicit confirmation and a same-stem transcode when extension matching is disabled. A blanket match/blanket rejection fails. The mapping owner uses valid candidates; direct helper tests are weaker than these actual selection outcomes. |
| a moved and renamed real asset is found by its bytes under the searched folder | REWRITE | Survives as “selects a renamed asset by fingerprint over a same-size different candidate”. The original sole candidate could still pass if fingerprint comparison disappeared. A wrong same-size file is now encountered first; the literal selected correct path, fingerprint match and fallback step require discrimination. The dependency supplies fingerprints, while the real scan must select correctly; this is not a test of the fingerprint algorithm itself. Name matching cannot find the renamed asset. |
| scales to thousands of offline media: one registration per linked file, linear time | DELETE | Fails independent performance-budget/refactor-resistance/unique-protection requirements: neither a single 3,000-item run nor a 60 s limit establishes linear complexity, and registration call count pins its cache strategy. The small real-tree scan covers mapping/fallback/selection; requested file/time bounds remain below, and model/relink command owners cover the actual documented asset bound. No CI budget was moved or weakened. |
| the folder walk honours its file cap and time budget; cancelling stops the job | OPTIMIZE | Requested `maxFiles=10` must return truncated/10; controlled elapsed time exceeds the requested one-second budget before all files; an aborted signal must reject specifically as `JOB_CANCELLED`. Twelve files suffice instead of fifty. A scoped `Date.now` spy replaces an otherwise unused production clock injection. None of the successful-selection cases protects resource termination or typed cancellation. |
| anchors whose new path is not on this computer are ignored; foreign last known paths are never opened | DELETE | The nonexistent foreign paths provide no witness of an attempted open; an empty registration list can pass after an unrelated filesystem failure. Unsupported foreign anchors are refused before the service by the real HTTP entry point below; pure cross-platform path tests own classification. Do not retain the private-call illusion. |
| legacy "name" means the whole file name unless the extension is ignored | CONSOLIDATE | The real match-property scan already rejects a mismatched extension for legacy `name` and accepts a same-stem transcode when extension matching is disabled. Remove helper-array order/dedup assertions without a distinct product contract. The public selection owner catches dropping implicit extension matching. |
| lists each failed property; properties the asset does not record are not compared | CONSOLIDATE | The real HTTP verification case owns literal failed-property names; the first scan now selects `size`/`mediaStart` with unknown placeholder values and recorded candidate values, so erroneously comparing them loses the files. Remove the weaker direct helper case and its duplicate fixture. |
| relinking to a path of another computer is refused with a named error | OPTIMIZE | Moved to the existing HTTP fixture. Foreign and relative paths plus malformed asset bodies require `VALIDATION_FAILED / 400`; the foreign-path error is nonretryable. Real positive relinks coexist in the file, so an unavailable route cannot supply the expected result. Removing host validation or request parsing fails; no private “register was not called” assertion substitutes for the response. |
| a located file is verified against the selected match properties | OPTIMIZE | Moved to the existing HTTP fixture. A `.mov` placeholder requiring 600 seconds and a real short `.mp4` must report exactly `extension` and `duration`, and require confirmation. A route ignoring selected criteria fails. The direct scan owner checks rejection/selection, rather than the caller-facing single-file response and confirmation payload. |
| relink-scan validates its body, folders and anchors; the result route checks the job | OPTIMIZE | Moved to the existing HTTP fixture. Empty assets/unknown criteria/foreign anchor require `VALIDATION_FAILED`, a nonexistent folder `NOT_FOUND`, and an unknown result job `JOB_NOT_FOUND`, with their declared statuses. Namespaced status checks prevent unrelated errors from passing. Successful jobs do not protect these body/path/job entry boundaries. |
| locate one Windows-path placeholder, the job relinks the others; the result is per project | OPTIMIZE | Moved to the existing HTTP fixture. A real two-asset anchored job returns literal summary/full-result identities; looking it up under another project is `JOB_NOT_FOUND`. Its returned media key resolves to online media, rather than merely being truthy. This owns actual runner/registration/serialized-result/project-scope wiring, which the direct scan and generic job tests cannot establish. |

### `apps/engine/test/playback-audio.test.ts`

| Original test | Disposition | Independent oracle, detectable regression and unique protection |
| --- | --- | --- |
| WMA and an AC-3 video are not browser-decodable; WAV / AAC media need no playback audio | REWRITE | Move WMA/AC-3 classification into their actual artifact owners below. The surviving declaration registers actual WAV/AAC media and requests playback audio through HTTP: both remain `none` with no jobs. Incorrect applicability/route wiring fails; the model codec table cannot prove real probe/registration/request behavior. |
| of a WMA: queued at registration, a float WAV that is FFmpeg’s decode of the original sample for sample | REWRITE | Real WMA probe metadata and auto-generated HTTP header/stream are checked. An independent RIFF wire check requires 32-bit IEEE float; raw PCM bytes must equal a separate full FFmpeg decode of the original, with literal 44.1 kHz/stereo and independently counted frames. HTTP range/absent-stream behavior remains. Resampling, clipping, changed samples, invalid format or unusable URLs fail. This is the actual preview artifact owner; no production WAV parser supplies its oracle. |
| of an AC-3 video: the 5.1 stream at its own rate and channel count, equal to FFmpeg’s decode | REWRITE | Real video retains browser-decodable picture and gets actual stream-index-1, six-channel/48 kHz float WAV; raw HTTP samples and frame count match independent full original decode. Treating container stream index as audio ordinal, downmixing or using WMA's rate fails. The stereo audio-only owner cannot cover this mixed-video/multichannel wiring. |
| is reused: asking again completes at once, and a copy of the same file shares it | REWRITE | The real HTTP derivative request succeeds and the documented cached artifact's mtime remains unchanged through explicit re-request and same-content registration. Rebuilding instead of reusing the existing artifact fails independently of FFmpeg's private call shape. Generic media-key dedupe does not establish that this playback directory/header avoids regeneration. Remove its FFmpeg-run counter. |
| fails visibly without leaving partial files, and a retry makes it | REWRITE | A controlled decoder failure flows through the real derivative/job/status/cleanup owner: failed state with visible error, no published or partial files, no automatic retry on status, then successful explicit HTTP retry after restoring the decoder. The error message's exact English substring is incidental and removed. Generic process/queue tests do not prove this derivative's failure retention/applicability/retry wiring. |
| is cancellable: the job ends cancelled, FFmpeg is stopped, nothing is left behind, it is not "failed" | REWRITE | The controlled outstanding decoder synchronizes cancellation without sleeps. Actual job state is cancelled; published/partial files are absent and status is not falsely failed. Remove the mock's own `aborted` flag assertion: generic process owners already establish child killing. Survives as “cancelling leaves no published or partial files and no failed derivative”; its unique promise is actual directory cleanup and visible state. |
| the sample-exact clip decode of the original equals the playback audio from the In point | CONSOLIDATE | The real native export below owns the same In-point sample timeline plus actual automatic decoder selection/mixer/export wiring, fixed output length and original-source independence. Remove the direct `clipDecodeArgs(...sampleExact:true)`/argv-shape scenario; manually enabling the flag does not protect actual codec selection. Acceptance of this consolidation requires the real sample-selection mutation to fail the surviving export oracle. |
| a native export decodes the WMA itself and lines up with the preview’s samples (lag 0, residual ≤ −50 dB) | REWRITE | Author a 3.5 s end and trim its In by 0.5 s; independently expect 336,000 interleaved output samples. Save the preview WAV reference and remove its actual cache artifacts before export: export must still decode the original. Compare real output to an independent full-source WAV resampling, requiring zero best-fit lag, residual below −50 dB and noninverted/audible gain. Wrong input seeking, using an evicted playback copy, truncation or shifted audio fails. No argv inventory or production resampler helper computes the expected result. |

## Supporting infrastructure

- Make `readWavInfo` private: its only external consumer was the deleted test
  self-oracle; the actual derivative calls it in the same module. The HTTP/raw-WAV
  owner now detects disagreement with independent wire/FFmpeg observations.
- Remove `RelinkScanDeps.now`: the only supplied callback was the bounded-walk
  test. Production still captures `Date.now`; the test scopes/restores that clock.
- Remove the fake registration call inventory, the unused wrapper result and
  unused placeholder options/nullable-path branches.
- Reuse the existing interchange server and registered input metadata for four
  HTTP cases; direct scans need only their real temporary tree. Requests/results
  are independent, and the shared document is read only by this input factory.
- Route the touched crossfade temporary directory through the existing owned
  cleanup helper; no new global cleanup or directory sweep is introduced.
- Keep `scripts/fixtures/legacy-audio.mjs`: both actual format owners need its
  original generated WMA/AC-3 files. No fixture, snapshot, dependency or runner
  configuration became unused, and no generated media is committed.

## Validation and performance

Root incoming baseline: all 31 cases in these files passed at `99d57175`.
Its four file spans were crossfade 2.575 s, interchange 1.251 s, Link Media
1.460 s, playback audio 1.589 s. These are JSON file spans under the larger
60-file run, not isolated process startup or comparable wall-time savings.

Final targeted command: **25/25 passed in four files**, Vitest 23.96 s and GNU
command wall 25.11 s. The first attempt had two fixture mistakes: the moved test
needed its `basename` import, and this worktree's symlinked generated fixtures
canonicalized to the root checkout while an existing XML rewrite expected its own
path. The missing import was fixed and the ignored fixtures were hard-linked into
this worktree. Neither the existing rewrite nor production path behavior changed.
The first failed attempt is retained as `media-target.*`; the passing result is
`media-target-restored.*`.

Five real production mutations each failed exactly its intended surviving case:

| Mutation | Observed failure |
| --- | --- |
| Force symmetric Custom Fade output | Actual outgoing gain 0.991358 vs independent 0.859207 (unchanged 0.05 bound) |
| Disable automatic sample-exact decode selection | Actual native WMA export's best lag −11 samples vs required zero |
| Skip fingerprint comparison | Same-size wrong file selected instead of the independently named correct path |
| Ignore the requested walk deadline | `timedOut=false` vs required true |
| Rebuild an existing cached artifact | Its actual filesystem mtime changed |

Every mutation was byte-restored in `finally`; source hashes and exact commands
are in `media-mutations.json`. Both subsequent final-source profile repetitions
passed 25/25; the end-of-profile restored sources were verified against their
last passing SHA-256 values. The original A versions passed 31/31 twice. No
expected mutation failure was accepted on an infrastructure error.

All commands used Node 20.19.0/pnpm 10.34.5, required oracles, Linux x64 on the
root report's eight-vCPU EPYC-Genoa machine, with the same already-generated
fixtures and pinned LGPL FFmpeg 7.1.5 engine/PCM oracle. The crossfade test's
existing bare FFmpeg generation/measurement uses the same system FFmpeg 6.1.1
in both versions. Another authorized web workstream used the other validation
slot; one-minute load averages were approximately 3.0–3.6. This is a scoped
shared-host ABBA observation, not isolated end-to-end CI evidence. File/cache
contents were already present; filesystem/compiler caches were not flushed.

| Run | Source | Command wall | Child user+system CPU | Cumulative test/setup work | Largest process RSS |
| --- | --- | ---: | ---: | ---: | ---: |
| A1 | incoming baseline | 26.746 s | 54.16 s | 10.37 s | 443,120 KiB |
| B1 | cleaned | 28.474 s | 53.14 s | 8.70 s | 435,952 KiB |
| B2 | cleaned | 27.127 s | 53.69 s | 8.68 s | 552,184 KiB |
| A2 | incoming baseline | 27.010 s | 56.49 s | 9.95 s | 431,996 KiB |

Mean wall **26.878→27.801 s**, an observed **0.922 s / 3.43% increase**: there is
**no measured wall-time improvement** for this subset. Import/transform variation
outweighed lower test/setup work. Mean child CPU **55.325→53.415 s** (−1.910 s /
−3.45%), and cumulative test/setup **10.16→8.69 s** (−1.47 s / −14.47%). These
metrics overlap and must not be added. Single-process RSS was variable and did
not show a reduction. Do not extrapolate a CI or memory improvement. Removing an
engine import/server and the 3,000-file setup reduces actual work; the regression
and maintenance improvements are retained without claiming a faster wall sample.

The actual engine TypeScript check passed in 32.91 s with a four-GiB heap
(maximum single-process RSS 2,625,308 KiB). Biome checked all six changed TS
files without suppression; `git diff --check` passed. No native/GL code or
shader changed in this workstream. Root owns the integrated full gate/builds.

Exact validation commands (reporter/output destinations omitted only in the
short mutation equivalents; the JSON evidence contains the full argv):

```sh
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm exec vitest run apps/engine/test/audio-crossfade.test.ts \
  apps/engine/test/interchange.test.ts apps/engine/test/link-media.test.ts \
  apps/engine/test/playback-audio.test.ts --maxWorkers=2 \
  --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/incoming-wave2/media-target-restored.json
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/engine typecheck
pnpm exec biome check apps/engine/src/derivatives/service.ts \
  apps/engine/src/interchange/relink.ts apps/engine/test/audio-crossfade.test.ts \
  apps/engine/test/interchange.test.ts apps/engine/test/link-media.test.ts \
  apps/engine/test/playback-audio.test.ts
```

The same four-file command ran A/B/B/A with only these six task files switched
between baseline `99d57175` and final bytes; it always used `--maxWorkers=2`.
Mutation runs selected, respectively, the Custom Fade case, native WMA case,
fingerprint case, requested-bounds case and cached-reuse case with `-t` under
the same environment. Evidence and orchestration are under
`/tmp/jasper-test-cleanup/incoming-wave2/media-{profile,mutations}*`.

For the initial four-file wave, net change versus the incoming source is **−89
test/support LOC** and **−1 production LOC**, excluding this required audit ledger.
The late imports rewrite below removes another three test LOC: cumulative media
cleanup **−92 test/support LOC / −1 production LOC**. No production algorithm,
schema, dependency, media recipe or runtime default changed.


## Late imports archive and display owners

Re-audited three existing declarations in `apps/engine/test/imports.test.ts` at
`572cf0ed`; these add no new declarations. Their original census keys were appended
to the same media disposition manifest. The unrelated HEIF probe case remains
unchanged: the failed system-6 full run had a newly generated HEIF that its oracle
could not read, while the actual pinned LGPL 7.1.5 probe succeeds. That run is not
a passing gate or a comparable final performance sample.

| Original declaration | Disposition | All six behavioral-bar requirements |
| --- | --- | --- |
| round-trips stored archives and reads deflated entries | REWRITE | Independent contract: [PKWARE APPNOTE 6.3.10 §§4.3.7/12/16](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT), dotLottie interchange and the documented caller-supplied allocation cap. Detectable bugs: invalid stored-file framing/body/path/checksum, failed method-8 decoding or ignored read limit. Independent oracles: literal wire signatures/method/name/body, Node's native CRC32 and the existing separately generated deflated dotLottie manifest's literal `spin` animation. Stable seam: archive bytes and public ZIP helper results/errors used by Lottie loading/export and sound packs. Refactor resistance: inspect standard fields using their wire lengths/offsets; allow different extra fields/comments, do not invoke the writer's own reader as its oracle or assert private collaborators. Unique protection: fuzz wrappers establish typed failure/termination, not correct decoded payload/CRC or the caller's smaller cap; HTTP Lottie metadata does not establish generic archive/limit behavior. Remove Python, temporary ZIP generation and the conditional success-only branch. |
| decodes EXR with the sRGB transfer and Radiance HDR through zscale | CONSOLIDATE | Actual EXR transfer and deep-source precision now belong to the public display owner below. A private `-apply_trc`/filter-array/boolean inventory cannot prove rendered pixels and rejects behavior-preserving changes to decode strategy. Model interpretation owners retain field-order behavior; TIFF16 in the real display case protects its distinct deep-source heuristic. Drop the Radiance filter-name-only pin without claiming a decoded Radiance fixture or adding unsupported codec behavior. All production helpers have real variants/sequence callers and remain. |
| makes display pictures of stills a browser cannot decode | REWRITE | Independent contract: [imports work note](../wp-notes/imports.md#3-engine-appsenginesrcimports-routes-routesimportsts) and `MediaVariantRequest/Status` promise an sRGB display picture, with 16-bit output for deep sources. Independent [sRGB transfer math](https://www.w3.org/TR/css-color-4/#color-conversion-code) maps scene-linear .25 to approximately .5371, about 137/255. Authored 2×2 grays .25… .2506 must retain a nonzero difference smaller than one 8-bit code in actual RGB48 samples; a fake 16-bit header after 8-bit quantization fails. Stable seam: HTTP variant request, its actual job, served PNG bytes and independent FFmpeg RGB48 decoding. Refactor resistance: no CLI flag shape, private variant-service cast or production transfer helper supplies expectations. Recognizable bugs: omitted/double TRC, lost precision, wrong bit depth, failed job or invalid served picture. Unique protection: the former helper pins/codec-only owner could not distinguish wrong gamma or 8-bit-then-upcast output; real TIFF16 also retains the previous non-EXR deep-metadata case. |

The test file has net **−3 LOC**. Removed one redundant declaration; replaced its
metadata/flag probes with one existing behavioral owner. No production source,
helper export, dependency, fixture recipe, configured timeout or HEIF assertion
changes. `decoderArgs`, `sourceFilters` and `isDeep` remain because their non-test
variants/sequence consumers are real.

Validation with normal pinned LGPL 7.1.5 binaries: **9/9 passed twice**, including
the unchanged HEIF case, actual native alpha export and strengthened display
owner. Vitest durations were 24.23/24.54 s, GNU command wall 25.28/25.65 s.
These repetitions check stability; there is no before/after speed claim because
the intervening failed full run used a different oracle/fixture inventory.

Four real production mutations failed exactly the intended retained declaration:

| Mutation | Independent assertion that failed |
| --- | --- |
| Write zero ZIP checksums | Native CRC32 expected 3,421,780,262; actual central-directory checksum 0 |
| Ignore the caller's smaller read limit | Valid deflated entry was returned instead of the required typed refusal |
| Omit the EXR transfer | Actual decoded display grays failed the independently expected 137±1 sRGB code |
| Quantize to eight bits before upcasting the PNG | Its PNG still declares 16 bits and coarse gray remains plausible, but actual RGB48 span 261 exceeds the one-8-bit-code bound 257 |

All four production files/edits were restored in `finally`; current byte hashes
match their original SHA-256 values. The complete restored nine-case file passed
after the mutations. The real engine TypeScript check passed in 32.97 s with
`NODE_OPTIONS=--max-old-space-size=4096`; Biome checked the changed test and
`git diff --check` passed. No test retry, skip, tolerance widening or production
change is part of this patch.

```sh
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome \
  pnpm exec vitest run apps/engine/test/imports.test.ts --maxWorkers=2 \
  --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/imports-probe-diagnosis/candidate-restored.json
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/engine typecheck
pnpm exec biome check apps/engine/test/imports.test.ts
```

Exact selected mutation argv, failure messages, source hashes and the two
independent HEIF probe outputs are retained under
`/tmp/jasper-test-cleanup/imports-probe-diagnosis/`. Root still owns the final
integrated full gate; this passing file is not reported as that whole-suite gate.
