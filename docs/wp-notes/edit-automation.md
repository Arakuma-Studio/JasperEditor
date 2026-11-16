# Editing-pattern automation (wp-note)

Spec: [`docs/specs/15-edit-automation.md`](../specs/15-edit-automation.md). Shared with specs 13 (subtitles) and 14
(transcript cleanup) for everything under "Proposals for new features". Each work package appends its design notes,
usage, verified behaviour (with the commands that measured it) and limits below.

## Proposals for new features (EA-001…EA-004, EA-031)

Built on branch `feat/wf-proposals`. What later producers (Decorate Cuts, punch-ins, Ken Burns, reactions, slides,
music beds, stingers, `apply_style`, automatic subtitles, transcript cleanup) build on. The generic proposal model is
D-51 / spec 12 §2.5 (`packages/project/src/proposals/`); this section is what spec 15 §2.1 adds to it.

### Features and agent accept (EA-001)

- `PROPOSAL_FEATURES` (`packages/project/src/proposals/features.ts`) lists `sound-design`, `edit-automation`,
  `subtitles`, `transcript-cleanup`: English name, description, item noun ("1 edit" / "{0} edits", "{0} subtitles",
  "{0} cuts"), Review groups in order, producer tools and where agent accept is decided. Names, nouns and group labels
  are model strings (`PROPOSAL_FEATURE_MODEL_STRINGS`, `pnpm i18n`), translated in `es.json`.
- Agent accept: sound design keeps its per-sequence "Allow agents to apply sound proposals"
  (`soundDesign.settings.agentsMayApply`, default off). The three workflow features are decided per **project**:
  Project Settings ▸ General ▸ **Agent Proposals**, "Allow agents to apply <feature> proposals", stored in
  `ProjectDocument.settings.agentProposals` (`Record<feature, boolean>`), **default on** (the user asked for
  agent-driven automation; every accept is one undoable "Agent: …" History step).
  - Why project settings and not an editor preference: the engine decides an agent's accept headless too (no editor
    window, `ProposalService.accept` reads the live or saved document), the choice belongs with the project the agent
    edits (like sound design's, which is in the document), and it is undoable and visible in History. Editor
    preferences are per user and machine and are not available headless (ARCHITECTURE §11, D-51).
  - Persistence: schema v10 optional field, read leniently (`agentProposalsAllowed`: absent entry → default; unreadable
    value → off for every feature, never a load failure), invariant `INV-PROJECT-SETTINGS`, repair keeps readable
    entries and rewrites the rest as `false` (reported). Row in `docs/project-files.md` "Fields added in v10".
  - Command: `project.updateSettings {settings: {agentProposals: {subtitles: false}}}` — merged per feature (other
    settings keep their replace semantics), validated strictly. The agent guard (`approvalReasons`) asks the user's
    approval for any entry set to `true` (an agent may turn a feature off, never on, by itself); the editor's Apply
    confirmation names such a grant inside a proposal (`approvalNeeds` → `agentProposals`).
  - Policies: `ProposalService` registers `projectFeaturePolicy(f)` for each project-setting feature through
    `registerPolicy` in its constructor; refusals are `403 APPROVAL_REQUIRED` naming the setting. Destructive commands
    inside an accepted item still need the approval card (headless → `APPROVAL_DENIED`), as before.
- Spec 17 (script-guided transcript correction, `docs/wp-notes/script-correction.md` "Applying fixes") adds a fifth
  project-setting feature, `transcript-correction` ("Transcript fixes", "1 fix" / "{0} fixes", groups Fixes / Spelling /
  Maybe, default on) and **per-item default selection**: an item input may carry `selected: false` (stored only when
  false; absent = selected). An accept of `"all"` (`composeAcceptTx`, `planAccept`, the engine route, MCP
  `accept_proposal`) takes the pending / stale items that are selected (`acceptAllItemIds`); explicit item ids take any
  item. For an agent the engine and MCP also leave out the feature's `agentAllExcludes` groups (`maybe` for transcript
  fixes) even when selected: an agent applies those only by naming their ids. The Review marks unselected rows "Not
  selected" and Accept all leaves them pending (accepting one explicitly takes it); MCP `get_proposal` reports
  `selected: false` and `accept_proposal` lists what "all" left out as `notSelected`. `transcript-cleanup` no longer
  declares an unused "Transcript fixes" group.
- Discovery: `GET /api/projects/:projectId/proposal-features` → `{features: [{id, name, description, itemNoun, groups,
  producers, agentAccept: {setting: 'project', allowed, default, explicit} | {setting: 'sound-sequence', sequences},
  refreshable}]}`; MCP `list_proposal_features {projectId}` (READ_ONLY). Client: `EngineClient.proposalFeatures`.

### Review vocabulary and ghosts (EA-002)

- Items name their group in `meta.group` (or `group`); the Review panel lists the feature's declared groups in their
  order with translated labels, then other groups (capitalised), Other, Tracks (`buildReviewModel(items, ghost,
  feature)`). Producers add a group by adding it to `PROPOSAL_FEATURES` (a label → `pnpm i18n` → Spanish).
- Feature sentences go through `apps/web/src/proposals/vocabulary.ts`: `reviewVocabulary(feature)` →
  `{groupOf, cardSentence?, itemsText, applyToast}`; the generic one uses the feature's noun ("ui-agent proposes Decorate
  Cuts: 214 edits", "Applied 12 of 40 cuts from …"). Sound design uses its own vocabulary (role grouping
  Hero / Support / Bed / Layers, "n sounds on k new tracks", "Applied n of m sounds").
- Ghosts (`apps/web/src/proposals/ghosts.ts`, drawn by `GhostLayer.tsx`): clip ghosts carry the clip kind
  (adjustment ◐ and text T marks); **key bands** for keyframes an item adds or changes on a clip (also all keys of a
  clip it creates: an adjustment kit's blur curve) at the keys' sequence frames, with a diamond per key; **transition
  ghosts** for created / changed transitions at their span. Why-lines name them ("Cross Dissolve on V1 at … (10
  frames)", "2 keyframes on “Clip” from … to …"). A keyed existing clip is still drawn as a changed clip (wash +
  ghost) under its key band.

### Finer anchors and Refresh proposal (EA-003)

- An item may declare what it decorates: `meta.anchorOn = {clips?: [clipId…], cuts?: [{trackId, frame}…]}` (≤ 64
  each, read leniently). Clips anchor by track, start, length, In point and speed (the existing clip fingerprint);
  a cut anchors as `cut@<trackId>@<frame>` → `cut:<track>:<frame>:<outgoing>:<incoming>`. When the user ripples or
  trims, the item goes stale with a reason ("The cut at 00:00:03:00 moved to 00:00:02:15"; "… is gone"; structured
  `StaleProblem` entity `cut`, said in the user's language by `stale-text.ts`). Stale items are never applied as
  planned: accept refuses them (all-or-nothing, or skipped with `partial`).
- **Refresh proposal**: producers implement a refresher and register it on the engine:
  `services.proposals.registerRefresher(feature, async ({projectId, proposal, itemIds, doc, revision}) => ({items,
  dropped?, report?}))`. It re-plans the requested items on the live document (its parameters travel in the proposal's
  `report`) and returns a replacement per item (same id, same temp refs) and the items that no longer apply. The model
  (`refreshProposalItems`) checks them like a draft's items (unknown keys, addressing, schemas, structure, budget),
  swaps them in as pending with fresh anchors, keeps the reviewer's note, makes dropped items invalid with the
  reason, never touches accepted or rejected items, then re-validates the rest. Route `POST
  /api/projects/:id/proposals/:proposalId/refresh {itemIds: "stale" | [ids]}` (event `proposal.changed` `refreshed`);
  without a refresher `409 PROPOSAL_NOT_REFRESHABLE` (`E_NOT_REFRESHABLE`); a refresher that throws → `422
  E_REFRESH_FAILED`, a malformed result → `422` with the issue. Editor: Review panel "↻ Refresh proposal" (shown with
  stale items; disabled with the reason when the feature's producer does not refresh, from `proposal-features`), UI
  command `proposals.refresh`; session `ProposalsController.refreshItems`; MCP `refresh_proposal`.

### Limits (EA-004)

- `proposalBudget(items, {frameOf?})` (`packages/project/src/proposals/budget.ts`) says whether items fit one proposal
  and one accept transaction (2 000 items; 5 000 commands; 50 000 alternative commands; 20 MB less the envelope) and,
  when not, how many fit in time order (`meta.frame`, `meta.range.start`, `meta.start`) and the frames
  `suggestedRange` they cover. Producers call it before creating a proposal and refuse with `E_TOO_LARGE` (the issue:
  `tooLargeIssue`). `createProposal` refuses an over-cap draft the same way (previously `E_SCHEMA` / `E_LIMIT`), and the
  engine answers `413 PROPOSAL_TOO_LARGE` with `detail {code: 'E_TOO_LARGE', fit, suggestedRange, …}`; MCP maps it to
  `E_TOO_LARGE` with the range in `details`.

### Batch commands (EA-031)

- `clip.addAdjustmentBatch {sequenceId?, trackId, items: [{start, length, effects?: [{effectId, params?, keyframes?:
  {param: [{frame, value, interpolation?, inInterpolation?, easeIn?, easeOut?}]}}], name?, ref?}], overwrite?}` —
  adjustment clips with effects; key `frame`s count from the item's first frame (0 … length). Items may not overlap
  each other (`E_OVERLAP` naming both); over existing clips the batch is refused naming the item and the clip (with its
  id in `blocking`) unless `overwrite: true` (then like `clip.addAdjustment`). Result `{clipIds, effectInstanceIds,
  trackId}`. History label "New Adjustment Layers".
- `keyframe.addBatch {sequenceId?, targets: [{clipId, path, keys: [{at, value?, interpolation?, inInterpolation?,
  easeIn?, easeOut?, spatial?}]}]}` — `path` is the property's `clip.properties` key split on "."
  (`["transform", "scale"]`, `["opacity"]`, `["effects", effectInstanceId | "$ref", param]`); an effect may also be
  given as its param.set target `["effect", effectInstanceId | "$ref", param]`; `at` as `keyframe.add` (`12` or
  `{frames: 12}` from the clip's start, `{sequenceFrame}`, …). Schema refusals name the key path
  (`keyframe.addBatch: targets[0].keys[3].at: …`). Two keys of a target on one frame are refused. Result `{keyframeIds,
  targets}`. Label "Add Keyframes".
- Both run the single commands' handlers item by item inside one command (same rules: track locks and kinds, the
  effect registry, value ranges and clamping warnings, interpolation sides, the shape box), so a batch is exactly the
  sum of its parts; a refusal is re-labelled `items[3]: effects[1] (jasper.transform): keyframes.scaleHeight[0]: …` /
  `targets[2] (clp_… transform.scale): keys[1]: …` with the matching `path`, and nothing of the transaction applies.
  Limits per command: 2 000 items, 32 effects per item, 1 000 keys per param / target, 5 000 targets, 100 000 keys.
- One command per decoration keeps a whole-video pass small: 1 000 kits = 1 000 commands in one proposal (vs ≈ 10–20
  per kit with `clip.addAdjustment` + `effect.add` + `keyframe.add`, i.e. over the 5 000-command cap).
- MCP: `describe_commands {types: ["clip.addAdjustmentBatch", "keyframe.addBatch"]}` gives schemas and worked
  examples (`apps/mcp/src/examples.ts`, applied to a real document by `apps/mcp/test/proposal-features.test.ts`); they
  run through `apply_commands` like any command.

### For producers (checklist)

1. Plan purely in `packages/project/src/automation/` (EA-030); one item per decoration with `meta.group` (a group of
   your feature), `meta.frame`, `meta.why`, `meta.anchorOn` (decorated clips, cut frames) and the pass parameters in
   the proposal's `report` (for your refresher).
2. Use the batch commands: one command per item; a setup item (`meta.setup: true`) creates the FX track.
3. Call `proposalBudget(items)` first; over the caps refuse with `E_TOO_LARGE` and `suggestedRange`.
4. Create the proposal with the feature id (`edit-automation`, `subtitles`, `transcript-cleanup`); register a refresher
   on the engine's `ProposalService`; add your Review groups and item noun to `PROPOSAL_FEATURES`.

### Verification (VM `wt-proposals`, branch `feat/wf-proposals`)

- Tests: `packages/project/test/batch-commands.test.ts` (placement, keys relative to the item, refs, track creation,
  refusals naming items / targets and keys, overwrite, locked track, property test, 1 000-item / 1 000-target batches,
  undo = the document before, redo deterministic), `packages/project/test/proposal-features.test.ts` (feature table,
  setting default / merge / strict command / guard, lenient read + repair + load of junk values, budgets incl. a
  fast-check property, `createProposal` E_TOO_LARGE, cut and clip anchors incl. moved / gone cuts and malformed
  `anchorOn`, refresh swaps / drops / refusals), `packages/project/test/proposals.test.ts` (over-cap drafts now
  `E_TOO_LARGE`), `apps/engine/test/proposals-features.test.ts` (agent accept on by default → off → refused, agent
  cannot turn it on, destructive items still denied headless, features route, 413 with the range, refresh through a
  registered producer then accept where the cut is now, producer errors), `apps/web/test/proposal-features-review.test.ts`
  (groups and labels, sound design unchanged, sentences, approval need, cut stale text, ghosts of adjustment / keys /
  transition / text, layout, session refresh), `apps/mcp/test/proposal-features.test.ts`; existing proposal suites
  (project, session, engine, web review, MCP conventions) pass.
- Performance (measured on the build VM, 16 vCPU, load average 5.3–5.8 from other agents, holding the bench lock;
  vitest, invariants in the test default mode, 3 runs): `clip.addAdjustmentBatch` with 1 000 items (2 effects, 5 keys
  each) 504–548 ms for the whole transaction; `keyframe.addBatch` with 1 000 targets × 2 keys 154–199 ms.
- In the running app (dev stack on the VM, ports 47926 / 5196): an agent's 4-item `edit-automation` proposal showed the
  card "ui-check-agent proposes Decorate Cuts: 4 edits", the Review panel grouped Cut kits / Punch-ins / Reactions /
  Overlay slides, ghosts drew the adjustment clip (kind `adjustment`), the text clip (`text`), the transition at the cut
  and the key bands (3 keys on the kit, 2 on the punch-in); after an agent trim + move the kit, punch-in and dissolve
  went stale with reasons and "↻ Refresh proposal" appeared disabled (no producer registered yet); Project Settings ▸
  General ▸ Agent Proposals listed the three features on, turning Subtitles off was saved (`proposal-features` then
  reported `subtitles: allowed false, explicit true`).

### Limits

- Only `edit-automation` registers a refresher (Decorate Cuts, punch-ins, Ken Burns, below); for `subtitles` and
  `transcript-cleanup` proposals Refresh proposal stays disabled with its reason until their producers register one.
- `set_project_settings` (MCP) does not expose `agentProposals`; agents use `apply_commands project.updateSettings`
  (turning a feature on asks the user).

## Decorate Cuts, punch-ins, Ken Burns (EA-020…EA-022, EA-030, EA-032, EA-033, EA-040, EA-041, EA-051)

Built on branch `feat/wf-kits`. Three passes, each a pure planner in `packages/project/src/automation/` (EA-030), an
engine producer (job `edit-automation`), an MCP tool, a Sequence ▸ Automate dialog and one proposal of feature
`edit-automation` (Review groups Cut kits / Punch-ins / Ken Burns). The parameters of every pass are plain JSON
(`DecorateCutsParamsSchema`, `PunchInParamsSchema`, `KenBurnsParamsSchema`, strict) so style recipes can store them;
every default is a measured value of the user's projects (private research `.prproj-analysis/research/auto`,
FINDINGS §3; the per-family curves were re-derived from `flat/*.json` for this package, see "Kit packs").

### Code map

| Layer | Files |
|---|---|
| Model (pure) | `automation/kits.ts` (kit packs as data, eases, repeat penalty), `params.ts`, `common.ts` (A-roll track, candidates, FX / ZOOM track), `decorate-cuts.ts`, `punch-ins.ts`, `ken-burns.ts`, `sfx.ts` (sound role → cue + placement), `proposal.ts` (items), `refresh.ts` (Refresh / Reroll), `summary.ts` (dry run), `pass.ts` (entry points); `sound/proposal-draft.ts` `soundSetupItems` (shared with sound design: the bin and sound import setup items, extracted from `soundProposalItems` without behaviour change) |
| API / client | `packages/api/src/automation.ts` (request, `AutomationPassResult`), route `automationPass`, job kind `edit-automation`, `ProposalRefreshRequest.reroll`; `EngineClient.automationPass` |
| Engine | `apps/engine/src/automation/run.ts` (dry run, job, refresher), `routes/automation.ts` (`POST /api/projects/:projectId/automation/:pass`), `gaps/reframe.ts` `ReframeService.analyze` (inline subject analysis), `proposals/service.ts` (`reroll` passed to refreshers) |
| MCP | `apps/mcp/src/tools/automation.ts` (`decorate_cuts`, `add_punch_ins`, `add_ken_burns`, `AUTOMATION_GUIDE`), `refresh_proposal {reroll}` |
| Editor | `apps/web/src/automation/menu.ts` (the Automate submenu entries), `AutomationDialog.tsx`, `run.ts`, `commands/automation.ts` (`automation.decorateCuts` / `punchIns` / `kenBurns`), Review ▸ details ⟳ Reroll and `proposals.rerollItem`, session `refreshItems(ids, {reroll})` |

Later work packages add their passes to `AUTOMATION_PASSES`, their entries to `AUTOMATE_MENU` (the menubar builds the
submenu from that list) and their schemas to `AUTOMATION_PARAM_SCHEMAS`; `planPass` / `passItems` / `passDraft` are the
recipe-facing entry points.

### Kit packs (data, EA-020)

A pack = families (target share, frames before / after the cut, variants = directions with weights), each variant one
`whole` adjustment clip or a `before` + `after` pair, each with effects, static params and keys `{at: frames from the
cut, value, ease}` (`ease` = the curve arriving at the key: `linear`, `hold` or a built-in ease preset, turned into the
two keys' `easeOut` / `easeIn` by fitting the preset's single best cubic: 2-key eased curves, never one key per
frame). Pixel params (`scaleWithFrame`) are for a 1080-px short side and scale with the sequence. `kitPackIssues`
checks keys against their segment and unknown eases; custom packs travel in `params.pack`.

| Family | Share (measured / planned in the harness) | Frames | Effects (stack order) and keys relative to the cut |
|---|---|---|---|
| Shake (shorts pack) | 100 % | 10 + 10 | S_Shake Amplitude 0.5, Frequency 6, Motion Blur on, Seed 0 (320 of 355 shorts kits; the other 35 used 1 / 8 / off) |
| Jolt | 48.9 % / 48.9 % | 10 + 10 | Replicate 3, 4 × Mirror at the ⅓ / ⅔ lines (the copies around the centre become reflections), Transform 300 %, shutter 360°, position −10 (0.5, 0.5) → −5 (0.4885, 0.5167) → 0 (0.52, 0.481) → +5 (0.4833, 0.5222) → +10 (0.5, 0.5) linear (one fixed pattern in all 699) |
| Whip (left / right / up / down 65 / 61 / 62 / 57) | 17.4 % / 16.5 % | 20 + 20 | Offset (wrap) −12 → 0 → +13 quart in / out (0.5 → 0 → −0.5 along the axis), Directional Blur (90° / 0°) 0 → 270 px from −12 to −3 (quart in), held to +3, → 0 at +13 (quart out) |
| Zoom blur (down / up / right / left 64 / 55 / 63 / 60) | 16.9 % / 16.6 % | 18 + 22 (vertical), 19 + 21 (horizontal) | before / after clips: Transform (non-uniform, shutter 360°) Scale Height 100 → 190 % (Scale Width 100 → 160 %) cubic in, back cubic out (horizontal: quart out); anchor = position at the leading edge, (−1, 0, +1) keys to the measured mid point and the opposite edge; Directional Blur 0 → 40 → 0 linear |
| Zoom through (in / out 62 / 60) | 8.6 % / 9.1 % | 20 + 20 | in: Transform 100 → 200 % circ in, then Transform 50 % + 4 × Mirror at ¼ / ¾ + Transform 100 → 200 % circ out (the incoming picture comes from 50 %); out: the mirror stack 200 → 100 % circ in, then Transform 200 → 100 % circ out |
| Spin (ccw / cw 60 / 56) | 8.1 % / 8.9 % | 20 + 20 | before / after clips: Transform scale 100 → 300 % cubic in, rotation 0 → ∓90° (from −15) cubic in; after 300 → 100 % and ±90° → 0 cubic out |

How the numbers were derived (rerunnable on the host from the research's `flat/*.json` with the `fam()` classifier of
`analyze.py`): per family and side, the keyed curves were normalised, the active span found (first / last frame that
changes) and the Penner family with the least RMSE fitted (e.g. Whip offset quart 0.030, Spin scale cubic 0.032–0.037,
Zoom through circ 0.009–0.023, Zoom blur blur linear 0.022–0.027). Assumptions (labelled): the decoded projects list a
clip's effects in the reverse of the stack order — the Replicate must run before the mirrors for the Jolt's centre copy
to be the untouched picture, and the static 50 % Transform before the mirrors in the zoom-through stack — so every kit
stack is built that way (Offset before Directional Blur, Transform before Directional Blur); the Jolt's keys sit on
whole frames (the user's sit half a frame earlier); Zoom blur keeps the user's one-frame anchor jump through the cut.

Family choice with a repeat penalty: the weights are the target shares and `chainWeights` fits the per-family weights
of a Markov chain whose stationary shares equal them with the previous family's weight × `repeatPenalty`. The long
pack's 0.54 gives P(same family as the previous kit) = 0.23 (measured 0.231; independent choices would give 0.312).
The dialog shows the resulting probability live; the harness measured 0.241 on the 11 long videos.

### Decorate Cuts (EA-020)

- Cuts: `pictureCuts` (kinds cut + jump; overlays with `includeInsertEdges`; `track` restricts to one track — needed
  when a full-length pre-render on a top track hides the cuts, the user's 2025 workflow; `range` filters cut frames).
- Per cut, in order: a two-sided transition → skipped (`transition`); an enabled adjustment clip over the cut →
  `decorated` (default on); closer than `minSpacingFrames` to the last kit → `spacing`; the kit's seed
  `itemSeed(seed, 'decorate-cuts', frame)` draws coverage first (`coverage`, default 1), then the family among those
  with a variant fitting the free window [previous kit end, sequence end) — a cut too close to the previous kit takes a
  shorter family or is skipped (`too-close`, `edge`, `track-busy` with an explicit busy `fxTrack`) — then the variant.
  Kits never overlap; each kit's `before` frames end on the frame before the cut and its `after` frames start on it.
- Alternatives (Review ⇄): up to 3 other families that fit between the neighbouring kits (a one-family pack offers its
  other variants), same temp refs, each with its own whoosh trim.
- FX track: the topmost video track named "FX" (or "FX n") above every decorated cut's track that is free at every kit
  and alternative span, else a new "FX" track at the top (a setup item); or the explicit `fxTrack`.
- The whoosh (sound design's cue / placement, no parallel placer): the library sounds of type `sfx.type` (default
  `whoosh`, the asset role) from the allowed sources, one installed pack (`packId`) or one sound folder (`rootId`) are
  ranked by `rankSounds` (window = the kit's run-up: the whoosh's lead fits it), rotated by `pickVariant` over the top
  `variety` (default 12, the user's rotation over 12 slices; `takes` variation: ±1 dB, no varispeed so the length stays
  exact), registered for the project (setup items via `soundSetupItems`); each kit item adds `soundCue.add` (kind cut,
  `align: peak`, window = run-up, anchored to the edit when both clips are on one track) + `soundDesign.place` (peak on
  the cut, sound design's support level unless `sfx.gainDb`) + `clip.trim` to the kit's span, computed with
  placement's own `planSoundInsert`, so the whoosh is exactly as long as the kit and centred on the cut (verified at
  the engine: start ≥ kit start, end ≤ kit end, peak within a frame of the cut).
- Item: id `kit:<frame>` (kept by Refresh / Reroll), `meta {group 'cut-kits', frame, range, why, seed, rerollable,
  family, variant, kitFrames, anchorOn {cuts, clips}, cut, cost, sound}`, requires the FX track and sound setup items.

### Punch-ins (EA-021)

Candidates: picture clips of the A-roll track (`track`, else the lowest track carrying ≥ 60 % of the most picture —
the research's rule) of at least `minClipSeconds` (1.5) and `rampFrames + 2`, Motion not keyed, no picture-moving effect
(Transform, S_Shake, Corner Pin, Warp Stabilizer), not in `excludeClipIds`, and (`skipReframed`, default on) no static
reframing of their own (a scale other than 100 % / fit / fill, a position off centre or a rotation: the user zooms
such clips 17 % of the time vs 66 %, `simulate.py`). `density` (0.7) of them, clips whose phrases hold "!" / "?" (or ¡ ¿)
first, then a seeded order. Start: the midpoint, the transcript word start nearest it (`start: 'word'`), or a caption
start (`start: 'caption'`, below); ramp
`rampFrames` (7) linear to `scale` (180 %) of the clip's own scale, held to the cut. Zoom about a point p: scale × k and
position' = p + k (position − p) on the same two linear keys, which is the same zoom about p on every frame between;
zooming in about any point of the frame keeps a covering picture covering it (property-tested), so p is only clamped to
the frame. Target `center`, `{x, y}` or `subject`: a faces roto on the clip (largest face present), else the Auto Reframe
analysis run inline by the job on 3 frames from the zoom start (face model when installed, else saliency), else the
centre (warning `W_NO_SUBJECT`). Method `motion` (default): `keyframe.addBatch` on scale (and position / scale width);
`adjustment`: a Transform adjustment clip (anchor = position = p, shutter 360° like the user's) on a "ZOOM" track
inserted right above the A-roll (a setup item). Optional whoosh (`sfx`, on by default) with its start on the zoom
start. Alternative: the other measured size (180 % ↔ 140 %).

#### Caption start (`start: 'caption'`, schema v14)

Asked for because the user's newer long-form projects (D, E, f, G) often start a punch-in on a caption's first frame
instead of the clip midpoint. The rule (`packages/project/src/automation/punch-caption.ts`), as measured by the editing
agent (`/tmp/jstyle/rules.py`, `combo3`, 2026-11-14):

- window: caption starts from max(0.8 s, 25 % of the clip) after the clip start to 0.6 s before the cut (and no later
  than the ramp fits);
- 1. the first caption in the window whose first word is *pero*, *aunque* or *sino*;
- 2. else a clause start — the previous caption ends in `, . ! ? … ; :`, or this one opens with a connector (*y, e,
  entonces, luego, después, ahora, también, además, porque, pues, o, bueno, cuando, hasta, ya, así, como, si,
  literalmente, obviamente, básicamente, incluso, encima* or a contrast word) or a capital — at 40–80 % of the clip,
  nearest 60 %;
- 3. else the caption start nearest 60 % of the clip;
- else the clip midpoint, reported as `W_CAPTION_FALLBACK` (some clips) or `W_NO_CAPTIONS` (no subtitles and no
  transcript words). Each item's `why` names the tier ("on “pero / aunque / sino”", "opening a clause").

Captions: the sequence's subtitle text clips (the largest subtitle group; their start frame and text), else the
sequence transcript's words grouped with the Pixel Pop rules (≤ 13 characters, ≤ 3 words, a break at punctuation and at
0.3 s pauses: what Create Subtitles would make with the user's template). Caption-track captions are not read (their
pages are long; a transcribed source falls back to its words). The connector lists are Spanish (the user's language);
in other languages only the punctuation and capital tests of tier 2 and tier 3 apply (assumption, not measured).

Agreement with the user's zooms (hit = the planned start within ±3 frames of the user's zoom start; clip bounds and
caption starts rounded to frames as in the editor, the exact-seconds figure in brackets where it differs). Data: the
editing agent's `punchlex.json` (667 punch-in zooms of 10 long videos, from `.prproj-analysis/research/auto/events.csv`),
the user's captions `.prproj-analysis/research/auto/captions.json` and `words_tl.json` (transcript words on the
timeline of E, G, f); copies and the rerunnable scripts are in `.prproj-analysis/research/punch-caption/` (private, not
committed; `eval.mts` runs this module, `results.txt` is its output):

| Zooms | n | `caption` | `midpoint` (default) | `word` |
|---|---|---|---|---|
| "word-placed": > 1 frame off the midpoint, a caption start within ±3 frames (the editing agent's subset) | 196 | 66.3 % (66.8 %, = `rules.py`'s 67 %) | 1.5 % (excluded by the selection) | — |
| … projects D/E/f/G | 120 | 72.5 % | 0 % | — |
| all zooms | 667 | 27.3 % | 54.6 % | — |
| all zooms, projects D/E/f/G | 295 | 37.6 % | 48.5 % | — |
| all zooms, older projects | 372 | 19.1 % | 59.4 % | — |
| all zooms, E/G/f (transcript words available) | 227 | 39.6 % | 46.7 % | 23.8 % |

The 67 % reproduces exactly (131 of 196; the editing agent's contrast list also had *mientras*, *sin embargo*, *en
cambio*, which change no hit). It is measured on a subset that leaves out the midpoint zooms, so it is not comparable
with the midpoint's agreement: over all of the user's zooms the midpoint still agrees more, also in D/E/f/G, where 39–58 %
of each project's zooms sit within ±3 frames of the midpoint (±1 frame: `caption` 32.9 %, `midpoint` 46.4 %). That is why
`midpoint` stays the default here; `caption` is the choice when the user asks for zooms on the subtitles. No tested mix
beats the midpoint: "contrast word, else midpoint" 48.8 % vs 48.5 % on D/E/f/G (`explore.py`).

Captions from words: with the Pixel Pop grouping of `words_tl.json` instead of the user's captions, `caption` agrees
14.1 % on E/G/f. That figure is bounded by the timing of the two transcriptions, not the grouping: only 25–29 % of the
user's caption starts have any transcript word onset within ±3 frames (interquartile range of the offset about ±4
frames, `offset.py`), so it says little about subtitles made in the editor, whose clips start on the words they show.

### Ken Burns (EA-022)

`share` (0.15) of all the A-roll's picture clips in the range (the measured 13–16 % are of every A-roll clip), chosen
in a seeded order among the clips no punch-in or move decorates yet (Motion not keyed, ≥ `minClipSeconds` = 1 s);
direction in with probability `inOutRatio / (inOutRatio + 1)` (2 : 1) from the clip's seed; keys on the clip's first and
last frame, linear, 100 → `scale` (118 % vertical, 130 % landscape) about the frame centre. Alternative: the other
direction; Reroll redraws the direction.

### Determinism, Refresh and Reroll (EA-032, EA-003)

A pass is a function of (document, parameters, seed). Every item stores its seed (`meta.seed`); the proposal's report
stores `{pass, version, params, summary}`. The engine registers `automationRefresher` for `edit-automation`:
`refreshAutomationItems` re-plans the requested items on the live document — kits find their cut again by its two clips
(dropped when the cut is gone, has a transition or is covered now), punch-ins and moves their clip — with the same seed
(Refresh) or the next one (`reroll: true`), keeping the item id, its temp refs (`$kitCue_<id>`, `$kitSfx_<id>`…), its
sound and its `requires`, between the other kits of the proposal. `POST …/refresh {itemIds, reroll}`; MCP
`refresh_proposal {reroll: true}`; Review ▸ details ⟳ Reroll (items with `meta.rerollable`), UI command
`proposals.rerollItem`.

### Engine and limits (EA-004, EA-033)

`POST /api/projects/:projectId/automation/:pass` (`decorate-cuts` | `punch-ins` | `ken-burns`), body
`{sequenceId?, mode?: 'propose' | 'dryRun', params?}` (strict). Invalid parameters, an unknown sequence, track or pass
are refused at once (400 / 404, `detail.code` `E_INVALID_PARAM` / `E_NOT_FOUND`, locked FX track 409). `dryRun` answers
200 with the `AutomationPassResult` (summary, `sfx {available, placed, sounds}`, budget — the sound commands counted as
placed); `propose` answers 202 with the job (`?wait=1` waits); the job's result names the proposal. Over the proposal
caps the job fails `PROPOSAL_TOO_LARGE` with `{code: 'E_TOO_LARGE', fit, suggestedRange}` (MCP `E_TOO_LARGE`, the dialog
suggests In to Out). A kit with a whoosh is 5 commands (batch adjustment, cue, place, 2 trims), so about 1 000 kits fit
one proposal (≈ 55 min of long form at 17.9 cuts / min).

Export cost class (dry run `summary.cost`): `native` for Motion keys (punch-ins, Ken Burns), adjustment punch-ins and
the long-form kits — the export's adjustment kernel runs their geometric effects (edit-structure wp-note), and
`adjustmentRemoteEffects` (render/adjustment-native.ts, the engine's effect list) estimates it; `remotion` for the
Shorts shake kit (S_Shake with motion blur: the export planner names it and the whole export goes through the
Remotion renderer). Tested in `apps/engine/test/automation.test.ts` (long-form kits → path `native`, as the dry run
said; punch-ins + Ken Burns → `native`).

### Export cost of 100 kits (EA-033, measured)

`pnpm exec tsx apps/engine/bench/automation-kits.ts` (results in
`apps/engine/bench/automation-kits.results.json`): a 1080p 30 fps edit of 101 flat pictures of 2 s with a small square
over them (100 cuts, 6 060 frames = 202 s), H.264 CRF 20 "fast", exported as it is and with 100 kits from Decorate
Cuts (seed 1, no sounds), same settings, wall time of the export job. Build VM: AMD EPYC-Rome, 16 vCPU, 31 GB, software
GL (SwiftShader in headless Chrome), bench lock held, but load average 6.5 → 15.6 from other agents' jobs (2026-10-26
00:26–01:21 UTC), one run each.

| Export | Path | Wall time | × real time | Per kit (vs native) |
|---|---|---|---|---|
| No kits | native | 35.9 s | 0.18 × | — |
| 100 long-form kits (Jolt 46, Zoom blur 24, Whip 15, Spin 9, Zoom through 6) | Remotion | 1 853.6 s (30.9 min) | 9.2 × | ≈ 18.2 s |
| 100 shorts shake kits (S_Shake with Motion Blur) | Remotion | 1 392.3 s (23.2 min) | 6.9 × | ≈ 13.6 s |

The kits send the whole export through the Remotion renderer, so the cost is not proportional to the kit frames alone:
the kits cover 3 080 of the 6 060 frames (51 %, long pack) or 2 000 (33 %, shake), yet every frame is rendered in the
browser. In the dry run the
cost class says it ("the export renders through the Remotion path"); a hybrid route that renders only the kit spans of
the composite would cut this to the kit frames and is not built (docs/gaps.md).

### Accuracy harness (EA-051, private)

`.prproj-analysis/research/automation-harness/` (not committed): `prepare.py` (host) strips every decoration from the
30 decoded main sequences — only the A-roll clips (frames, source, source In, static framing) and the caption phrases'
timing with a "!" / "?" flag remain; `run.ts` (build VM, in the worktree) rebuilds each as a JasperEditor sequence and
runs the real planners in the recipes' order (Decorate Cuts; punch-ins; Ken Burns on what is left); `compare.py` (host)
scores against the user's own decorations. Aggregates (2026-10-26, this branch):

| Measure | Shorts (19 videos) | Long form (11 videos) | Target |
|---|---|---|---|
| User kits matched on the exact frame | 94.6 % (±1 frame 95.8 %; of kits on an A-roll cut 99.4 %) | 97.6 % (on an A-roll cut 98.4 %) | ≥ 90 % |
| Planned kits on a user kit (precision) | 81.6 % (the user decorates 85.7 % of cuts; coverage default 1) | 95.1 % | — |
| Family shares | shake 100 % | jolt 48.9 · zoom blur 16.6 · whip 16.5 · zoom through 9.1 · spin 8.9 % (user 48.9 · 16.9 · 17.4 · 8.6 · 8.1 %) | — |
| P(same family as previous) | — | 0.241 (user 0.231) | 0.23 |
| Punch-in F1 (clip level), density 0.7 / 1.0 | (shorts get none in the recipes) | 0.62 / 0.71 (precision 0.58 / 0.57, recall 0.67 / 0.94) | ≥ 0.75 |
| … knowing the user's Ken Burns clips (oracle) | — | 0.67 / 0.78 | — |
| Punch-in start within 1 frame of the user's | — | 50 % (midpoint); word starts 16 % | — |
| Ken Burns share of A-roll clips | 15.8 % (user 15.9 %) | 15.0 % after punch-ins at 0.7 (user 13.4 %) | 13–16 % |
| Planning time, all 30 videos | 1.06 s total (VM, under load from other agents) | | |

The punch-in target is **not met** by the stripped edit: the user's precision among eligible clips is ≈ 0.66 whatever
subset is chosen (P(zoom) is flat over duration and the "!" / "?" phrases raise it only to 0.72), and the user's Ken
Burns clips (13 % of the A-roll, punched 1.6 % of the time) cannot be told from the others; with them known (oracle) the
planner reproduces the research rule's F1 0.78 at density 1.0. The default density stays the specified 0.7 (the
user's rate: ≈ 66 % of eligible clips); a recipe that aims at overlap rather than rate uses density 1.0 (F1 0.71).
Word-start timing is worse than the midpoint (16 % vs 50 % within a frame), as the research found, so `midpoint` is the
default.

### Verification (VM `wt-kits`)

- `packages/project/test/automation-planners.test.ts`: repeat penalty keeps the
  shares and gives 0.23; per-side eased batch keys; every kit centred on its cut exactly and disjoint (example and
  fast-check property over random edits, seeds and both aspects); determinism; shorts pack; close cuts → shorter
  family / `too-close`; edges, transitions, decorated cuts; coverage, spacing, range, track, refusals; family shares
  and repeat rate over 2 000+ kits; proposal = FX track + one item per kit, accept = one transaction (one revision),
  invariants hold, the document before untouched; whip curves evaluated relative to the cut; Refresh of a moved cut
  (same id, frame moved, swapped in by `refreshProposalItems`), Reroll = next seed, gone cut dropped; punch-ins
  (candidates, midpoint, 7-frame linear ramp, hold, a second pass skips them, reframed clips, coverage property,
  adjustment method on a ZOOM track above the A-roll; caption start: the three tiers, the window bounds, subtitles
  before words, the midpoint fallback and its warnings); Ken Burns (share, keys on first / last frame, in : out, per
  aspect, exclusions, native keys).
- `apps/engine/test/automation.test.ts` (6, real engine with an indexed generated kit): dry run stores nothing;
  refusals; Decorate Cuts proposal with whooshes placed through sound design, accepted by an agent as one
  transaction, kits exactly on their ranges, whoosh trimmed to the kit with its peak on the cut, export planner path
  `remotion` naming the effect; Refresh after a ripple and Reroll through the route; punch-ins and Ken Burns accepted,
  export path `native`; policy off → 403. `apps/engine/test/proposals-features.test.ts` updated (the built-in refresher).
- `apps/engine/test/automation-kits-export.test.ts` (REMOTION_E2E=1, 6): one kit of each family, exported through the
  route the planner chooses (Remotion) and compared with the Program composition's Remotion still of the same frames:
  share of channels within 4/255 0.9955–1.0000 at 7 frames per kit (mean |Δ| ≤ 0.075), and the kit visibly changes the
  picture (mean |Δ| vs the undecorated edit up to 0.7 shake, 1.4 jolt, 12.1 whip, 9.1 zoom blur, 13.0 zoom through,
  16.8 spin).
- `apps/mcp/test/automation.test.ts` (6); `apps/web/test/automation-dialog.test.tsx` (8: Automate submenu, dialog dry
  run, parameters, Propose → review, budget, recipe starting values, Reroll through the session).
- `e2e/automation.spec.ts` (`pnpm e2e`, VM, LGPL FFmpeg): Sequence ▸ Automate ▸ Decorate Cuts… → dry run (2 of 2
  cuts, Remotion) → Propose → Review (Cut kits, ghosts) → ⟳ Reroll → Accept all → Apply (one History entry) → export
  through Remotion; frames around both cuts differ from the undecorated export (whip blur and spin seen in extracted
  frames), frames away from the cuts match — passed (1.2 min).
- In the running dev stack (VM, pairing flow): the dialog, the dry-run summary, Propose → Review with three kits and
  their whooshes, Reroll (Whip → Zoom blur → Jolt, the why-line, ghosts and the whoosh re-trimmed to the new kit),
  Accept all + Ctrl+Enter → "Applied 3 of 3", FX and SFX tracks with the kits. This found a session defect, fixed:
  the preview memo keyed items by id and alternative only, so a Reroll (same id, same document) kept the old ghosts
  and details; `previewKey` now fingerprints the item's command set (`packages/session/test/proposals.test.ts`
  "a Reroll re-planning an item in place…", fails before the fix). Without Chrome's HTML-in-Canvas flag the live
  Program shows adjustment layers unadjusted with the existing notice (docs/gaps.md); render previews and export
  render them.
- Whole suites on the VM: `packages/project` 2 405 tests, `packages/session` 81, `apps/mcp` 283 (8 skipped, existing),
  `apps/web` 1 085, engine proposals / sound-design plan / beds / fx-routing / automation 88 — all pass; typecheck of
  project, session, api, engine-client, engine, mcp, web; biome on the changed files; check-tokens, check-layers,
  check-anime; `pnpm i18n` + `pnpm i18n:check` (11 266 strings).

### Limits

- The Shorts shake kit exports through the Remotion path (whole export: S_Shake motion blur has no native route); the
  long-form kits are native (CPU kernel: dense kit frames cost seconds of CPU each, edit-structure wp-note).
- The whoosh is cut to the kit's span with hard edges (like the user's slices of a compilation); no fade is added.
- `subject` targets need a faces roto or the engine's Reframe analysis; headless refresh of subject punch-ins
  re-measures the refreshed clips only.
- Style recipes, `apply_style` and Style Check: see "Style recipes, Apply Style and Style Check" below; reactions,
  overlay slides, music beds and stingers are below.
- Punch-in F1 below the spec's target (above).

## Reactions, overlay slides, music beds, stingers (EA-023…EA-026, EA-030, EA-032, EA-033, EA-040…EA-042, EA-051)

Built on branch `feat/wf-overlays`. Four more passes of feature `edit-automation`, made like the three above: a pure
planner in `packages/project/src/automation/`, the `edit-automation` job / dry run of `POST
/api/projects/:projectId/automation/:pass` (`reactions`, `slides`, `music`, `stingers`), the refresher (Refresh /
Reroll), an MCP tool, a Sequence ▸ Automate dialog and Review groups Reactions / Overlay slides / Music beds /
Stingers. Parameters are strict plain JSON (`ReactionParamsSchema`, `SlideParamsSchema`, `MusicParamsSchema`,
`StingerParamsSchema` in `AUTOMATION_PARAM_SCHEMAS`) so the recipes work package can store them as they are; defaults
are in `AUTOMATION_DEFAULTS`.

### Code map

| Layer | Files |
|---|---|
| Model (pure) | `automation/signals.ts` (picture cuts to snap to, trigger word lists per language, markers, face-less stretches from a faces roto, subtitle regions of spec 13 caption groups read defensively, "!" phrases, loudness peaks over the local median), `assets.ts` (asset roles: a bin by id or name, an engine folder's probed files → setup items that import them into a bin, media ids), `reactions.ts`, `slides.ts`, `music.ts`, `stingers.ts`, `overlay-items.ts` (proposal items), `common.ts` `basePictureTrack`, `params.ts`, `pass.ts` (`PassContext`: folder files, voice activity, loudness), `summary.ts`, `refresh.ts` |
| Synth | `packages/audio-fx/src/synth/recipes.ts` `SYNTH_EXTRA_RECIPES`: `synth.static` "Synth TV static" (glitch type, 8 seeded variants, indexed with the library's Jasper Synth sounds) |
| API / engine | `packages/api/src/automation.ts` (cost class `hybrid`, `summary.detail`, `summary.assets`), `apps/engine/src/automation/run.ts` (`passInputs`: folder listing + probing, `VoiceActivityService.forSequence`, the loudness curve with a small memory cache; `checkFolder`; the stingers' sound filtered to the recipe), `apps/engine/src/audio/service.ts` `momentaryCurve` (the offline mixer's PCM of the dialogue tracks through a BS.1770 `LoudnessMeter`, momentary loudness every 100 ms), `routes/automation.ts` (path reads only in local mode, like `/api/media/register`; folders checked at once) |
| MCP | `apps/mcp/src/tools/automation.ts`: `place_reactions`, `slide_overlays`, `lay_music_bed`, `add_stingers`; `AUTOMATION_GUIDE` extended |
| Editor | `apps/web/src/automation/OverlayFields.tsx` (fields of the four passes, the asset source: bin or folder with Browse… in the desktop app), `fields.tsx` (shared rows, moved out of `AutomationDialog.tsx`), `menu.ts`, `commands/automation.ts` (`automation.reactions` / `slides` / `musicBed` / `stingers`), `run.ts` |

### Measured defaults (FINDINGS §3; derived for this package from the research's events.csv, rerunnable)

| Pass | Default | Source |
|---|---|---|
| Reactions | length 2.1 s (vertical) / 2.6 s; start on a cut within 0.5 s; S_Shake Amplitude 0.8, Frequency 2; Motion scale drawn in 60…65 %, capped at 45 % of the frame height (large pictures); Horizontal Flip on the left slots; at most 12 / min (vertical; 2025's 11–15) or 1 / min (landscape, 0.9 measured) | spec, FINDINGS |
| Reaction slots | vertical: bottom left (0.39, 0.87, flipped) 41 %, bottom centre (0.47, 0.83) 49 %, bottom right (0.63, 0.85) 10 %; landscape: (0.15, 0.523, flipped) 32 %, (0.5, 0.523) 41 %, (0.83, 0.523) 27 % | cluster medians of the user's reaction centres (108 shorts / 78 long placements; position rounded to 0.1 for clustering), shares = cluster counts |
| Overlay slides | 30 frames, one-sided; heads 0.53 / tails 0.18 of the overlays (166 / 57 of 312 overlay clips); directions up 47 / down 33 / left 13 / right 8; Ease In Out Quad 68 % / Cubic 32 % (154 / 71 of the 225 Slides); motion blur High, 360° shutter; no dolly / reflection | events.csv `premiere_transition` Slide params (Direction 0–3 = right / left / down / up, smooth-slide.md §4.2; Animation 16 / 17 = in-out quad / cubic; Motion Blur 3 = High) |
| Music | bed 52 s, switch at the first cut after it (waiting ≤ 15 s), −33 dB clip gain, no ducking; vertical: one bed per song, −25 dB until the first cut | FINDINGS |
| Stingers | 29 frames; noise −18 dB; ≥ 6 LU over the median of a 10 s window; 1 / min, ≥ 10 s apart (15 in 30 videos) | spec, FINDINGS; rate and spacing assumed (labelled) |

### Reactions (EA-023)

- Pictures (asset role "reaction images", never shipped): `assets: {bin}` (id or name; sub-bins included), `{folder}`
  (absolute path on the engine computer: its png / jpg / webp / bmp / tiff files by name, ≤ 256, each probed and
  registered in the engine media store; setup items `react-asset-<n>` import the ones the proposal uses into a
  "Reactions" bin, reusing a project media of the same fingerprint) or `{mediaIds}`. GIFs (animated images) are left
  out (their length bounds the placement).
- Triggers, in budget order: markers whose name contains `markerMatch` ("reaction") or equals a picture's name (that
  picture is used); calls to action and exclamations of the sequence transcript — built-in Spanish and English lists
  (generic vocabulary, `REACTION_WORD_LISTS`; the transcript's language picks one, unknown → both), editable
  (`words.cta`, `words.exclamations`, one phrase per line in the dialog), matched accent- and case-insensitively on
  consecutive words, plus any word written with "!" / "¡"; optionally (`triggers.speakerNotVisible`) stretches of at
  least 1.5 s where the A-roll's faces roto (Track Faces) shows no face, sampled every ⅕ s — without face tracking a
  warning `W_NO_FACES` asks to run it.
- Timing: start on the nearest picture cut within `snapSeconds` of the trigger, else on it; `durationSeconds` long;
  no two reactions overlap (plus `minGapSeconds`); every 60 s window holds at most `maxPerMinute` (`rate` skips).
- Look: slot by weight (not the previous reaction's slot when another fits), picture preferred by the trigger
  (marker name, then name hints: "subscri / suscri / follow…" for calls to action, "surpris / wow / happy / xd…" for
  exclamations, then a seeded shuffle; not the previous reaction's picture when another fits), scale drawn per item,
  the slot's centre moved just enough to keep a picture that fits the frame inside it (found in the e2e's extracted
  frame: a 45 % full-HD picture at the left slot hung off the edge), the first slot whose picture rectangle stays
  clear of every subtitle on screen meanwhile (`subtitleRegions`: text
  clips with `caption.groupId`, rectangle from the text box and static Motion; empty without caption groups);
  `subtitles` skip when none is.
- Commands per item: `clip.place` (still, `sourceRange` of the length) on the reaction track, `param.set` scale and
  position, `effect.add` `jasper.flip-horizontal` (left slots) then `jasper.s.shake` (wobble). Alternatives: up to 3
  other pictures at the same slot (⇄); the item `requires` the setup items of all of them (alternatives cannot carry
  requires). Track: an explicit `reactionTrack`, a free "Reactions" track above the A-roll, else a new one created
  right below the first "FX" track above the A-roll (cut kits then shake the reactions, as in the user's stacks) or
  at the top.
- Base picture (`basePictureTrack`): the lowest video track whose picture clips and colour mattes cover half the
  sequence — a single full-length take included (the kits' `aRollTrack` leaves those out as possible pre-renders).

### Overlay slides (EA-024)

- `transition.add` already supported one-sided transitions at free clip edges (`{clipId, edge}` with no clip of the
  track touching that edge → the other side null, alignment start-at-cut / end-at-cut; a GPU transition then renders
  from / to transparent over the clip's own frames, no handles). Verified with command tests
  (`packages/project/test/transition-one-sided.test.ts`: Smooth Slide at the free head and tail of a still and a video
  clip, the stages `in` / `out`, no handles, clamped to a short clip, two-sided where a clip abuts, one transition per
  edge, undo = the document before and redo identical, refusals: not an edit point, no edge, an audio transition on
  video, a locked track) — no command change was needed.
- Single-sided transitions next to another clip (`transition.add {clipId, edge, oneSided: true}`): Premiere's
  single-sided transition, how the user's overlay Slides are applied. The transition stores only that clip (the other
  side null, alignment start-at-cut / end-at-cut) and renders exactly as at a free edge, since
  `resolveVideoTransitions` builds a one-sided stage from the clip alone: from / to transparency over the clip's own
  frames, so the tracks below show through (on the bottom track, the black background). The clip that touches the
  edge cuts straight and gets no handles. Preview and every export path read the same resolved stages from the render
  snapshot. The result names the touching clip (`adjacentClipId`). An `alignment` other than the fixed one, or a
  `cutOffset`, at such an edge is refused with the edit-point route (`trackId` + `at`), because it asks for a
  transition between both clips. Without `oneSided`, a video clip edge where another clip touches it still joins
  both clips: the editor, the planners and the existing tests depend on that. MCP `add_transition` always sends
  `oneSided` for `clipId` + `edge`, and its result adds a `note` when a clip touches the edge. So a call that names one
  clip never changes another; a transition between two clips is addressed by `track` + `at`. The default is
  one-sided because the call names one clip, the guide already called a clip-edge transition a fade, and audio clip
  edges were always one-sided. Covered by `transition-one-sided.test.ts` ("with oneSided …": the result, stages
  without handles on either clip, undo/redo, invariants and the alignment / cutOffset refusals) and
  `apps/mcp/test/transitions.test.ts`. The slides planner still uses free edges only (`edgeFree`).
- Overlays: picture clips (video, still, animated image, nest) on the video tracks above the base picture, except
  tracks named "Reactions", "FX", "ZOOM", "Stingers" (other passes' output; `overlayTracks` names tracks explicitly),
  not full-length layers. Each free edge draws (its own seed) whether it slides (heads / tails shares), the
  direction and the easing; both slides must fit on the clip. Command: `transition.add {clipId, edge, effectId:
  'jasper.smooth-slide', duration, params: {direction, animation, motionBlur, shutterAngle}}`; alternatives = the
  other directions; Reroll redraws direction and easing.

### Music beds (EA-025)

- Songs (asset role "music folder"): a bin, a folder (mp3 / wav / m4a / aac / flac / ogg / opus / aiff / caf, by file
  name) or media; order as listed or shuffled by the seed; songs without a readable length are left out.
- Beds end end-to-end from the range start: a bed switches at the first picture cut at least `bedSeconds` after it
  started, waiting at most `maxSwitchDelaySeconds` (else exactly at `bedSeconds`); a song that ends earlier hands over
  at its last cut within that delay before its end, else where it ends; the last bed runs to the end; vertical
  sequences default to one bed per song. Each bed starts at the song's beginning.
- Gain: `clip.update {gainDb}` (−33). Intro step (vertical default): the first bed is split at the first cut — the
  same song continuing, the first part at −25 dB — rather than volume keyframes, so the optional ducking
  (`audio.autoDuck`, which rewrites the targets' volume keyframes in its span) cannot erase it; audibly the same step.
  Ducking (`duck.enabled`, Essential Sound defaults 18 dB / 800 ms): regions = the dialogue stretches
  (`dialogueSpans` with the engine's voice activity; transcribed words or dialogue clips) under each bed.
- Item per bed `bed:<n>`; alternatives = 3 other songs for the same span (cut to their length); Reroll = another song.

### Stingers (EA-026; off unless asked)

- Picture: a mid-grey colour matte (`clip.addSolid`, a synthetic generator) with `jasper.noise` Amount 100 %,
  monochrome — uniform grey noise, new every frame — on a "Stingers" track at the top. Sound: Jasper Synth "TV
  static" (`synth.static`, band-limited flutter noise; registered from the library like any sound, licence
  `LicenseRef-JasperEditor`), placed through sound design (cue kind `emphasis`, start-aligned, trimmed to the
  stinger) at −18 dB; `sound: 'library'` uses library sounds of `sfx` (type glitch by default), `none` no sound.
- Punchlines: peaks of the dialogue tracks' momentary loudness at least `thresholdLu` over the median of the
  measurable values (> −70 LUFS) within ±5 s (`loudPeaks`), "!" phrases (transcript words, subtitle text clips and
  caption clips), paired when the peak lies within 0.5 s of the phrase (`match`: both — default —, either, loudness,
  exclamation). The stinger starts where the punchline ends, on a cut within `snapSeconds` after it; loudest first,
  `maxPerMinute` and `minGapSeconds` apply.
- The loudness is measured when proposing (and on Refresh) by `AudioService.momentaryCurve`; a dry run reuses a
  measurement of the same mix (memory cache keyed by `mixFingerprint`) or says `W_NO_LOUDNESS` (the dialog then still
  allows Propose with a count of 0).

### Export cost (EA-033)

`summary.cost.class` gains `hybrid`: the export stays native and the layer-bake extension renders only the layers
or spans that need the browser — reactions with S_Shake (still clips with a GPU effect), stingers (the matte with
Noise) and Smooth Slide spans (`bakesTransition`); without the layer bake the planner sends the export through
Remotion (existing rule). Music beds are `native`. The engine tests check the planner's route for each
(`apps/engine/test/automation-overlays.test.ts`: reactions, slides, stingers → `hybrid`; music → `native`).

### Determinism, Refresh, Reroll

Every item stores its seed; ids are stable keys (`react:<trigger key>` — `word:<clip>:<index>`, `marker:<id>`,
`hidden:<clip>:<frame>` —, `slide:<clip>:in|out`, `bed:<n>`, `sting:<frame>`). The refresher re-reads the pass's
inputs on the live document (folder, voice activity, loudness — in a scratch directory it removes) and re-plans:
reactions find their trigger again by key and re-time between the proposal's other reactions; slides need the edge
still free; beds keep their span (Reroll draws another song); stingers re-detect and take the nearest punchline within
2 s (`rerollable: false`).

### Accuracy harness (EA-051, private)

`.prproj-analysis/research/automation-harness/`: `prepare_overlays.py` (host; after `prepare.py`) adds to each
stripped edit the caption phrases' flags (call to action / exclamation, matched on the host against the planner's
Spanish lists — no words leave the host) and the overlay clips above the A-roll, and writes the user's reactions,
Slides at overlay edges and music clips as truth; `run-overlays.ts` (build VM) rebuilds each edit and runs the real
planners with their defaults (nine placeholder reaction pictures, five 180 s placeholder songs); `compare_overlays.py`
(host) aggregates. Measured 2026-10-26 on this branch (planning 0.98 s for all 30 videos on the VM under load):

| Measure | Shorts (19) | Long form (11) |
|---|---|---|
| Reactions / min, planned (user) | 2.64 (6.94) | 0.44 (0.94) |
| Reactions starting on a cut, planned (user) | 49 % (80 %) | 27 % (63 %) |
| Median length, planned (user) | 2.10 s (2.11 s) | 2.60 s (2.58 s) |
| User reactions matched within 0.5 s / 1 s (recall); planned on a user one within 1 s (precision) | 10 % / 16 %; 29 % | 0 % / 0 %; 0 % |
| Left reactions flipped, planned (user) | 100 % (77 %) | 100 % (75 %) |
| Overlay heads slid, planned (user) of 172 / 70 overlays; both | 53 (40); 15 | 24 (28); 14 |
| Overlay tails slid, planned (user); both | 16 (8); 3 | 5 (5); 0 |
| Beds per video, planned (user) | 1.0 (1.37) | 9.27 (7.36) |
| Median bed length, planned (user) | 61 s (33 s) | 53.1 s (52.5 s) |
| Bed switches on a cut, planned (user) | — (29 %) | 92 % (86 %) |

Reading: the music rule reproduces the long-form bed length and switching on cuts (the user's songs are not on the
drive, so the switch frames themselves cannot match: 10 % within 1 s). Reaction placement from words is weak, as the
research predicted (words explain ≤ 30 % of short-form placements, none of the long form's; the inferred trigger is a
hidden speaker, which the stripped edits cannot carry — face tracking needs the footage): the planned rate is about
40 % of the user's and few placements coincide. Slides match the measured shares by construction; which overlays get
one is the user's choice per overlay (agreement near chance). The speaker-not-visible trigger is tested on synthetic
face data only.

### Verification (VM `wt-overlays`)

- `packages/project/test/automation-overlays.test.ts` (25): signals (word lists, accents, multi-word phrases, "!"
  words, markers, `nearestCut` property, loudness peaks), reactions (snapping to a cut within 0.5 s, slots, flip,
  scale, alternatives, determinism and reroll variety, marker budget and picture choice, rate cap and no overlap
  (example and fast-check property over triggers, caps, aspects), subtitle regions with and without caption groups and
  junk values, face-less stretches, refusals, proposal accept as one transaction with invariants, folder setup items
  and reuse, Refresh / Reroll / dropped trigger), slides (free edges only, shares / directions / easings over 2 000
  edges, accept → one-sided transitions and their stages, colour-matte base, other passes' tracks), music (switch on
  the first cut ≥ 52 s, short songs, no cut, vertical intro split, accept with contiguous source and ducking keys,
  shuffle, Reroll), stingers (pairing, snapping, rate, spacing, unmeasured warning, accept: matte + Noise on a
  Stingers track and the generated sound's needs); `transition-one-sided.test.ts` (5).
- `apps/engine/test/automation-overlays.test.ts` (5, real engine with an indexed kit and Jasper Synth): reactions from
  a folder of generated PNGs (dry run stores nothing, proposal, agent accept as one revision, Reactions bin, hybrid
  export route, Refresh after a ripple re-times to the moved cut), folder refusals (relative 400, missing 404, unknown
  bin 404), music from a folder of generated WAVs (beds at 0 / 1 650 / 3 300 at −33 dB, native), slides (two one-sided
  Smooth Slides, hybrid), stingers (a measured 0.6 s shout + "¡no!" → a stinger on the next cut, the matte with Noise,
  the `synth.static` sound at −18 dB trimmed to 29 frames, hybrid).
- `apps/mcp/test/automation.test.ts` (8): the four tools listed with annotations and strict schemas, parameters as
  plain data with ranges in frames, the hybrid export note, the guide. `apps/web/test/automation-dialog.test.tsx`
  (11): the Automate submenu (seven entries), Reactions without a source (Propose disabled, nothing counted), a typed
  folder, triggers and word lists in the request, the bin guessed by name for Music Bed, the stinger dialog allowing an
  unmeasured Propose, the summary texts.
- `e2e/automation-overlays.spec.ts` (`pnpm e2e`, VM, LGPL FFmpeg): Sequence ▸ Automate ▸ Reactions… on three colour
  mattes with a "reaction" marker 4 frames after the first cut and the generated `still.png` in a "Reactions" bin →
  dry run (the bin found by name, one reaction, hybrid cost) → Propose → Review (Reactions) → Accept all → Ctrl+Enter
  (one History entry "Accept Reactions …") → the still on a new Reactions track at the cut (frame 60), 78 frames, with
  S_Shake → export: frames under the reaction differ from the undecorated export, frame 30 matches; the extracted
  frame 90 shows the picture flipped at the left slot, inside the frame — passed (40 s).
- `packages/audio-fx/test/sound-synth.test.ts`: the TV static recipe pinned and judged as glitch for all 8 variants.
  The pinned bytes of five older recipes (riser, transition, pop, shimmer, zap) differ on the VM (Node 24.22) on the
  base branch too, without this change — environment-dependent, not touched here.
- Updated: `apps/engine/test/sounds-routes.test.ts`, `apps/mcp/test/sound.test.ts` (20 synth recipes indexed).
- Whole suites on the VM after merging `feat/workflow` (subtitles): `@jasper/project`, `@jasper/session`,
  `@jasper/mcp`, `@jasper/audio-fx`, `@jasper/web` 4 632 passed, 8 skipped, 5 failed (the five pinned synth hashes
  above); engine automation / overlays / proposals / sounds / sound-design suites 77 passed; typecheck of project, api,
  audio-fx, engine, mcp, web, session; biome on the changed files; check-layers, check-tokens; `pnpm i18n` +
  `pnpm i18n:check` (11 528 strings).
- In the running dev stack (VM, ports 47932 / 5202, pairing-free dev mode): Sequence ▸ Automate lists the seven
  passes; Reactions… from a folder of three generated pictures → dry run "2 of 2 triggers get a reaction · Markers 2 ·
  On a cut 1", Propose → Review (Reactions group) → Apply = one History entry "Accept Reactions (7 of 7)" (the
  reaction track, the bin and three imports), the reaction picture at the right slot in the Program monitor; Music
  Bed… from a folder of two generated songs → two beds (0–1 558 at −33 dB, then the second song); Slide Overlays… on an
  overlay picture → one Smooth Slide in from the right, seen mid-move with its motion blur in the Program monitor;
  Stingers… → the unmeasured warning with Propose enabled. This found and fixed two defects: slides treated the
  reactions' track as overlays (now the other passes' tracks are excluded), and a colour-matte base was not counted as
  the base picture (then every overlay track above it was missed).

### Limits

- Reactions do not use animated images (GIF); "speaker not visible" needs a faces roto on the A-roll (Track Faces);
  subtitle avoidance covers spec 13 subtitle text clips (caption groups), not caption-track captions.
- Word triggers are a weak stand-in for the user's choices (harness above); markers are the reliable trigger.
- Music beds cut between songs without crossfades (the user's switch on cuts); the intro step is a split, not keys.
- Stingers' loudness is measured on the dialogue tracks (the dialogue stretches' tracks, else every audio track) when
  proposing and refreshing (a mixdown of the sequence); a dry run counts "!" phrases unless the same mix was measured.
- The overlay passes' Refresh re-reads folders and re-measures loudness: slower than the kits' refresh.

## Style recipes, Apply Style and Style Check (EA-010…EA-013, EA-040…EA-042, EA-050, EA-051)

Built on branch `feat/wf-recipes`. A **style recipe** combines Clean Up Voice (spec 14), automatic subtitles (spec 13)
and the seven passes above into one named, versioned set of parameters; **Apply Style** runs it into ONE proposal;
**Style Check** compares a sequence with its targets.

### Code map

| Layer | Files |
|---|---|
| Model (pure) | `automation/recipes.ts` (`StyleRecipeSchema`, built-ins, roles, targets, `resolveRecipeStages`, project copy reader / INV-STYLE-RECIPE / `repairStyleRecipes`), `automation/style.ts` (`planStyle`, `styleDraft`, `refreshStyleItems`, `pictureEnd`), `automation/style-check.ts` (`styleCheck`, `motionKindOf`), `commands/{schemas,handlers}/style-recipes.ts` (`styleRecipe.add` / `remove` / `setActive`), `cleanup.apply {pieceRefs}` (`handlers/cleanup.ts`, `multi-range.ts` records each piece's origin), `proposals/features.ts` (Review groups Voice cleanup / Subtitles; `meta.feature` → `embeddedFeatures` in the agent policy), `schema/document.ts` (`styleRecipes?`) |
| API / client | `packages/api/src/style.ts` (library, Apply Style, Style Check schemas), routes `styleRecipes*`, `applyStyle`, `styleCheck`, job kind `apply-style`, event `styleRecipes.changed`; `EngineClient.styleRecipes` / `createStyleRecipe` / `updateStyleRecipe` / `duplicateStyleRecipe` / `deleteStyleRecipe` / `applyStyle` / `styleCheck`; config `paths.styleRecipesDir` |
| Engine | `style-recipes/library.ts` (the user library), `automation/style.ts` (hooks: the `cleanup-analysis` child job, the template library, `passInputs`, subjects, sounds; dry run, job, refresher, Style Check's dead air), `routes/style.ts`; `routes/automation.ts` dispatches the `edit-automation` refresher to `refreshStyle` for Apply Style proposals |
| MCP | `apps/mcp/src/tools/style.ts` (`list_style_recipes`, `get_style_recipe`, `save_style_recipe`, `apply_style`, `style_check`, `STYLE_GUIDE`), resource `jasper://guide/editing-automation` ("Editing automation": `AUTOMATION_GUIDE` + `STYLE_GUIDE`) |
| Editor | `apps/web/src/automation/ApplyStyleDialog.tsx`, `StyleCheckDialog.tsx`, `StyleRecipesDialog.tsx`, `style-store.ts` (library mirror, recipe choices, the pass dialogs' last parameters), `style-run.ts`; `menu.ts` (Apply Style…, Style Check, Style Recipes…), `commands/automation.ts` (`automation.applyStyle` / `styleCheck` / `styleRecipes`; the pass commands start from the active recipe) |

### Recipes (EA-010)

- Format `jasper-style-recipe` v1 (strict zod): `{id: builtin:<name> | rcp_<16>, name, description?, revision (the
  recipe's own version, +1 per save), basedOn?, aspect?, passes, assets?, targets?, createdAt?, updatedAt?}`. `passes`
  composes the existing schemas, nothing is forked: `cleanup {enabled, preset, overrides?}` (`CleanupOverridesSchema`,
  a built-in or user preset id), `subtitles {enabled, template, rules?, text?, cutAware?, output?, language?}`
  (`captions.generate`'s fields), and per pass `{enabled, params?}` with `AUTOMATION_PARAM_SCHEMAS` as they are
  (reactions' and music's `assets` optional: they come from the roles). ≤ 512 KB.
- **Asset roles** (EA-011): `whoosh` (`AutomationSfxSchema`: the library's sounds of a type from the starter kit,
  installed CC0 packs or the user's sound folders), `reactionImages` / `musicFolder` (`AutomationAssetsSchema`: a bin by
  name, an engine folder, media), `staticNoise` (`generated` Jasper Synth noise, `library` sounds, `none`).
  `resolveRecipeStages` fills them into the pass parameters (a pass's own `sfx` / `assets` win). Built-in defaults:
  whoosh sounds of the library, bins named "Reactions" and "Music", generated noise. Nothing of the user's is shipped.
- **Targets** (Style Check, EA-013): `cutsPerMinute`, `kitCoverage`, `punchInsPerMinute`, `punchInStart`,
  `kenBurnsShare`, `musicGainDb` as `{value, tolerance}`, `deadAirPerMinute {max}`, `subtitleOnCut {min, maxCrossing}`.
- **User library** `<appdir>/style-recipes/` (engine): `index.json` (zod) + one `rcp_….json` per recipe; atomic writes
  (temp, fsync, rename, directory fsync), serialised, revision per change; load repairs reported to the user once
  (Style Recipes… shows them; `GET /api/style-recipes` `repairs`; MCP `list_style_recipes`): unreadable index moved
  aside and rebuilt from the files, missing file → entry dropped, unlisted file → adopted (a crash between a recipe's
  file and the index), unreadable file → moved aside (`….invalid-<time>`), never deleted; newer recipe formats listed
  read-only (refused for use with the reason), a newer library index makes the library read-only. Write order: new
  file then index; deletion: unlink then index (a crash never resurrects a deleted recipe).
- **Project copy** `ProjectDocument.styleRecipes {active?, recipes}` (schema v10, read leniently; row in
  `docs/project-files.md`): accepting an Apply Style proposal copies the recipe used and makes it active (its setup
  item `styleRecipe.add {recipe, activate: true}` that every other item requires); Style Recipes… ▸ Use makes a recipe
  active (`styleRecipe.setActive` / `add`), one undo step each. A library recipe wins over the project's copy of the same id
  (the engine's `resolveRecipe` and the editor's `recipeChoices`): a rename or edit in the library shows and is used
  at once; Use on an active recipe whose copy is an older revision updates the copy ("this project uses version n"). The pass dialogs (Decorate Cuts… … Stingers…) start
  from the active recipe's parameters for that pass (`recipePassParams`, roles filled in); explicit `params` of the UI
  command win.

### Built-in recipes (EA-011)

| Recipe | Cleanup | Subtitles | Kits | Punch-ins | Ken Burns | Reactions | Slides | Music | Stingers |
|---|---|---|---|---|---|---|---|---|---|
| Fast Shorts (vertical) | Fast | Pixel Pop | `shorts-shake` | off | 15 %, 118 % | on (vertical slots, bin "Reactions") | off | −33 dB, intro −25 dB until the first cut | off |
| Fast Long-form (landscape) | Fast | Pixel Pop | `long-pack` (five families, P(same) 0.23) | density 1, ≥ 2.3 s, 180 %, 7 frames, midpoint | 15 %, 130 % | off | on (measured shares) | beds of 52 s switching on cuts, −33 dB | off |
| Clean (any) | Natural | Subtitles (caption track) | off | off | off | off | off | off | off |

Sources: FINDINGS §3 and the wp-notes above (kits, overlays), spec 13 (Pixel Pop, the user's measured template), spec 14
(Fast measured on the user's edits, Natural the calm preset). Fast Long-form's punch-in density and shortest clip are
tuned on the accuracy harness (below; in-sample on the 11 long videos — assumption labelled). Targets: the measured
figures (cuts 23.8 / 17.9 per minute, kit coverage 85.7 / 95.1 %, punch-ins 9.0 / min starting at 0.50 of the clip, Ken
Burns 15 %, music −33 dB; dead air ≤ 1 s/min for Fast — the shipped Fast output measured 0.51–0.68 s/min, the user's
0.42–0.61 —, ≤ 3 s/min for Clean; subtitles ≥ 95 % of speech cuts, none crossing: spec 13's target). **Assumption**:
the tolerances (≈ ±30 % of a rate, ±0.05–0.1 of a share, ±2 dB) and Clean's dead-air bound are chosen, not measured.

### Apply Style (EA-012)

- Stages in the spec's order: cleanup → subtitles → kits → punch-ins → Ken Burns → reactions → slides → music →
  stingers. `planStyle(doc, {recipe, sequenceId, range, seed, passes}, hooks, {registries})` (pure; the engine's hooks do
  the I/O) builds one item list: the recipe copy (setup), the cleanup item (one `cleanup.apply` over the analysis'
  ranges, group Voice cleanup, `meta.feature: transcript-cleanup`), the subtitles item (one `captions.generate` with
  the template, group Subtitles, `meta.feature: subtitles`), then each pass's items as the pass makes them.
- **Later stages see earlier ones' planned results**: every stage's items are applied to a simulated copy of the
  document (sim ids `<prefix>_ZS…`, never stored) before the next stage plans on it. Consequences, all tested:
  decorations are planned on the cleaned-up timeline (kits sit on its cuts, including the jump cuts the cleanup makes),
  the reactions avoid the subtitles' screen regions, the kits' FX track is created above the subtitles and reactions
  (kits shake the whole composite, as in the user's stacks, FINDINGS §2), Ken Burns skips the clips punch-ins keyed,
  kits never overlap (Decorate Cuts), the passes stop at the picture's end (`pictureEnd`: subtitles may hold past it; no
  kit on a "cut to black").
- **Addressing the cleaned-up timeline**: `cleanup.apply {pieceRefs: '$c'}` declares `$c_<clip>_<k>` for the k-th piece
  (time order) of every clip left on the edited tracks (the left piece keeps the clip's id, cut pieces are new; a clip
  only moved is piece 0). Later items name every such clip by its ref (also in `meta`), and any entity an earlier stage
  creates by the ref of the command that creates it (FX / ZOOM / Reactions / Music / Stingers tracks, bins, media, cues);
  a sim id inside a name (item ids `punch:<clip>`, ref names) is spelled with the ref's token. An item that would need an
  entity no ref names is left out with the reason (`dropped`), never planned against an id that will not exist. Every
  decoration `requires` the cleanup item (its frames are the cleaned-up timeline's) and the recipe item; cut anchors of
  decorations are dropped when there is a cleanup (they would be read on the timeline before the cuts).
- `range` is in the live sequence's frames; the cleanup analysis gets it as is, the later stages get it mapped through
  the removed ranges (`frameAfterCuts`). A sequence that already has subtitle groups keeps them (the stage says so). The
  seed of the request (if any) is every pass's seed.
- **Roles and other blockers never skip silently**: a stage that cannot run is `skipped` with an actionable reason, and
  role / transcript problems are repeated in the result's warnings (`W_ROLE_MISSING`: "… the project has no bin named
  “Reactions”: import your reaction pictures into a bin with that name, or choose another bin or a folder for them
  (assets.reactionImages)"; no whoosh in the library: "install a CC0 sound pack or the starter kit … or add a folder of
  your sounds", the kits are planned without sound; `W_NO_TRANSCRIPT` for subtitles / cleanup without a transcript; an
  unknown subtitle template). A stage with nothing to do is `empty` with what it considered and why each was left out.
- **Dry run** (`mode: 'dryRun'`): per stage status, count, the pass summary (coverage, skips, families), sounds
  available, the export cost class (cleanup native; subtitles `hybrid` when the template's animation has GPU effects —
  Pixel Pop's Transform + S_Shake —, `native` on a caption track; passes as above) and the whole result's highest class,
  and the budget (with the sound commands counted). The dry run's cleanup analysis uses only cached voice analyses
  (media without one are planned at word timings: `W_VOICE_NOT_ANALYSED`); Propose analyses them (a `voice-analysis`
  child job per media). The engine test checks the export planner's route of the accepted result equals the dry run's
  class.
- **Accept**: everything is one transaction (one History entry "Accept Apply Style: <recipe> (n of m)"; undo restores
  the exact document, `packages/session/test/style-history.test.ts`). Agents may accept only when Project Settings ▸ Agent
  Proposals allows editing automation **and** every feature an item names in `meta.feature` (the cleanup's
  transcript-cleanup, the subtitles') — `projectFeaturePolicy` reads `embeddedFeatures`.
- **Refresh / Reroll** (`refreshStyleItems`, the `edit-automation` refresher dispatches on `report.pass ===
  'apply-style'`): the earlier stages' pending items are simulated on the live document (accepted ones are in it), then
  the requested decorations are re-planned by their pass's refresher with their seed (Refresh) or the next (Reroll),
  keeping ids and refs. A stale cleanup item is dropped with "run Apply Style again" (it comes from an analysis of the
  whole sequence; re-planning it alone could rename the pieces the decorations address); the subtitles item is returned
  unchanged (it is laid out when applied).

### Style Check (EA-013)

`styleCheck(doc, sequenceId, recipe, {deadAir})` measures the document as it is (hand edits included) with the passes'
own definitions and compares each with the recipe's target (status ok / off / unmeasured / unchecked):
cuts per minute (cut map cuts + jump cuts on the picture tracks, the passes' own tracks left out, before the picture's
end); cuts with a kit (an enabled adjustment clip on the frame before the cut or on it: a kit or its before / after pair;
a cut lying under a neighbour's kit counts as covered, like Decorate Cuts' `decorated`); punch-ins (an A-roll clip
whose Motion scale rises ≥ 15 % within 15 frames from a key after its first frame, or a Transform adjustment on a ZOOM
track) per minute and their median start in the clip; Ken Burns share (two scale keys on about the first and last frame,
5–60 % change); dead air = spec 14's `deadAirPerMinute` of a cleanup analysis with the recipe's preset that rejects every
finding (so it measures the edit as it is), with the pause findings as look-here frames — cached voice analyses only
(unmeasured otherwise, with the reason); subtitles: speech cuts (a subtitle word starting within 0.5 s after the cut,
spec 13's measure) that start a subtitle, and subtitles running over a hard cut; music: the median clip gain of the
"Music" tracks' clips (the vertical intro part left out). Every deviation lists up to 50 look-here frames with a note;
the editor's dialog moves the playhead to one on click; `style_check` returns them with timecodes.

### Editor and agents (EA-040…EA-042)

- Sequence ▸ Automate: Apply Style… (recipe — built-ins, the library, the project's copies; default the active recipe,
  else the built-in for the aspect —, the nine steps switched on / off for this run, range, seed, the dry run per step
  with reasons and the export class, Propose → the job → review), Style Check (recipe, the measures with value / target
  / status, look-here timecodes, Check Again), Style Recipes… (Use, Duplicate, Rename, Delete — the library asks for
  confirmation, a project-only copy is removed undoably —, "Save Current Settings as Recipe…" = a new library recipe from
  the active one with the parameters the Automate dialogs last proposed with in this window; the library's repairs
  and a read-only library are said). No new shortcuts.
- MCP: `list_style_recipes`, `get_style_recipe` (read-only), `save_style_recipe` (library; `projectId` + `activate` keep
  a copy in the project), `apply_style` (`mode`, `recipeId` | `recipe`, `passes`, `seed`, `range`), `style_check`
  (read-only); strict schemas (recipe stages validated with the recipe schemas at any depth), annotations; the guide
  resource "Editing automation" (`jasper://guide/editing-automation`) with the recommended workflow cleanup →
  subtitles → apply_style → review → accept → style_check. Deleting a library recipe is an editor action (the route asks
  an agent for the user's approval).
- i18n: every UI string and the built-ins' names / descriptions, stage names and measure labels (model strings) in
  English and Spanish.

### Accuracy harness (EA-051, private)

`.prproj-analysis/research/automation-harness/run-style.ts` (build VM) rebuilds each of the 30 stripped edits and runs
the real `planStyle` with the built-in recipe of its format (Fast Shorts for the 19 shorts, Fast Long-form for the 11
long videos): subtitles from the caption phrases, then kits, punch-ins and Ken Burns, each planned on the earlier
stages' result. Cleanup is off (the stripped edits are the user's finished cuts, no audio). Reactions and music have
no assets (reported as missing roles). Slides have no overlays. The output uses `run.ts`'s format and goes through the
kits package's comparison. Measured on the VM on this branch (shared load; planning all 30 videos took 6.8 s):

| Measure | Shorts (19) | Long form (11) |
|---|---|---|
| Kits: user kits matched exactly / ±1 frame (recall) | 94.4 % / 95.5 % | 97.6 % |
| Kits: user kits on an A-roll cut that got a kit | 99.4 % | 98.4 % |
| Kits: planned on a user kit (precision) | 85.2 % | 95.7 % |
| Kit families jolt / zoom-blur / whip / zoom-through / spin, planned (user) | — | .491 / .165 / .163 / .091 / .089 (.489 / .169 / .174 / .086 / .081) |
| P(same family as the previous kit), planned (user) | — | 0.241 (0.231) |
| Ken Burns share of A-roll clips, planned (user) | 0.158 (0.159) | 0.150 (0.134) |
| Punch-ins: F1 / precision / recall, rate planned (user) | — (off in Fast Shorts) | 0.678 / 0.592 / 0.792, 11.9 /min (8.95 /min) |

**Punch-in tuning (long form; same harness, same 11 videos)**. Before, the punch-ins pass defaults (density 0.7,
shortest clip 1.5 s) gave F1 0.622 (precision 0.577, recall 0.674, 10.4 /min). After, Fast Long-form uses density 1 and
a 2.3 s shortest clip: F1 0.678 (precision 0.592, recall 0.792, 11.9 /min). Density 1 with a 1.5 s shortest clip gave
F1 0.708 at 14.8 /min. It was rejected because the rate is 65 % over the user's and the Style Check target is
9 ± 3 /min. **Assumption**: the tuning is in-sample (chosen and measured on the same 11 videos). Kits and Ken Burns
were already at the measured figures, so they were left unchanged.

### Verification (VM `wt-recipes`)

- Unit and command tests:
  - `packages/project/test/style-recipes.test.ts` (19): recipe schema and built-ins; the project copy, its commands
    with undo / redo and refusals; load repair; `pieceRefs`; `frameAfterCuts`; Apply Style plans (decorations on the
    cleaned-up timeline, requires, anchors stripped, picture end); partial accept; missing roles; Fast Shorts; a
    fast-check property over random clips, cleanup cuts, seeds and aspects (25 runs: every item valid after the
    cleanup, invariants hold after accept, no kit overlap, no clip both punched in and Ken Burns'd, no reaction over a
    subtitle region); Reroll; the
    clashing-temp-ref regression; the agent policy with embedded features; Style Check; `motionKindOf`.
  - `packages/session/test/style-history.test.ts` (1): one History entry; undo and redo give the exact documents.
- Engine tests:
  - `apps/engine/test/style-recipes-library.test.ts` (6): atomic writes; the repairs (index, missing, unlisted and
    invalid files); newer formats read-only; revisions.
  - `apps/engine/test/apply-style.test.ts` (5): dry run, then job, then accept; the export planner's route equals the
    dry run's class; Style Check on the result; Reroll and the stale cleanup; roles.
- `apps/mcp/test/style.test.ts` (7) and `apps/web/test/style-recipes.test.tsx` (8). The web tests include the Enter
  regression in the rename field.
- Full suites with `--maxWorkers=2`:
  - `@jasper/project`: 2596 passed.
  - `@jasper/session`: 92 passed.
  - `@jasper/mcp`: 309 passed, 8 skipped (the existing opt-in skips).
  - `packages/api` + `packages/engine-client`: 47 passed.
  - `@jasper/web`: 1121 passed.
  - Engine subset of 8 files (apply-style, style-recipes-library, automation, automation-overlays,
    proposals-features, cleanup, subtitle-templates, route-client-gone): 47 passed. The rest of the engine suite was not
    run.
- Other checks: typecheck of project, api, config, engine-client, session, engine, mcp and web; biome on the changed
  files; `check-layers`, `check-tokens`, `check-anime`; `pnpm i18n` and `pnpm i18n:check`.
- `e2e/apply-style.spec.ts` passed (5.0 min). It runs Apply Style with cleanup, subtitles and kits on the generated
  talking clip, then review, Accept all, Apply as one History entry, and a Remotion export. The kit frames differ from
  a reference with the FX track off; frames away from the kits match.
- Checked by hand in the dev stack on the VM: the Automate entries; Style Recipes (duplicate, rename, Use, version
  info); the Apply Style dry run per step; Propose, then Review (7 items), then Apply 7 of 7 (16:26 → 7:19 with
  subtitles, kits, a punch-in and beds); Style Check (6 on target, 2 off, look-here seek); the pass dialog defaults from
  the active recipe. Bugs found this way and fixed, each with a regression test:
  - Enter in a name field closed the dialog.
  - A punch-in was dropped because two stages declared the same setup ref (refs are now renamed per stage).
  - The cleanup row showed "0.0 dB".
  - A library rename did not show while the project copy was active (the library now wins).

### Limits

- Every decoration requires the cleanup item: accepting a decoration applies the cleanup's cuts too. To decorate
  without them, run Apply Style with the cleanup step off.
- If the sequence changes, the cleanup item goes stale: Refresh drops it with "run Apply Style again". It is not
  re-planned alone.
- After the cleanup alone is accepted, later timeline edits do not make the decorations planned on it stale (their
  anchors are the cleanup's, stripped).
- Review ghosts of decorations are drawn where they land after the cuts, so they are offset from the live timeline
  until the cleanup is accepted.
- Style Check's dead air needs a cached voice analysis per media; without one the measure is "not measured" with the
  reason. The dry run plans the cleanup with cached analyses only (Propose runs them).
- The Style Check tolerances and Clean's dead-air bound are chosen, not measured (assumption, above).
- Punch-in F1 is 0.678, below 0.75, and the tuning is in-sample. A tuned short-form punch-in recipe is not in scope
  (Fast Shorts has punch-ins off, as measured).
- Subtitles can hold past the picture end (spec 13 behaviour). Kits and the other passes stop at `pictureEnd`.
- The editor loads the library when a recipe dialog first opens and refreshes it on `styleRecipes.changed`.
- "Save Current Settings as Recipe…" uses the parameters the Automate dialogs last proposed with in this window. They
  are not persisted.
- Fixed since (wp-note [time.md](time.md) §15): the Remotion and native export paths showed different source frames
  where a clip's frames fall between source frames (frame-rate conform, the cleanup's in-points), and untagged SD
  footage was decoded with BT.601 natively but BT.709 by the preview. The e2e exports its reference natively again.
