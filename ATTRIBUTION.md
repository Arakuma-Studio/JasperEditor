# Attribution

Every non-code asset in JasperEditor, with its author, source and licence. Each file listed here also has a
`<file>.attribution` sidecar with the full details. The rules are in [AGENTS.md](AGENTS.md) §3: no Adobe or other
product artwork; open licences only; every asset attributed. `node scripts/check-assets.mjs` (part of `pnpm lint`)
checks that the sidecars and this index cover every asset in the repository, and prints the sidecar and row to
write when one is missing.

`LicenseRef-JasperEditor` marks original work made for this project, under the project's own licence (the
repository has no public licence yet). Third-party JavaScript packages are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md);
code ported from other projects is recorded in [licenses/ported/](licenses/ported/).

## Fonts

Font files committed in the repository. The fonts the engine serves at `/fonts` come from `@fontsource/*` npm packages and are listed in `THIRD_PARTY_NOTICES.md`.

| Asset | Author | Source | Licence |
|---|---|---|---|
| `native/mg/crates/jasper-mg-templates/media/Inter_24pt-Regular.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`native/mg/crates/jasper-mg-templates/FONTS-OFL.txt`) |
| `native/mg/crates/jasper-mg-templates/media/Inter_24pt-Bold.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`native/mg/crates/jasper-mg-templates/FONTS-OFL.txt`) |
| `fixtures/mg-project/public/fonts/Inter-Bold.ttf` | The Inter Project Authors | https://github.com/rsms/inter | OFL-1.1 (`fixtures/mg-project/public/fonts/OFL.txt`) |

## App icons

Code-drawn original artwork.

| Asset | Author | Source | Licence |
|---|---|---|---|
| `apps/web/public/icons/apple-touch-icon.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `apps/web/public/icons/favicon-16.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `apps/web/public/icons/favicon-32.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `apps/web/public/icons/icon-192.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `apps/web/public/icons/icon-512.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `apps/web/public/icons/icon-maskable-192.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `apps/web/public/icons/icon-maskable-512.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |

## Models and binaries

Shipped as separate files with their licence texts; also listed in Help ▸ About ▸ Licenses.

| Asset | Author | Source | Licence |
|---|---|---|---|
| `apps/engine/models/2xNomosUni_span_multijpg.onnx` | Philip Hofmann (weights); SPAN architecture by Hongyuan Yu et al. (Apache-2.0) | https://github.com/Phhofm/models/releases/tag/2xNomosUni_span_multijpg | CC-BY-4.0 (`apps/engine/models/LICENSE-CC-BY-4.0.txt`) |
| `apps/engine/src/processing/proc/vidstab/vidstab.wasm` | Georg Martius and the vid.stab contributors | https://github.com/georgmartius/vid.stab (commit e2445c4081658318223762a696eb1c645c2d7168) | LGPL-2.1-or-later (`apps/engine/src/processing/proc/vidstab/LICENSE-vidstab.txt`) |

## Project fixtures

Hand-made `.jasper` projects (schema history, loader and migration tests; see [docs/project-files.md](docs/project-files.md)).

| Asset | Author | Source | Licence |
|---|---|---|---|
| `packages/project/test/fixtures/v1/basic.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/v2/basic.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/v3/basic.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/v4/basic.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/v5/basic.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/schema-v1.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/schema-v2.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/schema-v3.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/schema-v4.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `packages/project/test/fixtures/schema-v5.jasper` | JasperEditor contributors | original work | LicenseRef-JasperEditor |

## Screenshots

Screenshots and contact sheets of JasperEditor itself, showing only generated media.

| Asset | Author | Source | Licence |
|---|---|---|---|
| `docs/screenshots/fx/motion-blur/renders-before-after.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/motion-blur/thin-line-before-after.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/premiere-adjust-color-keying/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/premiere-stylize-distort-generate/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-blur-sharpen/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-film-grain/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-paint-kaleido-edges/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-render-textures/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-stylize-other/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/transitions/sapphire-dissolves/contact-sheet.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m3-mgtext/fixture-applied.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-adjust-composite/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-distort-warp/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-glows-lighting/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-textures-clouds/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/fx/sapphire-time-flicker/contact-sheet.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/transitions/premiere/contact-sheet.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/transitions/sapphire-swish-other/contact-sheet.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/transitions/sapphire-wipes/contact-sheet.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/graph-editor/value-velocity-graphs.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m3-mgtext/fixture-on-canvas-editor.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m3-mgtext/fixture-properties-text-warnings.jpg` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-stabpath-process-dialog.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/01-editing-workspace.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/02-timeline.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/03-monitors.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/04-project-list.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/05-project-icon.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/06-effect-controls.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/07-tools.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/08-export-mode.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/09-home.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/10-phone.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/11-tooltip.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/12-menu.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/after/13-program-motion-graphic.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/01-editing-workspace.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/02-timeline.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/03-monitors.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/04-project-list.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/05-project-icon.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/06-effect-controls.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/07-tools.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/08-export-mode.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/09-home.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/m1/before/10-phone.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/01-editor.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/02-timeline-glyphs.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/03-link-click-tracking-section.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/04-simplify-dialog.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/05-simplify-0.5px.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/06-effect-controls-simplified.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/07-ec-keyframe-menu.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/08-simplify-from-ec.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |
| `docs/screenshots/wp-m3-trackui/09-strip-tooltip.png` | JasperEditor contributors | original work | LicenseRef-JasperEditor |

## Generated test media (never committed)

`fixtures/media/` is gitignored. `pnpm fixtures` ([scripts/make-fixtures.mjs](scripts/make-fixtures.mjs) and the recipe
modules in [scripts/fixtures/](scripts/fixtures/)) generates it with ffmpeg from synthetic sources only: `testsrc2`
colour patterns, `sine` tones and expression-drawn frames (`clip-a.mp4`, `clip-b.mp4`, `tone.wav`, `still.png`,
`frame-code.mp4`, the `overlay-alpha.*` files, `phone-rot90.mp4`, and the colour, processing, tracking and transition
fixtures). They are original work (`LicenseRef-JasperEditor`); a `.<name>.recipe` stamp next to each file records the
hash of its ffmpeg arguments. Tests that need other media generate it into temporary directories the same way.

## Removed on 2026-10-07, replaced on 2026-10-08

Eleven screenshots and contact sheets were removed because they showed third-party photographs or video whose source
and licence were never recorded (AGENTS.md §3.2, "when in doubt, leave it out"). None could be restored: every one of
them showed such pictures (a portrait, a market, a parrot, landscapes, a rover, a launch pad, a presenter, a trailer
shot), so the `fixups` workstream rendered equivalents over procedural pictures (`scripts/docs/gallery-scenes.mjs`,
ffmpeg lavfi sources only) and the repository fixtures, listed under Screenshots above with sidecars:

- the seven `docs/screenshots/fx/*/contact-sheet.png` and `docs/screenshots/transitions/sapphire-dissolves/contact-sheet.jpg`:
  regenerated by `packages/compositions/test/docs-gallery.e2e.test.ts` (and the family tests' own `SBS_SHEET` /
  `PSDG_SHEET` with the procedural picture);
- `docs/screenshots/m3-mgtext/trailer-mg07-{overflow-warnings,on-canvas-editor,applied}.jpg`: replaced by
  `fixture-properties-text-warnings.jpg` and `fixture-on-canvas-editor.jpg` (already in the repository, same
  features on `fixtures/mg-project`) and a new `fixture-applied.jpg` (`e2e/mg-texts.spec.ts`, `DOCS_SCREENSHOTS=1`).

## Speech fixtures

Public-domain speech for the speech-to-text tests (`apps/engine/test/speech-model.e2e.test.ts`); made by
`scripts/speech/make-fixture.mjs`.

| Asset | Author | Source | Licence |
|---|---|---|---|
| `fixtures/speech/lj-composite.flac` | Linda Johnson (reader, LibriVox); Keith Ito (LJ Speech Dataset) | https://keithito.com/LJ-Speech-Dataset/ | LicenseRef-PublicDomain |
