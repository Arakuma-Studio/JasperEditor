// Sound Check measurements (spec 12 §2.6, P5-R1; wp-note "Phase 5 → WP5.1"): 10 ms curves of a stem streamed block by
// block, the loudness curves derived from them, and peak location by cross-correlation. Pure and deterministic.
//
//   CurveMeter      per 10 ms hop: the BS.1770-4 K-weighted, channel-weighted energy (the loudness meter's measure),
//                   the mean square over the channels (dBFS), the mean square of the loudest channel and the sample
//                   peak. Fed in blocks of any size; the
//                   result does not depend on how the stream is cut.
//   loudnessCurve   from the hop energies: the loudness of a window CENTRED on every hop (400 ms = momentary,
//                   3 s = short-term), LUFS, floored at LOUDNESS_FLOOR_LUFS; audio outside the stem is silence.
//   locateByCorrelation  where a reference (the sound file around its aligned point) sits in a signal (the SFX stem
//                   around its cue): normalised cross-correlation over a lag range, by FFT, with sub-sample refinement.
//
// Robustness: non-finite samples count as 0, a missing channel is silence, sizes are capped; nothing here throws for
// any argument except the documented RangeError of a hop count over the cap.
import { Biquad, defaultChannelWeights, energyToLufs, Fft, kPrefilter, kRlb } from '@jasper/audio-dsp';

/** Hop of every curve (s). */
export const CURVE_HOP_SEC = 0.01;
/** Loudness / level values never go below this (silence), so curves stay finite JSON numbers. */
export const LOUDNESS_FLOOR_LUFS = -120;
/** Longest stem a meter takes (hops = 6 h at 10 ms); more is ignored (the check refuses longer ranges before). */
export const MAX_CURVE_HOPS = 6 * 3600 * 100;

const fin = (x: number) => x - x === 0;

/** The 10 ms curves of one stem. */
export type StemCurves = {
	sampleRate: number;
	/** Samples per hop (round(sampleRate / 100)). */
	hop: number;
	/** Number of hops (the last one may be partial). */
	count: number;
	/** K-weighted, channel-weighted energy summed over each hop (Σ w_c·y²; divide by samples for a mean). */
	kEnergy: Float64Array;
	/** Mean square over the hop's samples and channels, dBFS (floored). */
	msDb: Float32Array;
	/**
	 * Mean square of the hop's loudest channel, dBFS (floored): the level of a signal in fewer channels than the layout
	 * has (a centre-only 5.1 dialogue, a left-only stereo room tone) is not lowered by the silent ones.
	 */
	loudestDb: Float32Array;
	/** Largest |sample| of the hop over the channels, dBFS (floored). */
	peakDb: Float32Array;
};

/** Streams planar blocks into 10 ms curves (see the module docs). */
export class CurveMeter {
	readonly sampleRate: number;
	readonly channels: number;
	readonly hop: number;
	private readonly weights: number[];
	private readonly pre: Biquad[];
	private readonly rlb: Biquad[];
	private readonly cap: number;
	private kE: Float64Array;
	private ms: Float64Array;
	private lc: Float64Array;
	private pk: Float32Array;
	private readonly accC: Float64Array;
	private n = 0;
	private pos = 0;
	private accK = 0;
	private accS = 0;
	private accP = 0;

	constructor(sampleRate: number, channels: number, maxHops = MAX_CURVE_HOPS) {
		this.sampleRate = fin(sampleRate) && sampleRate >= 1000 ? Math.round(sampleRate) : 48_000;
		this.channels = Math.max(1, Math.min(32, Math.floor(fin(channels) ? channels : 1)));
		this.hop = Math.max(1, Math.round(this.sampleRate * CURVE_HOP_SEC));
		this.weights = defaultChannelWeights(this.channels);
		const pre = kPrefilter(this.sampleRate);
		const rlb = kRlb(this.sampleRate);
		this.pre = Array.from({ length: this.channels }, () => new Biquad(pre));
		this.rlb = Array.from({ length: this.channels }, () => new Biquad(rlb));
		this.cap = Math.max(1, Math.min(MAX_CURVE_HOPS, Math.floor(maxHops)));
		const first = Math.min(this.cap, 1024);
		this.kE = new Float64Array(first);
		this.ms = new Float64Array(first);
		this.lc = new Float64Array(first);
		this.pk = new Float32Array(first);
		this.accC = new Float64Array(this.channels);
	}

	/** Hops recorded so far. */
	get hops(): number {
		return this.n;
	}

	private grow(): void {
		const size = Math.min(this.cap, this.kE.length * 2);
		const k = new Float64Array(size);
		k.set(this.kE);
		const m = new Float64Array(size);
		m.set(this.ms);
		const l = new Float64Array(size);
		l.set(this.lc);
		const p = new Float32Array(size);
		p.set(this.pk);
		this.kE = k;
		this.ms = m;
		this.lc = l;
		this.pk = p;
	}

	private close(samples: number): void {
		if (this.n >= this.cap) return;
		if (this.n >= this.kE.length) this.grow();
		this.kE[this.n] = this.accK;
		this.ms[this.n] = this.accS / Math.max(1, samples * this.channels);
		let loudest = 0;
		for (let c = 0; c < this.channels; c++) {
			if (this.accC[c]! > loudest) loudest = this.accC[c]!;
			this.accC[c] = 0;
		}
		this.lc[this.n] = loudest / Math.max(1, samples);
		this.pk[this.n] = this.accP;
		this.n++;
		this.accK = 0;
		this.accS = 0;
		this.accP = 0;
	}

	/** Feeds `frames` samples of every channel (`planar[c][0 … frames)`; missing channels are silence). */
	push(planar: readonly Float32Array[], frames: number): void {
		const total = Math.max(0, Math.floor(fin(frames) ? frames : 0));
		let i = 0;
		while (i < total) {
			const take = Math.min(total - i, this.hop - this.pos);
			for (let c = 0; c < this.channels; c++) {
				const x = planar[c];
				const w = this.weights[c] ?? 1;
				const f1 = this.pre[c]!;
				const f2 = this.rlb[c]!;
				let k = 0;
				let s = 0;
				let p = this.accP;
				for (let j = 0; j < take; j++) {
					const raw = x && i + j < x.length ? x[i + j]! : 0;
					const v = fin(raw) ? raw : 0;
					const y = f2.processSample(f1.processSample(v));
					k += y * y;
					s += v * v;
					const a = v < 0 ? -v : v;
					if (a > p) p = a;
				}
				this.accK += w * k;
				this.accS += s;
				this.accC[c]! += s;
				this.accP = p;
			}
			this.pos += take;
			i += take;
			if (this.pos === this.hop) {
				this.close(this.hop);
				this.pos = 0;
			}
		}
	}

	/** Closes a partial last hop and returns the curves. The meter may not be fed afterwards. */
	finish(): StemCurves {
		if (this.pos > 0) {
			this.close(this.pos);
			this.pos = 0;
		}
		const n = this.n;
		const msDb = new Float32Array(n);
		const loudestDb = new Float32Array(n);
		const peakDb = new Float32Array(n);
		for (let i = 0; i < n; i++) {
			const m = this.ms[i]!;
			msDb[i] = m > 0 ? Math.max(LOUDNESS_FLOOR_LUFS, 10 * Math.log10(m)) : LOUDNESS_FLOOR_LUFS;
			const l = this.lc[i]!;
			loudestDb[i] = l > 0 ? Math.max(LOUDNESS_FLOOR_LUFS, 10 * Math.log10(l)) : LOUDNESS_FLOOR_LUFS;
			const p = this.pk[i]!;
			peakDb[i] = p > 0 ? Math.max(LOUDNESS_FLOOR_LUFS, 20 * Math.log10(p)) : LOUDNESS_FLOOR_LUFS;
		}
		return {
			sampleRate: this.sampleRate,
			hop: this.hop,
			count: n,
			kEnergy: this.kE.slice(0, n),
			msDb,
			loudestDb,
			peakDb,
		};
	}
}

/** Silent curves of `count` hops (a stem with no clips). */
export function silentCurves(sampleRate: number, count: number): StemCurves {
	const n = Math.max(0, Math.min(MAX_CURVE_HOPS, Math.floor(fin(count) ? count : 0)));
	const sr = fin(sampleRate) && sampleRate >= 1000 ? Math.round(sampleRate) : 48_000;
	return {
		sampleRate: sr,
		hop: Math.max(1, Math.round(sr * CURVE_HOP_SEC)),
		count: n,
		kEnergy: new Float64Array(n),
		msDb: new Float32Array(n).fill(LOUDNESS_FLOOR_LUFS),
		loudestDb: new Float32Array(n).fill(LOUDNESS_FLOOR_LUFS),
		peakDb: new Float32Array(n).fill(LOUDNESS_FLOOR_LUFS),
	};
}

/**
 * Loudness (LUFS) of a window of `windowSec` centred on every hop: 0.4 = BS.1770 momentary, 3 = EBU short-term. The
 * window is divided by its full length even where it runs past the stem (silence there). Floored at
 * {@link LOUDNESS_FLOOR_LUFS}.
 */
export function loudnessCurve(c: StemCurves, windowSec: number, offsetDb = 0): Float32Array {
	const n = c.count;
	const out = new Float32Array(n);
	const w = Math.max(1, Math.round((fin(windowSec) ? windowSec : 0.4) / CURVE_HOP_SEC));
	const half = Math.floor(w / 2);
	const prefix = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + c.kEnergy[i]!;
	const denom = w * c.hop;
	const off = fin(offsetDb) ? offsetDb : 0;
	for (let i = 0; i < n; i++) {
		const a = Math.max(0, i - half);
		const b = Math.min(n, i - half + w);
		const e = (prefix[b]! - prefix[a]!) / denom;
		const l = e > 0 ? energyToLufs(e) + off : Number.NEGATIVE_INFINITY;
		out[i] = l > LOUDNESS_FLOOR_LUFS ? l : LOUDNESS_FLOOR_LUFS;
	}
	return out;
}

/** Collapses a curve to at most `max` points: the maximum of each bucket (peaks survive). */
export function maxPool(curve: ArrayLike<number>, max: number): { factor: number; values: number[] } {
	const n = curve.length;
	const m = Math.max(1, Math.floor(fin(max) ? max : 1));
	const factor = Math.max(1, Math.ceil(n / m));
	const values: number[] = [];
	for (let i = 0; i < n; i += factor) {
		let v = Number.NEGATIVE_INFINITY;
		for (let j = i; j < Math.min(n, i + factor); j++) if (curve[j]! > v) v = curve[j]!;
		values.push(Math.round(v * 100) / 100);
	}
	return { factor, values };
}

export type Correlation = {
	/** Position of `reference[0]` in `signal` (samples, fractional after parabolic refinement). */
	lag: number;
	/** Normalised cross-correlation at the best lag, −1…1 (0 when either side is silent). */
	ncc: number;
};

/** Longest reference / signal accepted by {@link locateByCorrelation} (samples). */
export const MAX_CORRELATION_SAMPLES = 1 << 20;

/** Options of {@link locateByCorrelation}. */
export type CorrelationOptions = {
	/**
	 * Where the reference is expected (a lag). Among the matches at least {@link CorrelationOptions.share} of the best
	 * one (local maxima of the correlation), the one nearest this lag is taken: the same sound played twice within the
	 * lag range (a repeat, a doubled layer) matches twice, and its own copy is the one where it is expected.
	 */
	prefer?: number;
	/** Share of the best correlation a match needs to be preferred (default 0.75). */
	share?: number;
	/**
	 * A match is the largest correlation within ± this many samples (default 1: any local maximum). Callers pass about
	 * a frame, so the side lobes of a tonal sound (one period away) are not separate matches.
	 */
	separation?: number;
};

/**
 * The lag in `[minLag, maxLag]` (positions of the reference's first sample in the signal; the reference must fit) where
 * `reference` best matches `signal` by normalised cross-correlation (FFT), refined to a fraction of a sample by a
 * parabola through the best lag and its neighbours. With `prefer`, a near-equal match nearer the expected lag wins
 * (see {@link CorrelationOptions}). Null when no lag fits or either input is empty or silent.
 */
export function locateByCorrelation(
	reference: Float32Array,
	signal: Float32Array,
	minLag: number,
	maxLag: number,
	opts: CorrelationOptions = {},
): Correlation | null {
	const m = reference.length;
	const s = signal.length;
	if (m < 2 || s < m || m > MAX_CORRELATION_SAMPLES || s > MAX_CORRELATION_SAMPLES) return null;
	const lo = Math.max(0, Math.ceil(fin(minLag) ? minLag : 0));
	const hi = Math.min(s - m, Math.floor(fin(maxLag) ? maxLag : s - m));
	if (hi < lo) return null;
	let refE = 0;
	for (let i = 0; i < m; i++) {
		const v = fin(reference[i]!) ? reference[i]! : 0;
		refE += v * v;
	}
	if (!(refE > 0)) return null;
	// only the part of the signal the lags can reach
	const seg = Math.min(s, hi + m) - lo;
	let size = 2;
	while (size < seg + m) size *= 2;
	const fft = new Fft(size);
	const ar = new Float64Array(size);
	const ai = new Float64Array(size);
	const br = new Float64Array(size);
	const bi = new Float64Array(size);
	for (let i = 0; i < seg; i++) {
		const v = signal[lo + i]!;
		ar[i] = fin(v) ? v : 0;
	}
	for (let i = 0; i < m; i++) {
		const v = reference[i]!;
		br[i] = fin(v) ? v : 0;
	}
	fft.forward(ar, ai);
	fft.forward(br, bi);
	// A · conj(B): correlation of the signal against the reference at every lag
	for (let k = 0; k < size; k++) {
		const re = ar[k]! * br[k]! + ai[k]! * bi[k]!;
		const im = ai[k]! * br[k]! - ar[k]! * bi[k]!;
		ar[k] = re;
		ai[k] = im;
	}
	fft.inverse(ar, ai);
	// sliding energy of the signal under the reference
	const prefix = new Float64Array(seg + 1);
	for (let i = 0; i < seg; i++) {
		const v = signal[lo + i]!;
		const x = fin(v) ? v : 0;
		prefix[i + 1] = prefix[i]! + x * x;
	}
	const nccAt = (k: number) => {
		const e = prefix[k + m]! - prefix[k]!;
		return e > 0 ? ar[k]! / size / Math.sqrt(e * refE) : 0;
	};
	let best = -1;
	let bestV = Number.NEGATIVE_INFINITY;
	for (let k = 0; k <= hi - lo; k++) {
		const v = nccAt(k);
		if (v > bestV) {
			bestV = v;
			best = k;
		}
	}
	if (best < 0 || !(bestV > 0)) return { lag: lo, ncc: 0 };
	const prefer = opts && fin(opts.prefer as number) ? (opts.prefer as number) : null;
	if (prefer !== null) {
		const share = fin(opts.share as number) ? Math.max(0, Math.min(1, opts.share as number)) : 0.75;
		const floor = bestV * share;
		const sep = fin(opts.separation as number) ? Math.max(1, Math.floor(opts.separation as number)) : 1;
		const last = hi - lo;
		const v = new Float64Array(last + 1);
		for (let k = 0; k <= last; k++) v[k] = nccAt(k);
		let pick = best;
		for (let k = 0; k <= last; k++) {
			const x = v[k]!;
			if (x < floor || k === pick) continue;
			let top = true;
			for (let j = Math.max(0, k - sep); j <= Math.min(last, k + sep) && top; j++)
				if (v[j]! > x || (v[j] === x && j < k)) top = false;
			if (!top) continue;
			const d = Math.abs(lo + k - prefer);
			const dp = Math.abs(lo + pick - prefer);
			if (d < dp || (d === dp && x > v[pick]!)) pick = k;
		}
		best = pick;
		bestV = v[pick]!;
	}
	let frac = 0;
	if (best > 0 && best < hi - lo) {
		const y0 = nccAt(best - 1);
		const y2 = nccAt(best + 1);
		const d = y0 - 2 * bestV + y2;
		if (d < 0) frac = Math.max(-0.5, Math.min(0.5, (0.5 * (y0 - y2)) / d));
	}
	return { lag: lo + best + frac, ncc: Math.min(1, bestV) };
}

// ── Layer audibility (spec 12 §4 P6-E2 `LAYER_INAUDIBLE`; wp-note "Phase 6 → WP-E1") ─────────────────────────────────
// Adapted from earshot `skills/real-sound/scripts/qa.py` `bands` / `read_metrics` (MIT, Copyright (c) 2026 Leon Lin;
// licenses/ported/earshot.md): 1/3-octave band energies (100 Hz … 12.6 kHz, 22 bands) of a Tukey(0.25)-windowed
// segment, summed over the channels, and how much a layer adds in each band over everything else.

/** Centres of the 1/3-octave bands judged (Hz): 10^(k/10), k = 20 … 41. */
export const THIRD_OCTAVE_CENTRES_HZ: readonly number[] = Array.from(
	{ length: 22 },
	(_, i) => 10 ** ((20 + i) / 10),
);

/**
 * Energies of `len` samples from `from` in each 1/3-octave band (Tukey 0.25 window, FFT zero-padded to a power of
 * two, channels summed). Non-finite samples count as 0; bands over the Nyquist frequency are 0. Never throws.
 */
export function thirdOctaveEnergies(
	planar: readonly ArrayLike<number>[],
	from: number,
	len: number,
	sampleRate: number,
): Float64Array {
	const out = new Float64Array(THIRD_OCTAVE_CENTRES_HZ.length);
	const n = Math.max(0, Math.min(1 << 18, Math.floor(fin(len) ? len : 0)));
	const sr = fin(sampleRate) && sampleRate >= 1000 ? sampleRate : 48_000;
	if (n < 8) return out;
	let size = 8;
	while (size < n) size *= 2;
	const fft = new Fft(size);
	const power = new Float64Array(size / 2 + 1);
	const a = Math.floor(fin(from) ? from : 0);
	// Tukey window, alpha 0.25 (scipy.signal.windows.tukey)
	const alpha = 0.25;
	const edge = (alpha * (n - 1)) / 2;
	const win = new Float64Array(n);
	for (let i = 0; i < n; i++) {
		const d = Math.min(i, n - 1 - i);
		win[i] = d >= edge || edge <= 0 ? 1 : 0.5 * (1 + Math.cos(Math.PI * (d / edge - 1)));
	}
	for (const ch of planar) {
		const re = new Float64Array(size);
		const im = new Float64Array(size);
		for (let i = 0; i < n; i++) {
			const v = ch[a + i];
			re[i] = typeof v === 'number' && fin(v) ? v * win[i]! : 0;
		}
		fft.forward(re, im);
		for (let k = 0; k <= size / 2; k++) power[k]! += re[k]! * re[k]! + im[k]! * im[k]!;
	}
	THIRD_OCTAVE_CENTRES_HZ.forEach((fc, b) => {
		const lo = fc * 2 ** (-1 / 6);
		const hi = fc * 2 ** (1 / 6);
		let e = 0;
		for (let k = Math.ceil((lo * size) / sr); k <= size / 2 && (k * sr) / size < hi; k++) e += power[k]!;
		out[b] = e;
	});
	return out;
}

/** Start of the `len`-sample window of `planar` with the most energy (stepped by `step`); 0 for an empty signal. */
export function loudestWindowStart(planar: readonly ArrayLike<number>[], len: number, step = 48): number {
	const n = planar[0]?.length ?? 0;
	const w = Math.max(1, Math.floor(fin(len) ? len : 1));
	if (n <= w) return 0;
	const prefix = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) {
		let e = 0;
		for (const ch of planar) {
			const v = ch[i];
			if (typeof v === 'number' && fin(v)) e += v * v;
		}
		prefix[i + 1] = prefix[i]! + e;
	}
	const s = Math.max(1, Math.floor(step));
	let best = 0;
	let bestE = -1;
	for (let i = 0; i + w <= n; i += s) {
		const e = prefix[i + w]! - prefix[i]!;
		if (e > bestE) {
			bestE = e;
			best = i;
		}
	}
	return best;
}

export type LayerAudibility = {
	/** Largest addition over the bands the layer has energy in (dB; capped at 60). */
	maxAddDb: number;
	/** The band where the layer stands out most against the rest (index into THIRD_OCTAVE_CENTRES_HZ) and its centre. */
	dominantBand: number;
	dominantHz: number;
	/** Gain (dB) that makes the layer add `targetDb` in its dominant band (null when the layer is silent there). */
	gainForTargetDb: number | null;
};

/**
 * How much a layer adds over the rest of the mix per band: 10·log10((E_layer + E_rest) / E_rest), over the bands where
 * the layer is within 30 dB of its strongest band (earshot's "ok" bands). A layer with no energy adds 0 dB.
 */
export function layerAudibility(
	layer: ArrayLike<number>,
	rest: ArrayLike<number>,
	targetDb = 3,
): LayerAudibility {
	let top = 0;
	for (let b = 0; b < layer.length; b++) if (layer[b]! > top) top = layer[b]!;
	let maxAdd = 0;
	let dom = 0;
	let domRatio = -1;
	if (top > 0)
		for (let b = 0; b < layer.length; b++) {
			const L = layer[b]!;
			if (!(L >= top * 1e-3)) continue;
			const R = Math.max(1e-30, rest[b] ?? 0);
			const add = Math.min(60, 10 * Math.log10((L + R) / R));
			if (add > maxAdd) maxAdd = add;
			const ratio = L / R;
			if (ratio > domRatio) {
				domRatio = ratio;
				dom = b;
			}
		}
	const L = layer[dom] ?? 0;
	const R = Math.max(1e-30, rest[dom] ?? 0);
	const want = 10 ** ((fin(targetDb) ? targetDb : 3) / 10) - 1;
	return {
		maxAddDb: Math.round(maxAdd * 100) / 100,
		dominantBand: dom,
		dominantHz: Math.round(THIRD_OCTAVE_CENTRES_HZ[dom] ?? 0),
		gainForTargetDb: L > 0 ? Math.round(10 * Math.log10((want * R) / L) * 10) / 10 : null,
	};
}
