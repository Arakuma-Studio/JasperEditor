# Project model audit: sound ranking through vector/voice analysis

Baseline: `eb28696cfe6d0fccde45b6bbf3e216fe9226fe25`. Scope: the 60 files assigned to `project_4`, containing 651 test declarations/templates. Parameterized templates remain grouped; the two transition case tables list their individual names in the ledger. [The disposition ledger](project_4.json) records each baseline name/path, contract source, oracle, observed seam, refactor resistance, remaining owner and validation command.

Disposition totals: 624 KEEP, 8 DELETE, 2 REWRITE, 15 OPTIMIZE, 2 surviving CONSOLIDATE owners. Ten test files changed, with a net reduction of 131 test lines; no production code, dependencies, configuration, standalone fixtures, snapshots or public exports were removed.

## Decisions

- Delete the declaration-level sound alignment check; `sound-insert.test.ts` owns the literal `defaultAlignForTypes` behavior.
- Delete the JSON property-kind assertion; the surviving object/union `param.set` acceptance, rejection and retained-value test detects the historical string-mapping regression through the command API.
- Delete the template-media property whose recursive reference walker copies the implementation. Literal nested-reference, cycle/depth, command, repair, persistence and clipboard cases remain.
- Delete the direct `rewriteParamMedia` collaborator check; force-delete, repair/load and cross-project clipboard tests own the observable remapping contracts. The production helper remains used by those paths.
- Delete the materials subset/self-determinism property, which accepts an always-empty implementation. Literal material inference, ordering/deduplication and ambiguity vectors remain.
- Delete the transition test asserting omission of an optional `tracks` field. Actual planar/point data, motion mapping and reverse-side behavior remain.
- Delete the reversed-text-preset probe: `clip.setSpeed` checks `kindCapabilities.supportsSpeed`, warns `W_VALUE_CLAMPED` for text, and leaves `speed.reverse` false. A direction-sign mutation survived both the original probe and an attempted stronger rewrite because their fixtures stayed forward-playing. Ordinary preset timing/evaluation retains the supported behavior.
- Delete duplicate v7/v8 fixture loading. `schema-history.test.ts` already loads every shipped fixture and checks each migration's complete data diff. Both the v8 and v9 fixtures contain the same Mirror→Crop stack, so those step oracles preserve its ordering through later migrations. Confirmed those owners survive in `project_3` commit `da4002a5`.
- Consolidate the v9 template-media case around avatar/gallery/usage preservation with the actual template registry; remove repeated schema-version and migration-step inventories owned by `schema-history.test.ts`.
- Consolidate rectangle merge coverage: retain the literal 3,500-unit overlap oracle, remove its second inclusion-exclusion helper, and retain the broader random/tangent area-law owners.
- Rewrite the light case around enabled light identity, disable/re-enable and hidden-track exclusion, replacing optional-container omission with render-snapshot behavior.

Removed local infrastructure: the copied recursive oracle, duplicate inclusion-exclusion helper, PCM signal generator, one-use parameterized fixture reader and unused imports. Supporting production functions retain real callers; no test-only production seam was removed.

## Voice optimization and measurements

The binary/window/page tests now supply documented feature planes directly to `buildVoiceAnalysis`: 15,000 frames, thirty one-second voiced runs, two full 60-second windows and one partial window. Literal −70/−20 dBFS levels and −55 dBFS threshold replace a production-derived expectation. The full DSP sample-to-feature oracle remains in `packages/audio-dsp/test/voice.test.ts`.

The round-trip owner compares the complete header structurally and every byte of the four decoded planes and re-encoded file with native `Buffer.compare`. It retains exact byte equality while avoiding matcher traversal of large typed arrays. Literal JVA1 magic independently pins the protocol.

Environment: x86-64 Linux, 8 vCPUs, AMD EPYC-Genoa processor, about 15 GiB RAM; Node 20.19.0, pnpm 10.34.5, Vitest 4.1.11, `--maxWorkers=2`. Runs used the same shared host, one voice file per process, with original/final runs interleaved under the shared pure-validation lock. Other host work was not controlled; these are file measurements, not full-suite or CI estimates.

Original wall times: 10.04, 9.16, 10.15 seconds. Final: 8.90, 9.10, 9.11 seconds. Median: 10.04 → 9.10 seconds, a measured difference of 0.94 seconds (9.4%). The before-run range was 0.99 seconds, so shared-host variance limits the wall-clock conclusion.

The largest timed voice case, binary round-trip, fell from a median 340.00 ms to 3.36 ms. Its assertions still check the full header and all bytes. The remaining vector Boolean property cases are retained for independent area identities and historical tangent failures; the first changed-file run measured `vector/ops.test.ts` at about 1.34 seconds. Startup/module loading remains outside the timed test bodies; no runner-isolation policy was changed.

## Validation

Commands ran with Node 20.19.0 and serialized validation locks:

- `pnpm install --frozen-lockfile --offline --ignore-scripts`
- `pnpm exec vitest run packages/project/test/{sound-takes,sound-taxonomy,template-media,template-object-params,text-animators,three-d-commands,transition-polish,voice-analysis,vector/ops}.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-test-audit/project4-final.json`: 120 passed before the final redundant migration case was removed.
- `pnpm exec vitest run packages/project/test/template-media.test.ts --maxWorkers=2 --reporter=json --outputFile=/tmp/jasper-test-audit/project4-final-template-media.json`: all 19 final cases passed after that deletion.
- `pnpm --filter @jasper/project typecheck`: passed.
- `pnpm exec vitest run packages/project/test/voice-analysis.test.ts --maxWorkers=2 --reporter=json --outputFile=<report>`: fifteen passed in each of six interleaved final benchmark runs; six earlier profiling runs also passed.
- `pnpm exec biome check --write <changed tests> docs/test-audit/project_4.json` and `git diff --check`: passed; formatting was limited to owned files.

Counterfactual checks confirmed intended failures for a +1 dB stored threshold, a changed encoder/decoder magic byte a hidden-track output filter bypass, and a one-byte decoded-level-plane offset. The last probe fails the new native byte-comparison assertion specifically. Every production mutation was restored. The unsupported reversal probe was investigated instead of treating its surviving mutation as a product failure.

The parent integration owns the full lint/typecheck/test/build gate, integrated performance comparison and remote delivery. This workstream did not run browser, GL, native or opt-in render suites because production/UI/render behavior did not change.

## Complete word preservation follow-up

The existing randomized subtitle-layout owner now compares all flattened output word identities with the complete independently generated input sequence. Its generator produces sorted, non-overlapping, nonempty alphanumeric `wN` tokens with positive integral-frame durations; the layout call supplies no output range and uses as-spoken text with no text transforms. The new assertion therefore makes no promise about invalid, whitespace-only or range-clipped words. Existing duplicate, order/timing and cut checks and all 200 property runs remain.

Focused target: `pnpm exec vitest run packages/project/test/subtitles-layout.test.ts --maxWorkers=2 -t "subtitles are sorted"`. Intended mutation: remove the last member of the layout's validated word list before grouping (`valid.pop()` before `displayWords`); the output sequence must then disagree with the independent input sequence. No new test or large fixture was added. This follow-up is committed for parent validation; no tests, typecheck, build, benchmark or mutation was run while the parent's isolated baseline was active.
