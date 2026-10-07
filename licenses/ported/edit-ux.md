# Editorial UX: trim mode, split-edit ripple edits, edit property tests, keyboard layouts

- **Upstream:** https://github.com/storytold/filmcraft (commit `771b614`)
- **Licence:** MIT OR Apache-2.0
- **Copyright:** Copyright (c) 2026 ArtCraft Team and the FilmCraft contributors
- **Ported by:** edit-ux workstream, 2026-10-07

| Upstream path | Our path | What |
|---|---|---|
| `crates/edit/src/lib.rs` (`ripple_trim_group`, `ripple_delete_spans`, `ripple_delete_items`, `set_speed_group`) | `packages/project/src/commands/ripple.ts`, `packages/project/src/commands/handlers/clip-core.ts`, `packages/project/src/commands/handlers/clip-edit.ts` | ripple trims that move split-edit partners with their pictures, ripple delete closing one stretch per track, speed groups rippling once by the largest change — TypeScript over our sync-lock rules |
| `crates/engine/src/trim.rs` | `packages/project/src/edit/trim-mode.ts`, `apps/web/src/panels/timeline/state/trim-mode.ts` | edit points, roll pairs, Select Nearest Edit Point, trim type cycle, Trim Monitor sides and shift counters, dynamic J/K/L trimming committed as one undo step, play around the edit |
| `crates/engine/src/commands.rs` (`edit_at_source`, `source_range`) and `crates/engine/src/sequence_tools.rs` (`split_source_ranges`) | `packages/project/src/commands/handlers/edit-ux.ts` | source edits with split (video/audio) source ranges offset by their In difference; extended with three/four-point resolution, backtiming and Fit Clip |
| `crates/engine/src/trim_tests.rs`, `split_edit_ripple_trim_tests.rs`, `ripple_delete_tests.rs` | `apps/web/test/edit-ux-trim-mode.test.ts`, `packages/project/test/edit-ux-split-edits.test.ts` | test scenarios ported to Vitest against our command handlers and session gestures |
| `crates/edit/src/tests.rs` (`never_overlaps`, `insert_then_extract_is_identity`, `ripple_trim_group_*`, `ripple_delete_closes_the_time_free_on_every_track`, `speed_on_a_linked_group_ripples_once`) | `packages/project/test/edit-ux-edit-props.test.ts`, `packages/project/test/edit-ux-split-edits.test.ts` | proptest properties ported to fast-check |
| `crates/engine/src/shortcut_presets.rs` (`AVID`, `FINAL_CUT`) | `apps/web/src/commands/keymap-presets.ts` | Avid Media Composer and Final Cut Pro key assignments mapped onto our command ids |
| `docs/monitors.md`, `crates/ui-egui/src/panels/monitor_view.rs` | `apps/web/src/panels/program/monitor-view.ts`, `GuidesOverlay.tsx` | guide behaviour (frame pixels, drag out of the rulers, drop outside to delete, templates) |

Notes: everything is re-implemented in TypeScript on Jasper's document model (frames and flicks instead of ticks,
Immer drafts, transactions); FilmCraft's dynamic trim history splicing became a session gesture. Not ported:
FilmCraft's egui widgets and its engine command dispatch.
