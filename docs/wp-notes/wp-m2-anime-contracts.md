# wp-m2-anime-contracts — shared contracts for in-video animation (S11, wave 0)

Branch `wp/m2-anime-contracts` (rebased on `main` 8a77f15 = cc6af79 refactor/audit + the S11 spec). Spec: `docs/specs/11-animation.md`. Contracts:
ARCHITECTURE §20.1–§20.8, D-31, D-32. Research: `docs/research/animejs-v4-notes.md`. Every contract is real,
compiled code with a minimal working implementation; the five wave-1 packages (`wp-m2-anime-core`,
`wp-m2-text-anim`, `wp-m2-anime-templates`, `wp-m2-layer-bake`, `wp-m2-shapes`) fill them in their own files.

## What was built (by ARCHITECTURE item)

| Item | Where | Notes |
|---|---|---|
| §20.1 schema v4 | `packages/project/src/schema/{document,sequence,common}.ts`, `migrations.ts`, `test/fixtures/v4/basic.jasper` | `CURRENT_SCHEMA_VERSION = 4`, no-op v3→v4. `TextAnimatorSchema {preset, version, durationFrames int ≥ 1, params}` (loose), `TextClip.textAnimation?: {in?, out?: TextAnimator \| null}`, `MotionGraphicClip.template.renderer?: 'fframes' \| 'anime'` (`MgRendererSchema`), kind `shape` (`ShapeClipSchema`, `ShapeDataSchema {type, size, fill \| null, stroke \| null, cornerRadius}`, Animatables; `AnimRGBASchema`). Fixture: animated text (slide-up@1 in / fade@1 out), anime template clip (`title-reveal@1`), rect (outside stroke, radius) and ellipse (keyframed size). |
| §20.1 factories | `packages/project/src/factories.ts`, `registry/properties.ts` | `defaultShape(type, opts)` (400×400, white fill, no stroke, radius 0), `DEFAULT_SHAPE_SIZE`, `DEFAULT_SHAPE_SECONDS`, `shapeIntrinsicBox` (largest size over value + keyframes, plus the stroke drawn outside: full width for `outside`, half for `center`); `intrinsicBoxOf` handles shapes. |
| §20.1 text animations | `packages/project/src/text-animations.ts` | `TextAnimationSpec`, `TEXT_ANIMATION_SPECS = []`, `getTextAnimationSpec(id, version, specs?)`, `TEXT_ANIMATION_REFERENCE_FPS`, `scaleAnimationFrames`, `textAnimatorParams` (defaults ⊕ params, parsed when valid), `compressAnimationWindows` and `resolveTextAnimationWindows(clip, specs?)` (S11:TXA-004: proportional, integer, each side ≥ 1 while the clip has ≥ 2 frames). |
| §20.1 kinds | `packages/project/src/registry/kinds.ts` | `KIND_CAPABILITIES.shape` (like text: Motion, opacity, effects; engines remotion/remotion, badge R, label magenta = graphics). `clipEngines(clip)` → `{preview, export, badge}` or null (unknown kinds); anime templates → remotion/remotion/R. |
| §20.1 snapshot | `packages/project/src/render/snapshot.ts` | Text source `animation?: {in?, out?: {preset, version, params, frames}}` (only when a side exists); warning `UNKNOWN_TEXT_ANIMATION` per preset not in the catalogue (passed through with stored params). `mg.renderer` only for `anime` (fframes snapshots byte-identical to before). `{shape: ShapeData}` source (unevaluated), box = `shapeIntrinsicBox`. `engine` from `clipEngines`. |
| §20.1 invariants | `packages/project/src/invariants.ts` | INV-012: animator `durationFrames` whole ≥ 1; shape size two numbers ≥ 0, corner radius ≥ 0, stroke width ≥ 0 (value and keyframes). |
| §20.1 commands | `commands/schemas/clip.ts`, `catalog.ts`, `handlers/{shape,text-animation,mg-template}.ts`, `clip-core.ts`, `types.ts` | `clip.addShape` (schema; handler stub owned by `wp-m2-shapes`), `ClipPatch.textAnimation` (nullable; per-side patch), `ClipPatch.shape` (merge; static or Animatable values), `ClipPatch.template {version}`, `clip.addText.textAnimation`. Field stubs validate the target kind (E_INVALID_PARAM) then answer E_NOT_IMPLEMENTED naming the owner (`COMMAND_FIELD_OWNERS`). `clip.addMotionGraphic` stamps `renderer: 'anime'` from the registry. `W_ANIMATION_COMPRESSED`. |
| §20.1 registry/agent | `registry/mg.ts`, `agent/schema-export.ts`, `packages/api/src/agent.ts` | `MgTemplateInfo.renderer/description/defaultDurationSeconds`, optional `MgTemplateRegistry.upgrade?`. Agent schema: `textAnimations[]`, `mgTemplates[].renderer` (always, `fframes` default) / `description` / `defaultDurationSeconds`, `properties[].kinds` (so the `shape` kind appears). |
| §20.2 motion | `packages/motion/**` | New package (animejs **4.5.0 exact**, remotion 4.0.499, project, mg-templates; react peer). Working runtime (see the API below); `./text` (`TEXT_ANIMATION_IMPLS = {}`, `TextAnimationImpl`, `UnitValues`, `REST_UNIT_VALUES`), `./templates` (`ANIME_TEMPLATE_IMPLS = {}`, `AnimeTemplateProps`). happy-dom vitest project. |
| §20.3 mg-templates | `packages/mg-templates/src/{types,registry,catalog}.ts`, `scripts/generate-schemas.ts` | Union `MgSvgTemplateDefinition \| MgAnimeTemplateDefinition`, `upgrades?`, `isAnimeTemplate`/`isSvgTemplate`, `FFRAMES_CATALOG`; `toTemplateInfo` passes renderer (anime only), description, default duration; `catalogJson` adds `renderer: 'anime'` for anime entries only; parity/twin tests and `schemas/` cover fframes templates only. Never imports animejs (tested). |
| §20.4 compositions | `packages/compositions/src/{SequenceComposition.tsx,fonts.ts,layers/ShapeLayer.tsx,layers/MotionGraphicLayer.tsx,layers/index.ts}` | `isFrameDependent` (kinds + animated text + keyframed shapes) in `layerViewEqual`; `FontsReadyContext`/`useFontsReady`, `useDocumentFonts` returns the settled flag (provided by SequenceComposition); `ShapeLayer` grey placeholder through `LayerBox`; anime-template placeholder card (no F badge). Deps `@jasper/motion`, `@remotion/shapes` 4.0.499. |
| §20.5 engine | `apps/engine/src/routes/{anime,layer-bake,index}.ts`, `src/anime/**`, `export/native-ext.ts`, `remotion/service.ts`, `scripts/build.mjs` | `routes/anime.ts` (appended): licence provider (anime.js MIT; package text in dev, committed `src/anime/third-party/LICENSE-animejs.txt` otherwise, copied to `dist/third-party` by the build) and `features.anime`. `routes/layer-bake.ts` registers `POST /api/layer-bake/preview` answering 501 `NOT_IMPLEMENTED` naming its owner (inline: the shared `routes/stub.ts` was removed by the cc6af79 audit, item 13), between mg-bundles and tracking. `LayerOverride.still?/rect?/colorRuns?`. `remotionSourceHash` hashes `pnpm-lock.yaml` and `@jasper/motion` sources. |
| §20.5 api | `packages/api/src/{m2-capabilities,mg,layer-bake,routes,agent}.ts` | `features.anime`, `features.layerBake`, `MgTemplateCatalogEntry.renderer?`, route `layerBakePreview` (owner `wp-m2-layer-bake`, loose `LayerBakePreviewRequest`). |
| §20.6 web | `apps/web/src/commands/{text-animation,shapes,index}.ts`, `text-animation/TextAnimationsTab.tsx`, `panels/motionTemplates/{MotionTemplatesPanel,PreviewThumb}.tsx`, `panels/timeline/components/ClipView.tsx`, `packages/ui/src/theme/{tokens,tailwind}.css` | Empty command modules (`textAnimationCommands`, `shapeCommands`, appended to the private `COMMAND_MODULES` list — the audit replaced the owner-keyed map, item 32); third tab "Text Animations" (placeholder); working `PreviewThumb` (poster `<Thumbnail>`, one app-wide hover `<Player autoPlay loop>` after 200 ms, touch/reduced-motion → poster); timeline badge from `clipEngines`; `--pr-engine-anime` (+ `bg-pr-engine-anime`). |
| §20.7 MCP | `apps/mcp/src/tools/{animation,shapes}.ts`, `server.ts` | `registerAnimationTools`/`ANIMATION_GUIDE`, `registerShapeTools`/`SHAPES_GUIDE` (empty strings; `FULL_GUIDE` filters empty sections — the audit had removed that filter because every guide was non-empty, item 39). |
| §20.8 lint | `scripts/check-anime.mjs` (+ test), `package.json` `lint`, `biome.json` overrides | Dependency rules (only motion imports animejs; only compositions imports `@jasper/motion`), ANM-006 import bans, wall-clock/`Math.random` bans in motion + compositions sources (mg-host protocol exempt with reason), anime API bans in files using anime.js; `anime-allow: <reason>`. Biome `noRestrictedImports` mirrors the import bans. |

## `@jasper/motion` API landed (ARCHITECTURE §20.2)

```ts
export type { Timeline, TimelineParams };                       // from animejs
export const ANIMEJS_VERSION: string;                           // animejs/package.json version ('4.5.0')
export function createPausedTimeline(params?: TimelineParams): Timeline;
export function seekCanonical(tl: Timeline, ms: number): void;  // non-finite ms → 0
export function frameToMs(frame: number, fps: number): number;
export function hash32(...parts: (string | number)[]): number;  // FNV-1a over UTF-8 of parts.join('\u001f'), unsigned
export function seededRandom(seed: number): () => number;       // createSeededRandom(seed >>> 0), values in [0, 1)
export type EaseName = 'linear' | 'in' | 'out' | 'inOut' | 'outBack' | 'outElastic' | 'outBounce' | 'outExpo' | 'inOutExpo' | 'steps';
export const EASES: Readonly<Record<EaseName, string>>;
export const EASE_NAMES: readonly EaseName[];
export function isEaseName(v: unknown): v is EaseName;
export function resolveEase(name: EaseName | string, opts?: { steps?: number }): EasingParam; // 'steps' → steps(n)
export function useAnimeValues<T extends Record<string, number>>(
  buildKey: string, build: () => { timeline: Timeline; targets: T[] }, ms: number): readonly Readonly<T>[];
export function useAnimeDom<E extends Element>(
  ref: RefObject<E | null>, buildKey: string, build: (root: E) => Timeline | null, ms: number, ready: boolean): void;
export type TextUnit = 'char' | 'word' | 'line';
export type TextSegment = { text: string; unitIndex: number; space: boolean }; // spaces: unitIndex -1
export function segmentText(text: string, unit: 'char' | 'word', locale?: string): TextSegment[];
export function needsShaping(text: string): boolean;
export function groupLines(container: HTMLElement, selector: string): number[];
```

## Contract changes (all additive unless noted)

- Schema v4 (older builds open v4 files read-only); new clip kind `shape` (`KnownClipKind`, `VisualClip`, `KIND_CAPABILITIES`).
- `RenderVisualSource`: text `animation?`, mg `renderer?`, `{shape}`; snapshot warning code `UNKNOWN_TEXT_ANIMATION`.
- Commands: `clip.addShape`; `ClipPatch.textAnimation/shape/template`; `clip.addText.textAnimation`; `CommandOwner` += `wp-m2-text-anim`, `wp-m2-anime-templates`, `wp-m2-shapes`; `COMMAND_FIELD_OWNERS`; `patchFieldNotImplemented`.
- `MgTemplateDefinition` is now a union (fframes definitions are typed `MgSvgTemplateDefinition`; consumers narrow with `isSvgTemplate` before `renderSvg`).
- `useDocumentFonts` returns `boolean` (was `void`).
- `AgentSchema.mgTemplates[].renderer` is always present (`'fframes'` default).
- `pnpm lint` runs `scripts/check-anime.mjs`; `biome.json` gains overrides.

## Licences

- `animejs` 4.5.0 — MIT (in About ▸ Licenses through `routes/anime.ts`; the text is committed for packaged builds).
- `@remotion/shapes` 4.0.499 (+ `@remotion/paths`) — Remotion licence, like the other `@remotion/*` packages.

## How to test

- `pnpm lint && pnpm typecheck && pnpm test`.
- Focused: `pnpm vitest run packages/project/test/anime-contracts.test.ts packages/mg-templates/test/anime-contracts.test.ts packages/motion apps/engine/test/anime.test.ts apps/web/test/anime-contracts.test.tsx apps/web/test/preview-thumb.test.tsx apps/mcp/test/animation.test.ts scripts/check-anime.test.mjs`.
- The motion runtime test proves the canonical seek on the R-ANM minimal repro (two `x` tweens with a gap: plain seek 1000 → 500 gives 300, canonical gives 100 = fresh 500) and that `useAnimeValues` returns identical values for shuffled frame orders (fast-check, fixed seeds).

Verification after the rebase on `main` 8a77f15 (2026-10-01): `pnpm install --frozen-lockfile` ok, `pnpm lint`
ok, `pnpm typecheck` ok, `pnpm e2e:typecheck` ok. `pnpm test` (load average ≈ 18–45 on 12 cores): 1256 passed,
29 skipped, 3 failed — `tracking.test.ts` (input-seek decoding), `mg-bundles.test.ts` (zod 3 schemas) and
`warp.test.ts` (planner), each hitting Vitest's default 5 s timeout during the parallel run. All three files pass
when run alone, and neither the tests nor the code they exercise are changed by this branch. An earlier run at
load ≈ 75–98 had 12 such timing failures in 9 files; every one passed on a re-run of its file.

### Rebase onto the cc6af79 refactor (resolved conflicts)

- `factories.ts`: kept the shape factories; dropped the re-added `structuredCloneJson` (removed by the audit).
- `migrations.ts`: kept the audit's inline identity steps and added `{from: 3, to: 4, migrate: (doc) => doc}`.
- `kinds.ts`: `KIND_CAPABILITIES.shape` written as a plain object (the `cap()` identity helper is gone).
- `properties.ts`: both imports (`contentTimeAt` from the audit, `shapeIntrinsicBox`).
- `mg-templates/registry.ts`: the audit's inlined canvas labels + `renderer: 'anime'` passthrough (`toTemplateInfo` is no longer exported).
- `compositions`: `@remotion/fonts` stays removed and `@remotion/player` stays a dev dependency; `@remotion/shapes` added. `SequenceComposition` keeps the inlined `AudioLayer` inside the new `FontsReadyContext.Provider`.
- `api/routes.ts`: `layerBakePreview` written without the removed `r()` helper and with `EngineJobSchema` (the `JobQueued` alias is gone).
- web `commands/index.ts`: new modules appended to the array; the old "one module per owner" registry test stays deleted; `apps/web/test/anime-contracts.test.tsx` imports the two modules directly.
- `mcp/server.ts`: `FULL_GUIDE` list + empty-section filter (see above).
- `engine/routes/layer-bake.ts`: inline 501 route (no `registerStubRoutes`); the route-coverage test now checks `hasRoute` for every API route.
- `pnpm-lock.yaml`: main's lockfile + `pnpm install`; the diff against `main` only adds lines (animejs 4.5.0, @remotion/shapes / @remotion/paths 4.0.499, the motion importer).
- The audit did not touch `RemotionService.sourceHash`; the defect below was still present on `main` and the fix stands.

## Defects found

- **Fixed:** the dev Remotion bundle hash (`RemotionService.sourceHash`) resolved `@jasper/project/package.json` and `@jasper/mg-templates/package.json`; the packages' `exports` do not expose `package.json` (`ERR_PACKAGE_PATH_NOT_EXPORTED`, silently caught), so their sources were never hashed and edits to the snapshot/scene code or templates reused a stale bundle. Roots are now resolved from the package entry (`remotionSourceHash`). Existing dev bundle caches rebuild once.
- anime.js 4.5.0 has no string form for `steps` (the core warns and falls back to linear); `EASES.steps` is a name only — use `resolveEase('steps', {steps})`.

## Known gaps / for the wave-1 packages

- Every new command field and `clip.addShape` answers E_NOT_IMPLEMENTED; razor/duplicate/fps remap of `textAnimation` (TXA-005) are not handled yet (a split copies both sides).
- Unknown text presets are passed through in the snapshot (with a warning) because the catalogue is empty; text-anim decides whether layers skip them.
- `shapeIntrinsicBox` uses the largest keyframed size; shapes may refine it (the geometry is centred in the box).
- `FontsReadyContext` is document-wide; core refines it per face (`isLoaded`).
- The Remotion bundle hash now includes the whole lockfile: any dependency change in the workspace rebuilds the dev bundle once (S11:FIX-009 asks for that).
- `posterAt` of anime templates is defined as seconds of content time (S11 does not fix the unit).
- No Playwright spec on contracts (no user-visible feature yet beyond the placeholder tab and cards).
