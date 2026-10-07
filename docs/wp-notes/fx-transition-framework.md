# GPU transition framework — authoring guide (wave 2, `wave2/transition-framework`; wave-4 polish §13)

Audience: the wave-3 agents that add transitions (≈35 Premiere standard video transitions, ≈70 Sapphire-style
transitions). You only edit **your family file** (`packages/project/src/registry/transitions/<family>.ts`) and add
tests. You do not touch the renderer, the registry, the Effects panel, Effect Controls, the timeline, the engine or
MCP — every one of them picks your entries up automatically. Read the shader-effect guide first
(`docs/wp-notes/fx-shader-framework.md`): transitions reuse its pass model, GLSL rules and library.

## 1. Where things live

| What | Where |
|---|---|
| Your family file (one `readonly TransitionSpec[]`) | `packages/project/src/registry/transitions/<family>.ts` (§12) |
| `defineShaderTransition`, `TRANSITION_BINS`, `SAPPHIRE_TRANSITION_SUBBINS`, `trParam` | `registry/transitions/define.ts` |
| Types (`GpuTransition`, `TrFrameContext`, `TrPlanContext`), progress, planning, `validateGpuTransition` | `registry/transitions/shader.ts` |
| Transition GLSL library (`GLSL_TRANSITION`, `GLSL_TR_EASE`, `GLSL_TR_WIPE`, `GLSL_TR_BLOCKS`, `GLSL_TR_3D`) | `registry/transitions/glsl.ts` |
| Param builders (`fxParam.*`), pass builders, the fx GLSL library | `registry/fx/params.ts`, `registry/fx/passes.ts`, `registry/fx/glsl/*` |
| The registry (`TRANSITION_SPECS` = 4 built-ins + `FX_TRANSITIONS`), resolution into render stages | `packages/project/src/transitions.ts` |
| Runtime (stage, hub, taps) — read only | `packages/compositions/src/fx/transition.tsx` (+ `fx/stage.ts`, `fx/effects.ts` `fxTap`) |
| Worked examples kept compiling | `packages/compositions/test/transition-examples.ts` |
| Real examples | `premiere-transitions.ts` (Push, Cross Zoom, Iris Round), `sapphire-dissolves.ts` (S_DissolveLuma) |

Everything is exported from `@jasper/project`.

**Import rule.** A family file imports values only from `./define.ts`, `./glsl.ts`, `./shader.ts` and `../fx/*`
(params, passes, glsl), and only **types** from `../../transitions.ts` and `../effects.ts` (`import type`).
`transitions.ts` imports the catalogue, so a value import from it is a module cycle.

## 2. Worked example (complete)

Premiere's Wipe ▸ Clock Wipe: the incoming clip is revealed by a hand sweeping around a centre point, with Premiere's
Border Width / Border Color, Anti-aliasing Quality, Center and Reverse. This is `TEST_CLOCK_WIPE` of
`transition-examples.ts` (compiled and run by the GL test), written as a family entry:

```ts
// packages/project/src/registry/transitions/premiere-transitions.ts
import type { TransitionSpec } from '../../transitions.ts';
import { fxParam } from '../fx/params.ts';
import { defineShaderTransition, TRANSITION_BINS } from './define.ts';
import { GLSL_TR_WIPE } from './glsl.ts';

export const CLOCK_WIPE = defineShaderTransition({
	id: 'jasper.clock-wipe',
	label: 'Clock Wipe',
	bin: TRANSITION_BINS.wipe,                              // Video Transitions ▸ Wipe ▸ Clock Wipe
	description: 'The incoming clip is revealed by a hand sweeping around the center, like a clock.',
	keywords: ['clock', 'radial', 'sweep'],
	params: [fxParam.angle('startAngle', 'Start Angle', -90)],   // u_startAngle (degrees, 0° = right, clockwise)
	options: { border: true, antiAliasing: true, center: true }, // + u_borderWidth, u_borderColor, u_antiAliasing, u_center
	gpu: {
		passes: [
			{
				include: [GLSL_TR_WIPE],
				frag: /* glsl */ `
void main() {
  vec2 c = u_center * u_compSize;                       // the centre point in sequence px
  float aa = tr_aaWidth(u_antiAliasing);                // Off / Low / Medium / High → 0 / 1 / 2 / 3 px
  // Overshoot the sweep a little so the soft edge and the border have left the frame at progress 1.
  float p = tr_progress() * (1.0 + (u_borderWidth + aa) / (6.2832 * tr_coverRadius(c)));
  float d = tr_clockWipe(tr_px(), c, p, u_startAngle);  // signed px distance, > 0 = B side
  fragColor = tr_wipeMix(tr_from(v_uv), tr_to(v_uv), d, 0.0, aa, u_borderWidth, u_borderColor);
}`,
			},
		],
	},
});

export const PREMIERE_TRANSITIONS: readonly TransitionSpec[] = [PUSH, CROSS_ZOOM, IRIS_ROUND, CLOCK_WIPE];
```

That is all. The transition now appears in the Effects panel (Video Transitions ▸ Wipe, **GPU** badge, the N/GPU
filters, drag onto an edit point / clip edge, double-click applies to the selected clips, Set as Default), on the
timeline (drawn like every transition, Replace With ▸ Wipe ▸ Clock Wipe), in Effect Controls' Transition section
(type, duration, alignment, A/B diagram, then Start, End, Start Angle, Border Width, Border Color, Reverse,
Anti-aliasing Quality, Center rows, stopwatches on the animatable ones), in the agent schema (`transitions`) and MCP
(`list_transition_types`, `add_transition {type: "clock-wipe" | "Clock Wipe", params}`), in the Player, stills and
exports (Remotion path), and in the catalogue + GL tests.

## 3. How a transition renders

A GPU transition is **one shader stage per transition** in sequence (frame) space, drawn above its track's clips
for the transition span, replacing both clips there:

1. The outgoing clip **A** and the incoming clip **B** are drawn by their own layers, with everything they have —
   effects (shader, colour, CSS), crop, Motion, corner pin, opacity — but instead of reaching the screen, each
   layer's finished picture is captured (the last step of the layer's fx chain, `fxTap`).
2. The stage's first two passes (the framework's) place A and B in the sequence frame: `u_from` and `u_to`,
   sequence-sized, premultiplied, transparent outside the layers (a PiP stays a PiP; a layer with alpha keeps it).
3. Your passes run with both pictures available and write the stage's output (sequence-sized, premultiplied). It is
   composited over the tracks below like a layer (the sides' common blend mode if they share one, else Normal).

So every transition can read **both sides anywhere**: luma dissolves (A's luma decides where B shows), page peels (B
under A, A's back on the peel), cube spins, card flips, film burns between shots, "dissolve through glow" of both.

**Two-sided** (an edit point): A plays into its tail handle, B starts in its head handle (media handles as for a
cross dissolve; the duration is fitted to them). **One-sided** (a clip edge with nothing on the other side, Premiere's
"single-sided" transition): the missing side is **transparent** (`u_hasFrom` / `u_hasTo` false) — a transition at
the head of B goes from transparency (what is below: lower tracks or the black background) to B, one at the tail of
A from A to transparency. Want black instead (e.g. a "dip")? Draw it: the stage can paint any colour.

**Progress** (`u_progress`, 0..1, also `TrFrameContext.progress`):

- linear progress of frame `i` of a `d`-frame span: two-sided `(i + 1) / (d + 1)` (exactly the built-in Cross
  Dissolve's ramp), fade at a head `i / d` (first frame = A side), fade at a tail `(i + 1) / d` (last frame = B side);
- Custom Completion (wave 4, params `useCompletion` / `completion`, §13.5): when on, the keyframable Transition
  Completion (0…100 %) at the frame replaces `linear` (call it `timing`; off — the default — `timing = linear`);
- Start / End (Premiere's sliders, params `startPercent` / `endPercent`): `p = start + (end − start) · timing`;
- Reverse (param `reverse`): with the default `gpu.reverse: 'swap'` the framework swaps the sides and uses `1 − p`,
  i.e. the transition plays from B to A backwards: an iris that opens on B closes on A, a push to the right becomes
  a push to the left. With `reverse: 'custom'` nothing is swapped and your shader reads `u_reverse` itself (use it
  when "reverse" means something else for your transition, e.g. a page peel that curls the other way).

**Contract** (checked by the GL test for every transition): at `u_progress = 0` the output is A, at `1` it is B
(within a few levels). Ease inside if you like (`tr_easeInOut`), but keep the ends.

## 4. Spec fields

`defineShaderTransition(init)` → `TransitionSpec` with `version: 1`, `appliesTo: 'video'`,
`capabilities: {preview: 'webgl', export: ['remotion']}`, params = Start, End, your params, the requested options.

| `init` field | Meaning |
|---|---|
| `id` | `jasper.<kebab>` (Premiere family) or `jasper.s.<kebab>` (Sapphire families). Never reuse an id; never the built-ins' (`jasper.cross-dissolve`, `jasper.dip-to-black`, `jasper.constant-gain`, `jasper.constant-power`). |
| `label` | Effects-panel name (Premiere: `Clock Wipe`; Sapphire style: `S_WipeClock`). |
| `bin` | `TRANSITION_BINS.motion3d` ('3D Motion'), `.dissolve`, `.iris`, `.pagePeel`, `.slide`, `.wipe`, `.zoom`; Sapphire families: `TRANSITION_BINS.sapphire` ('Sapphire Transitions'). Required. |
| `subBin` | Sapphire families: `SAPPHIRE_TRANSITION_SUBBINS.dissolves` / `.wipes` / `.other` (required there, checked). Premiere: omit. |
| `description` | Required (tooltip, agent catalogue). `keywords`: extra search words. |
| `params` | Your own `ParamSpec`s (`fxParam.*`), shown after Start / End. Names: letters and digits. No `curve`, `string` params; `media` params take still images only (`fxParam.media(name, label, ['image'])`, hold-only, §13.2). |
| `options` | `{border?, antiAliasing?, center?, reverse?, completion?}` — Premiere's standard options (§5). Reverse and Custom Completion are on unless `reverse: false` / `completion: false`. |
| `expensive` | Heavy in the preview (many taps per pixel, multi-pass blurs, iterative passes) — `TransitionSpec.expensive`, §13.1. |
| `gpu` | `GpuTransition` (below). |
| `version`, `migrate` | Bump `version` + `migrate(fromVersion, params)` when params change meaning. |

`GpuTransition`:

| Field | Meaning |
|---|---|
| `passes` | `ShaderPass[]`, or `(params, ctx: TrPlanContext) => ShaderPass[]` when passes depend on params (blur radius, iterations). `ctx = {width, height (sequence px), fps, duration (span frames)}`. Same `ShaderPass` fields as effects: `frag`, `output`, `include`, `scale`, `format`, `filter`, `uniforms`, and the follow-ups `size` (absolute px), `update` (ping-pong outputs), `mipmaps` (fx guide §17.4). |
| `uniforms(params, ctx: TrFrameContext)` | Derived uniforms of every pass (`u_<name>`; types from values as for effects). `ctx` adds `frame` (0…d−1), `linear`, `progress`, `seed`, `reversed`, `hasFrom`, `hasTo`. |
| `reverse` | `'swap'` (default) or `'custom'` (§3). |

There is no `padding` (the stage is the frame) and no time hooks: a side is its clip at the current frame. Sides are
pictures at the current frame only — a transition that needs earlier frames of a side is not possible in this
framework (none of the Premiere / Sapphire list does).

## 5. Uniforms and params

Declared in every pass of a transition (in addition to your params and `gpu.uniforms`):

| Uniform | Meaning in a transition |
|---|---|
| `sampler2D u_from`, `u_to` | A and B placed in the frame (premultiplied, linear, clamp-to-edge). Read them with `tr_from(uv)` / `tr_to(uv)` (transparent outside 0..1). Available in **every** pass. |
| `bool u_hasFrom`, `u_hasTo` | The side exists (false = one-sided, that side is transparent). |
| `float u_progress` | Transition progress (§3). `tr_progress()` = clamped. |
| `int u_side` | Always 0 in the stage. (Effects ON a side layer see `u_side` 1 = outgoing, 2 = incoming and the same `u_progress` — the fx framework's hook; note the brief's 0/1 numbering is not used: 0 means "no transition" there.) |
| `float u_frame`, `u_duration`, `u_time`, `u_fps` | Frame inside the span (0…d−1), span length, seconds, fps. `u_clipProgress` = `u_frame / (u_duration − 1)`. |
| `float u_seed` | Deterministic 0..1 per transition (+ a numeric `seed` param: `seedParam()` feeds it). |
| `vec2 u_compSize`, `u_canvasSize`, `u_resolution`, `u_texel` | Frame size (px); the current pass's output size and texel. |
| `vec4 u_box`, `mat3 u_layerToComp`, `float u_pxScale` | The whole frame, identity, 1 (frame space). `fx_layerNorm()` = `v_uv`. |
| `sampler2D u_source`, `u_prev` | `u_source` is unused (a 1×1 transparent picture); `u_prev` = the previous pass's output (first own pass: `u_to`). Read `u_from`/`u_to` instead. |
| `u_samples`, … | Not used (no time samples). |

Params → uniforms exactly as for effects: `u_<name>` — number → `float`, boolean → `bool`, enum → `int` (index in
`options`), vec2 → `vec2`, color → `vec4` (straight RGBA: premultiply yourself, `tr_premul`).

**Standard params** (`trParam.*`, appended by `defineShaderTransition` in Premiere's order):

| Param | Uniform | Notes |
|---|---|---|
| Start `startPercent` (0…100, default 0), End `endPercent` (default 100) | `u_startPercent`, `u_endPercent` | Applied by the framework to `u_progress`; you never need them. Hold-only. |
| Custom Completion `useCompletion` (default off), Transition Completion `completion` (%, default 50, animatable) — on unless `options.completion: false` | `u_useCompletion`, `u_completion` | Applied by the framework (`transitionTiming`, §13.5); you never need them. |
| *your params* | | |
| Border Width `borderWidth` (sequence px, default 0), Border Color `borderColor` (default black) — `options.border` | `u_borderWidth`, `u_borderColor` | Draw the border on B's side of the edge: `tr_wipeMix(..., u_borderWidth, u_borderColor)`. |
| Reverse `reverse` (default false) — on unless `options.reverse: false` | `u_reverse` | Handled by the framework with `reverse: 'swap'`. |
| Anti-aliasing Quality `antiAliasing` (Off/Low/Medium/High, default Low) — `options.antiAliasing` | `u_antiAliasing` (int) | Edge width in px: `tr_aaWidth(u_antiAliasing)`. |
| Center `center` (point normalised to the **frame**, default [0.5, 0.5]) — `options.center` | `u_center` | px = `u_center * u_compSize`. |

Conventions of your own params (normative): sizes, widths, softness in **sequence pixels** (`fxParam.pixels`; no
`u_pxScale` needed — the stage is always full resolution); angles in degrees, 0° = right, clockwise
(`fxParam.angle`, `fx_dir(deg)`); directions as Premiere's edge selectors (`fxParam.choice('direction', 'Direction',
['westToEast', …], ['West to East', …], …)`, convert to a vector in `gpu.uniforms`, see Push); counts (blocks,
bands, strips) as `fxParam.number` with `step: 1`; feather / softness in px; percentages 0..100.

Animatable params (numbers, vec2, colours — not choices or toggles) take keyframes: Effect Controls' stopwatch, or
`param.set` / `keyframe.add` with target `["transition", <id>, <name>]`. Keyframe times are flicks from the
transition's first frame; the stage evaluates them per frame.

## 6. GLSL rules and helpers

The validator (`validateGpuTransition`, run by the catalogue test) also rejects extra uniforms that redeclare a
built-in, a param uniform or a pass output (§13.4).

All rules of the shader-effect guide hold: GLSL ES 3.00 bodies (`void main()` writing `fragColor`), no `#version`,
precision, `in`/`out` or uniform declarations of built-ins/params/outputs (all generated), `texture()` not
`texture2D`, `v_uv` with (0,0) = top-left (never `gl_FragCoord`), premultiplied in and out, `vec4(0)` for nothing.
Pass outputs `from`, `to`, `trFrom`, `trTo` are reserved.

`GLSL_TRANSITION` (always included, no need to list it):

| Function | Meaning |
|---|---|
| `tr_from(uv)`, `tr_to(uv)` | A / B at a frame position (transparent outside the frame). |
| `tr_inFrame(uv)`, `tr_px()`, `tr_uvOfPx(px)`, `tr_aspect()` | Frame tests and coordinates (px = sequence px, y down). |
| `tr_progress()` | `clamp(u_progress, 0, 1)`. |
| `tr_over(top, base)`, `tr_premul(straight)` | Premultiplied over; straight → premultiplied. |
| `tr_coverRadius(px)`, `tr_halfDiagonal()` | Radius from `px` that covers the frame; half the diagonal. |

`GLSL_TR_EASE` (`tr/ease`): `tr_linearstep(a, b, x)`, `tr_phase(p, a, b)` (progress of a sub-interval),
`tr_easeIn/Out/InOut` (cubic), `tr_easeInOutSine`, `tr_easeInOutExpo`, `tr_smoother`.

`GLSL_TR_WIPE` (`tr/wipe`): `tr_aaWidth(q)`, `tr_edge(d, soft, aa)` (coverage of the B side of an edge at signed px
distance `d`), `tr_wipeMix(a, b, d, soft, aa, border, borderColor)` (the standard wipe composite with Premiere's
border), `tr_linearWipe(px, dir, p, margin)` (straight edge travelling along `dir` — Wipe, Band Wipe, Barn Doors,
Venetian Blinds build on it), `tr_circle(px, c, r)`, `tr_boxDist(px, c, halfSize)` (Iris Box), `tr_irisRadius(c, p,
margin)`, `tr_clockWipe(px, c, p, startDeg)`.

`GLSL_TR_BLOCKS` (`tr/blocks`): `tr_cell(uv, grid)`, `tr_cellUv(uv, grid)`, `tr_cellRandom(cell, seed)` (integer hash,
identical on every GPU), `tr_stagger(p, t0, width)` (per-element windows: Random Blocks, Checker Wipe, Zig-Zag,
Strip Slide), `tr_squareGrid(count)`.

`GLSL_TR_3D` (`tr/3d`): `tr_card(uv, angle, axis, dist, scale)` → (card uv, face): the frame as a card rotated about its
vertical (axis 0) or horizontal (axis 1) centre line in perspective — Flip Over, Card Flip, Cube Spin (two cards at
±90° offsets), Swish 3D. Back faces come mirrored back so a picture on the back reads correctly.

The fx library works here too (`GLSL_HASH`, `GLSL_NOISE` for burns / flutter / TV noise, `GLSL_COLOR` (`fx_luma`),
`GLSL_BLEND`, `GLSL_UV` (`fx_rot`, `fx_dir`), `GLSL_BLUR` (`fx_zoomBlur` for whips and swish pans), and the pass
builders `gaussianBlurPasses` / `bloomPyramidPasses` with `input: 'from'` / `'to'` / any of your outputs). Shared
GLSL of your own family: a `GlslChunk` in your family file (named `<family>/<name>`); propose library additions to
the integrator instead of editing `glsl.ts`.

## 7. Determinism

Every frame is a pure function of (document, frame): Player, stills, parallel render pages and random seeks draw the
same pixels. Randomness = `u_seed` + `u_frame` + positions through the integer hashes (`tr_cellRandom`, `fx_hash2/3`,
`fx_random`, `GLSL_NOISE`); in TS `fxRandom(ctx.seed, n)`. No `Math.random`, clocks or state between frames.

## 8. Multi-pass and both sides

A Sapphire-style "dissolve through glow" (`TEST_DISSOLVE_GLOW` of `transition-examples.ts`): the cross-faded picture
at half resolution, blurred, then added back, strongest mid-way:

```ts
export const S_DISSOLVE_GLOW = defineShaderTransition({
	id: 'jasper.s.dissolve-glow',
	label: 'S_DissolveGlow',
	bin: TRANSITION_BINS.sapphire,
	subBin: SAPPHIRE_TRANSITION_SUBBINS.dissolves,
	description: 'Dissolves through a glow: both clips bloom towards the middle of the transition.',
	params: [
		fxParam.pixels('glowWidth', 'Glow Width', 30, 200),
		fxParam.number('brightness', 'Brightness', 1.5, { min: 0, max: 10, step: 0.01 }),
	],
	gpu: {
		passes: (p): ShaderPass[] => [
			{
				output: 'mixed',                 // later passes read uniform sampler2D u_mixed
				scale: 0.5,
				include: [GLSL_TR_EASE],
				frag: /* glsl */ `
void main() {
  fragColor = mix(tr_from(v_uv), tr_to(v_uv), tr_easeInOut(tr_progress()));
}`,
			},
			...gaussianBlurPasses({ input: 'mixed', output: 'glow', sigma: num(p.glowWidth, 30), scale: 0.5 }),
			{
				include: [GLSL_TR_EASE, GLSL_COLOR],
				frag: /* glsl */ `
void main() {
  float p = tr_progress();
  vec4 base = mix(tr_from(v_uv), tr_to(v_uv), tr_easeInOut(p));
  float k = sin(3.14159265 * p) * u_brightness;   // 0 at both ends: exactly A, then exactly B
  vec4 g = texture(u_glow, v_uv);
  fragColor = vec4(min(base.rgb + g.rgb * k, vec3(base.a + g.a * k)), min(1.0, base.a + g.a * k));
}`,
			},
		],
	},
});
```

S_DissolveLuma (`sapphire-dissolves.ts`) shows the other pattern: a pass computes a map from one side (`u_lumaFrom
== 0 ? tr_from(v_uv) : tr_to(v_uv)`), a blur, and the final pass thresholds it to mix A and B.

Recipes: a page peel samples `tr_from` on the flat part, `tr_from` at the mirrored position (darkened) on the curl's
back and `tr_to` under it; a cube spin draws two `tr_card`s (A at angle `p·90°`, B at `p·90° − 90°`) and keeps the
nearer; a film burn builds a noise mask (`fx_fbm` with `u_seed`) that crosses from A to B through a hot colour; a
swish pan offsets both sides along a direction with `fx_zoomBlur`-like directional taps; strips/bands use `tr_cell`
on one axis with `tr_stagger`.

Motion blur of a move (wave 5): taps along the REAL path in progress space, as many as the on-screen travel needs —
`fx_mbShutter` / `fx_mbTapCount` / `fx_mbJitterFor` / `fx_mbTapAt` / `fx_mbDyn` of `GLSL_MB` (fx guide §19.3); never a
fixed handful of straight taps around the current pose.

## 9. Tests to write (per family)

Free for every entry (no plumbing):

- `packages/project/test/transition-framework.test.ts` — ids/prefixes, bins and sub-bins, description, Start/End
  present, `validateGpuTransition`, registry + agent schema wiring;
- `packages/compositions/test/transition-gl.test.ts` — **compiles and runs every registered GPU transition** in real
  WebGL2 (headless Chrome, SwiftShader): two-sided at the start and middle, one-sided in/out, reversed; and checks the
  §3 contract (A at progress 0, B at 1). One test per family of `TRANSITION_FAMILIES` (240 s each, as
  `fx-gl.test.ts` does for effects) plus one for the test transitions — a new family file gets its own test for free.

```bash
pnpm vitest run packages/project/test/transition-framework.test.ts packages/compositions/test/transition-gl.test.ts
```

Add in your family's own test file (`packages/project/test/transition-<family>.test.ts` and/or
`packages/compositions/test/transition-<family>-gl.test.ts`, copying the pattern of `test/transition-gl/entry.ts`:
`run(spec, params, {frame, duration, sides, out, in})` → pixels): one characteristic pixel per transition mid-way
(e.g. "the left half is B at progress 0.5 for a West-to-East wipe"), the border colour where it is drawn, Reverse,
the TS maths of `gpu.uniforms` / `passes` functions (pure), determinism of random ones (same seed → same pixels,
other `seed` → different).

Renders: `REMOTION_E2E=1 pnpm vitest run packages/compositions/test/transition-render.e2e.test.ts
packages/compositions/test/transition-player.e2e.test.ts` (Chrome + ffmpeg). For a visual check of your family over
real footage add your ids to `transition-gallery.e2e.test.ts` locally and run it with
`REMOTION_E2E=1 TRANSITION_GALLERY=/tmp/gallery` — then look at the PNGs.

## 10. What runs where

| | Preview (Player) | Renders / export |
|---|---|---|
| media sides (video, still, solid, composition master) | yes — the layer's `FxPicture` chain with the tap | yes |
| DOM sides (text, shapes, motion graphics), offline / pending cards | via HTML-in-Canvas (Electron, Chrome ≥ 148 with the flag); otherwise **fallback**: B dissolves in (A stays), chip "… needs HTML-in-Canvas" on the stage | yes (Remotion's render browser always has it) |
| no WebGL2 / lost context | fallback dissolve + chip | fails `WEBGL_UNAVAILABLE` |
| a side with a pre-rendered (`baked`) picture | fallback + chip | fails `FX_TRANSITION_UNSUPPORTED` on the Remotion path; native/hybrid exports bake the span from the sides' sources (no `baked` field), so it works there |
| a shader that does not compile | the stage stays empty, error logged once | fails `FX_SHADER_ERROR` |
| export path | — | wave1c (ARCHITECTURE D-35): the export stays native (`hybrid`): the layer-bake extension renders only the transition's span (sides A + B + stage, straight-alpha master, cached by content) with Remotion and the builder overlays it in the track's place; the sides are drawn natively outside the span. Without the layer-bake renderer the planner still routes the export to Remotion ("… is a GPU transition and no span renderer is available") |

## 11. Limitations (wave 2)

- **Export granularity.** Done in wave1c (`docs/wp-notes/native-animated-export.md`, D-35): only the span is rendered
  by Remotion (a span master per transition); everything else stays native.
- SVG-filter-only effects on a side (effects with neither a shader, a colour op nor a single CSS filter) are not part
  of its captured picture during the span (they are drawn after the fx chain normally).
- Composition clips whose live host iframe is shown in the preview (no cached preview yet) cannot be captured
  (HTML-in-Canvas does not see into iframes) — they appear transparent in the stage until the preview WebM exists.
- Keyframe times are relative to the stored span start; if the media handles shorten the span at render time the
  keys stay where they were (relative to the stored start).
- The A/B thumbnails of Premiere's Effect Controls ("Show Actual Sources") are not implemented (the section shows the
  A/B handle diagram). Point params (Center…) have on-canvas handles since wave 4 (§13.8).
- The preview draws the stage at the sequence resolution (no preview-resolution scale).

## 12. Families, ids, bins

| File | Export | Ids | Bins | Wave-3 scope |
|---|---|---|---|---|
| `premiere-transitions.ts` | `PREMIERE_TRANSITIONS` | `jasper.*` | `TRANSITION_BINS.motion3d/dissolve/iris/pagePeel/slide/wipe/zoom` | Premiere's standard video transitions (Cube Spin, Flip Over; Additive / Film / Non-Additive Dissolve, Dip to White; Iris Box / Cross / Diamond; Page Peel, Page Turn; Center Split, Slide, Split, Band Slide…; Band Wipe, Barn Doors, Checker Wipe, CheckerBoard, Clock Wipe, Gradient Wipe, Inset, Paint Splatter, Pinwheel, Radial Wipe, Random Blocks, Random Wipe, Spiral Boxes, Venetian Blinds, Wedge Wipe, Wipe, Zig-Zag Blocks…). Already there: Push, Cross Zoom, Iris Round. Cross Dissolve and Dip to Black are the native built-ins — do not duplicate. |
| `sapphire-dissolves.ts` | `SAPPHIRE_DISSOLVE_TRANSITIONS` | `jasper.s.*` | `.sapphire` + `SAPPHIRE_TRANSITION_SUBBINS.dissolves` | S_Dissolve* (already there: S_DissolveLuma). |
| `sapphire-wipes-other.ts` | `SAPPHIRE_WIPES_OTHER_TRANSITIONS` | `jasper.s.*` | `.sapphire` + `.wipes` (S_Wipe*) / `.other` (S_SwishPan, S_Swish3D, S_CardFlip, S_FilmBurnTransition, S_FilmRoll, S_FlutterCut, S_HyperPull, S_HyperPush, S_MochaWhip, S_ParallaxStripsTransition, S_StripSlideTransition, S_TVChannelChange, S_WhipLash) | |

The Effects panel lists Video Transitions ▸ bin (▸ sub-bin) ▸ transition, Premiere's bins first, Sapphire Transitions
last, each item with the GPU badge (built-ins: N).

## 13. Wave-4 additions (`wave4/transition-polish`)

### 13.1 `expensive`

`defineShaderTransition({…, expensive: true})` → `TransitionSpec.expensive`, exactly like `EffectSpec.expensive`:
Effect Controls' Transition section header shows the same "●" ("Expensive in preview") an expensive effect's
section shows; the agent schema (`transitions[].expensive`) and MCP `list_transition_types` export it. The Effects
panel does not badge expensive effects, so it does not badge transitions either; no planner or preview code reads
`expensive` for effects today (S03 PGM-031 "fx reduced" playback is not implemented), so transitions do not change
rendering either — it is a flag for panels and agents. Marked: S_Swish3D, S_HyperPush, S_HyperPull, S_FilmRoll,
S_ParallaxStripsTransition, S_DissolveDefocus, S_DissolvePixelSort, S_DissolvePixelMosh, S_DissolveZap,
S_DissolveAutoPaint, S_DissolveGlow / S_DissolveUltraGlow / S_DissolveLightLeak (the glow dissolves),
S_DissolveRays, S_DissolveDigitalDamage, Morph Cut, VR Spherical Blur (2 × 25 spherical taps per pixel).

### 13.2 Image (`media`) params

`fxParam.media('gradientImage', 'Custom Gradient', ['image'])` (hold-only; `mediaKinds` must be `['image']` — the
validator rejects video and LUT kinds). Binding and semantics are the effects': `uniform sampler2D u_<name>` +
`uniform vec2 u_<name>_size` (px, **(0, 0) when none, missing, offline or still loading in the Player**), the picture
premultiplied, uv (0,0) = top-left; `planGpuTransition` lists them in `plan.textures` (`transitionMediaTextures`).
Each image param takes one of the 12 texture units (with the named outputs; 4 are the framework's). The render
snapshot gives bound images media handles (as effect params), `TransitionStage` loads them (`useFxImages`; renders
hold a delayRender until a draw ran with every bound image), Effect Controls edits them with the effects' picker,
MCP lists `mediaKinds`. Hybrid export: the span bake's key already hashes `referencedMediaIds(t.params)` with their
fingerprints (`keyMedia`), so a replaced image re-bakes (covered by `apps/engine/test/gpu-spans.test.ts`).

Used by Premiere **Gradient Wipe** and **VR Gradient Wipe** (Premiere's "Custom…" gradient): with an image its
luminance × alpha is the gradient (stretched to the frame; VR: an equirectangular gradient over each eye); without
one the built-in Gradient choice applies, so existing documents render as before.

### 13.3 Trackers of the sides

`RenderTransition.tracks?: {out?, in?}: TrSideTrack` — set by `buildRenderSnapshot` for a side whose clip has a
tracker (`transitionTrackerOf`: the first planar tracker with samples, else the first tracker with samples, else the
first tracker's reference). `transitionSideTrack` evaluates it for every span frame (`trackerGeometryAt` at the
side's content time, smoothing included) and maps it through the side's layer map at that frame (Motion + corner pin,
as its picture is placed) into **sequence px**. Trackers otherwise reach effects only as baked keyframes
(`tracker.apply` → corner pin / Motion); transitions get the live geometry instead.

Authors read it in `gpu.uniforms(p, ctx)`: `ctx.tracks?.from` / `ctx.tracks?.to` (after a Reverse swap: the side
shown as `u_from` / `u_to`) = `TrTrackFrame {kind, corners (TL, TR, BR, BL) | null, point (the centre), confidence,
tracked}` or null. Because the tracks are part of the `RenderTransition`, the span bake key covers them.

**S_MochaWhip** (Track Mode = Follow Clip Track, default): with a track on the incoming clip the cut-out follows it
frame by frame — a planar track's quad is the cut-out region (Blur Mocha feathers it, Invert Mocha inverts it); a
point track centres the mask (Mask Size / Rotation, an ellipse when Cutout Mask is None) on the tracked point; the
cut-out pivots and lands around the tracked centre. Without a track (or Track Mode Off) it is the wave-3 behaviour:
the Cutout Mask shape, or a plain whip with Cutout Mask = None.

### 13.4 Validator: uniform collisions

`validateGpuTransition` and `validateGpuEffect` (shared `uniformCollisions`) reject extra uniforms — keys of
`gpu.uniforms()` and of `ShaderPass.uniforms` — that collide with a built-in (fx + transition built-ins: `u_from`,
`u_hasTo`…), a param uniform (`u_<param>`, `u_<media>_size`), a pass output (`u_<output>`), and a pass uniform that
`uniforms()` also returns. Before, these failed only when a shader mentioning the name compiled.

### 13.5 Custom Completion (keyframable timing curve)

Every GPU transition gets, after Start / End, **Custom Completion** (`useCompletion`, hold-only, default off) and
**Transition Completion** (`completion`, %, animatable, default 50). Semantics (`transitionTiming`):

- off (default, every existing document): the linear ramp of §3, unchanged — identical output;
- on: `timing = completion / 100` at the frame (keyframes are flicks from the span start, as every transition param),
  replacing the linear ramp; Start / End map it (`p = start + (end − start) · timing`) and Reverse applies on top.
  The sides' GPU effects see the same `u_progress`.

The progress contract is kept in its documented form: at `p = 0` the stage is A, at `p = 1` B. The linear two-sided
ramp never reaches 0 / 1 inside the span (Cross Dissolve's `(i + 1) / (d + 1)`); a curve can — keyed 0 % on the first
frame and 100 % on the last, the first frame is exactly A and the last exactly B. Turning Custom Completion on in
Effect Controls with an unanimated Completion seeds exactly that curve (two keys, one history entry); a static value
holds the transition at that percentage (Sapphire's Dissolve Percent). `options.completion: false` leaves the pair
out of a transition.

### 13.6 Push border

Push moved both pictures by `p` frames and drew the border on B's side of the seam, so at `p = 1` the band stayed along
the far edge. Now A, the band and B travel together by one frame + the border (`s = p · (1 + border / extent)`): at
`p = 0` the band is just outside the near edge, at `p = 1` just outside the far edge (exactly A / exactly B). Without a
border the output is unchanged. `transition-render.e2e` encoded the old seam (`p · H`); it now checks `p · (H + 12)`
and the last frame of a tail fade (`p = 1`: no band at the far edge).

### 13.7 GL test per family

`transition-gl.test.ts` runs the catalogue and the A/B contract per `TRANSITION_FAMILIES` entry (`catalogue(family)`
/ `ends(family)` of `test/transition-gl/entry.ts`), plus GL checks of image params, the Push border at the ends,
S_MochaWhip's track and Custom Completion.

### 13.8 On-canvas point handles

While a transition is selected in the Timeline (= shown in Effect Controls' Transition section), the Program monitor
draws the effects' crosshair for every point param of its type (`vec2` with `ui.control: 'point'`: Center, Swish /
WhipLash centres, MochaWhip's mask / cut-out centres…), `apps/web/src/fx/TransitionPointOverlay.tsx`. Transition
points are frame-normalised (no layer map). A drag is one gesture writing `param.set` on `["transition", id, name]`;
an animated param gets a key at the playhead clamped into the span, as the section's rows do.
