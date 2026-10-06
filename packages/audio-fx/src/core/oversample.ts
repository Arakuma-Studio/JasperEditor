// Polyphase FIR interpolator used for true-peak estimation (ITU-R BS.1770-4 Annex 2 style; port of filmcraft
// `oversample.rs`). The prototype is a Kaiser-windowed sinc low-pass (cut-off at the original Nyquist) split into
// `factor` phases of `TAPS_PER_PHASE` taps; each phase is normalised to unity DC gain.

/** Taps per polyphase branch. */
export const TAPS_PER_PHASE = 16;

/**
 * Oversampling factor giving an effective rate of at least 176.4 kHz (4× at 44.1/48 kHz, 2× at 88.2/96 kHz, 1×
 * above), as BS.1770-4 recommends for true-peak metering.
 */
export function truePeakFactor(sampleRate: number): number {
	return sampleRate < 88_200 ? 4 : sampleRate < 176_400 ? 2 : 1;
}

function besselI0(x: number): number {
	let sum = 1;
	let term = 1;
	const q = (x * x) / 4;
	for (let k = 1; k < 50; k++) {
		term *= q / (k * k);
		sum += term;
		if (term < sum * 1e-17) break;
	}
	return sum;
}

/** Polyphase coefficient bank shared by all channels. */
export class PolyphaseBank {
	readonly factor: number;
	/** `coeffs[p * TAPS_PER_PHASE + j]` multiplies `x[n − j]` for output phase `p`. */
	readonly coeffs: Float64Array;

	constructor(factor: number) {
		this.factor = Math.max(1, factor);
		const f = this.factor;
		const len = f * TAPS_PER_PHASE;
		const centre = (len - 1) / 2;
		const beta = 8;
		const i0b = besselI0(beta);
		const proto = new Float64Array(len);
		for (let m = 0; m < len; m++) {
			const t = (m - centre) / f;
			const sinc = Math.abs(t) < 1e-12 ? 1 : Math.sin(Math.PI * t) / (Math.PI * t);
			const r = (m - centre) / (centre + 1);
			proto[m] = (sinc * besselI0(beta * Math.sqrt(Math.max(0, 1 - r * r)))) / i0b;
		}
		this.coeffs = new Float64Array(len);
		for (let p = 0; p < f; p++) {
			let sum = 0;
			for (let j = 0; j < TAPS_PER_PHASE; j++) sum += proto[p + f * j]!;
			for (let j = 0; j < TAPS_PER_PHASE; j++) this.coeffs[p * TAPS_PER_PHASE + j] = proto[p + f * j]! / sum;
		}
	}

	/** Approximate delay (input samples) between an input sample and the interpolated values around it. */
	delay(): number {
		return TAPS_PER_PHASE / 2;
	}
}

/** Per-channel interpolator history. */
export class Interpolator {
	/** Double-written ring so a contiguous window of TAPS_PER_PHASE is always available. */
	private readonly hist = new Float64Array(2 * TAPS_PER_PHASE);
	private pos = 0;

	reset(): void {
		this.hist.fill(0);
		this.pos = 0;
	}

	/** Push one input sample; returns the largest |value| of the `factor` interpolated samples produced for it. */
	pushPeak(bank: PolyphaseBank, x: number): number {
		if (bank.factor === 1) return Math.abs(x);
		this.pos = this.pos === 0 ? TAPS_PER_PHASE - 1 : this.pos - 1;
		this.hist[this.pos] = x;
		this.hist[this.pos + TAPS_PER_PHASE] = x;
		const h = this.hist;
		const base = this.pos;
		const c = bank.coeffs;
		let peak = 0;
		for (let p = 0; p < bank.factor; p++) {
			let y = 0;
			const o = p * TAPS_PER_PHASE;
			for (let j = 0; j < TAPS_PER_PHASE; j++) y += c[o + j]! * h[base + j]!;
			const a = Math.abs(y);
			if (a > peak) peak = a;
		}
		return peak;
	}
}
