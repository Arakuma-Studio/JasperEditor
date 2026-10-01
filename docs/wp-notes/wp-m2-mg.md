# wp-m2-mg — motion graphics clips from Remotion projects (S08)

Branch `wp/m2-mg`. Spec: `docs/specs/08-motion-graphics-clips.md`. Contracts: ARCHITECTURE §19, D-19 (page
protocol), M1 `/mg/:key/:file` store. Remotion pinned at 4.0.499.

## What was built (by requirement)

| Req | Where | Notes |
|---|---|---|
| MGC-001/002 | `packages/project/src/schema/media.ts`, `apps/engine/src/mg-bundles/{service,schemas}.ts` | `mg-bundle` assets keep `mgBundle {remotionVersion, compositions[]}`. `MgCompositionInfo` gains optional `ui`, `category`, `thumbnailFrame` (from `jasper.mg.json`). |
| MGC-002 schema sources | `apps/engine/src/mg-bundles/schemas.ts`, `packages/project/src/composition/json-schema.ts` | Priority: `jasper.mg.json` (`compositions.<id>` or the `"*"` entry, which applies to every composition and is merged with the props inferred from `defaultProps`) → schema module (`package.json` `"jasper": {"schemas": "./src/jasper-schemas.ts"}`, bundled with esbuild, zod kept external and resolved from the project; zod 4 `toJSONSchema`, zod 3 `zod-to-json-schema`, run in a child process) → inference from `defaultProps` (`inferPropsSchema`). Schemas are validated (`validateJsonSchema`), `$ref`s resolved. |
| MGC-003/004/005/006 | `packages/project/src/composition/props.ts`, `kinds.ts`, `clip-core.ts`, `clip-edit.ts`, `transitions.ts`, `invariants.ts` | Bounded content (`contentDurationFlicks`) used by trims, ripple, transitions and invariants. Frame mapping `compositionFrameAt`, sequence-fps override (`compositionSequenceFrames`), `MG_FPS_MISMATCH` warning when the composition fps differs. Props hold-only (no stopwatch). |
| MGC-007 | `packages/project/src/commands/handlers/composition.ts` | `clip.addComposition` (duration optional = whole composition), `param.set props.*` / `clip.update {props}` validate against the schema (`validateCompositionProps`, `E_VALIDATION` with paths). Overrides only (`mergeProps`, `setPropOverride`, `unsetPropOverride`). Undo/redo through the normal command path. |
| MGC-008 | `packages/project/src/render/snapshot.ts` | `RenderCompositionSource {compositionId, props (effective), bundle {key, hash, remotionVersion}, info, prerender}`; `SnapshotOptions.resolveComposition`. |
| MGC-010 | `apps/engine/src/routes/mg-bundles.ts`, `service.ts` (`importPath`, `importUpload`) | Directory (project with `remotion` pinned 4.0.499 → bundled with the project's own CLI `remotion bundle`, `MG_REMOTION_VERSION` otherwise), built bundle directory, or zip upload (`UploadCreateRequest.purpose: 'mg-bundle'`). Content-addressed `<appdir>/mg-bundles/<sha256>/`; idempotent (`mediaKey` from the content hash). Job `mg-bundle` with progress. |
| MGC-011 | `service.ts` (`readCompositions`) | `getCompositions` on the served bundle with the LGPL FFmpeg directory and the configured browser. |
| MGC-012 | `routes/mg-bundles.ts` | `GET /mg/bundles/:key/*` (immutable, Range, same auth); `?jasper-host=1` on `index.html` injects the host bootstrap (`injectHostBootstrap`). |
| MGC-013 | `service.ts` (`watch`, `restoreWatches`, `rebuild`) | `watch: true` on project directories: debounced rebuild on `src/`/`public/`/config changes, new hash → `media.relink` (fingerprint change allowed for `mg-bundle`) and the `mgBundle.rebuilt` event; the web runtime relinks open projects as a system edit. Watches persist in `<appdir>/mg-bundles/watches.json`. Manual: `POST /api/mg-bundles/:key/rebuild`. |
| MGC-014 (P1) | `CompositionLayer.tsx` (`CompositionCard`), `native-ext.ts` (`blockers`) | "Composition <id> not in bundle" / "Composition bundle missing" card; export blocker. |
| MGC-015 (P1) | `apps/engine/src/mg-bundles/scaffold.ts`, `template/files.ts`, route `POST /api/mg-bundles/scaffold`, MCP `scaffold_mg_project` | Writes a Remotion 4.0.499 project with one example composition, `jasper.mg.json`, schema module. Unit-tested without the install step (see gaps). |
| MGC-020 | `packages/compositions/src/layers/CompositionLayer.tsx` | Order: master (renders) → live host (edit/paused) → preview WebM (idle, unchanged props) → idle card. Status chips (spinner, "Grade pending", error). A warm hidden host stays configured under the preview WebM so an edit switches back without a reload. |
| MGC-021 | `packages/compositions/src/mg-host/protocol.ts` | Same-origin iframe on the bundle page; `MgFrameHostDriver` uses the renderer-page protocol: `remotion_puppeteerTimeout` marker, `NODE_ENV=production` (`isRendering`), `remotion_setBundleMode({type:'evaluation'})` → `remotion_calculateComposition` → `setBundleMode({type:'composition', …})` → `remotion_setFrame` / `remotion_renderReady`, `remotion_getCompositionNames` polling. `checkHostProtocol` fails loudly on a version or protocol change (Playwright contract test). `color-scheme: light` on iframe and page (a mismatch paints an opaque backdrop). |
| MGC-022 | `CompositionLayer.tsx`, `apps/web/src/mg-bundles/runtime.ts` | Paused: exact playhead frame; playing: preview WebM when ready, live host otherwise. |
| MGC-023 | `runtime.ts` (`schedulePreview`) | 2 s after the last props change (0 s with colour effects) → `POST /api/mg-bundles/prerender {preview}`; VP9 `yuva420p` half size. |
| MGC-024 (P1) | `runtime.ts` (`MAX_LIVE_HOSTS = 4`), `CompositionLayer.tsx` | Budget of 4 live hosts; beyond it a hatched placeholder. The budget is first-come (mounted clips), not strictly "nearest the playhead". |
| MGC-025 | `CompositionLayer.tsx` (`hasPixelEffects`) | Motion/CSS effects apply to the host element; colour (pixel) effects grade the preview WebM ("Grade pending" until it exists). |
| MGC-030/031 | `service.ts` (`prerender`, `runPrerender`, `renderKeyOf`), `apps/web/src/mg-bundles/runtime.ts` (WebCrypto `renderKeyOf`) | `renderMedia` ProRes 4444 `yuva444p10le`, PNG frames, bt709, composition overridden to sequence fps/canvas; lossless remux adds bt709 tags; poster; VP9 alpha preview. `renderKey = sha256(canonicalJson({bundleHash, compositionId, props, width, height, fps, frameRange, recipe}))[:40]` stored in `<appdir>/mg/<renderKey>/` (served by M1 `/mg/:key/:file`, `meta.json` kind `composition`). Any props or bundle (code) change → new key → new master. GC: 14 days unused. |
| MGC-032 | `apps/engine/src/mg-bundles/native-ext.ts`, `apps/engine/src/export/{native-ext,planner}.ts` | `mg` native extension, `kinds: {'composition'}`; `prepare` submits child `mg-prerender` jobs (0 CPU slots, so they never starve behind the parent) for missing masters; overlay `{space:'layer', startFrame}`; `warnings` (new, additive) feed the plan. |
| MGC-033 | `CompositionLayer.tsx` (`MasterLayer`), `native-ext.ts` (`prepareForRemotion`, `adaptRemotionDoc`) | Remotion path plays the signed master URL through `OffthreadVideo transparent`. |
| MGC-034 | `native-ext.ts`, routes (`mgGuarded`) | `mgBundles.status: 'unavailable'` → blockers / 503 with hints. |
| MGU-001 | `apps/web/src/mg-bundles/{ImportDialog,import}.tsx`, `commands/composition.ts`, `shell/menus/model.ts` | File ▸ Import Remotion Project…: path field (desktop folder picker when `jasperDesktop.pickFolder` exists), "watch" toggle, zip upload of a built bundle on the web; progress + actionable errors (`bundleErrorText`). |
| MGU-002 | `apps/web/src/panels/motionTemplates/{RemotionTab,MotionTemplatesPanel,insert}.tsx` | "Templates" / "Remotion" tabs; bundles → compositions (category groups, poster thumbnails from `GET /api/mg-bundles/:key/poster/:compositionId`), double-click / drag / Insert. |
| MGU-003 | `apps/web/src/mg-bundles/CompositionSection.tsx` | Properties "Composition" section: bundle · id, status line, JSON-Schema form (string/number/integer/boolean/enum/colour/array/object, `ui` hints), reset per prop and to defaults, Edit as JSON, Rebuild bundle, Render master now. |
| MGU-004 | `apps/web/src/extensions/{index,react}.ts` (`clipBadgeProviders`, `useClipBadge`), `ClipView.tsx` | Graphics label colour; badge "R" → "✓" when the master is cached. |
| MGA-001 | `apps/mcp/src/tools/compositions.ts` | `import_mg_bundle`, `list_compositions` (props summary + schema), `add_composition`, `set_composition_props`, `prerender_composition`, `scaffold_mg_project`; `COMPOSITION_GUIDE`. |
| MGA-002 | `apps/engine/src/mg-bundles/project.ts` (`MgBundleError {code, hint}`), `engineToolError` | `MG_REMOTION_VERSION`, `MG_NOT_A_PROJECT`, `MG_BUNDLE_FAILED`, … carry hints through HTTP, jobs and MCP. |

## Contract changes (additive)

- `MgCompositionInfo.ui?` / `category?` / `thumbnailFrame?`; `ClipAddComposition.duration` optional; `ClipPatch.props`.
- `media.relink` accepts `mgBundle`, `lut`, `sizeBytes`, `originalName`; a fingerprint change is allowed for `mg-bundle` without `force`.
- Properties: `ValueKind 'json'`, `PropertyGroup 'props'`, `ui.control 'json'`, `PropertySpec.valueSchema`; `resolvePropertySpec`, `propertiesForClip`, `clipPropertiesJsonSchema` take an optional composition; `param.ts` `props.*` targets.
- Snapshot: `RenderCompositionSource.bundle/info/prerender`, `SnapshotOptions.resolveComposition`.
- One-line `contentDurationFlicks` hooks in `clip-core.ts`, `clip-edit.ts`, `transitions.ts`, `invariants.ts`; `clip.place` refuses `mg-bundle` media (use `clip.addComposition`).
- Engine: `NativeExtension.warnings` (+ planner); `UploadCreateRequest.purpose`, `UploadService.take`, upload `complete` refuses `mg-bundle` (409); `apps/engine/package.json` adds `zod-to-json-schema`, moves `esbuild` to dependencies.
- API: `MgPrerenderResult` extra fields, routes `mgBundlePoster`, `mgBundleScaffold`, `mgBundleRebuild` body, `mgBundleFiles`; event `mgBundle.rebuilt`; `MG_BUNDLE_ERROR_CODES`.
- `@jasper/compositions` export `./mg-host`.
- Web: `clipBadgeProviders` / `useClipBadge` + the `ClipView` hook; File menu entry; `MgTemplateRef.composition`.
- `pnpm-workspace.yaml` adds `fixtures/mg-project`.

## Licences

- `zod-to-json-schema` 3.25 — ISC (engine dependency, zod 3 projects only).
- `esbuild` — MIT (was a dev dependency; now a runtime dependency for the schema module).
- `fixtures/mg-project`: `remotion`, `@remotion/cli` 4.0.499 (Remotion licence, already used by the repo), `zod` 4.4.3 (MIT).
- FFmpeg: only `prores_ks`, `libvpx-vp9`, stream copy remux and `select`/`scale` for posters — all in the LGPL build; no GPL filters.

## How to test

- Unit: `pnpm vitest run --project @jasper/project --project @jasper/compositions --project @jasper/engine --project @jasper/web --project @jasper/mcp` (`packages/project/test/composition.test.ts`, `apps/engine/test/mg-bundles.test.ts`, `apps/mcp/test/compositions.test.ts`).
- Heavy engine/MCP suites (real bundling, renders, exports; need Chrome + LGPL FFmpeg): `MG_E2E=1 pnpm vitest run --project @jasper/engine apps/engine/test/mg-bundles.test.ts` (import, schema module, version error, zip, master/preview, cache hit, invalidation on props and on rebuild, native export vs Remotion still within 3/255 on 99 %, alpha over R/G/B/W ≤ 2/255, frame exactness), `MG_E2E=1 pnpm vitest run --project @jasper/mcp apps/mcp/test/compositions.test.ts` (port 48145).
- Playwright: `E2E_PORT=48440 pnpm e2e e2e/mg-clips.spec.ts` (protocol contract, UI import → Remotion tab → live host → props edit < 500 ms → preview WebM, MCP flow with `Agent:` History entries). Note: `pnpm e2e -- <spec>` passes `--` to Playwright, which then runs the whole suite.

## Real case: MatsSmileTrailer/mg

Copied to a temp dir (original untouched, `.bundle`, `out`, caches excluded). The project is a *registry*:
`src/registry.ts` lists `mgShot('MG05', …)` definitions whose duration, footage and guides come from the EDL brief
(`src/edit/brief.ts`); `Root.tsx` registers each as a `<Composition>` with empty `defaultProps`. In rendering mode
(`isRendering`, which the live host also sets) the footage preview and guides are off, so the page is transparent
— the shots work unchanged in the live host and the renderer. What such a project needs: a `jasper.mg.json` with
a `"*"` entry describing the runtime props shared by every shot (`matte`, `bg`, `guides`), since nothing is
inferable from empty `defaultProps`; categories via the same entry.

Results (engine 48140, web 52140):

- Import: 44 s (bundle with the project's CLI + metadata), 38 compositions.
- MG05 at frame 246 and MG22 at 1290 over `public/footage/timeline.mp4`; live host in the Program monitor.
- Native ProRes HQ exports, plan `native`, one child `mg-prerender` job each (MG05 240–310: 39 s; MG22 1285–1345: 42 s).
- Master vs `mg/out/MG05.mov`: alpha max diff 0, colour diff 0 (bit-identical decode); MG22 alpha diff 0.
- Export vs the reference composited straight-alpha over the footage: MG05 99.43 % of pixels within 3/255 (min frame 99.22 %), PSNR mean 49.1 dB / min 46.9; MG22 99.59 %, 52.9 dB. Shifting the reference by ±1 frame drops the minimum to ~84 % → placement is frame-exact. The frame before the clip is pure footage.
- Prop edit: "Matte pass" toggled in Properties → live host updated, preview re-rendered, master badge dropped; re-export rendered a new master (child job, 22 s) and the output shows the matte.

## Known gaps

- MGC-035 (P1) hybrid text layers: not implemented here (acceptance test 8 not covered). → Native text clips are
  baked by wp-m2-layer-bake (path `hybrid`, test 8 = layer-bake e2e parity); texts inside composition clips are
  wp-m3-mgtext (MGC-036…039, `docs/wp-notes/wp-m3-mgtext.md`).
- MGU-005: P2 per spec, not done. → Done in wp-m3-mgtext (on-canvas editing, promoted to P1).
- MGC-024: live-host budget is first-come, not ranked by distance to the playhead.
- `OffthreadVideo` / `<Video>` inside a composition is not shown in the live host (the renderer serves those frames; the preview WebM and masters are correct).
- Props edit latency in the dev build is ~270 ms with the host visible but ~600 ms when switching from the preview WebM (an editor-wide synchronous commit in dev React; the production E2E stays under 500 ms).
- Scaffold (MGC-015) is unit-tested for the files it writes and the version pin, not for `pnpm install` + bundle of the result.
- Folder picker on desktop relies on an optional `jasperDesktop.pickFolder`; otherwise a path field. Dropping a folder on the Project panel is not implemented.
- Posters use `thumbnailFrame` from the manifest, else frame 0 (as specified) — overlays that animate in are empty at frame 0, so set `thumbnailFrame` (the `"*"` entry works) for useful thumbnails.
