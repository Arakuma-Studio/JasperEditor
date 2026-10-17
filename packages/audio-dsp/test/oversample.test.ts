// Ported from FilmCraft crates/audio-dsp/src/oversample.rs tests, plus TruePeakDetector checks.
import { describe, expect, it } from 'vitest';
import {
	blockTruePeak,
	Interpolator,
	PolyphaseBank,
	TAPS_PER_PHASE,
	TruePeakDetector,
	truePeakFactor,
} from '../src/index.ts';
import { Rng, sine } from './util.ts';

describe('polyphase true-peak interpolator', () => {
	it('phases have unity DC, mirror each other and interpolate sines', () => {
		const bank = new PolyphaseBank(4);
		expect(bank.coeffs.length).toBe(3 * TAPS_PER_PHASE);
		for (let k = 0; k < 3; k++) {
			let s = 0;
			for (let j = 0; j < TAPS_PER_PHASE; j++) s += bank.coeffs[k * TAPS_PER_PHASE + j];
			expect(Math.abs(s - 1)).toBeLessThan(1e-12);
		}
		// point 1/4 is point 3/4 time-reversed
		for (let j = 0; j < TAPS_PER_PHASE; j++)
			expect(bank.coeffs[j]).toBeCloseTo(bank.coeffs[2 * TAPS_PER_PHASE + TAPS_PER_PHASE - 1 - j], 14);
		// the folded evaluation equals the direct convolution
		const ipd = new Interpolator();
		const r = new Rng(11);
		const win: number[] = [];
		for (let n = 0; n < 200; n++) {
			const x = r.uniform();
			win.unshift(x);
			const got = ipd.pushPeak(bank, x);
			if (n < TAPS_PER_PHASE) continue;
			let want = 0;
			for (let k = 0; k < 3; k++) {
				let y = 0;
				for (let j = 0; j < TAPS_PER_PHASE; j++) y += bank.coeffs[k * TAPS_PER_PHASE + j] * win[j];
				want = Math.max(want, Math.abs(y));
			}
			expect(got).toBeCloseTo(want, 12);
		}
		// Sine at fs/4 with 45° phase: samples at ±0.707, true peak 1.0.
		const ip = new Interpolator();
		let peak = 0;
		for (let n = 0; n < 400; n++) {
			const x = Math.fround(Math.sin((Math.PI / 2) * n + Math.PI / 4));
			const p = ip.pushPeak(bank, x);
			if (n > 40) peak = Math.max(peak, p);
		}
		expect(Math.abs(peak - 1)).toBeLessThan(0.002); // the half-sample point is on the grid
	});

	it('oversampling factor reaches ≥ 176.4 kHz', () => {
		expect(truePeakFactor(44100)).toBe(4);
		expect(truePeakFactor(48000)).toBe(4);
		expect(truePeakFactor(32000)).toBe(6);
		expect(truePeakFactor(22050)).toBe(8);
		expect(truePeakFactor(88200)).toBe(2);
		expect(truePeakFactor(96000)).toBe(2);
		expect(truePeakFactor(176400)).toBe(1);
		expect(truePeakFactor(192000)).toBe(1);
		expect(new PolyphaseBank(1).factor).toBe(1);
		expect(new Interpolator().pushPeak(new PolyphaseBank(1), -0.5)).toBe(0.5);
	});
});

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
		expect(blockTruePeak([a, b], 48000)).toBe(whole.truePeak());
		whole.reset();
		expect(whole.truePeak()).toBe(0);
		expect(whole.truePeakDb()).toBe(Number.NEGATIVE_INFINITY);
	});
});

describe('true peak at the end of a programme (sound-design P0)', () => {
	// fs/4 burst at 45°: samples ±0.707, inter-sample peaks ≈ 1.0.
	const burst = (n: number, at: number, len: number) => {
		const x = new Float32Array(n);
		for (let i = at; i < at + len; i++) x[i] = Math.sin((Math.PI / 2) * i + Math.PI / 4);
		return x;
	};

	it('a burst in the last samples reads the same true peak as one in the middle', () => {
		const mid = blockTruePeak([burst(4000, 2000, 12)], 48000);
		const end = blockTruePeak([burst(4000, 3988, 12)], 48000);
		expect(mid).toBeGreaterThan(0.99);
		expect(Math.abs(end - mid)).toBeLessThan(0.01);
		// a whole programme shorter than the interpolator delay
		expect(blockTruePeak([burst(12, 0, 12)], 48000)).toBeGreaterThan(0.99);
	});

	it('the loudness meter summary of a whole programme includes the tail; streaming reads are unchanged', async () => {
		const { LoudnessMeter, measureLoudness } = await import('../src/index.ts');
		const x = burst(4000, 3988, 12);
		expect(10 ** (measureLoudness([x], 48000).truePeakDb / 20)).toBeGreaterThan(0.99);
		const m = new LoudnessMeter(48000, 1);
		m.process([x]);
		const live = m.truePeak();
		expect(live).toBeLessThan(0.72); // the last points are not interpolated yet while the stream goes on
		m.flush();
		expect(m.truePeak()).toBeGreaterThan(0.99);
	});

	it("takePeak: per-span peaks (the history kept) whose maximum is the whole stream's true peak", () => {
		const rng = new Rng(7);
		const x = new Float32Array(48000);
		for (let i = 0; i < x.length; i++)
			x[i] = 0.3 * rng.uniform() + 0.6 * Math.sin((2 * Math.PI * 11025 * i) / 48000 + 0.7);
		const whole = new TruePeakDetector(48000, 1);
		whole.process([x]);
		const spans = new TruePeakDetector(48000, 1);
		const peaks: number[] = [];
		for (let a = 0; a < x.length; a += 480) {
			spans.process([x], a, 480);
			peaks.push(spans.takePeak());
		}
		expect(Math.max(...peaks)).toBeCloseTo(whole.truePeak(), 9);
		// after a take, the next span starts from zero
		expect(spans.takePeak()).toBe(0);
	});
});
