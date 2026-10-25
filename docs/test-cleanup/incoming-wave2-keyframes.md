# Incoming integration: keyframe sides and easing

Audited checkpoint `99d57175` after merging `origin/main` through `69c96e3b`.
This ledger assigns all 111 named declarations in the eight assigned incoming
project files plus the existing `sound-p4v-mix.test.ts` consolidation owner.
Forty declarations are newly introduced by this remote wave; 71 are pre-existing
owners whose earlier audit remains applicable. It supersedes earlier KEEP decisions
only for the explicitly marked original owners rewritten/consolidated here.

## Sources, boundaries and independent oracles

The independent contract sources are [S01 model/time/keyframes](../specs/01-project-model-and-state.md),
[per-side interpolation findings and compatibility](../wp-notes/keyframe-sides.md),
[the easing command/clipboard/velocity contract](../wp-notes/easing.md),
[effect-point pixel metrics](../wp-notes/spatial-points.md),
[Sound Design](../specs/12-sound-design.md), and the documented Lottie/AE wire format.
The 1/6 Linear-side influence is the existing documented inference from AE/Bodymovin/Premiere
samples; this pass does not claim a new live Adobe comparison.

For each retained row, those sources establish behavior independently of this implementation
(bar1). The row identifies an observable wrong value, protocol field, command refusal,
preservation or compatibility failure (bar2). Oracles are hand-authored literals, independently
solved value-unit/CSS cubics, frozen pre-change compatibility samples, or the independently
required preservation/minimum/immutability law (bar3). `evaluate`, public document commands,
loader/repair, clipboard/agent descriptions, serialization and actual consumer algorithms are
stable caller boundaries (bar4). Assertions constrain values/protocol semantics, not collaborator
shape/helper identity, so behavior-preserving internal refactors retain them (bar5). Each row
names the distinct boundary/input regime or the stronger surviving owner (bar6).

Credible failures of the retained isolated numeric units are: interpreting an explicit Linear
side with 1/3 rather than 1/6; using stale Auto speed at an extremum; ignoring the fixed roving
endpoint's incoming side; changing bytes for legacy documents; using linear quaternion progress;
losing a boundary's incoming ease while simplifying; reversing time without mirroring its curve.
Only those observable outputs remain. Internal branch tables and copied formulas were removed.

The old 3,458-line legacy JSON fixture survives deliberately: its outputs were recorded from
commit 27363576 before per-side implementation and are never recomputed by the tested code.
Its existing attribution establishes provenance. Every actual sample remains; fixture-member and
sample-count assertions were removed. Net test LOC: **−445** across eight changed test files. No snapshot, shared dependency or production API was removed;
private ease-segment exports previously removed by cleanup were not restored for incoming tests.

Disposition totals: 8 DELETE, 20 REWRITE, 2 OPTIMIZE, 4 CONSOLIDATE, 77 KEEP.

New 40 declarations: 8 DELETE, 16 REWRITE, 1 OPTIMIZE, 3 CONSOLIDATE, 12 KEEP. Eleven executions are removed; 29 new owners survive.

## Test-by-test disposition

### packages/project/test/anime-contracts.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| saved v4 fixture (animated text, anime template, rect + ellipse) loads without repairs (v4 → v6) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| rejects malformed animators and shapes at load (schema), and flags them after edits (invariants) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| intrinsic box = largest size + the stroke drawn outside the geometry | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| scales reference-rate frames to the sequence rate (round, ≥ 1) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| compresses in + out proportionally when they do not fit the clip with one frame at rest | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| keeps one frame at rest on 1- and 2-frame clips with both sides (the text shows) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| merges preset defaults for known presets and passes unknown presets through | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| lists text animations, template renderers and the kinds of every property | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |

### packages/project/test/ease-apply.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| two keys: the middle segment follows cubic-bezier exactly; the segment's sides become Bezier | KEEP | Existing command/CSS oracle retained; new serialized per-side enum expectations match the incoming version8 format. Preserves selected90-degree cubic output and invariant checks; no helper seam restored. |
| one key: default sections in + out; sections pick segments exactly | REWRITE | Independent CSS quarter-time output now proves defaultboth selected segments and explicit out selection, preserving untouched segment and refusal assertions. Removes production cubicToEases expectations shared with the writer. |
| neighbouring segments keep their shape: linear B with an Auto Bezier C, hold, continuous | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| a hold A becomes Bezier; auto / continuous B keeps its out ease | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| roving: a segment touching a roving key is the run between the fixed keys | REWRITE | Keep complete independently solved CSS samples/roving key placement and invariants at real command boundary; remove duplicate production cubicToEases field expectations. |
| hold-only properties are skipped with a warning; only hold-only → refused | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| locked tracks refuse with E_TRACK_LOCKED; unknown ids with E_NOT_FOUND | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| the previous document is untouched (undo) and re-applying is deterministic (redo) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| 3D Orientation: an overshooting curve warns that the overshoot is clamped | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| strict agent key checks identify an unknown key inside an ease curve | KEEP | Public strict-command validation returns E_SCHEMA at curve path for a nested unknown agent key. See incoming-remote.md earlier integration audit; unchanged since that accepted literal refusal rewrite. |

### packages/project/test/ease-clipboard.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| one key copies its two eases; pasting sets both sides of every target key | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| segments: one curve goes onto every target segment; n curves in order with a count warning | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| a copied multi-key curve pastes as a multi-point rebuild unless mode is "segments" | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| refuses an ease copy from non-adjacent keys of several properties; reads locked tracks | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| pastes in order (property, then time), keeping times and eases; validates like keyframe.update | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| speed ↔ slope through the segment average speed (numbers, signed) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| point properties: px/s along the curved path; round trip through describe | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| roving keys refuse a speed of their own | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-animation.md). |
| segments report cubic-bezier curves per section | REWRITE | Public curve metadata now equals independently supplied SWIFT coordinates directly, rather than applying production cubicToEases to both actual and expected. |

### packages/project/test/ease-sides.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| property: legacy and per-side keys — the span is the cubic, every other segment bit-identical, read-back exact | DELETE | Private writeSpan/read-back probes fail stable-seam, refactor and unique-owner bars. The real applyEase property retains independent CSS samples, neighbor preservation, invariants and immutable replay. |
| property: effect points with a layer-box metric — auto-bezier speeds and captures in pixels | REWRITE | Real Transform effect-point applyEase now owns pixel-metric neighbor preservation. A fixed asymmetric four-key fixture retains outside Auto Bezier positions and proves the selected span changes; omitting actual command metric fails. |
| reads a per-side segment as it renders: Linear out side + Bezier in side curve (⅙ on the Linear side) | DELETE | Private spanEases/segmentShape return-shape comparison duplicates evaluator math and the public describeKeyframeEases result; fails stable-seam and uniqueness. |
| property: the chosen segment is the cubic, the others evaluate as before, invariants hold, undo / redo | REWRITE | Real applyEase has an independent CSS bisection oracle and unchanged-neighbor/immutability law. Remove only private spanEases read-back; command-level output remains and no private export returns. |
| copies both sides with their types; pasting sets them like keyframe.setInterpolation (Premiere / AE) | KEEP | Clipboard protocol preserves independently authored incoming Bezier/outgoing Linear types and eases, then public paste preserves normalized source/target values. Generic clipboard tests use both-Bezier keys and miss sided-type loss. |
| a legacy Auto Bezier key after a Linear key copies as Linear in / Bezier out at its computed ease | REWRITE | Clipboard legacy Auto conversion uses independent centered/segment speed ratio 5/6, with original 12-digit floating tolerance; removes spanEases oracle. Distinct from explicit-type clipboard and catches copying stale stored ease. |
| a clip without types (older clipboard entries, agents) pastes Bezier sides | KEEP | Backward-compatible clipboard without type fields pastes Bezier sides. Explicitly typed clipboard cases cannot catch loss of this older caller/agent input contract. |
| per-side segments: side types, the ⅙ Linear side and the per-key incoming type | KEEP | Public agent description reports explicit incoming Bezier, outgoing Hold and the linear-side1/6 coordinates. Evaluator output alone cannot catch incorrect introspection metadata. |
| a multi-point rebuild follows the curve in layer px along the unchanged path (the metric-free one does not) | REWRITE | Actual multi-point command must follow the requested timing along the original path measured in layer pixels. Preserve dense original-geometry sampling/0.75px bound; delete redundant execution of an intentionally metric-free internal algorithm. |
| clean up path: tolerance in layer px, the timing linear in px, outside segments unchanged | REWRITE | Actual cleanup command retains original path within 0.5 px, constant pixel speed and valid document. Remove redundant private keySidesIssue probes; public invariant check already owns validity. |

### packages/project/test/keyframe-effect.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| inserts at an index, validates and clamps params, refuses unknown ids and wrong targets | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| validates animated param overrides (pasted/agent keyframes) field by field | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| refuses video effects on audio clips and edits on locked tracks | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| removes, reorders and bypasses; reorder clamps the index | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| supports track and master targets with an audio effect registry | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| FX-022: unknown effects are preserved, reorderable, removable and not editable | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table | REWRITE | Use independent high-precision cubic literals36.29366604572753 and63.70633395427247 at half time. Remove production bezierProgress oracle; command behavior and original six-digit tolerance remain. |
| keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| auto-bezier updates after a neighbour moves and preserves its curve when changed to bezier | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| continuous bezier keeps equal velocity on both sides of a key | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| keyframes.prune removes keys that cannot affect the visible range (S01:KF-006) | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| keyframe commands on track and master parameters use sequence time | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| keyframe edits on a locked track are refused atomically | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| maps crop, directional blur and flips to the native FFmpeg protocol | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| brightness/contrast preview transfer equals the canonical formula | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| exports a JSON Schema per clip including applied effect params | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| generates motion-graphic params.* specs from the template schema with defaults | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| resolves values at the playhead, computes reset values and picks the write command | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |
| effect param specs map to ParamPaths the handlers accept | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-core-inventory.md). |

### packages/project/test/keyframe-sides-commands.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| Ease In (side in) after a Linear key: only the incoming side changes, the curve eases into the key; undo / redo | KEEP | Incoming-side command must ease arrival without altering the leaving segment or previous immutable document. Literal shape/small final derivative plus full neighboring samples detect no-op and accidental both-sided edits; other cases edit outgoing/defaultboth. |
| Ease Out (side out): the arriving segment stays exactly as it was; the leaving one eases out | KEEP | Outgoing-side command must ease departure while preserving arrival. Small initial derivative plus original arrival samples detect no-op/wrong-side changes; complementary incoming case cannot substitute. |
| property: an outgoing edit never changes the arriving segment, an incoming edit never changes the leaving one | KEEP | Public command preservation property explores legacy/explicit-neighbor conversions and Auto/Continuous/Hold combinations, checks document invariants and unchanged opposite samples. Fixed input/output cases do not cover neighbor-dependent Auto conversion regimes. |
| Hold on both sides only changes the outgoing side; Linear / Bezier on both make the key explicit | KEEP | Defaultboth Hold changes departure only, preserving arriving curve; defaultboth Bezier explicitly sets both sides. Explicit side=in/out property does not exercise defaultboth/Hold semantics. |
| one side of an Auto Bezier key: the other side becomes Bezier frozen at its shape | CONSOLIDATE | Auto freeze on opposite side already covered by command preservation property over Auto input plus actual pixel-metric witness; remove repeated scalar fixture execution. |
| refusals: Hold on the incoming side, Auto / Continuous on one side, an ease for the other side | REWRITE | Public refusals assert E_INVALID_PARAM for semantic side/ease conflicts, E_SCHEMA for unknown side and unchanged document. Correct failure codes prevent an unrelated error from satisfying the negative. |
| keyframe.update side in edits only the incoming ease (graph handle drag) | REWRITE | Graph-handle update command stores only incoming ease and preserves the full leaving curve. Invalid incoming Hold now asserts E_INVALID_PARAM and unchanged document; setInterpolation cannot catch update handler wiring. |
| keyframe.add accepts inInterpolation and refuses a one-sided Auto Bezier | REWRITE | Keyframe add preserves incoming Bezier in serialized data, refuses inconsistent Auto with E_INVALID_PARAM and unknown incoming enum with E_SCHEMA. Other commands do not cover add input schema. |
| INV-011 reports unreadable incoming types; repairDocument fixes them with a report | REWRITE | Public INV-011 identifies damaged key paths; repairDocument removes unknown incoming, converts mismatched Auto-out and Continuous-in types, reports the changed keys and is idempotent. Remove exact English pins; retain literal serialized repairs, including consolidated incoming Continuous case. |
| copied keys keep their incoming side when pasted | OPTIMIZE | Public serialized keyframe paste preserves incoming enum and all 201 waveform samples, rejects tampered payload with E_SCHEMA atomically. Compute original 201 samples once instead of 201 times; same action/points/tolerance/isolation. |
| loadProject reads a damaged incoming side leniently: dropped before validation and reported | REWRITE | Public loadProject drops an object-valued incoming type before schema validation, reports repair, preserves valid enum and caller input, and reloads without repairs. Replace private sanitizer idempotence with actual load idempotence. |

### packages/project/test/keyframe-sides-consumers.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| Lottie: a Linear key into an Ease In key exports the After Effects tangents (⅙ linear side) | KEEP | Lottie serialized outgoing/incoming coordinates are independent literal AE/Bodymovin cubic coordinates 1/6,2/3,1. Scalar evaluator can pass while exporter drops or reverses these tangents. |
| 3D Orientation follows the per-side progress | REWRITE | Quaternion Orientation half-time matrix diagonal 0.5397158767532739 is derived independently from cubic progress 0.6370633395427247 and cos(theta), replacing segmentProgress/bezierProgress calls shared with production. Catches orientation ignoring sides even when scalar evaluation works. |
| property: Sound Design dips keep per-side volume curves outside the dips | CONSOLIDATE | Extend existing 300-run sound-p4v-mix curved-dip owner with valid legacy/explicit incoming types; both normal and reversed2× lanes keep unchanged/minimum/unwrite oracles. Remove separate 150-run one-lane duplicate. |
| simplify keeps a per-side segment arriving at the simplified span | KEEP | Public simplifier must actually reduce keys while preserving all arrival samples outside selected span and requested error. This detects dropping retained incoming ease; direct evaluator math and ordinary simplifier fixtures do not modify a per-side boundary. |
| effect.add keeps a valid incoming side and refuses an inconsistent one | KEEP | Public effect.add preserves a valid incoming key and rejects inconsistent Auto with E_INVALID_PARAM. keyframe.add has a separate schema/constructor and cannot own pasted effect-param payloads. |
| effect presets carry the incoming side (Save Preset → Apply) | REWRITE | Effect preset save/JSON parse/apply must retain literal incoming enum and sampled source curve after offset placement. Replaces source-derived enum expectation with literal [undefined,bezier]; other copy/paste protocols do not pass through preset schema. |
| re-timing onto a reversed clip mirrors per-side keys exactly (multicam, Paste Grade) | KEEP | Actual retimeAnim affine reversal and public retimeKeyframes cross-clip placement preserve a per-side curve at mirrored content coordinates. Metamorphic preservation law is independent; private reversal-helper table is redundant to this real caller boundary. |

### packages/project/test/keyframe-sides.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| matches the golden recorded from the previous evaluator bit for bit | REWRITE | Frozen samples from pre-feature commit 27363576 independently protect no-inInterpolation compatibility across scalar/vector/spatial/roving documents. Remove fixture-size/member inventory assertions; fixture bytes and all sampled outputs remain. |
| property: every sample equals the legacy formula exactly (Object.is) | DELETE | Copied previous implementation reuses current autoSlope and bezierProgress, so oracle is coupled; frozen pre-change golden already owns exact legacy compatibility. |
| property: a mixed segment is the After Effects cubic of both sides | KEEP | Independent value-unit cubic/bisection covers mixed explicit temporal sides, stale stored Linear eases and varying endpoints. Public evaluate output catches incorrect1/6-side influence; golden contains legacy reading only. |
| Premiere's Ease In after a Linear key: (⅙, ⅙) and (⅔, 1) — the eased side now counts | DELETE | Fixed Ease In case duplicates the stronger independently solved mixed-side property and command Ease In behavior; no unique failure remains. |
| Ease Out (bezier out) into a Linear incoming side uses ⅙ for the linear side | DELETE | Fixed Ease Out case duplicates mixed-side math property plus actual command Ease Out; no unique failure remains. |
| two explicit Linear sides are exactly linear; a Hold outgoing side holds whatever the incoming side | REWRITE | Public evaluate returns literal linear sample18.5 and Hold sample0 despite a curved incoming side. Remove SegmentShape/effectiveInInterpolation private representation assertions; Hold override is not covered by linear/Bezier property. |
| Auto Bezier sides keep their computed ease in per-side segments | REWRITE | Public samples at both sides of a local maximum compare to independently solved cubics with zero Auto speed. The old expectation called production autoSlope and only checked helper shape; this catches stale/nonzero Auto speed. |
| effectiveInInterpolation reads legacy keys after a Linear key as linear | DELETE | Private effectiveInInterpolation branch table duplicates agent description and legacy/explicit clipboard contracts; fails stable-seam and uniqueness. |
| roving runs use the fixed keys’ sides (per side when the end key is explicit) | REWRITE | Actual roving evaluate samples compare to independent fixed-end cubic in value units. Remove helper run-shape and production bezierProgress expectations; ignoring end-key incoming ease fails the retained output oracle. |
| reversal mirrors a mixed segment exactly (as legacy Bezier keys) | DELETE | Private reversedKeyTiming reconstruction duplicates actual retimeAnim/retimeKeyframes preservation owner; fails stable-seam/unique-owner requirements. |
| keySidesIssue flags unknown and inconsistent incoming types | DELETE | Private keySidesIssue table duplicates public INV-011/refusal/repair/load boundaries; exact error strings are incidental. |
| normalizeKeySides drops unknown types and turns one-sided Auto / Continuous into Bezier | CONSOLIDATE | Move uniquely necessary Hold+Continuous incoming repair assertion into public repairDocument owner alongside unknown incoming and Auto-out/Linear-in cases. Delete private normalizer calls and implementation self-consistency fuzz; public idempotence/serialized outcomes remain. |

### packages/project/test/sound-p4v-mix.test.ts

| Original declaration | Outcome | Reason / surviving owner |
| --- | --- | --- |
| clearing A then B (overlapping stop-befores) gives the fader ride back exactly | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| moving A then removing both leaves no ghost dip | OPTIMIZE | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| two overlapping builds on one filter: removing the first then the second leaves no keys and no filter | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| property: overlapping stop-befores and builds added, moved and removed in any order give the lanes back exactly | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| outside the dip the Bézier curve is unchanged (no swell clipped), eases kept, removed exactly | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| two Bézier keys 6 s apart on a shared music clip: applying and placing work (no E_LIMIT), the clip curve is kept | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| automation too dense to record: explicit apply refuses E_LIMIT, placing skips it with a warning | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| outside the dips the curve is kept (to 0.05 dB on rebuilt curves), inside = min(curve, dip), keys outside kept, exact unwrite | CONSOLIDATE | Surviving public mergeDips owner now generates legacy and valid explicit incoming types in the same 300 runs/two lanes, retaining exact undo/minimum/outside-curve and historical counterexample. Replaces new 150-run one-lane duplicate without increasing run count. |
| both parts are in the records: clearing the stop-before / build restores both | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| on the copy, clearing the stop-before removes the dip; the original keeps its own | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| repair renames mix.cues with a re-identified cue and prunes stale records; idempotent | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| moving a realised cue over music on a locked track does not fail the edit | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| deleting a cue whose dip sits on a locked track keeps an orphan record, settled exactly on unlock | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| a default-level SFX on a locked track keeps its gain and is reported | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| does not sweep back down at the clip end | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| a filled cue with ambience: mute → the lanes before, unmute → the realised lanes (ambience kept); immutability | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| an unfilled cue applied by hand comes back after unmuting | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| never write keys at negative times | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| removeBus gives back the document before ensureBus | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| ensureBus again keeps hand-tuned send levels and send automation; a retargeted send stays on removeBus | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |
| a type-default ducking depth is set by the delivery (music 14 LU under the voice); a user depth is kept | KEEP | Unchanged contract/oracle; retain the previous per-test independent source, observable failure, stable public boundary and distinct-owner justification in [the previous per-test ledger](project-sound.md). |

## Validation and performance

The root integrated incoming baseline ran before edits: five failures in `ease-sides.test.ts`,
all calls to private ease-segment functions no longer exported from the project barrel.
The three pure helper probes failed at their removed entry points; two meaningful command/clipboard
cases failed in their private read-back/expected-value code. The command behavior was retained
through independent outputs; no production export or behavior changed to satisfy those tests.

An initial new clipboard expectation used exact equality for the independently calculated 5/6
slope. Real flick arithmetic differed by one floating-point rounding step
(0.8333333333333335 vs0.8333333333333334). The original 12-digit approximate assertion was retained
with the independent 5/6 oracle; this is not a product failure or relaxed original tolerance.

Actual Node 20.19 / pnpm 10.34.5 / two-worker targeted validation, mutations and TypeScript use own
worktree dependencies (`@jasper/audio-dsp` resolves to this worktree). Evidence lives under
`/tmp/jasper-test-cleanup/wave2-keyframes/`; source mutations were restored byte-for-byte and
are absent from the commit.

Final restored run: **100/100 passed in 9 files**,11.77s Vitest / 12.88 s GNU process wall,
zero failures or skips. Earlier successful100-case run took15.29s runner time before the final
literal-oracle and public-repair refinements; it is not an identical-final-source repetition.
Actual declared project source/test TypeScript passed after all changes. All three production
mutants exited1 for intended numeric disagreements (9.982 / 7.339 / 10.537 s wall); restored sources
then passed the complete 100-case target. The metric omission produced a 0.00002125336 normalized
position error at an outside sample; wrong Linear influence and raw-time roving likewise failed
actual output assertions. Scoped Biome and diff checks passed. The final commit contains zero
production changes.

Exact complete target (two successful runs, later source refinements disclosed below):

```sh
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 pnpm exec vitest run \
  packages/project/test/ease-sides.test.ts \
  packages/project/test/keyframe-sides.test.ts \
  packages/project/test/keyframe-sides-commands.test.ts \
  packages/project/test/keyframe-sides-consumers.test.ts \
  packages/project/test/keyframe-effect.test.ts \
  packages/project/test/ease-apply.test.ts \
  packages/project/test/ease-clipboard.test.ts \
  packages/project/test/anime-contracts.test.ts \
  packages/project/test/sound-p4v-mix.test.ts --maxWorkers=2

env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/project typecheck
pnpm exec biome check <the eight changed test files>
git diff --check
```

Mutation commands used the same Vitest worker configuration with the named file and `-t` filter:
wrong `AE_LINEAR_SIDE` influence 1/6→1/3 selects `property: a mixed segment`;
`rovingProgress` returning rawtime selects `roving runs use`;
actual `applyEase` omitting `groupMetric(g)` selects
`keeps outside Auto Bezier segments in layer pixels`.
All three failed intended numeric output assertions, not setup/import errors.

Removing duplicated generated dip executions avoids an extra 150-run one-lane property while
the existing 300-run owner covers both lanes and valid incoming sides. Clipboard preservation
now constructs201 reference samples once instead of 201 times, keeping every output assertion.
No robust wall-clock improvement is claimed from these short incoming targets: the root baseline
contained five immediate helper failures, final tests exercise real command outputs, and the
shared host runs another bounded validation slot. Full-suite/CI impact belongs to root's final
integrated measurement. Extended FUZZ/browser/export suites are not claimed by this target.
