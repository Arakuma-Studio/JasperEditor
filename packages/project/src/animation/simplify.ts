// Keyframe simplification (S09:TRK-023 "Simplify keyframes", S01:KF-010): reduces dense keyframes (per-frame
// tracking output, recorded animation) to a minimal subset whose evaluated animation stays within a tolerance of
// the original at every sample time (the frames the clip shows, its handles and every original key time).
//
// The solver is generic over a group of channels (Animatables) and a joint deviation function, so the caller can
// measure what matters: for geometry the displacement of the drawn layer's corners in sequence pixels
// (`simplify-doc.ts`), otherwise the value distance in the property's units.
//
// Method:
//  - Kept keys are a subset of the original keys and keep their exact values, ids and times; only the segments
//    between kept keys are re-shaped. Each segment is `linear` or a fitted Bézier ease: with influence 1/3 on both
//    sides the evaluator's timing curve is x(τ) = τ, so the curve is a cubic Hermite in time whose two slopes are a
//    closed-form least-squares fit (non-negative slopes, S01:KF-001). Consecutive original keys keep their original
//    segment shape exactly, so a solution always exists (in the worst case nothing is removed).
//  - The minimal number of keys is found by dynamic programming over the candidate keys (shortest path in the DAG
//    of feasible segments), pruned: a segment is only fitted when it can improve a key count, and the scan from a
//    key stops after a run of infeasible ends.
//  - Channels sharing their key times (the four corner-pin corners, Motion written by one tracker apply) are
//    solved jointly with shared kept times; other channels of the group are solved one after the other with a
//    cumulative share of the tolerance, each against the already simplified ones, so the joint deviation of the
//    final result is ≤ the tolerance.
//  - The result is verified with the real evaluator (`keyframes.ts`) at every sample; a sub-group that would exceed
//    the tolerance there (numerical corner cases) keeps its original keys, so the guarantee is unconditional.
//  - Keys outside the span and the segments leaving it are untouched (boundary eases are made explicit).
import { evaluate, incomingEase, isHoldOnlyValue, outgoingEase } from '../keyframes.ts';
import type { Animatable, Ease, Keyframe } from '../schema/common.ts';

export type SimplifyValue = number | number[];
type Key = Keyframe<SimplifyValue>;

const LINEAR: Ease = { influence: 1 / 3, slope: 1 };
const THIRD = 1 / 3;
/** Fitted slopes are capped (very steep eases are better expressed by an extra key). */
const MAX_SLOPE = 40;
/** Consecutive infeasible segment ends after which the scan from a key stops. */
const MISS_LIMIT = 6;
/** Reweighting iterations of the ease fit (1 = plain least squares). */
const FIT_ITERATIONS = 6;

export type SimplifyChannel = {
	/** Original keys, sorted by time (unique times). */
	keys: readonly Key[];
	/** Inclusive key index span to simplify; keys outside are kept untouched. */
	span: readonly [number, number];
	/** Indices (into `keys`) inside the span that must stay (e.g. keys the user did not select). */
	locked?: ReadonlySet<number>;
};

export type SimplifyProblem = {
	channels: readonly SimplifyChannel[];
	/** Sorted, unique sample times (flicks) at which the deviation is measured. */
	times: readonly number[];
	/**
	 * Joint deviation at sample `s`: `values[c]` holds channel `c`'s value there (scalar channels at index 0). The
	 * function compares against the original animation (which it captures) and returns a non-negative distance.
	 */
	deviation(s: number, values: readonly Float64Array[]): number;
	/**
	 * Optional stricter (denser) deviation used to verify the result (e.g. a 9×9 grid over a corner-pinned
	 * picture while the solver uses its corners, edge midpoints and centre). When the result exceeds the tolerance
	 * under it, the solve is repeated with a smaller share of the tolerance.
	 */
	verify?(s: number, values: readonly Float64Array[]): number;
	tolerance: number;
};

export type SimplifyResult = {
	/** New key arrays (same order as the channels); unchanged channels return their original array. */
	keys: Key[][];
	/** Joint deviation of the result at every sample (verified with the evaluator). */
	errors: Float64Array;
	maxError: number;
	meanError: number;
	before: number[];
	after: number[];
};

function dimOf(v: SimplifyValue): number {
	return typeof v === 'number' ? 1 : v.length;
}

function write(out: Float64Array, offset: number, v: SimplifyValue): void {
	if (typeof v === 'number') out[offset] = v;
	else for (let i = 0; i < v.length; i++) out[offset + i] = v[i]!;
}

/** Index of the first time ≥ t (binary search). */
function lowerBound(times: readonly number[], t: number): number {
	let lo = 0;
	let hi = times.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (times[mid]! < t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/** Hermite timing curve with influence 1/3 on both sides: y(u) = 3(1−u)²u·y1 + 3(1−u)u²·y2 + u³. */
function hermite(u: number, y1: number, y2: number): number {
	const v = 1 - u;
	return 3 * v * v * u * y1 + 3 * v * u * u * y2 + u * u * u;
}

/** Shape of one channel on one segment. */
type Shape =
	| { kind: 'linear' }
	| { kind: 'ease'; out: Ease; in: Ease }
	| { kind: 'hold' }
	/** The original segment between two consecutive original keys (exact). */
	| { kind: 'original' };

/** The evaluator's effective shape of the segment leaving original key `i` (S01:KF-003). */
function originalSegment(keys: readonly Key[], i: number): Exclude<Shape, { kind: 'original' }> {
	const a = keys[i]!;
	if (a.interpolation === 'hold' || isHoldOnlyValue(a.value)) return { kind: 'hold' };
	if (a.interpolation === 'linear') return { kind: 'linear' };
	return { kind: 'ease', out: { ...outgoingEase(keys, i) }, in: { ...incomingEase(keys, i + 1) } };
}

type ChannelState = {
	ch: SimplifyChannel;
	dim: number;
	/** Original values at every sample (S × dim). */
	orig: Float64Array;
	/** Current values at every sample (after the sub-groups solved so far). */
	cur: Float64Array;
	/** Times of the span keys. */
	spanTimes: number[];
};

/** Simplifies a group of channels (see the header). Throws on malformed input (unsorted keys, bad span). */
export function simplifyKeyframes(problem: SimplifyProblem): SimplifyResult {
	const { times, tolerance } = problem;
	const S = times.length;
	const states: ChannelState[] = problem.channels.map((ch) => {
		const k = ch.keys;
		if (k.length === 0) throw new Error('A channel without keyframes cannot be simplified');
		const [i0, i1] = ch.span;
		if (!(i0 >= 0 && i1 < k.length && i0 <= i1)) throw new Error('Invalid keyframe span');
		for (let i = 1; i < k.length; i++)
			if (!(k[i]!.time > k[i - 1]!.time)) throw new Error('Keyframes must be sorted with unique times');
		const dim = dimOf(k[0]!.value);
		const orig = new Float64Array(S * dim);
		const anim: Animatable<SimplifyValue> = { value: k[0]!.value, keyframes: k as Key[] };
		for (let s = 0; s < S; s++) write(orig, s * dim, evaluate(anim, times[s]!));
		return {
			ch,
			dim,
			orig,
			cur: orig.slice(),
			spanTimes: k.slice(i0, i1 + 1).map((x) => x.time),
		};
	});
	// Sub-groups: channels whose span keys share the same times are solved jointly.
	const subGroups: number[][] = [];
	const byTimes = new Map<string, number[]>();
	states.forEach((st, c) => {
		if (st.spanTimes.length < 3) return; // nothing removable
		const sig = st.spanTimes.join(',');
		const g = byTimes.get(sig);
		if (g) g.push(c);
		else {
			const ng = [c];
			byTimes.set(sig, ng);
			subGroups.push(ng);
		}
	});

	const scratch = states.map((st) => new Float64Array(st.dim));
	const verify = problem.verify ?? problem.deviation;
	const m = subGroups.length;
	let result: Key[][] = [];
	let errors: Float64Array = new Float64Array(S);
	let maxError = 0;
	// Solve; if the (stricter) verification exceeds the tolerance, solve again with a smaller share of it.
	for (let attempt = 0, scale = 1; attempt < 8; attempt++, scale *= 0.8) {
		result = states.map((st) => st.ch.keys as Key[]);
		for (const st of states) st.cur.set(st.orig);
		subGroups.forEach((group, gi) => {
			const budget = (scale * tolerance * (gi + 1)) / m;
			const keys = solveSubGroup(states, group, times, problem.deviation, budget, scratch);
			group.forEach((c, j) => {
				result[c] = keys[j]!;
				const st = states[c]!;
				const anim: Animatable<SimplifyValue> = { value: keys[j]![0]!.value, keyframes: keys[j]! };
				for (let s = 0; s < S; s++) write(st.cur, s * st.dim, evaluate(anim, times[s]!));
			});
		});
		// Verification with the real evaluator (the `cur` arrays were filled with it above).
		errors = measure(states, S, verify, scratch);
		maxError = max(errors);
		if (maxError <= tolerance) break;
	}
	if (maxError > tolerance) {
		// Revert the sub-groups whose spans hold a violating sample (all original there: deviation 0).
		for (const group of subGroups) {
			const t0 = states[group[0]!]!.spanTimes[0]!;
			const t1 = states[group[0]!]!.spanTimes.at(-1)!;
			let bad = false;
			for (let s = lowerBound(times, t0); s < S && times[s]! <= t1; s++)
				if (errors[s]! > tolerance) bad = true;
			if (!bad) continue;
			for (const c of group) {
				result[c] = states[c]!.ch.keys as Key[];
				states[c]!.cur.set(states[c]!.orig);
			}
		}
		errors = measure(states, S, verify, scratch);
		maxError = max(errors);
	}
	let sum = 0;
	for (let s = 0; s < S; s++) sum += errors[s]!;
	return {
		keys: result,
		errors,
		maxError,
		meanError: S ? sum / S : 0,
		before: states.map((st) => st.ch.keys.length),
		after: result.map((k) => k.length),
	};
}

function max(a: Float64Array): number {
	let m = 0;
	for (let i = 0; i < a.length; i++) if (a[i]! > m) m = a[i]!;
	return m;
}

function measure(
	states: readonly ChannelState[],
	S: number,
	deviation: SimplifyProblem['deviation'],
	scratch: Float64Array[],
): Float64Array {
	const errors = new Float64Array(S);
	for (let s = 0; s < S; s++) {
		states.forEach((st, c) => {
			const out = scratch[c]!;
			for (let d = 0; d < st.dim; d++) out[d] = st.cur[s * st.dim + d]!;
		});
		errors[s] = deviation(s, scratch);
	}
	return errors;
}

/** Per-channel fit on one segment (values at the ends A, B; samples in between). */
type Fit = { shape: Shape; y1: number; y2: number };

/**
 * Solves one sub-group (channels with identical span key times) by DP over the span keys. Returns the new key
 * arrays of the group's channels.
 */
function solveSubGroup(
	states: readonly ChannelState[],
	group: readonly number[],
	times: readonly number[],
	deviation: SimplifyProblem['deviation'],
	budget: number,
	scratch: Float64Array[],
): Key[][] {
	const first = states[group[0]!]!;
	const T = first.spanTimes;
	const n = T.length;
	const i0s = group.map((c) => states[c]!.ch.span[0]);
	// A key is forced when any channel locks it.
	const forced = new Uint8Array(n);
	group.forEach((c, j) => {
		const locked = states[c]!.ch.locked;
		if (!locked) return;
		for (const idx of locked) {
			const k = idx - i0s[j]!;
			if (k > 0 && k < n - 1) forced[k] = 1;
		}
	});
	// The last span key keeps a `linear` interpolation (the segment leaving the span must not change) when it was
	// linear and is followed by a key: the last inner segment must then arrive linearly.
	const fixIn = group.map((c) => {
		const st = states[c]!;
		const i1 = st.ch.span[1];
		return st.ch.keys[i1]!.interpolation === 'linear' && i1 < st.ch.keys.length - 1;
	});
	const sampleIndex = T.map((t) => lowerBound(times, t));
	// Sample ranges strictly inside (T_a, T_b): [sampleIndex[a] (+1 if equal), sampleIndex[b]).
	const innerFrom = (a: number) => (times[sampleIndex[a]!] === T[a] ? sampleIndex[a]! + 1 : sampleIndex[a]!);

	const valueAt = (c: number, k: number): Float64Array => {
		const st = states[c]!;
		const v = st.ch.keys[st.ch.span[0] + k]!.value;
		const out = new Float64Array(st.dim);
		write(out, 0, v);
		return out;
	};
	const ends = group.map((c) => Array.from({ length: n }, (_, k) => valueAt(c, k)));
	const C = states.length;
	const role = new Int32Array(C).fill(-1);
	group.forEach((c, j) => {
		role[c] = j;
	});

	/** Projected targets p*(u) of channel j on [a, b] (reused by the fit iterations). */
	let us = new Float64Array(64);
	let ps = new Float64Array(64);
	let ws = new Float64Array(64);
	const clampY1 = (y: number) => Math.min(MAX_SLOPE / 3, Math.max(0, y));
	const clampY2 = (y: number) => Math.min(1, Math.max(1 - MAX_SLOPE / 3, y));

	/**
	 * Hermite slopes of channel j on [a, b] (null when the segment carries no movement): weighted least squares on
	 * the timing curve, refined towards the minimax fit with Lawson's reweighting (the check is on the max error).
	 */
	const fitHermite = (j: number, a: number, b: number, lo: number, hi: number): Fit | null => {
		const st = states[group[j]!]!;
		const A = ends[j]![a]!;
		const B = ends[j]![b]!;
		const dim = st.dim;
		let dd = 0;
		for (let d = 0; d < dim; d++) dd += (B[d]! - A[d]!) ** 2;
		if (dd < 1e-18) return null;
		const ta = T[a]!;
		const span = T[b]! - ta;
		const L = hi - lo;
		if (L <= 0) return null;
		if (us.length < L) {
			us = new Float64Array(L * 2);
			ps = new Float64Array(L * 2);
			ws = new Float64Array(L * 2);
		}
		// Target p* = (o−A)·D/|D|² (the projection on the segment's line; the evaluator moves along it).
		for (let i = 0; i < L; i++) {
			const s = lo + i;
			const u = (times[s]! - ta) / span;
			let dot = 0;
			for (let d = 0; d < dim; d++) dot += (st.orig[s * dim + d]! - A[d]!) * (B[d]! - A[d]!);
			us[i] = u;
			ps[i] = dot / dd;
			ws[i] = 1;
		}
		const fix = fixIn[j] && b === n - 1;
		let best: { y1: number; y2: number; err: number } | null = null;
		for (let iter = 0; iter < FIT_ITERATIONS; iter++) {
			// Normal equations for y1, y2 with basis b1 = 3(1−u)²u, b2 = 3(1−u)u², offset u³.
			let s11 = 0;
			let s12 = 0;
			let s22 = 0;
			let r1 = 0;
			let r2 = 0;
			for (let i = 0; i < L; i++) {
				const u = us[i]!;
				const w = ws[i]!;
				const p = ps[i]! - u * u * u;
				const v = 1 - u;
				const b1 = 3 * v * v * u;
				const b2 = 3 * v * u * u;
				s11 += w * b1 * b1;
				s12 += w * b1 * b2;
				s22 += w * b2 * b2;
				r1 += w * b1 * p;
				r2 += w * b2 * p;
			}
			const solve1 = (fixedY2: number) => (s11 > 1e-18 ? (r1 - s12 * fixedY2) / s11 : THIRD);
			const solve2 = (fixedY1: number) => (s22 > 1e-18 ? (r2 - s12 * fixedY1) / s22 : 2 * THIRD);
			let y1: number;
			let y2: number;
			if (fix) {
				y2 = 2 * THIRD; // incoming slope 1 (linear arrival)
				y1 = clampY1(solve1(y2));
			} else {
				const det = s11 * s22 - s12 * s12;
				if (Math.abs(det) < 1e-18) break;
				y1 = (r1 * s22 - r2 * s12) / det;
				y2 = (r2 * s11 - r1 * s12) / det;
				// Slopes: out = 3·y1, in = 3·(1 − y2); both in [0, MAX_SLOPE] (S01:KF-001: slope ≥ 0).
				if (y1 !== clampY1(y1) && y2 === clampY2(y2)) {
					y1 = clampY1(y1);
					y2 = clampY2(solve2(y1));
				} else if (y2 !== clampY2(y2) && y1 === clampY1(y1)) {
					y2 = clampY2(y2);
					y1 = clampY1(solve1(y2));
				} else {
					y1 = clampY1(y1);
					y2 = clampY2(y2);
				}
			}
			// Lawson update: w ← w·|r| (normalised); keeps the iterate with the smallest max residual.
			let err = 0;
			let sum = 0;
			for (let i = 0; i < L; i++) {
				const r = Math.abs(hermite(us[i]!, y1, y2) - ps[i]!);
				if (r > err) err = r;
				ws[i] = ws[i]! * (r + 1e-12);
				sum += ws[i]!;
			}
			if (!best || err < best.err) best = { y1, y2, err };
			if (sum <= 0) break;
			for (let i = 0; i < L; i++) ws[i] = ws[i]! / sum;
		}
		if (!best) return null;
		const { y1, y2 } = best;
		return {
			shape: {
				kind: 'ease',
				out: { influence: THIRD, slope: 3 * y1 },
				in: { influence: THIRD, slope: 3 * (1 - y2) },
			},
			y1,
			y2,
		};
	};

	/** Checks the group with the given per-channel shapes on [a, b]; true when every inner sample is within budget. */
	const limit = budget * (1 - 1e-9) - 1e-12;
	const check = (a: number, b: number, fits: readonly (Fit | null)[], lo: number, hi: number): boolean => {
		const ta = T[a]!;
		const span = T[b]! - ta;
		for (let s = lo; s < hi; s++) {
			const u = (times[s]! - ta) / span;
			for (let c = 0; c < C; c++) {
				const st = states[c]!;
				const out = scratch[c]!;
				const dim = st.dim;
				const j = role[c]!;
				if (j < 0) {
					const base = s * dim;
					for (let d = 0; d < dim; d++) out[d] = st.cur[base + d]!;
					continue;
				}
				const f = fits[j];
				const p = f ? hermite(u, f.y1, f.y2) : u;
				const A = ends[j]![a]!;
				const B = ends[j]![b]!;
				for (let d = 0; d < dim; d++) out[d] = A[d]! + p * (B[d]! - A[d]!);
			}
			if (!(deviation(s, scratch) <= limit)) return false;
		}
		return true;
	};

	/** Feasible shapes of [a, b] (b ≥ a + 2), or null. Linear first, then fitted eases. */
	const feasible = (a: number, b: number): Shape[] | null => {
		const lo = innerFrom(a);
		const hi = sampleIndex[b]!;
		const none = group.map(() => null);
		if (check(a, b, none, lo, hi)) return group.map(() => ({ kind: 'linear' }) as Shape);
		const fits = group.map((_, j) => fitHermite(j, a, b, lo, hi));
		if (fits.every((f) => f === null)) return null;
		if (!check(a, b, fits, lo, hi)) return null;
		return fits.map((f) => (f ? f.shape : ({ kind: 'linear' } as Shape)));
	};

	// DP: best[k] = fewest kept keys up to k (k kept); prev / shapes for the path.
	const best = new Float64Array(n).fill(Number.POSITIVE_INFINITY);
	const prev = new Int32Array(n).fill(-1);
	const shapes: (Shape[] | null)[] = new Array(n).fill(null);
	best[0] = 1;
	const original = group.map(() => ({ kind: 'original' }) as Shape);
	for (let a = 0; a < n - 1; a++) {
		const base = best[a]!;
		if (!Number.isFinite(base)) continue;
		if (base + 1 < best[a + 1]!) {
			best[a + 1] = base + 1;
			prev[a + 1] = a;
			shapes[a + 1] = original;
		}
		if (forced[a + 1]) continue; // cannot skip a forced key
		let misses = 0;
		for (let b = a + 2; b < n; b++) {
			if (base + 1 < best[b]!) {
				const sh = feasible(a, b);
				if (sh) {
					best[b] = base + 1;
					prev[b] = a;
					shapes[b] = sh;
					misses = 0;
				} else if (++misses > MISS_LIMIT) break;
			}
			if (forced[b]) break; // keys after a forced key need it kept
		}
	}

	// Path back from the last key.
	const kept: number[] = [];
	for (let k = n - 1; k >= 0; k = prev[k]!) {
		kept.push(k);
		if (k === 0) break;
	}
	kept.reverse();

	return group.map((c, j) => {
		const st = states[c]!;
		const keys = st.ch.keys;
		const [i0, i1] = st.ch.span;
		const segOf = (pos: number): Exclude<Shape, { kind: 'original' }> | 'none' => {
			// Shape of the segment leaving kept[pos] (or the original segment leaving the span).
			if (pos >= kept.length - 1) return i1 < keys.length - 1 ? originalSegment(keys, i1) : 'none';
			const sh = shapes[kept[pos + 1]!]![j]!;
			return sh.kind === 'original' ? originalSegment(keys, i0 + kept[pos]!) : sh;
		};
		const before = keys.slice(0, i0) as Key[];
		const after = keys.slice(i1 + 1) as Key[];
		const middle: Key[] = kept.map((k, pos) => {
			const orig = keys[i0 + k]!;
			// Incoming side: the segment arriving at this key.
			let inEase: Ease | 'linear' | 'none';
			if (pos === 0) {
				inEase = i0 === 0 ? 'none' : { ...incomingEase(keys, i0) };
			} else {
				const s = segOf(pos - 1);
				inEase = s === 'none' ? 'none' : s.kind === 'ease' ? s.in : 'linear';
			}
			const out = segOf(pos);
			return composeKey(orig, inEase, out, pos === kept.length - 1 && fixIn[j]!);
		});
		return [...before, ...middle, ...after];
	});
}

/** Builds a kept key from its incoming and outgoing segment shapes (values, ids and times are unchanged). */
function composeKey(
	orig: Key,
	inEase: Ease | 'linear' | 'none',
	out: Exclude<Shape, { kind: 'original' }> | 'none',
	keepLinear: boolean,
): Key {
	const easeIn = inEase === 'linear' || inEase === 'none' ? { ...LINEAR } : { ...inEase };
	// Spatial paths stay on the kept keys; the real-evaluator verification rejects a result they would bend.
	const base = {
		id: orig.id,
		time: orig.time,
		value: orig.value,
		...(orig.spatial ? { spatial: JSON.parse(JSON.stringify(orig.spatial)) as typeof orig.spatial } : {}),
	};
	if (out !== 'none' && out.kind === 'hold')
		return { ...base, interpolation: 'hold', easeIn, easeOut: { ...orig.easeOut } };
	const inLinear = inEase === 'linear' || inEase === 'none' || isLinearEase(inEase);
	const outLinear = out === 'none' || out.kind === 'linear';
	if (keepLinear || (inLinear && outLinear))
		return { ...base, interpolation: 'linear', easeIn: { ...LINEAR }, easeOut: { ...LINEAR } };
	const easeOut = out !== 'none' && out.kind === 'ease' ? { ...out.out } : { ...LINEAR };
	return { ...base, interpolation: 'bezier', easeIn, easeOut };
}

function isLinearEase(e: Ease): boolean {
	return Math.abs(e.slope - 1) < 1e-12 && Math.abs(e.influence - THIRD) < 1e-12;
}
