import { type CubicEase, EaseCurveSchema, evaluateEaseCurve, type MultiEase } from '@jasper/project';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	addPoint,
	curvesEqual,
	dragHandle,
	formatCubicBezier,
	handleRefs,
	LINEAR_EASE_CURVE,
	mirrorCurve,
	parseCubicBezier,
	removePoint,
	setCubicField,
	setPointField,
} from '../src/panels/easing/curve-edit.ts';

const cubic = (x1: number, y1: number, x2: number, y2: number): CubicEase => ({
	kind: 'cubic',
	x1,
	y1,
	x2,
	y2,
});
const free = { alt: false, shift: false };

describe('curve editor: dragging handles', () => {
	it('moves a cubic handle, clamping x to 0…1 and y to the schema limit', () => {
		const c = cubic(0.3, 0, 0.6, 1);
		expect(dragHandle(c, { kind: 'cubic', handle: 1 }, [0.5, 0.2], free, [0.3, 0])).toEqual(
			cubic(0.5, 0.2, 0.6, 1),
		);
		expect(dragHandle(c, { kind: 'cubic', handle: 2 }, [1.7, 42], free, [0.6, 1])).toEqual(
			cubic(0.3, 0, 1, 10),
		);
		expect(dragHandle(c, { kind: 'cubic', handle: 1 }, [-1, Number.NaN], free, [0.3, 0])).toEqual(
			cubic(0, -10, 0.6, 1),
		);
	});

	it('keeps a smooth multi-curve point smooth unless Alt is held', () => {
		const added = addPoint(cubic(0.42, 0, 0.58, 1), 0.5)!;
		const before = added.curve.points[1]!;
		const out = before.out!;
		const moved = dragHandle(
			added.curve,
			{ kind: 'out', index: 1 },
			[out[0], out[1] + 0.2],
			free,
			out,
		) as MultiEase;
		const p = moved.points[1]!;
		const v1 = [p.x - p.in![0], p.y - p.in![1]];
		const v2 = [p.out![0] - p.x, p.out![1] - p.y];
		expect(v1[0]! * v2[1]! - v1[1]! * v2[0]!).toBeCloseTo(0, 6);
		const alt = dragHandle(
			added.curve,
			{ kind: 'out', index: 1 },
			[out[0], out[1] + 0.2],
			{ alt: true, shift: false },
			out,
		) as MultiEase;
		expect(alt.points[1]!.in).toEqual(before.in);
	});

	it('a point carries its handles and stays between its neighbours', () => {
		const { curve } = addPoint(LINEAR_EASE_CURVE, 0.5)!;
		const moved = dragHandle(curve, { kind: 'point', index: 1 }, [2, 0.7], free, [0.5, 0.5]) as MultiEase;
		expect(moved.points[1]!.x).toBeLessThan(1);
		expect(moved.points[1]!.y).toBeCloseTo(0.7, 12);
		expect(EaseCurveSchema.safeParse(moved).success).toBe(true);
		// The end points never move.
		expect(dragHandle(curve, { kind: 'point', index: 0 }, [0.3, 0.3], free, [0, 0])).toBe(curve);
	});
});

describe('curve editor: points', () => {
	it('Ctrl-click on a cubic splits it at the time without changing the shape', () => {
		const c = cubic(0.25, 0.1, 0.25, 1);
		const r = addPoint(c, 0.4)!;
		expect(r.index).toBe(1);
		expect(r.curve.points).toHaveLength(3);
		for (const x of [0.05, 0.2, 0.4, 0.6, 0.9])
			expect(evaluateEaseCurve(r.curve, x)).toBeCloseTo(evaluateEaseCurve(c, x), 6);
		expect(EaseCurveSchema.safeParse(r.curve).success).toBe(true);
	});

	it('refuses a point too close to another one', () => {
		const r = addPoint(cubic(0.25, 0.1, 0.25, 1), 0.4)!;
		expect(addPoint(r.curve, 0.4)).toBeNull();
		expect(addPoint(r.curve, 0)).toBeNull();
		expect(addPoint(r.curve, Number.NaN)).toBeNull();
	});

	it('removing the only interior point gives back a cubic', () => {
		const r = addPoint(cubic(0.25, 0.1, 0.25, 1), 0.4)!;
		const back = removePoint(r.curve, 1);
		expect(back.kind).toBe('cubic');
		expect(EaseCurveSchema.safeParse(back).success).toBe(true);
		const two = addPoint(r.curve, 0.8)!;
		expect(removePoint(two.curve, 1).kind).toBe('multi');
		// End points cannot be removed.
		expect(removePoint(two.curve, 0)).toBe(two.curve);
	});
});

describe('curve editor: mirror, fields, history', () => {
	it('Mirror makes a multi curve point-symmetric from its first half', () => {
		const r = addPoint(cubic(0.6, 0, 0.9, 1.4), 0.3)!;
		const m = mirrorCurve(r.curve);
		expect(EaseCurveSchema.safeParse(m).success).toBe(true);
		for (const x of [0.1, 0.2, 0.35, 0.45])
			expect(evaluateEaseCurve(m, x) + evaluateEaseCurve(m, 1 - x)).toBeCloseTo(1, 6);
	});

	it('numeric fields clamp and ignore non-numbers', () => {
		const c = cubic(0.3, 0, 0.6, 1);
		expect(setCubicField(c, 'x1', 3)).toEqual(cubic(1, 0, 0.6, 1));
		expect(setCubicField(c, 'y2', -30)).toEqual(cubic(0.3, 0, 0.6, -10));
		expect(setCubicField(c, 'y1', Number.NaN)).toBe(c);
		const m = addPoint(c, 0.5)!.curve;
		const set = setPointField(m, 1, 'y', 1.2);
		expect(set.points[1]!.y).toBeCloseTo(1.2, 12);
		expect(setPointField(m, 0, 'x', 0.5)).toBe(m);
		expect(EaseCurveSchema.safeParse(setPointField(m, 1, 'outX', 5)).success).toBe(true);
	});
});

describe('cubic-bezier text', () => {
	it('reads CSS syntax, bare lists and keywords; writes CSS syntax', () => {
		expect(parseCubicBezier('cubic-bezier(0.25, 0.1, 0.25, 1)')).toEqual({
			ok: true,
			curve: cubic(0.25, 0.1, 0.25, 1),
		});
		expect(parseCubicBezier('  CUBIC-BEZIER( .42 , 0 , .58 , 1 );')).toEqual({
			ok: true,
			curve: cubic(0.42, 0, 0.58, 1),
		});
		expect(parseCubicBezier('[0.1, -0.5, 0.2, 1.6]')).toEqual({
			ok: true,
			curve: cubic(0.1, -0.5, 0.2, 1.6),
		});
		expect(parseCubicBezier('0.3 0 0.7 1')).toEqual({ ok: true, curve: cubic(0.3, 0, 0.7, 1) });
		expect(parseCubicBezier('ease-in-out')).toEqual({ ok: true, curve: cubic(0.42, 0, 0.58, 1) });
		expect(formatCubicBezier(cubic(1 / 3, -0, 0.6666, 1))).toBe('cubic-bezier(0.333, 0, 0.667, 1)');
	});

	it.each([
		['', /Enter/],
		['cubic-bezier(0.1, 0.2, 0.3)', /four numbers/],
		['cubic-bezier(1.2, 0, 0.5, 1)', /between 0 and 1/],
		['cubic-bezier(0.2, 0, 0.5, 11)', /between −10 and 10/],
		['cubic-bezier(a, b, c, d)', /four numbers/],
		['cubic-bezier(0x1, 0, 1, 1)', /four numbers/],
		['steps(4)', /four numbers|Enter/],
		['x'.repeat(500), /too long/],
	])('refuses %j', (text, msg) => {
		const r = parseCubicBezier(text);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.error).toMatch(msg);
	});

	it.each(['__proto__', 'constructor', 'toString', 'hasOwnProperty'])(
		'refuses the Object.prototype name %j instead of throwing (regression: keyword is not iterable)',
		(s) => {
			expect(parseCubicBezier(s).ok).toBe(false);
		},
	);

	it('never throws and round-trips what it writes (fuzz)', () => {
		fc.assert(
			fc.property(fc.string({ maxLength: 300 }), (s) => {
				const r = parseCubicBezier(s);
				if (r.ok) expect(EaseCurveSchema.safeParse(r.curve).success).toBe(true);
			}),
		);
		fc.assert(
			fc.property(
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: -10, max: 10, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				fc.double({ min: -10, max: 10, noNaN: true }),
				(x1, y1, x2, y2) => {
					const c = cubic(x1, y1, x2, y2);
					const r = parseCubicBezier(formatCubicBezier(c, 6));
					expect(r.ok).toBe(true);
					if (r.ok) expect(curvesEqual(r.curve, c, 1e-5)).toBe(true);
				},
			),
		);
	});
});

describe('every edit keeps the curve valid (fuzz)', () => {
	const op = fc.oneof(
		fc.record({ t: fc.constant('add' as const), x: fc.double({ min: -0.5, max: 1.5, noNaN: true }) }),
		fc.record({ t: fc.constant('remove' as const), i: fc.integer({ min: 0, max: 10 }) }),
		fc.record({
			t: fc.constant('drag' as const),
			h: fc.integer({ min: 0, max: 30 }),
			x: fc.double({ min: -2, max: 3 }),
			y: fc.double({ min: -20, max: 20 }),
			alt: fc.boolean(),
			shift: fc.boolean(),
		}),
		fc.record({ t: fc.constant('mirror' as const) }),
	);
	it('add / remove / drag / mirror', () => {
		fc.assert(
			fc.property(fc.array(op, { maxLength: 25 }), (ops) => {
				let c: CubicEase | MultiEase = { ...LINEAR_EASE_CURVE };
				for (const o of ops) {
					if (o.t === 'add') c = addPoint(c, o.x)?.curve ?? c;
					else if (o.t === 'remove') c = removePoint(c, o.i) as typeof c;
					else if (o.t === 'mirror') c = mirrorCurve(c) as typeof c;
					else {
						const refs = handleRefs(c);
						const ref = refs[o.h % refs.length]!;
						c = dragHandle(c, ref, [o.x, o.y], { alt: o.alt, shift: o.shift }, [0.5, 0.5]) as typeof c;
					}
					const r = EaseCurveSchema.safeParse(c);
					if (!r.success) throw new Error(`${JSON.stringify(o)} → ${JSON.stringify(c)}: ${r.error.message}`);
				}
			}),
			{ numRuns: 300 },
		);
	});
});
