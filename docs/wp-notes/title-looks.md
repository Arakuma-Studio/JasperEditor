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
| Test harness | `packages/compositions/test/title-look-harness.ts`, `title-look-gl/entry.ts` |
| Registry completeness, GL, fuzz, E2E | `packages/project/test/title-look*.test.ts`, `packages/compositions/test/title-look*.test.ts` |

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

Standalone instances see an empty shape (`s.d` large, `s.opacity` 0) and take the layer box as their unit. Everything must be a
closed form of `u_tlTime` and `u_tlSeed`: no history (TL-061).

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
| `appearance.addLayer {effectInstanceId, layerType, index?, params?, name?}`, `removeLayer`, `reorderLayer`, `setLayerEnabled` | |
| `appearance.setPaint {…, param?, paint}`, `appearance.setGradient {…, param?, gradient}` | 33 stops → `E_LIMIT` |
| `sequence.setGlobalLight {angle?, altitude?, clear?}` | |
| `clip.addGenerator {effectId, at, duration, track?, belowClipId?, params?}` | A `transparent` solid with the effect |

Addresses: `["appearance", fxId, layerId, param]`, `["appearance", fxId, "palette", role]`, `["appearance", fxId, "light",
"angle"]`, `["globalLight", sequenceId, "angle"]`. Property keys join the first with dots. Slot names have no `$`: `$` starts
a temp ref in commands.

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

Port map: `licenses/ported/pachislop-rendering.md`.

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

## Interchange and delivery (§12)

| Piece | File |
|---|---|
| Plan of a PSD: layers, what is baked, blockers | `apps/engine/src/export/delivery/psd-plan.ts` |
| PSD on disk, one layer at a time | `apps/engine/src/export/delivery/psd-writer.ts`, `psd-job.ts` |
| Style files to `PsStyleSchema` values | `apps/engine/src/title-looks/ps-styles.ts` |
| Style to look, with its report | `packages/project/src/title-looks/ps-style.ts` |
| PNG frames with alpha, Export Title | `apps/engine/src/export/delivery/alpha.ts`, `frames.ts`, `trim.ts`, `zip-writer.ts` |
| Alpha islands and the cut | `packages/project/src/image-split/`, `apps/engine/src/export/delivery/split-image.ts` |
| `clip.splitImage` | `packages/project/src/commands/{schemas,handlers}/image-split.ts` |
| Gamut and legal check | `packages/project/src/color/gamut-check.ts`, `apps/engine/src/export/delivery/gamut.ts` |
| Dialogs, overlay, commands | `apps/web/src/delivery/` |
| MCP tools | `apps/mcp/src/tools/delivery.ts`; guide topic `delivery` |
| Routes | `apps/engine/src/routes/delivery.ts` |

### TL-112 Send to Photoshop

- **Plan first.** `POST /api/psd/plan` runs nothing: it lists the layers, what is baked and the blockers, so the dialog can
  show them before writing (Pachislop's warnings arrive after the download).
- **One render per layer, alone, in the full frame.** That is what makes them register. A clip draws in Normal at 100 %, and
  its blend mode and opacity go on the PSD layer. An opacity expression stays in the pixels and the plan says so.
- **Baked with a name.** An adjustment layer or a blend mode without a Photoshop equal needs the picture below it, so a layer
  `<name> (baked)` holds the composite up to there, and what it stands in for stays below, hidden. A transition at the frame is
  one layer: its sides do not exist apart. A track matte or a 3D scene flattens the whole stack, because its sources can sit
  above the clip.
- **Memory.** `writePsd` takes every layer in RAM and returns one buffer. So each layer goes through ag-psd alone as a one-layer
  document (ag-psd still writes every byte: records, RLE, blend keys), its channel data goes to a scratch file, and the records
  are kept. The final file is head + records + streamed channels + tail + composite, the head and tail from one more ag-psd
  document with empty layers. Peak memory is one frame's RGBA plus ag-psd's scratch buffer, 12 bytes per pixel, so
  `MAX_PSD_PIXELS` is ≈ 1 GiB; the layer count does not matter. Cancellation is checked between layers and every step takes the
  job's signal. The file is a same-directory temp file, fsync, rename, directory fsync.
- **Split titles.** A part keeps every other layer of the look at zero opacity, not removed: rims grow from what is above them,
  so removing a layer would move the ones below it. Layers that do not grow the silhouette are just disabled. Parts are hidden,
  `fx` is shown: a look composites in linear light and Photoshop in gamma, so the parts recombine close to `fx`, not exactly.
- **Colour.** Layers are the display rendition (the same LUT as stills). The flattened picture in the file is the render.

### TL-113 Layer styles

- **Written against the catalogue.** The mapper looks up each layer type and param in the registry. On this stream's base only
  `face`, `rim`, `shadow` and `glow` exist, so Inner Shadow, Inner Glow, Bevel and Satin report `this build has no …` and are
  left out. They use the names of spec §5.1 (`innerShadow`, `innerGlow`, `bevelSize`, `satinSize`…), so they map once the
  streams that ship those types land; a param named differently shows up in the report rather than being lost.
- **Store.** TL-054's user store is not on this base. `saveImportedLooks` (`apps/web/src/delivery/LayerStyleDialog.tsx`) is the one
  place to change: today it writes project looks with `look.create`, undoable.
- **Overlays stack.** Pachislop mixes overlays into one colour. Here each is a `face` layer over the base at its opacity, which is
  exact for normal blending and stays editable.
- **Shape Burst.** ag-psd's enum lacks `GrdT.shapeburst` and throws, which loses the whole style in an `.asl` and the whole file in
  a `.psd`. Confirmed on ag-psd 31.0.2: `ps-styles.test.ts` swaps the decoder back and sees the style go. `ps-styles.ts` extends it.
- **No file from Photoshop was available.** Tests build `.asl` and `.psd` files with ag-psd's writers: the real layouts, but not
  Photoshop's own bytes. The `.asl` layout follows Pachislop's reader.

### TL-114 Alpha

- A transparent still and a PNG sequence are drawn by the compositions on a transparent page (the layer bake's path), since the
  native composite is RGB. ProRes 4444 is unchanged.
- Export Title renders on a canvas a quarter of the long side larger on each edge, measures every frame (alpha ≥ 1, so a glow's
  tail counts), crops all frames to the union plus the margin, and doubles the canvas once if something still touches its edge.
  The result's `origin` says where its corner sits in the sequence, which can be negative.
- `crop`, `lut3d`, `format` and the PNG encoder are LGPL: no GPL filter is involved (`alpha-delivery.test.ts` runs the graph
  through `assertLgplGraphArgs`). A 3D scene projects through the frame, so it is trimmed inside the frame, with a warning.

### TL-115 Split image

- The engine decodes and cuts, so no canvas touches kept pixels. 8- and 16-bit pictures stay as they are; a 16-bit island's alpha
  is judged by its high byte. The dialog's canvases only draw the preview.
- Static Motion gives each part an anchor at its centre, which is what logo animation wants. With keyframes the anchor moves
  instead, so every key stays valid and the parts follow the whole. Masks and trackers are refused: they are shaped to the whole
  picture.
- Parts are grouped. Each is on a free track above, or a new one.

### TL-116 Gamut overlay

- **The Program picture cannot be read back** in general: it is DOM, and only some stacks pass through a canvas. So the frame is
  measured by the engine, as `frame.capture` is: a job per paused frame, debounced, the previous one cancelled. The mask is hidden
  while playing or until the current frame's result is in, since a stale mask would mark the wrong pixels.
- **Gamut** is the working signal in the output's linear light with nothing mapped: a channel below 0 or above the output's peak
  (`unmappedOutputFn`). Against the working space itself that is 0 by construction.
- **Legal range.** Full-range RGB cannot break legal limits by itself: every 8-bit value maps inside the narrow range. What breaks
  them is 4:2:0, where a pixel gets its neighbours' chroma. So each pixel is rebuilt from its own Y′ and its block's chroma and
  held to EBU R 103 (RGB −5 % … +105 %, luma −1 % … +103 %). R 103 tolerates under 1 % of the picture.
- Assumption, not from a standard: nearest-neighbour chroma. A real decoder interpolates, so the check is a little stricter than a
  scope.
- Sources: EBU R 103 v3.0 (2020); ITU-R BT.709-6 and BT.2020-2 luma weights.

## Limits

- A PSD holds text as pixels, not type (TL-112), and the dialog says so.
- Layer styles have not met a file written by Photoshop itself (see TL-113 above).
- `block` gradients on animated text follow the frame's bounds until TL-036 brings layout boxes.
- `line` and `glyph` spans render as `block` until TL-036 (`docs/gaps.md`).
- The field is rebuilt whenever a frame is redrawn: an animated param on static text pays for it, though the input did not
  change. TL-037 only requires skipping unchanged input and params; `tlField` could be reused across frames when only layer
  uniforms change, by keying the field passes on their own.
