// Stack planning of a layer with GPU shader effects (wave-1 fx framework; S03 §4.2 per-layer order, FX-002 order
// preservation, RND-010). Pure (no React, no GL) and unit-tested. Which effects become steps of the layer's canvas
// effect chain and which stay CSS/SVG wrapper stages (LayerBox):
// - crop first (S03 §4.2 step 2, as `effectStages` does), then the stack in order;
// - the chain covers the stack up to the LAST effect that needs pixels (a shader effect or a colour run); in it:
//   shader effects → `gpu` steps, consecutive colour effects → one baked-LUT `lut` step (S06 runs), CSS-filter
//   effects → 2D `css` steps, crop → `crop`, flips → `flip`; the corner pin stays the layer matrix (it commutes);
//   built-ins whose preview needs an SVG filter at their params (one-direction Gaussian Blur, Repeat Edge Pixels)
//   run as GPU stand-ins (fx/builtins.ts) in stack order; anything else there (other style fragments) cannot run on
//   a canvas and is drawn after the chain as a CSS/SVG stage — listed in `reordered` (an order approximation);
// - effects after the chain stay CSS/SVG stages, in order.
// Layers without an enabled, known shader effect are not planned here (null): they keep the M1/M2 paths unchanged.
import {
	activeMasks,
	addPadding,
	CORNER_PIN_EFFECT_ID,
	type EffectParams,
	type EffectRegistry,
	type EffectSpec,
	type FxClipInfo,
	type FxPadding,
	type FxParamsAt,
	type FxPlanContext,
	gpuIsTimeDependent,
	gpuPadding,
	lumetriSpatialInstanceId,
	type ResolvedEffect,
	type ResolvedMask,
	ZERO_PADDING,
} from '@jasper/project';
import { chainGpuStandIn } from './builtins.ts';

const CROP = 'jasper.crop';
const FLIP_H = 'jasper.flip-horizontal';
const FLIP_V = 'jasper.flip-vertical';

/**
 * wp masks: the effect of a step applies inside these masks only (mix(original, effected, coverage)).
 * color-grade: `maskJoin` = this masked step and the next one (same masks) form ONE masked unit — a Lumetri
 * instance's LUT step and its spatial GPU stage mix with the input once, so feathered masks stay exact.
 */
type StepMasks = { masks?: ResolvedMask[]; maskJoin?: boolean };

export type FxStep =
	| ({ kind: 'gpu'; fx: ResolvedEffect; spec: EffectSpec; padding: FxPadding } & StepMasks)
	| ({ kind: 'lut'; effects: ResolvedEffect[] } & StepMasks)
	| ({ kind: 'css'; fx: ResolvedEffect; filter: string } & StepMasks)
	/** Insets as fractions of the layer box (left, top, right, bottom), like the CSS `inset()` clip. */
	| ({ kind: 'crop'; fx: ResolvedEffect; insets: [number, number, number, number] } & StepMasks)
	| ({ kind: 'flip'; fx: ResolvedEffect; horizontal: boolean } & StepMasks)
	/** wp masks: the layer's Opacity masks (picture × coverage), after every effect. */
	| { kind: 'mask'; masks: ResolvedMask[] };

/** wp masks: the bypass entry standing for a layer's masks (Opacity or effect masks). */
export const MASKS_BYPASS_ID = 'jasper.masks';

export type FxBypass = {
	fxId: string;
	effectId: string;
	reason: 'gpu-unavailable' | 'shader-failed' | 'layer-unsupported';
};

export type LayerFxPlan = {
	/** False: the GPU cannot run (preview without WebGL2 / lost context): draw the M1/M2 way, effects bypassed. */
	active: boolean;
	steps: FxStep[];
	/** Effects for LayerBox's CSS/SVG stages (in stack order). */
	cssEffects: ResolvedEffect[];
	/** Effects before the last chain step that could not run in the chain (drawn after it). */
	reordered: string[];
	bypassed: FxBypass[];
	/** Accumulated padding of the gpu steps, layer pixels. */
	padding: FxPadding;
	/** Some gpu step's output changes over time (redraw every frame). */
	timeDependent: boolean;
};

export type PlanLayerFxOptions = {
	registry: EffectRegistry;
	/** GPU host availability (fxStatus.gpu()). */
	gpu: 'ok' | 'lost' | 'unavailable';
	/** Effects whose shader failed (preview bypass). */
	failed?: (effectId: string) => boolean;
	/** Preview before/after: colour effects of the layer are bypassed (S06:CGU-005). */
	colorBypass?: boolean;
	/** Plan context for the padding hooks (layer box, scale, fps; frame and clip when known). */
	ctx: FxPlanContext;
	/** Params of an effect instance at other frames (`FxPlanContext.paramsAt` of its padding hook). */
	paramsAt?: (fx: ResolvedEffect) => FxParamsAt | undefined;
	/** Kind of a project media (a `media` param bound to a video makes its effect time dependent). */
	mediaKind?: (mediaId: string) => string | null | undefined;
	clip?: FxClipInfo;
	/**
	 * Transition framework: the layer is a side of a GPU transition (its picture is captured for the transition
	 * stage). The layer takes the chain even without shader effects, and the chain covers the whole stack (every
	 * effect that can run on a canvas does; SVG-filter effects are `reordered` and not part of the capture).
	 */
	capture?: boolean;
	/**
	 * wp masks: the layer's Opacity masks (evaluated). With an active Opacity mask or an enabled effect with an
	 * active mask, the layer takes the chain (like `capture`): the chain covers the whole stack, masked effects mix
	 * with their input by coverage, and a final `mask` step multiplies the picture by the Opacity masks.
	 */
	masks?: readonly ResolvedMask[];
};

/** wp masks: the active masks of an effect (empty when none). */
export function effectMasks(fx: Pick<ResolvedEffect, 'masks'>): ResolvedMask[] {
	return fx.masks?.length ? activeMasks(fx.masks) : [];
}

/** wp masks: the layer has an active Opacity mask or an enabled effect with an active mask. */
export function layerHasMasks(
	effects: readonly Pick<ResolvedEffect, 'masks' | 'enabled'>[],
	masks: readonly ResolvedMask[] | undefined,
): boolean {
	return (
		(masks?.length ? activeMasks(masks).length > 0 : false) ||
		effects.some((fx) => fx.enabled && effectMasks(fx).length > 0)
	);
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

export function planLayerFx(
	effects: readonly ResolvedEffect[],
	opts: PlanLayerFxOptions,
): LayerFxPlan | null {
	const { registry } = opts;
	const specOf = (fx: ResolvedEffect) => {
		const s = registry.get(fx.effectId, fx.effectVersion);
		return s?.appliesTo === 'video' ? s : undefined;
	};
	const ordered = [
		...effects.filter((e) => e.effectId === CROP),
		...effects.filter((e) => e.effectId !== CROP),
	].filter((fx) => fx.enabled && !!specOf(fx));
	const opacityMasks = opts.masks?.length ? activeMasks(opts.masks) : [];
	const masked = opacityMasks.length > 0 || ordered.some((fx) => effectMasks(fx).length > 0);
	const whole = !!opts.capture || masked;
	if (!whole && !ordered.some((fx) => !!specOf(fx)!.gpu)) return null;
	const bypassed: FxBypass[] = [];
	if (opts.gpu !== 'ok') {
		for (const fx of ordered)
			if (specOf(fx)!.gpu) bypassed.push({ fxId: fx.id, effectId: fx.effectId, reason: 'gpu-unavailable' });
		// wp masks: masks run on the GPU too (the preview falls back to a CPU mask image for Opacity masks).
		if (masked)
			bypassed.push({ fxId: MASKS_BYPASS_ID, effectId: MASKS_BYPASS_ID, reason: 'gpu-unavailable' });
		return {
			active: false,
			steps: [],
			cssEffects: [...effects],
			reordered: [],
			bypassed,
			padding: ZERO_PADDING,
			timeDependent: false,
		};
	}
	const runnable = ordered.filter((fx) => {
		const spec = specOf(fx)!;
		if ((spec.color || spec.gradeBypass) && opts.colorBypass) return false;
		if (spec.gpu && opts.failed?.(fx.effectId)) {
			bypassed.push({ fxId: fx.id, effectId: fx.effectId, reason: 'shader-failed' });
			return false;
		}
		return true;
	});
	let last = -1;
	runnable.forEach((fx, i) => {
		const spec = specOf(fx)!;
		if (spec.gpu || spec.color) last = i;
	});
	if (whole) last = runnable.length - 1;
	else if (last < 0 || !runnable.slice(0, last + 1).some((fx) => specOf(fx)!.gpu))
		// Every shader effect failed: plain M1/M2 drawing (the colour stage handles any grade).
		return {
			active: false,
			steps: [],
			cssEffects: runnable,
			reordered: [],
			bypassed,
			padding: ZERO_PADDING,
			timeDependent: false,
		};
	const steps: FxStep[] = [];
	const cssEffects: ResolvedEffect[] = [];
	const reordered: string[] = [];
	let padding: FxPadding = ZERO_PADDING;
	let timeDependent = false;
	runnable.forEach((fx, i) => {
		const spec = specOf(fx)!;
		if (i > last) {
			cssEffects.push(fx);
			return;
		}
		// Built-ins whose preview would be an SVG filter run as GPU stand-ins, in stack order.
		const fm = effectMasks(fx);
		const withMasks = <T extends object>(step: T): T => (fm.length ? { ...step, masks: fm } : step);
		const gpuSpec = spec.gpu
			? spec
			: (i < last || whole) && !opts.failed?.(fx.effectId)
				? chainGpuStandIn(spec, fx.params as EffectParams)
				: null;
		if (gpuSpec) {
			const paramsAt = opts.paramsAt?.(fx);
			const pad = gpuPadding(gpuSpec, fx.params, {
				...opts.ctx,
				...(paramsAt ? { paramsAt } : {}),
				...(opts.clip ? { clip: opts.clip } : {}),
				...(fx.puppet || fx.warpAnalysis
					? {
							structures: {
								...(fx.puppet ? { puppet: fx.puppet } : {}),
								...(fx.warpAnalysis ? { warpAnalysis: fx.warpAnalysis } : {}),
							},
						}
					: {}),
			});
			padding = addPadding(padding, pad);
			timeDependent ||= gpuIsTimeDependent(gpuSpec, fx.params, opts.mediaKind);
			steps.push(withMasks({ kind: 'gpu', fx, spec: gpuSpec, padding: pad }));
			return;
		}
		if (spec.color) {
			// A masked colour effect is its own run (its masks mix that run alone with its input).
			const prev = steps[steps.length - 1];
			const prevFx = runnable[i - 1];
			if (prev?.kind === 'lut' && !prev.masks && fm.length === 0 && prevFx && specOf(prevFx)!.color)
				prev.effects.push(fx);
			else steps.push(withMasks({ kind: 'lut', effects: [fx] }));
			return;
		}
		if (fx.effectId === CORNER_PIN_EFFECT_ID) return; // the layer matrix (projective), after every effect
		if (fx.effectId === CROP) {
			const p = fx.params;
			steps.push(
				withMasks({
					kind: 'crop',
					fx,
					insets: [num(p.left) / 100, num(p.top) / 100, num(p.right) / 100, num(p.bottom) / 100],
				}),
			);
			return;
		}
		if (fx.effectId === FLIP_H || fx.effectId === FLIP_V) {
			steps.push(withMasks({ kind: 'flip', fx, horizontal: fx.effectId === FLIP_H }));
			return;
		}
		const css = spec.preview.css?.(fx.params);
		if (css && Object.keys(css).length === 0) return; // identity
		if (css && Object.keys(css).length === 1 && typeof css.filter === 'string') {
			steps.push(withMasks({ kind: 'css', fx, filter: css.filter }));
			return;
		}
		cssEffects.push(fx);
		reordered.push(fx.id);
	});
	// CSS stages keep stack order (reordered ones first: they were before the post-chain effects).
	const order = new Map(effects.map((fx, i) => [fx.id, i]));
	cssEffects.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
	// color-grade: a masked Lumetri LUT step followed by its spatial stage is masked as one unit.
	for (let i = 0; i + 1 < steps.length; i++) {
		const a = steps[i]!;
		const b = steps[i + 1]!;
		if (
			a.kind === 'lut' &&
			a.masks?.length &&
			b.kind === 'gpu' &&
			b.masks?.length &&
			b.fx.id === lumetriSpatialInstanceId(a.effects[a.effects.length - 1]!.id)
		)
			a.maskJoin = true;
	}
	if (opacityMasks.length) steps.push({ kind: 'mask', masks: opacityMasks });
	return { active: true, steps, cssEffects, reordered, bypassed, padding, timeDependent };
}

/** The layer's canvas: box + padding in layer px, scaled down only when a side would exceed `maxSide`. */
export type FxCanvasLayout = {
	/** Canvas size in pixels (the chain size). */
	width: number;
	height: number;
	/** Canvas size in layer pixels (integers; the canvas element's CSS size). */
	cssWidth: number;
	cssHeight: number;
	/** Canvas pixels per layer pixel. */
	pxScale: number;
	/** Padding in layer pixels (the canvas sits at (−left, −top) in the layer box). */
	padding: FxPadding;
	/** The layer box inside the canvas, canvas pixels. */
	box: { x: number; y: number; w: number; h: number };
};

/**
 * `scale` (0, 1]: reduced preview resolution (the Program monitor's 1/2, 1/4… playback resolution): the canvas is
 * drawn at `scale` × its size and stretched by CSS; px-based params follow through `u_pxScale` / `ctx.pxScale`.
 */
export function fxCanvasLayout(
	box: { width: number; height: number },
	padding: FxPadding,
	maxSide: number,
	scale = 1,
): FxCanvasLayout {
	const cssWidth = Math.max(1, Math.ceil(box.width + padding.left + padding.right));
	const cssHeight = Math.max(1, Math.ceil(box.height + padding.top + padding.bottom));
	const s = Number.isFinite(scale) && scale > 0 ? Math.min(1, scale) : 1;
	const pxScale = Math.min(1, maxSide / Math.max(cssWidth, cssHeight)) * s;
	return {
		width: Math.max(1, Math.ceil(cssWidth * pxScale)),
		height: Math.max(1, Math.ceil(cssHeight * pxScale)),
		cssWidth,
		cssHeight,
		pxScale,
		padding,
		box: {
			x: padding.left * pxScale,
			y: padding.top * pxScale,
			w: box.width * pxScale,
			h: box.height * pxScale,
		},
	};
}
