import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	bezierProgress,
	type CubicEase,
	cubicToEases,
	EaseCurveSchema,
	easesToCubic,
	evaluateEaseCurve,
	MIN_EASE_INFLUENCE,
} from '../src/index.ts';

/** Reference CSS cubic-bezier: solve x(t) = u by bisection (x is monotone for x1, x2 in [0, 1]), return y(t). */
function cssCubic(c: CubicEase, u: number): number {
	const bez = (t: number, a: number, b: number) =>
		3 * (1 - t) ** 2 * t * a + 3 * (1 - t) * t * t * b + t ** 3;
	let lo = 0;
	let hi = 1;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, c.x1, c.x2) < u) lo = mid;
		else hi = mid;
	}
	return bez((lo + hi) / 2, c.y1, c.y2);
}

const cubicArb = fc.record({
	kind: fc.constant('cubic' as const),
	x1: fc.double({ min: 0.01, max: 1, noNaN: true }),
	y1: fc.double({ min: -2, max: 3, noNaN: true }),
	x2: fc.double({ min: 0, max: 0.99, noNaN: true }),
	y2: fc.double({ min: -2, max: 3, noNaN: true }),
});

describe('ease curves ↔ keyframe eases', () => {
	it('a converted cubic evaluates like CSS cubic-bezier', () => {
		fc.assert(
			fc.property(cubicArb, fc.double({ min: 0, max: 1, noNaN: true }), (c, u) => {
				const { easeOut, easeIn } = cubicToEases(c);
				expect(bezierProgress(u, easeOut, easeIn)).toBeCloseTo(cssCubic(c, u), 6);
			}),
		);
	});
	it('round-trips stored eases exactly', () => {
		fc.assert(
			fc.property(cubicArb, (c) => {
				const { easeOut, easeIn } = cubicToEases(c);
				const back = easesToCubic(easeOut, easeIn);
				expect(back.x1).toBeCloseTo(c.x1, 12);
				expect(back.y1).toBeCloseTo(c.y1, 12);
				expect(back.x2).toBeCloseTo(c.x2, 12);
				expect(back.y2).toBeCloseTo(c.y2, 12);
			}),
		);
	});
	it('Easy Ease is cubic-bezier(1/3, 0, 2/3, 1)', () => {
		const c = easesToCubic({ influence: 1 / 3, slope: 0 }, { influence: 1 / 3, slope: 0 });
		expect(c.x1).toBeCloseTo(1 / 3, 15);
		expect(c.y1).toBe(0);
		expect(c.x2).toBeCloseTo(2 / 3, 15);
		expect(c.y2).toBe(1);
	});
	it('stores a handle at x = 0 at the minimum influence, keeping finite slopes', () => {
		const { easeOut, easeIn } = cubicToEases({ kind: 'cubic', x1: 0, y1: 0.5, x2: 1, y2: 0.5 });
		expect(easeOut.influence).toBe(MIN_EASE_INFLUENCE);
		expect(easeIn.influence).toBe(MIN_EASE_INFLUENCE);
		expect(Number.isFinite(easeOut.slope) && Number.isFinite(easeIn.slope)).toBe(true);
	});
	it('validates multi-segment curves', () => {
		const ok = {
			kind: 'multi',
			points: [
				{ x: 0, y: 0 },
				{ x: 0.6, y: 1.1, in: [0.4, 1.1], out: [0.7, 1.1] },
				{ x: 1, y: 1 },
			],
		};
		expect(EaseCurveSchema.safeParse(ok).success).toBe(true);
		const badEnd = {
			kind: 'multi',
			points: [
				{ x: 0, y: 0 },
				{ x: 0.5, y: 2 },
				{ x: 1, y: 0.9 },
			],
		};
		expect(EaseCurveSchema.safeParse(badEnd).success).toBe(false);
		const badOrder = {
			kind: 'multi',
			points: [
				{ x: 0, y: 0 },
				{ x: 0, y: 2 },
				{ x: 1, y: 1 },
			],
		};
		expect(EaseCurveSchema.safeParse(badOrder).success).toBe(false);
		const badHandle = {
			kind: 'multi',
			points: [
				{ x: 0, y: 0, out: [0.7, 0] },
				{ x: 0.5, y: 2 },
				{ x: 1, y: 1 },
			],
		};
		expect(EaseCurveSchema.safeParse(badHandle).success).toBe(false);
	});
	it('evaluates cubic curves like CSS and multi curves through their points', () => {
		fc.assert(
			fc.property(cubicArb, fc.double({ min: 0, max: 1, noNaN: true }), (c, u) => {
				expect(evaluateEaseCurve(c, u)).toBeCloseTo(cssCubic(c, u), 9);
			}),
		);
		const multi = {
			kind: 'multi' as const,
			points: [
				{ x: 0, y: 0 },
				{ x: 0.5, y: 1.2, in: [0.4, 1.2] as [number, number], out: [0.6, 1.2] as [number, number] },
				{ x: 1, y: 1 },
			],
		};
		expect(evaluateEaseCurve(multi, 0)).toBe(0);
		expect(evaluateEaseCurve(multi, 0.5)).toBeCloseTo(1.2, 12);
		expect(evaluateEaseCurve(multi, 1)).toBe(1);
		expect(evaluateEaseCurve(multi, 0.25)).toBeCloseTo(
			cssCubic({ kind: 'cubic', x1: 1 / 3, y1: 1 / 3, x2: 0.8, y2: 1 }, 0.5) * 1.2,
			9,
		);
		expect(evaluateEaseCurve(multi, Number.NaN)).toBe(0);
	});
});
