// spec 13 AS-070 / AS-073 — lowered layers: a DOM layer whose content is static but whose picture moves (keyframed
// Motion / Opacity, the Transform effect with or without its Shutter Angle motion blur, S_Shake without motion blur
// or RGB split) is baked ONCE as a still of its layer box (`layer-bake`, recipe `layer-still`) and drawn here frame by
// frame as affine maps of that still, by the multi-tap kernel (kernel.ts `drawTaps`).
//
// The maps are the effects' own: every per-frame value comes from the registered shader's `uniforms` hook (the
// Transform's inverse map and its shutter plan `planMotionBlur`, S_Shake's pose `u_shakeNow` with the seed rules of
// `fxSeed`), evaluated with the same frame context the compositions build (fx/stage.ts: layer box, pxScale 1, fps,
// clip-local frame, `fxParamsAtFn` with the box metric). What the shaders sample is reproduced as coverage stages:
// the Transform samples its input inside the layer box only, S_Shake (Wrap No) samples the effect canvas (box +
// the effects' padding) with an anti-aliased edge, and the last effect's output is the canvas the browser draws
// with the Motion matrix. Motion blur taps are the shader's: tap times through the plan's time warp at the strata
// centres, key poses interpolated linearly, weights `t.y × opacity`, normalised by Σ t.y.
// Differences to the browser's render (documented in docs/wp-notes/auto-subtitles.md): one resample instead of one
// per GPU pass plus the compositor's, the per-pixel jitter of capped shutters is the stratum centre, and the stage
// edges are ½ px ramps instead of the Transform's hard box test.
import {
	clipContentTime,
	defaultEffectRegistry,
	type EffectParams,
	type EffectRegistry,
	effectParamMetric,
	FX_MB_WARP_SIZE,
	type FxFrameContext,
	fxClipProgress,
	fxParamsAtFn,
	fxSeed,
	gpuPadding,
	hasActiveExpression,
	isAnimated,
	type Rational,
	type RenderVisualClip,
	type ResolvedEffect,
	resolveLayerProps,
} from '@jasper/project';

/** Effects drawn by the lowered path (everything else keeps the layer's bake). */
const TRANSFORM = 'jasper.transform';
const SHAKE = 'jasper.s.shake';
/** Largest effect canvas side the lowered path accepts (the compositions draw larger canvases downscaled). */
const MAX_CANVAS = 4096;

/** An affine map `[m0…m5]`: u = m0·x + m1·y + m2, v = m3·x + m4·y + m5. */
export type Affine = [number, number, number, number, number, number];

const compose = (a: Affine, b: Affine): Affine => [
	a[0] * b[0] + a[1] * b[3],
	a[0] * b[1] + a[1] * b[4],
	a[0] * b[2] + a[1] * b[5] + a[2],
	a[3] * b[0] + a[4] * b[3],
	a[3] * b[1] + a[4] * b[4],
	a[3] * b[2] + a[4] * b[5] + a[5],
];

export function invertAffine(m: Affine): Affine | null {
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

/** The region of the layer (layer px) the still covers: the box grown by the content bleed, whole pixels. */
export type LoweredPicture = { x: number; y: number; w: number; h: number };

/** One output frame of a kernel-drawn member, in sequence pixels. */
export type TapFrame = {
	/** Drawn rectangle `[x0, y0, x1)` (sequence px, integers), null = nothing drawn. */
	rect: [number, number, number, number] | null;
	opacity: number;
	/** Picture (mip level) the taps sample. */
	level: number;
	/** `drawTaps` program with maps from sequence px to the level's picture px. */
	prog: number[];
};

/** A frame program of one tap without stages (what `drawLayer` draws). */
export function singleTap(inv: Affine, clip: readonly number[], weight = 1): number[] {
	return [1, weight, weight, ...inv, clip[0]!, clip[1]!, clip[2]!, clip[3]!, 0];
}

/** Translates a program's maps: output px → output px + (dx, dy) (a frame drawn into a larger canvas at an offset). */
export function shiftProgram(prog: readonly number[], dx: number, dy: number): number[] {
	const out = prog.slice();
	const n = out[0]! | 0;
	let p = 2;
	const shift = (q: number) => {
		// u(x + dx, y + dy) = m0·x + m1·y + (m0·dx + m1·dy + m2)
		out[q + 2] = out[q]! * dx + out[q + 1]! * dy + out[q + 2]!;
		out[q + 5] = out[q + 3]! * dx + out[q + 4]! * dy + out[q + 5]!;
	};
	for (let t = 0; t < n; t++) {
		shift(p + 1);
		p += 11;
		const ns = out[p - 1]! | 0;
		for (let s = 0; s < ns; s++) shift(p + s * 10);
		p += ns * 10;
	}
	return out;
}

type Stage = { map: Affine; rect: [number, number, number, number] };
type Tap = { w: number; map: Affine; stages: Stage[] };

const mipLevel = (s: number) => (s >= 0.5 || s <= 0 ? 0 : Math.min(12, Math.floor(Math.log2(1 / s) + 1e-9)));

/**
 * The frame programs of a lowered layer over `[f0, f1)`: Motion (layer map), the lowered effects in stack order and
 * the picture (`picture`, layer px; its mip levels follow the Motion scale like the sub-pixel kernel's). The layer
 * box is the clip's resolved box; the still is `picture.w × picture.h` px at 1 px per layer px.
 */
export function planLoweredFrames(o: {
	clip: RenderVisualClip;
	f0: number;
	f1: number;
	fps: Rational;
	picture: LoweredPicture;
	W: number;
	H: number;
	registry?: EffectRegistry;
}): { frames: TapFrame[]; levels: { w: number; h: number }[] } {
	const { clip: c, picture: pic } = o;
	const registry = o.registry ?? defaultEffectRegistry;
	const fpsN = o.fps.num / o.fps.den;
	const byId = new Map(c.effects.map((e) => [e.id, e]));
	const paramsAt = new Map<string, ReturnType<typeof fxParamsAtFn>>();
	const levels: { w: number; h: number }[] = [];
	const levelIndex = new Map<number, number>();
	const levelOf = (L: number) => {
		let i = levelIndex.get(L);
		if (i === undefined) {
			i = levels.length;
			levelIndex.set(L, i);
			levels.push({ w: Math.max(1, Math.round(pic.w / 2 ** L)), h: Math.max(1, Math.round(pic.h / 2 ** L)) });
		}
		return i;
	};
	const frames: TapFrame[] = [];
	for (let f = o.f0; f < o.f1; f++) {
		const t = clipContentTime(c, f, o.fps);
		const props = resolveLayerProps(c, t);
		const lf = f - c.start;
		const box = { width: props.box.width, height: props.box.height };
		const m = props.matrix;
		const motion = invertAffine([m.a, m.c, m.e, m.b, m.d, m.f]);
		const opacity = Math.min(1, Math.max(0, props.opacity / 100));
		if (!motion || !(opacity > 0)) {
			frames.push({ rect: null, opacity: 0, level: levelOf(0), prog: [0, 1] });
			continue;
		}
		const effects = props.effects.filter((fx) => fx.enabled);
		const ctxOf = (fx: ResolvedEffect): FxFrameContext => {
			let at = paramsAt.get(fx.id);
			const inst = byId.get(fx.id);
			if (!at && inst) {
				at = fxParamsAtFn(inst, c, fpsN, undefined, (name) => effectParamMetric(inst, name, c.intrinsicBox));
				paramsAt.set(fx.id, at);
			}
			return {
				width: box.width,
				height: box.height,
				pxScale: 1,
				fps: fpsN,
				frame: lf,
				duration: c.duration,
				seed: fxSeed(c.clipId, fx.id, fx.params as EffectParams),
				progress: fxClipProgress(lf, c.duration),
				...(at ? { paramsAt: at } : {}),
			};
		};
		// The effect canvas: the box grown by the GPU effects' padding (fx/plan.ts `fxCanvasLayout`).
		let pl = 0;
		let pt = 0;
		let pr = 0;
		let pb = 0;
		for (const fx of effects) {
			const spec = registry.get(fx.effectId, fx.effectVersion);
			if (!spec?.gpu) continue;
			const p = gpuPadding(spec, fx.params as EffectParams, ctxOf(fx));
			pl += p.left;
			pt += p.top;
			pr += p.right;
			pb += p.bottom;
		}
		const cw = Math.max(1, Math.ceil(box.width + pl + pr));
		const chh = Math.max(1, Math.ceil(box.height + pt + pb));
		if (cw > MAX_CANVAS || chh > MAX_CANVAS)
			throw new Error(`lowered layer ${c.clipId}: effect canvas ${cw}×${chh} exceeds ${MAX_CANVAS} px`);
		const canvas: [number, number, number, number] = [-pl, -pt, cw - pl, chh - pt];
		const gpu = effects.some((fx) => !!registry.get(fx.effectId, fx.effectVersion)?.gpu);
		let taps: Tap[] = [{ w: 1, map: motion, stages: gpu ? [{ map: motion, rect: canvas }] : [] }];
		let wsum = 1;
		for (let i = effects.length - 1; i >= 0; i--) {
			const fx = effects[i]!;
			const spec = registry.get(fx.effectId, fx.effectVersion);
			if (!spec?.gpu?.uniforms) throw new Error(`lowered layer ${c.clipId}: ${fx.effectId} has no uniforms`);
			const u = spec.gpu.uniforms(fx.params as EffectParams, ctxOf(fx)) as Record<string, unknown>;
			if (fx.effectId === TRANSFORM) {
				const poses = transformPoses(u, num(fx.params.opacity, 100));
				if (poses.blurred) wsum = poses.wsum;
				const next: Tap[] = [];
				for (const tap of taps)
					for (const q of poses.list) {
						if (!(q.w > 0)) continue;
						const map = compose(q.inv, tap.map);
						next.push({
							w: tap.w * q.w,
							map,
							stages: [...tap.stages, { map, rect: [0, 0, box.width, box.height] }],
						});
					}
				taps = next;
			} else if (fx.effectId === SHAKE) {
				const sh = shakeInverse(u, box, num(fx.params.zDist, 1));
				taps = taps.map((tap) => {
					const map = compose(sh, tap.map);
					return { w: tap.w, map, stages: [...tap.stages, { map, rect: canvas }] };
				});
			} else throw new Error(`lowered layer ${c.clipId}: ${fx.effectId} cannot be lowered`);
		}
		// Mip level from the Motion scale (layer px → sequence px), as the sub-pixel kernel picks it.
		const sx = Math.hypot(m.a, m.b);
		const sy = Math.hypot(m.c, m.d);
		const L = Math.min(mipLevel(sx), mipLevel(sy));
		const li = levelOf(L);
		const lv = levels[li]!;
		const kx = lv.w / pic.w;
		const ky = lv.h / pic.h;
		const toPicture: Affine = [kx, 0, -pic.x * kx, 0, ky, -pic.y * ky];
		const prog: number[] = [taps.length, wsum];
		let x0 = Number.POSITIVE_INFINITY;
		let y0 = Number.POSITIVE_INFINITY;
		let x1 = Number.NEGATIVE_INFINITY;
		let y1 = Number.NEGATIVE_INFINITY;
		for (const tap of taps) {
			const map = compose(toPicture, tap.map);
			prog.push(tap.w, ...map, 0, 0, lv.w, lv.h, tap.stages.length);
			for (const s of tap.stages) prog.push(...s.map, ...s.rect);
			// Bounds: the picture through the inverse of the tap's map.
			const fwd = invertAffine(map);
			if (!fwd) continue;
			for (const [u, v] of [
				[0, 0],
				[lv.w, 0],
				[lv.w, lv.h],
				[0, lv.h],
			] as const) {
				const x = fwd[0] * u + fwd[1] * v + fwd[2];
				const y = fwd[3] * u + fwd[4] * v + fwd[5];
				x0 = Math.min(x0, x);
				y0 = Math.min(y0, y);
				x1 = Math.max(x1, x);
				y1 = Math.max(y1, y);
			}
		}
		const rx0 = Math.max(0, Math.floor(x0) - 1);
		const ry0 = Math.max(0, Math.floor(y0) - 1);
		const rx1 = Math.min(o.W, Math.ceil(x1) + 1);
		const ry1 = Math.min(o.H, Math.ceil(y1) + 1);
		const visible = Number.isFinite(x0) && rx1 > rx0 && ry1 > ry0 && taps.length > 0;
		frames.push(
			visible
				? { rect: [rx0, ry0, rx1, ry1], opacity, level: li, prog }
				: { rect: null, opacity: 0, level: li, prog: [0, 1] },
		);
	}
	return { frames, levels };
}

/**
 * The Transform effect's inverse maps at a frame from its uniforms: the single map (`u_tfA`, `u_tfT`, × opacity),
 * or with motion blur the shader's taps (`fx_mbTap` at the strata centres through `u_mbWarp`, poses `fx_mbPose`
 * interpolated linearly between the `u_mbKeys`, weight `t.y × clamp(opacity / 100)`).
 */
function transformPoses(
	u: Record<string, unknown>,
	opacityParam: number,
): { list: { inv: Affine; w: number }[]; blurred: boolean; wsum: number } {
	const plan = (u.u_mbPlan as { ivec4: [number, number, number, number] } | undefined)?.ivec4;
	const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
	if (plan && plan[0] > 1) {
		const n = plan[0];
		const K = Math.max(plan[1], 2);
		const S = Math.max(plan[2], 1);
		const warped = (plan[3] & 2) !== 0;
		const keys = (u.u_mbKeys as { vec4s: number[] }).vec4s;
		const warp = (u.u_mbWarp as { vec4s: number[] }).vec4s;
		const list: { inv: Affine; w: number }[] = [];
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
): Affine {
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
