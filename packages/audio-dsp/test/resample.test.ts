import { describe, expect, it } from 'vitest';
import { resample } from '../src/index.ts';
import { rms, sine } from './util.ts';

/** Amplitude and phase of the `freq` component over `x[a … b)` (least squares on sin/cos). */
function tone(
	x: Float32Array,
	freq: number,
	sr: number,
	a: number,
	b: number,
): { amp: number; phase: number } {
	let ss = 0;
	let cc = 0;
	let sc = 0;
	let xs = 0;
	let xc = 0;
	for (let i = a; i < b; i++) {
		const w = (2 * Math.PI * freq * i) / sr;
		const s = Math.sin(w);
		const c = Math.cos(w);
		ss += s * s;
		cc += c * c;
		sc += s * c;
		xs += x[i] * s;
		xc += x[i] * c;
	}
	const det = ss * cc - sc * sc;
	const p = (xs * cc - xc * sc) / det; // coefficient of sin
	const q = (xc * ss - xs * sc) / det; // coefficient of cos
	return { amp: Math.hypot(p, q), phase: Math.atan2(q, p) };
}

const PAIRS: [number, number][] = [
	[44100, 48000],
	[48000, 44100],
	[48000, 96000],
	[96000, 48000],
	[44100, 96000],
	[96000, 44100],
];

describe('resample (Kaiser windowed sinc)', () => {
	it('length = round(len · to / from); equal rates copy', () => {
		const x = new Float32Array(1001);
		expect(resample([x], 44100, 48000)[0].length).toBe(Math.round((1001 * 48000) / 44100));
		expect(resample([x], 48000, 44100)[0].length).toBe(Math.round((1001 * 44100) / 48000));
		expect(resample([x, x], 48000, 22050, 'fast').length).toBe(2);
		const same = resample([x], 48000, 48000);
		expect(same[0]).not.toBe(x);
		expect(same[0]).toEqual(x);
		expect(resample([], 1, 2)).toEqual([]);
		expect(() => resample([x], 0, 48000)).toThrow();
	});

	it('high: sine amplitude (< 0.01 dB), frequency and phase preserved up to 0.45·min(fs)', () => {
		for (const [from, to] of PAIRS) {
			const minFs = Math.min(from, to);
			const n = Math.round(from * 0.25);
			for (const frac of [0.01, 0.1, 0.25, 0.4, 0.45]) {
				const f = frac * minFs;
				const x = sine(f, 0.5, from, n, 0.3);
				const [y] = resample([x], from, to, 'high');
				// skip the edges (zero padding outside the input)
				const edge = Math.round(to * 0.01);
				const t = tone(y, f, to, edge, y.length - edge);
				const errDb = 20 * Math.log10(t.amp / 0.5);
				expect(Math.abs(errDb), `${from}→${to} @ ${f} Hz: ${errDb} dB`).toBeLessThan(0.01);
				let dph = t.phase - 0.3;
				dph = Math.atan2(Math.sin(dph), Math.cos(dph));
				expect(Math.abs(dph), `${from}→${to} @ ${f} Hz phase`).toBeLessThan(1e-3);
				const res = new Float32Array(y.length - 2 * edge);
				for (let i = edge; i < y.length - edge; i++)
					res[i - edge] = y[i] - 0.5 * Math.sin((2 * Math.PI * f * i) / to + 0.3);
				expect(20 * Math.log10(rms(res) / (0.5 / Math.SQRT2)), `${from}→${to} @ ${f} residual`).toBeLessThan(
					-80,
				);
			}
		}
	});

	it('high: rejects aliasing ≥ 90 dB when downsampling', () => {
		for (const [from, to, f] of [
			[48000, 44100, 22500],
			[48000, 44100, 23900],
			[96000, 48000, 24500],
			[96000, 44100, 30000],
			[96000, 44100, 47000],
		]) {
			const x = sine(f, 1, from, Math.round(from * 0.2));
			const [y] = resample([x], from, to, 'high');
			const edge = Math.round(to * 0.01);
			const level = 20 * Math.log10(rms(y.subarray(edge, y.length - edge)) / Math.SQRT1_2);
			expect(level, `${from}→${to} @ ${f} Hz: ${level} dB`).toBeLessThan(-90);
		}
	});

	it('high: rejects imaging ≥ 90 dB when upsampling', () => {
		const from = 44100;
		const to = 96000;
		const f = 15000;
		const x = sine(f, 1, from, from / 5);
		const [y] = resample([x], from, to, 'high');
		// the image of a 15 kHz tone at 44.1 kHz lies at 44.1 − 15 = 29.1 kHz
		const edge = 2000;
		// subtract the ideal tone first so its leakage does not bias the image estimate
		const res = y.map((v, i) => v - Math.sin((2 * Math.PI * f * i) / to));
		const image = tone(res, from - f, to, edge, y.length - edge).amp;
		expect(20 * Math.log10(image)).toBeLessThan(-90);
	});

	it('fast: passband to 0.4·min within 0.01 dB, stop band ≥ 65 dB', () => {
		const [from, to] = [48000, 44100];
		const x = sine(0.4 * to, 0.5, from, from / 4);
		const [y] = resample([x], from, to, 'fast');
		const t = tone(y, 0.4 * to, to, 500, y.length - 500);
		expect(Math.abs(20 * Math.log10(t.amp / 0.5))).toBeLessThan(0.01);
		const [z] = resample([sine(23000, 1, from, from / 4)], from, to, 'fast');
		expect(20 * Math.log10(rms(z.subarray(500, z.length - 500)) / Math.SQRT1_2)).toBeLessThan(-65);
	});

	it('time alignment of an impulse and arbitrary (dense-table) ratios', () => {
		const x = new Float32Array(4800);
		x[2400] = 1;
		const [y] = resample([x], 48000, 96000);
		let arg = 0;
		for (let i = 1; i < y.length; i++) if (Math.abs(y[i]) > Math.abs(y[arg])) arg = i;
		expect(arg).toBe(4800);
		// non-integer / coprime rates use the dense table
		for (const [from, to] of [
			[44100, 47999],
			[48000, 44100.5],
		]) {
			const f = 3000;
			const s = sine(f, 0.5, from, Math.round(from / 4), 0.3);
			const [r] = resample([s], from, to);
			expect(r.length).toBe(Math.round((s.length * to) / from));
			const t = tone(r, f, to, 500, r.length - 500);
			expect(Math.abs(20 * Math.log10(t.amp / 0.5))).toBeLessThan(0.01);
			let dph = t.phase - 0.3;
			dph = Math.atan2(Math.sin(dph), Math.cos(dph));
			expect(Math.abs(dph)).toBeLessThan(1e-3);
			const res = new Float32Array(r.length - 1000);
			for (let i = 500; i < r.length - 500; i++)
				res[i - 500] = r[i] - 0.5 * Math.sin((2 * Math.PI * f * i) / to + 0.3);
			expect(20 * Math.log10(rms(res) / (0.5 / Math.SQRT2))).toBeLessThan(-80);
		}
	});
});
