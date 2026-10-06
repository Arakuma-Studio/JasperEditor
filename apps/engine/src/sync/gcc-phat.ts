// Synchronising recordings of the same event by their audio (Clip ▸ Synchronize, Merge Clips and Create
// Multi-Camera Source Sequence by "Audio"). Ported from FilmCraft `crates/audio-dsp/src/sync.rs`
// (MIT OR Apache-2.0, see licenses/ported/multicam.md) and split so the engine can run the coarse pass on an
// 8 kHz decode and the fine pass on two short full-rate windows (sync/audio.ts) instead of holding whole
// recordings at 48 kHz in memory.
//
// `findOffset(a, b)` returns the lag `L` (samples) for which `b[n] ≈ g · a[n + L]`: when `b` started recording
// two seconds after `a`, `L = 2 · sampleRate`.
//
// 1. Coarse. Both signals are DC-removed, normalised, low-pass filtered (Blackman-windowed sinc) and decimated
//    to ≤ 8 kHz (further for very long recordings, so the transform stays ≤ 4 M points). The generalised
//    cross-correlation with partial phase-transform weighting (GCC-PHAT-β: R = A·B* / |A·B*|^β) is computed with
//    ONE complex FFT of both signals packed as a + i·b. PHAT whitens the spectra, so the peak is sharp and
//    independent of the microphones' gains and frequency responses; β < 1 keeps noise-only bins from dominating.
// 2. Fine. Around the coarse peak the same correlation is computed at the full sample rate on the loudest common
//    window (≤ 2.7 s at 48 kHz), and the peak is refined by parabolic interpolation to a fraction of a sample.
//
// Two figures say how far to trust the result: `confidence` = coarse peak height / RMS of the correlation, and
// `distinct` = its height over the highest peak more than 50 ms away (music or a steady hum can match at several
// lags). Reference: Knapp & Carter, "The generalized correlation method for estimation of time delay", IEEE Trans.
// ASSP 24(4), 1976.
import { fft, nextPow2 } from './fft.ts';

export type SyncOptions = {
	/** Largest |lag| considered, in input samples (absent = anything with enough overlap). */
	maxLag?: number;
	/** Upper bound of the coarse search's sample rate (Hz). Default 8000. */
	coarseRate?: number;
	/** Most samples (both signals together) the coarse transform may hold. Default 2²². */
	maxCoarseSamples?: number;
	/** PHAT weighting exponent (1 = full whitening, 0 = plain cross-correlation). Default 0.75. */
	phatBeta?: number;
	/** Length of the full-rate refinement window (samples). Default 2¹⁷. */
	refineWindow?: number;
};

export const SYNC_DEFAULTS = {
	coarseRate: 8000,
	maxCoarseSamples: 1 << 22,
	phatBeta: 0.75,
	refineWindow: 1 << 17,
} as const;

/** Thresholds of `reliable` (FilmCraft's). */
export const RELIABLE_CONFIDENCE = 8;
export const RELIABLE_DISTINCT = 1.5;

export type SyncResult = {
	/** `b[n]` lines up with `a[n + lag]` (samples at the input rate). */
	lag: number;
	/** The same with sub-sample precision (parabolic interpolation of the refined peak). */
	lagFine: number;
	/** Coarse peak height over the RMS of the correlation. */
	confidence: number;
	/** Coarse peak height over the next-highest peak more than 50 ms away (Infinity when there is none). */
	distinct: number;
	/** True when the signals correlate negatively (one recording has inverted polarity). */
	inverted: boolean;
	/** `confidence ≥ 8 && distinct ≥ 1.5`: the match is clear enough to trust. */
	reliable: boolean;
};

export function isReliable(confidence: number, distinct: number): boolean {
	return confidence >= RELIABLE_CONFIDENCE && distinct >= RELIABLE_DISTINCT;
}

/** Average planar channels into one mono signal (length of the shortest channel). */
export function mixdown(channels: readonly Float32Array[]): Float32Array {
	const n = channels.reduce((m, c) => Math.min(m, c.length), channels.length ? Number.POSITIVE_INFINITY : 0);
	const out = new Float32Array(n);
	const k = Math.max(1, channels.length);
	for (const c of channels) for (let i = 0; i < n; i++) out[i] = out[i]! + c[i]! / k;
	return out;
}

/** Low-pass (Blackman-windowed sinc, cutoff 0.42 × the new sample rate) and keep every `d`-th sample. */
export function decimate(x: Float32Array, d: number): Float32Array {
	if (d <= 1) return Float32Array.from(x);
	const half = 8 * d;
	const fc = 0.42 / d; // cycles per input sample
	const n = 2 * half + 1;
	const h = new Float64Array(n);
	let sum = 0;
	for (let k = 0; k < n; k++) {
		const t = k - half;
		const sinc = t === 0 ? 2 * fc : Math.sin(2 * Math.PI * fc * t) / (Math.PI * t);
		const w = 0.42 - 0.5 * Math.cos((2 * Math.PI * k) / (n - 1)) + 0.08 * Math.cos((4 * Math.PI * k) / (n - 1));
		h[k] = sinc * w;
		sum += h[k]!;
	}
	for (let k = 0; k < n; k++) h[k] = h[k]! / sum;
	const outLen = Math.ceil(x.length / d);
	const out = new Float32Array(outLen);
	for (let i = 0; i < outLen; i++) {
		const c = i * d;
		const lo = Math.max(0, c - half);
		const hi = Math.min(x.length, c + half + 1);
		const k0 = lo - (c - half);
		let acc = 0;
		for (let j = lo; j < hi; j++) acc += x[j]! * h[k0 + (j - lo)]!;
		out[i] = acc;
	}
	return out;
}

/** Remove the mean and scale to unit RMS (silence stays silence), in place. */
function normalise(x: Float32Array): Float32Array {
	if (x.length === 0) return x;
	let mean = 0;
	for (let i = 0; i < x.length; i++) mean += x[i]!;
	mean /= x.length;
	let e = 0;
	for (let i = 0; i < x.length; i++) {
		const v = x[i]! - mean;
		x[i] = v;
		e += v * v;
	}
	const rms = Math.sqrt(e / x.length);
	if (rms > 1e-12) {
		const k = 1 / rms;
		for (let i = 0; i < x.length; i++) x[i] = x[i]! * k;
	}
	return x;
}

/**
 * GCC-PHAT-β of `a` and `b` zero-padded to `n` (a power of two ≥ a.length + b.length):
 * `r[L mod n] = Σ a[i + L]·b[i]` with whitened spectra. Only bins whose frequency (cycles per sample) lies in
 * `band` contribute. One complex FFT carries both real signals (x = a + i·b).
 */
function gcc(a: Float32Array, b: Float32Array, n: number, beta: number, band: [number, number]): Float64Array {
	const re = new Float64Array(n);
	const im = new Float64Array(n);
	re.set(a);
	im.set(b);
	fft(re, im);
	// X = A + iB for real a, b: A(k) = (X(k) + X*(n−k)) / 2, B(k) = (X(k) − X*(n−k)) / 2i.
	const weigh = (k: number, xr: number, xi: number, yr: number, yi: number): [number, number] => {
		// y = X*(n−k), given already conjugated.
		const ar = 0.5 * (xr + yr);
		const ai = 0.5 * (xi + yi);
		const dr = xr - yr;
		const di = xi - yi;
		const br = 0.5 * di;
		const bi = -0.5 * dr;
		// R = A·conj(B)
		const rr = ar * br + ai * bi;
		const ri = ai * br - ar * bi;
		const f = Math.min(k, n - k) / n;
		if (f < band[0] || f > band[1]) return [0, 0];
		const mag = Math.sqrt(rr * rr + ri * ri);
		if (mag <= 1e-30) return [0, 0];
		const w = mag ** -beta;
		return [rr * w, ri * w];
	};
	for (let k = 0; k <= n / 2; k++) {
		const j = (n - k) % n;
		const xkr = re[k]!;
		const xki = im[k]!;
		const xjr = re[j]!;
		const xji = im[j]!;
		const rk = weigh(k, xkr, xki, xjr, -xji);
		const rj = weigh(j, xjr, xji, xkr, -xki);
		re[k] = rk[0];
		im[k] = rk[1];
		re[j] = rj[0];
		im[j] = rj[1];
	}
	fft(re, im, true);
	return re;
}

const corrAt = (r: Float64Array, lag: number): number => {
	const n = r.length;
	return r[((lag % n) + n) % n]!;
};

function energy(x: Float32Array): number {
	let e = 0;
	for (let i = 0; i < x.length; i++) e += x[i]! * x[i]!;
	return e;
}

export type CoarseResult = {
	/** Lag in input samples (a multiple of `factor`). */
	lag: number;
	/** Decimation factor used (lag resolution in input samples). */
	factor: number;
	confidence: number;
	distinct: number;
	inverted: boolean;
};

/**
 * The coarse pass on whole signals at `sampleRate` (decimated internally to ≤ `coarseRate`). Null when either
 * signal is too short (< 0.1 s) or silent, or no lag leaves enough overlap.
 */
export function coarseOffset(
	a: Float32Array,
	b: Float32Array,
	sampleRate: number,
	opts: SyncOptions = {},
): CoarseResult | null {
	const sr = Math.max(1, Math.round(sampleRate));
	const minLen = Math.max(Math.floor(sr / 10), 64);
	if (a.length < minLen || b.length < minLen) return null;
	if (energy(a) < 1e-12 || energy(b) < 1e-12) return null;
	const coarseRate = Math.max(500, opts.coarseRate ?? SYNC_DEFAULTS.coarseRate);
	const maxCoarse = Math.max(1 << 12, opts.maxCoarseSamples ?? SYNC_DEFAULTS.maxCoarseSamples);
	const beta = opts.phatBeta ?? SYNC_DEFAULTS.phatBeta;
	const d = Math.max(Math.ceil(sr / coarseRate), Math.ceil((a.length + b.length) / maxCoarse), 1);
	const ca = decimate(normalise(Float32Array.from(a)), d);
	const cb = decimate(normalise(Float32Array.from(b)), d);
	const la = ca.length;
	const lb = cb.length;
	const n = nextPow2(la + lb);
	const rateC = sr / d;
	const band: [number, number] = [Math.min(40 / rateC, 0.05), d > 1 ? 0.4 : 0.5];
	const r = gcc(ca, cb, n, beta, band);
	// valid lags: b[0..lb) against a[L..L+lb) must overlap by a minimum amount
	const minOverlap = Math.max(Math.min(Math.floor(rateC / 2), Math.floor(Math.min(la, lb) / 4)), 8);
	const maxLagC = opts.maxLag !== undefined ? Math.floor(Math.abs(opts.maxLag) / d) + 1 : null;
	const lo = -(lb - minOverlap);
	const hi = la - minOverlap;
	if (hi < lo) return null;
	let bestL = 0;
	let bestV = 0;
	let sum2 = 0;
	let count = 0;
	for (let l = lo; l <= hi; l++) {
		if (maxLagC !== null && Math.abs(l) > maxLagC) continue;
		const v = corrAt(r, l);
		sum2 += v * v;
		count++;
		if (Math.abs(v) > Math.abs(bestV)) {
			bestL = l;
			bestV = v;
		}
	}
	if (count === 0 || bestV === 0) return null;
	const rms = Math.max(Math.sqrt(sum2 / count), 1e-30);
	const confidence = Math.abs(bestV) / rms;
	const guard = Math.max(Math.floor(rateC * 0.05), 2);
	let second = 0;
	for (let l = lo; l <= hi; l++) {
		if (Math.abs(l - bestL) <= guard || (maxLagC !== null && Math.abs(l) > maxLagC)) continue;
		second = Math.max(second, Math.abs(corrAt(r, l)));
	}
	const distinct = second > 0 ? Math.abs(bestV) / second : Number.POSITIVE_INFINITY;
	return { lag: bestL * d, factor: d, confidence, distinct, inverted: bestV < 0 };
}

/**
 * Start (index into `b`) of the length-`w` window with the most energy on both sides, where `a` is read shifted by
 * `lag` (b[i] ↔ a[i + lag]). Searched in quarter-window hops over the common part `[ov0, ov1)`.
 */
export function loudestCommonWindow(a: Float32Array, b: Float32Array, lag: number, w: number): number {
	const ov0 = Math.max(-lag, 0);
	const ov1 = Math.min(b.length, a.length - lag);
	const pre = (x: Float32Array) => {
		const p = new Float64Array(x.length + 1);
		for (let i = 0; i < x.length; i++) p[i + 1] = p[i]! + x[i]! * x[i]!;
		return p;
	};
	const pa = pre(a);
	const pb = pre(b);
	const hop = Math.max(1, Math.floor(w / 4));
	let best = ov0;
	let bestE = -1;
	for (let s = ov0; s + w <= ov1; s += hop) {
		const eb = pb[s + w]! - pb[s]!;
		const ea = pa[s + lag + w]! - pa[s + lag]!;
		const e = Math.min(ea, eb);
		if (e > bestE) {
			bestE = e;
			best = s;
		}
	}
	return best;
}

/**
 * The fine pass on two full-rate windows: `bw` = b[s, s + w) and `aw` = a[s + coarse − margin, s + coarse + w +
 * margin) (zero outside `a`). Returns the correction `delta` (integer samples, |delta| ≤ margin) to add to the
 * coarse lag and the sub-sample fraction `frac` ∈ [−0.5, 0.5] from parabolic interpolation of the peak.
 */
export function refineOffset(
	aw: Float32Array,
	bw: Float32Array,
	margin: number,
	sampleRate: number,
	inverted: boolean,
	opts: SyncOptions = {},
): { delta: number; frac: number } {
	const sr = Math.max(1, sampleRate);
	const beta = opts.phatBeta ?? SYNC_DEFAULTS.phatBeta;
	const a2 = normalise(Float32Array.from(aw));
	const b2 = normalise(Float32Array.from(bw));
	const n2 = nextPow2(a2.length + b2.length);
	const r2 = gcc(a2, b2, n2, beta, [20 / sr, 0.5]);
	// r2[L'] = Σ aw[i + L']·bw[i]; L' = margin + δ
	const sign = inverted ? -1 : 1;
	let bl = 0;
	let bv = Number.NEGATIVE_INFINITY;
	for (let l = 0; l <= 2 * margin; l++) {
		const v = corrAt(r2, l) * sign;
		if (v > bv) {
			bv = v;
			bl = l;
		}
	}
	const y0 = corrAt(r2, bl - 1) * sign;
	const y2 = corrAt(r2, bl + 1) * sign;
	const den = y0 - 2 * bv + y2;
	const frac = Math.abs(den) > 1e-20 ? Math.min(0.5, Math.max(-0.5, (0.5 * (y0 - y2)) / den)) : 0;
	return { delta: bl - margin, frac };
}

/** Margin (samples) of the fine pass around a coarse lag found with decimation `factor`. */
export function refineMargin(factor: number): number {
	return 2 * factor + 4;
}

/**
 * Find the lag `L` with `b[n] ≈ g·a[n + L]` (see the module notes). Null when either signal is too short or
 * silent, or no lag leaves enough overlap.
 */
export function findOffset(
	a: Float32Array,
	b: Float32Array,
	sampleRate: number,
	opts: SyncOptions = {},
): SyncResult | null {
	const c = coarseOffset(a, b, sampleRate, opts);
	if (!c) return null;
	const { confidence, distinct, inverted } = c;
	const reliable = isReliable(confidence, distinct);
	const coarse = c.lag;
	const margin = refineMargin(c.factor);
	const ov0 = Math.max(-coarse, 0);
	const ov1 = Math.min(b.length, a.length - coarse);
	if (ov1 - ov0 < 16) return { lag: coarse, lagFine: coarse, confidence, distinct, inverted, reliable };
	const w = Math.min(ov1 - ov0, Math.max(256, opts.refineWindow ?? SYNC_DEFAULTS.refineWindow));
	const start = loudestCommonWindow(a, b, coarse, w);
	const bw = b.subarray(start, start + w);
	const aw = new Float32Array(w + 2 * margin);
	for (let k = 0; k < aw.length; k++) {
		const i = start + coarse - margin + k;
		aw[k] = i >= 0 && i < a.length ? a[i]! : 0;
	}
	const { delta, frac } = refineOffset(aw, bw, margin, sampleRate, inverted, opts);
	const lag = coarse + delta;
	return { lag, lagFine: lag + frac, confidence, distinct, inverted, reliable };
}
