// Sapphire Blur+Sharpen — depth-of-field from a Z buffer: S_ZDefocus (iris bokeh per depth layer) and S_ZBlur
// (gaussian per depth layer). Layering: depth.ts; iris gather: iris.ts. Scales as S_RackDefocus (iris diameter =
// Defocus Width × U) and S_Blur (σ = Blur Width × U / 24).
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, SAPPHIRE_BINS } from '../define.ts';
import { GLSL_COMPOSITE } from '../glsl/composite.ts';
import { fxParam } from '../params.ts';
import type { FxPlanContext, ShaderPass } from '../shader.ts';
import {
	bool,
	choiceIndex,
	edgeOf,
	num,
	px,
	SBS_EDGE_REPEAT,
	SbsPlan,
	sEdgeMode,
	sMix,
	sNum,
	sSize,
	sSoftBorders,
	unitLayerPx,
	vec2,
} from './common.ts';
import { DEFOCUS_TONE, defocusPrepPass, defocusToneUniforms } from './defocus.ts';
import {
	GLSL_SBS_DEPTH,
	zBufferParam,
	zFocusParams,
	zFogParams,
	zLayerParams,
	zLayers,
	zMaxAmount,
	zRelParams,
	zTypeParam,
	zUseParam,
} from './depth.ts';
import {
	DEFOCUS_RADIUS_PER_UNIT,
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

const SLICE = '#define SBS_SLICE 1\n';

/** Prep → layered gathers → final (tone, fog, focus zone / shape view, clip, mix). */
function zPasses(
	p: EffectParams,
	ctx: FxPlanContext,
	o: { radiusX: number; radiusY: number; iris: IrisConfig; edge: number; showShape: boolean },
): ShaderPass[] {
	const plan = new SbsPlan(ctx);
	plan.pass(defocusPrepPass());
	const layered = zLayers(p, 'prep', ({ output, scale01, slice }) =>
		gatherPass(plan, {
			input: 'prep',
			output,
			radiusX: o.radiusX * scale01,
			radiusY: o.radiusY * scale01,
			iris: o.iris,
			edge: o.edge,
			defines: slice ? SLICE : '',
			include: [GLSL_SBS_DEPTH],
			uniforms: { u_slice: slice ?? [0, 1] },
		}),
	);
	const shape = o.showShape ? shapeViewPassParts(o.iris) : null;
	plan.pass({
		include: shape
			? [shape.defines, GLSL_SBS_DEPTH, GLSL_SBS_IRIS, GLSL_COMPOSITE]
			: [GLSL_SBS_DEPTH, GLSL_COMPOSITE],
		uniforms: {
			...layered.uniforms,
			...(shape?.uniforms ?? {}),
			u_shapeRel: o.radiusY / Math.max(1e-6, o.radiusX),
		},
		frag: /* glsl */ `${DEFOCUS_TONE}
// Fog by depth.
vec3 sbs_fog(vec3 c, float z) { return mix(c, u_fogColor.rgb, clamp(mix(u_fogNear, u_fogFar, z), 0.0, 1.0)); }
${shape ? IRIS_SHAPE_VIEW : ''}
${layered.glsl}
void main() {
  vec4 src = texture(u_source, v_uv);
${shape ? '  fragColor = sbs_shapeView(u_shapeRel, 0.8); return;' : ''}
  float z = sbs_depth(v_uv);
  if (u_show == 1) { fragColor = sbs_focusZone(src, sbs_zAmount(z)); return; }
  vec4 t = sbs_defocusTone(sbs_zLayered(v_uv));
  vec3 c = sbs_fog(t.rgb, z);
  vec4 result = vec4(c * t.a, t.a);
  if (!sbs_keep(v_uv, u_sbsEdge)) result = vec4(0.0);
  fragColor = fx_mixOriginal(result, src, u_mixWithOriginal);
}`,
	});
	return plan.passes;
}

// ---------------------------------------------------------------- S_ZDefocus

const ZDEF_SHOW = ['result', 'inFocusZone', 'shape'] as const;

export const S_Z_DEFOCUS = defineShaderEffect({
	id: 'jasper.s.z-defocus',
	label: 'S_ZDefocus',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Lens defocus driven by a depth map (ZBuffer): areas away from the Focal Depth bloom into iris-shaped bokeh, in depth layers; near/far widths and fog.',
	keywords: ['z defocus', 'depth of field', 'dof', 'depth map', 'zbuffer', 'bokeh', 'focus', 'sapphire'],
	expensive: true,
	params: [
		zBufferParam(),
		...zFocusParams(),
		sSize('defocusWidth', 'Defocus Width', 0.35, 1),
		sNum('relHeight', 'Rel Height', 1, { min: 0.01, softMax: 4, step: 0.01 }),
		zTypeParam(),
		fxParam.choice('show', 'Show', ZDEF_SHOW, ['Result', 'In Focus Zone', 'Shape'], 'result'),
		...zLayerParams(),
		irisShapeParam(),
		...irisLookParams(),
		...lensNoiseParams(),
		...highlightParams(1, 0, 'Highlight Threshold'),
		sNum('brightness', 'Brightness', 1, { min: 0, softMax: 4 }),
		sNum('offsetDarks', 'Offset Darks', 0, { softMin: -1, softMax: 1 }),
		sMix(),
		...zRelParams(),
		...zFogParams(),
		sEdgeMode('reflect'),
		zUseParam(),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) =>
			bool(p.softBorders)
				? num(p.defocusWidth, 0.35) *
					zMaxAmount(p) *
					DEFOCUS_RADIUS_PER_UNIT *
					unitLayerPx(ctx) *
					Math.max(1, num(p.relHeight, 1))
				: 0,
		uniforms: (p) =>
			defocusToneUniforms({
				edge: edgeOf(p),
				chroma: 0,
				mono: false,
				boost: num(p.boostHighlights),
				threshold: num(p.hilightThreshold, 0.9),
				gamma: num(p.useGamma, 1),
				brightness: num(p.brightness, 1),
				offsetDarks: num(p.offsetDarks),
			}),
		passes: (p, ctx) => {
			const r = px(ctx, num(p.defocusWidth, 0.35), DEFOCUS_RADIUS_PER_UNIT) * zMaxAmount(p);
			return zPasses(p, ctx, {
				radiusX: r,
				radiusY: r * Math.max(0.01, num(p.relHeight, 1)),
				iris: irisFromParams(p, irisSides(p.shape)),
				edge: edgeOf(p),
				showShape: choiceIndex(p.show, ZDEF_SHOW, 'result') === 2,
			});
		},
	},
});

// ---------------------------------------------------------------- S_ZBlur

const ZBLUR_SHOW = ['result', 'inFocusZone'] as const;
const GAUSS_IRIS: IrisConfig = { sides: 0, roundness: 1, rotate: 0, bokeh: 0, gauss: true };

export const S_Z_BLUR = defineShaderEffect({
	id: 'jasper.s.z-blur',
	label: 'S_ZBlur',
	category: 'Blur & Sharpen',
	bin: SAPPHIRE_BINS.blurSharpen,
	description:
		'Gaussian depth-of-field from a depth map (ZBuffer): areas away from the Focal Depth are blurred more, in depth layers; near/far widths and fog.',
	keywords: ['z blur', 'depth of field', 'dof', 'depth map', 'zbuffer', 'fog', 'sapphire'],
	expensive: true,
	params: [
		zBufferParam(),
		...zFocusParams(),
		sSize('blurWidth', 'Blur Width', 0.168, 2),
		fxParam.vec2('blurRel', 'Blur Rel', [1, 1], { min: 0, softMax: 4, step: 0.01 }),
		zTypeParam(),
		fxParam.choice('show', 'Show', ZBLUR_SHOW, ['Result', 'In Focus Zone'], 'result'),
		...zLayerParams(),
		...zRelParams(),
		...zFogParams(),
		zUseParam(),
		sSoftBorders(),
	],
	gpu: {
		timeInvariant: true,
		padding: (p, ctx) => {
			const rel = vec2(p.blurRel, [1, 1]);
			return bool(p.softBorders)
				? (3 * num(p.blurWidth, 0.168) * zMaxAmount(p) * unitLayerPx(ctx) * Math.max(rel[0], rel[1])) / 24
				: 0;
		},
		uniforms: (p) => ({
			...defocusToneUniforms({
				edge: edgeOf(p, SBS_EDGE_REPEAT),
				chroma: 0,
				mono: false,
				boost: 0,
				threshold: 1,
				gamma: 1,
				brightness: 1,
				offsetDarks: 0,
			}),
			u_mixWithOriginal: 0,
		}),
		passes: (p, ctx) => {
			const rel = vec2(p.blurRel, [1, 1]);
			// Gaussian over a disc of radius 3σ.
			const r = 3 * px(ctx, num(p.blurWidth, 0.168), 1 / 24) * zMaxAmount(p);
			return zPasses(p, ctx, {
				radiusX: r * Math.max(0, rel[0]),
				radiusY: r * Math.max(0, rel[1]),
				iris: GAUSS_IRIS,
				edge: edgeOf(p, SBS_EDGE_REPEAT),
				showShape: false,
			});
		},
	},
});

export const SBS_Z: readonly EffectSpec[] = [S_Z_DEFOCUS, S_Z_BLUR];
