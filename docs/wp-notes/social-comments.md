# Social-comment templates — work notes

Design: [`docs/superpowers/specs/2026-10-25-social-comment-templates-design.md`](../superpowers/specs/2026-10-25-social-comment-templates-design.md).

## Template media params

Design §7.7 (WP1 `sc/media`, contract C1). Anime templates can take pictures (a comment's avatar) as params.

### Model

- **Schema helper.** `mediaParam(opts?: { kinds?: Array<'image' | 'video'> })` in `@jasper/mg-templates`
  (`packages/mg-templates/src/params.ts`) is a strict zod schema for `{ mediaId: string } | null`, default `null`
  (= none). Its JSON schema carries `x-jasper-kind: "media"` and `x-jasper-media-kinds` (default `["image"]`);
  the keys are `TEMPLATE_PARAM_KIND_KEY` / `TEMPLATE_MEDIA_KIND` / `TEMPLATE_MEDIA_KINDS_KEY` of `@jasper/project`.
  A media param may sit anywhere inside `params` (e.g. a list of pictures). `createMgRegistry` refuses media params
  on fframes templates: the native renderer has no image input.
- **Reference helpers** (`packages/project/src/param-media.ts`): `collectParamMediaIds(value)` (every `{mediaId}`
  object, first-seen order, `''` skipped), `clipParamMediaIds(clip)` (motion-graphic clips only),
  `templateMediaRefs(value)` (with dotted paths) and `rewriteParamMedia(value, map)` (remap / clear / keep, untouched
  branches keep their identity). Every walk is cycle-safe and bounded (depth ≤ 32, ≤ 100 000 values).
- **Validation.** `validateMgParams` (`clip.addMotionGraphic`, `clip.update {params}`) and `param.set` on
  `params.<name>` go through `assertTemplateMedia` (`commands/handlers/mg-template.ts`): a medium that is not in the
  project is refused with `E_NOT_FOUND`, one of a kind the param does not take with `E_INVALID_PARAM`
  (`templateMediaKindsAt` reads the kinds from the schema, nested paths included). `null` is "none".
- **Schema v8.** `v7→v8` is a version bump only: v7 builds count a clip's own `mediaId` alone, so their orphan
  collection, item delete, Project Manager and paste would drop media referenced only from template params; they
  open v8 files read-only ([project files](../project-files.md)). Fixture `packages/project/test/fixtures/schema-v8.jasper`.

### Reference integrity

Media a template param references are counted wherever a clip's own `mediaId` is:

| Path | Behaviour |
|---|---|
| `collectOrphans` / `clipRefs`, `tx-delta` `orphanRefs` | a medium only a template param uses is kept |
| `item.delete` | in use like a clip's source: `E_IN_USE` naming the clip; with `force` the param is set to `null` (the clip stays; result `clearedParams: [{clipId, params, mediaIds}]`). The Project panel's confirmation says so |
| `media.removeUnused` | already deep-walked every clip (verified by test) |
| `mediaUsage` (Project panel usage, "unused" filter, MCP `list_media`), agent media list | the clip counts once per medium |
| Project Manager `usedMedia` (Exclude Unused, collect, consolidate; the engine copies `plan.files`) | used whole (pictures are never trimmed) |
| INV-006 / INV-014 (full and incremental checks) | a missing medium is reported at `…clips.<id>.params.<path>`; a referenced one is a use, not a leak |
| `repairDocument` | a dangling reference becomes `null` (report `clear-template-media`); no project item is invented for a medium only a template uses |
| Clipboard (`clip.paste`, `project.pasteItems`, `.jgt` graphic templates, timeline import) | the payload carries the medium; a paste into another project remaps the param |
| `.jasper` interchange metadata (OTIO) | the medium travels in the JasperEditor entities; an import that lacks it clears the param with a warning |
| Relink (`media.relink`, Project Manager) | keeps the media id, so references stay valid; the bake key and the graded-preview identity follow the new content |

### Render

- **Snapshot.** `buildRenderSnapshot` resolves template media like effect media (`useMedia`): the handle (engine URL,
  signed in renders) is in `snapshot.media[mediaId]`.
- **Layer.** `MotionGraphicLayer` builds `AnimeTemplateProps.mediaUrls` (`Readonly<Record<mediaId, url>>`) from the
  document's media handles (`ColorDocContext`, as effect media): `mediaSrc` picks the proxy / display picture when
  the original is not browser-decodable; offline or missing media are absent; `{}` when the params reference none.
- **Drawing.** `TemplateImage` (`@jasper/motion/templates`, `packages/motion/src/templates/image.tsx`) is an `<img>`
  (`crossOrigin="anonymous"`) that holds the render with `delayRender` from its first frame until the picture is
  loaded and decoded (`img.decode()`), like `useFxImages`. A load error releases the render and draws
  `TemplateImagePlaceholder` (a neutral dashed box) or the template's `fallback`; it never cancels the render.
- **Exports.** Remotion exports sign every snapshot handle (`remotionProps`); layer bakes sign the media
  `referencedMediaIds` finds in the clip source (template params included) and key the bake on each medium's
  fingerprint, size and mtime (`keyMedia`), so a relinked avatar re-bakes. The planner warns
  `OFFLINE_TEMPLATE_MEDIA` when a template shows offline media (those pictures render as placeholders).

### UI and agents

- Properties and Effect Controls show `MediaParamPicker` for media params: None (writes `null`), the project's
  media of the accepted kinds, "Missing media" for an unknown id, and a drop target for Project panel items (an item
  of another kind is refused with a hint). Edits are `param.set` commands (one undo step each). Media params are not
  keyframable.
- MCP `list_motion_templates` lists a media param as `media image` (or `media image|video`); the templates guide says
  what it takes and how it is refused.

### Tests

`packages/project/test/template-media.test.ts` (regressions: each integrity path failed before the fix; validation;
snapshot; v8 fixture; fast-check property of the walk), `packages/session/test/template-media-history.test.ts`
(undo / redo), `packages/interchange/test/template-media.test.ts`, `packages/mg-templates/test/media-param.test.ts`,
`packages/motion/test/template-image.test.tsx`, `packages/motion/test/template-image.e2e.test.ts` (`REMOTION_E2E=1`:
a real Chrome still waits for a slow CORS picture; a 404 draws the placeholder),
`packages/compositions/test/template-media-layer.test.tsx` (test-only `avatar-test@1`: params → snapshot →
`mediaUrls` → `TemplateImage` through the sequence composition), `apps/engine/test/template-media-bake.test.ts`
(signed URL, bake key follows the content, offline warning), `apps/web/test/template-media.test.tsx` (picker, None,
drop, delete dialog), `apps/web/test/layer-bake-runtime.test.ts`, `apps/mcp/test/template-media.test.ts`.
The test-only template lives in `packages/mg-templates/test/fixtures/avatar-test-template.ts` and
`packages/motion/test/fixtures/avatar-test-impl.tsx` (not in the catalogue).

### Limitations

- `TemplateImage` draws still pictures. A `kinds: ['video']` param resolves to the medium's URL, but no
  seek-driven template video component exists yet, so templates should declare images (the default).
- Animated images (GIF / animated WebP) are not offered: an `<img>` animates on the wall clock, which renders could
  not reproduce.
- `media.derive {replaceInClips}` (processed versions) rewrites clips' own media only; template params keep the
  original medium.
- Pre-existing, outside this scope: media that only effect params use (e.g. the image of a displacement map) are
  still not counted by Project Manager "Exclude Unused", `item.delete` or `collectOrphans`.
