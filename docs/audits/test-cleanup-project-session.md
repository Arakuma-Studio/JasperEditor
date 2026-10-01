# Project, session, API, client, and config test audit

Scope: `packages/{project,session,api,engine-client,config}/test`. Repository guidance came from the task's host-wide AGENTS.md text; no repository AGENTS.md was found. Test command: `pnpm test` (`vitest run`); package focus: `pnpm --filter @jasper/project test` and equivalent package scripts. Gates: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`. No coverage percentage or test-count gate was found. Before edits, `main` and `origin/main` both pointed to `348d18e` and the worktree was clean.

## Pre-edit decisions

| Test | Disposition | Failure it can detect; stronger remaining owner | Seam and risk | Validation |
| --- | --- | --- | --- | --- |
| `packages/project/test/anime-contracts.test.ts`: “clip.addShape is registered and owned by wp-m2-shapes (implemented there, test/shapes.test.ts)” | DELETE | Only owner/milestone metadata and duplicate command acceptance; `shapes.test.ts` covers actual shape creation and rejection. | `COMMAND_CATALOG` has production callers; only this metadata assertion is removed. Low risk. | Project test/typecheck. |
| Same file: “new clip.update / clip.addText fields validate their target, then name their owner” | DELETE | `COMMAND_FIELD_OWNERS` is an obsolete work-package table; text/shape/template validation has dedicated tests in `text-animation.test.ts`, `shapes.test.ts`, `anime-templates.test.ts`. | Table has no production caller. Low risk. | Project test/typecheck and workspace typecheck. |
| `packages/project/test/anime-contracts.test.ts`: “clip.addMotionGraphic stamps the anime renderer from the registry; upgrades need an installed target” | DELETE | Duplicates installed-template and upgrade behavior in `anime-templates.test.ts`. | Public command still covered; no seam deletion from this test. Low risk. | Project test. |
| `packages/project/test/anime-contracts.test.ts`: “registers the shape kind (capabilities like text, Remotion engines, graphics label)” | DELETE | Asserts registry metadata and capability shape; user-visible creation/rendering in `shapes.test.ts` and E2E shapes is stronger. | No seam deletion. Low risk. | Project test. |
| Same file: “text without animators and fframes templates keep their M1 snapshot shape” | DELETE | Exact private snapshot property-key inventory; rendering and legacy persistence tests cover behavior. | No seam deletion. Low risk. | Project test. |
| Same file: “lookups use the shipped catalogue (wp-m2-text-anim) or an explicit list” | DELETE | Compares a lookup against the catalogue object it searches; `text-animation.test.ts` tests the specified preset IDs, versions and command behavior. | `getTextAnimationSpec` has production callers in rendering, validation, property registry and commands; it stays. Low risk. | Project test. |
| Same file: “defaultShape: white fill, no stroke, radius 0, 400×400” | DELETE | `shapes.test.ts` “defaults: 400×400…” checks the same specified defaults through the user-facing `clip.addShape` command. | `defaultShape` remains used in handlers and the retained intrinsic-box test. Low risk. | Project test. |
| Same file: “carries text animation, the anime renderer and shapes” | DELETE | Duplicates snapshot contracts already checked independently and more strongly by `text-animation.test.ts`, `anime-templates.test.ts`, and `shapes.test.ts`. | `buildRenderSnapshot` has production callers; only this duplicate test and its local wrapper are removed. Low risk. | Project test. |
| `packages/project/test/transaction.test.ts`: “registers every M1 and M2 command type” | REWRITE | Published command IDs are required by ARCHITECTURE §5.3 and MCP callers. Preserve the independent command list; delete owner-label assertions, which detect only internal assignment changes. | `COMMAND_CATALOG` remains used by transactions and MCP. Low risk. | Project test/typecheck. |
| `packages/project/test/text-animation.test.ts`: “ships the twelve presets…” | REWRITE | Preset IDs/phases/version compatibility are specified by S11 TXA-002/003 and are user-visible. Drop self-identity assertion and description-length cosmetic assertion. | Catalogue is used by UI, schemas, rendering. Low risk. | Project test/typecheck. |
| `packages/project/test/anime-contracts.test.ts`: “lists text animations…” | REWRITE | Agent schema is a public protocol (S11 ANA-001); keep version/render capability assertions. Delete work-package `owner` expectation. | Public `exportAgentSchema` has engine and web callers. Low risk. | Project test/typecheck. |
| `packages/project/test/clip-edit.test.ts`: “AC-10b: insert move of a 60-frame clip at 300 shifts sync-locked tracks and splits straddlers” | DELETE | Duplicate of `place-move.test.ts` AC-10b, which additionally checks an audio sync-locked track. | Public `clip.move` remains covered. Low risk. | Project test. |
| `packages/project/test/clip-edit.test.ts`: “AC-11b: regular-trimming A into adjacent B stops exactly at B” | DELETE | Duplicate of `edit.test.ts` “regular trims clamp at neighbours and media bounds”, which checks the warning and source bound too. | Public `clip.trim` remains covered. Low risk. | Project test. |
| `packages/project/test/clip-edit.test.ts`: “AC-12a: razor on all unlocked tracks at 500 splits nothing on a locked track” | DELETE | Duplicate of `edit.test.ts` AC-12a, which includes video, audio and a locked track. | Public `clip.split` remains covered. Low risk. | Project test. |
| `packages/project/test/clip-edit.test.ts`: “AC-13b: ripple delete is refused with content on a sync-locked track; sync lock off makes it succeed” | DELETE | Duplicate of `edit.test.ts` AC-13b, which additionally verifies blocking clip ID and unlocked retry. | Public `clip.extract` remains covered. Low risk. | Project test. |
| `packages/project/test/clip-edit.test.ts`: “AC-15a: In at 100 and Out at 199 (inclusive) store a 100-frame range” | DELETE | The test supplies `199 + 1` itself, then subtracts 100; it cannot catch a conversion bug. `range.extract` AC-13d tests the actual 100-frame range consequence. | Public `sequence.setInOut` remains available. Low risk. | Project test. |
| `packages/project/test/shapes.test.ts`: “every keyframe / stopwatch command is wrapped by keepShapesCentred” | DELETE | Checks membership in the private wrapper set; surviving shape tests move keys and inspect on-screen centre after operations. | `SHAPE_BOX_COMMANDS` remains used by the production catalog; its direct test import is removed. Low risk. | Project test. |
| `packages/project/test/m2-contracts.test.ts`: “accepts, sorts and clamps control points”; “rejects duplicate x, too few points and junk” | REWRITE | S06 CGA-001 requires curve values through `param.set` to be sorted, clamped and validated. Existing tests call private `validateValue` with a hand-made rule. Use the public transaction command and inspect stored effect value / error code. | `validateValue` has production callers in param, keyframe, effect and clipboard handlers; no seam removal. Medium risk: verify actual command outcome. | Project test/typecheck. |
| `packages/project/test/time.test.ts`: “seeded ids are deterministic” | DELETE | Only checks the output of a helper explicitly documented as test-only. Random production IDs are still checked in the adjacent case; deterministic fixture IDs use the counter helper. | `createSeededIdSource` had no non-test callers and was removed after fixture imports migrated. Low risk; validate all packages. | Workspace typecheck and test. |

The removed production constants `COMMAND_FIELD_OWNERS`, `MG_TEMPLATE_OWNER`, and `TEXT_ANIMATION_OWNER`, plus `patchFieldNotImplemented`, had no non-test callers; their only uses were the deleted test, the dead table, and a stale comment. `createSeededIdSource` was also test-only; all fixture callers now use the existing counter ID source.

## Final disposition

The pre-edit table above records every DELETE and the targeted REWRITE decisions. All retained cases are listed below. For each file, the numbered basis explicitly addresses: (1) independent source, (2) recognizable failure, (3) expected result independent of the implementation, (4) stable seam, (5) refactor tolerance, and (6) lowest stable owner. A case title gives the particular failure protected. Parameterized cases are named individually. No test-only production seam was kept solely for a test.

### `packages/api/test/api.test.ts`

**Six-bar basis:** (1) ARCHITECTURE §9.2 and S04 ENG-022/023 API wire contract; (2) a regression in client/server routes and schemas fails the named case; (3) assertions use fixed route list, wire objects and error codes; (4) they observe exported ROUTES, path builders and Zod parsers; (5) equivalent internal refactors preserve those outputs; (6) this package owns HTTP protocol; engine tests exercise server implementation.

- **KEEP** `covers every M1 route of ARCHITECTURE §9.2`: protects the specified client/server routes and schemas.
- **KEEP** `builds paths and classifies engine prefixes`: protects the specified client/server routes and schemas.
- **KEEP** `shapes errors per S04:ENG-022`: protects the specified client/server routes and schemas.
- **KEEP** `parses events and ignores unknown types`: protects the specified client/server routes and schemas.
- **KEEP** `validates jobs and capabilities`: protects the specified client/server routes and schemas.
- **KEEP** `round-trips a real envelope, export request and transaction result`: protects the specified client/server routes and schemas.

### `packages/config/test/config.test.ts`

**Six-bar basis:** (1) ARCHITECTURE §4.3 and S04 ENG-010 appdir/CLI contract; (2) a regression in CLI/environment precedence and persisted/runtime paths fails the named case; (3) assertions use fixed argv/env/path examples from the documented layout; (4) they observe exported config functions; (5) equivalent internal refactors preserve those outputs; (6) this package owns config parsing and path construction.

- **KEEP** `reads flags in both forms`: protects the specified CLI/environment precedence and persisted/runtime paths.
- **KEEP** `resolves appdir with argv > env > default`: protects the specified CLI/environment precedence and persisted/runtime paths.
- **KEEP** `resolves port`: protects the specified CLI/environment precedence and persisted/runtime paths.
- **KEEP** `parses truthy env values`: protects the specified CLI/environment precedence and persisted/runtime paths.
- **KEEP** `lays out the appdir per ARCHITECTURE §4.3`: protects the specified CLI/environment precedence and persisted/runtime paths.
- **KEEP** `locates the desktop appdir and parses runtime files`: protects the specified CLI/environment precedence and persisted/runtime paths.

### `packages/engine-client/test/client.test.ts`

**Six-bar basis:** (1) S04 ENG/IN wire and upload/event contracts; (2) a regression in request paths, auth, upload and event stream behavior fails the named case; (3) assertions use scripted server responses and timed byte/event sequences; (4) they observe public EngineClient methods and fetched wire messages; (5) equivalent internal refactors preserve those outputs; (6) this package owns client protocol; engine tests own server routes.

- **KEEP** `calls typed routes with relative URLs and parses responses`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `sends If-Match, JSON bodies and bearer tokens`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `maps error shapes, 501 stubs, invalid responses and API mismatches`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `builds media and output URLs`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `uploads in chunks, resumes on offset mismatch and completes`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `aborts the upload session when cancelled`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `parses events split across chunks, reconnects with backoff and resumes with since`: protects the specified request paths, auth, upload and event stream behavior.
- **KEEP** `reconnects when heartbeats stop and caps the backoff at 30 s`: protects the specified request paths, auth, upload and event stream behavior.

### `packages/project/test/agent.test.ts`

**Six-bar basis:** (1) S01 AGT and S02 TL agent query/addressing/approval requirements; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `sequence.summary reports tracks, markers and timecodes`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `sequence.clipsInRange filters by range and track labels, with source seconds`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `sequence.at evaluates the stack at a frame (bottom → top)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `doc.get supports paths and field projection; session-only queries need a session`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `exports JSON Schemas for every query`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `resolves mediaByName, clipAt and markerByName`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `fails with E_AMBIGUOUS / E_NOT_FOUND and the command index`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `flags destructive commands and force`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `enforces limits and normalizes origins`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/anime-contracts.test.ts`

**Six-bar basis:** (1) ARCHITECTURE §20.1 and S11 schema, rendering, agent contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `is version 4 and the v4 fixture (animated text, anime template, rect + ellipse) loads without repairs`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `rejects malformed animators and shapes at load (schema), and flags them after edits (invariants)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `intrinsic box = largest size + the stroke drawn outside the geometry`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `scales reference-rate frames to the sequence rate (round, ≥ 1)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `compresses in + out proportionally when they do not fit the clip with one frame at rest`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps one frame at rest on 1- and 2-frame clips with both sides (the text shows)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `merges preset defaults for known presets and passes unknown presets through`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `clipEngines: kind defaults; anime templates are Remotion-rendered`: protects the specified document edits, persistence, math or render output named by each case.
- **REWRITE** `lists text animations, template renderers and the kinds of every property`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/anime-templates.test.ts`

**Six-bar basis:** (1) S11 ATP template version, renderer and keyframe contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `numeric (non-integer) and colour params are keyframable on anime templates only`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the stopwatch, param.set at frames and the keyframe commands work on params.<name>`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `integer, string and enum params and fframes template params stay static`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframes.prune, split and duplicate handle param keyframes (fresh ids, content time)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `evaluateTemplateParams evaluates and clamps keyframed params, ignoring non-keyframable names`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the snapshot carries param keyframes for anime templates only (unevaluated)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `clip.update {template: {version}} migrates params, re-stamps and keeps compatible keyframes`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `params in the same patch as an upgrade target the new version`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `re-stamps the renderer when a new version changes it (fframes → anime)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses downgrades, versions that are not installed and versions without a path; same version is a no-op`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses an upgrade whose version lacks the canvas the clip uses`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `accepts the same aspect at another size, the sequence canvas, and canvases the old version lacked too`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `flags a stamp that contradicts a known registry entry (unknown templates are left alone)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `repairs the stamps on load (loadProject with the registry) and drops malformed param keyframes`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/clip-edit.test.ts`

**Six-bar basis:** (1) S02 TL editing and AC command contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `butt edit, out edge +10` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `butt edit, in edge -30 (incoming grabbed)` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `both sides keep >= 1 frame` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `clip|gap: the gap shrinks until the next clip` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `gap|clip: the gap resizes, frame 0 bounds it` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `last clip out edge behaves like a regular trim` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `media handles limit both sides and source stays glued to the picture`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `linked partners roll together; Alt (linked: false) rolls one side only`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses on a locked track`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-12b: a clip with 10 frames of head handle stops after 10 frames of rightward slip`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `leftward slip shows later material and stops at the end of the media`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `multi-clip slip moves in lockstep with the most restrictive handle`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses when none of the selected clips can slip`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-12c: sliding B between A and C by +12 lengthens A, shortens C, keeps B source and length`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `gap neighbours resize instead of clips; frame 0 bounds the slide`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `neighbour media limits stop the slide`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `linked partners slide with the clip`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-12d: stretching a 100-frame clip to 200 frames yields speed 0.5 and the same source range`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a rate derives the duration from the source span`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `without ripple the duration is clamped to the next clip and the rate is kept`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `with ripple later clips and sync-locked tracks shift`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `linked V/A shift sync-locked followers only once`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `reverse flips the mapping without touching sourceIn or duration`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `clips without speed (stills, text, solids) only change duration`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `copies to the first free space to the right with new ids and a mirrored link group`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `deltaFrames and destination tracks place copies with overwrite semantics`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `copies keyframes with fresh ids`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `unlink dissolves the group; link re-creates one`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `linking moves a clip out of its previous group (dissolving it when it drops below two)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `skips clips without a transform and refuses when none has one`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-13d: extract In=100 Out=199 removes exactly 100 frames from targeted and sync-locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `tracks that are neither targeted nor sync-locked are untouched; locked tracks never shift`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `lift leaves a gap and splits clips at In and Out with relinked right parts`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-16b: extracting 30 frames before a marker moves it 30 frames left (and keeps it with rippleMarkers false)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses an empty range and an explicitly locked track`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `closes the gap and ripples sync-locked tracks that are empty in the gap range`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses with E_SYNC_CONFLICT naming the blocking clip; sync lock off makes it succeed`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the area after the last clip is not a gap`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-11d: Q (ripple-remove [clipStart, playhead)) removes the head and closes the gap`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-13a: Add Edit on targeted V1/A1 splits only V1/A1 clips crossing 240`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `every committed document passes INV-001…015; rejections leave the document unchanged`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `slip keeps timeline positions; slide keeps the sequence length; roll keeps both neighbours contiguous`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/clipboard.test.ts`

**Six-bar basis:** (1) S01 CLB and S02 clipboard/edit contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `copies clips with their linked partners, transitions, layout and every referenced entity`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `round-trips through text/html with non-ASCII text, and rejects HTML without the marker`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `validates with zod: foreign data, other versions, oversize and malformed entities are refused`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the paste commands refuse invalid and oversized payloads atomically`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `pastes at the playhead in overwrite mode with new ids, relative layout, links and transitions`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `overwrites what is under the pasted clips, and Paste Insert ripples instead (TRK-006)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses locked destinations and kind mismatches`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps every M2 field: text animators, shape keyframes, anime template params and renderer stamp`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `remaps trackers: a pasted target follows the pasted copy of its plate (S09)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `converts starts, durations, transitions and animator windows to the target frame rate`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `reuses media with the same fingerprint, adds missing assets with new ids and a project item`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `copies synthetics, transcripts and fonts with new ids (fonts with the same family are reused)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `resolves LUT media in effect params, composition bundles and derivation sources`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `applies the chosen attributes to every target in one transaction, keeping key offsets`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `Scale Attribute Times stretches keys to the target duration`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `pastes text animators, text style and shape style (M2) and refuses attributes that apply to nothing`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `Remove Attributes resets intrinsics and removes effects by registry id`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `effect.paste appends copied effects (and copied intrinsics) to every selected clip (EC-032)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `pastes keys at the playhead keeping relative timing, onto the same property path`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses a selected property of another value kind, and pastes shape size keys (M2)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `deep-copies sequences with new ids and remapped references, into the chosen bin`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `pastes bins with their children into another project (media resolved, items added once)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `throw on empty selections`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `payload data is never treated as addresses, temp refs or selections`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/color.test.ts`

**Six-bar basis:** (1) S06 CG colour transfer, curve, LUT and fusion contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `is registered by default as a colour correction effect with the contract param list`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `CG-021: defaults are the identity (null function; bit-exact on lattice points)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `CG-022: temperature warms (r > b), tint > 0 lowers green, exposure +1 doubles linear light, saturation 0 is grey`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `white balance gains keep the luma of grey`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `contrast pivots around mid-grey; whites/blacks move the end points`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `highlights act on bright tones, shadows on dark tones`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `vibrance boosts dull colours more than saturated ones`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `wheels: a shadows wheel towards red raises r most in the darks; gamma/gain follow their levels`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `curves: master then per channel`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `input LUT and look LUT with intensity (order of CG-020)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `output is always clamped to 0..1`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `passes through its points and is flat outside them`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `monotone data gives a monotone curve (property test)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `slopes are zero at local extrema (shape preserving)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the identity curve and collinear points are the identity`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `Brightness & Contrast matches S03:FX-040 within 1e-6`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `Hue/Saturation equals the CSS hue-rotate then saturate matrices within 1e-6`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `Black & White is lerp(v, Y(v), amount)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the M1 colour effects have no native filter strings any more (no eq/hue, D-13) but fuse as colour runs`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `consecutive colour effects fuse; blur ends the run; the baked LUT equals the composed function`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the run key changes with params and with the content identity of referenced LUTs`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a 33³ bake of a full grade takes < 15 ms (S06:CG-043; reported, fails above 2×)`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/composition.test.ts`

**Six-bar basis:** (1) S08 MGC composition/props contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `places a 90-frame composition clip with the composition size as canvas`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `fits a larger composition into a smaller sequence and keeps overrides`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `rejects unknown bundles, compositions and invalid props; clamps a too-long duration`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `an mg-bundle cannot be placed with clip.place`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `renders at the sequence rate: a 25 fps composition in a 30 fps sequence is scaled and warned about`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `param.set props.title validates against the schema: a number is rejected`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `clip.update {props} replaces the override object; {} resets to defaults`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `writes into nested values: array elements keep their siblings (inferred Badge schema)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `undo is the previous document (snapshot history): the edit never mutates it`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `cannot be trimmed beyond the composition; transitions get handles inside it`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `split keeps the composition content time continuous`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `accepts the new header and fingerprint without force`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `carries effective props, the bundle key and composition info; resolveComposition adds pre-renders`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a composition missing from the bundle has info null (rendered as a card, MGC-014)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `builds one spec per leaf from the schema, with hints, defaults and ParamPaths`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `nested objects become dotted keys; arrays and free-form values are json`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `validates the common keywords`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `infers a form schema from defaultProps`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `merges objects, replaces arrays; set/unset paths`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `maps content time to composition frames and render ranges with handles`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/document.test.ts`

**Six-bar basis:** (1) S01 PER/DOC/MIG persistence and forward compatibility contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `the v1 fixture always loads without repairs`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `v1 → v2 relabels default-labelled audio halves of A/V clips and nothing else`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `v1 → v2 keeps labels the user chose on audio clips`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the v2 fixture loads unchanged (v2 → v3 → v4 are version bumps only) and newer versions open read-only`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `rejects data that is not a project`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-24: unknown effect id and unknown clip kind load, are bypassed, and survive edits and saves`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-20: overlapping clips open with a repair report; the later clip moves to a new track`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `drops dangling references and dissolves broken link groups`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/edit.test.ts`

**Six-bar basis:** (1) S01 CLP/SEQ and S02 AC edit contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `AC-11a: trimming the head of a 50% speed clip by 10 frames advances sourceIn by 5 frames`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `regular trims clamp at neighbours and media bounds with W_DURATION_CLAMPED`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `trims linked partners with coincident edges`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-11c: ripple trim shifts later clips on the track and sync-locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-11c: content on a sync-locked track refuses the command (E_SYNC_CONFLICT) or stops the gesture`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `ripple lengthening splits straddling clips on sync-locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `splits linked partners, relinks right parts and copies keyframes with new ids`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-06: split + head trim keeps on-screen values identical`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-12a: razor all unlocked tracks at 500 skips locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `S02 AC-1a: 500 random splits at 37% speed (29.97) re-join exactly`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `lift leaves a gap; extract closes it on sync-locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-13b: ripple delete is refused when a sync-locked track has content in the range`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-07: 30 → 25 fps keeps adjacency, keeps keyframes on the picture and collapses 1-frame clips`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `frame size change keeps offset from center (S01:SEQ-007)`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/fuzz.test.ts`

**Six-bar basis:** (1) S01 AC-25 invariant and transaction atomicity contract; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `holds for ${RUNS} random runs`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/keyframe-effect.test.ts`

**Six-bar basis:** (1) S01 FX/KF and S03 PRP/easing contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `AC-10 (blur half): an agent transaction creates a text clip and blurs it through a temp ref`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `inserts at an index, validates and clamps params, refuses unknown ids and wrong targets`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `validates animated param overrides (pasted/agent keyframes) field by field`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses video effects on audio clips and edits on locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `removes, reorders and bypasses; reorder clamps the index`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `supports track and master targets with an audio effect registry`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `FX-022: unknown effects are preserved, bypassed, reorderable, removable and not editable`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-EC-1: stopwatch at frame 10 + value at frame 40 gives a linear ramp everywhere`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-EC-2 / AC-08: Ease Out, Ease In and Easy Ease match the Bézier table`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframe.add replaces at the same time, keyframe.update edits, keyframe.remove of the last key keeps its value`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframe.move shifts by whole frames, replaces a key it lands on and refuses negative times`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `auto-bezier stores neighbour-derived slopes and recomputes them when a neighbour moves`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `continuous bezier keeps equal velocity on both sides of a key`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-EC-3 / AC-06: splitting eased position animation keeps motion identical (≤ 0.001 px)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframes.prune removes keys that cannot affect the visible range (S01:KF-006)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframe commands on track and master parameters use sequence time`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframe edits on a locked track are refused atomically`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `random keyframe/effect transactions keep every invariant`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `holds the 7 M1 effects with badges, categories and param specs`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `golden param → preview/native mappings`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `brightness/contrast preview transfer equals the canonical formula`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `builds preview segments (merging CSS filters) and native chains in stack order`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `exports a JSON Schema per clip including applied effect params`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `generates motion-graphic params.* specs from the template schema with defaults`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `resolves values at the playhead, computes reset values and picks the write command`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `effect param specs map to ParamPaths the handlers accept`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/keyframes.test.ts`

**Six-bar basis:** (1) S01 KF interpolation contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `returns the static value without keyframes and clamps outside the range`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `linear at u = 0.5 gives the midpoint (numbers, vectors, colors)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `easy ease gives p(0.5) = 0.5 and p'(0) = 0`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `linear preset equals p = u`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `hold gives a step`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `hold-only value types step regardless of interpolation (S01:KF-007)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `auto-bezier on a local maximum does not overshoot`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `auto-bezier keeps a monotonic ramp smooth and bounded`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `overshooting eases are clamped to the parameter range when asked`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `matches a table of reference values`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/m2-contracts.test.ts`

**Six-bar basis:** (1) ARCHITECTURE §19 and S06 CGA/LUT/corner-pin contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `the v3 fixture with a LUT, an mg-bundle, a tracker and a corner pin loads without repairs`: protects the specified document edits, persistence, math or render output named by each case.
- **REWRITE** `accepts, sorts and clamps control points`: protects the specified document edits, persistence, math or render output named by each case.
- **REWRITE** `rejects duplicate x, too few points and junk`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `parses what it serializes (3D) and ignores comments / vendor keywords`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the identity LUT is exact at lattice points and between them (tetrahedral)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a baked function is reproduced within LUT precision; intensity mixes linearly`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `1D LUTs and domains`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `reports malformed files with a line number`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `groups consecutive colour effects, keeps other effects as barriers, drops disabled ones`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `bakes a run into one LUT (identity runs bake to null) and keys it by params and LUT identity`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `colour effects count as native in the Effects panel badges`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `maps the unit square / a box onto a quad and back`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `detects affine maps, convex quads and writes CSS matrix3d`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a corner pin makes the scene resolver emit a projective map and the pinned quad`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/place-move.test.ts`

**Six-bar basis:** (1) S01 CLP and S02 AC placement/move contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `AC-02: places linked V1/A1 clips from a 10 s stereo video`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps the last frame of media whose probed duration is rounded to microseconds`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `DT-021: linked A/V halves get the Movie label on video and the Audio label on audio`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `DT-021: a label the user chose for the item applies to both halves`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-03: overwrite into the middle splits the linked clips around it`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-04: insert shifts every sync-locked track and splits straddling clips`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `locked tracks are untouched by inserts (ARCHITECTURE §2.3)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `video V2 places audio on A2 and creates missing tracks (S02 AC-10c)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses a locked destination and wrong track kinds`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `default scaling fits larger media and keeps smaller media at 100 (S01:FX-004)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `dedupes media by fingerprint (S01 media.register)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-10a: overwrite move trims the clip underneath and leaves a gap at the origin`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-10b: insert move shifts all sync-locked unlocked tracks and splits straddlers`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `moves linked clips as a block and refuses missing tracks without createTracks`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/process-rescale.test.ts`

**Six-bar basis:** (1) S07 PRC source-swap framing contract; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `keeps the rendered framing identical (matrix, cropped quad, tracker points) for any size change`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a swap and its inverse restore Motion and trackers (within 1e-9)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `exact powers of two round-trip bit-exactly`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `848×480 → 1920×1080: per-axis factors, Uniform Scale split and restored`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `same size is a plain copy; animated Uniform Scale splits need new keyframe ids`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps the rendered layer identical and restores Motion when swapping back; invariants hold`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/process.test.ts`

**Six-bar basis:** (1) S07 PRC process/relink/derivation contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `adds the asset and its item in a "Processed" bin next to the original bin, and swaps clips in one transaction`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `names items from the step labels`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `is idempotent: the same file (or the same recipe of the same source) is reused, the swaps still happen`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `puts the bin at the root when the original bin is at the root; binId overrides`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `an original item at the project root gets a "Processed" bin at the root`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses without an engine asset, for unknown or non-video sources, and rolls back failed swaps`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `follows derivation chains: every version of the same original is a valid target`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `swaps to a 2× version and back, compensating Motion exactly (framing unchanged)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps keyframes, markers and trackers (tracker geometry in media pixels follows the size)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `is a no-op for the current media and refuses unrelated media, non-video clips, missing ids and locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `works on processed versions that the clip switched to through media.derive (swap back to the original)`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/render.test.ts`

**Six-bar basis:** (1) S03 DM transform and ARCHITECTURE §5.5 render contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `anchor lands on position`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `matches translate·rotate·scale·translate for rotation × non-uniform scale × anchor`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `rotates clockwise on screen (y-down)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `non-uniform scale: Scale is vertical, Scale Width horizontal (S01:FX-001)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `quad, bounds and inverse are consistent; crop hides without moving`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `builds tracks bottom→top, resolves mute/solo/output and evaluates layers per frame`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `limits the snapshot to an export range`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/shapes.test.ts`

**Six-bar basis:** (1) S11 SHP shape command, geometry and rendering contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `defaults: 400×400 at the sequence centre, white fill, no stroke, radius 0, 5 s, graphics label`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `takes size, fill, stroke, radius, transform, duration and name`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `validates colours, sizes and the rectangle-only corner radius`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `places like text: overwrite on the target track, creates missing tracks, refuses locked tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `merges fill, stroke and radius; null removes fill / stroke`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `accepts Animatables; a static value replaces keys; validates every key`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses cornerRadius on ellipses and shape patches on other kinds`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `param.set writes size, fill, stroke and radius; clamps negative sizes`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `creates a "None" fill or stroke on first write`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframes on size, fill, stroke and radius go through the shared keyframe commands and evaluator`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `static size and stroke edits keep the geometry centre on screen`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframes that grow or shrink the largest size move the anchor (value and keys) by half`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `flags colours outside 0..1`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `snapshot carries the unevaluated shape, its box and the Remotion engine`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `properties: corner radius for rectangles only; all shape keys are listed for agents`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `evaluates and clamps, centres the geometry in the box, drops zero-width strokes`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `hit-tests the drawn geometry: ellipse interior, rounded corners and the outer stroke band`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframe.move onto the largest key keeps the shape in place (finding 1)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keyframe.move deleting the widest outside-stroke key keeps the shape in place`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `once keyed, the box ignores a stale static value (size and stroke width, finding 2)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `re-centring stays correct across static → animated → static with a stale value`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `only an explicit value creates a "None" fill or stroke; the stopwatch on None is refused (finding 3)`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/text-animation.test.ts`

**Six-bar basis:** (1) S11 TXA text animation and FIX-004 contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **REWRITE** `ships the twelve presets, each usable as in and out, with defaults = the schema of {}`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `common params are bounded (stagger 0…1, units, orders, eases)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `writes both sides: params = defaults ⊕ given, window = default scaled to the sequence fps`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `refuses unknown presets (E_UNKNOWN_EFFECT) and bad params (E_INVALID_PARAM with the path)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `warns W_ANIMATION_COMPRESSED when in + out exceed the clip (no invariant failure)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `replaces a side with preset (params reset), merges without preset, removes with null`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `validates: merge without a side, bad params, non-text clips`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `applies to many clips in one transaction (clipIds) and warns when it compresses`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps unknown presets (durations editable, params refused)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `new animations get @2 with its defaults; saved @1 animators keep their version, params and snapshot`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `pickers list only the latest version (one Typewriter entry)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `razor: left keeps In only, right keeps Out only; undo-free copies stay independent`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `duplicate copies the animators; trims keep the windows and warn when they compress`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `a sequence frame-rate change remaps the windows (round, ≥ 1)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `static keys are registered for text clips; params are dynamic per preset`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `param.set writes presets, windows and params through clip.update (validated as a whole)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `FIX-004: param.set on layout-affecting text style fields re-runs layout like clip.update`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `flags and repairs invalid params of known presets; unknown presets are kept`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `the snapshot carries resolved, compressed animators; styled runs load their faces`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `agent queries report text animation and shape/composition sources`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/time.test.ts`

**Six-bar basis:** (1) S01 ID/TIME/SEQ and S02 timecode contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `generates prefixed 16-char Crockford ids`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `F(r) is an integer for every allowed sequence rate`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `converts frames, flicks and seconds`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `maps frames between rates monotonically (S01:SEQ-006)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `rounds media rates to the nearest allowed rate`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-01: new 1080p 29.97 project is drop-frame with V1–V3/A1–A3 and frame 1800 = 00;01;00;02`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `formats non-drop and drop-frame timecode`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `normalizes invalid drop-frame labels to the next valid frame`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `drop-frame round-trips over 24 h at 29.97 (${FUZZ ? 'every frame' : 'sampled'})`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `drop-frame round-trips over 24 h at 59.94 (${FUZZ ? 'every frame' : 'sampled'})`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `non-drop round-trips`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `parses partial entries (S02:TL-205, S05:TY-006)`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/tracker.test.ts`

**Six-bar basis:** (1) S09 TRK tracking geometry/data contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `adds planar and point trackers on video clips with media-px geometry and content time`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `updates, stores samples (replace / span merge) and removes trackers`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `moving the reference after tracking re-anchors every sample through the plane motion`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `split copies trackers to both halves with new ids; duplicate too; trackedBy follows the pin copy`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `scales trackers for a source of another size (S07:PRC-006)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `interpolates linearly between samples and holds outside the span`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `smooths with a centred moving average that keeps linear motion and static ends`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `merges disjoint spans with lost samples in the gap`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `re-anchors point samples by translation`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `converts engine results (source frames) to samples (content flicks)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `corner pin reproduces the tracked corners through plate Motion (150 %, 10°) and animated target Motion`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `transform mode: position follows the quad centre, scale/rotation relative to the reference`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `tracker.unlink drops the link and keeps the keyframes`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `removing a tracker keeps the keyframes and drops the link`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `builds forward / both / from-here requests in source frames`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/transaction.test.ts`

**Six-bar basis:** (1) S01 CMD/AGT/UND transaction and catalog contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `AC-09: a failing third command applies nothing and reports commandIndex 2`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-10: temp refs create a text clip and target it in later commands`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `AC-11: stale expectedRevision is refused when it touches a changed clip, fast-forwards otherwise`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `dry runs return the result without changing the document`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `enforces the command limit and schemas`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `resolves $selection and $selection.primary`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `does not substitute $-strings in text content`: protects the specified document edits, persistence, math or render output named by each case.
- **REWRITE** `registers every M1 and M2 command type`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `stubs refuse with E_NOT_IMPLEMENTED`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `flags approval-gated commands (S01:AGT-011)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `exports JSON Schemas for every command (S01:AGT-002)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `bins, moves, cycles and deletes items; in-use media needs force`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `source marks drive clip.place ranges (S01:PRJ-005)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `markers on sequences and clips; tracks add/remove/update`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `param.set validates, clamps and supports effects, tracks and master`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `clip.update edits text and motion-graphic params through the template registry`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `sequence.create from media adopts its settings and places it`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/transition-audio.test.ts`

**Six-bar basis:** (1) S01 TRN and audio fade contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `creates a two-sided ${c.alignment} crossfade with handles and ramps over [${c.span}]`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `shortens a crossfade to the media handles (W_TRANSITION_SHORTENED) and refuses one without room`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `keeps clipId + edge on an audio clip a one-sided fade, also where another clip touches it`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `degrades at render time when the clips are trimmed after the crossfade was added`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `creates a centred crossfade where two audio clips meet and fades at the free edges`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `skips an audio edit point without handles (no fall back to fades there)`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `includes a clip whose handle reaches into the range, and warns about crossfades without room`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `constant power: outgoing² + incoming² = 1 across the span`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `constant gain: outgoing + incoming = 1 across the span`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/transition-m2.test.ts`

**Six-bar basis:** (1) S02 TUI transition-update/default contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `cross dissolve → dip to black` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `dip to black → cross dissolve` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `same type is a no-op` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `video → audio refused` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `audio → video refused` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `audio → audio` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `unknown id` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `re-fits the duration when the new type needs other handles`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `defaults: video only, cross dissolve, the project duration`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `media [audio]: an audio crossfade at the cut and fades at the free edges; video clips ignored` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `media [video, audio], custom effects and duration` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `a video id as the audio default is refused` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `unknown video default` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `audio clips are ignored when media is video only` (parameterized case): protects the specified command outcome through the public transaction API.
- **KEEP** `skips edit points without room and locked tracks instead of failing`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/project/test/transition.test.ts`

**Six-bar basis:** (1) S01 TRN edit and render contracts; (2) a regression in document edits, persistence, math or render output named by each case fails the named case; (3) assertions use fixed spec examples, independent fixtures, algebraic properties or caller-observable error codes; (4) they observe exported model commands/helpers, persisted documents, snapshots or agent protocol; (5) equivalent internal refactors preserve those outputs; (6) this package owns the model contract; browser tests exercise broader workflows.

- **KEEP** `centres a transition with the extra frame after the cut`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `fits the duration into the clips and their media handles`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `evaluates ramps like ffmpeg fade`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `adds a centred cross dissolve at a cut, addressed by clip edge or by track + frame`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `shortens to the media handles with a warning and refuses when nothing fits`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `makes one-sided fades at free clip edges and audio fades on audio tracks`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `updates duration and alignment, removes, and applies the default transition`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `follows its clips: removed when they are separated, moved to the right part by a split`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `gives a cross dissolve handles on both clips and a ramp on the incoming one`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `gives a dip to black a matte and two ramps that meet on a black frame`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `fades both clips when the outgoing one is not opaque, and clamps to the handles at render time`: protects the specified document edits, persistence, math or render output named by each case.
- **KEEP** `draws one-sided fades on the clip itself`: protects the specified document edits, persistence, math or render output named by each case.

### `packages/session/test/persistence/autosave.test.ts`

**Six-bar basis:** (1) S01 PER-020/022 autosave/lifecycle contracts; (2) a regression in history, selection, persistence, autosave or React result named by each case fails the named case; (3) assertions use fixed state transitions, timing bounds and scripted engine responses; (4) they observe public EditorSession/store/controller/hooks and HTTP messages; (5) equivalent internal refactors preserve those outputs; (6) session owns state/persistence; browser tests own complete workflows.

- **KEEP** `saves 1.5 s after the last commit and restarts the idle timer on each commit`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `saves at least every 10 s during continuous editing`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `never saves while a gesture is in progress, even past 10 s; saves after the commit (AC-13)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `flush saves immediately, waits for an in-flight save, and saves the committed doc mid-gesture`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `does nothing in read-only sessions`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `debounces view-state saves by 1 s`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `re-attaching right after dispose (StrictMode remount) yields a working controller`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `flushes on visibilitychange → hidden and on pagehide; guards beforeunload while dirty`: protects the specified history, selection, persistence, autosave or React result named by each case.

### `packages/session/test/persistence/engine-store.test.ts`

**Six-bar basis:** (1) S01 PER/lease and MIG engine-store contracts; (2) a regression in history, selection, persistence, autosave or React result named by each case fails the named case; (3) assertions use fixed state transitions, timing bounds and scripted engine responses; (4) they observe public EditorSession/store/controller/hooks and HTTP messages; (5) equivalent internal refactors preserve those outputs; (6) session owns state/persistence; browser tests own complete workflows.

- **KEEP** `lists, creates and opens projects through the engine`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `saves with If-Match: <baseRevision> and returns the new revision`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `turns a 409 REVISION_CONFLICT into a conflict result with the server revision`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `duplicates, exports and imports projects`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `a second opener is read-only (reason "lease"); release on close frees the project`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `releases held leases with keepalive requests on pagehide (reload does not lock the project)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `keepalive lease release carries the bearer token in token-only auth mode (WP-3I)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `listens for pagehide only while it holds leases (stores do not leak listeners)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `heartbeats every lease.heartbeatMs and re-acquires transparently after an engine restart`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `"Take over" gives the lease to the read-only session; the old holder becomes lost and stops saving`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `refuses take over when the engine does not grant it`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `a document with a newer schemaVersion opens read-only without taking the lease (MIG-003)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `saves 1.5 s after a commit; a 409 pauses autosave until Overwrite`: protects the specified history, selection, persistence, autosave or React result named by each case.

### `packages/session/test/persistence/templates-load.test.ts`

**Six-bar basis:** (1) S11 ATP-002 saved renderer repair contract; (2) a regression in history, selection, persistence, autosave or React result named by each case fails the named case; (3) assertions use fixed state transitions, timing bounds and scripted engine responses; (4) they observe public EditorSession/store/controller/hooks and HTTP messages; (5) equivalent internal refactors preserve those outputs; (6) session owns state/persistence; browser tests own complete workflows.

- **KEEP** `a store given the template registry repairs contradicting stamps when it opens the project`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `without the registry the stamps are left as stored`: protects the specified history, selection, persistence, autosave or React result named by each case.

### `packages/session/test/react.test.tsx`

**Six-bar basis:** (1) public @jasper/session/react selector and rendering contract; (2) a regression in history, selection, persistence, autosave or React result named by each case fails the named case; (3) assertions use fixed state transitions, timing bounds and scripted engine responses; (4) they observe public EditorSession/store/controller/hooks and HTTP messages; (5) equivalent internal refactors preserve those outputs; (6) session owns state/persistence; browser tests own complete workflows.

- **KEEP** `reselects when props change without a store update`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `applies a changed equality function to the current selection`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `re-renders selectors on document changes`: protects the specified history, selection, persistence, autosave or React result named by each case.

### `packages/session/test/session.test.ts`

**Six-bar basis:** (1) S01 SES/UND/SEL/PER session history/selection/transport contracts; (2) a regression in history, selection, persistence, autosave or React result named by each case fails the named case; (3) assertions use fixed state transitions, timing bounds and scripted engine responses; (4) they observe public EditorSession/store/controller/hooks and HTTP messages; (5) equivalent internal refactors preserve those outputs; (6) session owns state/persistence; browser tests own complete workflows.

- **KEEP** `AC-12: undo right after opening and one change returns to the opened state; redo reapplies; selection restored`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `a new commit after undo discards the redo stack (UND-005)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `labels agent entries "Agent: …" and lets agents undo only their own top entry (UND-007/008)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `coalesces repeated nudges with the same key within 750 ms (UND-006)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `refuses writes in read-only sessions and when the lease is held elsewhere (PER-040)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `AC-13: 120 pointer moves make exactly one undo entry and no autosave during the drag`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `AC-13: Esc (cancel) during a drag leaves no entry and restores the drawn document`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `queues agent transactions during a gesture and applies them after it ends (SES-006)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `a gesture without updates commits nothing`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `linked selection expands to link partners and drops deleted ids (SEL-002/004)`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `TransportStore drives an attached player and notifies listeners`: protects the specified history, selection, persistence, autosave or React result named by each case.
- **KEEP** `selects the result of a transaction and records it as the history "after" selection`: protects the specified history, selection, persistence, autosave or React result named by each case.

Retained test cases: 431, including parameterized cases; five are rewrites. Fifteen original test declarations were deleted, including the seeded-ID self-test.

## Validation and remaining integration

- `pnpm --filter @jasper/project test`: 25 files, 388 tests passed before the final shape-wrapper inventory deletion. The affected final shape and curve files passed together: 2 files, 36 tests.
- `pnpm --filter @jasper/project typecheck`: passed after the final curve rewrite.
- Root Vitest filter for config, API, engine client and session: 8 files, 58 tests passed.
- Biome check on all ten touched project source/test files and `git diff --check`: passed.
- The global seeded-ID helper was removed after test fixture callers migrated to `createCounterIdSource`; focused project/API tests passed (4 files, 43 tests). Repository-wide lint, typecheck, test and build gates remain with the root integrator. No test-count or coverage gate was found.
