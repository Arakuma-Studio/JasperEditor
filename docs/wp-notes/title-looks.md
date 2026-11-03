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
| Light on a premultiplied picture (`tl_veil`, `tl_lit`, `tl_result`) | `packages/project/src/registry/fx/title-look/light.ts` |
| Deep Glow's PSF, passes and response, shared by layer and effect | `packages/project/src/registry/fx/title-look/deep-glow.ts` |
| Standalone effects of §8 | `packages/project/src/registry/fx/title-look/effects/`, built by `look-effect.ts` |
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

- **Light on nothing.** A premultiplied picture cannot show additive light where it has no alpha, and the framework's signal is
  sRGB-encoded, composited in the signal by the sequence. The usual alpha, the brightest linear channel, encodes a 2 % tail as
  0.02 where light of 2 % looks like 0.15, and a glow loses its haze: it reads as a blurred shape. `tl_veil` picks the colour and
  alpha whose encoded form over black is exactly the encoded light. Assumption, not a documented formula, chosen by looking.
- **A layer can say what the pixel should be.** `tl_over` cannot express additive light or a blend. `tl_result(under, D)` returns
  what makes the composite exactly `D`, and a layer reads what is below it from `u_tlComp`. Extrude and reflection draw behind
  what is below them this way, so they work on either side of the face.
- **Deep Glow's emitter.** `Shape` is the silhouette at this layer in the layer's paint, so a look can put it behind a face and
  colourways reach it. `Layers Below` makes the stack the light source, in its own colours, as Pachislop's effect does on the
  layer's picture; the exposure then lifts the picture itself and the response burns it. Reflection and Gradient Overlay read
  the stack the same way, which is why they go on top of it.
- **Glow Over Face defaults to 100 %**, Pachislop's default is 0. On footage alpha is 1 everywhere, so 0 would draw no glow at all;
  on titles light over the glyphs is what makes them read as lit. The look's `glow` layer keeps Pachislop's 15 %: it is a halo.
- **Mirror line.** A reflection sits under the outermost rim whatever its place in the stack (`outermost`).
- **Global light on effects.** `useGlobalLight` on an effect reads `Sequence.settings.globalLight` at the frame:
  `sequenceLightOf` takes it onto the render clip, `resolveLayerProps` evaluates it to `ResolvedEffect.globalLight` in sequence
  time, and the stage hands it over as `FxStructures.globalLight`. The default is off, unlike Pachislop's, so an effect's own
  angle works when it is added; a look's `useLight` is the same rule. Padding pads every side by the distance while a light
  decides the direction, so a moving light never clips.
- **Layers beyond §5.1.** `contourLines`, `extrude` and `gradientOverlay` are not in the §5.1 table. Their effects are in §8 and §5.1
  says an effect shares GLSL with its layer, so they are registered like any type, and Add Layer offers them.
- **Keyline's threshold and `follow` are not ported.** The field's edge is its local threshold, tuned for fading glyphs, and an
  effect reads the stack before it by definition.

### Standalone effects: the audit (AGENTS §10)

Each was checked against `registry/fx/` before writing anything. "Same job" means same input, same output and the same
controls would do; a name in common did not count.

| §8 effect | Candidates | Decision |
|---|---|---|
| Outer Glow | `jasper.alpha-glow` | **Extended.** Same job: a coloured glow around alpha. Technique Soft and Precise are the `glow` layer; Classic, the default, draws what it always did. Its keyword `outer glow` already finds it. Added: From, Intensity, Spread, Blend, Glow Over Layer; Glow's upper limit is 1700 px |
| Deep Glow | `jasper.glow`, `jasper.s.glow`, `jasper.s.ultra-glow` | **New** (`jasper.deep-glow`). Those are threshold blooms on the signal with a Gaussian or a look of their own; none is linear, energy-normalised or has this response, and each mirrors another product's parameter sheet, so a mode inside one would share nothing with it |
| Inner Glow | none: `jasper.s.edge-colorize`, `jasper.s.glow-edges` work from image edges, not alpha | **New** (`jasper.inner-glow`) |
| Inner Shadow | none | **New** (`jasper.inner-shadow`) |
| Contour Lines | `jasper.s.glow-rings` (one ring per bright area), `jasper.s.zebra`-style isolines of luma | **New** (`jasper.contour-lines`): lines at even distances from alpha |
| Perspective Shadow | `jasper.radial-shadow` (scales about a point on a wall behind), `jasper.drop-shadow` | **New** (`jasper.perspective-shadow`): a floor projection is another geometry |
| Floor Reflection | `jasper.mirror` (folds one half of the box onto the other, no fade, draws no further) | **New** (`jasper.floor-reflection`) |
| Gradient Overlay | `jasper.ramp`, `jasper.s.gradient`, `jasper.4-color-gradient` | **New** (`jasper.gradient-overlay`): those are generators that fill the box from points; this recolours within alpha from its bounds, in linear light |
| Shaded Extrude | none | **New** (`jasper.shaded-extrude`) |
| Keyline | none outside: `jasper.find-edges` and `jasper.s.edge-detect` find edges inside the picture | **New** (`jasper.keyline`), the `rim` layer |
| Title Material | | Another stream |

A look effect (`look-effect.ts`) is a small look: `[face(source), layer]` or `[layer, face(source)]` through the planner, unit 100 px, so
1 % is one layer px and px params reach the layer unchanged. Deep Glow alone has its own passes, because it needs no field and is the
one that runs on full-frame footage. Cost of the wrapper: every other effect pays for the field on a full-frame clip. That is
6 passes at 1080p, nothing on a GPU, and ≈ 1 s per frame on this host's SwiftShader.

### Bugs of the foundation's layers, fixed with the glows stream

Each has a regression test that was run against the foundation's own `shadow.ts` and `glow.ts` and failed there.

- **`useLight` padded only right and bottom.** `side(-dx)` with `dx = d` gives 0, against its comment: a light from the lower right
  clipped the shadow at the top left. On the old code the shadow had no canvas at all there.
- **A long shadow stopped short.** 48 steps of a field reaching a few pixels cover about 290 px; the field's reach now follows the length.
- **A perspective shadow scaled with the square of the resolution.** `tl_px(distance) * 0.01 * above` is px²; SSIM 0.866 between two
  scales on the old code. The kind is now Pachislop's floor projection.
- **A layer glow above 100 % cut a black hole in what was below it.** Alpha above 1 made `under * (1 - a)` negative. The first test written
  for this passed on the old code, because the bright card outweighed the negative term: it proved nothing and was rewritten.

Goldens this moved, all explained, none of them in a default the fix should not touch:

| Key | Largest change (levels) | Why |
|---|---|---|
| `glow@default` | 2.9 | Pachislop's tighter core in the soft technique |
| `glow@perturbed` | 151.9 | New params in the perturbation (Spread, Add as Light), and Precise from Layer now takes the picture's colours |
| `shadow@perturbed` | 66.7 | `useLight` now pads every side, so the canvas grew and the 4 × 4 grid moved |
| `rim@perturbed` | 1.0 | Softness in the perturbation |
| `jasper.alpha-glow@perturbed` | 177.6 | The perturbation reaches Technique Soft. `jasper.alpha-glow` at defaults did not change |

### A note on a false alarm worth keeping

`getImageData` returns **straight** alpha. The harness's `over()` and `lumaOver()` handle that; comparing raw `data` to a
premultiplied expectation looks like a shader bug. Look at the dumped picture before believing an SSIM.

## How to extend

Three rules: put your code in your own file, add one line to the list next to it, and never edit `plan.ts`, `glsl.ts`,
`registry.ts`, `validate.ts` or the commands. If you think you must, the contract is missing something: say so in your
report. Types in `contract.ts` are the normative reference.

A param must not be named after a built-in: `source` is `u_source`. The registry test catches it.

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
| `texture(u_tlComp, uv)` | what is below this layer, premultiplied linear; with `GLSL_TL_LIGHT` (`include`), `tl_result(under, D)` makes the composite exactly `D`, and `tl_lit(under, covered, empty)` adds light |
| `tlPaint_<param>(s)` | the value of paint param `<param>` here, premultiplied linear |
| `tl_finish(paint, s)` | the layer's finish (types with `finish: true`) |
| `u_<param>` | each param: number `float`, boolean `bool`, enum `int` (option index), vec2, colour `vec4`, media `sampler2D` + `u_<param>_size` |
| `u_tlLight`, `u_tlLightDir` | `vec3` unit vector to the light, `vec2` screen direction to it |
| `u_tlSeed`, `u_tlTime` | 0..1 from the appearance; content seconds (0 unless a layer is `timeDependent`) |
| `u_tlBlur` | the framework's blur of your `tl_mask`, when `blur` returns one |

### Worked example: a layer type

`packages/project/src/registry/fx/title-look/layers/edge-tint.ts`, a reduced `layers/inner-glow.ts`:

```ts
import { fmtDistance, layerSwatch, lp, paintText, type TitleLayerInit } from '../contract.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export const EDGE_TINT_LAYER: TitleLayerInit = {
	type: 'edgeTint',
	label: 'Edge Tint',
	description: 'Colour inside the shape, from its edge inward.',
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
	// Inside the shape: it needs the field, and a sliver of padding so a clip filling its box has an edge to start from.
	reach: () => 0.01,
	fieldReach: (p) => ({ inside: num(p.radius) + 1, outside: 0 }),
	handles: [{ kind: 'distance', params: ['radius'] }],
	summary(p) {
		return {
			swatch: layerSwatch(EDGE_TINT_LAYER, p),
			text: `${fmtDistance(p.radius)}, ${paintText(p.paint)}`,
			primary: 'radius',
		};
	},
};
```

One line in `layers/index.ts`, in `TITLE_LAYER_INITS`.

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
| `outermost` | `s.base` and padding count every layer's growth, not only that of the layers above (a reflection on top of the stack) |
| `prepass(p, ctx)` | Your own `ShaderPass[]` before the layer's pass. `ctx.surfacePass(pass)` gives a pass what the layer's own has (`tl_surface()`, `tl_px`, paints, the layer's uniforms); `ctx.unit` is the `tl_px` chunk alone; `ctx.unitKnown` says `pxPerPercent` is exact. Each pass mentions few textures, so the real budget is 12 per pass: the framework's names are `tlBounds`, `tlFlood`, `tlField`, `tlComp`, `tlMask`, `tlBlurH`, `tlBlur`. A look can hold a type twice: mark your outputs `update: true`, on the first pass too |
| `timeDependent(p)` | The layer moves on its own: the clip then redraws every frame and `u_tlTime` is live |
| `handles` | On-canvas handles for TL-092: `{kind, params}`, `target: 'light'` for the look's light, `when: {param, value}` when it only applies in one state |
| `shader(p, ctx)` | It is a function: return different GLSL per enum to keep programs small (`shadow.ts`, `glow.ts`) |

### Worked example: a standalone effect

`defineLookEffect` in `title-look/effects/index.ts`, one line in `TITLE_LOOK_EFFECTS`: ordinary `fxParam`s (px for distances), and the
layers they become. Padding across the clip, linear light and `requiresFloat` follow. The GL tests are in `title-look-glows-gl.test.ts`.

```ts
export const KEYLINE = defineLookEffect({
	id: 'jasper.keyline',
	label: 'Keyline',
	category: 'Stylize',
	description: 'An outline traced from the clip’s alpha.',
	params: [px('width', 'Width', 2, 100), fxParam.color('color', 'Color', [0, 0, 0, 1])],
	layers: (p) => [{ type: 'rim', params: { width: num(p.width), paint: colorPaint(p.color) } }, SOURCE_FACE],
});
```

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

- Deep Glow's PSF: an inverse power law as a scale mixture of Gaussians, `w(σ) ∝ σ^(2-p)` per log-σ step, because
  `∫ σ^(2-p) · σ^-2 exp(-r²/2σ²) dlog σ ∝ r^-p`. p from 1.6 to 3.2 (Pachislop). Veiling glare's power law is from its comment; I did
  not check it against a measurement.
- Pyramid variance, per axis, in level-0 px²: a 2×2 box at level j adds 4^j / 4; a bilinear read from level l, a tent, averages
  4^l / 6 (exact samples at the texel centres add none). Gaussians compose by adding variances, so each octave blurs by what is left.
- Soft knee: `e = max(x, q² / 4k)`, `q = clamp(x + k, 0, 2k)`, `x = luma − threshold` (Pachislop, the usual bloom knee).
- Over-exposure response: Pachislop's `bleed` and `shoulder`, written out in `deep-glow.ts`. An assumption of Pachislop's, not a camera
  measurement; it is the identity at or below 1 (tested).
- Floor projection: for a floor pixel, height on the object `h = (y − base) / ratio`, `ratio = tip.y / H`, `shear = tip.x / H`, width
  narrowed by `1 − perspective · h / H`. Pachislop's; the 10° guard against a horizontal direction is too.
- Gradient blends: `fx_blendRgb` on linear colours. Blending in linear light is §8's requirement. Photoshop blends on sRGB values, so a
  Multiply here is darker than Photoshop's.

Port map: `licenses/ported/pachislop-rendering.md`, `licenses/ported/pachislop-effects.md`.

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
| Glows in Program against a Remotion still: keyed `deepGlow`, `reflection`, `innerShadow` on a moving sequence light, Deep Glow, Perspective Shadow and a keyed Keyline as effects, frames 0, 30, 60 | SSIM 1.0000, max difference 0 | `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/title-look.e2e.test.ts` |
| Deep Glow energy: a 40 × 40 emitter of 1 at radius 40–120 %, falloff 10–90 % | 88–105 % of 1 600 (8-bit tails and clipping) | `pnpm exec vitest run packages/compositions/test/title-look-glows-gl.test.ts -t energy` |
| Deep Glow variance against Σ wσ² of its octaves at 100 %, 50 %, 25 % resolution | within −15 % / +4 %, x and y within 3 % | same, `-t variance` |
| Deep Glow radius across a pyramid level (116 → 124 %) | largest alpha step 6 / 255 | same, `-t continuous` |
| Look effects at half resolution against full, perturbed params | SSIM above 0.93 for all ten | same, `-t "half the resolution"` |
| Deep Glow cost, 1080p, SwiftShader | 7.0 s title box, 17.2 s full frame | [performance.md](../performance.md) §7 |

The extension contract was exercised by copying this note's three worked examples verbatim into their own files with their
one-line registrations: they typechecked with no change to the core, and the registry and GL tests picked them up (and failed
for the missing fingerprints, and for a generator example that was clipped by its own padding, now fixed above).

## Limits

- Reach stops at the framework's `FX_MAX_PADDING`, 2048 layer px per side. Deep Glow's radius stops at 1700 px, its reach at full
  scatter. An effect whose params add up past it (a 2000 px cast shadow with a 2000 px blur) clips there: that is a canvas limit, not
  a sampling error. A look's reach is in percent of its unit and meets the same limit.
- `block` gradients on animated text follow the frame's bounds until TL-036 brings layout boxes.
- `line` and `glyph` spans render as `block` until TL-036 (`docs/gaps.md`).
- The field is rebuilt whenever a frame is redrawn: an animated param on static text pays for it, though the input did not
  change. TL-037 only requires skipping unchanged input and params; `tlField` could be reused across frames when only layer
  uniforms change, by keying the field passes on their own.
