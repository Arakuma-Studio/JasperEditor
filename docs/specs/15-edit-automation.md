# Spec 15: Editing-pattern automation — cut kits, punch-ins, Ken Burns, reactions, music beds, style recipes

Status: specified 2026-10-25; implementation tracked in [`docs/ledgers/premiere-workflow.md`](../ledgers/premiere-workflow.md).
Owner wp-note: `docs/wp-notes/edit-automation.md` (created by the implementation). [`ARCHITECTURE.md`](../ARCHITECTURE.md)
and [`AGENTS.md`](../../AGENTS.md) win over this spec. Shared services (cut map, batch styling, schema v10) are defined
in [spec 13 §2](13-auto-subtitles.md); voice cleanup in [spec 14](14-transcript-cleanup.md).

## 0. Background

Measured on the user's 30 finished projects (private research `.prproj-analysis/research/auto`; rerunnable scripts):
the user's decorations follow a near-fixed recipe placed **on the cut frame** with fixed lengths and parameters:

- Cuts: shorts 23.8 /min (67 % jump cuts, clip median 2.1 s); long 17.9 /min (90 % jump cuts, median 3.1 s).
- Cut kits: 85.7 % (shorts) / 95.1 % (long) of cuts get one; 89.6–99 % of kits sit exactly on an A-roll cut.
  Shorts kit = S_Shake adjustment layer 10 + 10 frames around the cut (Amplitude 0.5, Frequency 6, Motion Blur on,
  Seed 0). Long-form kit = one of five families (weighted random; P(same family as the previous) 0.23):
  Jolt 49 % (10+10: Transform 300 % with 360° shutter blur, position jiggle ±1–2 %, mirror-tiled edges = 4× Mirror +
  Replicate 3), Whip 17 % (20+20: Offset wrap 0.5→0 + Directional Blur 0→270, four directions), Zoom-blur 17 %
  (20+20: scale to 160–190 % about an edge anchor + blur 0→40), Zoom-through 9 % (20+20: scale 100↔200),
  Spin 8 % (20+20: scale 300 % + rotation ±90°). Curves ≈ cubic/quartic ease-in into the cut, cubic ease-out after
  (baked one key per frame in Premiere). A whoosh of the kit's length is centred on the cut 100 % of the time.
- Punch-in zooms (long form): 9.0 /min on 49.8 % of A-roll clips: 100→180 % in 7 frames, linear, then hold to the next
  cut (97.9 %); start median at 0.50 of the clip (52 % exactly at the midpoint ±1 frame); never on clips < 1 s;
  mutually exclusive with Ken Burns; target centre 49 %, otherwise toward the speaker/avatar or an emote; phrases with
  "!" / "?" are under a zoom 55–57 % vs 29 %. Rule "midpoint of every clip ≥ 1.5 s without Ken Burns/static framing":
  F1 0.78 (recall 0.96, precision 0.66).
- Ken Burns: 13–16 % of A-roll clips; 100→115–122 % (shorts) or ≈130 % (long); keys on the clip's first and last frame,
  linear; zoom-in : zoom-out = 2 : 1.
- Reactions (emote images): shorts 6.9 /min (11–15 /min in 2025), median 2.1 s; long 0.9 /min, median 2.6 s; 63–80 %
  start on a cut; S_Shake wobble (Amplitude 0.8, Frequency 2) on 89–96 %; flipped when on the left; scale 60–65 %;
  fixed slots; words explain ≤ 30 % of placements (CTA "suscríbete/descárgalo", exclamations); inferred trigger:
  the speaker avatar is not visible.
- Overlay slides: one-sided 30-frame Smooth Slide at overlay heads (166) and tails (57); directions up 47 % / down 33 % /
  left 13 % / right 8 %; ease in-out quad/cubic.
- Music: long form ≈ 7 beds of ≈ 52 s switching on cuts (74 %), constant −33 dB clip gain, no ducking; shorts one bed,
  often −25 → −33 dB with the step at the first cut.
- Stinger: 29-frame TV-static picture after shouted punchlines with noise audio at −18 dB (15 instances).
- JasperEditor already has every building block (adjustment layers, `jasper.s.shake`, `jasper.transform`,
  `jasper.mirror`, `jasper.replicate`, `jasper.offset`, `jasper.directional-blur`, `jasper.smooth-slide`, ease presets,
  "Slow Zoom In" preset, auto-reframe saliency, face tracking, proposals); gaps: no cut enumeration API, sound-design
  cues skip plain cuts inside dialogue and have density budgets, only sound design creates proposals, no agent accept
  policy for other features, review vocabulary is sound-specific, effect presets map onto whole clips only.

## 1. Goals
- G1 Reproduce the user's editing style automatically and reviewably: decorate cuts, punch-ins, Ken Burns, reactions,
  overlay slides, music beds, stingers — each a separate **pass**, combinable through **style recipes**.
- G2 Every pass produces a **proposal** (items per cut/zoom/overlay with alternatives and deterministic "Reroll" seeds);
  accepting is one undo step; humans review in the Review panel with timeline ghosts; AI agents drive the same passes
  through MCP with dry-run statistics and may accept per project preference.
- G3 Parameters and defaults derived from the measured data; generic recipes for other users; no third-party brand
  names and no unlicensed assets shipped.
- G4 Exports stay faithful and affordable: prefer natively exportable Motion keyframes; measure and report the bake
  cost of effect kits.

## 2. Requirements

### 2.1 Proposals for new features (shared by specs 13–15)
- EA-001 Register features `edit-automation`, `subtitles`, `transcript-cleanup` with the proposal service: producers,
  accept policies (`registerPolicy`), per-project preference "Allow agents to apply <feature> proposals" (default
  **on** for these three — the user asked for agent-driven automation; edits remain undoable and labelled "Agent: …";
  destructive commands keep requiring approval as today).
- EA-002 Generic Review vocabulary: group label/order from item `meta.group` declared by the producer (not sound roles),
  feature-specific sentences via a small registry; ghosts for adjustment clips, keyframe ranges on clips, transitions
  and text clips (not only clips/tracks/cues).
- EA-003 Finer anchors: items anchor the clips they decorate (track/start/length/in) and the cut frame; stale items are
  re-planned by the producer on demand ("Refresh proposal") rather than silently applied.
- EA-004 Limits: a pass refuses with `E_TOO_LARGE` (suggesting a range) instead of producing a proposal whose accept
  would exceed the transaction caps; batch commands (EA-031) keep typical whole-video passes far below the cap.

### 2.2 Style recipes
- EA-010 A **style recipe** = named, versioned set of pass parameters (cut kits incl. families/weights, punch-ins, Ken
  Burns, reactions incl. asset set + slots, slides, music, stingers, subtitle template from spec 13, cleanup preset from
  spec 14). Stored in the user library (`<appdir>/style-recipes/`, atomic writes, zod index, repair) with a copy in the
  project when used (schema v10: `ProjectDocument.styleRecipes?`, optional, lenient, invariants + repair).
- EA-011 Built-in recipes (neutral names): **Fast Shorts** (shorts shake kit, Ken Burns 15 %, reactions slots bottom,
  music intro step) and **Fast Long-form** (five-family transition pack, punch-ins, Ken Burns 15 %, slides, beds) with
  the measured parameters; **Clean** (no decorations, Natural cleanup, Subtitles template) for general users.
  Recipes reference **asset roles** (whoosh SFX, reaction images, music folder, static noise) resolved from the user's
  library/bins; built-ins resolve whooshes from bundled/installed sound packs (CC0) or ask for a folder; never ship the
  user's assets.
- EA-012 `apply_style` runs several passes into one combined proposal (ordered: cleanup → subtitles → kits → punch-ins →
  Ken Burns → reactions → slides → music), resolving conflicts (a punch-in never overlaps a Ken Burns clip; kits never
  overlap each other; reactions avoid subtitle regions).
- EA-013 **Style Check**: compares a sequence with a recipe's targets (cuts/min, kit coverage, punch-in rate and
  timing, Ken Burns share, dead air from spec 14, subtitle cut alignment from spec 13, music level) and reports
  deviations with "look here" timecodes (UI panel + MCP `style_check`).

### 2.3 Passes
- EA-020 **Decorate Cuts** (Sequence ▸ Decorate Cuts…, MCP `decorate_cuts`): for each cut from the cut map (spec 13
  §2.1; options: track, range, include insert edges, minimum spacing) place a kit: an adjustment clip on an "FX" track
  above the picture (created if missing) spanning `before + after` frames around the cut, with effects + keyframes from
  the kit definition expressed relative to the cut (2-key eased curves with the measured easing; not baked per frame),
  plus an SFX of the same length centred on the cut through the sound-design cue/placement system (no parallel SFX
  placer). Kit families are data (kit presets: effects, params, keyframes, lengths, weights, directions); seeded
  choice with a configurable repeat penalty (default matches P(same)=0.23); kits never overlap — cuts closer than a kit
  span take the shorter family or are skipped (reported). Coverage default 100 % (option: skip probability).
- EA-021 **Punch-ins** (`add_punch_ins`): candidates = A-roll clips ≥ `minClipSeconds` (1.5) without Ken Burns or a
  kit-incompatible effect; start = midpoint (or the nearest word boundary when transcript words exist, option);
  ramp `rampFrames` (7) linear from 100 % to `scale` (180 %) then hold to the clip end; target centre / subject (face
  tracking or saliency) / explicit point; density (0.7) ranks "!"/"?" phrases first; implementation default =
  **Motion scale/position keyframes on the clip** (native export); option = adjustment-layer Transform (affects
  everything below). Optional whoosh via cues.
- EA-022 **Ken Burns** (`add_ken_burns`): share (15 %) of remaining A-roll clips; 100 → 118 % (shorts) / 130 % (long);
  keys on first and last frame, linear; in:out 2:1 (seeded).
- EA-023 **Reactions** (`place_reactions`): reaction asset set (images in a bin/folder), slots per aspect (data from
  the recipe), duration (median 2.1 s shorts / 2.6 s long), start snapped to a cut when within 0.5 s, S_Shake wobble
  (Amplitude 0.8, Frequency 2), horizontal flip on left slots, scale 60–65 %; triggers: transcript words (CTA and
  exclamation lists per language, editable), markers, and optional "speaker not visible" from the existing face
  tracking job; 3 alternative assets per item; rate cap per minute.
- EA-024 **Overlay slides** (`slide_overlays`): one-sided Smooth Slide (30 frames) at heads/tails of overlay clips
  (images/B-roll on tracks above the A-roll), direction weights from the data, ease in-out quad/cubic; `transition.add`
  must support one-sided transitions at free clip edges (verify; implement if missing).
- EA-025 **Music bed** (`lay_music_bed`): playlist from a bin/folder; beds switch at the first cut after
  `bedSeconds` (52), gain −33 dB (option: auto-duck with the existing ducking), shorts intro step (−25 dB until the
  first cut); never under subtitles-only sections without picture (none).
- EA-026 **Stinger** (`add_stingers`, off by default): generated noise picture (synthetic generator, not the user's file)
  + noise audio −18 dB, 29 frames, after shouted punchlines (loudness peak ≥ +6 LU over the local median and/or "!"
  caption); assistive (review).

### 2.4 Shared mechanics
- EA-030 All passes are pure planners in `packages/project/src/automation/` (deterministic given seed + document);
  engine jobs only for media analysis they need (face tracking, saliency, loudness — existing jobs).
- EA-031 Batch commands so a whole-video pass is a few commands: `clip.addAdjustmentBatch {trackId, items:[{start,
  length, effects:[{effectId, params, keyframes relative}]}]}`, `keyframe.addBatch {targets:[{clipId, path, keys}]}`,
  each one undoable unit with full validation; refusals name offending items.
- EA-032 Determinism and Reroll: every item stores its seed; Reroll re-plans the item with the next seed.
- EA-033 Export: each pass reports its export cost class (native / bake) in the dry run; the planner routes kits
  correctly; measure the bake cost of 100 kits on the build VM and record it in the wp-note (AGENTS §5).

### 2.5 UI and MCP
- EA-040 Sequence ▸ Automate submenu: Decorate Cuts…, Punch-ins…, Ken Burns…, Reactions…, Slide Overlays…, Music
  Bed…, Stingers…, Apply Style…, Style Check; each dialog shows parameters with defaults from the active recipe, a dry
  run summary (counts, coverage, cost) and creates a proposal opened in the Review panel.
- EA-041 MCP: `decorate_cuts`, `add_punch_ins`, `add_ken_burns`, `place_reactions`, `slide_overlays`, `lay_music_bed`,
  `add_stingers`, `apply_style`, `style_check`, `list_style_recipes`, `save_style_recipe`, `get_style_recipe`; all take
  `mode: 'propose' | 'dryRun'` (apply via `accept_proposal`), strict schemas, annotations; guide resource "Editing
  automation" with the recommended agent workflow (cleanup → subtitles → apply_style → review → accept → style_check).
- EA-042 i18n (English + Spanish) for every string.

### 2.6 Validation
- EA-050 Unit/property tests per planner (no overlaps, on-cut placement exact to the frame, determinism, caps);
  command tests (undo/redo, refusals, invariants); Review/ghost UI tests; e2e: Decorate Cuts on a generated sequence →
  accept → export → frames show the kit; preview-vs-export comparison for one kit of each family.
- EA-051 Accuracy harness (private, on the host with the decoded projects): strip the user's decorations from a
  decoded main sequence, run the passes, compare with the user's: kit coverage and timing (target ≥ 90 % of the
  user's kits matched on the exact frame), punch-in F1 (target ≥ 0.75), Ken Burns share; record results in the
  wp-note (measured).
