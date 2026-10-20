# Keyframe assistant: easing commands (ease-core)

Document-level commands that shape keyframe timing with ease curves, copy / paste eases and values, edit key
velocities numerically, drive a motion path from a slider and clean up motion paths. The feature set follows
public descriptions of keyframe-easing assistants for motion-graphics tools; names, curves and texts here are
original. Code: `packages/project/src/ease/` (`curve.ts` contract, `segments.ts`, `multi.ts`, `path-fit.ts`),
`packages/project/src/commands/{schemas,handlers}/ease.ts`, `handlers/ease-read.ts` (pure read helpers),
`packages/expressions/src/presets.ts` (Overshoot, Bounce).

## Model recap

- A key stores one interpolation (the segment it **leaves**) plus `easeIn` / `easeOut` = `{influence ∈ (0, 1],
  slope}`; the slope is relative to the segment's average speed (1 = linear). The evaluator (`keyframes.ts`) draws
  segment A → B as: hold (A holds), linear (A `linear`; B's in ease ignored), else
  `bezier(outgoingEase(A), incomingEase(B))`, where a `linear` B arrives with the linear ease (⅓, 1) and an
  `auto-bezier` key's eases are derived from its neighbours on every evaluation.
- CSS `cubic-bezier(x1, y1, x2, y2)` ↔ eases (`curve.ts`): `out.influence = x1`, `out.slope = y1 / x1`,
  `in.influence = 1 − x2`, `in.slope = (1 − y2) / (1 − x2)`; influence 0 is stored as 0.001 (the closest the model
  holds). Exact both ways (property tests in `ease-curve.test.ts`, `ease-apply.test.ts`).
- A run of roving keys between two fixed keys is **one** segment shaped by the fixed keys' eases
  (`rovingProgress`); every ease command addresses a segment touching a roving key as its enclosing run.

## Writing one segment without disturbing the others (`writeSpan`)

To make span A → B exactly `bezier(out, in)`:

- A becomes `bezier` (from linear / hold / auto / continuous) with its in ease set to the ease it effectively arrived
  with (so the segment before A is unchanged).
- B keeps `bezier` / `hold`. An `auto-bezier` or `continuous-bezier` B becomes `bezier` with its current effective
  out ease, so `finish` cannot re-derive (overwrite) the in ease just set. A `linear` B becomes `bezier` with the
  linear out ease, and the key after it is made to arrive linearly (an `auto-bezier` one is frozen to `bezier` with
  its effective out ease) — exactly how the segment B → C evaluated behind a linear B.
- Already linear spans written with linear eases are left alone.

Multi-point rebuilds measure these effective eases on the key list **before** inner keys are removed (auto-bezier
eases depend on neighbours).

## `keyframe.applyEase { keyframeIds, curve, sections? }`

Keys are grouped by property in document order, then time. Sections (per property): `in` = the span arriving at the
first selected key, `middle` = every span between two consecutive selected keys that are adjacent (or in one roving
run), `out` = the span leaving the last selected key; missing neighbours are skipped. Default: 2+ selected keys →
`middle`, one key → `in` + `out`.

- **cubic**: every chosen span gets `cubicToEases(curve)` through `writeSpan`; the span then evaluates exactly as
  CSS `cubic-bezier` (verified to 1e-9; fast-check over random neighbourhoods of all five interpolations shows every
  other segment unchanged).
- **multi** (needs `middle` and 2+ selected keys per property): span = first … last selected key. Keys strictly
  inside are removed; for curve points (x_m, y_m) new keys get `time = tA + round(x_m·(tB − tA))` (whole flicks, no
  frame rounding) and `value = vA + y_m·(vB − vA)` (numbers, vectors, colours componentwise; validated / clamped like
  `keyframe.update` → `W_VALUE_CLAMPED`). Piece m becomes the cubic of the piece in its own unit square:
  `x1 = (h1x − x_m)/Δx`, `y1 = (h1y − y_m)/Δy`, `x2 = (h2x − x_m)/Δx`, `y2 = (h2y − y_m)/Δy`, then `cubicToEases`.
  Value at time u = `vA + y(u)·Δv` exactly (sampled within 1e-6 normalised for overshoot, bounce and elastic
  curves in `ease-multi.test.ts`). A piece whose ends have equal y cannot hold a shaped ease (its keys have equal
  values, so the model draws a constant): it is made linear with `W_EASE_FLAT_SEGMENT`. Refused per property (→
  `W_EASE_SKIPPED`, or `E_INVALID_PARAM` when nothing applies): equal first / last values, non-numeric values (paths,
  gradients: path interpolation does not extrapolate, so overshooting keys could not be made), a span too short for
  the points. Roving keys in the span are cleared (`stopRoving` on its ends keeps their times) with
  `W_EASE_ROVING_CLEARED`.
- **Point properties** (vec2 with spatial interpolation) keep their drawn motion path: y is the fraction of the
  path's arc length L from A to B through the removed keys; y < 0 / y > 1 continue straight along the start / end
  tangent by y·L / (y − 1)·L (the evaluator's own overshoot rule, `pathPointAt`). New keys sit at
  `pathPointAt` of the original segment (64-sample arc tables, as the evaluator) and the original Bézier segments
  are split there with de Casteljau sub-curves as the new tangents, so the drawn path is unchanged. Where a curve
  piece would run across a corner of the path — an original key between two segments that are not one straight
  line, or a span end next to a curved segment (the extension is straight) — the curve piece itself is split at that
  y (de Casteljau in the curve's (x, y) plane, still exact) and a key is added there. Pieces are also split where
  their y turns inside the piece (an apex between two points), so every piece is monotone: its progress stays in
  [0, 1] (the evaluator would otherwise extend an excursion straight along the piece's end tangent, off the path).
  Every piece then lies on one original segment or on a straight extension, and the evaluator's arc-length progress
  along it equals the curve's y. Point properties can therefore get more keys than the curve has points.
  Measured (`ease-multi.test.ts`, overshoot / bounce / elastic on a three-segment curved path): positions on the
  original path within 0.05 px, timing within 0.2 % of L (the arc-length tables' accuracy).
- 3D Orientation turns spherically with progress clamped to [0, 1] (`three-d/scene.ts`): a curve leaving [0, 1] on
  an Orientation property warns `W_EASE_CLAMPED` (rendering unchanged). Limitation: multi-point keys on Orientation
  are Euler-componentwise values, so between them the slerp is not the original great-circle turn.
- Result: `{affected, created, removed}` keyframe ids. Hold-only properties are skipped (`W_EASE_SKIPPED`); locked
  tracks refuse with `E_TRACK_LOCKED`.

## Clipboard: `copyEase`, `keyframe.pasteEase`, `copyValues`, `keyframe.pasteValues`

- `copyEase(doc, ids)` (pure; reads locked tracks): one key → `{kind: 'key', easeIn, easeOut}` (effective eases);
  otherwise `{kind: 'segments', segments}` = the `middle` spans of every property as cubic-bezier, plus — for 3+ keys
  of one property — `curve`: all keys first … last as a multi curve (x = normalised time, y = normalised value:
  arc fraction for points, projection on B − A for vectors; handles from the segments' eases). The curve is omitted
  when it cannot be expressed (equal end values, a hold or roving run inside, y beyond ±10, > 64 points). With no
  span and several single keys the first key's eases are copied.
- `pasteEase`: `key` → both sides of every target key (a neighbouring hold keeps holding; a roving key takes its
  run's ease and is skipped); `segments` with `curve` and `mode ≠ 'segments'` → like `applyEase` multi; otherwise 1
  curve → every target span (sections as above), n curves → in order (property, then time); a count mismatch pastes
  min(n, m) with `W_EASE_COUNT_MISMATCH`. `mode: 'curve'` without a curve refuses.
- `copyValues` / `pasteValues`: values in order (property, then time), each validated like `keyframe.update`
  (`W_VALUE_CLAMPED`, `E_INVALID_PARAM` for a wrong type); times and eases kept; count mismatch → min +
  `W_EASE_COUNT_MISMATCH`.

## Velocity: `describeKeyframeEases`, `keyframe.setVelocity`

`speed = slope × average velocity of the span`, average velocity = Δv / Δt in units per second (signed for numbers;
Euclidean for vectors; arc length for curved spatial segments; the run's travelled distance for roving runs — the
evaluator's `distance`). `setVelocity {keyframeId, side, speed?, influence? (0.1 … 100 %)}` writes through
`writeSpan`; a span whose value does not change (Δv = 0) cannot hold a nonzero speed (refused), a held span and a
roving key are refused, `both` sets the sides that exist. `describeKeyframeEases` returns per property the selected
keys (time, value, interpolation, effective in / out ease with influence %, slope, speed) and the in / middle / out
segments as cubic-bezier with their average speed.

## `keyframe.createPathController { keyframeIds, replaceExpression? }`

For 2+ keys of one point property of a clip: keys between the first (A) and last (B) selected rove and the span is
linear (constant speed along the unchanged path; `writeSpan(A, B, linear, linear)` keeps the outside segments); a
Slider Control named "Path Progress" (unique "Path Progress 2" …) is added, keyed 0 at tA and 100 at tB with Easy Ease
(⅓, 0); the property's expression becomes

```js
var p = effect("Path Progress")("Slider");
var tA = key(iA).time, tB = key(iB).time;
var lo = Math.min(tA, tB), hi = Math.max(tA, tB);
(time < lo || time > hi) ? value : valueAtTime(linear(p, 0, 100, tA, tB))
```

so inside the span the layer sits on its original path at the slider's progress, outside it plays its keys. Verified
in `packages/expressions/test/ease-assistant.test.ts` (positions on the original path within 0.05 px; equal to the
keyed constant-speed path at the slider-mapped time within 1e-6). Limits: the expression addresses A and B by key
number, so adding keys before A shifts it; retiming the slider beyond [tA, tB] has no effect outside the span.
Refusals: not a point property, several properties, track / master properties, an existing expression without
`replaceExpression: true`.

## `keyframes.cleanupPath { keyframeIds, tolerance? = 0.5 }`

`keyframes.simplify` keeps the *timing* at every frame and refits temporal eases; Clean Up Path is a different
measure, so it is a separate planner (`path-fit.ts`) rather than a mode of the simplifier: the span's timing becomes
linear (A keeps its arriving ease as Bezier with a linear out ease; an Auto Bezier B is frozen so the segment after it
is unchanged) and the fewest keys are kept whose drawn path stays within the tolerance (value units — sequence px for
Motion). Fit after Schneider, "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990),
implemented from the published description: per candidate span one cubic from key i to key j with end tangents along
the original path's directions there, least squares on chord-length parameters with Newton re-parameterisation,
accepted when the two-sided distance (original samples ↔ fitted curve) is within the tolerance; shortest path over
accepted spans (dynamic programming), scans stop after 6 rejected ends or 128 segments. Consecutive keys keep their
original segment, so a solution always exists. Keys outside the span and their segments are unchanged.

## Expression presets

`overshoot` (damped sine past each key, amplitude = 15 % of the change into it) and `bounce-back` (the value
bounces back off each key's value with restitution 0.6 under constant pull 4000 units/s², up to 8 bounces; needs
speed into the key) join `inertial-bounce` (velocity-driven decaying sine).

## Warnings and refusals

`W_EASE_SKIPPED`, `W_EASE_FLAT_SEGMENT`, `W_EASE_CLAMPED`, `W_EASE_COUNT_MISMATCH`, `W_EASE_ROVING_CLEARED`,
`W_VALUE_CLAMPED`; refusals `E_NOT_FOUND`, `E_TRACK_LOCKED`, `E_INVALID_PARAM`. Every command is one undoable
transaction (`packages/session/test/ease-history.test.ts`).
