import { describe, expect, it } from 'vitest';
import { createProcessor } from '../src/registry.ts';
import { noise, peak, SR, sine, toneAmplitude } from './util.ts';

function fx(id: string, params: Record<string, number | boolean | string> = {}, ch = 1) {
	const e = createProcessor(`jasper.audio.${id}`, SR, ch)!;
	for (const [k, v] of Object.entries(params)) expect(e.setParam(k, v), `${id}.${k}`).toBe(true);
	e.reset();
	return e;
}
const impulse = (n: number, at = 0) => {
	const x = new Float32Array(n);
	x[at] = 1;
	return x;
};

describe('delays', () => {
	it('Delay: echoes at exactly the delay with the feedback series g, g², … and the mix law', () => {
		const d = fx('delay', { time: 100, feedback: 50, mix: 100 });
		const x = impulse(24000);
		d.process([x], 0, x.length);
		expect(x[0]).toBe(0);
		expect(x[4800]).toBeCloseTo(1, 6);
		expect(x[9600]).toBeCloseTo(0.5, 6);
		expect(x[14400]).toBeCloseTo(0.25, 6);
		const m = fx('delay', { time: 100, feedback: 0, mix: 30 });
		const y = impulse(9600);
		m.process([y], 0, y.length);
		expect(y[0]).toBeCloseTo(0.7, 6);
		expect(y[4800]).toBeCloseTo(0.3, 6);
	});

	it('tempo sync: note values at a tempo', () => {
		for (const [bpm, division, sample] of [
			[120, '1/4', 24000],
			[120, '1/8', 12000],
			[120, '1/4d', 36000],
			[90, '1/4', 32000],
		] as const) {
			const delay = fx('delay', { mode: 'tempo', bpm, division, mix: 100, feedback: 0 });
			const samples = impulse(48000);
			delay.process([samples], 0, samples.length);
			expect(samples[sample], `${bpm} BPM ${division}`).toBeCloseTo(1, 6);
		}
	});

	it('Multitap: taps at their times and levels', () => {
		const m = fx('multitap-delay', { mix: 100 });
		const x = impulse(60000);
		m.process([x], 0, x.length);
		for (const [ms, db] of [
			[250, -6],
			[500, -9],
			[750, -12],
			[1000, -15],
		] as const)
			expect(x[(ms * SR) / 1000]).toBeCloseTo(10 ** (db / 20), 5);
	});

	it('Analog Delay stays bounded with 200 % feedback and trash', () => {
		const a = fx('analog-delay', { feedback: 200, trash: 200, delay: 50 });
		const x = noise(1, SR * 4, 0.9);
		a.process([x], 0, x.length);
		expect(peak(x)).toBeLessThan(5);
		const t = fx('analog-delay', { dry: 0, wet: 100, feedback: 0, delay: 100 });
		const y = impulse(9600);
		t.process([y], 0, y.length);
		expect(y[4800]).toBeCloseTo(1, 6);
	});
});

describe('modulation', () => {
	it('Flanger: a static delay makes comb notches at odd multiples of 1/(2·delay)', () => {
		// Initial = final delay (no sweep), no feedback, 50 % mix: H = 0.5 + 0.5·z^−D → notches at (2k+1)/(2D).
		const f = fx('flanger', { initialDelay: 2, finalDelay: 2, feedback: 0, mix: 50 });
		const D = 0.002;
		const notch = 1 / (2 * D);
		const x = sine(notch, 0.5, SR, SR);
		f.process([x], 0, x.length);
		expect(toneAmplitude(x, notch, SR, SR / 2, SR)).toBeLessThan(0.01);
		const g = fx('flanger', { initialDelay: 2, finalDelay: 2, feedback: 0, mix: 50 });
		const y = sine(1 / D, 0.5, SR, SR);
		g.process([y], 0, y.length);
		expect(toneAmplitude(y, 1 / D, SR, SR / 2, SR)).toBeCloseTo(0.5, 2);
	});

	it('LFO rate: the chorus/flanger sweep repeats at Speed (±2 %)', () => {
		// Flanger mode, wet only, no feedback: an impulse train comes out delayed by the swept delay d(t); the delay
		// sequence (pulse centroids) is periodic at the LFO rate.
		const rate = 2;
		const f = fx('chorus-flanger', { mode: 'flanger', speed: rate, width: 100, intensity: 0, mix: 100 });
		const n = SR * 4;
		const step = 480;
		const x = new Float32Array(n);
		for (let i = 0; i < n; i += step) x[i] = 1;
		f.process([x], 0, n);
		const d: number[] = [];
		for (let i = 0; i + step < n; i += step) {
			let s = 0;
			let m = 0;
			for (let k = i; k < i + step; k++) {
				s += Math.abs(x[k]!) * (k - i);
				m += Math.abs(x[k]!);
			}
			d.push(m > 0 ? s / m : 0);
		}
		const mean = d.reduce((a, b) => a + b, 0) / d.length;
		let best = Number.NEGATIVE_INFINITY;
		let bestLag = 0;
		for (let lag = 30; lag < 80; lag++) {
			let s = 0;
			for (let i = 0; i + lag < d.length; i++) s += (d[i]! - mean) * (d[i + lag]! - mean);
			if (s > best) {
				best = s;
				bestLag = lag;
			}
		}
		const period = (bestLag * step) / SR;
		expect(Math.abs(1 / period - rate) / rate).toBeLessThan(0.02);
		// The sweep spans 0.3 … 5 ms at 100 % width.
		expect(Math.min(...d.slice(5))).toBeLessThan(0.4 * 48);
		expect(Math.max(...d)).toBeGreaterThan(4.9 * 48);
	});

	it('mix 0 is identity for the modulation effects', () => {
		for (const id of ['chorus-flanger', 'flanger', 'phaser']) {
			const x = noise(2, 4800, 0.4);
			const y = x.slice();
			fx(id, { mix: 0 }).process([y], 0, y.length);
			expect(y.every((v, i) => Math.abs(v - x[i]!) < 5e-7)).toBe(true);
		}
	});
});
