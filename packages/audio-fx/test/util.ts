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
