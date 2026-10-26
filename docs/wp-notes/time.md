# time — Time Remapping, Time Interpolation (Frame Sampling / Frame Blending / Optical Flow), reverse playback, Scene Edit Detection, variable frame rate

Workstream `time` of the parity program. Everything here is undoable document commands (`packages/project`), shown by
the Program monitor and the Remotion renders (`packages/compositions/src/retime/`), rendered by the native export (the
`retime` native extension, `apps/engine/src/export/retime/`), carried by the interchange formats, with UI, MCP tools
and tests. Ported code: `licenses/ported/time-effectcraft.md` (optical flow, cut detection) and
`licenses/ported/time-filmcraft.md` (Scene Edit Detection options and application), both MIT OR Apache-2.0.

## 1. Model (schema additions, all optional, no version bump)

| Field | Where | Meaning |
|---|---|---|
| `timeRemap?: {enabled, keyframes: {id, time, source, ramp?, ease?}[], speedBefore?, speedAfter?}` | `video`, `nest-video` (multicam clips are nests) | Premiere's Time Remapping. `time` = content flicks (the keyframe axis), `source` = media flicks. |
| `timeInterpolation?: 'frame-sampling' \| 'frame-blending' \| 'optical-flow'` | `video` | Clip ▸ Video Options ▸ Time Interpolation (default Frame Sampling). Applies to speed changes, remaps and frame-rate conform. |

**Two time axes** (`packages/project/src/time-remap/model.ts`):

- *Content time* `c` is the keyframe axis — `contentTimeAt(clip, frame)` as before. Motion, Opacity and effect
  keyframes are evaluated there, so a remap never moves them (Adobe does not document this; community reports say
  Premiere's Motion keyframes "disappear" when a remapped speed changes, which we consider worse — see §6).
- *Media time* `m = R(c)` chooses the picture. `R` is piecewise linear through the keyframes `(time, source)`:
  constant speed between two keys, forward, reverse (decreasing) or freeze (constant), extended with `speedBefore`
  / `speedAfter` (default 1).
- A keyframe with `ramp = r` replaces its corner with a speed transition over `[c − r, c + r]`. The speed goes from
  the left slope to the right slope along `E(x) = (1 − e)x + e(3x² − 2x³)`, with `e` = `ease` (default 1, an
  S-curve). Both shapes have mean ½, so every keyframe's media position stays where the corner put it: a ramp
  never shifts content.
- Timeline speed (Premiere's percentage) = `R'(c) · speed.rate`. Limits: 0.01 %–20,000 % per segment (Premiere
  Pro 14.0+), 0 % = freeze, negative = reverse.
- `clipMediaTimeAt` / `clipMediaTimeFn` apply the edit-structure frame hold (`frameHold.flicks`, content time) first,
  then the remap. The two features are unified: one frame-hold model (edit-structure's), with its commands, and a
  remap freeze segment for holds inside a clip.

**Invariants** (`time-remap/invariants.ts`, wired into `invariants.ts` and `repairDocument`):

- keys sorted, ≥ 1000 flicks apart, finite;
- ramps clamped to their neighbours;
- remap only on remappable kinds;
- remapped clips are never `speed.reverse`;
- keyframe ids unique.

`repairDocument` sorts and clamps the keys, drops a remap on a wrong kind or a reversed clip, and re-ids duplicate
keys (note `repair-time-remap`).

## 2. Commands (`commands/schemas/time.ts`, owner `wp-time`)

| Command | Semantics |
|---|---|
| `timeRemap.enable {clipIds, enabled, linkedAudio?: keep\|mute\|unlink}` | Enable: an identity remap. The clip is unchanged until a speed is set. Disable: every speed keyframe is removed, and the clip goes back to its linear duration (Premiere: "the clip's duration will return to its original length"). `linkedAudio` chooses what happens to the linked audio, which keeps playing at 100 % (Premiere). |
| `timeRemap.addKeyframe {clipId, at}` | Speed keyframe at a timeline frame (Ctrl-click on the band). |
| `timeRemap.removeKeyframes {clipId, keyIds}` | Remove keyframes; the segment speeds join (destructive-idempotent). |
| `timeRemap.setSpeed {clipId, at, speedPercent, ripple?}` | Speed of the segment under `at`. The out point follows: faster → shorter, slower → longer. A longer clip stops at the next clip, and its remaining frames go into the tail (Premiere: "it will not overwrite an adjacent clip"), unless `ripple`. |
| `timeRemap.moveKeyframe {clipId, keyId, toFrame}` | Alt-drag: move a keyframe; the speeds on both sides stay. |
| `timeRemap.setTransition {clipId, keyId, frames, ease?}` | Split a keyframe into a speed ramp of `2·frames`, or remove the ramp (0). |
| `timeRemap.addFreeze {clipId, at, duration, ripple?}` | Ctrl+Alt-drag: hold the frame at `at` for `duration` frames. |
| `timeRemap.addReverse {clipId, at, duration, ripple?}` | Ctrl-drag: palindrome reverse (backward for `duration`, then forward at full speed back to the frame). |
| `clip.setTimeInterpolation {clipIds, mode}` | Frame Sampling / Frame Blending / Optical Flow. |
| `clip.applySceneEdits {sequenceId, clips: [{clipId, cuts}], applyCuts, createSubclips, createMarkers, binName?}` | Applies Scene Edit Detection results in **one** undo step: razor cuts (linked clips too, latest first), one subclip per shot in a new bin "‹clip› Scenes", and/or clip markers "Scene Edit". |

Every edit keeps the source frames of the segments it does not touch. The edited remap is fitted to the media (a
clip never shows frames beyond its media) and to the next clip. Refusals:

- clips that are not remappable;
- clips with Reverse Speed (Speed/Duration's reverse and the remap don't combine; use a reverse segment);
- clips with a tracker: their analysis is in content time. `tracker.add` is refused on remapped clips too.

Speed/Duration, trim, rate stretch, transitions' handles, paste attributes ("Time Remapping" row) and Remove
Attributes are remap-aware (handles in `commands/ripple.ts` `contentHandles`, shared with edit-ux's trims; `clip-edit.ts`,
`transitions.ts`, `clipboard`). The source-range
process (media management) covers the remapped media extent (`process/source-range.ts`).

## 3. Preview and Remotion renders (`packages/compositions/src/retime/`)

A video layer is *retimed* when its frames are not linear playback:

- reverse;
- an active remap;
- Frame Blending or Optical Flow with a speed or frame-rate change;
- VFR media;
- Frame Sampling whose pictures do not start on media frames (`samplesOnFrameGrid`): a media frame rate other than
  the sequence's that is not a whole-frame step (29.97 → 30, 23.976 → 24, 25 → 30, 30 → 29.97; 60 → 30 stays
  linear), a speed that is not a whole number of media frames per sequence frame, an in-point or a frame hold between
  media frames (§15).

The render snapshot marks it with `retime: {interpolation, mediaRate, vfr}`. Each composition frame works the same
way:

1. It computes the media time (`retimeMediaSeconds`, using the project's own model functions).
2. `pickFrames` chooses the frame(s): the last frame whose timestamp is ≤ t, plus the next one for blend/flow.
3. `FrameSource` decodes them with mediabunny. It has a GOP cache, a key-packet index and a forward iterator, so
   reverse playback decodes each GOP once.
4. `RetimeCompositor` composes them on WebGL2:
   - Frame Sampling: copy;
   - Frame Blending: linear mix;
   - Optical Flow: the same algorithm as export (§5), run in fragment shaders.

The result is drawn in the layer box or handed to the colour stage / fx picture.

- Player: while a frame is not decoded yet the Player buffers, so no stale frame is shown during playback.
- Renders: each frame holds a `delayRender` until it is drawn.
- ProRes or other originals the browser can't decode: renders read them with `<OffthreadVideo>` at the exact frame
  (Frame Sampling).
- The Program monitor decodes at ≤ 1920 px on the long side; renders decode at full size.
- Retimed layers count as frame-dependent, so the sequence re-renders them every frame.
- **Reversed audio** (`audio/reversed.ts`): Remotion's `<Audio>` can't play backwards. A reversed clip plays a WAV
  of its media range, decoded in the page and reversed sample by sample. The native export uses `areverse`.
  Channel map, levels, audio-fx effects and the audio-mix mixer apply as for any clip.
- **Remapped nests** (multicam included): the nested sequence frame is the remapped content time. They support
  Frame Sampling only.

## 4. Native export (`apps/engine/src/export/retime/`)

The `retime` native extension keeps retimed layers on the native path.

- **prepare** renders each layer into a layer-sized FFV1 BGRA intermediate, cached under `cache/retime/<key>.mkv`
  (key = media fingerprint, remap, interpolation, size, algorithm version). It uses exactly the preview's frame
  choice:
  - `plan.ts` maps each output frame to source frames and a weight, reusing the project model;
  - `frames.ts` decodes chunks with accurate seek, scaled like the builder;
  - `pool.ts` runs worker threads with the flow kernel (`flowKernelSource()`);
  - VFR frame times come from the ffprobe packet pts (cached).
- **override** hands the intermediate to the builder as the clip's `layer` source (`retimed: true`). Effects,
  Motion, opacity, masks and transitions then apply as for any video layer.
- Linear Frame Sampling (`isLinearFrameSampling`: retimed only because its pictures fall between media frames, §15) is
  not claimed: the builder draws it from the media with exact source timing, without an intermediate.

The planner refuses with a named blocker (`retimeBlocker`) only where the stage cannot help:

- remapped nests go to Remotion;
- without the stage, every retimed layer is blocked with a reason.

The `VFR_SOURCE` conform warning only appears without the stage. Audio is not remapped (Premiere).

## 5. Optical flow (`time-remap/flow.ts`, GPU port `retime/flow-gl.ts`)

The flow is a port of effectcraft `flow.rs`, with a better interpolation.

**Analysis**
- luma at ≤ 1024 px on the long side (factor k);
- ≤ 4 pyramid levels;
- 8×8 tiles; SAD search ±4, then ±1 around the doubled coarse vectors of the tile and its neighbours;
- short-vector tie bias, sub-pixel parabola, 3×3 vector median;
- computed in both directions (a→b and b→a).

**Interpolation (ours, not effectcraft's single-field cross-fade)**
- ten motion hypotheses per pixel, from both fields and their neighbours;
- each hypothesis is checked against the flow at both ends (tolerance 1 px + 0.5·|v|) and weighted by
  photometric agreement;
- occluded pixels take the side where they are visible.

The CPU kernel (`createFlowKernel`) is self-contained, so the export worker threads run the identical code.

**Measured** (`packages/project/test/time-flow.test.ts`, `packages/compositions/test/retime-gl.test.ts`):

| Check | Result |
|---|---|
| Translation 6.4 / −2.2 px | found within 0.3 px |
| 27 px motion (through the pyramid) | found within 0.5 px, both directions |
| Translation interpolation | error < ¼ of a frame mix |
| Occlusion band (moving square), mean abs error 0…1 | ours **0.0042**, effectcraft single-field **0.0070**, frame mix **0.0292** |
| WebGL2 vs CPU (headless Chrome) | vectors equal within 4e-6; pictures within 1 code value; Frame Sampling / Blending exact (±1 rounding) |

## 6. Scene Edit Detection (`time-remap/scenes.ts`, engine `time/scenes.ts`)

The detector ports effectcraft `cuts.rs`.

- Each frame is decoded with its long side at 192 px. Its signature is a 4×4×4 joint RGB histogram plus a 96 px
  luma thumbnail.
- Dissimilarity = √(half-L1 histogram distance × motion-compensated thumbnail error × 4). A pan moves the picture,
  and motion compensation keeps it far below a cut.
- A frame is a cut when its score is above the sensitivity threshold and a peak against the median of its
  neighbours. That rejects dissolves, which spread their change over many frames.
- Added beyond the references:
  - a sensitivity control, using filmcraft's 0…100 idea: threshold `0.45 − 0.4·s/100`, 0.25 at the default 50,
    effectcraft's value;
  - a flash test: frame i+1/i+2 matches i−1, or i matches i−2/i−3, so a one-frame flash is not a cut;
  - a shortest-shot merge;
  - soft (trilinear) histogram bins (verify workstream): each channel splits its weight between the two nearest bin
    centres, so the histogram distance is continuous in colour. With effectcraft's hard bins a flat area whose colour
    drifts a few levels across a bin edge moves wholesale into the next bin: the last step of the `scenes.mp4`
    dissolve onto a flat gradient (green 73 → 59 across the 64 edge) scored 0.6 histogram distance and was reported
    as a cut. Pinned by `packages/project/test/time-scenes.test.ts` (both new cases fail with hard bins).
- Frame times are the media's real timestamps, so VFR is handled.

The job is `scene-detect`, at `POST /api/scenes/detect` (`?wait=1`). The engine client calls it as `detectScenes`.

**Measured accuracy.**

| Test | Ours | effectcraft cuts.rs | filmcraft scene.rs |
|---|---|---|---|
| Synthetic reel (`time-scenes.test.ts`): 4 cuts, a flash, a dissolve, a fast pan, a lighting change | P = 1, R = 1 | P = 0.67, R = 1 (false cuts at the flash and in the dissolve) | P = 0.67, R = 1 |
| `fixtures/media/scenes.mp4` through the engine job (`apps/engine/test/time-export.test.ts`): cuts 45, 75, 120, 198 | exact, P = R = 1 | — | — |

The scenes.mp4 guards are a one-frame white flash, a 0.4 s dissolve, a 12 px/frame pan and a Mandelbrot zoom.

## 7. Variable frame rate

- Frame times are the media's real presentation timestamps:
  - preview: from mediabunny packets;
  - export: from ffprobe packet pts.
- Media time 0 is the file's start time, the same origin ffmpeg `-ss` uses.
- A VFR clip shows, at every output frame, the source frame whose timestamp is the last one ≤ the media time. This
  is Premiere's "Preserve Audio Sync" (its default for VFR with audio), and it holds in both preview and export.
- Fixture `vfr-code.mp4`: 64 frames at n/30 + 0.01·(n mod 3) s, each carrying its frame number. Preview
  (`retime-frames.test.ts`, real Chrome + mediabunny) and native export (`time-export.test.ts`) show the frame of
  each timestamp exactly.

## 8. UI (apps/web/src/time/)

- **Speed band** (`SpeedBand.tsx`, a clip decoration). Shown via clip menu ▸ Show Clip Keyframes ▸ Time Remapping ▸
  Speed, or always on remapped clips. The entry is part of edit-ux's Show Clip Keyframes menu
  (`edit-ux/menus.ts`), after Opacity as in Premiere. Choosing it hides the clip's property lane; choosing a property
  hides the band (remapped clips keep it). The scale is logarithmic, ±3 octaves around the 100 % line (our choice; Adobe
  does not document its scale). Gestures follow the Premiere CS6 reference:
  - drag up/down to change the segment speed (Shift: 5 % steps);
  - Ctrl/Cmd-click to add a keyframe;
  - drag a keyframe to split it into a ramp; Alt-drag to move it;
  - Ctrl-drag for a palindrome reverse; Ctrl+Alt-drag for a freeze;
  - Delete removes a keyframe;
  - reverse segments show `<` ticks, holds show `|` ticks.

  Every drag is one gesture, so one undo step.
- **Effect Controls ▸ Time Remapping** (`TimeRemapSection.tsx`):
  - Speed at the playhead. It is editable; in Premiere it is read-only, and editing it here sets the segment speed.
  - Stopwatch: off removes the remap.
  - Keyframe navigation and the keyframe list with transitions.
  - Time Interpolation.
  - A note on linked audio: it keeps playing at 100 % (Premiere). Buttons mute or unlink it.
- **Clip context menu:**
  - Show Clip Keyframes ▸ Time Remapping ▸ Speed;
  - Remove Time Remapping;
  - Time Interpolation ▸ Frame Sampling / Frame Blending / Optical Flow;
  - Scene Edit Detection…, which opens a dialog (`SceneDetectDialog.tsx`) with Premiere's three outputs plus
    Sensitivity and Shortest shot. It shows progress and can be cancelled.
- **Clip ▸ Video Options ▸ Time Interpolation** in the menu bar.
- Remapped clips show "(time remapped)" after the name, and the filmstrip shows remapped frames.
- No shortcuts are bound: Adobe's default list has none for these commands. Speed/Duration (Ctrl+R) and Rate
  Stretch (R) belong to edit-ux.

## 9. Agents (MCP `apps/mcp/src/tools/time.ts`)

The tools are:

- `get_time_remap`, `set_time_remap`;
- `set_segment_speed`, `add_speed_keyframe`, `remove_speed_keyframes`, `move_speed_keyframe`;
- `set_speed_transition`, `add_freeze_segment`, `add_reverse_segment`;
- `set_time_interpolation`;
- `detect_scene_edits`, which runs the engine job and applies the results in one undo step.

All have strict inputs and are covered by the `TIME_GUIDE` resource text. Every command is also in
`describe_commands`.

## 10. Interchange (`packages/interchange`)

The model carries `IClip.timeMap` (clip time → content time, linear or smooth points) and `frameSampling`. Support
by format:

| Format | Time Remapping | Time Interpolation |
|---|---|---|
| Jasper JSON | exact | exact |
| FCPXML | `timeMap` / `timept` (`smooth2` for ramps); round trip exact for maps written here | `frameSampling` (none / `frame-blending` / `optical-flow`) |
| FCP7 XML | Time Remap `graphdict` (`when` = content frames, `value` = source frames) | `frameblending`; Optical Flow is written as blending (reported) |
| OTIO | in the clip's `metadata.jasper` only (OTIO has no time map) | metadata |
| EDL / AAF | average speed, loss reported | — |

The `prerender` reason is "time remapping". Reading converts a foreign smooth piece to the nearest symmetric
transition and reports `approximated`.

## 11. Verified behaviour

| Area | How it was verified |
|---|---|
| Model and commands | `packages/project/test/time-remap.test.ts`, `time-commands.test.ts` (curve, ramps keep anchors, edits keep untouched frames, next-clip clamp vs ripple, undo/redo, refusals, repair, paste attributes, scene edits in one step) |
| Preview frame choice | `packages/compositions/test/retime-frames.test.ts` (real Chrome + mediabunny: CFR forward/backward/random, reverse across GOPs, VFR timestamps) |
| GPU = CPU | `retime-gl.test.ts` (§5) |
| Native export | `apps/engine/test/time-export.test.ts`: reverse, remap (50 % + freeze + palindrome), VFR, Frame Blending at 50 %, Optical Flow, scene job |
| Native and Remotion exports, same sequence | `apps/engine/scripts/verify-time.ts` against a live engine (720p sequence: reversed clip 0–29, remapped 30–101 with 50 % / freeze / reverse, VFR clip 102–151; every frame's code read with ffmpeg): native **152/152**, Remotion **152/152** (`cd apps/engine && pnpm exec tsx scripts/verify-time.ts --engine http://127.0.0.1:<port>`) |
| Real app | `e2e/time.spec.ts` (built app, Chrome): band drag → slower, one undo step; Time Interpolation menu; Effect Controls section; Program monitor shows `floor(t·0.5)`-th source frames; native export shows the same frames; Scene Edit Detection dialog cuts scenes.mp4 at its 4 cuts in one undo step. **5/5 pass** (`E2E_PORT=<port> pnpm e2e e2e/time.spec.ts`). |
| Frame-rate conform (§15) | `packages/project/test/fps-conform.test.ts` (the rule per rate pair, fast-check against rational floor, `samplesOnFrameGrid`, the snapshot); `apps/engine/test/fps-conform-native.test.ts` (native frame codes = rule for 29.97 → 30, 23.976 → 24, 25 → 30, 60 → 30, 30 → 29.97, an in-point, 70 %, a hold; filters; untagged matrix); `apps/engine/test/fps-conform.e2e.test.ts` (REMOTION_E2E=1: native, hybrid, Remotion and preview stills, and the colour of four colour encodings) |
| MCP / web / interchange | `apps/mcp/test/time.test.ts`, `apps/web/test/time.test.ts`, `packages/interchange/test/time.test.ts` (FCPXML / FCP7 / Jasper round trips, OTIO metadata, EDL loss report) |

## 12. Comparison with the references

| | effectcraft | filmcraft | JasperEditor |
|---|---|---|---|
| Time remap | AE-style Time Remap property (`layer_time.rs`) | intrinsic Time Remapping effect with a keyframable Speed (±10,000 %); `crates/render` does not read it (only FCP7 interchange does) | Premiere speed keyframes with eased ramps, freeze and palindrome reverse segments, next-clip clamp, the speed band with Premiere's gestures |
| Optical flow | block flow, single-field cross-fade | Optical Flow renders as Frame Blending (`render/src/lib.rs` TODO) | block flow (ported) + multi-hypothesis occlusion-aware interpolation: occlusion error 0.0042 vs 0.0070; identical on GPU (preview) and CPU (export) |
| Scene detection | cuts.rs (no sensitivity, no flash guard) | grid / histogram difference with sensitivity | effectcraft measure + sensitivity + flash test: P = R = 1 where both references score P = 0.67 |
| VFR | no VFR handling found (frames by nominal rate) | no VFR handling found | timestamp-exact in preview and export |
| Reverse audio | — | reversed in its renderer (`render/src/audio.rs`) | reversed in preview, Remotion and native |

## 13. Adobe sources (research, §3b)

- *Premiere Pro CS6 reference* (https://help.adobe.com/archive/en/premiere-pro/cs6/premiere_pro_reference.pdf,
  pp. 377–383; the CC 2014 PDF has the same text). Used for:
  - the band, keyframes, splitting into transitions, Alt-drag move, Shift 5 % steps;
  - lengthening "will not overwrite an adjacent clip … pushes remaining frames into the tail";
  - Ctrl-drag palindrome reverse "at full speed", Ctrl+Alt-drag hold;
  - linked audio stays at 100 %;
  - "Time Remapping performs an edit"; turning the stopwatch off deletes the keyframes;
  - frame blending on frame-rate mismatch.
- helpx (via r.jina.ai; the old `/premiere-pro/using/` URLs now 404):
  - `…/premiere/desktop/edit-projects/change-clip-speed/change-clip-speed-and-duration-using-time-remapping.html` (Show Clip Keyframes ▸ Time Remapping ▸ Speed, band drag, tool tip);
  - `…/remove-time-remapping-from-a-clip.html` (duration returns to its original length);
  - `…/apply-time-interpolation-methods-to-adjust-clip-speed.html` (the three modes' descriptions);
  - `…/organize-media/file-organization/freeze-a-frame-for-a-portion-of-a-clip-using-time-remapping.html`;
  - `…/change-clip-sequence/detect-edit-points-using-scene-edit-detection.html` (the three outputs, Analyze, linked audio is cut too);
  - `…/get-started/keyboard-shortcuts/default-keyboard-shortcuts.html` (Speed/Duration Ctrl+R, Rate Stretch R, nothing for remap, holds, reverse).
- Adobe blog, Premiere Pro 14.0 (2019-11-04): Time Remapping up to 20,000 %.
- Adobe community FAQ "How to work with variable frame rate (VFR) media in Premiere Pro" (Preserve Audio Sync /
  Smooth Video Motion).

**Undocumented by Adobe; our choices:**

- effect keyframes stay in timeline time;
- Speed/Duration and Rate Stretch on a remapped clip scale the remap (`speed.rate`);
- the band's scale;
- the ramp's ease curve (a smooth S, `ease` 0…1 for linear…S);
- the Speed field in Effect Controls is editable;
- Scene Edit Detection's sensitivity (Adobe has none; filmcraft does) and its undo granularity (one step);
- trackers are refused on remapped clips;
- remapped nests use Frame Sampling.

**Fixed along the way** (found by the live checks above):
- Retimed layers were not frame-dependent, so Remotion reused their first frame. Now every frame re-renders.
- The first frame of a retimed layer on each render tab could be captured before the decoder existed. A
  `delayRender` now holds from the first render until the first picture is drawn.
- The timeline context menu (every clip, track and transition menu) is `fixed` inside the docked panel, so it
  opened offset by the panel's position. It is now in a portal.
- Show Clip Keyframes ▸ Time Remapping ▸ Speed did not re-render the memoised clip views. The decoration is now
  re-registered whenever the band set changes.

## 14. Limits

- Nests (and multicam) support Frame Sampling only, and remapped nests export through Remotion (native planner
  blocker).
- Clips with a tracker can't be remapped, and vice versa. Roto objects work on remapped clips: their mattes are
  media frames, and both the fx stage and the export check sample them at the media frame of the picture shown
  (frame hold, then the remap; `packages/project/test/roto.test.ts`).
- OTIO keeps the remap in metadata only. EDL/AAF get the average speed and report the loss. FCP7 writes Optical
  Flow as frame blending.
- Audio is never remapped (Premiere); a reversed clip's audio is reversed.
- The Speed/Duration dialog belongs to edit-ux.
- Not tested on Windows or macOS.
- Optical flow cannot follow motion beyond the pyramid's search reach (≈ 60 px per frame at analysis scale: radius 4
  over 4 levels), as in effectcraft; such motion shows interpolation artefacts.

## 15. Frame-rate conform: which source frame each sequence frame shows

**Rule** (the time model; nothing else defines it): sequence frame `f` of a clip shows content time
`content(f) = sourceIn + (f − start)·F·speed` (S01:CLP-004; the held time under a frame hold), and the picture is
*the source frame that contains it* — nearest-earlier sampling (CLP-004), the last frame whose timestamp is ≤ the media
time within `FRAME_TIME_EPS` = 2 µs (`frameIndexAt` / `pickFrames`, §3, `time-remap/sampling.ts`). It is not ambiguous,
and it is what the preview's retime pipeline already drew, so no choice had to be made; the consequences for the
common pairs (`packages/project/test/fps-conform.test.ts`, plus a fast-check property against exact rational floor
over all allowed rates):

| Media → sequence | Frames shown |
|---|---|
| 29.97 → 30 | 0, 0, 1, 2 … (f − 1), 1000 twice at 1001–1002, then f − 2 … |
| 23.976 → 24 | the same shape |
| 30 → 29.97 | f until 999, then 1001: one frame in 1000 skipped |
| 25 → 30 | 0, 0, 1, 2, 3, 4, 5, 5, 6 … (every fifth frame twice, at the containing frame) |
| 60 → 30 | 0, 2, 4 … |

**What was wrong** (reproduced on the build VM with `scripts/fixtures/fpsmap.mjs`: 640 × 360 H.264 sources at 23.976,
24, 25, 29.97, 30 and 60 fps carrying a 12-bit frame code and 16 colour patches, exported at crf 12 and read back with
ffmpeg; `apps/engine/test/fps-conform.e2e.test.ts`):

- **Native**: input seek to `content(f0)`, `setpts=PTS-STARTPTS`, `fps` rounding to the *nearest* slot. Accurate seek
  drops the frame that contains the seek point, so after a seek the layer started one frame late, and rate changes
  showed the nearest frame instead of the containing one.
- **Remotion / hybrid / Program preview** (`<Video>` of `@remotion/media`): linear playback picks a frame with a
  millisecond-scale tolerance (≈ 1–2 ms in 4.0.499), so where `content(f)` lies just before a frame (29.97 → 30 for
  f ≤ 60, 30 → 29.97 for 970 ≤ f mod 1000) it showed the next frame.

Before (frames that differ from the rule; native = the builder before the fix, the others = what Remotion drew):

| Case (frames) | native | hybrid | Remotion | preview still |
|---|---|---|---|---|
| 29.97 → 30 (1040) | 537 (first 1, 2, 3…) | 60 (1…60) | 60 (1…60) | frames 1–6 showed f, not f − 1 |
| 29.97 → 30, in-point 37 at frame 5 (90) | 90 (every frame one late) | 0 | 0 | = model |
| 23.976 → 24 (850) | 499 | 24 | 24 | — |
| 25 → 30 (120) | 40 (1, 2, 7, 8, 13, 14 …) | 0 | 0 | = model |
| 60 → 30 (120) | 0 | 0 | 0 | = model |
| 30 → 29.97 (1040) | 500 (from 500) | 30 (970…999) | 30 (970…999) | — |
| 30 → 30, in-point 11 at frame 3 (60) | 0 | 0 | 0 | = model |
| 30 → 30 at 70 % (90, native only) | 27 | | | |
| 29.97 → 30 held at frame 7 (30, native only) | 30 (showed 7, rule 6) | | | |

Sample (29.97 → 30, frame: rule / native / hybrid / Remotion / preview): 1: 0/1/1/1/1, 2: 1/2/2/2/2,
1002: 1000/1001/1000/1000/–. 30 → 29.97 at 500: 500/501/500/500/500.

**Fix.**

- *Model* (`time-remap/model.ts`): `samplesOnFrameGrid` and a new branch in `needsRetime`. Frame Sampling clips whose
  pictures do not start on media frames get `retime` in the render snapshot. Linear playback is exact only on the
  grid (same rate or whole-frame steps, in-point and hold on a frame). The compositions (Program monitor, Remotion
  exports, layer bakes) then pick the frame with `frameIndexAt` through the existing retime pipeline (§3). The render
  bar counts these layers as "retimed frames" (+5 ms per megapixel in `previews.ts`'s cost model, an estimate).
- *Native* (`export/native.ts`): `seekWindow` seeks two media frames early (at least 0.25 s, so the frame containing
  the start survives the accurate seek). `sourceTimingFilters` (`settb=AVTB`, `setpts=(PTS − lead)/speed − 2 µs`,
  `fps=…:round=up:start_time=0`) shows each slot's latest frame at or before it, the nested-sequence mapping already
  in the builder. It is used for media, processed intermediates with a content origin, and frame holds; the
  VP8-alpha decode-from-start path too. The retime stage does not claim these clips (`isLinearFrameSampling`), so they
  need no FFV1 intermediate.
- After: **0 frames differ** on every path and in every preview still for all the cases above, native, hybrid and
  Remotion (`fps-conform.e2e.test.ts`, 11/11, REMOTION_E2E=1; `fps-conform-native.test.ts`, 12/12 in the default
  suite, which fails 9 of its cases and both filter tests on the old builder).

**In the running app** (dev stack on the VM, the editor in a separate SwiftShader Chrome): a 720p 30 fps sequence with
`rate-code-2997.mp4` at 200 %. The Program monitor drew the layer through the retime pipeline (`canvas[data-retimed]`).
Its codes at frames 0, 1, 2, 3, 30, 31, 60, 61, 1001, 1002, 1003 were 0, 0, 1, 2, 29, 30, 59, 60, 1000, 1000, 1001,
the rule's frames. Playback advanced 144 frames in 5.0 s (≈ 29 fps, indicative only: not a benchmark, shared host).
The patch colours equal the headless renderer's, including the blue deviation below (green patch 40,201,47).

**Colour.** Patch means at frame 10 (8-bit R'G'B', patch interiors), before:

| Source | preview (Chrome) | native | Cause |
|---|---|---|---|
| BT.709 tagged (SD or HD) | B off by up to 9 on saturated patches (green 40,200,40 → B 47; blue → 191) | within 1.7 of the source | Chrome's software YUV → RGB (libyuv): B = … + 2.0·(Cb − 128) instead of BT.709's 2.112; predicted −0.112·(Cb − 128) matches every patch within 1 level |
| BT.601 encoded, **untagged**, 640 × 360 | decoded with **BT.709**: red 200,40,40 → 213,55,39 (25 levels) | decoded with BT.601 (the old rule below 720 lines) | matrix assumption |
| BT.601 tagged (SMPTE 170M) | within 2 | within 3 | none |
| BT.709 untagged 1280 × 720 | as tagged BT.709 | within 2 | none |

Range, transfer and chroma siting were ruled out: the grey wedge (0…255) is within 1 level on every path (no
limited/full or curve error), and the differences sit in flat patch interiors (no siting effect).

- *Untagged media* now decode with BT.709 at every size on the native path (`inColor`, also the gaps proxy job that
  shares it) — what Chrome does, so preview and export agree. It is a choice: ffmpeg and many NLEs assume BT.601 below
  720 lines. The preview cannot be made to decode untagged SD as BT.601 (the matrix is the browser decoder's), and the
  WP-2F note already took "browser behaviour" as the rule for untagged HD.
- *The libyuv blue deviation* is not reproduced in the export. It belongs to Chrome's software conversion: measured
  in headless renders and in the Program monitor of a SwiftShader Chrome; a GPU Chrome may convert exactly (not
  measured). Native stays exact; Remotion and hybrid inherit it.

After (`fps-conform.e2e.test.ts` asserts these):

- hybrid and Remotion are within 3 levels of the preview on every patch;
- native is within 3 levels of the preview in R and G, and in B within the predicted libyuv offset + 3;
- native is within 3 levels of the source for the tagged files and untagged HD.

Whole frames, native export against the Remotion / hybrid export (both 4:2:0):

| Source | PSNR (dB) | max | p99 |
|---|---|---|---|
| BT.709 | 41.9 / 41.2 | 29 / 28 | 11 / 12 |
| untagged BT.601 SD | 41.1 / 40.8 | 25 | 11 / 12 |
| BT.601 tagged | 44.0 / 43.4 | 24 / 30 | 9 / 11 |
| untagged HD | 39.8 / 40.1 | 35 / 33 | 15 / 14 |

These are within `Tolerance.BROWSER`'s PSNR ≥ 36 dB and max ≤ 64 (asserted). Its p99 ≤ 6 is exceeded on this chart:
the 1 % worst pixels are the sharp saturated patch and code edges, where Chrome's and swscale's 4:2:0 chroma
upsampling differ, plus the blue deviation. Measured on this chart only; natural footage has far fewer such edges,
and `e2e/apply-style.spec.ts` compares a native reference with a Remotion export again.

**Conditions.** Build VM `6b922ed28e39`: 16 vCPU AMD EPYC-Rome, 30 GB, shared with other agents (load average
5–18 during the runs). LGPL FFmpeg n7.1.5 (`JASPER_FFMPEG_LGPL_ONLY=1`; Remotion exports are a ProRes intermediate
encoded with OpenH264), Remotion 4.0.499, headless Chrome for Testing (Playwright's build). No timing claims. The
conform e2e took 380 s of wall time for 21 exports and 52 stills.

**Limits.**

- Frame-rate-converted, sped-up / slowed-down, off-grid and off-grid-held clips now play through the retime pipeline
  in the Program monitor: frame-exact, but they decode through mediabunny instead of `<Video>`. Playback cost was not
  benchmarked; the render bar's estimate rises (+5 ms/MP).
- An untagged SD file that was encoded with BT.601 is shown with BT.709 everywhere, and there is no matrix override
  in Interpret Footage ([gaps.md](../gaps.md) color-mgmt).
- Saturated blue/yellow content in Remotion and hybrid exports carries Chrome's B deviation (≤ 0.112·|Cb − 128|,
  ≤ 12.5 levels at full saturation); native exports don't.
