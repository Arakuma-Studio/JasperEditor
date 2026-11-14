// Adjustment layers with the Transform effect on the native path (docs/wp-notes/edit-structure.md "Native Transform on
// adjustment layers"). The preview runs the effect's shader on the composite below the layer (AdjustmentScope's canvas
// chain: stash → Transform → mix). The native composite ends its process at such a layer (a cut of the blend pipeline,
// blend/run.ts): the composite so far goes out as raw `W×H` RGBA, the multi-tap kernel draws it through the Transform's
// per-frame maps and shutter taps — the lowered layers' kernel and taps (`drawTaps`, `planLoweredFrames`, shared with
// the Program preview's 2D path), with the composite as the picture — and the next process receives `2W×H` frames, the
// composite ‖ the transformed composite. There the layer is drawn by the usual adjustment chain (its effects after the
// Transform, crop region, opacity, fades, blend mode) with the transformed half as its source and the original half as
// what it mixes over.
//
// `adjustStackedFrame` is self-contained (no imports, no closures over module scope): its source text runs in the
// worker threads (pool.ts), so tests and production share one implementation.
import {
	defaultEffectRegistry,
	type EffectRegistry,
	hasActiveExpression,
	type Rational,
	type RenderVisualClip,
} from '@jasper/project';
import { planLoweredFrames, type TapFrame } from '../stream/lowered.ts';

export const TRANSFORM_EFFECT = 'jasper.transform';
/** Largest frame side of the kernel (the lowered layers' effect canvas limit, `loweredLayerTaps`). */
const MAX_SIDE = 4096;

const enabledTransform = (fx: RenderVisualClip['effects'][number]) =>
	fx.enabled && fx.effectId === TRANSFORM_EFFECT;

/** True when the clip is an adjustment layer whose enabled effects include Transform (drawn through the kernel). */
export function isTransformAdjustment(c: Pick<RenderVisualClip, 'kind' | 'effects'>): boolean {
	return c.kind === 'adjustment' && c.effects.some(enabledTransform);
}

const deepExpression = (v: unknown): boolean => {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(deepExpression);
	const o = v as Record<string, unknown>;
	if (hasActiveExpression(o as { expression?: { text: string; enabled: boolean } })) return true;
	return Object.values(o).some(deepExpression);
};

/** True when a Transform blurs somewhere in the clip (Shutter Angle on: Use Composition's Shutter Angle off). */
function transformBlurs(fx: RenderVisualClip['effects'][number]): boolean {
	const values = (name: string) => {
		const a = fx.params[name];
		return a ? [a.value, ...a.keyframes.map((k) => k.value)] : [];
	};
	if (!values('useCompShutterAngle').some((v) => v === false)) return false;
	return values('shutterAngle').some((v) => typeof v === 'number' && v > 0);
}

/**
 * Why the native path cannot draw the Transform of an adjustment layer (empty = it can; only asked for
 * `isTransformAdjustment` clips). The other effects are checked by the planner as on any adjustment layer.
 */
export function transformAdjustmentRefusals(c: RenderVisualClip): string[] {
	const out: string[] = [];
	const label = `adjustment clip "${c.name}"`;
	const enabled = c.effects.filter((fx) => fx.enabled);
	let last = -1;
	enabled.forEach((fx, i) => {
		if (enabledTransform(fx)) last = i;
	});
	// The kernel draws the Transform on the composite as it is below the layer: effects before it (or between two
	// Transforms) would have to run first.
	for (const fx of enabled.slice(0, last))
		if (fx.effectId !== TRANSFORM_EFFECT)
			out.push(
				`${label} has ${fx.effectId} before its Transform (the native path draws Transform first on adjustment layers)`,
			);
	const transforms = enabled.filter(enabledTransform);
	if (transforms.some((fx) => deepExpression(fx.params)))
		out.push(`${label} has expressions on its Transform (not sampled by the native kernel)`);
	if (transforms.filter(transformBlurs).length > 1)
		out.push(`${label} has more than one motion-blurred Transform`);
	if (c.intrinsicBox.width > MAX_SIDE || c.intrinsicBox.height > MAX_SIDE)
		out.push(`${label} draws its Transform on a frame larger than ${MAX_SIDE} px`);
	return out;
}

/**
 * The kernel frames of a Transform adjustment layer over sequence frames `[f0, f1)` on a `W×H` composite: per frame
 * the drawn rectangle and the multi-tap program (sequence px → composite px; Transform maps, coverage stages and the
 * shutter taps of its motion blur). The layer's opacity is not applied here (the adjustment chain mixes it).
 */
export function planAdjustmentFrames(o: {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	fps: Rational;
	W: number;
	H: number;
	registry?: EffectRegistry;
}): TapFrame[] {
	// Only the Transforms: the kernel draws nothing else (the effects after them run in the next process).
	const clip: RenderVisualClip = { ...o.clip, effects: o.clip.effects.filter(enabledTransform) };
	return planLoweredFrames({
		clip,
		f0: o.f0,
		f1: o.f1,
		fps: o.fps,
		picture: { x: 0, y: 0, w: o.W, h: o.H },
		W: o.W,
		H: o.H,
		registry: o.registry ?? defaultEffectRegistry,
	}).frames;
}

/** The kernel `drawTaps` (stream/kernel.ts), passed in so that this function stays self-contained. */
type DrawTaps = (
	src: Uint8Array,
	sw: number,
	cw: number,
	ch: number,
	dst: Uint8Array,
	dw: number,
	dh: number,
	prog: ArrayLike<number>,
	opacity: number,
	rect: ArrayLike<number> | null,
	acc: Float32Array,
) => void;

/**
 * One frame of the cut: `src` = the composite (`W×H` straight RGBA), `out` = `2W×H`, the composite ‖ the composite
 * drawn through `prog` within `rect` (transparent elsewhere). `prog` null = the layer is not drawn on this frame (the
 * right half repeats the composite; the next process does not read it). `tmp` = `W×H×4` bytes, `acc` = the kernel's
 * scratch (at least `4 × rect area` floats).
 */
export function adjustStackedFrame(
	drawTaps: DrawTaps,
	src: Uint8Array,
	W: number,
	H: number,
	prog: ArrayLike<number> | null,
	rect: ArrayLike<number> | null,
	out: Uint8Array,
	tmp: Uint8Array,
	acc: Float32Array,
): void {
	const row = W * 4;
	if (prog) drawTaps(src, W, W, H, tmp, W, H, prog, 1, rect, acc);
	const right = prog ? tmp : src;
	for (let y = 0; y < H; y++) {
		const s = y * row;
		const o = 2 * s;
		out.set(src.subarray(s, s + row), o);
		out.set(right.subarray(s, s + row), o + row);
	}
}
