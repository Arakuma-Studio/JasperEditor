// A standalone effect that is a small look (spec 19 §8): its params become layers of the planner, on any clip, so the
// effect and the look layer are one piece of GLSL and one set of passes. The picture comes in as a `source` face.
//
// Distances are layer px: with a unit of 100 px, 1 % of the unit is one layer px, so a px param is a layer's percent
// param unchanged, and `u_tlUnit` follows `pxScale`. Params stay ordinary effect params: keyframes, expressions and Effect
// Controls need nothing here, and `paramUniforms: false` lets them share names with the layers' pass uniforms.
import type { RGBA } from '../../../schema/common.ts';
import {
	DEFAULT_LIGHT_ALTITUDE,
	DEFAULT_LIGHT_ANGLE,
	DEFAULT_PALETTE,
	type Gradient,
	type LayerParamValue,
	type Paint,
	TITLE_LOOK_INTENSITY,
} from '../../../title-looks/model.ts';
import type { ResolvedAppearance } from '../../../title-looks/resolve.ts';
import type { EffectParams, EffectSpec } from '../../effects.ts';
import { defineShaderEffect, type ShaderEffectInit } from '../define.ts';
import type { FxFrameContext, FxPadding, FxPlanContext, GpuEffect } from '../shader.ts';
import { type FxTitleLook, planTitleLook, titleLookPadding, titleLookUniforms } from './plan.ts';

/** 1 % of the unit = 1 layer px. */
export const LOOK_EFFECT_UNIT = 100;

/** Frames of a clip sampled for its padding; the current frame always counts, so no frame clips between samples. */
const REACH_SAMPLES = 32;

export type LookEffectLayer = { type: string; params: Record<string, LayerParamValue> };
export type LookEffectLayers = (p: EffectParams) => readonly LookEffectLayer[];

/** The clip's picture, in its own colours. */
export const SOURCE_FACE: LookEffectLayer = { type: 'face', params: { paint: { kind: 'source' } } };

const colorOf = (v: unknown, d: RGBA): RGBA => (Array.isArray(v) && v.length === 4 ? (v as RGBA) : d);

/** A colour param as a paint. */
export const colorPaint = (v: unknown, d: RGBA = [1, 1, 1, 1]): Paint => ({
	kind: 'color',
	color: colorOf(v, d),
});

/** Colours evenly spread, as a gradient paint (an effect param has no gradient type, TL-091 is a look's control). */
export function gradientPaint(
	type: Gradient['type'],
	angle: number,
	stops: readonly (readonly [number, unknown])[],
): Paint {
	return {
		kind: 'gradient',
		gradient: {
			type,
			span: 'block',
			angle: Number.isFinite(angle) ? angle : 0,
			stops: stops.map(([at, c]) => ({ at, paint: { color: colorOf(c, [1, 1, 1, 1]) } })),
		},
	};
}

function lookOf(layers: LookEffectLayers, p: EffectParams, ctx: FxPlanContext): FxTitleLook {
	const appearance: ResolvedAppearance = {
		seed: 0,
		palette: DEFAULT_PALETTE,
		light: ctx.structures?.globalLight ?? { angle: DEFAULT_LIGHT_ANGLE, altitude: DEFAULT_LIGHT_ALTITUDE },
		layers: layers(p).map((l, i) => ({ id: `l${i}`, ...l })),
	};
	return {
		appearance,
		unitPx: LOOK_EFFECT_UNIT,
		contentSeconds: 0,
	};
}

const withLook = <C extends FxPlanContext>(layers: LookEffectLayers, p: EffectParams, ctx: C): C => ({
	...ctx,
	structures: { ...ctx.structures, titleLook: lookOf(layers, p, ctx) },
});

/**
 * TL-033: the padding of the look across the clip, so the canvas keeps its size while a param animates. The frame being
 * drawn always counts: samples between keys only keep the canvas still, they are never what stops a frame clipping.
 */
function clipPadding(layers: LookEffectLayers, p: EffectParams, ctx: FxPlanContext): Partial<FxPadding> {
	const at = (q: EffectParams) => titleLookPadding(withLook(layers, q, ctx));
	const out = { left: 0, top: 0, right: 0, bottom: 0, ...at(p) };
	const n = ctx.clip?.duration ?? 0;
	if (ctx.paramsAt && n > 1)
		for (let i = 0; i < REACH_SAMPLES; i++) {
			const r = at(ctx.paramsAt(Math.round((i * (n - 1)) / (REACH_SAMPLES - 1))));
			out.left = Math.max(out.left, r.left ?? 0);
			out.top = Math.max(out.top, r.top ?? 0);
			out.right = Math.max(out.right, r.right ?? 0);
			out.bottom = Math.max(out.bottom, r.bottom ?? 0);
		}
	return out;
}

/** The GPU hooks of a look effect. */
export function lookEffectGpu(layers: LookEffectLayers): GpuEffect {
	return {
		passes: (p, ctx) => planTitleLook(withLook(layers, p, ctx)),
		padding: (p, ctx) => clipPadding(layers, p, ctx),
		// The look's output pass mixes by `u_lookIntensity` (TL-089), the look effect's own param. An effect built on a look
		// has no such param: it always shows its look in full (its own Intensity, where it has one, is a layer's).
		uniforms: (p, ctx: FxFrameContext) => ({
			...titleLookUniforms(withLook(layers, p, ctx)),
			[`u_${TITLE_LOOK_INTENSITY}`]: 100,
		}),
		paramUniforms: false,
		requiresFloat: true,
		timeInvariant: true,
	};
}

export function defineLookEffect(
	init: Omit<ShaderEffectInit, 'gpu'> & { layers: LookEffectLayers },
): EffectSpec {
	const { layers, ...rest } = init;
	return defineShaderEffect({ expensive: true, ...rest, gpu: lookEffectGpu(layers) });
}
