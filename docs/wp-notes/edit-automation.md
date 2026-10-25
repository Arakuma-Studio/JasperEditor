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

- No producer exists yet, so no feature registers a refresher: Refresh proposal is disabled with its reason for every
  proposal today (docs/gaps.md "edit-automation").
- `set_project_settings` (MCP) does not expose `agentProposals`; agents use `apply_commands project.updateSettings`
  (turning a feature on asks the user).
