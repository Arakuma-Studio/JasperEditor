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
  - Persistence: schema v9 optional field, read leniently (`agentProposalsAllowed`: absent entry → default; unreadable
    value → off for every feature, never a load failure), invariant `INV-PROJECT-SETTINGS`, repair keeps readable
    entries and rewrites the rest as `false` (reported). Row in `docs/project-files.md` "Fields added in v9".
  - Command: `project.updateSettings {settings: {agentProposals: {subtitles: false}}}` — merged per feature (other
    settings keep their replace semantics), validated strictly. The agent guard (`approvalReasons`) asks the user's
    approval for any entry set to `true` (an agent may turn a feature off, never on, by itself); the editor's Apply
    confirmation names such a grant inside a proposal (`approvalNeeds` → `agentProposals`).
  - Policies: `ProposalService` registers `projectFeaturePolicy(f)` for each project-setting feature through
    `registerPolicy` in its constructor; refusals are `403 APPROVAL_REQUIRED` naming the setting. Destructive commands
    inside an accepted item still need the approval card (headless → `APPROVAL_DENIED`), as before.
- Discovery: `GET /api/projects/:projectId/proposal-features` → `{features: [{id, name, description, itemNoun, groups,
  producers, agentAccept: {setting: 'project', allowed, default, explicit} | {setting: 'sound-sequence', sequences},
  refreshable}]}`; MCP `list_proposal_features {projectId}` (READ_ONLY). Client: `EngineClient.proposalFeatures`.

### Review vocabulary and ghosts (EA-002)

- Items name their group in `meta.group` (or `group`); the Review panel lists the feature's declared groups in their
  order with translated labels, then other groups (capitalised), Other, Tracks (`buildReviewModel(items, ghost,
  feature)`). Producers add a group by adding it to `PROPOSAL_FEATURES` (a label → `pnpm i18n` → Spanish).
- Feature sentences go through `apps/web/src/proposals/vocabulary.ts`: `reviewVocabulary(feature)` →
  `{groupOf, cardSentence?, itemsText, applyToast}`; the generic one uses the feature's noun ("ui-agent proposes Decorate
  Cuts: 214 edits", "Applied 12 of 40 cuts from …"); `registerReviewVocabulary(feature, v)` for a producer that needs
  more. Sound design is migrated onto the registry unchanged (role grouping Hero / Support / Bed / Layers, "n sounds on
  k new tracks", "Applied n of m sounds"; its review tests pass unchanged).
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
  easeIn?, easeOut?, spatial?}]}]}` — `path` is the property within the clip (`["transform", "scale"]`, `["opacity"]`,
  …) or `["effect", effectInstanceId | "$ref", param]` for an effect of that clip; `at` as `keyframe.add` (`{frames}`
  from the clip's start, `{sequenceFrame}`, …). Two keys of a target on one frame are refused. Result `{keyframeIds,
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
   on the engine's `ProposalService`; add your Review groups to `PROPOSAL_FEATURES` and, only if the noun is not
   enough, a vocabulary with `registerReviewVocabulary`.

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
first, then a seeded order. Start: the midpoint, or the transcript word start nearest it (`start: 'word'`); ramp
`rampFrames` (7) linear to `scale` (180 %) of the clip's own scale, held to the cut. Zoom about a point p: scale × k and
position' = p + k (position − p) on the same two linear keys, which is the same zoom about p on every frame between;
zooming in about any point of the frame keeps a covering picture covering it (property-tested), so p is only clamped to
the frame. Target `center`, `{x, y}` or `subject`: a faces roto on the clip (largest face present), else the Auto Reframe
analysis run inline by the job on 3 frames from the zoom start (face model when installed, else saliency), else the
centre (warning `W_NO_SUBJECT`). Method `motion` (default): `keyframe.addBatch` on scale (and position / scale width);
`adjustment`: a Transform adjustment clip (anchor = position = p, shutter 360° like the user's) on a "ZOOM" track
inserted right above the A-roll (a setup item). Optional whoosh (`sfx`, on by default) with its start on the zoom
start. Alternative: the other measured size (180 % ↔ 140 %).

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

Export cost class (dry run `summary.cost`): `native` for Motion keys (punch-ins, Ken Burns); `remotion` for kits and
adjustment punch-ins — the export planner has no native or layer-bake route for an adjustment layer's shader effects
(`nativeBlockers` names them: "adjustment clip … uses effect jasper.s.shake, which the native path cannot render"), so
the whole export goes through the Remotion renderer (tested in `apps/engine/test/automation.test.ts`: kits → path
`remotion` with the blocker; punch-ins + Ken Burns → `native`).

### Export cost of 100 kits (EA-033, measured)

`KITS_BENCH=1 pnpm exec vitest run apps/engine/test/automation-kits-bench.test.ts` (results in
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

- `packages/project/test/automation-planners.test.ts` (20): kit packs valid, eases resolve; repeat penalty keeps the
  shares and gives 0.23; per-side eased batch keys; every kit centred on its cut exactly and disjoint (example and
  fast-check property over random edits, seeds and both aspects); determinism; shorts pack; close cuts → shorter
  family / `too-close`; edges, transitions, decorated cuts; coverage, spacing, range, track, refusals; family shares
  and repeat rate over 2 000+ kits; proposal = FX track + one item per kit, accept = one transaction (one revision),
  invariants hold, the document before untouched; whip curves evaluated relative to the cut; Refresh of a moved cut
  (same id, frame moved, swapped in by `refreshProposalItems`), Reroll = next seed, gone cut dropped; punch-ins
  (candidates, midpoint, 7-frame linear ramp, hold, a second pass skips them, reframed clips, coverage property,
  adjustment method on a ZOOM track above the A-roll); Ken Burns (share, keys on first / last frame, in : out, per
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

- Kits export through the Remotion path (whole export); a hybrid route that bakes only the kit spans of the composite
  does not exist (the cost is in the export bench below).
- The whoosh is cut to the kit's span with hard edges (like the user's slices of a compilation); no fade is added.
- `subject` targets need a faces roto or the engine's Reframe analysis; headless refresh of subject punch-ins
  re-measures the refreshed clips only.
- Reactions, overlay slides, music beds, stingers, style recipes, `apply_style` and Style Check are later work packages
  (`AUTOMATE_MENU`, `AUTOMATION_PASSES` are where they plug in).
- Punch-in F1 below the spec's target (above).
