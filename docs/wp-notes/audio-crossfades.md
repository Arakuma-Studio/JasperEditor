# Audio crossfades and fade shapes (Premiere port)

Branch `feat/pp-audio-crossfades`. Premiere's audio transitions — Constant Gain, Constant Power, Exponential Fade and
the Custom Fade its fade handles make — with one gain-curve implementation for preview and every export path, and
Premiere's off-centre ("Custom Start") crossfades kept instead of re-centred.

## Research

Sources (fetched 2026-10-25):

1. Adobe, *Audio crossfade transitions* (Premiere help, updated 2025-08-22),
   <https://helpx.adobe.com/premiere/desktop/add-audio-effects/apply-audio-transitions/audio-crossfade-transitions.html>
   (read through the Wayback Machine; helpx answers 403 to scripts). Constant Gain "changes audio at a constant rate
   in and out … can sometimes result in a noticeable dip in volume at the midpoint"; Constant Power "decreases audio
   for the first clip slowly at first and then quickly toward the end … for the second clip … increases audio quickly
   at first and then more slowly"; Exponential Fade "fades out the first clip over a smooth logarithmic curve while
   fading up the second clip, also over a smooth logarithmic curve … sounds similar to the Constant Power transition,
   [but] more gradual". No formulas.
2. Adobe, *Fade in or fade out clip audio* and *Crossfade between audio clips* (same help set, 2025-08-22): fade
   handles on audio clips; drag to create "a variety of custom fades"; "hold the option key while dragging to
   constrain the adjustment to only one axis — up-down for slope or left-right for duration"; "hold the shift key to
   change one side for the crossfade effect".
3. Adobe Community, *default audio fade shape* (question 2025-07-21, Adobe employee's accepted answer),
   <https://community.adobe.com/questions-729/default-audio-fade-shape-1418959>: an applied audio transition
   "defaults to the fade shape Cosine @ 19 fade value"; to get "a Linear Fade Shape with Fade Value of 0 … use
   Constant Gain".
4. Adobe Community feature request *Interactive Fade Handles Ideas (Bring In More from Audition)* (2024-05-15):
   the fade shapes are "Cosine and Linear", set in Effect Controls; only the symmetrical crossfade exists in Premiere;
   asks for Audition's asymmetrical one.
5. CineD, *Adobe Premiere Pro Beta Improves Audio Workflow* (2024-01-22): dragging the handles "up or down, you can
   adjust the type of fade (or cosine value)". Videomaker (≈ 2024-01): dragging "change[s] the shape of the curve,
   giving exponential fades rather than simple linear ones", "familiar" from Audition / Pro Tools.
6. Adobe Audition help, *Visually fading and changing amplitude* and *Match, fade, & mix clip volume*
   (helpx.adobe.com/audition/…): Linear fades are even, Logarithmic fades "change volume slowly and then rapidly, or
   vice versa" (drag up or down), Cosine fades are "shaped like an S-curve, changing volume slowly at first, rapidly
   through the bulk of the fade, and slowly at the finish"; crossfades are "Symmetrical or Asymetrical …
   Symmetrical adjusts both fades identically, while asymetrical lets you adjust fades independently".
7. Peachpit, *Adobe Premiere Pro Classroom in a Book (2025 release)*, "Adding audio transition effects": Constant
   Power is the default audio transition; Exponential Fade "uses a logarithmic curve"; fade handles: "drag up or down
   to adjust the curve".

The user's 31 decoded projects (`/tmp/prproj-inspect`, read-only) hold 14 audio transitions: 8 "Constant Power"
(all `FadeShapeType` 1, `FadeShapeValue` 19, `CrossfadeSymmetry` 0 — matching source 3) and 6 "Custom Fade"
(`FadeShapeType` 1, values 12, 12, 12, 12, 13, 30; symmetry 0); one one-sided Constant Power at a clip tail and one
at a head; of the 12 two-sided ones 8 are off-centre, 2 centred and 2 start at the cut (`Alignment` = ticks from
the span start to the cut: 0 for a fade at a head, the duration for a fade at a tail). The XML node
carries nothing else (`AudioChannelLayout`, `ChannelType`, `FrameRate`).

### What the fields mean

- `FadeShapeType`: **1 = Cosine** (sources 3 + data: Constant Power is stored as 1 / 19). **0 = Linear is an
  assumption** (source 3 names the Linear shape; no document with it was seen).
- `FadeShapeValue`: the fade value Premiere shows next to the shape (source 3); Constant Power = Cosine @ 19,
  Constant Gain = Linear @ 0. Its range and exact curve are **not documented**; we take −100…100 (assumption,
  Audition-style signed curvature; the values seen are 12…30).
- `CrossfadeSymmetry`: **0 = Symmetrical** (data + source 4); **1 = Asymmetrical is an assumption** (Audition's
  option, source 6).

## The curves (`packages/project/src/audio-fade.ts`)

A fade's gain at progress x (0 = silent end, 1 = full level; a fade out evaluates its curve at 1 − x):

| Transition | Gain | Basis |
|---|---|---|
| Constant Gain | x | source 1 (constant rate; amplitudes sum to 1, the −6 dB dip) |
| Constant Power | sin(πx / 2) | source 1 (slow then fast out, fast then slow in); powers sum to 1 |
| Exponential Fade | (1000^x − 1) / 999 — dB-linear over 60 dB | unchanged from audio-fx (wp-notes/audio-fx.md); source 1 gives no formula: **assumption** |
| Custom Fade | base(x)^(2^(−v / 19)), base = x (Linear) or (1 − cos πx) / 2 (Cosine) | see below |

The Custom Fade family is **our design, anchored to the evidence**: Linear @ 0 is exactly Constant Gain's line,
Cosine @ 19 is exactly Constant Power's quarter sine (((1 − cos πx) / 2)^½ = sin(πx / 2)), Cosine @ 0 is Audition's
S-curve, and positive values rise earlier (fuller fade in / later fade out), negative ones later — the "logarithmic"
bends of source 6. At value 19 any shape's symmetrical crossfade keeps the summed power at 1 (base(x) + base(1 − x) =
1 for both bases), at 0 the summed amplitude. Every curve is 0 at x = 0, 1 at x = 1 and monotone for every value
(property test). Whether Premiere's renderer uses this exact family is **not known**; a Premiere Custom Fade other
than Cosine @ 19 / Linear @ 0 may differ from Premiere's by an unmeasured amount.

Symmetry: Symmetrical — the outgoing clip fades out on the mirror of the fade in (same shape and value);
Asymmetrical — the fade out has its own shape and value (`outFadeShape`, `outFadeValue`). A one-sided fade uses the
main shape.

## Model

- `jasper.custom-fade` (`TRANSITION_SPECS`, bin Crossfade): params `fadeShape` (linear | cosine, default cosine),
  `fadeValue` (−100…100, default 19), `symmetry`, `outFadeShape`, `outFadeValue`; static (not animatable).
  `audioTransitionCurves(t)` turns any audio transition into the curves of its sides; `customFadeParamsFor(id)` gives
  the Custom Fade that starts from a fixed transition's curve (Exponential Fade: Linear @ −44, x^5.0, the same −30 dB
  at its midpoint — an approximation used only as a drag's starting point).
- `Transition.cutPosition` (Custom Start): the fraction of a two-sided span before the cut; `cutOffsetOf`,
  `transitionSpan(cut, d, alignment, cutPosition)`, `fitTransitionDuration({cutPosition})` (the offset scales when the
  span is shortened). Video transitions honour it too (shared `transitionSpan` / `resolveVideoTransitions`).
- Commands: `transition.add` / `transition.update {cutOffset}` (frames before the cut; refused on fades, past the
  span, or with a different `alignment`: `E_INVALID_PARAM`); a new `alignment` drops it; results carry `cutOffset`.
- Invariants / repair: INV-010 (cut position, Custom Fade params), `drop-cut-position`, `reset-transition-param`;
  `docs/project-files.md` "Fields added in v8".

## Rendering (AGENTS §4)

`resolveAudioTransitions` writes each clip's fades with their curve (`RenderAudioFade.curve` + `shape`);
`audioFadeGain` is the one function the export's offline mixer (`audio/mixer.ts`, every export path), the preview
mix graph (`compositions/src/audio/graph.ts`, its level automation), the Remotion layer (`AudioLayer.tsx`) and the
pipeline use. The preview follows a Custom Fade's cusp (an exponent < 1 starts with an infinite slope) with
one-sample automation pieces (`CUSP_PRECISION`, like the 5.1 panner's).

Measured:
- `packages/compositions/test/audio-preview-mix-oracle.test.ts` "audio crossfades" (headless Chrome, preview while
  playing vs export): an asymmetrical off-centre Custom Fade, an Exponential fade in and a Constant Power fade out —
  worst |preview − export| < 1e-4 (before `CUSP_PRECISION`: 2.65e-4 at the span start); the export's samples equal
  gain × source within 2.7e-8.
- `apps/engine/test/audio-crossfade.test.ts`: native export of an off-centre asymmetrical Custom Fade between two
  tones; Goertzel amplitudes at five frames match the curves (±0.05).
- In the running app (2026-10-25, this branch, ports 47914 / 5184): a 30-frame Custom Fade (8 frames before the cut,
  Cosine @ 15 in, Linear @ −35 out after a drag in Effect Controls) exported natively to AAC; 50 ms Goertzel windows
  at 9 frames matched `fadeShapeGain` within 0.0025, both tones absent outside the span.

## UI

- Effect Controls / Properties ▸ Transition: for audio transitions a curve graph of both sides (from the curve
  model); drag up / down to change the fade value (a fixed transition becomes a Custom Fade starting from its own
  curve, Premiere's fade-handle behaviour; Shift on a crossfade: only the side under the pointer, asymmetrical);
  Custom Fade rows: Fade Shape, Fade Value (slider + scrubby number), Crossfade Symmetry, Fade Out Shape / Value.
  Picking Custom Fade in Type starts from the old curve. Alignment shows "Custom Start" for an off-centre span.
- Timeline: transition glyphs draw each side's curve; tooltips say "Custom Start (n frames before the cut)"; the
  Alignment submenu shows it; Alt-drag of an edge keeps the other edge (Custom Start); a Custom Start span's edges
  always keep the other edge.
- Effects panel: Audio Transitions ▸ Crossfade lists Custom Fade (from `TRANSITION_SPECS`).
- The Level-lane fade handles of the timeline stay keyframe fades (FCP/Resolve style, `keyframe-lane.ts`); they do
  not create transitions.

## Interchange

- FCP7 XML (Premiere dialect): names, effect ids (`KGAudioTransCrossFade3dB` / `0dB`) and the Spanish display names
  map to the four types (the effect id is tried when the name is unknown); `<parameter>`s `FadeShapeType`,
  `FadeShapeValue`, `CrossfadeSymmetry` (and `outFadeShape` / `outFadeValue`) are read and written for Custom Fades
  (`premiere-audio-fades.ts`). A Constant Power / Gain whose shape is not its own becomes a Custom Fade (reported); an
  Exponential Fade keeps its fixed curve (reported when shape data came with it).
- Every importer: an off-centre span gets a `cutPosition` (was re-centred with an info line).
- OTIO keeps params and offsets; EDL / AAF / OMF carry the type and the span only and warn that a transition's
  params are not carried.

## Limits

- The fade-value curve, the Linear code (0) and the asymmetrical code (1) are assumptions (above); a .prproj reader
  does not exist in this repository, so the user's projects reach JasperEditor through FCP7 XML.
- Exponential Fade's formula is not Adobe's documented one (none is published).
