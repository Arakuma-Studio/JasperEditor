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

## 2. Generation (spec 13 AS-001…AS-004)

`captions.generate {sequenceId?, source?, range?, output?, trackId?, trackName?, template?, rules?, text?, cutAware?,
language?, name?, nest?, dryRun?, ref?}` (`packages/project/src/commands/{schemas,handlers}/subtitles.ts`) creates
every subtitle in **one command** (one transaction, one History entry "Create Subtitles", no 5 000-command limit) and
returns `{groupId, trackId, clipIds, count, stats}`; `stats = {count, snappedToCuts, splitAtCuts, belowMinimum, merged,
dropped, crossing, warnings}` (`merged` = cuts merged into montage zones, `dropped` = wordless pieces removed,
`crossing` = subtitles still running across a cut: always 0 for hard cuts). `dryRun: true` changes nothing and
returns the stats, the resolved rules and the first 50 subtitles (the dialog's live counts and MCP dry runs).

Layout is pure (`packages/project/src/captions/subtitles/layout.ts`, `layoutSubtitles`):

1. **Words**: `sequenceWords` (the sequence transcript: transcribed audio clips, top track first; `breakBefore` of the
   transcript kept), filtered by `source` (`'sequence-transcript'`, `{mediaId}`, `{clipIds}` — a video clip stands for
   its linked audio) and `range` (word midpoint inside). Reversed audio clips give no words and time-remapped video
   clips are reported (`W_SUBTITLES`); no words at all is `E_INVALID_PARAM`.
2. **Text transforms** (`text.ts`) on the display text of every word, over the whole run so Sentence case knows where
   sentences start: case (as spoken / UPPER / lower / Sentence), glyph replacement (… → ..., “ ” „ « » → ",
   ‘ ’ ‚ → ', – — → -; only the glyphs listed in `missingGlyphs` when given — the template names what its font lacks),
   profanity mask (`asterisks` or `first-letter`, case and punctuation ignored); trailing punctuation is stripped per
   subtitle.
3. **Grouping** (`groupSubtitleWords`): the rules of `captionBlocks` (lines of `maxChars`, `lines`, speaker change,
   pause ≥ `breakPauseSeconds`, `maxSeconds`, `breakBefore: 'segment'`) plus `maxWords`, the punctuation mode (`never`;
   `half` = after `.?!…` once the subtitle is half full, as before; `always` = after `.?!…` and `, ; :`) and the
   language's **weak words** (AS-042): a soft break (line full / max words) after an article, preposition or
   conjunction moves that word to the next subtitle when the next one can take it (Spanish list `es`: el la los las un
   una … de del en por para con sin y e ni o u que si …; the same rule for `en`; other languages: none). Lines inside a
   subtitle (`breakLines`) follow the same rule. **Assumption**: subtitling convention (no source states exact lists).
4. **Cut awareness** (§3), then **timing** (`finishTiming`): hold until the next subtitle (up to `holdSeconds`, never
   past a cut), minimum duration (into the silence after, else — when the start is not on a cut — before; else
   counted in `belowMinimum`), maximum duration (never cutting words), gap, no overlaps (a start on a cut wins), frame
   snapping (start = the first word's frame, end = the frame after the last word's end).

Rules (`rules.ts`, strict zod, every field optional and resolved against the template's defaults, then the generic
ones; stored resolved in the group):

| Rule | Range | Generic (Premiere-like) | Pixel Pop (the user's measured style) |
|---|---|---|---|
| `maxChars` (per line) | 7–72 | 42 | 13 |
| `lines` | 1–3 | 2 | 1 |
| `maxWords` | 1–20 / null | null (off) | 3 |
| `minSeconds` | 0.1–10 | 1 | 0.2 |
| `maxSeconds` | 0.5–60 | 7 | 2 |
| `gapFrames` | 0–30 | 0 | 0 |
| `breakPauseSeconds` | 0.05–10 | 1 | 0.3 |
| `holdSeconds` | 0–10 / null | null (off) | 0.5 |
| `punctuation` | never / half / always | half | always |
| text: case / strip trailing / replace glyphs | | as spoken / off / off | as spoken / off / on (… “ ” ‘ ’ « » – —) |

**Output = text clips** (default; AS-003). A new top video track "Subtitles" (or `trackId`, which must be an unlocked
video track: `E_TRACK_KIND`, `E_TRACK_LOCKED`), one text clip per subtitle placed with overwrite. Each clip:
`sourceIn` = one hour of content time (`CAPTION_CONTENT_ORIGIN`, like caption clips) so heads can be extended by
trims and by alignment; `content.text` = the subtitle's lines; `content.style` = the template style scaled to the
frame; box = paragraph text (`autoSize: 'height'`) `box.widthPct` of the frame width; Motion position = the
template's box centre for the nearest aspect (16:9, 9:16, 1:1, 4:5), anchor = box centre; the template's text
animation and effect preset (§6); `caption = {groupId, words (content time), speaker?, anchorIn}`. The group record
`Sequence.captionGroups[cgp_…] = {name, templateId, rules, text, language, cutAware, sourceRef, range, trackId,
highlight, createdAt}` keeps what `captions.regenerate` needs. The template is copied into the project
(`ProjectDocument.subtitleTemplates`) and its style becomes a **linked project text style** (spec 13 SH-002, the
styling work): one style per template and frame size (found again by `templateId` + `frame` stored on the style
entry; a style edited since wins), the clips get `styleId` (no overrides), so editing that style restyles every
subtitle (§7). The font is a project font of the template's family (`Pixel12x10` for Pixel Pop) resolved through the
font library at render time; a family that is not installed renders with the default family and the editor shows an
install notice. `nest: true` puts the clips in a nested sequence (the group moves with them; warning
`W_SUBTITLES_NESTED`: nests do not follow later ripple edits).

**Output = caption track** (AS-004): today's caption clips (`placeCaptionClips`) laid out with the same rules and cut
awareness, line breaks from the layout, the track style from the template (text style fields, `boxWidthPct`,
`maxCharsPerLine` / `maxLines` / `maxSegmentMs` from the rules, `linePct` / `positionPct` from the template position,
highlight word / karaoke). A template chosen explicitly may default to this output (the "Subtitles" built-in).

## 3. Cut-aware timing (AS-010…AS-013)

Cuts come from the cut map (§1) below the subtitles' track (`cuts.ts` `subtitleCutEvents`; options AS-011:
`enabled`, `lookBackSeconds` 0.5, `lookAheadSeconds` 0.05, `trackIds` (picture tracks; default all below),
`overlayCoverage` 0.5, `includeJumpCuts`, `includeOverlays`, `transitions` snap / avoid). Steps as implemented
(`alignToCutEvents`, `finishTiming`):

0. **Cut events**: a two-sided transition ≥ 3 frames is a zone around its edit point (shorter ones are hard cuts);
   cuts closer to each other than the minimum duration merge into one zone whose edit point is the first cut
   (`merged` counts the cuts merged).
1. **Split at cuts**: every cut strictly inside a subtitle that may not cross it (hard cuts; zones only when the
   subtitle started at or after the zone start) divides its words by midpoint (a straddling word goes to the side
   holding most of its duration); each non-empty part becomes a piece `[previous cut, next cut)` (the first keeps the
   subtitle's start, the last its end), so all words on one side = the boundary moves to the cut (the 27-frame case);
   a subtitle left without words is dropped. **Look ahead** is applied here: a first piece within `lookAhead` before
   the first cut joins the piece after it (the start moves onto the cut).
2. **Start on cuts (look back)**: the latest cut ≤ `lookBack` before a start becomes the start when the previous
   subtitle has no word (midpoint) after it; the previous one then ends on the cut.
3. **End on cuts**: by step 1 a subtitle with no words after a cut ends on it; holds and minimum-duration extensions
   stop at the next cut.
4. **Priorities**: never cross a cut > exact alignment > minimum duration > gap (a start on a cut is fixed; a piece
   made too short extends away from its cut, else is kept and counted in `belowMinimum`; wordless pieces < 3 frames
   are dropped).
5. **Zones**: a subtitle started before a zone may run through it; a boundary between subtitles inside a zone moves to
   the edit point (`snap`) or to the nearer zone edge (`avoid`) when that takes no words from either side.
   **Interpretation** (spec text "a caption may run through a zone only if it started before the transition"):
   applied to montage zones too, so a subtitle may run through flash cuts closer than the minimum duration.
   "Started before" is judged for the *piece* that reaches the zone, after the earlier splits: a subtitle split at a
   hard cut lying on or inside a zone (a transition starting on a cut, or a hard cut inside a montage / transition
   span) starts with the zone, not before it, so it may not run through the zone's edit point and is split there too.
   Starts moved by look-back (step 2) and by zone snapping are checked the same way (the split step runs again after
   them). Found by the layout property test (fast-check seed 428871206: one word over frames 0–8, a hard cut at 1, a
   zone [1, 13) with its edit point at 7 gave a subtitle [1, 8) across the edit point); the property's rule — a zone's
   edit point is crossed only by a subtitle that started before the zone — is the spec's and stays as written;
   regression test "a piece that starts on (or inside) a zone after a split does not run through it".
6. Timing (§2 step 4).

`captions.alignToCuts {groupId | clipIds, options?, dryRun?}` (AS-012) re-runs steps 0–5 (and the minimum-duration
priority, no hold) on existing subtitles track by track — words from `caption.words` (a subtitle without words counts
as one word over its span) — then applies the result in one step: razor cuts at the pieces' starts (words and text
divided, §4), moves / trims (words stay where they were in sequence time; template keys follow the In), removal of
emptied subtitles; other clips on the track bound how far a subtitle may grow. It returns the same stats plus
`moved`, `removed`, `clips`.

**Output in a nest** (AS-013): when the subtitles' sequence is placed in other sequences, the parents' cuts over each
nest clip (constant speed; reversed, remapped or held nest clips are skipped with a warning) are mapped into it and a
warning says so. Edge cases tested (`packages/project/test/subtitles-layout.test.ts`, `subtitles-commands.test.ts`):
cut on a subtitle's first / last frame, several cuts in one word, locked output track, output in a nest, reversed
A-roll, 23.976 / 25 / 29.97 / 59.94 / 60 fps (layout and documents), speaker change at a cut, cut during a pause, a
subtitle emptied by a split, transitions < 3 frames, overlays below / above the coverage threshold, montages; a
fast-check property (200 runs: random words, cuts, zones, rules and rates) checks sorted, non-overlapping subtitles
of ≥ 1 frame holding every word once, no hard cut crossed, zones crossed only by subtitles started before them.

## 4. Editing integrity (AS-006)

- **Razor** (`splitClipAt` → `splitCaptionWords`): words go to the piece holding their midpoint and each piece's text
  keeps its own words, located in the text in order (case and punctuation ignored) so manual line breaks and styled
  runs survive (runs and paragraph settings are cut with the text); when the words cannot be located (the text was
  rewritten) each piece gets its words joined; a cut inside one word keeps everything on both pieces. Every split
  path (clip.split, razor through all tracks, overwrite / clearRange, ripple extract, alignToCuts) uses it.
- **Text edits** re-time unchanged words (LCS, `retimeText`; changed spans share the replaced time by characters):
  the per-transaction upkeep (`captions/subtitles/normalize.ts`, run by `applyTransaction` on the clips the
  transaction changed) does it whenever a command changed a subtitle's text without setting its words (Properties,
  the Program monitor, `clip.update`, `param.set`, Paste Attributes), and also rebuilds the highlight (§6) and
  re-anchors template keys (§6). A subtitle pasted into a sequence without its group gets the group (copied from the
  sequence it came from, else default rules).
- **Ripple edits** move subtitles as ordinary clips (sync lock); words are content time, so moves and ripples keep them.
- `captions.regenerate {groupId, range?, rules?, text?, cutAware?, dryRun?}` rebuilds a group (or a range) from the
  current transcript with the stored (or patched) rules; a new subtitle whose words equal an old clip's (case and
  punctuation ignored) and that overlaps it in time keeps that clip (its style, effects, transform and manual
  overrides; only its range and words change); other old clips are removed, new ones are created from the template.
- `captions.updateGroup {groupId, name?, language?}`, `captions.deleteGroup {groupId, clips: delete | keep}` (keep =
  ordinary text clips). `sequence.duplicate` gives the copy's groups new ids.

## 5. Conversion and subtitle export (AS-005)

`captions.convert {groupId | clipIds | captionTrackId, to, keepSource?, template?, trackName?}`:

- **Text clips → caption track**: a new caption track named after the group; its style = the first clip's text style
  + `boxWidthPct` (box width / frame width), `linePct` (box top), `positionPct` (box centre), the rules' line limits
  and the highlight (word / karaoke); a clip whose style differs from the first keeps the difference as its caption
  style override; words (sequence time) with line breaks from the text. Not representable on a caption track and
  reported per feature with clip counts (`unrepresentable`, warning `W_SUBTITLES_CONVERT`): effects, text animation,
  text animators, keyframes, masks, blend mode, styled runs, scale / rotation, hand-made Source Text keys, 3D. The
  source clips (and the emptied group) are removed unless `keepSource`.
- **Caption track → text clips**: one text clip per caption page (`captionPages`, so multi-page captions become
  several subtitles exactly as they show) on a new top video track, in a new group (rules from the track's line
  limits, highlight from the caption highlight); style = the resolved caption style (or `template`), box width
  `boxWidthPct`, position from placement / margin / `linePct` / `positionPct` (title-safe 10 %, as the caption
  renderer) plus the caption clip's Motion offset; caption markup (`<i>` …) becomes plain text; Motion scale /
  rotation / keyframes of caption clips are reported. The caption track is removed when emptied (unless `keepSource`).
- Text clips → caption track → text clips gives back the same ranges and texts (tested).

**SRT / VTT from a text-clip group**: `captionCuesForGroup(seq, groupId, range?)` gives the group's cues in output
time (enabled clips on shown tracks); the export service accepts group ids wherever it takes caption tracks
(`captions.sidecarTracks`, `captions.embed`), `sidecarTracks: 'active'` falls back to the first group when the
sequence has no caption track, `embed: true` / `'all'` include groups (`apps/engine/src/export/captions.ts`, label
`S1…`), and MCP `export_captions` takes `groupId` (§9). Burn-in is unchanged: text clips always render.

## 6. Templates (AS-020…AS-022)

A template (`captions/subtitles/templates.ts`, format `jasper-subtitle-template` v1, ≤ 1 MB, strict-ish zod with
unknown fields kept) = `fontFamily` + text style without font id (sizes at a 1080-px shorter side, scaled with the
sequence's shorter side: font, strokes, shadow distance / blur / spread, background padding / radius), `box.widthPct`,
`position[aspect]` (box centre as fractions of the frame), `animation.textAnimation` (legacy in / out text animations,
windows in seconds) and `animation.preset` (an **anchor-in effect preset**, the effect-presets format: effects with
keys timed from each clip's In), default `rules` / `text` / `cutAware`, `highlight` (none / word / karaoke /
keywords), default `output`. Stored: built-ins in code, the user library `<appdir>/presets/subtitle-templates.json`
(engine, atomic writes, validated, invalid entries kept aside, unreadable file moved aside, newer versions read-only;
routes `GET /api/subtitle-templates`, `PUT /api/subtitle-templates/:templateId`, `DELETE …` with the user's approval for
agents; event `subtitleTemplates.changed`), and the project copy `ProjectDocument.subtitleTemplates` (made when a
template is used).

Commands: `subtitleTemplate.save {clipId, name, description?, id?, effects?}` (Save as Template…: the clip's style,
box %, position for this aspect, text animation, effects as an anchor-in preset, and its group's rules, text and
highlight), `subtitleTemplate.add {template}`, `subtitleTemplate.delete {templateId}` (project copy),
`subtitleTemplate.apply {template, groupId | clipIds, parts?: {style, layout, animation, highlight}}` (one undo step:
style linked as in §2, box and position, the template's previous effects (marked `EffectInstance.subtitleTemplate`)
and text animation replaced, highlight rebuilt, the group's `templateId` set).

**Keys anchored to the In**: the preset's keys are laid out from each clip's In; `caption.anchorIn` records that In
and the upkeep shifts every key of the marked effects by the In's move after a trim or a razor cut (the right piece
of a cut pops in again; moves and ripples keep `sourceIn`, so nothing shifts).

**Highlight**: `word` / `karaoke` = Source Text hold keys at each word's start (content time) whose styled runs colour
the spoken word / every word spoken so far; `keywords` = static runs on the listed words (the longest word when the
list is empty); runs and keys are tagged so they are rebuilt from the words after text, style and word changes and
removed with the highlight; hand-made Source Text keys are never replaced (the highlight is then not drawn). These
render through the existing text renderer on every path (no rendering code changed).

Built-ins (neutral names; bundled OFL / Apache fonts except Pixel Pop's user-installed family):

| Template | Font, size, look | Layout (box %, centre y 16:9 / 9:16) | Animation | Rules |
|---|---|---|---|---|
| Pixel Pop | Pixel12x10 500, 98 px, white, #AE00FF outside stroke 11.5 px, shadow #221D58 80 % distance 0, blur 24, spread 12 | 75 %, 0.83 / 0.50 | Transform: uniform scale 75 % @0 → 108 % @0.100 s → 100 % @0.167 s, opacity 0 → 100 % @0.050 s, linear, shutter 360°; S_Shake Amplitude 0.6, Frequency 1, Seed 0, no wrap, no blur, X / Y / Tilt Rand Amp 0.267 / 0.133 / 1 | Pixel Pop (§2) |
| Pixel Pop Classic | Pixel12x10 500, 130 px, 30 px stroke, same shadow | 75 %, 0.80 / 0.50 | Transform uniform scale 0.1 % → 100 % over 0.083 s, full ease-in on the second key, shutter 360°; no shake | Pixel Pop |
| Subtitles | Source Sans 3 600, 48 px, 60 % black box | 80 %, 0.86 / 0.78 | none | generic; output caption track |
| Bold Pop | Montserrat 800, 92 px, UPPER, black 8 px stroke, soft shadow | 80 %, 0.80 / 0.58 | text animation Pop in 0.2 s | 16 / 1 / 3 words / 0.3–2.5 s / hold 0.4 s / always |
| Word Highlight | Poppins 700, 76 px, black 6 px stroke | 82 %, 0.82 / 0.62 | — | 22 / 2 / 6 words; highlight word #FFD400 |
| Karaoke | Montserrat 800, 70 px, black 6 px stroke | 84 %, 0.83 / 0.64 | — | 28 / 2 / 8 words; karaoke #33D6FF |
| Minimal | Inter 500, 54 px, soft shadow | 80 %, 0.87 / 0.76 | Fade in 0.15 s / out 0.1 s | generic |
| Lower Third | Source Sans 3 600, 46 px, left aligned, dark bar 78 % | 56 %, centre x 0.34 y 0.80 / 0.50, 0.74 | Slide Right in 0.25 s | 40 / 2 |

Pixel Pop sources: spec 13 §0 / research `subs` §1.3 (font, colours, ≈ 98 px on screen at a 1080 shorter side, box 75
%, positions, pop-in keys at frames 6 / 10 / 3 of 59.94 → 0.100 / 0.167 / 0.050 s, effect order Transform then
S_Shake as in the user's graphics). **Assumptions**: the shadow's blur 24 px and spread 12 px (Premiere's shadow "size"
26.87 / blur 250 have no documented pixel meaning; chosen to give the soft #221D58 glow seen in the export frames;
`spreadPx` renders once the text-rendering work lands, until then only the blur shows); positions for 1:1 (0.70) and
4:5 (0.62); the Pixel Pop font weight (the family has one Medium face).

### 6.1 S_Shake calibration

Inputs: the user's S_Shake (Amplitude 0.6, Frequency 1, X / Y / Tilt Rand Amp 72 / 36 / 5, Rand Freq 1, Seed 0, Wrap
0) and three exports' first ten frames of one caption each (research `subs` frames: two Pixel Pop shorts / long
frames, one 2024 short without shake as a control). Method:

1. Units. Sapphire documents X / Y Rand Amp without a unit (defaults 0.2 / 0.1) and Tilt Rand Amp in degrees
   (borisfx.com/documentation/sapphire/ae/shake/); our S_Shake follows Sapphire's defaults with offsets of
   Amplitude × Rand Amp × 0.1 *layer-box* widths × noise and tilt Amplitude × Tilt Rand Amp × 5° × noise
   (`registry/fx/sapphire-distort-warp/math.ts`). 72 / 36 are exactly 360 × Sapphire's defaults, so Premiere shows these
   two parameters ×360 (a Rand Amp of 72 read as frame widths would move the text 43 frames; read as pixels it would
   give a 0.15 px/frame drift at 1 Hz, far below what the frames show). Tilt 5 is degrees (Amplitude 0.6 → ±3°).
2. Frame. Sapphire offsets are relative to the clip's frame (the 1080- or 1920-wide graphic), ours to the layer box
   (the text box, 75 % of the frame width). Conversion: Rand Amp = value / 360 × 100 / `box.widthPct`; Tilt Rand Amp =
   value / 5.
3. Check. Purple-outline bounding boxes per frame (export frames decoded with the LGPL ffmpeg on the build VM, private
   script `research/subtitles-harness/shake-measure.mjs`): the control short does not move (box centre constant over
   10 frames); the Pixel Pop captions drift by 1.5–5.5 px (shorts, at 540-px width ×2 → 3–11 px) and 7.5–10.5 px
   (long, at 960-px width ×2 → 15–21 px) from the frame centre — inside the converted model's range (shorts ±19 px,
   long ±35 px peak at |noise| ≤ 1.5) and of the predicted order (0.6 × 0.02 frame widths = 13 px / 23 px rms scale).
   Ten-frame windows during the pop-in (where scale also moves the box) cannot separate Sapphire's noise shape or its
   frequency law from ours, so the trajectories are not expected to match, only the amplitude.

Result: X 0.267, Y 0.133, Tilt 1 (Pixel Pop, box 75 %), equal pixel offsets to the user's S_Shake on any frame width
(unit test `the Pixel Pop shake reproduces the Premiere offsets on any frame`). Confidence: medium for X / Y (unit
inference + magnitude check), medium-high for Tilt (documented degrees); frequency carried over as is.

## 7. Linked styles (spec 13 SH-002 / AS-003 integration)

The template → project text style link is one function (`linkTemplateStyle`). The styling commands work on groups
through `caption.groupId` (`text.setStyle {groupId}`, `textStyle.apply / detach / reset {groupId}`); the highlight
upkeep rebuilds its Source Text keys after any style change so they never hold a stale style.

## 8. Editor (AS-040, AS-022, AS-032)

`apps/web/src/subtitles/` (+ `apps/web/src/commands/subtitles.ts`):

- **Create Subtitles…** (Sequence ▸ Captions, the Text panel menu, a button in the Transcript tab; History "Create
  Subtitles"; Spanish "Generar subtítulos", since "Crear subtítulos" already names Create Captions): source
  (sequence transcript / one media / the selected clips), template (built-ins, the project's templates and the user
  library, refreshed on `subtitleTemplates.changed`), output, language; every AS-002 rule in three columns (generic
  default, template default, value — a blank value keeps the template's default, "off" for the rules that allow it);
  text transforms; the AS-011 cut options; Nest with its warning. Live counts (subtitles, snapped, split, below
  minimum, merged) and a rendered frame of the first subtitle come from the same `captions.generate` applied to a copy
  of the document (dry run), drawn by the Player inside its own session provider and an error boundary. A template
  whose font family is not in the font library shows an install notice with **Install Font…**. Create sends one
  `captions.generate`.
- **Text ▸ Subtitles** tab: the sequence's groups (name, template, language, count) with Align to Cuts, Regenerate,
  Select, Apply Template…, Export (SRT, VTT, TTML, SCC, STL from `captionCuesForGroup`), To Caption Track, Captions to
  Text Clips, Save as Template… (also on text clips' timeline context menu; "Save to library" option), Rename, Delete;
  a virtualised list of a group's clips (a 2,000-clip group draws < 60 rows), click to seek, inline text edits (one
  undo step; words re-time).
- Selection helpers **Subtitle Group** and **Same Template** in the Select menu registry (styling's
  `selectionHelpers`); no new default shortcuts (keymap test).
- Export dialog: the captions section also appears for sequences with subtitle groups only; a group can be the sidecar
  / embedded source.
- Tests: `apps/web/test/subtitles.test.tsx`; Playwright `e2e/subtitles.spec.ts` (two generated full-frame shots with a
  cut, an imported transcript, Pixel Pop through the dialog: no subtitle crosses the cut, "el juego" starts on frame
  90; the exported frames before / after the cut show the expected subtitles; 3 / 3 passed with a full build).
- UI check on the build VM's dev stack (1080×1920 60 fps project, Pixel12x10 installed in that app dir only): the
  dialog previewed 11 subtitles with 1 split at the cut and no font notice; Create gave one History entry; "horas"
  ended on the cut frame 240 and "y" started on it; the Program monitor drew the pixel-font subtitles and the tab
  showed "11 subtitles · Pixel Pop · es".

## 9. Agents (AS-041)

MCP (`apps/mcp/src/tools/captions.ts`, `apps/mcp/src/tools/subtitles.ts`; strict arguments; times as frames, seconds
or timecode; guide text `SUBTITLES_GUIDE` with the recommended flow transcribe → clean up (spec 14) →
`captions_from_transcript` with a template → `align_captions_to_cuts` after edits → `style_text` /
`apply_subtitle_template` → `export_captions {groupId}`):

- `captions_from_transcript` — with any of `output`, `template`, `rules` (every AS-002 rule), `text`, `cutAware`,
  `source`, `range`, `trackName`, `nest`, `dryRun` it emits `captions.generate` (one undo step; the dry run returns
  the statistics and the first subtitles with timecodes); with only its original arguments (`maxChars`, `lines`,
  `minSeconds`, `maxSeconds`, `gapFrames`, `breakPauseSeconds`, `preset`, `track`, …) it keeps the original caption-track
  path (`transcript.createCaptions`), so existing agent flows behave as before.
- `list_caption_groups {sequenceId?, groupId?, offset?, limit?}` (groups: name, template, language, rules, track,
  clip count; with `groupId` a paged list of its clips with frames, timecodes, text and word counts),
  `align_captions_to_cuts {groupId | clipIds, options?, dryRun?}`, `regenerate_captions {groupId, range?, rules?, text?,
  cutAware?, dryRun?}`, `convert_captions {groupId | clipIds | captionTrackId, to, keepSource?, template?}`.
- Templates: `list_subtitle_templates` (built-ins, project copies and the user library, each with whether its font
  family is installed), `save_subtitle_template {clipId, name, toLibrary?}` (project copy, then the library),
  `apply_subtitle_template {template, groupId | clipIds, parts?}`, `delete_subtitle_template {templateId, from:
  project | library}` (library deletion is approved by the user in the editor).
- `export_captions {groupId}` writes SRT / VTT / any caption format from a text-clip group (`captionCuesForGroup`).

Tests: `apps/mcp/test/subtitles.test.ts` (each tool, dry run, refusals: unknown template, unknown argument, mixed
paths, locked track; the original `captions_from_transcript` path; describe_commands examples).

## 10. Verification and measurements

Tests (all run on the build VM; numbers of the latest runs):

- `packages/project/test/subtitles-layout.test.ts` (26): rules, text transforms, Spanish line breaks, every cut step
  and edge case, five frame rates, fast-check property (200 runs).
- `packages/project/test/subtitles-commands.test.ts` (29): generation (text clips, Pixel Pop effects and keys, linked
  style, template copy, weak words), cut alignment on documents (cut, overlay below / above the threshold, nest
  mapping, reversed dialogue, five frame rates), dry run, caption-track output (also into a track without a stored
  style), refusals (locked track, track kind, no transcript, unknown / invalid template, bad range), nesting, razor,
  text edit re-timing, template keys after a trim, paste into another sequence, regenerate, align after re-editing,
  conversion round trip, SRT from a group, save / apply templates, word highlight, groups, sequence duplicate, load
  repair (idempotent), the S_Shake calibration.
- `packages/session/test/subtitles-history.test.ts`: generate (≈ 200 Pixel Pop subtitles on a 9:16 59.94 short
  with 60 B-roll cuts), align, regenerate, apply template, text edit, razor, convert both ways — one History entry
  each, undo / redo restore the exact documents.
- `apps/engine/test/subtitle-templates.test.ts` (library: save / replace / delete / restart, refusals, unreadable
  file, invalid entries kept aside, newer library read-only), `apps/engine/test/subtitles-export.test.ts` (sidecars
  and embedded streams from a group, SRT round trip).
- `apps/mcp/test/subtitles.test.ts` (§9).
- Whole suites after integration: `packages/project` 205 files / 2 440 tests, `packages/session` 20 / 81,
  `apps/mcp` 69 / 284 (+ 8 skipped by design), engine subset (subtitle templates, subtitle export, caption export,
  effect presets, proposal features) 5 / 19 — all passing; typecheck of project, session, api, config, engine, mcp;
  `check-layers`, `check-tokens`; biome on the changed files.

Generation speed (`pnpm exec tsx packages/project/bench/subtitles.ts`, results in
`packages/project/bench/subtitles.results.json`; the whole `captions.generate` / `captions.alignToCuts` transaction
including the cut map, placement, template effects, linked style and invariants; 7 samples, median; bench lock held;
build VM AMD EPYC-Rome 16 vCPU, 31 GB, Node 24.22.1, **load average 22.6 / 20.5 / 17.9 from other agents' jobs**, so
these are upper bounds):

| Case | Subtitles | Generate (median, min–max) | Align after the B-roll moved 7 frames |
|---|---|---|---|
| 10 min 1080p 59.94, 1 500 words, 300 B-roll cutaways (Pixel Pop) | 1 165 (229 snapped, 370 split, 0 crossing) | 689 ms (637–782) | 408 ms (392–502) |
| 60 s 9:16 60 fps, 160 words, 40 cutaways | 116 (18 snapped, 43 split) | 66.5 ms (62–100) | 34.9 ms (32–42) |

Before running the cut map on a plain snapshot of the document (`current(draft)`), its per-track indexes were rebuilt
on every lookup because they are never cached on Immer drafts: 1 955 ms / 4 311 ms for the long case (same machine,
load ≈ 24, CPU profile: 18 s self time in `sequenceIndex` over the run).

**Accuracy harness (AS-061, private, aggregate only)**: generation + cut alignment with the Pixel Pop rules on the
Premiere transcripts of the user's decoded projects mapped onto their main timelines (the research `subs` mapping),
against the projects' cut frames; scripts in `.prproj-analysis/research/subtitles-harness/` (outside the repo).
"Speech cuts" = cuts with a word starting within 0.5 s after them, inside the stretch the user captioned.

| | Shorts (18 projects, 3 096 words, 344 speech cuts) | Long-form (8 projects, 11 793 words, 1 022 speech cuts) |
|---|---|---|
| Subtitle starts exactly on the cut — ours | **98.8 %** (within ±2 frames 99.4 %) | **99.8 %** (99.8 %) |
| — the user's own captions | 59.6 % (79.1 %) | 30.3 % (75.0 %) |
| Subtitles across a cut — ours | 0 across hard cuts; 3 of 1 870 run through montage zones (cuts 1–5 frames apart) | 0 across hard cuts; 1 of 6 811 through a montage zone |
| — the user's own (≥ 3 frames each side) | 82 of 1 845 | 107 of 6 537 |

Target (≥ 95 % of speech cuts get a subtitle start on the cut; 0 subtitles across a cut): met for starts; for
crossings, met for every hard cut — the 4 run-throughs are §3 step 5 montage zones (flash cuts closer than the
minimum duration), allowed by the spec's zone rule. Layout time for all 26 projects: 81 ms.

## 11. Limitations

- Montage zones let a subtitle started before a burst of cuts closer than the minimum duration run through it (spec
  rule); `minSeconds` lower than the shortest shot avoids that.
- Weak-word lists exist for Spanish and English only; other languages break lines greedily.
- Glyph replacement uses the template's `missingGlyphs` (or the whole table); the font's character map is not read.
- The Pixel Pop shadow's blur / spread are assumptions (§6); `spreadPx` draws once the text-rendering work (SH-004)
  lands. Box heights are estimated (0.55 em per character, one line per `\n`) until a text measurer is wired.
- Caption markup (`<i>`, `<b>`) becomes plain text on conversion to text clips; caption clips' Motion scale /
  rotation / keys are reported, not converted.
- Subtitles inside a nested sequence align to the parents' cuts only for constant-speed nest clips.
- Highlight (word / karaoke) uses Source Text keys, so it does not combine with legacy in / out text animations on
  the same clip (the typeset renderer draws keyed text); none of the built-ins combines them.
- Export speed with many animated subtitles is the subtitle-export work (AS-050 / AS-070…076), not changed here.
- **Rendering defect seen (not in this work's code)**: with the template's GPU effects (Transform, S_Shake) the
  outside stroke of a subtitle is clipped to the glyph box — flat stroke edges at the top / left / bottom of the text
  in the e2e export frames and a thin bar next to the text in the Program monitor. The effect layer is rasterised to
  bounds that do not include the stroke (and shadow) overflow; it belongs to the text-rendering / subtitle-export
  work (SH-004, AS-070) and is reported there.
- Cut map: pictures covering less than the overlay threshold (e.g. a 720p clip unscaled in a 1080p sequence) are not
  base pictures, so a cut from such a shot to black gives no cut to align to.

## Subtitle-scale export and preview (spec 13 §4: AS-050, AS-070…AS-076)

Owner: work package `subexport`. Baseline: the private textperf measurements behind spec 13 §4 — one ffmpeg input per
caption (≈ 205–230 MB RSS per animated caption master, ≈ 40 MB per looped still, overlay chain at 17 fps with 1 000
inputs), one Remotion render per caption (≈ 3.4 s fixed cost per still), a 50 s short with 99 animated captions taking
183 s and 19–25 GB, the 9-minute video impossible on the Hybrid path, and one run that killed the engine itself.

### S.1 Lowered layers: still + native motion (AS-070, AS-073)

- `isLoweredLayer(c)` (`packages/project/src/render/lowered.ts`, shared by the export and the preview): a text layer
  whose glyphs stay still (`loweredContentStatic`: no In/Out animation, no time-varying animator, no keyframes or
  expressions in its text) while its picture moves: keyframed Motion / Opacity, the **Transform** effect (any keys,
  with or without its Shutter Angle motion blur; at most one blurred Transform) and **S_Shake** with Motion Blur off,
  Wrap X/Y **No** and no RGB split. `loweredRefusal` names what it refuses: masks, effect masks, expressions, other
  effects, S_Shake wrap / motion blur / RGB split (those layers keep the master bake, exact as before).
- The layer bake renders it once as recipe `layer-still` (`layerStill`, `layerStillClip` in
  `apps/engine/src/layer-bake/layer.ts`): its layer box grown by `contentBleed` + 2 px, Motion a translation into that
  region, Opacity 100 %, no effects, one frame. Its key holds no Motion or effects, so identical words share it. From a
  sheet (S.3) the still is **trimmed to its pixels + 2 transparent px** (`alphaBounds`), its region stored in the
  cache meta (`picture`), so the kernel, the stream and the overlay only touch the glyphs, stroke and shadow. A still
  whose pixels touch its border (text overflowing an estimated box, a wrapped line) is baked again with the region
  grown by a quarter of the box + two font sizes, then, still clipped, as an ordinary master (bake rounds in
  `extension.ts`; nothing is cut silently).
- Per frame, `loweredLayerTaps` gives the taps in layer space and `planLoweredFrames` (`export/stream/lowered.ts`)
  adds Motion⁻¹, the mip level (from the Motion scale, like the sub-pixel kernel) and the drawn rectangle. Every value
  comes from the registered effect's own `gpu.uniforms` hook with the compositions' frame context (layer box,
  pxScale 1, fps, clip-local frame, `fxSeed` seed rules, `fxParamsAtFn` with the box metric): S_Shake's `u_shakeNow`
  (green-channel pose: `src = zDist · R⁻¹ · (f − d)` in frame units of the box width), the Transform's `u_tfA/u_tfT`,
  and with motion blur the shader's plan (`u_mbPlan` taps, `u_mbKeys` key poses interpolated linearly, `u_mbWarp`
  time warp; tap weight `t.y × clamp(opacity / 100)`, normalised by Σ t.y). What the shaders sample becomes coverage
  stages: the effect canvas the browser draws (box + the text's paint + the GPU effects' padding, `gpuPadding`),
  S_Shake's input canvas (Wrap No samples the canvas with an anti-aliased edge) and the Transform's input canvas.
- The multi-tap kernel `drawTaps` (`export/stream/kernel.ts`) sums the taps (bilinear, premultiplied, clamp to edge)
  times the anti-aliased coverage of the still and of each stage; per row it computes coverage only where it is
  partial (row spans); one tap without stages uses `drawLayer` unchanged.
- Differences to the composition (measured in S.6): one resample instead of one per GPU pass plus the browser's
  composite; capped shutters take the stratum centres instead of the shader's per-pixel jitter; stage edges are
  ½ px ramps instead of the shaders' hard canvas test.
- **Text paint under effects (fix of the defect in §11):** a text layer's stroke, shadow and glyph ink reach beyond
  its box. With GPU effects the effect canvas was the box + the effects' padding and the Transform sampled only
  inside the box, so template effects cut the outside stroke and the shadow flat at the box (exports and the Program
  monitor alike). Now the effect canvas of a text layer starts grown by `textContentPad` (`@jasper/project`
  text-style.ts: strokes, shadow offset + spread + 3 σ, glyph ink, background padding — the same extent the layer
  bake crops with, `contentBleed`; whole pixels, since the DOM picture snaps to the pixel grid), and the Transform
  effect moves its whole input canvas (as Premiere moves the layer's whole picture), transparent outside it. The
  lowered taps (Program monitor Canvas 2D path, native kernel) use the same canvas for every stage. Regression
  tests: `subtitle-parity.e2e.test.ts` "template effects keep the stroke and shadow beyond the text box" (an
  identity Transform and a still S_Shake equal the plain text, native and composition: SSIM 1.0000; before the fix
  no paint outside the box), `fx-gl.test.ts` (the lowered Canvas 2D renderer moves the text and outside-box paint at full and reduced resolution, and blurs moving paint).
- Text boxes still marked `layoutPending` (made without a text measurer) bake their layer stills grown up front
  (a quarter of the box + two font sizes), so a pipelined export does not restart for a wrapped line.

- **Run masters (AS-073):** shaken layers the kernel does not draw (S_Shake with Motion Blur, RGB split or Wrap) stay
  masters, but those of one track that follow each other (no overlap, gaps ≤ 60 frames, a run ≤ 3 600 frames,
  normal blend, no fades or handles, no colour grade: `layer-bake/runs.ts`) bake as **one master per run**
  (`planRun`: the clips shifted to the run's start in one transparent document, child job `Bake graphics – N layers
  from "…"`). Every clip of the run points at it (`LayerOverride.run`) and the builder draws it once, one input over
  the run's span; the memory preflight counts a run as one master. The shake keeps the shader's own blur, so these
  frames are the composition's.

### S.2 Kernel streams: memory follows what is on screen (AS-072)

- In the main graph, the constant-picture layers of a track — baked static stills (`sequence` overrides without colour
  runs), lowered layers, still images / solids with sub-pixel Motion — without transition handles, fades, masks or
  blend modes are **members of one stream** (`stream/tap-plan.ts`, `stream/members.ts`, grouping in `native.ts`
  `memberOf`): one raw RGBA pipe and one overlay per track over the members' union rectangle, drawn by `streamTaps`
  (`stream/taps.ts`). Members never overlap in time (one track, no handles), so a frame draws at most one; pictures
  are decoded (one ffmpeg frame per mip level, `PREFETCH_MEMBERS` ahead) and dropped after the member's last frame.
  A member alone, or a lowered layer with fades / handles / a blend mode, is a stream of its own with the transition
  fades applied by ffmpeg as before. `JASPER_EXPORT_TRACK_STREAMS=0` draws one input per layer (the comparison path
  of the tests). The composite's inputs no longer grow with the clip count (300 stills on a track: one input, one
  overlay, test in `subtitle-export.test.ts`).
- At most 8 kernel threads per stream (`MAX_TAP_WORKERS`): a stream is paced by the composite reading it.
- Member stills are decoded in-process (`stream/png.ts`: 8-bit RGBA / RGB PNGs, inflate in the libuv pool, rows
  unfiltered as PNG specifies; equal to ffmpeg's `format=rgba` decode, property test `subtitle-png.test.ts`); scaled
  mip levels and other files keep the one-frame ffmpeg decode. One ffmpeg spawn per picture held the event loop for
  ≈ 9 ms each (a fork of the engine; CPU profile of the short benchmark: 5.2 s in `spawn`), which stalled the stream
  feeding the composite.

- **Composite base:** when the first layer of the sequence is an opaque video covering the whole frame for the whole
  range (no override, Motion an identity at W × H, Opacity 100 %, no fades, masks, blend mode, crop or alpha
  effects), it is the composite's base instead of a blend over the background colour (`coverBase` in `native.ts`;
  frames after its source ends are padded with the background colour, as the blend showed). An ffmpeg experiment on
  the short benchmark's graph (VM, quiet): video + one subtitle input 25.4 s with the background blend, 20.9 s
  without, 20.7 s for the video alone. Frames are identical to the blend path (test `subtitle-export.test.ts`;
  `JASPER_EXPORT_COVER_BASE=0` keeps the blend). Generalised to every span such a video covers, whatever its range
  (cuts, segments): docs/wp-notes/export-performance.md §12.

### S.3 Batched still rendering, pipelined (AS-071, AS-076)

- Every still bake of an export (static layers and layer stills) is rendered in **sheets** (`ensureSheet`, child job
  `Bake graphics – N stills`): up to 128 one-frame clips back to back in one document as large as its largest still,
  rendered by one Remotion `renderFrames` (`renderStillSheet`: transparent PNG frames), decoded by one ffmpeg,
  cropped, border-checked (sequence stills: the edges inside the frame, re-rendered alone with the full-frame fallback
  when touched; layer stills: every edge) and stored per key with the PNG deflate in the libuv pool. Sheets render one
  at a time on 4 pages (2 pages when there are more than two: Chrome's memory, S.6). Cached keys are reused, keys in
  flight joined, one missing still renders alone.
- **Pipelined:** a native export does not wait for the still bakes its kernel streams draw. Missing stills get
  provisional entries (the planned file and region) with a `ready` promise (`LayerOverride.ready`) and are rendered in
  the background in time order — sheets of 16, 32, 64, 128… stills, so each sheet is ready before the composite
  reaches its subtitles — while the composite
  runs (`NativePrepareContext.background`). A stream waits for a member's still before decoding it and re-plans a
  trimmed layer still inside its frame; stills opened as ffmpeg inputs are awaited before the composite starts
  (`NativeGraph.waitFor`). A still that comes out different from its plan (clipped, re-cropped) stops the composite
  (`BakeChangedError`) and the export restarts without the pipeline (the bakes are then cached). The mixdown runs while
  the layers prepare. Stills exports (one frame) and nested sequences do not pipeline.

### S.4 Preflight and robustness (AS-074)

- `estimateComposite` (`export/memory.ts`) models the composite's peak memory from the layers the builder will draw
  (textperf's per-input costs scaled by the sequence's pixels; one kernel stream per track with members) and the
  planner adds a named native blocker when it exceeds `compositeMemoryBudget()` (60 % of the RAM or of the engine's
  cgroup limit; `JASPER_EXPORT_MEMORY_BUDGET_MB`): Auto goes to the Remotion path, a forced Native export is refused
  (`PATH_NOT_ELIGIBLE`) with the estimate ("the native composite needs ≈ 232.4 GB of memory (1080 animated graphics
  masters as separate inputs), more than the 18.0 GB this machine allows").
- A compositor that dies of a SIGKILL the job did not send fails the export with `OUT_OF_MEMORY`
  (`killedComposite`; a pipe error it caused in a stream no longer masks it). On Linux every tool process gets
  `oom_score_adj` 900 (`preferOomKill`, `tools/process.ts`): the OOM killer picks ffmpeg before the engine, which
  textperf saw killed. The engine's own stream memory is bounded (S.2). Regression tests: a compositor killed by
  SIGKILL and one under a 150 MB address-space cap (wrapper ffmpeg) fail the job while the engine keeps serving.
- A kernel stream that fails (its pipe closed by a composite that stopped, a restart, a cancel) rejects with its error;
  the draws still in flight are settled, not left as unhandled rejections — one such rejection ended the engine
  process during a pipelined restart in a benchmark (regression test `subtitle-taps-failure.test.ts`).
- The plan's estimate counts still bakes as sheets (≈ 3.4 s per sheet of ≤ 128 + 0.1 s per still, textperf).

### S.5 Program monitor (AS-075, AS-050)

- The composition already mounts only clips near the playhead (`FrameWindow`, pages of 60 frames, one before and two
  after), so the clip count does not reach the per-frame work: playback of 1 080 subtitles with keyframed Motion only
  measures like video alone (S.6).
- The remaining cost was the GPU chain of lowered layers in the preview: DOM capture → WebGL passes → read back every
  frame (`GLES2::ReadPixels`, `WaitForCmd` in the trace). The preview now draws lowered layers with **Canvas 2D** from
  the same taps the export uses (`fx/lowered.ts`: `loweredCanvasProgram`, `fxLowered`): one `drawImage` per shutter
  tap of the captured picture, clipped to each stage rectangle, summed with `lighter` at weight w / Σw. Renders keep
  the GPU chain (the reference the native export is compared with). Static subtitles stay DOM text.
- Measured (S.6): with 1 200 subtitles over a solid, static and Motion-animated subtitles play like no subtitles
  (58.2–58.9 fps vs 58.5–58.9). Pixel Pop played at 57.6 fps vs 58.0 before the text-paint fix (S.1, effects then
  saw a picture cut at the box); with the stroke and shadow inside the effect canvas it measured 46–48 fps, and
  52.3–53.1 fps (−9.6 % / −10.6 % of 58.5, two runs in opposite orders) once each Canvas 2D tap draws only the part
  of the capture that can hold paint (`FxLoweredParams.src`). The rest is the pop-in's shutter taps (one
  `drawImage` each, software canvas). Over a 1080p H.264 video the headless
  software-GL player itself varies from 7 to 30 fps between runs without subtitles, so that comparison is not
  resolvable on the VM; Pixel Pop measured 7.9–9.5 fps there (3.2 fps before the Canvas 2D path) and the CPU
  profiles with and without subtitles are the same (video `drawImage` ≈ 20 %, nothing from the subtitles in the top
  25).

### S.6 Measurements, verification and limitations

Machine: build VM (16 vCPU, 30 GB, no GPU, software GL), LGPL ffmpeg n7.1.5 (`libopenh264` for H.264). Benchmarks
held the shared bench lock; other agents' load is reported as `loadBefore` in each JSON
(`scripts/perf/subtitles.mjs`, results under `~builder/subexport-results/` on the VM). The engine ran in a systemd
scope (MemoryMax 22 GB, no swap); memory is the peak over the engine process tree, sampled every 250 ms: RSS summed
over processes (counts Chrome's shared pages once per process) and PSS summed (the memory actually used).

Workload (`--case short`: 1080 × 1920, 50 s at 59.94 fps, 99 subtitles of 1–4 words; `--case long9m`: 1920 × 1080,
9 min, 1 080 subtitles; both over an H.264 video, H.264 output with AAC; `pixelpop` = the subtitles agent's Pixel
Pop recipe, Transform pop-in with 360° shutter + S_Shake, stroke and shadow; `none` = the same video without
subtitles). Cold = empty layer cache; warm = the same export again.

Final code (round r15, after the text-render, subtitles, cleanup-UI and overlays merges; `loadBefore` 3–9 from
other agents' work, 15.7 before the last row):

| Run | Wall | vs none | Peak PSS / RSS sum |
| --- | --- | --- | --- |
| short, none | 24.1 s | — | 1.0 / 1.3 GB |
| short, Pixel Pop, cold | 37.0 s | 1.54× (target ≤ 1.3×: **not met**, see below) | 4.5 / 8.0 GB |
| short, Pixel Pop, warm | 28.0 s | +16 % (target ≤ +20 %: met) | 2.1 / 2.8 GB |
| 9 min, none | 224.7 s | — | 1.3 / 1.3 GB |
| 9 min, 1 080 Pixel Pop, cold | 304.7 s | 1.36× (target ≤ 10 min: met) | 4.4 / 7.7 GB (target ≤ 6 GB: met as PSS) |
| 9 min, 1 080 Pixel Pop, warm | 331.8 s | (load 15.7: not comparable) | 2.4 / 2.4 GB |

Round r11 (before those merges, VM otherwise quiet): short none 23.8 s, cold 43.5 s (with the restart below), warm
27.6 s (+16 %); 9 min none 251.1 s, cold 301.8 s (1.20×, PSS 3.9 GB), warm 292.4 s (+16 %). Round r14 (final code
less the doubling sheets, load 2–9): 9 min none 256.9 s, cold 323.1 s, warm 313.8 s (+22 %, load 16 before it).

- Before (textperf, same recipes): short cold 183 s and 19–25 GB; the 9-minute export did not finish. Intermediate
  rounds on this branch: r6 (before pipelining) short cold 39.2 s / warm +20.6 %, 9 min cold 374.9 s, warm +23.5 %;
  r9 (pipelined, before the composite base) 9 min cold 335.6 s, warm +22.2 %; run-to-run spread of the same export
  ≈ 5–8 % (9 min, none: 251.1 / 254.8 / 274.2 s).
- Cold short: before the text measurer, five wrapped subtitles came out clipped and restarted the composite at
  ≈ 13 s (r11). With measured boxes (and grown stills for boxes still `layoutPending`) there is no restart; what
  remains (child-job timings recorded by the bench): the first sheet's latency (≈ 4 s: Remotion composition
  selection ≈ 1.2 s + render), Chrome rendering the later sheets beside the composite, and provisional regions —
  a cold stream is planned from the layer stills' regions (the 1 440 px wide box of an auto-height subtitle + its
  paint) and only learns the trimmed pictures as they arrive, so its frame is about twice the warm one. Doubling
  sheet sizes (16, 32, 45 here) cut it from 42.2 s (r14) to 37.0 s.
- Subtitle parity (`subtitle-parity.e2e.test.ts`, REMOTION_E2E=1, 1080 × 1920, worst region SSIM over the pop-in,
  overshoot and hold, final code): static 0.9997, motion pop 0.9873, Pixel Pop 0.9996, Pixel Pop classic 0.9994,
  shake 0.9997, shake with motion blur (run master) 0.9995 — all ≥ 0.98 (FX-040); the side-by-side images were
  inspected. Text paint under template effects: identity Transform and still S_Shake equal the plain subtitle
  (SSIM 1.0000) natively and in the composition.
- Preview (`scripts/perf/subtitles-preview.mjs`, built app on the VM, headless Chrome with software GL): S.5; the
  pop-in, overshoot and hold of a Pixel Pop subtitle in the Program monitor were inspected in screenshots (`--shots`).

Verification on the VM (final code): engine suite (`vitest run --maxWorkers=2`: 1 418 passed; two environment failures that
also fail on the base branch — Electron without libgtk, the ZIP-1 peak-buffer bound under load), compositions and
project suites, engine / compositions / project typecheck, `check-layers`, `check-tokens`, `check-anime`, Biome on
the changed files, the Transform / motion-blur GL suites, and with REMOTION_E2E=1 `layer-bake.e2e`,
`layer-bake-parallel.e2e`, `text-paint-export.e2e`, `compositor-export.e2e` and `subtitle-parity.e2e`.
New tests: `subtitle-lowered.test.ts` (kernel vs reference, maps vs shader formulas, refusals, memory estimate, run
grouping), `subtitle-export.test.ts` (kernel streams, run masters, composite base, preflight, killed and failing
compositors), `subtitle-taps-failure.test.ts` and `subtitle-png.test.ts` (regressions and in-process decode),
`packages/compositions/test/fx-gl.test.ts` (lowered preview pixels).

Limitations:
- Cold short exports are 1.54× (target 1.3×), above.
- Program monitor: Pixel Pop with an outside stroke and a shadow plays ≈ 10 % below no subtitles over a solid on the
  VM's software canvas (S.5), at the AS-075 limit.
- The Program-monitor criterion over video (AS-075, within 10 % of video-only fps) cannot be resolved on the VM's
  software-GL player (spread larger than the criterion); it holds over a solid.
- Lowered layers differ from the composition by one resample (S.1): capped shutters use stratum centres, stage edges
  are ½ px ramps; motion pop is the lowest SSIM (0.9873).
- Run masters cover shaken layers on one track whose clips follow within 60 frames; graded, faded or blended shaken
  layers stay one master each. Nested sequences do not pipeline their stills.
