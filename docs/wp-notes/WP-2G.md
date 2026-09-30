# WP-2G: fframes motion graphics. Notes for integration

Branch `wp/wp-2g`. The worktree is `JasperEditor-worktrees/wp-2g`, which the orchestrator assigned; the brief's example path was `JasperEditor-wt/WP-2G`.
Scope: ARCHITECTURE D-12 and §10.2 (R-FF Design C). Delivered:

- the `jasper-mg` Rust CLI and its templates
- the TypeScript twins
- the engine render service and routes
- the composition layer
- the Motion Templates panel and the `mg.*` commands

## What exists

| Area | Files | Status |
|---|---|---|
| Rust workspace | `native/mg/{Cargo.toml,Cargo.lock}`, `crates/jasper-mg-core`, `crates/jasper-mg-templates`, `crates/jasper-mg-cli`, `fixtures/{lower-third,title-card}.json` | `fframes = "=1.0.3"`, default `cpu_renderer` feature only (no `h264`, no `compile-time-svgtree`). Profiles follow R-FF §8. 18 Rust tests. |
| Build script | `scripts/mg-build.mjs` (`pnpm mg:build`, `--dev`, `--quiet`) | Runs `cargo build --release --locked` and prints the binary path. Without cargo it prints a skip notice and exits 0. |
| TS twins | `packages/mg-templates/src/{core.ts,templates/*.ts,spec.ts,catalog.ts,registry.ts,types.ts}`, `schemas/*.json`, `scripts/generate-schemas.ts` | Catalog of `lower-third@1` and `title-card@1`, zod schemas, `renderSvg` twins, render-spec and cache-key helpers. |
| Engine | `apps/engine/src/mg/{binary,render,service,index}.ts`, `apps/engine/src/routes/mg.ts` | Binary resolution and probe, render pipe to ProRes 4444 (plus VP9-alpha preview), cache, `mg-render` jobs, routes, `mgMasterProvider`. |
| Composition | `packages/compositions/src/layers/MotionGraphicLayer.tsx` | Draws the SVG twin through the layer matrix. The render-state badge shows in preview only. |
| Web | `apps/web/src/panels/motionTemplates/{index.ts,MotionTemplatesPanel.tsx,insert.ts}`, `apps/web/src/commands/mg.ts` | Gallery, insert through `clip.addMotionGraphic`, drag payload, `mg.insert`, `mg.rerender`. |

Shared-file edits, all minimal and additive:

- `packages/api/src/mg.ts`: `MgTemplateCatalogEntrySchema` gains optional `native`, `defaultDurationSeconds` and `description`. This is a Contract-Change.
- `apps/engine/src/index.ts`: exports plus a marked TODO registration point (below).
- `apps/engine/test/server.test.ts`: the "every route answers 501" sweep now skips the `mg*` routes, because WP-2G implements them.

## `jasper-mg` CLI (as implemented)

```
jasper-mg --version        → {"name":"jasper-mg","version":"0.1.0","fframes":"1.0.3","renderer":"jasper-mg/0.1.0","templates":["lower-third@1","title-card@1"]}
jasper-mg schema           → {"templates":[{id, version, name, category, paramsSchema, defaults, introFrames, outroFrames,
                                            defaultDurationSeconds, canvases:["1920x1080","1080x1920","1080x1080"]}]}
jasper-mg render --spec <file|-> --raw-rgba [--threads N]   → width*height*4 bytes per frame, straight alpha, in order
jasper-mg frame  --spec <file|-> --frame N --out f.png      → straight-alpha PNG
jasper-mg svg    --spec <file|-> --frame N                  → the SVG markup of one frame (extra command, used for parity)
stderr NDJSON: {"event":"start","frames","width","height","threads","template"} {"event":"progress","done","total","elapsed"}
               {"event":"done","frames","elapsed"} | {"event":"error","code":"INVALID_SPEC"|"RENDER_FAILED","message"}
exit codes: 0 ok, 2 invalid spec/params/frame (and clap usage errors), 1 other (I/O, broken pipe, render failure)
```

- `--threads` defaults to `JASPER_MG_THREADS`, then to all cores. The engine passes its 4 CPU slots (S04:MG-013).
- The spec is `MgRenderSpec`: `{template:{id,version}, params, width, height, fps:{num,den}, durationFrames, sourceInFrames?}`. It uses `deny_unknown_fields`. Params use `deny_unknown_fields` plus `default`, so omitted fields take the template defaults. Range checks mirror the zod schemas.
- Rendering uses one `fframes::Previewer` and one `CpuFrameRenderer` per thread, with round-robin frames and an ordered reorder buffer (the R-FF Appendix pipe pattern). Output is straight RGBA, because `RgbaFrame::from_premultiplied` un-premultiplies.

### fframes 1.0.3 findings (API verified on this machine)

- **The fps override does not help.** `RenderOptions::override_fps` is an integer `Option<usize>`, and `Previewer` ignores it (it builds its `TimeBase` from `Video::FPS`). Neither can express 29.97 or 23.976.
  - The templates therefore do their own timing. Frame `n` is at `t = (sourceIn + n) / (num/den)`, and `duration()` returns `Duration::Frames(durationFrames)`.
  - `Video::FPS = 30` is a placeholder that only fframes' own `timeline!` helpers would read, and we do not call them.
- **Canvases.** `AnyTemplate<'a, const W, const H>` implements `fframes::Video` for 1920×1080, 1080×1920 and 1080×1080.
  - The CLI picks the canvas whose aspect ratio is closest (smallest |ln ratio|; near-ties go to the first canvas).
  - Frames are rasterized at the exact output size: `Previewer::svg_tree` followed by `CpuFrameRenderer::render_tree(tree, TRANSPARENT, w, h)`.
  - The design canvas is fitted with a uniform "contain" transform, so any size works (1280×720 is 16:9 at scale 0.667).
- **Text is built as strings at runtime.** Without `compile-time-svgtree`, `Svgr` is a string that `usvg` parses for each frame. The templates build their markup as strings, which is what makes an element-for-element TS twin possible.
- **Embedded media.** `include_media_dir!` resolves its path relative to the **workspace root** (`crates/jasper-mg-templates/media`), and the generated constructor is `MgMedia::new()`, not `prepare()`.
  - The embedded fonts are Inter 24pt Regular and Bold, under the SIL OFL (`crates/jasper-mg-templates/FONTS-OFL.txt`).
  - The typographic family resolves as `Inter`.
- **Performance on this machine (12 cores):**

  | Run | Result |
  |---|---|
  | 150 frames 1080p raw, all threads | 2.6 s |
  | Verify pipe to ProRes 4444 | 6.8 s wall |
  | Engine job (4 threads, master + VP9 preview + verify) | about 15–20 s |

  ProRes encoding is the bottleneck.

## Rust/TS parity

- **Shared arithmetic, not shared code.** `packages/mg-templates/src/core.ts` mirrors `jasper-mg-core` function by function:
  - easing and the closed-form damped spring
  - `progress`, canvas fit and frame timing
  - number formatting (`floor(x*1000+0.5)/1000`, at most 3 decimals, no trailing zeros, ±0 → `0`)
  - hex color channels and XML escaping
  - the deterministic text-width estimate used for the lower-third panel width

  Each template module (`lower_third.rs` / `lower-third.ts`, `title_card.rs` / `title-card.ts`) builds the same element sequence with the same constants.
- **Tests:**
  - Always run:
    - schemas in `packages/mg-templates/schemas/` equal the generated ones (`pnpm --filter @jasper/mg-templates schemas`)
    - every `native/mg/fixtures/*.json` parses with the TS schema, lists every param, and equals the TS defaults
    - unknown or out-of-range params are rejected on both sides
    - SVG snapshots at frames 0, mid and end for each template
  - With `MG_PARITY=1` and a built binary:
    - `jasper-mg schema` equals the TS catalog (canonical JSON of schema, defaults, intro/outro, duration and canvases)
    - `jasper-mg svg` equals the TS `renderSvg` for 2 templates × 2 param sets × 3 sizes/rates (30, 29.97 with sourceIn, 25 fps portrait) × 4 frames
    - numbers must match within ±0.002, to absorb last-ulp differences in `exp`/`sin`/`cos`; every other token must match exactly
  - Run: `pnpm mg:build && MG_PARITY=1 pnpm vitest run packages/mg-templates`.
- **What still differs is rasterization only.**
  - The browser draws the twin with its own font stack (`Inter, 'Inter 24pt', 'Source Sans 3', sans-serif`) and anti-aliasing. `jasper-mg` uses tiny-skia and the embedded Inter.
  - Layout does not depend on font metrics, because widths use the shared estimate. A long name in a much wider or narrower font can therefore sit tighter or looser in the panel than in the master.
- **Rules when changing a template:**
  - Edit the Rust and TS modules together, bump the template version if outputs change for the same params, and bump `RENDERER_VERSION`, which is part of the cache key.
  - Run `pnpm --filter @jasper/mg-templates schemas`, update the snapshots, and run the parity test.

## Engine service

- **Binary resolution.** `JASPER_MG`, then `native/mg/target/release/jasper-mg` found by walking up from the module or the cwd, then `process.resourcesPath/bin/jasper-mg`.
  - An explicit `JASPER_MG` is authoritative. `JASPER_MG=/nonexistent` makes fframes `unavailable` with the reason `JASPER_MG=/nonexistent is not an executable file`; it never falls back to another binary.
- **Startup probe.** `routes/mg.ts` creates `app.jasper.services.mg` (`createMgService`) and awaits `refresh()`, which runs `--version` and `schema`. `service.capability()` returns `{fframes: 'ready'}` or `{fframes: 'unavailable', fframesReason}`.
- **Render pipe.** `jasper-mg render --spec - --raw-rgba --threads 4 | ffmpeg -f rawvideo -pix_fmt rgba -s WxH -r num/den -i pipe:0`, which writes:
  - `master.mov`: `prores_ks -profile:v 4 -pix_fmt yuva444p10le -vendor apl0`
  - `preview.webm`, for quality `preview` only: `libvpx-vp9 yuva420p`, half size, `-auto-alt-ref 0`

  It then writes `poster.png` (the middle frame, from `jasper-mg frame`) and verifies each output with `ffprobe -count_packets`. A mismatch fails the job with `FRAME_COUNT_MISMATCH`.
  - Outputs go to `<appdir>/mg/<key>/.tmp-<jobId>/` and are renamed into place; `meta.json` has `verified: true`.
  - Cancelling kills both processes (SIGTERM, then SIGKILL after 3 s) and removes the partial files.
- **Cache key.** `sha256(canonicalJson({template, params with defaults applied, canvas, fps, durationFrames, sourceInFrames, renderer}))`, truncated to 40 hex characters (S01:KND-009, S04:MG-011).
  - `{}` and explicitly spelled-out defaults give the same key.
  - A cache hit completes the job at once (S04:CA-001).
- **Jobs.** The runner is self-contained for now: kind `mg-render`, 4 CPU slots, concurrency `cores / 4`, dedupe key `mg:<key>:<quality>`, cancel. It emits `job.created`, `job.updated` (at most 4/s) and `job.finished` through `services.events.publish(type, job, projectId)` when such a service exists.
- **Routes:**
  - `GET /api/motion-graphics/templates` returns the native catalog (`native: true`) when the binary is ready, and the TS catalog (`native: false`) otherwise.
  - `POST /api/motion-graphics/render` returns `202 EngineJob`. With `?wait=1` it returns `200` with the finished job.
    - Errors: `400 VALIDATION_FAILED`, `INVALID_SPEC` or `TEMPLATE_NOT_FOUND`; `503 MG_UNAVAILABLE`.
  - `GET /mg/:key/:file` serves `master.mov`, `preview.webm` and `poster.png`, supports Range (206/416), and is sent as immutable.
- **Native export hook.** `service.mgMasterProvider(clip, {fps, projectId?, parentId?, signal?}) → Promise<path | null>`. `mgMasterHook(service)` adapts it to WP-2F's `MgMasterProvider` request shape `({clip, fps, projectId?, signal}) → Promise<path | null>`; aborting the signal returns null and cancels a render the request started (a joined render keeps running).
  - It builds the spec from the snapshot clip (`specFromClip`), renders or reuses the master, and returns null when fframes is unavailable or the render fails. On null the planner must fall back to Remotion.
  - The `fps` argument is needed because `RenderVisualClip` does not carry the sequence rate.

### Integration with WP-2F (TODO at merge)

WP-2F was not merged when this package was written, so `apps/engine/src/index.ts` only carries a marked TODO. After merging WP-2F:

1. Capabilities: `registerCapabilityProvider(mgCapabilityProvider(app.jasper.services.mg))`. The provider returns `{render: {fframes, fframesReason?}}`. Until this is done, `GET /api/capabilities` is WP-2F's route, and on this branch it is still the WP-00 stub (501). Verify `render.fframes` after the merge. Before the merge the same state is visible as `renderer.status` in `GET /api/motion-graphics/templates`; that was verified with `pnpm dev:engine`, both ready and with `JASPER_MG=/nonexistent`.
2. Export planner: `registerMgMasterProvider(mgMasterHook(mg))` (WP-2F's `MgMasterRequest` is structurally compatible), or pass `(clip) => mg.mgMasterProvider(clip, {fps: snapshot.settings.fps, projectId, parentId: exportJobId, signal})`.
3. Jobs: either make `/api/jobs*` include `services.mg.listJobs()/getJob()/cancel()`, or port `service.ts`'s runner onto WP-2F's `JobQueue`. The runner exposes `requestRender(spec, quality, meta) → {job, done}`, which maps directly.
4. Events: register the broadcaster as `services.events` with `publish(type, payload, projectId?)`, or adapt the `emit` option of `createMgService`.

## Composition layer

- `MotionGraphicLayer` resolves params against the template schema, falling back to defaults field by field.
  - It calls `renderSvg(params, localFrame, fps, canvas, {durationFrames: clip.duration, sourceInFrames, idPrefix: 'mg-<clipId>'})`. Clip paths get unique ids, which matters because inlined SVG ids are global to the document.
  - It injects the markup into a box of `props.box` size placed by `matrixToCss(props.matrix)`, with opacity and blend applied.
  - Unknown templates draw a labeled placeholder.
- **Badge.** It shows only when `options.isPreview` is true, reading the state from `MgRenderStateContext` (`none | rendering n% | ready | failed`). The default is "F · SVG preview".
- **TODO(WP-2C/3I):** `layers/index.ts` belongs to WP-2C, so the context is not re-exported from `@jasper/compositions`. Add `export { MgRenderStateContext, type MgRenderState } from './layers/MotionGraphicLayer.tsx';` there, then have the Program monitor provide it from `job.*` events.
- **TODO (Remotion export fonts):** Remotion renders draw the twin in headless Chrome. Inter is only present if it is installed or loaded, so load it with `@remotion/fonts` from the engine's `/fonts` (WP-2F) for closer fidelity. Native exports use the master and are not affected.

## Web

- **Panel.** `PanelDefinition` `motionTemplates`, title "Motion Templates", and a menu entry `mg.rerender`. Cards show the TS catalog merged with the engine catalog's `native` flags.
- **Insert.** Double-click or Enter runs `insertMotionTemplate(session, {id, version})`:
  - it inserts at the playhead of the active sequence, on the topmost targeted unlocked video track (otherwise the topmost unlocked video track)
  - duration is `defaultDurationSeconds` × the sequence rate, with default params, via one `clip.addMotionGraphic` transaction ("Add Lower Third")
  - the new clip is then selected
- **Drag.** `dragstart` writes `application/x-jasper-mg-template` = `{type:'jasper/mg-template', template}`. The Timeline (WP-2B) and Program (WP-2C) drop handlers should call `readMgTemplateDrag(e.dataTransfer)` and then `insertMotionTemplate(session, template, {at, trackId})`. Both are exported from `apps/web/src/panels/motionTemplates/index.ts`.
- **Commands** (no default key bindings):
  - `mg.insert {templateId, version?, at?, trackId?}` is agent-exposed.
  - `mg.rerender` needs the `fframes` capability. It sends the spec of each selected motion-graphic clip (`mgSpecForClip`) to `POST /api/motion-graphics/render` with quality `preview`.
- **Not done: automatic proxy/master requests (S01:LIFE-045).** A session-level watcher should debounce 500 ms after param, duration or canvas changes and request renders. It is not in this package's brief; the Program monitor or session integration should add it with `mgSpecForClip` and `mgRender`.

## Verification (this branch)

- `pnpm install && pnpm lint && pnpm typecheck && pnpm test && pnpm build`: pass. Tests: 27 files, 189 passed, 2 skipped, 1 todo.
- With `native/mg/target` moved away, `pnpm test` passes: 187 passed, 4 skipped. The engine render tests and the parity tests skip with a message.
- `pnpm mg:build`: builds `native/mg/target/release/jasper-mg`. With a PATH that has no cargo, it prints the skip notice and exits 0.
- `cargo test --release` in `native/mg`: 18 passed. These cover spec parsing, frame count, the straight-alpha probe (50 % white stays `255,255,255,128`), exit codes and PNG output.
- The acceptance pipe:

  ```
  native/mg/target/release/jasper-mg render --spec native/mg/fixtures/lower-third.json --raw-rgba \
    | ffmpeg -f rawvideo -pix_fmt rgba -s 1920x1080 -r 30 -i - -c:v prores_ks -profile:v 4 -pix_fmt yuva444p10le /tmp/jasper-research/WP-2G/lt.mov
  ```

  `ffprobe -count_frames` reports 150 frames, `yuva444p12le` (ProRes 4444 decodes as 12-bit). The panel pixel at frame 60 decodes as `10,15,31,200`, which is straight alpha: the expected value is `[0.04,0.06,0.12,0.78]` → `10,15,31,199`.
- `MG_PARITY=1`: schema and SVG parity pass.
- Engine test (gated): a real 150-frame lower-third render at 1920×1080 and 30 fps, with the ffprobe frame count, pix_fmt and straight-alpha pixel checks, Range, cache hit, `mgMasterProvider` and cancel with no leftovers.

## M2: replacing the twins with WASM (Design B)

1. **Split the templates crate.**
   - The SVG builders (`lower_third::render_svg`, `title_card::render_svg`, and `Prepared::svg`) already depend only on `jasper-mg-core` and serde.
   - Put the `fframes`-dependent parts (`AnyTemplate: Video`, `MgMedia`) behind a `renderer` feature, on by default for the CLI.
   - A new `crates/jasper-mg-wasm` (cdylib) can then expose `#[wasm_bindgen] fn render_svg(spec_json: &str, frame: u32) -> String` plus `schema()` without pulling in fframes, libav or the `getrandom` issue.
   - Build it with its own target dir, to avoid feature-unification rebuilds (R-FF §4 and §8), using `cargo build -p jasper-mg-wasm --target wasm32-unknown-unknown` followed by `wasm-bindgen --target web`.
   - If fframes' own features (text measuring, raster-only effects) become necessary, switch to `fframes-editor-controller`'s `impl_wasm_bridge_for!` over a single canvas type instead.
2. **Load in the layer.** `MotionGraphicLayer` loads the module once (cached promise plus `delayRender` for Remotion renders) and calls `render_svg` in place of `def.renderSvg`.
   - The module is about 37 µs per frame (R-FF §4), so scrubbing stays free.
   - The layer props, the badge and the id-prefix handling stay as they are.
3. **Twins become fallbacks.** The TS twins are then only needed as a fallback when WASM fails to load and as test oracles. The existing `MG_PARITY` harness becomes a WASM-vs-native check, since both run the same Rust code. ARCHITECTURE open question 4 suggests dropping the twins from the runtime bundle.
4. **Keep the schemas for zod.** `@jasper/mg-templates` keeps the zod schemas and the catalog metadata, because `clip.addMotionGraphic` validation and the property registry need zod. Generate them from `jasper-mg schema`, or keep `schemas/` as the checked-in source of truth.

## Known limitations / follow-ups

- Parameters are static in M1: the property registry marks `params.*` as `animatable: 'no'`. Keyframe tracks inside the spec (S03:KND-061) are future work, via a `keyframes` field per param in `MgSpec` and the same adapter on both sides.
- Only two templates ship. MGT-003 (the "Create with agent" card, which would use Design A) and favorites/context-menu actions are not implemented.
- `jasper-mg` statically links LGPL libav (R-FF §9). Shipping it in Electron `extraResources` needs the LGPL relinking notice; see the M3 packaging decision.
- The Rust binary is ~32 MB (release, thin LTO). `native/mg/target` is gitignored.
