// BigInt fixed-point reference: 2^-320 resolution, bisection to 2^-200 on the curve parameter.
// Overlapping-influence samples: EffectCraft crates/keyframe/src/lib.rs
// `temporal_ease_matches_live_ae_with_overlapping_influences`, AE 26.3x87.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type Animatable, bezierProgress, type Ease, evaluate, type Keyframe } from '../src/index.ts';

const S = 320n;
const ONE = 1n << S;

/** Exact `x · 2^S` of a double (truncated below 2^-S). */
function fx(x: number): bigint {
	if (x === 0) return 0n;
	const buf = new DataView(new ArrayBuffer(8));
	buf.setFloat64(0, x);
	const bits = buf.getBigUint64(0);
	const sign = bits >> 63n ? -1n : 1n;
	const expBits = Number((bits >> 52n) & 0x7ffn);
	const frac = bits & ((1n << 52n) - 1n);
	const mant = expBits === 0 ? frac : frac | (1n << 52n);
	const e = BigInt((expBits === 0 ? 1 : expBits) - 1075) + S;
	return sign * (e >= 0n ? mant << e : mant >> -e);
}
const mul = (a: bigint, b: bigint) => (a * b) >> S;

function cubic(p1: bigint, p2: bigint, t: bigint): bigint {
	const s = ONE - t;
	return 3n * mul(mul(mul(s, s), t), p1) + 3n * mul(mul(mul(s, t), t), p2) + mul(mul(t, t), t);
}

/** Exact progress for (u, out, in) — the reference. */
function reference(u: number, out: Ease, inn: Ease): number {
	if (u <= 0) return 0;
	if (u >= 1) return 1;
	const x1 = fx(out.influence);
	const x2 = ONE - fx(inn.influence);
	const U = fx(u);
	let lo = 0n;
	let hi = ONE;
	for (let i = 0; i < 200; i++) {
		const mid = (lo + hi) >> 1n;
		if (cubic(x1, x2, mid) < U) lo = mid;
		else hi = mid;
	}
	const t = (lo + hi) >> 1n;
	const y1 = mul(fx(out.influence), fx(out.slope));
	const y2 = ONE - mul(fx(inn.influence), fx(inn.slope));
	const y = cubic(y1, y2, t);
	return Number(y >> (S - 80n)) / 2 ** 80;
}

const influence = fc.oneof(
	fc.double({ min: 1e-3, max: 1, noNaN: true }),
	fc.constantFrom(1, 1 - 1e-12, 1 - 1e-6, 0.999, 1e-3, 1 / 3, 0.5),
);
const slope = fc.oneof(fc.double({ min: -4, max: 8, noNaN: true }), fc.constantFrom(0, 1, 3, -1));
const ease = fc.record({ influence, slope });

describe('bezierProgress precision (keyframes-blend)', () => {
	it('matches the exact reference to 1e-9 over random eases', () => {
		fc.assert(
			fc.property(fc.double({ min: 0, max: 1, noNaN: true }), ease, ease, (u, out, inn) => {
				const got = bezierProgress(u, out, inn);
				const want = reference(u, out, inn);
				const scale = Math.max(1, Math.abs(out.slope), Math.abs(inn.slope));
				expect(Math.abs(got - want)).toBeLessThanOrEqual(1e-9 * scale);
			}),
			{ numRuns: 3000, seed: 0x5eed },
		);
	});

	it('resolves the flat midpoint of 100 % / 100 % influence (closed form)', () => {
		const full = { influence: 1, slope: 0 };
		for (const u of [0.5 - 1e-9, 0.5 - 1e-12, 0.5, 0.5 + 1e-12, 0.5 + 1e-9, 0.49, 0.51, 0.5 + 1e-4]) {
			// x = ½ + 4(t − ½)³ exactly.
			const t = 0.5 + Math.cbrt((u - 0.5) / 4);
			const want = 3 * (1 - t) * t * t + t * t * t;
			expect(Math.abs(bezierProgress(u, full, full) - want)).toBeLessThan(1e-12);
			expect(Math.abs(bezierProgress(u, full, full) - reference(u, full, full))).toBeLessThan(1e-12);
		}
	});

	it('is accurate next to the flat midpoint (influences just under 100 %)', () => {
		const near = { influence: 1 - 1e-12, slope: 0 };
		for (const u of [0.5 - 1e-13, 0.5, 0.5 + 3e-12, 0.5 + 1e-7, 0.4999])
			expect(Math.abs(bezierProgress(u, near, near) - reference(u, near, near))).toBeLessThan(1e-9);
	});

	it('was the old 1.6e-4 error case: 100 % / 100 % near u = 0.5', () => {
		const full = { influence: 1, slope: 0 };
		let worst = 0;
		for (let i = 0; i <= 2000; i++) {
			const u = 0.49 + (0.02 * i) / 2000;
			worst = Math.max(worst, Math.abs(bezierProgress(u, full, full) - reference(u, full, full)));
		}
		expect(worst).toBeLessThan(1e-12);
	});
});

const SEC = 705_600_000;
function scalar(from: number, to: number, out: Ease, inn: Ease): Animatable<number> {
	const k = (id: string, time: number, value: number): Keyframe<number> => ({
		id,
		time,
		value,
		interpolation: 'bezier',
		easeIn: inn,
		easeOut: out,
	});
	return { value: from, keyframes: [k('kf_a', 0, from), k('kf_b', SEC, to)] };
}

describe('influence overlap above 100 % is not normalised (After Effects)', () => {
	// Live AE samples (Rotation, 0 → 1 s): [from, to, out speed, out influence, in speed, in influence, samples].
	// Our slope is the speed normalised by the segment's average speed: slope = speed × duration / Δvalue.
	const cases: [number, number, number, number, number, number, [number, number][]][] = [
		[
			0,
			100,
			0,
			0.8,
			0,
			0.8,
			[
				[0.1, 0.59243939036327],
				[0.25, 4.76438030608764],
				[0.4, 18.4284394271562],
				[0.75, 95.2356196939123],
			],
		],
		[
			0,
			100,
			20,
			0.8,
			80,
			0.6,
			[
				[0.1, 2.25754942621577],
				[0.25, 6.99841889412931],
				[0.4, 14.9334636959052],
				[0.75, 73.8196785378389],
			],
		],
		[
			100,
			0,
			-20,
			0.6,
			-80,
			0.8,
			[
				[0.1, 97.6395466334594],
				[0.25, 91.597048571292],
				[0.4, 74.5367957474338],
				[0.75, 22.3789127753126],
			],
		],
	];
	it.each(cases)('%d → %d, out %d/%d, in %d/%d', (from, to, os, oi, is, ii, samples) => {
		const dv = to - from;
		const a = scalar(from, to, { influence: oi, slope: os / dv }, { influence: ii, slope: is / dv });
		for (const [t, want] of samples)
			expect(Math.abs(evaluate(a, Math.round(t * SEC)) - want)).toBeLessThan(1e-7);
	});
});
