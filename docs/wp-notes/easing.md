# Easing toolkit

## Built-in presets

Workstream `ease-presets` (branch `feat/ease-presets`). Code: `packages/project/src/ease/presets.ts` (catalog,
source functions, `matchEasePreset`) and `packages/project/src/ease/fit.ts` (curve fitter); tests:
`packages/project/test/ease-presets.test.ts`, `packages/project/test/ease-fit.test.ts`. The curve contract
(`EaseCurve`, `EasePreset`, `evaluateEaseCurve`, `EASE_Y_LIMIT` = 10, `MAX_EASE_POINTS` = 64) is in `curve.ts`.

The catalog is our own selection and naming, built only from public math: the CSS easing keywords (W3C), Robert
Penner's easing equations (MIT / BSD-3-Clause, port record `licenses/ported/easing-penner.md`), Material Design 3
motion tokens (published numbers) and our own physics (overshoot by peak amount, elastic, bounce, spring). No
third-party preset collection was consulted or copied.

### API

```ts
fitEaseCurve(fn: (x: number) => number, opts?: { tolerance?: number; maxPoints?: number; derivative?: (x: number) => number }): EaseCurve
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
   coarse steps exceeds 2 × tolerance (then no cubic can pass).
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

Deterministic: fixed grids and search orders, no randomness (tested by refitting every preset).

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
`packages/project/test/ease-presets.test.ts` asserts ≤ 0.002 on the same 10 000 samples for every preset, and
checks the Penner presets against an independent copy of the equations on 2000 samples. Exact curves (CSS,
Material, Basic) are their own source.

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
| `penner.quad-in-out` | Quad In-Out | multi, 3 pts | < 1e-9 |
| `penner.cubic-in` | Cubic In | cubic | < 1e-9 |
| `penner.cubic-out` | Cubic Out | cubic | < 1e-9 |
| `penner.cubic-in-out` | Cubic In-Out | multi, 3 pts | < 1e-9 |
| `penner.quart-in` | Quart In | cubic | 6.82e-4 |
| `penner.quart-out` | Quart Out | cubic | 5.05e-4 |
| `penner.quart-in-out` | Quart In-Out | multi, 4 pts | 1.95e-3 |
| `penner.quint-in` | Quint In | multi, 4 pts | 1.07e-3 |
| `penner.quint-out` | Quint Out | multi, 4 pts | 1.07e-3 |
| `penner.quint-in-out` | Quint In-Out | multi, 4 pts | 1.53e-3 |
| `penner.expo-in` | Expo In | cubic | 1.18e-3 |
| `penner.expo-out` | Expo Out | cubic | 1.18e-3 |
| `penner.expo-in-out` | Expo In-Out | multi, 7 pts | 1.51e-3 |
| `penner.circ-in` | Circ In | multi, 7 pts | 1.25e-3 |
| `penner.circ-out` | Circ Out | multi, 7 pts | 1.25e-3 |
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
