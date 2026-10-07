# interchange — timeline import/export and Link Media

Workstream `interchange` of the parity program: Final Cut Pro 7 XML, FCPXML, OpenTimelineIO, CMX 3600 EDL, AAF,
OMF and Avid ALE, import and export, in process (TypeScript), with pre-renders of what a format cannot carry, AAF/OMF
audio essence, a report after every import and export, and Link Media (S04:AS-011). Ported code:
`licenses/ported/interchange.md` (FilmCraft and EffectCraft, MIT OR Apache-2.0).

## 1. Design

### 1.1 Layers

| Layer | Where | What |
|---|---|---|
| Formats | `packages/interchange` (`@jasper/interchange`, pure: no DOM, no Node, no fs) | readers/writers over a format-neutral model (`model.ts`, "IR"), `readDocument` / `writeDocument`, sniffing (`formats.ts`) |
| JasperEditor bridge | `packages/interchange/src/jasper-{import,export}.ts`, `prerender.ts` | document → IR (`fromJasper`, with pre-rendered clips substituted, everything the format cannot carry reported), IR → fragment (`toJasper`), the pre-render plan |
| Command | `packages/project` `project.importTimeline {fragment, binId?, binName?}` | one undoable transaction: a bin named after the document, its items, media (deduplicated against the project), sequences, captions; reuses Paste's `insertProjectItems` |
| Engine | `apps/engine/src/interchange/service.ts`, `routes/interchange.ts` | file I/O, media registration, embedded audio, export jobs (pre-renders, audio essence), relink and folder search |
| UI | `apps/web/src/interchange/*`, `commands/interchange.ts` | File ▸ Import routing, File ▸ Export ▸ *format*… dialogs, report dialog, Link Media dialog, Project panel entry |
| Agents | `apps/mcp/src/tools/interchange.ts` | `import_timeline`, `export_timeline`, `list_offline_media`, `link_media` |

The IR is close to an NLE timeline: sequences of video/audio tracks, clips with flicks times (`start`, `duration`,
`sourceIn` = lowest content time used, `speed`, `reverse`, `hold`), sources (media, nested sequence, or "none" with
what it was), Motion/Opacity/blend, levels/pan with keyframes, effects (JasperEditor effect instances), links,
groups, markers, transitions with their sides, captions, multi-camera sources and selections, generators, bins,
and a `jasper` field on every entity that OTIO carries verbatim in `metadata.jasper`.

### 1.2 Time

All times are flicks (705 600 000 per second): every rate in the brief (23.976, 24, 25, 29.97 DF/NDF, 30, 50,
59.94 DF/NDF, 60) has an integral number of flicks per frame, and 48 kHz has 14 700 per sample. Premiere ticks
(254 016 000 000/s) are exactly 360 flicks, so `pproTicksIn/Out` are read and written exactly (BigInt above 2^53).
FCPXML rational seconds map exactly (`rationalSecondsToFlicks`); OTIO `RationalTime` is written at the sequence
rate and snapped back to its rational form; drop-frame timecode is computed per SMPTE 12M (`formatTc`/`parseTc`).
AAF/OMF sound slots use the sample rate as edit rate, so audio edits are sample-exact; at 29.97 and 59.94 a frame is
not a whole number of 48 kHz samples, so those clip edges round to the nearest sample (≤ 10.4 µs).

### 1.3 What each format carries

| | FCP7 XML | FCPXML | OTIO | EDL | AAF | OMF | ALE |
|---|---|---|---|---|---|---|---|
| Video tracks, clips, gaps | yes | V1 spine + connected lanes | yes | one track per list (per-track lists) | yes | — (audio only) | clip log |
| Audio tracks | yes (channels) | lanes / A+V clips | yes | A, A2…A4 | yes, mono breakout | yes, mono breakout | tracks column |
| Speed / reverse / freeze | Time Remap | timeMap | LinearTimeWarp / FreezeFrame | M2 | pre-render | — | — |
| Motion / Opacity / crop + keyframes | Basic Motion (uniform scale), Opacity, Crop | adjust-transform (non-uniform), adjust-blend, adjust-crop | metadata | pre-render | pre-render | — | — |
| Blend modes | `compositemode` subset | `adjust-blend` modes | metadata | pre-render | pre-render | — | — |
| Levels / pan + keyframes | Audio Levels, Pan | adjust-volume, adjust-panner | metadata | — | MonoAudioGain (Constant/VaryingValue) | MonoAudioGain (CVAL/VVAL) | — |
| Transitions | yes (names, alignment) | V1 only | yes | dissolve, wipe, key | dissolve, fade, wipe; audio crossfades | audio crossfades | — |
| Nested sequences | inline / by id | compound clips | Stacks | pre-render | — (reported) | — | — |
| Multi-camera clips | `<multiclip>` (§2.4) | `multicam` / `mc-clip` | metadata + view | the angle's clips | the angle's clips | the angle's clips | the angle's media |
| Generators (solids, bars, black…) | generatoritem | pre-render | GeneratorReference + metadata | pre-render | — | — | — |
| Markers | sequence and clip | sequence / clip / chapter | Marker.2 | LOC | CommentMarker | — (reported) | — |
| Captions | reported | `caption` (iTT roles) | metadata | reported | reported | reported | — |
| Bins | yes (`bin`/master clips) | event | metadata | — | — | — | — |
| Effects | by JasperEditor id (others ignore) | `filter-video` by id | metadata | pre-render | pre-render | — | — |

"Pre-render" means: with `prerender: unsupported` (the default except OTIO/OMF/ALE) the engine renders the clip to
ProRes 4444 with alpha and references the movie; with `none` the loss is reported. Masks, expressions, text, shapes,
motion graphics, compositions, adjustment layers and tracking always count as unsupported outside OTIO.

### 1.4 Reports

Every import and export returns a `Report`: entries with a level (`warning` = not carried, `info` = a note), the
subject (clip / effect / track / sequence / media, with id, name and frame), a count (identical entries merge) and
`instead` — what was written in its place ("a filler", "Cross Dissolve", "the clip without the track effects",
"nothing (export the captions as a sidecar file)"…). The UI shows warnings first with their *Instead*, notes folded;
MCP tools return `report.notCarried` and the number of notes.

### 1.5 Pre-renders (EffectCraft's design)

`planPrerender(doc, sequenceId, format, mode)` lists the clips, with the reason (`text clip`, `effects`,
`blend mode multiply`, `Motion`, `masks`, `expressions`, `speed change`, `nested sequence`…), walking into nested
sequences the format keeps. The export job renders each one alone — its sequence with only that clip, range = the
clip — through the normal export pipeline with `video.alpha` (ProRes 4444, straight alpha, Remotion path), so frame 0
is the clip's first frame. `fromJasper` replaces the clip by a full-frame media clip of the movie (default Motion), in
a "Pre-rendered" bin; a failed render is reported and the clip is exported as the format can.

### 1.6 Import

`POST /api/interchange/import` reads the bytes (path on local engines, or base64), sniffs the format (`aaf` by the
compound-file root class, `omf` by the Bento label, then the text formats), reads it into the IR, writes AAF/OMF
embedded audio as WAV files under `<appdir>/projects/<id>/Imported Audio/<document>/`, registers every referenced
file it can find (probe + fingerprint, at most 4 at once) and builds the fragment; files it cannot find become
**offline placeholders**: an asset with the document's name, path, duration, streams and timecode and the fingerprint
`pending:interchange:<hash>`, so the timeline keeps its exact shape. `project.importTimeline` adds the fragment in
one transaction; the report dialog lists the offline files and offers Link Media. EDL source timecodes are guessed
from the list (each source's hour) and rebased on the real file's start timecode when it is registered.

### 1.7 Link Media (S04:AS-011)

`POST /api/assets/:aid/relink {projectId, path, asset}` registers the file and compares it with the asset:
`match` = `fingerprint` (same bytes), `placeholder` (an imported placeholder: no fingerprint to compare) or
`different`, plus the differences a user would notice (kind, duration beyond one frame, resolution, frame rate,
audio layout, name, size). A different file, or a placeholder whose kind, length or frame rate disagree, is relinked
only after confirmation (`force`). `POST /api/projects/:pid/relink-scan {folder, assets, match, ignoreExtension}` is a
`relink-scan` job: it walks the folder (≤ 200 000 files, depth 32, hidden entries skipped), matches by file name
(optionally without the extension), then size and duration as asked, and — for assets with a real fingerprint — by
fingerprint among files of the same size (moved and renamed copies). The client applies one `media.relink` per
found file in one transaction ("Link Media (n)"). `media.relink` accepts a new fingerprint without `force` for
placeholders (there is nothing to compare). The Link Media dialog (File ▸ Link Media…, Project panel ▸ Link Media…)
shows each offline item with its last known path, a folder search with match options after Premiere's "Match File
Properties" (File Name; Ignore Extension = Premiere's File Extension unchecked; Media Start = start timecode; plus
File Size and Media Duration), per-item Locate, the differences, and a checkbox per found file.

## 2. Formats

### 2.1 FCP7 XML (xmeml 4/5, the Premiere dialect)

Reads and writes `project`/`bin`/`children`/master `clip`s (bins mirror the project; master clips carry labels and
markers), `sequence` (rate, timecode, in/out, labels), `media/video|audio/track` (enabled, locked), `clipitem`
(start/end/in/out plus `pproTicksIn/Out`, enabled, `masterclipid`, `file` by id, `sourcetrack`, labels, markers,
links), nested `sequence`s (inline, by id), `generatoritem` (Slug/Black, Color, Bars and Tone, Transparent Video,
Universal Counting Leader), `transitionitem` (alignment, Premiere names, start/end black), and the filters Basic
Motion (scale, rotation, center, anchor — uniform scale), Opacity, Crop, Time Remap (constant speed, reverse,
freeze), Audio Levels and Audio Pan with keyframes; `compositemode` blend modes. Values are written with the
shortest exact decimal (`exactNum`) and read with 9-digit rounding so property round trips are exact.

### 2.2 FCPXML 1.9–1.11

See `fcpxml.ts`'s header: V1 is the spine, other tracks are connected clips on lanes (audio on negative lanes),
merged A/V clips when picture and sound are linked with identical timing (FCPXML has no other links: reported as an
info), roles, rational time, `adjust-transform`/`blend`/`volume`/`panner`/`crop` with keyframes, `timeMap`, compound
clips (`ref-clip`), `caption` elements (`iTT?captionFormat=ITT.<lang>`), markers (point markers; a 1-frame marker is
a point), chapter markers, multicam (§2.4). Generators cannot be referenced (FCP's are Motion templates): solids are
pre-rendered.

### 2.3 OTIO, EDL, AAF, OMF, ALE

- **OTIO**: the full JasperEditor round trip through `metadata.jasper` (verified: a project with text, solids,
  effects, keyframes, transitions, links, markers and captions comes back identical). Other readers see clips with
  External/MissingReferences, Stacks for nests, LinearTimeWarp/FreezeFrame, markers and transitions.
- **EDL**: see `edl.ts`; a centred dissolve is written, as CMX requires, with the edit at the dissolve's start (the
  picture at every record frame is the same after a round trip; the cut moves to the start of the dissolve).
- **AAF**: the Edit Protocol (`aaf/index.ts` header): a top-level CompositionMob with a timecode slot, picture and
  sound timeline slots of Sequences (Filler, SourceClip, Transition with VideoDissolve_2 / VideoFadeToBlack /
  SMPTE wipe / MonoAudioDissolve), MonoAudioGain OperationGroups (Constant or Varying amplitude), comment markers;
  MasterMob → file SourceMob (CDCI / PCM descriptor, NetworkLocator or embedded EssenceData) → tape SourceMob with
  timecode; MS-CFB v4 (4096-byte sectors) or v3 (512, "older Avid / Pro Tools"); amplitudes as rationals with a
  2^24 denominator (≈1e-6 dB).
- **OMF 2.0**: Bento container (label, TOC, reference lists) with audio-only compositions (`omf/index.ts` header):
  the same mob chain as AAF, WAVE/AIFF descriptors, encapsulated WAVE media data or locators (UNIX/DOS path + file URL).
- **ALE**: heading, columns, data; one media item per row on import; export logs the sequence's (or project's) media.

AAF and OMF audio: `link` (reference the sources; AAF default), `embed` / Encapsulate (OMF default) or `separate`
files (WAV for AAF; AIFF or WAV for OMF), Trim Audio Files (used ranges + handle frames, default one second as in
Premiere) or Copy Complete Audio Files, 16/24-bit, Breakout to Mono (default on for OMF, as Premiere's separate
OMF audio is mono AIFF). The engine decodes each range with ffmpeg (`-ss`, `-frames:a`, `pcm_s16le`/`s24le` at the
sequence rate), zero-padding past the end of the media.

### 2.4 Multi-camera clips (docs/wp-notes/multicam.md §6)

- **FCP7**: an enabled multi-camera clip item carries `<multiclip id>` (`name`, `collapsed TRUE`, `synctype 1`, one
  `<angle>` per camera, shown cameras first, with `activevideoangle` on the clip's angle and `activeaudioangle` on
  the audible one — the first camera for `camera1`). Each angle `<clip>` is the camera's media: `in` = its media at
  the latest angle start (where every camera exists, so In-point sync reproduces the placement), `out`, `file`, and
  `start`/`end` in source-sequence frames that JasperEditor reads back exactly; other readers align the In points.
  Every edit is its own clip item (consecutive items of one multiclip with different active angles). When an angle
  is not one media clip at normal speed (several clips, gaps before the meeting point, speed) or the source mixes
  every camera (`all`), the clip is written as a nested sequence *as its angle sees it* (the other cameras' tracks
  `enabled FALSE`), reported as an info. The source sequence is not written a second time when every use is a
  multiclip. Import builds one source sequence per multiclip (a video track per camera with picture, an audio track
  per camera with sound, linked), audio mode `switch`, selections from the active flags.
- **FCPXML**: the source is a `media` with `multicam` (`mc-angle` per camera holding its tracks laid out like a
  storyline); every clip is an `mc-clip` with `mc-source` per used angle (`video`, `audio` or `all`; picture
  adjustments and video filters inside the video angle's `mc-source`, as the DTD requires). Hidden cameras become
  ordinary angles, tracks of no camera and source markers are reported.
- **OTIO**: the multi-camera source and selections are in `metadata.jasper` (exact round trip); in the file, each
  multi-camera clip's Stack has the other cameras' tracks disabled, so other readers show the active camera.
- **EDL, AAF, OMF, ALE**: no nests, so the clip is written as its angle's clips — Multi-Camera ▸ Flatten's pieces
  (`resolveMulticamClip` + `pieceVideoClip`/`pieceAudioClip`: composed Motion/opacity, levels, effects; audio angles
  spanning several tracks go on extra tracks), with transitions moved to the edge pieces.
- Disabled multi-camera clips are ordinary nests everywhere.

## 3. Usage

- **File ▸ Import…** (Ctrl+I) or a drop: `.fcpxml .otio .edl .aaf .omf .ale .xmeml`, and `.xml` files whose content
  is xmeml/FCPXML, are imported as timelines (caption `.xml`/TTML still goes to captions); one report dialog for all.
- **File ▸ Export ▸ Final Cut Pro XML… / FCPXML… / OpenTimelineIO… / EDL… / AAF… / OMF… / Avid ALE…**: the dialog
  (name, version, EDL tracks/reels/comments/per-track lists, AAF/OMF audio mode, files, handles, bit depth, format,
  breakout, 512-byte sectors, ALE scope, pre-render mode with the number of clips and reasons, destination: download
  or a file path on local engines), then progress, then the report with download links. Side files go to
  `<name> Media/` next to the document.
- **File ▸ Link Media…** / Project panel ▸ **Link Media…** on offline items.
- **MCP**: `import_timeline {path | content | contentBase64, format?, rate?, dropFrame?, binId?}`,
  `export_timeline {format, sequenceId?, outputPath?, prerender?, xmemlVersion?, fcpxmlVersion?, edl?, audio?,
  aafSmallSectors?, aleScope?, wait?}`, `list_offline_media`, `link_media {mediaId+path | folder, match?,
  ignoreExtension?, force?, dryRun?}`; every edit is also an `apply_commands` command (`project.importTimeline`,
  `media.relink`).
- **HTTP**: `POST /api/interchange/import`, `/api/interchange/prerender-plan`, `/api/interchange/export` (job),
  `GET /renders/:jobId/interchange/:name`, `POST /api/assets/:assetId/relink`,
  `POST /api/projects/:projectId/relink-scan` (job). Capability block `features.interchange`.

## 4. Verified behaviour (measured; commands below)

`pnpm vitest run packages/interchange --maxWorkers=2` — 11 files, 74 tests, all passing (≈ 65 s on the shared
16-core machine under load):

- **Property round trips** (fast-check, ported FilmCraft strategies; `arbProject(features)` + `canonical()` or the
  clip/transition structure), at every rate including 29.97/59.94 DF: OTIO (everything), FCP7 XML (+ keyframes,
  generators, transitions, links), FCPXML (+ lanes, keyframes, speed), EDL (cuts, dissolves, speed), ALE (media and
  timecodes), AAF (every clip, transition and link; audio to the nearest frame) and OMF (every audio clip and
  crossfade). `FC_RUNS=400` was also run for AAF and `FC_RUNS=300` for OMF.
- **Fixtures** (hand-made, per dialect): Premiere FCP7 XML (`premiere-lighthouse.xml`: bins, master clips, ticks,
  Basic Motion, Time Remap, levels), Resolve FCP7 XML (timecode strings, no `<frame>`), Final Cut Pro FCPXML
  (`fcp-harbour.fcpxml`: spine, lanes, compound clip, timeMap, roles, chapter markers), Resolve FCPXML, Premiere
  29.97 DF EDL, Resolve 25 fps EDL (`* CLIP NAME`), Avid EDL with keys, Avid ALE.
- **AAF**: round trips at 25, 29.97 DF, 23.976 and 59.94 DF (structure, links, transitions, gain and keyframes,
  markers, timecodes, reproducible bytes), 512-byte sectors, mono breakout, embedded trimmed audio with handles
  (PCM bit-exact), linked per-clip files + video mixdown, uncarried clips named; a file written by pyaaf2 (Avid
  dialect) is read.
- **OMF**: round trips at 25, 23.976 and 29.97 DF, embedded WAVE (bit-exact), separate AIFF files with mono breakout,
  the required properties of every OMF class (ported structural check), Bento values and references.
- **JasperEditor round trips through `project.importTimeline`**: OTIO identical (text, solids, effects, keyframes,
  transitions, links, markers, captions); FCP7 and FCPXML keep timing, Motion, opacity, blend, levels, pan, effects
  and transitions of the media clips; AAF timing and levels; EDL the picture of every record frame. The text clip is
  named in every report.
- **Multi-camera**: FCP7 multiclips (6 items, one source), FCPXML (1 multicam, 3 angles, 3 mc-clips), OTIO exact with
  one enabled camera per stack, EDL/AAF/OMF the active camera's clips — each compared with what the original shows
  (`resolveMulticamClip`), plus the FCP7 fallback (split angle, `all` audio) and disabled clips.
- **Corruption/fuzz**: every format's reader on truncations and random byte flips (300 runs + 97 truncations for
  AAF/OMF) throws nothing but `InterchangeError`.
- **External readers** (`/tmp/interchange-venv`: opentimelineio 0.18.1 with otio_json, cmx_3600, fcp_xml, fcpx_xml,
  AAF and ale adapters; pyaaf2): our OTIO, FCP7 XML, FCPXML, EDL, ALE and AAF files are read by them with the expected
  structure. These tests skip when the venv is absent. No OMF reader was available: OMF is verified structurally.

`pnpm vitest run apps/engine/test/interchange.test.ts --maxWorkers=2` — 6 tests: FCP7 export job to a path and import
back with registered media; AAF with embedded audio decoded by ffmpeg (16-bit, non-silent) imported back as WAV files;
OMF with separate mono 24-bit AIFF files next to the document; per-track EDLs and the pre-render plan; an FCP7 file
whose media moved imported as 3 placeholders, relinked one by path (`placeholder`, no confirmation), a wrong file
needing confirmation (kind differs), the rest by folder search (name + duration) and `media.relink`; garbage refused
with `INTERCHANGE_UNSUPPORTED` (415) / 422.

`REMOTION_E2E=1 JASPER_E2E_PORT=49165 pnpm vitest run apps/engine/test/interchange-prerender.e2e.test.ts` — the text
clip of a 720p sequence is pre-rendered to ProRes 4444 (ffprobe: `prores`, `yuva444p12le`, 1280×720, 15 frames for a
15-frame clip), the corner pixel's alpha is 0, the text opaque, and the EDL references the movie. The frame composited
on green was looked at (the text on a transparent background).

`pnpm vitest run apps/web/test/interchange.test.tsx` (4) — timeline file detection, EDL import as one transaction with
placeholders, Link Media enabled, relink, one undo removes the import; the export dialog's request (EDL options) and
the report. `apps/mcp/test/interchange.test.ts` (3) — the four tools against an in-memory engine, strict arguments.
`packages/project/test/clipboard.test.ts` — pasting a multi-camera source remaps its cameras' tracks (fixed here:
`copySequence` did not remap `multicam.angles`, which broke Paste and import of multi-camera sources).

## 5. Comparison with the references

- **FilmCraft** (`crates/interchange`, Rust): the formats, the IR idea, the mob composition model, CFB/AAF/OMF/Bento
  and the property tests are ported. Differences: JasperEditor's model is frames + flicks (FilmCraft ticks), so the IR
  and the bridge (`jasper-{import,export}.ts`) are new; added on top: bins/master clips in FCP7, crop, blend modes,
  generators, channel mapping, hold filters, FCPXML captions and non-uniform scale, OTIO full metadata round trip,
  EDL start-timecode rebasing, ALE import, AAF SDK usage codes and MetaDictionary (pyaaf2 needed them), multicam in
  every format, exact amplitudes, the engine (embedded essence, registration, relink).
- **EffectCraft** (`crates/interchange/src/export.rs`): the pre-render modes and per-layer reasons; JasperEditor
  pre-renders sequence clips (not composition layers) through its export pipeline, per format capabilities.
- **Premiere Pro** (documented behaviour, §6): File ▸ Export ▸ Final Cut Pro XML / AAF / OMF / EDL with their
  options (OMF: Encapsulate or Separate Audio as mono AIFF, Trim or Copy Complete, handle frames default one second;
  AAF: embed, breakout to mono, bit depth; EDL: tracks, reels, comments), File ▸ Link Media; FCPXML, OTIO and ALE are
  beyond Premiere (Resolve/FCP formats). JasperEditor additionally reports every loss per clip and pre-renders
  instead of dropping.

## 6. Sources

- Adobe: [Formats exported directly from Premiere Pro](https://helpx.adobe.com/premiere-pro/using/formats-exported-directly-premiere-pro.html);
  [Exporting OMF files for Pro Tools](https://helpx.adobe.com/premiere-pro/using/exporting-omf-files-pro-tools.html)
  (Encapsulate / Separate Audio as mono AIF in `_omfiMediaFiles`, Trim / Copy Complete, Handle Frames default one
  second); [Relink offline media](https://helpx.adobe.com/premiere-pro/how-to/relink-offline-media.html) (Link Media,
  Match File Properties: File Name, File Extension, Media Start, Tape Name); the Export AAF / EDL / Final Cut Pro XML
  dialogs as described in the Premiere Pro user guide.
- Apple: [Final Cut Pro XML Interchange Format, Elements](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html)
  (multiclip, angle, activevideoangle, activeaudioangle, collapsed, synctype 1–5, clip);
  [FCPXML DTD v1.7](https://developer.apple.com/library/archive/documentation/Miscellaneous/Conceptual/LegacyDTDsFinalCutPro/FCPXMLDTDv1.7/FCPXMLDTDv1.7.html)
  (media/multicam/mc-angle/mc-clip/mc-source content models and srcEnable values) and the FCPXML 1.9–1.11 reference.
- OpenTimelineIO: the schema reference and the Python adapters (`otio_json`, `cmx_3600`, `fcp_xml`, `fcpx_xml`, `AAF`,
  `ale`) used as external readers.
- CMX 3600 (SMPTE 258M-era edit list format) as documented by the OTIO cmx_3600 adapter and the FilmCraft notes;
  SMPTE 12M drop-frame timecode.
- AMWA: AAF Object Specification v1.1, AAF Low-Level Container Specification v1.0.1, AAF Edit Protocol v1.0;
  Microsoft [MS-CFB] Compound File Binary format.
- Avid: OMF Interchange Specification 2.0; Apple Bento Specification rev. 1.0d5; Avid ALE description (heading,
  columns, data).
- Undocumented choices (made here): FCP7 multiclip angle `start`/`end` (JasperEditor-exact placement; other readers
  align In points), `synctype 1` whatever the source's sync method, the view-nest fallback, Flatten for nest-less
  formats, pre-render file names `<clip name> <clip id>.mov`.

## 7. Limits and caveats

- FCP7 XML: uniform scale only (non-uniform and flips are pre-rendered or reported), track volume/pan and clip groups
  are not carried, a clip's channel mapping is written as its first channel, transitions use Premiere's names
  (other applications may substitute).
- FCPXML: transitions only on the primary storyline, audio transitions not carried, links only as merged A/V clips,
  no generators (pre-rendered), hidden multicam cameras become ordinary angles.
- EDL: one video track per list, at most four audio channels, no levels; reel names are derived (file name, clip name
  or AX); the source timecode of imported media is a guess until the real file is linked.
- AAF: no nested sequences (reported/pre-rendered), no speed (pre-rendered), Motion/Opacity/effects pre-rendered;
  render clip audio effects into the essence is not implemented (gain is written as MonoAudioGain).
- OMF: audio only; markers and captions are reported; no external validator was available.
- Pre-renders need the Remotion path (a browser); without it the job reports each failed render and exports the
  clips as the format carries them. Pre-renders are full frames of the sequence size.
- Link Media: Premiere's Tape Name match (and its other metadata matches) is not implemented; folder search is
  capped at 200 000 files; the folder and Locate paths are typed (the desktop bridge has no folder picker).
- Merged clips' `merged` flag is not carried by any format (the sequence comes back as an ordinary sequence).
- OTIO `metadata.jasper` keeps engine-store keys: importing an OTIO written by this engine on the same machine links
  the media without probing again.
