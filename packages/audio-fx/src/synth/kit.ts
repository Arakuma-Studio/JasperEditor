// Jasper Synth building blocks (spec 12 §2.1): a seeded PRNG and small, deterministic DSP helpers in float64.
// No Math.random, no time, no environment: the same recipe and seed give the same samples, bit for bit (the
// transcendental functions are V8's fdlibm ports, the same on every platform).
import { Biquad, designBiquad, type FilterType } from '@jasper/audio-dsp';

/** SplitMix32 (Steele, Lea & Flood 2014, 32-bit variant): a tiny, well-mixed, seedable generator. */
export class SplitMix32 {
	private x: number;

	constructor(seed: number) {
		this.x = seed >>> 0;
	}

	/** Next unsigned 32-bit integer. */
	nextU32(): number {
		this.x = (this.x + 0x9e3779b9) >>> 0;
		let z = this.x;
		z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
		z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
		return (z ^ (z >>> 16)) >>> 0;
	}

	/** Uniform in [0, 1). */
	unit(): number {
		return this.nextU32() / 4294967296;
	}

	/** Uniform in [-1, 1). */
	bipolar(): number {
		return this.unit() * 2 - 1;
	}

	/** Uniform in [lo, hi). */
	range(lo: number, hi: number): number {
		return lo + (hi - lo) * this.unit();
	}

	/** Log-uniform in [lo, hi) (lo, hi > 0). */
	logRange(lo: number, hi: number): number {
		return lo * (hi / lo) ** this.unit();
	}

	/** Integer in [lo, hi]. */
	int(lo: number, hi: number): number {
		return lo + Math.min(hi - lo, Math.floor(this.unit() * (hi - lo + 1)));
	}

	pick<T>(items: readonly T[]): T {
		return items[this.int(0, items.length - 1)]!;
	}
}

/** FNV-1a 32-bit hash of a string (recipe ids → PRNG streams). */
export function hashString(s: string): number {
	let h = 0x811c9dc5;
	for (let i = 0; i < s.length; i++) {
		h ^= s.charCodeAt(i);
		h = Math.imul(h, 0x01000193) >>> 0;
	}
	return h >>> 0;
}

export const TWO_PI = 2 * Math.PI;

/** A mono work buffer of `seconds` at `sr`. */
export function buffer(sr: number, seconds: number): Float64Array {
	return new Float64Array(Math.max(1, Math.round(sr * seconds)));
}

/** Add white noise × `env(t)` into `out`. */
export function addNoise(
	out: Float64Array,
	sr: number,
	rng: SplitMix32,
	env: (t: number) => number,
	from = 0,
): void {
	for (let i = Math.max(0, Math.round(from * sr)); i < out.length; i++) out[i] += rng.bipolar() * env(i / sr);
}

/** Add a sine whose frequency and amplitude follow `freq(t)` and `amp(t)` (phase-continuous). */
export function addSine(
	out: Float64Array,
	sr: number,
	freq: (t: number) => number,
	amp: (t: number) => number,
	phase = 0,
	from = 0,
): void {
	let ph = phase;
	for (let i = Math.max(0, Math.round(from * sr)); i < out.length; i++) {
		const t = i / sr;
		const f = freq(t);
		if (f < sr / 2) out[i] += amp(t) * Math.sin(ph);
		ph += (TWO_PI * f) / sr;
		if (ph > TWO_PI) ph -= TWO_PI;
	}
}

/**
 * Add a band-limited sawtooth (additive: every harmonic under 0.45·sr, so a falling sweep never aliases) following
 * `freq(t)` and `amp(t)`.
 */
export function addSaw(
	out: Float64Array,
	sr: number,
	freq: (t: number) => number,
	amp: (t: number) => number,
	maxHarmonics = 64,
): void {
	let ph = 0;
	for (let i = 0; i < out.length; i++) {
		const t = i / sr;
		const f = freq(t);
		const a = amp(t);
		const kmax = Math.min(maxHarmonics, Math.floor((0.45 * sr) / Math.max(f, 1)));
		let s = 0;
		for (let k = 1; k <= kmax; k++) s += Math.sin(k * ph) / k;
		out[i] += a * (2 / Math.PI) * s;
		ph += (TWO_PI * f) / sr;
		if (ph > TWO_PI) ph -= TWO_PI;
	}
}

/**
 * Filter `x` in place with an RBJ biquad whose cutoff follows `freq(t)` (coefficients updated every 16 samples).
 * `q` and `stages` (cascaded identical sections) set the slope.
 */
export function filter(
	x: Float64Array,
	sr: number,
	kind: FilterType,
	freq: number | ((t: number) => number),
	q = Math.SQRT1_2,
	stages = 1,
): Float64Array {
	const f = typeof freq === 'number' ? () => freq : freq;
	const sections = Array.from({ length: stages }, () => new Biquad(designBiquad(kind, sr, f(0), q)));
	for (let i = 0; i < x.length; i++) {
		if (i % 16 === 0 && typeof freq !== 'number') {
			const c = designBiquad(kind, sr, f(i / sr), q);
			for (const s of sections) s.setCoeffs(c);
		}
		let v = x[i]!;
		for (const s of sections) v = s.processSample(v);
		x[i] = v;
	}
	return x;
}

/** Exponential decay with time constant `tau` (s), starting at `t0`. */
export const expDecay =
	(tau: number, t0 = 0) =>
	(t: number): number =>
		t < t0 ? 0 : Math.exp(-(t - t0) / tau);

/** Linear attack of `attack` s into an exponential decay `tau`, starting at `t0`. */
export const attackDecay =
	(attack: number, tau: number, t0 = 0) =>
	(t: number): number => {
		const u = t - t0;
		if (u < 0) return 0;
		return u < attack ? u / attack : Math.exp(-(u - attack) / tau);
	};

/** Raised-cosine bell from `t0` to `t1` with its maximum at `peak` (0…1 of the way). */
export const bell =
	(t0: number, t1: number, peak = 0.5) =>
	(t: number): number => {
		if (t <= t0 || t >= t1) return 0;
		const u = (t - t0) / (t1 - t0);
		const v = u < peak ? (u / peak) * 0.5 : 0.5 + ((u - peak) / (1 - peak)) * 0.5;
		return 0.5 - 0.5 * Math.cos(TWO_PI * v);
	};

/** Equal-power pan of a mono buffer to stereo; `pan(t)` in −1 … 1. */
export function panStereo(
	x: Float64Array,
	sr: number,
	pan: number | ((t: number) => number),
): Float64Array[] {
	const l = new Float64Array(x.length);
	const r = new Float64Array(x.length);
	for (let i = 0; i < x.length; i++) {
		const p = typeof pan === 'number' ? pan : pan(i / sr);
		const a = ((Math.max(-1, Math.min(1, p)) + 1) * Math.PI) / 4;
		l[i] = x[i]! * Math.cos(a) * Math.SQRT2;
		r[i] = x[i]! * Math.sin(a) * Math.SQRT2;
	}
	return [l, r];
}

/** Mix `b × gain` into `a` (in place). */
export function mixInto(a: Float64Array, b: Float64Array, gain = 1): Float64Array {
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) a[i] += b[i]! * gain;
	return a;
}

/** Reverse in place. */
export function reverse(x: Float64Array): Float64Array {
	x.reverse();
	return x;
}

/**
 * Finish a render: a 25 Hz high-pass (no DC), raised-cosine fades (`fadeIn`, `fadeOut` seconds) and the peak of all
 * channels normalised to `peakDb` dBFS; returns Float32 channels.
 */
export function finish(
	chs: Float64Array[],
	sr: number,
	opts: { peakDb?: number; fadeIn?: number; fadeOut?: number } = {},
): Float32Array[] {
	const fadeIn = Math.max(0, Math.round((opts.fadeIn ?? 0) * sr));
	const fadeOut = Math.max(1, Math.round((opts.fadeOut ?? 0.005) * sr));
	let peak = 0;
	for (const c of chs) {
		filter(c, sr, 'highPass', 25, Math.SQRT1_2, 1);
		const n = c.length;
		for (let i = 0; i < Math.min(fadeIn, n); i++) c[i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeIn);
		for (let i = 0; i < Math.min(fadeOut, n); i++)
			c[n - 1 - i] *= 0.5 - 0.5 * Math.cos((Math.PI * i) / fadeOut);
		for (let i = 0; i < n; i++) peak = Math.max(peak, Math.abs(c[i]!));
	}
	const g = peak > 0 ? 10 ** ((opts.peakDb ?? -1) / 20) / peak : 0;
	return chs.map((c) => {
		const out = new Float32Array(c.length);
		for (let i = 0; i < c.length; i++) out[i] = c[i]! * g;
		return out;
	});
}
