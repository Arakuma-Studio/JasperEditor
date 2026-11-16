// Sound segments (Decorate Cuts' whooshes cut from a media; wp-note edit-automation "Decorate Cuts inputs"): slow
// swells separated by quiet are found one each, over a noise floor; any input gives ordered, disjoint segments.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { soundSegments } from '../src/index.ts';

const SR = 16_000;

/** Low noise with rising-then-falling tone swells: [peak s, width s]. */
function swells(seconds: number, at: [number, number][]): Float32Array {
	const x = new Float32Array(Math.round(seconds * SR));
	let s = 3;
	for (let i = 0; i < x.length; i++) {
		s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
		x[i] = ((s >>> 8) / (1 << 24) - 0.5) * 0.002;
	}
	for (const [peak, width] of at) {
		const a = Math.round((peak - width / 2) * SR);
		const p = Math.round(peak * SR);
		const b = Math.round((peak + width / 2) * SR);
		for (let i = a; i < b; i++) {
			const env = i <= p ? (i - a) / (p - a) : (b - i) / (b - p);
			x[i]! += 0.7 * env * env * Math.sin((2 * Math.PI * 500 * i) / SR);
		}
	}
	return x;
}

describe('soundSegments', () => {
	it('finds each swell between quiet stretches, covering its loud part', () => {
		const at: [number, number][] = [
			[1, 0.6],
			[2.5, 1.2],
			[4.2, 0.4],
		];
		const segs = soundSegments([swells(5, at)], SR);
		expect(segs).toHaveLength(3);
		segs.forEach((g, i) => {
			const [peak, width] = at[i]!;
			expect(g.startSample / SR).toBeLessThan(peak - width / 4);
			expect(g.endSample / SR).toBeGreaterThan(peak + width / 4);
			expect(g.startSample / SR).toBeGreaterThan(peak - width / 2 - 0.05);
			expect(g.endSample / SR).toBeLessThan(peak + width / 2 + 0.05);
		});
		expect(soundSegments([new Float32Array(SR)], SR)).toEqual([]);
	});

	it('property: ordered, disjoint, inside the input; never throws', () => {
		fc.assert(
			fc.property(
				fc.array(fc.float({ noNaN: false, min: -2, max: 2 }), { maxLength: 4000 }),
				fc.constantFrom(8000, 16_000, 44_100, 12),
				(xs, rate) => {
					const segs = soundSegments([Float32Array.from(xs)], rate);
					let prev = 0;
					for (const g of segs) {
						expect(g.startSample).toBeGreaterThanOrEqual(prev);
						expect(g.endSample).toBeGreaterThan(g.startSample);
						expect(g.endSample).toBeLessThanOrEqual(xs.length);
						prev = g.endSample;
					}
				},
			),
			{ numRuns: 200 },
		);
	});
});
