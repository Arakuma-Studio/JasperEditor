// keyframe-sides: per-key incoming / outgoing temporal interpolation (docs/wp-notes/keyframe-sides.md).
// - Documents without `inInterpolation` evaluate bit-identically to the evaluator before this change: a golden
//   recorded from that evaluator (fixtures/keyframe-sides/legacy-evaluation.json: numbers, vec2, curved spatial
//   paths, roving runs, every interpolation).
// - Per-side segments match After Effects' cubic Bézier in (time, value) built from each side's speed and influence,
//   computed independently here (control points in value units, bisection on the time curve).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	type Ease,
	evaluate,
	evaluateKeyframes,
	type Interpolation,
	type Keyframe,
} from '../src/index.ts';

const golden = JSON.parse(
	readFileSync(new URL('./fixtures/keyframe-sides/legacy-evaluation.json', import.meta.url), 'utf8'),
) as { docs: { kind: string; anim: Animatable<unknown>; times: number[]; values: unknown[] }[] };

const LIN: Ease = { influence: 1 / 3, slope: 1 };
const key = (
	time: number,
	value: number,
	interpolation: Interpolation,
	extra: Partial<Keyframe<number>> = {},
): Keyframe<number> => ({
	id: `k${time}`,
	time,
	value,
	interpolation,
	easeIn: { ...LIN },
	easeOut: { ...LIN },
	...extra,
});

/**
 * After Effects' segment, independently: the cubic Bézier through (t0, v0), (t0 + I₀·T, v0 + S₀·I₀·T),
 * (t1 − I₁·T, v1 − S₁·I₁·T), (t1, v1) with speeds S in value units per flick and influences I; a Linear side has
 * I = ⅙ and S = the segment's average speed. Solved by bisection on the time curve.
 */
function aeSegment(
	a: { t: number; v: number; inf: number; speed: number },
	b: { t: number; v: number; inf: number; speed: number },
	t: number,
): number {
	const T = b.t - a.t;
	const p1 = [a.t + a.inf * T, a.v + a.speed * a.inf * T];
	const p2 = [b.t - b.inf * T, b.v - b.speed * b.inf * T];
	const bez = (s: number, c0: number, c1: number, c2: number, c3: number) =>
		(1 - s) ** 3 * c0 + 3 * (1 - s) ** 2 * s * c1 + 3 * (1 - s) * s * s * c2 + s ** 3 * c3;
	let lo = 0;
	let hi = 1;
	for (let n = 0; n < 200; n++) {
		const mid = (lo + hi) / 2;
		if (bez(mid, a.t, p1[0]!, p2[0]!, b.t) < t) lo = mid;
		else hi = mid;
	}
	const s = (lo + hi) / 2;
	return bez(s, a.v, p1[1]!, p2[1]!, b.v);
}

describe('keyframe-sides: documents without inInterpolation evaluate as before', () => {
	it('matches the golden recorded from the previous evaluator bit for bit', () => {
		for (const d of golden.docs) {
			d.times.forEach((t, j) => {
				expect(evaluateKeyframes(d.anim, t), `${d.kind} ${d.anim.keyframes[0]!.id} t=${t}`).toEqual(
					d.values[j],
				);
			});
		}
	});
});

describe('keyframe-sides: per-side segments (After Effects)', () => {
	const sideArb = fc.record({
		type: fc.constantFrom<'linear' | 'bezier'>('linear', 'bezier'),
		influence: fc.double({ min: 0.05, max: 1, noNaN: true }),
		slope: fc.double({ min: -2, max: 4, noNaN: true }),
	});

	it('property: a mixed segment is the After Effects cubic of both sides', () => {
		fc.assert(
			fc.property(
				sideArb,
				sideArb,
				fc.integer({ min: 10, max: 500_000 }),
				fc.double({ min: -500, max: 500, noNaN: true }),
				fc.double({ min: -500, max: 500, noNaN: true }),
				fc.double({ min: 0, max: 1, noNaN: true }),
				(out, inn, T, v0, v1, u) => {
					fc.pre(Math.abs(v1 - v0) > 1e-3);
					const a = key(1000, v0, out.type, { easeOut: { influence: out.influence, slope: out.slope } });
					const b = key(1000 + T, v1, 'linear', {
						inInterpolation: inn.type,
						easeIn: { influence: inn.influence, slope: inn.slope },
					});
					const avg = (v1 - v0) / T;
					const side = (s: typeof out, t: number, v: number) =>
						s.type === 'linear'
							? { t, v, inf: 1 / 6, speed: avg }
							: { t, v, inf: s.influence, speed: s.slope * avg };
					const t = 1000 + u * T;
					const got = evaluate({ value: v0, keyframes: [a, b] }, t);
					const want =
						out.type === 'linear' && inn.type === 'linear'
							? v0 + u * (v1 - v0)
							: aeSegment(side(out, 1000, v0), side(inn, 1000 + T, v1), t);
					expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(v1 - v0)) * 4);
				},
			),
			{ numRuns: 600 },
		);
	});

	it('two explicit Linear sides are exactly linear; a Hold outgoing side holds whatever the incoming side', () => {
		const lin = [key(0, 0, 'linear'), key(100, 50, 'linear', { inInterpolation: 'linear' })];
		expect(evaluate({ value: 0, keyframes: lin }, 37)).toBe(18.5);
		const hold = [
			key(0, 0, 'hold'),
			key(100, 50, 'linear', { inInterpolation: 'bezier', easeIn: { influence: 1, slope: 0 } }),
		];
		expect(evaluate({ value: 0, keyframes: hold }, 99)).toBe(0);
	});

	it('Auto Bezier at an extremum has zero speed in both per-side segments', () => {
		const kfs = [
			key(0, 0, 'linear'),
			key(100, 80, 'auto-bezier', { inInterpolation: 'auto-bezier' }),
			key(250, 20, 'linear', { inInterpolation: 'linear' }),
		];
		// The middle value is a local maximum, so Auto Bezier has zero speed on both sides.
		for (const [at, a, b] of [
			[50, { t: 0, v: 0, inf: 1 / 6, speed: 0.8 }, { t: 100, v: 80, inf: 1 / 3, speed: 0 }],
			[175, { t: 100, v: 80, inf: 1 / 3, speed: 0 }, { t: 250, v: 20, inf: 1 / 6, speed: -0.4 }],
		] as const) {
			expect(evaluate({ value: 0, keyframes: kfs }, at)).toBeCloseTo(aeSegment(a, b, at), 9);
		}
	});

	it('roving runs use the fixed keys’ sides (per side when the end key is explicit)', () => {
		const kfs: Keyframe<number>[] = [
			key(0, 0, 'linear'),
			key(100, 40, 'linear', { roving: true }),
			key(300, 100, 'linear', { inInterpolation: 'bezier', easeIn: { influence: 1 / 3, slope: 0 } }),
		];
		for (const at of [60, 150, 240]) {
			const want = aeSegment(
				{ t: 0, v: 0, inf: 1 / 6, speed: 100 / 300 },
				{ t: 300, v: 100, inf: 1 / 3, speed: 0 },
				at,
			);
			expect(evaluate({ value: 0, keyframes: kfs }, at)).toBeCloseTo(want, 9);
		}
	});
});
