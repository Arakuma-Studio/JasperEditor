// Minimal in-place iterative radix-2 complex FFT over Float64Array pairs (power-of-two sizes).
// Ported from FilmCraft `crates/audio-dsp/src/fft.rs` (MIT OR Apache-2.0, licenses/ported/multicam.md), in
// double precision: the audio-sync correlations run on up to 4 M points, where single-precision twiddles lose
// the sub-sample peak.

export class Fft {
	readonly n: number;
	private readonly twRe: Float64Array;
	private readonly twIm: Float64Array;
	private readonly rev: Uint32Array;

	constructor(n: number) {
		if (!Number.isSafeInteger(n) || n < 2 || n > 2 ** 30 || (n & (n - 1)) !== 0)
			throw new RangeError('FFT size must be a power of two between 2 and 2 ** 30');
		this.n = n;
		const bits = Math.log2(n);
		this.rev = new Uint32Array(n);
		// Reversing i drops its low bit into the high position and shifts the already-reversed i/2.
		// Build each exact integer permutation index once, including large uncached sync plans.
		const highBit = 1 << (bits - 1);
		for (let i = 1; i < n; i++) this.rev[i] = (this.rev[i >>> 1]! >>> 1) | ((i & 1) === 0 ? 0 : highBit);
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
		if (re.length !== n || im.length !== n)
			throw new RangeError(`FFT buffers must each contain ${n} samples`);
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
		for (let len = 2; len <= n; len *= 2) {
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

const plans = new Map<number, Fft>();

/** Forward (e^{-iωt}) or inverse (e^{+iωt}) transform, unscaled (divide by `n` yourself after inverse). */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
	if (im.length !== re.length) throw new RangeError('fft: re and im lengths differ');
	let plan = plans.get(re.length);
	if (!plan) {
		plan = new Fft(re.length);
		// Large sync plans are released after the transform to bound retained memory.
		if (re.length <= 1 << 18) plans.set(re.length, plan);
	}
	if (inverse) plan.inverse(re, im);
	else plan.forward(re, im);
}

export function nextPow2(n: number): number {
	let p = 2;
	while (p < n) p *= 2;
	return p;
}
