// Sapphire Blur+Sharpen — lens defocus: S_RackDefocus, S_AdvancedDefocus, S_DefocusPrism. One pipeline:
// prepare (edge mode, chroma distort, mono, Boost Highlights, Use Gamma → half float) → iris gather on a pyramid
// level (iris.ts) → optional Gauss Blur → tone tail (gamma out, Brightness, Offset Darks, Scale Color, grain) →
// Soft Borders / clip to the layer box → Show Shape → Mix With Source.
// Scale: the iris DIAMETER is "Defocus Width" Sapphire units (U = half the layer width): 0.088 ≈ 42 px radius at
// 1920 px; "Gauss Blur" is a gaussian σ of gaussBlur × U / 2.
import type { EffectParams, EffectSpec, ParamSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { GLSL_HASH } from '../glsl/hash.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, FxUniformValue, ShaderPass } from '../shader.ts';
import {
	bool,
	choiceIndex,
	edgeOf,
	GLSL_SBS_COMMON,
	num,
	px,
	rgba,
	SbsPlan,
	sColor,
	sEdgeMode,
	sMix,
	sNum,
	sSize,
	sSoftBorders,
	sUnit,
	unitLayerPx,
	vec2,
} from './common.ts';
import {
	DEFOCUS_RADIUS_PER_UNIT,
	defocusWidthParam,
	fringeOf,
	GLSL_SBS_IRIS,
	gatherPass,
	highlightParams,
	IRIS_SHAPE_VIEW,
	type IrisConfig,
	irisFromParams,
	irisLookParams,
	irisShapeParam,
	irisSides,
	lensNoiseParams,
	shapeViewPassParts,
} from './iris.ts';

/** σ of "Gauss Blur" per Sapphire unit. */
const GAUSS_SIGMA_PER_UNIT = 0.5;

/** Prepared picture: edge mode, chroma distort, mono, boost, gamma (premultiplied half float). */
export function defocusPrepPass(output = 'prep', input = 'source'): ShaderPass {
	return {
		output,
		include: [GLSL_SBS_COMMON],
		format: 'rgba16f',
		frag: /* glsl */ `
void main() {
  vec4 c = fx_unpremultiply(sbs_chromaTex(u_${input}, v_uv, u_dChroma, u_sbsEdge));
  vec3 rgb = u_dMono ? vec3(fx_luma(c.rgb)) : c.rgb;
  rgb = sbs_gammaIn(sbs_boost(rgb, u_dBoost, u_dThreshold), u_dGamma);
  fragColor = vec4(rgb * c.a, c.a);
}`,
	};
}

/** Uniforms of `defocusPrepPass` and of the defocus tone tail. */
export function defocusToneUniforms(o: {
	edge: number;
	chroma: number;
	mono: boolean;
	boost: number;
	threshold: number;
	gamma: number;
	brightness: number;
	offsetDarks: number;
	scaleColor?: readonly [number, number, number];
}): Record<string, FxUniformValue> {
	return {
		u_sbsEdge: { int: o.edge },
		u_dChroma: o.chroma,
		u_dMono: o.mono,
		u_dBoost: o.boost,
		u_dThreshold: o.threshold,
		u_dGamma: Math.max(0.1, o.gamma),
		u_dBright: o.brightness,
		u_dOffset: o.offsetDarks,
		u_dScale: (o.scaleColor ?? [1, 1, 1]) as [number, number, number],
	};
}

/** GLSL tail: defocused (premultiplied, gamma space) → straight colour after gamma out, brightness, offset. */
export const DEFOCUS_TONE = /* glsl */ `
vec4 sbs_defocusTone(vec4 d) {
  vec4 s = fx_unpremultiply(d);
  vec3 c = sbs_gammaOut(s.rgb, u_dGamma);
  c = sbs_offsetDarks(c * u_dBright, u_dOffset) * u_dScale;
  return vec4(max(c, 0.0), clamp(s.a, 0.0, 1.0));
}
`;

type DefocusOptions = {
	radiusX: number;
	radiusY: number;
	iris: IrisConfig;
	edge: number;
	gaussBlur: number;
	extraLevels?: number;
	/** 0 result, 1 shape (zoomed), 2 shape (actual size). */
	show: number;
	affectAlpha: boolean;
	grain?: boolean;
};

/** Plans prep → gather → gauss → final of a uniform defocus. */
export function uniformDefocusPasses(ctx: FxPlanContext, o: DefocusOptions): ShaderPass[] {
	const plan = new SbsPlan(ctx);
	plan.pass(defocusPrepPass());
	const g = gatherPass(plan, {
		input: 'prep',
		output: 'defocus',
		radiusX: o.radiusX,
		radiusY: o.radiusY,
		iris: o.iris,
		edge: o.edge,
		extraLevels: o.extraLevels,
	});
	let tex = g.output;
	if (o.gaussBlur > 0) {
		const s = o.gaussBlur * GAUSS_SIGMA_PER_UNIT * (ctx.width * ctx.pxScale) * 0.5;
		tex = plan.blur2d({
			input: g.output,
			output: 'gauss',
			sigmaX: s,
			sigmaY: s,
			edge: 3,
			maxLevel: 6,
		}).output;
	}
	const shape = o.show > 0 ? shapeViewPassParts(o.iris) : null;
	const zoom =
		o.show === 2 ? Math.max(0.01, (2 * Math.max(o.radiusX, o.radiusY)) / (ctx.height * ctx.pxScale)) : 0.8;
	const relY = o.radiusY / Math.max(1e-6, o.radiusX);
	plan.pass({
		include: shape
			? [shape.defines, GLSL_SBS_IRIS, GLSL_COMPOSITE, GLSL_HASH]
			: [GLSL_SBS_COMMON, GLSL_COMPOSITE, GLSL_HASH],
		uniforms: { ...(shape?.uniforms ?? {}), u_shapeZoom: zoom, u_shapeRel: relY },
		frag: /* glsl */ `${o.grain ? '#define SBS_GRAIN 1\n' : ''}${DEFOCUS_TONE}
${shape ? IRIS_SHAPE_VIEW : ''}
${o.grain ? GRAIN_GLSL : ''}
void main() {
  vec4 src = texture(u_source, v_uv);
${shape ? '  fragColor = sbs_shapeView(u_shapeRel, u_shapeZoom); return;' : ''}
  vec4 t = sbs_defocusTone(texture(u_${tex}, v_uv));
  float a = ${o.affectAlpha ? 't.a' : 'u_sbsEdge == SBS_EDGE_NONE ? max(t.a, src.a) : src.a'};
  vec3 c = t.rgb;
#ifdef SBS_GRAIN
  c = sbs_grain(c);
#endif
  vec4 result = vec4(c * a, a);
  if (!sbs_keep(v_uv, u_sbsEdge)) result = vec4(0.0);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
	});
	return plan.passes;
}

/** Film grain of S_AdvancedDefocus (u_grainA: amp, darks, mids, brights; u_grainB: size, blur, mono, seed). */
const GRAIN_GLSL = /* glsl */ `
float sbs_grainNoise(vec2 p, float k) {
  vec2 cell = floor(p);
  vec2 f = fract(p);
  f = mix(vec2(0.0), f * f * (3.0 - 2.0 * f), clamp(u_grainB.y * 200.0, 0.0, 1.0));
  float s = fract(u_grainB.w * 0.618034 + k * 0.137 + u_seed);
  int fr = int(u_frame);
  float a = fx_hash3(ivec3(ivec2(cell), fr), s), b = fx_hash3(ivec3(ivec2(cell) + ivec2(1, 0), fr), s);
  float c = fx_hash3(ivec3(ivec2(cell) + ivec2(0, 1), fr), s), d = fx_hash3(ivec3(ivec2(cell) + ivec2(1, 1), fr), s);
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y) * 2.0 - 1.0;
}
vec3 sbs_grain(vec3 c) {
  if (u_grainA.x <= 0.0) return c;
  vec2 p = fx_layerPx() / max(u_grainB.x * (1.0 + u_grainB.y * 150.0), 0.001);
  vec3 n = vec3(sbs_grainNoise(p, 0.0));
  if (u_grainB.z < 0.5) n = vec3(n.x, sbs_grainNoise(p, 1.0), sbs_grainNoise(p, 2.0));
  float l = fx_luma(c);
  float w = l < 0.5 ? mix(u_grainA.y, u_grainA.z, l * 2.0) : mix(u_grainA.z, u_grainA.w, l * 2.0 - 1.0);
  return c + n * u_grainA.x * w * 0.25;
}
`;

const softPadding = (p: EffectParams, ctx: FxPlanContext, width: number, rel: number, fringe = 1) =>
	bool(p.softBorders)
		? width * DEFOCUS_RADIUS_PER_UNIT * unitLayerPx(ctx) * rel * fringe +
			3 * num(p.gaussBlur) * GAUSS_SIGMA_PER_UNIT * unitLayerPx(ctx)
		: 0;

// ---------------------------------------------------------------- S_RackDefocus

const MONO = ['color', 'mono'] as const;

const RACK_PARAMS: ParamSpec[] = [
	fxParam.choice('effect', 'Effect', MONO, ['Defocus Color', 'Defocus Mono'], 'color'),
	defocusWidthParam(),
	sNum('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
	irisShapeParam(),
	fxParam.toggle('showShape', 'Show Shape', false),
	...irisLookParams(),
	...lensNoiseParams(),
	sSize('gaussBlur', 'Gauss Blur', 0, 0.2),
	...highlightParams(1, 0),
	sNum('chromaDistort', 'Chroma Distort', 0, { softMin: -2, softMax: 2, step: 0.01 }),
	sNum('colorFringing', 'Color Fringing', 0, { softMin: -2, softMax: 2, step: 0.01 }),
	sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
	sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1 }),
	sMix(),
	sEdgeMode('reflect'),
	sSoftBorders(),
];

export const S_RACK_DEFOCUS = defineShaderEffect({
	id: 'jasper.s.rack-defocus',
	label: 'S_RackDefocus',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Defocuses the clip like a real lens (circle-of-confusion convolution): bright points bloom into clean circles or iris polygons instead of being smoothed away.',
	keywords: ['defocus', 'bokeh', 'lens blur', 'out of focus', 'iris', 'rack focus', 'sapphire'],
	expensive: true,
	params: RACK_PARAMS,
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) =>
			softPadding(
				p,
				ctx,
				num(p.defocusWidth, 0.088),
				Math.max(1, num(p.relHeight, 1)),
				Math.max(...(fringeOf(num(p.colorFringing)) ?? [1])),
			),
		uniforms: (p) =>
			defocusToneUniforms({
				edge: edgeOf(p),
				chroma: num(p.chromaDistort),
				mono: p.effect === 'mono',
				boost: num(p.boostHighlights),
				threshold: num(p.hilightThreshold, 0.9),
				gamma: num(p.useGamma, 1),
				brightness: num(p.brightness, 1),
				offsetDarks: num(p.offsetDarks),
			}),
		passes: (p, ctx) => {
			const r = px(ctx, num(p.defocusWidth, 0.088), DEFOCUS_RADIUS_PER_UNIT);
			return uniformDefocusPasses(ctx, {
				radiusX: r,
				radiusY: r * Math.max(0.01, num(p.relHeight, 1)),
				iris: { ...irisFromParams(p, irisSides(p.shape)), fringe: fringeOf(num(p.colorFringing)) },
				edge: edgeOf(p),
				gaussBlur: num(p.gaussBlur),
				show: bool(p.showShape) ? 1 : 0,
				affectAlpha: true,
			});
		},
	},
});

// ---------------------------------------------------------------- S_DefocusPrism

export const S_DEFOCUS_PRISM = defineShaderEffect({
	id: 'jasper.s.defocus-prism',
	label: 'S_DefocusPrism',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Defocuses each colour channel into its own ring of a different width, so highlights bloom into prismatic rainbow rings.',
	keywords: ['defocus', 'prism', 'chromatic', 'rainbow', 'bokeh', 'rings', 'sapphire'],
	expensive: true,
	params: [
		defocusWidthParam(),
		sNum('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		irisShapeParam(),
		fxParam.toggle('showShape', 'Show Shape', false),
		...irisLookParams(),
		...lensNoiseParams(),
		sSize('gaussBlur', 'Gauss Blur', 0, 0.2),
		...highlightParams(1, 0),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1 }),
		sColor('scaleColor', 'Scale Color', [1, 1, 1]),
		sNum('chromaSep', 'Chroma Sep', 0.3, { min: -1, max: 1, step: 0.01 }),
		sNum('chromaRingthick', 'Chroma Ringthick', 0.3, { min: 0.01, softMax: 2, step: 0.01 }),
		sNum('chromaDistort', 'Chroma Distort', 0, { softMin: -2, softMax: 2, step: 0.01 }),
		sMix(),
		sEdgeMode('reflect'),
	],
	gpu: {
		timeInvariant: true,
		uniforms: (p) => {
			const sc = rgba(p.scaleColor, [1, 1, 1, 1]);
			return defocusToneUniforms({
				edge: edgeOf(p),
				chroma: num(p.chromaDistort),
				mono: false,
				boost: num(p.boostHighlights),
				threshold: num(p.hilightThreshold, 0.9),
				gamma: num(p.useGamma, 1),
				brightness: num(p.brightness, 1),
				offsetDarks: num(p.offsetDarks),
				scaleColor: [sc[0], sc[1], sc[2]],
			});
		},
		passes: (p, ctx) => {
			const r = px(ctx, num(p.defocusWidth, 0.088), DEFOCUS_RADIUS_PER_UNIT);
			return uniformDefocusPasses(ctx, {
				radiusX: r,
				radiusY: r * Math.max(0.01, num(p.relHeight, 1)),
				iris: {
					...irisFromParams(p, irisSides(p.shape)),
					prism: { sep: num(p.chromaSep, 0.3), thick: num(p.chromaRingthick, 0.3) },
				},
				edge: edgeOf(p),
				gaussBlur: num(p.gaussBlur),
				show: bool(p.showShape) ? 1 : 0,
				affectAlpha: true,
			});
		},
	},
});

// ---------------------------------------------------------------- S_AdvancedDefocus

const ADV_SHAPES = ['circle', 'polygon', 'custom'] as const;
const ADV_SHOW = ['result', 'shapeActual', 'shapeZoomed'] as const;
const FRINGE_STYLES = ['redBlue', 'greenMagenta'] as const;
const RESOLUTIONS = ['full', 'half', 'quarter'] as const;

export const S_ADVANCED_DEFOCUS = defineShaderEffect({
	id: 'jasper.s.advanced-defocus',
	label: 'S_AdvancedDefocus',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Lens defocus with full control of the iris (polygon, roundness, notches, custom lens picture, ring bokeh), colour fringing, optical vignetting (cat’s-eye bokeh), matte-box crops, lens textures and film grain.',
	keywords: ['defocus', 'bokeh', 'lens', 'iris', 'cat eye', 'anamorphic', 'lens blur', 'sapphire'],
	expensive: true,
	params: [
		defocusWidthParam(),
		fxParam.vec2('defocusRel', 'Defocus Rel', [1, 1], { min: 0.01, softMax: 4, step: 0.01 }),
		fxParam.choice('shape', 'Shape', ADV_SHAPES, ['Circle', 'Polygon', 'Custom'], 'polygon'),
		sNum('points', 'Points', 5, { min: 3, softMax: 12, step: 1, int: true }),
		fxParam.media('customLens', 'Custom Lens', ['image']),
		fxParam.choice(
			'show',
			'Show',
			ADV_SHOW,
			['Result', 'Shape (Actual Size)', 'Shape (Zoomed In)'],
			'result',
		),
		...irisLookParams(0.3, -0.3),
		sUnit('bokehSoftness', 'Bokeh Softness', 1),
		sUnit('bokehCenter', 'Bokeh Center', 0.5),
		sUnit('notchDepth', 'Notch Depth', 0),
		sUnit('notchAngle', 'Notch Angle', 0.05),
		sNum('colorFringing', 'Color Fringing', 0, { softMin: -2, softMax: 2, step: 0.01 }),
		fxParam.choice(
			'colorFringingStyle',
			'Color Fringing Style',
			FRINGE_STYLES,
			['Red/Blue', 'Green/Magenta'],
			'redBlue',
		),
		...lensNoiseParams(),
		sNum('opticalVignette', 'Optical Vignette', 0, { min: -1, max: 1, step: 0.01 }),
		sNum('vignetteSize', 'Vignette Size', 1, { min: 1, softMax: 4, step: 0.01 }),
		sNum('matteBoxLeft', 'Matte Box Left', 0, { min: 0, max: 4, step: 0.01 }),
		sNum('matteBoxRight', 'Matte Box Right', 0, { min: 0, max: 4, step: 0.01 }),
		sNum('matteBoxTop', 'Matte Box Top', 0, { min: 0, max: 4, step: 0.01 }),
		sNum('matteBoxBottom', 'Matte Box Bottom', 0, { min: 0, max: 4, step: 0.01 }),
		fxParam.media('lensTexture', 'Texture', ['image']),
		sNum('textureScale', 'Texture Scale', 1, { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('textureScaleRelY', 'Texture Scale Rel Y', 1, { min: 1, softMax: 4, step: 0.01 }),
		fxParam.vec2('textureShift', 'Texture Shift', [0, 0], { min: -5, max: 5, step: 0.01 }),
		fxParam.angle('textureRotate', 'Texture Rotate', 0),
		sUnit('textureIntensity', 'Texture Intensity', 1),
		sNum('grainAmp', 'Grain Amp', 0, { min: 0, softMax: 2, step: 0.01 }),
		sNum('grainAmpBrights', 'Grain Amp Brights', 0, { min: 0, softMax: 2, step: 0.01 }),
		sNum('grainAmpDarks', 'Grain Amp Darks', 0.37, { min: 0, softMax: 2, step: 0.01 }),
		sNum('grainAmpMids', 'Grain Amp Mids', 1, { min: 0, softMax: 2, step: 0.01 }),
		sNum('grainSize', 'Grain Size', 1, { min: 0.001, softMax: 4, step: 0.01 }),
		sNum('grainBlur', 'Grain Blur', 0.00567, { min: 0, softMax: 0.05, step: 0.0001 }),
		fxParam.toggle('grainMono', 'Grain Mono', false),
		sNum('grainSeed', 'Grain Seed', 0.123, { min: 0, softMax: 10, step: 0.001 }),
		sNum('boostHighlights', 'Boost Highlights', 0, { min: 0, softMax: 4, step: 0.01 }),
		sNum('hilightThreshold', 'Hilight Threshold', 0.9, { min: 0, softMax: 1, step: 0.01 }),
		sNum('chromaticAberration', 'Chromatic Aberration', 0, { softMin: -2, softMax: 2, step: 0.01 }),
		sNum('useGamma', 'Use Gamma', 1.8, { min: 0.1, softMax: 4, step: 0.01 }),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1 }),
		sSize('gaussBlur', 'Gauss Blur', 0, 0.2),
		sMix(),
		sEdgeMode('reflect'),
		fxParam.choice('defocusResolution', 'Resolution', RESOLUTIONS, ['Full', 'Half', 'Quarter'], 'full'),
		fxParam.toggle('affectAlpha', 'Affect Alpha', false),
		sSoftBorders(),
	],
	gpu: {
		padding: (p, ctx) => {
			const rel = vec2(p.defocusRel, [1, 1]);
			const f = fringeOf(num(p.colorFringing), p.colorFringingStyle === 'greenMagenta');
			return softPadding(
				p,
				ctx,
				num(p.defocusWidth, 0.088),
				Math.max(rel[0], rel[1]),
				Math.max(...(f ?? [1])),
			);
		},
		uniforms: (p) => ({
			...defocusToneUniforms({
				edge: edgeOf(p),
				chroma: num(p.chromaticAberration),
				mono: false,
				boost: num(p.boostHighlights),
				threshold: num(p.hilightThreshold, 0.9),
				gamma: num(p.useGamma, 1.8),
				brightness: num(p.brightness, 1),
				offsetDarks: num(p.offsetDarks),
			}),
			u_grainA: [num(p.grainAmp), num(p.grainAmpDarks, 0.37), num(p.grainAmpMids, 1), num(p.grainAmpBrights)],
			u_grainB: [
				num(p.grainSize, 1),
				num(p.grainBlur, 0.00567),
				bool(p.grainMono) ? 1 : 0,
				num(p.grainSeed, 0.123),
			],
		}),
		passes: (p, ctx) => {
			const rel = vec2(p.defocusRel, [1, 1]);
			const r = px(ctx, num(p.defocusWidth, 0.088), DEFOCUS_RADIUS_PER_UNIT);
			const shape = choiceIndex(p.shape, ADV_SHAPES, 'polygon');
			const tex = {
				scale: num(p.textureScale, 1),
				relY: num(p.textureScaleRelY, 1),
				rotate: num(p.textureRotate),
				intensity: num(p.textureIntensity, 1),
				shift: vec2(p.textureShift, [0, 0]),
			};
			const iris: IrisConfig = {
				...irisFromParams(p, shape === 1 ? Math.max(3, Math.round(num(p.points, 5))) : 0),
				bokehSoftness: num(p.bokehSoftness, 1),
				bokehCenter: num(p.bokehCenter, 0.5),
				notchDepth: shape === 1 ? num(p.notchDepth) : 0,
				notchAngle: num(p.notchAngle, 0.05),
				fringe: fringeOf(num(p.colorFringing), p.colorFringingStyle === 'greenMagenta'),
				opticalVignette: num(p.opticalVignette),
				vignetteSize: num(p.vignetteSize, 1),
				matteBox: [num(p.matteBoxLeft), num(p.matteBoxRight), num(p.matteBoxTop), num(p.matteBoxBottom)],
				texture: tex,
				customLens: shape === 2,
			};
			const show = choiceIndex(p.show, ADV_SHOW, 'result');
			return uniformDefocusPasses(ctx, {
				radiusX: r * Math.max(0.01, rel[0]),
				radiusY: r * Math.max(0.01, rel[1]),
				iris,
				edge: edgeOf(p),
				gaussBlur: num(p.gaussBlur),
				extraLevels: choiceIndex(p.defocusResolution, RESOLUTIONS, 'full'),
				show: show === 0 ? 0 : show === 1 ? 2 : 1,
				affectAlpha: bool(p.affectAlpha),
				grain: num(p.grainAmp) > 0,
			});
		},
	},
});

export const SBS_DEFOCUS: readonly EffectSpec[] = [S_ADVANCED_DEFOCUS, S_DEFOCUS_PRISM, S_RACK_DEFOCUS];
