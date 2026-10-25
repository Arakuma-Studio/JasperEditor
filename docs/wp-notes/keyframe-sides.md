# keyframe-sides — separate incoming / outgoing temporal interpolation per keyframe

Branch `feat/pp-keyframe-sides` (Premiere port). Premiere and After Effects keep an incoming and an outgoing temporal
interpolation on every key: Premiere's **Ease In** makes only the incoming side Bezier, **Ease Out** only the outgoing
side. Before this work a JasperEditor key had one `interpolation` that governed the segment leaving it, and a segment
leaving a Linear key was linear whatever the next key stored, so an Ease In after a Linear key did nothing.

## 1. Research

### Sources

- **AE help, "Keyframe interpolation"** (helpx.adobe.com/after-effects/using/keyframe-interpolation.html; read through
  web.archive.org, 2024 capture, because helpx answers 403 here). Quoted:
  - "the incoming method applies to the property value as the current time approaches a keyframe, and the outgoing
    method applies to the property value as the current time leaves a keyframe."
  - The keyframe icon "displays the left half of the incoming interpolation icon and the right half of the outgoing".
    A dark half means "no keyframe is adjacent to that side, or that its interpolation is overridden by the Hold
    interpolation applied to the preceding keyframe."
  - "If you create a keyframe following a Hold keyframe, the new keyframe uses incoming Hold interpolation", and
    "Toggle Hold Keyframe" applies Hold "as outgoing interpolation".
  - "the graph segment following a Hold keyframe appears as a horizontal straight line."
  - Bezier: "the two direction handles on a Bezier keyframe operate independently". Auto Bezier: adjusting a handle
    manually converts the key to Continuous Bezier.
- **AE help, "Speed"** (helpx.adobe.com/after-effects/using/speed.html, same archive). "After you apply Easy Ease, each
  keyframe has a speed of 0 with an influence of 33.33% on either side." Easy Ease In eases "speed coming into
  selected keyframes", Easy Ease Out "coming out of".
- **AE scripting guide, Property object** (ae-scripting.docsforadobe.dev/property/property/).
  - `setInterpolationTypeAtKey(keyIndex, inType, outType)` takes LINEAR / BEZIER / HOLD per side.
  - Temporal Auto-Bezier and Continuous affect a key "only if the keyframe interpolation type is
    KeyframeInterpolationType.BEZIER for both keyInInterpolationType(keyIndex) and keyOutInterpolationType(keyIndex)".
- **Premiere Pro help, "Controlling effect changes using keyframe interpolation"**
  (helpx.adobe.com/premiere-pro/using/controlling-effect-changes-using-keyframe.html, archived 2023).
  - Right-clicking a key in Effect Controls or a Timeline panel offers Linear, Bezier, Auto Bezier, Continuous Bezier,
    Hold, Ease In, Ease Out.
  - "Ease In Slows down the value changes entering a keyframe. Ease Out Gradually accelerates the value changes
    leaving a keyframe."
- **Lottie / bodymovin exporter**, `bundle/jsx/utils/keyframeHelper.jsx` (github.com/bodymovin/bodymovin-extension, MIT;
  read for behaviour, not ported). It converts every AE segment into one cubic:
  - **Hold** when `keyOutInterpolationType(i) === HOLD`.
  - **Linear** only when the left key's out type **and** the right key's in type are LINEAR.
  - Otherwise the out control point is `(I₀/100, S₀·I₀·T/Δv)` and the in point is `(1 − I₁/100, 1 − S₁·I₁·T/Δv)`.
    They are built from `keyOutTemporalEase(i)` of the left key and `keyInTemporalEase(i+1)` of the right key, also
    when one of the sides is LINEAR. AE reports a speed and an influence for linear sides too.
- **The user's Premiere projects** (`/tmp/prproj-inspect/json`, 31 projects, read-only). Keys are encoded
  `time, value, inType, outType, inSpeed, inInfluence, outSpeed, outInfluence` (types 0 = linear, 5 = bezier).
  Measured with a script over every keyframed numeric parameter:
  - Key types: 159 879 (linear in, linear out), 2 777 (bezier in, linear out) = Premiere's Ease In. No other
    combinations occur.
  - Segments: 95 786 linear → linear, 1 519 linear out → bezier in (the mixed segments the evaluator ignored).
  - Linear sides carry influence **1/6** (321 267 sides). Their speed equals the segment's average speed on 96 200
    outgoing and 95 786 incoming sides.
  - Bezier sides written by Ease In carry influence **1/3** and speed 0. Most were then dragged in the graph
    (influence 1.0 on 1 360 sides).
  - Stale numbers sit on some linear sides: influence 1.0 or 0.0001 and a speed ≠ the average on 1 106 sides, 224 of
    them in linear → linear segments, which Premiere draws straight. So Premiere does not read a linear side's stored
    numbers in a linear segment.

### Findings

1. **Segment rule.** A segment a → b uses a's outgoing side and b's incoming side.
   - Hold if a's outgoing side is Hold.
   - Linear (p = u) when both sides are Linear.
   - Otherwise it is the cubic Bézier in normalised (time, value):
     `(0,0)`, `(I_out, I_out·S_out)`, `(1 − I_in, 1 − I_in·S_in)`, `(1,1)`, with slope `S = speed / average speed`.
2. **A Linear side** of such a mixed segment contributes After Effects' linear temporal ease: influence **⅙** at the
   segment's average speed (slope 1).
   - Evidence: AE reports exactly that for linear keys, bodymovin builds the cubic from it, and Premiere writes exactly
     these numbers whenever it computes a linear side.
   - *Assumption, labelled:* Premiere evaluates a linear side from these computed values, not from stale stored
     numbers. Finding 1 shows it ignores stale numbers on linear → linear segments. No Adobe document states the ⅙
     outright.
3. **Hold** is a property of the outgoing side. AE's incoming Hold only mirrors the previous key's outgoing Hold (the
   "overridden" half). JasperEditor therefore has no incoming Hold. Setting Hold changes only the outgoing side, and
   the key's incoming side keeps its shape.
4. **Auto Bezier / Continuous Bezier** shape both sides; AE applies them only when both sides are Bezier. A key whose
   two sides differ therefore never uses them. Setting one side of such a key turns the other into Bezier frozen at its
   current shape, as AE converts an adjusted Auto Bezier handle.
5. **Ease In / Ease Out** (Premiere) set one side to Bezier with speed 0 and influence ⅓ (data: 2 777 keys of that
   shape, the pristine ones exactly {⅓, 0}); the other side is untouched.

## 2. Model (`packages/project/src/schema/common.ts`)

- `Keyframe.inInterpolation?: 'linear' | 'bezier' | 'auto-bezier' | 'continuous-bezier'` (`IN_INTERPOLATIONS`).
  - `interpolation` stays the outgoing side, and also the incoming side when `inInterpolation` is absent.
  - Read leniently: `z.custom`, so any value loads.
- **Absent = exactly the old behaviour.** A segment whose right key has no `inInterpolation` is read the legacy way:
  - linear when the left key is Linear;
  - otherwise a Linear right key contributes ⅓·1, as before.

  Every existing document evaluates bit-identically (§6).
- **Present = per-side (After Effects) reading** of the segment arriving at the key (§1, findings 1–2). New
  documents only get it through side edits, imports that carry sides, pastes and presets.
- INV-011 `keySidesIssue` reports two problems: an unknown incoming type, and Auto / Continuous Bezier on a key whose
  sides differ.
- `repairDocument` `repair-key-sides` (`normalizeKeySides`) fixes them, motion-graphic `paramKeyframes` included:
  - it drops an unknown incoming type (the key reads the legacy way);
  - one-sided Auto / Continuous becomes Bezier with the stored ease.
- No schema bump: the branch is at v8. See the "Fields added in v8" row in `docs/project-files.md`.

## 3. Evaluator (`packages/project/src/keyframes.ts`)

- `segmentShape(kfs, a, b = a+1)` → `'hold' | 'linear' | {out, in}` is the one rule. `evaluateKeyframes`, roving runs
  (`rovingProgress` over the fixed keys), 3D Orientation and Lottie export all use it.
  - `segmentProgress` / `shapeProgress` wrap it.
  - Spatial arc-length paths, roving, hold-only values and clamping are unchanged; the progress feeds them as before.
- `outgoingEase` / `incomingEase` return the per-side ease when the segment is read per side, else the legacy one.
- `effectiveInInterpolation` gives the type that actually shapes the arriving segment.
- `reversedKeyTiming` mirrors each segment's actual shape. The mirrored keys are legacy Bezier keys, so callers drop
  `inInterpolation`.

## 4. Commands (`packages/project/src/commands`)

`keyframe.setInterpolation {…, side?: 'both' | 'in' | 'out'}` (default `both`) and `keyframe.update {…, side?}`:

| Side | Effect |
|---|---|
| `in` | the incoming type and ease; the outgoing side keeps its shape |
| `out` (and Hold on `both`) | the incoming side is made explicit *without changing the arriving segment* (`freezeIncoming`: after a Linear key → Linear; a legacy Linear key after a curving key → Bezier {⅓, 1}, its exact legacy contribution; Auto → its computed ease); then the outgoing type; the next key's incoming side becomes explicit (its own type) so the edited segment is read per side |
| `both` | both types explicit; the next key's incoming side explicit |

- Refusals (`E_INVALID_PARAM`):
  - Hold on the incoming side;
  - Auto / Continuous Bezier on one side;
  - `easeOut` with side `in`, or `easeIn` with side `out`.
- The old workaround that turned a Linear previous key into Bezier for an Ease In is gone. The per-side rule makes it
  unnecessary.
- `keyframe.add {inInterpolation?}` refuses an inconsistent key. `effect.add` validates pasted keys' sides.
- Tests (`packages/project/test/keyframe-sides-commands.test.ts`):
  - undo / redo;
  - every refusal;
  - property: an outgoing edit never changes the arriving segment, an incoming edit never the leaving one;
  - repair, paste.

## 5. Every consumer

| Consumer | How it follows the sides |
|---|---|
| Preview (Player / compositions), Remotion, native export, audio automation, expressions `valueAtTime`, MCP / agent queries | all sample the shared `evaluate()`. The native FFmpeg path samples per frame (`export/keyframed.ts`, `stream/plan.ts`); it builds no expressions from keys, so it stays exact |
| 3D Orientation (`three-d/scene.ts`) | `segmentProgress` |
| Lottie export | the segment's actual eases (a mixed segment exports AE's tangents) |
| Keyframe simplification | original segments read with `segmentShape`; the segment arriving at the span keeps its per-side reading |
| Sound Design dips / curve rewrites (`sound/mix.ts`) | curved = `segmentShape`; an edge key keeps a per-side arriving segment (explicit incoming side) |
| Copy / paste, paste attributes, reversed paste, effect presets, `effect.add`, multicam and Paste Grade re-timing, rescale | carry `inInterpolation`; reversed placements mirror per-side keys exactly (`reversedKeyTiming`) |
| Graph editor (`apps/web/.../graph.ts`) | effective eases from `segmentShape`; one handle per Bezier side; a handle drag edits only its side (`keyframe.update {side}`) |
| Agent property queries, MCP `get_motion_path`, `copy_grade` | report / carry the incoming side |

**Interchange:**

- **FCPXML.** A point's `interp` is linear | ease | easeIn | easeOut ("interpolation type for point", FCPXML DTD 1.4,
  developer.apple.com retired DTD archive).
  - Per-side keys map both ways: eased in only ↔ `easeIn`, out only ↔ `easeOut`, both ↔ `ease`.
  - *Assumption:* `easeIn` eases the arrival at that point, as Final Cut's "Ease In … slows as movement approaches
    the ending keyframe" (larryjordan.com, "FCPX keyframes").
  - Legacy keys export exactly as before.
- **FCP 7 XML.** It has one interpolation per key. Its FCPCurve is FCP's own 40-segment power curve
  (developer.apple.com, "Final Cut Pro XML ▸ Keyframe Interpolation"), not After Effects' Bézier.
  - A key is written FCPCurve when either side curves.
  - The lost sides are reported in the export report.
- **AAF / OMF** carry linear / constant only. Curved segments, per-side ones included, are reported as exported linear.
- **OTIO / JasperEditor metadata** keep keys whole (tested).

## 6. Evidence

**Bit-identity.** `packages/project/test/keyframe-sides.test.ts` checks two things:

- A golden recorded from the evaluator at commit `27363576`, before this change
  (`test/fixtures/keyframe-sides/legacy-evaluation.json`): 48 seeded documents, ≥ 1 500 samples, covering numbers,
  vec2, curved spatial paths, roving and every interpolation. The samples are compared exactly.
- A fast-check property against the legacy formula, with `Object.is`.

**After Effects math.** A property compares mixed segments with an independent cubic solved in value units, to 4e-9
relative. The Premiere Ease In case is (⅙, ⅙)–(⅔, 1).

**In the running app, measured 2026-10-25** on this host's dev stack (ports 47913 / 5183). Setup: a Color Matte with
Scale keys 10 % at frame 0 and 100 % at frame 60, both Linear.

- Effect Controls ▸ right-click the second key shows "Temporal Interpolation" with Linear checked. **Ease In** gave
  `{interpolation: linear, inInterpolation: bezier, easeIn: {⅓, 0}}` and left the first key Linear.
- The glyph shows a Bezier left half and a Linear right half.
- The value graph leaves the first key straight and eases into the second, with one handle on its incoming side only.
- At frame 30 Effect Controls and Properties read 67.3 % and the Program monitor showed the matte at 67 % width. The
  formula `10 + 90 · bezierProgress(½, {⅙, 1}, {⅓, 0})` gives 67.336; the old evaluator gave 55.
- The timeline lane draws the eased band. Right-clicking its key opens Temporal Interpolation ▸ with Ease In checked;
  Ease Out there set only the outgoing side.
- **Native export** (`jasper export --engine native`, 1080p): the extracted frames 15 / 30 / 45 measured the matte at
  38.85 % / 67.29 % / 89.79 % of the width. The formula gives 38.89 / 67.34 / 89.77, within one pixel; linear would
  give 32.5 / 55 / 77.5.

## 7. Limits

- The ⅙ linear-side influence and Premiere's reading of stale linear-side numbers are inferred from AE / bodymovin and
  the user's data (§1). No live Adobe comparison was run.
- FCP 7 cannot carry separate sides, and AAF / OMF carry no curves (both reported). The FCPXML `easeIn` / `easeOut`
  direction is an assumption (§5).
- Segments of documents written before this change keep the legacy reading until a side edit touches them. A Linear
  key into a Bezier key stays linear there, as it always rendered.
- Spatial interpolation of effect point params (Transform / Offset) is covered by spatial-points
  ([spatial-points.md](spatial-points.md)); the temporal per-side rules above apply to those keys unchanged.
