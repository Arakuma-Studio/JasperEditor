// keyframe-sides: per-key incoming / outgoing temporal interpolation (docs/wp-notes/keyframe-sides.md).
// - Documents without `inInterpolation` evaluate bit-identically to the evaluator before this change: a golden
//   recorded from that evaluator (fixtures/keyframe-sides/legacy-evaluation.json: numbers, vec2, curved spatial
//   paths, roving runs, every interpolation) and a fast-check property against the legacy formula.
// - Per-side segments match After Effects' cubic Bézier in (time, value) built from each side's speed and influence,
//   computed independently here (control points in value units, bisection on the time curve).
import { readFileSync } from 'node:fs';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Animatable,
	autoSlope,
	bezierProgress,
	type Ease,
	effectiveInInterpolation,
	evaluate,
	evaluateKeyframes,
	type InInterpolation,
	type Interpolation,
	incomingEase,
	type Keyframe,
	keySidesIssue,
	normalizeKeySides,
	outgoingEase,
	reversedKeyTiming,
	rovingProgress,
	rovingRuns,
	segmentShape,
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

/** The legacy outgoing / incoming eases and segment progress, verbatim from the evaluator before keyframe-sides. */
function legacyOut(kfs: readonly Keyframe<number>[], i: number): Ease {
	const k = kfs[i]!;
	if (k.interpolation === 'auto-bezier') return { influence: 1 / 3, slope: autoSlope(kfs, i, 'out') };
	if (k.interpolation === 'linear') return LIN;
	return k.easeOut;
}
function legacyIn(kfs: readonly Keyframe<number>[], i: number): Ease {
	const k = kfs[i]!;
	if (k.interpolation === 'auto-bezier') return { influence: 1 / 3, slope: autoSlope(kfs, i, 'in') };
	if (k.interpolation === 'linear') return LIN;
	return k.easeIn;
}
function legacyValue(kfs: readonly Keyframe<number>[], t: number): number {
	if (t <= kfs[0]!.time) return kfs[0]!.value;
	if (t >= kfs[kfs.length - 1]!.time) return kfs[kfs.length - 1]!.value;
	let i = 0;
	while (kfs[i + 1]!.time <= t) i++;
	const a = kfs[i]!;
	const b = kfs[i + 1]!;
	if (a.interpolation === 'hold') return a.value;
	const u = (t - a.time) / (b.time - a.time);
	const p = a.interpolation === 'linear' ? u : bezierProgress(u, legacyOut(kfs, i), legacyIn(kfs, i + 1));
	return a.value + p * (b.value - a.value);
}

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
		let n = 0;
		for (const d of golden.docs) {
			d.times.forEach((t, j) => {
				expect(evaluateKeyframes(d.anim, t), `${d.kind} ${d.anim.keyframes[0]!.id} t=${t}`).toEqual(
					d.values[j],
				);
				n++;
			});
		}
		expect(golden.docs.some((d) => d.anim.keyframes.some((k) => k.roving))).toBe(true);
		expect(golden.docs.some((d) => d.anim.keyframes.some((k) => k.spatial))).toBe(true);
		expect(n).toBeGreaterThan(1500);
	});

	const interp = fc.constantFrom<Interpolation>(
		'linear',
		'bezier',
		'auto-bezier',
		'continuous-bezier',
		'hold',
	);
	const ease = fc.record({
		influence: fc.double({ min: 0.01, max: 1, noNaN: true }),
		slope: fc.double({ min: -3, max: 5, noNaN: true }),
	});
	const legacyDoc = fc
		.array(
			fc.record({
				gap: fc.integer({ min: 1, max: 100_000 }),
				value: fc.double({ min: -1000, max: 1000, noNaN: true }),
				interpolation: interp,
				easeIn: ease,
				easeOut: ease,
			}),
			{ minLength: 2, maxLength: 7 },
		)
		.map((ks) => {
			let t = 0;
			return ks.map((k, i) => {
				t += k.gap;
				return {
					id: `k${i}`,
					time: t,
					value: k.value,
					interpolation: k.interpolation,
					easeIn: k.easeIn,
					easeOut: k.easeOut,
				} satisfies Keyframe<number>;
			});
		});

	it('property: every sample equals the legacy formula exactly (Object.is)', () => {
		fc.assert(
			fc.property(
				legacyDoc,
				fc.array(fc.double({ min: 0, max: 1, noNaN: true }), { maxLength: 12 }),
				(kfs, us) => {
					const anim = { value: 0, keyframes: kfs };
					const t0 = kfs[0]!.time;
					const t1 = kfs[kfs.length - 1]!.time;
					for (const u of us) {
						const t = t0 + u * (t1 - t0);
						expect(Object.is(evaluate(anim, t), legacyValue(kfs, t))).toBe(true);
					}
					for (let i = 0; i < kfs.length - 1; i++) {
						expect(outgoingEase(kfs, i)).toEqual(legacyOut(kfs, i));
						expect(incomingEase(kfs, i + 1)).toEqual(legacyIn(kfs, i + 1));
					}
				},
			),
			{ numRuns: 400 },
		);
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

	it("Premiere's Ease In after a Linear key: (⅙, ⅙) and (⅔, 1) — the eased side now counts", () => {
		const kfs = [
			key(0, 0, 'linear'),
			key(300, 100, 'linear', { inInterpolation: 'bezier', easeIn: { influence: 1 / 3, slope: 0 } }),
		];
		const anim = { value: 0, keyframes: kfs };
		expect(segmentShape(kfs, 0)).toEqual({
			out: { influence: 1 / 6, slope: 1 },
			in: { influence: 1 / 3, slope: 0 },
		});
		for (const u of [0.1, 0.25, 0.5, 0.75, 0.9]) {
			const want = aeSegment(
				{ t: 0, v: 0, inf: 1 / 6, speed: 100 / 300 },
				{ t: 300, v: 100, inf: 1 / 3, speed: 0 },
				u * 300,
			);
			expect(evaluate(anim, u * 300)).toBeCloseTo(want, 9);
		}
		// It decelerates into the key (above the straight line), unlike the legacy reading of the same values.
		expect(evaluate(anim, 150)).toBeGreaterThan(50);
		const legacy = {
			value: 0,
			keyframes: [key(0, 0, 'linear'), key(300, 100, 'bezier', { easeIn: { influence: 1 / 3, slope: 0 } })],
		};
		expect(evaluate(legacy, 150)).toBe(50);
	});

	it('Ease Out (bezier out) into a Linear incoming side uses ⅙ for the linear side', () => {
		const kfs = [
			key(0, 10, 'bezier', { inInterpolation: 'linear', easeOut: { influence: 1 / 3, slope: 0 } }),
			key(600, 70, 'linear', { inInterpolation: 'linear' }),
		];
		expect(segmentShape(kfs, 0)).toEqual({
			out: { influence: 1 / 3, slope: 0 },
			in: { influence: 1 / 6, slope: 1 },
		});
		const want = aeSegment(
			{ t: 0, v: 10, inf: 1 / 3, speed: 0 },
			{ t: 600, v: 70, inf: 1 / 6, speed: 60 / 600 },
			200,
		);
		expect(evaluate({ value: 0, keyframes: kfs }, 200)).toBeCloseTo(want, 9);
	});

	it('two explicit Linear sides are exactly linear; a Hold outgoing side holds whatever the incoming side', () => {
		const lin = [key(0, 0, 'linear'), key(100, 50, 'linear', { inInterpolation: 'linear' })];
		expect(segmentShape(lin, 0)).toBe('linear');
		expect(evaluate({ value: 0, keyframes: lin }, 37)).toBe(18.5);
		const hold = [
			key(0, 0, 'hold'),
			key(100, 50, 'linear', { inInterpolation: 'bezier', easeIn: { influence: 1, slope: 0 } }),
		];
		expect(segmentShape(hold, 0)).toBe('hold');
		expect(evaluate({ value: 0, keyframes: hold }, 99)).toBe(0);
		expect(effectiveInInterpolation(hold, 1)).toBe('hold');
	});

	it('Auto Bezier sides keep their computed ease in per-side segments', () => {
		const kfs = [
			key(0, 0, 'linear'),
			key(100, 80, 'auto-bezier', { inInterpolation: 'auto-bezier' }),
			key(250, 20, 'linear', { inInterpolation: 'linear' }),
		];
		const s = segmentShape(kfs, 0);
		expect(s).not.toBe('linear');
		expect(s).toMatchObject({
			out: { influence: 1 / 6, slope: 1 },
			in: { influence: 1 / 3, slope: autoSlope(kfs, 1, 'in') },
		});
		expect(segmentShape(kfs, 1)).toMatchObject({
			out: { influence: 1 / 3, slope: autoSlope(kfs, 1, 'out') },
			in: { influence: 1 / 6 },
		});
	});

	it('effectiveInInterpolation reads legacy keys after a Linear key as linear', () => {
		const kfs = [
			key(0, 0, 'linear'),
			key(100, 1, 'bezier'),
			key(200, 2, 'bezier', { inInterpolation: 'linear' }),
		];
		expect(effectiveInInterpolation(kfs, 0)).toBeNull();
		expect(effectiveInInterpolation(kfs, 1)).toBe('linear');
		expect(effectiveInInterpolation(kfs, 2)).toBe('linear');
	});

	it('roving runs use the fixed keys’ sides (per side when the end key is explicit)', () => {
		const kfs: Keyframe<number>[] = [
			key(0, 0, 'linear'),
			key(100, 40, 'linear', { roving: true }),
			key(300, 100, 'linear', { inInterpolation: 'bezier', easeIn: { influence: 1 / 3, slope: 0 } }),
		];
		const [run] = rovingRuns(kfs as Keyframe<unknown>[]);
		expect(run).toMatchObject({ a: 0, b: 2 });
		for (const u of [0.2, 0.5, 0.8])
			expect(rovingProgress(kfs as Keyframe<unknown>[], run!, u)).toBe(
				bezierProgress(u, { influence: 1 / 6, slope: 1 }, { influence: 1 / 3, slope: 0 }),
			);
	});

	it('reversal mirrors a mixed segment exactly (as legacy Bezier keys)', () => {
		const kfs: Keyframe<number>[] = [
			key(0, 0, 'linear'),
			key(300, 100, 'linear', { inInterpolation: 'bezier', easeIn: { influence: 0.5, slope: 0.2 } }),
		];
		const rev = [...kfs]
			.reverse()
			.map((k, j) => ({
				...k,
				...reversedKeyTiming(kfs as Keyframe<unknown>[], kfs.length - 1 - j),
				time: 300 - k.time,
			}))
			.map((k) => {
				const { inInterpolation: _drop, ...rest } = k;
				return rest as Keyframe<number>;
			});
		for (const t of [30, 120, 151, 270])
			expect(evaluate({ value: 0, keyframes: rev }, 300 - t)).toBeCloseTo(
				evaluate({ value: 0, keyframes: kfs }, t),
				9,
			);
	});
});

describe('keyframe-sides: validation and repair helpers', () => {
	it('keySidesIssue flags unknown and inconsistent incoming types', () => {
		expect(keySidesIssue({ interpolation: 'linear' })).toBeNull();
		expect(keySidesIssue({ interpolation: 'linear', inInterpolation: 'bezier' })).toBeNull();
		expect(keySidesIssue({ interpolation: 'hold', inInterpolation: 'linear' })).toBeNull();
		expect(keySidesIssue({ interpolation: 'auto-bezier', inInterpolation: 'auto-bezier' })).toBeNull();
		expect(keySidesIssue({ interpolation: 'linear', inInterpolation: 'hold' })).toMatch(/unknown/);
		expect(keySidesIssue({ interpolation: 'linear', inInterpolation: 7 })).toMatch(/unknown/);
		expect(keySidesIssue({ interpolation: 'auto-bezier', inInterpolation: 'linear' })).toMatch(/both sides/);
		expect(keySidesIssue({ interpolation: 'bezier', inInterpolation: 'continuous-bezier' })).toMatch(
			/both sides/,
		);
	});

	it('normalizeKeySides drops unknown types and turns one-sided Auto / Continuous into Bezier', () => {
		const a = { interpolation: 'linear' as Interpolation, inInterpolation: 'hold' as unknown };
		expect(normalizeKeySides(a)).toBe(true);
		expect('inInterpolation' in a).toBe(false);
		const b = { interpolation: 'auto-bezier' as Interpolation, inInterpolation: 'linear' as InInterpolation };
		expect(normalizeKeySides(b)).toBe(true);
		expect(b).toEqual({ interpolation: 'bezier', inInterpolation: 'linear' });
		const c = {
			interpolation: 'hold' as Interpolation,
			inInterpolation: 'continuous-bezier' as InInterpolation,
		};
		expect(normalizeKeySides(c)).toBe(true);
		expect(c).toEqual({ interpolation: 'hold', inInterpolation: 'bezier' });
		const d = { interpolation: 'bezier' as Interpolation, inInterpolation: 'linear' as InInterpolation };
		expect(normalizeKeySides(d)).toBe(false);
		fc.assert(
			fc.property(
				fc.constantFrom<Interpolation>('linear', 'bezier', 'auto-bezier', 'continuous-bezier', 'hold'),
				fc.oneof(
					fc.constantFrom<unknown>(
						undefined,
						'linear',
						'bezier',
						'auto-bezier',
						'continuous-bezier',
						'hold',
						3,
						null,
					),
					fc.string(),
				),
				(interpolation, inInterpolation) => {
					const k = { interpolation, inInterpolation };
					normalizeKeySides(k);
					expect(keySidesIssue(k)).toBeNull();
					expect(normalizeKeySides(k)).toBe(false);
				},
			),
		);
	});
});
