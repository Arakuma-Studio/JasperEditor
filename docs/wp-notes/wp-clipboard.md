# wp-clipboard — copy, cut, paste, paste attributes (S01 §20)

Branch `wp/clipboard`. Spec: `docs/specs/01-project-model-and-state.md` §20 (CLB-001…012), S03 XF-050, FX-011/012,
EC-023/024/032, the KF table ("duplicate, copy/paste, paste attributes"), NFR-012; S01 ID-005, SES-007, SEL-006/008,
CMD-001, TRK-006, LIFE-030. Implementation decisions are recorded at the end of S01 §20.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| CLB-001 | `packages/project/src/clipboard/{payload,build}.ts` | `ClipboardPayloadSchema` (zod, `format: 'jasper-clipboard'`, `version: 1`, kinds `clips` / `effects` / `keyframes` / `project-items`). Builders read the committed document: `buildClipsPayload` (linked partners, transitions whose clips are all copied incl. fades, `originFrame`, `trackOffsets` per source track, `trackKinds`, `frameRate`, `primaryClipId`), `buildEffectsPayload` (chosen instances, optional intrinsics, source timing), `buildKeyframesPayload` (per property / effect param address, value kind, origin, source speed), `buildItemsPayload` (bins with descendants, sequences + nested sequences and their items). `packReferences` ships media closed over derivation sources and font files (sources first), synthetics, transcripts, fonts, and `mediaItems` (item names). |
| CLB-002 | `packages/project/src/clipboard/payload.ts` (`encodeClipboardHtml` / `decodeClipboardHtml` / `clipboardText`), `apps/web/src/clipboard/{system,events}.ts`, `apps/web/src/shell/keymap/dispatcher.ts` (`awaitNativePaste`), `apps/desktop/src/{preload.cts,main.ts,security.ts}` | `text/html` = base64 JSON in `<span data-jasper-clipboard="…">` + `<pre>` text (attributes survive sanitizers; our own UTF-8/base64 codec, the model is DOM/Node-free); `text/plain` = text of text/caption clips, else names. Writes: the copy/cut event when there is one, else a synchronous `execCommand('copy')` with a one-shot copy listener (works in any user gesture, no permission), else the async API. Desktop: `jasperDesktop.clipboard.write/read` → main writes `text/plain` + `text/html` + `electron application/osclipboard;format="application/x-jasper-clipboard"` atomically (`clipboard.write([new ClipboardItem…])`), validated (`fromApp`, JasperEditor JSON, 20 MB). In-memory copy always (`clipboardMemory`). Reads: Ctrl/Cmd+V commands carry `nativeClipboard: 'paste'` — the dispatcher leaves the chord to the browser and runs the command from the paste event it fires (120 ms fallback without data); menu pastes read Electron, then `navigator.clipboard.read()`, then memory. `pasteSourceOf`: JasperEditor content on the system clipboard wins; foreign content wins over memory unless our last copy never reached the system clipboard. Browser/app-menu copy/cut/paste events outside text fields run the Edit commands (`installClipboardEvents`). |
| CLB-003/004 | `packages/project/src/commands/handlers/clipboard.ts` (`clip.paste`), `apps/web/src/clipboard/actions.ts` | Earliest clip at `at`, lowest copied track of each kind on `tracks.{video,audio,caption}` (UI: lowest targeted unlocked track, else V1/A1), offsets kept, missing tracks added, locked/kind checks. Overwrite clears each pasted clip's range; insert insert-shifts the destination + sync-locked tracks by the pasted span (markers ripple). Frame-rate conversion of starts/ends, transitions and text animator windows. The UI selects the copies (`selectAfter`, also the History "after" selection) and moves the playhead to `result.end`. |
| CLB-005 | `clip.pasteAttributes`, `clip.removeAttributes`; `apps/web/src/clipboard/{attributes.ts,AttributesDialog.tsx}` | Motion, Opacity (+ blend mode), Volume, Panner, each copied effect (by payload instance id; only onto clips of its medium), M2 rows In/Out animation, text style (through `clip.update` so layout re-runs), shape style (fill/stroke/corner radius, shapes re-centred via `SHAPE_BOX_COMMANDS`); "Scale Attribute Times" stretches key offsets to the target duration. Keys keep their offset from the clip's first frame in sequence time (speed-aware) and get new ids. Remove Attributes resets intrinsics (registry defaults), removes effects by registry id, clears animators. Dialog: rows grouped Video/Audio/Effects/Text/Shape, unavailable rows disabled with a reason. |
| CLB-006 | `effect.paste`, `keyframe.paste`; Effect Controls copy in `actions.ts` | EC Copy: selected keyframes, else the selected effect header, else every applied effect. Effects append to every selected clip (EC-032; copied intrinsics replace Motion/Opacity/Volume/Panner). Keys land at the playhead keeping spacing (through sequence time when speeds differ), on the same property / effect (by id + occurrence) / template param, else on the focused property row when the value kinds match; a key at the same time is replaced. |
| CLB-007 | `project.pasteItems`; Project panel menu Cut/Copy/Paste | Into the selected bin (else the panel's bin); bins recreated with their children; sequences deep-copied (tracks, clips, transitions, links, groups, markers, effects, keyframes, trackers get new ids; nest clips point at the pasted copies). |
| CLB-008 | `Resolver` in `handlers/clipboard.ts` | Lazy: only entities the pasted content uses. Media: same fingerprint → reused; else added under a new id (derivation remapped) with a project item (except pure derivation sources / font files); locators are resolved by the runtime's normal new-media path (`apps/web/src/import/media-runtime.ts`, LIFE-030). Synthetics/transcripts/fonts: same project + id → reused; else copied (a font with the same family + source is reused). Link/group membership recreated inside the pasted set only. Trackers: a target follows the pasted copy of its plate (`trackedBy` clip, tracker and corner-pin ids remapped), else the original plate in the same sequence, else the link is dropped. |
| CLB-009 | `parseClipboardPayload` | JSON string or object, 20 MB UTF-8 cap (`E_LIMIT`), foreign data / other versions ("newer JasperEditor (format version N)") / schema issues (`E_SCHEMA` with the path). Every paste command re-validates; `payload` is skipped by temp-ref / `$selection` substitution, semantic addressing and the AGT-010 touched-id walk. |
| CLB-011 | `cutSelection` | Timeline: copy + `clip.lift` (gap). EC: copy + remove keys / the selected effect. Project: copy + Clear of the selected items. |
| XF-050 | `apps/web/src/panels/program/{layer-menu.ts,TransformOverlay.tsx,ProgramMonitor.tsx}` | Right-click selects the topmost unlocked layer under the pointer; menu Cut, Copy, Paste, Paste Attributes…, Duplicate, Delete, Enable, Scale/Set to Frame Size (same commands and enabled state as the Edit menu); Paste on empty frame. |
| FX-011/012 | as CLB-005 | Edit ▸ Paste Attributes… / Remove Attributes…, timeline clip menu, Program menu. |
| EC-023/024 | as CLB-006; EC key menu gains Copy | Ctrl/Cmd+C/V in Effect Controls. |
| SEL-006/008 | `packages/session/src/session.ts` (`SessionTxInput.selectAfter`) | Pasted clips / items selected and recorded as the History entry's after-selection. |
| MCP | `apps/mcp/src/tools/clipboard.ts`, `examples.ts` | `copy_clips`, `paste_clips`, `copy_items`, `paste_items`; `CLIPBOARD_GUIDE`; describe_commands examples for the six commands (dry-run in `apps/mcp/test/clipboard.test.ts` and the integration suite). |

## Contract changes (additive)

- Commands `clip.paste`, `clip.pasteAttributes`, `clip.removeAttributes`, `effect.paste`, `keyframe.paste`, `project.pasteItems` (owner `wp-clipboard`, milestone M2; `schemas/clipboard.ts`, `catalog.ts`); `WARNING_CODES += W_CLIP_SKIPPED`; `buildParams` exported from `handlers/effect.ts`; `SHAPE_BOX_COMMANDS` += the attribute/keyframe pastes.
- `substituteRefs` (`DECL_KEYS += payload`), `referencedIds` and `resolveAgentAddresses` never look inside `payload`.
- `@jasper/project` exports `clipboard/*`; `@jasper/session` `SessionTxInput.selectAfter`.
- Web: `UiCommand.nativeClipboard`; `awaitNativePaste` / `NATIVE_PASTE_WAIT_MS` in the dispatcher; `TransformOverlayProps.onContextMenu`; timeline `ContextMenu` `testId`; `JasperDesktopBridge.clipboard`.
- Desktop: IPC `jasper:clipboard-write` / `jasper:clipboard-read` (invoke), helpers in `security.ts`.

## Defects fixed

- `timeline.duplicate` selected the copies after its transaction, so Redo restored the selection from before the
  duplicate (SEL-008); it now uses `selectAfter` (`apps/web/test/clipboard.test.tsx`).

## How to test

- Unit: `pnpm vitest run packages/project/test/clipboard.test.ts apps/web/test/clipboard.test.tsx apps/mcp/test/clipboard.test.ts apps/desktop/test/security.test.ts packages/session/test/session.test.ts`.
- Playwright: `E2E_PORT=<port> pnpm e2e e2e/clipboard.spec.ts` (keyboard copy/paste of an animated text, keyframed shape and anime template; undo/redo; Paste Insert; Paste Attributes dialog; Program monitor menu; Effect Controls keys; Project panel sequence; cross-project paste in a second tab through the system clipboard).

## Known gaps

- CLB-010 (external text, images, files) is not implemented: foreign clipboard content is reported, not pasted.
- The Electron custom format (`electron application/osclipboard;format=…`) is typechecked and unit-tested at the
  validation level only; no packaged desktop run was possible here (no Electron binary installed).
- XF-050's Anchor ▸, Arrange ▸, Reveal in Timeline/Project, Agent ▸, Reset Motion/Crop entries are not in the
  Program menu yet; EC-004's effect-header menu (Copy, …) does not exist yet (headers copy with Ctrl/Cmd+C).
- Paste Grade (S06) keeps its own in-memory grade clipboard (replace semantics); general Paste Attributes appends
  colour effects like any other effect.
- Nested-sequence clips paste only where their sequence exists (nesting itself is M2-pending).
