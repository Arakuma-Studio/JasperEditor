# fx shader framework — authoring guide (wave 1, `wave1/shader-framework`; follow-ups `wave2b/fx-framework-followups`)

> **New since wave 1** (details in §17, pitfalls in §18): `ctx.paramsAt(frame)` (params at other / sub-frame times)
> and `ctx.clip` (clip/item/file name, source in-point, source timecode) in every hook; time samples and remaps that
> compose across the stack, `time.sampleEdge`, `u_sampleValid`; ping-pong outputs (`update`), absolute pass sizes
> (`size`), mipmaps (`mipmaps`, `gpu.sourceMipmaps`); `ivec2/3/4` and `vec4[]` uniforms; `.cube` LUT params
> (`lutParam`, `sampler3D`, `GLSL_LUT`); unused declarations dropped; `gaussianBlurPasses` X/Y and uniform sigmas;
> SVG-only built-ins run in stack order; reduced preview resolution; a SwiftShader compile-time budget test.
> **Wave 5** (§19): the adaptive shutter motion blur (`planMotionBlur`, `GLSL_MB`, `GLSL_MB_POSES`) for every moving
> effect and transition.

Audience: the wave-2 agents that add effects to the fx catalogue (Premiere standard effects, Sapphire-style
families). You only edit **your family file** (`packages/project/src/registry/fx/<family>.ts`) and add tests. You do
not touch the renderer, the registry, the Effects panel, Effect Controls, the engine or MCP — every one of them picks
your entries up automatically. Specs: S03 §4.2, §15 (FX-001/002/040/041), S11 §2 (determinism); ARCHITECTURE §19.2
(the GL colour stage is the rendering precedent).

## 1. Where things live

| What | Where |
|---|---|
| Your family file (one `readonly EffectSpec[]`) | `packages/project/src/registry/fx/<family>.ts` (11 files, see §13) |
| `defineShaderEffect`, `SAPPHIRE_BINS` | `registry/fx/define.ts` |
| Param builders (`fxParam.*`, `lutParam`, `sapphireCommonParams`, `blendModeParam`, `edgeModeParam`, …) | `registry/fx/params.ts` |
| Pass builders (`gaussianBlurPasses`, `bloomPyramidPasses`) | `registry/fx/passes.ts` |
| Adaptive shutter motion blur (`planMotionBlur`, `centredShutter`, `mbUniforms`, `mbQualityParam`, §19) | `registry/fx/motion-blur.ts` + `registry/fx/glsl/motion-blur.ts` |
| Types, planning (`planGpuEffect`, `planPasses`), uniforms, padding, seeds, time hooks (`fxStackTime`, `fxParamsAtFn`), `validateGpuEffect` | `registry/fx/shader.ts` |
| GLSL library (`GLSL_HASH`, `GLSL_NOISE`, `GLSL_COLOR`, `GLSL_BLEND`, `GLSL_SAMPLE`, `GLSL_UV`, `GLSL_BLUR`, `GLSL_COMPOSITE`, `GLSL_LUT`) | `registry/fx/glsl/*.ts` |
| Runtime (GPU host, chain, layers, SVG built-in stand-ins `builtins.ts`) — read only | `packages/compositions/src/fx/*` |
| Worked examples (test-only effects) | `packages/compositions/test/fx-examples.ts` |

Everything is exported from `@jasper/project` (framework) and `@jasper/compositions` (runtime).

**Import rule.** A family file imports values only from `./define.ts`, `./params.ts`, `./passes.ts`, `./shader.ts`,
`./motion-blur.ts` and `./glsl/*`, and only **types** from `../effects.ts` (`import type`). `effects.ts` imports the catalogue, so a value
import from it is a module cycle (top-level use → `ReferenceError` at load; the catalogue test would catch it).

## 2. Worked example (complete)

A Sapphire-style glow: threshold the bright parts, blur them at half resolution, add the tinted light back, with
Show/Mix-with-Orig, drawing outside the layer box. This is `TEST_GLOW` of `fx-examples.ts`, written as a family entry:

```ts
// packages/project/src/registry/fx/sapphire-glows-lighting.ts
import type { EffectSpec } from '../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from './define.ts';
import { GLSL_BLEND } from './glsl/blend.ts';
import { GLSL_COMPOSITE } from './glsl/composite.ts';
import { fxParam, sapphireCommonParams } from './params.ts';
import { gaussianBlurPasses } from './passes.ts';

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);

export const S_GLOW = defineShaderEffect({
	id: 'jasper.s.glow',
	label: 'S_Glow',
	category: 'Stylize',
	bin: SAPPHIRE_BINS.glows,                       // Video Effects ▸ Sapphire Glows ▸ S_Glow
	description: 'Bright areas bleed light around them.',
	keywords: ['bloom', 'light', 'halo'],
	params: [
		fxParam.percent('threshold', 'Threshold', 60),     // u_threshold (float, 0..100)
		fxParam.pixels('radius', 'Width', 20, 200),          // u_radius (float, layer px)
		fxParam.number('brightness', 'Brightness', 1.5, { min: 0, max: 10, step: 0.01 }),
		fxParam.color('glowColor', 'Glow Color', [1, 0.8, 0.5, 1]),  // u_glowColor (vec4, straight)
		...sapphireCommonParams(),                           // u_show (int), u_mixWithOriginal (float)
	],
	gpu: {
		padding: (p) => 3 * num(p.radius),                   // light may reach 3σ outside the layer
		passes: (p, ctx) => [
			{
				output: 'bright',                               // later passes read uniform sampler2D u_bright
				include: [GLSL_COMPOSITE],
				frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(texture(u_source, v_uv));
  float m = fx_lumaMatte(c.rgb, u_threshold / 100.0, 0.1) * c.a;
  fragColor = vec4(c.rgb * m, m);                        // premultiplied out
}`,
			},
			// two passes (H, V) at half resolution → output u_glow
			...gaussianBlurPasses({ input: 'bright', output: 'glow', sigma: num(p.radius) * ctx.pxScale, scale: 0.5 }),
			{
				include: [GLSL_COMPOSITE, GLSL_BLEND],            // last pass: writes the effect result
				frag: /* glsl */ `
void main() {
  vec4 src = texture(u_source, v_uv);
  vec4 g = texture(u_glow, v_uv);
  vec4 result = fx_addLight(src, g.rgb * u_glowColor.rgb * u_brightness);
  fragColor = fx_finish(result, src, g.a, u_mixWithOriginal, u_show);
}`,
			},
		],
	},
});

export const SAPPHIRE_GLOWS_LIGHTING_EFFECTS: readonly EffectSpec[] = [S_GLOW];
```

That is all. The effect now appears in the Effects panel (folder + **GPU** badge), Effect Controls (generic rows from
the params), the agent schema (`describe_commands` / `exportAgentSchema`: `bin`, `description`, `gpu: true`), the
Player, stills and exports (Remotion path), and in the catalogue + GL tests.

More examples in `fx-examples.ts`: a generator (`TEST_GRADIENT`), a padded drop shadow with derived uniforms
(`TEST_DROP_SHADOW`), time samples (`TEST_TRAILS`, `TEST_ECHO`), time remaps (`TEST_FREEZE`, `TEST_JITTER`).

## 3. Spec fields

`defineShaderEffect(init)` → `EffectSpec` with `version: 1`, `appliesTo: 'video'`,
`capabilities: {preview: 'webgl', export: ['remotion']}`, `native: null`.

| `init` field | Meaning |
|---|---|
| `id` | `jasper.<kebab>` (Premiere families) or `jasper.s.<kebab>` (Sapphire families). Never reuse an id. |
| `label` | Effects-panel name (Sapphire style: `S_Glow`). |
| `category` | `EffectCategory` (semantic; the folder when there is no `bin`). |
| `bin` | Effects-panel folder under Video Effects. Sapphire families: one of `SAPPHIRE_BINS` (required by the catalogue test). Premiere families: omit (category folders). |
| `params` | `ParamSpec[]` (use `fxParam.*`). Names: letters and digits, starting with a letter (no `_`). |
| `gpu` | `GpuEffect` (below). |
| `description` | Required (tooltip, agent catalogue). |
| `keywords`, `version`, `migrate`, `expensive` | As for every effect (S01:FX-020…024). Bump `version` + `migrate` when params change meaning. |
| `preview` | Optional CSS/SVG approximation, used only where the GPU cannot run (preview without WebGL2). |
| `native` | Leave unset (see §11). |

`GpuEffect`:

| Field | Meaning |
|---|---|
| `passes` | `ShaderPass[]`, or `(params, ctx: FxPlanContext) => ShaderPass[]` when the number/settings of passes depend on params (pyramids, iterations). `ctx = {width, height (layer box px), pxScale, fps}` + optional `frame`, `paramsAt`, `clip` (§17.1, §17.2). |
| `kind` | `'filter'` (default) or `'generator'` (draws its own picture; `u_source` is still the input to composite over). Metadata. |
| `padding(params, ctx)` | Extra layer pixels the effect may draw outside its input's bounds: a number (all sides) or `{left, top, right, bottom}`. Clamped to 0…2048. |
| `uniforms(params, ctx: FxFrameContext)` | Derived uniforms for every pass, e.g. `{u_offsetPx: [dx, dy]}` (types from values, §5). `ctx` adds `frame`, `duration`, `seed`, `progress`, and (when the host has them) `paramsAt`, `clip`. |
| `sourceMipmaps` | `true`: `u_source` has a mip chain in every pass of the effect (`textureLod`/`textureGrad` for strongly shrinking warps, §17.4). |
| `paramUniforms` | `false` (or a function of the params): no `u_<param>` uniforms; the hooks turn params into pass uniforms that may reuse their names. Spec 19's look effects (`title-look/look-effect.ts`). |
| `time.remap(params, ctx)` | Source-frame remap (§9). |
| `time.samples(params, ctx)` | Extra source pictures at frame offsets (§9). |
| `time.sampleEdge` | Samples outside the clip's drawn span: `'drop'` (default: none that frame), `'transparent'`, `'clamp'` (§17.3). |
| `timeInvariant` | `true` if the output depends only on params + input (no `u_frame`/`u_time`/`u_progress`/`u_seed`-per-frame, no time hooks). Lets still layers skip per-frame redraws. Default false. |

`ShaderPass`:

| Field | Meaning |
|---|---|
| `frag` | GLSL ES 3.00: helper functions + `void main()` writing `fragColor`. No `#version`, `precision`, `in`/`out`, built-in or param uniform declarations (all generated). Use `texture()`, never `texture2D`/`gl_FragColor`. |
| `output` | Name of this pass's output texture, readable by LATER passes as `uniform sampler2D u_<output>` (declared for you). Default `pass<i>`. Ignored on the last pass (its output is the effect result). |
| `include` | GLSL chunks (`GLSL_*`); dependencies pulled in, each once. |
| `scale` | (0, 1]: output size relative to the effect canvas (0.5 = half). The last pass is always full size. Sample other textures with `v_uv` regardless of their size. |
| `format` | `'rgba8'` (default) or `'rgba16f'` (HDR intermediates > 1.0; falls back to rgba8 without `EXT_color_buffer_float`). |
| `filter` | How later passes sample this output: `'linear'` (default) or `'nearest'`. |
| `uniforms` | Uniforms of this pass only (e.g. `{u_dir: [1, 0]}` to reuse one blur shader twice). |
| `size` | Absolute output size `{width, height}` in px (1…8192) instead of `scale`: lookup / statistics passes (e.g. 64×1). Ignored on the last pass. |
| `update` | Ping-pong: write an output name an earlier pass already wrote; this pass reads the old contents as `u_<output>`, later passes the new ones (§17.4). |
| `mipmaps` | Build a mip chain of this output after drawing (trilinear minification for later passes). |

Limits: ≤ 12 distinct output names + media params per effect (ping-pong `update` passes reuse a name); ≤ 8 time
samples; canvas side ≤ 8192 px (bigger layers are drawn downscaled, `u_pxScale` < 1).

## 4. Params → uniforms (naming `u_<paramName>`)

| Param type | GLSL | Value |
|---|---|---|
| `number` | `uniform float u_x` | as stored (percentages stay 0..100 — divide in GLSL) |
| `boolean` | `uniform bool u_x` | |
| `enum` | `uniform int u_x` | index in `options` (unknown value → the default's index) |
| `vec2` | `uniform vec2 u_x` | as stored |
| `color` | `uniform vec4 u_x` | straight RGBA 0..1 (premultiply yourself: `fx_premultiply`) |
| `media` | `uniform sampler2D u_x` + `uniform vec2 u_x_size` | the picture (premultiplied); size in px, `(0,0)` when none/offline |
| `media` with `mediaKinds: ['lut']` (`lutParam`) | `uniform highp sampler3D u_x` + `uniform vec2 u_x_size` | the `.cube` LUT, N³ RGB half float, trilinear; `(N, 1)`, `(0,0)` when none — `fx_lut3d(u_x, u_x_size, rgb)` |
| `string`, `curve` | not mapped | |

Conventions of `fxParam.*` (normative):

- `fxParam.point(name, label, [0.5, 0.5])`: a vec2 **normalised to the layer box** ([0,0] = top-left, [1,1] =
  bottom-right, may leave the box), `ui.control: 'point'` → x/y fields in Effect Controls **and a draggable crosshair
  in the Program monitor** when the effect is selected in Effect Controls (writes a keyframe when animated). In GLSL:
  `fx_uvOfLayerNorm(u_center)`.
- `fxParam.pixels`: layer pixels (`unit: 'px'`); multiply by `u_pxScale` in GLSL (or by `ctx.pxScale` in TS).
- `fxParam.angle`: degrees, 0° = right, clockwise on screen (`fx_dir(deg)` → unit vector).
- `fxParam.percent`: 0..100 slider. `fxParam.choice`: enum popup (hold-only). `fxParam.toggle`: checkbox (hold-only).
- `fxParam.media(name, label, ['image', 'video'])`: a picture input (depth/displacement maps, textures, mattes). The
  inspector shows a project-media picker for these kinds.
- `fxParam.number(name, label, def, range, {unit?, animatable?, group?, ui?})` for everything else.
- Sapphire common params: `sapphireCommonParams({seed?, show?})` = `[Seed?] Show, Mix with Orig` →
  `u_seed` (mixed in, see §8), `u_show` (int: 0 Result, 1 Matte, then your extra options), `u_mixWithOriginal` (0..1).
  Finish with `fx_finish(result, original, matte, u_mixWithOriginal, u_show)`.
- `blendModeParam()` → `int` index into `FX_BLEND_MODES` → `fx_blend(u_blendMode, base, top, opacity)`.
- `edgeModeParam()` → `int` index into `FX_EDGE_MODES` → `fx_sampleEdge(tex, uv, u_edgeMode)`.

Custom uniforms (`gpu.uniforms`, `pass.uniforms`) must be named `u_<name>`; types come from the value: number →
`float`, boolean → `bool`, `[a,b]`/`[a,b,c]`/`[a,b,c,d]` → `vec2/3/4`, `{int: n}` → `int`, `{floats: [...]}` →
`float u_x[n]`, `{mat3: [9 numbers, column-major]}` → `mat3`, `{ivec2: [a, b]}` / `{ivec3}` / `{ivec4}` → `ivec2/3/4`
(truncated), `{vec4s: [4·n numbers]}` → `vec4 u_x[n]` (packed point lists). Keep a uniform's type AND array length
stable across frames (pad arrays to a fixed size, pass the count separately).

## 5. Built-ins, coordinates, alpha

Declared in every pass (unused ones cost nothing). Declarations of YOUR outputs, media textures and param/custom
uniforms are emitted only in the passes that mention them (body or includes), so identical pass bodies share one
compiled program across effects and positions:

| Uniform | Meaning |
|---|---|
| `sampler2D u_source` | The effect input: the layer picture after the effects above this one, on the effect canvas. Premultiplied, linear filtering, clamp-to-edge. |
| `sampler2D u_prev` | Previous pass output (pass 0: `u_source`). |
| `vec2 u_resolution`, `u_texel` | Current pass output size (px) and 1/size. |
| `vec2 u_canvasSize` | Effect canvas size (px, full resolution) = layer box + accumulated padding. |
| `vec4 u_box` | The layer box inside the canvas: x, y, w, h (canvas px, y down). |
| `float u_pxScale` | Canvas px per layer px (1 except for huge layers). |
| `float u_frame`, `u_time`, `u_fps`, `u_duration` | Clip-local frame (real time, also under a remap), seconds, fps, clip length in frames. |
| `float u_clipProgress` | `u_frame / (u_duration − 1)`, 0..1. |
| `float u_progress`, `int u_side` | Transition progress (0..1) and side (1 outgoing, 2 incoming) when a transition drives the layer; else `u_clipProgress` / 0 (§10). |
| `float u_seed` | Deterministic 0..1 per clip + effect instance (+ `seed` param) (§8). |
| `mat3 u_layerToComp`, `vec2 u_compSize` | Layer px → sequence px (Motion, corner pin), sequence size. |
| `sampler2DArray u_samples`, `int u_sampleCount`, `float u_sampleOffsets[8]`, `int u_sampleValid` | Time samples (§9, §17.3); use `fx_sample(i, uv)`. Count, offsets, validity and every `u_<media>_size` are set in EVERY pass, also passes that do not sample. |

Prelude helpers (always available): `fx_canvasPx()`, `fx_layerPx()`, `fx_layerNorm()`, `fx_uvOfCanvasPx(p)`,
`fx_uvOfLayerPx(p)`, `fx_uvOfLayerNorm(n)`, `fx_inBox(uv)`, `fx_premultiply(c)`, `fx_unpremultiply(c)`,
`fx_sample(i, uv)`.

- **Orientation**: `v_uv` is 0..1 over the canvas with **(0,0) at the top-left** in every texture (y down, like
  every layer coordinate in the editor). Do not use `gl_FragCoord` (the final pass is flipped internally).
- **Alpha**: every texture is **premultiplied**, and `fragColor` must be premultiplied. Blurs/warps work directly;
  colour maths needs `fx_unpremultiply` → work → `fx_premultiply`. Write `vec4(0)` for "nothing".
- **The last pass replaces the input**: a glow/shadow must composite the source itself (`fx_over`, `fx_blend`,
  `fx_addLight`). Pixels you do not write are transparent.

## 6. Padding (S03:FX-041)

The layer's canvas = layer box + the sum of the paddings of its shader effects (stack order: each effect pads its
input's bounds). The canvas is drawn at (−left, −top) of the layer box, so glows, shadows, rays and flares are not
clipped at the box edge; Motion/opacity/blend apply to the whole canvas. Return the reach of your effect in layer
pixels (blur: ~3σ; shadow: distance + 3·softness; rays: their length). Too small clips light; too big costs fill
rate. Layer selection/hit-testing still uses the layer box. A later crop (crop is always first in the stack) clips
everything outside its inset rect, as in Premiere.

## 7. Generators and media inputs

- **Generators** (`gpu.kind: 'generator'`): ignore or composite over `u_source`. To fill the layer, test
  `fx_inBox(v_uv)` and use `fx_layerNorm()`. On a Color Matte (solid) layer the input is the matte colour. Example:
  `TEST_GRADIENT`.
- **Media params**: `fxParam.media('map', 'Displacement Map')` → `u_map`, `u_map_size`. Images are loaded once;
  videos play at the layer's clip-local (source) time from their own start. Missing/offline → `u_map_size == vec2(0)`
  (handle it: e.g. pass the source through). Sample with the same `v_uv` mapping you want (e.g. stretch the map over
  the layer box: `texture(u_map, fx_layerNorm())`).

## 8. Seeds and determinism (S11 §2)

Every frame must be a pure function of (document, frame): the Player, renderStill, parallel renderMedia pages and
random seeks all draw the same pixels. Therefore:

- no `Math.random`, no clocks, no state carried between frames, no reading previous output (feedback effects must be
  expressed with time samples, §9);
- randomness = `u_seed` (stable per clip + instance; changes with the `seed` param) combined with `u_frame` and
  pixel coordinates through the integer hashes of `GLSL_HASH` (`fx_hash2/3`, `fx_random(px, frame, seed)`) or the
  noise of `GLSL_NOISE` (`fx_simplex3(vec3(p, u_time), u_seed)`, `fx_fbm`, `fx_cellular`…). Integer hashes are exact on
  every GPU and in SwiftShader;
- TypeScript hooks use `fxRandom(ctx.seed, n)` (and `fxSeed` if you need one yourself).

## 9. Time effects

- **`time.remap(params, ctx)`** → the clip-local SOURCE frame shown at `ctx.frame` (freeze, retime, reverse, jitter,
  random edits). The composition wraps the layer in `<Freeze frame>` and passes the remapped `localFrame`/
  `contentTime` to the layer component, so video, composition clips and DOM layers all show the source at that frame;
  Motion, opacity and every effect param stay at the real time; `u_frame` is the real frame. Result is floored and
  clamped to the drawn span `[−headHandle, duration + tailHandle − 1]`. Several remaps NEST like image effects
  (After Effects' model, `fxSourceFrame`): the last effect is asked for the real frame and asks the effects above it
  for its remapped frame — [Freeze, Speed ×2] stays frozen, [Speed ×2, Freeze at 10] shows source frame 20.
  `ctx = {frame, fps, duration, headHandle, tailHandle, seed, paramsAt?, clip?}`.
- **`time.samples(params, ctx)`** → up to 8 integer frame offsets relative to the (remapped) source frame, e.g.
  `[-1, -2, -3]` for trails/echo/time average. Read them with `fx_sample(i, uv)` (i in request order, `u_sampleOffsets[i]`
  is the offset; `u_sampleCount` how many are bound). Samples are the **raw layer source** (before any effect) in the
  canvas layout (same `v_uv` as `u_source`), at the frame the effect's input has after the OTHER effects' remaps
  (`fxStackTime`, §17.3): an echo below a freeze echoes the frozen picture, an echo above it shows the frozen frame
  ± offsets. Put sampling effects first in a stack (later image effects are not applied to samples). Each sample is
  decoded for its own source frame (a `<Freeze>`d decoder per frame), so samples are deterministic under random seek
  and in parallel renders. Outside the drawn span: `time.sampleEdge` (default `'drop'`: no samples that frame,
  `u_sampleCount == 0` — never a stale picture). `timeInvariant` is ignored with time hooks.
- Verified: freeze remap and an earlier-frame sample are exact in renders (`fx-render.e2e.test.ts`) and in the Player
  when paused (`fx-player.e2e.test.ts`).
- Limits: during **playback** in the Player each sample/remapped decoder seeks per frame — exact when paused or
  rendering, but it may lag or stutter while playing (cost grows with the sample count; keep ≤ 4 for real-time).
  Stills: samples equal the still. DOM layers (text, shapes, motion graphics): no samples (`u_sampleCount == 0`);
  remap works (the content is drawn at the remapped time). "Feedback" effects need an explicit window of samples.

## 10. Transitions hook

GPU transitions are a separate framework (wave 2): `docs/wp-notes/fx-transition-framework.md` — one frame-space
shader stage per transition that reads both sides (`u_from`, `u_to`). For effects ON a clip that is a side of a GPU
transition, `LayerProps.transition` is set during the span: `u_progress` (the transition's progress, 0..1) and
`u_side` (1 outgoing, 2 incoming); without it `u_progress = u_clipProgress`, `u_side = 0`. In TS,
`FxFrameContext.progress` is the same value.

## 11. Export, native vs null, WebGL

- `native` stays unset (null). wave1c (ARCHITECTURE D-35): a video / still / solid / animated-image layer with such an
  effect is baked by the layer-bake extension (a Remotion render of that layer alone, straight-alpha master or one PNG
  when nothing changes per frame, cached by content) and overlaid natively — the rest of the export stays native
  (`hybrid`). Exports forced to Remotion, or engines without the bake, run your shader in headless Chrome (WebGL2 via
  ANGLE/SwiftShader) for the whole render. Today's native builder renders only crop, flips and the
  extensions' effects (colour LUTs) — an `EffectSpec.native` filter is NOT consumed, so do not add one (it would also
  show a misleading N badge).
- Renders without WebGL2 fail with `WEBGL_UNAVAILABLE` (the engine checks documents with GPU or colour effects
  before rendering); a shader that does not compile fails the render with `FX_SHADER_ERROR` (log + offending lines);
  never silently unprocessed.
- DOM layers (text/shapes/anime templates) export through the layer-bake path (S11:LBK): the bake is a Remotion render
  of the layer, so your effect runs there too (HTML-in-Canvas, always enabled in Remotion's render browser). Bakes of
  layers with time-dependent GPU effects are per-frame masters, not still PNGs; their cache key keeps the clip id
  (`u_seed`).

## 12. What runs where

| Layer kind | Preview (Player) | Renders / export |
|---|---|---|
| video (browser-decodable) | yes — headless `<Video>` frames → FxPicture | yes |
| video (ProRes etc., `OffthreadVideo`) | proxy as above | yes (OffthreadVideo frames) |
| still, animated image (first frame) | yes | yes |
| solid / Color Matte | yes | yes |
| composition clip (mg-bundle) | on the cached preview WebM; the live iframe host cannot be captured → chip "Grade pending" until the preview is ready | yes (master) |
| text, shape, motion graphic (fframes SVG twin, anime template) | via HTML-in-Canvas: Electron (enabled by the desktop app) and Chrome ≥ 148 with chrome://flags/#canvas-draw-element; otherwise the layer draws unprocessed with the chip "GPU effects need HTML-in-Canvas…" | yes (bake / Remotion path) |
| no WebGL2 / lost context (preview) | effects bypassed, chip "GPU effects unavailable/paused"; a CSS `preview` fallback of the spec is used if present | render fails `WEBGL_UNAVAILABLE` |

Stack order (FX-002; crop-order, schema v8): the stack in order, Crop where it sits (v7 drew Crop first; v7 projects
are migrated so their Crop comes first). The canvas chain covers the stack up to the last shader or colour effect, or
crop that needs it (Edge Feather, which runs as the `CROP_FEATHER_GPU` stand-in; a crop before a pixel-mixing effect
the colour stage would move ahead of it — [crop-order.md](crop-order.md)): shader effects, colour runs (one baked LUT per run, same shader as the colour stage),
CSS-filter effects (2D canvas filter), crop and flips run in exact order. Built-ins whose preview needs an SVG filter
at their params (Gaussian Blur with one direction or Repeat Edge Pixels) run as GPU stand-ins in the chain
(`compositions/src/fx/builtins.ts`), so their order is exact too; `reordered` now only lists effects with other
style fragments (none of the built-ins). Effects after the chain stay CSS/SVG wrapper stages. The corner pin is the
layer matrix (always last). Layers without shader effects keep the exact M1/M2 behaviour.

## 13. Families, ids, bins, badges

| File | Export | Ids | Bin |
|---|---|---|---|
| `premiere-adjust-color-keying.ts` | `PREMIERE_ADJUST_COLOR_KEYING_EFFECTS` | `jasper.*` | categories (Adjust, Color Correction, Keying) |
| `premiere-stylize-distort-generate.ts` | `PREMIERE_STYLIZE_DISTORT_GENERATE_EFFECTS` | `jasper.*` | categories |
| `sapphire-glows-lighting.ts` | `SAPPHIRE_GLOWS_LIGHTING_EFFECTS` | `jasper.s.*` | `SAPPHIRE_BINS.glows` / `.lighting` |
| `sapphire-paint-kaleido-edges.ts` | `SAPPHIRE_PAINT_KALEIDO_EDGES_EFFECTS` | `jasper.s.*` | `.stylize` |
| `sapphire-film-grain.ts` | `SAPPHIRE_FILM_GRAIN_EFFECTS` | `jasper.s.*` | `.stylize` |
| `sapphire-stylize-other.ts` | `SAPPHIRE_STYLIZE_OTHER_EFFECTS` | `jasper.s.*` | `.stylize` |
| `sapphire-adjust-composite.ts` | `SAPPHIRE_ADJUST_COMPOSITE_EFFECTS` | `jasper.s.*` | `.adjust` / `.composite` |
| `sapphire-blur-sharpen.ts` | `SAPPHIRE_BLUR_SHARPEN_EFFECTS` | `jasper.s.*` | `.blurSharpen` |
| `sapphire-distort-warp.ts` | `SAPPHIRE_DISTORT_WARP_EFFECTS` | `jasper.s.*` | `.distort` |
| `sapphire-render-textures.ts` | `SAPPHIRE_RENDER_TEXTURES_EFFECTS` | `jasper.s.*` | `.render` |
| `sapphire-time-flicker.ts` | `SAPPHIRE_TIME_FLICKER_EFFECTS` | `jasper.s.*` | `.time` |

The Effects panel lists Video Effects ▸ (bin or category) ▸ effect, with an RT badge (real-time preview) and a GPU
badge (Premiere's "Accelerated" badge) plus RT/N/GPU filter toggles. Premiere-standard effects that already exist
(crop, Gaussian Blur, brightness & contrast, hue/saturation, B&W, flips, corner pin, Lumetri) are not duplicated.

## 14. Tests to write (per family)

`packages/compositions/test/fx-gl.test.ts` renders GPU effects in real WebGL2 (headless Chrome,
SwiftShader) and compares their output with committed fingerprints. Run it before committing:

```bash
pnpm vitest run packages/compositions/test/fx-gl.test.ts
```

Add in your family's own test file (`packages/project/test/fx-<family>.test.ts` and/or
`packages/compositions/test/fx-<family>-gl.test.ts`):

1. Independently specified numerical contracts at their lowest stable seam; expected values must not repeat
   the production formulas or assert private uniforms/pass structure.
2. Pixel behaviour of each effect in real WebGL: copy the pattern of `test/fx-gl/entry.ts` (`run(spec, params, box,
   paint)` → pixels) — at least: identity/default params, one characteristic pixel per effect, padding when you draw
   outside the box, alpha (transparent input stays transparent where it should).
3. Determinism of random effects: same params → same pixels; different `seed` → different pixels.
4. Time effects: observable frame output against independent expectations, with a representative REMOTION_E2E
   render (pattern: `fx-render.e2e.test.ts`, which bundles `test/fx-render/entry.ts` with extra effects via `setFxEffectRegistry`).

Commands: `pnpm typecheck`, `pnpm lint`, `pnpm vitest run <paths>`, full `pnpm test`; browser suites:
`REMOTION_E2E=1 pnpm vitest run packages/compositions/test/fx-render.e2e.test.ts packages/compositions/test/fx-player.e2e.test.ts`
(needs Chrome and ffmpeg). `FX_GL=0` skips the GL test where no Chrome exists.

## 15. GLSL library (include what you use)

| Chunk | Functions |
|---|---|
| `GLSL_HASH` (fx/hash) | `fx_pcg`, `fx_hash1/2/3(ivec, seed)`, `fx_hash22`, `fx_hash33`, `fx_random(px, frame, seed)` |
| `GLSL_NOISE` (fx/noise) | `fx_valueNoise(3)`, `fx_gradientNoise`, `fx_simplex(vec2, seed)`, `fx_simplex3(vec3, seed)`, `fx_fbm(3)(p, octaves, lacunarity, gain, seed)`, `fx_turbulence`, `fx_ridged`, `fx_cellular(p, jitter, seed)` → (F1, F2), `fx_cellId`, `fx_noise01` |
| `GLSL_COLOR` (fx/color) | `fx_luma` (Rec.709), `fx_saturate`, `fx_srgbToLinear`/`fx_linearToSrgb`, `fx_rgb2hsv`/`fx_hsv2rgb`, `fx_rgb2hsl`/`fx_hsl2rgb`, `fx_hueShift`, `fx_brightnessContrast`, `fx_tint` |
| `GLSL_BLEND` (fx/blend) | `fx_blendRgb(mode, base, top)`, `fx_blend(mode, base, top, opacity)` (premultiplied), `fx_over`, `fx_addLight`, `FX_BLEND_*` |
| `GLSL_SAMPLE` (fx/sample) | `fx_sampleEdge(t, uv, mode)`, `fx_sampleTransparent`, `fx_sampleLayer(t, layerNorm, mode)`, `fx_mirrorUv`, `FX_EDGE_*` |
| `GLSL_UV` (fx/uv) | `fx_rot`, `fx_rotateAround`, `fx_scaleAround`, `fx_toPolar`/`fx_fromPolar`, `fx_deg`, `fx_dir`, `FX_PI`, `FX_TAU` |
| `GLSL_BLUR` (fx/blur) | `fx_gaussian1d(t, uv, dir, texel, sigma)`, `fx_box1d`, `fx_blur9`, `fx_zoomBlur`, `fx_gaussianWeight` |
| `GLSL_COMPOSITE` (fx/composite) | `fx_finish`, `fx_mixOriginal`, `fx_matteView`, `fx_lumaMatte`, `fx_colorDistanceMatte`, `fx_applyMatte`, `fx_setAlpha`, `FX_SHOW_*` |
| `GLSL_LUT` (fx/lut) | `fx_lut3d(highp sampler3D t, vec2 size, vec3 rgb)` (identity when size.x < 2), `fx_lutMix(t, size, rgb, amount)` |

Pass builders: `gaussianBlurPasses({input, output, sigma, sigmaY?, scale?, format?})` (H + V passes; outputs
`<output>H`, `<output>`; a sigma is canvas px, or `{uniform: 'u_x'}` — any float GLSL expression of your
`gpu.uniforms`, e.g. `'u_sig.y'`, evaluated per frame so animated radii keep their programs and plans; numeric
sigmas produce exactly the wave-1 programs), `bloomPyramidPasses({input, prefix, levels})` (½, ¼, … downsamples
`u_<prefix>0…`).
Shared GLSL you need in several of your own effects: keep it as a `GlslChunk` in your family file (name it
`<family>/<name>`); propose additions to the library to the integrator instead of editing `glsl/*`.

## 16. Runtime notes and limitations (wave 1)

- One WebGL2 context per page runs all shader effects (and the LUT passes of fx layers), programs compiled once per
  page and cached by source; the effects are Remotion `2d` canvas effects that blit the GL result. Intermediates are
  pooled by size (LRU 48).
- Preview resolution = the layer's intrinsic size × the Program monitor's playback resolution (Full, 1/2, 1/4, 1/8 →
  `RenderOptions.fxPreviewScale`; renders always full): at 1/2 the canvases are drawn at half size and stretched, and
  `u_pxScale` / `ctx.pxScale` halve, so px-based params keep their on-screen size (§18 units).
- Composition clips run shader effects only on the cached preview/master, not on the live host iframe.
- DOM layers need HTML-in-Canvas in the preview (see §12); no time samples there. HTML-in-Canvas requires the element
  to be in the viewport in renders (a DOM layer entirely outside the frame with a padded effect reaching into it is
  not captured).
- `curve` and `string` params are not mapped to uniforms (use `paramsAt` / `ctx.clip` in TS hooks and pass numbers).
- The on-canvas handles cover `point` params only (no angle/radius gizmos).
- Engine-level REMOTION_E2E tests cannot use test-only effects (the engine bundles the production registry); the
  render path is verified with `@remotion/renderer` directly and the same browser options.

## 17. Follow-ups (wave 2b, `wave2b/fx-framework-followups`)

All additive: an effect that does not use a new field draws exactly what it drew before (same values; only program
source TEXT changed, because unused declarations are now dropped).

### 17.1 Params at other times — `ctx.paramsAt(frame)`

`FxFrameContext`, `FxPlanContext` (padding, function passes) and `FxTimeContext` (time hooks) carry
`paramsAt?: (frame: number) => EffectParams`: the params of THIS instance at another clip-local frame of the real
time, fractional frames allowed, evaluated from the clip's keyframes by the shared `evaluate()` (content time, clip
in-point, speed, reverse — `fxClipContentTime`). `paramsAt(ctx.frame)` returns the very `p` object the hook got.
It is a pure function of the document: Player, stills and parallel renders agree. Absent in unit tests and the
catalogue checks: always write `ctx.paramsAt?.(f) ?? p` or skip the feature without it.

```ts
uniforms: (p, ctx) => {
  const shutter = 0.5;                               // frames, centred on the frame
  const poses = Array.from({ length: 8 }, (_, i) =>
    poseOf(ctx.paramsAt?.(ctx.frame + ((i + 0.5) / 8 - 0.5) * shutter) ?? p));
  return { u_n: { int: 8 }, u_poses: { vec4s: poses.flat() } };
}
```

Helpers: `fxParamsAtFn(instance, clip, fps, current?)` (what the host uses), `fxClipContentTime`. Users: Premiere
Transform (Shutter Angle), S_BlurMoCurves, S_WarpCornerPin / S_WarpPerspective (Motion Blur), Write-on (stroke).
For motion blur do not hand-roll shutter samples like this sketch: use `planMotionBlur` (§19), which bounds the
uniforms, adapts the tap count to the travel and collapses to the single-sample path when nothing moves (exact old
output).

### 17.2 Clip context — `ctx.clip`

`ctx.clip?: FxClipInfo` = `{clipName, itemName (project item), fileName, sourceInSeconds (in-point), sourceStartTimecode
(the media's embedded `HH:MM:SS:FF` or null), speed, reverse, duration}` in every hook. `fxSourceSeconds(clip,
frame, fps)` = media seconds shown at a clip-local frame. The snapshot carries the media part as
`RenderVisualClip.sourceInfo` (media clips with effects). Users: Clip Name (Display: Sequence Clip Name / Project Item
Name / File Name / Custom; instances without a Display value keep their Name), Timecode (Media = source timecode).

### 17.3 Stack time — remaps and samples compose

`fxStackTime(steps, ctx)` (the host calls it with every enabled effect that has time hooks, in stack order) gives the
layer source frame (`fxSourceFrame`: nested remaps, §9) and, per effect, the source frame of each sample: the frame
the effect is asked for (the real frame mapped by the remaps of the effects AFTER it in the stack) through its own
remap, + the offset, then mapped through the remaps of the effects BEFORE it. `time.sampleEdge` decides samples outside the drawn span: `'drop'` (default; `u_sampleCount == 0`
for the frame, as in wave 1 but never stale), `'transparent'` (positional, transparent picture), `'clamp'` (nearest
frame of the span). `u_sampleValid` (int bitmask): bit i set when sample i shows its own frame. Samples of a layer
are fetched once per distinct source frame (slots `sample@<frame>`) and uploaded once per frame (keyed upload).

### 17.4 Passes: ping-pong, absolute sizes, mipmaps

- `update: true` + an existing `output` name = ping-pong: the host alternates two textures per name (`FxPassPlan
  .target` = `<first>` / `<first>~`), the pass reads the previous contents as `u_<name>`. A 66-pass bitonic sort,
  a jump flood or an accumulation loop uses ONE name (the 12-texture rule counts names). Generate the steps in a
  `passes` function; the GLSL of every step should be the same text with the step in pass `uniforms` (one program).
- `size: {width: 64, height: 1}`: absolute output size (histograms, LUT rows, global statistics). Read it with
  `texture(u_<name>, uv)` / `texelFetch(u_<name>, ivec2(i, 0), 0)`.
- `mipmaps: true` on a pass: its output gets a mip chain after drawing; `gpu.sourceMipmaps: true`: `u_source` has one
  in every pass of the effect. Sample with `textureLod(t, uv, lod)` (lod = log2 of the footprint in texels) or
  `textureGrad`. Only opt in where you need it: with mipmaps, plain `texture()` in minifying mappings filters.

### 17.5 Uniform types

`{ivec2: [a, b]}` / `{ivec3}` / `{ivec4}` → integer vectors; `{vec4s: [...]}` → `vec4 u_x[n]` (4·n numbers). Prefer
`vec4s` over `{floats}` for long lists: every `float` array element takes a whole vec4 register on many drivers
(WebGL2 guarantees only 224 fragment uniform vectors in total).

### 17.6 LUT assets — `lutParam`

`lutParam(name, label)` = a `media` param with `mediaKinds: ['lut']` (the inspector lists the project's `.cube`
assets). Bound as `uniform highp sampler3D u_<name>` + `vec2 u_<name>_size` = (N, 1), (0, 0) when none/offline. 1D
LUTs and custom DOMAIN_MIN/MAX are baked to 33³ first, so `fx_lut3d(u_x, u_x_size, rgb)` (`GLSL_LUT`, identity when
none) is all a shader needs. Renders wait for the asset like colour-run LUTs. Users: S_ColorFuse (`lut1File`…
`lut3File` override the image/look of each slot), S_VHS (`lut1File`, `lut2File`).

### 17.7 Time dependence

`gpuIsTimeDependent(spec, params?, mediaKind?)`: a `media` param bound to a VIDEO makes a `timeInvariant` effect
time dependent (the picture plays). The composition (re-render per frame), the stage and the layer-bake planner
(no still bake) use it.

### 17.8 SVG-only built-ins, preview resolution

- One-direction Gaussian Blur / Repeat Edge Pixels inside an fx chain run as a GPU stand-in in stack order
  (`chainGpuStandIn`, per-axis σ, Repeat Edge = clamped sampling in the box, otherwise padded by 3σ).
- `RenderOptions.fxPreviewScale` (the Program monitor's playback resolution) scales the canvases; `u_pxScale`
  follows. Renders ignore it.

### 17.9 SwiftShader compile budget

`packages/compositions/test/fx-compile-budget.test.ts` compiles, links and draws EVERY distinct program of every
registered effect and transition (default params) plus the library noise/hash helpers inside loops on SwiftShader,
and fails when one takes longer than `FX_COMPILE_BUDGET_MS` (default 5000 ms); it prints the slowest programs
(`FX_COMPILE_REPORT=path.json` writes them all; `FX_COMPILE_FILTER=<id part>`; `FX_COMPILE_WORKERS`). Run it after
adding noise-heavy effects:

```bash
pnpm vitest run packages/compositions/test/fx-compile-budget.test.ts
```

## 18. Pitfalls

- **`filter` is a reserved word in GLSL ES 3.00** (so are e.g. `sample`, `input`, `output`, `common`, `partition`,
  `active`, `patch`, `resource`, `class`, `union`, `enum`, `typedef`, `template`, `this`, `goto`, `inline`, `public`,
  `static`, `extern`, `external`, `interface`, `long`, `short`, `double`, `half`, `fixed`, `unsigned`, `cast`,
  `namespace`, `using`, `sizeof`, `asm`, `volatile`, `superp`): a param named `filter` becomes `u_filter` (fine), but a
  local variable, function or parameter named `filter` / `sample` / `input` does not compile. Name them `filt`,
  `smp`, `inp`.
- **Noise in loops on SwiftShader.** Software GL inlines every call and unrolls constant loops; code with many
  selects (`?:`, data-dependent `if` on scalars) per call explodes its compile time super-linearly. The library
  helpers are branch-free (`fx_u`), so `fx_simplex3`, `fx_fbm*`, `fx_cellular`, `fx_valueNoise3` in loops compile
  in < 0.5 s (they took 20–60 s and more before). Still: prefer dynamic loop bounds (`for (k < 12) if (k >= n)
  break;` or `k < int(u_n)`) over large constant ones, hoist seed hashing out of loops, and check new effects with the
  budget test (§17.9).
- **Sampler budget.** WebGL2 guarantees 16 texture units per pass: the framework uses `u_source`, `u_prev`,
  `u_samples` (+ a dummy array) — keep ≤ 12 of your outputs + media/LUT params *mentioned in one pass* (the
  12-distinct-names rule; ping-pong updates do not add names). 3D LUT params count like pictures.
- **Uniform budget.** ≤ 224 vec4 per fragment shader: pack lists in `vec4s`, bound sample counts (16 shutter
  samples × 2 vec4 is fine, 256 floats is not).
- **Units.** Layer px params × `u_pxScale` (or `ctx.pxScale`) = canvas px — the preview scale and huge-layer downscale
  both go through it, never assume 1. Points are layer-normalised (0..1 over the box), angles degrees clockwise,
  percentages 0..100, Sapphire "units" a fraction of the layer width/height as each family documents, time in
  clip-local frames (`u_frame`, `paramsAt`) or seconds (`u_time`), shutter lengths in frames centred on the frame.
- **Exactness when adding features to an effect.** Keep the old code path for the old parameter values (e.g.
  `if (u_n > 1) { new path } else { old body unchanged }`) and new params' defaults neutral: existing documents and
  pixel tests must not change.
- **Determinism.** No state between frames: accumulate from `paramsAt` (Write-on draws the whole path every frame)
  or from time samples, never from the previous output.
- **Motion blur.** Do not average a fixed handful of shutter samples (8 ghost copies of a fast move): use the
  adaptive shutter of §19.
- **Razor cuts (spec 19 TL-121).** A split gives the right part new ids, but its GPU effects keep
  `EffectInstance.patternOrigin`: `u_seed` hashes the origin's ids and `u_frame` / `u_time` continue from the cut. A hook
  that hashes a frame number for per-frame noise reads `fxPatternFrame(ctx)` (= `ctx.frame` + the origin's frame), not
  `ctx.frame`; progress, durations, keyframes (`paramsAt`) and source time keep `ctx.frame`. Details:
  [title-looks-fixes.md](title-looks-fixes.md).
- **Float targets (TL-123).** The host falls back from `rgba16f` / `rgba32f` to 8 bits without `EXT_color_buffer_float`.
  An effect that is wrong on 8 bits (linear-light compositing, distance fields) sets `gpu.requiresFloat` (`true`, or a
  refusal code string): the preview bypasses it with a chip, the export plan and the render refuse by name.
- **Padding is read by the bake (TL-122).** `gpu.padding` also sizes the layer bake's crop (`contentBleed`), evaluated
  per frame for animated params: a padding that is too small clips the glow in exports, too large only costs pixels.

## 19. Adaptive shutter motion blur (wave 5, `wave5/adaptive-motion-blur`)

Every moving effect or transition blurs with the same helper, so a fast move is one continuous smear (no ghost copies,
no periodic peaks) and a slow one stays cheap. TypeScript: `registry/fx/motion-blur.ts`; GLSL:
`registry/fx/glsl/motion-blur.ts` (`GLSL_MB`, `GLSL_MB_POSES`). Both are exported from `@jasper/project`; family
files may import `./motion-blur.ts` like `./params.ts`.

### 19.1 The model

- **Shutter**: a box shutter over an interval relative to the frame, in frames. `centredShutter(length, shift = 0)` =
  Sapphire's Mo Blur Length (centred; S_BlurMoCurves' Shutter Shift moves it), `angleShutter(angle, phase =
  −angle/2)` = Shutter Angle / 360 (Premiere's Transform: centred; After Effects' phase when an original has one).
  No tent / smooth weighting: none of the originals exposes one.
- **Poses at exact sub-frame times**: `planMotionBlur` evaluates the effect's pose function (usually
  `ctx.paramsAt(f)` + the effect's maths, or a procedural pose such as S_Shake's) at `FX_MB_KEYS` = 32 key times over
  the shutter, both ends included (`mbKeyTimes`), passed as `u_mbKeys` (32 × stride vec4). The shader interpolates
  them linearly (`fx_mbPose`): 31 segments per shutter stay well under a pixel from curved, rotating and eased paths
  (a 90° turn at 500 px radius: 0.15 px), at half the per-tap cost of a Catmull-Rom spline in SwiftShader (measured:
  64 taps at 960×540, 245 ms linear vs 450–540 ms spline vs 130–165 ms for a bare tap loop).
- **Tap count**: the longest path (summed over the key segments) of the tracked points — the layer box corners and
  centre as they move on the output, so rotation and zoom count — in PASS pixels: `taps = clamp(ceil(path /
  spacing), 1, max)`. Auto: 1 px spacing (a partition of unity for bilinear taps: a flat smear profile), ≤ 64 taps;
  Draft: 2.5 px, ≤ 16; High: 1 px, ≤ 96 (`FX_MB_TAP_LIMIT`, the shaders' loop bound). Because the points are in canvas
  px (`ctx.pxScale`), a ½ preview resolution takes half the taps.
- **Time warp**: taps are placed by the measure 0.25 · time + 0.75 · path length (`mbTimeWarp`, a 32-entry table
  `u_mbWarp`), each weighted by the time its stratum lasts (`fx_mbTap` returns (s, weight)). A burst inside the
  shutter (an ease, a Twitchy shake) gets taps where it moves; the weights keep the exposure of a box shutter. Constant
  speed → identity warp, all weights 1.
- **Jitter**: stratified, one offset per pixel (`fx_mbJitter`: the R2 low-discrepancy lattice over the pass pixels +
  `u_seed`, integer maths — blue-noise-like grain, identical on every GPU, independent of the frame, so renders are
  reproducible in any frame order). Only used when the taps are sparser than the spacing (capped or warped).
- **No motion → identical output**: blur off, an empty shutter, identical packed poses or a travel < 1/1000 px give
  `taps = 1` (`mbStaticPlan`) and the shader runs the unblurred code path unchanged (exact old pixels: checked against
  checksums of the pre-wave-5 code in `fx-motion-blur-gl.test.ts`).
- **Software GL**: write the per-tap choice of a uniform branch with `if / else`, not `?:` — SwiftShader evaluates
  both arms of a select (S_Shake's RGB / mono taps).

### 19.2 Using it in an effect

```ts
import { GLSL_MB_POSES } from './glsl/motion-blur.ts';
import { centredShutter, mbQualityParam, mbStaticPlan, mbUniforms, planMotionBlur } from './motion-blur.ts';

params: [..., fxParam.toggle('motionBlur', 'Motion Blur', false),
         fxParam.number('moBlurLength', 'Mo Blur Length', 1, { min: 0, softMax: 2, step: 0.01 }),
         mbQualityParam()],                       // advanced "Mo Blur Quality": Auto (default) / Draft / High
gpu: {
  uniforms: (p, ctx) => {
    const at = ctx.paramsAt;                      // absent in unit tests: no blur
    const plan = bool(p.motionBlur) && at
      ? planMotionBlur({
          frame: ctx.frame,
          window: centredShutter(num(p.moBlurLength, 1)),
          poseAt: (f) => poseOf(at(f)),           // exact pose at a sub-frame time
          points: (q) => boxCornersAndCentre(q).map(([x, y]) => [x * ctx.pxScale, y * ctx.pxScale]), // canvas px
          pack: (q) => [q.x, q.y, q.angle, q.scale], // stride × 4 numbers (interpolated component-wise)
          stride: 1,
          quality: p.mbQuality,
        })
      : mbStaticPlan(1);                          // same uniform sizes every frame
    return { ...myUniforms(p), ...mbUniforms(plan) }; // u_mbPlan (ivec4), u_mbKeys, u_mbWarp
  },
  passes: [{ include: [GLSL_MB_POSES], frag: /* glsl */ `
void main() {
  if (!fx_mbOn()) { fragColor = shade(u_x, u_y, u_angle, u_scale); return; }   // unchanged path
  int n = fx_mbTaps();
  float j = fx_mbPlanJitter();
  vec4 acc = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < fx_mbDyn(FX_MB_TAP_LIMIT); i++) {   // opaque bound: SwiftShader does not unroll
    if (i >= n) break;
    vec2 t = fx_mbTap(i, n, j);                  // (shutter time 0..1, weight)
    vec4 q = fx_mbPose(0, t.x);                  // part 0 of the pose at that time
    acc += shade(q.x, q.y, q.z, q.w) * t.y;
    wsum += t.y;
  }
  fragColor = acc / max(wsum, 1e-6);
}` }],
}
```

Pose packing rules: interpolate quantities that vary smoothly (positions, angles in radians — unwrap
across ±π if they come from atan2 —, log or plain zoom, matrix entries normalised to a fixed scale: S_WarpCornerPin
divides each inverse homography by its w at the quad centre; S_Shake packs (dx, dy, cos θ / zoom, sin θ / zoom) so a
tap needs no trigonometry). Keep `stride` fixed (the uniform's length must not
change). Pick tracked points whose screen motion bounds what the user sees: forward-mapped box corners + centre;
for inverse-only warps project fixed source points forward (S_WarpPerspective's `perspectiveHit` /
`perspectiveProject`). Effects that supersample (minifying warps) keep a reduced supersampling per tap (2–3 per axis
once there are 8–32 taps).

### 19.3 Transitions and GLSL-only motion

Transitions (and effects whose motion is a GLSL function of progress or time) use `GLSL_MB` directly:

```glsl
float h = fx_mbShutter(p, blurFrames, frameStep);         // half width in progress, shrunk at the ends (exact A / B)
float ext = abs(travel(p + h) - travel(p - h)) * sizePx;  // on-screen path length (sum segments if not monotonic)
int n = fx_mbTapCount(ext, 64);
float j = fx_mbJitterFor(ext, n);
for (int i = 0; i < fx_mbDyn(64); i++) {
  if (i >= n) break;
  acc += pictureAt(mix(p - h, p + h, fx_mbTapAt(i, n, j)));   // the REAL pose at the tap (eases, scale, rotation)
}
fragColor = acc / float(n);
```

Premiere's modern transitions wrap it as `pm_shutter(p, blur%, frames)` (`premiere/modern`); the Sapphire swish
family's `sw_taps` / `sw_shutter` are the same model (1.5 px spacing, white-noise jitter). Blur helpers that are not
shutters (directional / zoom / spin blurs) take `max(wave-3 count, fx_mbTapCount(extent, 64))` so short blurs keep
their exact taps and long ones stop banding (`pm_taps`).

### 19.4 Migrated (wave 5)

| Effect / transition | Before | Now |
|---|---|---|
| S_Shake, S_DissolveShake | 8 box samples of the pose | 32 key poses × 3 channels, ≤ 64 taps by travel (+ Mo Blur Quality) |
| S_WarpCornerPin, S_WarpPerspective | 8 samples (`DW_MB_SAMPLES`) | key pins / plane poses, ≤ 64 taps (+ Mo Blur Quality) |
| Premiere Transform (Shutter Angle) | 16 samples | key transforms, ≤ 64 taps by box-corner travel (+ Mo Blur Quality) |
| S_FreeLens (shake blur) | linear smear of the shift between ±dt, 8 taps | true shutter poses (shift, keystone, distortion), ≤ 64 taps (+ Mo Blur Quality) |
| S_BlurMoCurves | From → To straight interpolation (adaptive count) | the curves' 32 key transforms over the shutter |
| Premiere 3D Roll, Film Roll, Roll, Stretch, Pull / Spin / Travel Motion, 3D Spin, 3D Spinback, Whip | 8–32 straight taps around the current pose | real eased path, ≤ 64 taps by on-screen travel |
| Premiere Earthquake | 8 taps between two poses | shake evaluated at every tap, ≥ 8, ≤ 64 by path length |
| Directional / Radial / Zoom Blur transitions (`pm_*`) | 16 / 32 fixed taps | ≥ the old count, ≤ 64 by extent |
| S_StripSlide, S_StripSlideTransition | 12 / ≤ 32 straight taps | real eased slide, ≤ 64 taps |
| S_Retime (Motion Blur), S_FilmDamage (Shake Motion Blur) | 7 / 5 taps | ≥ the old count, ≤ 64 by extent |

Unchanged (already the reference): S_SwishPan, S_Swish3D, S_WhipLash, S_MochaWhip, S_HyperPush/Pull, S_FilmRoll
(adaptive `sw_taps`; S_FilmRoll's gate shake stays a linear smear of its per-frame jump — the shake model is
piecewise constant).

Known limits: Jumpy shakes jump instantaneously in the model (held random targets), so a jump inside the shutter is
two exposures linked by a faint streak (correct for a box shutter, not a smear); 32 keys resolve shakes up to ~10
cycles per shutter; the tap count is global per frame (worst tracked point), so slow parts of a rotating layer take
the taps of its corners.
