import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
	type Ease,
	evaluate,
	type Interpolation,
	type Keyframe,
	type SimplifyValue,
	simplifyKeyframes,
} from '../src/index.ts';

const LIN: Ease = { influence: 1 / 3, slope: 1 };
const STEP = 1000;

function key(
	i: number,
	value: SimplifyValue,
	interpolation: Interpolation = 'linear',
	e?: [Ease, Ease],
): Keyframe<SimplifyValue> {
	return {
		id: `kf_${i}`,
		time: i * STEP,
		value,
		interpolation,
		easeIn: e ? e[0] : { ...LIN },
		easeOut: e ? e[1] : { ...LIN },
	};
}

const anim = (keys: Keyframe<SimplifyValue>[]) => ({ value: keys[0]!.value, keyframes: keys });
const vec = (v: SimplifyValue) => (typeof v === 'number' ? [v] : v);
const dist = (a: SimplifyValue, b: SimplifyValue) => {
	const x = vec(a);
	const y = vec(b);
	return Math.sqrt(x.reduce((s, v, i) => s + (v - y[i]!) ** 2, 0));
};

/** Sample times: every frame (STEP) plus a sub-frame grid (STEP/4) over [t0, t1]. */
function sampleTimes(t0: number, t1: number, sub = 1): number[] {
	const out: number[] = [];
	for (let t = t0; t <= t1 + 1e-9; t += STEP / sub) out.push(t);
	return out;
}

/** Runs the solver on one channel with the value distance and checks the guarantee with the evaluator. */
function solveOne(
	keys: Keyframe<SimplifyValue>[],
	tol: number,
	opts: { span?: [number, number]; sub?: number } = {},
) {
	const span = opts.span ?? [0, keys.length - 1];
	const times = sampleTimes(keys[0]!.time - 3 * STEP, keys.at(-1)!.time + 3 * STEP, opts.sub ?? 1);
	const orig = times.map((t) => evaluate(anim(keys), t));
	const r = simplifyKeyframes({
		channels: [{ keys, span }],
		times,
		tolerance: tol,
		deviation: (s, values) => {
			const o = vec(orig[s]!);
			return Math.sqrt(o.reduce((acc, v, d) => acc + (values[0]![d]! - v) ** 2, 0));
		},
	});
	const out = r.keys[0]!;
	for (let s = 0; s < times.length; s++) {
		expect(dist(evaluate(anim(out), times[s]!), orig[s]!)).toBeLessThanOrEqual(tol);
	}
	return { r, out, times, orig };
}

const valueArb = (dim: 1 | 2) =>
	dim === 1
		? fc.double({ min: -500, max: 500, noNaN: true })
		: fc.tuple(
				fc.double({ min: -500, max: 500, noNaN: true }),
				fc.double({ min: -500, max: 500, noNaN: true }),
			);

describe('simplifyKeyframes', () => {
	it('keeps every frame within the tolerance on random dense tracks (scalar and vec2)', () => {
		fc.assert(
			fc.property(
				fc.integer({ min: 3, max: 120 }),
				fc.constantFrom<1 | 2>(1, 2),
				fc.double({ min: 0.01, max: 5, noNaN: true }),
				fc.integer({ min: 0, max: 1_000_000 }),
				(n, dim, tol, seed) => {
					// Smooth random walk plus jitter (tracking-like).
					let rnd = seed;
					const next = () => {
						rnd = (rnd * 1103515245 + 12345) % 2147483648;
						return rnd / 2147483648 - 0.5;
					};
					const pos = [0, 0];
					const vel = [next() * 4, next() * 4];
					const keys = Array.from({ length: n }, (_, i) => {
						for (let d = 0; d < 2; d++) {
							vel[d]! += next() * 0.8;
							pos[d]! += vel[d]! + next() * 0.3;
						}
						return key(i, dim === 1 ? pos[0]! : [pos[0]!, pos[1]!]);
					});
					const { r, out } = solveOne(keys, tol);
					expect(out.length).toBeLessThanOrEqual(n);
					expect(r.maxError).toBeLessThanOrEqual(tol);
					// Kept keys are original keys with the same id, time and value; the ends stay.
					const byId = new Map(keys.map((k) => [k.id, k]));
					for (const k of out) {
						const o = byId.get(k.id)!;
						expect(o).toBeDefined();
						expect(k.time).toBe(o.time);
						expect(k.value).toEqual(o.value);
					}
					expect(out[0]!.id).toBe(keys[0]!.id);
					expect(out.at(-1)!.id).toBe(keys.at(-1)!.id);
				},
			),
			{ numRuns: 150 },
		);
	});

	it('honours mixed interpolations (bezier, auto-bezier, hold) at sub-frame samples, inside and outside a span', () => {
		const interps: Interpolation[] = ['linear', 'bezier', 'auto-bezier', 'continuous-bezier', 'hold'];
		fc.assert(
			fc.property(
				fc.array(
					fc.record({
						v: valueArb(1),
						interp: fc.constantFrom(...interps),
						ein: fc.record({
							influence: fc.double({ min: 0.05, max: 1, noNaN: true }),
							slope: fc.double({ min: 0, max: 3, noNaN: true }),
						}),
						eout: fc.record({
							influence: fc.double({ min: 0.05, max: 1, noNaN: true }),
							slope: fc.double({ min: 0, max: 3, noNaN: true }),
						}),
					}),
					{ minLength: 4, maxLength: 40 },
				),
				fc.double({ min: 0.05, max: 20, noNaN: true }),
				fc.integer({ min: 0, max: 100 }),
				fc.integer({ min: 0, max: 100 }),
				(spec, tol, aPct, bPct) => {
					const keys = spec.map((s, i) => key(i, s.v, s.interp, [s.ein, s.eout]));
					let a = Math.floor((aPct / 100) * (keys.length - 1));
					let b = Math.floor((bPct / 100) * (keys.length - 1));
					if (a > b) [a, b] = [b, a];
					const { out, times, orig } = solveOne(keys, tol, { span: [a, b], sub: 4 });
					// Outside the span (before key a and after key b) the animation is exactly the original.
					for (let s = 0; s < times.length; s++) {
						const t = times[s]!;
						if (t <= keys[a]!.time || t >= keys[b]!.time)
							expect(dist(evaluate(anim(out), t), orig[s]!)).toBeLessThan(1e-6);
					}
					expect(out.slice(0, a)).toEqual(keys.slice(0, a));
					expect(out.slice(out.length - (keys.length - 1 - b))).toEqual(keys.slice(b + 1));
				},
			),
			{ numRuns: 300 },
		);
	});

	it('keeps locked (unselected) keys inside the span', () => {
		const keys = Array.from({ length: 30 }, (_, i) => key(i, i * 2));
		const r = simplifyKeyframes({
			channels: [{ keys, span: [0, 29], locked: new Set([10, 20]) }],
			times: sampleTimes(0, 29 * STEP),
			tolerance: 0.1,
			deviation: (s, v) => Math.abs(v[0]![0]! - s * 2),
		});
		expect(r.keys[0]!.map((k) => k.id)).toEqual(['kf_0', 'kf_10', 'kf_20', 'kf_29']);
	});

	it('reduces a smooth per-frame curve to few keys and fits eases', () => {
		// 300 frames of a slow sine (amplitude 100 px) sampled per frame as linear keys.
		const keys = Array.from({ length: 300 }, (_, i) => key(i, 100 * Math.sin((i / 299) * Math.PI * 2)));
		const { out } = solveOne(keys, 0.1);
		expect(out.length).toBeLessThan(keys.length);
		// A single ease-in-out move (Easy Ease) sampled per frame collapses to its two keys.
		const ease: Ease = { influence: 1 / 3, slope: 0.4 };
		const src = [key(0, 0, 'bezier', [ease, ease]), key(60, 500, 'bezier', [ease, ease])];
		const dense = Array.from({ length: 61 }, (_, i) => key(i, evaluate(anim(src), i * STEP)));
		const r2 = solveOne(dense, 0.05);
		expect(r2.out.length).toBeLessThan(dense.length);
	});

	it('solves channels with shared key times jointly and others with a share of the tolerance', () => {
		// Two channels with shared times + one with different times; deviation = sum of the three distances.
		const a = Array.from({ length: 50 }, (_, i) => key(i, Math.sin(i / 7) * 30));
		const b = Array.from({ length: 50 }, (_, i) => key(i, Math.cos(i / 9) * 20));
		const c = Array.from({ length: 25 }, (_, i) => ({ ...key(i, (i * i) / 10), time: i * 2 * STEP }));
		const times = sampleTimes(0, 49 * STEP);
		const ev = (k: Keyframe<SimplifyValue>[], t: number) => evaluate(anim(k), t) as number;
		const orig = [a, b, c].map((k) => times.map((t) => ev(k, t)));
		const tol = 0.5;
		const r = simplifyKeyframes({
			channels: [a, b, c].map((keys) => ({ keys, span: [0, keys.length - 1] as [number, number] })),
			times,
			tolerance: tol,
			deviation: (s, v) => [0, 1, 2].reduce((sum, ch) => sum + Math.abs(v[ch]![0]! - orig[ch]![s]!), 0),
		});
		for (let s = 0; s < times.length; s++) {
			const e = [0, 1, 2].reduce((sum, ch) => sum + Math.abs(ev(r.keys[ch]!, times[s]!) - orig[ch]![s]!), 0);
			expect(e).toBeLessThanOrEqual(tol);
		}
		expect(r.after[0]!).toBeLessThan(50);
		expect(r.after[2]!).toBeLessThan(25);
	});
});
