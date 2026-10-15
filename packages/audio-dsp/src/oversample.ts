/**
 * Polyphase FIR interpolator for true-peak estimation (ITU-R BS.1770-4 Annex 2 style).
 *
 * For an oversampling factor `f` the interpolated points lie on the grid `k/f` (k = 1 … f−1) between two input
 * samples — the same grid as resampling to `f·fs` (so the half-sample point, where e.g. a 45°-phase fs/4 tone
 * peaks, is hit exactly); the samples themselves (k = 0) are taken as they are. Each point uses
 * {@link TAPS_PER_PHASE} input samples weighted by a Kaiser-windowed sinc (β = {@link TP_KAISER_BETA}, cut-off
 * {@link TP_CUTOFF} × Nyquist) normalised to unity DC gain — the kernel ffmpeg's `ebur128` true-peak upsampler
 * (libswresample defaults when upsampling: 32 taps, Kaiser β 9, cut-off at the input Nyquist) uses, so both meters
 * agree within a few hundredths of a dB on every signal of the oracle suite (white noise included). Because point `k/f` is point `(f−k)/f` time-reversed,
 * the window is folded and each mirrored pair costs `TAPS_PER_PHASE` multiply-adds. All arithmetic is float64.
 *
 * Ported from FilmCraft `crates/audio-dsp/src/oversample.rs` (MIT OR Apache-2.0), improved: FilmCraft's
 * 16 taps / β = 8 on a half-step-offset grid under-reads the true peak of white noise by ≈ 0.9 dB (and of a 45°
 * fs/4 tone by ≈ 0.17 dB) against ffmpeg's `ebur128`.
 */

/** Taps per polyphase branch. */
export const TAPS_PER_PHASE = 32;
/** Kaiser window β of the interpolation kernel. */
export const TP_KAISER_BETA = 9;
/** Cut-off of the interpolation kernel relative to the original Nyquist. */
export const TP_CUTOFF = 1;

/**
 * Oversampling factor giving an effective rate of at least 176.4 kHz, as recommended by BS.1770-4 for
 * true-peak metering: `ceil(176400 / fs)` — 4× at 44.1/48 kHz, 2× at 88.2/96 kHz, 1× at ≥ 176.4 kHz (as
 * FilmCraft), and e.g. 6× at 32 kHz, 8× at 22.05 kHz.
 */
export function truePeakFactor(sampleRate: number): number {
	if (!(sampleRate > 0)) return 4;
	return Math.max(1, Math.ceil(176400 / sampleRate - 1e-9));
}

/** Modified Bessel function of the first kind, order 0 (power series). */
export function besselI0(x: number): number {
	let sum = 1;
	let term = 1;
	const q = (x * x) / 4;
	for (let k = 1; k < 200; k++) {
		term *= q / (k * k);
		sum += term;
		if (term < sum * 1e-17) break;
	}
	return sum;
}

/** Polyphase coefficient bank shared by all channels. */
export class PolyphaseBank {
	readonly factor: number;
	/**
	 * `coeffs[(k − 1) * TAPS_PER_PHASE + j]` multiplies `x[n − j]` for the point at `n − TAPS/2 + k/factor`
	 * (k = 1 … factor − 1).
	 */
	readonly coeffs: Float64Array;
	/**
	 * Largest L1 norm of a phase (slightly inflated): `|y_k| ≤ l1 · max_j |x[n − j]|`, used to skip
	 * convolutions that provably cannot exceed a floor.
	 */
	readonly l1: number;
	/** Number of mirrored phase pairs (`k`, `factor − k`), k = 1 … ⌊factor/2⌋. */
	readonly pairs: number;
	/**
	 * Folded kernel. With `s_j = x_j + x_{T−1−j}`, `d_j = x_j − x_{T−1−j}` (j < T/2), `A = c_k[j] + c_k[T−1−j]`,
	 * `B = c_k[j] − c_k[T−1−j]`, `P = Σ A·s`, `Q = Σ B·d`: `y_k = (P + Q)/2`, `y_{f−k} = (P − Q)/2`, so
	 * `max(|y_k|, |y_{f−k}|) = (|P| + |Q|)/2`. Layout `fold[(j · pairs + (k − 1)) · 2 + {0: A, 1: B}]`.
	 */
	readonly fold: Float64Array;

	constructor(factor: number) {
		this.factor = Math.max(1, Math.floor(factor));
		const f = this.factor;
		const T = TAPS_PER_PHASE;
		const D = T / 2;
		const i0b = besselI0(TP_KAISER_BETA);
		this.coeffs = new Float64Array((f - 1) * T);
		for (let k = 1; k < f; k++) {
			const u = k / f;
			let sum = 0;
			for (let j = 0; j < T; j++) {
				const t = D - u - j; // distance (samples) from tap x[n − j] to the point
				const a = Math.PI * TP_CUTOFF * t;
				const sinc = Math.abs(a) < 1e-12 ? 1 : Math.sin(a) / a;
				const r = t / D;
				const w = besselI0(TP_KAISER_BETA * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
				this.coeffs[(k - 1) * T + j] = sinc * w;
				sum += sinc * w;
			}
			for (let j = 0; j < T; j++) this.coeffs[(k - 1) * T + j] /= sum;
		}
		let l1 = 1;
		for (let k = 1; k < f; k++) {
			let s = 0;
			for (let j = 0; j < T; j++) s += Math.abs(this.coeffs[(k - 1) * T + j]);
			if (s > l1) l1 = s;
		}
		this.l1 = l1 * (1 + 1e-9);
		this.pairs = f >> 1;
		this.fold = new Float64Array(D * this.pairs * 2);
		for (let k = 1; k <= this.pairs; k++) {
			for (let j = 0; j < D; j++) {
				const a = this.coeffs[(k - 1) * T + j];
				const b = this.coeffs[(k - 1) * T + T - 1 - j];
				this.fold[(j * this.pairs + k - 1) * 2] = a + b;
				this.fold[(j * this.pairs + k - 1) * 2 + 1] = a - b;
			}
		}
	}

	/**
	 * Delay (input samples) between an input sample and the interpolated values computed when it is pushed:
	 * pushing `x[n]` yields the points between `x[n − delay]` and `x[n − delay + 1]`.
	 */
	get delay(): number {
		return TAPS_PER_PHASE / 2;
	}
}

/** Per-channel interpolator history (double-written ring, so a contiguous window is always available). */
export class Interpolator {
	private readonly hist = new Float64Array(2 * TAPS_PER_PHASE);
	private pos = 0;
	/** Pushes left during which the window still holds a sample that could exceed the floor. */
	private hot = 0;

	reset(): void {
		this.hist.fill(0);
		this.pos = 0;
		this.hot = 0;
	}

	/**
	 * Push one input sample; returns the maximum absolute value of the `factor − 1` interpolated points between
	 * `x[n − TAPS/2]` and `x[n − TAPS/2 + 1]` (callers add the sample peaks themselves). With factor 1 this is
	 * `|x|`.
	 *
	 * `floor` (default 0) lets callers that only care about values above it skip work: when every sample in
	 * the window satisfies `|x| · l1 ≤ floor` (judged against the floor in force when each sample was
	 * pushed), no interpolated value can exceed the floor and 0 is returned without convolving. The floor
	 * must not decrease between resets (meters pass their running peak, the limiter its ceiling).
	 */
	pushPeak(bank: PolyphaseBank, x: number, floor = 0): number {
		if (bank.factor === 1) return Math.abs(x);
		const T = TAPS_PER_PHASE;
		const pos = this.pos === 0 ? T - 1 : this.pos - 1;
		this.pos = pos;
		const h = this.hist;
		h[pos] = x;
		h[pos + T] = x;
		const a0 = x < 0 ? -x : x;
		if (a0 * bank.l1 > floor) this.hot = T;
		else if (this.hot > 0) this.hot--;
		if (this.hot === 0) return 0;
		const pairs = bank.pairs;
		if (pairs === 2) return peak2pairs(bank.fold, h, pos);
		if (pairs === 1) return peak1pair(bank.fold, h, pos);
		return peakPairs(bank.fold, pairs, h, pos);
	}
}

function peak2pairs(c: Float64Array, h: Float64Array, pos: number): number {
	let p0 = 0;
	let q0 = 0;
	let p1 = 0;
	let q1 = 0;
	const last = pos + TAPS_PER_PHASE - 1;
	for (let j = 0, k = 0; j < TAPS_PER_PHASE / 2; j++, k += 4) {
		const a = h[pos + j];
		const b = h[last - j];
		const sj = a + b;
		const dj = a - b;
		p0 += c[k] * sj;
		q0 += c[k + 1] * dj;
		p1 += c[k + 2] * sj;
		q1 += c[k + 3] * dj;
	}
	return 0.5 * Math.max(Math.abs(p0) + Math.abs(q0), Math.abs(p1) + Math.abs(q1));
}

function peak1pair(c: Float64Array, h: Float64Array, pos: number): number {
	let p0 = 0;
	let q0 = 0;
	const last = pos + TAPS_PER_PHASE - 1;
	for (let j = 0, k = 0; j < TAPS_PER_PHASE / 2; j++, k += 2) {
		const a = h[pos + j];
		const b = h[last - j];
		p0 += c[k] * (a + b);
		q0 += c[k + 1] * (a - b);
	}
	return 0.5 * (Math.abs(p0) + Math.abs(q0));
}

function peakPairs(c: Float64Array, pairs: number, h: Float64Array, pos: number): number {
	let peak = 0;
	const last = pos + TAPS_PER_PHASE - 1;
	for (let q = 0; q < pairs; q++) {
		let p0 = 0;
		let q0 = 0;
		for (let j = 0; j < TAPS_PER_PHASE / 2; j++) {
			const a = h[pos + j];
			const b = h[last - j];
			const k = (j * pairs + q) * 2;
			p0 += c[k] * (a + b);
			q0 += c[k + 1] * (a - b);
		}
		const v = 0.5 * (Math.abs(p0) + Math.abs(q0));
		if (v > peak) peak = v;
	}
	return peak;
}

/**
 * Streaming true-peak meter (linear). Per channel, the maximum of the sample peak and the interpolated
 * (oversampled to ≥ 176.4 kHz) peak.
 */
export class TruePeakDetector {
	readonly sampleRate: number;
	readonly channels: number;
	readonly bank: PolyphaseBank;
	private readonly interp: Interpolator[];
	private readonly peaks: Float64Array;

	constructor(sampleRate: number, channels: number) {
		this.sampleRate = sampleRate;
		this.channels = Math.max(1, Math.floor(channels));
		this.bank = new PolyphaseBank(truePeakFactor(sampleRate));
		this.interp = Array.from({ length: this.channels }, () => new Interpolator());
		this.peaks = new Float64Array(this.channels);
	}

	/**
	 * Feed planar audio `ch[c][offset … offset + length)`. Extra channels are ignored; missing channels
	 * count as silence (their history is not advanced).
	 */
	process(ch: Float32Array[], offset = 0, length?: number): void {
		const nch = Math.min(ch.length, this.channels);
		for (let c = 0; c < nch; c++) {
			const data = ch[c];
			const end = Math.min(data.length, length === undefined ? data.length : offset + length);
			const ip = this.interp[c];
			const bank = this.bank;
			let peak = this.peaks[c];
			for (let i = offset; i < end; i++) {
				const x = data[i];
				const a = x < 0 ? -x : x;
				const tp = ip.pushPeak(bank, x, peak);
				const m = tp > a ? tp : a;
				if (m > peak) peak = m;
			}
			this.peaks[c] = peak;
		}
	}

	/** Maximum true peak over all channels (linear). */
	truePeak(): number {
		let m = 0;
		for (let c = 0; c < this.channels; c++) if (this.peaks[c] > m) m = this.peaks[c];
		return m;
	}

	/** Maximum true peak in dBTP (−Infinity for silence). */
	truePeakDb(): number {
		return 20 * Math.log10(this.truePeak());
	}

	/** Per-channel true peak (linear). Returns the internal array (do not mutate). */
	truePeakPerChannel(): Float64Array {
		return this.peaks;
	}

	reset(): void {
		this.peaks.fill(0);
		for (const ip of this.interp) ip.reset();
	}
}
