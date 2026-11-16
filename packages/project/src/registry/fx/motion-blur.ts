// Adaptive shutter motion blur: the TypeScript half of the framework helper shared by effects and
// transitions (GLSL half: ./glsl/motion-blur.ts; guide: docs/wp-notes/fx-shader-framework.md §19). Pure: no DOM, no GL.
//
// The model (Premiere / Sapphire): a box shutter over an interval of the frame (Shutter Angle / 360 or Mo Blur Length
// frames, centred, optionally shifted). `planMotionBlur` evaluates the effect's pose at exact sub-frame times (32 key
// poses over the shutter, from `ctx.paramsAt` or the effect's own pose function), measures how far the
// layer box corners and centre travel along that path in pass pixels (so rotation and zoom count, and the preview
// scale reduces the taps proportionally), and plans the taps: one every ~1 px up to a cap, stratified with a
// deterministic per-pixel jitter when capped. The shader interpolates the key poses linearly (`fx_mbPose`: 31
// segments per shutter keep curved and rotating paths well under a pixel from the true path, at half the cost of a
// spline on SwiftShader) and takes its taps through a time warp (`fx_mbTap`) that spreads them over time AND path length, so a
// fast burst inside the shutter (a Jumpy shake jump, a keyframe ease) stays a continuous smear; the per-tap weights
// bring the exposure back to a box shutter.
import type { ParamValue } from '../../schema/common.ts';
import type { ParamSpec } from '../effects.ts';
import { FX_MB_MAX_TAPS, FX_MB_SPACING, FX_MB_TAP_LIMIT, FX_MB_WARP_SIZE } from './glsl/motion-blur.ts';
import { fxParam } from './params.ts';

/** Key poses over the shutter (first = shutter open, last = shutter close), linearly interpolated by the shader. */
export const FX_MB_KEYS = 32;
/** Share of the tap placement that follows time (the rest follows the path length). */
export const FX_MB_TIME_SHARE = 0.25;

/** Quality presets of the "Mo Blur Quality" param (Auto = the default; Draft for heavy previews). */
export const MB_QUALITY_OPTIONS = ['auto', 'draft', 'high'] as const;
export type MbQuality = (typeof MB_QUALITY_OPTIONS)[number];
const QUALITY: Record<MbQuality, { spacing: number; max: number }> = {
	auto: { spacing: FX_MB_SPACING, max: FX_MB_MAX_TAPS },
	draft: { spacing: 2.5, max: 16 },
	high: { spacing: FX_MB_SPACING, max: FX_MB_TAP_LIMIT },
};

/** The advanced "Mo Blur Quality" popup (Auto / Draft / High; hold-only). Missing in old documents = Auto. */
export function mbQualityParam(name = 'mbQuality', label = 'Mo Blur Quality'): ParamSpec {
	return fxParam.choice(name, label, MB_QUALITY_OPTIONS, ['Auto', 'Draft', 'High'], 'auto', {
		group: 'Advanced',
	});
}

/** Tap spacing (pass px) and cap of a quality value (unknown → Auto). */
export function mbQuality(q: ParamValue | undefined): { spacing: number; max: number } {
	return QUALITY[(typeof q === 'string' && q in QUALITY ? q : 'auto') as MbQuality];
}

/** A shutter interval in frames relative to the frame being drawn. */
export type ShutterWindow = { start: number; end: number };

/**
 * A shutter of `length` frames centred on the frame (Sapphire's Mo Blur Length, Premiere's Shutter Angle / 360),
 * moved by `shift` frames (Sapphire's Shutter Shift). Negative lengths count as 0.
 */
export function centredShutter(length: number, shift = 0): ShutterWindow {
	const l = Number.isFinite(length) ? Math.max(0, length) : 0;
	const s = Number.isFinite(shift) ? shift : 0;
	return { start: s - l / 2, end: s + l / 2 };
}

/**
 * A shutter from an angle and a phase in degrees (After Effects' convention: the shutter opens `phase` degrees after
 * the frame time; the default phase −angle/2 centres it, which is Premiere's Transform behaviour).
 */
export function angleShutter(angleDeg: number, phaseDeg = -angleDeg / 2): ShutterWindow {
	const a = Math.min(720, Math.max(0, Number.isFinite(angleDeg) ? angleDeg : 0)) / 360;
	const ph = (Number.isFinite(phaseDeg) ? phaseDeg : -angleDeg / 2) / 360;
	return { start: ph + 0, end: ph + a + 0 };
}

/** Taps for an on-screen smear of `extentPx` pass pixels: ≤ `spacing` px apart, 1 … `max`. */
export function mbTapCount(extentPx: number, opts: { spacing?: number; max?: number } = {}): number {
	const spacing = Math.max(1e-3, opts.spacing ?? FX_MB_SPACING);
	const max = Math.min(FX_MB_TAP_LIMIT, Math.max(1, Math.floor(opts.max ?? FX_MB_MAX_TAPS)));
	if (!(extentPx > 0)) return 1;
	return Math.min(max, Math.max(1, Math.ceil(extentPx / spacing - 1e-9)));
}

type Pt = readonly [number, number];

/**
 * Path length (px) of every tracked point over a sequence of poses, per segment: `segments[k]` = the longest move of
 * any point between pose k and k + 1; `total` = their sum (an upper bound of the longest single path).
 */
export function poseTrackLengths(points: readonly (readonly Pt[])[]): { segments: number[]; total: number } {
	const segments: number[] = [];
	for (let k = 0; k + 1 < points.length; k++) {
		const a = points[k]!;
		const b = points[k + 1]!;
		let m = 0;
		for (let i = 0; i < Math.min(a.length, b.length); i++) {
			const d = Math.hypot(b[i]![0] - a[i]![0], b[i]![1] - a[i]![1]);
			if (Number.isFinite(d)) m = Math.max(m, d);
		}
		segments.push(m);
	}
	return { segments, total: segments.reduce((s, x) => s + x, 0) };
}

/**
 * The time warp of the taps (FX_MB_WARP_SIZE entries, shutter time s at uniform steps of the tap fraction): taps are
 * placed by the measure c(s) = timeShare · s + (1 − timeShare) · pathLength(s) / total, so a key segment gets taps in
 * proportion to both the time it lasts and the distance it covers. Null when the motion has a constant speed (the
 * warp is the identity: plain stratified times, all weights 1).
 */
export function mbTimeWarp(segments: readonly number[], timeShare = FX_MB_TIME_SHARE): number[] | null {
	const n = segments.length;
	const total = segments.reduce((s, x) => s + x, 0);
	if (n < 1 || !(total > 0)) return null;
	const mean = total / n;
	if (segments.every((x) => Math.abs(x - mean) <= 0.02 * mean)) return null;
	const a = Math.min(1, Math.max(0.05, timeShare));
	// Cumulative measure at the key times k / n.
	const c = [0];
	for (let k = 0; k < n; k++) c.push(c[k]! + (a + (1 - a) * (segments[k]! / total) * n) / n);
	const last = c[n]!;
	const out: number[] = [];
	let k = 0;
	for (let m = 0; m < FX_MB_WARP_SIZE; m++) {
		const target = (m / (FX_MB_WARP_SIZE - 1)) * last;
		while (k < n - 1 && c[k + 1]! < target) k++;
		const span = c[k + 1]! - c[k]!;
		const u = span > 0 ? Math.min(1, Math.max(0, (target - c[k]!) / span)) : 0;
		out.push((k + u) / n);
	}
	out[0] = 0;
	out[FX_MB_WARP_SIZE - 1] = 1;
	return out;
}

export type MbPlanOptions<P> = {
	/** Clip-local frame being drawn. */
	frame: number;
	/** Shutter interval relative to the frame (`centredShutter`, `angleShutter`). */
	window: ShutterWindow;
	/** The pose at an exact (sub-)frame time. */
	poseAt: (frame: number) => P;
	/** Tracked positions of a pose in PASS pixels (layer box corners and centre, …), same count for every pose. */
	points: (pose: P) => readonly Pt[];
	/** The pose as `stride` vec4s (4 · stride numbers) for `u_mbKeys`. */
	pack: (pose: P) => readonly number[];
	/** vec4s per pose (fixed per effect: the uniform's length must not change between frames). */
	stride: number;
	/** Quality param value (`mbQualityParam`); default Auto. */
	quality?: ParamValue;
};

export type MbPlan = {
	/** Taps per pixel (1 = no blur: draw the single, unblurred pose). */
	taps: number;
	/** Key poses (FX_MB_KEYS when blurring, else 0). */
	keys: number;
	stride: number;
	/** Longest path of a tracked point over the shutter (pass px). */
	extentPx: number;
	/** Jitter the strata (the taps are sparser than the spacing). */
	jitter: boolean;
	/** `u_mbKeys`: FX_MB_KEYS × stride vec4s. */
	packed: number[];
	/** `u_mbWarp` values (FX_MB_WARP_SIZE), or null = identity. */
	warp: number[] | null;
	/** Shutter times (clip-local frames) of the FX_MB_KEYS key poses (empty without blur). */
	times: number[];
};

/** The plan of "no blur" (taps 1) with zero-filled arrays of the right size. */
export function mbStaticPlan(stride: number): MbPlan {
	return {
		taps: 1,
		keys: 0,
		stride,
		extentPx: 0,
		jitter: false,
		packed: new Array<number>(FX_MB_KEYS * stride * 4).fill(0),
		warp: null,
		times: [],
	};
}

/** Clip-local frames of the key poses of a shutter: FX_MB_KEYS evenly over the interval, both ends included. */
export function mbKeyTimes(frame: number, w: ShutterWindow, keys = FX_MB_KEYS): number[] {
	const dt = (w.end - w.start) / (keys - 1);
	return Array.from({ length: keys }, (_, i) => frame + w.start + i * dt);
}

/**
 * Plans the shutter of one frame: key poses at exact sub-frame times, the travel of the tracked points, the tap count
 * and the time warp. No motion (identical packed poses, or a travel below 1/1000 px), an empty shutter or a quality
 * that allows one tap → `taps: 1` (draw the unblurred path: exactly the output without motion blur).
 */
export function planMotionBlur<P>(o: MbPlanOptions<P>): MbPlan {
	const stride = Math.max(1, Math.floor(o.stride));
	const len = o.window.end - o.window.start;
	if (!(len > 0) || !Number.isFinite(o.frame)) return mbStaticPlan(stride);
	const times = mbKeyTimes(o.frame, o.window);
	const poses = times.map((t) => o.poseAt(t));
	const packs = poses.map((q) => {
		const v = o.pack(q);
		if (v.length !== stride * 4)
			throw new Error(`motion blur: a pose packs ${v.length} numbers, not ${stride * 4}`);
		return v;
	});
	if (packs.every((v) => v.every((x, i) => x === packs[0]![i]))) return mbStaticPlan(stride);
	const { segments, total } = poseTrackLengths(poses.map((q) => o.points(q)));
	if (!(total > 1e-3)) return mbStaticPlan(stride);
	const q = mbQuality(o.quality);
	const taps = mbTapCount(total, q);
	if (taps <= 1) return mbStaticPlan(stride);
	const warp = mbTimeWarp(segments);
	return {
		taps,
		keys: FX_MB_KEYS,
		stride,
		extentPx: total,
		jitter: total / taps > q.spacing * 1.01 || warp !== null,
		packed: packs.flatMap((v) => v.map((x) => (Number.isFinite(x) ? x : 0))),
		warp,
		times,
	};
}

/** The uniforms of a plan for `GLSL_MB_POSES`: `u_mbPlan` (ivec4), `u_mbKeys`, `u_mbWarp` (fixed sizes). */
export function mbUniforms(plan: MbPlan): {
	u_mbPlan: { ivec4: [number, number, number, number] };
	u_mbKeys: { vec4s: number[] };
	u_mbWarp: { vec4s: number[] };
} {
	const warp = plan.warp ?? Array.from({ length: FX_MB_WARP_SIZE }, (_, m) => m / (FX_MB_WARP_SIZE - 1));
	return {
		u_mbPlan: {
			ivec4: [plan.taps, plan.keys, plan.stride, (plan.jitter ? 1 : 0) | (plan.warp ? 2 : 0)],
		},
		u_mbKeys: { vec4s: plan.packed },
		u_mbWarp: { vec4s: warp },
	};
}

// CPU taps of a plan, the same arithmetic as `GLSL_MB_POSES` (`fx_mbTap`, `fx_mbPose`, `fx_mbJitter`), for renderers
// that draw a planned shutter without WebGL (the native export's kernels, the lowered layers). Each function is
// self-contained (no imports, no module scope): the native kernels inline their source text into worker threads.

/**
 * Shutter time s (0..1 over the interval) and box-shutter weight of tap `i` of `n`, stratified with offset `j`
 * (0.5 = the stratum centre), through the plan's time warp (`warp`: `MbPlan.warp`, null = identity): `out[0]` = s,
 * `out[1]` = weight. GLSL `fx_mbTap`.
 */
export function mbTapTime(
	i: number,
	n: number,
	j: number,
	warp: ArrayLike<number> | null,
	out: { 0: number; 1: number },
): void {
	const a = (i + j) / n;
	if (!warp) {
		out[0] = a;
		out[1] = 1;
		return;
	}
	const last = warp.length - 1;
	const x = Math.min(1, Math.max(0, a)) * last;
	const m = Math.min(Math.floor(x), last - 1);
	const t0 = warp[m]!;
	const t1 = warp[m + 1]!;
	out[0] = t0 + (t1 - t0) * (x - m);
	out[1] = Math.max(t1 - t0, 0) * last;
}

/**
 * The pose at shutter time `s`: the `stride` vec4s linearly interpolated between the plan's key poses (`packed`,
 * `keys` × `stride` vec4s), written to `out` (4 · stride numbers). GLSL `fx_mbPose` for every part.
 */
export function mbPoseAt(
	packed: ArrayLike<number>,
	keys: number,
	stride: number,
	s: number,
	out: { [i: number]: number },
): void {
	const K = Math.max(keys, 2);
	const S = Math.max(stride, 1);
	const u = Math.min(1, Math.max(0, s)) * (K - 1);
	const k = Math.min(Math.floor(u), K - 2);
	const f = u - k;
	const a = k * S * 4;
	const b = (k + 1) * S * 4;
	for (let c = 0; c < S * 4; c++) {
		const lo = packed[a + c]!;
		out[c] = lo + (packed[b + c]! - lo) * f;
	}
}

/**
 * The per-pixel stratum offset of a jittered plan at pass pixel (x, y) (integers, top-left origin) — GLSL
 * `fx_mbJitter` bit for bit; `seedHash` = `mbSeedHash(u_seed)`.
 */
export function mbJitter(x: number, y: number, seedHash: number): number {
	const h = (Math.imul(x, 3242174889 | 0) + Math.imul(y, 2447445414 | 0) + seedHash) >>> 0;
	return (h >>> 8) * (1 / 16777216);
}

/** The seed term of `fx_mbJitter`: `fx_pcg(fx_seedBits(seed) ^ 0x5bd1e995u)` with `fx_seedBits`' float32 product. */
export function mbSeedHash(seed: number): number {
	const s = Math.min(1, Math.max(0, Math.fround(Number.isFinite(seed) ? seed : 0)));
	const v = (Math.floor(Math.fround(s * 4294967040)) ^ 0x5bd1e995) >>> 0;
	const state = (Math.imul(v, 747796405) + 2891336453) >>> 0;
	const word = Math.imul(((state >>> ((state >>> 28) + 4)) ^ state) >>> 0, 277803737) >>> 0;
	return ((word >>> 22) ^ word) >>> 0;
}
