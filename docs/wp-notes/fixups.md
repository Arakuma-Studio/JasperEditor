# fixups — integration follow-ups of the parity program

Workstream `fixups` (branch `feat/fixups`): root-cause fixes, each with a regression test, for problems the other
workstreams found while merging, plus the decision log, the parity / gaps refresh and the screenshots removed by
`process`. No reference code was ported here (nothing to record in `licenses/ported/`).

## 1. Merge Paths collapsed at tangencies (shapes)

**Symptom.** The fast-check property of `packages/project/test/vector/ops.test.ts` (inclusion–exclusion of Add /
Intersect / Subtract / Exclude on random rectangles and circles) failed once in a full run and passed on rerun.

**Counterexample** (seed 1, run 460, shrunk): a circle of radius 21 at (0, −19) and a 10 px square at (−1, 2). The
circle's bottom vertex (0, 2) lies on the square's top edge: a tangency. Every merge mode returned an empty path.
A sweep of 90 000 random pairs (seeds 1–3) plus 15 744 constructed tangencies (circles touching squares on every
side at many offsets, circles touching circles inside and out) found no other failure after the fix.

**Root cause.** In PathBool.js 1.0.4 (`path-bool`, MIT), `sortOutgoingEdgesByAngle` orders the edges leaving a
vertex by `atan2` angle and breaks ties by curvature. At a tangency two edges leave along −x; `atan2` returned +π for
one (a zero y component) and −π for the other (a vanishing negative one), so they compared as far apart as possible,
the curvature tie-break never ran, the pair was ordered backwards, face tracing merged the whole arrangement into one
face, `computeNestingTree` dereferenced a null bounding box and threw, and `booleanLoops` caught it and returned
nothing.

**Fix.**
- `patches/path-bool@1.0.4.patch` (`pnpm patch`, `pnpm.patchedDependencies`, lockfile hash): angles within the
  vertex's tie tolerance of +π are folded below −π before sorting, so the two spellings of one direction tie and the
  curvature decides. The patched code carries a comment (D-45).
- `packages/project/src/vector/boolean.ts`: if PathBool.js still throws, retry once in a frame rotated by ≈ 0.45 rad
  and rotate the result back (round-off ~1e-15 of the extent) instead of silently dropping the shape.

**Tests.** `ops.test.ts` › "merge at tangencies" (the counterexample, and tangencies on every side / circles inside
and out) fails without either fix and passes with each alone. The random property now runs with a fixed seed, and a
second fast-check property draws only tangent circle/square pairs. `boolean-retry.test.ts` makes PathBool.js throw
once (and twice) through `vi.mock` and checks the rotated retry returns the same geometry in the original frame.

## 2. Escape did not cancel a shape drag (e2e `shapes.spec.ts`)

**Root cause.** Both the keymap dispatcher and the shape tool's gesture listener listen for `keydown` in the capture
phase on `window`; the dispatcher was installed first, so it ran first and executed `gesture.cancel`, which
deselects the timeline. That store update re-rendered the shape overlay synchronously, and its effect (no
dependency list) removed and re-added its key listener during the dispatch; a listener removed during dispatch is
not called, so the drag survived. Since `edit-ux` (75ff5d17) `gesture.cancel` also touches trim / play-around state,
which made the re-render certain.

**Fix.** (a) The dispatcher tracks held pointers (`pointerdown` / `pointerup` / `pointercancel`, a `pointermove`
without buttons, `blur`) and leaves Escape alone while one is held: Esc during a drag belongs to the drag (XF-053),
and the keymap's Escape no longer deselects at the same time. (b) `ShapeToolOverlay` and `TransformOverlay` register
one key listener for their lifetime that calls the latest render's handler (no re-subscription mid-dispatch).

**Tests.** `apps/web/test/shell.test.tsx` › "Esc during a pointer drag is left to the drag…" (fails without the
fix); `e2e/shapes.spec.ts` passes again and now also checks that Esc during the drag kept the selection.

## 3. Long context menus ran off the window

- `packages/ui/src/menu/placement.ts`: `placeAtPoint` (right/down from the point, flipped left/up, else pinned to
  the window edge with a max-height that scrolls), `placeBeside` (submenus: right of the item, else left; slid up to
  fit; scrolls when taller than the window), `useMenuFit` (measures after every render, so an inline list that opens
  — the Project panel's Label list — moves the menu). `PointMenu` renders such a menu in a portal on `<body>`
  (`fixed` inside a docked panel is relative to the panel).
- Used by the shared timeline context menu (`Chrome.tsx`, also Effect Controls, Program monitor, Effects panel,
  expressions, text animators) and its submenus, the Project panel's context menu, the Effect Controls keyframe
  interpolation menu and the transcript word menu.
- Radix menus (menubar, dropdowns, context menus, every submenu): `MENU_CONTENT` used the dropdown-only
  `--radix-dropdown-menu-content-available-height`, so context menus and the menubar fell back to 80vh; it now uses
  `--radix-popper-available-height`, which Radix sets for every kind.
- Tests: `packages/ui/test/menu-placement.test.tsx` (placement maths and `PointMenu` in a portal), `e2e/fixups.spec.ts`
  (Project menu with the Label list open, every timeline clip submenu, every menubar menu and submenu, in a
  1600×1000 and a 1600×560 window).

## 4. `ui_click` / `ui_locate` aimed at the centre of the whole clip (mcp-cli)

- Timeline locator: a clip target aims at the middle of its *visible* frames and its row's visible band
  (`apps/web/src/panels/timeline/model/locate.ts`); `reveal` scrolls the timeline (horizontal `scrollFrame`, vertical
  region scroll) when nothing of the clip / frame / row shows.
- Element targets (`{id}`, `ui_locate {id}`): the element's box clipped by its overflow-clipping ancestors and the
  window; a scrolled-away timeline clip (which may have no DOM element) is revealed through the timeline's own scroll,
  other elements with `scrollIntoView`. `ui_locate {id}` reports `visible` and `scrolled`.
- Found on the way: the built `jasper-mcp` bundle died at load (`Class2 is not a constructor`): roto's dynamic
  `import('@jasper/project')` next to the static imports made esbuild lazy-wrap the package and zod. Static imports
  now; `apps/mcp/test/bundle.test.ts` bundles `src/cli.ts` like `scripts/build.mjs` (shared `build-options.mjs`) and
  checks it answers `initialize` (fails before the fix).
- Tests: `apps/web/test/timeline-locate.test.ts`, `e2e/agent-ui.spec.ts` › "a clip running off the visible
  timeline…" (zoomed so the whole clip's centre is off screen; then scrolled away behind a second clip).

## 5. Third-party notices repeated the same copyright line

`scripts/third-party-notices.mjs` splits a record's copyright field into lines (`;`), normalises them, and renders the
ported-source table with numbered holders (`[3] [4]`) plus one "Copyright holders" list naming each line once with
the records it covers; each licence text's "Applies to" lists each line once. Per-record attribution stays (the
table and the record bodies). `THIRD_PARTY_NOTICES.md` regenerated; `pnpm notices --check` passes; test in
`scripts/third-party-notices.test.mjs`.

## 6. Audio-mix panels test at ≈ 5.3 s

A CPU profile showed most of the time in React rendering Radix `SelectItem`s: each mixer strip's "+ Effect" was a
Select, and Radix renders every option of a closed Select (the whole 60-entry audio effect list per strip, on every
render). It is an action, so it is now a `DropdownMenu` whose items are built when it opens. The test went from
4.6 s to 1.1–1.3 s for the slow case (two runs each, same shared machine, `--maxWorkers=2`); no timeout change was needed. A new test checks the
menu is empty while closed, lists every audio effect when open and inserts the chosen one.

Found in the merge gate: `packages/interchange/test/cfb.test.ts` › "handles DIFAT" timed out (145 s under load,
≈ 70 s alone). The CFB code takes ≈ 0.2 s for the 8 MiB stream; the time went into `toEqual` walking 8 Mi array
elements. The test now compares the bytes natively (same assertion, ≈ 2 s).

## 7–8. Decision log, parity and gaps

ARCHITECTURE D-40…D-45 (interchange in process, QuickJS expressions, audio DSP packages, CANVAS_NESTED, multicam on
nests, patched dependencies). `docs/parity.md` regraded row by row from the merged wp-notes and tests (breadth
≈ 90 % recomputed from the table; counts measured from the registries, `MENUBAR`, `COMMAND_CATALOG` and a live
`listTools`); `docs/gaps.md` readiness ≈ 35–45 % with its reasoning, a status per workstream; `previews`,
`golden-fuzz` and CANVAS_NESTED stay open.

## 9. Screenshots removed by `process`

None could be restored: every one of the 11 showed third-party photographs or footage (checked in git history at
`e5877562^`). All were regenerated from procedural pictures (`scripts/docs/gallery-scenes.mjs`: ffmpeg lavfi
gradients, mandelbrot, testsrc2, boxes) or the repository fixture:

| Removed | Now |
|---|---|
| `fx/{premiere-adjust-color-keying,sapphire-film-grain,sapphire-paint-kaleido-edges,sapphire-render-textures,sapphire-stylize-other}/contact-sheet.png`, `transitions/sapphire-dissolves/contact-sheet.jpg` | regenerated, same paths, by `packages/compositions/test/docs-gallery.e2e.test.ts` (`REMOTION_E2E=1 DOCS_GALLERY=1`) |
| `fx/sapphire-blur-sharpen/contact-sheet.png`, `fx/premiere-stylize-distort-generate/contact-sheet.png` | regenerated, same paths, by the family tests' `SBS_SHEET` / `PSDG_SHEET` with `SBS_SCENE` / `PSDG_PHOTO` = the procedural picture |
| `m3-mgtext/trailer-mg07-overflow-warnings.jpg`, `trailer-mg07-on-canvas-editor.jpg` | the existing fixture screenshots of the same features (`fixture-properties-text-warnings.jpg`, `fixture-on-canvas-editor.jpg`) |
| `m3-mgtext/trailer-mg07-applied.jpg` | new `fixture-applied.jpg` (`e2e/mg-texts.spec.ts`, `DOCS_SCREENSHOTS=1`) |

Each has a sidecar and an `ATTRIBUTION.md` row; `docs/wp-notes/wp-m3-mgtext.md` points at the fixture shots.

## Limits

- The path-bool patch must be re-checked when the dependency is upgraded (the patch file pins 1.0.4).
- Escape is left to the gesture only while a pointer button is held; keyboard-only gestures still go through
  `gesture.cancel`.
- The regenerated contact sheets render every effect at its defaults, or — when the defaults leave the picture
  unchanged (a blur of 0, a key colour absent from the picture) — with every numeric parameter 40 % of the way to its
  (soft) maximum and key colours on the picture's green card; effects that need a map or matte input show their
  no-input behaviour.
