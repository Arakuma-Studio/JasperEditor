import { describe, expect, it } from 'vitest';
import { fx } from './processor.ts';
import { db, noise, rms, SR, sine, toneAmplitude } from './util.ts';

/** RT60 (s) from an impulse response: Schroeder integration, line fit of the −5 … −25 dB range (T20 × 3). */
function rt60(ir: ArrayLike<number>, sr: number): number {
	const n = ir.length;
	const edc = new Float64Array(n);
	let acc = 0;
	for (let i = n - 1; i >= 0; i--) {
		acc += ir[i]! * ir[i]!;
		edc[i] = acc;
	}
	const e0 = edc[0]!;
	let i5 = 0;
	while (i5 < n && 10 * Math.log10(edc[i5]! / e0) > -5) i5++;
	let i25 = i5;
	while (i25 < n && 10 * Math.log10(edc[i25]! / e0) > -25) i25++;
	return (3 * (i25 - i5)) / sr;
}

describe('Convolution Reverb', () => {
	it('100 % wet produces a delayed reverberant tail', () => {
		const r = fx('convolution-reverb', { impulse: 'largeHall', mix: 100 }, 1);
		const latency = r.latency();
		const n = SR * 3;
		const x = new Float32Array(n);
		x[0] = 1;
		r.process([x], 0, n);
		expect(x.subarray(0, latency).every((v) => Object.is(v, 0))).toBe(true);
		expect(x.subarray(latency + 1).some((sample) => sample !== 0)).toBe(true);
	});

	it('mix law: 0 % is the delayed dry signal', () => {
		const r = fx('convolution-reverb', { mix: 0 }, 1);
		const latency = r.latency();
		const x = noise(2, 9600, 0.3);
		const y = x.slice();
		r.process([y], 0, y.length);
		expect(y.subarray(latency).every((v, i) => Math.abs(v - x[i]!) < 5e-7)).toBe(true);
	});
});

describe('Studio and Surround Reverb', () => {
	it('Studio Reverb decays ~60 dB per RT60 and stays bounded', () => {
		const r = fx('studio-reverb', { mix: 100, decay: 1, damping: 0 });
		const n = SR * 3;
		const l = new Float32Array(n);
		const rr = new Float32Array(n);
		l[0] = 1;
		rr[0] = 1;
		r.process([l, rr], 0, n);
		const w = SR / 10;
		const drop = db(rms(l, 0.2 * SR, 0.2 * SR + w) / rms(l, 1.2 * SR, 1.2 * SR + w));
		expect(drop).toBeGreaterThan(45);
		expect(drop).toBeLessThan(75);
		const t = rt60(l, SR);
		expect(Math.abs(t - 1) / 1).toBeLessThan(0.15);
		let differ = false;
		for (let i = 0; i < n; i++) if (Math.abs(l[i]! - rr[i]!) > 1e-4) differ = true;
		expect(differ).toBe(true);
	});

	it('Surround Reverb: dry 100 / wet 0 is identity; the wet tail exists', () => {
		const s = fx('surround-reverb', { dry: 100, wet: 0 });
		const x = noise(3, 4800, 0.3);
		const y = x.slice();
		s.process([y, y.slice()], 0, y.length);
		expect(y.every((v, i) => Math.abs(v - x[i]!) < 5e-7)).toBe(true);
		const w = fx('surround-reverb', { dry: 0, wet: 100 });
		const imp = new Float32Array(SR);
		imp[0] = 1;
		w.process([imp, imp.slice()], 0, SR);
		expect(rms(imp, SR / 4, SR / 2)).toBeGreaterThan(1e-4);
	});
});

describe('Pitch Shifter', () => {
	function shifted(params: Record<string, number>, f: number) {
		const p = fx('pitch-shifter', params);
		const n = SR * 2;
		const l = sine(f, 0.5, SR, n);
		const r = l.slice();
		p.process([l, r], 0, n);
		expect(l.every((v, i) => Object.is(v, r[i]))).toBe(true);
		return { y: l, lat: p.latency() };
	}

	/** Peak on the same 0.05 Hz grid: Hann-windowed DFT magnitudes through the independent Goertzel recurrence. */
	function peakHz(y: Float32Array, from: number, len: number, guess: number): number {
		const windowed = Float64Array.from(
			{ length: len },
			(_, i) => y[from + i]! * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / len)),
		);
		let best = 0;
		let bestF = guess;
		for (let f = guess * 0.97; f <= guess * 1.03; f += 0.05) {
			const coefficient = 2 * Math.cos((2 * Math.PI * f) / SR);
			let previous = 0;
			let beforePrevious = 0;
			for (const sample of windowed) {
				const next = sample + coefficient * previous - beforePrevious;
				beforePrevious = previous;
				previous = next;
			}
			const m =
				previous * previous + beforePrevious * beforePrevious - coefficient * previous * beforePrevious;
			if (m > best) {
				best = m;
				bestF = f;
			}
		}
		if (!(best > 0) || !Number.isFinite(best)) throw new Error('No finite spectral peak');
		return bestF;
	}

	for (const [st, cents] of [
		[7, 0],
		[-5, 0],
		[12, 0],
		[0, 50],
		[-12, 0],
	] as const)
		it(`shifts 440 Hz by ${st} st ${cents} cents within 0.5 %`, () => {
			const want = 440 * 2 ** ((st + cents / 100) / 12);
			const { y, lat } = shifted({ semitones: st, cents }, 440);
			const from = lat + 8192;
			const got = peakHz(y, from, 24000, want);
			expect(Math.abs(got - want) / want).toBeLessThan(0.005);
			const aOut = toneAmplitude(y, want, SR, from, from + 24000);
			expect(Math.abs(db(aOut / 0.5))).toBeLessThan(3);
			if (Math.abs(st) >= 1)
				expect(db(toneAmplitude(y, 440, SR, from, from + 24000) / aOut)).toBeLessThan(-30);
		});

	it('zero shift is the input delayed by exactly latency() samples', () => {
		const { y, lat } = shifted({ semitones: 0 }, 440);
		const x = sine(440, 0.5, SR, y.length);
		expect(y.subarray(lat + 2048).every((v, i) => Math.abs(v - x[i + 2048]!) < 2e-3)).toBe(true);
	});
});
