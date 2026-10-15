// Ported from FilmCraft crates/audio-dsp/src/oversample.rs tests, plus TruePeakDetector checks.
import { describe, expect, it } from 'vitest';
import { TruePeakDetector } from '../src/index.ts';
import { Rng, sine } from './util.ts';

describe('TruePeakDetector', () => {
	it('measures inter-sample peaks: fs/4 sine at 45° (44.1/48 kHz), 12 kHz off-grid at 96 kHz (2×)', () => {
		// at 96 kHz the 2× interpolator has the same 192 kHz point spacing as 4× at 48 kHz, so the equivalent
		// test tone is 12 kHz (a 24 kHz tone would read up to −0.69 dB low, inherent to BS.1770's 2×)
		for (const [sr, f, ph] of [
			[44100, 44100 / 4, Math.PI / 4],
			[48000, 12000, Math.PI / 4],
			[96000, 12000, Math.PI / 8],
		]) {
			const x = sine(f, 0.5, sr, sr / 10, ph);
			const d = new TruePeakDetector(sr, 1);
			d.process([x]);
			// EBU Tech 3341 true-peak tolerance: +0.2 / −0.4 dB
			const tp = d.truePeakDb() - 20 * Math.log10(0.5);
			expect(tp, `sr ${sr}`).toBeGreaterThan(-0.4);
			expect(tp, `sr ${sr}`).toBeLessThan(0.2);
		}
	});

	it('is at least the sample peak, per channel, and block-size independent', () => {
		const r = new Rng(3);
		const a = new Float32Array(5000).map(() => r.uniform());
		const b = new Float32Array(5000).map(() => 0.25 * r.uniform());
		const whole = new TruePeakDetector(48000, 2);
		whole.process([a, b]);
		const parts = new TruePeakDetector(48000, 2);
		let pos = 0;
		while (pos < a.length) {
			const len = Math.min(a.length - pos, 1 + (r.nextU32() % 300));
			parts.process([a, b], pos, len);
			pos += len;
		}
		expect(Array.from(parts.truePeakPerChannel())).toEqual(Array.from(whole.truePeakPerChannel()));
		const sp = a.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
		expect(whole.truePeakPerChannel()[0]).toBeGreaterThanOrEqual(sp);
		expect(whole.truePeak()).toBe(whole.truePeakPerChannel()[0]);
		// ±0.25 uniform noise: inter-sample overshoot is bounded well below 2× the sample peak
		expect(whole.truePeakPerChannel()[1]).toBeLessThan(0.5);
		whole.reset();
		expect(whole.truePeak()).toBe(0);
		expect(whole.truePeakDb()).toBe(Number.NEGATIVE_INFINITY);
	});
});
