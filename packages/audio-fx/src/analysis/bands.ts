// Octave-band and local-loudness analysis shared by the sound descriptors (`sound-descriptors.ts`, `octaveBandsDb`)
// and the masking solver (`masking.ts`, spec 12 §2.4; wp-note "Phase 4 → WP4.1a"). Pure and deterministic.
//
//   bandLevels       Welch average of Hann frames (2^k ≥ 40 ms, 50 % overlap) over a time window, channels summed
//                    (mean square per channel), integrated over the 7 octave bands 125 Hz … 8 kHz with fractional
//                    bin edges: exactly the descriptors' `octaveBandsDb` measurement, restricted to the window
//   shortTermPeakLu  the loudest BS.1770-4 momentary loudness (400 ms, K-weighted, channel-weighted) whose window
//                    centre lies in a time range, evaluated every 10 ms: the "local peak" of a bed around an event
//
// Robustness: non-finite samples count as 0, channels may differ in length (shorter = silence after its end), windows
// are clipped to the signal, and an empty, silent or degenerate input gives the floor (bands) or −Infinity (loudness).
// Neither function throws for any argument.
import { Biquad, defaultChannelWeights, energyToLufs, kPrefilter, kRlb } from '@jasper/audio-dsp';
import { Fft } from '../core/fft.ts';
import { hann } from '../core/stft.ts';

/** Octave band centres of `octaveBandsDb` / {@link bandLevels} (Hz); each band spans centre/√2 … centre·√2. */
export const OCTAVE_BAND_CENTRES_HZ: readonly number[] = /* @__PURE__ */ Object.freeze([
	125, 250, 500, 1000, 2000, 4000, 8000,
]);
/** Level of an empty band or of silence (dB). */
export const BAND_FLOOR_DB = -120;
/** Most spectral frames averaged by a band measurement (evenly spaced over the window beyond that). */
export const MAX_BAND_FRAMES = 1500;
/** Most channels {@link bandLevels} and {@link shortTermPeakLu} read (more are ignored). */
export const MAX_BAND_CHANNELS = 32;
/** Momentary loudness window (BS.1770-4), seconds. */
export const MOMENTARY_WINDOW_SEC = 0.4;
/** Step between evaluated momentary windows in {@link shortTermPeakLu}, seconds. */
export const LOCAL_PEAK_HOP_SEC = 0.01;
/** K-weighting filters run this long before the first evaluated window, so they have settled (seconds). */
const K_WARMUP_SEC = 0.5;

/** Local-peak support around an event by weight (seconds each side), spec 12 §2.4 / P4. */
export const BED_PEAK_MARGIN_SEC = /* @__PURE__ */ Object.freeze({ hero: 1, support: 0.15, ambient: 0.15 });

/** A time window in seconds, `start ≤ end`. */
export type TimeWindow = { start: number; end: number };

const dbPow = (p: number): number => (p > 0 ? 10 * Math.log10(p) : Number.NEGATIVE_INFINITY);

// ── Welch power spectrum ─────────────────────────────────────────────────────────────────────────────────────────

/** FFT length ≈ `seconds` at the rate, a power of two in [256, 32768]. */
export function fftLength(sr: number, seconds: number): number {
	let n = 256;
	while (n < sr * seconds && n < 32768) n *= 2;
	return n;
}

/**
 * One-sided power spectra of frame `[start, start + N)` (zeros outside `[0, len)`) for every channel, added into
 * `acc` (scaled so that the bins of one frame sum to the frame's windowed mean square). Channels are transformed
 * in pairs with one complex FFT.
 */
export class FramePower {
	readonly n: number;
	private readonly fft: Fft;
	private readonly win: Float64Array;
	private readonly re: Float64Array;
	private readonly im: Float64Array;
	private readonly scale: number;

	constructor(n: number) {
		this.n = n;
		this.fft = new Fft(n);
		this.win = hann(n);
		this.re = new Float64Array(n);
		this.im = new Float64Array(n);
		let w2 = 0;
		for (let i = 0; i < n; i++) w2 += this.win[i]! * this.win[i]!;
		this.scale = 1 / (n * w2);
	}

	add(ch: ArrayLike<number>[], len: number, start: number, acc: Float64Array): void {
		const { n, re, im, win } = this;
		const half = n / 2;
		for (let c = 0; c < ch.length; c += 2) {
			const a = ch[c]!;
			const b = c + 1 < ch.length ? ch[c + 1]! : null;
			for (let i = 0; i < n; i++) {
				const s = start + i;
				const inside = s >= 0 && s < len;
				re[i] = inside ? a[s]! * win[i]! : 0;
				im[i] = inside && b ? b[s]! * win[i]! : 0;
			}
			this.fft.forward(re, im);
			for (let k = 0; k <= half; k++) {
				const m = (n - k) % n;
				// A = (X[k] + conj X[n−k]) / 2, B = (X[k] − conj X[n−k]) / 2i
				const ar = (re[k]! + re[m]!) / 2;
				const ai = (im[k]! - im[m]!) / 2;
				const br = (im[k]! + im[m]!) / 2;
				const bi = (re[m]! - re[k]!) / 2;
				const mult = k === 0 || k === half ? 1 : 2;
				acc[k] += mult * this.scale * (ar * ar + ai * ai + (b ? br * br + bi * bi : 0));
			}
		}
	}
}

/**
 * Welch-averaged one-sided power spectrum (mean square per bin, per channel) of `ch` over samples `[s0, s1)`:
 * Hann frames of {@link fftLength}(sr, 40 ms), 50 % overlap, centred from `s0` to `s1` (both edges included),
 * at most {@link MAX_BAND_FRAMES} evenly spaced frames. Samples outside `[0, len)` are 0. `null` for no input.
 */
export function welchPower(
	ch: ArrayLike<number>[],
	len: number,
	sr: number,
	s0: number,
	s1: number,
): { power: Float64Array; binHz: number } | null {
	if (ch.length === 0 || s1 <= s0) return null;
	const N = fftLength(sr, 0.04);
	const hop = N / 2;
	const fp = new FramePower(N);
	const acc = new Float64Array(N / 2 + 1);
	const first = s0 - hop;
	const count = Math.max(1, Math.ceil((s1 - first) / hop));
	const used = Math.min(count, MAX_BAND_FRAMES);
	for (let f = 0; f < used; f++) {
		const idx = used === count ? f : Math.round((f * (count - 1)) / Math.max(1, used - 1));
		fp.add(ch, len, first + idx * hop, acc);
	}
	const norm = 1 / (used * ch.length);
	for (let k = 0; k < acc.length; k++) acc[k] *= norm;
	return { power: acc, binHz: sr / N };
}

/**
 * Octave band levels (dB, floored at {@link BAND_FLOOR_DB}) of a power spectrum: each bin stands for
 * `[f − Δ/2, f + Δ/2)` and counts with the share of that interval inside the band.
 */
export function octaveBandsFromPower(power: Float64Array, binHz: number): number[] {
	return OCTAVE_BAND_CENTRES_HZ.map((fc) => {
		const lo = fc / Math.SQRT2;
		const hi = fc * Math.SQRT2;
		let e = 0;
		const k0 = Math.max(0, Math.floor(lo / binHz - 0.5));
		const k1 = Math.min(power.length - 1, Math.ceil(hi / binHz + 0.5));
		for (let k = k0; k <= k1; k++) {
			const a = Math.max(lo, (k - 0.5) * binHz);
			const b = Math.min(hi, (k + 0.5) * binHz);
			if (b > a) e += (power[k]! * (b - a)) / binHz;
		}
		const v = dbPow(e);
		return Number.isFinite(v) ? Math.max(BAND_FLOOR_DB, v) : BAND_FLOOR_DB;
	});
}

// ── input guards ─────────────────────────────────────────────────────────────────────────────────────────────────

const validRate = (sr: unknown): sr is number => typeof sr === 'number' && Number.isFinite(sr) && sr >= 1 && sr <= 1e7;

/** The channels that are sample arrays (at most {@link MAX_BAND_CHANNELS}); others are dropped. */
function usableChannels(channels: unknown): Float32Array[] {
	if (!Array.isArray(channels)) return [];
	const out: Float32Array[] = [];
	for (const c of channels) {
		if (out.length >= MAX_BAND_CHANNELS) break;
		if (c instanceof Float32Array) out.push(c);
	}
	return out;
}

/** Sample range `[s0, s1)` of a window, clipped to `[0, len]`; null when empty or invalid. */
function sampleRange(window: unknown, sr: number, len: number): [number, number] | null {
	if (!window || typeof window !== 'object') return null;
	const { start, end } = window as { start?: unknown; end?: unknown };
	if (typeof start !== 'number' || typeof end !== 'number' || Number.isNaN(start) || Number.isNaN(end)) return null;
	const a = Math.max(0, Math.min(len, Math.round(Math.max(-1e12, Math.min(1e12, start)) * sr)));
	const b = Math.max(0, Math.min(len, Math.round(Math.max(-1e12, Math.min(1e12, end)) * sr)));
	return b > a ? [a, b] : null;
}

/** Copy of `c[s0, s1)` with non-finite samples as 0 and silence past the channel's end. */
function cleanSlice(c: Float32Array, s0: number, s1: number): Float32Array {
	const out = new Float32Array(s1 - s0);
	const m = Math.min(c.length, s1);
	for (let i = s0; i < m; i++) {
		const x = c[i]!;
		out[i - s0] = x - x === 0 ? x : 0;
	}
	return out;
}

// ── public API ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Levels of the 7 octave bands 125 Hz … 8 kHz (dB re full scale, mean square per channel: a full-scale sine reads
 * −3.01) of planar `channels` over `window` (seconds), measured like the descriptors' `octaveBandsDb` but with the
 * signal outside the window taken as silence. Floor {@link BAND_FLOOR_DB}; an empty or invalid window, no channels,
 * silence or an invalid rate give the floor in every band. Never throws.
 */
export function bandLevels(channels: Float32Array[], sampleRate: number, window: TimeWindow): number[] {
	const floor = (): number[] => OCTAVE_BAND_CENTRES_HZ.map(() => BAND_FLOOR_DB);
	if (!validRate(sampleRate)) return floor();
	const ch = usableChannels(channels);
	let len = 0;
	for (const c of ch) len = Math.max(len, c.length);
	const range = sampleRange(window, sampleRate, len);
	if (ch.length === 0 || !range) return floor();
	const [s0, s1] = range;
	const slices = ch.map((c) => cleanSlice(c, s0, s1));
	const w = welchPower(slices, s1 - s0, sampleRate, 0, s1 - s0);
	if (!w) return floor();
	let total = 0;
	for (let k = 0; k < w.power.length; k++) total += w.power[k]!;
	if (!(total > 0) || !Number.isFinite(total)) return floor();
	return octaveBandsFromPower(w.power, w.binHz);
}

/** Combined level (dB) of a set of band levels: 10·log10 Σ 10^(L/10); {@link BAND_FLOOR_DB} for none. */
export function sumBandsDb(levels: readonly number[]): number {
	let e = 0;
	for (const l of levels) if (Number.isFinite(l)) e += 10 ** (l / 10);
	const v = dbPow(e);
	return Number.isFinite(v) ? Math.max(BAND_FLOOR_DB, v) : BAND_FLOOR_DB;
}

/**
 * The loudest BS.1770-4 momentary loudness (LUFS: K-weighted mean square over 400 ms, channels weighted by
 * `defaultChannelWeights`) among the windows centred every 10 ms from `window.start − marginSec` to
 * `window.end + marginSec`. Audio outside the signal is silence; the K-weighting runs from 0.5 s before the first
 * window so it has settled. −Infinity for silence, no channels, an invalid window or rate. Never throws.
 */
export function shortTermPeakLu(
	channels: Float32Array[],
	sampleRate: number,
	window: TimeWindow,
	marginSec = 0,
): number {
	if (!validRate(sampleRate)) return Number.NEGATIVE_INFINITY;
	const ch = usableChannels(channels);
	if (ch.length === 0 || !window || typeof window !== 'object') return Number.NEGATIVE_INFINITY;
	const { start, end } = window;
	if (!Number.isFinite(start) || !Number.isFinite(end)) return Number.NEGATIVE_INFINITY;
	const margin = Number.isFinite(marginSec) ? Math.max(0, Math.min(3600, marginSec)) : 0;
	let len = 0;
	for (const c of ch) len = Math.max(len, c.length);
	const sr = sampleRate;
	const lo = Math.min(start, end) - margin;
	const hi = Math.max(start, end) + margin;
	const half = Math.round((MOMENTARY_WINDOW_SEC / 2) * sr);
	const hop = Math.max(1, Math.round(LOCAL_PEAK_HOP_SEC * sr));
	// window centres cLo … cHi (samples); the signal only matters on [cLo − half, cHi + half) ∩ [0, len)
	const cLo = Math.round(lo * sr);
	const cHi = Math.round(hi * sr);
	const a = Math.max(0, cLo - half);
	const b = Math.min(len, cHi + half);
	if (b <= a || cHi - cLo > 4 * 3600 * sr) return Number.NEGATIVE_INFINITY;
	const warm = Math.max(0, a - Math.round(K_WARMUP_SEC * sr));
	const weights = defaultChannelWeights(ch.length);
	// prefix sums of the channel-weighted K-weighted square over [a, b)
	const prefix = new Float64Array(b - a + 1);
	const pre = kPrefilter(sr);
	const rlb = kRlb(sr);
	const sq = new Float64Array(b - a);
	for (let c = 0; c < ch.length; c++) {
		const wgt = weights[c] ?? 1;
		if (wgt === 0) continue;
		const x = ch[c]!;
		const f1 = new Biquad(pre);
		const f2 = new Biquad(rlb);
		for (let i = warm; i < b; i++) {
			const v = i < x.length ? x[i]! : 0;
			const y = f2.processSample(f1.processSample(v - v === 0 ? v : 0));
			if (i >= a) sq[i - a] += wgt * y * y;
		}
	}
	for (let i = 0; i < sq.length; i++) prefix[i + 1] = prefix[i]! + sq[i]!;
	const winLen = 2 * half;
	let best = 0;
	for (let c = cLo; c <= cHi; c += hop) {
		const w0 = Math.max(a, c - half) - a;
		const w1 = Math.min(b, c + half) - a;
		if (w1 <= w0) continue;
		const e = (prefix[w1]! - prefix[w0]!) / winLen;
		if (e > best) best = e;
	}
	return best > 0 && Number.isFinite(best) ? energyToLufs(best) : Number.NEGATIVE_INFINITY;
}

/**
 * Local peak of a bed around an event: {@link shortTermPeakLu} over the event window widened by
 * {@link BED_PEAK_MARGIN_SEC} of its weight (±1 s for a hero, ±0.15 s otherwise).
 */
export function bedLocalPeakLu(
	channels: Float32Array[],
	sampleRate: number,
	window: TimeWindow,
	weight: keyof typeof BED_PEAK_MARGIN_SEC,
): number {
	const margin = BED_PEAK_MARGIN_SEC[weight] ?? BED_PEAK_MARGIN_SEC.support;
	return shortTermPeakLu(channels, sampleRate, window, margin);
}
