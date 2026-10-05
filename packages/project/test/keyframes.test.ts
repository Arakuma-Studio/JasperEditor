import { describe, expect, it } from 'vitest';
import { type Animatable, bezierProgress, EASE_PRESETS, evaluate, type Keyframe } from '../src/index.ts';

const kf = <T>(
	id: string,
	time: number,
	value: T,
	interpolation: Keyframe<T>['interpolation'] = 'linear',
	ease = EASE_PRESETS.linear,
): Keyframe<T> => ({
	id,
	time,
	value,
	interpolation,
	easeIn: ease,
	easeOut: ease,
});
const anim = <T>(value: T, keyframes: Keyframe<T>[] = []): Animatable<T> => ({ value, keyframes });

describe('keyframe evaluation (S01:KF-003/004, AC-08)', () => {
	it('returns the static value without keyframes and clamps outside the range', () => {
		expect(evaluate(anim(42), 10)).toBe(42);
		const a = anim(0, [kf('kf_1', 100, 10), kf('kf_2', 200, 20)]);
		expect(evaluate(a, 0)).toBe(10);
		expect(evaluate(a, 300)).toBe(20);
	});
	it('linear at u = 0.5 gives the midpoint (numbers, vectors, colors)', () => {
		expect(evaluate(anim(0, [kf('kf_1', 0, 0), kf('kf_2', 100, 100)]), 50)).toBe(50);
		expect(
			evaluate(anim<[number, number]>([0, 0], [kf('kf_1', 0, [0, 10]), kf('kf_2', 100, [100, 30])]), 50),
		).toEqual([50, 20]);
		const c = evaluate(
			anim<[number, number, number, number]>(
				[0, 0, 0, 1],
				[kf('kf_1', 0, [1, 0, 0, 1]), kf('kf_2', 100, [0, 0, 1, 1])],
			),
			50,
		);
		expect(c).toEqual([0.5, 0, 0.5, 1]);
	});

	it('linear preset equals p = u', () => {
		for (const u of [0, 0.1, 0.33, 0.5, 0.77, 1])
			expect(bezierProgress(u, EASE_PRESETS.linear, EASE_PRESETS.linear)).toBeCloseTo(u, 6);
	});
	it('hold gives a step', () => {
		const a = anim(0, [kf('kf_1', 0, 0, 'hold'), kf('kf_2', 100, 100)]);
		expect(evaluate(a, 0)).toBe(0);
		expect(evaluate(a, 99)).toBe(0);
		expect(evaluate(a, 100)).toBe(100);
	});
	it('hold-only value types step regardless of interpolation (S01:KF-007)', () => {
		const a = anim('a', [kf('kf_1', 0, 'a'), kf('kf_2', 100, 'b')]);
		expect(evaluate(a, 60)).toBe('a');
		expect(evaluate(anim(false, [kf('kf_1', 0, false), kf('kf_2', 100, true)]), 99)).toBe(false);
	});
	it('auto-bezier on a local maximum does not overshoot', () => {
		const a = anim(0, [
			kf('kf_1', 0, 0, 'auto-bezier'),
			kf('kf_2', 100, 100, 'auto-bezier'),
			kf('kf_3', 200, 0, 'auto-bezier'),
		]);
		let max = Number.NEGATIVE_INFINITY;
		for (let t = 0; t <= 200; t++) max = Math.max(max, evaluate(a, t));
		expect(max).toBeLessThanOrEqual(100 + 1e-9);
	});
	it('auto-bezier keeps a monotonic ramp smooth and bounded', () => {
		const a = anim(0, [
			kf('kf_1', 0, 0, 'auto-bezier'),
			kf('kf_2', 100, 50, 'auto-bezier'),
			kf('kf_3', 200, 100, 'auto-bezier'),
		]);
		let prev = -1;
		for (let t = 0; t <= 200; t += 5) {
			const v = evaluate(a, t);
			expect(v).toBeGreaterThanOrEqual(prev);
			expect(v).toBeLessThanOrEqual(100);
			prev = v;
		}
	});
	it('overshooting eases are clamped to the parameter range when asked', () => {
		const k1 = { ...kf('kf_1', 0, 0, 'bezier'), easeOut: { influence: 1, slope: 3 } };
		const k2 = { ...kf('kf_2', 100, 100, 'bezier'), easeIn: { influence: 1 / 3, slope: 3 } };
		const a = anim(0, [k1, k2]);
		const raw = Math.max(...Array.from({ length: 101 }, (_, t) => evaluate(a, t)));
		expect(raw).toBeGreaterThan(100);
		expect(
			Math.max(...Array.from({ length: 101 }, (_, t) => evaluate(a, t, { clamp: { min: 0, max: 100 } }))),
		).toBe(100);
	});
	it('matches a table of reference values', () => {
		const e = EASE_PRESETS.easy;
		const table: [number, number][] = [
			[0, 0],
			[0.25, 0.156],
			[0.5, 0.5],
			[0.75, 0.844],
			[1, 1],
		];
		for (const [u, p] of table) expect(bezierProgress(u, e, e)).toBeCloseTo(p, 3);
	});
});
