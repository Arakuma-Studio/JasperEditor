import { describe, expect, it } from 'vitest';
import { AllPass1, DelayLine, Prng } from '../src/core/util.ts';
import { SR } from './util.ts';

describe('primitives', () => {
	it('delay line reads integer and fractional delays', () => {
		const d = new DelayLine(8);
		for (let i = 0; i < 5; i++) d.push(i);
		expect(d.read(0)).toBe(4);
		expect(d.tap(2)).toBe(2);
		expect(Math.abs(d.read(1.5) - 2.5)).toBeLessThan(1e-6);
	});

	it('first-order all-pass has unit magnitude', () => {
		const a = AllPass1.coef(1000, SR);
		const ap = new AllPass1();
		const r = new Prng(3);
		let ein = 0;
		let eout = 0;
		for (let i = 0; i < 48000; i++) {
			const x = r.uniform();
			const y = ap.tick(a, x);
			ein += x * x;
			eout += y * y;
		}
		expect(Math.abs(eout / ein - 1)).toBeLessThan(0.01);
	});

	it('PRNG is deterministic and uniform', () => {
		const a = new Prng(42);
		const b = new Prng(42);
		let sum = 0;
		for (let i = 0; i < 100000; i++) {
			const v = a.uniform();
			expect(v).toBe(b.uniform());
			expect(v).toBeGreaterThanOrEqual(-1);
			expect(v).toBeLessThan(1);
			sum += v;
		}
		expect(Math.abs(sum / 100000)).toBeLessThan(0.01);
	});
});
