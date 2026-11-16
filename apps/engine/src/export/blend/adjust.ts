// Adjustment layers with geometric effects on the native path (docs/wp-notes/edit-structure.md "Native geometric
// effects on adjustment layers"). The preview runs the effects' shaders on the composite below the layer
// (AdjustmentScope's canvas chain: stash → effects → mix). The native composite ends its process at such a layer (a cut
// of the blend pipeline, blend/run.ts): the composite so far goes out as raw `W×H` RGBA, a worker pool runs the same
// chain on it — one resample pass per effect in stack order, as the GPU host does (passes.ts) — and the next process
// receives `2W×H` frames, the composite ‖ the chain's output. There the layer is drawn by the usual adjustment chain
// (its effects after the geometric ones — colour runs, flips —, crop region, opacity, fades, blend mode) with the drawn
// half as its source and the original half as what it mixes over.
//
// The passes' per-frame values come from the effects themselves: the evaluated params (`resolveLayerProps`), the
// shaders' `uniforms` and `padding` hooks with the frame context the compositions build (`loweredFrameContext`), the
// Transform's taps from its uniforms (`transformPoses`, shared with lowered layers).
import {
	ADJUSTMENT_KERNEL_EFFECTS,
	clipContentTime,
	defaultEffectRegistry,
	type EffectParams,
	type EffectRegistry,
	gpuPadding,
	hasActiveExpression,
	loweredFrameContext,
	type Rational,
	type RenderVisualClip,
	resolveLayerProps,
	transformPoses,
} from '@jasper/project';
import type { ChainFrame, ChainPass } from './passes.ts';

export const TRANSFORM_EFFECT = 'jasper.transform';
const SHAKE = 'jasper.s.shake';
const MIRROR = 'jasper.mirror';
const REPLICATE = 'jasper.replicate';
const OFFSET = 'jasper.offset';
const DIRECTIONAL_BLUR = 'jasper.directional-blur';
/** The effects the kernel draws on an adjustment layer (passes.ts; the list the automation cost estimate shares). */
const KERNEL_EFFECTS = ADJUSTMENT_KERNEL_EFFECTS;
/** Largest effect canvas side (box + padding) of the kernel. */
const MAX_SIDE = 4096;

type Effect = RenderVisualClip['effects'][number];
const kernelEffect = (fx: Pick<Effect, 'enabled' | 'effectId'>) =>
	fx.enabled && KERNEL_EFFECTS.has(fx.effectId);

/** True when the clip is an adjustment layer with an enabled geometric effect the kernel draws. */
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

/**
 * True when an adjustment layer's output is its geometric effects' output, as it is: only geometric effects, Normal,
 * Opacity 100 % without keys, no fades, masks or 3D. Consecutive such layers (one track's transition kits) share one
 * kernel pass that replaces the composite in their frames (native.ts), instead of a pass and an overlay each.
 */
export function isPlainKernelAdjustment(c: RenderVisualClip): boolean {
	return (
		isKernelAdjustment(c) &&
		c.effects.every((fx) => !fx.enabled || KERNEL_EFFECTS.has(fx.effectId)) &&
		(c.blendMode ?? 'normal') === 'normal' &&
		c.opacity.value === 100 &&
		c.opacity.keyframes.length === 0 &&
		!c.fades?.length &&
		!c.masks?.length &&
		!c.threeD
	);
}

/**
 * Why the native path cannot draw the geometric effects of an adjustment layer (empty = it can; only asked for
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
	// The kernel runs the geometric effects on the composite as it is below the layer: another effect before one of
	// them (a colour run, a crop, a flip) would have to run between its passes.
	for (const fx of enabled.slice(0, last))
		if (!kernelEffect(fx))
			out.push(
				`${name} has ${fx.effectId} before a geometric effect (the native path draws its geometric effects first on adjustment layers)`,
			);
	const kernel = enabled.filter(kernelEffect);
	for (const fx of kernel) {
		if (fx.masks?.length) out.push(`${name} has effect masks on ${fx.effectId}`);
		if (deepExpression(fx.params)) out.push(`${name} has expressions on ${fx.effectId}`);
		if (fx.effectId === SHAKE) {
			const a = fx.params.motionBlur;
			if (a && [a.value, ...a.keyframes.map((k) => k.value)].some((v) => v === true))
				out.push(`${name} uses S_Shake motion blur, which the native kernel does not draw`);
		}
	}
	return out;
}

/**
 * The kernel's chain over sequence frames `[f0, f1)`: per frame the effect canvas padding and one pass per geometric
 * effect (passes.ts), from the evaluated params and the shaders' own hooks. The layer's opacity is not applied here
 * (the adjustment chain mixes it). Throws when the effect canvas exceeds `MAX_SIDE`.
 */
export function planAdjustmentFrames(o: {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	fps: Rational;
	registry?: EffectRegistry;
}): ChainFrame[] {
	const c = o.clip;
	const registry = o.registry ?? defaultEffectRegistry;
	const fps = o.fps.num / o.fps.den;
	const cache = new Map();
	const frames: ChainFrame[] = [];
	for (let f = o.f0; f < o.f1; f++) {
		const props = resolveLayerProps(c, clipContentTime(c, f, o.fps));
		const box = { width: props.box.width, height: props.box.height };
		const effects = props.effects.filter(kernelEffect);
		const pad: [number, number, number, number] = [0, 0, 0, 0];
		const passes: ChainPass[] = [];
		for (const fx of effects) {
			const spec = registry.get(fx.effectId, fx.effectVersion);
			if (!spec?.gpu) throw new Error(`adjustment clip "${c.name}": ${fx.effectId} has no shader`);
			const p = fx.params as EffectParams;
			const ctx = loweredFrameContext({ clip: c, fx, frame: f, fps, box, cache });
			const padding = gpuPadding(spec, p, ctx);
			pad[0] += padding.left;
			pad[1] += padding.top;
			pad[2] += padding.right;
			pad[3] += padding.bottom;
			const u = (spec.gpu.uniforms?.(p, ctx) ?? {}) as Record<string, unknown>;
			const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
			const pt = (v: unknown): [number, number] =>
				Array.isArray(v) && v.length === 2 ? [num(v[0], 0.5), num(v[1], 0.5)] : [0.5, 0.5];
			if (fx.effectId === TRANSFORM_EFFECT) {
				const plan = (u.u_mbPlan as { ivec4: number[] } | undefined)?.ivec4;
				if (plan && plan[0]! > 1)
					// Motion blur: the shader's own per-pixel taps (its jitter included) from the planned shutter.
					passes.push({
						k: 'tf',
						taps: [],
						wsum: 1,
						mb: {
							n: plan[0]!,
							K: plan[1]!,
							S: plan[2]!,
							flags: plan[3]!,
							keys: (u.u_mbKeys as { vec4s: number[] }).vec4s,
							warp: (u.u_mbWarp as { vec4s: number[] }).vec4s,
							seed: ctx.seed,
						},
					});
				else {
					const poses = transformPoses(u, num(p.opacity, 100));
					passes.push({ k: 'tf', taps: poses.list.flatMap((q) => [q.w, ...q.inv]), wsum: poses.wsum });
				}
			} else if (fx.effectId === SHAKE) {
				const wrap = (v: unknown) => (v === 'no' ? 0 : v === 'tile' ? 1 : 2);
				passes.push({
					k: 'shake',
					q: (u.u_shakeNow as { vec4s: number[] }).vec4s,
					rgb: u.u_shakeRgb === true,
					z: num(p.zDist, 1),
					wx: wrap(p.wrapX),
					wy: wrap(p.wrapY),
				});
			} else if (fx.effectId === MIRROR) {
				const [cx, cy] = pt(p.reflectionCenter);
				const a = (num(p.reflectionAngle, 0) * Math.PI) / 180;
				passes.push({ k: 'mirror', cx, cy, dx: Math.cos(a), dy: Math.sin(a) });
			} else if (fx.effectId === REPLICATE) passes.push({ k: 'replicate', n: num(p.count, 2) });
			else if (fx.effectId === OFFSET) {
				const [sx, sy] = pt(p.shiftCenterTo);
				passes.push({ k: 'offset', sx, sy, blend: num(p.blendWithOriginal, 0) });
			} else {
				const step = (u.u_dbStep as number[] | undefined) ?? [0, 0];
				passes.push({ k: 'dblur', sx: step[0]!, sy: step[1]! });
			}
		}
		const cw = Math.ceil(box.width + pad[0] + pad[2]);
		const ch = Math.ceil(box.height + pad[1] + pad[3]);
		if (cw > MAX_SIDE || ch > MAX_SIDE)
			throw new Error(
				`adjustment clip "${c.name}": its effect canvas is ${cw}×${ch} px (at most ${MAX_SIDE} on the native path)`,
			);
		frames.push({ pad, passes });
	}
	return frames;
}

/** Why the kernel cannot run a kernel adjustment layer's chain (its canvas too large; null = it can). */
export function adjustmentPlanRefusal(c: RenderVisualClip, fps: Rational): string | null {
	try {
		planAdjustmentFrames({ clip: c, f0: c.start, f1: c.start + c.duration, fps });
		return null;
	} catch (e) {
		return e instanceof Error ? e.message : String(e);
	}
}
