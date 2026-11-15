# compositor — one flat compositor for stacks whose canvas scopes would nest

Workstream `compositor` of the parity program (BASE port 49500). It removes the CANVAS_NESTED limitation found by
color-mgmt and narrowed by previews (wp-notes `color-mgmt.md` §3/§7, `previews.md` §5). No ported code.

## 1. The problem

Chrome's HTML-in-Canvas never fires `paint` on a `layoutsubtree` canvas that lies inside another one. I measured it
again on Chrome 150 (headless, `--enable-features=CanvasDrawElement`): the inner canvas gets no paint event, not even
after `requestPaint()`, and `drawElementImage` / `captureElementImage` accept **only immediate children** of the canvas
("Only immediate children of the <canvas> element can be passed to DrawElementImage"). The outer capture shows the
inner canvas's DOM children unprocessed.

Every canvas scope of the composition captures *everything below it*: the GL blend scope (`BlendScope`), linear-light
runs, canvas-mode adjustment layers (`AdjustmentScope`), 3D runs (`Scene3DScope`) and the Program monitor's display
transform (`DisplayStage`). DOM layers with GPU effects, masks or colour effects draw through their own HTML-in-Canvas
(`FxDomPicture`). So two scopes in one stack, or such a layer below a scope, nested canvases: renders failed with
CANVAS_NESTED and the Player showed the content without the inner chain; the HDR display transform stepped aside.

## 2. Design

**Hybrid: the nested structure where it works, one flat compositor where scopes would nest.** Decided per stack
(`VideoTracks`, i.e. per sequence and per nested sequence), statically from the stack:

- *No nesting* (at most one scope, nothing drawing through HTML-in-Canvas below it): the old structure, untouched.
  Every stack that rendered before keeps its exact code path and pixels.
- *Nesting* (`flatStackReason`, `fx/flat-plan.ts`): the stack is drawn **flat**. No scope captures anything. Every
  drawn layer hands its finished picture to one compositor:
  - media layers (video, stills, solids, generators, compositions) through `FxPicture` and the existing compositor
    tap (a canvas: video frames are decoded into it, no HTML-in-Canvas);
  - DOM layers without a canvas chain of their own (text, shapes, captions, Lottie, vector… with no GPU effect, mask
    or colour effect) through `FlatDomCapture`: a frame-sized HTML-in-Canvas around the *transformed* layer, so the
    pixels are exactly the ones Chrome rasterises in the nested structure (rotated text keeps its edges); drawn opaque
    and Normal, the compositor applies opacity and blend mode;
  - DOM layers with a chain (GPU effects, masks, colour) through their own `FxDomPicture` and the tap, as before;
  - GPU transition stages through their tap; 3D run members to the 3D hub, as before;
  - transition mattes and the background are colour fills; adjustment tracks and 3D runs publish the canvas effects
    their scope would run (`FlatAdjustment`, `FlatRun3D` → `FlatRegistry`).

  These elements are siblings: none lies inside another canvas, so nothing can nest.
- *A pixel density other than 1* (`flatStackReason(…, density)`, `usePagePixelDensity`): a stack with any canvas scope
  is drawn flat too. The density is the page's device pixels per CSS pixel — the Remotion `scale` of a render
  (`render_frame` / Export Frame at another width than the sequence's, Remotion exports at another output size; Remotion
  forces it with `--force-device-scale-factor`) and `devicePixelRatio` in the Player (HiDPI screens, browser zoom;
  re-read when it changes). Measured on Chrome 156: under a forced device scale factor `s`, HTML-in-Canvas draws each
  `<canvas>` it captures (the frame canvas of `<Video>`, `FxPicture` canvases) at one backing pixel per device pixel
  from the canvas's corner, clipped to its CSS box, instead of stretching the backing over the box — a canvas whose
  backing equals its CSS size comes out zoomed by 1/s into its top-left corner. A Transform (or any effect) on an
  adjustment layer then worked on that zoomed capture: identity rendered `render_frame` at width 320 of a 640 sequence
  as a 2× zoom into the top-left. CDP's emulated device scale factor (Playwright `deviceScaleFactor` alone) does not
  show it; a forced one does, as a real HiDPI screen does. At density 1 nothing changes.

**The compositor** (`FlatCompositor`, `fx/flat.tsx`) builds the frame on canvases, bottom to top, in the order the
nested structure applies (`flatOpsAt`): the background; per track its adjustment layer, its transition mattes, the 3D
run whose bottom it is, then its layers (clips, then GPU transition stages). It runs **the scopes' own effects**:

| Step | Effect | As in |
|---|---|---|
| layers, fills | `fxBlendComposite` (`planComposite`): every blend mode, Dissolve, stencils, linear light (`cm_toLinear`), the stack stored premultiplied RGBA8 between layers (`storePremul8`) | the GL blend scope = the native kernel |
| adjustment layer | its chain `stash → effects → mix` (opacity, blend, crop region, Opacity masks) on the accumulated picture placed in the chain's **padded layout** exactly where the scope's capture puts it (`layout.box`), then cropped back to the frame | `AdjustmentScope` (shared hook `useAdjustmentChain`) |
| 3D run | `fx3dRun` with the accumulated picture as backdrop (Classic and Advanced 3D, models, environment light) | `Scene3DScope` (shared hook `useScene3DRun`) |
| display transform | the display LUT (`colorLut`), last, Program monitor only | `DisplayStage` |
| Stencil / Silhouette | the background drawn once more under the finished stack | the stencil background element |

CSS-mode adjustment layers (filters only) are canvas steps in a flat stack (`css` steps of the chain, `ctx.filter`).

**Nested sequences.** A nest layer whose picture is captured (effects, masks, a compositor or transition tap) cannot
capture a nested sequence that draws through HTML-in-Canvas itself (`docUsesCanvas`). Such a nest takes its nested
sequence's picture as a **canvas source**: the nested tracks are drawn flat (`VideoTracks flat="feed"`), and the
nested compositor feeds the layer's `FxPicture` like a video frame (renders invalidate the slot on every frame change,
so a frame is never drawn from another frame's picture). Recursion follows the nesting; the snapshot builder refuses
cycles and `docUsesCanvas` stops at depth 16.

**The display transform.** In the Program monitor of a non-Rec. 709 working space, `DisplayStage` no longer steps
aside when something inside draws through HTML-in-Canvas: the sequence's stack is drawn flat and its compositor
applies the display LUT last (`FlatDisplayContext`); preview files get the same LUT as a `<Video>` effect.

**Safety net.** The static decision covers every stack the composition builds (property test, §4). Should a canvas
still find itself inside another one, `ScopedHtmlInCanvas` asks the *owner* of the enclosing canvas to draw without
it (`CanvasOwnerContext`: the `VideoTracks` switches to flat, a nest layer to its canvas source), holding the render
until the owner redrew. CANVAS_NESTED remains only where no owner can flatten — a canvas that is not one of ours —,
which no composition of a render snapshot produces. It also needs WebGL2 and HTML-in-Canvas: without them the scopes
were never canvases (Player fallback with chips, renders refuse as before), so nothing nests.

**Long renders.** A hub (`CompositeHub`, `Scene3DHub`) keeps one canvas per layer key, and a flat stack captures
every drawn layer. Since every captured layer delivers on every frame it is drawn (its tap is per frame), a hub keeps
only the pictures of its 8 latest distinct frames (`RecentFrames`; a frame seen again moves to the end, so scrubbing
back never drops the frame on screen). Before, each render page kept a canvas for every clip it had ever drawn: a
1080p60 export of 8347 frames with adjustment layers on two tracks (≈ 2600 clips in an earlier copy of the project,
Remotion path, NVIDIA GPU) failed after 46 minutes at 59.5 %. In the minute it failed the kernel OOM-killed a Chrome process
with `oom_score_adj` 200 and shmem-rss ≈ 59 GB (`journalctl -k` on that machine; 200 is Chrome's GPU process, so
inferred to be the render browser's), and the GPU context loss surfaced as CANVAS_NESTED (below). Measured with a
temporary browser-console probe on a 300-clip flat stack (Remotion export on the shared CPU host): up to 42 pictures
per page, growing with the clips, before; at most 8 after. `JASPER_REMOTION_BROWSER_LOG=1` now also covers
`renderMedia` (exports), as its comment always said.

**GPU context lost mid-render.** `VideoTracks` drew flat only while the GPU status was `ok`, so a lost context
remounted a flat stack nested and its scopes refused at once with CANVAS_NESTED (reproduced by losing the fx host's
context at frame 150 of the probe's render). A render now keeps drawing flat once it could, and `RenderGpuGuard` (the
composition's first child, so it runs before the layers) fails it with `WEBGL_CONTEXT_LOST … at sequence frame N`,
which the engine reports as a retryable job error with `detail.frame`. CANVAS_NESTED from an adjustment layer names
its clips and the sequence frame.

### Options evaluated (prototypes in real Chrome)

1. **Nested HTML-in-Canvas with repaint tricks** — prototype `/tmp/compositor-proto/e1.mjs`: the inner canvas never
   paints (0 paint events after `requestPaint` on both); dead end.
2. **One root HTML-in-Canvas capturing every layer** (the single-capture idea of the brief): Chrome only captures
   immediate children of the canvas, so every layer would have to be portalled into a direct child of one root canvas,
   and DOM layers with effects would need their chains moved out of their own components. Possible, but it rewrites
   every layer component for no pixel or speed gain over (3) — each layer is still one capture per frame.
3. **Per-layer captures side by side + one GL compositor** (chosen): the blend group's mechanism (previews), extended
   to adjustment chains, 3D runs, fills, the display transform and nested sequences, with composition-space captures
   for plain DOM layers. It reuses the scopes' effects verbatim, so the maths cannot drift.
4. **Flat everything, always** — rejected: it would move every stack with one blend mode or one adjustment layer onto a
   new code path (parity risk, and video decoding into canvases for every such stack in the Player).

## 3. Exports and the planner

ARCHITECTURE D-43 (HTML-in-Canvas scopes cannot nest) stays true of the browser; its "open limitation" is what this
workstream removes (the decision table is not edited here, per the brief).

Nothing changes in the planner: it already routed these stacks honestly; only the Remotion path used to fail at render
time. Adjustment layers with GPU effects, 3D runs and linear light go to Remotion (named blockers, as before) and now
render; blend modes plus adjustment layers with native effects stay native; DOM layers in such stacks are baked
(hybrid). Layer bakes render one layer alone (`layerFilter`): never flat. Stills and preview files use the same paths.
`apps/engine/test/compositor-export.e2e.test.ts` exports each kind of stack through the path the planner picks and
through Remotion, against the formulas.

## 4. Verified behaviour

- **`compositor.e2e.test.ts`** (REMOTION_E2E=1, Remotion renders in Chrome 150) — every combination of the brief against
  references computed without a browser (the CPU reference of `three-d-reference.ts`, extended with pointwise
  adjustment layers; `blendPixel`; Invert = 1 − c; BT.1886 for linear light):
  adjustment (GPU) over a GL blend and vice versa; two GL blends separated by an adjustment layer (and a Normal layer);
  crop + opacity of an adjustment layer over a GL blend; a DOM layer with GPU effects under a GL blend and under an
  adjustment layer; a GPU transition between DOM layers under an adjustment layer; linear light with an adjustment
  layer (GPU) and with a DOM layer with GPU effects between the blended tracks; 3D runs over / under GL blends and
  adjustment layers, and between two GL blends; a nest with effects whose nested sequence nests scopes (canvas
  source) under a GL blend; a nest holding a GL blend under an adjustment layer. Whole frames within 6 code values on
  > 99.5 % of the pixels (3D) or sampled pixels within 4.
  **Parity**: the same frame through the old scope and through the flat compositor (the stack made flat by scopes at
  other frames): a padded GPU blur adjustment over video (**worst 0** code values), a GL blend over video and rotated
  text, a 3D run over video, linear light with text — within 3 code values.
- **`compositor-player.e2e.test.ts`** (REMOTION_E2E=1, Players in headless Chrome with HTML-in-Canvas): video under an
  adjustment layer and a GL blend (decoded frames reach the compositor; two seeks), a nest drawn as a canvas source, an
  adjustment layer over a 3D run, and a Rec. 2100 PQ sequence with a GL blend scope whose graphics white is shown
  through the display transform (> 220; it was the raw 148 with a chip before) without the chip.
  `COMPOSITOR_ELECTRON=1 xvfb-run -a …` runs the same four Players in the desktop app's **Electron 44** (Chrome 152,
  `CanvasDrawElement` as `apps/desktop` sets it; SwiftShader for WebGL2 because xvfb has no GPU): 4 / 4 pass.
- **`apps/engine/test/compositor-export.e2e.test.ts`** (REMOTION_E2E=1, real engine): see §3.
- **`adjustment-transform.e2e.test.ts`** (REMOTION_E2E=1, Remotion stills in Chrome 156): an identity Transform on an
  adjustment layer over video equals the frame without it at `scale` 0.5 and 1.5, and Transform 180 % about
  (0.5, 0.38) on the adjustment layer equals it on the video clip at `scale` 0.5 (`Tolerance.BROWSER`). All three
  failed before the density rule (PSNR ≈ 4–5 dB). Checked once by hand, not kept as tests: the add_punch_ins
  `adjustment` form (keyframed 100 → 180 %, 360° shutter) against the same keyframed Transform on the clip at
  `scale` 0.5 — frames 5 and 15 identical, frame 0 PSNR 56 dB (max 9); Players at a forced device scale factor of 2
  and 1.25: identity and 180 % screenshots byte-identical to their references (at 2 the adjusted picture was shrunk
  into the top-left quarter before).
- `color-mgmt.test.tsx`: the nested guard asks the owner to flatten instead of failing.
- Historical validation: the former mocked compositor property test failed immediately with the flat path
  disabled. It was removed in favour of the rendered-pixel owners above.
- Historical regressions run when these changes landed (all passed; some suites have since been removed):
  `scope-nesting`, `edit-structure-render`, `three-d-render`,
  `masks-render`, `text-animators`, `transition-render`, `fx-render`, `fx-player`, `transition-player` (REMOTION_E2E,
  compositions); `blend-remotion.e2e` (31 / 31 modes) and `color-mgmt-remotion` (engine); `blend-gl`, `three-d-gl`,
  `masks-gl`, `capture-safe-canvas` (GL). The Player suites failed before on `integrate/parity` for an unrelated reason
  (their test pages served the bundle without a charset, and a non-ASCII XML-name regex of `@jasper/project` broke
  the whole bundle): `fx-media.ts` now serves test pages as UTF-8.

- **Golden frames** (golden-fuzz's harness, `golden-scenes.e2e.test.ts`): the 56 existing scenes pass unchanged on this
  branch (the pixel-parity safety net). Six combined scenes are added (`combo-*` in `test/golden/scenes.ts`), each
  checked against a computed reference *before* its golden is compared or blessed (`Scene.reference`):

  | Scene | Reference | Measured against it |
  |---|---|---|
  | `combo-gl-blends-stacked` (Linear Burn 60 % + Color Dodge 50 %) | `blendPixel` per pixel, RGBA8 between layers | PSNR 68.2 dB, max 1 |
  | `combo-adjust-over-gl-blend` (Invert over Linear Burn 70 %) | Invert of `blendPixel` | PSNR 69.1 dB, max 1 |
  | `combo-blend-adjust-blend` (Vivid Light, Invert, Subtract) | `blendPixel`, Invert, `blendPixel` | PSNR 76.7 dB, max 1 |
  | `combo-linear-adjust-between` (1.0 gamma: Normal 50 %, Invert, Screen 40 %) | BT.1886 decode / blend / encode | PSNR 95.1 dB, max 1 |
  | `combo-3d-blend-adjust` (Linear Burn, a 3D run, Invert; solids) | Classic 3D CPU reference + pointwise Invert | 1.3 % of the pixels off by > 6 (edges: the reference does not antialias) |
  | `combo-hdr-display-scope` (PQ, Program monitor, a GPU blend scope) | the export render (working signal, nested structure) through the display LUT on the CPU | PSNR 72.1 dB, max 3 |

**Found on the way** (`packages/project/src/derive/index.ts`): the per-track clip index was memoised by the
`clips` record identity, which an Immer draft keeps for the whole transaction, so a command that read the index made
later commands of the same transaction see stale clips (`transition.add` after `clip.addSolid` on another track was
refused: "not an edit point"; overwrites could miss a clip added earlier in the same transaction). Drafts are no
longer cached; `packages/project/test/derive-draft-index.test.ts`. The session §13 benchmarks (command on 1 000 clips,
50-clip gesture) measured the same before and after (≈ 31–44 ms and 140–210 ms both ways on this loaded host). The same
fix landed concurrently on `integrate/parity` (with `derive-draft.test.ts`); the merge kept that version and both tests.

## 5. Limits

- A plain DOM layer is captured in composition space (exact). A DOM layer with its own chain (GPU effects, masks,
  colour) is captured in layer space and placed by the compositor with bilinear sampling, as the blend group and GPU
  transitions always did; in the nested structure Chrome resamples the same picture with its own filter. Differences
  are at transformed edges only (a few code values).
- A flat stack composites in RGBA8 (as the blend scope and the native kernel); the nested structure's Normal layers are
  composited by Chrome. Normal layers with opacity can differ by one code value between the two paths.
- The Player draws a flat stack once per animation frame from the latest pictures (like every scope); renders hold
  each frame until every picture of that frame arrived.
- The density rule (§2) removes captures of media canvases by scopes. Captures that remain at a density other than 1
  — a DOM layer's own `FxDomPicture`, `FlatDomCapture`, the Program monitor's `DisplayStage` — draw a `<canvas>` inside
  the captured DOM the same way (assumption from the measurement in §2, not exercised: e.g. a shape layer drawn on a
  canvas with a GPU effect, rendered at another width than the sequence's).
- Long renders: the track-matte hubs and the transition hubs still keep their latest pictures per matte clip / per
  GPU transition for the life of a page (not measured; the composite and 3D hubs were the ones holding a canvas per
  drawn clip). A GPU context lost mid-render fails the render (`WEBGL_CONTEXT_LOST`, retryable) instead of waiting for
  the browser to restore it. The fixed export itself was not re-run on the GPU machine.
- Performance: only stacks that could not render before are flat; their cost is a capture per DOM layer and one GPU
  pass per layer per frame (the blend group's cost model). `pnpm perf` is unchanged (§6).

## 6. Performance

Measured with `node scripts/performance.mjs --sections editor` (the `pnpm perf` editor section: whole-editor playback
in the built app, headless Chrome 150 with HTML-in-Canvas, SwiftShader, 6 s per scenario) on the same 12-core shared
host, alternating the baseline (`integrate/parity` 7ac85235 built in a separate worktree) and this branch, with this
branch's script on both (so both run the two new scenarios). fps = frames shown per second; the host load factor of
`scripts/perf/budget.ts` is given per run.

| Scenario | base run 1 (×1.29) | base run 2 (×1.82) | compositor run 1 (×1.73) | compositor run 2 (×1.74) |
|---|---|---|---|---|
| single 1080p H.264 | 12.5 | 9.3 | 11.2 | 8.2 |
| stack of 3 (scaled, translucent) | 3.1 | 3.0 | 2.8 | 2.5 |
| GL blend scope over video (nested structure) | 2.0 | 1.1 | 1.0 | 1.2 |
| adjustment (Invert) over GL blend over video | 1.5 *(wrong picture: chip, no Invert)* | 1.0 *(idem)* | 1.0 | 1.4 |
| GPU effects, live | 3.8 | 3.7 | 3.9 | 3.7 |
| GPU effects, from previews | 15.5 | 9.5 | 16.6 | 10.6 |

The differences are within the run-to-run spread of this loaded host (the same build varies by 30–40 % between runs):
no measurable regression of the stacks that keep the nested structure (their code path is unchanged apart from a
context read per layer and a memoised decision per stack). The flat compositor plays the nested-scope stack at the
speed the one-scope stack plays (≈ 1–1.5 fps of 1080p on this CPU-only SwiftShader host), and now draws it right.
Raw reports: `test-results/performance/compositor*.{json,md}` (not committed). `pnpm perf` gained the two scenarios;
its previewed-playback budget now finds its scenario by name.
