import { LoudnessMeter } from '@jasper/audio-dsp';
import { describe, expect, it } from 'vitest';
import { dbToGain } from '../src/core/math.ts';
import { fx } from './processor.ts';
import { db, noise, rms, SR, sine, toneAmplitude } from './util.ts';

const run = (e: ReturnType<typeof fx>, x: Float32Array) => {
	const l = x.slice();
	const r = x.slice();
	e.process([l, r], 0, l.length);
	return [l, r] as const;
};

describe('special effects', () => {
	it('Distortion: hard clip makes odd harmonics only; asymmetry adds even ones; output is DC-free and bounded', () => {
		const n = SR;
		const x = sine(500, 0.5, SR, n);
		const h = (s: Float32Array, k: number) => toneAmplitude(s, 500 * k, SR, n / 2, n);
		const [y] = run(fx('distortion', { drive: 24, curve: 'hard' }), x);
		expect(h(y, 3)).toBeGreaterThan(0.1 * h(y, 1));
		expect(h(y, 2)).toBeLessThan(1e-3 * h(y, 1));
		const [z] = run(fx('distortion', { drive: 24, symmetry: 60 }), x);
		expect(h(z, 2)).toBeGreaterThan(0.02 * h(z, 1));
		let mean = 0;
		for (let i = n / 2; i < n; i++) mean += z[i]!;
		expect(Math.abs(mean / (n / 2))).toBeLessThan(1e-3);
		expect(z.every((v) => Math.abs(v) < 2)).toBe(true);
	});

	it('GuitarSuite with everything off is transparent at low level; defaults produce sound', () => {
		const g = fx('guitar-suite', { compressor: 0, distortion: 0, amp: 'none', filter: 'none' });
		const [y] = run(g, sine(1000, 0.01, SR, SR));
		expect(Math.abs(db(toneAmplitude(y, 1000, SR, SR / 2, SR) / 0.01))).toBeLessThan(0.05);
		const [z] = run(fx('guitar-suite'), sine(300, 0.5, SR, SR));
		expect(rms(z)).toBeGreaterThan(0.01);
	});

	it('Mastering: transparent at its defaults; EQ follows responseDb; the maximizer raises level', () => {
		const x = noise(1, 24000, 0.25);
		const [y] = run(fx('mastering'), x);
		expect(y.every((v, i) => Math.abs(v - x[i]!) < 1e-4)).toBe(true);
		const e = fx('mastering', { eqLow: 6 });
		expect(Math.abs(e.responseDb!(20)! - 6)).toBeLessThan(0.3);
		const [t] = run(e, sine(30, 0.1, SR, SR));
		expect(Math.abs(db(toneAmplitude(t, 30, SR, SR / 2, SR) / 0.1) - e.responseDb!(30)!)).toBeLessThan(0.1);
		const n = SR;
		const big = noise(12, n, 0.3);
		const [m] = run(fx('mastering', { loudness: 100 }), big);
		expect(rms(m)).toBeGreaterThan(1.5 * rms(big));
	});

	it('Vocal Enhancer voicings', () => {
		const v = fx('vocal-enhancer', { mode: 'male' });
		expect(v.responseDb!(40)!).toBeLessThan(-6);
		expect(v.responseDb!(3000)!).toBeGreaterThan(2);
		const [y] = run(v, sine(3000, 0.02, SR, SR));
		expect(Math.abs(db(toneAmplitude(y, 3000, SR, SR / 2, SR) / 0.02) - v.responseDb!(3000)!)).toBeLessThan(
			0.1,
		);
		expect(fx('vocal-enhancer', { mode: 'music' }).responseDb!(1500)!).toBeLessThan(-3);
	});

	it('Loudness Meter passes audio unchanged and reports the reference sine level', () => {
		const n = SR * 3;
		const x = sine(1000, 0.1, SR, n);
		const m = fx('loudness-meter');
		const l = x.slice();
		const r = x.slice();
		let pos = 0;
		for (const len of [1, 127, 4096, 333, n]) {
			const k = Math.min(len, n - pos);
			m.process([l, r], pos, pos + k);
			pos += k;
			if (pos >= n) break;
		}
		expect(Buffer.from(l.buffer).equals(Buffer.from(x.buffer))).toBe(true);
		// EBU Tech 3341 case 1 scaled: a stereo 1 kHz sine at −20 dBFS (peak) reads −20 LUFS.
		expect(Math.abs(m.meters!()[2]! - -20)).toBeLessThan(0.1);
	});

	it('Mute ramps to silence over 5 ms without a step', () => {
		const m = fx('mute', { mute: true });
		const x = new Float32Array(SR).fill(0.5);
		const [y] = run(m, x);
		expect(y.every((v) => Object.is(v, 0))).toBe(true);
		const u = fx('mute');
		const z = new Float32Array(1000).fill(0.5);
		u.setParam('mute', true);
		u.process([z], 0, z.length);
		expect(z[0]!).toBeGreaterThan(0.49);
		expect(z[120]!).toBeCloseTo(0.25, 1);
		expect(z[300]).toBe(0);
	});

	it('Loudness Auto Gain brings steady signals to the target within 0.5 LU, within the boost/cut limits', () => {
		for (const inDb of [-35, -23, -12]) {
			const g = fx('auto-gain', { target: -23, maxBoost: 20, maxCut: 20, response: 500 });
			const n = SR * 12;
			const x = noise(7, n, dbToGain(inDb) * Math.sqrt(3));
			const [l, r] = run(g, x);
			const meter = new LoudnessMeter(SR, 2);
			meter.process([l.subarray(SR * 8), r.subarray(SR * 8)]);
			expect(Math.abs(meter.integrated() - -23), `in ${inDb}`).toBeLessThan(0.5);
		}
		const lim = fx('auto-gain', { target: -10, maxBoost: 6 });
		const x = noise(8, SR * 10, dbToGain(-40) * Math.sqrt(3));
		run(lim, x);
		expect(lim.meters!()[0]!).toBeLessThanOrEqual(6 + 1e-9);
		const s = fx('auto-gain');
		run(s, new Float32Array(SR * 5));
		expect(s.meters!()[0]).toBe(0);
	});
});
