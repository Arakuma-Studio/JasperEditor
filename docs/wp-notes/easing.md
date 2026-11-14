# Easing toolkit

## Built-in presets

Workstream `ease-presets` (branch `feat/ease-presets`). Code: `packages/project/src/ease/presets.ts` (catalog,
source functions, `matchEasePreset`) and `packages/project/src/ease/fit.ts` (curve fitter); tests:
`packages/project/test/ease-presets.test.ts`, `packages/project/test/ease-fit.test.ts`. The curve contract
(`EaseCurve`, `EasePreset`, `evaluateEaseCurve`, `EASE_Y_LIMIT` = 10, `MAX_EASE_POINTS` = 64) is in `curve.ts`.

The catalog is our own selection and naming, built only from public math: the CSS easing keywords (W3C), Robert
Penner's easing equations (MIT / BSD-3-Clause, port record `licenses/ported/easing-penner.md`), Material Design 3
motion tokens (published numbers) and our own physics (overshoot by peak amount, elastic, bounce, spring). No
third-party preset collection was copied; two published cubic-bezier tables are cited below only to compare accuracy
(§ Single-cubic presets).

### API

```ts
fitEaseCurve(fn: (x: number) => number, opts?: { tolerance?: number; cubicTolerance?: number; maxPoints?: number; derivative?: (x: number) => number }): EaseCurve
fitCubicEase(fn: (x: number) => number): CubicEase
easeCurveMaxError(curve: EaseCurve, fn: (x: number) => number, samples = 2000): number
class EaseFitError extends Error { code: 'E_INVALID_PARAM' | 'E_LIMIT'; reason: 'options' | 'nonfinite' | 'range' | 'endpoints' | 'points' }
BUILTIN_EASE_GROUPS: readonly { id: string; name: string }[]
BUILTIN_EASE_PRESETS: readonly EasePreset[]      // lazy view of builtinEasePresets()
builtinEasePresets(): readonly EasePreset[]       // built and fitted on first call, then cached (frozen)
builtinEaseSource(id: string): ((x: number) => number) | undefined
matchEasePreset(curve: EaseCurve, presets = BUILTIN_EASE_PRESETS, tolerance = 1e-3): EasePreset | null
pennerEase, overshootEase, elasticEase, bounceEase, bounceRestitution, springEase, backStrengthForOvershoot
```

`EaseFitError.code` is a command error code (`commands/types.ts`), so a command handler can forward a refusal
unchanged. `EasePreset.group` is a group id (`basic`, `penner`, …); the display name is in `BUILTIN_EASE_GROUPS`.

### Fitter (`fitEaseCurve`)

1. Validate options (tolerance in (0, 1], default 0.002; `maxPoints` ≥ 3, capped at 64) and sample f on the
   1025-point grid x = i / 1024. Nonfinite values → `E_INVALID_PARAM`/`nonfinite`; |f| > 10 → `range`;
   |f(0)| or |f(1) − 1| above the tolerance → `endpoints` (the curve is pinned to (0, 0) and (1, 1)).
2. Turning points: a zig-zag filter over the samples keeps only reversals with a swing ≥ the tolerance (float noise
   and sub-tolerance ripples, e.g. a spring's settled tail, are not points); each is refined by golden-section
   search to 1e-11. This puts points exactly on bounce contacts (kinks) and on elastic / spring peaks.
3. Single cubic, only when there are ≤ 2 turning points (a cubic-bezier's y(t) has at most two): first the cubic
   Hermite candidate cubic-bezier(1/3, f′(0)/3, 2/3, 1 − f′(1)/3) — exact for polynomials of degree ≤ 3 (Penner
   quad / cubic / back, our overshoot curves) — then a least-squares fit (`fitCubicEase`): for fixed x1, x2 the
   curve is linear in y1, y2 (y(t) = 3(1−t)²t·y1 + 3(1−t)t²·y2 + t³), solved by 2×2 normal equations over 64
   evenly spaced t; x1, x2 by a 4 × 4 grid on [0, 1]² and a compass search (steps 1/6 … 2⁻¹⁰). Accepted when the
   max error on the grid is ≤ the tolerance. The least-squares search gives up early when the RMS after the
   coarse steps exceeds 2 × the bound being tested (then no cubic can pass). With `cubicTolerance` above the
   tolerance and a monotone f (no turning point), a minimax refinement follows: a pattern search over all 80 unit
   moves of (x1, y1, x2, y2) (steps 1/32 … 2⁻¹², scored at 128 evenly spaced t on f itself), starting from the
   least-squares cubic clamped to y1 ≥ 0, y2 ≤ 1 and accepting only monotone cubics — y′(t)/3 =
   (1−t)²·y1 + 2(1−t)t·(y2 − y1) + t²·(1 − y2) ≥ 0 on [0, 1] iff y1 ≥ 0, y2 ≤ 1 and (y2 ≥ y1 or (y2 − y1)² ≤
   y1(1 − y2)). The result is accepted when its max error on the grid is ≤ `cubicTolerance`. Without the
   constraint the best Cubic In-Out cubic dips 0.15 % below 0 before moving (a visible step back).
4. Otherwise a `multi` curve over pieces between [0, turning points…, 1]. Each piece starts with Hermite handles
   point ± (dx/3, f′·dx/3) (dx = piece width; one-sided slopes inside the piece from a 3-point difference with
   h = min(1e-5, dx/4), or `opts.derivative`). Steep handles are shortened along their tangent so their |Δy| ≤
   max(|Δy of the piece|, dx) (vertical tangents such as Penner circ). If the piece error exceeds the tolerance, a
   compass search over the two handle lengths (log₂ multipliers, steps 1 … 1/32, scored at 32 evenly spaced t
   against the grid, linearly interpolated) minimises the max error; the result is then checked on the piece's
   grid samples (at least 24 samples, evaluated directly in narrow pieces). Still above the tolerance → split at
   the midpoint and recurse (pieces ≥ 1e-4 wide). Handles are clamped inside their piece (x strictly past the
   point, never past the neighbour) and to ±10 in y, so every result satisfies `MultiEaseSchema`.
5. More than `maxPoints` points → `E_LIMIT`/`points`. A single remaining piece is split at t = ½ by de Casteljau
   (same curve) because a multi curve needs ≥ 3 points.

Deterministic: fixed grids and search orders, no randomness (tested with representative curve fits).

### Single-cubic presets

A cubic preset is stored as the handles of the two keys of each segment it is applied to (`{influence, slope}`
per side, slope normalised by the segment's average speed, `cubicToEases`), so moving either key later rescales the
ease in time and value. A multi curve bakes keys at its interior points, which keep their own times when the outer
keys move. Before this change the fitter accepted a single cubic only within 0.002, so in-out power curves (Cubic
In-Out, the reported case, has a best least-squares cubic error of 0.0028) were stored as multi curves and `apply_ease`
baked extra keys.

Rule (`PRESET_CUBIC_TOLERANCE` in `presets.ts`, `cubicTolerance` above): a fitted preset whose source is monotone is
one cubic-bezier when the best monotone cubic is within **0.01 of the value change** (max |cubic(x) − f(x)|);
everything else stays a multi curve within 0.002. Measured (10 000 samples, rerun with the command under § Measured
accuracy; `fitEaseCurve(fn, { cubicTolerance: 1 })` gives the best monotone cubic of the rejected ones):

| Preset | Before | Now | Best monotone cubic error |
|---|---|---|---|
| `penner.quad-in-out` | multi, 3 pts | cubic (0.483, 0.0403, 0.517, 0.9597) | 3.10e-3 |
| `penner.cubic-in-out` | multi, 3 pts | cubic (0.6602, 0, 0.3398, 1) | 8.39e-3 |
| `penner.quint-in` / `-out` | multi, 4 pts | cubic | 8.42e-4 |
| `penner.circ-in` / `-out` | multi, 7 pts | cubic | 4.07e-4 / 2.70e-4 |
| `penner.quart-in-out` | multi, 4 pts | multi, 4 pts | 1.96e-2 (rejected) |
| `penner.circ-in-out` | multi, 11 pts | multi, 11 pts | 1.98e-2 (rejected) |
| `spring.critical` | multi, 6 pts | multi, 6 pts | 2.64e-2 (rejected) |
| `penner.quint-in-out` | multi, 4 pts | multi, 4 pts | 3.00e-2 (rejected) |
| `penner.expo-in-out` | multi, 7 pts | multi, 7 pts | 3.18e-2 (rejected) |

Quint In / Out already had a least-squares cubic within 0.002 (8.42e-4); the early give-up of step 3 (RMS after the
coarse steps above 2 × 0.002) rejected it before the fine steps. The bound sits in a gap of the measured errors:
the largest accepted is 8.39e-3, the smallest rejected 1.96e-2.

Why 1 %: it is no looser than the cubic-beziers commonly used for these curves on the web. Published
approximations, measured the same way against Penner's equations (values read on 2026-11-14; cited for comparison
only, nothing copied):

| Curve | easings.net ([`src/easings.yml`](https://raw.githubusercontent.com/ai/easings.net/master/src/easings.yml), GPL-3.0 site) | Bourbon 4.3.4 ([`_timing-functions.scss`](https://raw.githubusercontent.com/thoughtbot/bourbon/v4.3.4/app/assets/stylesheets/addons/_timing-functions.scss), MIT; credits jquery.easie) | Ours |
|---|---|---|---|
| Quad In-Out | (0.45, 0, 0.55, 1): 5.26e-3 | (0.455, 0.03, 0.515, 0.955): 1.92e-2 | 3.10e-3 |
| Cubic In-Out | (0.65, 0, 0.35, 1): 9.54e-3 | (0.645, 0.045, 0.355, 1): 2.47e-2 | 8.39e-3 |
| Quint In | (0.64, 0, 0.78, 0): 1.13e-2 | (0.755, 0.05, 0.855, 0.06): 1.01e-1 | 8.42e-4 |
| Circ In | (0.55, 0, 1, 0.45): 1.80e-3 | (0.6, 0.04, 0.98, 0.335): 4.49e-2 | 4.07e-4 |

In pixels, 1 % is at most 19 px on a full-width 1920 px move at the worst frame, 2 px on a 200 px move (Cubic
In-Out: 16 px and 1.7 px). Curves that turn (Back In-Out, Anticipate & Overshoot, elastic, bounce, underdamped
springs) keep the 0.002 bound: their peak is the visible feature, and 1 % absolute would be a fifth of a 5 %
overshoot. Their best single cubics miss by about 1.0e-2 (Anticipate & Overshoot Light, the closest), 3.0e-2 (Back
In-Out) and 0.03–0.7 (elastic, bounce, springs), so they stay baked.

Alternative not taken: storing the preset as a named easing on the segment (an analytic `easeFn` evaluated by the
shared evaluator). It would be exact and rescale too, but it changes the persisted keyframe model (schema bump,
migration, `repairDocument`) and every consumer of `{influence, slope}`: the graph and velocity editors,
Continuous / Auto Bezier neighbour updates, `get_keyframe_eases`, ease copy / paste, Lottie and interchange
exporters (which would still have to bake for other apps). A within-1 % cubic gives the rescaling behaviour with
none of that; the rejected curves keep their exact multi shape. Limits: a span baked by an older build (e.g. Cubic
In-Out as 3 keys) is no longer named after that preset by `get_keyframe_eases` (its curve is 8.4e-3 from the new
cubic, above the 2e-3 span match); the keys and their animation are unchanged.

### Catalog: formulas and sources

**Basic** — match the keyframe model (`EASE_PRESETS` in `keyframes.ts`, the Ease In / Ease Out / Easy Ease handlers
via `interpolationCommand` in `apps/web/src/panels/effectControls/lib.ts` and `applyInterpolation` in
`commands/handlers/keyframe.ts`): Linear = both sides {⅓, 1} = cubic-bezier(⅓, ⅓, ⅔, ⅔); Easy Ease = {⅓, 0} both
sides = (⅓, 0, ⅔, 1); Easy Ease In = the arriving key's in ease {⅓, 0}, leaving side linear = (⅓, ⅓, ⅔, 1)
(decelerates into the key); Easy Ease Out = (⅓, 0, ⅔, ⅔). The test checks them against `bezierProgress` and
`cubicToEases`. CSS keywords from W3C CSS Easing Functions Level 1 §2.2
(https://www.w3.org/TR/css-easing-1/#cubic-bezier-easing-functions): ease (0.25, 0.1, 0.25, 1), ease-in
(0.42, 0, 1, 1), ease-out (0, 0, 0.58, 1), ease-in-out (0.42, 0, 0.58, 1).

**Classic Equations (Penner)** — http://robertpenner.com/easing/ (terms: http://robertpenner.com/easing_terms_of_use.html),
normalised to t ∈ [0, 1]: sine in 1 − cos(πx/2); quad … quint in xⁿ; expo in 2^(10x − 10) (0 at x = 0); circ in
1 − √(1 − x²); back in (s + 1)x³ − s·x² with s = 1.70158; out(x) = 1 − in(1 − x) (expo out 1 − 2^(−10x), 1 at 1);
in-out = in(2x)/2 for x < ½, 1 − in(2 − 2x)/2 after (back in-out uses s·1.525, expo in-out Penner's own split).
Expo is fitted with its analytic derivative (its ends are special-cased, so finite differences there would be
wrong). Note Penner's expo starts at 2⁻¹⁰ ≈ 0.001 just after 0; the pinned (0, 0) is within the tolerance.

**Overshoot & Anticipation** (ours) — the back polynomial family parametrised by the peak overshoot p instead of
Penner's constant: out(x) = 1 + (s+1)u³ + s·u², u = x − 1; dout/du = 0 at u = −2s / (3(s+1)), where the overshoot
is 4s³ / (27(s+1)²) (monotone in s; solved by bisection, `backStrengthForOvershoot`; p = 0.1 gives Penner's
1.70158). Amounts: light 5 %, medium 12 %, strong 25 %. Anticipate In = 1 − out(1 − x) (dips by p);
Anticipate & Overshoot = in-out composition of the two.

**Elastic** (ours) — n full cosine cycles under an exponential envelope normalised to reach 0 exactly at x = 1:
out(x) = 1 − cos(2πn·x) · (e^(−d·x) − e^(−d)) / (1 − e^(−d)); in(x) = 1 − out(1 − x). n ∈ {2, 3, 5} swings
(n overshoots), decay d: soft 3, medium 6, strong 10; out: the full 3 × 3 grid; in: n ∈ {2, 3, 5} with medium decay.

**Bounce** (ours) — a ball dropped at rest from height 1 under constant gravity g, keeping a fraction e (coefficient
of restitution) of its speed at each impact. Fall time t0 = √(2/g); after impact k the speed is e^k·g·t0, so
bounce k lasts 2e^k·t0 and peaks at (e^k·g·t0)² / (2g) = e^(2k). With N bounces the total time is
t0(1 + 2Σₖ₌₁ᴺ e^k) = 1, giving t0 = 1 / (1 + 2Σ e^k) (and g = 2/t0²). Progress = 1 − height: (x/t0)² while falling,
1 − e^(2k)(1 − u²) in bounce k (u ∈ [−1, 1] across it). e is chosen so the last bounce is 1 % of the drop:
e^(2N) = 0.01 → e = 0.01^(1/(2N)) (N = 2: 0.316, 3: 0.464, 4: 0.562, 5: 0.631). Out / In (= 1 − out(1 − x)) /
In-Out (composition), N = 2…5. Each falling / rising arc is a parabola in x, so the Hermite pieces are exact;
points land on every contact and apex (2N + 2 points for out / in).

**Spring** (ours) — unit-mass damped harmonic oscillator released at rest at 0 toward 1, damping ratio ζ, natural
frequency ω. Underdamped: y(τ) = 1 − e^(−ζωτ)(cos ω_d·τ + (ζω/ω_d) sin ω_d·τ), ω_d = ω√(1 − ζ²), with
ω = ln(1/ε)/ζ so the envelope e^(−ζωτ) is ε = 0.001 at τ = 1. Critical (ζ = 1): y = 1 − e^(−ωτ)(1 + ωτ) with
(1 + ω)e^(−ω) = ε solved by Newton (ω ≈ 9.23). The curve is y(τ)/y(1) so it ends exactly at 1 (a ≤ 0.1 % rescale).
ζ: critical 1, smooth 0.7, gentle 0.5, bouncy 0.3, wobbly 0.15. The first overshoot of an underdamped spring is
e^(−πζ/√(1−ζ²)) (standard second-order step response), checked in the tests for ζ = 0.3.

**Material Motion** — Material Design 3 easing tokens, https://m3.material.io/styles/motion/easing-and-duration/tokens-specs.
That page renders client-side only, so the values were taken from the machine-readable token sources it is
generated from: material-web `tokens/versions/v0_192/_md-sys-motion.scss` at commit 60c3e53
(https://github.com/material-components/material-web/blob/60c3e5377ea15d0c6e3b8e3d6bac90889063ebbf/tokens/versions/v0_192/_md-sys-motion.scss):
standard (0.2, 0, 0, 1), standard decelerate (0, 0, 0, 1), standard accelerate (0.3, 0, 1, 1), emphasized decelerate
(0.05, 0.7, 0.1, 1), emphasized accelerate (0.3, 0, 0.8, 0.15), legacy (0.4, 0, 0.2, 1), legacy decelerate
(0, 0, 0.2, 1), legacy accelerate (0.4, 0, 1, 1). Emphasized is a two-piece path, which the web tokens can only
approximate in CSS (their `easing-emphasized` falls back to (0.2, 0, 0, 1)); the path is from Material Components
for Android `lib/java/com/google/android/material/motion/res/values/tokens.xml` at commit 66b0eeb
(https://github.com/material-components/material-components-android/blob/66b0eeb53afeb6025ffbbd37734b08e5bce197ed/lib/java/com/google/android/material/motion/res/values/tokens.xml),
`m3_sys_motion_easing_emphasized_path_data` = `M 0,0 C 0.05, 0, 0.133333, 0.06, 0.166666, 0.4 C 0.208333, 0.82,
0.25, 1, 1, 1`, stored as a 3-point multi curve. The Android file lists emphasized decelerate as (0.1, 0.7, 0.1, 1)
and accelerate as (0.3, 0, 0.8, 0.2); we use the web token values (as published for the M3 spec page).
These are numeric facts; no Material code or assets are included.

### Measured accuracy

Max |curve − source| over 10 000 evenly spaced x (`easeCurveMaxError(p.curve, builtinEaseSource(p.id), 9999)`).
Rerun (from `packages/project`):
`npx tsx -e "import('./src/ease/presets.ts').then(async (m) => { const f = await import('./src/ease/fit.ts'); for (const p of m.builtinEasePresets()) console.log(p.id, f.easeCurveMaxError(p.curve, m.builtinEaseSource(p.id), 9999).toExponential(2)); })"`.
`packages/project/test/ease-presets.test.ts` checks the Penner presets against an independent copy of the equations
on 2000 samples and pins the published CSS and Material control points. The 10 000-sample comparison above is
a diagnostic against the production source functions, not an independent regression oracle.

| Id | Name | Curve | Max error |
|---|---|---|---|
| `basic.linear` | Linear | cubic | < 1e-9 |
| `basic.easy-ease` | Easy Ease | cubic | < 1e-9 |
| `basic.easy-ease-in` | Easy Ease In | cubic | < 1e-9 |
| `basic.easy-ease-out` | Easy Ease Out | cubic | < 1e-9 |
| `basic.ease` | Ease (CSS) | cubic | < 1e-9 |
| `basic.ease-in` | Ease In (CSS) | cubic | < 1e-9 |
| `basic.ease-out` | Ease Out (CSS) | cubic | < 1e-9 |
| `basic.ease-in-out` | Ease In-Out (CSS) | cubic | < 1e-9 |
| `penner.sine-in` | Sine In | cubic | 4.17e-4 |
| `penner.sine-out` | Sine Out | cubic | 4.17e-4 |
| `penner.sine-in-out` | Sine In-Out | cubic | 2.84e-4 |
| `penner.quad-in` | Quad In | cubic | < 1e-9 |
| `penner.quad-out` | Quad Out | cubic | < 1e-9 |
| `penner.quad-in-out` | Quad In-Out | cubic | 3.10e-3 |
| `penner.cubic-in` | Cubic In | cubic | < 1e-9 |
| `penner.cubic-out` | Cubic Out | cubic | < 1e-9 |
| `penner.cubic-in-out` | Cubic In-Out | cubic | 8.39e-3 |
| `penner.quart-in` | Quart In | cubic | 6.82e-4 |
| `penner.quart-out` | Quart Out | cubic | 5.05e-4 |
| `penner.quart-in-out` | Quart In-Out | multi, 4 pts | 1.95e-3 |
| `penner.quint-in` | Quint In | cubic | 8.42e-4 |
| `penner.quint-out` | Quint Out | cubic | 8.42e-4 |
| `penner.quint-in-out` | Quint In-Out | multi, 4 pts | 1.53e-3 |
| `penner.expo-in` | Expo In | cubic | 1.18e-3 |
| `penner.expo-out` | Expo Out | cubic | 1.18e-3 |
| `penner.expo-in-out` | Expo In-Out | multi, 7 pts | 1.51e-3 |
| `penner.circ-in` | Circ In | cubic | 4.07e-4 |
| `penner.circ-out` | Circ Out | cubic | 2.70e-4 |
| `penner.circ-in-out` | Circ In-Out | multi, 11 pts | 9.67e-4 |
| `penner.back-in` | Back In | cubic | < 1e-9 |
| `penner.back-out` | Back Out | cubic | < 1e-9 |
| `penner.back-in-out` | Back In-Out | multi, 5 pts | < 1e-9 |
| `overshoot.anticipate-in-light` | Anticipate In (Light) | cubic | < 1e-9 |
| `overshoot.overshoot-out-light` | Overshoot Out (Light) | cubic | < 1e-9 |
| `overshoot.anticipate-overshoot-light` | Anticipate & Overshoot (Light) | multi, 5 pts | < 1e-9 |
| `overshoot.anticipate-in-medium` | Anticipate In (Medium) | cubic | < 1e-9 |
| `overshoot.overshoot-out-medium` | Overshoot Out (Medium) | cubic | < 1e-9 |
| `overshoot.anticipate-overshoot-medium` | Anticipate & Overshoot (Medium) | multi, 5 pts | < 1e-9 |
| `overshoot.anticipate-in-strong` | Anticipate In (Strong) | cubic | < 1e-9 |
| `overshoot.overshoot-out-strong` | Overshoot Out (Strong) | cubic | < 1e-9 |
| `overshoot.anticipate-overshoot-strong` | Anticipate & Overshoot (Strong) | multi, 5 pts | < 1e-9 |
| `elastic.out-2-soft` | Elastic Out: 2 Swings, Soft Decay | multi, 10 pts | 1.84e-3 |
| `elastic.out-2-medium` | Elastic Out: 2 Swings, Medium Decay | multi, 8 pts | 1.80e-3 |
| `elastic.out-2-strong` | Elastic Out: 2 Swings, Strong Decay | multi, 7 pts | 8.13e-4 |
| `elastic.out-3-soft` | Elastic Out: 3 Swings, Soft Decay | multi, 11 pts | 1.95e-3 |
| `elastic.out-3-medium` | Elastic Out: 3 Swings, Medium Decay | multi, 10 pts | 1.62e-3 |
| `elastic.out-3-strong` | Elastic Out: 3 Swings, Strong Decay | multi, 9 pts | 1.43e-3 |
| `elastic.out-5-soft` | Elastic Out: 5 Swings, Soft Decay | multi, 18 pts | 1.97e-3 |
| `elastic.out-5-medium` | Elastic Out: 5 Swings, Medium Decay | multi, 17 pts | 1.95e-3 |
| `elastic.out-5-strong` | Elastic Out: 5 Swings, Strong Decay | multi, 12 pts | 1.84e-3 |
| `elastic.in-2-medium` | Elastic In: 2 Swings, Medium Decay | multi, 7 pts | 1.80e-3 |
| `elastic.in-3-medium` | Elastic In: 3 Swings, Medium Decay | multi, 10 pts | 1.62e-3 |
| `elastic.in-5-medium` | Elastic In: 5 Swings, Medium Decay | multi, 13 pts | 1.95e-3 |
| `bounce.out-2` | Bounce Out: 2 Bounces | multi, 6 pts | 1.06e-8 |
| `bounce.out-3` | Bounce Out: 3 Bounces | multi, 8 pts | 2.64e-8 |
| `bounce.out-4` | Bounce Out: 4 Bounces | multi, 10 pts | 4.45e-8 |
| `bounce.out-5` | Bounce Out: 5 Bounces | multi, 12 pts | 7.12e-8 |
| `bounce.in-2` | Bounce In: 2 Bounces | multi, 6 pts | 1.06e-8 |
| `bounce.in-3` | Bounce In: 3 Bounces | multi, 8 pts | 2.64e-8 |
| `bounce.in-4` | Bounce In: 4 Bounces | multi, 10 pts | 4.45e-8 |
| `bounce.in-5` | Bounce In: 5 Bounces | multi, 12 pts | 7.12e-8 |
| `bounce.in-out-2` | Bounce In-Out: 2 Bounces | multi, 11 pts | 6.32e-9 |
| `bounce.in-out-3` | Bounce In-Out: 3 Bounces | multi, 15 pts | 4.13e-8 |
| `bounce.in-out-4` | Bounce In-Out: 4 Bounces | multi, 19 pts | 3.30e-8 |
| `bounce.in-out-5` | Bounce In-Out: 5 Bounces | multi, 23 pts | 3.61e-8 |
| `spring.critical` | Spring: Critically Damped | multi, 6 pts | 1.11e-3 |
| `spring.smooth` | Spring: Smooth | multi, 6 pts | 1.59e-3 |
| `spring.gentle` | Spring: Gentle | multi, 7 pts | 1.92e-3 |
| `spring.bouncy` | Spring: Bouncy | multi, 11 pts | 2.00e-3 |
| `spring.wobbly` | Spring: Wobbly | multi, 20 pts | 1.92e-3 |
| `material.standard` | Standard | cubic | < 1e-9 |
| `material.standard-decelerate` | Standard Decelerate | cubic | < 1e-9 |
| `material.standard-accelerate` | Standard Accelerate | cubic | < 1e-9 |
| `material.emphasized` | Emphasized | multi, 3 pts | < 1e-9 |
| `material.emphasized-decelerate` | Emphasized Decelerate | cubic | < 1e-9 |
| `material.emphasized-accelerate` | Emphasized Accelerate | cubic | < 1e-9 |
| `material.legacy-standard` | Legacy Standard | cubic | < 1e-9 |
| `material.legacy-decelerate` | Legacy Decelerate | cubic | < 1e-9 |
| `material.legacy-accelerate` | Legacy Accelerate | cubic | < 1e-9 |

Per group worst (measured): basic 0, penner 1.95e-3 (quart in-out), overshoot 8.3e-11, elastic 1.97e-3, bounce
7.1e-8, spring 2.00e-3 (bouncy, 1.996e-3), material 0. Largest multi curve: 23 points (bounce in-out, 5 bounces).

### Matching (`matchEasePreset`)

Samples the curve at 257 evenly spaced x and returns the preset whose curve is within the tolerance (default
1e-3) at every sample — the closest one when several are, the first in catalog order on ties — or null. Sample
based, so a cubic and the same curve written as a multi curve match. Preset samples are cached per curve object
(WeakMap), so a lookup against the 79 built-ins costs 257 curve evaluations plus array comparisons.

### Performance

`builtinEasePresets()` fits 62 source functions on its first call (nothing is fitted at import time:
`BUILTIN_EASE_PRESETS` is a read-only Proxy view that builds on first access); later calls return the cached frozen
array. The built-ins are not re-parsed with zod at build time (zod's first parse cost more than the fitting); the
tests parse every preset with `EasePresetSchema`.

Measured on the shared host (AMD Ryzen 7 7700, 16 threads, load average 60–80 from other jobs, Node 20.20.2 via
tsx, `process.cpuUsage()` around the first `builtinEasePresets()` call after import): cold first build 1.1–1.6 s CPU; warm refit of all 62 sources 0.43–0.58 s CPU. Calibration loop on the same
host and run (`for i < 1e7: s += Math.sqrt(i) * 1.0001`): 190–400 ms CPU, against ≈ 10 ms on an idle CPU of this
class (estimate). Scaled by that ratio the cold build is ≈ 50–80 ms and a warm refit ≈ 15–25 ms on an unloaded
machine — an estimate, not a measurement; it could not be measured unloaded here. The test only enforces a loose
5 s CPU ceiling and < 5 ms for the cached call.

### Names and translations

Preset and group names are English in the catalog. They reach `apps/web/src/i18n/model-strings.json` through
`apps/web/i18n/model-strings.ts` (`pnpm i18n` runs it, then `scripts/i18n.mjs` merges it into `en.json`), which
now adds `builtinEasePresets()` names and `BUILTIN_EASE_GROUPS` names (not `group`, which is an id). Spanish
translations are in `apps/web/src/i18n/es.json`. The UI must show them through `t(name)`.

### Limitations

- The fit tolerance is checked on the 1025-point grid; between grid samples the error can exceed it slightly
  (largest seen at 10 000 samples: 1.996e-3 for the defaults).
- Least squares, not minimax, picks the single cubic, so a function a minimax cubic could match within the
  tolerance may come back as a multi curve.
- Functions with more than 64 points' worth of detail at the tolerance are refused (`E_LIMIT`), not approximated.
- The performance budget (< 50 ms) is an estimate from a calibration ratio on a loaded host (see above).

## Easing commands

Document-level commands that shape keyframe timing with ease curves, copy / paste eases and values, edit key
velocities numerically, drive a motion path from a slider and clean up motion paths. The feature set follows
public descriptions of keyframe-easing assistants for motion-graphics tools; names, curves and texts here are
original. Code: `packages/project/src/ease/` (`curve.ts` contract, `segments.ts`, `multi.ts`, `path-fit.ts`),
`packages/project/src/commands/{schemas,handlers}/ease.ts`, `handlers/ease-read.ts` (pure read helpers),
`packages/expressions/src/presets.ts` (Overshoot, Bounce).

### Model recap

- A key stores its outgoing `interpolation`, an optional incoming `inInterpolation` (docs/wp-notes/keyframe-sides.md)
  and `easeIn` / `easeOut` = `{influence ∈ (0, 1], slope}`; the slope is relative to the segment's average speed
  (1 = linear). The evaluator's ONE rule, `segmentShape` (`keyframes.ts`), draws segment A → B from A's outgoing
  side and B's incoming side (After Effects): hold when A holds; linear when both sides are Linear; else
  `bezier(out, in)`, where a Linear side of a curved segment is After Effects' linear ease (influence ⅙, slope 1)
  and an Auto Bezier side is derived from the neighbours on every evaluation. A B without `inInterpolation` is read
  the legacy way: linear whenever A is Linear, a Linear B arriving with (⅓, 1). Every ease read below goes through
  `segmentShape` (`spanEases`), so what the commands, the panel and the agents report is what renders.
- spatial-points: an effect point (values normalised to the layer box) evaluates with the box's pixel metric
  (docs/wp-notes/spatial-points.md). The ease code takes the same metric (`Target.metric`, `groupMetric`):
  auto-bezier eases, average speeds (layer px/s), arc lengths of multi-point rebuilds and the clean-up fit are
  measured in those pixels, and `finish` refreshes auto-bezier eases and roving times with it.
- CSS `cubic-bezier(x1, y1, x2, y2)` ↔ eases (`curve.ts`): `out.influence = x1`, `out.slope = y1 / x1`,
  `in.influence = 1 − x2`, `in.slope = (1 − y2) / (1 − x2)`; influence 0 is stored as 0.001 (the closest the model
  holds). Exact both ways (property tests in `ease-curve.test.ts`, `ease-apply.test.ts`).
- A run of roving keys between two fixed keys is **one** segment shaped by the fixed keys' eases
  (`rovingProgress`); every ease command addresses a segment touching a roving key as its enclosing run.

### Writing one segment without disturbing the others (`writeSpan`)

To make span A → B exactly `bezier(out, in)` — A's outgoing side and B's incoming side Bezier with those eases —
while every other segment evaluates bit-identically:

- A's outgoing side becomes Bezier (`interpolation: 'bezier'`, `easeOut = out`). `keepIncoming` keeps the segment
  arriving at A: an explicit Auto / Continuous incoming side (they shape both sides) becomes Bezier frozen at the
  ease it contributed; a key read the legacy way takes the ease it arrived with as `easeIn` (Bezier, Hold and
  Continuous keys arrive with their stored ease).
- B's incoming side becomes Bezier with `in`; its outgoing side keeps its type, so the segment after B is unchanged:
  a legacy Bezier / Hold B just takes `easeIn`; a legacy Auto / Continuous B becomes `bezier` with its effective out
  ease (so `finish` cannot re-derive the in ease just set); a legacy Linear B gets `inInterpolation: 'bezier'` and
  keeps leaving Linear (previously it became Bezier and the key after it was patched); a per-side B gets
  `inInterpolation: 'bezier'` (`keepOutgoing` freezes a both-sided outgoing type).
- Already linear spans written with linear eases are left alone.

Multi-point rebuilds measure the effective eases (and the explicit incoming side, `explicitInSide`) on the key list
**before** inner keys are removed (auto-bezier eases depend on neighbours). Tests (`ease-sides.test.ts`) observe
`keyframe.applyEase`: a generated scalar span follows an independently solved CSS cubic to 1e-6, other segments
retain their values, invariants hold, and immutable reapplication is deterministic. A real Transform effect-point
command checks that the outside Auto Bezier segments retain their pixel-metric values. Multi-point rebuilds and
path cleanup check the curve/path in the layer box's pixels. Private `writeSpan` / `spanEases` output-shape probes
are unnecessary: these command results and the public ease-description/clipboard results own their contracts.

### `keyframe.applyEase { keyframeIds, curve, sections? }`

Keys are grouped by property in document order, then time. Sections (per property): `in` = the span arriving at the
first selected key, `middle` = every span between two consecutive selected keys that are adjacent (or in one roving
run), `out` = the span leaving the last selected key; missing neighbours are skipped. Default: 2+ selected keys →
`middle`, one key → `in` + `out`.

- **cubic**: every chosen span gets `cubicToEases(curve)` through `writeSpan`; the span then evaluates exactly as
  CSS `cubic-bezier` (verified to 1e-9 through `keyframe.applyEase`; neighbouring linear, Auto Bezier, hold and
  continuous segments are checked for preservation through the same command boundary).
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
  path's arc length L from A to B through the removed keys (effect points: measured on the keys in the layer box's
  pixels, `keysInMetric`, with points and handles mapped back — the evaluator's metric; measured on a 1920 × 1080
  Transform Position arch, the rebuilt motion is within 0.75 px of the curve's pixel arc fraction, while the
  metric-free layout is several px off, `ease-sides.test.ts`); y < 0 / y > 1 continue straight along the start / end
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

### Clipboard: `copyEase`, `keyframe.pasteEase`, `copyValues`, `keyframe.pasteValues`

- `copyEase(doc, ids)` (pure; reads locked tracks): one key → `{kind: 'key', easeIn, easeOut, inInterpolation,
  interpolation}` — its two sides (keyframe-sides): per side the ease it contributes to its segment as rendered (a
  Linear / Hold side: the ease it would contribute) and its type — incoming = the explicit side reproducing the
  arriving segment (`explicitInSide`: a legacy key is Linear after a Linear key, Bezier for a Hold key or a Linear
  key after a curving one), outgoing = `interpolation`; Auto / Continuous on a key whose sides then differ become
  Bezier at their contributed ease; a roving key copies its run's two ends as Bezier sides;
  otherwise `{kind: 'segments', segments}` = the `middle` spans of every property as cubic-bezier, plus — for 3+ keys
  of one property — `curve`: all keys first … last as a multi curve (x = normalised time, y = normalised value:
  arc fraction for points, projection on B − A for vectors; handles from the segments' eases). The curve is omitted
  when it cannot be expressed (equal end values, a hold or roving run inside, y beyond ±10, > 64 points). With no
  span and several single keys the first key's eases are copied.
- `pasteEase`: `key` → both sides of every target key as `keyframe.setInterpolation` sets them (Premiere / After
  Effects): the target key takes the copied incoming type and ease and the outgoing ones, the next key's incoming
  side becomes explicit (so the segment leaving the target is read per side), the neighbours keep their own sides —
  a Linear neighbour of a now curved segment contributes ⅙·1, as an Ease In after a Linear key (previously the
  neighbour was converted to Bezier ⅓·1); a neighbouring hold keeps holding; Auto Bezier re-derives its eases from
  the target's neighbours and Continuous Bezier matches its in speed to its out speed, as those types do; a clip
  without types (older entries, agents) pastes Bezier sides; a roving key takes its run's ease and is skipped; `segments` with `curve` and `mode ≠ 'segments'` → like `applyEase` multi; otherwise 1
  curve → every target span (sections as above), n curves → in order (property, then time); a count mismatch pastes
  min(n, m) with `W_EASE_COUNT_MISMATCH`. `mode: 'curve'` without a curve refuses.
- `copyValues` / `pasteValues`: values in order (property, then time), each validated like `keyframe.update`
  (`W_VALUE_CLAMPED`, `E_INVALID_PARAM` for a wrong type); times and eases kept; count mismatch → min +
  `W_EASE_COUNT_MISMATCH`.

### Velocity: `describeKeyframeEases`, `keyframe.setVelocity`

`speed = slope × average velocity of the span`, average velocity = Δv / Δt in units per second (signed for numbers;
Euclidean for vectors; arc length for curved spatial segments; the run's travelled distance for roving runs — the
evaluator's `distance`). `setVelocity {keyframeId, side, speed?, influence? (0.1 … 100 %)}` writes through
`writeSpan` (the segment's other side keeps the ease it contributes, a Linear side as an equivalent Bezier side);
a span whose value does not change (Δv = 0) cannot hold a nonzero speed (refused), a held span and a roving key are
refused, `both` sets the sides that exist. Effect points measure speeds in layer px/s. `describeKeyframeEases`
returns per property the selected keys (time, value, interpolation, `inInterpolation` when explicit, effective in /
out side with its type, influence %, slope, speed) and the in / middle / out segments as cubic-bezier with `hold`,
`linear`, their two side types (`outInterpolation`, `inInterpolation` = the type B's incoming side acts as) and
their average speed — all from `segmentShape`.

### `keyframe.createPathController { keyframeIds, replaceExpression? }`

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

### `keyframes.cleanupPath { keyframeIds, tolerance? = 0.5 }`

`keyframes.simplify` keeps the *timing* at every frame and refits temporal eases; Clean Up Path is a different
measure, so it is a separate planner (`path-fit.ts`) rather than a mode of the simplifier: the span's timing becomes
linear (A leaves Linear with its arriving segment kept by `keepIncoming`; the kept keys between are legacy Linear; a
per-side B arrives Linear, an Auto Bezier B is frozen so the segment after it is unchanged) and the fewest keys are
kept whose drawn path stays within the tolerance (sequence px for Motion; layer px for effect points, fitted on the
keys in the metric's pixels). Fit after Schneider, "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990),
implemented from the published description: per candidate span one cubic from key i to key j with end tangents along
the original path's directions there, least squares on chord-length parameters with Newton re-parameterisation,
accepted when the two-sided distance (original samples ↔ fitted curve) is within the tolerance; shortest path over
accepted spans (dynamic programming), scans stop after 6 rejected ends or 128 segments. Consecutive keys keep their
original segment, so a solution always exists. Keys outside the span and their segments are unchanged.

### Expression presets

`overshoot` (damped sine past each key, amplitude = 15 % of the change into it) and `bounce-back` (the value
bounces back off each key's value with restitution 0.6 under constant pull 4000 units/s², up to 8 bounces; needs
speed into the key) join `inertial-bounce` (velocity-driven decaying sine).

### Warnings and refusals

`W_EASE_SKIPPED`, `W_EASE_FLAT_SEGMENT`, `W_EASE_CLAMPED`, `W_EASE_COUNT_MISMATCH`, `W_EASE_ROVING_CLEARED`,
`W_VALUE_CLAMPED`; refusals `E_NOT_FOUND`, `E_TRACK_LOCKED`, `E_INVALID_PARAM`. Every command is one undoable
transaction (`packages/session/test/ease-history.test.ts`).

## Easing panel

The Easing panel (`apps/web/src/panels/easing/`, Window ▸ Easing, docked with Effect Controls) shapes an ease curve
and applies it to the selected keyframes, keeps curves in a library, and copies / pastes eases and values between
keys. Its controls run the easing UI commands (`apps/web/src/commands/easing.ts`), which are also in the command
palette, Clip ▸ Keyframe Easing, the panel menu, the Effect Controls key menu and the keymap, so every disabled
control shows the same reason (no keyframe selection, a locked track, a read-only project, a selection the action
does not apply to, or a document command this build lacks).

### Curve model and the selection

A curve is `EaseCurve` (`packages/project/src/ease/curve.ts`): `cubic` = CSS `cubic-bezier(x1, y1, x2, y2)` over one
segment, `multi` = points from (0, 0) to (1, 1) with optional in / out handles over several segments; y may leave
0…1 (overshoot) within `EASE_Y_LIMIT`. The panel reads the selection with `describeKeyframeEases` (per property: the
selected keys with their effective eases and the in / middle / out segments as cubics, see "Easing commands"). The
editor shows, per property: the one middle segment; for two or more middle segments the span's multi-point curve
from `copyEase` (first segment's cubic when the span cannot be one curve); for a single key its leaving, else
arriving, segment. Several properties get a switcher.

### Editor

- Drag handles and points; Shift keeps the axis that moved further; a symmetric cubic stays symmetric and a smooth
  multi-curve point (in and out handles on one line) stays smooth, unless Alt is held.
- Ctrl/Cmd-click the curve adds a point by splitting the piece at that time with de Casteljau's algorithm, so the
  shape does not change; Ctrl/Cmd-click a point removes it (the two neighbouring handles stay). A multi curve left
  with its end points becomes a cubic. Double-click empty space resets to linear.
- Keyboard: Tab reaches each handle (`role="slider"`), arrows nudge by 0.01 (Shift 0.1), `+` adds a point in the
  middle of the widest piece, Delete removes the focused point, Ctrl/Cmd+Z and Ctrl/Cmd+Shift+Z (or the Undo /
  Redo buttons) step through the editor's own history (100 steps), separate from document History.
- Mirror makes the curve point-symmetric about (½, ½) from its first half (the first handle of a cubic, the points
  before the middle of a multi curve).
- Numeric fields: x1 y1 x2 y2 for a cubic; per point x, y and handle coordinates for a multi curve. The text field
  reads `cubic-bezier(a, b, c, d)`, a bare `a, b, c, d` / `[a, b, c, d]` / `a b c d`, or the CSS keywords `linear`,
  `ease`, `ease-in`, `ease-out`, `ease-in-out` (CSS Easing Functions Level 1, §2.2), and writes the CSS form
  rounded to 3 decimals. Pasting a valid value applies it at once; invalid text is refused with the reason.
- Every function in `curve-edit.ts` returns a schema-valid curve (handles clamped into their piece, points kept
  apart, y within the limit); a fast-check test runs random add / remove / drag / mirror sequences against
  `EaseCurveSchema`.
- Auto-apply: a drag is one live gesture (`session.beginGesture`, the document updates while dragging and commits
  once, one undo step); other committed edits apply through the Apply Ease command, one undo step each.
- The view's vertical range grows in quarter steps to show the curve; it is frozen during a drag so the handle stays
  under the pointer. The bands above 1 and below 0 are shaded (`--pr-warning` mixed into the graph background).

### Targeting

The In | Middle | Out control picks the segments explicitly (none = the command's automatic choice: between selected
keys, or both sides of a single key; multi curves only between keys). Click modifiers on Apply, Paste Ease and
library tiles override it for that click: Shift = in, Alt = out, Ctrl (Cmd on macOS) = middle, and they add up. The
info line counts the segments and properties an apply reaches, following the modifiers held at that moment.

### Preview

A dot travels and a bar scales along the edited (or hovered) curve: 1.1 s play, 0.45 s hold, looping, with room
for overshoot at both ends. With `prefers-reduced-motion`, or while the panel is hidden, it shows five still frames
(u = 0, ¼, ½, ¾, 1) instead of animating.

### Library

Tabs: Favourites, the built-in groups (read-only; Duplicate to My Curves copies one), the user's groups (New Group,
rename / delete from the tab's context menu; a deleted group's curves move to My Curves). Tiles: size slider
(40–160 px), fitted or fixed columns; hover previews a curve and shows its values in the info line; click applies
it (with the targeting modifiers) and loads it into the editor; the tile matching the editor's curve is
highlighted. User curves: rename (F2 or menu), colour label (the design tokens' label palette), move to a group
(menu, or drop on a tab), reorder (drag, Alt+←/→ on a focused tile, or Move Earlier / Later), delete (with Undo in
the notice), favourite. The library, recent curves, favourites and the panel settings (view, tile size, columns,
sections, Auto-apply, active tab, current curve) are a per-user preference in `localStorage`
(`jasper.easing.v1`, schema version 1): each entry is validated with zod on load and a damaged one is dropped on its
own; a library written by a newer version is neither read nor overwritten.

Export writes `{format: "jasper-ease-presets", version: 1, groups, presets}` (the active user group, or every user
curve). Import refuses files over 1 MB, non-JSON, other formats and newer versions; each preset is validated with
`EasePresetSchema` (plus the optional colour), invalid ones are skipped and listed (first five reasons), clashing ids
get new ones, groups are matched by id or name or created; the library limits (1000 curves, 100 groups) hold.

### Keyframe Velocity

Under the curve fields: for one selected key of the shown property (a key picker when several are selected), its In
and Out speed (property units per second; px/s along the path for point properties) and influence (%) as
`describeKeyframeEases` reports them. Editing a field runs `keyframe.setVelocity` (one undo step, history label
"Keyframe Velocity"); influence is clamped to 0.1…100 %. Link sets both sides at once (`side: "both"`). A side without
a segment, a hold segment or a roving key is disabled with that reason; on a flat segment (both keys equal, average
speed 0) only the speed is disabled — influence still applies.

### Commands, menus and shortcuts

| Command | Default key | Document command |
| --- | --- | --- |
| Easy Ease / Easy Ease In / Easy Ease Out | F9 / Shift+F9 / Ctrl(Cmd)+Shift+F9 | `keyframe.setInterpolation` (bezier, {⅓, 0} on the side) |
| Apply Ease | — | `keyframe.applyEase` |
| Copy Ease / Paste Ease | Ctrl(Cmd)+C / Ctrl(Cmd)+V in the Easing panel | `copyEase` + `copyValues` / `keyframe.pasteEase` |
| Paste Values | — | `keyframe.pasteValues` (history: "Paste Keyframe Values") |
| Keyframe Velocity (panel fields; agents) | — | `keyframe.setVelocity` |
| Duplicate / Mirror Keys at Playhead | — | `keyframe.paste` (mirror: reversed payload, latest key at the playhead) |
| Spatial ▸ Linear, Temporal ▸ Continuous | — | `keyframe.setSpatialInterpolation`, `keyframe.setInterpolation` |
| Drive Along Path, Clean Up Motion Path | — | `keyframe.createPathController`, `keyframes.cleanupPath` |
| Add Overshoot / Bounce Expression | — | `expression.set` with the `overshoot` / `bounce-back` presets |

F9 is free in the default layout; in the Final Cut Pro 7 layout F9 stays Insert in the editing panels (their scope
comes first) and is Easy Ease elsewhere. Apply, Paste Ease and Clean Up keep the result selected (the eased keys plus
the keys a multi-point curve created, minus removed ones), so a second apply reaches the same span. Every warning of
a result (W_EASE_SKIPPED, W_EASE_FLAT_SEGMENT, W_EASE_CLAMPED, W_EASE_COUNT_MISMATCH, W_EASE_ROVING_CLEARED,
W_VALUE_CLAMPED) is listed in one toast; a refusal shows "<action>: not possible" with the model's message. Drive
Along Path needs two or more keys of one point property. Mirror Keys at Playhead reuses the keyframe paste's reversed
path (`reversedKeyTiming`, `reversedSpatial`), so each segment's ease is mirrored: cubic (x1, y1, x2, y2) becomes
(1 − x2, 1 − y2, 1 − x1, 1 − y1) — tested.

### Status and limits

- Easing actions use commands registered in the static document catalogue. Selection, read-only, track locking,
  clipboard contents and argument validation determine availability; model refusals remain visible.
- The built-in groups and curves are the catalogue of "Built-in presets" above (`builtinEasePresets()`, shown with
  `t(name)`); the highlighted tile is `matchEasePreset` of the editor's curve against built-in and user curves.
- Effect Controls ▸ key menu ▸ Apply Ease ▸ lists the recent curves (named after the matching preset) and the
  favourites; its submenu is placed `fixed` beside its row because the key menu scrolls. Spatial Interpolation ▸
  in the same menu does the same through `placeBeside` / `useMenuFit` (`@jasper/ui`), flipping left at the window
  edge (`apps/web/test/motion-path.test.tsx`).
- Verified in the running app (dev stack, demo project, a colour matte with Opacity and Position keys): library
  preset apply (Cubic Out; Bounce Out: 4 Bounces creating keys, the tile matched afterwards), the Effect Controls
  value / velocity graphs matching the editor's curve, Keyframe Velocity edits, Copy → Paste Ease onto Position,
  Paste Values, Drive Along Path, Clean Up Motion Path, Mirror Keys at Playhead, Add Overshoot Expression, a refusal
  toast (flat span), Auto-apply drag (live gesture, one "Apply Ease" history entry), F9 Easy Ease, Apply Ease ▸
  recent curve from the key menu.
- Export (2026-10-20, shared host at load ≈ 40–55, `--maxWorkers=1`): `apps/engine/test/native-animated.test.ts`
  exports a card eased by `keyframe.applyEase` (Overshoot Out (Strong) on Scale — peak 95 % for keys 45 → 85 —, Bounce
  Out: 3 / 2 Bounces on Rotation / Opacity, Anticipate & Overshoot (Medium) rebuilding a curved Position path) and a
  `keyframe.createPathController` card natively (ProRes 4444, 1080p, 48 frames): measured corners within 0.043 px
  (eased) / 0.004 px (controller) of the evaluator's quad on every frame (≤ 0.1 px required), colour ≤ 1.6/255 at the
  overshoot and bounce frames. With `REMOTION_E2E=1`, native vs Remotion SSIM min 0.9994 (eased) / 0.9988
  (controller), ≥ 0.98 required.
- Tests: `apps/web/test/easing-curve-edit.test.ts`, `easing-library.test.ts`, `easing-commands.test.ts` (the real
  commands: apply cubic and multi, undo, refusal, copy / paste ease and values, velocity, path controller, clean-up,
  duplicate / mirror, expressions, shortcuts), `easing-panel.test.tsx` (editor, targeting, velocity editor, library).
