// Stack planning of a layer with GPU shader effects (wave-1 fx framework; S03 §4.2 per-layer order, FX-002 order
// preservation, RND-010). Pure (no React, no GL) and unit-tested. Which effects become steps of the layer's canvas
// effect chain and which stay CSS/SVG wrapper stages (LayerBox):
// - crop first (S03 §4.2 step 2, as `effectStages` does), then the stack in order;
// - the chain covers the stack up to the LAST effect that needs pixels (a shader effect or a colour run); in it:
//   shader effects → `gpu` steps, consecutive colour effects → one baked-LUT `lut` step (S06 runs), CSS-filter
//   effects → 2D `css` steps, crop → `crop`, flips → `flip`; the corner pin stays the layer matrix (it commutes);
//   anything else there (SVG filters, other style fragments) cannot run on a canvas and is drawn after the chain as
//   a CSS/SVG stage — listed in `reordered` (an order approximation, as for the M2 colour stage);
// - effects after the chain stay CSS/SVG stages, in order.
// Layers without an enabled, known shader effect are not planned here (null): they keep the M1/M2 paths unchanged.
import {
	addPadding,
	CORNER_PIN_EFFECT_ID,
	type EffectRegistry,
	type EffectSpec,
	type FxPadding,
	type FxPlanContext,
	gpuIsTimeDependent,
	gpuPadding,
	type ResolvedEffect,
	ZERO_PADDING,
} from '@jasper/project';

const CROP = 'jasper.crop';
const FLIP_H = 'jasper.flip-horizontal';
const FLIP_V = 'jasper.flip-vertical';

export type FxStep =
	| { kind: 'gpu'; fx: ResolvedEffect; spec: EffectSpec; padding: FxPadding }
	| { kind: 'lut'; effects: ResolvedEffect[] }
	| { kind: 'css'; fx: ResolvedEffect; filter: string }
	/** Insets as fractions of the layer box (left, top, right, bottom), like the CSS `inset()` clip. */
	| { kind: 'crop'; fx: ResolvedEffect; insets: [number, number, number, number] }
	| { kind: 'flip'; fx: ResolvedEffect; horizontal: boolean };

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
	/** Plan context for the padding hooks (layer box, scale, fps). */
	ctx: FxPlanContext;
};

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** True when the stack has an enabled effect with a GPU realization (the layer takes the fx path). */
export function hasGpuEffects(
	effects: readonly Pick<ResolvedEffect, 'enabled' | 'effectId' | 'effectVersion'>[],
	registry: EffectRegistry,
): boolean {
	return effects.some((fx) => fx.enabled && !!registry.get(fx.effectId, fx.effectVersion)?.gpu);
}

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
	if (!ordered.some((fx) => !!specOf(fx)!.gpu)) return null;
	const bypassed: FxBypass[] = [];
	if (opts.gpu !== 'ok') {
		for (const fx of ordered)
			if (specOf(fx)!.gpu) bypassed.push({ fxId: fx.id, effectId: fx.effectId, reason: 'gpu-unavailable' });
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
		if (spec.color && opts.colorBypass) return false;
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
	if (last < 0 || !runnable.slice(0, last + 1).some((fx) => specOf(fx)!.gpu))
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
		if (spec.gpu) {
			const pad = gpuPadding(spec, fx.params, opts.ctx);
			padding = addPadding(padding, pad);
			timeDependent ||= gpuIsTimeDependent(spec);
			steps.push({ kind: 'gpu', fx, spec, padding: pad });
			return;
		}
		if (spec.color) {
			const prev = steps[steps.length - 1];
			const prevFx = runnable[i - 1];
			if (prev?.kind === 'lut' && prevFx && specOf(prevFx)!.color) prev.effects.push(fx);
			else steps.push({ kind: 'lut', effects: [fx] });
			return;
		}
		if (fx.effectId === CORNER_PIN_EFFECT_ID) return; // the layer matrix (projective), after every effect
		if (fx.effectId === CROP) {
			const p = fx.params;
			steps.push({
				kind: 'crop',
				fx,
				insets: [num(p.left) / 100, num(p.top) / 100, num(p.right) / 100, num(p.bottom) / 100],
			});
			return;
		}
		if (fx.effectId === FLIP_H || fx.effectId === FLIP_V) {
			steps.push({ kind: 'flip', fx, horizontal: fx.effectId === FLIP_H });
			return;
		}
		const css = spec.preview.css?.(fx.params as never);
		if (css && Object.keys(css).length === 0) return; // identity
		if (css && Object.keys(css).length === 1 && typeof css.filter === 'string') {
			steps.push({ kind: 'css', fx, filter: css.filter });
			return;
		}
		cssEffects.push(fx);
		reordered.push(fx.id);
	});
	// CSS stages keep stack order (reordered ones first: they were before the post-chain effects).
	const order = new Map(effects.map((fx, i) => [fx.id, i]));
	cssEffects.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
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

export function fxCanvasLayout(
	box: { width: number; height: number },
	padding: FxPadding,
	maxSide: number,
): FxCanvasLayout {
	const cssWidth = Math.max(1, Math.ceil(box.width + padding.left + padding.right));
	const cssHeight = Math.max(1, Math.ceil(box.height + padding.top + padding.bottom));
	const pxScale = Math.min(1, maxSide / Math.max(cssWidth, cssHeight));
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
