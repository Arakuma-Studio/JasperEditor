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
| Factory library (data): looks per category, colourways, categories, search, templates | `packages/project/src/title-looks/factory/` |
| Which face a look gives a text clip (TL-053) | `packages/project/src/title-looks/font.ts` |
| Style check (TL-056) | `packages/project/src/title-looks/lint.ts` |
| User look format (TL-054) | `packages/project/src/title-looks/user-looks.ts` |
| User look library and routes | `apps/engine/src/title-looks/library.ts`, `apps/engine/src/routes/title-looks.ts` |
| Display fonts (TL-053) | `apps/engine/fonts/display/` (`manifest.json` pins commit and hashes) |
| Generator recolour rule (TL-051) | `packages/project/src/registry/fx/title-look/recolor.ts` |
| Template expansion (TL-052) | `packages/project/src/commands/handlers/title-template.ts` |
| Commands (TL-018) | `packages/project/src/commands/{schemas,handlers}/title-look.ts` |
| Extension contract, `lp` builders, summaries | `packages/project/src/registry/fx/title-look/contract.ts` |
| Catalogue (nothing else lists types) | `packages/project/src/registry/fx/title-look/registry.ts` |
| Pass planner, padding, uniforms | `packages/project/src/registry/fx/title-look/plan.ts` |
| Shared GLSL (surface, field, blur) | `packages/project/src/registry/fx/title-look/glsl.ts` |
| Paints and gradients | `packages/project/src/registry/fx/title-look/paint.ts` |
| Layer types, finishes, generators | `packages/project/src/registry/fx/title-look/{layers,finishes,generators}/` |
| Direct text entry, run toolbar (TL-085, TL-093) | `apps/web/src/text-edit/` |
| Run operations, vertical text rules (TL-093, TL-111) | `packages/project/src/text-runs.ts`, `text-writing.ts` |
| Warp Text (TL-110) | `packages/project/src/registry/fx/text-warp.ts`, `text-warp/mesh.ts` |
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

## Text (TL-085, TL-093, TL-110, TL-111)

### Direct entry (TL-085)

The Type tool opens a caret where it is clicked; double-clicking a text clip in Program edits it through the plain-text handler
(`text-edit/register.ts`, order 60, after template texts and before composition texts). Clicking text with the Type tool edits
it too. `graphics.newTextLayer` keeps adding a clip: it runs from menus and for agents, with no pointer to type at.

- **The draft lives outside React** (`EntryDraft`, `text-edit/draft.ts`). A render failure commits it from the error boundary; if
  that is refused a new editor opens on it, and a second failure hands the text to the message. `pagehide`, unmounting the overlay,
  starting playback and the clip leaving the monitor all commit. A refused commit keeps the editor open with the reason.
- **One gesture is one History step, and it is the live preview.** Text changes go to `session.beginGesture(...).update(commands)`,
  so the Player draws the transient document and a look renders the letters as they are typed. Commit replays the commands on the
  committed document; cancel leaves nothing. An entry that changes nothing holds no gesture. While text is being typed an agent's
  `submit` waits and its `apply` gets `E_QUEUED`, as during any drag. A new text gets a new clip id per keystroke, because a gesture
  replays its commands.
- **Empty means gone.** A new entry of nothing or only whitespace writes nothing; emptying an existing clip lifts it, in one undo.
- **A text clip that went while it was edited** (another window) comes back as a new text with what was typed.
- **Ghost editor.** The editor is a transparent copy of the block (`textBlockStyle`, `contentSpans`, `runLayoutCss`, the same as the
  layer) inside the same layer map, over the real picture. Where it cannot match, it shows its own text on a scrim
  (`data-mode="plain"`): text on a path, paragraph overrides, optical or manual kerning, tsume.
- **Our own caret.** Transparent text needs one, and no single colour is visible on every look: a white bar with a black edge,
  placed in layer px from the selection's rectangle (the centre survives rotation, a bounding box would not) and scaled to stay
  2 screen px.
- **IME.** The DOM is not rebuilt during a composition, keys belong to the IME (`isComposing`), and the editor switches to plain
  mode with a native caret, because the IME's underlines are drawn in the text colour. The text reaches the preview at
  `compositionend`. `syncFromDom` reads the element when committing, so a blur in mid-composition keeps what is shown.
- **Rest while editing.** The clip uses the template edit hold: In/Out animators and text animators rest, and a warp stands aside
  (`useLayerFx`), so the caret sits on the letters. The look keeps drawing. All of this is preview only.
- **Keys.** `data-keymap-suspend` makes the dispatcher ignore the target; the element stops propagation; browser chords that
  would take the focus (Ctrl+S, Ctrl+P…) are prevented. Ctrl+Z undoes typing locally, because History is out of reach during a
  gesture. Enter is a new line, Ctrl+Enter or Esc commits. Ctrl+B and Ctrl+I style the selection.
- **The press does not open the caret, the release does.** A press on the SVG overlay moves focus to the body afterwards, which
  blurred the fresh editor and committed nothing.
- **StrictMode.** Effects replay in development. The commit on unmount runs in a microtask and checks the effect came back: run
  synchronously, it closed the draft on mount, so every later commit was a no-op and the gesture stayed open. The component tests
  mount in `StrictMode` for this reason.
- Refused: read-only projects, locked tracks, text an expression drives, 3D layers (a short message at the pointer). Subtitles are
  left to the Captions panel. Source Text keys: the edit writes a key at the playhead with `param.set`.

### Runs (TL-093)

The toolbar over a selection writes `content.runs` through `text-runs.ts`: flat, sorted runs with fields equal to the base removed.
All of it belongs to the entry's one History step. Runs follow typing like a word processor (`remapTextRuns`; `remapParagraphs` does
the same for paragraph overrides).

The look applies over the runs. Size, weight, font and spacing change the picture, so the shape field wraps the styled letters and a
rim stays one outline (tested: `title-text.e2e.test.ts`). A run's **colour** shows where the face paints `{kind: 'source'}`; a role,
colour or gradient face paints over it, as the toolbar's tooltip says.

**Per-letter finishes: data contract for the finishes stream.** `content.runs[i].finish` holds a finish id, and it persists, repairs
and survives edits. A look uses one program per finish, so drawing it needs a pixel-to-letter map and a second program in the
planner, which is GLSL and belongs to that stream. The map exists in TL-036's owner pass; a glyph's run is
`textRunAt(content.runs, glyph.offset)`. Until the planner draws it `RUN_FINISHES_DRAWN` is false and the toolbar's control is disabled
with the reason (`docs/gaps.md`): set it to true with the planner change.

### Warp Text (TL-110)

**Decision: an ordinary effect that follows the look, drawn as a forward mesh.**

- *Effect, not a look step.* It reads the composited look, so rims, glows and shadows bend with the letters. It works on text with no
  look. Keyframes, expressions, Effect Controls, copy and paste, MCP `add_effect`, export routing and the bake need no code. A look
  step would add per-kind code to `plan.ts` and would not exist without a look. `look.apply` puts the look first in the stack, and
  Properties inserts the warp straight after it, so a look applied later still goes under the warp. It can be moved in Effect
  Controls: placed before the look, rims are computed on the bent letters and keep a constant width.
- *Mesh, not a shader.* The Photoshop surfaces are defined forward (box → picture). Inverting them per pixel needs a solver that
  fails on folds; a fixed lattice of 128 × 128 cells over the canvas draws folds with `over`. Chord error ≈ 0.6 px for a half-circle
  arc 3840 px wide with the box filling half the canvas, so 64 cells across it (computed from the sagitta `r(1 − cos(θ/2))`, not
  measured).
- *Resolution independence.* Control points are normalised to the layer box and the lattice is fixed, so geometry does not depend on the
  canvas. `sourceMipmaps` filters what the warp shrinks.
- *Past the box.* A rim or glow outside the box goes on along the surface's tangent at the edge (C1), because a Bernstein polynomial
  runs away within one box width. This also means the warp bends a text box, as Photoshop does, so a fixed box wider than its text
  bends the box, not the ink.
- *Padding.* `FxPlanContext.inputPadding` tells a warp how far its input reaches, in `planLayerFx` and in `contentBleed`, so a glow does
  not clip where the warp stretches it, and a bake stays cropped.
- *Framing.* The warped frame is re-centred on the box (Pachislop's rule): a title does not drift as its bend animates.

Patchy's control meshes are compared control point by control point with the output of Patchy's own C++
(`packages/project/test/fixtures/patchy-warp-meshes.json`: 15 styles × 4 bends × 2 orientations × 2 distortions).

### Vertical text (TL-111)

`content.writingMode` (next to `style`, not in it: it applies to a whole block and has no meaning per run). Chromium does all shaping:
`writing-mode: vertical-rl` and `text-orientation: mixed` give columns from the right, `vert` forms and sideways Latin, and
`text-combine-upright: all` draws tate-chu-yoko. Pachislop's own glyph layout is not ported, for that reason.

- **Tate-chu-yoko** (`tateChuYokoRanges`): a maximal run of 1 to 3 half-width characters with another kind of character or a paragraph
  edge on both sides. A space next to it means Latin text, so "12月" and a lone "OK" stand up and "GO TO IT" and "2026年" stay on
  their side. On by default, off per clip. This rule is ours, not a documented one: Photoshop leaves it to a manual setting, and
  automatic rules vary.
- **Three renderers.** The plain block; the In/Out overlay, which groups columns from `offsetLeft`, merges a run's letters into one
  unit, shifts along the column and draws a horizontal typewriter caret; the typeset renderer, which merges the run into one glyph,
  measures columns, places glyphs by the middle of their cell, and runs tracking down the column (`PlaceOptions.vertical`).
- **Box.** Columns wrap at `box.height`. `autoSize: 'height'` keeps the height and takes the width; point text takes both. Columns start
  at the right edge of the box. The headless measurer gets the height too.
- **Refused:** text on a path. A path has one direction and a column has none on it (`docs/gaps.md`).
- The look reads the picture, and the warp's Vertical orientation is Patchy's transposed construction.

- **A unit of several code points.** `substituteCharacter` compared the first code point with the whole unit, so on the typeset path
  every multi-code-point grapheme was cut with no animator asking: a tate-chu-yoko "12" drew "1", and a decomposed "é" or a ZWJ emoji
  lost its tail. Program and the render agreed, so SSIM was 1.0; looking at the frame found it. The E2E now checks the drawn text.
Agent tools (§11): [title-looks-agents.md](title-looks-agents.md).

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
| `appearance.setLayerFixedColor {effectInstanceId, layerId, fixed}` | TL-051. Fixing turns the roles the layer reads into their current colours; unfixing keeps them |
| `title.insertTemplate {templateId, at, duration?, track?, texts?, colorwayId?, seed?, availableFonts?}` | TL-052. Ordinary clips in one transaction, grouped. Returns `{clipIds, slots}` |

`look.apply` also takes `availableFonts`: see "Fonts" below.

Addresses: `["appearance", fxId, layerId, param]`, `["appearance", fxId, "palette", role]`, `["appearance", fxId, "light",
"angle"]`, `["globalLight", sequenceId, "angle"]`. Property keys join the first with dots. Slot names have no `$`: `$` starts
a temp ref in commands.

## People (TL-086 to TL-098)

Three tiers over one model: click a look (Looks tab, `Graphics ▸ Apply Look…`), tune a few controls (Properties ▸ Look), open
the full stack (Properties ▸ Appearance, Effect Controls). Everything is in `apps/web/src/title-looks/`.

| Piece | File |
|---|---|
| One entry per look: library, then what only the project has | `library.ts` |
| What a click does, what it must announce | `actions.ts` |
| Actions on the selection's look and on project looks | `look-actions.ts` |
| Search, categories, recents, tile size, status line | `LooksBrowser.tsx` (the tab: `LooksTab.tsx`; the dialog: `ApplyLookDialog.tsx`) |
| Virtual grid | `grid-window.ts` (pure), `LookGrid.tsx`, `LookCard.tsx` |
| Posters | `posters.ts`; engine `apps/engine/src/title-looks/posters.ts`, `POST /api/title-looks/poster` |
| Preview without an edit (TL-088, TL-095) | `preview.ts`, `PreviewChip.tsx` |
| Look header, stack rows | `LookSection.tsx`, `AppearanceList.tsx`, `rows.ts`, `selection.ts` |
| Effect Controls block | `AppearanceBlock.tsx`, `appearance` of `FxSection` (`panels/effectControls/items.ts`) |
| Paint and gradient controls | `PaintField.tsx`, `GradientField.tsx`, `paint.ts` |
| On-canvas outline and handles, tool bar target | `LayerOverlay.tsx`, `overlay-geometry.ts`, `ToolTarget.tsx`, `focus.ts` |
| Style check badge | `StyleCheckBadge.tsx`, `style-check.ts` |
| Commands | `apps/web/src/commands/title-looks.ts` |
| Review of `title-art` proposals | `apps/web/src/proposals/title-art.tsx` |

Decisions:

- **A preview is the session's derived preview.** `derivedPreviewFor(session)` already draws the committed document with commands
  applied in a dry transaction, never saved and never in History, and ends itself on any edit, gesture or close. `look.apply`,
  `look.setColorway` and `effect.addMany` run there unchanged, so what a hover shows is what the click does. A chip says what
  Program shows. The 180 ms wait means sweeping across a grid draws nothing. Preview ends only its own kind, never Clean Up's.
- **A poster is a render, not a drawing of one.** The engine builds a one-clip project with the same commands a person uses and
  renders it through `JasperSequence`, so a thumbnail cannot disagree with the look, and a recipe the commands refuse answers
  with their `E_*` code. The key is the content (`canonicalJson` of recipe, palette, text, font and size) plus the scene version
  and the engine version; files are ordinary `mg-posters` cache entries, so the cache cleaner, its budget and its orphan sweep
  need no new code. The browser is shared across a burst and closes after 20 s idle. A press on a card that has left stops
  waiting; the render stops when the last waiter leaves (`clientGoneSignal`).
- **Intensity is the effect's own param, `lookIntensity`.** It is a mix of the clip's picture and the finished look in the last
  pass, in the signal, both premultiplied. Being an ordinary param it keyframes, pastes and shows in Effect Controls with no code,
  and it animates a look on or off, which a macro over the layers could not. 100 % is the look exactly (the test compares bytes).
  `u_lookIntensity` is named so it cannot meet a layer's `u_intensity` in a pass. `look.reset` of the whole appearance clears it.
- **Quick controls name a layer by type and position** (`TitleLook.quickControls`), because recipes have no ids. A look that names
  none offers the primary value of its top three layers. Saved in the project with the look (`look.apply` copies them).
- **Rows reset to the look.** `defaultValue` of an appearance property is a function: the linked look's value, else the type's
  default. Without it ⟲ on a rim went to the type's 6 %, not the look's 5 %, and every tuned look read as changed.
- **`lookOverrides` is the link status.** The header counts it; nothing else keeps a "dirty" flag.
- **Layers are matched across clips by position and type** (`sharedStack`). Same structure: rows edit all of them, mixed reads "—",
  and a drag offsets each clip from its own value through the usual `planSet`. Different structure: the panel says so rather than
  guessing which layer is which.
- **New layers do not cover the title** (`newLayerIndex`): a type that reaches outside the shape goes under the face, one that
  stays inside (sheen, inner glow) over it. A generator follows its own `front`. `applyEffectToClips` sends a generator dropped on
  a title to a free track below it (TL-064).
- **Handles come from `layerHandles`**: the type's `handles` while their `when` holds, plus the angle of each gradient paint; a
  paint angle has no handle while the paint is not a gradient. A handle with `target: 'light'` turns the look's light (or the
  sequence's, when the look follows it), and a shadow that follows the light moves its distance along it. An offset handle
  starts at the edge of the box: at Fit, a 10 % shadow is 5 screen px from the anchor and could not be grabbed there.
- **`Clip › Layer` sits in the Tools strip** as vertical text when the strip is vertical; a click returns to the clip. Selecting a
  layer never changes the clip selection.
- **Colourways coalesce until the next edit** (`coalesceWindowMs: Infinity`, `coalesceRelabel`): the entries have different
  labels, so a key alone merged nothing. A person may look at each for as long as they like; it stays one History entry.
- **A look on a still or a video announces itself.** Its face paints over the picture, which is usually not what was wanted, so the
  toast offers Keep Clip Picture (the `source` paint). Replaced keyframes are announced with their count (TL-019).
- **TL-096 lives in `ScrubbyNumber`:** `useScrubLabel` for the label, `onReset` for double-click, and `track` with `log` and
  `pow` mappings. Tracks appear where the spec names a useful end (`softMax`) or a positive range spans 50×, so plain numbers
  look as they did. Mappings ported from Pachislop's `controls.tsx` (`licenses/ported/pachislop-ui.md`).
- **Double-click on a value.** The first click turns the value into a field, so the second lands on the field. Within 400 ms of
  that click it resets; later it selects text as a field should.

## The library

Everything below is the library stream's. It reads as a general tool on purpose: categories run from Clean to 3D, pachinko is one
of fifteen, and no code path knows about it. A test keeps that category at 15 % of the looks at most, and keeps the first look
general.

Current content: 30 looks in 13 categories, 15 colourways, 14 templates. Brush and 3D have no looks yet: they need `texture`
and the 3D work to be worth shipping. The pass after the finishes and generators exist authors the rest (TL-050 asks for 60).

### Adding to it

- A look: an entry in `factory/looks/<category>.ts` through `defineLook`. It needs a font with a weight, a fallback and a Japanese
  face, a colourway as its own palette, tags in English and Spanish, and generic sample text. Add its strings to `es.json`.
- Every colour goes through a role. A colour that must not follow a colourway goes on a layer marked `fixedColor`; the library test
  fails on a free colour otherwise.
- A colourway: an entry in `factory/colorways.ts` with all nine roles.
- A template: an entry under `factory/templates/`. Positions are fractions of the frame, sizes fractions of its shorter side.

The UI and agents read `FACTORY_LOOKS`, `FACTORY_COLORWAYS`, `FACTORY_TEMPLATES`, `LOOK_CATEGORIES`, `searchLooks`, `searchTemplates`
and `lookSearchEntry` from `factory/index.ts`.

### Roles are a contract

A look only stays good under every colourway if roles mean the same thing everywhere. The library test checks these on every
colourway, and that every look passes the lint at error level under every colourway:

| Role | Promise |
|---|---|
| `face`, `faceAlt`, `accent3` | Main fill, deep end of a face gradient, highlight of a face gradient |
| `keyline` | The line touching the face: ΔL* ≥ 25 from `face` |
| `accent1` | Next ring: ΔL* ≥ 25 from `keyline` |
| `accent2` | Outer frame: ΔL* ≥ 15 from `accent1` |
| `base` | Backing |
| `glow` | Light: L* ≥ 60 |
| `shadow` | A dark tint, never pure black: L* ≤ 25 |

`accent3` as the highlight is a decision, not in the spec: a gradient needs a highlight stop, and a free white stop would escape the
colourway.

### Fixed colours and the generator recolour rule (TL-051)

`AppearanceLayer.fixedColor` means colourways leave the layer alone. A fixed layer reads no role: `appearance.setLayerFixedColor` turns
the roles it reads into their current colours, and the lint flags one that still reads a role (an imported recipe). A generator's
colours come from its shader, so a role cannot reach them: unless the layer is fixed, each pixel is gradient-mapped by its Rec. 601 luma
onto black, `shadow`, `glow`, `accent3`, white, each stop placed at its own luma, so a mapped pixel keeps its brightness. Pixels whose
channels are all at least 0.92 are left alone, which keeps hot cores white. `recolors: true` on a layer type makes the planner bind the
ramp; every generator layer has it. A standalone generator has no palette and draws its own colours; a template gives it colours
through `roles`.

No generator shipped when this was written. The rule was tried with a temporary generator, since removed: blue and red colourways
kept the white core and the alpha, a fixed layer kept its own colours, and the pictures were inspected. The test in
`title-look-library-gl.test.ts` runs for every generator as soon as one is registered.

### Fonts (TL-053)

Decision: display fonts are committed files, unmodified, from `google/fonts` at the commit in `apps/engine/fonts/display/manifest.json`.
The text fonts stay on `@fontsource`. Reading the catalogue decided it: fontsource subsets and converts its files (TL-003 asks for
upstream bytes), the catalogue only reads its `latin` and `latin-ext` subsets, and Japanese families there come as about a hundred
pieces. Display families use the same `<id>/files/*` layout, so `filePath` and the `/fonts` route barely changed; `build-remotion.mjs`
copies the folder to `dist/fonts`, and `apps/desktop/scripts/package.mjs` already ships that.

To add one: put the file and its `OFL.txt` under `<id>/`, add the entry with its SHA-256, and a row in `ATTRIBUTION.md`. The engine test
checks hashes, licence texts and attribution. Only families with an `OFL.txt` in their upstream folder were taken: M PLUS Rounded 1c
has none there, so Zen Maru Gothic replaced it (AGENTS §3).

The faces: Anton, Bebas Neue, Cinzel, Abril Fatface, Russo One, Bungee, Black Ops One, Monoton, Audiowide, Orbitron, Press Start 2P,
Bangers, Creepster, Pacifico, Righteous, Fredoka, Lilita One, Titan One, Archivo Black (Latin); Dela Gothic One, Reggae One, RocknRoll
One, DotGothic16, Yuji Boku, Kaisei Tokumin, Zen Maru Gothic, Zen Kaku Gothic New (Japanese).

Size: 27 families, **30.4 MB** uncompressed, of which 1.9 MB Latin and 28.5 MB Japanese (17.8 MB gzipped, measured with gzip over
the files). The text fonts already shipped are 7.0 MB, so `dist/fonts` grows about 5.4 times. The repository grows by the same 30.4 MB. A
full installer was not built, so its total is not known. Yuji Boku alone is 8.3 MB: drop it first if size matters.

The rule, `chooseLookFont`: Japanese text takes the look's `ja` face, because Latin display families have no kana. If the caller
passed `availableFonts` and the family is missing, `fallback` takes over. Otherwise the family stands as named and a missing one follows
`FONT_FALLBACK`. A look's weight and tracking come with its font: a display family has few weights, and any other would be synthesised.

### The style check (TL-056)

`lintAppearance(appearance, ctx)` is pure and deterministic. It returns `{issues, unmeasured}`; each issue has a code, a severity, a
stable id, an English message, an i18n template with arguments, the rule it breaks, and `fix: {label, commands}` when the context
names the effect instance. Fixes are one transaction, so one undo.

Thresholds, and why they differ from Pachislop's, are at the top of `lint.ts`. Errors are what makes a title fail outright: nothing
draws, rims at 30 % of the size or more, or a title whose outside matches the measured backdrop. All of these are judgement chosen for
video, not measured against viewers.

The seam for rendered checks: the caller measures the picture and passes `ctx.rendered = {backdropL, frames}`, where `backdropL` is
the mean L* just outside the title at its worst sampled frame. Without it, `unmeasured` lists `backdrop-contrast`: `title_check` must
report that as not measured, never as passed. A halo or a soft shadow counts as separation. Add further rendered checks to
`RENDERED_CHECKS` the same way.

Practice behind the rules: Pachislop's lint credits Japanese telop and title tutorials; chroma subsampling is why lightness carries
edges on video (ITU-R BT.601 and BT.709 4:2:0). Assumption, not documented: 2 px at 1080p as the smallest rim that survives a streaming
encode.

### Templates (TL-052)

A template is JSON-safe data. `title.insertTemplate` runs the ordinary handlers inside one command, as the batch commands do, so the
rules are the single commands', a refusal applies nothing, and one undo removes everything. Text clips carry a look and in and out
animators; shapes carry a one-role look so a colourway reaches them, and keyframes for their motion; generators are `transparent`
solids. Each clip takes the first free track above the one before, so nothing is overwritten, and the clips are grouped.

### User looks (TL-054)

`<appdir>/presets/title-looks.json`, its own file like the other preset libraries, so a build that does not know looks never rewrites it.
Writes are serialized and atomic. Entries that no longer validate go to `invalid` and are written back; an unreadable file moves
aside; a newer file is read-only (`readOnly` in the list, 409 on writes). Export writes `jasper-title-looks` version 1, which Import reads
back with new ids and free names. Save takes `recipeFromAppearance(appearance, t)`. Deleting asks the user when an agent calls it, as
effect presets do. To apply one, pass it to `look.apply` as `look: {name, recipe, sourceId, tags, category, colorways}`.

Routes: `GET`, `POST /api/title-looks`, `PUT`, `DELETE /api/title-looks/:lookId`, `POST /api/title-looks/import`, `POST
/api/title-looks/export`. Event: `titleLooks.changed`.

### Four libraries (TL-055)

| Library | Is | Holds | Home | Stored |
|---|---|---|---|---|
| Text Style | Typography and basic paint | `TextStyle`, linked per clip | Properties ▸ Text Style | `doc.textStyles` |
| Look | An appearance | Layers, palette, light, font | Looks tab | Factory data, user library, and `doc.titleLooks` once used |
| Effect Preset | A stack of ordinary effects | Effects and keyframes | Effects ▸ Presets | `effect-presets.json` |
| Title Template | Clips | Text with a look, shapes, generators, timing | Looks tab links to it | Factory data |

How they meet: a look brings a font when applied and never links to a Text Style, and a Text Style edit does not touch a look. A look never
holds ordinary effects, and an Effect Preset never holds an appearance: `jasper.title-look` is internal, `effect.add` refuses it,
`buildEffectPreset` leaves it out (and refuses a preset of nothing else), and `effect.applyPreset` skips one in an older file with a
warning. Before that, saving a clip's stack stored the look without its appearance and applying added an empty instance. A
template refers to looks by id and expands; once expanded it has no link back. Each has one home, and the Looks tab links to the others
rather than listing them twice.

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
- CIE L*a*b* (D65) from sRGB, IEC 61966-2-1 primaries, as in Pachislop's `toLab`. Rec. 601 luma for the recolour ramp, as design tools'
  gradient maps do.

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

Port map: `licenses/ported/pachislop-rendering.md`, `licenses/ported/pachislop-looks.md`,
`licenses/ported/pachislop-effects.md`.

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
| Text: vertical title, look, keyed Warp Text, run, tate-chu-yoko: Program against a Remotion still, frames 0, 30, 60 | SSIM 1.0000, max difference 0 | `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/title-text.e2e.test.ts`; figures in `test-results/title-text-e2e/metrics.json` |
| Text: text animator on vertical text, Program against a Remotion still, frames 0, 30 | SSIM 1.0000, max difference 0 | same |
| Text: the warped title at 200 % against 100 %, real text | SSIM 0.990 | same |
| Warp meshes against Patchy's compiled C++: 240 meshes | equal to 6 decimals | `pnpm exec vitest run packages/project/test/text-warp.test.ts` |
| Glows in Program against a Remotion still: keyed `deepGlow`, `reflection`, `innerShadow` on a moving sequence light, Deep Glow, Perspective Shadow and a keyed Keyline as effects, frames 0, 30, 60 | SSIM 1.0000, max difference 0 | `REMOTION_E2E=1 pnpm exec vitest run packages/compositions/test/title-look.e2e.test.ts` |
| Deep Glow energy: a 40 × 40 emitter of 1 at radius 40–120 %, falloff 10–90 % | inside the test bounds, 88–105 % of 1 600 (8-bit tails and clipping); exact values not logged | `pnpm exec vitest run packages/compositions/test/title-look-glows-gl.test.ts -t energy` |
| Deep Glow variance against Σ wσ² of its octaves at 100 %, 50 %, 25 % resolution | inside the test bounds, −15 % / +4 %, x and y within 3 %; exact values not logged | same, `-t variance` |
| Deep Glow radius across a pyramid level (116 → 124 %) | largest alpha step at most 6 / 255 (test bound) | same, `-t continuous` |
| Look effects at half resolution against full, perturbed params | SSIM above 0.93 for all ten | same, `-t "half the resolution"` |
| Deep Glow cost, 1080p, SwiftShader | 7.0 s title box, 17.2 s full frame | [performance.md](../performance.md) §7 |

The extension contract was exercised by copying this note's three worked examples verbatim into their own files with their
one-line registrations: they typechecked with no change to the core, and the registry and GL tests picked them up (and failed
for the missing fingerprints, and for a generator example that was clipped by its own padding, now fixed above).

| Poster from disk, 240 × 136, two layers, SwiftShader, shared host | answered as `cached`, under a fifth of the first render (asserted); 580 ms in one run under load | `REMOTION_E2E=1 pnpm exec vitest run apps/engine/test/title-look-posters.e2e.test.ts` |
| Poster, first render, same conditions | ≈ 20 s, not timed alone. Basis: the four tests of that file took 58.6 s for three renders, on a bundle already built | same |

## Limits

- Text entry: tsume, optical and manual kerning, per-paragraph settings and text on a path are edited in plain mode. A tab or browser
  crash loses an entry that was never committed: what commits on `pagehide` is safe, a killed renderer has no such moment.
- A warp bends the layer box, so a fixed box bends more air than text. Use point text.
- The library is part of TL-050 and TL-052: 30 of 60 looks, 14 of 16 templates, none in Brush and 3D. Recorded in `docs/gaps.md`.
- A colourway on a template's standalone generator is applied once, at insertion: `look.setColorway` does not reach it later.
- A template shape's look is shared by role and palette, so `look.update` on it changes every such shape in the project.
- Reach stops at the framework's `FX_MAX_PADDING`, 2048 layer px per side. Deep Glow's radius stops at 1700 px, its reach at full
  scatter. An effect whose params add up past it (a 2000 px cast shadow with a 2000 px blur) clips there: that is a canvas limit, not
  a sampling error. A look's reach is in percent of its unit and meets the same limit.
- `block` gradients on animated text follow the frame's bounds until TL-036 brings layout boxes.
- The layer outline in Program is the layer's reach around the clip box, not its pixels: the box of a text clip is its text box,
  which can be wider than the glyphs.
- The style check's rendered row (contrast against the picture) needs pixels only the engine has: the badge lists it as not measured,
  never as passed. `title_check` measures it for agents.
- `line` and `glyph` spans render as `block` until TL-036 (`docs/gaps.md`).
- The field is rebuilt whenever a frame is redrawn: an animated param on static text pays for it, though the input did not
  change. TL-037 only requires skipping unchanged input and params; `tlField` could be reused across frames when only layer
  uniforms change, by keying the field passes on their own.
