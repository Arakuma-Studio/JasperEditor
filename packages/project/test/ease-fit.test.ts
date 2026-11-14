import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type CubicEase,
	EASE_Y_LIMIT,
	type EaseCurve,
	EaseCurveSchema,
	EaseFitError,
	easeCurveMaxError,
	evaluateEaseCurve,
	fitCubicEase,
	fitEaseCurve,
	MAX_EASE_POINTS,
} from '../src/index.ts';

/** The fitter's contract grid: 1025 evenly spaced x. */
const gridError = (c: EaseCurve, fn: (x: number) => number) => easeCurveMaxError(c, fn, 1024);
const cubicFn = (c: CubicEase) => (x: number) => evaluateEaseCurve(c, x);

function refusal(fn: () => unknown): EaseFitError {
	try {
		fn();
	} catch (e) {
		expect(e).toBeInstanceOf(EaseFitError);
		return e as EaseFitError;
	}
	throw new Error('expected an EaseFitError');
}

describe('fitEaseCurve', () => {
	it('returns the exact cubic for cubic polynomials (Hermite handles)', () => {
		const quad = fitEaseCurve((x) => x * x);
		expect(quad.kind).toBe('cubic');
		const c = quad as CubicEase;
		expect(c.x1).toBeCloseTo(1 / 3, 12);
		expect(c.y1).toBeCloseTo(0, 6);
		expect(c.x2).toBeCloseTo(2 / 3, 12);
		expect(c.y2).toBeCloseTo(1 / 3, 6);
		expect(gridError(quad, (x) => x * x)).toBeLessThan(1e-6);
	});

	it('recovers a cubic-bezier given as a function within the tolerance', () => {
		const target: CubicEase = { kind: 'cubic', x1: 0.42, y1: 0, x2: 0.58, y2: 1 };
		const fit = fitEaseCurve(cubicFn(target));
		expect(fit.kind).toBe('cubic');
		expect(gridError(fit, cubicFn(target))).toBeLessThanOrEqual(0.002);
	});

	it('fits oscillating functions with a multi curve whose points sit on the turning points', () => {
		const fn = (x: number) => 1 - Math.cos(6 * Math.PI * x) * (1 - x) ** 2;
		const fit = fitEaseCurve(fn);
		expect(fit.kind).toBe('multi');
		expect(EaseCurveSchema.safeParse(fit).success).toBe(true);
		expect(gridError(fit, fn)).toBeLessThanOrEqual(0.002);
		// Between the grid samples the error stays close to the tolerance.
		expect(easeCurveMaxError(fit, fn, 9973)).toBeLessThan(0.0025);
		if (fit.kind !== 'multi') return;
		// cos(6πx) turns at x = k/3 (the envelope shifts the turning points slightly).
		for (const k of [1, 2]) expect(fit.points.some((p) => Math.abs(p.x - k / 3) < 0.03)).toBe(true);
	});

	it('handles kinks and vertical tangents (bounce contacts, circular arcs)', () => {
		const kink = (x: number) => (x < 0.5 ? 4 * x * x : 1 - 0.25 * (1 - ((x - 0.75) / 0.25) ** 2));
		const k = fitEaseCurve(kink);
		expect(gridError(k, kink)).toBeLessThanOrEqual(0.002);
		const arc = (x: number) => Math.sqrt(Math.max(0, 1 - (x - 1) ** 2));
		const a = fitEaseCurve(arc);
		expect(EaseCurveSchema.safeParse(a).success).toBe(true);
		expect(gridError(a, arc)).toBeLessThanOrEqual(0.002);
	});

	it('honours a smaller tolerance with more points', () => {
		const fn = (x: number) => 1 - Math.cos(4 * Math.PI * x) * Math.exp(-4 * x) * (1 - x);
		const coarse = fitEaseCurve(fn, { tolerance: 0.01 });
		const fine = fitEaseCurve(fn, { tolerance: 0.0005 });
		expect(gridError(coarse, fn)).toBeLessThanOrEqual(0.01);
		expect(gridError(fine, fn)).toBeLessThanOrEqual(0.0005);
		const n = (c: EaseCurve) => (c.kind === 'multi' ? c.points.length : 2);
		expect(n(fine)).toBeGreaterThanOrEqual(n(coarse));
	});

	it('uses an analytic derivative when given', () => {
		const fn = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x < 0.5 ? 8 * x ** 4 : 1 - 8 * (1 - x) ** 4);
		const d = (x: number) => (x < 0.5 ? 32 * x ** 3 : 32 * (1 - x) ** 3);
		const fit = fitEaseCurve(fn, { derivative: d });
		expect(gridError(fit, fn)).toBeLessThanOrEqual(0.002);
		expect(EaseCurveSchema.safeParse(fit).success).toBe(true);
	});

	it('is deterministic', () => {
		const fn = (x: number) => 1 - Math.cos(10 * Math.PI * x) * Math.exp(-5 * x) * (1 - x);
		expect(fitEaseCurve(fn)).toEqual(fitEaseCurve(fn));
		expect(fitCubicEase(Math.sqrt)).toEqual(fitCubicEase(Math.sqrt));
	});

	it('refuses nonfinite, out-of-range and wrongly anchored functions with typed errors', () => {
		const nan = refusal(() => fitEaseCurve((x) => (x > 0.5 ? Number.NaN : x)));
		expect([nan.code, nan.reason]).toEqual(['E_INVALID_PARAM', 'nonfinite']);
		const inf = refusal(() => fitEaseCurve((x) => (x > 0.3 ? Number.POSITIVE_INFINITY : x)));
		expect(inf.reason).toBe('nonfinite');
		const notNumber = refusal(() => fitEaseCurve((() => 'x') as unknown as (x: number) => number));
		expect(notNumber.reason).toBe('nonfinite');
		const range = refusal(() => fitEaseCurve((x) => x + 40 * Math.sin(Math.PI * x)));
		expect([range.code, range.reason]).toEqual(['E_INVALID_PARAM', 'range']);
		const ends = refusal(() => fitEaseCurve((x) => 0.5 + x / 2));
		expect(ends.reason).toBe('endpoints');
		const badDerivative = refusal(() =>
			fitEaseCurve((x) => 1 - Math.cos(6 * Math.PI * x) * (1 - x), { derivative: () => Number.NaN }),
		);
		expect(badDerivative.reason).toBe('nonfinite');
	});

	it('refuses bad options', () => {
		for (const tolerance of [0, -1, Number.NaN, Number.POSITIVE_INFINITY, 2])
			expect(refusal(() => fitEaseCurve((x) => x, { tolerance })).reason).toBe('options');
		for (const maxPoints of [2, Number.NaN, -5])
			expect(refusal(() => fitEaseCurve((x) => x, { maxPoints })).reason).toBe('options');
		for (const cubicTolerance of [0, Number.NaN, 2])
			expect(refusal(() => fitEaseCurve((x) => x, { cubicTolerance })).reason).toBe('options');
		expect(refusal(() => fitEaseCurve(42 as unknown as (x: number) => number)).reason).toBe('options');
	});

	it('refuses with E_LIMIT when the tolerance needs more than maxPoints points', () => {
		const fn = (x: number) => 1 - Math.cos(8 * Math.PI * x) * (1 - x);
		const few = refusal(() => fitEaseCurve(fn, { maxPoints: 5 }));
		expect([few.code, few.reason]).toEqual(['E_LIMIT', 'points']);
		// 200 swings cannot fit in MAX_EASE_POINTS points at all.
		const many = refusal(() => fitEaseCurve((x) => x + 0.3 * Math.sin(400 * Math.PI * x)));
		expect(many.code).toBe('E_LIMIT');
		// A larger maxPoints than MAX_EASE_POINTS is capped, not honoured.
		const capped = fitEaseCurve(fn, { maxPoints: 10_000 });
		if (capped.kind === 'multi') expect(capped.points.length).toBeLessThanOrEqual(MAX_EASE_POINTS);
	});

	it('property: smooth random functions fit within the tolerance or are refused, never invalid', () => {
		const coeffs = fc.array(fc.double({ min: -0.35, max: 0.35, noNaN: true }), {
			minLength: 1,
			maxLength: 5,
		});
		fc.assert(
			fc.property(coeffs, fc.integer({ min: 1, max: 4 }), (a, base) => {
				// x + Σ a_k sin(k·π·x): f(0) = 0, f(1) = 1, smooth, up to 5·base half-waves.
				const fn = (x: number) =>
					x + a.reduce((s, ak, k) => s + ak * Math.sin((k + 1) * base * Math.PI * x), 0);
				let fit: EaseCurve;
				try {
					fit = fitEaseCurve(fn);
				} catch (e) {
					expect(e).toBeInstanceOf(EaseFitError);
					return;
				}
				expect(EaseCurveSchema.safeParse(fit).success).toBe(true);
				expect(gridError(fit, fn)).toBeLessThanOrEqual(0.002);
			}),
			{ numRuns: 40, seed: 20261020 },
		);
	});

	it('property: arbitrary (also wild) functions never yield an invalid curve', () => {
		fc.assert(
			fc.property(
				fc.double({ min: -30, max: 30, noNaN: true }),
				fc.double({ min: 0.5, max: 60, noNaN: true }),
				fc.double({ min: 0.0001, max: 0.05, noNaN: true }),
				(amp, freq, tolerance) => {
					const fn = (x: number) => x + amp * x * (1 - x) * Math.sin(freq * x);
					try {
						const fit = fitEaseCurve(fn, { tolerance });
						expect(EaseCurveSchema.safeParse(fit).success).toBe(true);
						expect(gridError(fit, fn)).toBeLessThanOrEqual(tolerance);
					} catch (e) {
						expect(e).toBeInstanceOf(EaseFitError);
					}
				},
			),
			{ numRuns: 40, seed: 7 },
		);
	});

	it('property: random cubic-beziers come back as a single cubic', () => {
		const cubicArb = fc.record({
			kind: fc.constant('cubic' as const),
			x1: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
			y1: fc.double({ min: -1, max: 2, noNaN: true }),
			x2: fc.double({ min: 0.05, max: 0.95, noNaN: true }),
			y2: fc.double({ min: -1, max: 2, noNaN: true }),
		});
		fc.assert(
			fc.property(cubicArb, (c) => {
				const fit = fitEaseCurve(cubicFn(c), { tolerance: 0.005 });
				expect(EaseCurveSchema.safeParse(fit).success).toBe(true);
				expect(gridError(fit, cubicFn(c))).toBeLessThanOrEqual(0.005);
			}),
			{ numRuns: 25, seed: 11 },
		);
	});
});

describe('fitCubicEase', () => {
	it('finds a close single cubic and keeps x1, x2 in [0, 1] and y in range', () => {
		const sine = (x: number) => 1 - Math.cos((x * Math.PI) / 2);
		const c = fitCubicEase(sine);
		expect(EaseCurveSchema.safeParse(c).success).toBe(true);
		expect(gridError(c, sine)).toBeLessThan(0.001);
		const wild = fitCubicEase((x) => x + 9 * Math.sin(20 * x) * x * (1 - x));
		expect(EaseCurveSchema.safeParse(wild).success).toBe(true);
		expect(Math.abs(wild.y1)).toBeLessThanOrEqual(EASE_Y_LIMIT);
	});

	it('refuses nonfinite functions', () => {
		expect(refusal(() => fitCubicEase(() => Number.NaN)).reason).toBe('nonfinite');
	});
});

describe('easeCurveMaxError', () => {
	it('measures the analytic maximum error and reports nonfinite sources', () => {
		const c: CubicEase = { kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 2 / 3, y2: 2 / 3 };
		// max |x - x²| = ¼, attained at x = ½.
		expect(easeCurveMaxError(c, (x) => x * x, 1024)).toBeCloseTo(0.25, 12);
		expect(easeCurveMaxError(c, () => Number.NaN)).toBe(Number.POSITIVE_INFINITY);
		expect(easeCurveMaxError(c, (x) => x * x, Number.NaN)).toBeCloseTo(0.25, 12);
	});
});
