// The Title Looks catalogue: every layer type, finish and generator, normalised for the planner, validation, the UI
// and the tests. Nothing else in the codebase lists them.
import type { LayerParamValue, Paint } from '../../../title-looks/model.ts';
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import { type FxUniformValue, fxPatternFrame, type GlslChunk, type ShaderPass } from '../shader.ts';
import {
	type GeneratorColor,
	type GeneratorPreset,
	isPaintParam,
	type LayerParams,
	type LayerShader,
	layerSwatch,
	lp,
	type PrepassContext,
	type TitleFinish,
	type TitleGenerator,
	type TitleLayerInit,
	type TitleLayerType,
	type TitleParamSpec,
} from './contract.ts';
import { TITLE_FINISHES } from './finishes/index.ts';
import { TITLE_GENERATORS } from './generators/index.ts';
import { GLSL_TLG_LOOK_SHAPE, GLSL_TLG_WINDOW, standInChunk } from './generators/shared.ts';
import { GLSL_TL_PAINT, GLSL_TL_SURFACE, GLSL_TL_UNIT_KNOWN } from './glsl.ts';
import { TITLE_LAYER_INITS } from './layers/index.ts';
import { paintOf } from './paint.ts';

export const GENERATOR_LAYER_PREFIX = 'generator:';

/** The `finish` param of every layer type that takes one. */
const finishParam = (): TitleParamSpec =>
	lp.choice(
		'finish',
		'Finish',
		TITLE_FINISHES.map((f) => f.id),
		TITLE_FINISHES.map((f) => f.label),
		'flat',
	);

/** Output of a generator drawn at reduced size (`TitleGenerator.lowRes`). */
const LOW_RES_OUTPUT = 'tlGenD';

/** `#define`s of a generator at these params, and the look or standalone marker. */
const generatorDefines = (g: TitleGenerator, p: LayerParams, standalone: boolean) =>
	`${standalone ? '#define TLG_STANDALONE 1\n' : ''}${g.defines?.(p) ?? ''}`;

/** A pass of a generator: its program text with `defines`, its chunks and `uniforms`. */
function generatorPass(
	pass: ShaderPass,
	defines: string,
	include: readonly GlslChunk[],
	uniforms: Readonly<Record<string, FxUniformValue>>,
	written: Set<string>,
	standalone: boolean,
): ShaderPass {
	const output = pass.output;
	const again = output !== undefined && (!standalone || written.has(output));
	if (output !== undefined) written.add(output);
	return {
		...pass,
		frag: `${defines}${pass.frag}`,
		include: [...include, ...(pass.include ?? [])],
		uniforms: { ...uniforms, ...pass.uniforms },
		...(pass.draw ? { draw: { ...pass.draw, vert: `${defines}${pass.draw.vert}` } } : {}),
		...(again ? { update: true } : {}),
	};
}

const LUMA = 'vec3(0.2126, 0.7152, 0.0722)';

/**
 * TL-051: a generator in a look recolours through a luma gradient map: its brightness picks along the paint, from black
 * up to the paint, and the hottest part goes white, so a fire in a blue look is blue with a white core.
 */
function recolorGlsl(mode: GeneratorColor['mode'], gradient: boolean): string {
	const paint = gradient
		? 'tl_ramp(u_paintRamp, x)'
		: 'vec4(tlPaint_paint(s).rgb * smoothstep(0.0, 0.55, x), tlPaint_paint(s).a)';
	const map = /* glsl */ `
vec3 tl_lumaMap(float x, TlSurface s) {
  vec4 c = ${paint};
  return mix(c.rgb, vec3(1.0), smoothstep(0.72, 1.0, x));
}`;
	if (mode === 'flat')
		return /* glsl */ `
vec4 tl_recolor(vec4 g, TlSurface s) { return tlPaint_paint(s) * g.a; }`;
	if (mode === 'luma')
		return /* glsl */ `${map}
vec4 tl_recolor(vec4 g, TlSurface s) {
  if (g.a <= 0.0) return vec4(0.0);
  float x = clamp(dot(g.rgb / g.a, ${LUMA}), 0.0, 1.0);
  return vec4(tl_lumaMap(x, s) * g.a, g.a);
}`;
	return /* glsl */ `${map}
vec4 tl_recolor(vec4 g, TlSurface s) {
  vec3 c = tl_lumaMap(clamp(dot(g.rgb, ${LUMA}), 0.0, 1.0), s);
  return vec4(c, clamp(max(c.r, max(c.g, c.b)), 0.0, 1.0)) * min(g.a * 8.0, 1.0);
}`;
}

/** A generator as a look layer: its picture, composited like any other layer, recoloured through the look (TL-051). */
function generatorLayer(g: TitleGenerator): TitleLayerType {
	const color: GeneratorColor = g.color ?? { role: 'glow', mode: 'light' };
	const t: TitleLayerType = {
		type: `${GENERATOR_LAYER_PREFIX}${g.id}`,
		label: g.label,
		description: g.description,
		finish: false,
		params: [
			...g.params,
			lp.toggle('ownColors', 'Own Colours', color.fixed === true),
			...lp.paint('paint', 'Look Colour', { kind: 'role', role: color.role }),
			lp.percent('opacity', 'Opacity', 100),
		],
		// TL-051: the planner binds `u_tlRecolor` = not `fixedColor`. A look that fixes the layer's colour keeps the
		// generator's own colours, as Own Colours does (fire defaults to it).
		recolors: true,
		shader: (p): LayerShader => {
			const gradient = paintOf(p.paint, { kind: 'color', color: [1, 1, 1, 1] }).kind === 'gradient';
			const body = g.lowRes ? `texture(u_${LOW_RES_OUTPUT}, s.uv)` : /* glsl */ `tl_generate(s)`;
			return {
				glsl: `${generatorDefines(g, p, false)}${g.lowRes ? '' : g.glsl}
${recolorGlsl(color.mode, gradient)}
vec4 tl_layer(TlSurface s) {
  vec4 g = ${body} * tlg_window(s.px);
  if (!u_ownColors && u_tlRecolor) g = tl_recolor(g, s);
  return g * (u_opacity * 0.01);
}`,
				include: [
					GLSL_TLG_LOOK_SHAPE,
					GLSL_TLG_WINDOW,
					...(gradient ? [GLSL_TL_PAINT] : []),
					...(g.lowRes ? [] : (g.include ?? [])),
				],
				...(g.usesBounds?.(p) ? { usesBounds: true } : {}),
			};
		},
		...(g.prepass || g.lowRes
			? {
					prepass: (p: LayerParams, c: PrepassContext) => {
						const defines = `${c.defines}${generatorDefines(g, p, false)}`;
						const include = [...c.include, GLSL_TLG_LOOK_SHAPE, ...(g.include ?? [])];
						const written = new Set<string>();
						const pass = (x: ShaderPass) => generatorPass(x, defines, include, c.uniforms, written, false);
						return [
							...(g.prepass?.(p, { pxPerPercent: c.pxPerPercent, pass }) ?? []),
							...(g.lowRes ? [pass(lowResPass(g))] : []),
						];
					},
				}
			: {}),
		...(g.reach ? { reach: g.reach } : {}),
		...(g.fieldReach ? { fieldReach: g.fieldReach } : {}),
		...(g.timeDependent ? { timeDependent: g.timeDependent } : {}),
		...(g.front ? { front: true } : {}),
		summary: (p) => ({
			swatch: p.ownColors === true ? null : layerSwatch(t, p),
			text: g.summary?.(p) ?? g.label,
			primary: null,
		}),
	};
	return t;
}

/** The pass that draws a `lowRes` generator. */
const lowResPass = (g: TitleGenerator): ShaderPass => ({
	output: LOW_RES_OUTPUT,
	format: 'rgba16f',
	scale: 1 / (g.lowRes ?? 1),
	frag: `${g.glsl}
void main() { fragColor = tl_generate(tl_surface()); }`,
});

function normalize(init: TitleLayerInit): TitleLayerType {
	return { ...init, finish: init.finish === true, params: init.params };
}

/** Every layer type, built-ins then generators. */
export const TITLE_LAYER_TYPES: readonly TitleLayerType[] = [
	...TITLE_LAYER_INITS.map(normalize),
	...TITLE_GENERATORS.map(generatorLayer),
];

const BY_TYPE = new Map(TITLE_LAYER_TYPES.map((t) => [t.type, t]));
const FINISH_BY_ID = new Map(TITLE_FINISHES.map((f) => [f.id, f]));

export const titleLayerType = (type: string): TitleLayerType | undefined => BY_TYPE.get(type);
export const titleFinish = (id: string): TitleFinish | undefined => FINISH_BY_ID.get(id);
export { TITLE_FINISHES, TITLE_GENERATORS };

/** Every param a layer of this type may store: its own, `finish`, and the params of every finish. */
export function layerParamSpecs(t: TitleLayerType): readonly TitleParamSpec[] {
	if (!t.finish) return t.params;
	return [...t.params, finishParam(), ...TITLE_FINISHES.flatMap((f) => f.params)];
}

/** The params one layer shows and plans: its own, `finish`, and the current finish's. */
export function activeParamSpecs(t: TitleLayerType, finish: string): readonly TitleParamSpec[] {
	if (!t.finish) return t.params;
	return [...t.params, finishParam(), ...(titleFinish(finish)?.params ?? [])];
}

export function paramSpec(t: TitleLayerType, name: string): TitleParamSpec | undefined {
	return layerParamSpecs(t).find((p) => p.name === name);
}

/** Stored values over the defaults of every param of the layer. */
export function withDefaults(
	t: TitleLayerType,
	stored: Readonly<Record<string, LayerParamValue>>,
): LayerParams {
	const out: LayerParams = {};
	for (const p of layerParamSpecs(t)) out[p.name] = stored[p.name] ?? p.default;
	return out;
}

/**
 * A layer's Program handles (TL-092): the type's own while their `when` holds, and the angle of every gradient paint
 * (`lp.paint`'s `<name>Angle`). A paint's angle turns nothing while the paint is not a gradient, so it has no handle then.
 */
export function layerHandles(t: TitleLayerType, p: LayerParams): NonNullable<TitleLayerType['handles']> {
	const paints = t.params.filter(isPaintParam);
	const isGradient = (name: string) => (p[name] as Paint | undefined)?.kind === 'gradient';
	const flat = new Set(paints.filter((s) => !isGradient(s.name)).map((s) => `${s.name}Angle`));
	const own = (t.handles ?? []).filter(
		(h) =>
			(!h.when || p[h.when.param] === h.when.value) &&
			!(h.kind === 'angle' && h.target !== 'light' && flat.has(h.params[0]!)),
	);
	const named = new Set(own.filter((h) => h.target !== 'light').flatMap((h) => h.params));
	const gradients = paints
		.filter((s) => isGradient(s.name) && !named.has(`${s.name}Angle`))
		.map((s) => ({ kind: 'angle' as const, params: [`${s.name}Angle`] }));
	return [...own, ...gradients];
}

/** A standalone generator's unit, as a share of the shorter side: a title-sized unit, so a preset reads the same. */
export const STANDALONE_UNIT = 0.2;

/** The effect of one generator (`Generate` category, TL-060): on a clip it draws over the clip's picture. */
export function generatorEffect(g: TitleGenerator): EffectSpec {
	const include = [
		GLSL_TL_UNIT_KNOWN,
		GLSL_TL_SURFACE,
		standInChunk(g.standIn ?? 'none'),
		...(g.include ?? []),
	];
	return defineShaderEffect({
		id: `jasper.generator.${g.id}`,
		label: g.effectLabel ?? g.label,
		category: g.category ?? 'Generate',
		description: g.description,
		keywords: [...(g.keywords ?? []), 'generator', 'title'],
		params: g.params.filter((p) => !isPaintParam(p)) as EffectSpec['params'],
		...(g.prepass || g.lowRes ? { expensive: true } : {}),
		gpu: {
			kind: 'generator',
			// TL-123: data in `rgba32f` and light above 1 do not survive 8 bits: refuse, never degrade.
			...(g.prepass || g.lowRes ? { requiresFloat: true } : {}),
			// A standalone generator has no look: its unit is title-sized and it reads a stand-in shape (TL-060).
			// `fxPatternFrame`: the clock of a pattern continues across a razor cut (TL-035, TL-121).
			uniforms: (_p, ctx) => ({
				u_tlUnit: Math.min(ctx.width, ctx.height) * STANDALONE_UNIT * ctx.pxScale,
				u_tlSeed: ctx.seed,
				u_tlTime: fxPatternFrame(ctx) / ctx.fps,
			}),
			passes: (raw, ctx) => {
				const p = raw as LayerParams;
				const defines = generatorDefines(g, p, true);
				const written = new Set<string>();
				const pass = (x: ShaderPass) => generatorPass(x, defines, include, {}, written, true);
				const unit = Math.min(ctx.width, ctx.height) * STANDALONE_UNIT * ctx.pxScale;
				const pre = g.prepass?.(p, { pxPerPercent: unit * 0.01, pass });
				return [
					...(pre ?? []),
					...(g.lowRes ? [pass(lowResPass(g))] : []),
					{
						include,
						frag: /* glsl */ `${defines}${g.lowRes ? '' : g.glsl}
void main() {
  ${g.lowRes ? `vec4 g = texture(u_${LOW_RES_OUTPUT}, v_uv);` : 'vec4 g = tl_generate(tl_surface());'}
  vec4 under = texture(u_source, v_uv);
  vec3 c = g.a > 0.0 ? fx_linearToSrgb(clamp(g.rgb / g.a, 0.0, 1.0)) * g.a : vec3(0.0);
  fragColor = vec4(c, clamp(g.a, 0.0, 1.0)) + under * (1.0 - clamp(g.a, 0.0, 1.0));
}`,
					},
				];
			},
		},
	});
}

/** A preset chip of a generator by ids (TL-063). */
export function generatorPreset(generator: string, preset: string): GeneratorPreset | undefined {
	return TITLE_GENERATORS.find((g) => g.id === generator)?.presets?.find((x) => x.id === preset);
}

/** TL-064: where a layer of this type goes when no index is given: generators behind the title unless they say front. */
export function defaultLayerIndex(layers: readonly { type: string }[], type: string): number {
	const t = titleLayerType(type);
	if (!t || !type.startsWith(GENERATOR_LAYER_PREFIX) || t.front) return layers.length;
	let i = 0;
	while (i < layers.length && layers[i]!.type.startsWith(GENERATOR_LAYER_PREFIX)) i++;
	return i;
}

/** The standalone effects of every generator (registered in `FX_FAMILIES`). */
export const TITLE_GENERATOR_EFFECTS: readonly EffectSpec[] = TITLE_GENERATORS.map(generatorEffect);
