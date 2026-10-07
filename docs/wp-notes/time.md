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
Attributes are remap-aware (`clip-edit.ts`, `clip-core.ts`, `transitions.ts`, `clipboard`). The source-range
process (media management) covers the remapped media extent (`process/source-range.ts`).

## 3. Preview and Remotion renders (`packages/compositions/src/retime/`)

A video layer is *retimed* when its frames are not linear playback:

- reverse;
- an active remap;
- Frame Blending or Optical Flow with a speed or frame-rate change;
- VFR media.

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
  - a shortest-shot merge.
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
  Speed, or always on remapped clips. The scale is logarithmic, ±3 octaves around the 100 % line (our choice; Adobe
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
- Clips with a tracker can't be remapped, and vice versa.
- OTIO keeps the remap in metadata only. EDL/AAF get the average speed and report the loss. FCP7 writes Optical
  Flow as frame blending.
- Audio is never remapped (Premiere); a reversed clip's audio is reversed.
- The Speed/Duration dialog belongs to edit-ux.
- Not tested on Windows or macOS.
- Optical flow cannot follow motion beyond the pyramid's search reach (≈ 60 px per frame at analysis scale: radius 4
  over 4 levels), as in effectcraft; such motion shows interpolation artefacts.
