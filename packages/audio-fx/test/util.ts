import { Fft } from '../src/core/fft.ts';
import { Prng } from '../src/core/util.ts';

export const SR = 48000;

export function sine(freq: number, amp: number, sr: number, n: number, phase = 0): Float32Array {
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr + phase);
	return out;
}

export function noise(seed: number, n: number, amp: number): Float32Array {
	const r = new Prng(seed);
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = r.uniform() * amp;
	return out;
}

export function rms(x: ArrayLike<number>, start = 0, end = x.length): number {
	if (end <= start) return 0;
	let s = 0;
	for (let i = start; i < end; i++) s += x[i]! * x[i]!;
	return Math.sqrt(s / (end - start));
}

export function db(x: number): number {
	return 20 * Math.log10(x);
}

export function peak(x: ArrayLike<number>, start = 0, end = x.length): number {
	let p = 0;
	for (let i = start; i < end; i++) p = Math.max(p, Math.abs(x[i]!));
	return p;
}

/** Amplitude of the `freq` component of `x` (single-bin DFT correlation). */
export function toneAmplitude(
	x: ArrayLike<number>,
	freq: number,
	sr: number,
	start = 0,
	end = x.length,
): number {
	let re = 0;
	let im = 0;
	for (let i = start; i < end; i++) {
		const w = (2 * Math.PI * freq * i) / sr;
		re += x[i]! * Math.cos(w);
		im += x[i]! * Math.sin(w);
	}
	return (2 * Math.sqrt(re * re + im * im)) / (end - start);
}

export function run(
	fx: { process(ch: readonly Float32Array[], s: number, e: number): void },
	...ch: Float32Array[]
): Float32Array[] {
	const n = Math.min(...ch.map((c) => c.length));
	fx.process(ch, 0, n);
	return ch;
}

/**
 * Noise with an exact power-law spectrum (random-phase bins with power ∝ f^slope between lo and hi Hz; slope −1 =
 * pink), peak-normalised to `peakAmp`. `n` must be a power of two.
 */
export function powerLawNoise(
	seed: number,
	n: number,
	sr: number,
	lo: number,
	hi: number,
	slope: number,
	peakAmp = 0.5,
): Float32Array {
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	const r = new Prng(seed);
	for (let k = 1; k < n / 2; k++) {
		const f = (k * sr) / n;
		if (f < lo || f > hi) continue;
		const a = Math.sqrt(f ** slope);
		const ph = r.unit() * 2 * Math.PI;
		re[k] = a * Math.cos(ph);
		im[k] = a * Math.sin(ph);
		re[n - k] = re[k]!;
		im[n - k] = -im[k]!;
	}
	new Fft(n).inverse(re, im);
	let p = 0;
	for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(re[i]!));
	const out = new Float32Array(n);
	for (let i = 0; i < n; i++) out[i] = (peakAmp * re[i]!) / p;
	return out;
}
