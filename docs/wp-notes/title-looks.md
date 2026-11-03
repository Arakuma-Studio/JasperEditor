# Title Looks: decisions, contract and how to extend

Owner note of [spec 19](../specs/19-title-looks.md). If you add a layer type, a finish or a generator, read "How to
extend" and the spec section of your stream: you do not need anything else.

## What exists

A look on a clip is **one effect instance**, `jasper.title-look` (internal: never in the Effects panel, `effect.add`
refuses it). Its `EffectInstance.appearance` (TL-011) is an ordered stack of layers with a palette, a light and a seed.
Everything else follows from that being an effect: split, duplicate, copy and paste, Effect Controls placement, export
routing and the layer bake need no per-kind code.

| Piece | File |
|---|---|
| Model, zod schemas, limits, ids | `packages/project/src/title-looks/model.ts` |
| Evaluated at a frame | `packages/project/src/title-looks/resolve.ts` |
| INV-APPEARANCE, `repairAppearance`, project looks | `packages/project/src/title-looks/validate.ts` |
| Recipes (looks as authored: no ids, no Animatables) | `packages/project/src/title-looks/recipe.ts` |
| Diff and rebase of overrides, colourways, look bodies | `packages/project/src/title-looks/overrides.ts` |
| `lookOverrides` upkeep at the end of a transaction | `packages/project/src/title-looks/normalize.ts` |
| Paths, property keys, property specs | `packages/project/src/title-looks/properties.ts` |
| Factory library (data) | `packages/project/src/title-looks/factory/` |
| Commands (TL-018) | `packages/project/src/commands/{schemas,handlers}/title-look.ts` |
| Extension contract, `lp` builders, summaries | `packages/project/src/registry/fx/title-look/contract.ts` |
| Catalogue (nothing else lists types) | `packages/project/src/registry/fx/title-look/registry.ts` |
| Pass planner, padding, uniforms | `packages/project/src/registry/fx/title-look/plan.ts` |
| Shared GLSL (surface, field, blur) | `packages/project/src/registry/fx/title-look/glsl.ts` |
| Paints and gradients | `packages/project/src/registry/fx/title-look/paint.ts` |
| Layer types, finishes, generators | `packages/project/src/registry/fx/title-look/{layers,finishes,generators}/` |
| What generators share: noise, the shape, stable sites | `packages/project/src/registry/fx/title-look/generators/shared.ts` |
| Test harness | `packages/compositions/test/title-look-harness.ts`, `title-look-gl/entry.ts` |
| Registry completeness, GL, fuzz, E2E | `packages/project/test/title-look*.test.ts`, `packages/compositions/test/title-look*.test.ts` |
| Generator behaviour (time, identity), contact sheets | `packages/compositions/test/title-look-generators-gl.test.ts`, `title-look-generators-sheets.test.ts` |

## How a frame is drawn

`render/scene.ts` resolves the appearance at the clip's content time (`ResolvedEffect.appearance`), `fx/stage.ts` hands it
to the planner through `FxStructures.titleLook`, and `planTitleLook` returns ordinary `ShaderPass`es, in the same code for
the Player and for Remotion (TL-030):

1. **Alpha bounds** (only when something reads `tl_bounds()`): a reduction of the input to one `rgba32f` texel.
2. **Shape field** (TL-031): edge seeds → jump flood (`tlFlood`, `rgba32f`, starts at the power of two covering the reach,
   ends with a JFA+1 step) → `tlField` (`rgba16f`): signed distance in canvas px (+ outside), the opacity of the nearest
   edge, the vector to it.
3. **Composite** (TL-032): `tlComp` (`rgba16f`, linear light, premultiplied) starts empty; each enabled layer adds one
   pass, bottom-first, preceded by its prepasses and its blur.
4. **Output**: `tlComp` back to the framework's signal (sRGB-encoded, premultiplied).

Passes are one program per (layer type, paint kinds, finish): layer values are pass uniforms, so programs are shared across
looks and compile once. A six-layer look with a blur plans about 25 passes. Measured cost: `docs/performance.md` §7.

## Decisions

- **Local threshold.** A fixed 0.5 alpha threshold is fine for still images (Pachislop), but on animated text a glyph fading
  in would get no rim until it crossed 50 % and then pop. The edge sits at half the local peak alpha (5×5), reaching 50 % once
  the peak is 75 %, and a rim inherits a nearby opacity that is full from 50 % local alpha up. Effect: a rim fades in with
  its glyph, reaching full strength when the glyph is half visible. Two pixels of reach matter: with a 3×3 window the outer
  pixels of a 2 px antialiased ramp read as a faint shape of their own and seed a false edge (visible as translucent wedges).
- **Face coverage is the input's alpha, not the field**, so the glyphs' antialiasing stays exactly as drawn.
- **Rims reach one pixel under what is above them** when they touch it, so antialiased edges never leak the background.
- **`source` paint.** TL-011 lists role, colour and gradient. Without a fourth kind a look on a still or a video would
  flatten it, and TL-093's per-word runs would have no way to keep their colour. `{kind: 'source'}` paints the clip's picture.
- **Gradients interpolate in the signal, composite in linear light.** A black to white ramp reads even, as in design tools;
  a 256-entry ramp in a data texture means one program for any stop count and no uniform budget.
- **Layer ids are unique inside their appearance, not the document.** `lookOverrides` and `look.update` match layers by id,
  so ids must survive split, duplicate and paste. `reidentifyClipChildren` therefore leaves them alone; it re-ids keyframes
  through its generic walk. ParamPaths always carry the effect id.
- **`lookOverrides` is derived.** Clips hold effective values (a missing look only unlinks them). The field names where they
  deviate (`{<layerId>: ['width', '$enabled'], $added, $removed, $order, $palette, $light}`) and is recomputed at the end of
  every transaction that touches a linked clip (`normalizeLookLinks`), so no command maintains it, and `param.set`,
  `keyframe.*` and `expression.*` work unchanged. `look.update` rebases from the clip itself against the look as it was.
- **Recipes keep layer identity by type and position** on `look.update`, because a recipe has no ids.
- **Time.** Layers read `u_tlTime`: content seconds, continuous across a razor cut, unlike `u_frame`. It is 0 for looks with
  nothing time dependent, so a still look has one step key and is not redrawn (TL-037). `seed` comes from the appearance,
  never from ids (TL-035). `FORBIDDEN_TITLE_GLSL` rejects `u_seed`, `u_frame`, `u_pxScale`, `gl_FragCoord` and float hashes.
- **Still looks and spurious paints (TL-037).** The step key of a still look does not change between frames, but that is not
  enough: on every Player seek React's Suspense hides and restores the composition (`display: none !important`), Chrome fires
  `paint` on the `<HtmlInCanvas>` and the chain runs with an unchanged input. For a still DOM picture under time-invariant
  steps the stage sets `inputKey` (the immutable clip object's identity plus the steps before), and `fxShader` keeps the output
  in a small LRU keyed by it and the loaded-fonts count (a late font changes the picture with no change to the clip). Preview
  only; renders never reuse. `calculateKey` includes `inputKey`: Remotion keeps the memoized params of an unchanged key, so
  without it a text edit would show the old look (the E2E test checks an edit redraws).
- **Float refusal** is TL-123's: `requiresFloat: 'TITLE_LOOK_NEEDS_FLOAT'` gives a chip in preview, `cancelRender` in a render and
  a plan blocker once the probe answered; the host guard is a backstop.
- **Media.** `{mediaId}` values in layer params go through `effectMediaRefs` and `clearEffectMedia` (named
  `appearance.<layerId>.<param>`), so orphans, item delete, usage, Project Manager and force delete all see them (TL-021).
- **`contentBleed`.** `gpu.padding` needs `FxStructures.titleLook`, which only the composition has, so the bake takes a look's
  reach from `titleLookBleed` directly: the keyed reach, or null (full-frame bake) when an expression drives a param.
- **Unit (TL-012).** Text: the text size, one uniform. Other clips: the shorter side of the alpha bounds, read from the
  reduction in the shader. Plan-time decisions there (flood steps, blur scale) use the layer box as an upper bound and three
  mip levels of margin, so a small logo in a huge transparent still blurs slightly coarser, never wrongly sized.
- **`block` span uses the alpha bounds of the frame** on every clip kind. It is exact for still text; under position
  animators the bounds follow the letters. TL-036 replaces this with layout boxes for text.
- **Sequence light** travels on the render clip (`sequenceLight`, keys in sequence time) only when a look follows it.

### A note on a false alarm worth keeping

`getImageData` returns **straight** alpha. The harness's `over()` and `lumaOver()` handle that; comparing raw `data` to a
premultiplied expectation looks like a shader bug. Look at the dumped picture before believing an SSIM.

## How to extend

Three rules: put your code in your own file, add one line to the list next to it, and never edit `plan.ts`, `glsl.ts`,
`registry.ts`, `validate.ts` or the commands. If you think you must, the contract is missing something: say so in your
report. Types in `contract.ts` are the normative reference.

Units: every distance is `lp.distance` (percent of the unit); convert in GLSL with `tl_px(u_x)`. Colours are linear,
premultiplied. Use `s.px`, never `gl_FragCoord`. Times are `u_tlTime`; randomness is `u_tlSeed` with `GLSL_HASH`.

### What a layer shader gets

```glsl
struct TlSurface {
  vec2 uv;        // canvas uv, (0,0) top-left
  vec2 px;        // canvas px
  float d;        // signed distance to the shape edge, canvas px, + outside
  float opacity;  // opacity of the nearest part of the shape
  vec2 toEdge;    // canvas px from here to the nearest edge point
  float base;     // canvas px: growth of the silhouette by the layers above this one
  float alpha;    // the input's alpha here
};
```

| Available | Meaning |
|---|---|
| `tl_px(percent)`, `tl_unit()` | percent of the unit → canvas px; the unit in canvas px |
| `tl_band(d, a, b)`, `tl_inside(d, edge)` | antialiased band and interior |
| `tl_over(under, top)`, `tl_linear(srgb)` | premultiplied over, signal → linear |
| `tl_surfaceAt(uv)`, `tl_sourceLinear(uv)` | the surface elsewhere (offsets), the input as straight linear colour |
| `tl_bounds()` | alpha bounds, canvas px `(x0, y0, x1, y1)`; mentioning it makes the planner run the reduction |
| `tlPaint_<param>(s)` | the value of paint param `<param>` here, premultiplied linear |
| `tl_finish(paint, s)` | the layer's finish (types with `finish: true`) |
| `u_<param>` | each param: number `float`, boolean `bool`, enum `int` (option index), vec2, colour `vec4`, media `sampler2D` + `u_<param>_size` |
| `u_tlLight`, `u_tlLightDir` | `vec3` unit vector to the light, `vec2` screen direction to it |
| `u_tlSeed`, `u_tlTime` | 0..1 from the appearance; content seconds (0 unless a layer is `timeDependent`) |
| `u_tlBlur` | the framework's blur of your `tl_mask`, when `blur` returns one |

### Worked example: a layer type

`packages/project/src/registry/fx/title-look/layers/inner-glow.ts`:

```ts
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const INNER_GLOW_LAYER: TitleLayerInit = {
	type: 'innerGlow',
	label: 'Inner Glow',
	description: 'Light inside the shape, from its edge inward.',
	finish: false,
	params: [
		lp.distance('radius', 'Radius', 12, { softMax: 60 }),
		lp.number('intensity', 'Intensity', 100, { min: 0, max: 1000, softMax: 300, step: 1 }, { unit: '%' }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'glow' }),
	],
	shader: () => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  float x = clamp(-s.d / max(tl_px(u_radius), 1.0), 0.0, 1.0);
  return tlPaint_paint(s) * (1.0 - x) * s.alpha * clamp(u_intensity * 0.01, 0.0, 1.0);
}`,
	}),
	// Inside the shape: it needs the field, but no padding.
	fieldReach: (p) => ({ inside: num(p.radius) + 1, outside: 0 }),
	handles: [{ kind: 'distance', params: ['radius'] }],
	summary(p) {
		return {
			swatch: layerSwatch(INNER_GLOW_LAYER, p),
			text: `${fmtDistance(p.radius)}, ${paintText(p.paint)}`,
			primary: 'radius',
		};
	},
};
```

One line in `layers/index.ts`:

```ts
export const TITLE_LAYER_INITS = [FACE_LAYER, RIM_LAYER, SHADOW_LAYER, GLOW_LAYER, INNER_GLOW_LAYER];
```

That gives you: params and defaults in every command and recipe, validation (INV-APPEARANCE, `param.set`, repair), padding,
the field reach, property specs for Effect Controls, the summary row, keyframes and expressions on every number, and the
registry and GL tests below. Types are stored in documents: never rename `type` or a param.

Fields you may need:

| Field | When |
|---|---|
| `reach(p)` | The layer paints outside the silhouette: percent of the unit, a number or per side. Padding adds the growth above it and takes the maximum across the clip's frames. Too small clips light; the GL test catches it |
| `grows(p)` | Layers below start from a larger silhouette (rims) |
| `fieldReach(p)` | The field must be right this far outside or inside. Default: outside as far as `reach`. Reads past it see `d` = the reach, a lower bound of the true distance |
| `blur(p, ctx)` | Return `{sigma, mask}`: `sigma` in percent of the unit, `mask` GLSL `vec4 tl_mask(TlSurface s)`. The framework runs mask → horizontal → vertical at the lowest resolution that holds the sigma and your pass reads `u_tlBlur`. Every radius is cheap at every size; use `tl_inside`/`tl_band` in the mask, which widen their antialiasing to fit |
| `prepass(p, ctx)` | Your own `ShaderPass[]` before the layer's pass. Budget: `FX_MAX_TEXTURES` names per plan; the framework uses `tlBounds`, `tlFlood`, `tlField`, `tlComp`, `tlMask`, `tlBlurH`, `tlBlur`. Reuse names with `update: true` |
| `timeDependent(p)` | The layer moves on its own: the clip then redraws every frame and `u_tlTime` is live |
| `handles` | On-canvas handles for TL-092 |
| `shader(p, ctx)` | It is a function: return different GLSL per enum to keep programs small (`shadow.ts`, `glow.ts`) |

### Worked example: a finish

`finishes/satin.ts` and one line in `finishes/index.ts`. Param names start with the finish id and must be unique across
finishes (they share the layer's `params` record):

```ts
import { defineFinish, lp } from '../contract.ts';

export const FINISH_SATIN = defineFinish({
	id: 'satin',
	label: 'Satin',
	description: 'Soft bands of light that follow the shape.',
	params: [lp.distance('satinSize', 'Size', 10, { softMax: 50 }), lp.percent('satinIntensity', 'Intensity', 40)],
	glsl: /* glsl */ `
vec4 tl_finish(vec4 paint, TlSurface s) {
  float x = sin(s.d / max(tl_px(u_satinSize), 1.0) * 3.14159);
  return vec4(paint.rgb * (1.0 + x * u_satinIntensity * 0.01), paint.a);
}`,
	fieldReach: (p) => ({ inside: Number(p.satinSize) * 2 }),
});
```

The `finish` param's options, validation of `satinSize` and `satinIntensity` on `face`, `rim` and any `finish: true` type,
property specs and the compile test all follow from that line.

### Worked example: a generator

`generators/rays.ts` and one line in `generators/index.ts`. It becomes the effect `jasper.generator.rays` in the `Generate`
category and the layer `generator:rays`, from the same GLSL (TL-060). `clip.addGenerator` takes either name:

```ts
import { GLSL_UV } from '../../glsl/sample.ts';
import { defineGenerator, lp } from '../contract.ts';

export const GENERATOR_RAYS = defineGenerator({
	id: 'rays',
	label: 'Rays',
	description: 'Rotating rays from the centre of the title.',
	params: [lp.number('count', 'Count', 12, { min: 1, max: 64, step: 1 }), lp.number('speed', 'Speed', 30, { min: -720, max: 720 })],
	include: [GLSL_UV],
	shapeAware: false,
	timeDependent: () => true,
	glsl: /* glsl */ `
vec4 tl_generate(TlSurface s) {
  vec2 q = s.uv - 0.5;
  float a = atan(q.y, q.x) + radians(u_speed) * u_tlTime;
  // Fades out before the canvas edge: the canvas ends at the look's padding, so declare `reach` for what you draw.
  float v = (0.5 + 0.5 * cos(a * u_count)) * (1.0 - smoothstep(0.25, 0.5, length(q)));
  return vec4(vec3(v), v);
}`,
});
```

Everything must be a closed form of `u_tlTime` and `u_tlSeed`: no history (TL-061). A standalone instance has no title: its unit
is a fifth of the shorter side of the box (title-sized, so a preset reads alike), and it reads the shape named by `standIn`:
`none` (`s.d` large, `s.opacity` 0), `ground` (the bottom of the frame) or `disc` (a title-sized disc in the middle).

Fields a generator may need, beyond those of a layer type:

| Field | When |
|---|---|
| `presets` | At least three (TL-063). Values over the defaults; `clip.addGenerator` and `appearance.addLayer` take `preset` |
| `color` | `{role, mode, fixed?}`: the default paint, `light` / `luma` / `flat`, and whether a new layer keeps its own colours (TL-051) |
| `prepass(p, c)` | Draw passes and analysis. Build each with `c.pass`, which brings the unit, the shape, `defines`, params as uniforms and the ping-pong write. Scratch outputs are `tlGenA`, `tlGenB`, `tlGenC`, shared by every generator of a look: read them before the next generator draws |
| `defines(p)` | `#define`s per hold-only value, so a program holds one branch. They reach pass text, not `include` chunks |
| `lowRes` | Soft pictures drawn at 1/n of the canvas side (`tlGenD`) and upsampled, in preview and export alike |
| `standIn`, `shapeAware`, `usesBounds(p)`, `fieldReach(p)`, `effectLabel` | The stand-in above; `tl_bounds()` in a chunk or prepass, which the planner cannot see; how far the field must be right; a panel name when `label` is taken |

Shape access: `tl_surfaceAt(uv)`, `tlg_d(uv)` and `tlg_field(px)` work in both worlds and in vertex shaders. `tlg_begin()` first, then
`tlg_h`, `tlg_vnoise`, `tlg_fbm`. A param must not be named `source`, `progress`, `time`, `side` or `seed`: `u_<name>` is a
built-in or forbidden; use `variationParam()` for a second pattern of one seed.

### Media inputs (TL-021)

A `lp.media('tile', 'Tile', ['image'])` param is bound for you as `u_tile` / `u_tile_size`, per layer, and counted as a media
use by `clipParamMediaIds`. `u_tile_size` is `(0, 0)` when none is bound: handle it.

### Tests you get, and the one you write

Your type or finish is covered automatically by `packages/project/test/title-look-registry.test.ts` (contract, defaults,
summary, forbidden GLSL) and `packages/compositions/test/title-look-gl.test.ts`: compile, a fingerprint at default and
perturbed params, a perturbation check, nothing clipped at the padding, and resolution independence at two scales. **A
registered type without recorded fingerprints fails**: run the GL test with `JASPER_BLESS=1`, look at the picture, and commit
`goldens/title-look-fingerprints.json`.

Write your own behaviour tests in `packages/compositions/test/title-look-<area>-gl.test.ts`:

```ts
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CHROME, type LookPage, openLookPage, pixel } from './title-look-harness.ts';

describe.runIf(!!CHROME)('inner glow', { timeout: 120_000 }, () => {
	let tl: LookPage;
	beforeAll(async () => { tl = await openLookPage(dirname(fileURLToPath(import.meta.url))); }, 120_000);
	afterAll(() => tl?.browser.close());

	it('is brightest at the edge', async () => {
		const img = await tl.render({
			recipe: { layers: [{ type: 'innerGlow', params: { radius: 20, paint: { kind: 'color', color: [1, 0, 0, 1] } } }] },
			input: { kind: 'rect', x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
			box: { width: 320, height: 160 },
			unitPx: 100,
		});
		const y = img.box.y + 80;
		expect(pixel(img, img.box.x + 82, y)[3]).toBeGreaterThan(pixel(img, img.box.x + 95, y)[3]);
	});
});
```

`tl.render` inputs: `text`, `rect`, `card`, and `shapes` (exact geometry at any size: use it for resolution checks; `fillText`
hints differently per size, so text scores low before your layer does anything). `data` is **straight** alpha.
`lumaOver(img)`, `over(img)`, `layerCrop`, `resampleLuma` and `ssim` compare pictures; compare at the smallest size.

Dump a PNG and look at it (`over()` + `encodePng` of `@jasper/testkit/png`). Assertions on a few pixels passed while the
first shape field drew translucent wedges.

## Commands (TL-018)

| Command | Notes |
|---|---|
| `look.apply {clipIds, lookId? \| look?, colorwayId?, seed?}` | A project look, a factory id, or a `{name, recipe, …}` source copied in on first use (TL-015). Reports `droppedKeyframes`. Keeps the seed of a replaced look |
| `look.remove`, `look.detach`, `look.reset {layerIds?}` | |
| `look.setColorway {clipIds, colorwayId?, palette?}` | Role values only; reports `keptAnimated` roles (they keep their keys) |
| `look.create {name, fromClipId? \| recipe?, link?}`, `look.update {lookId, fromClipId? \| recipe?}` | `update` keeps overrides and keys, skips locked tracks with `W_CLIP_SKIPPED` |
| `look.rename`, `look.delete` | A deleted look only unlinks its clips |
| `appearance.addLayer {effectInstanceId, layerType, index?, preset?, params?, name?}`, `removeLayer`, `reorderLayer`, `setLayerEnabled` | Without an index a generator goes behind the title, above other generators, unless it says `front` (TL-064) |
| `appearance.setPaint {…, param?, paint}`, `appearance.setGradient {…, param?, gradient}` | 33 stops → `E_LIMIT` |
| `sequence.setGlobalLight {angle?, altitude?, clear?}` | |
| `clip.addGenerator {effectId, at, duration, track?, belowClipId?, preset?, params?}` | A `transparent` solid with the effect, on a free track below `belowClipId`, or on a new track under it when none is free (TL-064). `effectId` takes `generator:<id>` |

Addresses: `["appearance", fxId, layerId, param]`, `["appearance", fxId, "palette", role]`, `["appearance", fxId, "light",
"angle"]`, `["globalLight", sequenceId, "angle"]`. Property keys join the first with dots. Slot names have no `$`: `$` starts
a temp ref in commands.

## Generators (spec 19 §7)

The sixteen of TL-061: Fire, Smoke, Corona, Sunburst, Magic Circle, Lens Flare, Backlight, Light Streaks, Shockwave, Particles,
Glints, Ink Splatter, Brush Swirl, Speed Lines, Lightning, Pattern. Each is one file, a `generator:<id>` layer and a
`jasper.generator.<id>` effect from the same GLSL (TL-060). Contact sheets: `GEN_SHEETS=1 pnpm exec vitest run
packages/compositions/test/title-look-generators-sheets.test.ts --maxWorkers=1` writes `/tmp/title-looks/sheets/generators-*.png`.

### How they relate to the effects already in the registry

None of these replaces an existing effect, and none reuses its name in the panel (`effectLabel`). What they add is the shape and
the look; where an existing effect already does the job on a picture, it stays the tool for that.

| New | Existing | Relation |
|---|---|---|
| Lens Flare (panel: Title Flare) | `jasper.lens-flare`, `jasper.s.lens-flare`, `jasper.s.lens-flare-auto-track` | Those model lenses (element chains, three lens types). This is Pachislop's single anamorphic flare: it centres on the title and recolours with the look. The lens element model was not reused: it needs a dozen Sapphire uniforms and a family-private chunk |
| Backlight | `jasper.s.rays`, `jasper.s.edge-rays` | Those beam from bright pixels or edges of a picture, as a filter. This one needs only the silhouette, and rotates its mask |
| Lightning (panel: Title Lightning) | `jasper.lightning`, `jasper.s.zap`, `jasper.s.ultra-zap`, `jasper.s.zap-to`, `jasper.s.zap-from` | Those are bolts between points. These start and end on the title's edge, read from the field |
| Particles | `jasper.particle-world`, `jasper.particle-systems`, `jasper.particle-playground`, `jasper.s.dust` | Those are stepped simulations with checkpoint caches, or a texture. This is closed form and scrubs exactly, emits from the shape, and sits in a look |
| Glints | `jasper.s.glint` and its rainbow variant | Those put rays on every highlight, as a filter, with nothing to keep across frames. This one has stars with identity |
| Brush Swirl | `jasper.write-on` | That paints along a keyframed brush from the clip start. This is a designed stroke with a write-on front |
| Sunburst, Speed Lines, Shockwave, Magic Circle, Ink Splatter, Fire, Smoke, Corona, Pattern, Light Streaks | none | Nothing in the registry draws these. Clouds and textures are full-frame noise with no shape; S_ streak filters smear a picture's highlights, Light Streaks draws its own |

### Time (TL-061)

No generator keeps state, and the framework has no place for it: `u_tlTime` and the seed are the only inputs besides params and the
shape, so frame N has one picture. `u_tlTime` is content seconds in a look and `fxPatternFrame(ctx) / fps` in a standalone effect:
the foundation read `ctx.frame`, which restarts at a razor cut.

- **Noise** scrolls and warps with `evolution + speed · t`. Keyframing `speed` jumps, as in After Effects; keyframe `evolution`
  for a change of pace.
- **Particles:** `x = t / life + phase`, age `fract(x)`, cycle `floor(x)`. The cycle re-seeds the birth, and an envelope hides the
  wrap. Position is exact at any age: `birth + direction · travel · (1 − e^(−k·age)) / (1 − e^(−k)) + g · seconds² / 2 + sway`.
- **Hold-frame boil:** a step number `floor(t · rate)` enters the hash, so every frame of a step is identical. Lightning re-strikes
  each bolt on its own beat of four steps. **Continuous:** the same noise slides.
- **Shockwave:** one Progress. Upstream reads noise at the current radius, which swims. The texture reads a frozen Texture Radius,
  so fibres keep their angle and scale with the ring. Loop Every only drives the same Progress.

### Stable identity (TL-062)

There is no history, so identity cannot be carried from frame to frame. It has to be a function of the seed and the current shape.

**Sites.** A particle, drop or bolt has a seeded site in the anchor box, and emits from the nearest part of the shape, read from the
shared field: `site + toEdge` on the outline, the site itself where it is inside for fill. The normal is the same vector. Nothing is
drawn from a list of the shape's pixels, so nothing re-rolls: Pachislop's rejection sampling changes every later particle when
one cell flips. A letter that moves disturbs only the sites near it; a typewriter wakes sites where they stand; a site with nothing
within Capture sleeps behind a smooth gate. Three things follow, and they are limits, not bugs:

- *Anchor.* `Layout` (the layer box, default) gives that locality. A title moved by clip Motion does not change the layer's pixels at
  all, so this is the common case and it is exact. A title moved whole by a text animator leaves its sites behind and wakes others:
  `Alpha Bounds` carries every site with it, at the price of locality (a letter that widens the bounds moves all sites).
- *Birth is read now.* A particle in flight flies from where its site's nearest edge is at this frame, not at its birth frame:
  that would need the shape's history. Per-letter animation carries a letter's particles with it.
- *Count.* Sites are spread over the box, so Count is a density: the share near the shape emits. A wide box with a small logo emits
  fewer. A nearest-edge flip across the medial axis between two letters moves a site across the gap; Capture smaller than the gap
  leaves no site there to flip. An inverse-CDF mapping of the shape's mass was considered: it gives an exact count and rigid letters,
  but a letter fading in slides every other particle, which breaks locality.

**Glints** run Pachislop's placement on the GPU every frame, with no read-back: a grid fixed in units of the title (so resolution does
not change it), luminance of what is below the layer (`tlComp`, so a metal face's highlights count), non-maximum suppression,
prominence, regional normalisation, face bias from the field, Hessian ridge rejection. Each of 64 seeded **homes** takes the strongest
peak under a Gaussian prior around it, in one pass per home; a star's jitter, rotation and twinkle belong to the home. That prior is
the hysteresis, and it is spatial, because a temporal one needs last frame: a peak must beat the one a star holds by the prior's
margin to take it. Greedy spacing runs in one pass over the 64 candidates, with smooth suppression that follows the score, not the
rank. Nothing pops: a star fades with its margin over the runner-up in its window, over the first home left out and over any rival it
suppresses, so a hand-over happens where both are invisible (Pachislop's `fade`, widened); peaks fade through the threshold and the
shape's edge; and homes on one peak are one star, shared by their priors, so a peak moving from one home to the next crossfades their
twinkles. No CPU data was needed, so `FxPixels` is not used.

Differences from upstream: normalisation is by the regional maximum only, because a global maximum would need one more reduction and
the regional one already lets a dim second line compete. Near ties within 4 % of the unit keep the stronger peak instead of blending
positions.

### Colour (TL-051)

A generator draws its own colours, plain `lp.color` params, the same as a standalone effect. As a look layer it gains `Own Colours`, a
paint and an opacity. With own colours off, its picture goes through a luma gradient map: brightness picks along the paint from
black up, and the hottest part goes white, so hot cores stay hot in any colourway. A gradient paint is the map itself. `light` reads
premultiplied brightness, `luma` the straight colour of a picture with real transparency (smoke, fire), `flat` takes the paint by
alpha (ink, brushes, which a luma map would leave black). Fire defaults to its own colours.

### Assumptions

Not documented anywhere; chosen by looking at sheets: the luma map's knees (0.55, 0.72), a standalone unit of a fifth of the shorter
side, Capture defaults, the prior's width (0.75 of a home's share of the box) and the fade margins of Glints (8 % of the top score,
30 % over the runner-up), the particle glow's shape, and every preset value, converted from Pachislop's px at 2 px per 1 % of a 200 px
title and tuned.

## Formulas and sources

- Jump flooding: Rong and Tan, "Jump flooding in GPU with applications to Voronoi diagram and distance transform" (I3D 2006);
  the extra step of 1 is their JFA+1. Steps start at the power of two covering the reach, so they sum to at least it.
- Sub-pixel seeds: the pixel centre moved along the Sobel gradient of alpha by `(a − threshold) / slope`, as Pachislop's
  `seedFrag` does; slope is the steeper one-sided difference along the normal, because edges arrive 1 to 2 px wide.
- sRGB: IEC 61966-2-1, the piecewise transfer of `fx_srgbToLinear` / `fx_linearToSrgb`.
- Composite: Porter and Duff "over" on premultiplied linear light.
- Blur: separable Gaussian, reach 3σ (a layer's `blur` and `radius` are the visible radius ≈ 3σ, Pachislop's convention).
- SSIM in tests: Wang et al. 2004, 8 × 8 windows, `C1 = (0.01·255)²`, `C2 = (0.03·255)²`.
- Assumption, not documented anywhere: a rim's opacity rule (full from 50 % local alpha) was chosen by looking at fades.
- Hessian ridge test: the eigenvalues of the 2×2 Hessian of smoothed luminance, `m ± √(¼(Lxx − Lyy)² + Lxy²)`; a spot curves down
  both ways, a ridge one way. Homes: the R2 low-discrepancy sequence, Roberts, "The Unreasonable Effectiveness of Quasirandom
  Sequences" (2018), α = (0.7548776662, 0.5698402910). Star and heart distances: Inigo Quilez, as Pachislop.
- Exponential drag: `dv/dt = −k·v` integrates to `(1 − e^(−k·t)) / k`, normalised here to 1 at the end of life.

Port maps: `licenses/ported/pachislop-rendering.md`, `licenses/ported/pachislop-generators.md`.

## Measured

| What | Result | Rerun |
|---|---|---|
| Program against a Remotion still, animated text and a keyed look param, frames 0, 30, 60 | SSIM 1.0000, max difference 0 | `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/title-look.e2e.test.ts` |
| Razor cut at frame 20 against the uncut clip, frames 10, 19, 20, 21, 45 | max difference 0 | same |
| Double build with fresh ids | byte-identical | same |
| Still look across 4 seeks in the Player | 0 GL draws; a text edit redraws | same |
| Resolution, real text through Remotion: 100 % against 50 %, 200 % against 100 % | SSIM 0.969, 0.997 (text hints per size) | same |
| Resolution, exact shapes, six layers: 100/50, 200/50, 200/100 | SSIM 0.986, 0.983, 0.998 | `pnpm exec vitest run packages/compositions/test/title-look-gl.test.ts` |
| `fxPreviewScale` 0.5 against full | SSIM 0.964 | same |
| Frame cost, six layers, 1080p, SwiftShader | 1.3 s title-sized box, 5.8 s frame-sized | [performance.md](../performance.md) §7 |

The extension contract was exercised by copying this note's three worked examples verbatim into their own files with their
one-line registrations: they typechecked with no change to the core, and the registry and GL tests picked them up (and failed
for the missing fingerprints, and for a generator example that was clipped by its own padding, now fixed above).

## Limits

- `block` gradients on animated text follow the frame's bounds until TL-036 brings layout boxes.
- `line` and `glyph` spans render as `block` until TL-036 (`docs/gaps.md`).
- The field is rebuilt whenever a frame is redrawn: an animated param on static text pays for it, though the input did not
  change. TL-037 only requires skipping unchanged input and params; `tlField` could be reused across frames when only layer
  uniforms change, by keying the field passes on their own.
