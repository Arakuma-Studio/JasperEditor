# fx shader framework — authoring guide (wave 1, `wave1/shader-framework`)

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
| Param builders (`fxParam.*`, `sapphireCommonParams`, `blendModeParam`, `edgeModeParam`, …) | `registry/fx/params.ts` |
| Pass builders (`gaussianBlurPasses`, `bloomPyramidPasses`) | `registry/fx/passes.ts` |
| Types, planning, uniforms, padding, seeds, time hooks, `validateGpuEffect` | `registry/fx/shader.ts` |
| GLSL library (`GLSL_HASH`, `GLSL_NOISE`, `GLSL_COLOR`, `GLSL_BLEND`, `GLSL_SAMPLE`, `GLSL_UV`, `GLSL_BLUR`, `GLSL_COMPOSITE`) | `registry/fx/glsl/*.ts` |
| Runtime (GPU host, chain, layers) — read only | `packages/compositions/src/fx/*` |
| Worked examples (test-only effects) | `packages/compositions/test/fx-examples.ts` |

Everything is exported from `@jasper/project` (framework) and `@jasper/compositions` (runtime).

**Import rule.** A family file imports values only from `./define.ts`, `./params.ts`, `./passes.ts`, `./shader.ts`
and `./glsl/*`, and only **types** from `../effects.ts` (`import type`). `effects.ts` imports the catalogue, so a value
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
| `passes` | `ShaderPass[]`, or `(params, ctx: FxPlanContext) => ShaderPass[]` when the number/settings of passes depend on params (pyramids, iterations). `ctx = {width, height (layer box px), pxScale, fps}`. |
| `kind` | `'filter'` (default) or `'generator'` (draws its own picture; `u_source` is still the input to composite over). Metadata. |
| `padding(params, ctx)` | Extra layer pixels the effect may draw outside its input's bounds: a number (all sides) or `{left, top, right, bottom}`. Clamped to 0…2048. |
| `uniforms(params, ctx: FxFrameContext)` | Derived uniforms for every pass, e.g. `{u_offsetPx: [dx, dy]}` (types from values, §5). `ctx` adds `frame`, `duration`, `seed`, `progress`. |
| `time.remap(params, ctx)` | Source-frame remap (§9). |
| `time.samples(params, ctx)` | Extra source pictures at frame offsets (§9). |
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

Limits: ≤ 12 named outputs + media params per effect; ≤ 8 time samples; canvas side ≤ 8192 px (bigger layers are
drawn downscaled, `u_pxScale` < 1).

## 4. Params → uniforms (naming `u_<paramName>`)

| Param type | GLSL | Value |
|---|---|---|
| `number` | `uniform float u_x` | as stored (percentages stay 0..100 — divide in GLSL) |
| `boolean` | `uniform bool u_x` | |
| `enum` | `uniform int u_x` | index in `options` (unknown value → the default's index) |
| `vec2` | `uniform vec2 u_x` | as stored |
| `color` | `uniform vec4 u_x` | straight RGBA 0..1 (premultiply yourself: `fx_premultiply`) |
| `media` | `uniform sampler2D u_x` + `uniform vec2 u_x_size` | the picture (premultiplied); size in px, `(0,0)` when none/offline |
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
`float u_x[n]`, `{mat3: [9 numbers, column-major]}` → `mat3`. Keep a uniform's type stable across frames.

## 5. Built-ins, coordinates, alpha

Declared in every pass (unused ones cost nothing):

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
| `sampler2DArray u_samples`, `int u_sampleCount`, `float u_sampleOffsets[8]` | Time samples (§9); use `fx_sample(i, uv)`. |

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
  clamped to the drawn span `[−headHandle, duration + tailHandle − 1]`; several remaps compose in stack order
  (remap is a layer-level operation: it changes the source of the whole stack). `ctx = {frame, fps, duration,
  headHandle, tailHandle, seed}`.
- **`time.samples(params, ctx)`** → up to 8 integer frame offsets relative to the (remapped) source frame, e.g.
  `[-1, -2, -3]` for trails/echo/time average. Read them with `fx_sample(i, uv)` (i in request order, `u_sampleOffsets[i]`
  is the offset; `u_sampleCount` how many are valid). Samples are the **raw layer source** (before any effect) in the
  canvas layout (same `v_uv` as `u_source`); put time effects first in a stack. Each sample is decoded for its own
  frame (a `<Freeze>`d decoder per offset), so samples are deterministic under random seek and in parallel renders.
  Out-of-span samples are transparent. `timeInvariant` is ignored with time hooks.
- Verified: freeze remap and an earlier-frame sample are exact in renders (`fx-render.e2e.test.ts`) and in the Player
  when paused (`fx-player.e2e.test.ts`).
- Limits: during **playback** in the Player each sample/remapped decoder seeks per frame — exact when paused or
  rendering, but it may lag or stutter while playing (cost grows with the sample count; keep ≤ 4 for real-time).
  Stills: samples equal the still. DOM layers (text, shapes, motion graphics): no samples (`u_sampleCount == 0`);
  remap works (the content is drawn at the remapped time). "Feedback" effects need an explicit window of samples.

## 10. Transitions hook

Wave-2 shader transitions are per-side effects on the outgoing/incoming clip. `u_progress` (0..1) and `u_side`
(1 outgoing, 2 incoming) come from `LayerProps.transition` (`packages/compositions/src/types.ts`), which the
transition framework fills (not set by anyone yet); without it `u_progress = u_clipProgress`, `u_side = 0`. In TS,
`FxFrameContext.progress` is the same value. A transition effect may also declare its own `progress` param if it must
be keyframable by users.

## 11. Export, native vs null, WebGL

- `native` stays unset (null). The planner routes a clip with any effect the native builder cannot render to the
  Remotion path (`uses effect <id>, which the native path cannot render`), where the compositions run your shader in
  headless Chrome (WebGL2 via ANGLE/SwiftShader). Today's native builder renders only crop, flips and the
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

Stack order (S03 §4.2, FX-002): crop first, then the stack in order. The canvas chain covers the stack up to the last
shader or colour effect: shader effects, colour runs (one baked LUT per run, same shader as the colour stage),
CSS-filter effects (2D canvas filter), crop and flips run in exact order. Effects after the chain stay CSS/SVG wrapper
stages. **Approximation:** an SVG-filter effect (e.g. one-direction Gaussian Blur) placed *before* a shader effect is
drawn after the chain (reported in the plan's `reordered`). The corner pin is the layer matrix (always last).
Layers without shader effects keep the exact M1/M2 behaviour.

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

Free for every entry (no plumbing): `packages/project/test/fx-catalogue.test.ts` (ids, prefixes, bins, description,
`validateGpuEffect`, registry + agent schema wiring) and `packages/compositions/test/fx-gl.test.ts`, which **compiles
and runs every registered GPU effect with default params in real WebGL2** (headless Chrome, SwiftShader). Run both
before committing:

```bash
pnpm vitest run packages/project/test/fx-catalogue.test.ts packages/compositions/test/fx-gl.test.ts
```

Add in your family's own test file (`packages/project/test/fx-<family>.test.ts` and/or
`packages/compositions/test/fx-<family>-gl.test.ts`):

1. Param maths you do in TS (`uniforms`, `padding`, `passes` functions, time hooks): unit tests (pure functions).
2. Pixel behaviour of each effect in real WebGL: copy the pattern of `test/fx-gl/entry.ts` (`run(spec, params, box,
   paint)` → pixels) — at least: identity/default params, one characteristic pixel per effect, padding when you draw
   outside the box, alpha (transparent input stays transparent where it should).
3. Determinism of random effects: same params → same pixels; different `seed` → different pixels.
4. Time effects: hook outputs per frame (pure) and, for one representative effect, a REMOTION_E2E render (pattern:
   `fx-render.e2e.test.ts`, which bundles `test/fx-render/entry.ts` with extra effects via `setFxEffectRegistry`).

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

Pass builders: `gaussianBlurPasses({input, output, sigma (canvas px), scale?, format?})` (H + V passes; outputs
`<output>H`, `<output>`), `bloomPyramidPasses({input, prefix, levels})` (½, ¼, … downsamples `u_<prefix>0…`).
Shared GLSL you need in several of your own effects: keep it as a `GlslChunk` in your family file (name it
`<family>/<name>`); propose additions to the library to the integrator instead of editing `glsl/*`.

## 16. Runtime notes and limitations (wave 1)

- One WebGL2 context per page runs all shader effects (and the LUT passes of fx layers), programs compiled once per
  page and cached by source; the effects are Remotion `2d` canvas effects that blit the GL result. Intermediates are
  pooled by size (LRU 48).
- Preview resolution = the layer's intrinsic size (4K footage → a 4K canvas): heavy multi-pass effects on 4K layers
  are not real-time on weak GPUs; there is no preview-resolution scale yet (`u_pxScale` is ready for it).
- Composition clips run shader effects only on the cached preview/master, not on the live host iframe.
- DOM layers need HTML-in-Canvas in the preview (see §12); no time samples there. HTML-in-Canvas requires the element
  to be in the viewport in renders (a DOM layer entirely outside the frame with a padded effect reaching into it is
  not captured).
- `curve` and `string` params are not mapped to uniforms.
- The on-canvas handles cover `point` params only (no angle/radius gizmos).
- Engine-level REMOTION_E2E tests cannot use test-only effects (the engine bundles the production registry); the
  render path is verified with `@remotion/renderer` directly and the same browser options.
