# Code ported by the `edit-structure` workstream

Upstream: FilmCraft — https://github.com/storytold/filmcraft
Licence: MIT OR Apache-2.0
Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors

| Upstream path | Our path | What |
|---|---|---|
| `crates/edit/src/through.rs` (`is_through_edit`, `through_edits`, `join_through_edits`, `track_gaps`, `sequence_gaps`, `clip_item_to`) | `packages/project/src/derive/index.ts` (`sameSource`, `isThroughEdit`), `packages/project/src/structure/through.ts`, `packages/project/src/commands/handlers/structure.ts` (`joinThroughEdits`) | Through-edit detection and joining, gap lists and navigation, trimming a copy of a clip to a range (Make Subsequence) |
| `crates/engine/src/commands.rs` (`nest`, `clip.group`, `clip.ungroup`) | `packages/project/src/commands/handlers/structure.ts` (`nestHandler`, `clip.group`, `clip.ungroup`) | Nest: lowest track per kind, linked nest clips, nested sequence with the parent's settings and track layout |
| `crates/engine/src/sequence_tools.rs` (`make_subsequence`, `go_to_gap`, `join_through_edits`, `reverse_match_frame`, `timeline_time_of`) | `packages/project/src/commands/handlers/structure.ts` (`makeSubsequence`), `apps/web/src/commands/structure.ts` (gap navigation, reverse match frame) | Subsequence naming `<name>_Sub_NN`, transitions inside the range, gap navigation, reverse match frame |
| `crates/engine/src/clip_ops.rs` (`add_frame_hold`, `insert_frame_hold_segment`, `frame_hold_options`, `remove_unused`) | `packages/project/src/commands/handlers/structure.ts` (`addFrameHold`, `insertFrameHoldSegment`, `frameHoldOptions`, `removeUnused`) | Frame hold semantics (split + hold, 2 s segment, hold on In / Out / playhead / sequence time / source time, Hold Filters) |
| `crates/project/src/lib.rs` (`source_time_at`, `effect_time_at`, `moving_source_time_at`) | `packages/project/src/render/scene.ts` (`clipContentTime`, `clipPictureTime`) | Picture time vs. effect time under a frame hold (Hold Filters) |
| `crates/edit/src/multicam.rs` (`flatten_items`) | `packages/project/src/commands/handlers/structure.ts` (`unnestHandler`) | Flattening a nest clip into the clips it shows (outer effects appended) |
| `crates/media/src/generators.rs` (`bars`, `leader`, `audio_sample`) | `packages/project/src/structure/generators.ts` | HD colour bars layout, the counting leader sweep/rings, the 1 kHz tone and leader blips (extended: Premiere's leader colours and cue options, anti-aliasing, stroke numerals) |
| `crates/render/src/lib.rs` (`render_seq_tracks` adjustment branch, `adjustment_region`, depth guard) | `packages/compositions/src/layers/AdjustmentScope.tsx`, `apps/engine/src/export/native.ts` (adjustment branch of `drawStack`) | Adjustment layers: effects on the composite below, mixed back with opacity / blend, limited to a region |
