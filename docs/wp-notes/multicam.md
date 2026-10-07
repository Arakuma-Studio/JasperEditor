# multicam — audio sync, Synchronize, Merge Clips, multi-camera editing

Workstream `multicam` of the parity program. Everything is undoable document commands (`packages/project`), rendered
by the existing render paths (Player, stills, Remotion and native exports), with UI, MCP tools and tests. Ported code:
`licenses/ported/multicam.md` (FilmCraft, MIT OR Apache-2.0).

## 1. Design decision: multi-camera is built on nests

When this workstream started there were no nested sequences; `edit-structure` then landed generic nests
(`nest-video` / `nest-audio` clips, recursive rendering in the compositions and in the native filtergraph, nested
audio flattening, open-in-timeline, match frame). Multi-camera is therefore modelled **as Premiere does**: a
multi-camera clip *is* a nest clip of a multi-camera source sequence, with a multi-camera selection.

- **Source** = an ordinary `Sequence` with `multicam: { angles, audio, sync? }`. Each angle (camera) is one video track
  plus its audio tracks (`MulticamAngle {id, name, videoTrackId | null, audioTrackIds, enabled, itemId?}`); audio-only
  sources are angles without video, always mixed in. The clips' positions in the source **are** the sync: adjusting
  sync = opening the source sequence (double-click / Reveal Nested Sequence) and nudging clips; every multi-camera
  clip follows immediately (it renders the source live). Angle order = camera order (Camera 1 = the first video
  angle); hidden angles (`enabled: false`, Edit Cameras) keep their clips but leave the camera numbering.
- **Clip** = `nest-video` / `nest-audio` with `multicam: { enabled, angle }`. Enabled, the render snapshot builds the
  nested snapshot of a **view** of the source (`multicamView`): the other angles' video tracks get `output: false`
  (video clips) / only the audible tracks of the angle play (audio clips: `camera1` = the first video angle, `all` =
  every camera, `switch` = the selected angle; audio-only angles always). Disabled (Multi-Camera ▸ Enable off), it is
  an ordinary nest (the composite). The nest content key includes the view, so render caches never mix angles.
- Consequences: the multi-camera clip's Motion, opacity, blend mode, masks, colour and effects apply to the angle's
  picture exactly as on any nest (on the source frame, after the angle clip's own effects); speed, reverse, frame
  holds, transitions, trims (bounded by the source length) work as for nests; the native export draws it in the same
  filtergraph; Remotion previews/exports draw it through `NestLayer`. No special render path exists.
- **Merged clip** = a sequence with `merged: { videoItemId, audioItemIds, sync, removeVideoAudio }`: V1 = the video, the
  audio tracks = its own audio (unless removed) and the external recordings, all linked and synced. Placing it edits
  **the clips it holds** (linked, in sync — edit-structure's "individual clips" placement), as Premiere places merged
  clips, unless `nest: true` is passed explicitly.
- Rejected alternative (the first design, written before nests landed): expanding multi-camera clips into flat clips
  inside the render snapshot. It is kept only for **Flatten** (`multicam/resolve.ts`), which must reproduce the nest's
  picture with ordinary clips; the tests compare Flatten against the nest frame by frame.

All schema additions are optional (no version bump): `Sequence.multicam`, `Sequence.merged`, `NestVideoClip.multicam`,
`NestAudioClip.multicam`, `MediaItem.markers` (source clip markers). Invariants: angle track references, duplicate
angle ids / shared video tracks, selection → existing angle with video, `multicam` only on nest clips, item marker
ids/times (INV-001/004/006/012). `repairDocument` prunes broken angles, drops multi-camera selections of non-sources
(they become plain nests) and re-points missing angles to camera 1. `track.remove` on a source prunes the angles and
re-points clips.

## 2. Audio sync (two-pass GCC-PHAT)

`packages/audio-dsp/src/sync.ts` (port of FilmCraft `crates/audio-dsp/src/sync.rs`, in double precision) and the
engine service `apps/engine/src/sync/service.ts` behind `POST /api/sync/audio`.

- **Coarse pass**: both signals DC-removed, normalised, low-passed (Blackman-windowed sinc, cutoff 0.42 of the new
  rate) and decimated to ≤ 8 kHz (further for very long recordings so the transform stays ≤ 4 M points); the
  generalised cross-correlation with β-weighted phase transform `R = A·B* / |A·B*|^β` (β = 0.75) is computed with **one
  complex FFT of both signals packed as a + i·b** (A and B separated by conjugate symmetry), band-limited to 40 Hz …
  0.4·rate. The engine decodes the coarse signal directly at 8 kHz mono with ffmpeg (its resampler is the anti-alias
  filter), so a 30-minute recording costs 57 MB of floats, not 345 MB.
- **Fine pass**: around the coarse lag, the loudest window both recordings share (≤ 2.7 s, chosen on the coarse
  signals) is decoded at 48 kHz from both files, correlated with the same GCC-PHAT, and the peak refined by
  parabolic interpolation (`lagFine`, sub-sample).
- **Metrics**: `confidence` = peak / RMS of the correlation, `distinct` = peak / highest peak more than 50 ms away,
  `inverted` = negative peak (polarity). `reliable` = confidence ≥ 8 and distinct ≥ 1.5 (FilmCraft's thresholds). The
  dialogs show the figures and ask before applying an unreliable match ("… Anyway"); the MCP tools refuse unless
  `onUnreliable: "apply"`.
- **Offsets** are media times on a common clock: `t_clip = t_ref + offsetFlicks` (the reference is 0); the commands
  take them as `audioOffsets` (the reference may be omitted; offsets on any common clock are normalised to the command's
  own reference). Sub-frame parts are kept: a clip whose exact start falls between frames starts on the next frame with
  its source In moved by the remainder.
- Limits: at most 30 minutes of each recording are analysed (from the analysed stretch's start); 2–32 recordings per
  request; recordings must overlap by ≥ 0.5 s (or a quarter of the shorter one).

## 3. Commands

| Command | Semantics |
|---|---|
| `clip.synchronize {clipIds, method, referenceClipId? \| referenceTrack?, ignoreHours?, marker?, offsetFrames?, audioOffsets?}` | Clip ▸ Synchronize: units = each clip with its linked clips (they move together); the unit's sync point is read from its clip on the lowest video track (audio method: lowest audio track). Reference = the given clip/track, else the unit on the lowest video track (Premiere's "Synchronize Point on track"). Units move by whole frames (sub-frame audio remainder into the source In); if anything would go before frame 0 everything shifts right. Overwrites what is in the way (the moved clips excepted). |
| `item.mergeClips {itemIds, method, name?, binId?, removeVideoAudio?, …}` | One video item (the reference) + 1–16 audio items → a merged clip `<video> - Merged` (Iris label) in the video's bin. |
| `multicam.create {itemIds, method, name?, binId?, referenceItemId?, preset?, audio?, cameraNames?, names?, order?, moveToProcessedBin?, …}` | Cameras (items with video) first, audio-only sources after; `order` selection / name / timecode / explicit ids; names `Camera N` (Enumerate Angles) or clip names; preset `automatic` = the reference camera's size and rate; tracks named after the cameras; optional Processed Clips bin. |
| `clip.place {source: {sequenceId}}` of a source | Linked `nest-video` + `nest-audio` multi-camera clips showing camera 1 (always nests). |
| `multicam.switchAngle {angle, clipIds? \| at? \| range?, track?, topDown?, video?, audio?}` | Angle = id, camera number (shown order) or name. Whole clips, the clip under `at`, or only a range (edits at its ends; neighbouring pieces with the same angle are healed). Linked multi-camera audio follows unless `audio: false`. |
| `multicam.record {cuts[{at, angle}], to?, track?, topDown?, video?, audio?}` | A live switching pass: from each cut on, its angle until the next (the last until `to`, default the end of the run of multi-camera clips under the first cut). Two cuts at one frame: the later wins; a cut to the angle already shown adds no edit (healed). One transaction = one undo step. |
| `multicam.setEnabled {clipIds, enabled}` | Enable / Disable (with linked clips). Enabling a plain nest makes its sequence a source: one angle per video track (audio tracks paired by index, extra audio tracks audio-only, audio mode `all`). |
| `multicam.flatten {clipIds}` | Replaces enabled multi-camera clips (and linked ones) by the angle's clips: composed Motion (closed form for static angle Motion, else sampled per frame; a rotation with non-uniform outer scale warns `MULTICAM_TRANSFORM_SKEW`), opacity product, blend, inner then outer effects, keyframes re-timed into media time, audio gain/volume/pan/effects of the clip, the angle clip, its track and the source master composed; transitions move to the edge pieces; flattened video/audio of one piece stay linked. Disabled clips are skipped with `W_CLIP_SKIPPED`. |
| `multicam.editAngles {sequenceId, angles?, order?, audio?}` | Edit Cameras: rename, show/hide, reorder, audio mode. |
| `marker.add {itemId, flicks}` (+ update/remove) | Source clip markers on media items (Source monitor M) — the "Clip Marker" sync point. |

Agents: semantic address `{"itemByName": "Cam A.mp4"}` for project items.

## 4. UI

- **Clip menu**: Synchronize…, Merge Clips…, Create Multi-Camera Source Sequence…, Multi-Camera ▸ Enable / Flatten /
  Edit Cameras… / Multi-Camera Audio Follows Video / Multi-Camera Selection Top Down. **Timeline clip context menu**:
  Synchronize…; for nest clips Multi-Camera ▸ Enable, Flatten, `1 Camera 1` … (checked = shown), Edit Cameras….
  **Project panel context menu**: Merge Clips…, Create Multi-Camera Source Sequence….
- **Dialogs** with Premiere's option names: Synchronize Clips (Clip Start / Clip End / Timecode + Ignore Hours / Clip
  Marker / Audio, Synchronize on track), Merge Clips (Name, In Point / Out Point / Matching Timecode / Clip Marker /
  Audio, Offset Audio by, Remove Audio From AV Clip), Create Multi-Camera Source Sequence (Video Clip Name + Multicam
  or custom name, In / Out / Timecode / Clip Marker / Audio, Sequence Offset, Sequence Preset (Automatic + presets),
  Move source clips to Processed Clips bin, Audio: Camera 1 / All Cameras / Switch Audio, Camera Names: Enumerate
  Angles / Use Clip Names, Camera Order), Edit Cameras (show/hide, rename, reorder, audio).
- **Program monitor ▸ Settings ▸ Multi-Camera** (Shift+0): the monitor plays a virtual document — the angle grid on the
  left and the program on the right — in its one Player, so cells and program are frame-synced by construction and
  drawn by the normal render path (each cell is the multi-camera clip switched to one angle, without the clip's
  effects/Motion). Grid Automatic / 2×2 / 3×3 / 4×4 with page arrows; Show Multi-Camera Preview Monitor (off: grid
  only); Show Camera Names; Selection Top Down; Audio Follows Video; Edit Cameras…. The active camera is outlined
  yellow when stopped and red while recording; clicking a cell switches/records.
- **Keys** (Premiere defaults, `editing` scope): 1–9 Select Camera N (page-relative), Ctrl+1–9 Cut to Camera N,
  Shift+0 Multi-Camera view; M in the Source monitor adds a source clip marker.
- **Live switching**: while playing, keys and clicks add cuts to one session gesture (`multicam.record` re-applied to
  the pass's base document on every press, so the timeline shows the cuts live); stopping playback commits the
  pass as one History entry "Record Multi-Camera". Stopped, a key switches the clip at the playhead (one undo step);
  Ctrl+N cuts there.
- Timeline labels multi-camera clips `[MC2] name` (camera number); Match Frame resolves through the active angle.

## 5. Agents (MCP, `apps/mcp/src/tools/multicam.ts`)

`measure_audio_sync` `synchronize_clips` `merge_clips` `create_multicam_sequence` `switch_multicam_angle`
`record_multicam_cuts` `set_multicam_enabled` `flatten_multicam` `edit_multicam_cameras` `get_multicam`; guide text
`MULTICAM_GUIDE`; placing a source uses `place_sequence`. Audio sync is measured in the engine before the command
runs; every command is also available through `describe_commands` / `apply_commands`.

## 6. FCP7 XML (xmeml) mapping — for the interchange workstream

Apple's *Final Cut Pro XML Interchange Format* (xmeml v2+, "Elements" catalogue) defines `clipitem > multiclip` with
`name`, `angle+` (`activevideoangle`, `activeaudioangle`, `clip+`), `collapsed`, `synctype` (1 In, 2 Out, 3 timecode,
4/5 aux timecode). A multi-camera clip maps as:

| Jasper | xmeml |
|---|---|
| enabled `nest-video` multi-camera clip (start, duration, sourceIn → in/out in source frames) | `<clipitem>` with `<multiclip id="mc-<sourceSeqId>">`, `<collapsed>TRUE</collapsed>` |
| source item name | `<multiclip><name>` |
| `multicam.sync` | `<synctype>`: in → 1, out → 2, timecode → 3; marker/audio → 1, each angle's `<clip><in>` set to the media frame that sits at the source's common time 0 so In-point sync reproduces the placement |
| angles in camera order (shown ones; hidden angles too, after) | `<angle>` per camera: `<clip>` = the angle's media (name, rate, in/out, `<file>`), `<activevideoangle>TRUE` on the clip's angle |
| audio clip's angle (`switch` mode) | `<activeaudioangle>TRUE` on that angle; `camera1` → the first angle; `all` → no xmeml equivalent: export the sound as a separate nested-sequence audio clipitem (composite) and report it |
| disabled multi-camera clip | an ordinary nested-sequence clipitem (`<sequence>` reference), as edit-structure exports nests |
| an angle track with several clips or gaps | not expressible as one `<clip>`: export that clip as the nested-sequence fallback (the angle's view) and report it |
| switching (cuts) | consecutive clipitems of one multiclip with different `activevideoangle` |

Import does the inverse: one source sequence per distinct `multiclip id` (one angle per `<angle>`, its clip placed so
the synctype points line up), multi-camera clips with the active angles. Implemented by the interchange workstream
(`docs/wp-notes/interchange.md` §2.4), also for FCPXML (`multicam`/`mc-clip`), OTIO and, as the angle's clips, EDL,
AAF, OMF and ALE.

## 7. Verified behaviour (tests; all measured with the commands shown)

- `packages/audio-dsp/test/sync.test.ts` (12): FFT vs naive DFT; decimation response; exact integer delays both signs
  up to 2 s; three microphones with −20…+10 dB gains, 25/10/3 dB SNR, a low-pass colouring and fractional delays —
  every lag within 1 sample, `lagFine` within 0.75; echo 23 ms later at 0 dB SNR → direct path; inverted polarity;
  partial overlap (4 s of 10/14 s) both ways; sub-sample delays (0.25, 0.5, 10.4, −3.7 samples) within 0.3; unrelated /
  silent / short inputs not reliable or null; `maxLag`; 44.1 kHz input.
  `pnpm vitest run packages/audio-dsp/test/sync.test.ts`.
- `apps/engine/test/sync-audio.test.ts` (3, real ffmpeg): WAV reference vs an MP4/AAC camera 3.25 s later (quieter,
  noisy): offset within 1 ms; a recorder 1.5 s earlier with inverted polarity: within 1 sample, `inverted`, reliable;
  unrelated material flagged; analysed stretches (clip source ranges) give media-time offsets; `maxOffsetSeconds`;
  validation (404/400) and the `features.audioSync` capability.
- `packages/project/test/multicam.test.ts` (24): sync points (In/Out/named marker/timecode incl. ignore hours,
  drop-frame hour labels, common-clock audio offsets), sub-frame placement; Create (tracks, names, order, preset,
  Processed Clips bin, audio offsets); placing; rendering through the nest (only the angle's media, outer effects,
  opacity, Motion on the nest, content key per angle, every frame at the synced media time); disabled = composite;
  audio modes camera 1 / all / switch and audio fixed vs following; source edits reflected; switching at a time / in a
  range with healing; recording passes (one transaction, healing, video-only); a randomised property check that every
  frame renders the angle the cuts selected at the synced time; Edit Cameras numbering; **Flatten equals the nest
  frame by frame** (matrices, opacity, media time, effects) incl. a 4K angle fitted into a 1080 source with keyframed
  outer scale, rotation and anchor, and an animated angle Motion (sampled); Synchronize by timecode / named markers /
  audio with sub-frame remainder / reference track; Merge Clips (markers, removeVideoAudio, placing synced linked
  clips, 16-clip limit); invariants and repair; item markers.
- `apps/engine/test/multicam-export.test.ts` (2, real ffmpeg, native path): frame codes of camera A at its synced
  frames, camera B in a switched range, camera B's tone only while B is shown, the clip's 50 % opacity on the angle,
  and Flatten exporting the same pixels (±4).
- `apps/mcp/test/multicam.test.ts` (3): the tools through the protocol (audio measured then applied, unreliable
  refused/applied, synchronize against the command's reference, placing, range switch, recording, get_multicam,
  Edit Cameras, Flatten, strict arguments).
- `apps/web/test/multicam.test.ts` (7): keys stopped (switch / Cut to Camera, undo), a recorded pass while playing
  (live in the drawn document, nothing committed until stop, one History entry, undo restores), refusals, the
  Multi-Camera view document (grid cells, program, pages, 17-camera paging), page-relative keys, menus' commands,
  default key bindings, Project-panel enablement.
- `e2e/multicam.spec.ts` (5, built app, Chrome): Project panel ▸ Create Multi-Camera Source Sequence…, placing (`[MC1]`), Shift+0 grid + program (nests drawn), clicking a cell switches (undo), keys 2 and 1 while playing → one "Record Multi-Camera" History entry with cuts, native export with each part showing its camera (red/blue pixels), Merge Clips… by audio flagging a steady tone (distinct 1.17) and merging anyway. `E2E_PORT=49220 E2E_SKIP_BUILD=1 pnpm exec playwright test e2e/multicam.spec.ts`.

## 8. Adobe fidelity (research, brief §3b) and sources

- Create Multi-Camera Source Sequence options and audio choices (Camera 1 / All Cameras / Switch Audio), sync by In,
  Out, timecode, clip marker or audio, Processed Clips bin, camera names, Edit Cameras reorder:
  [Adobe — Create a multi-camera source sequence](https://helpx.adobe.com/premiere-pro/using/create-multi-camera-source-sequence.html)
  (helpx blocks automated fetching from this host; content confirmed through Adobe's page summaries in search results),
  [Larry Jordan — Premiere Pro CC Multicam Cookbook](https://larryjordan.com/articles/premiere-pro-cc-multicam-cookbook-2/),
  [MASV — Multicam editing in Premiere](https://massive.io/tutorials/multicam-editing-in-adobe-premiere/).
- Keys: 1–9 Select Camera, Ctrl+1–9 Cut to Camera, Shift+0 multi-camera view:
  [Premiere shortcut list (PDF)](https://training.utdailybeacon.com/wp-content/uploads/2023/01/Premiere-Pro-Shortcut-Commands.pdf),
  [Adobe community: multi-camera editing switching cameras](https://community.adobe.com/t5/premiere-pro-discussions/multi-camera-editing-switching-cameras/td-p/8493110).
  Premiere's "Multi-Camera Record On/Off Toggle" (0) is not bound: recording starts on its own when you switch while
  playing (as in current Premiere).
- Synchronize (Clip Start, Clip End, Timecode, Clip Marker, Audio; one clip per track; targeted tracks):
  [ProVideo Coalition — Using Synchronize in Premiere Pro](https://www.provideocoalition.com/using-synchronize-premiere-pro/),
  [AEJuice forum tutorial](https://forum.aejuice.com/t/tutorial-synchronize-clips-that-sit-on-the-same-track-in-premiere-pro/2205).
  We do not require one clip per track (linked clips form units instead).
- Merge Clips (name, In Points / Clip Marker / Audio, Remove Audio From AV Clip, a new clip but no new media):
  [Evergreen Help Wiki — Merging Clips from Dual-System](https://helpwiki.evergreen.edu/wiki/index.php/Merging_Clips_from_Dual-System_-_Premiere_Pro),
  [crumplepop — How to merge clips in Premiere Pro](https://crumplepop.com/how-to-merge-clips-in-premiere-pro/),
  [UT Austin wiki — Merging audio with waveforms](https://cloud.wikis.utexas.edu/wiki/spaces/comm/pages/33425251/Adobe+Premiere+-+Merging+Audio+with+Waveforms).
  Premiere's limit is 16 audio *channels*; here 16 audio *clips* (each with all its channels).
- FCP7 XML multiclip: [Apple — Final Cut Pro XML Interchange Format, Elements](https://developer.apple.com/library/archive/documentation/AppleApplications/Reference/FinalCutPro_XML/Elements/Elements.html),
  [Versions of the interchange format](https://developer.apple.com/library/mac/documentation/AppleApplications/Reference/FinalCutPro_XML/VersionsoftheInterchangeFormat/VersionsoftheInterchangeFormat.html).
- GCC-PHAT: Knapp & Carter, *The generalized correlation method for estimation of time delay*, IEEE Trans. ASSP 24(4),
  1976; the β-weighted PHAT is standard practice (FilmCraft's notes).
- Undocumented, chosen as most plausible: the last camera of a recording pass runs to the end of the current run of
  multi-camera clips (FilmCraft's provisional end); yellow (stopped) / red (recording) outlines; Synchronize's reference
  default (lowest video track); merged-clip label Iris; Multi-Camera Audio Follows Video on by default.

## 9. Comparison with FilmCraft

| Feature | FilmCraft | Here |
|---|---|---|
| Audio sync | two-pass GCC-PHAT on whole 48 kHz decodes, f32 | same algorithm in f64; coarse decode at 8 kHz + two short 48 kHz windows (≈ 6× less memory); offsets on a common clock; dialogs/MCP warn or refuse unreliable matches |
| Synchronize / Merge / Create | yes | same + explicit camera order, names override, preset, sub-frame remainder in source In for every method, Merge Clips placing as linked clips |
| Model | multicam source sequence + `MulticamSel` on nest clips | same, angle ids (stable under reorder) instead of indices |
| Rendering | render plan picks the angle track | nested snapshot of the angle view: every render path (Player, Remotion, native filtergraph) unchanged; per-angle cache keys |
| Live switching | record pass merged into one undo entry | same, as a session gesture shown live; also via MCP `record_multicam_cuts` |
| Flatten | effects appended; refuses speed/reverse/holds | composed Motion/opacity/blend/keyframes/audio with a frame-by-frame equivalence test against the nest render; speed, reverse and holds supported |
| Multi-Camera view | egui grid with paging, decode-scale | one virtual composition (grid + program) in the Program Player, paging, outlines, click-to-cut |

## 10. Limits (honest)

- The FCP7 multiclip mapping (§6) is implemented by the interchange workstream (`docs/wp-notes/interchange.md` §2.4).
- Audio sync analyses at most 30 minutes per recording; repetitive material (music beats, hum) can match at several
  lags — `distinct` flags it, but the user must choose.
- The Multi-Camera view decodes every visible angle at full size in the preview Player (no reduced-resolution grid
  decode; lower the Program monitor's playback resolution for heavy grids).
- `all` audio mode has no FCP7 equivalent (see §6).
