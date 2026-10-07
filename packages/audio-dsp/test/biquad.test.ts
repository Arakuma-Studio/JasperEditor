// Ported from FilmCraft crates/audio-dsp/src/biquad.rs tests, plus the K-weighting table checks.
import { describe, expect, it } from 'vitest';
import {
	Biquad,
	type BiquadCoeffs,
	biquadMagnitude,
	biquadMagnitudeDb,
	designBiquad,
	kPrefilter,
	kRlb,
	kWeightingPower,
} from '../src/index.ts';
import { db, sine, toneAmplitude } from './util.ts';

const SR = 48000;

function measuredDb(c: BiquadCoeffs, freq: number): number {
	const n = SR;
	const x = sine(freq, 0.5, SR, n);
	const bq = new Biquad(c);
	bq.processBlock(x);
	return db(toneAmplitude(x.subarray(n / 2), freq, SR) / 0.5);
}

describe('biquad (RBJ cookbook, TDF-II)', () => {
	it('peaking hits gain at centre', () => {
		const c = designBiquad('peaking', SR, 1000, 1, 6);
		expect(Math.abs(biquadMagnitudeDb(c, 1000, SR) - 6)).toBeLessThan(1e-9);
		expect(Math.abs(biquadMagnitudeDb(c, 20, SR))).toBeLessThan(0.05);
		expect(Math.abs(measuredDb(c, 1000) - 6)).toBeLessThan(0.05);
	});

	it('low-pass / high-pass are −3 dB at the cut-off', () => {
		const q = Math.SQRT1_2;
		const lp = designBiquad('lowPass', SR, 2000, q);
		const hp = designBiquad('highPass', SR, 2000, q);
		expect(Math.abs(biquadMagnitudeDb(lp, 2000, SR) + 3.0103)).toBeLessThan(0.01);
		expect(Math.abs(biquadMagnitudeDb(hp, 2000, SR) + 3.0103)).toBeLessThan(0.01);
		expect(Math.abs(biquadMagnitudeDb(lp, 100, SR))).toBeLessThan(0.01);
		expect(Math.abs(biquadMagnitudeDb(hp, 15000, SR))).toBeLessThan(0.1);
		expect(biquadMagnitudeDb(lp, 8000, SR)).toBeLessThan(-22);
		expect(Math.abs(measuredDb(lp, 2000) + 3.0103)).toBeLessThan(0.05);
		expect(Math.abs(measuredDb(hp, 500) - biquadMagnitudeDb(hp, 500, SR))).toBeLessThan(0.05);
	});

	it('notch is deep at centre', () => {
		const c = designBiquad('notch', SR, 60, 10);
		expect(biquadMagnitude(c, 60, SR)).toBeLessThan(1e-6);
		expect(Math.abs(biquadMagnitudeDb(c, 1000, SR))).toBeLessThan(0.01);
		expect(measuredDb(c, 60)).toBeLessThan(-40);
	});

	it('shelves reach their gain', () => {
		const q = Math.SQRT1_2;
		const ls = designBiquad('lowShelf', SR, 200, q, 9);
		const hs = designBiquad('highShelf', SR, 5000, q, -9);
		expect(Math.abs(biquadMagnitudeDb(ls, 10, SR) - 9)).toBeLessThan(0.05);
		expect(Math.abs(biquadMagnitudeDb(ls, 200, SR) - 4.5)).toBeLessThan(0.01);
		expect(Math.abs(biquadMagnitudeDb(ls, 10000, SR))).toBeLessThan(0.05);
		expect(Math.abs(biquadMagnitudeDb(hs, 23000, SR) + 9)).toBeLessThan(0.1);
		expect(Math.abs(biquadMagnitudeDb(hs, 5000, SR) + 4.5)).toBeLessThan(0.01);
		expect(Math.abs(measuredDb(ls, 40) - biquadMagnitudeDb(ls, 40, SR))).toBeLessThan(0.05);
		expect(Math.abs(measuredDb(hs, 12000) - biquadMagnitudeDb(hs, 12000, SR))).toBeLessThan(0.05);
	});

	it('band-pass and all-pass', () => {
		const bp = designBiquad('bandPass', SR, 1000, 2);
		expect(Math.abs(biquadMagnitudeDb(bp, 1000, SR))).toBeLessThan(1e-9);
		const ap = designBiquad('allPass', SR, 1000, 2);
		for (const f of [50, 1000, 9000]) expect(Math.abs(biquadMagnitudeDb(ap, f, SR))).toBeLessThan(1e-9);
	});

	it('constant-bandwidth cut reaches its depth', () => {
		const c = designBiquad('cut', SR, 1000, 4, -20);
		expect(Math.abs(biquadMagnitudeDb(c, 1000, SR) + 20)).toBeLessThan(1e-9);
		expect(Math.abs(biquadMagnitudeDb(c, 100, SR))).toBeLessThan(0.1);
	});

	it('state flushes to zero (no denormals)', () => {
		const bq = new Biquad(designBiquad('lowPass', SR, 100, 0.7));
		bq.processSample(1);
		let last = 1;
		for (let i = 0; i < 2_000_000; i++) {
			last = bq.processSample(0);
			const a = Math.abs(last);
			if (a !== 0 && a < 1.1754943508222875e-38) throw new Error(`subnormal at ${i}: ${last}`);
		}
		expect(last).toBe(0);
	});

	it('reset clears the memory and setCoeffs keeps it', () => {
		const bq = new Biquad(designBiquad('lowPass', SR, 1000, 0.7));
		const first = bq.processSample(1);
		bq.processSample(0.5);
		bq.reset();
		expect(bq.processSample(1)).toBe(first);
		bq.setCoeffs({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });
		// the TDF-II state still carries the previous filter's memory into the next sample
		expect(bq.processSample(0)).not.toBe(0);
	});
});

describe('K-weighting', () => {
	it('matches the BS.1770-4 coefficient table at 48 kHz (1e-6)', () => {
		const p = kPrefilter(48000);
		expect(Math.abs(p.b0 - 1.53512485958697)).toBeLessThan(1e-6);
		expect(Math.abs(p.b1 + 2.69169618940638)).toBeLessThan(1e-6);
		expect(Math.abs(p.b2 - 1.19839281085285)).toBeLessThan(1e-6);
		expect(Math.abs(p.a1 + 1.69065929318241)).toBeLessThan(1e-6);
		expect(Math.abs(p.a2 - 0.73248077421585)).toBeLessThan(1e-6);
		const r = kRlb(48000);
		expect([r.b0, r.b1, r.b2]).toEqual([1, -2, 1]);
		expect(Math.abs(r.a1 + 1.99004745483398)).toBeLessThan(1e-6);
		expect(Math.abs(r.a2 - 0.99007225036621)).toBeLessThan(1e-6);
		// FilmCraft checks the same table to 1e-8
		expect(Math.abs(p.b0 - 1.53512485958697)).toBeLessThan(1e-8);
		expect(Math.abs(r.a2 - 0.99007225036621)).toBeLessThan(1e-8);
	});

	it('shape is sample-rate independent', () => {
		for (const sr of [32000, 44100, 48000, 96000, 192000]) {
			const d = (f: number): number => 10 * Math.log10(kWeightingPower(f, sr));
			expect(Math.abs(d(1000) - 0.691), `sr ${sr}`).toBeLessThan(0.03);
			expect(Math.abs(d(10000) - 4), `sr ${sr}`).toBeLessThan(0.3);
			expect(d(20), `sr ${sr}`).toBeLessThan(-10);
		}
	});
});
