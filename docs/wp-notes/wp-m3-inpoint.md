# wp-m3-inpoint — source ranges: frame-exact in-points across versions (S07 PRC-015…019)

Problem (found assembling the trailer): a clip whose media is swapped for another rendering of the **same source**
that covers a **different source range** (a processed range with handles, a graded render made for another cut)
must keep showing exactly the same source moments. M2 left this open ("ranged processed versions don't remap the
clip's in-point", `wp-m2-process.md`). The trailer's assembler solved it with a sidecar (`first_src_frame`):
in-point = wanted first source frame − the file's first source frame, the surplus becomes handles, refuse when the
range is not covered (`MatsSmileTrailer/assemble/edl2assemble.mjs`, "Trim-only conform"). This package makes that
the editor's model.

Branch `wp/m3-inpoint`. Spec `docs/specs/07-clip-processing.md` PRC-015…019, PRU-005, PRA-003, §8 item 11;
S01 command table; ARCHITECTURE D-33 and §19.4.

## Model (decisions)

- **`MediaAsset.sourceRange`** `{mediaId | null, sourceName?, firstFrame, frames, frameRate, origin: process |
  sidecar | manual}`: file frame `i` is frame `firstFrame + i` of the source. Schema **v5**; the v4 → v5 migration
  writes the whole-source range (`firstFrame 0`) on every M2 processed/transcoded version. A recorded range is
  authoritative: a range naming no project media (`mediaId: null`, an external source) means "no version link".
  Versions without a range (agents' `media.register` with a derivation) keep the M2 identity link.
- **Content time stays per file.** No render path, bound check, proxy or waveform needed to change. A swap is a
  pure integer shift of the clip's content time — `Δ = shift(from) − shift(to)`, `shift = Σ firstFrame·F(rate)` up
  the chain to the root original (versions of versions compose) — applied to `sourceIn`, every keyframe (any
  `{value, keyframes}` inside the clip: Motion, opacity, effect params), clip markers and tracker samples /
  reference times. `start`, `duration`, speed and direction stay; swapping back applies −Δ and restores the clip
  bit-exactly (property-tested). Handles are not stored: they follow from `sourceIn` and the new file's length, so
  trims, transitions (`clipHandles`) and the native export see what the file holds.
- **Frames correspond by index**, so file, source and the range's rate must be equal (de-judder retimes the
  picture but keeps the count, so it is covered); otherwise the link is refused with a message. Supporting
  frame-for-frame conforms between rates would need a speed change and float rates — not exact, so not offered.
- **Coverage** (`coveredClipFrames`, end tolerance 1/16 of a file frame ≤ INV-005's): refuse (`E_OUT_OF_MEDIA`
  naming the frames: "T02.mov holds frames 174–303 of crudo.mp4; clip … shows frames 160–219 (14 before its first
  frame)"), `fit: 'trim'` (setClipRange on the clip and linked clips on unlocked tracks sharing the edge, then
  `cleanupSequence` drops separated transitions), `fit: 'skip'` (warning; used by the job's auto-swap).
  Markers/tracker samples that would get negative content time are dropped with a warning; transitions that lose
  handles warn `W_TRANSITION_SHORTENED`.
- **Replace Footage = `media.relink {replace: true}`** (the editor had only the command, no UI): same media id, so
  every clip, item and reference follows; `locators` replaces all locators (stale paths would point at the old
  bytes). `keepSourceTiming` moves every clip / source mark / transcript of the media by `sourceTimingShift`:
  both ranges (same source) → `old.first − new.first`; only the new file has one → the current file is that
  source (warning when the names differ — the trailer case `T02.json` `spec.src: raw/crudo.mp4` vs `crudo.mp4`
  matches); only the current one → the new file is the source (back to the raw); else both start timecodes;
  else refused. Versions of the replaced media are re-anchored on the new file (`firstFrame += shift`) or detached
  with `W_VERSION_DETACHED` when they hold frames before it. Processed versions are not "replaced" (process again).
  Choice: Replace Footage replaces for every clip (Premiere semantics); per-clip switching between renders is the
  Media Version dropdown, because a sidecar-declared render becomes a **version** of its source.
- **Sidecars** (`parseSourceSidecar`): `<file>.json` or `<stem>.json`; `first_src_frame` | `firstFrame`, `frames`,
  `fps`, `handles` `[pre, post]` | `{pre, post}`, `source` | `src` | `spec.src` (the trailer's grade format as is),
  and jasper-proc's own sidecar (`input.range`). Read by the engine for files registered by path
  (`RegisteredMedia.sourceHint`, not stored) and by the web client for a `.json` picked/dropped with an uploaded
  video (not uploaded). Imports turn them into `sourceRange` (origin `sidecar`) with the source resolved by name
  among the project's media and the same batch (`media.setSourceRange` commands appended to the import
  transaction, so order does not matter; never the same bytes). MOV timecode is used through
  `probe.startTimecode` (Replace Footage only; no range is stored for it).
- Ranged processing (`ProcessRequest.range`, existed since M2) now flows through: `ProcessResult.range`,
  `MediaRecord.derivedFrom.range`, `media.derive {range}` → `sourceRange`, names `crudo [Denoised · frames
  1088–1231]`. A clip range that is the whole file is processed as the whole file.

## What was built

| Req | Where |
|---|---|
| PRC-015 | `packages/api/src/processing.ts` (`range` on result), `apps/engine/src/processing/service.ts`, `apps/engine/src/media/{service,registry}.ts`, `packages/project/src/commands/handlers/process.ts` (`processedSourceRange`, `media.derive {range, fit}`), `schema/media.ts` (`SourceRangeSchema`), `migrations.ts` (v4→v5), `schema/document.ts` (v5) |
| PRC-016 | `packages/project/src/process/source-range.ts` (`rootPlacement`, `versionShift`, `rootFrameSpan`, `shiftClipContentTime`), `process/versions.ts` (`sourceLinkOf`, `originalMediaId`/`mediaVersionsOf` follow ranges), `clip.replaceSource {fit}` |
| PRC-017 | `coveredClipFrames`, `coverageTolerance`, `clipFileFrames` (messages), `retimeClipForFile` / `trimToCovered` / `warnTransitions` in `handlers/process.ts` |
| PRC-018 | `media.relink {replace, locators, container, sourceRange, keepSourceTiming, fit}` (`handlers/project.ts` → `replaceMediaFile`), `sourceTimingShift` |
| PRC-019 | `media.setSourceRange`, `process/sidecar.ts`, `apps/engine/src/media/sidecar.ts`, web import (`import/service.ts`, `import/transaction.ts`), MCP `import_media` |
| PRU-005 | `apps/web/src/processing/ProcessDialog.tsx` (Frames row), `jobs.ts` (range, `fit: 'skip'`), `MediaVersionSection.tsx` (frames, handles), `actions.ts` (`switchMediaVersionInteractive` → trim prompt), `ReplaceFootageDialog.tsx` + `replace-footage.ts`, `register.ts` (Project item menu), `commands/process.ts` + `shell/menus/model.ts` (Clip ▸ Replace Footage…) |
| PRA-003 | `apps/mcp/src/tools/processing.ts` (`process_clip {handles, range, fit}`, `use_media_version {fit}`, `replace_footage`, `set_media_source_range`), `tools/projects.ts` (`import_media` sidecars, `get_media_info` `sourceRange` + `sourceFrames`) |

## Contract changes (additive)

- Schema v5, `MediaAsset.sourceRange` (D-33). Other M3 packages may put their additions under v5 too.
- Commands: `clip.replaceSource.fit`; `media.derive.{range, fit}` (result adds `skippedClipIds`, `trimmedClipIds`);
  `media.relink.{replace, locators, container, sourceRange, keepSourceTiming, fit}` (now returns `{mediaId, …}`);
  new `media.setSourceRange`.
- `originalMediaId` / `mediaVersionsOf` follow source ranges; `processedItemName(name, recipe, range?)`;
  `tracking/request.ts` `mediaFrameRate` accepts `Pick<MediaAsset, 'probe'>`.
- `@jasper/api`: `ProcessResult.range`, `RegisteredMedia.sourceHint`. Engine: `registerDerived` `opts.range`,
  `MediaRecord.derivedFrom.range`.
- Web: Clip menu entry `media.replaceFootage`; `IMPORT_ACCEPT` includes `.json` (sidecars); `PreparedMedia.sourceHint`;
  `switchMediaVersion(session, ids, mediaId, fit?)` result shape.
- MCP: tools `replace_footage`, `set_media_source_range` (README tool count 69).

## How to test

```bash
pnpm vitest run --project @jasper/project packages/project/test/source-range.test.ts   # property tests, coverage, relink, migration, v5 fixture
pnpm vitest run --project @jasper/engine apps/engine/test/processing-range.test.ts     # frame-coded range, native export before/after, sidecar hint
MCP_PROCESSING_TEST_PORT=48621 pnpm vitest run --project @jasper/mcp apps/mcp/test/processing.test.ts
pnpm vitest run --project @jasper/web apps/web/test/processing.test.tsx apps/web/test/wp2e/import.test.ts
E2E_PORT=48620 pnpm e2e -- e2e/source-range.spec.ts
```

The e2e processes frames 14–45 (clip 20–39 + 6 handles) of `frame-code.mp4` through the UI, swaps, and reads the
burned-in frame numbers from `render_frame` (`frame.capture`, the engine's still render) at timeline frames 0, 5,
10, 19 — 20, 25, 30, 39 on the original, on the range, back on the original — then Replace Footage with a render of
frames 10…63 and its sidecar (in-points −10, same codes) and one undo.

## Validation on real footage

The sidecar semantics (file frame `i` = source frame `first_src_frame + i`) were checked on the trailer's graded
renders against `raw/crudo.mp4` (30 fps, 8769 frames): for frames 10 / middle / last-10 of each render, the
best-matching raw frame (gradient correlation at 160×90 over offsets −3…+3) is at offset 0 —
`T02.mov` (first 174, 130 frames, handles 0/8): 0.77 / 0.93 / 0.94; `T05.mov` (first 412, 107 frames):
0.95 / 0.95 / 0.96. Importing `T02.mov` by path next to `T02.json` (its `spec.src` is `raw/crudo.mp4`) makes it a
version of `crudo.mp4`; a clip on crudo frames 180…279 switches to it with in-point 6 and handles 6 / 24.

## Open issues / notes

- Range ↔ rate: only equal frame rates link (see above). VFR files are treated with their average rate.
- PST-013 (M2): de-judder of a range copies its first/last frame (no context frame is read outside the range).
  With handles ≥ 1 those frames are handles, so the frames a clip shows are retimed; with handles 0 the clip's
  first/last frame are not.
- Replace Footage via timecode does not store a range (it is in the probe); mixing a timecode-only file with a
  range-declaring one is refused (no common basis).
- `media.setSourceRange` moves no clip by design (it declares metadata); re-declaring the range of a version clips
  already use changes which source frames those clips stand for (documented in the MCP tool).
- The uploaded file of a cancelled Replace Footage dialog stays in the engine store until media GC.
