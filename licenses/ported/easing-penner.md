# Robert Penner's easing equations, ported by the `ease-presets` workstream

- **Upstream:** http://robertpenner.com/easing/ (terms of use: http://robertpenner.com/easing_terms_of_use.html)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2001 Robert Penner
- **Ported by:** ease-presets workstream, 2026-10-20

| Upstream path | Our path | What |
|---|---|---|
| `easing/` (the published ActionScript equations: sine, quad, cubic, quart, quint, expo, circ, back × in / out / in-out) | `packages/project/src/ease/presets.ts` (`pennerEase`) | The equations rewritten in TypeScript for normalised time t ∈ [0, 1] (start 0, change 1, duration 1); the "Classic Equations" ease presets are fitted from them |
| `easing/` (back: overshoot constant s = 1.70158, in-out factor 1.525) | `packages/project/src/ease/presets.ts` (`overshootEase`, `backStrengthForOvershoot`) | Penner's back polynomial family, reused with our own strengths derived from a peak overshoot |

Notes: the upstream terms offer the equations under the MIT License and the 3-Clause BSD License; we use them under
MIT. Only the mathematical formulas were ported (no upstream source text); elastic and bounce are not ported — our
elastic, bounce and spring curves are our own physics (docs/wp-notes/easing.md "Built-in presets").
