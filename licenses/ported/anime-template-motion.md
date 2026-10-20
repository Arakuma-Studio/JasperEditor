# anime.js ease curves for the anime templates' sound-design motion model

- **Upstream:** https://github.com/juliangarnier/anime (npm `animejs` 4.5.0, `dist/modules/easings/eases/parser.js`)
- **Licence:** MIT
- **Copyright:** Copyright (c) 2025 Julian Garnier
- **Ported by:** sound-design WP6.5b (cues), 2026-10-17

| Upstream path | Our path | What |
|---|---|---|
| `dist/modules/easings/eases/parser.js` (`easeInPower`, `easeTypes`, `easeInFunctions`: power, Quad…Quint, Sine, Circ, Expo, Bounce, Back, Elastic) | `packages/mg-templates/src/templates/anime/eases.ts` | the ease curves as plain functions (`animeEase`), so the pure layer evaluates the same eases the anime.js renderer seeks |

Notes: TypeScript; only the parameterless ease names the templates use (no `steps`, `cubicBezier`, `irregular` or
parameter strings); the `Bounce` loop is rewritten without an assignment inside its condition (same values). The
curves are Robert Penner's easing equations as simplified by anime.js. @jasper/motion's `mg-cue-timing` test compares
the port with anime.js at every frame of every anime template.
