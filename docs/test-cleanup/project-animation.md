# Project animation test cleanup

Scope: 39 files, 430 original test declarations (481 expanded cases). Tables below name every original case, including generated/table names. The baseline runner confirms 481 cases; the post-cleanup inventory has 460 cases, with all 144 cases in the 10 changed files validated below. Tests were reviewed with their production owner and the listed independent requirement; the disposition is not inferred from a filename or assertion pattern.

## Behavioral evidence convention

For each retained row, the test title states the exact claimed behavior and therefore the recognizable caller-visible failure it detects. The source, stable seam and independent oracle listed immediately above its table apply to that row. The oracle consists of authored inputs/literal outcomes, published math/wire facts, independent reference vectors or an explicitly required metamorphic invariant (immutability, inversion, continuity, shape preservation), rather than a private collaborator call graph. These seams survive behavior-preserving implementation changes. Each row protects its named operation/input class at the lowest complete owner: document commands, parser bytes, pure geometry/selector math or the snapshot/property protocol. UI/render tests protect different wiring/pixel contracts and do not supersede command refusal/serialization/math coverage. Specific duplicate owners and exceptions are identified in the rows. No public schema, migration fixture, Rust selector oracle or fault boundary was removed.

Risk: deleted tests lose implementation/inventory change detection; all independently identified contracts remain at the owners named below. Retained tests consume normal production exports; the removed ease-segments barrel had only one test consumer, while all production users import the internal module directly. `builtinEaseSource` remains a documented API/diagnostic used by the work note, so it was not deleted.

## Dispositions

### `packages/project/test/anime-contracts.test.ts`

Independent source: S11 TXA-002/004, SHP-001/003, ANA-001; ARCHITECTURE §20.1/D-32. Stable seam: loadProject, animation-window functions, intrinsic boxes and exportAgentSchema. Independent oracle: committed v4 bytes, hand-authored invalid fields, arithmetic window/box results, public agent keys.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| saved v4 fixture (animated text, anime template, rect + ellipse) loads without repairs (v4 → v6) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rejects malformed animators and shapes at load (schema), and flags them after edits (invariants) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| intrinsic box = largest size + the stroke drawn outside the geometry | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| scales reference-rate frames to the sequence rate (round, ≥ 1) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| compresses in + out proportionally when they do not fit the clip with one frame at rest | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps one frame at rest on 1- and 2-frame clips with both sides (the text shows) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| merges preset defaults for known presets and passes unknown presets through | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| lists text animations, template renderers and the kinds of every property | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/anime-templates.test.ts`

Independent source: S11 ATP-002/006/009 and FIX-005. Stable seam: applyTransaction, property schema/evaluation, buildRenderSnapshot and loadProject. Independent oracle: hand-authored template versions and upgrade function, literal interpolation samples/refusal codes and saved-field expectations.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| numeric (non-integer) and colour params are keyframable on anime templates only | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the stopwatch, param.set at frames and the keyframe commands work on params.<name> | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| integer, string and enum params and fframes template params stay static | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframes.prune, split and duplicate handle param keyframes (fresh ids, content time) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| evaluates template values and clamps an overshoot, ignoring static parameter keys | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the snapshot carries param keyframes for anime templates only (unevaluated) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| clip.update {template: {version}} migrates params, re-stamps and keeps compatible keyframes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| params in the same patch as an upgrade target the new version | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| re-stamps the renderer when a new version changes it (fframes → anime) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses downgrades, versions that are not installed and versions without a path; same version is a no-op | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses an upgrade whose version lacks the canvas the clip uses | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| accepts the same aspect at another size, the sequence canvas, and canvases the old version lacked too | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| flags a stamp that contradicts a known registry entry (unknown templates are left alone) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| repairs the stamps on load (loadProject with the registry) and drops malformed param keyframes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/auto-tangents.test.ts`

Independent source: docs/wp-notes/easing.md and S03 KF-030/031; proportional Auto Bezier rule. Stable seam: autoTangents. Independent oracle: unequal 90/300 chords, one-third lengths and next−previous direction; independent vector arithmetic.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| proportional: unequal neighbours give unequal handles along next − prev | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/composition-texts.test.ts`

Independent source: S08 MGC-036/037/038 and MGU-005. Stable seam: composition text discovery, checking and override APIs. Independent oracle: authored bundle schemas/manifests/text, literal issue codes, preserved sibling values and accent spans.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| a UI-hinted string is a text; colours and patterned strings are not | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| infers texts from plain strings and links style props by the object and prefix conventions | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| manifest declarations come first, set labels, limits and explicit style links; false hides a string | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the x-jasper-text schema annotation declares (or excludes) a text | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| static: schema length is an error, soft limits and stray line breaks are warnings | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| measured: off frame, clipped, ellipsis, outside the safe box, wrapped lines, not drawn | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| writes several values (text + style) into one override object, keeping siblings | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| splits *…* spans into runs that concatenate back to the value | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| resolves the accent colour from a literal or a colour prop | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/ease-apply.test.ts`

Independent source: docs/wp-notes/easing.md: keyframe.applyEase; S01 CMD-003/strict agent validation. Stable seam: applyTransaction and unknownCommandKeyIssues. Independent oracle: independent bisection CSS oracle, fixed command inputs, untouched pre-edit values and exact refusal/warning codes.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| two keys: the middle segment follows cubic-bezier exactly; keys become Bezier | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| one key: default sections in + out; sections pick segments exactly | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| neighbouring segments keep their shape: linear B with an Auto Bezier C, hold, continuous | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a hold A becomes Bezier; auto / continuous B keeps its out ease | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| roving: a segment touching a roving key is the run between the fixed keys | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| property: any neighbourhood — the target span is exact, all others unchanged | DELETE | Fails stable seam/refactor resistance: directly mutates internal key arrays through writeSpan. Public applyEase command tests keep independent CSS/neighbor/hold/roving checks; unused root helper barrel removed. |
| hold-only properties are skipped with a warning; only hold-only → refused | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| locked tracks refuse with E_TRACK_LOCKED; unknown ids with E_NOT_FOUND | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the previous document is untouched (undo) and re-applying is deterministic (redo) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| 3D Orientation: an overshooting curve warns that the overshoot is clamped | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| schemas export to JSON Schema and strict key checks reach inside curves | REWRITE | Removes implemented-flag inventory; keeps nested input strictness and asserts E_SCHEMA + curve path + command index, preventing an unrelated error from passing. Surviving name: `strict agent key checks identify an unknown key inside an ease curve`. |

### `packages/project/test/ease-clipboard.test.ts`

Independent source: docs/wp-notes/easing.md: copyEase/pasteEase, copyValues/pasteValues, velocity. Stable seam: copyEase/copyValues/describeKeyframeEases and applyTransaction. Independent oracle: authored clipboard/ease values, signed speed/duration arithmetic, independent CSS samples and exact command refusals.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| one key copies its two eases; pasting sets both sides of every target key | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| segments: one curve goes onto every target segment; n curves in order with a count warning | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a copied multi-key curve pastes as a multi-point rebuild unless mode is "segments" | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses an ease copy from non-adjacent keys of several properties; reads locked tracks | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| pastes in order (property, then time), keeping times and eases; validates like keyframe.update | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| speed ↔ slope through the segment average speed (numbers, signed) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| point properties: px/s along the curved path; round trip through describe | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| roving keys refuse a speed of their own | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| segments report cubic-bezier curves per section | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/ease-curve.test.ts`

Independent source: W3C CSS cubic-bezier; docs/wp-notes/easing.md curve storage contract. Stable seam: curve conversion, schema and evaluation APIs. Independent oracle: independent 200-step CSS bisection, literal Bézier handles/endpoints and malformed curve fixtures.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| a converted cubic evaluates like CSS cubic-bezier | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| round-trips stored eases exactly | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Easy Ease is cubic-bezier(1/3, 0, 2/3, 1) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| stores a handle at x = 0 at the minimum influence, keeping finite slopes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| validates multi-segment curves | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| evaluates cubic curves like CSS and multi curves through their points | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/ease-fit.test.ts`

Independent source: docs/wp-notes/easing.md: fitter API, tolerances/limits and typed refusals. Stable seam: fitEaseCurve, fitCubicEase and easeCurveMaxError. Independent oracle: authored polynomial/trigonometric functions, literal accuracy/limit/error contracts; analytic max |x−x²|=¼.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| returns the exact cubic for cubic polynomials (Hermite handles) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| recovers a cubic-bezier given as a function within the tolerance | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| fits oscillating functions with a multi curve whose points sit on the turning points | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| handles kinks and vertical tangents (bounce contacts, circular arcs) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| honours a smaller tolerance with more points | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| uses an analytic derivative when given | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is deterministic | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses nonfinite, out-of-range and wrongly anchored functions with typed errors | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses bad options | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses with E_LIMIT when the tolerance needs more than maxPoints points | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| property: smooth random functions fit within the tolerance or are refused, never invalid | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| property: arbitrary (also wild) functions never yield an invalid curve | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| property: random cubic-beziers come back as a single cubic | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| finds a close single cubic and keeps x1, x2 in [0, 1] and y in range | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses nonfinite functions | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is 0 for the identical function and ∞ for a NaN one | REWRITE | Replaces evaluator self-comparison with independent max \|x−x²\|=¼; retains nonfinite-source infinity and invalid sample-count fallback. Surviving name: `measures the analytic maximum error and reports nonfinite sources`. |

### `packages/project/test/ease-multi.test.ts`

Independent source: docs/wp-notes/easing.md: multi-point rebuild and spatial-path preservation. Stable seam: applyTransaction + evaluate. Independent oracle: authored overshoot/bounce/elastic curves, preserved original path, independent polyline distances and literal warnings.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| overshoot: inner keys replaced, the motion equals the curve within 1e-6 (normalised) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| bounce: inner keys replaced, the motion equals the curve within 1e-6 (normalised) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| elastic: inner keys replaced, the motion equals the curve within 1e-6 (normalised) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a piece with equal end values is made linear with W_EASE_FLAT_SEGMENT | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| values clamped by the property range warn W_VALUE_CLAMPED | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses equal end values, a single key, and sections without middle | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| roving keys in the span are cleared with a warning | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| overshoot: the drawn path is unchanged and the timing follows the curve by arc length | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| bounce: the drawn path is unchanged and the timing follows the curve by arc length | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| elastic: the drawn path is unchanged and the timing follows the curve by arc length | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/ease-path.test.ts`

Independent source: docs/wp-notes/easing.md: Clean Up Path and controller refusals. Stable seam: applyTransaction + evaluated motion. Independent oracle: authored semicircle, bidirectional path distances, fixed half-way positions, immutable outside samples and refusal codes.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| keeps the drawn path within the tolerance with far fewer keys, linear timing, outside untouched | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| two keys only lose their easing; non-point properties are refused | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| needs one point property of a clip and refuses to overwrite an expression | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/ease-presets.test.ts`

Independent source: docs/wp-notes/easing.md: W3C/Penner/Material and documented physics formulas/API. Stable seam: builtinEasePresets/evaluateEaseCurve, physics functions, matchEasePreset and read-only catalog. Independent oracle: independently written Penner equations, published CSS/Material numbers, analytic peaks/restitution/envelopes and authored matcher probes.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| has unique, stable ids in known groups, and every group is used | DELETE | Fails refactor resistance/independent oracle: catalogue inventory and hard-coded count. Published CSS/Material/Penner/physics output vectors remain. |
| validates every preset with EasePresetSchema | DELETE | Fails independent oracle: production declarations validated against their own schema. Actual command curve validation and fitter invalid-input properties remain. |
| matches every source function within 0.002 on 10 000 samples (measured figures in the log) | DELETE | Fails independent oracle: expectations are production builtinEaseSource functions; 790,000 evaluator/source comparisons add no independent requirement. Independent Penner and published-token/physics tests remain. |
| Penner presets match independently written Penner equations within 0.002 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Basic presets match the keyframe model (Linear, Easy Ease, Ease In / Ease Out) and CSS keywords | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Material presets carry the published token values | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| overshoot presets peak at their amounts | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| bounce presets follow the restitution model: contacts at 1, apex heights e^(2k) | REWRITE | Checks actual fitted catalogue curves against physical contact/apex equations at the documented 0.002 fit tolerance; removes incidental number-of-control-points assertion. |
| elastic and spring sources end exactly at 1 and stay within their envelopes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is deterministic: refitting every source gives identical curves | DELETE | Fails oracle/stable seam: repeats catalogue builder fitting strategy and exact curve structure. Representative fit determinism remains in ease-fit. |
| exposes BUILTIN_EASE_PRESETS as a read-only array view of the cached catalog | REWRITE | Removes array/proxy/cache identity inventories; keeps public read-only mutation refusal with an independent TypeError expectation. Surviving name: `refuses mutation of the public read-only preset catalog`. |
| builds within the budget (cold, first read; measured figures in the log) | DELETE | Fails independent contract/reliability: arbitrary 5ms cached getter deadline and duplicate fitting cost; diagnostic cold-build measurements are not a behavioral oracle. |
| finds each built-in preset from its own curve | DELETE | Fails independent oracle/unique protection: production catalogue supplies both curve and expected id. Authored matcher ambiguity/tolerance/equivalent-representation cases remain. |
| matches whatever the representation (a cubic written as a two-piece multi curve) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| returns null for a curve far from every preset and honours the list and tolerance | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| prefers the closest of several matching presets | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/expressions.test.ts`

Independent source: docs/wp-notes/expressions.md; S01 expression storage, command immutability and snapshot contracts. Stable seam: applyTransaction, effect-preset serialization, property paths, snapshot and repair APIs. Independent oracle: authored expression strings and original values, serialized public paths, literal errors and repair outcomes.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| set, disable, clear: stored on the Animatable, the input document untouched | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| effect params, Source Text, masks, transitions | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refusals: static properties, faders, audio effects, template params, missing expression | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| effect.rename | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| expressions travel with duplicated / pasted effect params | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| carry expressions of intrinsic properties and effect params | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| are passthrough, applied with clip-centred points, and left out of render snapshots | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| 3D points validate as three numbers | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| snapshots carry the world only with active expressions; unbound evaluation is the keyframed value | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| ParamPath ↔ ExpressionRef round trip for every expression location | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| invariants flag and repair drops malformed or misplaced expressions | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/keyframe-effect.test.ts`

Independent source: S01 FX-020…023, KF-003…007, AC-06/08/10; S03 PRP-001…003/FX-040. Stable seam: applyTransaction, evaluate, native filter protocol and property schema APIs. Independent oracle: authored commands, independent Bézier table/transfer formula, literal FFmpeg strings and public schema keys.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inserts at an index, validates and clamps params, refuses unknown ids and wrong targets | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| validates animated param overrides (pasted/agent keyframes) field by field | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses video effects on audio clips and edits on locked tracks | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| removes, reorders and bypasses; reorder clamps the index | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| supports track and master targets with an audio effect registry | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| FX-022: unknown effects are preserved, reorderable, removable and not editable | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| auto-bezier updates after a neighbour moves and preserves its curve when changed to bezier | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| continuous bezier keeps equal velocity on both sides of a key | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframes.prune removes keys that cannot affect the visible range (S01:KF-006) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe commands on track and master parameters use sequence time | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe edits on a locked track are refused atomically | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| maps crop, directional blur and flips to the native FFmpeg protocol | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| brightness/contrast preview transfer equals the canonical formula | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| exports a JSON Schema per clip including applied effect params | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| generates motion-graphic params.* specs from the template schema with defaults | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| resolves values at the playhead, computes reset values and picks the write command | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| effect param specs map to ParamPaths the handlers accept | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/keyframes-ease-precision.test.ts`

Independent source: S01 KF-003/004; EffectCraft overlapping-influence reference and recorded AE 26.3x87 samples. Stable seam: bezierProgress and evaluate. Independent oracle: independent 320-bit fixed-point bisection, analytic singularity formula, externally recorded numeric vectors.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| matches the exact reference to 1e-9 over random eases | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| resolves the flat midpoint of 100 % / 100 % influence (closed form) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is accurate next to the flat midpoint (influences just under 100 %) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| was the old 1.6e-4 error case: 100 % / 100 % near u = 0.5 | CONSOLIDATE | Duplicate 2001-point BigInt grid; retained exact closed-form test covers singular midpoint plus 0.5±1e−12/1e−9 and retains 3000 independent random fixed-point cases. |
| 0 → 100, out 0/0.8, in 0/0.8 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| 0 → 100, out 20/0.8, in 80/0.6 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| 100 → 0, out -20/0.6, in -80/0.8 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/keyframes.test.ts`

Independent source: S01 KF-003/004/007 and AC-08. Stable seam: evaluate and bezierProgress. Independent oracle: literal scalar/vector/color midpoints and hold values, analytic monotonicity/overshoot bounds and reference table.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| returns the static value without keyframes and clamps outside the range | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| linear at u = 0.5 gives the midpoint (numbers, vectors, colors) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| linear preset equals p = u | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| hold gives a step | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| hold-only value types step regardless of interpolation (S01:KF-007) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| auto-bezier on a local maximum does not overshoot | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| auto-bezier keeps a monotonic ramp smooth and bounded | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| overshooting eases are clamped to the parameter range when asked | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| matches a table of reference values | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/masks-path.test.ts`

Independent source: docs/wp-notes/masks.md; ported EffectCraft path/interpolation/trace contracts. Stable seam: Bezier path operations, evaluate and tracePaths. Independent oracle: ellipse equation/area, rectangle corners/perimeter, independently rasterized occupancy and fixed vertex/rotation results.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| flattens an ellipse onto the ellipse | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| polygons flatten to their corners | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inserting a vertex keeps the outline; removing and converting vertices | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| nearest point, transforms, reversal and rotation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| splitting keeps the outline | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| correspondence finds the rotation and vertex paths do not cross | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rigid interpolation turns instead of collapsing | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Mask Path keyframes: vertex-wise for equal counts, smart matching otherwise | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| traces a disc and a square with a hole | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| minimum area, threshold and edge-touching shapes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/masks-raster.test.ts`

Independent source: docs/wp-notes/masks.md: pixel coverage/feather/modes. Stable seam: prepareMasks/packMasks/rasterizeMaskPack. Independent oracle: literal pixel coverage, analytic ellipse area, monotone/symmetric feather and arithmetic opacity/scale.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| a hard rectangle is exact box coverage | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| an ellipse area matches the analytic area | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| feather is a symmetric distance falloff centred on the edge | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| expansion, inversion, opacity and modes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| variable feather points (outer on top, inner at the bottom) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| px scale converts feather and expansion | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a fixed stack of every feature rasterises to the stored checksum (8-bit, 160×90) | DELETE | Fails independent oracle/refactor resistance: opaque implementation-produced hash/sum. Analytic pixel/area/feather/mode tests remain; orphan snapshot removed. |

### `packages/project/test/roving.test.ts`

Independent source: S01 roving keys; docs/wp-notes/easing.md; recorded EffectCraft constant-speed case. Stable seam: evaluate/retimeRoving, commands and repair. Independent oracle: 300/400 distance ratio, 200 px/s speed, fixed endpoint values, continuity and literal repair/command outcomes.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| linear ends: constant speed through the run and times proportional to the distance (EffectCraft case) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| ignores the stored time of a roving key: the value depends on the run only | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| eased fixed keys shape the whole run (one ease across the roving keys, smooth speed) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| first / last / hold keys never rove; runs are split by fixed keys | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| property: key values are passed at the stored times, runs are continuous | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.setRoving re-times the key; first / last are refused with a warning | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| dragging a roving key in time turns roving off and keeps the speed through it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| repairDocument drops roving flags on keys that cannot rove | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/shapes.test.ts`

Independent source: S11 SHP-001/003/004; docs/wp-notes/wp-m2-shapes.md review findings. Stable seam: applyTransaction, shape geometry/hit-testing, snapshots and public property schemas. Independent oracle: authored shapes and edits, literal dimensions/colors/positions, analytic circle membership and fixed historical failure vectors.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| defaults: 400×400 at the sequence centre, white fill, no stroke, radius 0, 5 s, graphics label | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| takes size, fill, stroke, radius, transform, duration and name | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| validates colours, sizes and the rectangle-only corner radius | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| places like text: overwrite on the target track, creates missing tracks, refuses locked tracks | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| merges fill, stroke and radius; null removes fill / stroke | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| accepts Animatables; a static value replaces keys; validates every key | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses cornerRadius on ellipses and shape patches on other kinds | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| param.set writes size, fill, stroke and radius; clamps negative sizes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframes on size, fill, stroke and radius go through the shared keyframe commands and evaluator | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| static size and stroke edits keep the geometry centre on screen | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframes that grow or shrink the largest size move the anchor (value and keys) by half | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| flags colours outside 0..1 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| snapshot carries the unevaluated shape, its box and the Remotion engine | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| properties: corner radius for rectangles only; all shape keys are listed for agents | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| evaluates and clamps, centres the geometry in the box, drops zero-width strokes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| hit-tests the drawn geometry: ellipse interior, rounded corners and the outer stroke band | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.move onto the largest key keeps the shape in place (finding 1) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.move deleting the widest outside-stroke key keeps the shape in place | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| once keyed, the box ignores a stale static value (size and stroke width, finding 2) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| re-centring stays correct across static → animated → static with a stale value | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| only an explicit value creates a "None" fill or stroke; the stopwatch on None is refused (finding 3) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/spatial.test.ts`

Independent source: S03 KF-021/030/031, OVL-020; S01 MIG-005; §12.5 copy semantics. Stable seam: evaluate, spatial geometry API, commands and loadProject. Independent oracle: linear interpolation, analytic tangent rules, independent million-step arc reference samples, committed v5 bytes and original copied values.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| keys without spatial data (and linear keys) evaluate exactly like the component lerp | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| two Auto Bezier keys move on the straight line exactly like linear ones | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Auto Bezier tangents are Catmull-Rom (next − prev) / 6; the path passes through every key | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Linear temporal keeps a constant speed along the curve (arc-length reparameterization) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| pathPointAt maps progress to arc length; a symmetric arc has its arc midpoint at t = 0.5 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| temporal easing controls the speed along the path | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Bezier / Continuous keys use their stored tangents; a linear neighbour contributes none | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| new position / anchor keys are Auto Bezier spatial with Linear temporal; other vectors stay plain | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| corner pin corners are points whose new keys stay straight | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.setSpatialInterpolation: Linear zeroes, Bezier starts from the auto tangents, Continuous aligns | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.setTangents: auto → continuous (other side opposite), Alt breaks, Bezier stays independent | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframe.add / keyframe.update accept spatial data | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframes.simplify keeps a curved path within the tolerance (verified with the evaluator) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a document written before spatial interpolation loads unchanged and evaluates as before | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| split keeps the curve on both halves (new ids, tangents kept) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| duplicate, keyframe paste and paste attributes keep the tangents | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| paste attributes onto a reversed clip traverses the path backwards (tangents swap) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/text-animation.test.ts`

Independent source: S11 TXA-002…009, ANA-007, FIX-004. Stable seam: applyTransaction, loadProject, snapshot/property/agent APIs. Independent oracle: authored animators, literal window/version/error/repair fields and fixed split/frame-rate behavior.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| common params are bounded (stagger 0…1, units, orders, eases) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| writes both sides: params = defaults ⊕ given, window = default scaled to the sequence fps | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses unknown presets (E_UNKNOWN_EFFECT) and bad params (E_INVALID_PARAM with the path) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| warns W_ANIMATION_COMPRESSED when in + out exceed the clip (no invariant failure) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| replaces a side with preset (params reset), merges without preset, removes with null | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| validates: merge without a side, bad params, non-text clips | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| applies to many clips in one transaction (clipIds) and warns when it compresses | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps unknown presets (durations editable, params refused) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| new animations get @2 with its defaults; saved @1 animators keep their version, params and snapshot | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| razor: left keeps In only, right keeps Out only; undo-free copies stay independent | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| duplicate copies the animators; trims keep the windows and warn when they compress | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a sequence frame-rate change remaps the windows (round, ≥ 1) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| exports dynamic text animation parameter schemas for the selected preset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| param.set writes presets, windows and params through clip.update (validated as a whole) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| FIX-004: param.set on layout-affecting text style fields re-runs layout like clip.update | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| flags and repairs invalid params of known presets; unknown presets are kept | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the snapshot carries resolved, compressed animators; styled runs load their faces | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| agent queries report text animation and shape/composition sources | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/text-animators-maths.test.ts`

Independent source: docs/wp-notes/text-animators.md; permissive EffectCraft selector/path port. Stable seam: text selector/path/substitution/color math APIs. Independent oracle: committed independently generated Rust oracle vectors, bounds/permutations, literal Unicode/HSV/rounding facts.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| range_value for every shape, ease and smoothness | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| ease high / low | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| SplitMix64, Randomize Order permutations, value noise and wiggly are bit-exact | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| mode initial values and combine | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| path measure, placement and arc positions | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| shapes stay within 0…1 and ramps hold outside the range | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| ease is monotonic for every high/low | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| random order is a permutation for every n and seed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| wiggly respects asymmetric min / max bounds | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| combine always stays within −1…1 | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Preserve Case & Digits cycles within letters and digits | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Full Unicode moves through code points; Character Value blends towards a code point | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rounds half away from zero like Rust | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| HSV round-trips and colour adjustments | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/text-animators.test.ts`

Independent source: docs/wp-notes/text-animators.md: commands, selectors, typography, preset phases and Source Text. Stable seam: applyTransaction, public property registry, load/repair and charTransforms. Independent oracle: authored commands/selectors/fonts, literal companion fields/refusal codes, phase boundaries and [0,0,0,0]→[100,100,0,0]→[100,100,100,100] reveal.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| adds an animator with AE companions and a Range Selector, addressable by ref in the same transaction | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rejects unknown entries and non-text clips | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| every menu entry adds properties; per-character 3D adds Z and X/Y rotation companions | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| selectors: add / update / reorder / remove; static fields via param.set; values clamp | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keyframes on animator properties and selector fields work with the generic keyframe commands | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| update, duplicate (fresh ids), remove property and animator | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| variable font axes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the property registry exposes every animator key for the clip | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| every preset applies cleanly; Out presets end on the clip end, loops cover the clip | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| durationFrames scales the keys; replace drops existing animators; unknown preset fails | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| works on reversed clips (keys sorted, in range) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| text.setPathOptions on a mask; margins keyframable; mask removal resets to Path: None | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| More Options are created on first write | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Source Text hold keys: stopwatch, keys at times, validation, snapshot and fonts | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| flags and repairs malformed animator data | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a typewriter preset evaluates to a left-to-right reveal | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| param.set writes the style through clip.update with read-time defaults | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| registers a family once and is usable as a fontId ref | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-camtrack.test.ts`

Independent source: docs/wp-notes/three-d.md: camera tracker/world mapping and supported footage constraints. Stable seam: tracker commands, trackPointsAt, snapshots and camera projection. Independent oracle: synthetic authored camera/points, independent pinhole projection/plane perpendicularity, literal span/staleness and repair results.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| applies to a video clip with the shown media frames as the span; refuses other clips and a second tracker | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| commits a solve; deleting points or changing settings makes it stale; another span drops it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| projects the track points of a frame through the solved camera | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Create Camera: the camera sees every track point where the footage shows it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Create Text and Camera puts a 3D text layer in the plane of the selected points | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Set Ground Plane and Origin: the points lie on the horizontal plane through the frame centre | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses a camera for footage that is rotated or off-centre | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| invariants flag malformed solves; repair resets them and drops trackers without media | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-classic.test.ts`

Independent source: docs/wp-notes/three-d.md: Classic 3D; permissive EffectCraft bokeh cases. Stable seam: renderClassicCPU, bokehBlur/progressiveBlur and boostHighlights. Independent oracle: literal pixel colors/alpha, analytic depth/light sums and independent impulse kernel/conservation/threshold expectations.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| a plane at its defaults is drawn exactly where its 2D Motion puts it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the nearer plane wins whatever the stack order; intersecting planes split along their intersection | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| coplanar planes keep stack order; blend modes apply in depth order | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| lights: no lights = unlit; a parallel light facing the plane lights it by diffuse·N·L + ambient | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| ray-cast shadows: a caster between a light and a receiver darkens it; Light Transmission tints it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Accepts Shadows: Only draws just the shadow | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| depth of field: a plane at the focus distance stays sharp, a farther one is blurred | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| kernel shapes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| diffraction fringe brightens the rim | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| highlights boost only above threshold | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| progressive blur follows the radius map | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-commands.test.ts`

Independent source: docs/wp-notes/three-d.md: supported layers, cameras/lights and renderer setting. Stable seam: applyTransaction, public properties, snapshots and transition resolver. Independent oracle: authored clips/commands, literal refusal flags, lens f/sensor math, preserved camera distance and light/scene outputs.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| turns the 3D Layer switch on with After Effects defaults, off keeps the values | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses kinds without Motion and clips with transitions; transitions are refused on 3D layers | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| locked tracks refuse | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| 3D properties are keyframable through param.set; registry rows appear only on 3D layers | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| clip.addCamera: a two-node 50 mm camera on top that frames the sequence like the default camera | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Camera Settings: preset, focal length, angle of view, f-stop, lock to zoom, one-node | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| camera tools: orbit keeps the distance to the point of interest; pan moves both; dolly approaches | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| clip.addLight: types, settings, environment media validation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| disabled and hidden-track lights are off | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| 3D runs across tracks; a 2D layer between them splits them; sequence.set3dRenderer | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a transition kept in an old document on a 3D layer is skipped with a warning | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-extrude.test.ts`

Independent source: docs/wp-notes/three-d.md: Advanced 3D extrusion; ported earcut contracts. Stable seam: earcut/contour/extrusion geometry APIs. Independent oracle: polygon area and Euler triangle counts, circle equation, independently welded watertight edge counts and outward normals.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| triangulates a square with a square hole (area = outer − hole) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| triangulates random star polygons exactly (property) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| traces a disc with sub-pixel accuracy | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| sorts a ring into an outline with a hole, and two discs into two shapes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a flat shape is its front face only; an extruded one is a closed solid with outward normals | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the bevel insets the faces by the bevel depth and the hole bevel by its percentage | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-hostile.test.ts`

Independent source: AGENTS §0 bounded allocation/cycle/typed failures; docs/wp-notes/three-d.md parser budget; glTF strict-tree/index rules. Stable seam: parseModel byte boundary. Independent oracle: small malicious byte fixtures, typed ModelParseError, bounded allocation, valid shared texture/deep tree controls.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| an accessor of 100 million zero vectors is refused with a reason, without the allocation | CONSOLIDATE | Six loose-budget rows duplicate precise zero-accessor/stride, instance-budget, malformed-index and strict-tree cases. Unique malformed data URI kept as explicit typed parser failure; unused HOSTILE_MODELS table removed. |
| a stride of 0 with a count of 100 million is refused with a reason, without the allocation | CONSOLIDATE | Six loose-budget rows duplicate precise zero-accessor/stride, instance-budget, malformed-index and strict-tree cases. Unique malformed data URI kept as explicit typed parser failure; unused HOSTILE_MODELS table removed. |
| nodes that share their children (8 ways, 14 levels) is refused with a reason, without the allocation | CONSOLIDATE | Six loose-budget rows duplicate precise zero-accessor/stride, instance-budget, malformed-index and strict-tree cases. Unique malformed data URI kept as explicit typed parser failure; unused HOSTILE_MODELS table removed. |
| 20 000 instances of a 30 000-vertex mesh is refused with a reason, without the allocation | CONSOLIDATE | Six loose-budget rows duplicate precise zero-accessor/stride, instance-budget, malformed-index and strict-tree cases. Unique malformed data URI kept as explicit typed parser failure; unused HOSTILE_MODELS table removed. |
| a broken data: URI is refused with a reason, without the allocation | CONSOLIDATE | Six loose-budget rows duplicate precise zero-accessor/stride, instance-budget, malformed-index and strict-tree cases. Unique malformed data URI kept as explicit typed parser failure; unused HOSTILE_MODELS table removed. |
| negative and fractional indices is refused with a reason, without the allocation | CONSOLIDATE | Six loose-budget rows duplicate precise zero-accessor/stride, instance-budget, malformed-index and strict-tree cases. Unique malformed data URI kept as explicit typed parser failure; unused HOSTILE_MODELS table removed. |
| a mesh shown by more nodes than the allowance covers is refused before any of it is decoded | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses non-finite, fractional, negative and out-of-range indices | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| an accessor of zeros and a stride of 0 cost nothing before they are refused | REWRITE | Adds missing typed ModelParseError assertion so silent acceptance cannot pass timing/allocation checks; exact resource limits remain. |
| counts that are not counts are refused: negative, fractional, text, missing | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| an image used by thousands of materials is read once | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a tree as deep as the limit reads; shared children at any depth do not | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses a malformed data URI with a typed model error (surviving row) | CONSOLIDATE owner | Malformed percent-encoded bytes must yield ModelParseError, never URIError; independent malformed wire fixture through parseModel. Other retained hostile rows cover allocation/index/tree failures. |

### `packages/project/test/three-d-models.test.ts`

Independent source: docs/wp-notes/three-d.md: glTF/GLB/OBJ and model-layer contracts. Stable seam: parseModel bytes, commands, snapshot and repair APIs. Independent oracle: authored GLB wire bytes/OBJ text, literal transformed triangle/normal/material/bounds, URI/extension refusal and model renderer warnings.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| reads a .glb: node transforms, indices, material, computed normals, bounds | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| reads a .gltf with an embedded buffer and refuses external files and compressed meshes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| reads an OBJ (quads fanned, negative indices, uv / normal references) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| places a model media as a 3D model layer that stays 3D | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the snapshot draws it with the 3D renderer and warns when the sequence uses Classic 3D | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| repair turns a model layer back into a 3D layer | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-scene.test.ts`

Independent source: docs/wp-notes/three-d.md §2 coordinates, lens, camera, falloff and 3D runs. Stable seam: world/projection/camera/light scene APIs. Independent oracle: 50mm/36mm lens arithmetic, literal projections/rotation/identity and active-layer/time ordering, independent inverse-square/smoothstep values.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| is the 50 mm preset at −zoom | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a 3D layer at its defaults projects exactly like its 2D Motion (property test) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| pushing a layer back (+z) makes it smaller; toward the camera bigger | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Y rotation of 90° shows the layer edge-on (no homography) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| X rotation tilts the top edge away (narrower) under perspective | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Z position / scale / anchor Z compose as T·O·Rz·Ry·Rx·S·T(−A) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Orientation interpolates along the shortest rotation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| orientationOfMat4 inverts mat4Orientation (property test) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| mat4Invert inverts world matrices | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a new two-node camera frames the sequence like the default camera | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the topmost camera that is on is active | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a one-node camera looks along its own +z (orientation turns it) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| lens relations: 50 mm = 2666.67 px at 1920; angle of view round trip | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a spot light is full inside the inner cone, off outside the outer cone | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inverse-square falloff is clamped inside Radius and falls as (r/d)² | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| smooth falloff: 1 inside Radius, smoothstep to 0 over Falloff Distance | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| consecutive 3D layers form a run; a 2D layer breaks it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/three-d-schema.test.ts`

Independent source: glTF 2.0 material/node/accessor wire format; AGENTS §0 entry validation. Stable seam: parseModel bytes. Independent oracle: authored malformed JSON scalars/fields, typed errors/nested paths, glTF material defaults and permitted extensions.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| refuses malformed material fields: {"pbrMetallicRoughness":{"baseColorFactor":"red"}} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"pbrMetallicRoughness":{"baseColorFactor":[1,0,0]}} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"pbrMetallicRoughness":{"metallicFactor":"shiny"}} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"pbrMetallicRoughness":{"roughnessFactor":null}} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"emissiveFactor":[0,0,"blue"]} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"alphaMode":"TRANSPARENT"} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"alphaCutoff":"half"} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed material fields: {"doubleSided":"false"} | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses malformed node matrices instead of discarding the transform | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| identifies the nested field that failed validation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rejects non-object material values for arbitrary JSON scalars | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps optional material defaults and ignores unused extension metadata | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/boolean-retry.test.ts`

Independent source: AGENTS §0 failure containment; docs/wp-notes/shapes.md robust boolean operations. Stable seam: merge with a fault injected only at external path-bool boundary. Independent oracle: independent union area 17,500 and original-frame corners; empty safe result on repeated dependency failure.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| retries in a rotated frame and returns the same geometry | REWRITE | Removes private injected failure-counter assertion; keeps independent union area/original-frame geometry after a dependency failure. Surviving name: `preserves the geometry after a geometry-library failure`. |
| gives up with an empty result (never a throw) when the retry fails too | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/commands.test.ts`

Independent source: docs/wp-notes/shapes.md: vector command, conversion and persistence contracts. Stable seam: applyTransaction, evaluated shapes, snapshot and repair. Independent oracle: authored vector/SVG data, literal keyframes/transforms/refusals, original picture preservation and invariant/repair outputs.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| creates a frame-sized layer whose contents sit around the frame centre | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| takes a preset and refuses rect fields, unknown presets and bad items | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| builds every preset into valid contents | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| expands SVG path data with several subpaths into several path items | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| adds, groups, moves, duplicates and removes items | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| updates items: static values, enums, dashes / taper / wave, validation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| animates item fields through param.set and the keyframe commands | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| animates paths and gradients between keyframes | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps the picture: geometry, paint, keyframes and screen position | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| flags malformed items and duplicate ids; repair fixes them | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/evaluate.test.ts`

Independent source: docs/wp-notes/shapes.md: paths/paints/operator stacking and public shape queries. Stable seam: evaluateVectorShape, hit/bounds queries and editing commands. Independent oracle: authored stacks, literal colors/lengths/opacity/order, analytic bounds and before/after shape geometry.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| rectangles start at the top right and run clockwise; reversed runs the other way | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| ellipses start at the top; polystars have 2n vertices with the first point up | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a Trim Paths below a stroke still trims it; paths below a paint are not painted by it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| operators reach the paths of nested groups (in the group space they live in) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| items higher in the list draw on top; composite "above" lifts a paint over the paints before it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Merge Paths merges the paths above it and drops the paints above it | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| Repeater copies paths and paints with a compounding transform and an opacity ramp | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| group opacity multiplies; a group blend mode chains the group (copies are separate instances) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| disabled items are skipped; paths honour their direction for trims | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| bounds, hit-testing and item matrices | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| time dependence: keyframes, expressions and self-animating Wiggle Paths | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| turns a polystar into a path with the same geometry at that time | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| moves, inserts, converts, removes and closes vertices; keyframed paths get keys | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/ops.test.ts`

Independent source: docs/wp-notes/shapes.md; ported EffectCraft path operations; set/Euclidean geometry identities. Stable seam: trim/offset/merge/wiggle/path operation APIs. Independent oracle: independent square/circle area/perimeter, inclusion–exclusion, literal displacement/orientation/phase bounds and pinned tangency cases.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| trims half a square, with and without offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps an empty slot | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is one piece across the start of a closed path | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| simultaneously trims each path by its own length | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| individually trims sequentially | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| reverse flips orientation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rounds a square like the rectangle roundness | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| clamps to half a segment | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps open endpoints when rounding corners | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| grows a square with a miter | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| round and bevel joins | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| negative shrinks | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| circle offsets preserve the analytic area | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is independent of orientation | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| copies | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| outlines an open path | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| bloat moves vertices inwards and bulges | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| pucker moves vertices outwards | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rotates by distance | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| keeps a centred circle round | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| zigzag coordinates follow amplitude and alternate sides | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| is deterministic and time varying | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| spatial phase shifts the pattern continuously | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| displacement is bounded | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| full correlation translates | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rect inclusion-exclusion | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| edge cases | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| fill rules | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a circle resting on a square edge | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| circles tangent to squares on every side and to circles inside and out | REWRITE | Removes 80 repeated circle-square inclusion–exclusion executions already owned by the pinned tangent regression and seeded 60-case tangent property. Retains all 16 circle-circle inner/outer/axis cases, which those tests do not cover. Surviving name: `circles tangent to circles inside and out, in every direction`. |
| inclusion–exclusion holds for random rectangles and circles (curve booleans are robust) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inclusion–exclusion holds for circles touching squares (tangencies are the hard case) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/svg.test.ts`

Independent source: SVG path/paint/transform syntax; docs/wp-notes/shapes.md; security PAR-1. Stable seam: parseSvgPath and svgToShapeContents boundaries. Independent oracle: authored SVG bytes, independent square/circle area, literal colors, affine multiplication and malformed character references.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| reads every command, relative forms and implicit repeats | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| compact syntax and arc flags without separators | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a circle from two arcs has the circle area | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| parses CSS colours | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| decomposes affine matrices exactly into group transforms | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| converts shapes, paints, groups and the viewBox | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| gradients: objectBoundingBox, stops with opacity, radial focal point | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| use, symbol, polygon, evenodd and stroke details | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| out-of-range and surrogate references become U+FFFD instead of throwing RangeError | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/tracer.test.ts`

Independent source: docs/wp-notes/shapes.md: Trim Paths tracer commands. Stable seam: shape.addTrimTracer transactions and returned/persisted clip metadata. Independent oracle: authored source/follower identities, exact spans/track choices/tip selection and refusal codes; evaluated expression ownership is packages/expressions/test/trim-tracer.test.ts.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| creates a dot clip on the track above over the same span, driven by an id-addressed expression | REWRITE | Removes generated source snippets/return-to-storage string self-comparisons. Keeps created clip type, exact span, source ids, track and absence of rotation; actual evaluated tips/rotation remain at expressions owner. |
| picks the tip whose keyframes change most (End on a tie), follows Individually trims along every path | REWRITE | Removes generated-expression formatting assertions; keeps public auto-tip choice, individual/simultaneous path selection. Evaluated geometry/rotation remains at expressions owner. |
| inserts a new track when the track above is busy or locked; drives an existing follower and warns on replace | REWRITE | Removes generated-expression substring check; asserts existing follower identity plus created:false and replacement warning, preserving caller-visible behavior. |
| refuses unknown items, non-trims, non-vector clips, foreign or locked followers and self-following | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses a trim with no path above it and a trim in a disabled group | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| without trimItemId follows the master trim, also in the same transaction as shape.animateTrim | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/trim-animate.test.ts`

Independent source: docs/wp-notes/shapes.md: Trim Paths animation semantics, replacement and undo. Stable seam: shape.animateTrim/reversePathDirection/addLine transactions and evaluated geometry. Independent oracle: hand-authored documented style table (not planner output), literal key times/values, preserved ids/items, exact refusal codes and undo snapshot.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| in | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| in with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| in reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| in reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| out | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| out with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| out reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| out reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inOut | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inOut with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inOut reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| inOut reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleIn | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleIn with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleIn reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleIn reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleOut | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleOut with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleOut reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| middleOut reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideIn | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideIn with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideIn reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideIn reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideOut | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideOut with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideOut reversed | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divideOut reversed with offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divide: N parts with fresh ids, the master in part 1, linked trims by id | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| divide reuses a single top-level group as part 1 (no wrapper) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| at, durationFrames, offsetDegrees, inOutLag and curve | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| default at is each clip start; fractional lag keys stay exact | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| speed and reverse speed: keys in content time, mirrored curve on reversed clips | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses an animation before the clip content | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| rejects out-of-range arguments at the schema | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses inOutLag 0 (nothing would ever be visible) and accepts the bounds just inside | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| in then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| out then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| inOut then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| middleIn then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| middleOut then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| divideIn then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| divideOut then every style | CONSOLIDATE | 98 command scenarios compare normalized internal trees against the same implementation on a fresh clip. Documented style vectors remain; surviving trim-reuse case explicitly checks old linked offset/end-key cleanup and id/mode preservation. |
| reuses the last top-level trim (id, name, mode) and re-enables it | REWRITE | Surviving consolidation owner: reapply after a reversed linked/animated-offset style, assert literal outgoing keys, static end/offset and cleared expression, then preserve master id/mode through divide. Replaces 98 self-oracle executions. |
| merges parts back when the user added items next to them | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| converts rectangle / ellipse clips in the same transaction | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| skips other clips with W_TRIM_SKIPPED and refuses when none apply | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses clips on locked tracks | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| caps divided item counts | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the earlier document is untouched and the edit re-applies identically | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| toggles every path item at all depths; twice restores the contents | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| the renderer honours the direction for trims | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| skips rectangle / ellipse and non-shape clips | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| a centred, stroke-only open line with its anchor at its centre | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| vertical, explicit options, default track rule | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| refuses bad arguments | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

### `packages/project/test/vector/values.test.ts`

Independent source: docs/wp-notes/shapes.md: gradient, taper/wave and dash contracts; EffectCraft vectors. Stable seam: gradient sampling/interpolation and variable stroke APIs. Independent oracle: literal halfway colors/alpha, analytic taper/wave samples and manually listed dash intervals.

| Original test declaration | Outcome | Evidence / remaining protection |
| --- | --- | --- |
| midpoints put the 50 % blend at the midpoint; opacity stops are independent | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| interpolates keys with different stop structures through resampling | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| taper and wave width profiles (EffectCraft cases) | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |
| dash intervals with several pairs and an offset | KEEP | Protects this distinct named behavior through the source/seam/oracle above; a change to that outcome fails the explicit assertions, while implementation-only rewrites remain free. |

## Cleanup and validation

Original expanded-case outcomes: CONSOLIDATE 14, DELETE 8, KEEP 448, REWRITE 11. A new explicit malformed-URI consolidation owner replaces the only unique row from the removed hostile table; it is also listed above. Final suite scope is 460 cases.

Removed infrastructure: one mask checksum snapshot, the unused HOSTILE_MODELS fixture inventory, catalogue timing/log scaffolding, generated-expression string helper, unused ease-helpers FRAME/expectClose/times exports, and the ease-segments package-root barrel exposure. Net test/helper/snapshot change: -287 lines; one unused package-root barrel line also removed. Internal production algorithms and all supported behavior remain unchanged.

The root baseline used Node 20.19.0, Vitest 4.1.11, two workers, required FFmpeg oracles and Chrome on the shared 8-vCPU AMD EPYC-Genoa / 15 GiB host. All 39 owned files / 481 cases passed. Full-repository baseline: 2109.71 s runner duration, with two unrelated baseline failures (engine cache permission simulation and composition canvas capture); see the root report for investigation and final gate results.

Measured baseline file execution (from the root JSON report; import/setup excluded):

| File | Baseline ms | Relevant redundant work |
| --- | ---: | --- |
| ease-presets.test.ts | 919.93 | production-source oracle 716.45 ms |
| keyframes-ease-precision.test.ts | 857.28 | duplicate BigInt grid 317.58 ms |
| ease-apply.test.ts | 473.50 | private writeSpan property 284.07 ms |
| vector/ops.test.ts | 1330.09 | repeated fixed tangency matrix 353.77 ms |
| vector/trim-animate.test.ts | 740.01 | 98 repeated command scenarios |

Post-change validation: all 10 changed surviving test files passed, 144/144 cases, without skips. Runner duration 14.20 s; measured process wall-clock 15.32 s. The other 29 owned files are unchanged and passed the original baseline; the root integrated gate owns their final rerun and cross-package typecheck.

| Changed file | Baseline execution ms | After execution ms |
| --- | ---: | ---: |
| ease-apply.test.ts | 473.50 | 90.97 |
| ease-fit.test.ts | 251.39 | 242.59 |
| ease-presets.test.ts | 919.93 | 174.94 |
| keyframes-ease-precision.test.ts | 857.28 | 586.28 |
| masks-raster.test.ts | 144.03 | 89.49 |
| three-d-hostile.test.ts | 405.67 | 290.88 |
| vector/boolean-retry.test.ts | 11.83 | 9.77 |
| vector/ops.test.ts | 1330.09 | 1173.46 |
| vector/tracer.test.ts | 92.02 | 91.55 |
| vector/trim-animate.test.ts | 740.01 | 272.08 |

These file execution costs exclude import/setup and come from separate bounded waves on the same host/toolchain. They diagnose removed work; they do not establish a same-command total-suite speedup. The root report measures the final full-suite wall-clock. Remaining costly tests are intentional: the independent 3000-case high-precision Bézier oracle and seeded curve-boolean/tangency properties protect numerical and geometry failures that the deleted inventories/self-oracles cannot detect.

Commands executed (Node 20.19.0 / pnpm 10.34.5 / Vitest 4.1.11):

```sh
export PATH=/tmp/jasper-test-cleanup/toolchain/node-v20.19.0-linux-x64/bin:/root/.local/share/mise/installs/node/24.22.1/bin:$PATH
pnpm install --frozen-lockfile --offline
env JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm exec vitest run packages/project/test/ease-apply.test.ts packages/project/test/ease-fit.test.ts packages/project/test/ease-presets.test.ts packages/project/test/keyframes-ease-precision.test.ts packages/project/test/masks-raster.test.ts packages/project/test/three-d-hostile.test.ts packages/project/test/vector/boolean-retry.test.ts packages/project/test/vector/tracer.test.ts packages/project/test/vector/trim-animate.test.ts packages/project/test/vector/ops.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/jasper-project-animation-after.json
pnpm exec biome check packages/project/src/index.ts packages/project/test/ease-apply.test.ts packages/project/test/ease-fit.test.ts packages/project/test/ease-helpers.ts packages/project/test/ease-presets.test.ts packages/project/test/keyframes-ease-precision.test.ts packages/project/test/masks-raster.test.ts packages/project/test/three-d-hostile.test.ts packages/project/test/three-d-hostile.ts packages/project/test/vector/boolean-retry.test.ts packages/project/test/vector/tracer.test.ts packages/project/test/vector/trim-animate.test.ts packages/project/test/vector/ops.test.ts
git diff --check
```

The first Biome check reported formatting in three changed files. `pnpm exec biome format --write packages/project/test/ease-apply.test.ts packages/project/test/ease-helpers.ts packages/project/test/three-d-hostile.ts` corrected those files; the final 13-file check passed.

Two temporary, restoring mutation checks verified intended regression detection. Replacing the 100% influence inverse with `return u` made the retained closed-form midpoint test fail with error 0.00094494 > 1e−12. Preserving a stale linked offset expression after reapplying a trim made the consolidated reuse test fail its cleared-expression assertion. Each mutation produced exactly one intended assertion failure, and both production files were restored byte-for-byte before the following verification.

```sh
pnpm exec vitest run packages/project/test/keyframes-ease-precision.test.ts --maxWorkers=2 -t 'resolves the flat midpoint' --reporter=json --outputFile=/tmp/jasper-project-animation-mutant-singularity.json
pnpm exec vitest run packages/project/test/vector/trim-animate.test.ts --maxWorkers=2 -t 'reuses the last top-level trim' --reporter=json --outputFile=/tmp/jasper-project-animation-mutant-stale-offset.json
env JASPER_REQUIRE_ORACLES=1 JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm exec vitest run packages/project/test/keyframes-ease-precision.test.ts packages/project/test/vector/trim-animate.test.ts --maxWorkers=2 -t 'resolves the flat midpoint|reuses the last top-level trim'
```

The restored-source verification passed both selected tests (53 other cases excluded only by this diagnostic name filter). No new unresolved failures remain in this workstream. Full lint/typecheck/build and browser/native/opt-in rendering gates were not duplicated inside this isolated worktree; the root report records integrated validation.
