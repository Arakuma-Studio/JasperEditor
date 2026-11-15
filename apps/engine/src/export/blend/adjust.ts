// Adjustment layers with Transform or S_Shake on the native path (docs/wp-notes/edit-structure.md "Native Transform
// and S_Shake on adjustment layers"). The preview runs the effects' shaders on the composite below the layer
// (AdjustmentScope's canvas chain: stash → effects → mix). The native composite ends its process at such a layer (a cut
// of the blend pipeline, blend/run.ts): the composite so far goes out as raw RGBA, the multi-tap kernel draws it
// through the effects' per-frame maps (Transform with its shutter taps, S_Shake's pose) — the lowered layers' kernel
// and taps (`drawTaps`, `planLoweredFrames`, shared with the Program preview's 2D path), with the composite as the
// picture — and the next process receives `2W×H` frames, the composite ‖ the drawn composite. There the layer is drawn
// by the usual adjustment chain (its effects after the kernel's — colour runs, flips —, crop region, opacity, fades,
// blend mode) with the drawn half as its source and the original half as what it mixes over. One Transform or one
// S_Shake per layer (the preview resamples after every effect; one kernel pass resamples once). An S_Shake that wraps
// with Reflect gets the composite padded with its mirror image (`fillborders` mirror = the shader's continuous
// reflection about the frame edge, sampled bilinearly), as far as its taps reach.
//
// `adjustStackedFrame` is self-contained (no imports, no closures over module scope): its source text runs in the
// worker threads (pool.ts), so tests and production share one implementation.
import {
	defaultEffectRegistry,
	type EffectRegistry,
	hasActiveExpression,
	loweredEffectRefusal,
	type Rational,
	type RenderVisualClip,
} from '@jasper/project';
import { planLoweredFrames, type TapFrame } from '../stream/lowered.ts';

export const TRANSFORM_EFFECT = 'jasper.transform';
export const SHAKE_EFFECT = 'jasper.s.shake';
/** The effects the kernel draws on an adjustment layer. */
const KERNEL_EFFECTS: ReadonlySet<string> = new Set([TRANSFORM_EFFECT, SHAKE_EFFECT]);
/** Largest frame side of the kernel (the lowered layers' effect canvas limit, `loweredLayerTaps`). */
const MAX_SIDE = 4096;

type Effect = RenderVisualClip['effects'][number];
const kernelEffect = (fx: Effect) => fx.enabled && KERNEL_EFFECTS.has(fx.effectId);
const label = (fx: Effect) => (fx.effectId === TRANSFORM_EFFECT ? 'Transform' : 'S_Shake');

/** True when the clip is an adjustment layer with an enabled Transform or S_Shake (drawn through the kernel). */
export function isKernelAdjustment(c: Pick<RenderVisualClip, 'kind' | 'effects'>): boolean {
	return c.kind === 'adjustment' && c.effects.some(kernelEffect);
}

/** True when an effect is one the kernel draws on adjustment layers (the planner skips its generic check). */
export function isKernelEffect(effectId: string): boolean {
	return KERNEL_EFFECTS.has(effectId);
}

const deepExpression = (v: unknown): boolean => {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(deepExpression);
	const o = v as Record<string, unknown>;
	if (hasActiveExpression(o as { expression?: { text: string; enabled: boolean } })) return true;
	return Object.values(o).some(deepExpression);
};

const values = (fx: Effect, name: string): unknown[] => {
	const a = fx.params[name];
	return a ? [a.value, ...a.keyframes.map((k) => k.value)] : [];
};

/** True when an S_Shake wraps with Reflect on an axis somewhere in the clip (a missing param is the default, Reflect). */
function shakeReflects(fx: Effect): boolean {
	if (fx.effectId !== SHAKE_EFFECT) return false;
	return ['wrapX', 'wrapY'].some((w) => {
		const vs = values(fx, w);
		return vs.length === 0 || vs.some((v) => v === 'reflect');
	});
}

/**
 * Why the native path cannot draw the Transform / S_Shake of an adjustment layer (empty = it can; only asked for
 * `isKernelAdjustment` clips). The other effects are checked by the planner as on any adjustment layer.
 */
export function kernelAdjustmentRefusals(c: RenderVisualClip): string[] {
	const out: string[] = [];
	const name = `adjustment clip "${c.name}"`;
	const enabled = c.effects.filter((fx) => fx.enabled);
	let last = -1;
	enabled.forEach((fx, i) => {
		if (kernelEffect(fx)) last = i;
	});
	// The kernel draws on the composite as it is below the layer: effects before it (or between two kernel effects)
	// would have to run first.
	for (const fx of enabled.slice(0, last))
		if (!kernelEffect(fx))
			out.push(
				`${name} has ${fx.effectId} before its ${label(enabled[last]!)} (the native path draws Transform and S_Shake first on adjustment layers)`,
			);
	const kernel = enabled.filter(kernelEffect);
	for (const fx of kernel) {
		const r = loweredEffectRefusal(fx, { reflect: true });
		if (r) out.push(`${name} uses ${r}, which the native kernel does not draw`);
	}
	if (kernel.some((fx) => deepExpression(fx.params)))
		out.push(`${name} has expressions on its Transform or S_Shake (not sampled by the native kernel)`);
	// One effect per kernel pass: the preview resamples after every effect, the kernel would compose them into one
	// resample (measured: 37 dB against the preview for S_Shake then Transform 130 %).
	if (kernel.length > 1)
		out.push(
			`${name} has ${kernel.length} Transform / S_Shake effects (the native kernel draws one per adjustment layer)`,
		);
	if (c.intrinsicBox.width > MAX_SIDE || c.intrinsicBox.height > MAX_SIDE)
		out.push(`${name} draws Transform / S_Shake on a frame larger than ${MAX_SIDE} px`);
	return out;
}

/**
 * The kernel frames of a Transform / S_Shake adjustment layer over sequence frames `[f0, f1)` on a `W×H` composite:
 * per frame the drawn rectangle and the multi-tap program (sequence px → picture px; the effects' maps, coverage stages
 * and the Transform's shutter taps), and `pad`: the picture is the composite with `pad` px of its mirror image on every
 * side (an S_Shake wrapping with Reflect; 0 = the composite itself). The layer's opacity is not applied here (the
 * adjustment chain mixes it). Throws when a reflection would reach farther than the frame's smaller side (the planner
 * refuses that first, `adjustmentPadRefusal`).
 */
export function planAdjustmentFrames(o: {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	fps: Rational;
	W: number;
	H: number;
	registry?: EffectRegistry;
}): { frames: TapFrame[]; pad: number } {
	// Only the kernel's effects: the kernel draws nothing else (the effects after them run in the next process).
	const clip: RenderVisualClip = { ...o.clip, effects: o.clip.effects.filter(kernelEffect) };
	const plan = (pad: number) =>
		planLoweredFrames({
			clip,
			f0: o.f0,
			f1: o.f1,
			fps: o.fps,
			picture: { x: -pad, y: -pad, w: o.W + 2 * pad, h: o.H + 2 * pad },
			W: o.W,
			H: o.H,
			registry: o.registry ?? defaultEffectRegistry,
		}).frames;
	const frames = plan(0);
	if (!clip.effects.some(shakeReflects)) return { frames, pad: 0 };
	// How far beyond the frame the taps sample for an output inside it (affine maps: at the frame's corners).
	let reach = 0;
	for (const f of frames) {
		const p = f.prog;
		let i = 2;
		for (let t = 0; t < (p[0]! | 0); t++) {
			const m = p.slice(i + 1, i + 7);
			for (const [x, y] of [
				[0, 0],
				[o.W, 0],
				[o.W, o.H],
				[0, o.H],
			] as const) {
				const u = m[0]! * x + m[1]! * y + m[2]!;
				const v = m[3]! * x + m[4]! * y + m[5]!;
				reach = Math.max(reach, -u, u - o.W, -v, v - o.H);
			}
			i += 12 + (p[i + 11]! | 0) * 10;
		}
	}
	if (!(reach > 0)) return { frames, pad: 0 };
	const pad = Math.ceil(reach) + 2;
	if (pad > Math.min(o.W, o.H))
		throw new Error(
			`adjustment clip "${o.clip.name}": its S_Shake reflects ${pad} px beyond the frame (at most ${Math.min(o.W, o.H)})`,
		);
	return { frames: plan(pad), pad };
}

/** Why a kernel adjustment layer's reflection cannot be padded natively (null = it can). */
export function adjustmentPadRefusal(c: RenderVisualClip, fps: Rational): string | null {
	const W = Math.max(1, Math.round(c.intrinsicBox.width));
	const H = Math.max(1, Math.round(c.intrinsicBox.height));
	try {
		planAdjustmentFrames({ clip: c, f0: c.start, f1: c.start + c.duration, fps, W, H });
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
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
 * One frame of the cut: `src` = the composite with `pad` px of padding on every side (`(W + 2·pad) × (H + 2·pad)`
 * straight RGBA), `out` = `2W×H`, the composite ‖ the picture drawn through `prog` within `rect` (transparent
 * elsewhere). `prog` null = the layer is not drawn on this frame (the right half repeats the composite; the next
 * process does not read it). `tmp` = `W×H×4` bytes, `acc` = the kernel's scratch (at least `4 × rect area` floats).
 */
export function adjustStackedFrame(
	drawTaps: DrawTaps,
	src: Uint8Array,
	W: number,
	H: number,
	pad: number,
	prog: ArrayLike<number> | null,
	rect: ArrayLike<number> | null,
	out: Uint8Array,
	tmp: Uint8Array,
	acc: Float32Array,
): void {
	const row = W * 4;
	const sw = W + 2 * pad;
	if (prog) drawTaps(src, sw, sw, H + 2 * pad, tmp, W, H, prog, 1, rect, acc);
	for (let y = 0; y < H; y++) {
		const s = ((y + pad) * sw + pad) * 4;
		const o = 2 * y * row;
		out.set(src.subarray(s, s + row), o);
		out.set(prog ? tmp.subarray(y * row, (y + 1) * row) : src.subarray(s, s + row), o + row);
	}
}
