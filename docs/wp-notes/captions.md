# wp captions: captions, transcripts and text-based editing

Workstream `captions` of the parity program. Caption tracks and caption clips (preview, burn-in on every export path,
embedded streams, sidecars), caption editing, seven caption file formats, the transcript model and text-based editing,
MCP tools, the Text panel. Ported from FilmCraft (record: `licenses/ported/captions.md`).

## 1. Model

### Caption tracks

`seq.captionTracks` (S01:TRK-001) — drawn above every video track, `C1` lowest. Additive optional fields (no schema
bump, read-time defaults):

| Field | Meaning |
|---|---|
| `visible` (existing) | The eye: shown in the Program monitor and burned in on export. |
| `styleDefaults` (existing, `CaptionStyle`) | The track style ("Track Style" in Premiere). Created with `defaultCaptionStyle` (font size relative to 1080 lines). |
| `language` | BCP-47 (`en`, `fr-CA`); written to embedded streams (ISO 639-2) and TTML `xml:lang`. |
| `captionStandard` | `subtitle` (default) / `cea-608` / `cea-708` / `teletext` (Premiere's caption track "Format"; set from the imported format). |
| `vttBlocks` | WebVTT STYLE / REGION / NOTE blocks of an imported file, written back by VTT export. |

`Sequence.activeCaptionTrackId` (optional, null = C1): the track new captions go to, the Captions tab edits, exports
embed first (flagged default) and sidecars use by default. `ProjectSettings.captionStylePresets` (optional): saved
track styles.

`CaptionStyle` gains optional `placement` (`bottom` / `middle` / `top`, inside title-safe), `marginPct` (0–45 % of the
frame height from the title-safe edge), `linePct` / `positionPct` (WebVTT `line:N%` / `position:N%`, per caption).

### Caption clips own their words

A `captions` clip on a caption track is one caption block (what Premiere and FilmCraft call a caption segment). Its
`transcriptId` references a transcript **the clip owns** (`mediaId: null`; S04:TR-052 "caption clips hold their own
copy of the words in clip-relative time"). Words are in clip content time starting at `CAPTION_CONTENT_ORIGIN` (1 h of
flicks), so the head of a caption can be extended (generators cannot go below content 0, S01:CLP-005).

- The clip shows every word of its transcript: text = words joined (S01:AST-032), `breakBefore: 'line'` forces a line
  break, `'segment'` starts a new page. A single-page caption shows for the whole clip; in a multi-page caption each page
  starts at its first word (the first page at the clip start) and lasts until the next page or its last word + 0.5 s
  (≥ 0.7 s), the last page until the clip end (S04:TR-053). `captionPages` is the one function preview, burn-in,
  sidecar and embedded export use (S01:KND-008 "all three agree").
- Word times drive the active-word highlight (`highlight.mode` `word` / `karaoke`) and splits.
- `clip.style` holds per-caption overrides of the track style; `clip.cue` keeps an imported WebVTT cue id and settings.
- A caption clip that references a media transcript (`mediaId` set) shows the words whose midpoint is in its content
  range (S01 semantics); no command creates such clips any more — `clip.addCaptions` copies the words.

**Ownership pass** (`normalizeCaptionData`, run once per transaction before orphan collection, and by `repairDocument`):
when an edit leaves several clips on one caption transcript (clip.split, Add Edit, an insert across a caption on a
sync-locked track, clip.duplicate, paste, sequence.duplicate), each gets a copy with the words whose midpoint lies in
its content range (a split divides the text where it is spoken); a side with no word gets all of them (FilmCraft:
both halves keep the text). Two abutting pieces with discontinuous content (a ripple cut **through** a caption:
extract, Remove Fillers / Pauses, ripple trim of the media) are joined back into one shortened caption, as Premiere
does. Unreferenced caption transcripts are collected (INV-014).

### Transcripts (media)

`TranscriptSchema` is unchanged (the `speech` workstream writes it). A media transcript holds words in media time. The
**sequence transcript** (`sequenceWords`) is derived, never stored: audio tracks top first; a word is heard through
the first enabled, non-reversed audio clip whose range covers its midpoint (mapped through speed); cut words are
clamped; duplicated dialogue on lower tracks reads once. It therefore follows every edit.

**Words cut off at an In** (`heardFromCutStart`, `CUT_START_MIN_SHARE` = 0.2): a word whose midpoint lies before a
clip's In also belongs to that clip when no clip of the track plays its cut-off part and the clip plays at least a
fifth of it. Speech to text starts the first word after a pause early (it takes in the breath or silence before it), so
the In a restart cut puts at the kept take's voice onset often lands past that word's midpoint, and the kept take lost
its first word in the subtitles (the reporter's cut, rev 144: "Y si alguno de ellos…" read "si alguno…", "Pero",
"El", "No", "Lo reescribieron"…). Measured on that cut (rev 144's transcript over rev 144's and rev 267's clips, 33
straddling first words): every word the clip plays ≥ 20 % of was the kept take's own; the removed takes' words that
reach into a kept clip do so by ≤ 10 % ("funciona," 6 %, "%" 10 %) and stay out. Words cut at a clip's Out keep the
midpoint rule: there the straddling word is the next take's early-started first word ("El", "al", "60", 25–34 % inside).
The 20 % is an assumption beyond that recording. Test: `packages/project/test/sequence-transcript.test.ts` "a kept
take's first word cut off at the In…" (fails before: the take read "si alguno no").

**Zero-length leftovers and tail fragments** (`MIN_HEARD_WORD_SECONDS` = 0.02, `tailFragmentIndex`): a word shorter than
20 ms (a leftover of an edit: "En" 7 ms at 2038.46, "Resulta" 0 ms at the end of a clip) is heard through no clip. A
clip's last word is not heard through that clip when it is short (< 0.25 s played), ends within 0.15 s of the Out, comes
within 0.12 s after a word of the same clip that ends a sentence (. ! ?, not an ellipsis; speech to text squeezed it
against the sentence end — a sentence really started there has a pause before it, so "…me. I uh love" with the filler
cut keeps "I"), does not end a sentence itself
unless it is under 0.1 s ("y." 60 ms), and the next clip on the track starts where this one ends and speaks. That word is
a fragment of another take, a breath written as a word, or the squeezed start of the phrase the next clip says (the
reporter's v8: "…Appstore! | Y si alguno…" showed "Y", 0.2 s at the end of the Appstore clip, in the previous scene); the
next clip shows its own copy when it has one (a "Y" cut off at its In follows it by the rule above), else the word
reaches no caption. A clip that is only that word (a sliver) keeps it. Measured: on rev 144's transcript and cut 30 such
words leave the previous scene ("sombra. | Y", "MEJOR. | Entonces", "tan fácil. | Unity" — 30–180 ms sentence starts
squeezed into the tail) and 17 zero-length leftovers go; on rev 267's rebuilt transcript only the reported "Y". These
words are also left out of text-based editing (they are what the sequence transcript lists). The thresholds are
assumptions beyond that recording. Test: "a short word stranded at a clip's tail after a sentence end, and zero-length
leftovers, reach no caption" (fails before: "Appstore! Y Y si", "En", "y.").

`transcript.replaceWords`' subtitle patch skips (`edited`) a subtitle whose words would overlap after the splice — a
subtitle made when a word the sequence no longer hears still reached the captions: the whole accept of a Rebuild from
script proposal over rev 144 was refused with `INV-SUBTITLE` ("y su propio", zero-length "propio"). Test:
`script-fix-apply.test.ts` "a subtitle holding a word the sequence no longer hears is skipped…" (fails before).

### Invariants and repair

INV-012 transcript words sorted / non-overlapping / integer flicks; INV-014 a caption transcript is used by one clip;
INV-006 caption fonts, track-style fonts and the active caption track exist. `repairDocument` sorts words, resets a
missing active track to C1, drops missing caption fonts and runs the ownership pass.

## 2. Commands (all undoable, in `describe_commands`)

| Command | What it does |
|---|---|
| `caption.addTrack` | New caption track (name, language, standard, index, active, style). |
| `caption.setActiveTrack` | Active caption track. |
| `caption.add` | Caption at a time (default 3 s, cut short at the next caption; refused where a caption already is). |
| `caption.import` | A caption file (`content`, `contentBase64` for STL, or parsed `cues`; format detected) onto a new or existing track, snapped to frames, overlaps cut; `offset`, `replace`, `language`. |
| `caption.setText` | Text (lines `\n`, page break = blank line) and/or speaker; unchanged words keep their timing (LCS re-timing, S03:CAP-022). |
| `caption.split` / `caption.merge` | Split under a time (words go to the side they are spoken in) / merge consecutive captions (texts joined by a line break). |
| `caption.delete` | Delete; `ripple` closes the gaps on the caption track only (FilmCraft / Premiere caption ripple). |
| `caption.setTimes` | In / out (Text panel timecode fields), limited by neighbours. |
| `caption.setStyle` / `caption.applyPreset` / `caption.savePreset` / `caption.deletePreset` | Track style or per-caption overrides; built-in presets `builtin:default` `broadcast` `outline` `yellow` `social` `minimal` (sizes scaled from 1080 lines); saved presets in project settings. |
| `clip.addCaptions` (was `E_NOT_IMPLEMENTED`) | Captions for a transcript: aligned to a clip (`alignToClipId`, through its speed; reversed clips refused), or the media's words as heard in the sequence; `range`; `rules`; one clip per caption block (default) or one paged clip (`split: false`). |
| `transcript.create` / `editText` / `setBreak` (were `E_NOT_IMPLEMENTED`) | Create (words normalised: leading-space tokens folded, sorted, overlaps cut; speakers), replace a word range (new words share the range's timing by character count), caption break before a word. |
| `transcript.import` | JSON (ours in flicks, FilmCraft ticks, `@remotion/captions` `Caption[]`, Whisper `segments[].words[]`, whisper.cpp `transcription[].tokens[]`, `{text,start,end}` seconds) or any caption file (cues split into words timed by character count, each cue starting a segment), for a media or the media of a clip (`timeBase: 'sequence'` maps file times through the clip). |
| `transcript.delete`, `renameSpeaker`, `setSpeaker` | Delete unused transcripts; rename a speaker (key or name) in one or every transcript; set the speaker of a word range. |
| `transcript.select` / `extract` / `lift` | Sequence word range → In/Out snapped outward / ripple-delete / lift on every unlocked track. |
| `transcript.insertInto` | Copies the picture and sound under a word range into another sequence (insert or overwrite). |
| `transcript.removeFillers` | Ripple-deletes filler words and phrases, longest phrase first ("you know" before "you"); `filler_ranges` snap to the nearest frames and never reach into the neighbouring words' frames; one undo step. |
| `transcript.removePauses` | Ripple-deletes pauses ≥ `minSeconds` keeping `keepSeconds` of air next to each word (snapped inward). |
| `transcript.createCaptions` | FilmCraft `caption_blocks` on a new track (42 chars × 2 lines, 1–7 s, new caption at a 1 s pause, a speaker change, the maximum duration, or sentence punctuation once half full; frame-snapped, never overlapping; short captions extend into the following silence, never over the next caption). |

Clip-level caption edits are the ordinary clip commands: `clip.move`, `clip.trim` (regular / ripple / roll),
`clip.extract` (sync-locked ripple delete), `clip.split`, `range.lift/extract` — caption tracks take part in sync lock
(S01:TRK-006): an insert splits a caption across the insert point and moves the right part, an extract shortens it.

## 3. Formats (`packages/project/src/captions/formats`)

| Format | Read | Write |
|---|---|---|
| SubRip `.srt` | BOM, UTF-16, Windows-1252, CRLF/CR, missing or wrong indexes, `,`/`.` ms, 1–9 fraction digits, missing hours, SSA coordinates, cues without blank lines | renumbered, ms |
| WebVTT `.vtt` | cue ids, settings (`line:N%`, `position:N%`, `align:` become per-caption placement), `<v Speaker>`, STYLE/REGION/NOTE kept, missing signature tolerated | same, settings merged with the caption's overrides |
| Scenarist SCC `.scc` | CEA-608 channel 1: pop-on, roll-up (RU2–4, CR, moving base row), paint-on, BS/DER/EDM/ENM, special + extended sets, redundant control codes | pop-on, drop-frame (default) or not, loads scheduled before the caption so EOC lands on its first frame, 32 columns, centred |
| MacCaption MCC `.mcc` | SMPTE ST 334-2 CDPs with abbreviations; CEA-608 field 1, else CEA-708 service 1 (windows, define/clear/display/hide/toggle/delete); 30DF/30/60DF/60/25/24/50 | 29.97 with 608 + 708 (two-window pop-on), or either alone |
| EBU STL `.stl` | GSI + TTI, STL25.01 / STL30.01, ISO/IEC 6937, `<i>`/`<u>` codes, extension blocks, TCP subtracted, comment / user-data blocks skipped | same |
| TTML / IMSC1 `.ttml` | any TTML (2006 ttaf1, TTML1, TTML2): clock / frame / offset / tick times, `dur`, nested time containers, timed spans, referenced styles, `ttm:agent`, `xml:id` | IMSC1 Text profile, exact frame times at the sequence rate |
| DFXP `.dfxp` | as TTML | TTML1 DFXP presentation profile, ms clock times |

`parseCaptionFile` never throws (a typed `{ok:false, error}`); TTML uses a small bounded XML reader (no DOM in the
pure model). Readers snap cue times to the sequence frames on import (`snapCaptionDocument`).

## 4. Rendering and export

- **Snapshot** (`buildRenderSnapshot`): visible caption tracks are appended after the video tracks (`caption: true`)
  with a `{captions: {style, pages, standard}}` source (pages clip-relative, so moving a caption keeps bake caches).
  `SnapshotOptions.captions` = `'visible'` (default) / `'none'` / track list. Nested sequences never burn in their own
  captions.
- **Preview / Remotion**: `CaptionsLayer` (packages/compositions) draws the page under the frame inside the frame-sized
  layer box (Motion and Opacity apply): font / weight / italic / size / line height / tracking / caps, fill, outline
  (first stroke), shadow, per-line background box with padding, radius and opacity, alignment, placement in title-safe
  (10 % margins, Premiere's default safe margins) with margin, VTT line / position overrides, `<i>` `<b>` `<u>`,
  active-word / karaoke highlight; CEA-608 tracks without a style font use a monospace face.
- **Native / hybrid**: caption layers are DOM layers for the layer-bake extension (`DOM_KINDS`): a single-page caption
  without highlight bakes one still, others a straight-alpha master, overlaid natively above every video track — the
  native path stays native (`hybrid`), only the caption pixels come from the shared composition. Without Remotion the
  planner refuses with the layer-bake blocker (never dropped silently). `FONT_FALLBACK` covers caption fonts.
- **Export settings** `captions: {burnIn, embed, sidecar[], sidecarTracks, dropFrame}` (packages/api). Embedded
  streams: after the render a stream-copy remux adds one subtitle stream per caption track with cues (active first,
  default disposition): `mov_text` in MP4/MOV, WebVTT in WebM; ISO 639-2 language and title (+ `handler_name` in MP4).
  Sidecars are written to `renders/<job>/captions/` and served at `/renders/:jobId/captions/:name`; with a path
  destination they are copied next to the file. All cues are in output time of the export range.
- Export dialog: Captions section (Burn In, Embed, Sidecar format + tracks), remembered per sequence; the Jobs panel
  offers sidecar downloads. MCP `start_export {captions}`.

## 5. UI

- **Timeline**: a caption area above the video tracks (one lane per caption track, `C1` lowest; up to 4 visible,
  scrolls). Headers: lock, `Cn` badge (click = active track), sync lock, eye, name · language; context menu (active,
  rename, language, add, delete). Blocks show their text; click selects (Shift adds), drag moves, edge drag trims —
  live through a session gesture, one undo step; double-click opens Text ▸ Captions; context menu (Edit Text, Split
  at Playhead, Merge, Clear, Ripple Delete). Automation ids `timeline.caption.<id>`, `timeline.captionTrack.C<n>`,
  `timeline-caption-area`.
- **Text panel** (Window ▸ Text; also in the Editing workspace and the new **Captions** workspace):
  - *Captions*: track picker, New Track, language, Add (at playhead) / Split / Merge / Delete / Import… / Export
    (format); search + Replace All; track style strip (preset, Save Style…, size, text colour, box + colour, outline,
    alignment, position, highlight); the caption list with go-to, editable in/out timecodes and text (blur or
    Ctrl+Enter commits, Esc reverts), speaker, current caption highlighted. Ids `text.tab.Captions`,
    `text.captions.add|split|merge|delete|import|export|search|replace|replaceAll|newTrack|language`,
    `text.captions.<id>.row|goto|in|out|text`, `text.captions.style.*`.
  - *Transcript*: paragraphs per speaker (rename by clicking the label, filter by speaker), word under the playhead
    underlined, low-confidence words (< 0.6, S03:CAP-021) wavy-underlined, click a word to seek, drag / Shift-click to
    select, search with match navigation, Mark In/Out, Extract, Lift, Correct…, Insert into another sequence; word menu
    (Correct Word, Speaker…, caption Line / Page / No break before); tools Remove Fillers (editable list kept in local
    storage, live count), Remove Pauses (threshold, keep), Create Captions (rules, live count, selection-scoped when
    words are selected), Import (JSON or caption file for a media of the sequence). Ids `text.tab.Transcript`,
    `text.transcript.*`.
- **Commands / keymap** (Premiere defaults): Add New Caption Track `Ctrl+Alt+A` (mac `Opt+Cmd+A`), Add Caption at
  Playhead `Ctrl+Alt+C` (`Opt+Cmd+C`), Go to Next / Previous Caption Segment `Ctrl+Alt+↓ / ↑` — these ids were declared
  in the keymap and are now registered; plus `captions.split|merge|showAll|hideAll|import|export|openPanel`,
  `transcript.openPanel|import|createCaptions|removeFillers|removePauses`. Menus: Sequence ▸ Captions ▸ …, File ▸
  Import Captions…, File ▸ Export ▸ Captions ▸ (format).
- **Import**: caption files in File ▸ Import / drops go onto a new caption track of the open sequence (FilmCraft);
  desktop paths are read through `POST /api/captions/read` (local engines, caption extensions, ≤ 64 MB).

## 6. MCP (`apps/mcp/src/tools/captions.ts`)

`import_captions` `export_captions` `list_captions` `add_caption` `edit_caption` `split_captions` `merge_captions`
`delete_captions` `style_captions` `caption_track` · `import_transcript` `transcript_inspect` `transcript_search`
`transcript_select` `transcript_extract` `transcript_lift` `insert_transcript_selection` `remove_fillers`
`remove_pauses` `rename_speaker` `captions_from_transcript` — guide text `CAPTIONS_GUIDE` in the server instructions,
README tool list updated. Text-based tools take word indices or a `query` + `occurrence`; fillers / pauses have a
`dryRun`.

Stretched words (fix "hidden retakes"): `captions.generate`, `captions.regenerate` (`W_SUBTITLES`) and
`transcript.createCaptions` (`W_STRETCHED_WORDS`) warn when the words they time cues from hold a word longer than 1 s
inside speech — a neighbour within 1.5 s on at least one side; a word with none on either side (said alone between
pauses) is not flagged (`stretchedWords`, `captions/words.ts`). The first rule (every neighbour within 0.3 s) missed
most of them: Whisper usually leaves a gap on one side of the stretched word — the reporter's large-v3-turbo runs
missed "tener" 2.11 s (0.51 s after "quise"), "pones" 6.27 s (1.6 s after "los"), "miles" 3.89 s (0.59 s), "millones"
2.58 s, "propio" 2.38 s (2.26 s after "su"), "personas" 2.11 s and "y" 3.27 s, each touching its next word; the
engine's voice-based check found them all. The command handlers have no voice analysis, so the rule uses word gaps
only (assumption: a > 1 s word next to another word lies over speech after word-bound refinement). Naming
up to 8 sequence times and suggesting `transcribe {chunking: "vad"}`, then rebuilding the captions (the hidden-take
re-decode is on by default, so stretched words left in a new transcript are ones it could not split). Speech to text writes a phrase said twice once and stretches its words over both takes, so cues from them
run ahead of the audio (wp-notes/speech.md §11.3 "Hidden takes"). The 1 s threshold follows the report (normal words
0.2–0.4 s; stretched ones 1.46–6.3 s), the 1.5 s gap the missed words above, not a measurement here. The warning reaches MCP results
(`captions_from_transcript`, `regenerate_captions`) as transaction warnings. Test: `subtitles-commands.test.ts`
"stretched words" (the second case, "tener" after a gap, fails with the first rule).

## 7. Verified behaviour

- `packages/project/test/caption-formats.test.ts` (46): every FilmCraft format unit test; property round trips
  (fast-check, 64 runs each) SRT, SRT+BOM+CRLF, WebVTT with ids/speakers/settings/blocks, SCC drop/non-drop and
  back-to-back, MCC 608 and 708-only, STL 25/29.97, TTML at 23.976/25/29.97/59.94, DFXP after snapping; corruption:
  random bytes (300 runs × 7 readers), a valid STL header + random blocks, random MCC lines, byte-mutated and
  truncated valid files of every format (400 runs) — no throw; SRT → VTT → SCC keeps text and frames.
- `packages/project/test/sequence-transcript.test.ts` (15): FilmCraft's transcript tests on its interview fixture
  (mapping through clips, cut words, speed, duplicate tracks, repeats, search, word at, paragraphs, outward word ranges,
  pauses, fillers longest-first, filler ranges never in neighbours, caption blocks rules / dense words / extension into
  silence / max duration).
- `packages/project/test/captions-commands.test.ts` (35): every command end to end incl. FilmCraft's caption-edit
  tests, sync lock follow (insert split, extract shortens), text-based extract / lift / insert into / fillers / pauses
  on the interview fixture, imports (SRT, VTT settings, SCC, STL, JSON variants, sequence time base), ownership and
  repair, and a fast-check fuzz of random caption edits (150 runs) — invariants always hold, no `E_INTERNAL`.
- `packages/compositions/test/captions.test.tsx`: caption tracks drawn above video, pages, markup, hidden tracks,
  karaoke highlight, title-safe placement and VTT overrides.
- `apps/engine/test/captions-export.test.ts` (oracle = ffmpeg): plan `hybrid` with burn-in, `native` without, unknown
  tracks refused; MP4 export with two `mov_text` streams (eng/fra, default disposition on the active track) whose
  cues, read back by ffmpeg, are frame-exact; range exports in output time; WebM with a WebVTT stream; SRT/VTT/SCC
  sidecars served (SCC re-read).
- `apps/mcp/test/captions.test.ts`: all 21 tools through the protocol (files on disk, no overwrite, errors as tool
  errors).
- `e2e/captions.spec.ts` (Playwright, built app): File ▸ Import of an SRT, caption lane, Text ▸ Captions edit /
  replace / Ctrl+Alt+C / style, Program monitor draws the caption, Text ▸ Transcript import / click-to-seek / search /
  Mark In/Out / Remove Fillers / Create Captions, and an export with burn-in (luma of the caption band, frame checked
  by eye: `test-results/e2e-captions/burned.png`), two embedded `mov_text` streams (ffprobe) and an SRT sidecar
  downloaded from the Jobs panel; a Remotion-path export burns in the same pixels (`burned-remotion.png`).

## 8. Compared with FilmCraft (reference) — equal or better

| Area | FilmCraft | JasperEditor |
|---|---|---|
| Formats | SRT, VTT, SCC, MCC, STL, TTML, DFXP | same, same readers/writers and tests; plus corruption fuzzing of every reader |
| Caption model | caption list per track | caption clips: every clip edit, sync lock, undo, clipboard, agents work on captions; word timing kept for karaoke highlight and splitting where words are spoken |
| Split | duplicates the text on both halves | partitions the words at the split time (duplicates only when no word boundary lies between) |
| Burn-in | own rasteriser, italic/bold not drawn differently | the composition: fonts of the project, `<i>`/`<b>`/`<u>`, outline, shadow, per-line box with padding/radius/opacity, title-safe placement, active-word / karaoke highlight; same pixels in preview, Remotion and native (baked) |
| Export | burn-in only | burn-in + embedded `mov_text` / WebVTT streams + sidecars in 7 formats, in output time |
| Multiple tracks | yes | yes, with languages, active track, per-track show/hide, embedded as separate language streams |
| Styles | track style | track style + per-caption overrides + built-in and saved presets |
| Transcript | sequence transcript, search, select/extract/lift, fillers, pauses, captions | same algorithms (ported with tests) + insert into another sequence, speaker filter/rename/set, word correction and caption breaks, import from JSON or caption files, dry-run previews |
| Speech recognition | Whisper (candle) | not in this workstream (the `speech` workstream writes `TranscriptSchema`) |

## 9. Adobe fidelity (research, not measurement)

Sources: Adobe community / training material for the Premiere caption shortcuts — Add New Caption Track `Opt+Cmd+A /
Ctrl+Alt+A`, Add Caption Segment at Playhead `Opt+Cmd+C / Ctrl+Alt+C`, Go to Next / Previous Caption Segment
`Ctrl+Alt+↓ / ↑` (community.adobe.com "Discuss new captions workflow in Premiere Pro";
community.adobe.com "caption keyboard shortcuts for split and merge do not work"; gotranscript.com "Mastering Captions
in Premiere Pro CC 2021"); Create Captions dialog fields (style, maximum length in characters 42, minimum duration,
gap between captions, lines — community.adobe.com "Create Captions minimum duration in seconds…"); Track Style
(harvardwiki caption guide); Premiere's default safe margins (title safe 20 %, i.e. 10 % per side). helpx.adobe.com
refused automated fetching (HTTP 403), so the shortcut list was taken from the community sources above.

Decisions where Adobe is undocumented or the brief asks otherwise:
- Create Captions minimum duration: **1 s** (the brief and FilmCraft); Premiere's dialog reportedly defaults to 3 s.
- Split / Merge caption have no default shortcut in Premiere; JasperEditor exposes them in Sequence ▸ Captions, the
  Text panel and the caption context menu without a key.
- Default style: white, weight 600, 48 px at 1080 lines (scaled with the frame), black box at 60 % opacity, bottom of
  title-safe — a readable broadcast-like default; Premiere's default caption look is not documented.
- Caption ripple delete affects the caption track only (Premiere / FilmCraft); a sequence-wide sync-locked ripple is
  Delete ▸ Ripple Delete on the clips (`clip.extract`).
- Caption files dropped on the project import onto a caption track (FilmCraft) rather than becoming a project item.

## 10. Limits

- Caption tracks keep their pixels in the composition; the native builder has no ffmpeg `subtitles`/ASS path (libass
  is not in the LGPL build); burn-in therefore needs the layer-bake (Remotion) renderer, and the planner refuses with a
  named blocker when it is unavailable.
- CEA-608/708 styling (colours, italics per row, roll-up on screen) is decoded into text; the burned-in look of a
  `cea-608` track is the track style with a monospace face, not a pixel-exact 608 decoder rendering.
- Embedded streams are text (`mov_text` / WebVTT); CEA-608 inside H.264 SEI is not written (MCC/SCC sidecars carry
  608/708).
- Remotion `direct` exports (VP9 WebM) are remuxed after the render like the other paths.
