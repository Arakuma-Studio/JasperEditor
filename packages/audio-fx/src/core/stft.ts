// Streaming STFT overlap-add framework shared by the spectral effects (port of filmcraft `effects/stft.rs`).
import { Fft } from './fft.ts';

/** Per-channel streaming buffers. Latency is exactly `n` samples. */
export class StftChannel {
	private readonly input: Float64Array;
	private readonly output: Float64Array;
	private pos = 0;

	constructor(n: number) {
		this.input = new Float64Array(n);
		this.output = new Float64Array(n);
	}

	reset(): void {
		this.input.fill(0);
		this.output.fill(0);
		this.pos = 0;
	}

	/**
	 * Push one sample and pop one output sample. Every `hop` samples `frame` is called with the last `n` input
	 * samples and must ADD an `n`-sample (windowed) frame into `out` (overlap-add).
	 */
	tick(x: number, hop: number, frame: (input: Float64Array, out: Float64Array) => void): number {
		const n = this.input.length;
		this.input[n - hop + this.pos] = x;
		const y = this.output[this.pos]!;
		this.pos++;
		if (this.pos === hop) {
			this.pos = 0;
			this.output.copyWithin(0, hop);
			this.output.fill(0, n - hop);
			frame(this.input, this.output);
			this.input.copyWithin(0, hop);
		}
		return y;
	}
}

/** Periodic Hann window. */
export function hann(n: number): Float64Array {
	const w = new Float64Array(n);
	for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
	return w;
}

/** FFT size for spectral effects at a sample rate (~43 ms at 48 kHz). */
export function fftSize(sampleRate: number): number {
	return sampleRate <= 50_000 ? 2048 : sampleRate <= 100_000 ? 4096 : 8192;
}

/** Shared spectral scratch. */
export class Spectral {
	readonly fft: Fft;
	readonly window: Float64Array;
	readonly re: Float64Array;
	readonly im: Float64Array;

	/** `sqrtWindow`: √Hann for analysis and synthesis (sums to a constant at 75 % overlap); else Hann for both. */
	constructor(n: number, sqrtWindow: boolean) {
		const w = hann(n);
		if (sqrtWindow) for (let i = 0; i < n; i++) w[i] = Math.sqrt(w[i]!);
		this.fft = new Fft(n);
		this.window = w;
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
	}

	/** Window `input` into re/im and run the forward FFT. */
	analyse(input: Float64Array): void {
		const n = input.length;
		for (let i = 0; i < n; i++) {
			this.re[i] = input[i]! * this.window[i]!;
			this.im[i] = 0;
		}
		this.fft.forward(this.re, this.im);
	}

	/** Enforce Hermitian symmetry from bins 0..=n/2, inverse FFT, window, scale and add to `out`. */
	synthesiseAdd(out: Float64Array, scale: number): void {
		const n = this.re.length;
		this.im[0] = 0;
		this.im[n / 2] = 0;
		for (let k = 1; k < n / 2; k++) {
			this.re[n - k] = this.re[k]!;
			this.im[n - k] = -this.im[k]!;
		}
		this.fft.inverse(this.re, this.im);
		for (let i = 0; i < n; i++) out[i] = out[i]! + this.re[i]! * this.window[i]! * scale;
	}
}
