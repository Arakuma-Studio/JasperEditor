import { describe, expect, it } from 'vitest';
import { Biquad, designBiquad, magnitudeDb } from '../src/core/biquad.ts';
import { AllPass1, DelayLine, Prng } from '../src/core/util.ts';
import { db, SR, sine, toneAmplitude } from './util.ts';

function measuredDb(c: ReturnType<typeof designBiquad>, freq: number): number {
	const x = sine(freq, 0.5, SR, SR);
	new Biquad().process(c, x);
	return db(toneAmplitude(x, freq, SR, SR / 2, SR) / 0.5);
}

/** |H| of the cookbook's analog prototype through the bilinear transform, written from the formulas directly. */
function cookbookPeakingDb(f0: number, q: number, gain: number, f: number): number {
	const A = 10 ** (gain / 40);
	const w0 = (2 * Math.PI * f0) / SR;
	const alpha = Math.sin(w0) / (2 * q);
	const b = [1 + alpha * A, -2 * Math.cos(w0), 1 - alpha * A];
	const a = [1 + alpha / A, -2 * Math.cos(w0), 1 - alpha / A];
	const w = (2 * Math.PI * f) / SR;
	const h = (c: number[]) => {
		const re = c[0]! + c[1]! * Math.cos(w) + c[2]! * Math.cos(2 * w);
		const im = -(c[1]! * Math.sin(w) + c[2]! * Math.sin(2 * w));
		return Math.hypot(re, im);
	};
	return 20 * Math.log10(h(b) / h(a));
}

describe('biquad (RBJ cookbook)', () => {
	it('peaking hits its gain at the centre and matches the cookbook everywhere', () => {
		const c = designBiquad('peaking', SR, 1000, 1, 6);
		expect(Math.abs(magnitudeDb(c, 1000, SR) - 6)).toBeLessThan(1e-9);
		expect(Math.abs(magnitudeDb(c, 20, SR))).toBeLessThan(0.05);
		for (const f of [50, 300, 1000, 2500, 9000, 18000])
			expect(Math.abs(magnitudeDb(c, f, SR) - cookbookPeakingDb(1000, 1, 6, f))).toBeLessThan(1e-9);
		expect(Math.abs(measuredDb(c, 1000) - 6)).toBeLessThan(0.05);
	});

	it('low-pass / high-pass are −3.01 dB at the cutoff with 12 dB/oct slopes', () => {
		const q = Math.SQRT1_2;
		const lp = designBiquad('lowPass', SR, 2000, q, 0);
		const hp = designBiquad('highPass', SR, 2000, q, 0);
		expect(Math.abs(magnitudeDb(lp, 2000, SR) + 3.0103)).toBeLessThan(0.01);
		expect(Math.abs(magnitudeDb(hp, 2000, SR) + 3.0103)).toBeLessThan(0.01);
		expect(Math.abs(magnitudeDb(lp, 100, SR))).toBeLessThan(0.01);
		expect(Math.abs(magnitudeDb(hp, 15000, SR))).toBeLessThan(0.1);
		expect(magnitudeDb(lp, 8000, SR)).toBeLessThan(-22);
		expect(Math.abs(measuredDb(lp, 2000) + 3.0103)).toBeLessThan(0.05);
		expect(Math.abs(measuredDb(hp, 500) - magnitudeDb(hp, 500, SR))).toBeLessThan(0.05);
	});

	it('notch is deep at the centre, shelves reach their gain, band-pass/all-pass are unity', () => {
		const n = designBiquad('notch', SR, 60, 10, 0);
		expect(magnitudeDb(n, 60, SR)).toBeLessThan(-120);
		expect(Math.abs(magnitudeDb(n, 1000, SR))).toBeLessThan(0.01);
		expect(measuredDb(n, 60)).toBeLessThan(-40);
		const q = Math.SQRT1_2;
		const ls = designBiquad('lowShelf', SR, 200, q, 9);
		const hs = designBiquad('highShelf', SR, 5000, q, -9);
		expect(Math.abs(magnitudeDb(ls, 10, SR) - 9)).toBeLessThan(0.05);
		expect(Math.abs(magnitudeDb(ls, 200, SR) - 4.5)).toBeLessThan(0.01);
		expect(Math.abs(magnitudeDb(hs, 23000, SR) + 9)).toBeLessThan(0.1);
		expect(Math.abs(magnitudeDb(hs, 5000, SR) + 4.5)).toBeLessThan(0.01);
		expect(Math.abs(measuredDb(ls, 40) - magnitudeDb(ls, 40, SR))).toBeLessThan(0.05);
		const bp = designBiquad('bandPass', SR, 1000, 2, 0);
		expect(Math.abs(magnitudeDb(bp, 1000, SR))).toBeLessThan(1e-9);
		const ap = designBiquad('allPass', SR, 1000, 2, 0);
		for (const f of [50, 1000, 9000]) expect(Math.abs(magnitudeDb(ap, f, SR))).toBeLessThan(1e-9);
	});

	it('state flushes to exact zero', () => {
		const c = designBiquad('lowPass', SR, 100, 0.7, 0);
		const bq = new Biquad();
		bq.tick(c, 1);
		let last = 1;
		for (let i = 0; i < 2_000_000; i++) last = bq.tick(c, 0);
		expect(last).toBe(0);
	});
});

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
