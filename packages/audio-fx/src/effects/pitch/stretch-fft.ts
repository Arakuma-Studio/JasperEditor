// FFTs of the Signalsmith Stretch port (licenses/ported/signalsmith-linear.md): the sizes Signalsmith Linear's
// `SplitFFT::fastSizeAbove` picks (2^k · {1, 3, 5}), as one radix-3/5 Cooley–Tukey step over the power-of-two FFT of
// @jasper/audio-dsp, and the half-bin-shifted ("modified") real FFT of `RealFFT<…, halfBinShift = true>` computed
// through a complex FFT of half the size. Unscaled both ways: inverse(forward(x)) = N · x.
import { Fft } from '../../core/fft.ts';

/** Signalsmith Linear `SplitFFT::fastSizeAbove`: the smallest 2^k · {1…6, 8} (no 7) ≥ `size`. */
export function fastSizeAbove(size: number): number {
	let pow2 = 1;
	while (pow2 < 16 && pow2 < size) pow2 *= 2;
	while (pow2 * 8 < size) pow2 *= 2;
	let multiple = Math.floor((size + pow2 - 1) / pow2);
	if (multiple === 7) multiple = 8;
	return multiple * pow2;
}

/** In-place complex FFT of size 2^k · m, m ∈ {1, 3, 5}: m interleaved power-of-two FFTs and one radix-m step. */
export class MixedFft {
	readonly n: number;
	private readonly m: number;
	private readonly p: number;
	private readonly sub: Fft;
	private readonly cos: Float64Array;
	private readonly sin: Float64Array;
	private readonly sRe: Float64Array;
	private readonly sIm: Float64Array;
	private readonly viewsRe: Float64Array[];
	private readonly viewsIm: Float64Array[];
	private readonly tRe: Float64Array;
	private readonly tIm: Float64Array;

	constructor(n: number) {
		let m = 1;
		if (n % 5 === 0) m = 5;
		else if (n % 3 === 0) m = 3;
		const p = n / m;
		if (!Number.isInteger(p) || p < 2 || (p & (p - 1)) !== 0)
			throw new RangeError(`unsupported FFT size ${n}`);
		this.n = n;
		this.m = m;
		this.p = p;
		this.sub = new Fft(p);
		this.cos = new Float64Array(n);
		this.sin = new Float64Array(n);
		for (let j = 0; j < n; j++) {
			const a = (-2 * Math.PI * j) / n;
			this.cos[j] = Math.cos(a);
			this.sin[j] = Math.sin(a);
		}
		this.sRe = new Float64Array(m === 1 ? 0 : n);
		this.sIm = new Float64Array(m === 1 ? 0 : n);
		this.viewsRe = Array.from({ length: m }, (_, r) => this.sRe.subarray(r * p, (r + 1) * p));
		this.viewsIm = Array.from({ length: m }, (_, r) => this.sIm.subarray(r * p, (r + 1) * p));
		this.tRe = new Float64Array(m);
		this.tIm = new Float64Array(m);
	}

	/** e^{−2πi·k/n·…} forward transform, in place. */
	forward(re: Float64Array, im: Float64Array): void {
		this.run(re, im, 1);
	}

	/** e^{+2πi·k/n·…} inverse transform (unscaled), in place. */
	inverse(re: Float64Array, im: Float64Array): void {
		this.run(re, im, -1);
	}

	private run(re: Float64Array, im: Float64Array, sign: 1 | -1): void {
		const { m, p, n } = this;
		if (m === 1) {
			if (sign === 1) this.sub.forward(re, im);
			else this.sub.inverse(re, im);
			return;
		}
		const sRe = this.sRe;
		const sIm = this.sIm;
		for (let r = 0; r < m; r++)
			for (let j = 0; j < p; j++) {
				sRe[r * p + j] = re[m * j + r]!;
				sIm[r * p + j] = im[m * j + r]!;
			}
		for (let r = 0; r < m; r++) {
			if (sign === 1) this.sub.forward(this.viewsRe[r]!, this.viewsIm[r]!);
			else this.sub.inverse(this.viewsRe[r]!, this.viewsIm[r]!);
		}
		const cos = this.cos;
		const sin = this.sin;
		const tRe = this.tRe;
		const tIm = this.tIm;
		for (let k1 = 0; k1 < p; k1++) {
			// t_r = W_n^{r·k1} · Y_r[k1]
			for (let r = 0; r < m; r++) {
				const yr = sRe[r * p + k1]!;
				const yi = sIm[r * p + k1]!;
				const j = r * k1;
				const wr = cos[j]!;
				const wi = sign * sin[j]!;
				tRe[r] = yr * wr - yi * wi;
				tIm[r] = yr * wi + yi * wr;
			}
			// X[k1 + p·k2] = Σ_r t_r · W_m^{r·k2} (W_m = W_n^p)
			for (let k2 = 0; k2 < m; k2++) {
				let xr = 0;
				let xi = 0;
				for (let r = 0; r < m; r++) {
					const j = p * ((r * k2) % m);
					const wr = cos[j]!;
					const wi = sign * sin[j]!;
					xr += tRe[r]! * wr - tIm[r]! * wi;
					xi += tRe[r]! * wi + tIm[r]! * wr;
				}
				re[k1 + p * k2] = xr;
				im[k1 + p * k2] = xi;
			}
		}
		void n;
	}
}

/**
 * Half-bin-shifted real FFT of even size `n` (Signalsmith Linear `RealFFT<Sample, false, true>`): bin k is the
 * frequency (k + ½)/n, k < n/2, so there is no DC/Nyquist packing. forward: X[k] = Σ x[t]·e^{−2πi(k+½)t/n}.
 */
export class HalfBinRealFft {
	readonly n: number;
	readonly bins: number;
	private readonly fft: MixedFft;
	private readonly twRe: Float64Array;
	private readonly twIm: Float64Array;
	private readonly hbRe: Float64Array;
	private readonly hbIm: Float64Array;
	private readonly re: Float64Array;
	private readonly im: Float64Array;

	constructor(n: number) {
		const h = n / 2;
		if (!Number.isInteger(h) || h % 2 !== 0) throw new RangeError(`unsupported real FFT size ${n}`);
		this.n = n;
		this.bins = h;
		this.fft = new MixedFft(h);
		this.twRe = new Float64Array(h / 2 + 1);
		this.twIm = new Float64Array(h / 2 + 1);
		for (let i = 0; i <= h / 2; i++) {
			const a = (i + 0.5) * ((-2 * Math.PI) / n) - Math.PI / 2;
			this.twRe[i] = Math.cos(a);
			this.twIm[i] = Math.sin(a);
		}
		this.hbRe = new Float64Array(h);
		this.hbIm = new Float64Array(h);
		for (let i = 0; i < h; i++) {
			const a = (-2 * Math.PI * i) / n;
			this.hbRe[i] = Math.cos(a);
			this.hbIm[i] = Math.sin(a);
		}
		this.re = new Float64Array(h);
		this.im = new Float64Array(h);
	}

	/** `time` (n samples) → `outRe`/`outIm` (n/2 bins). */
	forward(time: Float64Array, outRe: Float64Array, outIm: Float64Array): void {
		const h = this.bins;
		const re = this.re;
		const im = this.im;
		for (let i = 0; i < h; i++) {
			const tr = time[2 * i]!;
			const ti = time[2 * i + 1]!;
			const wr = this.hbRe[i]!;
			const wi = this.hbIm[i]!;
			re[i] = tr * wr - ti * wi;
			im[i] = ti * wr + tr * wi;
		}
		this.fft.forward(re, im);
		const end = h / 2 + 1;
		for (let i = 0; i < end; i++) {
			const ci = h - 1 - i;
			const twr = this.twRe[i]!;
			const twi = this.twIm[i]!;
			const oddR = (re[i]! + re[ci]!) * 0.5;
			const oddI = (im[i]! - im[ci]!) * 0.5;
			const evR = (re[i]! - re[ci]!) * 0.5;
			const evI = (im[i]! + im[ci]!) * 0.5;
			const rotR = evR * twr - evI * twi;
			const rotI = evI * twr + evR * twi;
			outRe[i] = oddR + rotR;
			outIm[i] = oddI + rotI;
			outRe[ci] = oddR - rotR;
			outIm[ci] = rotI - oddI;
		}
	}

	/** `inRe`/`inIm` (n/2 bins) → `time` (n samples), unscaled. */
	inverse(inRe: Float64Array, inIm: Float64Array, time: Float64Array): void {
		const h = this.bins;
		const re = this.re;
		const im = this.im;
		const end = h / 2 + 1;
		for (let i = 0; i < end; i++) {
			const ci = h - 1 - i;
			const twr = this.twRe[i]!;
			const twi = this.twIm[i]!;
			const oddR = inRe[i]! + inRe[ci]!;
			const oddI = inIm[i]! - inIm[ci]!;
			const rotR = inRe[i]! - inRe[ci]!;
			const rotI = inIm[i]! + inIm[ci]!;
			// × conj(twiddle)
			const evR = rotR * twr + rotI * twi;
			const evI = rotI * twr - rotR * twi;
			re[i] = oddR + evR;
			im[i] = oddI + evI;
			re[ci] = oddR - evR;
			im[ci] = evI - oddI;
		}
		this.fft.inverse(re, im);
		for (let i = 0; i < h; i++) {
			const tr = re[i]!;
			const ti = im[i]!;
			const wr = this.hbRe[i]!;
			const wi = this.hbIm[i]!;
			time[2 * i] = tr * wr + ti * wi;
			time[2 * i + 1] = ti * wr - tr * wi;
		}
	}
}
