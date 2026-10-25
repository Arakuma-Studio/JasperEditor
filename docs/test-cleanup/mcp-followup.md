# MCP cleanup follow-up

Scope starts at `8b4c8936`: all 68 current MCP test files, including 245 named declarations (parameterized declarations counted once). Existing [MCP ledger](mcp.md) and [window response regression](mcp-ui-window.md) remain historical records; this follow-up supersedes only the rows explicitly changed here. The inventory is AST-based. No test-count or coverage target drove retention.

The six-bar justification for every surviving row combines its exact named scenario with its file’s evidence paragraph:

1. The source is a requirement, public protocol/configuration contract, compatibility obligation or documented regression, independent of the handler.
2. The named request must produce the authored document/result/artifact or specific refusal; a missing/wrong conversion, unintended write, lost metadata, leaked credential or broken workflow is recognizable to callers.
3. Expected values are authored inputs, external-format vectors, known generated-media truth or specified invariants. A fake engine supplies dependency input; it does not implement the asserted MCP transformation. The removed gain calculation and catalogue length violated this rule.
4. The observed seam is the public MCP/CLI/HTTP result plus persisted document/file, or the lowest stable PNG/parser/renderer entry boundary. Private collaborator shape and source spelling are removed.
5. Handler/file/helper renames, batching and implementation decomposition may change while those outcomes remain. Revision checks replace duplicate stream plumbing; marker checks allow plot/header movement.
6. The particular boundary conversion/workflow in each row is absent from its lower algorithm owner. Source/PNG/annotation/renderer duplicates were reviewed against the remaining owners named below. No model test alone substitutes for MCP argument/default/permission wiring.

A KEEP row does not claim unrelated incidental assertions are independently contractual. Its named meaningful outcome and file-specific oracle are the retention basis. Rendering requirements are explicit for the annotated sound sheet (Spec 12 P6-E6/P6-E7); that is why semantic lane/marker alignment survives while arbitrary grid and font metrics do not.

## Implementation and limits

- Deleted phrase/source inventories and private glyph/grid probes; retained one narrowed peak-line contract plus hostile-data properties.
- Consolidated the duplicate authenticated editor WebSocket fixture into the existing shared helper, waiting for the server welcome instead of sleeping.
- Replaced color/grading’s duplicated SSE collectors and five 500-ms sleeps with exact project revision deltas; `apps/engine/test/agent.test.ts` remains the owner of `doc.changed` publication/relay behavior.
- Removed proposal/cancellation sleeps, the unasserted zero-gain native export, and an unrelated material-test timeline rendering pass. Kept actual native-export/FFmpeg peak verification.
- Removed the redundant JSON-record response wrapper after a baseline compiler failure exposed circular Zod inference; retained recursive JSON validation plus explicit object-root rejection.
- Removed the dead `foldText` export after its private-font test disappeared. Its function body and production callers stay internal; other PNG/font/sound helpers still have real callers. No dependency, snapshot, persisted schema or production behavior changed.
- Left expensive generated sound, picture-motion, lossily encoded delivery, real-model-pipeline and opt-in rendering workflows when they protect distinct public orchestration. The tiny semantic model validates plumbing, not CLAP quality.
- Identified 27 legacy teardown races with uncancelled 8-second fallback timers. They are not changed or claimed as a measured performance gain in this pass; broader process-lifecycle consolidation needs its own measured evidence.

Disposition counts for this follow-up (declarations, not expanded runtime cases): DELETE 12, KEEP 208, OPTIMIZE 12, REWRITE 13.

## Per-test disposition

## `apps/mcp/test/animation.test.ts`

Independent source: PNG specification frozen FFmpeg-decoded vectors; AGENTS §0 allocation/validation rules. Owner inspected: `apps/mcp/src/png.ts`. Oracle: Frozen RGBA bytes, malformed headers and bounded invalid sizes. Non-test callers / other coverage: decodePng/encodePng/composeGrid called by tools/animation.ts; png-limits owns overlapping resource guards.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| decodes RGB and RGBA rows of every filter type | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| decodes greyscale with alpha and rejects unsupported input | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| requires complete headers, chunks and an end marker | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| rejects invalid raster and grid sizes before allocating | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/audio-fx.test.ts`

Independent source: docs/wp-notes/audio-fx.md and published audio tool arguments. Owner inspected: `apps/mcp/src/tools/audio-fx.ts`. Oracle: Real command application, authored effect values, LUFS differences and audio activity offsets. Non-test callers / other coverage: Tool handlers registered by server; project audio commands own DSP/edit algebra.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| adds with keyframes, edits, reorders, bypasses and removes | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| type, options, Auto-Match, ducking, clear | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| remix to a duration and revert | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/auto-tag.test.ts`

Independent source: Spec 12 P6-R3 and docs/wp-notes/sound-design.md Phase 6.3. Owner inspected: `apps/mcp/src/tools/audio-fx.ts`. Oracle: Authored classifier outputs 0.95 dialogue / 0.45 music / silent, raw persisted tags, forced user-type override and distinct error codes. Unique protection / remaining owner: The MCP translation must select untyped clips, preserve the user’s type, apply classification and report low confidence; a classifier/model unit cannot prove that orchestration. The retained e2e/sound-autotag.spec.ts and p65 automatic-drop-tagging workflows own the live asynchronous classifier/application route; the in-memory engine is not its only owner.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| tags every untyped clip in one transaction, marked auto; reports low confidence; silent stays untyped | REWRITE | Remove private classification-call shape/counts and wording; assert raw persisted tag fields and exact refusal codes. |
| propose only classifies; a user type is kept unless force; minConfidence | REWRITE | Remove private classification-call shape/counts and wording; assert raw persisted tag fields and exact refusal codes. |
| engine failures and bad arguments are tool errors | REWRITE | Remove private classification-call shape/counts and wording; assert raw persisted tag fields and exact refusal codes. |

## `apps/mcp/test/bundle.test.ts`

Independent source: README MCP stdio launch contract; docs/ARCHITECTURE.md §11. Owner inspected: `apps/mcp/scripts/build.mjs and src/cli.ts`. Oracle: Actual bundled Node process must answer SDK initialize. Non-test callers / other coverage: Distributed jasper-mcp executable; no weaker helper proves bundle loading.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| the jasper-mcp bundle loads and answers initialize | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/cache.test.ts`

Independent source: docs/wp-notes/wp-m3-cachegc.md S04:CA-019 public usage units. Owner inspected: `apps/mcp/src/tools/cache.ts`. Oracle: Known byte inputs must become 300/100/150/50 MB and 25600 MB budget. Non-test callers / other coverage: Public get_cache_usage; conventions owns annotations.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| get_cache_usage converts byte counts to MB | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/captions.test.ts`

Independent source: docs/wp-notes/captions.md; SRT/VTT/SCC file contracts. Owner inspected: `apps/mcp/src/tools/captions.ts`. Oracle: Files on disk and independently authored word/cue ranges applied by real commands. Non-test callers / other coverage: Public caption/transcript tools; project caption algorithms do not own MCP import/export orchestration.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| imports, lists, edits and exports captions (files on disk) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| transcript tools: inspect, search, select, fillers, pauses, captions | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| extract, lift and insert a text selection | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/color-mgmt.test.ts`

Independent source: docs/wp-notes/color-mgmt.md public working/footage/clip color spaces. Owner inspected: `apps/mcp/src/tools/color-mgmt.ts`. Oracle: Real persisted color-space overrides and absolute import path rules. Non-test callers / other coverage: Public color management tools; project validation owns color data schemas.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| lists spaces, sets the working space, interprets footage and overrides a clip | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| imports an OCIO config and refuses relative paths | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/color.test.ts`

Independent source: docs/wp-notes/wp-m2-color.md; docs/specs/06-color-grading.md MCP/render requirements. Owner inspected: `apps/mcp/src/tools/color.ts`. Oracle: Actual engine documents, independently known LUT errors and rendered frames. Non-test callers / other coverage: Public MCP color editing, real engine; unit color tests do not own transport/persistence/render orchestration.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| imports a .cube LUT and reports the broken one with its line number | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| grade_clip grades in one Agent change and render_frame shows it | OPTIMIZE | Replace event-stream sleep/pump with one committed revision; engine agent suite owns doc.changed. |
| get_grade returns the evaluated values and LUT names | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| keyframed params need a time: rejected without one, keyed at `at` | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| instance "new" stacks a second Lumetri; copy_grade replaces the target grade in one change | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/compositions.test.ts`

Independent source: docs/wp-notes/wp-m3-mgtext.md public composition import/update/render contract. Owner inspected: `apps/mcp/src/tools/compositions.ts`. Oracle: Real compiler/imported composition, metadata duration and rendered artifact. Non-test callers / other coverage: Public composition pipeline; compiler units do not own import-to-render workflow.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| imports, places, edits and renders a composition; errors carry hints | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/conventions.test.ts`

Independent source: docs/wp-notes/mcp-cli.md §§1–2 MCP metadata, strictness, progress and cancellation. Owner inspected: `apps/mcp/src/context.ts and src/strict.ts`. Oracle: Protocol metadata, explicit argument keys/codes, clock times and cancellation notification. Non-test callers / other coverage: Every tool uses strict registration/context; project owns suggestions; SDK boundary owns cancellation.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| every tool has a title and all four annotation hints, set consistently | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| every fixed-shape object of every input schema forbids additional properties | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| rejects an unknown top-level key, naming it and the accepted keys | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| rejects unknown keys inside nested objects and union members | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| applies to tools registered directly on the server | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| reports schema mismatches with the accepted and required keys | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| throttles progress to one notification per 100 ms, increasing, latest value wins | REWRITE | Assert the documented minimum 100-ms spacing, increasing values and final latest-value flush; allow different valid intermediate schedules instead of pinning one private batching schedule. |
| sends nothing without a progress token | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| notifications/cancelled on wait_for_job cancels the engine job | OPTIMIZE | Cancel after observed progress instead of a fixed 400-ms delay. |

## `apps/mcp/test/default-sequence.test.ts`

Independent source: Published SequenceIdArg default-first behavior; docs/wp-notes/code-audit-mcp.md multi-sequence regression. Owner inspected: `apps/mcp/src/context.ts`. Oracle: Two distinct sequences, explicit expected destination and E_TRACK_KIND. Non-test callers / other coverage: transact used by all editing tools; project intentionally requires sequence selection rather than choosing MCP defaults.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| add_text and add_marker without sequenceId edit the first sequence | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| an explicit sequenceId is sent as given and not second-guessed | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| invalid track kind is refused with or without an explicit sequence | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/discovery-start.test.ts`

Independent source: AGENTS §0 child-process failure propagation; engine autostart public config. Owner inspected: `apps/mcp/src/discovery.ts`. Oracle: Actual ChildProcess error event must reject rather than emit unhandled error. Non-test callers / other coverage: startHeadlessEngine used by EngineLink autostart; real integration owns normal lifecycle.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| rejects engine spawn errors without emitting an unhandled child error | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/ease-trim.test.ts`

Independent source: docs/wp-notes/mcp-cli.md Easing and Trim Paths; CSS cubic-bezier syntax; S03 keyframe rules. Owner inspected: `apps/mcp/src/tools/ease.ts, tools/trim-paths.ts`. Oracle: Literal CSS control points, 0/30/60 frame positions, known speeds, preserved endpoints, real command application and document restoration after undo. Unique protection / remaining owner: The MCP selectors, time conversion, curve spellings, tool orchestration and guide resource keys are not exercised by the pure keyframe/shape owners. Parser properties own malformed input without live server startup.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| get_clip_properties lists the ease leaving every key; get_keyframe_eases gives the detail | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| apply preset → read back the same preset id, for cubic segments and multi-point runs | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| cubic-bezier strings, handle objects, keywords and custom points are applied exactly | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| sections: one key gets its in and out segments by default | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| transfer_ease, transfer_keyframe_values and set_keyframe_velocity round-trip | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| create_path_controller and cleanup_motion_path on position keys | REWRITE | Retain authored CSS values/selectors/endpoint preservation/document undo; remove catalogue-count, private call logs, generated-expression strings and exact prose. |
| refusals and argument errors are error results with hints, applying nothing | REWRITE | Retain authored CSS values/selectors/endpoint preservation/document undo; remove catalogue-count, private call logs, generated-expression strings and exact prose. |
| every edit is one undoable History entry | REWRITE | Retain authored CSS values/selectors/endpoint preservation/document undo; remove catalogue-count, private call logs, generated-expression strings and exact prose. |
| lists every built-in preset with cubic values or point counts, per group | REWRITE | Retain authored CSS values/selectors/endpoint preservation/document undo; remove catalogue-count, private call logs, generated-expression strings and exact prose. Surviving name: `lists CSS cubic values and filters multi-point presets by group`. |
| add_line → animate_trim_paths with a tracer is one transaction; re-running replaces; undo removes both | REWRITE | Retain authored CSS values/selectors/endpoint preservation/document undo; remove catalogue-count, private call logs, generated-expression strings and exact prose. |
| skipped clips get no tracer; curve must be cubic; refusals are error results | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| reverse_path_direction and add_trim_tracer (default master trim, existing follower) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| parses presets, names, keywords, cubic-bezier strings, handles and points | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| fuzz: any string either parses to a valid curve or is an E_INVALID_PARAM ToolError | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| fuzz: cubic-bezier strings round-trip their numbers; out-of-range x is refused | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| the easing and Trim Paths examples apply to a real document | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| jasper://guide carries the easing and Trim Paths guides | REWRITE | Retain authored CSS values/selectors/endpoint preservation/document undo; remove catalogue-count, private call logs, generated-expression strings and exact prose. |

## `apps/mcp/test/edit-ux.test.ts`

Independent source: docs/wp-notes/edit-ux.md public source edits, match frame and split marks. Owner inspected: `apps/mcp/src/tools/edit-ux.ts`. Oracle: Authored frame/time examples evaluated through real transactions. Non-test callers / other coverage: Public edit tools; pure edit commands do not own MCP seconds/timecode conversion.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| source_edit: three-point at `at`, backtiming, four-point needs fit, fit to fill | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| find_edit_points + trim_edit_points roll a cut; match_frame and reverse_match_frame agree | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| make_subclip / edit_subclip / set_split_marks | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/export-credits.test.ts`

Independent source: Spec 12 §2.11 and Phase 6.4 export credits. Owner inspected: `apps/mcp/src/tools/render.ts`. Oracle: CC BY versus CC0, authored CSV/TXT/MD choices, explicit null, sequence precedence and warning codes/credits URLs. Unique protection / remaining owner: The engine owns writing the sidecar; these cases uniquely check MCP default selection and projection of plan/job warnings.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| defaults to Markdown when a used sound needs a credit; returns the sound warnings with their codes | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| format, scope and null reach the engine; null leaves W_SOUND_CREDITS for the agent to tell | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| the sequence setting wins over the default (none when set to null); CC0 alone gives none | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| wait: true and wait_for_job return the credits file and the warnings of the result | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/export-delivery.test.ts`

Independent source: Spec 12 delivery guarantees; docs/wp-notes/sound-design.md lossy-codec true-peak headroom correction. Owner inspected: `apps/mcp/src/tools/render.ts, tools/sound-check.ts`. Oracle: A generated loud mix, independently required −1 dBTP target, AAC 128 kb/s preset and actual export/check decoded levels. Unique protection / remaining owner: A numerical limiter test does not exercise the MCP preset-to-export-to-check wiring or delivery metadata exposed to callers.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| start_export, wait_for_job and sound_check {exportPreset} report the ceiling and the decoded audio | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/format.test.ts`

Independent source: Public timeline source-range display; docs/wp-notes/time.md time remapping. Owner inspected: `apps/mcp/src/format.ts`. Oracle: Six seconds source media at half speed must still display six source seconds. Non-test callers / other coverage: timelineTable is used by public timeline tools; no render checks the text data representation.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| a time-remapped clip shows the media its frames show, not sourceIn + duration | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/grading.test.ts`

Independent source: docs/specs/06-color-grading.md and docs/wp-notes/color-grade.md. Owner inspected: `apps/mcp/src/tools/color.ts`. Oracle: Real applied grading state, numeric scopes and independently compared rendered pixels. Non-test callers / other coverage: Public grading pipeline; engine owns numerical auto-tone and look catalogues.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| sets every new Lumetri section in one change; get_grade reads them back | OPTIMIZE | Assert one committed revision through get_project; remove SSE transport duplication and fixed sleep. |
| the spatial stage (vignette, HSL Secondary) renders: render_frame changes when the vignette is switched off | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| scopes_read measures a frame as numbers (and one clip alone) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| color_match solves clip A towards a frame of clip B in one Apply Match change | OPTIMIZE | Assert one committed revision through get_project; remove SSE transport duplication and fixed sleep. |

## `apps/mcp/test/imports.test.ts`

Independent source: docs/wp-notes/imports.md public interpretation and PSD/PDF/image-sequence imports. Owner inspected: `apps/mcp/src/tools/imports.ts`. Oracle: Real documents, explicit 29.97→23.976 rate/loop example and distinct PDF pages. Non-test callers / other coverage: Public import tools; engines decode source formats, MCP owns document registration/conversion.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| interprets footage and reports file vs effective values | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| refuses empty, unknown and strictly-invalid interpretations | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| imports an image sequence from one frame | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| lists PSD layers and imports them as a sequence | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| imports chosen PSD layers individually or merged, and the flattened picture | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| imports PDF pages, one item per page | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| exports a sequence as Lottie with warnings | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/integration.test.ts`

Independent source: docs/ARCHITECTURE.md §11; docs/wp-notes/mcp-cli.md; S03:KF-021. Owner inspected: `apps/mcp/src/server.ts and registered tool owners`. Oracle: Actual engine persisted state, independent frame/value expectations, files and authentication refusals. Non-test callers / other coverage: Public MCP workflows; lower command tests do not exercise discovery/auth/transport/persistence together.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| discovers the engine, edits media, renders a frame, and exports a playable video | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| clipboard tools preserve destination time, track, insertion mode and bin | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| keeps the engine token out of MCP responses and stderr | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| serves project resources and the edit-video prompt through MCP | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| dry runs leave the project unchanged and destructive edits require approval | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| creates, edits, applies defaults, and removes transitions through MCP | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| persists text animation changes and returns a PNG contact sheet | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| stores a shape with the requested geometry and rejects invalid ellipse corners | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| reads a curved motion path and sets its spatial interpolation (S03:KF-021) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| starts an engine and stops it when the MCP client closes | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/interchange.test.ts`

Independent source: docs/wp-notes/interchange.md public timeline import/export/relink contracts. Owner inspected: `apps/mcp/src/tools/interchange.ts`. Oracle: Authored engine fragments applied by real commands, explicit options/URLs and force-only mismatched relink. Non-test callers / other coverage: Public interchange tools; codec parsers do not own MCP transaction and safety orchestration.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| import_timeline applies the fragment and reports offline media and what was not carried | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| export_timeline maps the options, waits for the job and lists files and losses | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| list_offline_media and link_media (folder search; differences need force) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/jasper-cli.test.ts`

Independent source: docs/wp-notes/mcp-cli.md §5 CLI commands/options/exit statuses; README CLI usage. Owner inspected: `apps/mcp/src/jasper-cli.ts and src/jasper.ts`. Oracle: Actual CLI statuses, document values, JSON-lines and output media files. Non-test callers / other coverage: jasper executable invokes runCli; helpers have no external production callers or package exports.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| usage errors exit 2, --help 0, --version 0 | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| status, project creation through call, and project resolution | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| import, exec with k=v and JSON, describe, run with JSON-lines output | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| get / set / props report value and evaluated | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| render-frame writes a PNG, export writes a video | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| the bin entry runs and returns the exit status | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/masks.test.ts`

Independent source: docs/wp-notes/masks.md public pixel/normalized masks, trace holes and track mattes. Owner inspected: `apps/mcp/src/tools/masks.ts`. Oracle: Explicit 0.5/0.1 normalized coordinates, add/subtract holes and 50-pixel translation. Non-test callers / other coverage: Public mask tools; project owns mask data algebra but not MCP unit conversion/job application.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| add (px units), list, edit, remove | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| auto-trace creates add / subtract masks; track_mask writes path keys | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| set_track_matte adds a Track Matte Key reading V1 and hides it | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/multicam.test.ts`

Independent source: docs/wp-notes/multicam.md signed offsets, sync confidence and angle selection. Owner inspected: `apps/mcp/src/tools/multicam.ts`. Oracle: Explicit 60/30-frame offsets, actual switched/flattened document and unreliable-sync refusal. Non-test callers / other coverage: Public multicam tools; project commands do not interpret engine audio alignment samples.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| creates a multicam by audio, places it, switches, records, lists and flattens | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| refuses unreliable audio unless asked, and merges clips | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| synchronizes timeline clips by audio against the reference the command uses | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/music-picture.test.ts`

Independent source: Spec 12 P6-E11 music to picture. Owner inspected: `apps/mcp/src/tools/audio-fx.ts, tools/sound-design.ts`. Oracle: Generated C-major music with a known bar-17 drop at 32 s, hero at 20 s + 15 frames, one-millisecond alignment and authored bar endings. Unique protection / remaining owner: Each case exercises a different public route: discovery, anchored remix persistence, end-on-bar fitting, style planning, cue edits or typed refusal. Beat-analysis units do not test their orchestration.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| names the tools and the style options | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |
| find_music_drops names the drop at bar 17, where it plays now, the key and tempo | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| remix_audio {landDropAt: "hero"} lands the drop on the hero; a later remix keeps it | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| fit_music_to_picture end-on-bar ends the music just before a bar line, faded | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| plan_sound_design takes tuneToMusic / stopOnBar and tunes the chime | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| set_sound_cues {stopBefore: true} ends on the bar line the plan picks for the same cue; plain with stopOnBar off | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| refusals are typed | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/png-limits.test.ts`

Independent sources: PNG scanline encoding; AGENTS §0 untrusted dimensions; `docs/wp-notes/mcp-cli.md` explicitly records preserving 8K support and refusing surplus inflated data. Production owner: `apps/mcp/src/png.ts`, used by contact-sheet tools. These tests do not prove an upper bound on inflation allocation.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| refuses oversized dimensions before expanding the compressed data | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| decodes an 8K source image | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| validates dimensions and scanline lengths across varied PNG inputs | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/polish.test.ts`

Independent source: Public browse_media arguments and local file privacy contract; README MCP media browsing. Owner inspected: `apps/mcp/src/tools/polish.ts`. Oracle: Requested video filtering retains folders, excludes audio/captions and enforces limit/probe options. Non-test callers / other coverage: Public browse_media; engine tests own actual disk enumeration.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| lists a folder, filters by kind, limits and probes | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/presets.test.ts`

Independent source: docs/wp-notes/effect-presets.md public search, anchor-to-out and built-in immutability. Owner inspected: `apps/mcp/src/tools/presets.ts`. Oracle: Explicit 20/29→80/89 keyframe placement and real applied effect values. Non-test callers / other coverage: Public preset tools; model owns serialized preset schema, MCP owns selection/anchor request mapping.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| filters built-in presets by query and reports user library bins | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| saves from a clip, applies by id with Anchor to Out, and refuses built-in deletion | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| applies inline JSON and a built-in to several clips in one transaction; validates authored presets | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/previews.test.ts`

Independent source: docs/wp-notes/previews.md public render-bar ranges and render request modes. Owner inspected: `apps/mcp/src/tools/previews.ts`. Oracle: Independently placed clips at 0,10,20,30,60 and public HTTP job request/result. Non-test callers / other coverage: Public preview tools; project owns segmentation/hash arithmetic; engine owns cache file deletion/perf counters.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| get_render_bar_state reports the segments with their state, cost and reasons | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| render_previews sends the requested mode and whole-sequence range, then waits for completion | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/processing.test.ts`

Independent source: docs/specs/07-clip-processing.md safety, media-version coverage and sidecars. Owner inspected: `apps/mcp/src/tools/processing.ts`. Oracle: Real processed files/document versions, explicit handle ranges, fit refusal/trim and destructive metadata. Non-test callers / other coverage: Public processing workflow; pure model tests do not exercise actual processing/sidecars.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| marks processing settings as destructive in the MCP tool schema | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| set_processing_settings needs the user in an open editor | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| process_clip (denoise, local, replace, wait) swaps the clip to the processed version | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| process_clip with handles processes only the clip range (+ handles) and keeps the source frames | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| use_media_version refuses a version that does not cover a clip, or trims with fit: "trim" | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| import_media links a render with a sidecar to its source; set_media_source_range; replace_footage keeps timing | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/proposals.test.ts`

Independent source: Architecture D-51; Spec 12 §2.5/§2.10. Owner inspected: `apps/mcp/src/tools/proposals.ts, tools/sound-design.ts`. Oracle: Unchanged project revisions in propose mode, explicit user decisions/notes, actual stored proposal and exactly one revision on permitted apply. Unique protection / remaining owner: Proposal store tests do not cover MCP defaults, permission refusal, waiting/serialization or plan-to-proposal wiring. The `since` token supplies a stable observation boundary independent of call scheduling.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| plan_sound_design stores a proposal (nothing applied) with a table, why-lines and alternates | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| get_proposal lists items and a ghost table; an agent may not accept; reject works | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| wait_for_proposal returns the user’s decisions: accepted, rejected, swapped, notes | OPTIMIZE | Remove the fixed 1500-ms delay: since-token semantics observe the note independent of scheduling. |
| an allowed agent accepts the rest ("all" = the remaining place items with their setup); decided | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| place_sound proposes by default; a placement that cannot apply is refused and leaves no proposal | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/qa/scenarios.test.ts`

Independent source: docs/wp-notes/mcp-cli.md §6 explicitly requires seven visual critical workflows. Owner inspected: `apps/mcp/src/server.ts, real engine and render pipeline`. Oracle: Generated fixture truth, measured pixel/color/frame results and recorded QA artifacts. Non-test callers / other coverage: End-to-end MCP is required owner for these seven workflows; command units are not visual substitutes.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| rough cut: place, split, ripple-delete and stack shots; every cut shows the right picture | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| colour grade: exposure brightens, saturation 0 makes grey, get_grade reads it back | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| titles: a white title is drawn where it is placed and follows its position | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| transitions: a cross dissolve mixes red into blue across the cut | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| keyframes: opacity fades the title in, position keys move it, evaluated matches the render | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| export and re-import: the file has every frame and plays back like the timeline | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| cancelling a waiting export over MCP cancels the engine job and leaves no file | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/roto.test.ts`

Independent source: Public roto propagation/render/export contract; AGENTS §4 preview/export fidelity. Owner inspected: `apps/mcp/src/tools/roto.ts`. Oracle: Generated known object mask, independent IoU ≥0.93 and exported frames. Non-test callers / other coverage: Actual roto workflow with retained artifact; lower mask tests cannot prove pipeline fidelity.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| create_roto → propagate → render_frame / export cut the object out (IoU ≥ 0.93), masks, refusals | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sim-warp.test.ts`

Independent source: docs/wp-notes/sim-warp.md public Puppet pin animation. Owner inspected: `apps/mcp/src/tools/sim-warp.ts`. Oracle: Known pin coordinates and independently evaluated keyframe positions after real commands. Non-test callers / other coverage: Public Puppet tools; project deformation tests own packed mesh representation.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| Puppet: add, move, record, get, remove pins | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-beds.test.ts`

Independent source: Spec 12 P6-E12 beds and room tone. Owner inspected: `apps/mcp/src/tools/sound-beds.ts`. Oracle: Generated dialogue with −52 dBFS floor, three authored scenes and a known one-second gap; preview/propose leave the document unchanged and apply commits once. Unique protection / remaining owner: The engine owns acoustic ranking; these cases verify preview/propose/apply orchestration, selected scene/range conversion and typed public refusals.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| names the tools, the measurements and the Sound Check fix | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |
| lay_ambience_bed: preview, propose (nothing changes), apply (one edit) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| fill_room_tone: the floor, the ranked tones (pink closest), the fill | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| typed refusals | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-check-ack.test.ts`

Independent source: Spec 12 P6-E4/P6-E5 acknowledgement and proposal checking. Owner inspected: `apps/mcp/src/tools/sound-check.ts`. Oracle: A generated late hit and hard ending, warnings acknowledgeable but errors refused, no project revision while checking a proposal. Unique protection / remaining owner: The MCP policy/serialization and proposal-mode safety are distinct from the engine detector and model acknowledgement persistence.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| acknowledges a warning (not an error), the check agrees; a proposal check reports what it introduces | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-check-verdicts.test.ts`

Independent source: Spec 12 human verdicts and P6-E4/P6-E5 safe-fix review; delivery preset contract. Owner inspected: `apps/mcp/src/tools/sound-check.ts`. Oracle: Authored user versus agent markers, known stale-moment edit, explicit AAC/PCM/custom targets and safe versus unsafe fixes from a fixed report. Unique protection / remaining owner: Each case protects a different MCP projection or permission/default: user provenance, encoded target, stale verdict, kept report, safe-fix ordering or custom target validation. The fake engine provides inputs, not the asserted MCP transformation.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| returns the user’s listen-here verdicts with timecode, slot and note; not an agent’s marker | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| checks for the delivery preset’s typical encoding by default; exportAudio {codec: "pcm"} is the PCM master | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a verdict bound to its moment (soundDesign.setVerdict) says whether it is still current; older ones cannot tell | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| get_sound_check returns the kept report with its staleness and the verdicts; no job is run | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| safeFixes: the safe fixes once each in the order they were judged (commands, swaps, jobs); why lines | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| passes a custom target to the engine; refuses one out of range | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-check.test.ts`

Independent source: Spec 12 §2.10 P5-R2 Sound Check workflow. Owner inspected: `apps/mcp/src/tools/sound-check.ts, tools/sound-timeline.ts`. Oracle: A hit moved two frames late at 30 fps must report roughly 66.7 ms, its suggested fix resolves that finding and the kept check becomes current. Unique protection / remaining owner: This critical real-engine MCP workflow proves suggested tool arguments actually repair the edit and results/pictures survive the transport; detector units alone cannot prove that.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| finds a 2-frame late hit, its safe fix resolves it, the re-check passes and is stored; pictures decode | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-cues.test.ts`

Independent source: Spec 12 §2.10 P2-R6; WP2.3 cue routes. Owner inspected: `apps/mcp/src/tools/sound-design.ts`. Oracle: Authored cuts at 90/330, transition at 180, marker at 250; sample-exact alignment, preserved edit fields, alternate identities, revision conflicts and dialogue activity windows. Unique protection / remaining owner: Distinct public routes own cue derivation/storage, layered placement, explicit/cycled swaps, old-library-copy upgrade, peak alignment and speech-aware warnings. Model tests own their command algebra, not MCP selection/time conversion.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| builds the fixture and finds every event with frames, timecodes, reasons and anchors | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| set_sound_cues stores suggestions verbatim in one transaction, skips stored ones, edits, removes and resyncs | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| place_sound lands peaks exactly on cues: a sound with alternates, three layers, a pick by type | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| swap_sound keeps the peak frame, track, role, pan and gain; next / previous cycle the alternates | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| swap_sound to the clip’s own sound swaps an old copy of it (no trailing silence) for the current one | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| swap_sound cycles a sound placed without alternates: next ×3 progresses, previous ×3 returns to it | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| align_peak moves a clip (and its layers) so the peak lands exactly; back to its cue; refusals | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| place_sound warns of a hero under dialogue only where speech is heard (voice activity, mix gains) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-examples.test.ts`

Independent source: Spec 12 §2.9 runnable describe_commands examples. Owner inspected: `apps/mcp/src/examples.ts`. Oracle: Published example objects must apply through real address resolution and transaction validation after minimal documented setup. Unique protection / remaining owner: Example correctness is externally visible documentation behavior. Model command tests cannot notice a broken example distributed to callers. Each parameterized command uses its own published example.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| %s applies to a project with clip-a.mp4 | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-grammar.test.ts`

Independent source: Spec 12 P6-E10 sound grammar. Owner inspected: `apps/mcp/src/tools/sound-design.ts`. Oracle: Generated distinct clicks/keys/materials; repeated click choices share one voice and gain at rate 1, keys use sibling takes, wood ranks over metal, style options survive planning. Unique protection / remaining owner: These assertions protect public pick/swap/plan policy wiring. The removed duplicate picture call and array-is-array probe cannot prove the material/style contracts.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| names every rule and the style options | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |
| every click cue plays the one click voice at one level, speed 1, no jitter | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| keys are takes of one recording at speed 1; swap_sound next walks the sibling takes | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a hit pick prefers the material of the hits already placed (wood) | OPTIMIZE | Remove duplicate timeline render/artifact and array-type coverage probe; keep real material choices/style policy. |
| plan_sound_design takes the style options and reports what the grammar did | OPTIMIZE | Remove duplicate timeline render/artifact and array-type coverage probe; keep real material choices/style policy. |

## `apps/mcp/test/sound-guide.test.ts`

Independent source: Spec 12 agent instruction prose, with no exact spelling or private FULL_GUIDE identifier contract. Owner inspected: `apps/mcp/src/server.ts and tools/sound.ts`. Oracle: No independent functional oracle; old cases only matched phrases or parsed source. Unique protection / remaining owner: Runtime sound/proposal/approval workflows retain the behavioral safety rules; identifier renames and equivalent prose must be allowed.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| says what the spec requires | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |
| is part of FULL_GUIDE | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |
| teaches propose → wait → read the notes, and the policy gate | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |
| is part of FULL_GUIDE | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |

## `apps/mcp/test/sound-import-upgrade.test.ts`

Independent source: Spec 12 §2.1 padding compatibility; WP6.5b library-copy upgrade. Owner inspected: `apps/mcp/src/tools/sound.ts importCommands`. Oracle: One media identity after a changed fingerprint, unchanged timeline start, source-in shifted by exactly 50 ms and reimport reuse. Unique protection / remaining owner: The real command system applies the MCP builder output. The model upgrade command cannot catch the builder choosing duplicate registration rather than upgrade. Internal command-list decomposition was removed.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| upgrades the older copy in place: one media, its clip moved by the lead | REWRITE | Assert imported document identity/alignment/reuse, without pinning command-list decomposition. |

## `apps/mcp/test/sound-levels.test.ts`

Independent source: Spec 12 §2.3 default insert levels and Phase 2 verification B. Owner inspected: `apps/mcp/src/tools/sound-design.ts`. Oracle: Actual mixed/exported audio stays below 0 dBTP with normalisation off, metered by FFmpeg; default-level provenance survives placement. Unique protection / remaining owner: The project sound-level owner tests numerical role targets independently. This retained real MCP placement/export workflow owns aggregate unclipped audio. An unasserted second export and a production-derived gain oracle were removed.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| every fill gets its role level; the mix stays under 0 dBTP without normalisation | OPTIMIZE | Keep independent FFmpeg unclipped-audio oracle and role provenance; remove production-derived gain expectations and unasserted second native export. |

## `apps/mcp/test/sound-listen.test.ts`

Independent source: Spec 12 P6-E6/P6-E7; explicit annotated-sheet completion requirement at §4. Owner inspected: `apps/mcp/src/tools/sound-listen.ts, tools/sound-timeline.ts`. Oracle: Generated music/dialogue/clicks, known cut with no sound, transcript/result consistency and rendered sheet with correctly mapped semantic lanes/marks/thumbnails. Unique protection / remaining owner: The engine owns analysis; the MCP owner composes the caller-visible transcript and annotated image. The spec explicitly requires the PNG/cell alignment, so those visual assertions are retained.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| gives the transcript, the compact JSON and the annotated sheet; cells locate every lane, cue and thumbnail | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-mix.test.ts`

Independent source: Spec 12 §2.4/§2.10 Phase 4 mixing. Owner inspected: `apps/mcp/src/tools/sound-design.ts`. Oracle: Generated bed/dialogue, authored stop-before/build edits, room bus toggle/idempotence, delivery propose/apply behavior and strict-key refusal. Unique protection / remaining owner: Each operation has a distinct public tool-to-command orchestration contract. DSP/command units do not prove that MCP writes the requested automation or waits for engine measurements.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| stop-before / build on a filled cue, room glue, delivery; strict arguments | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-motion.test.ts`

Independent source: Spec 12 P6-R2/P6-E2 picture motion and WP6.5b annotated motion. Owner inspected: `apps/mcp/src/tools/sound-motion.ts, tools/sound-design.ts, tools/sound-timeline.ts`. Oracle: Generated box rests, moves during 1–2 s, stops; events/cues near authored frames 31/60, cached result, measured curve passed to the sheet, typed range errors. Unique protection / remaining owner: The real analysis-to-cue-to-MCP-sheet pipeline protects forwarding and cache use absent from detector units and direct renderer tests.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| finds the box moving (00:00:01:01–00:00:02:01) and stopping, draws the strip, and gives anchored pixel cues | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-packs.test.ts`

Independent source: Architecture D-50; Spec 12 pack provenance, approval and tool annotation rules. Owner inspected: `apps/mcp/src/tools/sound.ts`. Oracle: Pinned local pack fixture, external-facing annotation booleans, installed/searchable state and denial/approval/removal idempotence. Unique protection / remaining owner: Conventions owns broad annotation consistency, but cannot infer pack network/open-world semantics. The second case owns real install/index/approval orchestration rather than simulating the state under assertion.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| annotations: list is read-only, install reaches the network, remove is destructive and idempotent | REWRITE | Keep protocol annotations; remove non-contract description wording. |
| lists, installs (waiting for the index), searches by pack and removes behind the approval card | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-profile.test.ts`

Independent source: Spec 12 P6-E8 reference profiles. Owner inspected: `apps/mcp/src/tools/sound-profile.ts, tools/sound-check.ts`. Oracle: Three generated reference soundtracks, a deliberately dull soundtrack, stable shared-file format, refusal of malformed files and no local media paths exported. Unique protection / remaining owner: A profile-statistics unit cannot detect MCP selection, report projection, file import/export or permission wiring. Real analysis is retained for the mismatch workflow.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| build, list, get, set, sound_check rows (as the report), export → import, refusals | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-rebalance.test.ts`

Independent source: Spec 12 Phase 4 solver and proposal/apply policy. Owner inspected: `apps/mcp/src/tools/sound-design.ts`. Oracle: Generated music/dialogue with two effects; propose leaves document unchanged, explicit apply marks solved gains, repeated apply is a no-op and manual-gain handoff obeys mode. Unique protection / remaining owner: The public MCP default and autoGain handoff could regress despite a correct solver/model. Real engine measurements are needed to ensure orchestration uses actual mix inputs.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| proposes by default, applies as one undo step, is idempotent; strict arguments | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-semantic.test.ts`

Independent source: Spec 12 P6-E14 describe-it search; Architecture D-53. Owner inspected: `apps/mcp/src/tools/sound-semantic.ts`. Oracle: Independent generated high/low tones and high-frequency event at 17 s; keyword fallback before installation, real tiny-model pipeline, known event range and padded placement at frame 30. Unique protection / remaining owner: Model correctness is owned elsewhere; this integration uniquely protects installation/fallback/search/moment-placement orchestration and does not claim real CLAP semantic quality.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| falls back to keywords without the model, installs it, ranks by sound, finds and places a moment | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-sheet.test.ts`

Independent source: Spec 12 §2.10 view_sounds peak-line requirement; AGENTS §0 hostile input/allocation rules. Owner inspected: `apps/mcp/src/sound-sheet.ts`. Oracle: Peak times 0/0.25/1 obey a linear time axis on the actual raster; malformed descriptor/base64/count inputs stay bounded and do not crash drawing. Unique protection / remaining owner: Direct renderer output is the lowest seam for marker positioning and hostile-data robustness. MCP image-presence checks do not establish either; PNG codec correctness is owned by animation/png-limits.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| folds text to drawable ASCII and measures it | DELETE | Fails independent contract/refactor resistance: private glyph metrics, fixed grid/header sizes or incidental decay-column appearance; peak-axis contract and hostile-data fuzz survive. |
| draws ink inside the canvas only | DELETE | Fails independent contract/refactor resistance: private glyph metrics, fixed grid/header sizes or incidental decay-column appearance; peak-axis contract and hostile-data fuzz survive. |
| a cell: size, header, and the red peak line at peakSec | REWRITE | Keep peak/time-axis relationship using semantic line detection and raster endpoints; remove absolute header/gutter/size and PNG round-trip assertions. Surviving name: `the peak line follows sound time on the contact sheet`. |
| a cell without visual data says so; a sound that does not decay has no decay line | DELETE | Fails independent contract/refactor resistance: private glyph metrics, fixed grid/header sizes or incidental decay-column appearance; peak-axis contract and hostile-data fuzz survive. |
| the detail picture and a grid of cells | DELETE | Fails independent contract/refactor resistance: private glyph metrics, fixed grid/header sizes or incidental decay-column appearance; peak-axis contract and hostile-data fuzz survive. |
| hostile visual data never throws and stays bounded | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-takes.test.ts`

Independent source: Spec 12 P6-E9 takes and material search. Owner inspected: `apps/mcp/src/tools/sound.ts`. Oracle: A generated recording with eight known takes, wood-only query, explicit ~t3/~t4 range identities and inherited CC0 licence. Unique protection / remaining owner: The cases exercise distinct public search/get/view/import transformations for take ids. Generic recording tests do not catch losing slice metadata or replacing the recording licence.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| search_sounds: a recording row says how many takes it has; takes: true returns them as rows | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| search_sounds material filters by the words; the facet counts it | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| get_sound lists the takes of a recording; a take id gives the take alone | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| view_sounds draws takes next to their recording | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| import_sounds imports a take as a copy of its range with the recording’s licence | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound-timeline-motion.test.ts`

Independent source: Spec 12 P6-E6/P6-E7 and WP6.5b item 11 measured-motion lane. Owner inspected: `apps/mcp/src/sound-timeline.ts`. Oracle: Authored movement on frames 30–60, partly analysed windows and absent/hostile analysis; actual rendered trace plus status metadata. Unique protection / remaining owner: These cases protect rendering of supplied analysis rather than the engine’s movement detector. The extra encode/decode round trip duplicated PNG owners and was removed.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| is drawn where the range was analysed: a pink curve peaking where the picture moves | OPTIMIZE | Inspect raster output directly; PNG codec has frozen independent vector tests. |
| only over the analysed frames (null elsewhere): partly analysed | OPTIMIZE | Inspect raster output directly; PNG codec has frozen independent vector tests. |
| not analysed (null or absent): no pink, the keyframed curve still drawn, no failure | OPTIMIZE | Inspect raster output directly; PNG codec has frozen independent vector tests. |
| hostile pixelMotion never throws | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/sound.test.ts`

Independent source: Spec 12 §2.10 P1-R6/P1-R8 and §2.11 credits; Architecture D-50. Owner inspected: `apps/mcp/src/tools/sound.ts`. Oracle: Known subset of real starter recordings, authored generated 50-ms hit, explicit licence/credit values, exact timeline peak alignment, document revisions and actual approval decisions. Unique protection / remaining owner: Each row exercises its named public route: indexing/status/search/pictures/import/insert/credits/peak detection/export/folder approval. Engine library and model units cannot prove MCP forwarding, defaults or transport provenance.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| rescan_sound_library indexes the kit and the synth fallback (wait, progress) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| sound_library_status reports sources, counts and folders | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| search_sounds: rows with descriptors, title words before synonyms, synth last, strict arguments | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| search_sounds contactSheet returns one PNG with numbered cells | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| get_sound gives every descriptor and a larger picture | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| view_sounds draws the given sounds in order | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| import_sounds adds sounds to the "Sound Effects" bin in one undo step and reuses them | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| insert_sound puts the peak exactly on the frame, in one undo step, never overwriting | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| list_sound_credits lists the used sounds in md, txt and csv | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| detect_sound_peak gives project audio its peak (the editor's Detect Peak), one undo step | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| export_sound_credits writes the credits file (never overwriting) like File ▸ Export ▸ Sound Credits… | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| sound folders need the user: refused without a window, denied, approved; CC-BY credits | OPTIMIZE | Reuse existing authenticated editor-window fixture and wait for protocol welcome. |

## `apps/mcp/test/speech.test.ts`

Independent source: docs/wp-notes/speech.md transcribe/translate/media/mix timeline contracts. Owner inspected: `apps/mcp/src/tools/speech.ts`. Oracle: Known engine word times mapped into actual transcript documents and clip coverage. Non-test callers / other coverage: Public speech tools; engine owns speech model installation; project owns transcript model.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| transcribes a media, commits one step, and reads it back | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a sequence in media mode transcribes only untranscribed clip media; wait: false then jobIds commits | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a sequence mix gives the words to the clip media (media time, coverage) and drops words outside the clips | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| refuses bad targets and an uninstalled model with a hint | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/structure.test.ts`

Independent source: docs/wp-notes/edit-structure.md nesting and unnesting public sequence behavior. Owner inspected: `apps/mcp/src/tools/structure.ts`. Oracle: Real nested sequence and placed/unnested document state. Non-test callers / other coverage: Public structure tools; project owns adjustment/groups/synthetic command semantics.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| nests, lists, places and unnests | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/templates.test.ts`

Independent source: docs/wp-notes/wp-m2-anime-templates.md S11:ANA-003/005 and ATP-006. Owner inspected: `apps/mcp/src/tools/templates.ts and src/tools/render.ts`. Oracle: Public keyframable types, real parameter changes, exact error codes and actionable environment key. Non-test callers / other coverage: Public template/render tools; distinct synchronous errors, failed jobs and export-plan blockers.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| reports renderer, native and a compact params summary with keyframable flags | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| rejects invalid parameter values and names with E_INVALID_PARAM | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| keeps RENDERER_UNAVAILABLE for fframes templates | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| sets static params and preserves template defaults | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| keyframes numeric and colour params of anime templates (setAnimated + set at the frame) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| validates the clip, the param names, values, times and the renderer | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| render_frame: TEMPLATE_NOT_INSTALLED and a missing browser | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| start_export preserves plan errors and explains unavailable rendering | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| wait_for_job: a failed export explains Remotion; cancelled jobs get no hint | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/test-ports.test.ts`

Independent source: No production contract; test infrastructure policy only. Owner inspected: `apps/mcp/src/test/helpers.ts testPort`. Oracle: A source regex over a narrow spelling. Unique protection / remaining owner: Existing testPort allocates a real port for each engine. Source spelling cannot prove isolation and breaks on refactoring.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| no test file defaults to a fixed engine port | DELETE | Fails independent oracle, stable seam and refactor resistance: source identifier/prose spelling checks do not observe a functional result. Behavioral sound/proposal workflows remain. |

## `apps/mcp/test/text-animators.test.ts`

Independent source: docs/wp-notes/text-animators.md public selectors and path options. Owner inspected: `apps/mcp/src/tools/text-animators.ts`. Oracle: Explicit animator values/keyframes/ranges and created guide path. Non-test callers / other coverage: Public animator tools; project owns preset contents and path-clear commands.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| add_text_animator with values, keys and a range; add_text_selector; get; remove | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| set_text_path creates a guide mask and Path Options | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/three-d.test.ts`

Independent source: docs/wp-notes/three-d.md public camera/light/layer scene data. Owner inspected: `apps/mcp/src/tools/three-d.ts`. Oracle: Explicit 50mm camera, depth-of-field, spot light and persisted 3D layers. Non-test callers / other coverage: Public 3D tools; project owns command refusals and schema validation.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| builds a 3D scene and reads it back | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/time.test.ts`

Independent source: docs/wp-notes/time.md speed remapping and scene-edit application. Owner inspected: `apps/mcp/src/tools/time.ts`. Oracle: Half-speed duration and explicitly supplied scene cuts converted to linked real edits. Non-test callers / other coverage: Public time tools; project owns pure remap command algebra, engine owns scene detection.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| remaps a clip: half speed, ramp, freeze, reverse, then removes it | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| Scene Edit Detection runs the engine job and applies cuts, markers and scene items in one step | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/tracking.test.ts`

Independent source: Public corner-pin pixel coordinates and tracker application; AGENTS §4 fidelity. Owner inspected: `apps/mcp/src/tools/tracking.ts`. Oracle: Explicit requested pixels and independently generated tracking truth within 3px. Non-test callers / other coverage: Actual tracking render workflow retains artifact; project tests cannot prove tracker-to-render integration.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| set_corner_pin stores the requested sequence-pixel corners on the clip | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| add_tracker + track + apply_tracking + render_frame pins the overlay within 3 px of the ground truth | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/transitions.test.ts`

Independent source: S10:TUI-034 default preferences; published transition label/parameter contract. Owner inspected: `apps/mcp/src/tools/transitions.ts`. Oracle: Authored editor preference overrides/fallbacks and canonical GPU transition data. Non-test callers / other coverage: Public transition tools; project owns interpolation rendering, MCP owns preferences/label resolution.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| uses the open editor’s default types and alignment | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| lets call arguments override the editor value by value | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| falls back to the built-ins for invalid editor values | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| adds a GPU transition by label with params and updates its params | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/ui-state.test.ts`

Independent source: docs/test-cleanup/mcp-ui-window.md; published ui_state window metadata. Owner inspected: `apps/mcp/src/tools/ui.ts`. Oracle: Authored width/height/devicePixelRatio and conflicting untrusted window identity versus relay identity. Unique protection / remaining owner: A relay test cannot detect MCP dropping measurements or allowing result data to override authoritative routing identity.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| ui_state preserves window measurements alongside the relay identity | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/unit.test.ts`

Independent source: docs/ARCHITECTURE.md §11 engine discovery; AGENTS §0 network/data-loss rules; package CLI version. Owner inspected: `apps/mcp/src/discovery.ts, src/link.ts, src/errors.ts and src/export-presets.ts`. Oracle: Explicit config precedence, network classes, bounded timeout, no write replay, public error and preset values. Non-test callers / other coverage: EngineLink/config/error conversion used by every tool; actual integration owns happy path, these isolate failure classes.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| reports a non-Error health rejection: %s | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| prefers explicit URL/token (flags over env) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| reads <appdir>/engine/runtime.json (token included) and skips stale or dead entries | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| falls back to the default dev port | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| discovery rejects non-engine answers | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| EngineLink reports an actionable error when nothing runs | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| re-discovers after a refused read and returns the project list | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a request that never answers ends with ENGINE_TIMEOUT instead of hanging | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a write cut off mid-flight is reported, not retried (it may have been applied) | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| a write that never reached the engine, and any read, stay retryable NETWORK errors | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| maps tool, engine and transaction errors to isError results with hints | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| caller quality overrides take precedence over export preset defaults | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| the --version CLI reports the package version | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/vector-shapes.test.ts`

Independent source: Published vector shape/SVG tools; serialized shape path and dry-run contracts. Owner inspected: `apps/mcp/src/tools/shapes.ts`. Oracle: Authored taper/transform/path values and unchanged document on SVG dry-run. Non-test callers / other coverage: Public vector tools; project SVG parser does not own MCP dry-run/document conversion.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| add, get, update (nested taper / transform), path edits, remove | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| svg_to_shape: dry run reports warnings, apply adds a clip; convert_shape_to_vector | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## `apps/mcp/test/versions.test.ts`

Independent source: docs/project-files.md restore-copy/lease/journal safety; public version tools. Owner inspected: `apps/mcp/src/tools/versions.ts`. Oracle: Explicit safe restore mode, version sizes/kinds and read-only recoverable journal summary. Non-test callers / other coverage: Public version tools; storage owner handles files, MCP owns safe default and compact response mapping.

| Baseline test declaration | Disposition | Particular contract / deletion reason |
| --- | --- | --- |
| lists versions with their kind and restores as a copy or in place | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |
| reports recoverable unsaved changes without acting on them | KEEP | Retain the exact input/output, refusal, persistence or artifact behavior named here; the independent source/oracle and unique seam above apply to this row. |

## Validation and timing

Root holds the comparable full-suite baseline and final measurements. No isolated timing is extrapolated into an overall or CI speedup.

Static validation completed before runtime workers were released:

- `pnpm exec biome check` passed for the initial 17 changed TypeScript source/support files after formatting/import fixes limited to those files; the final response-helper follow-up passed its own Biome check.
- `git diff --check` passed.
- Independent static cross-review by the browser-sound workstream found no lost unique contract in the peak-line or color/grading changes. The peak test observes a specified linear time-axis law without importing plot constants. Revision deltas prove one persisted transaction; the engine agent test independently owns event/label publication.

The initial baseline lock and subsequent resource queue delayed runtime validation; these are now the local results on Node 20.19.0, pnpm 10.34.5, two Vitest workers, `JASPER_REQUIRE_ORACLES=1`, and `JASPER_BROWSER_EXECUTABLE=/usr/bin/google-chrome`:

```sh
pnpm exec vitest run apps/mcp/test/auto-tag.test.ts apps/mcp/test/color.test.ts apps/mcp/test/conventions.test.ts apps/mcp/test/ease-trim.test.ts apps/mcp/test/grading.test.ts apps/mcp/test/music-picture.test.ts apps/mcp/test/proposals.test.ts apps/mcp/test/sound-beds.test.ts apps/mcp/test/sound-grammar.test.ts apps/mcp/test/sound-import-upgrade.test.ts apps/mcp/test/sound-levels.test.ts apps/mcp/test/sound-packs.test.ts apps/mcp/test/sound-sheet.test.ts apps/mcp/test/sound-timeline-motion.test.ts apps/mcp/test/sound.test.ts apps/mcp/test/animation.test.ts apps/mcp/test/png-limits.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/jasper-test-cleanup/mcp/changed.json
```

All 85 tests in 17 selected files passed, with zero skipped cases. Vitest reported 121.36 s; `/usr/bin/time -v` measured 122.54 s wall, 327.87 s user CPU, 61.38 s system CPU and 1,705,944 KiB maximum RSS. This run generated worktree-local fixtures and compiled/rendered with Chrome, so it is validation evidence rather than a comparable before/after benchmark. The slowest selected case was the real spatial-grading render (21.951 s). The independent default-level/export case passed in 8.649 s; its formerly unasserted second export is no longer executed. No CI or overall-suite percentage improvement is inferred from these isolated timings.

Three restoring mutations were each rejected by exactly the intended single test, with all temporary production changes restored:

| Mutation | Narrow target (`pnpm exec vitest run <file> -t '<name>' --maxWorkers=2`) | Observed failure |
| --- | --- | --- |
| Draw every peak at time zero | `sound-sheet.test.ts`: `the peak line follows sound time on the contact sheet` | Endpoint positions collapse (`2.5` is not greater than `2.5`). |
| Omit the caller's cleanup tolerance | `ease-trim.test.ts`: `create_path_controller and cleanup_motion_path on position keys` | The path retains three keys instead of the independently expected two endpoints. |
| Send stale progress values | `conventions.test.ts`: `throttles progress to one notification per 100 ms, increasing, latest value wins` | Sent `[0, 19, 39, 99]` disagrees with the latest authored inputs `[1, 20, 40, 100]`. |

`mutations.json` in the same temporary evidence directory records the exact commands, exit codes and failure messages. `git diff --exit-code -- apps/mcp/src` confirmed restoration.

The first `pnpm --filter @jasper/mcp typecheck` failed at unchanged `test/tool-response.ts:4` with TS5115: infinitely circular `IsOptionalIn`, `$ZodTypeInternals`, `$InferZodRecordInput`. The helper has identical blob `db7313f769dc49c9265bb5fe9aef5ee31dea1cb0` at baseline `8b4c8936` and cleanup commit `a6fdb24c`; `/tmp/jasper-test-cleanup/mcp/typecheck-baseline-evidence.json` records the bytes/hash check and original output. The locked Zod 4.6.5 record-input declaration checks optionality of its recursive JSON union. A standalone probe reproduced that diagnostic with the original schema; both a bounded annotation and a direct bounded assertion still recursed. The final fix removes the redundant outer `z.record` wrapper, retains the exact `z.json()` recursive validator, and rejects null/scalar/array roots with an explicit object guard. TypeScript then narrows the result naturally to a JSON object, with no casts or disabled checks. Invalid root values now produce the helper’s descriptive `Error` rather than a Zod-formatted test failure; no production API or accepted response shape changes.

The isolated original/annotation/guard probes used this compiler command, with each individual file name recorded in `type-probes.json` (the direct-assertion diagnostic is preserved separately):

```sh
pnpm exec tsc --noEmit --skipLibCheck --strict --target ES2022 --module ESNext --moduleResolution Bundler /tmp/jasper-test-cleanup/mcp/type-probe/original.ts
```

The original and annotation probes failed with TS5115 as expected; `json-object-guard.ts` compiled successfully. `pnpm --filter @jasper/mcp typecheck` then passed. The two actual consumers were checked after the helper change:

```sh
pnpm exec vitest run apps/mcp/test/export-credits.test.ts apps/mcp/test/sound-check-verdicts.test.ts --maxWorkers=2 --reporter=default --reporter=json --outputFile.json=/tmp/jasper-test-cleanup/mcp/response-helper.json
pnpm exec tsx /tmp/jasper-test-cleanup/mcp/type-probe/runtime.ts
```

Both consumer files passed all 10 cases, with zero skips (13.24 s total; 767 ms test bodies). The temporary runtime probe compared original/new acceptance against eight authored JSON strings: empty/nested objects succeed; null, scalar, string and array roots, an overflowed number and malformed JSON fail. This confirms recursive validation and object-root rejection remain active; no permanent helper self-test was added. The failed baseline gate, unsuccessful type-only approaches and successful final checks remain separate evidence rather than being relabelled as passes.

Unchanged MCP suites and opt-in QA/composition suites were not repeated here. Root's integrated full gate and quiet suite measurement remain authoritative.
