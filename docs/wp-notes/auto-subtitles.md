# auto-subtitles — automatic subtitles, templates, multi-clip styling and cut-aware timing (spec 13)

Owner work note of [spec 13](../specs/13-auto-subtitles.md). Each section records one part's behaviour, the
researched or assumed rules behind it, how it was verified and what is left. Services shared with specs 14 and 15
(spec 13 §2) are documented here.

## 1. Cut map (spec 13 SH-001)

`pictureCuts(doc, sequenceId, opts?)` (`packages/project/src/structure/cuts.ts`, exported from `@jasper/project`)
lists every frame where the picture the viewer sees changes. It is pure, never stores anything and never throws on
damaged data; `analyzePictureCuts` returns the same cuts with warnings, the tracks considered and the analysed range.
Consumers: cut-aware subtitles (AS-010…AS-013), transcript cleanup (spec 14), Decorate Cuts and other automation
(spec 15 EA-020), and agents through MCP `list_cuts`.

### 1.1 API

```ts
type PictureCut = {
  frame: number;                       // first frame of the new picture
  kind: 'cut' | 'jump' | 'overlay';
  trackId: string;                     // track of the incoming picture, else of the outgoing one
  outgoingClipId?: string;             // clips of the queried sequence (a nest clip when the picture is inside it)
  incomingClipId?: string;
  transitionId?: string;               // two-sided transition of the queried sequence at this edit point
  zone?: { start: number; end: number }; // its span [start, end) in sequence frames (the cut zone)
  nested?: { outgoing?: NestedClipRef; incoming?: NestedClipRef;
             transition?: { sequenceId; transitionId; nestPath } };
};
type NestedClipRef = { sequenceId: string; clipId: string; nestPath: string[] }; // nest clip ids, outermost first
```

Options (`CutMapOptionsSchema`, strict zod): `outputTrackId` (only video tracks below it count; a caption track =
every video track; an audio track is refused), `trackIds` (only these video tracks), `overlayCoverage` (0.01…1,
default 0.5), `includeJumpCuts` / `includeOverlays` (default true), `range` `{start, end}` (frames `[start, end)`).
A missing sequence or track and invalid options throw `CutMapError` with `E_NOT_FOUND` / `E_INVALID_PARAM`.
Warnings: `nest-missing`, `nest-cycle`, `nest-depth`, `sampled`, `nest-work-limit`, `unreadable-clip`.

Output guarantees (property-tested): frames are integers in `(0, sequence duration)` and in `range`, strictly
increasing (at most one entry per frame), and name existing clips and tracks of the queried sequence.

### 1.2 Rules

For every frame, the picture stack is built top track first, below `outputTrackId`, over shown tracks (`output` not
false) and enabled clips only:

1. **Picture layers** are clips that draw a picture of a source: `video`, `still`, `animated-image`, `solid` (not
   Transparent Video) and `nest-video`. Text, shape and caption clips and adjustment layers (spec SH-001), and also
   motion graphics, compositions, 3D models, cameras and lights are never layers (**assumption**: titles and
   templates generated from inline data are graphics over the picture, like text; counting a full-canvas lower third
   as a cut would split subtitles at every title).
2. **Coverage** = area of the layer's visible quad — its intrinsic box through the stack's Crop windows (flips after a
   crop mirror it), the corner pin and Motion (position, anchor, scale, scale width, rotation, flips), evaluated at the
   frame — intersected with the frame and every enclosing nest window, divided by the frame area (convex polygon
   clipping). Layers under `overlayCoverage` and layers at opacity 0 are ignored.
3. A layer is **opaque-full** when it covers ≥ 99.9 % of the frame (`FULL_FRAME_COVERAGE`, ≈ 2,000 px² short at
   1080p), its opacity times its nests' is ≥ 99.5 % and nothing makes it see-through: a blend mode other than
   Normal, masks, a 3D layer, media with alpha (not interpreted as "ignore"), a translucent colour matte, or a
   Keying / Distort / Perspective / Transform / Edge Feather effect. Layers below an opaque-full layer are hidden.
4. The **base picture** is the topmost opaque-full layer, else the topmost layer covering the frame, else the layer
   with the largest coverage (a scaled-down main picture alone stays the base). The other kept layers are overlays.
5. At frame `f` (compared with `f − 1`):
   - the base changes to another source or to / from nothing → `cut`; to the same source with discontinuous
     content → `jump`;
   - the base changes but the old base stays visible as an overlay, or the new one was visible as an overlay →
     `overlay` (a picture over a continuing one grows to full frame or leaves);
   - otherwise an overlay enters or leaves → `overlay` (with the topmost entering / leaving clip);
   - one entry per frame: a base change wins over an overlay change.
6. **Continuity** (no cut): the same layer, or the same source (media + stream, still, synthetic, nested source)
   showing content within half a source step of where the previous picture would continue. This is
   `isThroughEdit`'s criterion generalised across tracks, nests and speeds: through edits, a frame hold resumed where
   it froze and a speed change with continuous content are not cuts (`isThroughEdit` itself requires equal speeds).
   A punch-in (scale change) at a through edit is therefore not reported either (**assumption**, follows the spec's
   "excludes through edits").
7. **Transitions**: a two-sided transition between the outgoing and incoming clips (at the level where the two
   pictures part, so also inside a nest) adds `transitionId` (or `nested.transition`) and `zone` = its span
   (`transitionSpan`, Custom Start `cutPosition` included); inside a nest the zone is the parent frames whose nested
   frame lies in the span. One-sided transitions never make a zone. A picture fading out to nothing or in from
   nothing (a one-sided transition on the edge it crosses — at any nesting level, reversed clips use the opposite
   side — or an opacity ≤ 5 %, e.g. keyframed fades) is not a cut; a fade over another picture still cuts at the edge.
8. **Nests** are followed exactly as the renderer draws them (`NestLayer`, `buildRenderSnapshot`): the multi-camera
   angle (`multicamView`), the nested sequence conformed to the parent rate (`conformSequenceRate`), the nested frame
   `floor(max(0, pictureTime) / F + 1e-6)` through speed, reverse, frame hold and time remap (`clipMediaTimeFn`);
   nested layers are composed with the nest clip's layer map, opacity and see-through flags and clipped to its
   visible quad. Depth ≤ 8 (`MAX_CUT_MAP_NEST_DEPTH`; deeper nest clips count as one picture, warning `nest-depth`);
   a nest showing a sequence already on the path draws nothing (warning `nest-cycle`, like the renderer's error).
9. Rational rates: everything is in integer sequence frames; content times are flicks, so 23.976 / 29.97 / 59.94
   behave exactly like integer rates (tested at 23.976, 25, 29.97, 59.94 and 60 fps and a 25 fps nest in 59.94).

Other consequences: a cut to black is reported where the last picture ends while audio or captions continue; the
sequence's first frame and its end are never cuts; a keyframed opacity dissolve gives two `overlay` entries (when it
starts and when it becomes opaque) rather than a zone.

### 1.3 Algorithm and performance

The stack can only change at clip edges of picture layers, at nested change frames mapped to the parent (per frame of
the nest clip: a change when the nested frames shown at `x − 1` and `x` enclose a nested change) and while an
animated layer's geometry or opacity varies. On this sequence's own tracks an animated layer is scanned frame by
frame for status changes only (off / under the threshold / opaque-full / partial), so a punch-in zoom that stays
full-frame costs no stack evaluation; partial or see-through animated layers and animated layers inside nests are
evaluated on every frame. The stack is evaluated once per change frame (static layers' geometry and root coverage are
cached per clip); events compare consecutive stacks. Budgets keep hostile documents bounded: 250,000 animated frames
per call (then sampled, warning `sampled`) and 4,000,000 mapped nest frames (then the nest's inner cuts are skipped,
warning `nest-work-limit`).

Measured with `pnpm exec tsx packages/project/bench/cut-map.ts` (results in
`packages/project/bench/cut-map.results.json`; bench lock held, fixture construction not timed, 7 samples of ≥ 200 ms,
median):

| Case | Clips | Cuts (cut / jump / overlay) | Median | Samples |
|---|---|---|---|---|
| One 59.94 fps sequence, ≈ 54 min (195,000 frames): V1 2,600 A-roll pieces (every 13th a keyframed punch-in), V2 700 full-frame B-roll (300 cross dissolves), V3 300 picture-in-picture at 75 %, V4 1,000 titles, V5 400 shapes | 5,000 | 3,599 (1,549 / 1,500 / 550) | **31.2 ms** | 29.6–33.5 ms |
| Shared scale project (`bench/scale-project.ts`), all 200 sequences one after another | 5,000 | 2,000 | 14.8 ms | 13.6–15.6 ms |

Machine: build VM, AMD EPYC-Rome, 16 vCPU (shared with other agents' jobs; load average 4.2 → 4.5 during the
run), 32 GB, Node 24.22.1, run through `tsx` (2026-10-25). The spec's target is < 50 ms for 5,000 clips: met. The
same output hash (`7d8c3c2f…`) before and after the two optimisations (status-change scan of animated layers,
allocation-free polygon clipping), which took the first case from 93.4 ms (median, same machine, load ≈ 2.8) to the
figure above.

### 1.4 Sound design's `deriveEditCues`

Not refactored onto the cut map: its semantics differ on purpose (spec 12) — per track rather than the visible
picture, abutting clips only (no cuts to / from black), text and shape clips count, edits under a transition are not
its cuts (the transition is the event), no nests. Rebuilding it on `pictureCuts` would change the sound-design cues
its tests pin, so it is not a behaviour-preserving change.

### 1.5 Agents

MCP `list_cuts {projectId, sequenceId?, outputTrackId?, trackIds?, overlayCoverage?, includeJumpCuts?,
includeOverlays?, range?: {start, end}, offset?, limit?}` (read-only, strict arguments; track labels or ids; times
as frames, seconds or timecode) returns `{frameRate, duration, range, tracks, total, counts {cut, jump, overlay},
offset, cuts: [{frame, timecode, kind, track, trackId, outgoingClipId?, incomingClipId?, transitionId?, zone?
{start, end, startTimecode, endTimecode}, nested?}], nextOffset?, warnings?}`; pages default to 500 cuts (≤ 2,000).
The tool computes from the loaded document (`loadDoc`), like `list_through_edits`; no engine route is needed.
Guide text: `STRUCTURE_GUIDE`.

### 1.6 Verification

- `packages/project/test/cut-map.test.ts`: every rule above on documents built through the real commands — cuts,
  gaps, through edits, jump cuts, speed changes, cuts on a clip's first / last frame and range bounds, one-frame clips,
  upper-track B-roll, hidden tracks, disabled clips, text / shape / adjustment / caption clips, Transparent Video,
  solids, `outputTrackId` / `trackIds`, refusals, overlays above / below the threshold, cuts under overlays, Crop and
  position coverage, opacity and blend modes, a scaled-down base, an animated overlay against an independent
  per-frame oracle, a keyframed punch-in, a keyframed fade-out, two-sided / overlapping / one-sided transitions,
  nests (mapping, 2× speed, reverse, trimmed head, nested transition zone, same-source continuation, 25 fps in 59.94,
  cycles, eight levels vs nine), five frame rates, damaged values and missing nested sequences.
- `packages/project/test/cut-map-property.test.ts` (fast-check, 150 runs each): sorted, unique, inside the sequence
  and the range, a range is a filter of the whole map, existing clip / track ids; stable under Add Edit, an empty
  track on top, a disabled clip and a title.
- `apps/mcp/test/structure.test.ts`: `list_cuts` frames, timecodes, counts, paging, options and refusals.

### 1.7 Limitations

- Coverage ignores mask shapes, 3D projection, the Transform effect and distortion effects: such layers count with
  their Motion / Crop / corner-pin quad and never hide the layers below. Pixel alpha of media (logos with transparent
  areas) is not measured; such layers never hide the layers below either.
- Cuts inside a single clip's footage (uncut takes) are not in the document; they need Scene Edit Detection
  (`detect_scene_edits`), which consumers can merge in.
- Animated layers inside nests are evaluated on every frame of their span (bounded by the budgets above).

## Subtitle-scale export and preview (spec 13 §4: AS-050, AS-070…AS-076)

Owner: work package `subexport`. Measured baseline: the private textperf benchmark (spec 13 §4): one ffmpeg input
per caption (≈ 205–230 MB RSS per animated caption master, ≈ 40 MB per looped still, 17 fps overlay chain at
1 000 inputs), one Remotion render per caption (≈ 3.4 s fixed cost per still), 99 animated captions in a 50 s short
peaking at 19–25 GB, the long video impossible on the Hybrid path, and one run that killed the engine itself.

### S.1 What is built

- **Lowered layers — still + native motion (AS-070, AS-073).** `layerStill(c)` (`apps/engine/src/layer-bake/layer.ts`)
  accepts a text layer whose content is static (`isStaticLayer` of the clip without its Motion keys and effects) and
  whose picture moves: keyframed Motion / Opacity, the Transform effect (any keys, with or without its Shutter Angle
  motion blur; at most one blurred Transform) and S_Shake with Motion Blur off, Wrap X/Y **No** and no RGB split
  (`loweredRefusal`, `apps/engine/src/export/stream/lowered.ts`, names what it refuses). No masks, effect masks,
  expressions or other effects (they keep the master bake). The layer bake renders it once as recipe `layer-still`:
  its layer box grown by `contentBleed` (+2 px), Motion a translation into that region, Opacity 100 %, effects
  removed, one frame (`layerStillClip`). The still is then **trimmed to its pixels + 2 transparent px** (sheet path)
  and its region recorded in the cache meta (`picture`). A still whose pixels touch its border (text overflowing an
  estimated box, a wrapped line) is baked again with the region grown by a quarter of the box + two font sizes, then,
  still clipped, as an ordinary master (bake rounds in `extension.ts`; never silently cut).
- **The multi-tap kernel** (`drawTaps`, `export/stream/kernel.ts`) draws a lowered layer per frame from its still:
  `planLoweredFrames` composes, per output frame and shutter tap, the affine maps of Motion⁻¹, then each lowered
  effect from the last to the first (S_Shake's pose, the Transform's inverse) into one map from sequence px to still
  px, plus **coverage stages** for what the shaders sample: the effect canvas the browser draws (box + the GPU
  effects' padding, `gpuPadding`), S_Shake's input canvas (Wrap No samples the whole canvas), the Transform's input
  box (it samples inside the layer box only). Every per-frame value comes from the registered effect's own
  `gpu.uniforms` hook with the compositions' frame context (layer box, pxScale 1, fps, clip-local frame, `fxSeed`
  seed rules, `fxParamsAtFn` with the box metric): `u_shakeNow` (green channel pose), `u_tfA/u_tfT`, and with
  motion blur the shader's plan (`u_mbPlan` taps, `u_mbKeys` key poses interpolated linearly, `u_mbWarp` time warp,
  tap weight `t.y × clamp(opacity / 100)`, normalised by Σ t.y). Mip levels follow the Motion scale like the
  sub-pixel kernel. Per row, coverage is computed only where it is partial (row spans).
- **Kernel streams (AS-072).** In the main graph, the constant-picture layers of a track — baked static stills
  (`sequence` overrides without colour runs), lowered layers, still images / solids with sub-pixel Motion — without
  transition handles, fades, masks or blend modes become **members of one stream** (`stream/taps.ts`,
  `stream/members.ts`, grouping in `native.ts`): one raw RGBA pipe and one overlay for the whole track, covering the
  members' union rectangle. Members never overlap in time, so each frame draws at most one; its pictures are decoded
  (one ffmpeg frame per mip level) a few members ahead and dropped after its last frame. One member alone (or a
  lowered layer with fades / handles / a blend mode) is a stream of its own with the transition fades applied by
  ffmpeg as before. `JASPER_EXPORT_TRACK_STREAMS=0` draws one input per layer (comparison path of the tests).
- **Batched still rendering (AS-071).** Every still bake of an export (static layers and layer stills) is rendered in
  **sheets** (`ensureSheet`, child job `Bake graphics – N stills`): up to 64 one-frame clips back to back in one
  document of the largest still's size, rendered by one Remotion `renderFrames` (`renderStillSheet`, transparent PNG
  frames, the export's page budget shared between sheets by size), decoded by one ffmpeg, cropped, border-checked and
  stored per key. Identical words share a key (a layer still's key has no Motion or effects in it). Cached keys are
  reused, keys in flight joined; one missing still renders alone. Static layers that touch their crop border are
  rendered alone with the full-frame fallback, as before.
- **Preflight and robustness (AS-074).** `estimateComposite` (`export/memory.ts`) models the composite's peak memory
  from the layers the builder will draw (textperf's per-input costs scaled by the sequence's pixels; one kernel stream
  per track with members) and the planner adds a named native blocker when it exceeds `compositeMemoryBudget()`
  (60 % of RAM or of the cgroup limit; `JASPER_EXPORT_MEMORY_BUDGET_MB`): Auto goes to the Remotion path, a forced
  Native export is refused (`PATH_NOT_ELIGIBLE`) with the estimate. A compositor that dies of SIGKILL the job did not
  send becomes `OUT_OF_MEMORY` (`killedComposite`; a pipe error it caused in a stream no longer masks it). Every tool
  process gets `oom_score_adj` 900 on Linux (`preferOomKill`), so the OOM killer picks ffmpeg before the engine.
  The engine's own stream memory is bounded (one stream per track: output slots and a few pictures).
- The plan's estimate counts still bakes as sheets (≈ 3.4 s per sheet of ≤ 128 + 0.1 s per still, textperf).

