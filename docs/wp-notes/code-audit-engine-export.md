# Engine export and rendering code audit

## Scope and method

Reviewed the engine's `export`, `audio`, `layer-bake`, `remotion`, `previews`, `grading`, `color`,
`anime`, `mg`, and `mg-bundles` directories. The review covered duplicated implementation and
contracts, weak types and assertions, error handling, compatibility paths, unfinished implementations,
comments, and runtime dependency cycles. It used `AGENTS.md`, `CLAUDE.md`, the architecture's rendering
and licensing decisions, and the time, layer-bake, colour, preview, audio, and composition notes as
constraints. No restricted reference assets, new third-party source, or new assets were used.

The concrete type sources were `packages/project/src/render/snapshot.ts`,
`packages/project/src/schema/media.ts`, `packages/api/src/mg-bundles.ts`, and the installed
`@remotion/renderer` declarations (`open-browser.d.ts`, `browser/BrowserPage.d.ts`). The changes reuse
those contracts rather than reconstructing permissive lookalikes.

## Critical assessment and implemented recommendations

| Finding | Assessment | Change |
| --- | --- | --- |
| Four export worker pools repeated scheduling, shutdown, and failure handling | High confidence duplication with a correctness consequence: `FlowPool.close()` rejected active jobs but left queued promises unresolved. Divergent bookkeeping also made it harder to establish a common failure contract. | Added `ExportWorkerPool<Request, Response>` and moved blend, layer, warp, and flow scheduling into it. Requests/replies retain their own concrete types. Closing or losing a worker rejects outstanding requests, and synchronous structured-clone failures reject instead of stranding a task. Invalid counts are refused before allocation, counts are bounded by host parallelism and the existing buffering window, and a partial startup failure terminates workers already created. |
| Flow replies used optional output/error fields and defaulted missing output to `[]` | The protocol has two outcomes; an empty successful result is not an appropriate representation of an error. | Used a success/error union and removed the empty-output fallback, untyped request records, and request-ID bookkeeping unnecessary for one outstanding task per worker. |
| The text-measure HTTP callback could throw on malformed percent encoding | Confirmed process crash: the original callback exits Node with `URIError: URI malformed` for `%FF`. Synchronous file checks and unobserved stream errors had the same missing boundary. | Added one asynchronous request boundary, explicit error responses, asynchronous descriptor-based reads, and awaited stream completion. Missing files remain 404; malformed encoding is 400; other read failures are 500. Disconnected responses are closed. |
| Text measuring manually restated Chromium options and asserted browser input/result types | The renderer and API already define these types; the assertions bypassed them. | Reused `ChromiumOptions`, the text-measure API request/result, and result schema validation. The browser receives a serialized request and the bundle's response is validated at the edge. |
| Layer-bake source reads used `as never` and partial objects containing `unknown` | Render sources already form a union discriminated by their fields. The local declarations lost captions, shape, text animator, and template information. | Narrowed the existing union with property checks, used the actual `threeD` and `puppet` fields, and derived normalized clip and graded-effect hash material from project types. |
| Synthetic WAV records used a double assertion | The generated record already satisfies the real `MediaRecord` contract. | Removed the assertion, allowing changes in that contract to be checked at construction. |
| `audioOutputOf` accepted an unused `unknown` encoder argument | Its only caller passed the result of a conditional whose two branches were both `null`. | Removed the argument and conditional. |
| Bundle hashing silently skipped every `stat` error | Only a missing entry is a tolerated dangling link. Treating permission/I/O errors as absence can give an incomplete bundle a valid-looking content identity. | Tolerated `ENOENT` only; other errors propagate to the bundle job's existing failure handling. |
| Loudness normalization recovered from every rename error with a non-atomic copy | Permission errors were hidden, and a failed cross-device copy could overwrite a previously valid normalized file with partial bytes. | Isolated publication, restricted recovery to `EXDEV`, and reused `atomicCopyFile`. Fault-injection tests cover disk-full preservation, permission failure, and successful publication. |
| Service files contained section-divider comments and workstream narration | These duplicate method names or repository history rather than explaining behavior. | Removed obvious section dividers and stale narration in the changed render areas, while retaining pixel, cache, timing, protocol, and licensing constraints. |

The render kernels and their worker source strings remain the same algorithms. The shared scheduler
preserves shared-memory slots and transferable flow buffers. Its only cross-thread exception handler is
at `postMessage`, where Node can synchronously reject a value it cannot clone. Error/exit handlers and
close-time rejection are required by the no-hanging-jobs rule.

## Other areas and retained boundaries

- **Export planner and native extensions:** native/hybrid/Remotion choice remains capability driven.
  Extension state is intentionally opaque to the registry: each registered extension owns its prepared
  payload. Replacing this boundary with a large union of all implementations would couple the planner
  to colour, imports, retiming, graphics, and layer-bake implementations. The new worker scheduler,
  unlike this extensibility boundary, has concrete generic request/reply types.
- **Audio:** the offline mixer's decoding, true-peak limiting, loudness measurement, and cancellation
  handling serve distinct stages. They are not interchangeable duplicate algorithms. Normalization publication now shares the existing atomic-copy implementation and preserves rename errors except for the expected cross-device case.
- **Previews and layer caches:** a missing/deleted derived file is a cache miss, while cancellation and
  joining another export's in-flight bake require promise observation and cleanup. Removing these
  catches mechanically would create rejected background promises or break cache recovery.
- **Remotion and motion graphics:** browser capability probing, supported schema-version conversion,
  and source/bundle validation are real environment or external-input boundaries. LGPL binary
  selection and the explicit development-only bundled renderer are licensing decisions, not obsolete
  fallbacks. No encoder, filter, render-path eligibility, or development/packaging policy changed.
- **Colour and grading:** LUT/OCIO parsing and external process failures require validation and named
  errors. The same colour maths feeds preview and native LUT generation. Consolidating those with
  image geometry or general effect filters would blur the parity boundary.
- **Unknown values:** caught JavaScript errors, parsed JSON before validation, arbitrary composition
  properties/JSON Schema, and recursive scans of extensible animation data remain `unknown` where
  their values really are not known. None were replaced by unchecked assertions merely to reduce a
  search count. Existing project-envelope casts are a broader validation-boundary concern and are
  not presented as solved by this change.
- **Fallback and unfinished-code scan:** searches for `TODO`, `NOT_IMPLEMENTED`, `@deprecated`,
  fallback/legacy markers, and unsafe assertions distinguished real compatibility or cache behavior
  from the removed dead parameter and reply fallback. No disabled feature or named export blocker
  was removed to make the code appear complete.

A TypeScript-AST scan of 253 engine source files found no strongly connected components in static
relative runtime imports. Type-only imports were excluded. This is evidence for that graph, not a
claim about runtime-loaded third-party packages or every possible dynamic import.

## Verification

- Baseline text-measure callback reproduced in an isolated Node process: `%FF` caused exit 1 with an
  uncaught `URIError`; the request logic was taken from the original file, with only types and the
  unrelated HTML bootstrap removed.
- Baseline optical-flow lifecycle reproduced with the original pool and an inert flow kernel: only one of two requests settled after close.
- Worker regression covers closing a flow pool with one running and one queued request. Additional
  scheduling tests cover invalid counts, startup cleanup, worker termination, and structured-clone errors, alongside the pre-existing
  idle-worker failure and `tsx` worker-source tests.
- Text-measure tests exercise malformed encodings with `fast-check`, missing files/directories,
  traversal refusal, normal files, and continued serving after rejected requests.
- Bundle-hash tests distinguish a permission failure from a dangling link and retain readable files.
- `pnpm vitest run apps/engine/test/worker-pools.test.ts apps/engine/test/mg-text-measure.test.ts apps/engine/test/mg-bundle-hash.test.ts apps/engine/test/warp-unit.test.ts --maxWorkers=1`: 4 files, 15 tests passed before the subsequent worker-allocation guards.
- `pnpm vitest run apps/engine/test/worker-pools.test.ts apps/engine/test/layer-bake.test.ts --maxWorkers=1 -t 'DOM layers and static detection|native export worker|export worker scheduling'`: 2 files, 18 tests passed, 12 unrelated layer tests skipped by the name filter. This run includes the final worker-allocation/startup guards.
- `pnpm vitest run apps/engine/test/audio-publish.test.ts --maxWorkers=1`: 3 tests passed. A baseline fault-injection reproduction of the original rename/copy branch confirmed that `ENOSPC` after a partial copy left the old destination containing incomplete audio; the new test preserves the old destination and the complete scratch source.
- Biome passed for the changed source and regression files. `git diff --check`, `check-layers`, and `check-anime` passed.
- The first wider layer-bake run was stopped when its planner setup launched full media-fixture generation; it is not counted as a pass. The targeted layer/static run excludes that setup.
- The local engine typecheck was stopped at the integrator's request because simultaneous typechecks
  overloaded the shared host. The integration gate owns the final serialized typecheck and full gate.

## Integrated native export deadline investigation

At integration revision `7105a89b`, the full suite's 300-frame 1080p native-export test exceeded its
explicit 120-second completion deadline. The saved job journal records a successful native
`libopenh264` export in 90.345 seconds. An unchanged isolated rerun also exceeded 120 seconds; its
cleanup interrupted an encoding job at 42.65%, with no preceding render error. Host load averages
were approximately 74 initially and 107 during artifact checks. These are measured functional-test
results under contention, not a renderer performance benchmark or a passing test claim.

Independent checks of the completed full-suite artifact passed the original media assertions:
300 decoded frames, 1920×1080 H.264/yuv420p with BT.709 tags, stereo 48 kHz AAC lasting 10 seconds,
6,605,616 bytes, and an MP4 `ftyp` signature. The three sampled RGB pixels were `[0, 0, 254]`,
`[0, 214, 0]`, and `[253, 23, 0]`, satisfying the blue, green, and still-red assertions. The sequential
ffprobe/pixel checks took 61.061 seconds with one decoder thread. They did not independently exercise
the HTTP range response.

Only this test's completion deadline is now 600 seconds. Its render settings, frame count, pixel,
audio, event, and HTTP assertions are unchanged; no production timeout or performance budget changed.
The focused rerun of every original assertion is pending at this commit:
`pnpm exec vitest run apps/engine/test/export.test.ts -t 'exports a 2-track sequence to an mp4 whose frame count equals the range length' --maxWorkers=1 --reporter=verbose`.

## Limits

No preview/export pixel algorithm, format migration, shader, encoder, or user-facing editing behavior
was intentionally changed. Real GPU/OS coverage and the opt-in browser/FFmpeg suites are not claimed
by these unit checks. This assessment does not claim every remaining `unknown`, catch, or compatibility
branch is removable, nor that static review proves an entire render system free of defects.
