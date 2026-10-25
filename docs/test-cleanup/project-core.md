# Project core follow-up cleanup

This follow-up starts at `8b4c8936`. The earlier exhaustive disposition records in
[project1](project1.md), [project2](project2.md), [project3](project3.md) and
[project4](project4.md) remain the starting evidence. This second pass inspects
cross-file duplication and unnecessary work in thirteen core test files, plus their
production owners. The table below supersedes earlier decisions for those files.
It does not claim a new line-by-line audit of every other model test.

Counting declarations, including a parameterized declaration as one family:
91 audited; 8 DELETE, 13 REWRITE, 1 OPTIMIZE, 4 surviving CONSOLIDATE owners,
65 KEEP. Seven schema load cases and six migration-step cases expand four schema
history declarations into fifteen runtime tests, so this scope originally contains
102 runtime tests and retains 94. No replacement test scenarios were added.

## Contract and ownership evidence

The following contracts supply bar 1; their named failures supply bar 2. Each table
row supplies the independently authored oracle (bar 3) and the distinct case it
owns (bar 6). These stable interfaces (bar 4) permit helper renames, internal data
structures and algorithm changes that preserve their output (bar 5).

- **LUT:** [S06](../specs/06-color-grading.md), the supported LUT file formats,
  [colour management](../wp-notes/color-mgmt.md), and the independent Kuhn-simplex
  reference. `parseCube`/format readers, `applyLut`, `bakeLut`, `flattenLut`, and
  public format dispatch are the shared preview/export/import boundary. Literal
  tables, affine transforms, and specified interpolation can disagree with the
  production implementation. UI/export tests do not replace these format variants.
- **Storage:** [project-file procedures](../project-files.md), S01 MIG-002/003,
  DOC-005, PER-004 and AC-20/24. `loadProject` and the shipped `MIGRATIONS` are the
  persistence boundary used by engine/session loaders. Committed schema fixtures,
  literal `STEP_CHANGES`, and deliberately corrupt documents supply independent
  oracles. Schema-history owns compatibility; document tests own unknown-data
  preservation through edits, repair and render-snapshot bypass.
- **Edit:** S01 CMD-004, CLP-007 and INV-001, and the DATA-7 child-ID regression.
  `applyTransaction` is the public editing boundary used by web/session/MCP.
  Independently specified transition membership, child-ID disjointness and pin
  references detect stale indexes, rejected edits and corrupt copied clips.
  The surviving cases exercise the affected commands without inspecting caches.
- **Proposal:** [spec 12 §2.5](../specs/12-sound-design.md), D-51, P3-R4,
  WP6.5b items 14/15 and P6-E5. `previewProposal` is the editor's review boundary.
  A preview must represent the requested decisions, entity ownership and invariant
  failures regardless of batching or reuse. Single-item execution is the documented
  reference semantics; literal duplicate IDs independently pin rejection. Other
  proposal tests do not exercise reused checkpoints, multi-item ghost attribution
  or conflicts crossing the batch boundary.
- **Curve/map:** S06 CG-030 and S09 TRK-050. `param.set`, homography utilities,
  render snapshots and `resolveSceneAt` connect authored grade/track data to the
  rendered picture. Literal clamped control points and pinned source/destination
  corners are independent mathematical oracles. Their coordinate assertions are
  rendering behavior, not incidental UI layout.

- **Bed:** spec 12 §4/P6-E12 and sound-design Phase 6→WP-E8 specify scene
  boundaries, matched loop joins, crossfade/fade durations, source containment,
  ducking and room-tone filling. Public scene/layout helpers and `soundDesign.layBed`
  are the lowest planner/command seams. Literal frame spans/gains and independent
  interval laws catch audible gaps, out-of-loop audio and incorrect replacement.
  Parser/HTTP tests do not observe those document/layout results.
- **Auto Tag:** spec 12 P6-R3 and the Phase 6→WP6.3 Auto Tag contract in
  [sound-design](../wp-notes/sound-design.md). `essentialSound.autoTag`,
  `setType`/`clearType`/`applyPreset`, `repairDocument` and `dialogueSpans` are
  shared editor/MCP boundaries. Literal classifier results, skip/error codes,
  marked provenance, retained settings and dialogue spans supply independent
  oracles. These distinct policy transitions are not exercised by lower-level
  classification math or MCP/HTTP transport tests.

Inspected production owners: `src/migrations.ts`, `src/invariants.ts`,
`src/derive/index.ts`, `src/commands/handlers/{transition,clip-edit,structure}.ts`,
`src/commands/placement.ts`, `src/color/{lut,lut-formats}.ts`, and
`src/proposals/ghost.ts`, `src/commands/handlers/essential.ts` and
`src/essential/model.ts`, `src/sound/ambience-bed.ts`, `src/ids.ts`, and
`src/proposals/{validate,compose,anchors,decisions}.ts`. Shared helpers remain used by other tests. The only
removed production seam is preview instrumentation described below.

[The current core inventory](project-core-inventory.md) maps all 838 named core
families plus 35 parser-fuzz targets (873 decisions) to fresh or historical
six-bar evidence. The detailed fresh table below audits 91 declarations in thirteen
files; it is not the denominator for the broader retained inventory.

## Test-by-test decisions

Paths below are relative to `packages/project/test/`. Names identify the original
baseline tests; schema template names identify all their generated version cases.
For KEEP, OPTIMIZE, REWRITE and surviving CONSOLIDATE, the evidence group above
supplies source, stable seam and refactor tolerance; the reason identifies the
independent expected result and the unique recognizable failure.

| Path / test | Outcome | Reason / independent oracle / unique remaining owner |
| --- | --- | --- |
| `document.test.ts`: the v1 fixture always loads without repairs | DELETE | Fails unique protection (bar 6): schema-history's v1 fixture already pins load, migration and zero repairs; document's retained unknown-data test also loads the richer v1 fixture. |
| `document.test.ts`: v1 → v2 relabels default-labelled audio halves of A/V clips and nothing else | DELETE | Bar 6: schema-history's exact v1→v2 leaf diff permits only the required audio-label change. |
| `document.test.ts`: v1 → v2 keeps labels the user chose on audio clips | DELETE | Bar 6: the same shipped schema fixture includes a user-selected rose audio label, and the exact step diff forbids changing it. |
| `document.test.ts`: the v2 fixture loads unchanged (…) and newer versions open read-only | DELETE | Bar 6: schema-history separately loads v2, pins every shipped no-op step and tests future versions. Its future-version survivor now also checks the one additional assertion: preservation of `futureField`. |
| `document.test.ts`: AC-24: unknown effect id and unknown clip kind load, are bypassed, and survive edits and saves | KEEP | Storage: arbitrary future payload survives load/save, unrelated edits and partial overwrite; unsupported layers produce a render warning. Prevents data loss/broken opening of extensible projects; schema-step fixtures do not edit unknown kinds. |
| `document.test.ts`: AC-20: overlapping clips open with a repair report; the later clip moves to a new track | KEEP | Storage: a deliberately overlapping solid is moved away from the title, with `move-overlap` report and valid result. Prevents losing/mixing overlapping saved content; other migration cases start valid. |
| `document.test.ts`: drops dangling references and dissolves broken link groups | KEEP | Storage: deleted linked audio and a missing root item produce `drop-reference`/`dissolve-links` repairs. Prevents unusable loaded references; overlap and unknown-data cases do not corrupt links. |
| `schema-history.test.ts`: schema v${v} loads, migrates to v${CURRENT_SCHEMA_VERSION} and passes the invariants without repairs (v1…v7) | KEEP | Storage: each independently committed schema fixture must load at current version, report exactly the intervening steps and need no repair. Prevents losing an older supported file format; current-version editing tests cannot prove old-version compatibility. |
| `schema-history.test.ts`: step v${step.from}→v${step.to} makes exactly its documented changes (v1→v2…v6→v7) | KEEP | Storage: literal `STEP_CHANGES` catches a changed migration, unintended field changes and audio-label damage. End-to-end loads alone do not isolate the shipped step or pin its complete leaf diff. |
| `schema-history.test.ts`: a bare document without an envelope or schemaVersion is read as v1 | KEEP | Storage: a historical bare file is recognized as v1 with zero repairs. Envelope fixtures do not cover this legacy wire shape. |
| `schema-history.test.ts`: a newer schema opens read-only and is never migrated down (S01:MIG-003) | CONSOLIDATE | Storage: independently sets version to future and adds `{futureField:{a:1}}`; expects read-only, no migration and that exact field. Detects downgrade or unknown-data loss in future files. Absorbs document's only additional future-field assertion. |
| `derive-draft.test.ts`: alternating clip.place and transition.add on the clips just placed | DELETE | Bar 6: both this and derive-draft-index call the same `clipsAtEditPoint` path repeatedly while one transaction mutates its clips record. The latter performs fewer commands, uses two tracks, and verifies both resulting transitions through direct applyTransaction. Marker insertion adds no index contract. |
| `derive-draft-index.test.ts`: sees clips added after an earlier command read it | CONSOLIDATE | Edit: six literal commands create two adjacent solids and a cross dissolve on each of two tracks; expects a successful transaction and two transitions. Detects a cached draft index hiding later clips; ordinary one-transaction-per-edit tests miss the stale state. |
| `reidentify-children.test.ts`: splitting and duplicating an animated title gives its animators and selectors new ids | DELETE | Bar 6: split-children-ids creates a title animator, splits and duplicates it, explicitly checks animator/selector disjointness and all descendant IDs. Preset construction is separately covered by text-animators. |
| `reidentify-children.test.ts`: splitting a clip with Puppet pins gives meshes and pins new ids; pins follow their mesh | DELETE | Bar 6: split-children-ids performs the same two-pin split and verifies fresh mesh/pin IDs plus references. The `ppn_` formatting repetition is already owned by the public ID generator contract. |
| `split-children-ids.test.ts`: a text clip with an animator can be split and duplicated | CONSOLIDATE | Edit: copied animator/selector IDs differ from the original and all descendant IDs remain unique. Detects duplicate IDs causing a split/duplicate refusal or damaged copied animation; ordinary flat-clip editing does not create nested animators. |
| `split-children-ids.test.ts`: a clip with Puppet pins can be split; the copy’s pins point at the copy’s meshes | CONSOLIDATE | Edit: expects two copied pins, a different mesh ID, fresh pin IDs and references to the copied mesh. Detects dangling/cross-clip pin ownership; the text-animator case has no meshes. |
| `color-mgmt-luts.test.ts`: matches the brute-force simplex reference for sizes 2–33 | OPTIMIZE | LUT: keeps all 8,000 deterministic RGB inputs, all 24,000 component comparisons, all four sizes and the independent brute reference at 2e-6. Asserting the maximum error once per size is equivalent to the conjunction of component assertions (NaN/Infinity also fail). Detects nonlinear tetrahedron/order/domain interpolation bugs; affine examples cannot. |
| `color-mgmt-luts.test.ts`: is exact on affine LUTs and at lattice nodes | KEEP | LUT: an authored affine function gives exact expected RGB, and a nontrivial lattice node gives exact table values. Detects gain/offset/channel-order errors without relying on the production interpolator. Nonlinear tolerance checks do not require this exact affine law. |
| `color-mgmt-luts.test.ts`: 1D shaper + 3D (Resolve layout): parse, apply, write, read back | KEEP | LUT: literal mixed-size file maps `[1,2,3]` to `[.25,.5,.75]`, preserves shaper on serialization. Detects skipped/double-applied shapers or unsupported mixed-table wire layout. Single-table examples do not. |
| `color-mgmt-luts.test.ts`: 1D only, with LUT_1D_INPUT_RANGE | KEEP | LUT: literal range 0…2 and unequal channel slopes map `[1,1,1]` to `[.5,.25,.125]`. Detects ignored per-format input range; DOMAIN_MIN/MAX case uses different file keys. |
| `color-mgmt-luts.test.ts`: a 3D LUT with LUT_3D_INPUT_RANGE alone takes that domain | KEEP | LUT: literal −.5…1.5 domain maps [.5,.5,.5] to itself and reports the negative domain. Detects ignored 3D input-range directive; 1D range does not cover cube domains. |
| `color-mgmt-luts.test.ts`: refuses duplicate sizes and data before sizes | KEEP | LUT: malformed literal files raise CubeParseError and report the missing combined entry count. Detects incorrectly accepted ambiguous/malformed wire data; finite valid interpolation tests do not. |
| `color-mgmt-luts.test.ts`: round-trips with blue-fastest orientation (a red↔blue swap shows any mistake) | KEEP | LUT: authored non-symmetric red/blue swap and half-green transform survive `.3dl` conversion within 12-bit quantization; mesh header is fixed bytes. Detects orientation/quantization damage in writer; independent Lustre reader sample does not exercise writer. |
| `color-mgmt-luts.test.ts`: reads a hand-written Lustre file (Mesh header, 12-bit output) | KEEP | LUT: fixed external-format bytes map [.2,.4,.6] to those literal values. Detects a reader/writer pair sharing the same wrong interpretation, which a round trip could miss. |
| `color-mgmt-luts.test.ts`: a non-uniform input mesh becomes a 1D shaper | KEEP | LUT: authored non-uniform mesh produces the known half-intensity breakpoint; incomplete and unordered meshes refuse. Detects ignoring input mesh spacing; uniform Lustre input does not. |
| `color-mgmt-luts.test.ts`: spi1d with From and one component | KEEP | LUT: literal one-component SPI table repeats the expected transfer to every channel and rejects a missing row. Detects SPI range/component expansion failures; cube/3dl are separate wire formats. |
| `color-mgmt-luts.test.ts`: spi3d rows with explicit indices | KEEP | LUT: fixed index tuples encode reversed RGB and yield [.75,.5,.25]; missing rows refuse. Detects interpreting SPI indices as implicit row order or samples. |
| `color-mgmt-luts.test.ts`: csp 3D with non-uniform pre-LUTs | KEEP | LUT: fixed pre-LUT breakpoints and table produce [.75,.875,1]. Detects CSP metadata/pre-LUT handling errors; cube shaper input layout differs. |
| `color-mgmt-luts.test.ts`: dispatches by extension and sniffs unknown files | KEEP | LUT: supported uppercase/path extensions and format signatures select the proper reader, PNG is not a LUT. Detects import dispatch rejecting/incorrectly routing supported files; direct reader calls bypass dispatch. |
| `color-mgmt-luts.test.ts`: flattens shapers and 1D tables into a plain unit cube | KEEP | LUT: authored shaper and cube map [.25,.5,.75] to [.125,.125,.09375] with no residual shaper. Detects flattening that drops or applies a shaper twice; import read/write tests keep the shaper. |
| `m2-contracts.test.ts`: the v3 fixture with a LUT, an mg-bundle, a tracker and a corner pin loads without repairs | KEEP | Storage: richer saved feature fixture retains LUT size, bundle Title composition and tracker stride after migration. Generic schema-history fixtures do not contain this legacy combination. |
| `m2-contracts.test.ts`: accepts, sorts and clamps control points | KEEP | Curve/map: command takes unsorted out-of-range authored points and returns literal sorted/clamped [0,0], [.5,.6], [1,1]. Detects unsafe command normalization; pure curve evaluation sees already-normalized points. |
| `m2-contracts.test.ts`: rejects duplicate x, too few points and junk | KEEP | Curve/map: exact E_INVALID_PARAM for three authored malformed curves. Detects malformed grade points admitted through commands; valid normalization does not exercise refusals. |
| `m2-contracts.test.ts`: parses what it serializes (3D) and ignores comments / vendor keywords | KEEP | LUT: authored warm transform round-trips table values/title despite unknown vendor and comment lines. Detects unsupported harmless metadata rejection or 3D-only writer loss; mixed-shaper case uses a distinct grammar. |
| `m2-contracts.test.ts`: the identity LUT is exact at lattice points and between them (tetrahedral) | DELETE | Bar 6: color-mgmt-luts independently checks general affine functions, lattice nodes and the full nonlinear simplex reference across sizes. Identity has no separate production fast path and adds no distinct failure mode. |
| `m2-contracts.test.ts`: a baked function is reproduced within LUT precision; intensity mixes linearly | KEEP | LUT: authored nonlinear warm transform approximates its independent function, and half intensity is the arithmetic mean of input and output. Detects baking or intensity mistakes; tetra interpolation test does not call intensity mixing. |
| `m2-contracts.test.ts`: 1D LUTs and domains | KEEP | LUT: DOMAIN_MIN/MAX literal table clamps an over-range blue input to .25. Detects ignoring the legacy domain directive or missing saturation; INPUT_RANGE uses different bytes and no over-range sample. |
| `m2-contracts.test.ts`: reports malformed files with a line number | KEEP | LUT: literal malformed files reject with CubeParseError, and bad sample at line 2 reports line 2. Detects untyped/unhelpful import failure; structural-size refusal test does not pin input source location. |
| `m2-contracts.test.ts`: maps the unit square / a box onto a quad and back | KEEP | Curve/map: independently authored pinned corners map unit/source coordinates and invert to identity. Detects projective matrix/order errors; rendered corner-pin case checks command/snapshot wiring, while this is the lowest mathematical seam. |
| `m2-contracts.test.ts`: detects convex quads and writes CSS matrix3d | KEEP | Curve/map: crossed corner order is rejected and a literal translation emits exact CSS matrix bytes. Detects invalid homography input and row/column wire mapping; sampled point transforms do not exercise CSS representation. |
| `m2-contracts.test.ts`: a corner pin makes the scene resolver emit a projective map and the pinned quad | KEEP | Curve/map: authored normalized pins resolve to literal [192,108] and [1536,972], absent pin stays affine. Detects dropped corner-pin effect in snapshot/evaluation; isolated homography utilities bypass that integration. |
| `proposals-preview-batch.test.ts`: same document, items applied, failures and per-item ghosts (random proposals, invariant check on and off) | KEEP | Proposal: batch vs documented one-item semantics preserve document, decisions, typed failures and ghost ownership over authored command combinations. Also independently forbids duplicate supplied marker IDs. Detects interactions between dependencies, refs and batching; single deterministic proposal examples do not cover these combinations. |
| `proposals-preview-batch.test.ts`: reuses the shared prefix of a preview of the same document (what Hear plays after a reject) | REWRITE | Proposal: retains all fresh/reused document, applied-item, failure and ghost assertions after rejecting item i90. Removes exact 99/35 work counters: those fail stable seam/refactor tolerance (bars 4/5), and kept production-only instrumentation alive. Detects wrong checkpoint reuse; performance is measured separately. |
| `proposals-preview-batch.test.ts`: an item naming a clip only as a key (applyGains gains) keeps its ghost when another item names it by value | KEEP | Proposal: literal applyGains key must attribute the audio clip to the gain item's changed ghost; independent item then renames it. Detects lost ghost attribution for IDs embedded as keys; ordinary clipId-valued commands do not. |
| `proposals-preview-batch.test.ts`: 120 items, two of which add a marker with one id: the later one fails with the issue, the rest apply | REWRITE | Proposal: exact later item i101 fails E_INVARIANT/INV-001, 119 survive, one marker remains; disabling invariant checks admits 120. Detects cross-batch invariant conflict loss on large proposals; same-named random test does not deterministically position this conflict beyond multiple batches. Removed exact conflict sentence/punctuation matching (bar 1); structured error code/invariant and the actual rejected item remain. |


| `essential-autotag.test.ts`: tags untyped clips "auto" with the type defaults; undo leaves the document; redo is identical | REWRITE | Auto Tag: keeps literal tagged results and stored type/provenance for music and dialogue. Removes defaults calculated by the same production default factory (bar 3), fake undo achieved by assigning h.doc, and repeated execution. Actual undo/redo is owned by the session. Renamed to describe the surviving classified-type/provenance contract. |
| `essential-autotag.test.ts`: never replaces a type the user set, unless force; the same type is SAME | KEEP | Auto Tag: USER_TYPE/SAME codes preserve a manual SFX type and enabled reverb; force replaces a different manual type while preserving ownership of the same manual music type. Detects classifier overwrite of deliberate user work; untyped classification does not cover ownership. |
| `essential-autotag.test.ts`: re-tags an auto clip: another type resets to its defaults, the same type keeps the settings | KEEP | Auto Tag: same-category reclassification refreshes confidence but keeps enabled noise repair; a different category resets noise repair to false. Detects either destructive refresh or inappropriate carryover across categories; manual ownership uses a different policy. |
| `essential-autotag.test.ts`: Confirm = setType with the same type: the mark goes, settings and effects stay | KEEP | Auto Tag: explicitly confirming an automatic type removes the mark and retains repair/effects; subsequent tagging skips it as USER_TYPE. Detects confirmation that silently changes audible processing or fails to establish user ownership. |
| `essential-autotag.test.ts`: minConfidence skips weak results (LOW_CONFIDENCE); presets keep the mark; Clear Audio Type removes it | KEEP | Auto Tag: .4 confidence is below .6, .91 survives presets, and clear removes metadata. User presets cannot introduce a forged automatic mark. Detects weak classifications applied or provenance changed by preset/clear operations; direct confirmation is a different action. |
| `essential-autotag.test.ts`: refusals: unknown clip, not audio, locked track, empty / malformed / oversized results | KEEP | Auto Tag: literal invalid inputs require E_NOT_FOUND, E_INVALID_PARAM, E_SCHEMA or E_TRACK_LOCKED. Detects unauthorized/invalid tagging, out-of-range confidence and >2000-entry allocation input; successful tagging cases cannot prove these entry guards. |
| `essential-autotag.test.ts`: an unreadable mark is reported and dropped by repair (the type and settings stay) | KEEP | Auto Tag: malformed robot/high metadata triggers INV-ESSENTIAL, is removed, leaves music type and valid document. Detects whole-setting deletion or corrupt provenance retained after load; command validation cannot protect already-saved files. |
| `essential-autotag.test.ts`: auto-tagged dialogue is dialogue for dialogueSpans (whole clip without voice activity) | KEEP | Auto Tag: a newly classified 120-frame audio clip yields the literal [0,120] dialogue span with its clip/track IDs. Detects excluding automatic dialogue from downstream suppression/ducking; tagging metadata alone does not call the dialogue consumer. |

| `ambience-bed.test.ts`: a cut to other footage starts a scene; a cut inside one media does not; markers and shot changes do | KEEP | Bed: independent scene spans [0,200], [200,400], [400,600], authored chapter/scene markers, range edges and shot cuts pin scene merging. Detects splitting a continuous source into false scenes or missing real boundaries; layout tests start from already derived shots. |
| `ambience-bed.test.ts`: never throws on hostile documents | KEEP | Bed: empty/malformed/null documents produce empty scenes. Detects crashing a panel on missing saved data; valid scene fixtures do not cover malformed entry values. |
| `ambience-bed.test.ts`: 3 scenes over 20 s of a 4 s loop: pieces of the loop, 1.5 s crossfades at the loop joints, 0.5 s at scene changes | KEEP | Bed: fixed layout covers 600 frames, has 45-frame loop/15-frame scene joins and 30-frame outer fades. Detects wrong planner timing before commands are involved; command test owns actual resulting document wiring. |
| `ambience-bed.test.ts`: property: every piece and every handle stays in its loop; every loop joint is the matched one; crossfades fit | KEEP | Bed: independent interval containment, contiguous matched loop endpoints and fade-within-piece laws hold across generated loop and shot lengths. Detects reading outside a loop at short/uneven joins; fixed layout uses one long regular loop. |
| `ambience-bed.test.ts`: refuses overlapping shots, too-short shots and loops | KEEP | Bed: literal overlapping/one-frame/short-loop layouts refuse, and a valid one-second loop reports its shortened crossfade. Detects invalid geometry accepted at the pure layout boundary; command schema cannot prove planner behavior. |
| `ambience-bed.test.ts`: lays the 3-scene bed: Ambience track, crossfades, fades, Essential ambience, grouped; undo / redo | REWRITE | Bed: retains resulting clips, -18 dB gain, ambience type/metadata, group, legal source spans and constant-power joins. Removes h.doc assignment/replay masquerading as undo and its noIds JSON/regex helper. Real undo is owned by EditorSession; no command/result assertion is lost. |
| `ambience-bed.test.ts`: range, replace, a second bed on another track, a per-shot bed, equal-gain loop joints | KEEP | Bed: second bed uses a distinct track, replace removes earlier IDs and reuses a free track, a custom shot's audio remains in 5…25 s, and equal-gain joins select constant-gain. Detects destructive unintended replacement or ignored per-shot source/range; ordinary initial placement has neither case. |
| `ambience-bed.test.ts`: ducks under the dialogue with Volume keyframes (−10 dB) | KEEP | Bed: literal dialogue interval yields -10 dB at frame 195; absence of dialogue yields W_BED_NOTHING_TO_DUCK. Detects failure to wire planner ducking into real volume keyframes; the DSP/keyframe evaluator alone never lays a bed. |
| `ambience-bed.test.ts`: refusals change nothing | KEEP | Bed: exact E_INVALID_PARAM/NOT_FOUND/TRACK_KIND/SCHEMA/OVERLAP/TRACK_LOCKED on authored invalid commands and unchanged prior document. Detects wrong refusal reason or partial destructive edits; pure layout has no tracks/media/authored document. |
| `ambience-bed.test.ts`: never throws on hostile arguments (property): a refusal or a valid document | REWRITE | Bed: every generated command now starts from the same immutable fixture and fresh ID source, checks returned document invariants and rejects E_INTERNAL. Previously successful samples accumulated beds and JSON clones between samples, and internal crashes reported as E_INTERNAL counted as valid refusals. This removes hidden order dependence and a false-positive negative path without reducing generated cases. |
| `ambience-bed.test.ts`: dialogue regions, the gaps between dialogue clips, the padded fill, the level | KEEP | Bed: literal dialogue groups/gap [90,120], padded fill [82,128], -7 dB gain and 8-frame fades pin room tone. Detects filling a scene break, missing dialogue overlap or wrong floor/gain; ambience loop cases do not exercise room tone. |
| `ambience-bed.test.ts`: a malformed bed or one on another kind of clip is reported and dropped by repair | KEEP | Bed/storage: two deliberately invalid beds produce INV-SFX, only invalid metadata is removed, and repair is idempotent. Detects corrupt project metadata left active or valid beds discarded; successful command tests never load corrupt saved metadata. |
| `proposals-preview-ids.test.ts`: gives the same well-formed ids for the same seed and different ones for another | REWRITE | Proposal/ID: retains deterministic ordered IDs, explicit Crockford prefix/body regex and within-stream uniqueness. Removes an undocumented all-distinct-seeds injection guarantee: the public source explicitly permits seeds to meet. The regex replaces calling production isValidId as the oracle. Detects nondeterministic or malformed preview IDs independently of the production validator. |
| `proposals-preview-ids.test.ts`: does not repeat within a long stream | KEEP | Proposal/ID: 20,000 emitted clip IDs must be distinct, detecting premature stream rollover that a three-ID determinism sample cannot. The expected set cardinality comes from the caller's requested entities, not the generator. |
| `proposals-preview-ids.test.ts`: keeps an item's created ids whatever other items are applied | KEEP | Proposal: entity IDs for item c stay the same with all items vs only c, recomputation preserves ghosts, source markers remain empty. Detects ID shifts that remount playing clips after another proposal decision; isolated ID determinism does not wire idsFor through preview. |
| `proposals-preview-ids.test.ts`: uses ctx.ids (random by default) without idsFor | KEEP | Proposal: independent previews without seeded IDs create different entity IDs. Detects accidentally using deterministic/global IDs for default callers; explicit idsFor cases select a different API mode. |
| `proposals.test.ts`: validates every item by dry run, records anchors, the base revision and the document hash | KEEP | Proposal: two authored items remain pending with literal metadata/counts, clip anchor, base revision and no applied edits. Detects proposal creation that mutates a project or fails to anchor review; acceptance tests begin after creation. |
| `proposals.test.ts`: marks an item whose commands fail invalid with the reason, and the items requiring it too | REWRITE | Proposal: literal valid/invalid/invalid states, E_NOT_FOUND/A9 and required item bad remain. Drops only the exact dependency sentence; detects failure propagation without freezing English prose. |
| `proposals.test.ts`: marks the later of two items that only conflict together invalid (one transaction must apply) | REWRITE | Proposal: literal duplicate cue IDs invalidate the later item while preserving other pending items; E_INVALID_PARAM remains the reason. Drops the conflict prefix sentence; single-item refusals do not exercise composed-set conflict. |
| `proposals.test.ts`: resolves addressing forms against the document and stores ids | KEEP | Proposal: V1 frame 5 resolves to the authored clip ID; out-of-range frame 900 invalidates the item. Detects persisting unstable semantic addresses rather than IDs; direct agent-address tests do not create stored proposals. |
| `proposals.test.ts`: refuses malformed drafts with typed issues and never throws | KEEP | Proposal: independently malformed drafts pin E_SCHEMA, E_LIMIT, E_INVALID_PARAM and E_NOT_FOUND for shape, dependencies, limits, refs and unknown sequence. Detects forbidden proposal wire shapes before dry run; command validation alone lacks proposal-level constraints. |
| `proposals.test.ts`: takes the dependency closure in proposal order as ONE transaction "Accept <title> (n of m)" | KEEP | Proposal: requested dependent adds its track prerequisite in literal order, preserves origin/revision/ranges, and actual application adds a muted track. The history-label format is documented in sound-design's Model API. Detects missing prerequisites, wrong ordering or dropped transaction metadata; a closure-only graph test does not apply the composed transaction. |
| `proposals.test.ts`: uses the refs an earlier accept defined, skips accepted items and applies the selected alternative | KEEP | Proposal: recorded track ref is reused, accepted track is skipped, selected solo alternative applies without mute. Detects reapplying accepted edits or ignoring alternative/ref state; initial all-at-once accept has no previous accepted item. |
| `proposals.test.ts`: refuses unknown and invalid items (also through requires) and more commands than one transaction | REWRITE | Proposal: exact E_NOT_FOUND/E_INVALID_PARAM/E_LIMIT and required culprit itemId bad replace an incidental English message. Detects accepting invalid prerequisites or exceeding transaction bounds, without freezing sentence layout. |
| `proposals.test.ts`: an anchored item goes stale when its clip moves or is deleted, and pending again when it is back | REWRITE | Proposal: structured anchor problem specifies clip ID/start 0→12/deletion and restoring base revives pending state. Removes exact localized reason text. Detects stale accepted-position assumptions or sticky staleness; generic invalid-command cases do not move existing anchors. |
| `proposals.test.ts`: an item whose commands stop applying goes stale, and so do the items requiring it | REWRITE | Proposal: removed A3 gives literal stale/stale states, conflict problem and dependent requires/item/state. Removes duplicated human explanation patterns; detects lost dependency staleness with independently specified structured data. |
| `proposals.test.ts`: planAccept is all-or-nothing, or with partial applies the rest and reports the stale items | KEEP | Proposal: moved anchor rejects a/c as E_STALE; partial composes only b, preserves expected revision, and empty partial returns no transaction. Detects accidental partial application in strict mode or applying stale dependencies; compose alone lacks current document revalidation. |
| `proposals.test.ts`: an item that newly conflicts with the others is found by the dry run of the composed set | KEEP | Proposal: a user-added duplicate cue makes the old item stale and only unrelated marker b remains applicable. Detects relying solely on saved anchors instead of final dry run; moving/deleting anchor tests exercise different stale triggers. |
| `proposals.test.ts`: entities an accepted item changed are not anchors of the proposal's later items | KEEP | Proposal: after accepting the proposal's own move, later rename remains pending. Detects invalidating the remaining review because its own earlier action moved the clip; external-change stale tests intentionally require opposite behavior. |
| `proposals.test.ts`: reject, note, select and reopen change the proposal only; an accepted item cannot be rejected | KEEP | Proposal: literal decision states, notes/selections, immutability and typed accepted-rejection refusal pin review transitions. Detects lost decisions, document writes during review or double rejection of applied work; transaction execution does not implement review policy. |
| `proposals.test.ts`: proposalGhost lists created, changed and deleted entities, down to the effects inside a clip | KEEP | Proposal: actual added blur/marker IDs appear in created, owner clip in changed, reverse diff includes deleted effect; unchanged document has empty ghost. Detects missing nested review overlays; flat document diffs cannot observe nested entities. |
| `proposals.test.ts`: previewProposal applies items one by one on a copy, with per-item ghosts and failures | KEEP | Proposal: authored track/mute/marker preview preserves source, attributes creates/changes correctly, and missing prerequisite fails its dependent without changing the document. Provides a fixed independent expected preview for the randomized batching comparison. |
| `proposals.test.ts`: accepting A then B equals accepting A ∪ B (A before B in proposal order) | KEEP | Proposal: real application of generated dependency/ref-bearing proposals in separate and united accepts must produce the same normalized document and decisions. Detects lost refs or acceptance replay across multiple calls; batched preview does not commit or mark accepts. |
| `proposals.test.ts`: rejecting leaves the document identical; accepting the rest equals never having had the rejected items | KEEP | Proposal: rejecting generated items preserves serialized project, literal states match chosen IDs, and composing all closes only pending items. Detects rejected items leaking into acceptance or mutation during rejection; one fixed decision example does not vary requirement graphs. |
| `proposals.test.ts`: compose is deterministic and the closure is minimal and closed | KEEP | Proposal: independently traversed DAG reachability and proposal order pin exact dependency closure, and reversed request order yields the same composition. Detects missing or unnecessary dependency edits; ordinary chain examples do not cover branching DAGs. |
| `proposals.test.ts`: never throws on fuzzed drafts and proposals; problems are typed | REWRITE | Proposal: arbitrary drafts refuse with typed creator errors or yield a valid proposal usable by compose/plan/revalidate/preview. Now explicitly rejects E_INTERNAL, which the old E_* regex accepted. Detects an internal exception disguised as a valid rejection; documented creator errors are schema/limit/invalid/not-found. |
| `proposals.test.ts`: an agent granting itself "Allow agents to apply sound proposals" needs the user's approval | REWRITE | Proposal/security: an enabling command must produce an approval reason; disabling, unrelated density and dry-run operations produce none. Removes exact reason sentence/cardinality; detects self-authorization through the public guard independently of the UI approval wording. |

## Removed infrastructure and production seam

`fixtures/v2/basic.jasper` had no caller after the duplicate migration scenarios
were deleted (`rg 'basic.jasper'` plus fixture helper inspection). Its 632 lines and
its ATTRIBUTION row are removed. The independently committed `schema-v2.jasper`
remains. Other basic feature fixtures still have callers and remain.

`previewStats` and its exported type, global counters and increments had only test
consumers. The shared/session workstream removes its two other consumers
(`proposals-budget.test.ts` and `proposals-perf.test.ts`). The project reuse test
now observes only preview results. The real `PreviewOptions` batch/reuse/time-slice
API remains used by the editor; no production result or command behavior changes.

## Verification and measurements

Focused validation and timing results are appended after the parent finishes the
unmodified suite baseline, to avoid introducing CPU contention into its measurement.
