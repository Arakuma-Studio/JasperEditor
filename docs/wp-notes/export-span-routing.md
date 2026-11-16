# Export span routing and layer routes

Branch `perf/export-span-routing` (from `main` dcdf40c74). An `auto` export used to render everything on the Remotion
path as soon as one clip had a native blocker. The main project (56,199 frames, 183 transition-kit adjustment
clips on V5 over ≈ 9 % of the frames; Replicate, Mirror, Offset, Directional Blur and stacked Transforms have no
native path on adjustment layers) then rendered at 2.2–3.3 f/s for 5–6 h.

## What an `auto` export does now

1. **Spans** (`export/routing.ts`). The planner looks at the export's native blockers. If every blocker names a clip
   or transition, it takes the frames those items are drawn on, including transition handles. A nested clip or
   transition counts for its top-level nest clip. Those frames are the Remotion spans (`blockerSpans`), and the rest
   stays native or hybrid. A blocker without an item (encoder, memory, linear-light blending, alpha output,
   colour-managed output) keeps the whole export on Remotion, as before.
2. **Merging by cost** (`spanRuns`, "Cost model" below). A gap between spans is drawn by Remotion when that costs less
   than one more native piece plus one more Remotion piece. A native stretch at an edge is absorbed when it is shorter
   than one native piece's cost. Past `maxRuns` (400) pieces, the smallest gaps are merged. The split is used only when
   its estimate beats Remotion for the whole range. This replaces the bake fallback's limit of 8 stretches (that
   fallback uses the same function).
3. **Layer routes** (`export/layer-routes.ts`, stage 1). If every Remotion item of a span is a top-level adjustment
   clip, the span is split at those adjustment tracks instead of rendering its whole stack on Remotion:
   - native composite of the tracks below the first adjustment track → plate (lossless 8-bit RGB PNG frames at the
     sequence size);
   - Remotion draws only that adjustment track over the plate (effects, crop, opacity, fades, blend, exactly as the
     composition draws an adjustment layer over the composite below it, "background included") → PNG frames → a
     lossless FFV1 file (the new base);
   - the native composite of the tracks up to the next adjustment track over the base → the next plate; and so on;
   - the last native pass composites the tracks above the last adjustment track over the base into the export's piece.

   Each pass is an export of the span from a pass document. In that document the other video tracks have output off
   (Track Matte Key sources stay as matte-only tracks). From the second pass on, a placeholder solid on a new bottom
   track shows the base: natively through the `layer-routes` extension's `sequence` override, and in Remotion as a
   baked frame sequence served by the layer cache route. Captions are burned in once, by the last pass.
4. **Join** (`service.ts` `renderRoutes`). With an encoder whose pieces join by stream copy (`joinsByCopy`), the
   sequence's rate and aspect ratio, and no pixel aspect, every piece is encoded with the export's settings and the
   pieces are joined by stream copy with the export's sound, as native segments are. Otherwise, or when the pieces'
   parameter sets differ, the pieces are rendered again to ProRes intermediates and joined by one encode (Use
   Previews' path).

Plan: `path: 'hybrid'`, `paths: {native, remotion, spans}`, one `segments` entry per piece (mode `remotion` for
the spans). Warning `REMOTION_SPANS` lists every span, the distinct reasons with their counts (the first ten), and
which spans are split at their adjustment layers and which keep their whole stack, with the reason. `blockers`
still holds every reason. If a layer route cannot run (no plate store, a pass failed), that span renders its whole
stack on Remotion and the result warns `LAYER_ROUTE_FALLBACK` with the cause.

MCP `start_export`: `plan.why` lists the first five distinct reasons and then `and N more (details.blockers)`.
`plan.details.blockers` lists every reason with its item ids, and `plan.paths` is passed through. The
`PATH_NOT_ELIGIBLE` hint says how many more reasons the error's `details.blockers` holds.

## Fidelity (AGENTS §4)

- A whole-stack span is a Remotion render of those frames, the same as a Remotion export of the range.
- In a layer-routed span, the pixels outside the adjustment's effect come from the native renderer, the same one
  that draws the frames before and after the span. Only the adjustment layer passes through the browser, over a
  full-frame plate, so edge sampling matches the composition's adjustment scope: the scope samples the composite at
  the frame size, "background included", and sees transparency beyond the frame edge.
- Intermediates. The native composite and the browser both work at 8 bits per channel for plain Rec.709 outputs, so
  8-bit RGB PNG plates and FFV1 bases are lossless at the working depth. Both sides read RGB as encoded BT.709
  values without conversion. Remotion's PNG keeps straight alpha, and FFV1 `bgra` keeps it into the native override,
  which overlays straight alpha. Timing is frame-exact: frame 0 is the span's first frame on every side. The native
  composite is 8-bit for every output (its overlays are `rgba`/`gbrp`), so the plates lose nothing for 10-bit
  ProRes either. Routing is used only for outputs written in BT.709 as worked (any bit depth); outputs that convert
  colour (another space, HDR) stay on one path.

## Not done in this branch

- **Stage 2: clip-type layers.** A clip whose own pixels need Remotion (not an adjustment layer) still renders its
  span's whole stack on Remotion, with the reason named. Text, shapes, anime templates and MG compositions were
  already isolated layers with alpha, composited natively (the layer bake).
- **Stage 3: nested sequences.** A nested Remotion item renders its span's whole stack on Remotion.
- 3D layers in a span keep the whole stack on Remotion.
- Spans of stacked adjustment tracks round-trip once per track. Pieces render one after the other, so a short
  native piece runs as one graph.

## Cost model

`ROUTE_COST` (≈) only sets where spans merge and whether a split pays.
- Rates: Remotion 2.5 f/s, native 8 f/s. Source: the video team's figures for the 1080p60 project on the user's PC.
  The PC's own job logs (see "Estimate") show faster native rates for 720p drafts.
- Fixed cost per piece: native ≈ 4 s, Remotion ≈ 8 s, estimated from the phase times of exports in the PC's logs
  (plan 0.8–5.4 s; layer-bake cache checks 1–3 s; ffmpeg start). The per-piece cost measured in this branch's tests
  is under "Measurements".
  The cost model does not yet price a layer route's extra passes (two native passes and one Remotion pass per span).

## Measurements (this host; not the user's PC)

Conditions: shared 12-core VM with no GPU, load average 40–90 from other agents, Chrome 156 with SwiftShader GL,
libopenh264 / prores_ks. Wall times from `export-layer-routes.e2e.test.ts`. Rerun with
`REMOTION_E2E=1 pnpm --filter @jasper/engine exec vitest run test/export-layer-routes.e2e.test.ts`.

| 90 frames 1280×720, one 30-frame Offset span | wall time |
|---|---|
| `auto`, routed (2 native pieces + 1 layer-routed piece = 3 passes) | 117–137 s (3 runs) |
| `remotion`, whole range | 52–87 s (3 runs) |
| `native`, same sequence without the adjustment layer | 15–23 s (3 runs) |

On a sequence this short, each piece's fixed cost dominates and routing is slower than Remotion for the whole range.
The cost model's per-piece constants are too low for this host.

Parity, from the same runs (decoded ProRes 4444 frames, RGB):
- Outside the span, routed frames equal the native export exactly (tolerance 0).
- Inside the span, outside the adjustment's crop, routed frames equal the native export (≥ 99.9 % of values within 2).
- At the span edges, frame 29 against frame 30 and frame 59 against frame 60 (left half): 99.99 % of values within 3,
  mean difference 0.007, maximum 10.
- For comparison, a native and a Remotion export of the same chart.png frame differ much more: 62 % of values within
  3, mean 4.45, maximum 48. Outside the effect, a whole-stack Remotion span would show that jump at its edges.

## Estimate for the main project (≈, not measured)

56,199 frames; ≈ 9 % (≈ 5,060 frames) in ≈ 150–183 spans under the kits; 1080p60 sequence.

Rates from the PC's job logs (`.stage/engine/logs/jobs`, read-only, 2026-11-15/16):
- Remotion exports: 7,200 frames in 2,116 s (3.4 f/s) and 8,346 frames in 2,280 s (3.7 f/s).
- Hybrid range exports with cached bakes, 720p output from a 1920×1080 composite, NVENC p2, 4 segments: 20,270 frames in 336 s (60 f/s) and 9,957
  frames in 240 s (41 f/s). With bakes to render: 9,957 frames in 392 s (25 f/s).
- The video team quotes ≈ 8 f/s hybrid and 2.2–3.3 f/s Remotion for this project.

Assumption: one piece costs ≈ 5 s native and ≈ 8 s Remotion, and a layer-routed span ≈ 20 s (three passes). Native
pieces average ≈ 280 frames, so each one renders as one graph, not four segments: ≈ 15–25 f/s.

| | native frames | Remotion frames | fixed | total |
|---|---|---|---|---|
| today (whole range on Remotion) | – | 56,199 at 2.2–3.3 f/s | – | 5–6 h (team) |
| whole-stack spans | 51,140 at 15–25 f/s: 34–57 min | 5,060 at 2.5 f/s: 34 min | 183 × 8 s + 184 × 5 s ≈ 40 min | ≈ 1.8–2.2 h |
| layer routes | the above + 2 × 5,060 plate / above passes: 41–68 min | 5,060 plate + effect at ≈ 5–8 f/s: 11–17 min | 183 × 20 s ≈ 61 min | ≈ 1.9–2.4 h |

With the team's 8 f/s for native frames, both rows grow by ≈ 1 h. Most of what remains is per-piece set-up. The next
step is to render pieces side by side, or to plan and prepare once for every piece.
