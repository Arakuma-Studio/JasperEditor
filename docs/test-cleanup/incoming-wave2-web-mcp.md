# Incoming integration: web and MCP contracts

Checkpoint `99d57175` includes remote `69c96e3b`; compare incoming features with `2d364873`.
All66 named declarations in the thirteen assigned files are mapped below, including unchanged surviving owners from the previous audit. Line numbers identify that unmodified integrated checkpoint, so renamed/reflowed tests remain traceable. These rows supersede earlier area rows for the same declarations; they are not extra tests.

## Behavioral bar and stable boundaries

Every surviving row below names an independent source, recognizable failure and oracle. UI rows observe actual controls/events and committed document, history, selected menu state or visible failure; coordinates are action input, never layout assertions. Their output assertions tolerate renaming helpers, changing intermediate command construction, DOM nesting and CSS. Protocol rows use the actual MCP SDK/stdio/HTTP boundary, literal documented keys/codes/paths and real project transactions; fake dependencies only isolate external engine results/errors, never implement the behavior being asserted. Artifact/process rows observe independently decoded bytes or exit state. Each row names the distinct wiring or failure that lower tests cannot establish; purely duplicate lower behavior is deleted or moved to its surviving owner. Sources are the repository contract/work notes, not the implementation under test.

Read alongside [MCP original audit](mcp-followup.md), [web original audit](web-core.md), [browser original audit](browser.md), [audio crossfades](../wp-notes/audio-crossfades.md), [Crop order](../wp-notes/crop-order.md), [fonts](../wp-notes/fonts.md), [keyframe sides](../wp-notes/keyframe-sides.md), [Link Media](../wp-notes/link-media.md), [spatial points](../wp-notes/spatial-points.md) and [playback audio](../wp-notes/wma-preview.md). No production behavior, schema, migration, fixture bytes, sample/pixel tolerance or dependency changes here.

Disposition counts: 5 CONSOLIDATE, 8 DELETE, 34 KEEP, 19 REWRITE. Categories include surviving consolidation owners; they are decisions, not physical test deletions.

## `apps/mcp/test/fonts.test.ts`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L170 — list_fonts: bundled, installed and the project's missing fonts | KEEP | MCP font guide specifies bundled/installed summaries, project available/missing status, layer counts and query filtering. Literal Inter/Pixel12x10/missing family wire output uses real model documents and SDK transport; engine catalog tests cannot detect MCP omission/field transformation. |
| L192 — install_font: absolute paths only; the missing font becomes available; clashes are explained | REWRITE | Delete fake-implemented successful installation/missing-becomes-available assertions; real engine library owners establish that behavior. Retain precise E_INVALID_ARGUMENT at path for a relative input and FONT_EXISTS→E_FONT_EXISTS mapping over actual SDK transport, which generic engine/error tests cannot establish for this tool. |
| L208 — remove_font goes through the engine approval and reports a denial | REWRITE | Remove private client call inventory and generic malformed-ID duplicate. Actual remove_font SDK response must surface E_APPROVAL_DENIED from the dependency. Engine route approval tests own authorization; this uniquely guards the MCP failure code reaching its caller. |
| L217 — add_text {font} registers the family and sets it on the new text clip in one transaction | KEEP | Actual add_text SDK call applies real project commands; literal requested family must be registered and referenced by the resulting text clip. Fonts guide specifies one transaction composition; neither font.add nor clip.addText model tests establish tool wiring. |

## `apps/mcp/test/integration.test.ts`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L98 — discovers the engine, edits media, renders a frame, and exports a playable video | KEEP | MCP CLI/engine protocol: real stdio imports media, edits the document, renders PNG bytes and exports probeable video. Literal frame/media/artifact checks fail on broken end-to-end SDK/process wiring; lower fake-engine cases cannot establish real transport/job outputs. |
| L163 — clipboard tools preserve destination time, track, insertion mode and bin | KEEP | Clipboard MCP guide: destination frame/track, insert mode and bin must reach actual saved clips/items; independently chosen destinations expose argument loss. Stable stdio/query/document seam tolerates internal command construction changes and is distinct from lower copy/paste commands. |
| L245 — keeps the engine token out of MCP responses and stderr | KEEP | Security review forbids token disclosure. Independently acquired live secret must be absent from MCP result/stderr bytes; only this actual process boundary sees accidental logging/serialization leaks. |
| L255 — serves project resources and the edit-video prompt through MCP | KEEP | MCP resource/prompt protocol exposes project resources and usable edit-video prompt through actual SDK discovery/read calls; literal requested project/resource data establishes the externally addressable boundary beyond helper schema tests. |
| L265 — dry runs leave the project unchanged and destructive edits require approval | KEEP | MCP destructive approval/dry-run guarantees: actual dry-run leaves saved document unchanged and destructive edit is refused without approval. Independent before-state and public error outcome distinguish engine authorization from fake dependency errors. |
| L284 — creates, edits, applies defaults, and removes transitions through MCP | KEEP | Actual stdio transition create/edit/default/remove round trip persists requested type/duration/alignment; SDK connection to real engine uniquely owns production transaction wiring beyond in-memory model tests. |
| L366 — persists text animation changes and returns a PNG contact sheet | KEEP | Text-animation MCP guide: actual saved animation plus decoded PNG contact-sheet artifact protects serialization and renderer invocation together; internal helper tests cannot establish a valid public image response. |
| L426 — stores a shape with the requested geometry and rejects invalid ellipse corners | KEEP | Shape MCP public geometry input/refusal: literal dimensions/content survive real engine transaction; invalid ellipse corners refuse rather than become another primitive. This is serialized model data, not incidental DOM geometry. |
| L451 — reads a curved motion path and sets its spatial interpolation (S03:KF-021) | KEEP | S03:KF-021 clip-motion path: public curved-path keys/points and Linear setter retain actual clip-space semantics via stdio. Independent chord/known key data distinguishes it from the new effect-layer normalized path. |
| L492 — reads and sets the motion path of an effect point (spatial-points: Transform effect Position) | KEEP | Spatial-points MCP guide: actual authenticated stdio get_motion_path on an effect Position reports layer-box1920×1080 and literal keyframes, has length above independent chord bound; setting Linear yields chord length and scalar Rotation refuses E_INVALID_PARAM. Existing clip-path SDK case does not cover effect target argument routing. |
| L549 — starts an engine and stops it when the MCP client closes | KEEP | CLI --start-engine lifecycle: client close must terminate the spawned engine, observed through actual process exit. Stable process boundary; in-memory transport tests cannot detect orphaned engines. |

## `apps/mcp/test/interchange.test.ts`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L270 — import_timeline applies the fragment and reports offline media and what was not carried | KEEP | Interchange MCP import protocol transforms engine fragments/offline/loss report and applies a real project fragment. Literal bin/name/path/report fields detect tool mapping loss; parser tests cannot establish this public response. |
| L289 — export_timeline maps the options, waits for the job and lists files and losses | KEEP | Interchange MCP export wire options/audio handles/output destination and engine-relative download URLs must become the requested public result. Fixed options and absolute endpoint URL can disagree with implementation; actual engine export tests do not cover MCP translation. |
| L321 — list_offline_media and link_media (folder search; differences need force) | KEEP | Incoming addition to the existing folder-link owner protects Windows source-path notation, offset1/limit1 page with total3/next2, and verified versus forced links. Link-media MCP protocol independently specifies paging and cross-platform locators; engine scanning cannot detect MCP pagination/wire omission. |
| L350 — link_media with a located file relinks the others automatically in one transaction | REWRITE | Keep SDK located-file→document results: exact Windows/Mac anchor wire payload, located+verified files linked, differing file still requiring force, relative path E_INVALID_PARAM. Remove redundant requested-asset ID inventory; SDK/engine wire anchor contract is stable, not private collaborator call count. |

## `apps/mcp/test/transitions.test.ts`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L162 — uses the open editor’s default types and alignment | KEEP | S10:TUI-034 defaults: public apply_default_transitions must honor open-editor type/alignment preferences. Literal A1/V1 resulting transitions through SDK and real project distinguish this source from caller overrides. |
| L172 — lets call arguments override the editor value by value | KEEP | S10:TUI-034 explicit call arguments override only supplied editor defaults. Literal per-medium resulting transitions detect precedence bugs; preference fallback test supplies no overrides and cannot supersede it. |
| L191 — falls back to the built-ins for invalid editor values | KEEP | S10:TUI-034 invalid editor preferences fall back to supported built-ins with valid model transitions. Literal known defaults detect stale/invalid saved configuration handling; ordinary valid preference case does not. |
| L220 — adds a GPU transition by label with params and updates its params | KEEP | Transition MCP GPU framework: a label resolves to the declared GPU effect and params survive add/update through real project transactions. Literal effect/parameter output establishes tool normalization distinct from Smooth Slide short-name path. |
| L242 — lists Smooth Slide with its controls and adds / updates it by short name | REWRITE | Delete registry/label/parameter count inventories including22animation options. Actual SDK short-name Smooth Slide add/list/update retains literal direction, animation, dolly, reflection and shutter values; Smooth-slide MCP guide specifies editable controls, model tests cannot establish short-name mapping. |
| L317 — adds an off-centre asymmetrical custom-fade crossfade and updates it | KEEP | Actual SDK Custom Fade add/list/update retains off-centre span95…115, offset5, asymmetric shapes/values; center clears offset, later offset15 is custom, effect change resolves exponential-fade. Audio-crossfades/MCP wire docs specify these representations; project model tests cannot detect tool parameter omission. |
| L370 — refuses a cutOffset on a fade and a bad fade shape as tool errors | REWRITE | Replace substring/generic-isError with exact E_INVALID_PARAM for cutOffset on one-sided fade and invalid fadeShape. Remove ordered parameter inventory. Public error code plus precise input distinguishes intended refusal from tool failure; lower commands alone cannot prove MCP error delivery. |

## `apps/web/test/audio-crossfade-ui.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L73 — draws both sides of a fixed crossfade; picking Custom Fade starts from its own curve (Constant Gain → Linear @ 0) | REWRITE | Drop SVG-path presence assertions; the actual type picker must preserve Constant Gain as Linear @0 in the committed transition. Independent curve equivalence in audio-crossfades §Research; the project model cannot catch a disconnected picker. |
| L89 — edits shape, value and symmetry (asymmetrical seeds the fade out); each edit is one undo step | KEEP | Select shape, value and asymmetry; committed Linear@30 seeds the outgoing side and one undo/redo restores the edit. Audio-crossfades specifies these controls and per-edit history; lower command tests do not dispatch UI events. |
| L121 — dragging the curve up makes a Constant Power a Custom Fade above Cosine @ 19, in one history entry | REWRITE | A real upward curve drag must convert Constant Power to Custom Fade, retain Cosine and increase above the independently documented19 in one history step. Delete the undocumented one-pixel/one-unit sensitivity pin; retain direction and outcome. |
| L139 — an off-centre crossfade shows Custom Start; picking an alignment drops it | REWRITE | Remove the exact option-copy inventory; the displayed selection is custom and choosing center removes the document cutPosition. Protects a picker accidentally treating Custom Start as center; model commands cannot establish the selected control. |
| L153 — draws the span off-centre, resizes from either edge keeping the other one | REWRITE | Replace private edgeDrag/command shapes with real TimelineController pointer gestures. Starting span115…135 at cut120, moving end to140 preserves start (duration25,cutPosition0.2), moving start to110 preserves end (25,0.4), crossing cut yields start-at-cut. These are the independently documented Custom Start edge rules, not DOM layout. |
| L174 — the timeline draws each side’s curve (Custom Fade asymmetrical, one-sided fades) | DELETE | Private transitionViewProps curve-key/title inventory fails stable-seam/refactor resistance and copy bars. Audio-crossfade-shapes owns the sound envelopes; real controls and actual renderer/export owners protect editing and audible results, not a memoization prop encoding. |

## `apps/web/test/crop-order-ui.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L61 — pins a crop at the top of the stack as a draggable effect header; dropping an effect on it puts that effect first | REWRITE | Remove data-fx-index, MIME echo and DOM section-order inventories. Actually drag Blur onto Crop and assert committed [Blur,Crop], undo [Crop,Blur], redo [Blur,Crop]. Crop-order §Research specifies reorderable standard effects; model reorder tests cannot establish the pinned header drop target. |
| L87 — drags the pinned Crop down the stack | KEEP | Actually drag the pinned Crop to the end and assert [Flip,Blur,Crop]. Distinct source-header wiring from the first case's destination-header wiring; no fixed row widths or DOM geometry are asserted. |
| L97 — a clip whose crop sits after another effect shows no pinned defaults (editing them would add a second crop) | REWRITE | Replace pinned/default section-presence inventory with editing the later Crop's Left spinbutton. It changes the existing effect to1 and preserves exactly [Flip,Crop], catching a UI binding that silently inserts a second Crop. Lower command tests do not bind inspector rows. |

## `apps/web/test/fonts.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L80 — a font named by its PostScript name is available; an unknown one used by text is missing | REWRITE | Remove status-classifier output duplicated by API font resolution. Add an unreferenced missing family, then require only the used missing Minion Pro with clips1; known Pixel12x10/Inter and unused family are excluded, while null catalog yields no premature warning. Fonts work note specifies used missing detection/readiness; API lookup and project usage owners do not combine these UI rules. |
| L98 — the Player resolves library fonts like the engine's exports (PostScript name → the library face) | KEEP | At the web-to-render snapshot boundary, Pixel12x10 must carry the installed TTF URL and unknown family no URL. Fixed catalog URL is independent of resolver code; engine/API owners cannot detect a Player input builder omitting the library. |
| L117 — lists project, installed and bundled fonts, marks missing ones, and hands catalog families to onPickFamily | CONSOLIDATE | Callback-only family picking and menu listing duplicated the stronger Properties document edit. Search and installed-family selection now execute there; missing used-family logic remains in project font status. Delete section-label/counter/attribute inventories, which have no separate behavioral contract. |
| L160 — search filters the menu | CONSOLIDATE | Move the actual pix search into the surviving Properties pick: Inter disappears and Pixel remains selectable, then the document changes. This catches broken filtering through the real caller without a second render and callback-only fixture. |
| L180 — Properties ▸ Text: picking an installed family registers it and sets it in one undo step | REWRITE | Properties text workflow now filters pix and picks Pixel12x10, commits that family and undoes back to Inter with one history step. Fonts work note specifies searchable installed families and undoable selection; API or command owners cannot catch disconnected menu callbacks. |

## `apps/web/test/interchange.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L66 — recognises timeline documents by extension and FCP7 XML by content | KEEP | Interchange file-recognition contract routes timeline extensions/FCP7 XML to the importer while movie/caption XML remain ordinary media. Fixed file/header bytes can disagree with detection; parsers cannot establish import-routing discrimination. |
| L75 — imports an EDL as one undoable transaction with offline placeholders, then links one | KEEP | Interchange frontend importer binds real EDL parser response into a single undoable project transaction, preserves offline placeholders and links one through the new shared command. Fixed A001/B002 outcomes and invariants catch frontend fragment dispatch; browser case owns real menu/auth/jobs, this is the cheapest frontend seam. |
| L125 — the export dialog sends the options, follows the job and shows the report | KEEP | Interchange Export dialog maps selected options into the HTTP request, follows public job completion and produces the loss/download report. Independent request and artifact/report data expose UI action wiring; engine export owners cannot detect missing checkbox/sequence arguments. |

## `apps/web/test/keyframe-sides-ui.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L65 — Ease In sets only the incoming side of the key; the menu checks it; the glyph shows both halves; undo | REWRITE | Drop glyph halves and heading-copy assertions. Actual Ease In/Out menu actions leave the opposite side unchanged, report selected menu state and undo to legacy Linear. Keyframe-sides §4/§5 specifies independent sides; lower commands cannot catch the UI dispatching the wrong side. |
| L99 — the graph shows a handle on the eased side only and edits that side | CONSOLIDATE | Surviving graph owner retains incoming-only handle editing and now absorbs Continuous/Alt behavior from the deleted planner probe: ordinary drag stays Continuous, Alt makes Bezier and leaves the incoming ease unchanged. This is real graph event-to-document wiring; no command object shape is asserted. |
| L139 — interpolationCommand: Ease In / Ease Out / Hold set one side | DELETE | Private interpolationCommand shape assertions fail stable-seam/refactor bars. Actual menu owner above proves Ease In/Out outcomes; Hold/both command semantics remain in keyframe-sides-commands. The choice of an intermediate side field is not itself a user contract. |
| L154 — presetOf / commonPreset: the checked item | DELETE | Private preset classifier branch inventory duplicates actual selected menu state and fails stable-seam/refactor bars. The public UI owner checks Linear and Ease In selection; model tests own interpolation validity. |
| L169 — glyph halves and handles follow each side | DELETE | Glyph-half declaration/handle Boolean inventory fails appearance/stable-seam/refactor bars. Actual eased-side graph control and its drag remain; no independent visual golden requirement specifies these private shape tags. |
| L182 — planEaseEdit edits only the dragged side (Continuous keeps the link unless Alt) | CONSOLIDATE | Transfer the unique Continuous/Alt link contract to the surviving graph pointer workflow. Remove planEaseEdit command-array assertions; lower model commands own ease coupling but cannot establish Alt gesture routing. |
| L201 — clipKeysById finds keys anywhere in a clip (the timeline key menu) | DELETE | clipKeysById shape/filter helper test fails unique/stable-seam bars; existing timeline selection/keyframe controls and project keyframe command tests own selected key IDs and edits. It only reasserts an implementation traversal over an arranged clip. |

## `apps/web/test/link-media.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L154 — locate one file: the others link automatically in one undoable transaction | REWRITE | A real Locate UI plus fixed engine wire answers commits the located file and two verified matches; mismatched/ambiguous media remain pending, Link anyway is explicit, undo/redo is atomic and Offline closes. Replace criteriaOf(DEFAULT_LINK_OPTIONS) circular expectation with literal name/extension/duration/streams; remove row counts, history-label and copy pins. Link-media §3–5 independently specifies these decisions. |
| L277 — Offline All closes with every row still offline | KEEP | Offline All closes with linked0/offline2 and both placeholders still offline. Distinct user escape path from automatic linking; project commands cannot detect a button that relinks or drops entries. |
| L294 — links thousands of offline media as one transaction; undo and redo restore it | DELETE | The2000-item applyLinks helper workload duplicates real multi-file UI atomic undo and project relink transaction ownership; its30s limit is an undocumented benchmark. No minimum batch-size requirement is lost: engine20,000 asset limit has its own owner. Fails unique-protection/cost bar. |
| L322 — a refused transaction is reported, not half applied | DELETE | Helper-only single-item refusal duplicates project relink E_INVALID_PARAM and immutable transaction tests. Name promised half-application protection but submitted no multi-command failing transaction and asserted no refusal code; fails unique/wrong-reason bars. The real dialog confirmation owner remains. |
| L343 — opens once the media are resolved and some are offline; never for read-only projects | REWRITE | Keep resolved-offline auto-open and read-only exclusion, but initialize the read-only session runtime as offline before rendering. Previously it stayed resolving, so removing the read-only guard still passed. Remove50ms sleep: hook effects are synchronous through renderHook act. Link-media §5 specifies the visible dialog and read-only boundary. |

## `apps/web/test/motion-path-effect-points.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L92 — is drawn for the effect focused in Effect Controls, through the layer, evaluated like the renderer | DELETE | Expected path dots were computed by production evaluate and incidental90-dot/rectangle coordinates were pinned. Fails independent-oracle/appearance/stable-seam bars. Remaining pointer key/tangent and interpolation-menu owners observe committed values; project/spatial render owners protect curve evaluation. |
| L119 — the param row focus also shows it; dragging a key edits the normalised value in one undo entry | KEEP | Dragging the effect point from(480,405) to(500,425) must store normalized(.5+40/1920,.75+40/1080), one undo entry, undo literal(.5,.75). Spatial-points §Program monitor defines normalized layer-space editing. Independent geometry converts the actual gesture, not markup widths; model commands cannot catch inverse-map wiring. |
| L136 — dragging a tangent handle stores normalised tangents (continuous, lengths kept in pixels) | KEEP | Dragging the outgoing tangent30screen px up must store−60/1080 normalized y, collinear Continuous handles and undo to Auto. Spatial-points specifies pixel-metric tangent editing; before-state plus independent unit conversion can disagree with event routing. Lower tangent commands do not map pointer coordinates. |
| L160 — is offered on Transform Position keys and sets their mode | KEEP | The actual Spatial Interpolation menu starts checked Auto and selecting Linear commits that mode on Transform Position. Spatial-points §Consumers names effect-point controls; tests below cannot prove that Effect Controls offers the right target. |

## `apps/web/test/playback-audio.test.tsx`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L50 — WMA: the stream WAVs once ready, null (silent) before, never the original | REWRITE | Use only the actual resolveMediaHandle boundary: fixed stream0 WAV URL when ready; null while generating or runtime unknown; original AAC omits playbackAudio. Consolidates helper and default cases. Wma-preview §Preview wiring independently specifies null versus absent and exact stream URL protocol; compositions cannot catch web handle omission. |
| L68 — AAC media keep playing the original (no playbackAudio key at all) | CONSOLIDATE | Original AAC behavior is asserted in the surviving resolveMediaHandle case. Remove a separate helper-only execution; the public handle still omits playbackAudio for browser-decodable original audio. |
| L74 — scrubbing / Detect Peak read the stream WAV (its only track), nothing while it is being made | KEEP | Scrubbing/Detect Peak stream3 uses its WAV as track0; pending copy yields silence; ordinary/proxy sources preserve stream index. Wma-preview §Preview wiring specifies this decoding boundary; Program AudioLayer tests cannot establish the separate browser decoder input. |
| L90 — follows the playback-audio derivative: status, job progress and the ready URL | KEEP | Actual EngineClient HTTP status plus job.updated and derivative.ready events move runtime queued→running0.5→ready and supply the fixed WAV URL. API wire-event contract and session state are independent; static handle tests cannot detect missing event subscription/state routing. |
| L160 — shows progress while the playback audio is made, a visible failure, nothing once ready | REWRITE | Replace private playbackAudioBadge return-shape/copy assertions with actual ClipView. Running42% is visible, decoder error detail is visible, and ready removes the failure. Wma-preview §Preview wiring/AGENTS visible failure contract applies; a helper could pass while the rendered clip suppresses all errors. |

## `e2e/interchange.spec.ts`

| Original test | Decision | Contract, independent oracle, credible failure and unique owner |
| --- | --- | --- |
| L40 — File ▸ Export ▸ Final Cut Pro XML: options, job, report and download | KEEP | File Export critical built-app workflow: actual FCP7 XML download/job/report and document contents protect UI menu→authenticated HTTP→artifact wiring. File existence and parser-level data are independent; isolated dialog/parser owners cannot establish deployed workflow. |
| L81 — File ▸ Import of an EDL whose media moved, then Link Media by folder | REWRITE | Keep real File Import EDL→offline placeholders→folder search→verified relinks with committed media and one undo step; incoming automatic-close behavior uses condition waits. Remove DOM row-count assertion superseded by actual project pending/linked media. Link-media workflow crosses built-app auth/HTTP/jobs/UI, beyond model owners. |

## Cleanup, validation and measured cost

Two exports used only by these tests are now private: `playbackAudioUrls` in the Program snapshot builder and `presetOf` in the Effect Controls menu library. The former still serves its same-file real media-handle builder; the latter still serves `commonPreset`. All other deleted helper-test subjects have external production callers and remain available. No unused fixture, mock module, dependency or configuration was orphaned.

Net **−306 test/support lines**,12 fewer declarations (66→54;52 unit/integration plus two retained E2E owners). No runtime contract or test tolerance was weakened. The2,000-media helper scenario alone consumed2.153s in the unmodified incoming baseline; it is deleted because stronger transaction/UI owners cover the behavior, not merely for its duration. Link Media JSON file spans were3.835s before and1.661/1.244s in the two restored runs. Those timings have scheduling/polling variance on the shared8-vCPU host and are not a measured full-suite or CI speedup. The retained UI Locate workflow itself stayed around1.1s; module imports and real MCP engine startup remain larger process costs.

Baseline: root ran all changed incoming paths with two workers before any edits (`/tmp/jasper-test-cleanup/incoming-wave2/baseline.{json,log,time}`). All64 cases in these twelve default files passed. This scope did not own the five invalid private-ease-helper imports failing elsewhere. The first rewrite attempt passed50/52: its two newly constructed fixtures used a malformed `med_1` in actual clip placement and the wrong textbox role for a native search input. A session-generated ID and public searchbox role corrected both; the seven cases in those files then passed. No product behavior or assertion was removed to hide those setup errors.

Restored validation: **52/52 passed across12 files**,43.27s runner/44.445s process. A second run after the final used-font assertion passed **52/52**,41.87s runner/43.100s process, explicitly requiring oracles and Chrome. No skips, unhandled errors or retries. The two sources differ only in that last small font fixture, so these are reliability observations, not identical-source timing samples. Exact commands (Node20.19.0,pnpm10.34.5,Vitest4.1.11; frozen offline install, own workspace package links verified):

```sh
env -u NODE_OPTIONS JASPER_REQUIRE_ORACLES=1 \
  JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome pnpm exec vitest run \
  apps/mcp/test/fonts.test.ts apps/mcp/test/integration.test.ts \
  apps/mcp/test/interchange.test.ts apps/mcp/test/transitions.test.ts \
  apps/web/test/audio-crossfade-ui.test.tsx apps/web/test/crop-order-ui.test.tsx \
  apps/web/test/fonts.test.tsx apps/web/test/interchange.test.tsx \
  apps/web/test/keyframe-sides-ui.test.tsx apps/web/test/link-media.test.tsx \
  apps/web/test/motion-path-effect-points.test.tsx apps/web/test/playback-audio.test.tsx \
  --maxWorkers=2 --reporter=default --reporter=json \
  --outputFile.json=/tmp/jasper-test-cleanup/wave2-web-mcp/repeat.json
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/web typecheck
env NODE_OPTIONS=--max-old-space-size=4096 pnpm --filter @jasper/mcp typecheck
env NODE_OPTIONS=--max-old-space-size=4096 pnpm e2e:typecheck
```

All actual TypeScript commands passed; web was checked again after the final fixture edit. The heap is the verified command-local allowance, overriding the host compiler interception. Biome passed all13 changed TypeScript/TSX files; `git diff --check` passed. All source-only changes were reviewed: exactly the two unused exports became private. No generated media, artifacts, symlinks, dependency or lockfile changes are committed.

Six real production mutations independently failed at intended assertions, then production bytes were restored:

| Mutation | Intended observed failure |
| --- | --- |
| Ignore Custom Start in edge gestures | Wrong committed duration/cut position, versus literal25/0.2 |
| Keep Continuous linkage despite Alt | Actual graph drag leaves Continuous instead of Bezier |
| Remove read-only guards from auto-open | A visible Link Media dialog appears for the resolved read-only session |
| Hide only failed playback badges | Actual ClipView has no decoder-error detail, despite its running progress still working |
| Omit playback-audio from Program media handles | Fixed WAV stream mapping becomes undefined |
| Include unused missing fonts in Resolve Fonts | Extra unreferenced family appears in the missing list |

Mutation commands were `env -u NODE_OPTIONS pnpm exec vitest run <owning-file> --maxWorkers=2 -t <affected-name>` plus default/JSON reporters; complete argv, assertion failures, wall times, restoration hashes and logs live under `/tmp/jasper-test-cleanup/wave2-web-mcp/` (`mutate.py`, `mutations.json`, individual reports and validation-status files). Final restored positive scopes above passed after all mutations.

The two E2E owners remain in the manifest: export is KEEP; import/relink is REWRITE. Root owns the fresh built-app run of both after all incoming work integrates; browser execution was not run in this worktree. Neither the scoped52-case gate nor TypeScript is claimed as the repository-wide final gate.
