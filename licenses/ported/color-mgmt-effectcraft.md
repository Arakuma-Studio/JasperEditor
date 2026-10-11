# Custom OpenColorIO configurations, ASC CDL, colour spaces with Bradford adaptation

- **Upstream:** https://github.com/storytold/effectcraft
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the EffectCraft contributors
- **Ported by:** color-mgmt, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/effects/src/ocio_config.rs` | `packages/project/src/color/ocio/yaml.ts`, `config.ts` | YAML subset reader, config (spaces, roles, displays), Matrix / File / Exponent / Log / LogAffine / CDL / Range / Group transforms, tests |
| `crates/effects/src/ocio.rs` (CDL, `.cc`/`.ccc`/`.cdl`, file inverse) | `packages/project/src/color/ocio/cdl.ts`, `config.ts` | ASC CDL v1.2 maths and XML, 1D exact / 3D iterative inverse |
| `crates/color/src/space.rs` | `packages/project/src/color/cms/matrix.ts`, `gamut.ts`, `packages/project/src/math/matrix3.ts` | Bradford chromatic adaptation, ACES AP0/AP1 primaries and white |

Notes: ported to TypeScript. Extended: OCIO v2 display colour spaces and view transforms, ExponentWithLinear,
LogCamera, ColorSpace, Allocation, ExposureContrast (linear), FixedFunction (ACES_GamutComp13, XYZ→xyY/uvY,
RGB→HSV) and Builtin transforms, interchange roles, self-contained bundles of a config's LUT files. Unlike EffectCraft,
transforms that cannot be applied refuse the conversion instead of passing colours through.
