// Minimal in-place radix-2 complex FFT (power-of-two sizes), allocation-free after planning (port of filmcraft
// `fft.rs`; f64 here).

export class Fft {
	readonly n: number;
	private readonly twRe: Float64Array;
	private readonly twIm: Float64Array;
	private readonly rev: Uint32Array;

	/** Plan an FFT of size `n` (a power of two ≥ 2). */
	constructor(n: number) {
		if (n < 2 || (n & (n - 1)) !== 0) throw new Error('FFT size must be a power of two');
		this.n = n;
		const bits = Math.log2(n);
		this.rev = new Uint32Array(n);
		for (let i = 0; i < n; i++) {
			let r = 0;
			for (let b = 0; b < bits; b++) r |= ((i >>> b) & 1) << (bits - 1 - b);
			this.rev[i] = r >>> 0;
		}
		this.twRe = new Float64Array(n / 2);
		this.twIm = new Float64Array(n / 2);
		for (let k = 0; k < n / 2; k++) {
			const a = (-2 * Math.PI * k) / n;
			this.twRe[k] = Math.cos(a);
			this.twIm[k] = Math.sin(a);
		}
	}

	/** Forward transform (e^{-iωt}), unscaled. */
	forward(re: Float64Array, im: Float64Array): void {
		this.run(re, im, false);
	}

	/** Inverse transform (e^{+iωt}), unscaled (divide by `n` yourself). */
	inverse(re: Float64Array, im: Float64Array): void {
		this.run(re, im, true);
	}

	private run(re: Float64Array, im: Float64Array, inverse: boolean): void {
		const n = this.n;
		const rev = this.rev;
		for (let i = 0; i < n; i++) {
			const j = rev[i]!;
			if (j > i) {
				const tr = re[i]!;
				re[i] = re[j]!;
				re[j] = tr;
				const ti = im[i]!;
				im[i] = im[j]!;
				im[j] = ti;
			}
		}
		const sign = inverse ? -1 : 1;
		for (let len = 2; len <= n; len <<= 1) {
			const half = len >> 1;
			const stride = n / len;
			for (let start = 0; start < n; start += len) {
				for (let k = 0; k < half; k++) {
					const wr = this.twRe[k * stride]!;
					const wi = sign * this.twIm[k * stride]!;
					const a = start + k;
					const b = a + half;
					const xr = re[b]! * wr - im[b]! * wi;
					const xi = re[b]! * wi + im[b]! * wr;
					re[b] = re[a]! - xr;
					im[b] = im[a]! - xi;
					re[a] = re[a]! + xr;
					im[a] = im[a]! + xi;
				}
			}
		}
	}
}
