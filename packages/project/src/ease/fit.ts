// Ease-curve fitting: approximate a progress function y = f(x) on [0, 1] (f(0) = 0, f(1) = 1) with an `EaseCurve`.
// A single cubic-bezier when one matches within the tolerance, otherwise a multi-segment curve with points at the
// function's turning points and wherever the error demands a split. Deterministic (no randomness, fixed sample
// grids and search orders); see docs/wp-notes/easing.md "Built-in presets" for the method.
import {
	type CubicEase,
	EASE_Y_LIMIT,
	type EaseCurve,
	type EaseCurvePoint,
	evaluateEaseCurve,
	MAX_EASE_POINTS,
	type MultiEase,
} from './curve.ts';

/** Why a fit was refused: bad options, a nonfinite / out-of-range function, wrong endpoints or too many points. */
export type EaseFitReason = 'options' | 'nonfinite' | 'range' | 'endpoints' | 'points';

/** A refused fit. `code` is a command error code so callers can forward it as a refusal unchanged. */
export class EaseFitError extends Error {
	constructor(
		readonly code: 'E_INVALID_PARAM' | 'E_LIMIT',
		readonly reason: EaseFitReason,
		message: string,
	) {
		super(message);
		this.name = 'EaseFitError';
	}
}

export type EaseFitOptions = {
	/** Largest accepted |curve(x) − f(x)| (default 0.002). */
	tolerance?: number;
	/**
	 * Largest |curve(x) − f(x)| accepted for a single cubic-bezier when f is monotone (no turning point with a swing
	 * ≥ `tolerance`; default `tolerance`, raised to it when below). A cubic within this bound is preferred to a multi
	 * curve: one segment's handles rescale with its keys, a multi curve's interior keys do not. Curves that turn
	 * (overshoot, anticipation) keep `tolerance`: their peak is the feature, and an absolute bound would distort it.
	 */
	cubicTolerance?: number;
	/** Most points of a multi-segment result, endpoints included (default and cap `MAX_EASE_POINTS`, at least 3). */
	maxPoints?: number;
	/** f′(x), used for the handle slopes instead of one-sided finite differences. */
	derivative?: (x: number) => number;
};

export const DEFAULT_EASE_FIT_TOLERANCE = 0.002;
/** Intervals of the uniform grid the error is measured on (1025 samples). */
const GRID = 1024;
/** Fewest samples the error of one multi-curve piece is measured at. */
const MIN_PIECE_SAMPLES = 24;
/** Pieces narrower than this are not split further. */
const MIN_PIECE_WIDTH = 1e-4;

type Pt = readonly [number, number];
type Bez = readonly [Pt, Pt, Pt, Pt];

const cube = (t: number, p0: number, p1: number, p2: number, p3: number) => {
	const s = 1 - t;
	return s * s * s * p0 + 3 * s * s * t * p1 + 3 * s * t * t * p2 + t * t * t * p3;
};
const cubeD = (t: number, p0: number, p1: number, p2: number, p3: number) => {
	const s = 1 - t;
	return 3 * s * s * (p1 - p0) + 6 * s * t * (p2 - p1) + 3 * t * t * (p3 - p2);
};

/**
 * The parameter t ∈ [0, 1] where the monotone x(t) of a piece equals u: safeguarded Newton (a bisection step
 * whenever Newton leaves the bracket or stalls), warm-started from `guess`.
 */
function solveT(u: number, x0: number, x1: number, x2: number, x3: number, guess: number): number {
	if (u <= x0) return 0;
	if (u >= x3) return 1;
	let lo = 0;
	let hi = 1;
	let t = Math.min(1, Math.max(0, guess));
	for (let i = 0; i < 60; i++) {
		const e = cube(t, x0, x1, x2, x3) - u;
		if (Math.abs(e) < 1e-13) return t;
		if (e < 0) lo = t;
		else hi = t;
		const d = cubeD(t, x0, x1, x2, x3);
		let next = d > 1e-12 ? t - e / d : Number.NaN;
		if (!(next > lo && next < hi)) next = (lo + hi) / 2;
		if (Math.abs(next - t) < 1e-15) return next;
		t = next;
	}
	return t;
}

/** Sampled target function: grid x and y, checked finite and inside ±EASE_Y_LIMIT. */
type Samples = { fn: (x: number) => number; xs: Float64Array; ys: Float64Array };

function call(fn: (x: number) => number, x: number): number {
	const y = fn(x);
	if (typeof y !== 'number' || !Number.isFinite(y))
		throw new EaseFitError('E_INVALID_PARAM', 'nonfinite', `the function is not finite at x = ${x}`);
	if (Math.abs(y) > EASE_Y_LIMIT)
		throw new EaseFitError(
			'E_INVALID_PARAM',
			'range',
			`the function leaves ±${EASE_Y_LIMIT} at x = ${x} (y = ${y})`,
		);
	return y;
}

function sample(fn: (x: number) => number): Samples {
	if (typeof fn !== 'function') throw new EaseFitError('E_INVALID_PARAM', 'options', 'fn must be a function');
	const xs = new Float64Array(GRID + 1);
	const ys = new Float64Array(GRID + 1);
	for (let i = 0; i <= GRID; i++) {
		xs[i] = i / GRID;
		ys[i] = call(fn, i / GRID);
	}
	return { fn, xs, ys };
}

function tolOf(opts: EaseFitOptions | undefined): number {
	const tol = opts?.tolerance ?? DEFAULT_EASE_FIT_TOLERANCE;
	if (typeof tol !== 'number' || !Number.isFinite(tol) || tol <= 0 || tol > 1)
		throw new EaseFitError('E_INVALID_PARAM', 'options', `tolerance must be in (0, 1], got ${String(tol)}`);
	return tol;
}

function cubicTolOf(opts: EaseFitOptions | undefined, tol: number): number {
	const c = opts?.cubicTolerance;
	if (c === undefined) return tol;
	if (typeof c !== 'number' || !Number.isFinite(c) || c <= 0 || c > 1)
		throw new EaseFitError(
			'E_INVALID_PARAM',
			'options',
			`cubicTolerance must be in (0, 1], got ${String(c)}`,
		);
	return Math.max(tol, c);
}

function maxPointsOf(opts: EaseFitOptions | undefined): number {
	const m = opts?.maxPoints ?? MAX_EASE_POINTS;
	if (typeof m !== 'number' || !Number.isFinite(m) || m < 3)
		throw new EaseFitError('E_INVALID_PARAM', 'options', `maxPoints must be at least 3, got ${String(m)}`);
	return Math.min(MAX_EASE_POINTS, Math.floor(m));
}

// ---------------------------------------------------------------------------------------------------------------
// Single cubic

/** Max |cubic(x) − f(x)| over the sample grid (stops early once above `stopAbove`). */
function cubicMaxError(c: CubicEase, s: Samples, stopAbove: number): number {
	const ends = Math.max(Math.abs(s.ys[0] as number), Math.abs((s.ys[GRID] as number) - 1));
	const seg: Bez = [
		[0, 0],
		[c.x1, c.y1],
		[c.x2, c.y2],
		[1, 1],
	];
	return Math.max(ends, bezMaxError(seg, s.xs.subarray(1, GRID), s.ys.subarray(1, GRID), stopAbove));
}

/** Curve parameters t the cubic search is scored at. */
const FIT_SAMPLES = 64;

const clampY = (v: number) => Math.min(EASE_Y_LIMIT, Math.max(-EASE_Y_LIMIT, v));

/** f(x) interpolated linearly on the sample grid (scores during searches; results are checked on exact samples). */
function gridAt(s: Samples, x: number): number {
	const p = Math.min(GRID, Math.max(0, x * GRID));
	const i = Math.min(GRID - 1, Math.floor(p));
	const w = p - i;
	return (s.ys[i] as number) * (1 - w) + (s.ys[i + 1] as number) * w;
}

/**
 * For fixed x1, x2 the curve is linear in y1, y2: y(t) = 3s²t·y1 + 3st²·y2 + t³. Least squares over FIT_SAMPLES
 * evenly spaced t (target f(x(t)) from the grid) by the 2×2 normal equations; returns the residual sum of squares.
 */
function bestYs(s: Samples, x1: number, x2: number): { y1: number; y2: number; sse: number } {
	let a11 = 0;
	let a12 = 0;
	let a22 = 0;
	let b1 = 0;
	let b2 = 0;
	let rr = 0;
	for (let j = 0; j < FIT_SAMPLES; j++) {
		const t = (j + 0.5) / FIT_SAMPLES;
		const u = 1 - t;
		const p = 3 * u * u * t;
		const q = 3 * u * t * t;
		const r = gridAt(s, p * x1 + q * x2 + t * t * t) - t * t * t;
		a11 += p * p;
		a12 += p * q;
		a22 += q * q;
		b1 += p * r;
		b2 += q * r;
		rr += r * r;
	}
	const det = a11 * a22 - a12 * a12;
	let y1 = 0;
	let y2 = 1;
	if (Math.abs(det) > 1e-12 * Math.max(1, a11 * a22)) {
		y1 = (b1 * a22 - b2 * a12) / det;
		y2 = (a11 * b2 - a12 * b1) / det;
	}
	if (!Number.isFinite(y1)) y1 = 0;
	if (!Number.isFinite(y2)) y2 = 1;
	y1 = clampY(y1);
	y2 = clampY(y2);
	// Σ(p·y1 + q·y2 − r)² expanded in the accumulated sums.
	const sse = Math.max(0, a11 * y1 * y1 + 2 * a12 * y1 * y2 + a22 * y2 * y2 - 2 * (b1 * y1 + b2 * y2) + rr);
	return { y1, y2, sse };
}

/**
 * Least-squares cubic: a 4 × 4 grid over (x1, x2) ∈ [0, 1]², then a compass search from the best node. With
 * `giveUpRms`, returns null as soon as the coarse search (steps ≥ 1/48) ends with an RMS error above it: the max
 * error is at least the RMS, and the fine steps left only polish x1, x2, so such a cubic cannot get within a
 * tolerance well below `giveUpRms`.
 */
function cubicLeastSquares(s: Samples, giveUpRms?: number): CubicEase | null {
	let best = { x1: 1 / 3, x2: 2 / 3, ...bestYs(s, 1 / 3, 2 / 3) };
	const nodes = [0, 1 / 3, 2 / 3, 1];
	for (const x1 of nodes)
		for (const x2 of nodes) {
			const r = bestYs(s, x1, x2);
			if (r.sse < best.sse) best = { x1, x2, ...r };
		}
	let step = 1 / 6;
	while (step >= 2 ** -10) {
		if (giveUpRms !== undefined && step < 1 / 48 && Math.sqrt(best.sse / FIT_SAMPLES) > giveUpRms)
			return null;
		let moved = false;
		for (const [dx1, dx2] of [
			[step, 0],
			[-step, 0],
			[0, step],
			[0, -step],
		] as const) {
			const x1 = Math.min(1, Math.max(0, best.x1 + dx1));
			const x2 = Math.min(1, Math.max(0, best.x2 + dx2));
			if (x1 === best.x1 && x2 === best.x2) continue;
			const r = bestYs(s, x1, x2);
			if (r.sse < best.sse) {
				best = { x1, x2, ...r };
				moved = true;
			}
		}
		if (!moved) step /= 2;
	}
	return { kind: 'cubic', x1: best.x1, y1: best.y1, x2: best.x2, y2: best.y2 };
}

/** One-sided derivative of f at x looking into the piece (dir = +1: toward larger x, −1: toward smaller). */
function slopeAt(
	s: Samples,
	deriv: ((x: number) => number) | undefined,
	x: number,
	dir: 1 | -1,
	width: number,
) {
	const h = Math.min(1e-5, width / 4);
	if (deriv) {
		const d = deriv(Math.min(1, Math.max(0, x + dir * h * 1e-3)));
		if (typeof d === 'number' && Number.isFinite(d)) return d;
		throw new EaseFitError('E_INVALID_PARAM', 'nonfinite', `the derivative is not finite at x = ${x}`);
	}
	const f0 = call(s.fn, x);
	const f1 = call(s.fn, x + dir * h);
	const f2 = call(s.fn, x + dir * 2 * h);
	return (dir * (-3 * f0 + 4 * f1 - f2)) / (2 * h);
}

/** The cubic Hermite interpolant of the end slopes: cubic-bezier(1/3, f′(0)/3, 2/3, 1 − f′(1)/3). */
function hermiteCubic(s: Samples, deriv: ((x: number) => number) | undefined): CubicEase {
	const m0 = slopeAt(s, deriv, 0, 1, 1);
	const m1 = slopeAt(s, deriv, 1, -1, 1);
	return { kind: 'cubic', x1: 1 / 3, y1: clampY(m0 / 3), x2: 2 / 3, y2: clampY(1 - m1 / 3) };
}

/**
 * The best single cubic-bezier for f in the least-squares sense over (x1, y1, x2, y2), x1, x2 ∈ [0, 1]. The curve
 * still starts at (0, 0) and ends at (1, 1) whatever f(0) and f(1) are. Throws `EaseFitError` for a nonfinite or
 * out-of-range f.
 */
export function fitCubicEase(fn: (x: number) => number): CubicEase {
	return cubicLeastSquares(sample(fn)) as CubicEase;
}

/** Curve parameters the minimax search scores a cubic at (the result is then checked on the whole grid). */
const MINIMAX_SAMPLES = 128;
/** The 80 directions of the minimax pattern search: every nonzero combination of −1, 0, +1 over (x1, y1, x2, y2). */
const MINIMAX_DIRECTIONS: readonly (readonly [number, number, number, number])[] = (() => {
	const out: [number, number, number, number][] = [];
	for (const a of [-1, 0, 1])
		for (const b of [-1, 0, 1])
			for (const c of [-1, 0, 1]) for (const d of [-1, 0, 1]) if (a || b || c || d) out.push([a, b, c, d]);
	return out;
})();

/**
 * True when the cubic's progress y(t) never decreases: y′(t)/3 = (1−t)²·a + 2(1−t)t·b + t²·c with a = y1,
 * b = y2 − y1, c = 1 − y2 is ≥ 0 on [0, 1] iff a ≥ 0, c ≥ 0 and (b ≥ 0 or b² ≤ a·c). x(t) is monotone for any
 * x1, x2 in [0, 1], so this is "progress never steps back".
 */
function isMonotoneCubic(c: CubicEase): boolean {
	const a = c.y1;
	const b = c.y2 - c.y1;
	const d = 1 - c.y2;
	return a >= 0 && d >= 0 && (b >= 0 || b * b <= a * d);
}

/**
 * Minimax refinement of a cubic for a monotone f (least squares spreads the error; the max error is what the
 * tolerance bounds), keeping the cubic monotone too: an unconstrained fit of an in-out curve dips below 0 and
 * overshoots 1 by a fraction of a percent, a visible step back. A pattern search over all 80 unit moves of
 * (x1, y1, x2, y2) — the coordinates move together, so a handle pinned at x = 0 or 1 can still trade its y against
 * the other handle — with steps 1/32 … 2⁻¹², scored by `scoreByT` on f itself, from `start` clamped to y1 ≥ 0,
 * y2 ≤ 1 (the linear cubic when that is still not monotone).
 */
function cubicMinimax(s: Samples, start: CubicEase): CubicEase {
	const seg = (c: CubicEase): Bez => [
		[0, 0],
		[c.x1, c.y1],
		[c.x2, c.y2],
		[1, 1],
	];
	const clamped: CubicEase = { ...start, y1: Math.max(0, start.y1), y2: Math.min(1, start.y2) };
	let best: CubicEase = isMonotoneCubic(clamped)
		? clamped
		: { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
	// f evaluated directly, not from the grid: near a vertical tangent (Penner circ) the grid's chords are too coarse.
	let bestErr = scoreByT(s, seg(best), true, Number.POSITIVE_INFINITY, MINIMAX_SAMPLES);
	const unitX = (v: number) => Math.min(1, Math.max(0, v));
	let step = 1 / 32;
	while (step >= 2 ** -12) {
		let moved = false;
		for (const [a, b, c, d] of MINIMAX_DIRECTIONS) {
			const next: CubicEase = {
				kind: 'cubic',
				x1: unitX(best.x1 + a * step),
				y1: clampY(best.y1 + b * step),
				x2: unitX(best.x2 + c * step),
				y2: clampY(best.y2 + d * step),
			};
			if (!isMonotoneCubic(next)) continue;
			const err = scoreByT(s, seg(next), true, bestErr, MINIMAX_SAMPLES);
			if (err < bestErr) {
				best = next;
				bestErr = err;
				moved = true;
			}
		}
		if (!moved) step /= 2;
	}
	return best;
}

// ---------------------------------------------------------------------------------------------------------------
// Multi-segment

/**
 * Turning points with a swing of at least `delta` (a zig-zag filter over the samples, so float noise and
 * sub-tolerance ripples are not points), each refined to the local extremum by golden-section search.
 */
function turningPoints(s: Samples, delta: number): number[] {
	const ys = s.ys;
	const idx: number[] = [];
	let dir = 0; // +1 rising, −1 falling, 0 unknown
	let pivot = 0;
	for (let i = 1; i <= GRID; i++) {
		const y = ys[i] as number;
		const p = ys[pivot] as number;
		if (dir === 0) {
			if (y - (ys[0] as number) >= delta) {
				dir = 1;
				pivot = i;
			} else if ((ys[0] as number) - y >= delta) {
				dir = -1;
				pivot = i;
			}
			continue;
		}
		if (dir > 0) {
			if (y >= p) pivot = i;
			else if (p - y >= delta) {
				idx.push(pivot);
				dir = -1;
				pivot = i;
			}
		} else if (y <= p) pivot = i;
		else if (y - p >= delta) {
			idx.push(pivot);
			dir = 1;
			pivot = i;
		}
	}
	const out: number[] = [];
	for (const i of idx) {
		if (i <= 0 || i >= GRID) continue;
		const isMax = (ys[i] as number) >= (ys[i - 1] as number);
		let a = (i - 1) / GRID;
		let b = (i + 1) / GRID;
		const g = (x: number) => (isMax ? -call(s.fn, x) : call(s.fn, x));
		const r = (Math.sqrt(5) - 1) / 2;
		let c = b - r * (b - a);
		let d = a + r * (b - a);
		let gc = g(c);
		let gd = g(d);
		for (let k = 0; k < 40 && b - a > 1e-11; k++) {
			if (gc < gd) {
				b = d;
				d = c;
				gd = gc;
				c = b - r * (b - a);
				gc = g(c);
			} else {
				a = c;
				c = d;
				gc = gd;
				d = a + r * (b - a);
				gd = g(d);
			}
		}
		const x = (a + b) / 2;
		if (x > 0 && x < 1 && (out.length === 0 || x > (out[out.length - 1] as number) + MIN_PIECE_WIDTH))
			out.push(x);
	}
	return out.filter((x) => x > MIN_PIECE_WIDTH && x < 1 - MIN_PIECE_WIDTH);
}

/** Evaluation abscissae of a piece: the grid samples inside (a, b), or MIN_PIECE_SAMPLES evenly spaced ones. */
function pieceSamples(s: Samples, a: number, b: number): { us: Float64Array; fs: Float64Array } {
	const i0 = Math.floor(a * GRID) + 1;
	const i1 = Math.ceil(b * GRID) - 1;
	if (i1 - i0 + 1 >= MIN_PIECE_SAMPLES) {
		return { us: s.xs.subarray(i0, i1 + 1), fs: s.ys.subarray(i0, i1 + 1) };
	}
	const us = new Float64Array(MIN_PIECE_SAMPLES);
	const fs = new Float64Array(MIN_PIECE_SAMPLES);
	for (let j = 0; j < MIN_PIECE_SAMPLES; j++) {
		const u = a + ((j + 1) / (MIN_PIECE_SAMPLES + 1)) * (b - a);
		us[j] = u;
		fs[j] = call(s.fn, u);
	}
	return { us, fs };
}

/**
 * Max |piece(u) − f(u)| over the abscissae `us` (ascending, inside the piece), returning as soon as it exceeds
 * `stopAbove`. Handles at exactly one and two thirds make x(t) linear, so t is then (u − x0) / dx with no solve.
 */
function bezMaxError(
	seg: Bez,
	us: Float64Array,
	fs: Float64Array,
	stopAbove = Number.POSITIVE_INFINITY,
): number {
	const [p0, p1, p2, p3] = seg;
	const dx = p3[0] - p0[0];
	const linear =
		Math.abs(p1[0] - (p0[0] + dx / 3)) <= 1e-15 && Math.abs(p2[0] - (p3[0] - dx / 3)) <= 1e-15 && dx > 0;
	let worst = 0;
	let t = 0;
	for (let j = 0; j < us.length; j++) {
		const u = us[j] as number;
		t = linear ? Math.min(1, Math.max(0, (u - p0[0]) / dx)) : solveT(u, p0[0], p1[0], p2[0], p3[0], t);
		const e = Math.abs(cube(t, p0[1], p1[1], p2[1], p3[1]) - (fs[j] as number));
		if (e > worst) {
			worst = e;
			if (worst > stopAbove) return worst;
		}
	}
	return worst;
}

/**
 * Max |y(t) − f(x(t))| at `samples` evenly spaced interior t (no x → t solve), f from the grid, or evaluated
 * directly in a piece too narrow for the grid; returns as soon as it exceeds `stopAbove`.
 */
function scoreByT(
	s: Samples,
	seg: Bez,
	direct: boolean,
	stopAbove = Number.POSITIVE_INFINITY,
	samples = SEARCH_SAMPLES,
): number {
	const [p0, p1, p2, p3] = seg;
	let worst = 0;
	for (let j = 1; j <= samples; j++) {
		const t = j / (samples + 1);
		const x = cube(t, p0[0], p1[0], p2[0], p3[0]);
		const f = direct ? call(s.fn, x) : gridAt(s, x);
		const e = Math.abs(cube(t, p0[1], p1[1], p2[1], p3[1]) - f);
		if (e > worst) {
			worst = e;
			if (worst > stopAbove) return worst;
		}
	}
	return worst;
}

/** Samples a piece's handle-length search is scored on (the result is then checked on all of its samples). */
const SEARCH_SAMPLES = 32;

/**
 * The handle `point + k·v` with the largest k ≤ kWanted that keeps the handle's x inside the piece and its y inside
 * ±EASE_Y_LIMIT; x is kept strictly past the point (a handle at the point itself is not representable).
 */
function handle(p: Pt, v: Pt, k: number, a: number, b: number): Pt {
	let kk = k;
	const span = b - a;
	if (v[0] !== 0) kk = Math.min(kk, span / Math.abs(v[0]));
	if (v[1] > 0) kk = Math.min(kk, (EASE_Y_LIMIT - p[1]) / v[1]);
	if (v[1] < 0) kk = Math.min(kk, (-EASE_Y_LIMIT - p[1]) / v[1]);
	let x = p[0] + kk * v[0];
	const minDx = span * 1e-6;
	x = v[0] > 0 ? Math.min(b, Math.max(p[0] + minDx, x)) : Math.max(a, Math.min(p[0] - minDx, x));
	return [x, clampY(p[1] + kk * v[1])];
}

/**
 * Piece from (a, fa) to (b, fb): Hermite handles (± (dx/3, f′·dx/3)), shortened along their tangent when steep so
 * |Δy| stays within the piece's rise (vertical tangents), then — if the error is still above the tolerance — a
 * compass search over the two handle lengths (log₂ scale) minimising the max error.
 */
function fitPiece(
	s: Samples,
	deriv: ((x: number) => number) | undefined,
	a: number,
	fa: number,
	b: number,
	fb: number,
	tol: number,
): { seg: Bez; err: number } {
	const dx = b - a;
	const ma = slopeAt(s, deriv, a, 1, dx);
	const mb = slopeAt(s, deriv, b, -1, dx);
	const cap = Math.max(Math.abs(fb - fa), dx);
	const va: Pt = [dx / 3, (ma * dx) / 3];
	const vb: Pt = [-dx / 3, (-mb * dx) / 3];
	const ka = Math.abs(va[1]) > cap ? cap / Math.abs(va[1]) : 1;
	const kb = Math.abs(vb[1]) > cap ? cap / Math.abs(vb[1]) : 1;
	const P0: Pt = [a, fa];
	const P3: Pt = [b, fb];
	const { us, fs } = pieceSamples(s, a, b);
	const make = (la: number, lb: number): Bez => [
		P0,
		handle(P0, va, ka * 2 ** la, a, b),
		handle(P3, vb, kb * 2 ** lb, a, b),
		P3,
	];
	const hermite = make(0, 0);
	const hermiteErr = bezMaxError(hermite, us, fs, tol);
	if (hermiteErr <= tol) return { seg: hermite, err: hermiteErr };
	const direct = dx * GRID < 2 * MIN_PIECE_SAMPLES;
	let best = { la: 0, lb: 0, seg: hermite, err: scoreByT(s, hermite, direct) };
	let step = 1;
	while (step >= 1 / 32) {
		let moved = false;
		for (const [da, db] of [
			[step, 0],
			[-step, 0],
			[0, step],
			[0, -step],
		] as const) {
			const la = best.la + da;
			const lb = best.lb + db;
			if (Math.abs(la) > 12 || Math.abs(lb) > 12) continue;
			const seg = make(la, lb);
			const err = scoreByT(s, seg, direct, best.err);
			if (err < best.err) {
				best = { la, lb, seg, err };
				moved = true;
			}
		}
		// Stop well inside the tolerance (the full sample set can be slightly worse than the search set).
		if (best.err <= tol / 2) break;
		if (!moved) step /= 2;
	}
	return { seg: best.seg, err: bezMaxError(best.seg, us, fs) };
}

/**
 * Fits an ease curve to the progress function `fn` on [0, 1]: a `cubic` when one cubic-bezier is within
 * `tolerance` (max |error| over a 1025-sample grid) or, for a monotone f after a monotone minimax refinement,
 * within `cubicTolerance`; otherwise a `multi` curve with points at the endpoints, the function's turning points
 * (swing ≥ tolerance) and midpoints of pieces still above the tolerance. The ends are
 * pinned to (0, 0) and (1, 1). Throws `EaseFitError` when f is nonfinite or leaves ±EASE_Y_LIMIT, when f(0) or f(1)
 * is farther than the tolerance from 0 / 1, or when the tolerance needs more than `maxPoints` points.
 */
export function fitEaseCurve(fn: (x: number) => number, opts?: EaseFitOptions): EaseCurve {
	const tol = tolOf(opts);
	const cubicTol = cubicTolOf(opts, tol);
	const maxPoints = maxPointsOf(opts);
	const deriv = opts?.derivative;
	if (deriv !== undefined && typeof deriv !== 'function')
		throw new EaseFitError('E_INVALID_PARAM', 'options', 'derivative must be a function');
	const s = sample(fn);
	const y0 = s.ys[0] as number;
	const y1 = s.ys[GRID] as number;
	if (Math.abs(y0) > tol || Math.abs(y1 - 1) > tol)
		throw new EaseFitError(
			'E_INVALID_PARAM',
			'endpoints',
			`an ease runs from (0, 0) to (1, 1); the function gives f(0) = ${y0}, f(1) = ${y1}`,
		);
	const turns = turningPoints(s, tol);
	// A cubic-bezier's y(t) has at most two turning points.
	if (turns.length <= 2) {
		const hermite = hermiteCubic(s, deriv);
		if (cubicMaxError(hermite, s, tol) <= tol) return hermite;
		const monotoneTol = turns.length === 0 ? cubicTol : tol;
		const ls = cubicLeastSquares(s, 2 * monotoneTol);
		if (ls && cubicMaxError(ls, s, tol) <= tol) return ls;
		if (ls && monotoneTol > tol) {
			const mm = cubicMinimax(s, ls);
			if (cubicMaxError(mm, s, monotoneTol) <= monotoneTol) return mm;
		}
	}
	const breaks = [0, ...turns, 1];
	const yAt = (x: number) => (x === 0 ? 0 : x === 1 ? 1 : call(s.fn, x));
	const pieces: Bez[] = [];
	const limit = maxPoints - 1;
	const tooMany = () =>
		new EaseFitError(
			'E_LIMIT',
			'points',
			`matching the function within ${tol} needs more than ${maxPoints} points`,
		);
	const walk = (a: number, fa: number, b: number, fb: number, pendingAfter: number): void => {
		const r = fitPiece(s, deriv, a, fa, b, fb, tol);
		if (r.err <= tol || b - a < 2 * MIN_PIECE_WIDTH) {
			if (r.err > tol) throw tooMany();
			pieces.push(r.seg);
			return;
		}
		if (pieces.length + pendingAfter + 2 > limit) throw tooMany();
		const m = (a + b) / 2;
		const fm = yAt(m);
		walk(a, fa, m, fm, pendingAfter + 1);
		walk(m, fm, b, fb, pendingAfter);
	};
	for (let i = 0; i + 1 < breaks.length; i++) {
		const a = breaks[i] as number;
		const b = breaks[i + 1] as number;
		walk(a, yAt(a), b, yAt(b), breaks.length - 2 - i);
	}
	if (pieces.length + 1 > maxPoints) throw tooMany();
	return piecesToMulti(pieces);
}

function piecesToMulti(pieces: readonly Bez[]): MultiEase {
	// A curve that needed no interior point (a single piece) still has to be a valid multi curve (≥ 3 points):
	// split it at t = 1/2 with de Casteljau (exactly the same curve).
	let list = pieces;
	if (list.length === 1) {
		const [p0, p1, p2, p3] = list[0] as Bez;
		const mid = (p: Pt, q: Pt): Pt => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
		const a = mid(p0, p1);
		const b = mid(p1, p2);
		const c = mid(p2, p3);
		const d = mid(a, b);
		const e = mid(b, c);
		const m = mid(d, e);
		list = [
			[p0, a, d, m],
			[m, e, c, p3],
		];
	}
	const points: EaseCurvePoint[] = [];
	for (let i = 0; i < list.length; i++) {
		const [, p1, p2, p3] = list[i] as Bez;
		if (i === 0) points.push({ x: 0, y: 0, out: [p1[0], p1[1]] });
		else (points[points.length - 1] as EaseCurvePoint).out = [p1[0], p1[1]];
		const last = i === list.length - 1;
		points.push({ x: last ? 1 : p3[0], y: last ? 1 : p3[1], in: [p2[0], p2[1]] });
	}
	return { kind: 'multi', points };
}

/** Max |curve(x) − fn(x)| over `samples` + 1 evenly spaced x in [0, 1] (∞ when either side is not finite). */
export function easeCurveMaxError(curve: EaseCurve, fn: (x: number) => number, samples = 2000): number {
	const n = Math.max(1, Math.min(1_000_000, Math.floor(Number.isFinite(samples) ? samples : 2000)));
	let worst = 0;
	for (let i = 0; i <= n; i++) {
		const e = Math.abs(evaluateEaseCurve(curve, i / n) - fn(i / n));
		if (!(e <= worst)) worst = Number.isNaN(e) ? Number.POSITIVE_INFINITY : e;
	}
	return worst;
}
