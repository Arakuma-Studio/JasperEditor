// spec 13 AS-070 / AS-073 — lowered layers: a text layer whose glyphs stay still while its picture moves (keyframed
// Motion / Opacity, the Transform effect with or without its Shutter Angle motion blur, S_Shake without motion blur,
// wrap or RGB split) is drawn as ONE still of its layer box through per-frame affine maps — by the native export's
// kernel (engine `export/stream/lowered.ts`) and by the Program preview's 2D canvas path (compositions
// `fx/lowered.ts`), from the taps computed here.
//
// The maps are the effects' own: every per-frame value comes from the registered shader's `uniforms` hook (the
// Transform's inverse map and its shutter plan `planMotionBlur`, S_Shake's pose `u_shakeNow` with the seed rules of
// `fxSeed`), evaluated with the frame context the compositions build (fx/stage.ts: layer box, pxScale 1, fps,
// clip-local frame, `fxParamsAtFn` with the box metric). What the shaders sample becomes coverage stages: the
// Transform samples its input inside the layer box only, S_Shake (Wrap No) samples the effect canvas (box + the GPU
// effects' padding) with an anti-aliased edge, and the last effect's output is the canvas the browser draws with the
// Motion matrix. Motion blur taps are the shader's: tap times through the plan's time warp at the strata centres,
// key poses interpolated linearly, weights `t.y × clamp(opacity / 100)`, normalised by Σ t.y.
import { hasActiveExpression, isAnimated } from '../keyframes.ts';
import {
	defaultEffectRegistry,
	type EffectParams,
	type EffectRegistry,
	effectParamMetric,
} from '../registry/effects.ts';
import { FX_MB_WARP_SIZE } from '../registry/fx/glsl/motion-blur.ts';
import {
	FX_MAX_PADDING,
	type FxFrameContext,
	fxClipProgress,
	fxParamsAtFn,
	fxSeed,
	gpuPadding,
} from '../registry/fx/shader.ts';
import { textAnimatorsTimeVarying } from '../text-animators/evaluate.ts';
import { textContentPad } from '../text-style.ts';
import type { ResolvedEffect, ResolvedLayerProps } from './scene.ts';
import type { RenderVisualClip } from './snapshot.ts';

const TRANSFORM = 'jasper.transform';
const SHAKE = 'jasper.s.shake';
/** Largest effect canvas side the lowered path accepts (the compositions draw larger canvases downscaled). */
const MAX_CANVAS = 4096;

/** An affine map `[m0…m5]`: u = m0·x + m1·y + m2, v = m3·x + m4·y + m5. */
export type Affine6 = [number, number, number, number, number, number];

/** `a ∘ b` (b first). */
export function composeAffine(a: Affine6, b: Affine6): Affine6 {
	return [
		a[0] * b[0] + a[1] * b[3],
		a[0] * b[1] + a[1] * b[4],
		a[0] * b[2] + a[1] * b[5] + a[2],
		a[3] * b[0] + a[4] * b[3],
		a[3] * b[1] + a[4] * b[4],
		a[3] * b[2] + a[4] * b[5] + a[5],
	];
}

export function invertAffine(m: Affine6): Affine6 | null {
	const det = m[0] * m[4] - m[1] * m[3];
	if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
	const i0 = m[4] / det;
	const i1 = -m[1] / det;
	const i3 = -m[3] / det;
	const i4 = m[0] / det;
	return [i0, i1, -(i0 * m[2] + i1 * m[5]), i3, i4, -(i3 * m[2] + i4 * m[5])];
}

const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const deepAnimated = (v: unknown): boolean => {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(deepAnimated);
	const o = v as Record<string, unknown>;
	if (Array.isArray(o.keyframes) && 'value' in o && isAnimated(o as never)) return true;
	return Object.values(o).some(deepAnimated);
};
const deepExpression = (v: unknown): boolean => {
	if (!v || typeof v !== 'object') return false;
	if (Array.isArray(v)) return v.some(deepExpression);
	const o = v as Record<string, unknown>;
	if (hasActiveExpression(o as { expression?: { text: string; enabled: boolean } })) return true;
	return Object.values(o).some(deepExpression);
};

/** Value of a param over the clip: every key's value and the base value (held params have no keys). */
function paramValues(fx: RenderVisualClip['effects'][number], name: string): unknown[] {
	const a = fx.params[name];
	if (!a) return [];
	return [a.value, ...a.keyframes.map((k) => k.value)];
}

/**
 * Why an effect cannot be lowered (null = it can): only Transform and S_Shake without motion blur, RGB split or
 * wrap; no effect masks.
 */
function effectRefusal(fx: RenderVisualClip['effects'][number]): string | null {
	if (fx.masks?.length) return 'effect masks';
	if (fx.effectId === TRANSFORM) return null;
	if (fx.effectId === SHAKE) {
		const all = (n: string, ok: (v: unknown) => boolean) => paramValues(fx, n).every(ok);
		if (!all('motionBlur', (v) => v === false || v === undefined)) return 'S_Shake motion blur';
		for (const w of ['wrapX', 'wrapY']) if (!all(w, (v) => v === 'no')) return 'S_Shake wrap';
		const one = (n: string, d: number) => {
			const vs = paramValues(fx, n);
			return vs.length === 0 ? [d] : vs.map((v) => num(v, d));
		};
		const amps = ['redAmplitude', 'greenAmplitude', 'blueAmplitude'].map((n) => one(n, 1));
		const phases = ['redPhase', 'greenPhase', 'bluePhase'].map((n) => one(n, 0));
		const same = (xs: number[][]) =>
			xs.every((x) => x.length === 1 && x[0] === xs[0]![0] && !Number.isNaN(x[0]!));
		if (!same(amps) || !same(phases)) return 'S_Shake RGB split';
		if (!one('rgbRandomness', 0).every((v) => v === 0)) return 'S_Shake RGB split';
		return null;
	}
	return `effect ${fx.effectId}`;
}

/** True when a Transform effect blurs (Shutter Angle on, not the sequence's shutter) somewhere in the clip. */
function transformBlurs(fx: RenderVisualClip['effects'][number]): boolean {
	if (fx.effectId !== TRANSFORM) return false;
	const useComp = paramValues(fx, 'useCompShutterAngle');
	if (useComp.length > 0 && useComp.every((v) => v === true)) return false;
	if (useComp.length === 0) return false;
	return paramValues(fx, 'shutterAngle').some((v) => num(v, 0) > 0);
}

/**
 * spec 13 AS-070: why a text layer cannot be drawn as a still + native motion (null = it can). The caller checks
 * that its content is static (`isStaticLayer` of the clip without Motion keys and effects) and bakes it.
 */
export function loweredRefusal(c: RenderVisualClip): string | null {
	if (c.kind !== 'text' || !('text' in c.source)) return 'not a text layer';
	if (c.threeD) return '3D layer';
	if (c.masks?.length) return 'masks';
	if (
		deepExpression(c.transform) ||
		deepExpression(c.opacity) ||
		c.effects.some((fx) => deepExpression(fx.params))
	)
		return 'expressions';
	const fxs = c.effects.filter((fx) => fx.enabled);
	for (const fx of fxs) {
		const r = effectRefusal(fx);
		if (r) return r;
	}
	if (fxs.filter(transformBlurs).length > 1) return 'more than one motion-blurred Transform';
	return null;
}

/** True when the clip's picture moves: keyframed Motion / Opacity or a lowered effect (else it is a static still). */
export function loweredMoves(c: RenderVisualClip): boolean {
	return (
		deepAnimated(c.transform) ||
		deepAnimated(c.opacity) ||
		c.effects.some((fx) => fx.enabled && (fx.effectId === SHAKE || deepAnimated(fx.params)))
	);
}

/**
 * True when the text layer's glyphs do not change over its frames: no In/Out animation, no time-varying animator, no
 * keyframes or expressions anywhere in its text source.
 */
export function loweredContentStatic(c: RenderVisualClip): boolean {
	if (!('text' in c.source)) return false;
	const s = c.source;
	if (s.animation?.in || s.animation?.out) return false;
	if (textAnimatorsTimeVarying(s)) return false;
	return !deepAnimated(s) && !deepExpression(s);
}

/** spec 13 AS-070: the layer is drawn as one still + per-frame maps on every path that can (`loweredLayerTaps`). */
export function isLoweredLayer(c: RenderVisualClip): boolean {
	return loweredRefusal(c) === null && loweredMoves(c) && loweredContentStatic(c);
}

/** One tap of a layer-space program: weight, map (layer output px → layer source px) and coverage stages. */
export type LoweredTap = {
	w: number;
	map: Affine6;
	stages: { map: Affine6; rect: [number, number, number, number] }[];
};

/**
 * The taps of a lowered layer at sequence frame `frame` in LAYER space (Motion excluded): `map` sends a point of the
 * layer's output (what Motion places) to the source still's layer px; the first stage of every tap is the effect
 * canvas (when there are GPU effects), then each effect's sample rectangle from the last effect to the first. The
 * output is `Σ w · sample / wsum` (premultiplied). `props` = the layer's props at the frame (`resolveLayerProps`).
 */
export function loweredLayerTaps(o: {
	clip: RenderVisualClip;
	props: ResolvedLayerProps;
	frame: number;
	fps: number;
	registry?: EffectRegistry;
	/** Per-instance `FxParamsAt` cache across frames (sub-frame shutter samples). */
	paramsAtCache?: Map<string, ReturnType<typeof fxParamsAtFn>>;
}): { taps: LoweredTap[]; wsum: number; canvas: [number, number, number, number] | null } {
	const { clip: c, props, fps } = o;
	const registry = o.registry ?? defaultEffectRegistry;
	const lf = o.frame - c.start;
	const box = { width: props.box.width, height: props.box.height };
	const effects = props.effects.filter((fx) => fx.enabled);
	const byId = new Map(c.effects.map((e) => [e.id, e]));
	const cache = o.paramsAtCache ?? new Map();
	const ctxOf = (fx: ResolvedEffect): FxFrameContext => {
		let at = cache.get(fx.id);
		const inst = byId.get(fx.id);
		if (!at && inst) {
			at = fxParamsAtFn(inst, c, fps, undefined, (name) => effectParamMetric(inst, name, c.intrinsicBox));
			cache.set(fx.id, at);
		}
		return {
			width: box.width,
			height: box.height,
			pxScale: 1,
			fps,
			frame: lf,
			duration: c.duration,
			seed: fxSeed(c.clipId, fx.id, fx.params as EffectParams),
			progress: fxClipProgress(lf, c.duration),
			...(at ? { paramsAt: at } : {}),
		};
	};
	// The effect canvas: the box grown by the text's own paint (stroke, shadow, ink: `textContentPad`) and the GPU
	// effects' padding (compositions fx/plan.ts `planLayerFx`, `fxCanvasLayout`).
	const cp = 'text' in c.source ? Math.min(FX_MAX_PADDING, Math.max(0, textContentPad(c.source.text))) : 0;
	let pl = cp;
	let pt = cp;
	let pr = cp;
	let pb = cp;
	let gpu = false;
	for (const fx of effects) {
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec?.gpu) continue;
		gpu = true;
		const p = gpuPadding(spec, fx.params as EffectParams, ctxOf(fx));
		pl += p.left;
		pt += p.top;
		pr += p.right;
		pb += p.bottom;
	}
	const cw = Math.max(1, Math.ceil(box.width + pl + pr));
	const ch = Math.max(1, Math.ceil(box.height + pt + pb));
	if (cw > MAX_CANVAS || ch > MAX_CANVAS)
		throw new Error(`lowered layer ${c.clipId}: effect canvas ${cw}×${ch} exceeds ${MAX_CANVAS} px`);
	const canvas: [number, number, number, number] = [-pl, -pt, cw - pl, ch - pt];
	const id: Affine6 = [1, 0, 0, 0, 1, 0];
	let taps: LoweredTap[] = [{ w: 1, map: id, stages: gpu ? [{ map: id, rect: canvas }] : [] }];
	let wsum = 1;
	for (let i = effects.length - 1; i >= 0; i--) {
		const fx = effects[i]!;
		const spec = registry.get(fx.effectId, fx.effectVersion);
		if (!spec?.gpu?.uniforms) throw new Error(`lowered layer ${c.clipId}: ${fx.effectId} has no uniforms`);
		const u = spec.gpu.uniforms(fx.params as EffectParams, ctxOf(fx)) as Record<string, unknown>;
		if (fx.effectId === TRANSFORM) {
			const poses = transformPoses(u, num(fx.params.opacity, 100));
			if (poses.blurred) wsum = poses.wsum;
			const next: LoweredTap[] = [];
			for (const tap of taps)
				for (const q of poses.list) {
					if (!(q.w > 0)) continue;
					const map = composeAffine(q.inv, tap.map);
					next.push({
						w: tap.w * q.w,
						map,
						// The Transform samples its whole input canvas (the box and the text's paint beyond it).
						stages: [...tap.stages, { map, rect: canvas }],
					});
				}
			taps = next;
		} else if (fx.effectId === SHAKE) {
			const sh = shakeInverse(u, box, num(fx.params.zDist, 1));
			taps = taps.map((tap) => {
				const map = composeAffine(sh, tap.map);
				return { w: tap.w, map, stages: [...tap.stages, { map, rect: canvas }] };
			});
		} else throw new Error(`lowered layer ${c.clipId}: ${fx.effectId} cannot be lowered`);
	}
	return { taps, wsum, canvas: gpu ? canvas : null };
}

/**
 * The Transform effect's inverse maps at a frame from its uniforms: the single map (`u_tfA`, `u_tfT`, × opacity),
 * or with motion blur the shader's taps (`fx_mbTap` at the strata centres through `u_mbWarp`, poses `fx_mbPose`
 * interpolated linearly between the `u_mbKeys`, weight `t.y × clamp(opacity / 100)`).
 */
function transformPoses(
	u: Record<string, unknown>,
	opacityParam: number,
): { list: { inv: Affine6; w: number }[]; blurred: boolean; wsum: number } {
	const plan = (u.u_mbPlan as { ivec4: [number, number, number, number] } | undefined)?.ivec4;
	const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
	if (plan && plan[0] > 1) {
		const n = plan[0];
		const K = Math.max(plan[1], 2);
		const S = Math.max(plan[2], 1);
		const warped = (plan[3] & 2) !== 0;
		const keys = (u.u_mbKeys as { vec4s: number[] }).vec4s;
		const warp = (u.u_mbWarp as { vec4s: number[] }).vec4s;
		const list: { inv: Affine6; w: number }[] = [];
		let wsum = 0;
		for (let i = 0; i < n; i++) {
			const a = (i + 0.5) / n;
			let s = a;
			let wt = 1;
			if (warped) {
				const x = Math.min(1, Math.max(0, a)) * (FX_MB_WARP_SIZE - 1);
				const mI = Math.min(Math.floor(x), FX_MB_WARP_SIZE - 2);
				const t0 = warp[mI]!;
				const t1 = warp[mI + 1]!;
				s = t0 + (t1 - t0) * (x - mI);
				wt = Math.max(t1 - t0, 0) * (FX_MB_WARP_SIZE - 1);
			}
			wsum += wt;
			const uu = Math.min(1, Math.max(0, s)) * (K - 1);
			const k = Math.min(Math.floor(uu), K - 2);
			const fr = uu - k;
			const part = (pi: number, c: number) => {
				const lo = keys[(k * S + pi) * 4 + c]!;
				const hi = keys[((k + 1) * S + pi) * 4 + c]!;
				return lo + (hi - lo) * fr;
			};
			// Pose = (a, b, c, d) (tx, ty, opacity, valid); s = (a·x + c·y + tx, b·x + d·y + ty).
			if (part(1, 3) <= 0.5) continue;
			list.push({
				inv: [part(0, 0), part(0, 2), part(1, 0), part(0, 1), part(0, 3), part(1, 1)],
				w: wt * clamp01(part(1, 2) / 100),
			});
		}
		return { list, blurred: true, wsum: wsum > 0 ? wsum : 1 };
	}
	if (u.u_tfValid === false) return { list: [], blurred: false, wsum: 1 };
	const A = u.u_tfA as number[];
	const T = u.u_tfT as number[];
	return {
		list: [{ inv: [A[0]!, A[2]!, T[0]!, A[1]!, A[3]!, T[1]!], w: clamp01(opacityParam / 100) }],
		blurred: false,
		wsum: 1,
	};
}

/**
 * S_Shake (Wrap No, one channel) as an inverse map in layer px from its `u_shakeNow` pose (dx, dy, cos θ / zoom,
 * sin θ / zoom), frame units of the layer width centred on the box: src = zDist · R⁻¹ · (f − d).
 */
function shakeInverse(
	u: Record<string, unknown>,
	box: { width: number; height: number },
	zDist: number,
): Affine6 {
	const v = (u.u_shakeNow as { vec4s: number[] }).vec4s;
	// The green channel's pose (the single-channel path of `sh_render`).
	const dx = v[4]!;
	const dy = v[5]!;
	const c = v[6]!;
	const s = v[7]!;
	const K = Math.max(1e-3, zDist);
	const bw = box.width;
	const cx = box.width / 2;
	const cy = box.height / 2;
	const ox = -(cx + bw * dx);
	const oy = -(cy + bw * dy);
	return [K * c, K * s, K * (c * ox + s * oy) + cx, -K * s, K * c, K * (-s * ox + c * oy) + cy];
}
