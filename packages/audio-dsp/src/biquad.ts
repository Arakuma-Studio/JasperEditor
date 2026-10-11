/**
 * Second-order IIR sections: RBJ "Audio EQ Cookbook" designs, transposed direct form II in float64.
 *
 * Ported from FilmCraft `crates/audio-dsp/src/biquad.rs` (MIT OR Apache-2.0).
 */

/** Normalised biquad coefficients (`a0 == 1`): `H(z) = (b0 + b1 z⁻¹ + b2 z⁻²) / (1 + a1 z⁻¹ + a2 z⁻²)`. */
export type BiquadCoeffs = { b0: number; b1: number; b2: number; a1: number; a2: number };

export type FilterType =
	| 'peaking'
	| 'lowShelf'
	| 'highShelf'
	| 'lowPass'
	| 'highPass'
	| 'notch'
	| 'bandPass'
	| 'allPass'
	/**
	 * Constant-bandwidth cut: `1 + (g − 1)·BP(s)` — the −3 dB width of the band-pass stays `f/Q` however deep
	 * the cut (`gainDb` ≤ 0), unlike the RBJ peaking filter whose cut widens with depth.
	 */
	| 'cut';

/** Pass-through coefficients. */
export const BIQUAD_IDENTITY: Readonly<BiquadCoeffs> = Object.freeze({ b0: 1, b1: 0, b2: 0, a1: 0, a2: 0 });

/** Flush tiny values to zero (denormal protection for recursive state). */
export function flushDenormal(x: number): number {
	return x > -1e-30 && x < 1e-30 ? 0 : x;
}

function norm(b0: number, b1: number, b2: number, a0: number, a1: number, a2: number): BiquadCoeffs {
	return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 };
}

/**
 * RBJ cookbook design. `freq` in Hz (clamped to [1, 0.49·sampleRate]), `q` > 0 (clamped to ≥ 1e-3),
 * `gainDb` used by peaking, shelving and cut types (shelves use `q` as the shelf "Q": S = 1 ≙ Q = 1/√2).
 */
export function designBiquad(
	kind: FilterType,
	sampleRate: number,
	freq: number,
	q: number,
	gainDb = 0,
): BiquadCoeffs {
	const f = Math.min(Math.max(freq, 1), sampleRate * 0.49);
	const qq = Math.max(q, 1e-3);
	const w0 = (2 * Math.PI * f) / sampleRate;
	const sn = Math.sin(w0);
	const cs = Math.cos(w0);
	const alpha = sn / (2 * qq);
	const a = 10 ** (gainDb / 40);
	switch (kind) {
		case 'lowPass':
			return norm((1 - cs) / 2, 1 - cs, (1 - cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
		case 'highPass':
			return norm((1 + cs) / 2, -(1 + cs), (1 + cs) / 2, 1 + alpha, -2 * cs, 1 - alpha);
		case 'bandPass':
			return norm(alpha, 0, -alpha, 1 + alpha, -2 * cs, 1 - alpha);
		case 'notch':
			return norm(1, -2 * cs, 1, 1 + alpha, -2 * cs, 1 - alpha);
		case 'allPass':
			return norm(1 - alpha, -2 * cs, 1 + alpha, 1 + alpha, -2 * cs, 1 - alpha);
		case 'cut': {
			const g = 10 ** (gainDb / 20);
			return norm(1 + g * alpha, -2 * cs, 1 - g * alpha, 1 + alpha, -2 * cs, 1 - alpha);
		}
		case 'peaking':
			return norm(1 + alpha * a, -2 * cs, 1 - alpha * a, 1 + alpha / a, -2 * cs, 1 - alpha / a);
		case 'lowShelf': {
			const k = 2 * Math.sqrt(a) * alpha;
			return norm(
				a * (a + 1 - (a - 1) * cs + k),
				2 * a * (a - 1 - (a + 1) * cs),
				a * (a + 1 - (a - 1) * cs - k),
				a + 1 + (a - 1) * cs + k,
				-2 * (a - 1 + (a + 1) * cs),
				a + 1 + (a - 1) * cs - k,
			);
		}
		case 'highShelf': {
			const k = 2 * Math.sqrt(a) * alpha;
			return norm(
				a * (a + 1 + (a - 1) * cs + k),
				-2 * a * (a - 1 + (a + 1) * cs),
				a * (a + 1 + (a - 1) * cs - k),
				a + 1 - (a - 1) * cs + k,
				2 * (a - 1 - (a + 1) * cs),
				a + 1 - (a - 1) * cs - k,
			);
		}
	}
}

/**
 * Second-order analog section `(n0·s² + n1·s·ω0/Q + n2·ω0²) / (s² + s·ω0/Q + ω0²)` mapped through the
 * bilinear transform with the centre frequency `f0` pre-warped (`K = tan(π·f0/fs)`):
 * `b = (n0 + n1·K/Q + n2·K², 2(n2·K² − n0), n0 − n1·K/Q + n2·K²) / a0`, `a0 = 1 + K/Q + K²`.
 * The K-weighting stages ({@link kPrefilter}, {@link kRlb}) are instances of this.
 */
export function bilinearSection(
	sampleRate: number,
	f0: number,
	q: number,
	n0: number,
	n1: number,
	n2: number,
): BiquadCoeffs {
	const k = Math.tan((Math.PI * f0) / sampleRate);
	const a0 = 1 + k / q + k * k;
	return {
		b0: (n0 + (n1 * k) / q + n2 * k * k) / a0,
		b1: (2 * (n2 * k * k - n0)) / a0,
		b2: (n0 - (n1 * k) / q + n2 * k * k) / a0,
		a1: (2 * (k * k - 1)) / a0,
		a2: (1 - k / q + k * k) / a0,
	};
}

/**
 * Bilinear high shelf with high-frequency gain `vh` (linear) and band gain `vb` (linear) at the analog
 * centre `f0` / quality `q` — the shape of the BS.1770 K-weighting pre-filter.
 */
export function bilinearHighShelf(
	sampleRate: number,
	f0: number,
	q: number,
	vh: number,
	vb: number,
): BiquadCoeffs {
	return bilinearSection(sampleRate, f0, q, vh, vb, 1);
}

/** Bilinear second-order high-pass at the analog centre `f0` / quality `q` (unnormalised b = 1, −2, 1). */
export function bilinearHighPass(sampleRate: number, f0: number, q: number): BiquadCoeffs {
	const c = bilinearSection(sampleRate, f0, q, 1, 0, 0);
	// b = (1, −2, 1)·(1/a0) for the normalised high-pass; BS.1770 keeps the unnormalised numerator (1, −2, 1).
	return { b0: 1, b1: -2, b2: 1, a1: c.a1, a2: c.a2 };
}

/** |H(e^{jω})| at `freqHz`. */
export function biquadMagnitude(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
	const w = (2 * Math.PI * freqHz) / sampleRate;
	const s1 = Math.sin(w);
	const c1 = Math.cos(w);
	const s2 = Math.sin(2 * w);
	const c2 = Math.cos(2 * w);
	const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
	const ni = -(c.b1 * s1 + c.b2 * s2);
	const dr = 1 + c.a1 * c1 + c.a2 * c2;
	const di = -(c.a1 * s1 + c.a2 * s2);
	return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

/** Analytic magnitude response in dB at `freqHz`. */
export function biquadMagnitudeDb(c: BiquadCoeffs, freqHz: number, sampleRate: number): number {
	return 20 * Math.log10(biquadMagnitude(c, freqHz, sampleRate));
}

/** One biquad section (transposed direct form II, float64 state, denormals flushed below 1e-30). */
export class Biquad {
	private b0 = 1;
	private b1 = 0;
	private b2 = 0;
	private a1 = 0;
	private a2 = 0;
	private s1 = 0;
	private s2 = 0;

	constructor(c: BiquadCoeffs = BIQUAD_IDENTITY) {
		this.setCoeffs(c);
	}

	/** Replace the coefficients, keeping the state (glitch-free for small changes). */
	setCoeffs(c: BiquadCoeffs): void {
		this.b0 = c.b0;
		this.b1 = c.b1;
		this.b2 = c.b2;
		this.a1 = c.a1;
		this.a2 = c.a2;
	}

	reset(): void {
		this.s1 = 0;
		this.s2 = 0;
	}

	/** Filter one sample. */
	processSample(x: number): number {
		const y = this.b0 * x + this.s1;
		this.s1 = flushDenormal(this.b1 * x - this.a1 * y + this.s2);
		this.s2 = flushDenormal(this.b2 * x - this.a2 * y);
		return y;
	}

	/** Filter `buf[offset … offset + length)` in place. */
	processBlock(buf: Float32Array, offset = 0, length = buf.length - offset): void {
		const end = Math.min(buf.length, offset + length);
		for (let i = offset; i < end; i++) buf[i] = this.processSample(buf[i]);
	}
}
