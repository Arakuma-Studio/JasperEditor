# Final independent-oracle integration review

Reviewed the integrated source through `2dda4eb1`, followed by the integrated report-only changes through `3b3bf525` and project4 correction `80582eda`. This was a read-only review: no source/worktree edits, runtime tests, builds, or additional agents. The review updated only this report outside the checkout. Root owns integrated validation, remote integration and push.

**Source findings: resolved.** No outstanding concrete source defect, lost contract, broken caller, circular stronger-owner claim, or missing assigned declaration was found in the final review. Three ledger/provenance inconsistencies were corrected in owner commits; generated notices were then refreshed and checked in integration. This is not a claim that pending runtime gates passed.

## Original concrete findings and final disposition

| Finding | Final disposition and observed integrated evidence |
| --- | --- |
| `apps/web/test/polish-open.test.tsx`: exact two POSTs and `[MEDIA_STATUS_BATCH_MAX, 200]` copied internal batching | **RESOLVED — REWRITE.** The independently documented API cap is literal 1000; every emitted batch respects it, the union equals the 1200 authored keys, and every medium's status/poster result is checked. No exact count, order, or partition remains. The public schema/runtime constant remains because production uses it. |
| `packages/audio-fx/test/{stereo-channel,dynamics,special}.test.ts`: expected amplitudes/ceilings reused `dbToGain` | **RESOLVED — REWRITE/DELETE incidental assertion.** Gain and limiter contracts use independent amplitude literals without changing stimuli or tolerances; the additional local HardLimiter ceiling was corrected too. The arbitrary mastering −0.3 dB private ceiling assertion was deleted because no independent exact requirement was found. Production DSP helper consumers remain. |
| `packages/audio-dsp/test/ducking.test.ts`: silence asserted equal to owner `FLOOR_DB` | **RESOLVED — DELETE incidental assertion.** Fixed −20 dB envelope/window behavior remains. The constant export remains for the real engine audio-service consumer. |
| `packages/session/test/view.test.ts`: expected complete view from the owner's `defaultSequenceView` | **RESOLVED — REWRITE.** Removed the exact constructor echo; successful public open, repair propagation and clean document state remain. The production constructor remains. |
| `packages/session/test/selection.test.ts`: expected empty state from the same `emptySelection` helper | **RESOLVED — REWRITE.** Inherited-property exclusion now expects literal empty clip/transition/item lists; helper use is fixture setup only. |
| `packages/interchange/test/{edl,aaf,omf}.test.ts`: expected origins through `parseTc`/`timecodeBase`; EDL reader/writer cancellation | **RESOLVED — REWRITE.** Independent literal frame/flick origins and authored CMX minute-boundary labels replace conversion-derived expectations. Setup helpers remain where needed by actual writers. |
| `packages/testkit/test/golden.test.ts`: expected error text derived from `MAX_GOLDEN_BYTES` | **RESOLVED — REWRITE.** Asserts public `GoldenMismatch`, successful small output and absence of the oversized file. The test claims oversized rejection, not an untested exact limit boundary. |
| `apps/web/test/program-math.test.ts`: expected points and parameters recomputed with action-owner matrices | **RESOLVED — REWRITE.** Authored 37-degree cropped pointer coordinates, independent opposite-handle tables, off-ray uniform projection, anchor and viewport values replace shared matrix calculations. Corresponding layer-menu expectations were corrected too; real geometry consumers remain. |

## Cross-owner follow-ups verified

- **Project numeric/configuration limits — resolved.** Documented 32-key, 64/96-tap, 32-warp, 2048-padding and eight-sample limits now use independent fixed expected values. Color-management vectors no longer obtain expected encoded values from the same transfer function. Speech coverage uses the authored ten-second source interval. Mesh reset uses the configured grid's analytic center/tangents. Histogram/HLS/YC scope expectations use independent BT.709/HLS values; camera defaults use the independent 36 mm/50 mm optics contract. Removed `rowOf` and `vectorCell` had no production callers.
- **Engine numeric oracles — resolved.** Camera output metrics no longer use solver rotation/alignment helpers. Native absolute card/crop geometry uses authored endpoint/affine values; full-frame cross-renderer parity remains separately justified. Engine color/export uses independent exposure and blend values, audio loudness uses external FFmpeg, roto output uses an external PNG decoder, and real speech timing uses the authored trim/placement rather than production distribution. The real-model WER scorer moved into test support.
- **Security discovery — resolved.** The listening-engine test reads the token through the actually advertised runtime file and retains literal 0600 permissions plus successful HTTP authentication. Config's separate naming contract remains below it; shared `appdirPaths` equality was removed.
- **Motion/audio residual self-oracles — resolved.** Tuple hash versus the same joined-string hash comparison was removed while fixed vectors and collision/order contracts remain. Remix's implementation-derived minimum-piece assertion and test-only export were removed; independently authored attack/boundary behavior remains. The identical-underlying LoudnessMeter comparison was removed while its normative loudness vector and public pass-through behavior remain.
- **Web/MCP/tooling protocols — resolved.** Fixed documented key/header/storage/time values replace same-owner constants where they were the expectation; fixtures and typed readers remain where they merely arrange or observe data. Real Properties and parameter-edit UI results replace captured internal command kinds/state. MCP reads public revision/persisted fields; inventory/probe-count leftovers are gone. Desktop readiness, native event ownership and scanner outcomes now observe the actual channel/output rather than collaborator counts or graph size.
- **E2E false positives — resolved.** Screenshot dimensions are checked in actual PNG bytes against an independent browser capture. Caption burn pixels use an opaque fixed background, so animated source motion cannot satisfy the difference. Headless refusal and capability-derived export routing duplicates were removed without losing real reopen or exported clipping artifacts.
- **Compositions/Lumetri — resolved in source.** Linear burn expects literal `[26, 0, 26]`; distort identity/map tests read the independently painted input before any shader. HSL selection/invert/mask/softness, highlight gain and vignette have independent rendered values/relationships. Seven original project declarations were transferred to actual registered-shader outcomes, including Set/Add/Remove eyedroppers. Input key builders are actions under test, not expected-value builders. The unused CPU output mirror and harness reference mode were removed.

## Deliberately retained relationships

An imported helper is a lead, not a deletion verdict. Setup-only helpers, typed output readers, authored fixture dimensions and independently specified units remain when they do not manufacture the expected behavior.

- The Program mapping E2E remains a narrowly stated **inverse protocol** contract. Public MCP descriptions promise both directions; authored 960/540 returns through separate conversion equations, and `elementFromPoint` identifies the real Program panel. It catches missing or mismatched direction handling, not a common absolute viewport error. Existing tool-response artifacts remain.
- GL/native blend, optimized/scalar LUT and preview/export audio comparisons retain explicitly required **backend parity**. The implementations are distinct at the observed seam, and lower numeric tests/committed goldens own absolute formula correctness. This does not claim shared-code equality is an independent numeric oracle.
- Cross-runtime expression equality is explicitly required to be bit-identical. Current source preservation, ordered parallel output, and cache invalidation properties likewise have separately specified relational behavior.

## Source/support census

Caller searches and relevant owner reads found no missing production call sites after removal of camera `umeyama`, `frameR` and redundant rotation re-export; scopes `rowOf`/`vectorCell`; or CPU-only Lumetri output functions. WER lives only under engine test support and its self-test is deleted. Lumetri settings/eyedropper builders remain because real renderer/UI callers need them. Private constants retain same-module production uses and have no lingering test imports. Earlier removed localization hooks, wrappers, gallery-only exports, recipes and dead GL harness paths remain absent.

Previously reviewed retained fixture/snapshot consumers remain valid: schema history, version and interchange fixtures, native parity goldens, scene/motion-blur goldens, mask raster snapshot and GL fingerprints. Published documentation images and their provenance remain. No orphan supporting artifact was identified.

## Inventory and six-bar report review

The assignment inventory still contains 627 unique test-bearing paths across 19 owners. A final normalized name-to-ledger census accounts for **4,451 original TS/JS declarations**: 4,450 names match directly, and the remaining dynamic `processing-colour-range` template is explicitly represented by its RECIPES × available FFmpeg × range family in `engine3.md`. Parameterized declarations count once. Four Rust test files, desktop clipboard and four standalone scripts are assigned; tooling also records 22 executable performance budget rows and all six microbenchmark targets.

Reviewed final added/superseding justifications specify independent source, visible failure, independent expectation, stable action/observation, refactor tolerance and lowest unique owner. The remaining reporting corrections are about authoritative ownership/counting and stale provenance, not missing behavioral justification:

1. **Lumetri seven transferred originals — RESOLVED in integrated `357e2561` (owner commit `80582eda`).** `project4.md` classifies them REWRITE across packages, links each to `compositions2.md#final-oracle-independence-rescan-pre-edit-record`, and reports 55 DELETE / 36 REWRITE / 287 KEEP. Each original row now has its own six-bar explanation; the destination contains the full shader rationale and exact seven-row transfer map. Reviewed the correction.
2. **WER helper original — RESOLVED in integrated `74ba385a`, `b808664f` and `3b3bf525`.** Engine1's authoritative `counts edits` row is DELETE with totals 34 DELETE / 34 REWRITE / 164 KEEP. Engine3's supplement describes its implemented deletion as cross-owner and already counted, not an additional original declaration; engine3 final totals are 22 DELETE / 29 REWRITE / 176 KEEP. Root also corrected the leftover initial engine1 summary to the final totals in its documentation work. Reviewed the corrections.
3. **Lumetri provenance/worknote — RESOLVED, including generated notices.** The stale CPU-every-pixel pass claim is corrected in integrated `12b79a07`, with current independent contracts and pending validation. `80582eda` removes the obsolete `secondaryKey` mapping and names the surviving settings normalizer plus `lm_key`. Its isolated worktree could not generate notices because `@codemirror/autocomplete` was not installed; the failure is reported, not treated as a pass. Root subsequently ran `pnpm notices` and `pnpm notices --check` successfully in integration: 150 packages and 31 ported source records. No concrete review housekeeping remains.

## Validation limits

`git diff --check cf890a29..HEAD` passed during this review. No reviewer runtime/build jobs were run. The source review found no blocker, but independent camera straight-path normalization differs from its former best-fit metric and needs the scheduled noisy-fixture run. Quantized GL mask/eyedropper and painted-source cases likewise need actual GL execution. Watchdog-only failures under host contention are unresolved validation results until a rerun succeeds; they were not used to delete contracts or relax numerical tolerances. Final lint/typecheck/test/build, specialized-suite status, remote-added-test audit and push remain root responsibilities.


## GPU fingerprint declaration follow-up — pre-edit disposition

At integration `56f3ed72`, review found one additional **REWRITE** requirement:
`transition-gl/entry.ts` swallowed fingerprint render errors and omitted keys,
while `expectFingerprints` compares only received keys. Different catalogue
inputs do not cover all three patterned-card progress cases. Propagate these
errors. The earlier source-findings resolution above does not cover this later
finding until the following rewrite is committed and reviewed.

The FX and transition family declarations also become individual documented pixel
contracts. Their complete B1–B6 justifications, caller census, risk and exact retained
case mapping were recorded before edits in the final supplements of
[compositions1.md](compositions1.md#per-effect-fingerprint-declarations--before-edit-record)
and [compositions2.md](compositions2.md#per-transition-declarations-and-omitted-fingerprint-failures--before-edit-record).
Preserve every input/render, fixed golden, tolerance, existing category watchdog,
browser/context and transition phase ordering. Family elapsed-time limits are not
specified behavior. These changes do not remove a retained regression, raise a
timeout, change production, or introduce a production test hook. Static validation
and exact accounting will be appended; full GL execution remains pending integration.


**Follow-up implemented; static validation passed.** The transition catch is removed;
a deliberate render-rejection probe passes through the same Error in the rewritten
adapter where the baseline swallowed it. Independent committed-golden IDs now keep
missing catalogue effects/transitions declared; new unpinned catalogue entries also
remain checked. No shader, production seam, fixture image or golden JSON changed.

Exact accounting: **374 effects × 2 = 748 renders**, and **172 transitions ×
(5 catalogue + 2 endpoint + 3 fingerprint) = 1,720 renders**. Static comparison
preserved the complete group/phase/ID sequence and each existing category's 60s/240s
watchdog. The sum of available per-case wall-time budgets increases; this attributes
failures to independently specified contracts and is not a host-load repair. Biome
checked all four TS files, TypeScript syntax/transpilation passed, and diff whitespace
checks passed. No browser/GL or full package typecheck was launched for this follow-up;
those remain integration gates. Composition1 original dispositions are unchanged;
one composition2 family original changes KEEP→REWRITE (83 DELETE / 25 REWRITE /
149 KEEP before its separately owned four-suite follow-up).
