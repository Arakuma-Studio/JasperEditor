// `deepGlow` (§5.1): scattered light with a power-law falloff and an over-exposure response (`../deep-glow.ts`). `Shape`
// emits from the title's silhouette in the layer's paint, so it works behind a face; `Layers Below` makes everything under
// it the light source, in its own colours, burning towards white where it is over-bright.
import type { Paint } from '../../../../title-looks/model.ts';
import {
	fmtDistance,
	fmtNumber,
	layerSwatch,
	lp,
	type PaintParamSpec,
	type TitleLayerInit,
} from '../contract.ts';
import { deepGlowPasses, dgReach, dgTintOf, GLSL_TL_DEEP_GLOW } from '../deep-glow.ts';
import { paintOf } from '../paint.ts';

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

const stack = (p: Record<string, unknown>) => p.from === 'stack';

/** Inner to outer over the radius: a gradient's position is the octave's. No rotation: nothing here has a direction. */
const TINT: PaintParamSpec = {
	name: 'tint',
	label: 'Tint',
	type: 'paint',
	default: { kind: 'role', role: 'glow' },
	animatable: false,
};

const emitFrag = (fromStack: boolean) => /* glsl */ `
void main() {
  TlSurface s = tl_surface();
  vec4 L = ${fromStack ? 'texture(u_tlComp, s.uv)' : 'tlPaint_paint(s) * max(s.alpha, tl_inside(s.d, s.base) * s.opacity)'};
  fragColor = vec4(L.rgb * dg_emitFraction(L) * pow(2.0, u_exposure), 0.0);
}`;

export const DEEP_GLOW_LAYER: TitleLayerInit = {
	type: 'deepGlow',
	label: 'Deep Glow',
	description:
		'Physically scaled light: it scatters like lens bloom and burns towards white where it is over-bright.',
	finish: false,
	// Light comes from the whole title, rims included, wherever the layer sits; its reach starts there too.
	outermost: true,
	params: [
		lp.choice('from', 'From', ['shape', 'stack'], ['Shape', 'Layers Below'], 'shape'),
		lp.number('exposure', 'Exposure', 1, { min: -10, max: 10, softMin: -4, softMax: 6, step: 0.01 }),
		lp.number('threshold', 'Threshold', 0, { min: 0, max: 10, softMax: 1, step: 0.01 }),
		lp.number('knee', 'Threshold Knee', 0.25, { min: 0, max: 1, step: 0.01 }),
		lp.distance('radius', 'Radius', 120, { softMax: 400 }),
		lp.percent('falloff', 'Falloff', 50),
		lp.number('intensity', 'Intensity', 1, { min: 0, max: 100, softMax: 8, step: 0.01 }),
		lp.number('chroma', 'Chromatic Scatter', 0, { min: -100, max: 100, step: 1 }, { unit: '%' }),
		...lp.paint('paint', 'Paint', { kind: 'role', role: 'glow' }),
		lp.percent('tintAmount', 'Tint Amount', 0),
		TINT,
		lp.percent('highlightShift', 'Highlight Shift', 60),
		lp.percent('coreWhite', 'Core Whiteness', 20),
		lp.percent('onFace', 'Glow Over Face', 100),
	],
	shader: (p) => ({
		glsl: /* glsl */ `
vec4 tl_layer(TlSurface s) {
  vec4 under = texture(u_tlComp, s.uv);
  return tl_result(under, dg_result(under, texture(u_tlDgAcc, s.uv).rgb, ${stack(p) ? 'true' : 'false'}));
}`,
		include: [GLSL_TL_DEEP_GLOW],
	}),
	prepass(p, ctx) {
		return [
			ctx.surfacePass({
				output: 'tlDgPyr',
				update: true,
				format: 'rgba16f',
				include: [GLSL_TL_DEEP_GLOW],
				frag: emitFrag(stack(p)),
			}),
			...deepGlowPasses({
				radius: num(p.radius),
				falloff: num(p.falloff),
				chroma: num(p.chroma),
				intensity: num(p.intensity),
				tintAmount: Math.min(1, Math.max(0, num(p.tintAmount) / 100)),
				tintAt: dgTintOf(paintOf(p.tint, TINT.default as Paint), ctx.look.palette),
				pxPerPercent: ctx.pxPerPercent,
				unitKnown: ctx.unitKnown,
				unit: ctx.unit,
				again: true,
			}),
		];
	},
	reach: (p) => dgReach(num(p.radius), num(p.chroma)),
	fieldReach: () => ({ outside: 1 }),
	handles: [{ kind: 'distance', params: ['radius'] }],
	summary(p) {
		return {
			swatch: layerSwatch(DEEP_GLOW_LAYER, p),
			text: `${fmtDistance(p.radius)}, ${fmtNumber(p.exposure, 2)} stops`,
			primary: 'radius',
		};
	},
};
