// The checks of the `mergeDips` properties (wp-note "Phase 4 → WP4.2a" and its verification's "bug 2"), shared by the
// properties in sound-mix.test.ts / sound-p4v-mix.test.ts and the targeted hunt in sound-mix-dips-hunt.test.ts.
import { expect } from 'vitest';
import {
	type Animatable,
	clipLaneTime,
	type Dip,
	dipEnvelopeAt,
	evaluate,
	FLICKS_PER_SECOND,
	type Keyframe,
	type LaneTime,
	mergeDips,
	SEQUENCE_LANE,
	unwriteCurve,
} from '../src/index.ts';

const S = FLICKS_PER_SECOND;
const MS = S / 1000;

// The per-sample checks call `expect` only when they fail (same matcher, same message): ≈ 10× faster, for the hunt's
// millions of runs.
const le = (a: number, b: number) => {
	if (!(a <= b)) expect(a).toBeLessThanOrEqual(b);
};
const close = (a: number, b: number, digits: number) => {
	if (!(Math.abs(a - b) < 10 ** -digits / 2)) expect(a).toBeCloseTo(b, digits);
};

/** The identity lane the linear property uses (a track lane spanning everything). */
export const IDENTITY_LANE: LaneTime = {
	toLane: (t: number) => t,
	toSeq: (t: number) => t,
	span: [0, Number.POSITIVE_INFINITY],
};

/** The lanes of the curved property: the sequence lane and a reversed clip at 2× speed. */
export const CURVED_LANES = [
	{ name: 'sequence', lane: SEQUENCE_LANE, timeScale: 1 },
	{
		name: 'clip ×2 reversed',
		lane: clipLaneTime(
			{ start: 0, duration: 30 * 30, sourceIn: 0, speed: { rate: 2, reverse: true } },
			{ num: 30, den: 1 },
		),
		timeScale: 2,
	},
] as const;

/**
 * Linear / hold lanes: result = min(existing, dip) inside the windows, identical outside, keys outside kept, unwrite
 * restores. `samples` / `step`: the test times are k · step (k = 0…samples).
 */
export function checkLinearDips(
	kfs: Keyframe<number>[],
	value: number,
	dips: Dip[],
	opts: { lane?: LaneTime; samples?: number; step?: number } = {},
): void {
	const lane = opts.lane ?? IDENTITY_LANE;
	const samples = opts.samples ?? 400;
	const step = opts.step ?? 11 * MS;
	const anim: Animatable<number> = { value, keyframes: kfs };
	let i = 0;
	const r = mergeDips(anim, lane, dips, { newId: () => `new_${i++}`, clamp: [-96, 15] });
	if (!r) return;
	const res: Animatable<number> = { value, keyframes: r.keyframes };
	const inWin = (t: number) => r.windows.some(([a, b]) => t >= a && t <= b);
	for (let k = 0; k <= samples; k++) {
		const t = k * step;
		const e = evaluate(anim, t);
		const got = evaluate(res, t);
		le(got, e + 1e-3);
		if (!inWin(t)) close(got, e, 6);
		else {
			// ≤ the dip curve relative to the window's reference level, = the minimum of both
			const w = r.windows.find(([a, b]) => t >= a && t <= b)!;
			const ref = Math.max(evaluate(anim, w[0]), evaluate(anim, w[1]));
			const dd = Math.max(-96, ref + dipEnvelopeAt(dips, t));
			// a hold step between two samples is drawn as a 1-flick ramp: skip its instant
			const stepAt = kfs.some(
				(kf, j) => j > 0 && kfs[j - 1]!.interpolation === 'hold' && Math.abs(kf.time - t) <= 2,
			);
			if (!stepAt) close(got, Math.min(e, dd), 2);
			le(got, dd + 1e-3);
		}
	}
	// keys outside the windows are untouched
	for (const k of kfs)
		if (!r.windows.some(([a, b]) => k.time >= Math.round(a) && k.time <= Math.round(b)))
			expect(r.keyframes).toContainEqual(k);
	// unwriting gives the original keys back
	const back = unwriteCurve(r.keyframes, r);
	expect(back.exact).toBe(true);
	expect(back.keyframes).toEqual(kfs);
}

/**
 * Any interpolation (Bézier, auto-Bézier, continuous Bézier too) on the sequence lane or a reversed 2× clip: outside
 * the dips the curve is kept (to 0.05 dB on rebuilt curves), inside = min(curve, dip), keys outside kept, exact
 * unwrite. Returns the largest deviation of a rebuilt curve outside the dips.
 */
export function checkCurvedDips(
	kfs: Keyframe<number>[],
	dips: Dip[],
	li: 0 | 1,
	value = -3,
	/**
	 * Straight lanes' tolerance (dB). 1e-5 for dips on whole flicks; dips between flicks are drawn with keys on whole
	 * lane flicks (≤ half a lane flick off: ≤ 60 dB/ms × 0.5 flick ≈ 4.3e-5 dB on the steepest 1 ms fade).
	 */
	straightTol = 1e-5,
): number {
	let maxCurved = 0;
	const { lane } = CURVED_LANES[li];
	const anim: Animatable<number> = { value, keyframes: kfs };
	let i = 0;
	const r = mergeDips(anim, lane, dips, { newId: () => `new_${i++}`, clamp: [-96, 15] });
	if (!r) return 0;
	const res: Animatable<number> = { value, keyframes: r.keyframes };
	const E = (t: number) => evaluate(anim, lane.toLane(t));
	const G = (t: number) => evaluate(res, lane.toLane(t));
	// the un-widened dip windows (as mergeDips merges them) and their reference levels
	// (sorted by window start: dips with longer fades start earlier than their start — sorting by dip start
	// merged [1299, 1301] ms with [917, 1703] ms into [1299, 1703] ms, seed 2097034364)
	const w0: [number, number][] = [];
	const ws = dips
		// a dip of no depth is no dip (WP6.5b)
		.filter((d) => d.depthDb < 0)
		.map((d): [number, number] => {
			const f = Math.max(1, d.fadeMs) * MS;
			return [Math.max(lane.span[0], d.start - f), Math.min(lane.span[1], d.end + f)];
		})
		.filter((w) => w[1] > w[0])
		.sort((a, b) => a[0] - b[0]);
	for (const w of ws) {
		const last = w0[w0.length - 1];
		if (last && w[0] <= last[1]) last[1] = Math.max(last[1], w[1]);
		else w0.push([w[0], w[1]]);
	}
	// keyframe-sides: a Linear key into an eased incoming side curves too.
	const curved =
		kfs.some((k) => k.interpolation !== 'linear' && k.interpolation !== 'hold') ||
		kfs.some(
			(k, j) =>
				j > 0 &&
				kfs[j - 1]!.interpolation !== 'hold' &&
				k.inInterpolation !== undefined &&
				k.inInterpolation !== 'linear',
		);
	// rebuilt curves: within sampling (1 ms samples at most 0.001 dB off; steeper bends a little more);
	// straight ones: exact (to rounding)
	const tolOut = curved ? 0.05 : 1e-6;
	const tol = curved ? 0.05 : straightTol;
	const nearStep = (t: number) => kfs.some((kf, j) => j > 0 && Math.abs(lane.toSeq(kf.time) - t) <= 3);
	const end = Math.min(lane.span[1], 4.5 * S);
	for (let k = 0; k <= 300; k++) {
		const t = (k / 300) * end;
		if (nearStep(t)) continue;
		const e = E(t);
		const got = G(t);
		le(got, e + tol);
		const env = dipEnvelopeAt(dips, t);
		// strictly inside a window the dip curve holds also where the envelope touches 0 (one dip's fade ending as the
		// next one's begins)
		if (env === 0 && !w0.some(([a, b]) => t > a && t < b)) {
			le(Math.abs(got - e), tolOut);
			maxCurved = curved ? Math.max(maxCurved, Math.abs(got - e)) : maxCurved;
			continue;
		}
		const w = w0.find(([a, b]) => t >= a && t <= b);
		if (!w) continue;
		const ref = Math.max(E(w[0]), E(w[1]));
		// the dip curve stops at the floor (−96 dB), it is not capped at the top (WP6.5b: the result never exceeds the curve)
		le(Math.abs(got - Math.min(e, Math.max(-96, ref + env))), tol);
	}
	// keys outside the rewritten ranges are the same keys
	for (const k of kfs) {
		const ts = lane.toSeq(k.time);
		if (!r.windows.some(([a, b]) => ts >= a - 1 && ts <= b + 1)) expect(r.keyframes).toContainEqual(k);
	}
	const back = unwriteCurve(r.keyframes, r);
	expect(back.exact).toBe(true);
	expect(back.keyframes).toEqual(kfs);
	return maxCurved;
}

/** Keys from generated `{time, value, interpolation, …}` records: the first key at a time wins, sorted by time. */
export function keysOf(
	keys: readonly {
		time: number;
		v: number;
		interp: Keyframe<number>['interpolation'];
		inf?: number;
		slope?: number;
	}[],
): Keyframe<number>[] {
	const seen = new Set<number>();
	const kfs: Keyframe<number>[] = [];
	for (const k of keys) {
		if (seen.has(k.time)) continue;
		seen.add(k.time);
		const curved = k.inf !== undefined;
		kfs.push({
			id: `kf_${kfs.length}`,
			time: k.time,
			value: k.v,
			interpolation: k.interp,
			easeIn: curved ? { influence: k.inf!, slope: k.slope ?? 0 } : { influence: 1, slope: 1 },
			easeOut: curved ? { influence: 1 - k.inf!, slope: k.slope ?? 0 } : { influence: 1, slope: 1 },
		});
	}
	return kfs.sort((a, b) => a.time - b.time);
}
