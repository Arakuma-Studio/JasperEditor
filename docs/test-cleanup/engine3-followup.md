# Engine 3 independent-oracle follow-up

The [camera metric correction](camera-metric-correction.md) supersedes the endpoint-fit convention recorded for `camtrack-job.test.ts` below. It restores the original best-fit similarity metric and full truth-span denominator without production helpers.

This is a completed cleanup supplement to `engine3.md`. The ledger below was recorded before editing. The integration checkout's assigned test files matched the first-pass commit when inspected. No runtime or typecheck processes are launched here: root owns integrated validation because the shared host is overloaded.

## Before-edit decisions

Each numbered justification corresponds to the user's six retention requirements. Test names below identify individual declarations; the existing first-pass ledger remains authoritative for unchanged tests.

### REWRITE — `apps/engine/test/camtrack-job.test.ts` / `solves the camera of the plate: focal length, path and rotation against the truth`

- Failure: a camera exported with the wrong rotation convention, curved/nonuniform translation, wrong focal length, or missing tracked frames fails against the ray-cast fixture. The existing oracle imported the solver's own `logRot`, `rodrigues`, matrix multiplication and alignment helpers, allowing matched conversion errors to cancel.
- Independent contract: `packages/api/src/camtrack.ts` specifies world-to-camera axis-angle output; `scripts/fixtures/camtrack.mjs` independently creates 60 equally spaced positions on a straight dolly and camera matrices; `docs/wp-notes/three-d.md` specifies camera accuracy and end-to-end tracking evidence.
- Stronger remaining coverage: `camtrack-solve.test.ts` exercises the solver with synthetic feature tracks, but does not own real video decoding, feature extraction, process serialization, or HTTP publication. It cannot replace this lowest real-plate workflow.
- Six-item bar: (1) the independent API, fixture trajectory and accuracy requirement above specify the result; (2) wrong output places tracked 3D objects incorrectly; (3) independent quaternion vector rotation, fixture-authored matrices and the straight constant-speed trajectory can disagree with solver math; (4) the action and observations are the public solve/job HTTP APIs; (5) no solver function or private collaborator is inspected; (6) this is the lowest seam that includes actual video feature tracking and published camera output, while pure solve tests own solver-only cases.
- Callers/seams: matrix/rotation helpers have production solver callers and stay. `umeyama` and its `Similarity` type have no non-test callers; the only two callers were this test and `camtrack-solve.test.ts`. Engine1 removed its caller in commit `a062eb81` and explicitly delegated the now-unused source block's deletion here. Remove its obsolete comment and port-record description too; regenerate notices.
- Risk: low production risk (only dead alignment code removed); the independent numerical oracle can expose previously hidden rotation or tracking bugs. Keep existing 5% translation and 0.5-degree tolerances.
- Validation: `pnpm exec vitest run apps/engine/test/camtrack-job.test.ts apps/engine/test/camtrack-solve.test.ts --maxWorkers=1`; engine typecheck, full integrated gate. Deferred to root.

### REWRITE — `apps/engine/test/roto.test.ts` / `segments the base frame from a stroke and propagates both ways (IoU ≥ 0.95 on every frame)`

- Failure: corrupt/noninteroperable mask PNGs, wrong segmentation or incorrect propagation fail decoding or the independent ellipse IoU checks.
- Six-item bar: (1) `scripts/fixtures/roto.mjs` supplies known ellipse geometry and `docs/wp-notes/roto.md`'s segmentation accuracy contract; (2) users receive a broken or misplaced matte; (3) FFmpeg decodes the HTTP PNG independently of its production encoder and ellipse arithmetic does not use segmentation code; (4) POST segment, GET job and GET mask are the stable public seam; (5) encoding internals and propagation implementation can change without changing the assertions; (6) core segmentation tests do not cover media decoding, bidirectional job propagation and delivered interoperable PNGs together.
- Stronger coverage: no independent lower PNG interoperability test was found; core segmentation tests use arrays, not emitted PNGs. No duplicate replay is introduced.
- Callers/seams: `decodeGreyPng` remains required by `src/roto/service.ts` for processing stored frames; only its test import is removed.
- Risk: low; external FFmpeg is already a fixture/tooling prerequisite. Failure is explicit if the decoder is unavailable or rejects the PNG. Preserve existing IoU threshold.
- Validation: `pnpm exec vitest run apps/engine/test/roto.test.ts --maxWorkers=1`; engine typecheck and integrated gate, deferred to root.

### REWRITE — `apps/engine/test/roto.test.ts` / `computes a single frame for interactive previews`

- Failure: a wrong requested frame, invalid preview PNG, or unusable matte fails the frame range/count and independent IoU check.
- Six-item bar: (1) public `direction: frame` requests one frame with the fixture's known ellipse; (2) the interactive preview would display the wrong mask; (3) external FFmpeg and analytic ellipse geometry cannot share a production codec/segmenter mistake; (4) observes the segment/job/mask HTTP APIs; (5) no worker internals or cache implementation is asserted; (6) the bidirectional test does not exercise single-frame dispatch, and no lower test owns delivery of this requested frame.
- Stronger coverage/callers/risk/validation: as above; preserve the separate 0.93 preview IoU requirement.

### REWRITE — `apps/engine/test/roto.test.ts` / `installs the model through the catalogue installer and segments with it`

- Failure: installation fails to yield a usable real model, inference produces a wrong mask, or model output cannot be consumed as a PNG.
- Six-item bar: (1) the verified model installation API and known ellipse fixture independently specify usable segmentation; (2) an installed model that cannot produce the selected subject is a caller-visible failure; (3) decoding is external and target geometry is authored independently of model inference; (4) observes model installation and segment/mask HTTP APIs; (5) storage and inference internals can change; (6) classic-engine/core tests cannot cover verified installation followed by real model inference.
- Stronger coverage/callers/risk/validation: as above; retain the opt-in real-model prerequisite and 0.95 IoU threshold. Missing model assets remain an explicitly skipped specialized suite, not claimed success.

### DELETE — `apps/engine/test/speech-core.test.ts` / `word error rate (FilmCraft lib.rs test) > counts edits`

This coordinated deletion was implemented here and is counted once in engine1's authoritative original inventory. This row supplies cross-owner evidence, not an additional test declaration.

- Failure previously detected: changes to a test scoring helper's normalization/edit-distance implementation. There is no production or public API contract for this helper.
- Missing bar items: no caller-visible production failure (2), no public production seam (4), and only keeps a test-only source seam alive (6). The real-model tests compare independently authored speech transcripts with actual output; those behavioral tests remain.
- Caller census: `wordErrorRate` is used only by this helper test and `speech-model.e2e.test.ts`; `normalizeWord` has no external caller. Move WER to `apps/engine/test/speech-wer.ts`, make normalization private, and delete the helper self-test/import. Update the port record and regenerate notices to preserve attribution.
- Risk: no production behavior changes. Validation: source caller census, Biome and notices checks here; integrated speech tests/typecheck at root. Engine1 explicitly approved these paths; its independent FFT edits affect different hunks.

### REWRITE — `apps/engine/test/speech-model.e2e.test.ts` / `transcribes the media (English model): WER ≤ 4 %, word bounds within 60 ms on average`

- Failure: a real model emits inaccurate text, misaligned timestamps, wrong language, overlapping/out-of-range words or insufficient confidence. Delete the final attach-and-read-count round trip: it only compares inserted words with the same words and duplicates project transcript ownership.
- Six-item bar: (1) `docs/wp-notes/speech.md` specifies WER/timing acceptance and the public-domain LJ fixture supplies separately authored text and measured boundaries; (2) users see incorrect words or subtitle timing; (3) test-only WER and measured references are independent of speech decoding/alignment; (4) observes the public transcribe HTTP result; (5) model runner and alignment implementation can be replaced; (6) pure project transcript tests cannot cover actual English model inference, while they own transcript storage/mapping and remove the need for the extra round trip here.
- Callers/seams: `sequenceWords` retains many production callers; remove only this test import. WER support move described above.
- Risk: none to production; real model download/availability remains the existing specialized requirement. Validation: `SPEECH_E2E=1 pnpm exec vitest run apps/engine/test/speech-model.e2e.test.ts --maxWorkers=1`, deferred to root.

### REWRITE — `apps/engine/test/speech-model.e2e.test.ts` / `transcribes a sequence mix and gives the words back to the clip media in media time`

- Failure: mix transcription ignores a 14-second source trim or 2-second sequence placement, emits wrong words, or returns source-time timestamps. Remove production `distributeSequenceWords` from the oracle and compare raw sequence words with independently measured source utterance times shifted by -12 seconds. Remove the subsequent attach-and-compare-to-inserted-coverage round trip.
- Six-item bar: (1) the speech HTTP contract explicitly returns sequence-time words for a mix (`docs/wp-notes/speech.md` §engine), and the clip arrangement plus LJ measurements independently determines timing; (2) captions/transcript selections would point to the wrong sequence time; (3) literal source trim and placement arithmetic cannot share the distribution helper's mapping bug; (4) observes the transcribe-sequence HTTP output directly; (5) offline mixer, worker and client mapping refactors do not affect the contract; (6) `packages/project/test/speech.test.ts` owns distribution and attachment, while this test uniquely covers an actual trimmed/offset sequence mix through real inference.
- Callers/seams: distribution and attachment remain needed by production clients; only the extra test layer/import is removed. Rename the test to accurately identify its sequence-time contract.
- Risk: an independently exposed timestamp/mix regression must be fixed in its owner if observed, not hidden by remapping the result. Existing 8% WER and 150ms onset limits remain. Validation: same opt-in speech-model command above, deferred to root.

### REWRITE — `apps/engine/test/security-hardening.test.ts` / `a dev engine started without a token makes one, requires it, and tells local tools where it is`

- Failure: the advertised discovery file is missing, world-readable, or contains a token that cannot authenticate the engine. The existing path equality used the same `appdirPaths` as production and the token was read through that helper instead of through the advertised path.
- Six-item bar: (1) DEV-1 requires authenticated listening engines and private local credential discovery; config's stable runtime filename has a separate literal owner in `packages/config/test/config.test.ts`; (2) local tools cannot authenticate or credentials become readable to other users; (3) read the actual advertised file, assert literal mode 0600, and compare its token with the token already demonstrated to authenticate HTTP; (4) uses listening-engine HTTP, discovery and actual filesystem permissions; (5) filename/path-helper refactors do not invalidate discovery behavior; (6) pure config tests own naming, while this test alone joins discovery with the listening server and secure file contents.
- Callers/seams: `appdirPaths` is a production config API and remains used by other setup/security tests. Delete only its redundant expected-path equality here and read the token through `health.runtimeFile`.
- Risk: no production change; preserves all authentication and permission checks. Validation: `pnpm exec vitest run apps/engine/test/security-hardening.test.ts --maxWorkers=1`, engine typecheck and integrated gate, deferred to root.

## Leads rejected after inspecting ownership

- `FLICKS_PER_SECOND` in `sync-audio.test.ts` and `speech-model.e2e.test.ts` converts independently specified seconds to/from public time units. Literal frame lengths 23,520,000 at 30fps and 23,543,520 at 29.97fps in `packages/project/test/time.test.ts` already own the exact flick rate. Repeating that contract in every caller is unnecessary; retain the conversions.
- Cache key helpers address arranged cache artifacts; the independent expected behavior is whether the original file survives a real edit/purge, not a recomputed expected key. Media source/output comparisons in processing tests protect preservation or attenuation against actual input artifacts. They are valid metamorphic contracts.
- Fixture construction, model catalog setup and production schemas used to read actual outputs are not expected-value generators. They stay where subsequent independently specified values or externally visible state are asserted.

## Validation and result

Biome passed for all seven changed source/test/support TypeScript files; `git diff --check` and regenerated `pnpm notices --check` passed. Reviewed the staged diff. Integrate engine1 commit `a062eb81` before this cleanup so its remaining test caller is removed before the dead alignment function. No focused/runtime suite is claimed as run in this worktree. Root must validate the integrated changes, including the specialized camera, roto and speech prerequisites. The coordinated WER DELETE is counted in engine1's original inventory. The seven REWRITE follow-ups replace the corresponding original dispositions; they are not additional cases. No replacement test declarations are added.
