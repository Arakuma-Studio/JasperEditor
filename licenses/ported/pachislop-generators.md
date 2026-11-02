# Pachislop: title generators

- **Upstream:** https://github.com/SafEight/pachislop (commit `dd952d0`)
- **Licence:** LicenseRef-Pachislop
- **Copyright:** Copyright (c) 2026 SafEight
- **Ported by:** title-looks generators, 2026-11-02

| Upstream path | Our path | What |
|---|---|---|
| `src/effects/lib.ts` (`NOISE_GLSL`), `src/generators/energy/shared.ts` | `packages/project/src/registry/fx/title-look/generators/shared.ts` | Value noise, fbm, the upstream distance |
| `src/generators/energy/fire.ts` | `packages/project/src/registry/fx/title-look/generators/fire.ts` | Flames from the shape's edges, presets |
| `src/generators/energy/smoke.ts` | `packages/project/src/registry/fx/title-look/generators/smoke.ts` | Billowing smoke, presets |
| `src/generators/energy/corona.ts` | `packages/project/src/registry/fx/title-look/generators/corona.ts` | Tendrils and aura, presets |
| `src/generators/energy/lightning.ts` | `packages/project/src/registry/fx/title-look/generators/lightning.ts` | Bolt composition, modes, core and glow, presets |
| `src/generators/lines/sunburst.ts` | `packages/project/src/registry/fx/title-look/generators/sunburst.ts` | Sunburst, wedges, focus lines, speed rings |
| `src/generators/lines/lightStreaks.ts`, `src/generators/lines/shared.ts` | `packages/project/src/registry/fx/title-look/generators/light-streaks.ts` | Streak shading, taper, presets |
| `src/generators/lines/speedLines.ts` | `packages/project/src/registry/fx/title-look/generators/speed-lines.ts` | Focus, flow, flash and burst lines, wedge shading, presets |
| `src/generators/light/lensFlare.ts`, `src/generators/common.ts` (`ANAMORPHIC_GLSL`) | `packages/project/src/registry/fx/title-look/generators/lens-flare.ts` | Anamorphic flare |
| `src/generators/light/backlight.ts` | `packages/project/src/registry/fx/title-look/generators/backlight.ts` | Masked radial blur |
| `src/generators/rings/shockwave.ts` | `packages/project/src/registry/fx/title-look/generators/shockwave.ts` | Band profiles, fibres, smear, flash |
| `src/generators/rings/magicCircle.ts` | `packages/project/src/registry/fx/title-look/generators/magic-circle.ts` | Rows as distance fields, floor plane, presets |
| `src/generators/rings/brushSwirl.ts` | `packages/project/src/registry/fx/title-look/generators/brush-swirl.ts` | Stroke paths, pressure, bristles, droplets |
| `src/generators/inkSplatter.ts` | `packages/project/src/registry/fx/title-look/generators/ink-splatter.ts` | Drops, drag streaks, satellites |
| `src/generators/particles.ts` | `packages/project/src/registry/fx/title-look/generators/particles.ts` | Emitters, distributions, depth, 11 shapes, presets |
| `src/generators/glints.ts` | `packages/project/src/registry/fx/title-look/generators/glints.ts` | Peak scoring, greedy spacing, star sprites, hero glint |
| `src/generators/pattern.ts`, `src/engine/patterns.ts` | `packages/project/src/registry/fx/title-look/generators/pattern.ts` | Procedural marks, floor plane |

## Changes made when porting

- Pachislop has no time input: these are stills. Every generator here is a closed form of `u_tlTime` and the seed, with no
  history. Noise scrolls and evolves, particles have a wrapped seeded age and a ballistic position, and scatter moves, which
  it does not upstream.
- Pachislop's CPU layout (particle lists, bolt segments, ribbons, speed-line tables) became vertex shaders over
  `gl_InstanceID` and `gl_VertexID`. Its read-backs became GPU passes: Glints scores peaks, tracks homes and spaces them
  greedily with no read-back, and the speed-line title focus sphere-traces the shared field.
- Rejection sampling over the current picture, which re-rolls when a cell flips, became seeded sites that read the nearest
  part of the shape from the field, so particles, drops and bolts keep their identity when the title's pixels change.
- Shockwave's noise read the current radius, which makes the texture swim. It reads a frozen Texture Radius.
- Lightning's midpoint displacement became 1D fractal noise along the bolt, with hold-frame and continuous modes.
- Float hashes became integer hashes (`GLSL_HASH`), and distances are percentages of the look's unit, never pixels.
- Glows that were separate effects on a layer are part of each generator (lightning, streaks, particles).
- Magic Circle text rows drew a font atlas on a canvas, which a pure plan cannot. Glyph rows are procedural strokes (runes,
  trigrams, segment digits). The kanji sets were not ported.
- Preset names and descriptions that named Japanese terms or real titles were rewritten as generic descriptions (TL-001).
- Follow-layer plumbing (`drawFollowed`, `followParam`) was not ported: the shared field and the layer's own place in a look
  do that job.
