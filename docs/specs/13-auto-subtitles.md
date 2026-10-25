# Spec 13: Automatic subtitles as editable text, templates, multi-clip styling and cut-aware timing

Status: specified 2026-10-25; implementation tracked in [`docs/ledgers/premiere-workflow.md`](../ledgers/premiere-workflow.md).
Owner wp-note: `docs/wp-notes/auto-subtitles.md` (created by the implementation). [`ARCHITECTURE.md`](../ARCHITECTURE.md)
and [`AGENTS.md`](../../AGENTS.md) win over this spec. §2 defines services shared with
[spec 14](14-transcript-cleanup.md) and [spec 15](15-edit-automation.md).

## 0. Background

Measured on the user's 29 caption projects (10,816 captions, 59.94 fps; private research
`.prproj-analysis/research/subs`): Premiere Speech-to-Text → Create Captions → style → Upgrade to Graphic → nest;
workarounds to move and animate all captions at once (cut the nest into pieces; apply saved effect presets to every
graphic). Captions are 1–3 words (99.6 %), one line, median 8 characters (limit ≈ 13), median 25 (shorts) / 29 (long)
frames, gap 0 (99.7 %; empty placeholders fill pauses). Style (2025): Pixel12x10, white fill, #AE00FF outside stroke
(≈ 11.5 px at 1080), #221D58 shadow at 80 % (soft, distance 0), ≈ 98 px on screen, centred at y 0.50 (shorts) /
0.83 (long), box 75 % of the frame width; pop-in = uniform scale 75 % → 108 % at frame 6 → 100 % at frame 10 + opacity
0 → 100 % in 3 frames, linear, motion-blurred; S_Shake on every caption (Amplitude 0.6, Frequency 1, random amplitude
X/Y/Tilt 72/36/5). Caption starts exactly on the cut for 61 % (shorts) / 35 % (long) of cuts (hand-aligned; chance
< 1 %); 1.8–4.2 % of captions run across a cut; the first word after a cut starts a median 9–11 frames later. The
user's complaints: Premiere put a caption 27 frames before a cut; phrases ran across cuts; Premiere can't restyle many
graphics at once.

JasperEditor today: caption tracks (word timing, karaoke, presets, sidecar export; no effects or animators) and text
clips (effects, masks, animators; no style presets, no subtitle export) are separate; `transcript.createCaptions`
outputs only caption tracks with rules {maxChars 42, lines 2, min 1 s, max 7 s, gap 0, break pause 1 s} and ignores
picture cuts; Properties multi-edits built-in text fields with mixed values in one undo step but has no shadow rows
and no multi-clip effect editing (Effect Controls = primary clip only); only `strokes[0]` is rendered, the shadow is
one CSS text-shadow without spread; no text measurer is wired (0.55 em per character estimate); each text clip is its
own export bake.

Premiere/competitors: Premiere Create Captions has max length 42 (7–72), min duration 3 s (1.2–6), gap 0–10 frames,
single/double lines, a "Single Word" layout (26.3) without animation, Upgrade Caption to Graphic; nobody snaps captions
to cuts (Netflix's guide: start on a shot change when speech begins within 0.5 s after it; end 2 frames before a cut
when ending within 0.5 s of it). CapCut/Descript/Submagic/Captions.ai offer templates with word highlight and
animation, words-per-line, emoji.

## 1. Goals
- G1 Create subtitles with Premiere-like rules plus the options this user needs (max words, hold until next, cut
  awareness), as **normal editable text clips** by default (and caption tracks when sidecar subtitles are wanted),
  converting both ways.
- G2 **Templates** that carry style, layout, animation and effects — including one recreating the user's style
  ("Pixel Pop") — applied to a subtitle group in one undo step and saved from any styled clip.
- G3 **Style many text clips at once** (text style, shadow, strokes, effects and their keyframes) with mixed-value
  display and one undo step; persistent **linked styles** so later style edits update every linked clip.
- G4 **Cut-aware timing**: never run a subtitle across a cut; start a subtitle on a cut that falls just before it;
  split phrases at cuts; handle transitions; automatic and on demand ("Align Subtitles to Cuts").
- G5 Fast and faithful preview/export for ~100 (shorts) and ~1,000+ (long) animated subtitle clips.
- G6 Fully drivable by AI agents (MCP) with dry-run statistics.

## 2. Shared services (used by specs 13–15)
- SH-001 **Cut map** `pictureCuts(doc, sequenceId, opts)` (pure, `packages/project/src/structure/cuts.ts`): returns
  `{frame, kind: 'cut'|'jump'|'overlay', trackId, outgoingClipId?, incomingClipId?, transitionId?, zone?: {start,end}}`
  for every frame where the topmost visible full-frame content changes below an optional output track: different
  sources, jump cuts (same source, discontinuous), overlays covering ≥ `overlayCoverage` (50 %) of the frame. Looks
  inside nests (depth ≤ 8, cycle detection, speed mapping); excludes through edits, hidden/disabled tracks, adjustment,
  text, shape and caption clips, and one-sided transitions; a two-sided transition contributes its edit point and its
  span as a cut zone. Rational frame rates (60000/1001). Property tests: cuts sorted, unique, inside the sequence.
  MCP `list_cuts`.
- SH-002 **Schema v9** (one coordinated bump, done first by the coordinator): optional, lenient fields with invariants
  and `repairDocument`, documented under "Fields added in v9" in `docs/project-files.md`: `TextClip.caption?`,
  `Sequence.captionGroups?`, `ProjectDocument.textStyles?` + `TextClip.styleId?` + `styleOverrides?`,
  `ProjectDocument.subtitleTemplates?`, `Sequence.cleanup?` (spec 14), `ProjectDocument.styleRecipes?` (spec 15),
  `TextStyle.shadow.spreadPx?`, `TextStyle.strokes[]` fully honoured, `Clip.automation?: {feature, pass, seed}`
  provenance. Older builds open v9 read-only.
- SH-003 **Batch styling commands**: `text.setStyle {clipIds | groupId, patch (deep, per field), runs: 'keep' |
  'clear-overridden'}` (atomic, re-layout, refuses non-text clips naming them); `effect.setParamMany {targets:[{clipId,
  effectInstanceId}] | {clipIds, effectId, occurrence}, param, value | keyframes(relative to each clip's In)}`;
  `effect.addMany` / `effect.removeMany`; all one undo step each; undo/redo/refusal/invariant tests.
- SH-004 **Text rendering upgrades** (every path, preview and export identical; planner refusal for anything a path
  can't render): all `strokes[]` with inside/centre/outside positions; shadow with `spreadPx` (and blur, distance,
  angle, opacity) — implemented as a pre-blurred dilated alpha (not CSS `text-shadow` alone); a real **text measurer**
  in the editor session and headless (engine/export) so boxes, anchors and backgrounds follow glyph metrics.

## 3. Requirements

### 3.1 Generation
- AS-001 `captions.generate {sequenceId, source: 'sequence-transcript'|{mediaId}|{clipIds}, range?, output:
  'text-clips'|'caption-track', trackId?, template?, rules, text, cutAware, dryRun}` → creates the subtitles in ONE
  command/undo step (no 5,000-command issue) and returns stats {count, snappedToCuts, splitAtCuts, belowMinimum,
  merged, warnings}. Pure layout in `packages/project/src/captions/` reusing `captionBlocks`/`sequenceWords`.
- AS-002 Rules (dialog + command + MCP): max characters per line (7–72), lines (1–3), **max words per caption**
  (off / 1–20), min duration (0.1–10 s), max duration, gap between captions (0–30 frames), break at a pause ≥ X s,
  **hold until next caption** (off / up to X s), break at punctuation (never / when half full / always), case (as
  spoken / UPPER / lower / Sentence), strip trailing punctuation, replace glyphs the chosen font lacks (… → ..., “” →
  "), profanity mask (optional list). Generic defaults = Premiere-like (42 / 2 / off / 1 s / 7 s / 0 / 1 s / off /
  half full / as spoken). Defaults for the "Pixel Pop" template = the user's measured style (13 / 1 / 3 / 0.2 s / 2 s
  / 0 / 0.3 s / 0.5 s / always / as spoken / off / on).
- AS-003 Output = text clips: on a new top video track "Subtitles" (or a chosen track), one text clip per caption,
  `TextClip.caption = {groupId, words:[{text,start,end}], speaker?}`, member of a `Sequence.captionGroups[groupId]
  {name, templateId?, rules, language, cutAware, sourceRef}`; linked to the template's text style (SH-002 `styleId`).
  Option "Nest subtitles" (off by default, with a warning that nests don't follow later ripple edits).
- AS-004 Output = caption track: today's behaviour, now honouring the template's caption style and the same rules.
- AS-005 Conversion: `captions.convert {groupId|clipIds|captionTrackId, to: 'text-clips'|'caption-track'}` keeps words,
  timing, text and style where representable; reports what can't be represented (effects, animations) going to a
  caption track. Subtitle export (SRT/VTT) also works directly from a text-clip caption group.
- AS-006 Editing integrity: razor through a caption text clip divides its words (and rebuilds each half's text); text
  edits re-time unchanged words; ripple edits move subtitles as ordinary clips (sync lock); `captions.regenerate`
  rebuilds a group (or a range) from the current transcript keeping manual style overrides where clips still match.

### 3.2 Cut-aware timing
- AS-010 Algorithm (applied after grouping words and before duration/gap rules; uses SH-001 below the output track):
  1. **Split at cuts**: for each cut inside a caption, assign words by midpoint; words on both sides → two captions
     `[start, cut)` + `[cut, end)`; all words on one side → move the boundary to the cut; a word straddling the cut
     goes to the side holding most of its duration.
  2. **Start on cuts**: if a cut is ≤ `lookBack` (0.5 s) before a caption start and the previous caption has no words
     after the cut, start the caption on the cut (ending the previous one there); if a cut is ≤ `lookAhead` (0.05 s)
     after the start, move the start to the cut.
  3. **End on cuts**: a caption with no words after a cut ends on it; a hold never continues past a cut.
  4. Priorities: never cross a cut > exact cut alignment > minimum duration > gap; a piece made too short is extended
     away from the cut if possible, else kept and reported; wordless hold pieces < 3 frames are dropped.
  5. **Cut zones** (two-sided transitions): boundaries snap to the edit point; a caption may run through a zone only
     if it started before the transition; cuts closer than the minimum duration merge into one zone (reported).
  6. Then min/max duration, gap, hold, frame snapping.
- AS-011 Options: cut awareness on/off; lookBack / lookAhead; which tracks define picture (default: everything below
  the output track); overlay coverage threshold; transition behaviour (snap to edit point / avoid zone).
- AS-012 **Align Subtitles to Cuts** (`captions.alignToCuts {groupId|clipIds, options}`): re-run steps 1–5 on existing
  subtitles after later edits, one undo step, with a report.
- AS-013 Edge-case tests: cut on a caption's first/last frame, several cuts in one word, locked output track, output in
  a nest (map parent cuts, warn), reversed/time-remapped A-roll (skip, report), 23.976/25/29.97/59.94/60 fps, speaker
  change at a cut, cut during a pause, caption emptied by a split, transitions < 3 frames, overlays below the threshold.

### 3.3 Templates
- AS-020 Template = text style (incl. strokes, shadow spread, background), box (% of frame width), position per aspect
  ratio (16:9, 9:16, 1:1, 4:5), animation (in/out text animation or keyframes anchored to each clip's In, in seconds —
  re-anchored after trims), effects (+ keyframes), default rules, text transforms, highlight (none / active word /
  karaoke / keywords). Stored in the user library (atomic, zod, repair) and copied into the project
  (`subtitleTemplates`) when used; "Save as Template…" from any styled text clip; apply to a group/selection in one
  undo step; built-ins use bundled licence-safe fonts only and neutral names.
- AS-021 Built-in templates: **Pixel Pop** (the user's 2025 recipe: font family "Pixel12x10" resolved through the font
  library — falls back to the default with a visible "install font" notice when not installed; values from §0; pop-in
  keys scale 75 % @0 → 108 % @0.100 s → 100 % @0.167 s, opacity 0 → 100 % @0.050 s, linear, Transform shutter 360°;
  S_Shake Amplitude 0.6, Frequency 1, random amplitude calibrated from the user's 72/36/5 — calibration method and
  result recorded in the wp-note), **Pixel Pop Classic** (2024 recipe: 130 px, 30 px stroke, scale 0.1 → 100 % over
  0.083 s with full ease-in, no shake), and generic **Subtitles**, **Bold Pop**, **Word Highlight**, **Karaoke**,
  **Minimal**, **Lower Third**.
- AS-022 Template preview in the dialog (rendered frame of the first caption) and live counts.

### 3.4 Multi-clip styling (UI)
- AS-030 Properties: when several text clips are selected, every text row (font, size, weight, fill, strokes list,
  shadow incl. spread, background, box, alignment, tracking, line height, caps) shows shared values or mixed ("–",
  split swatch, "Mixed"); scrubbing a mixed number applies a relative change, typing sets all; one History entry
  ("Stroke Width (108 clips)").
- AS-031 Effect Controls "N clips" mode: lists effects shared by all selected clips (matched by effect id +
  occurrence); editing a param sets every matching instance; keyframed params edit "relative to each clip's In"; add /
  remove an effect on all; no mini-timeline in this mode.
- AS-032 Selection helpers: Select ▸ Subtitle Group, Select ▸ Same Style, Select ▸ Same Template; Linked styles:
  editing the project text style updates all linked clips; "Detach" / "Reset to style" per clip.
- AS-033 MCP `style_text {clipIds | $selection | groupId, style, effects}`, `list_text_styles`, `create_text_style`,
  `apply_text_style`, `apply_subtitle_template`.

### 3.5 Dialog, panels, MCP
- AS-040 Create Subtitles dialog (Text panel and Captions menu): source, output, template, rules (two columns: generic
  / template defaults), cut awareness options, language, live preview + counts (captions, snapped, split, below min),
  Create. Captions/Subtitles panel lists a group's clips (virtualised for 2,000+ items), edit text inline.
- AS-041 MCP: `captions_from_transcript` gains `output`, `template`, `rules` (all of AS-002), `cutAware`, `dryRun`;
  `align_captions_to_cuts`, `convert_captions`, `list_caption_groups`, `regenerate_captions`, `list_cuts`; guide
  resource updated with the recommended agent flow (transcribe → clean up (spec 14) → create subtitles with a template
  → align to cuts after edits).
- AS-042 i18n English + Spanish; Spanish line-breaking rules (don't end a line on articles/prepositions when avoidable).

### 3.6 Performance and export
- AS-050 Preview: 1,200 animated subtitle clips scrub and play at the sequence rate on the build VM's Chromium (measure;
  document); the timeline and panels stay responsive (virtualisation where lists exceed 500 items).
- AS-051 Export architecture: defined from the textperf measurements (§4, filled in before implementation starts) — the
  per-clip bake model must be replaced or batched so a 10-minute 1080p video with ~1,200 animated subtitles exports in
  a time comparable to the same video without subtitles plus a bounded overhead, with bounded memory (no per-clip
  ffmpeg input growth), on every export path, with preview-vs-export pixel parity tests.

### 3.7 Validation
- AS-060 Unit/property tests (rules, cut algorithm, conversion round trips, template application, linked styles),
  command tests (undo/redo/refusals/invariants), schema v9 fixtures and repair tests, renderer parity tests for strokes
  and shadow spread (preview vs every export path), e2e: Create Subtitles with Pixel Pop on a generated video with cuts
  → verify cut alignment frames and export frames; multi-clip styling e2e (select 100 subtitles → change stroke →
  one undo step).
- AS-061 Accuracy harness (private): run generation + cut alignment on the user's decoded projects' transcripts and cut
  maps; report how often our captions start on the user's cut frames vs the user's own (target ≥ 95 % of cuts with
  speech within 0.5 s get a caption start on the cut; 0 captions across a cut).

## 4. Export architecture (from the textperf measurements, 2026-10-25)

Measured on the build VM (16 shared vCPU, 30 GB, no GPU; private `research/textperf`): the hybrid composite opens one
ffmpeg input per text clip — ≈ 205–230 MB RSS per animated caption, ≈ 40 MB per static one, throughput 242 fps at 99
inputs → 17 fps at 1,000; 99 animated captions peak at 19–25 GB, 240 were OOM-killed at a 22 GB cap, 1,000 would need
≈ 220 GB. Each caption is its own Remotion render (static ≈ 3.4 s, almost all fixed setup; animated ≈ 8.1–8.5 s, 6 in
flight). Short (99 captions): no text 29 s / 1.3 GB; static 97 s / 10.8 GB; pop 183 s / 19 GB; pop + 22 S_Shake 194 s /
25 GB; forced Remotion 365 s / 10.9 GB. Long 2-min slice (240 captions): only the Remotion path finishes (843 s, 8.3 GB
→ ≈ 63 min for 9 min). Caption-track items and nests don't help (same per-item bakes). One run killed the engine
process itself mid-export (crash path). Prototype without code changes: bake the pop as a still and let the native
path draw the scale keys → short exports in 34.5 s (5.3× faster, +19 % over no text); one Remotion render for all
distinct stills: 99 captions in 9.6 s instead of ≈ 60 s. Preview with 1,080 captions in headless software Chrome:
7.5 → 2.6 fps (single noisy runs).

- AS-070 **Still + native motion**: text clips whose animation is expressible as Motion/Opacity transforms (scale,
  position, rotation, opacity keys incl. the pop-in) and whose content is static are baked once as a still (cropped
  tightly to the glyphs + stroke + shadow extent, not the current wide margin) and composited natively with their
  keyframed transform by the existing native motion kernel. Pixel parity with preview within the AGENTS §4 tolerances
  (test per template).
- AS-071 **Batched still rendering**: all distinct stills of an export are rendered in as few Remotion renders as
  possible (one page renders many stills; identical content + style shares one still across clips).
- AS-072 **Bounded composite memory**: memory must scale with what is on screen, not with the clip count: one native
  input stream per text track (an image sequence / concatenated stills timed to the track) or a composite split into
  time windows containing only the clips visible in each window. Target peak RSS ≤ 6 GB for a 10-minute 1080p export
  with 1,200 animated subtitles on the build VM (measure).
- AS-073 **Shake**: S_Shake without motion blur and RGB split is converted to deterministic per-frame transforms (same
  seed rules as the shader) and composited natively; otherwise shaken clips of a track are batched into one render per
  track. Parity test vs the shader.
- AS-074 **Preflight and robustness**: the planner estimates composite memory and routes or refuses with a named
  blocker before starting a composite that can't fit; ffmpeg OOM/kill becomes a job error, never an engine crash
  (find and fix the measured engine-killed path; regression test with a memory-capped child).
- AS-075 **Preview**: the Program monitor mounts only text clips within a window around the playhead (and caches
  rasterised stills of static subtitles), so playback with 1,200 subtitles stays within 10 % of the video-only frame
  rate on the build VM's headless Chrome (measure; record conditions).
- AS-076 **Targets** (build VM, measured before/after in the wp-note): short with 99 Pixel Pop subtitles ≤ 1.3× the
  no-text export time; 9-minute long-form with 1,080 subtitles ≤ 10 minutes and ≤ 6 GB peak RSS on every export path
  the planner chooses; second export with a warm cache ≤ the no-text time + 20 %.
