// The Title Looks catalogue: every layer type, finish and generator, normalised for the planner, validation, the UI
// and the tests. Nothing else in the codebase lists them.
import type { LayerParamValue, Paint } from '../../../title-looks/model.ts';
import type { EffectSpec } from '../../effects.ts';
import { defineShaderEffect } from '../define.ts';
import {
	isPaintParam,
	type LayerParams,
	type LayerShader,
	layerSwatch,
	lp,
	type TitleFinish,
	type TitleGenerator,
	type TitleLayerInit,
	type TitleLayerType,
	type TitleParamSpec,
} from './contract.ts';
import { TITLE_FINISHES } from './finishes/index.ts';
import { TITLE_GENERATORS } from './generators/index.ts';
import { GLSL_TL_SURFACE, GLSL_TL_UNIT_KNOWN } from './glsl.ts';
import { TITLE_LAYER_INITS } from './layers/index.ts';
import { GLSL_TL_RECOLOR } from './recolor.ts';

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

/** A generator as a look layer: its picture, composited like any other layer. */
function generatorLayer(g: TitleGenerator): TitleLayerType {
	const t: TitleLayerType = {
		type: `${GENERATOR_LAYER_PREFIX}${g.id}`,
		label: g.label,
		description: g.description,
		finish: false,
		params: [...g.params, lp.percent('opacity', 'Opacity', 100)],
		recolors: true,
		shader: (): LayerShader => ({
			glsl: `${g.glsl}\nvec4 tl_layer(TlSurface s) { return tl_recolor(tl_generate(s)) * (u_opacity * 0.01); }`,
			include: [GLSL_TL_RECOLOR, ...(g.include ?? [])],
		}),
		...(g.reach ? { reach: g.reach } : {}),
		...(g.timeDependent ? { timeDependent: g.timeDependent } : {}),
		summary: (p) => ({
			swatch: layerSwatch({ params: g.params }, p),
			text: g.summary?.(p) ?? g.label,
			primary: null,
		}),
	};
	return t;
}

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

/** The effect of one generator (`Generate` category, TL-060): on a clip it draws over the clip's picture. */
export function generatorEffect(g: TitleGenerator): EffectSpec {
	return defineShaderEffect({
		id: `jasper.generator.${g.id}`,
		label: g.label,
		category: g.category ?? 'Generate',
		description: g.description,
		keywords: [...(g.keywords ?? []), 'generator', 'title'],
		params: g.params.filter((p) => !isPaintParam(p)) as EffectSpec['params'],
		gpu: {
			kind: 'generator',
			// A standalone generator has no look: its unit is the layer box and it sees an empty shape (TL-060).
			uniforms: (_p, ctx) => ({
				u_tlUnit: Math.min(ctx.width, ctx.height) * ctx.pxScale,
				u_tlSeed: ctx.seed,
				u_tlTime: ctx.frame / ctx.fps,
			}),
			passes: [
				{
					include: [GLSL_TL_UNIT_KNOWN, GLSL_TL_SURFACE, ...(g.include ?? [])],
					frag: /* glsl */ `
${g.glsl}
void main() {
  TlSurface s;
  s.uv = v_uv;
  s.px = v_uv * u_canvasSize;
  s.d = 1.0e6;
  s.opacity = 0.0;
  s.toEdge = vec2(0.0);
  s.base = 0.0;
  s.alpha = 0.0;
  vec4 g = tl_generate(s);
  vec4 under = texture(u_source, v_uv);
  vec3 c = g.a > 0.0 ? fx_linearToSrgb(clamp(g.rgb / g.a, 0.0, 1.0)) * g.a : vec3(0.0);
  fragColor = vec4(c, g.a) + under * (1.0 - g.a);
}`,
				},
			],
		},
	});
}

/** The standalone effects of every generator (registered in `FX_FAMILIES`). */
export const TITLE_GENERATOR_EFFECTS: readonly EffectSpec[] = TITLE_GENERATORS.map(generatorEffect);
