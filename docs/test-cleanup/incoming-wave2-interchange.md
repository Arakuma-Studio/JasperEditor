# Incoming wave2: interchange and expression-point audit

Scope: all 50 named declarations in the seven assigned files introduced by
`2d364873..69c96e3b`, integrated checkpoint `99d57175`. No original 5,722 declaration
is replaced by this scope. Counts describe original declarations, including removed
consolidations: **4 CONSOLIDATE, 3 DELETE, 26 KEEP, 17 REWRITE**. Seven executions disappear; 43 declarations survive.

Independent sources are the existing researched contracts in
[keyframe sides](../wp-notes/keyframe-sides.md),
[spatial points](../wp-notes/spatial-points.md),
[audio crossfades](../wp-notes/audio-crossfades.md),
[Pitch Shifter](../wp-notes/premiere-pitch-shifter.md),
[Smooth Slide](../wp-notes/smooth-slide.md),
[Link Media](../wp-notes/link-media.md), and architecture D-40/D-41.
No third-party reference artifacts were opened. Documented import assumptions remain
assumptions; no proprietary implementation or output is claimed reproduced.

## Behavioral bar for every retained row

Each row below names its independent requirement, recognizable output failure,
independent literal/formula/format oracle and distinct owner. All call public
interchange converters/writers/readers, import+command boundaries, or expression
binding/snapshot boundaries. They inspect returned document/IR data, wire bytes,
recorded reports or rendered expression values, never private call order/counts.
Those boundaries and their specified results survive helper/identifier/algorithm
refactors. The row's final sentence explains why another remaining owner does not
supersede it. DELETE/removed CONSOLIDATE rows identify their failed bar and survivor.

Pure pitch/transition converters are explicitly exported public APIs and documented
as decoded-component boundaries for future format importers. Their exports remain;
absence of internal consumers is not evidence that this public interface is a test
hook. No production source, dependency, fixture asset or runner configuration changes.

The expression reference is an explicit cubic P(t)=(1−(1−t)^3,t^3), two-second
duration, 1920×1080 layer. Independent adaptive Simpson integration of
`sqrt((5760(1−t)^2)^2+(3240t^2)^2)` gives total 2719.945053206891px; inverse integrated
arc length supplies the committed position literals, and the analytic tangent confirms the derivative review. This replaces a self-comparison against the same
production evaluator. The position oracle uses KF-031's 0.25px budget; prior 9-digit
same-evaluator equality was no independent physical accuracy oracle. The generic derivative and vector arithmetic remain independently covered in engine.test.ts. An analytic probe at arbitrary frame 50 differed by 0.00595 from the finite arc-table derivative; no independent requirement promises the old same-evaluator two-decimal physical accuracy. This is not claimed a product bug and no tolerance was widened. Pitch curve limits stay 0.11c (single conversion)
and 0.21c (wire round trip); no tolerance follows a production constant anymore.

## Test-by-test dispositions

Original line numbers below identify the integrated baseline; rewritten names may
change. All 50 rows are also reconciled in the task's disposition manifest.

### `packages/expressions/test/spatial-points.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| value and valueAtTime are the metric-evaluated (rendered) path (47) | REWRITE | Effect-point expression valueAtTime must use layer-pixel arc length and work after snapshot binding; old expected values reused evaluate with the same metric and could agree on a broken metric. Explicit cubic positions independently integrated in 1920×1080px catch missing metric or delayed-time application through bindDocumentExpressions and bindSnapshotExpressions. Model evaluation alone cannot prove expression-world or snapshot wiring. |
| velocity is the derivative of the metric-evaluated path (normalised units per second) (78) | CONSOLIDATE | No unique remaining glue: velocity is the generic prelude valueAtTime finite difference, using the same property metric options as retained independent position/snapshot binding. Existing engine.test.ts numKeys/key/nearestKey/valueAtTime/velocity owns literal 90 units/second and vector maths owns literal subtract/divide arrays. Original expected derivative reused the exact production evaluator. Remove this composite execution; the retained binding owner catches missing metric and existing engine owner catches derivative/time-unit faults. |

### `packages/interchange/test/keyframe-sides.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| FCPXML: one-sided eases are written as easeIn / easeOut points and read back per side (33) | KEEP | FCPXML easeIn/easeOut protocol tokens and recovered incoming/outgoing sides are literal expectations from the DTD mapping. Wrong token or side assignment loses the edit. Unique asymmetric four-key wire owner; scalar evaluator tests cannot establish serialization. |
| FCPXML: documents without per-side keys export exactly as before (ease / linear) (51) | KEEP | Legacy FCPXML keys must keep linear/linear and ease/smooth bytes. Literal token pairs catch compatibility drift when inInterpolation is absent; new per-side inputs do not exercise that path. |
| OTIO keeps the incoming sides exactly (67) | REWRITE | OTIO metadata must retain incoming sides and ease vectors exactly; literal expected arrays replace another fixture-factory call. Lost incoming side or slope fails the round trip. FCPXML/FCP7 intentionally have different fidelity and cannot supersede this lossless owner. |
| FCP 7: an Ease In key is still written as a curve and the lost sides are reported (75) | KEEP | FCP7 must emit curve keys for incoming Bezier sides and report separate-side loss. Two FCPCurve wire occurrences and a feature-specific report identify the regression; FCPXML/OTIO support different wire semantics. |

### `packages/interchange/test/premiere-audio-fades.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| Constant Power with its own shape (Cosine @ 19, symmetrical) stays Constant Power (24) | CONSOLIDATE | Private mapper invocation duplicated format behavior. Own-shape Constant Power/Cosine 19 and Constant Gain/Linear 0 assertions move to the surviving fixed-fade XML owner, which also catches importer wiring and uses literal expected ids/params. |
| Custom Fade Cosine @ 12 / 13 / 30, symmetrical (37) | DELETE | Failed unique-protection bar:12/13/30 repetitions differ only in incidental valid numeric input. The Custom Fade XML 30 owner, asymmetric −12.5 round trip and full-domain parser fuzz protect field conversion and bounds. |
| a fixed transition with another shape becomes a Custom Fade; Exponential Fade keeps its curve; bad data is reported (47) | REWRITE | Actual FCP7 parser now owns fixed-shape identity, custom-shape promotion, Exponential fixed behavior and invalid-field fallback. Literal ids/params and the three distinct report replacements catch wrong fade choice or wrong fallback reason; counting arbitrary warnings no longer suffices. This replaces a private helper seam. |
| never throws and only produces readable Custom Fade params (fuzz) (71) | REWRITE | Untrusted fade fields must produce only readable finite bounded params without crashing. Escaped generated scalar fields now pass through FCP7 XML and fragment import; literal type/range domains can reject production output. Broad corrupt-document fuzz does not exercise valid XML carrying hostile fade values. |
| premiereFadeShapeOf writes the fields back (92) | CONSOLIDATE | Private export-helper assertions duplicated the actual asymmetric/off-centre XML round trip. Its surviving owner asserts literal five-field params after export/import; an export-field regression now fails at the wire seam. |
| maps the names, the effect ids and the Spanish display names (131) | KEEP | Independent Premiere/FCP7 names, effect ids and localized aliases must identify four audio fades. Literal alias→id pairs catch wrong transition selection; shape/geometry tests use already resolved ids and do not own name detection. |
| reads the Custom Fade shape and keeps an off-centre span (Custom Start) instead of re-centring it (148) | KEEP | Custom Start must preserve4/20=0.2 cut position, duration and cosine30 shape; start/end-at-cut and centred inputs retain their declared alignments. Literal frame/fraction outcomes catch silent recentering during IR→fragment conversion, which standalone model transition tests do not exercise. |
| writes and reads back a Custom Fade (asymmetrical, off-centre) through FCP7 XML (169) | REWRITE | FCP7 must carry asymmetric linear−12.5/cosine40 fade fields and0.4 cut position. Literal restored params replace expectations copied from another import result; this actual writer/reader owner absorbs the redundant export-helper execution. |
| EDL and AAF say that a Custom Fade’s shape is not carried (never dropped silently) (203) | KEEP | EDL and AAF cannot carry Custom Fade shape and must identify its loss rather than silently dropping it. Separate actual exporter reports naming the transition/parameters detect missing reporting; supported-format round trips cannot establish this refusal-to-silently-lose contract. |

### `packages/interchange/test/premiere-pitch-shifter.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| is linear from 0.5 (0) through 1 (1/3) to 2 (1); garbage is no shift (79) | DELETE | Failed unique-protection/lowest-owner bar: arithmetic helper branch checks duplicate the measured semitone table, independent direct exporter formula, clamping owner and public garbage-input owner. No meaningful mapping contract relies on this helper execution. |
| reads the whole semitones of Premiere's measured table exactly (90) | KEEP | Public translator must match the independently measured ExtendScript table across octave endpoints and positive/negative semitones. Literal observed normalized values→whole semitones catch wrong normalization/logarithmic interpretation, even if mutually inverse conversion functions agree. |
| the user's values: 0.2995 is −90.04 cents (−1 st +9.96 c with Use Positive Cents, else 0 st −90.04 c) (98) | KEEP | Recorded noninteger voice shifts and positive-cent display splitting must map to exact literal cents, including −90.04→−1+9.96 versus0−90.04. Whole-semitone vectors cannot expose cents rounding/sign errors; XML aliases do not own this decoded API input. |
| splits cents like Premiere displays them; the sum is exact (115) | DELETE | Failed unique-protection bar: splitCents helper examples restated branches already observed in public fractional-shift/display, octave-clamp and garbage-input owners. Public decoded params remain protected without depending on helper shape. |
| is monotonic, stays in the Pitch Shifter ranges and round-trips (property) (124) | CONSOLIDATE | Monotonicity/range/inverse-conversion property duplicated the measured import vectors, hostile-input boundedness and the opposite-direction property, and two wrong inverse maps could agree. Retained direct-export property uses the documented independent frequency-ratio formula; measured imports and curve property remain separate owners. |
| JasperEditor → Premiere → JasperEditor keeps the shift (and whole-semitone splits) for \|shift\| ≤ 1 octave (148) | REWRITE | Public export of arbitrary supported semitone/cents shifts must equal(2^(cents/1200)−0.5)/1.5 and preserve positive-cent presentation. Independent mathematical oracle replaces another production importer as expected output. Detects wrong exporter normalization even when inverse importer agrees; wire tests own XML encoding only. |
| clamps shifts beyond an octave on export, and a Transpose Ratio outside 0…1 on import (reported) (177) | KEEP | Export beyond an octave and forced normalized import belowzero must clamp to explicit endpoint values and report clamping. Valid-domain scalar/property cases cannot establish out-of-domain policy or visible loss reporting. |
| reads a displayed ratio (0.5…2) when asked, or when a value is above 1 (194) | REWRITE | Explicit displayed-ratio mode0.75 must yield literal −498.045c; aboveone selects ratio interpretation. Production centsOfRatio no longer supplies the oracle. Normalized default inputs do not protect this documented alternate API mode. |
| a .prproj instance: Spanish names, the instance name, Precision from the plug-in state, nothing reported (206) | KEEP | Decoded Spanish parameter/state input must preserve instance name, high precision/default switches and−90.04c without warnings; parameter values override stale state. Literal param/metadata values catch alias/state-precedence loss. FCP7 does not carry this plug-in-state input. |
| bypass (the component flag or the Bypass parameter) disables the effect (234) | KEEP | Either decoded component bypass or Bypass parameter disables the mapped effect. Literal false results catch either missed source; the FCP7 enabled flag is a different wire input and cannot supersede the public decoded-component API. |
| the keyframed Use Positive Cents (0.75 → 0.25) changes nothing audible and is reported as ignored (246) | KEEP | Animated Use Positive Cents is display-only: exact pitch stays−90.04, no audio keys are created, and the ignored animation is reported. Other scalar switch tests cannot detect accidental audible automation. |
| reports custom splicing settings and a non-default Precision (Audition-style names) (266) | KEEP | Unsupported non-default precision and manual splicing must be identified in warning reports. Feature-specific tokens reject unrelated warnings; ordinary converted values cannot establish that fidelity loss remains visible. |
| reads parameters by ExtendScript match name or index when names are localised otherwise (284) | KEEP | Public decoded params identified by ExtendScript match id or parameter index must map to literal −300c/+1200c despite unrecognized display names. Name-based XML parsing cannot exercise the index-only API input. |
| the plug-in state ParamList: Version 1 (five values) and Version 2; garbage → [] (294) | REWRITE | Version1/2 state-only components must recover+2st and malformed state must safely default to 0. Literal caller-visible params replace direct private ParamList array checks. Parameter/state precedence case supplies an explicit ratio and therefore cannot own state-only fallback. |
| identifies the effect by match name, the Spanish name or a Premiere-only parameter, not by JasperEditor id (307) | KEEP | Public identification API must distinguish UUID, script alias, Spanish name and Premiere-only params from Jasper own id/params. Literal booleans catch false recognition that would reinterpret already mapped values; wire integration covers selected dialects but not all API argument sources. |
| never throws on garbage and only produces valid Pitch Shifter values (fuzz) (318) | KEEP | Garbage decoded component/state/name/keys must never crash and must produce finite bounded Pitch Shifter params and finite nonnegative integer times. Independent literal domains enforce the public boundary safety contract; valid measured fixtures cannot protect hostile values. |
| keeps every keyframe time and follows the linear-ratio curve within the tolerance (property) (400) | REWRITE | Import must keep original times and approximate piecewise-linear normalized-ratio pitch within 0.11c. Expected curve now uses independent piecewise arithmetic+documented logarithm, never production ratio/evaluator helpers. Constant vectors cannot expose omitted subdivision or timeline errors. |
| a hold key stays a hold; equal keys add nothing (434) | KEEP | Hold interpolation must keep−1200c until the next key and retain original0/one-second endpoints; static input must stay keyless. Literal hold outcomes catch accidental interpolation, distinct from the linear-ratio approximation owner. |
| exports JasperEditor keyframes so Premiere follows the semitone curve within the tolerance (460) | REWRITE | Exported curve must reproduce a−12→+12st ramp within 0.11c with exact endpoint times. Independent linear-cents expectation and ratio formula replace shared evaluator/mapping helpers; incidental intermediate-key count is removed. Scalar exports cannot catch missing temporal approximation. |
| imports the normalised Transpose Ratio with keyframes, the switches and the instance name (509) | REWRITE | FCP7 normalized ratio, frame-snapped automation, switches and instance name must map to literal endpoints and independently calculated midpoint. Replaced production helper oracle; decoded API cases cannot establish XML wiring or frame snapping. |
| a disabled filter is a bypassed (disabled) effect; Spanish names; a ratio-scaled parameter (541) | KEEP | Disabled Spanish/displayed-ratio FCP7 filter must remain bypassed,+2st and unnamed when its name is only the generic effect name. Literal output catches wrong scale detection/enable/name wiring; decoded API takes explicit ratioScale and does not exercise XML valuemax. |
| JasperEditor's own Pitch Shifter filters (semitones / cents by id) still read back (557) | KEEP | Existing Jasper-id FCP7 semitones3/cents25 must remain that representation. Literal values catch accidental interpretation as Premiere normalized ratio; all other wire vectors use Premiere identifiers. |
| exports in Premiere's representation and reads back the same shift, keyframes and bypass (566) | REWRITE | Actual XML export/import must retain bypass, declared Premiere wire id and original linear-ratio/hold curve. Expected31-frame pitch values derive from authored source keys, never the first import output. Detects shared reader/writer pitch error and hold/time changes that round-trip self-comparison could hide. |
| into a document: a valid Pitch Shifter effect (invariants) (601) | KEEP | Public importTimeline fragment must apply as an undoable project.importTimeline command with a valid registered named Pitch Shifter carrying literal 0st−80c. IR-only tests cannot catch broken fragment effect-version/command wiring; schema/invariant checking accompanies a concrete value assertion. |

### `packages/interchange/test/premiere-transitions.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| maps the Universe Slide MatchName to Smooth Slide (case-insensitive); others are not mapped (71) | REWRITE | Public MatchName recognition must map UUID/case variant to literal jasper.smooth-slide and reject unqualified Slide/null. Independent wire id replaces registry.id as expected; FCP7 positive case does not cover casefold/negative API inputs. |
| converts the decoded parameters: popups by index, numbers clamped, layer picker ignored (78) | KEEP | Decoded Universe fields must map literal popup indices, clamped numbers, ignored layer picker and unsupported-index report. Literal ten-field dictionary catches wrong field/index/range conversion; XML fixture exercises different settings and cannot supersede the full decoded API mapping. |
| keeps keyframes of numbers (flicks from the span start) and drops those of hold-only settings (111) | KEEP | Numeric animation must keep sorted original times/values, while enum animation is dropped with a feature-specific report. Literal key arrays and hold-only result catch silent automation loss/policy changes; static parameter tests cannot protect it. |
| never throws and only produces valid Smooth Slide values (fuzzed parameter lists) (136) | REWRITE | Hostile decoded parameter/key lists must return finite bounded numbers, valid literal enums/booleans and nonnegative integer times. Independent documented domains replace production SMOOTH_SLIDE registry introspection, so matching registry/mapping mistakes no longer satisfy the oracle. |
| FCP7 XML: an effectid of Universe Slide becomes Smooth Slide with params; the name "Slide" alone stays Slide (183) | REWRITE | Actual FCP7 Universe MatchName must produce a valid one-sided Smooth Slide with literal mapped settings/keys; ordinary Slide must remain jasper.slide. Literal id replaces registry.id. Decoded mapping cannot catch wire recognition/fragment command integration or name collision. |

### `packages/interchange/test/relative-paths.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| Windows and UNC references stay absolute paths (never joined to the import folder) (36) | KEEP | Imported Windows drive and UNC media references must remain absolute on another host and never become project-relative. Literal paths/null relativity catch destructive host-prefix joining; local relative-reference tests cannot detect foreign roots. |
| a relative reference is resolved against the import folder and kept as the project-relative path (48) | KEEP | Relative EDL media must resolve against import folder while preserving authored project-relative spelling, including parent/backslash path. Literal full/reference map catches either incorrect join or lost portability metadata; absolute-path tests have no relative metadata. |
| file URLs of Windows drives decode to drive paths; relative references are recognised (59) | REWRITE | Public path boundary must decode drive/file URLs and distinguish relative files from absolute/non-file/empty references. Literal paths/null outcomes cover URI and empty branches absent from EDL vectors. Removed new Report().entries self-assertion and its unused import. |

### `packages/interchange/test/spatial-points.test.ts`

| Original test (line) | Disposition | Contract, independent oracle, failure and unique owner |
| --- | --- | --- |
| FCPXML: a point key’s curve is its spatial interpolation, for Motion and effect points, and reads back (66) | KEEP | FCPXML point curve tokens, key values and lossy smooth reconstruction must follow the DTD for both Motion and effect points, with handle-loss/approximation reporting. Literal wire/value/mode arrays catch dropped effect animation or conflated temporal/spatial interpolation; scalar per-side tests exercise different fields. |
| FCP 7 XML writes point key values only and reports the curved paths (109) | REWRITE | FCP7 must retain literal point key values while reporting unsupported curved paths. Previously only warning strings were asserted; now actual exported/imported Transform values must remain. This catches a writer dropping keys while truthfully warning, which other-format owners cannot detect. |
| OTIO keeps every key’s spatial data exactly (118) | KEEP | OTIO metadata must retain each authored Motion/effect spatial mode and tangent exactly. Authored fixture data is an independent lossless round-trip oracle; FCPXML/FCP7 intentionally discard handles and cannot supersede this format owner. |

## Validation and performance

Final scope: 43/43 cases passed across seven files, zero skips, 13.33 s Vitest /
14.63 s GNU command wall time. Final-source restoration also passed 47/47 cases
across the Pitch Shifter, expression-point and full expression-engine files.
Actual TypeScript 5.9.3 checks passed for interchange (29.52 s) and expressions
(15.13 s), with the host compiler-interception preload replaced command-locally.
Biome checked all seven changed files; staged diff checks passed. No production
change, fixture/snapshot, dependency or configuration changed. Exact test diff is
195 lines added / 265 removed: **−70 test LOC**.

Commands (Node 20.19.0 / pnpm 10.34.5, own workspace dependency links verified):

```sh
pnpm install --offline --frozen-lockfile --ignore-scripts
env -u NODE_OPTIONS pnpm exec vitest run \
  packages/interchange/test/keyframe-sides.test.ts \
  packages/interchange/test/premiere-audio-fades.test.ts \
  packages/interchange/test/premiere-pitch-shifter.test.ts \
  packages/interchange/test/premiere-transitions.test.ts \
  packages/interchange/test/relative-paths.test.ts \
  packages/interchange/test/spatial-points.test.ts \
  packages/expressions/test/spatial-points.test.ts --maxWorkers=2
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/interchange typecheck
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/expressions typecheck
env -u NODE_OPTIONS pnpm exec vitest run \
  packages/expressions/test/spatial-points.test.ts \
  packages/expressions/test/engine.test.ts \
  packages/interchange/test/premiere-pitch-shifter.test.ts --maxWorkers=2
```

The measured runs add default/JSON reporters and GNU `time -v`. Evidence is under
`/tmp/jasper-test-cleanup/wave2-interchange/` (`profile.py`, four `profile-*`
logs/JSON/time files, `profile-summary.json`, `final-current.*`, typecheck logs,
`mutate.py`, `mutant-*`, `restoration.*`, and independent expression-reference JSON).
Root's incoming-wave2 baseline also passed all 50 cases before editing.

A scoped ABBA run restored exact `99d57175` tests for A, and the 43-case cleanup for
B, preserving production inputs, two workers and file isolation. Command wall
samples were A=18.400/18.614 s, B=17.301/18.687 s; mean 18.507→17.994 s, an observed
0.513 s / 2.77% reduction. B's 1.386 s spread exceeds the mean difference, so this
is **not evidence of a robust speed improvement**. One other agent's limited
validation ran concurrently; caches were not flushed. Imports dominate these
millisecond-sized bodies. Final CPU mean was 32.485 s versus 31.430 s baseline,
an increase; no CPU or CI saving is claimed. The final deterministic import-curve
anchor was added after ABBA; the subsequent 14.63 s final-source run is validation,
not a comparable extra speedup sample.

Three actual production mutations were rejected, and sources were byte-restored:

- Removing the effect property's metric from expression-world options caused the
  retained independent position owner to fail: 92.73 px error versus 0.25 px.
- Dividing the generic expression finite difference by `h` instead of `2*h`
  caused the existing expression-engine velocity owner to report 180 rather than
  90 units/second. This verifies surviving ownership after consolidation.
- Disabling pitch subdivision caused the independent export curve to miss by
  52.877 cents versus 0.11. The import property's original random sample could
  miss this fault, so its retained property now includes a deterministic full-octave
  midpoint example in addition to its 60 generated cases. Both import and export
  owners then failed; both pass after restoration. No tolerance was relaxed.

The first rewritten expression fixture tried changing frozen command state and
failed before its assertions; supplying spatial data through `keyframe.add`
corrected setup. An independent analytic derivative probe exposed the numerical
accuracy limit described above; no product regression is inferred. A natural
midpoint derivative probe passed the unchanged bound, but the execution was still
consolidated because its glue duplicated retained independent owners. None of
these intermediate failures was suppressed or counted as a passing gate.

No browser/export/native suite is required for these test-only pure boundary
changes. Root owns integrated lint, full suite/build and current-built-app checks;
this scoped report does not claim those gates passed.
