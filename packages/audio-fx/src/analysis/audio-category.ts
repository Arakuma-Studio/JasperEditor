// Essential Sound Auto Tag (spec 12 P6-R3; wp-note "Phase 6 → WP6.3 Auto Tag and dialogue awareness"): classifies a
// clip's audio as dialogue, music, SFX or ambience from measured features. Premiere Pro's Auto Tag does the same with
// a trained model; this is a deterministic, documented rule set over classic speech / music discrimination features:
//
//   - energy VAD as the engine's speech module (`vadThreshold`: 30 % between the noise floor and the speech level, at
//     least 6 dB over the floor) → activity ratio, bursts, pauses (Scheirer & Slaney 1997 "percentage of low-energy
//     frames");
//   - syllabic modulation: the 2.5–8 Hz modulation energy of the 300–3400 Hz envelope (Houtgast & Steeneken's
//     modulation transfer; the "4 Hz modulation energy" of Scheirer & Slaney 1997);
//   - pitch over time (YIN, de Cheveigné & Kawahara 2002, as `analyzeSound`): voicing, speech-range f0, glides versus
//     steady notes, voiced run length;
//   - tonal persistence: spectral peaks still present 200 ms later (sustained partials = notes);
//   - onsets (log band-energy flux) and their periodicity (autocorrelation over 0.25–1.5 s: a beat);
//   - stationarity: the level and the band spectrum from one second to the next (beds and room tone barely change);
//   - spectral flatness, duration, dynamic range.
//
// Pure (no I/O), deterministic, never throws on audio content (empty, silent, NaN, one sample: a defined result).
// Long inputs: the caller passes up to `MAX_CATEGORY_WINDOWS` windows (e.g. 4 × 15 s spread over a long clip) and the
// real duration; each window is measured on its own (no joins) and the features are pooled by audible time.
import { Biquad, designBiquad, Fft } from '@jasper/audio-dsp';

/** Bump when features or rules change (engine caches key on it). */
export const AUDIO_CATEGORY_VERSION = 1;
export const AUDIO_CATEGORIES = ['dialogue', 'music', 'sfx', 'ambience'] as const;
export type AudioCategory = (typeof AUDIO_CATEGORIES)[number];

/** Seconds analysed per window, windows per clip, and the analysis rate. */
export const MAX_CATEGORY_WINDOW_SECONDS = 60;
export const MAX_CATEGORY_WINDOWS = 8;
export const CATEGORY_ANALYSIS_RATE = 16_000;
/** A confidence under this is "low": the UI and agents should say so (and the user confirm). */
export const LOW_CATEGORY_CONFIDENCE = 0.6;
/** Peak level (dBFS of a 10 ms frame) under which a clip is silent: nothing to classify. */
export const SILENT_PEAK_DBFS = -70;

export interface AudioCategoryFeatures {
	/** Real length of the clip (s) and how much of it was analysed. */
	durationSec: number;
	analysedSec: number;
	silent: boolean;
	/** 10 ms frames over the VAD threshold ÷ frames; frames within 40 dB of the 95th percentile and ≥ −65 dBFS ÷ frames. */
	activeRatio: number;
	audibleRatio: number;
	/** 95th − 10th percentile of the 10 ms levels (dB). */
	dynamicRangeDb: number;
	/** Active bursts (runs bridged over 50 ms) per audible second, and their median length (s). */
	burstRate: number;
	burstMedianSec: number;
	/** Frames under half the mean amplitude of the surrounding second (Scheirer & Slaney). */
	lowEnergyRatio: number;
	/** 2.5–8 Hz modulation energy ÷ the squared mean of the 300–3400 Hz envelope (Hann-windowed 2.56 s blocks). */
	syllabicModulation: number;
	/** Voiced YIN frames ÷ active YIN frames; voiced frames with f0 in 70–400 Hz ÷ voiced. */
	voicedRatio: number;
	speechPitchRatio: number;
	/** Consecutive voiced frames (20 ms) within 0.12 semitone of each other ÷ consecutive voiced pairs within 2 st. */
	pitchSteadiness: number;
	/** Median |Δ semitone| per 20 ms of those pairs. */
	pitchGlideSt: number;
	/** Median voiced run (s). */
	voicedRunSec: number;
	/** Spectral peaks (64 ms frames) found again (±1 bin) 192 ms later ÷ peaks; frames with ≥ 3 peaks ÷ audible frames. */
	tonalPersistence: number;
	tonalFrameRatio: number;
	/** Onsets (log band flux peaks) per audible second, the count, and the best autocorrelation at 0.25–1.5 s lags. */
	onsetRate: number;
	onsetCount: number;
	onsetRegularity: number;
	/** Standard deviation of the 1 s levels (dB) and mean RMS change of the 1 s band spectrum (dB). */
	levelStdDb: number;
	spectralChangeDb: number;
	/** Wiener entropy of the long-term power spectrum over 100–6000 Hz; its centroid (Hz). */
	flatness: number;
	centroidHz: number;
	/** First to last frame within 40 dB of the peak (s), as a share of the analysed time. */
	activeSpanRatio: number;
	/** The level of the last 10 % of the active span under the peak (dB, ≥ 0): an event that dies away. */
	tailDropDb: number;
}

export interface AudioCategoryResult {
	category: AudioCategory;
	/**
	 * The winner's share of the squared scores × min(1, winner ÷ 0.5) (0…1): two close scores or weak evidence give a
	 * low confidence. Under `LOW_CATEGORY_CONFIDENCE` = low.
	 */
	confidence: number;
	scores: Record<AudioCategory, number>;
	/** Why, in words (the strongest evidence first). */
	reasons: string[];
	/** True when the audio is silent (category 'ambience', confidence 0: callers do not tag it). */
	silent: boolean;
}

export class AudioCategoryError extends Error {
	readonly code = 'E_INVALID_PARAM' as const;
}

export type AudioWindow = { channels: readonly Float32Array[]; sampleRate: number };

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const ramp = (x: number, a: number, b: number) => (Number.isFinite(x) ? clamp01((x - a) / (b - a)) : 0);
const q3 = (x: number) => {
	const v = Math.round((Number.isFinite(x) ? x : 0) * 1000) / 1000;
	return v === 0 ? 0 : v;
};

function median(xs: number[]): number {
	if (!xs.length) return 0;
	const s = xs.slice().sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median of a scratch buffer (reordered in place; quickselect). */
function selectMedian(a: Float64Array): number {
	const n = a.length;
	if (!n) return 0;
	const kth = (k: number) => {
		let lo = 0;
		let hi = n - 1;
		while (lo < hi) {
			const pivot = a[(lo + hi) >> 1]!;
			let i = lo;
			let j = hi;
			while (i <= j) {
				while (a[i]! < pivot) i++;
				while (a[j]! > pivot) j--;
				if (i <= j) {
					const t = a[i]!;
					a[i] = a[j]!;
					a[j] = t;
					i++;
					j--;
				}
			}
			if (k <= j) hi = j;
			else if (k >= i) lo = i;
			else return a[k]!;
		}
		return a[k]!;
	};
	return kth(n >> 1);
}

function quantile(sorted: ArrayLike<number>, p: number): number {
	if (!sorted.length) return Number.NEGATIVE_INFINITY;
	return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))]!;
}

/** Mono at the analysis rate (≤ 16 kHz): channels averaged, NaN/±Inf as 0, 4th-order low-pass then interpolation. */
function monoAt(win: AudioWindow, maxSeconds: number): { x: Float32Array; sr: number } {
	const sr = win.sampleRate;
	const chans = win.channels.filter((c): c is Float32Array => c instanceof Float32Array).slice(0, 32);
	let len = 0;
	for (const c of chans) len = Math.max(len, c.length);
	len = Math.min(len, Math.ceil(maxSeconds * sr));
	const mono = new Float32Array(len);
	if (chans.length) {
		for (const c of chans) {
			const n = Math.min(len, c.length);
			for (let i = 0; i < n; i++) {
				const v = c[i]!;
				if (Number.isFinite(v)) mono[i] = mono[i]! + Math.max(-1e6, Math.min(1e6, v));
			}
		}
		const g = 1 / chans.length;
		for (let i = 0; i < len; i++) mono[i] = mono[i]! * g;
	}
	if (sr <= CATEGORY_ANALYSIS_RATE * 1.01) return { x: mono, sr };
	const fc = 0.45 * CATEGORY_ANALYSIS_RATE;
	for (const q of [0.5412, 1.3066]) new Biquad(designBiquad('lowPass', sr, fc, q)).processBlock(mono);
	const out = new Float32Array(Math.floor((len * CATEGORY_ANALYSIS_RATE) / sr));
	const step = sr / CATEGORY_ANALYSIS_RATE;
	for (let i = 0; i < out.length; i++) {
		const p = i * step;
		const k = Math.floor(p);
		const f = p - k;
		out[i] = (mono[k] ?? 0) * (1 - f) + (mono[k + 1] ?? mono[k] ?? 0) * f;
	}
	return { x: out, sr: CATEGORY_ANALYSIS_RATE };
}

/** Per-window raw measurements, pooled by `pool`. */
type WindowStats = {
	sec: number;
	frames: number;
	levels: Float32Array;
	active: number;
	audible: number;
	bursts: number[];
	lowEnergy: number;
	lowEnergyFrames: number;
	modulation: number[];
	voiced: number;
	yinActive: number;
	speechPitch: number;
	steadyPairs: number;
	pairs: number;
	glides: number[];
	runs: number[];
	persistHits: number;
	persistPeaks: number;
	tonalFrames: number;
	audibleSpecFrames: number;
	onsets: number;
	regularity: number;
	regularityWeight: number;
	levels1s: number[];
	bandChanges: number[];
	spectrum: Float64Array | null;
	binHz: number;
	spanFrames: number;
	tailDropDb: number;
};

const HOP_SEC = 0.01;
const N_BANDS = 20;

function hann(n: number): Float64Array {
	const w = new Float64Array(n);
	for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
	return w;
}

/** Band edges (FFT bins) of `N_BANDS` log-spaced bands over 60 Hz … min(7 kHz, 0.45 sr). */
function bandEdges(nfft: number, sr: number): number[] {
	const lo = 60;
	const hi = Math.min(7000, 0.45 * sr);
	const edges: number[] = [];
	for (let b = 0; b <= N_BANDS; b++) {
		const f = lo * (hi / lo) ** (b / N_BANDS);
		edges.push(Math.max(1, Math.min(nfft / 2, Math.round((f * nfft) / sr))));
	}
	return edges;
}

function measureWindow(x: Float32Array, sr: number): WindowStats {
	const hop = Math.max(1, Math.round(sr * HOP_SEC));
	const frames = Math.floor(x.length / hop);
	const st: WindowStats = {
		sec: x.length / sr,
		frames,
		levels: new Float32Array(frames),
		active: 0,
		audible: 0,
		bursts: [],
		lowEnergy: 0,
		lowEnergyFrames: 0,
		modulation: [],
		voiced: 0,
		yinActive: 0,
		speechPitch: 0,
		steadyPairs: 0,
		pairs: 0,
		glides: [],
		runs: [],
		persistHits: 0,
		persistPeaks: 0,
		tonalFrames: 0,
		audibleSpecFrames: 0,
		onsets: 0,
		regularity: 0,
		regularityWeight: 0,
		levels1s: [],
		bandChanges: [],
		spectrum: null,
		binHz: 0,
		spanFrames: 0,
		tailDropDb: 0,
	};
	if (frames < 1) return st;
	// ── 10 ms levels ──────────────────────────────────────────────────────────────────────────────────────────────
	const amp = new Float64Array(frames);
	for (let f = 0; f < frames; f++) {
		let e = 0;
		for (let i = f * hop; i < (f + 1) * hop; i++) e += x[i]! * x[i]!;
		e /= hop;
		amp[f] = Math.sqrt(e);
		st.levels[f] = 10 * Math.log10(e + 1e-12);
	}
	const sorted = Float32Array.from(st.levels.filter((v) => v > -100)).sort();
	const peak = sorted.length ? sorted[sorted.length - 1]! : -120;
	if (peak < SILENT_PEAK_DBFS) return st;
	const floor = quantile(sorted, 0.1);
	const top = quantile(sorted, 0.95);
	const th = Math.max(floor + 0.3 * (top - floor), floor + 6, -60);
	const audibleTh = Math.max(-65, top - 40);
	const isActive = new Uint8Array(frames);
	const isAudible = new Uint8Array(frames);
	for (let f = 0; f < frames; f++) {
		if (st.levels[f]! >= th) {
			isActive[f] = 1;
			st.active++;
		}
		if (st.levels[f]! >= audibleTh) {
			isAudible[f] = 1;
			st.audible++;
		}
	}
	// active span and tail
	let first = -1;
	let last = -1;
	for (let f = 0; f < frames; f++)
		if (st.levels[f]! >= peak - 40) {
			if (first < 0) first = f;
			last = f;
		}
	st.spanFrames = first >= 0 ? last - first + 1 : 0;
	if (st.spanFrames > 0) {
		const tail = Math.max(1, Math.round(st.spanFrames * 0.1));
		let e = 0;
		for (let f = last - tail + 1; f <= last; f++) e += 10 ** (st.levels[f]! / 10);
		st.tailDropDb = Math.max(0, peak - 10 * Math.log10(e / tail + 1e-12));
	}
	// bursts: active runs bridged over 50 ms
	{
		let runStart = -1;
		let gap = 0;
		for (let f = 0; f <= frames; f++) {
			const on = f < frames && isActive[f] === 1;
			if (on) {
				if (runStart < 0) runStart = f;
				gap = 0;
			} else if (runStart >= 0) {
				gap++;
				if (gap > 5 || f === frames) {
					st.bursts.push((f - gap + 1 - runStart) * HOP_SEC);
					runStart = -1;
					gap = 0;
				}
			}
		}
	}
	// low-energy frames: under half the mean amplitude of the surrounding second (audible frames only)
	{
		const pre = new Float64Array(frames + 1);
		for (let f = 0; f < frames; f++) pre[f + 1] = pre[f]! + amp[f]!;
		for (let f = 0; f < frames; f++) {
			if (!isAudible[f] && st.levels[f]! < audibleTh - 20) continue;
			const a = Math.max(0, f - 50);
			const b = Math.min(frames, f + 50);
			const mean = (pre[b]! - pre[a]!) / (b - a);
			st.lowEnergyFrames++;
			if (amp[f]! < 0.5 * mean) st.lowEnergy++;
		}
	}
	// ── speech-band envelope (300–3400 Hz band-pass, 10 ms RMS) for the syllabic modulation ─────────────────────────
	const env = new Float64Array(frames);
	{
		const hp = new Biquad(designBiquad('highPass', sr, 300, 0.7071));
		const lp = new Biquad(designBiquad('lowPass', sr, Math.min(3400, 0.45 * sr), 0.7071));
		for (let f = 0; f < frames; f++) {
			let e = 0;
			for (let i = f * hop; i < (f + 1) * hop; i++) {
				const v = lp.processSample(hp.processSample(x[i]!));
				e += v * v;
			}
			env[f] = Math.sqrt(e / hop);
		}
	}
	// ── STFT (32 ms window, 20 ms hop): band energies (onsets, stationarity) and the long-term spectrum ───────────────
	const n32 = 2 ** Math.ceil(Math.log2(0.032 * sr));
	const w32 = hann(n32);
	const fft32 = new Fft(n32);
	const re = new Float64Array(n32);
	const im = new Float64Array(n32);
	const edges = bandEdges(n32, sr);
	const sHop = 2 * hop;
	const sFrames = Math.floor(x.length / sHop);
	const sAudible = new Uint8Array(sFrames);
	const bands = new Float64Array(sFrames * N_BANDS);
	const longSpec = new Float64Array(n32 / 2 + 1);
	let longFrames = 0;
	for (let f = 0; f < sFrames; f++) {
		sAudible[f] = isAudible[Math.min(frames - 1, 2 * f)]! | isAudible[Math.min(frames - 1, 2 * f + 1)]!;
		const s0 = Math.round(f * sHop + sHop / 2 - n32 / 2);
		for (let i = 0; i < n32; i++) {
			const k = s0 + i;
			re[i] = (k >= 0 && k < x.length ? x[k]! : 0) * w32[i]!;
			im[i] = 0;
		}
		fft32.forward(re, im);
		for (let b = 0; b < N_BANDS; b++) {
			let e = 0;
			for (let k = edges[b]!; k < Math.max(edges[b]! + 1, edges[b + 1]!); k++)
				e += re[k]! * re[k]! + im[k]! * im[k]!;
			bands[f * N_BANDS + b] = e;
		}
		if (sAudible[f]) {
			for (let k = 0; k <= n32 / 2; k++) longSpec[k] = longSpec[k]! + re[k]! * re[k]! + im[k]! * im[k]!;
			longFrames++;
		}
	}
	if (longFrames) {
		st.spectrum = longSpec;
		st.binHz = sr / n32;
	}
	// syllabic modulation: 2.56 s blocks, half overlap, of the speech-band envelope (blocks mostly audible)
	{
		const B = 256;
		const wB = hann(B);
		const fftB = new Fft(B);
		const mr = new Float64Array(B);
		const mi = new Float64Array(B);
		const k0 = Math.round((2.5 * B) / 100);
		const k1 = Math.round((8 * B) / 100);
		const starts: number[] = [];
		if (frames >= B) for (let s = 0; s + B <= frames; s += B / 2) starts.push(s);
		else if (frames >= 64) starts.push(0);
		for (const s of starts) {
			let aud = 0;
			let mean = 0;
			const len = Math.min(B, frames - s);
			for (let i = 0; i < len; i++) {
				aud += isAudible[s + i]!;
				mean += env[s + i]!;
			}
			if (aud < 0.3 * len || mean <= 0) continue;
			mean /= len;
			for (let i = 0; i < B; i++) {
				mr[i] = i < len ? (env[s + i]! - mean) * wB[Math.floor((i * B) / len)]! : 0;
				mi[i] = 0;
			}
			fftB.forward(mr, mi);
			let e = 0;
			for (let k = k0; k <= k1; k++) e += mr[k]! * mr[k]! + mi[k]! * mi[k]!;
			// Parseval with the Hann window (mean square 0.375): energy per sample ÷ the squared mean
			st.modulation.push((2 * e) / (B * len * 0.375) / (mean * mean));
		}
	}
	// onsets: rise of log band energies (dB, floor 80 dB under the loudest band), summed, per 20 ms
	const flux = new Float64Array(sFrames);
	{
		let maxBand = 0;
		for (let i = 0; i < bands.length; i++) if (bands[i]! > maxBand) maxBand = bands[i]!;
		const floorE = maxBand * 1e-8 + 1e-20;
		const lg = new Float64Array(bands.length);
		for (let i = 0; i < bands.length; i++) lg[i] = 10 * Math.log10(Math.max(bands[i]!, floorE));
		for (let f = 2; f < sFrames; f++) {
			let sum = 0;
			for (let b = 0; b < N_BANDS; b++) {
				const prev = Math.max(lg[(f - 1) * N_BANDS + b]!, lg[(f - 2) * N_BANDS + b]!);
				sum += Math.min(30, Math.max(0, lg[f * N_BANDS + b]! - prev));
			}
			flux[f] = sum;
		}
		// peaks: local maximum (±2 frames), ≥ 30 dB summed rise and over 1.5 × the median of the surrounding second
		// + 10 dB, audible, ≥ 60 ms after the previous onset
		let lastOnset = -100;
		const scratch = new Float64Array(51);
		for (let f = 2; f < sFrames - 2; f++) {
			const v = flux[f]!;
			if (v < 30 || !sAudible[f]) continue;
			let isMax = true;
			for (let d = -2; d <= 2; d++) if (d !== 0 && flux[f + d]! > v) isMax = false;
			if (!isMax || f - lastOnset < 3) continue;
			const lo = Math.max(0, f - 25);
			const hi = Math.min(sFrames, f + 26);
			const w = scratch.subarray(0, hi - lo);
			w.set(flux.subarray(lo, hi));
			if (v < 1.5 * selectMedian(w) + 10) continue;
			lastOnset = f;
			st.onsets++;
		}
		// periodicity of the flux envelope: normalised autocorrelation, best over 0.24–1.5 s (needs ≥ 3 periods)
		const lo = 12;
		const hi = Math.min(75, Math.floor(sFrames / 3));
		if (hi > lo + 2) {
			let mean = 0;
			for (let f = 0; f < sFrames; f++) mean += flux[f]!;
			mean /= sFrames;
			const e = new Float64Array(sFrames);
			let r0 = 0;
			for (let f = 0; f < sFrames; f++) {
				e[f] = flux[f]! - mean;
				r0 += e[f]! * e[f]!;
			}
			if (r0 > 0) {
				let best = 0;
				for (let lag = lo; lag <= hi; lag++) {
					let sum = 0;
					for (let f = 0; f + lag < sFrames; f++) sum += e[f]! * e[f + lag]!;
					const r = (sum / (sFrames - lag)) * (sFrames / r0);
					if (r > best) best = r;
				}
				st.regularity = best;
				st.regularityWeight = st.audible;
			}
		}
	}
	// stationarity: 1 s levels and band spectra (audible seconds)
	{
		let prev: Float64Array | null = null;
		for (let s0 = 0; s0 + 50 <= sFrames; s0 += 50) {
			let aud = 0;
			for (let f = s0; f < s0 + 50; f++) aud += sAudible[f]!;
			if (aud < 25) {
				prev = null;
				continue;
			}
			let e = 0;
			for (let f = 2 * s0; f < Math.min(frames, 2 * s0 + 100); f++) e += 10 ** (st.levels[f]! / 10);
			st.levels1s.push(10 * Math.log10(e / 100 + 1e-12));
			const v = new Float64Array(N_BANDS);
			for (let b = 0; b < N_BANDS; b++) {
				let be = 0;
				for (let f = s0; f < s0 + 50; f++) be += bands[f * N_BANDS + b]!;
				v[b] = 10 * Math.log10(be / 50 + 1e-20);
			}
			// relative spectrum (level removed): the change is about colour, the level has its own measure
			const m = v.reduce((x0, y0) => x0 + y0, 0) / N_BANDS;
			for (let b = 0; b < N_BANDS; b++) v[b] = Math.max(v[b]! - m, -60);
			if (prev) {
				let d = 0;
				for (let b = 0; b < N_BANDS; b++) d += (v[b]! - prev[b]!) ** 2;
				st.bandChanges.push(Math.sqrt(d / N_BANDS));
			}
			prev = v;
		}
	}
	// ── tonal persistence: 64 ms frames, 48 ms hop; peaks ≥ 15 dB over the frame's median, ≤ 50 dB under its max ──
	{
		const n64 = 2 ** Math.ceil(Math.log2(0.064 * sr));
		const h64 = Math.round(0.048 * sr);
		const w64 = hann(n64);
		const fft64 = new Fft(n64);
		const r = new Float64Array(n64);
		const i2 = new Float64Array(n64);
		const k0 = Math.max(5, Math.round((80 * n64) / sr));
		const k1 = Math.min(n64 / 2 - 5, Math.round((5000 * n64) / sr));
		const peaksOf: Uint8Array[] = [];
		const nf = Math.max(0, Math.floor((x.length - n64) / h64) + 1);
		const lgs = new Float64Array(k1 + 5);
		const medBuf = new Float64Array(k1 - k0 + 1);
		for (let t = 0; t < nf; t++) {
			const s0 = t * h64;
			const mid = Math.min(frames - 1, Math.floor((s0 + n64 / 2) / hop));
			const pk = new Uint8Array(k1 + 2);
			peaksOf.push(pk);
			if (!isAudible[mid]) continue;
			for (let i = 0; i < n64; i++) {
				r[i] = x[s0 + i]! * w64[i]!;
				i2[i] = 0;
			}
			fft64.forward(r, i2);
			let mx = Number.NEGATIVE_INFINITY;
			for (let k = k0 - 4; k <= k1 + 4; k++) {
				lgs[k] = 10 * Math.log10(r[k]! * r[k]! + i2[k]! * i2[k]! + 1e-20);
				if (lgs[k]! > mx) mx = lgs[k]!;
			}
			medBuf.set(lgs.subarray(k0, k1 + 1));
			const med = selectMedian(medBuf);
			let count = 0;
			for (let k = k0; k <= k1; k++) {
				const v = lgs[k]!;
				// a partial: a local maximum standing ≥ 10 dB over the spectrum 3–4 bins away (outside a Hann main
				// lobe; noise maxima stand ≈ 5 dB over theirs), ≥ 15 dB over the frame's median, ≤ 50 dB under its max
				const side = Math.max(lgs[k - 3] ?? v, lgs[k + 3] ?? v, lgs[k - 4] ?? v, lgs[k + 4] ?? v);
				if (v > lgs[k - 1]! && v >= lgs[k + 1]! && v >= side + 10 && v >= med + 15 && v >= mx - 50) {
					pk[k] = 1;
					count++;
				}
			}
			st.audibleSpecFrames++;
			if (count >= 3) st.tonalFrames++;
		}
		const L = 4; // 192 ms
		for (let t = 0; t + L < peaksOf.length; t++) {
			const a = peaksOf[t]!;
			const b = peaksOf[t + L]!;
			let n = 0;
			let hit = 0;
			for (let k = k0; k <= k1; k++) {
				if (!a[k]) continue;
				n++;
				if (b[k] || b[k - 1] || b[k + 1]) hit++;
			}
			if (n >= 2) {
				st.persistPeaks += n;
				st.persistHits += hit;
			}
		}
	}
	// ── pitch: YIN at ≤ 8 kHz, 40 ms frames every 20 ms over active frames ──────────────────────────────────────────
	{
		const dec = Math.max(1, Math.floor(sr / 8000));
		const psr = sr / dec;
		const y = new Float32Array(Math.floor(x.length / dec));
		for (let i = 0; i < y.length; i++) {
			let s = 0;
			for (let j = 0; j < dec; j++) s += x[i * dec + j]!;
			y[i] = s / dec;
		}
		const W = Math.round(0.02 * psr);
		const tMin = Math.max(2, Math.floor(psr / 1000));
		const tMax = Math.ceil(psr / 65);
		const d = new Float64Array(tMax + 2);
		const step = Math.round(0.02 * psr);
		let prevSt: number | null = null;
		let run = 0;
		const closeRun = () => {
			if (run > 0) st.runs.push(run * 0.02);
			run = 0;
		};
		for (let s0 = 0; s0 + W + tMax + 1 < y.length; s0 += step) {
			const mid = Math.min(frames - 1, Math.floor(((s0 + W / 2) * dec) / hop));
			if (!isActive[mid]) {
				closeRun();
				prevSt = null;
				continue;
			}
			st.yinActive++;
			for (let tau = 1; tau <= tMax + 1; tau++) {
				let s = 0;
				for (let i = 0; i < W; i++) {
					const v = y[s0 + i]! - y[s0 + i + tau]!;
					s += v * v;
				}
				d[tau] = s;
			}
			let run2 = 0;
			let best = -1;
			let bestV = 1;
			for (let tau = 1; tau <= tMax + 1; tau++) {
				run2 += d[tau]!;
				const cm = run2 > 0 ? (d[tau]! * tau) / run2 : 1;
				d[tau] = cm;
			}
			for (let tau = tMin; tau <= tMax; tau++) {
				if (d[tau]! < 0.25) {
					while (tau + 1 <= tMax && d[tau + 1]! < d[tau]!) tau++;
					best = tau;
					bestV = d[tau]!;
					break;
				}
			}
			if (best < 0) {
				closeRun();
				prevSt = null;
				continue;
			}
			const a = d[best - 1]!;
			const b = d[best]!;
			const c = d[best + 1]!;
			const den = a - 2 * b + c;
			const tauF = best + (den !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / den)) : 0);
			const f0 = psr / tauF;
			if (!(bestV < 0.25) || f0 < 65 || f0 > 1000) {
				closeRun();
				prevSt = null;
				continue;
			}
			st.voiced++;
			run++;
			if (f0 >= 70 && f0 <= 400) st.speechPitch++;
			const semis = 12 * Math.log2(f0 / 440);
			if (prevSt !== null) {
				const dSt = Math.abs(semis - prevSt);
				if (dSt < 2) {
					st.pairs++;
					st.glides.push(dSt);
					if (dSt < 0.12) st.steadyPairs++;
				}
			}
			prevSt = semis;
		}
		closeRun();
	}
	return st;
}

function pool(parts: WindowStats[], durationSec: number): AudioCategoryFeatures {
	const sum = (f: (s: WindowStats) => number) => parts.reduce((a, s) => a + f(s), 0);
	const frames = sum((s) => s.frames);
	const audible = sum((s) => s.audible);
	const audSec = audible * HOP_SEC;
	const analysedSec = sum((s) => s.sec);
	const all = parts.flatMap((s) => Array.from(s.levels).filter((v) => v > -100)).sort((a, b) => a - b);
	const peak = all.length ? all[all.length - 1]! : -120;
	const silent = !(peak >= SILENT_PEAK_DBFS) || audible === 0;
	const regW = sum((s) => s.regularityWeight);
	let spectrum: Float64Array | null = null;
	let binHz = 0;
	for (const s of parts)
		if (s.spectrum) {
			if (!spectrum) {
				spectrum = s.spectrum.slice();
				binHz = s.binHz;
			} else if (s.spectrum.length === spectrum.length)
				for (let k = 0; k < spectrum.length; k++) spectrum[k] = spectrum[k]! + s.spectrum[k]!;
		}
	let flatness = 0;
	let centroidHz = 0;
	if (spectrum && binHz > 0) {
		const k0 = Math.max(1, Math.round(100 / binHz));
		const k1 = Math.min(spectrum.length - 1, Math.round(6000 / binHz));
		let mx = 0;
		for (let k = k0; k <= k1; k++) mx = Math.max(mx, spectrum[k]!);
		const fl = mx * 1e-12 + 1e-30;
		let lg = 0;
		let ar = 0;
		let num = 0;
		let den = 0;
		for (let k = k0; k <= k1; k++) {
			const p = Math.max(spectrum[k]!, fl);
			lg += Math.log(p);
			ar += p;
		}
		for (let k = 1; k < spectrum.length; k++) {
			num += k * binHz * spectrum[k]!;
			den += spectrum[k]!;
		}
		const n = k1 - k0 + 1;
		flatness = ar > 0 ? Math.exp(lg / n) / (ar / n) : 0;
		centroidHz = den > 0 ? num / den : 0;
	}
	const levels1s = parts.flatMap((s) => s.levels1s);
	const lm = levels1s.length ? levels1s.reduce((a, b) => a + b, 0) / levels1s.length : 0;
	const levelStd =
		levels1s.length > 1 ? Math.sqrt(levels1s.reduce((a, b) => a + (b - lm) ** 2, 0) / levels1s.length) : 0;
	const span = sum((s) => s.spanFrames);
	const bursts = parts.flatMap((s) => s.bursts);
	const tail = parts.length ? Math.max(...parts.map((s) => s.tailDropDb)) : 0;
	const persistPeaks = sum((s) => s.persistPeaks);
	const yinActive = sum((s) => s.yinActive);
	const voiced = sum((s) => s.voiced);
	const pairs = sum((s) => s.pairs);
	const specFrames = sum((s) => s.audibleSpecFrames);
	const lowFrames = sum((s) => s.lowEnergyFrames);
	const dur =
		Number.isFinite(durationSec) && durationSec > 0 ? Math.max(durationSec, analysedSec) : analysedSec;
	return {
		durationSec: q3(dur),
		analysedSec: q3(analysedSec),
		silent,
		activeRatio: q3(frames ? sum((s) => s.active) / frames : 0),
		audibleRatio: q3(frames ? audible / frames : 0),
		dynamicRangeDb: q3(all.length ? quantile(all, 0.95) - quantile(all, 0.1) : 0),
		burstRate: q3(audSec > 0 ? bursts.length / audSec : 0),
		burstMedianSec: q3(median(bursts)),
		lowEnergyRatio: q3(lowFrames ? sum((s) => s.lowEnergy) / lowFrames : 0),
		syllabicModulation: q3(median(parts.flatMap((s) => s.modulation))),
		voicedRatio: q3(yinActive ? voiced / yinActive : 0),
		speechPitchRatio: q3(voiced ? sum((s) => s.speechPitch) / voiced : 0),
		pitchSteadiness: q3(pairs ? sum((s) => s.steadyPairs) / pairs : 0),
		pitchGlideSt: q3(median(parts.flatMap((s) => s.glides))),
		voicedRunSec: q3(median(parts.flatMap((s) => s.runs))),
		tonalPersistence: q3(persistPeaks ? sum((s) => s.persistHits) / persistPeaks : 0),
		tonalFrameRatio: q3(specFrames ? sum((s) => s.tonalFrames) / specFrames : 0),
		onsetRate: q3(audSec > 0 ? sum((s) => s.onsets) / audSec : 0),
		onsetCount: sum((s) => s.onsets),
		onsetRegularity: q3(regW ? sum((s) => s.regularity * s.regularityWeight) / regW : 0),
		levelStdDb: q3(levelStd),
		spectralChangeDb: q3(median(parts.flatMap((s) => s.bandChanges))),
		flatness: q3(flatness),
		centroidHz: Math.round(centroidHz),
		activeSpanRatio: q3(frames ? span / frames : 0),
		tailDropDb: q3(tail),
	};
}

/**
 * Features of up to `MAX_CATEGORY_WINDOWS` windows of one clip (each ≤ 60 s; longer ones are cut) and its real length
 * (`durationSec`, default: the windows' total). Throws `AudioCategoryError` only for malformed arguments (no windows,
 * a sample rate outside 1 kHz … 768 kHz); any audio content gives finite features.
 */
export function audioCategoryFeatures(
	windows: readonly AudioWindow[] | AudioWindow,
	durationSec?: number,
): AudioCategoryFeatures {
	const list = Array.isArray(windows) ? windows : [windows as AudioWindow];
	if (list.length === 0 || list.length > MAX_CATEGORY_WINDOWS)
		throw new AudioCategoryError(`Give 1…${MAX_CATEGORY_WINDOWS} audio windows`);
	const parts: WindowStats[] = [];
	for (const w of list) {
		if (!w || !Array.isArray(w.channels) || !(w.sampleRate >= 1000 && w.sampleRate <= 768_000))
			throw new AudioCategoryError('Each window needs channels and a sample rate in 1 kHz … 768 kHz');
		const { x, sr } = monoAt(w, MAX_CATEGORY_WINDOW_SECONDS);
		parts.push(measureWindow(x, sr));
	}
	return pool(parts, durationSec ?? Number.NaN);
}

const fmt = (x: number, d = 2) => (Number.isFinite(x) ? x.toFixed(d) : '?');

/**
 * The category of a clip from its features (deterministic; never throws). Scores are 0…1 per category; the
 * confidence is the winner's share of the squared scores. Rules (documented in the wp-note, constants here):
 *
 * - dialogue: voiced with speech-range pitch, AND syllabic modulation / gliding pitch / short voiced runs / pauses,
 *   AND no steady beat; ≥ 0.5 s.
 * - music: ≥ 2 s and a steady pulse of onsets, or sustained tonal partials with steady pitch.
 * - ambience: ≥ 3 s, audible most of the time, and stationary (level and colour change little from second to second),
 *   with no beat and not sustained tones.
 * - sfx: short, or one event that rises and dies away (few onsets, a large dynamic range, a tail), and what is left.
 */
export function classifyAudio(f: AudioCategoryFeatures): AudioCategoryResult {
	const zero: Record<AudioCategory, number> = { dialogue: 0, music: 0, sfx: 0, ambience: 0 };
	if (!f || f.silent || !(f.analysedSec > 0))
		return { category: 'ambience', confidence: 0, scores: zero, reasons: ['silent'], silent: true };
	const D = f.durationSec;
	const mod = ramp(f.syllabicModulation, 0.1, 0.3);
	const voice = ramp(f.voicedRatio, 0.15, 0.4) * ramp(f.speechPitchRatio, 0.5, 0.8);
	const glide = 1 - ramp(f.pitchSteadiness, 0.3, 0.55);
	const shortRuns = 1 - ramp(f.voicedRunSec, 0.25, 0.6);
	const pauses = ramp(f.lowEnergyRatio, 0.1, 0.25);
	const beat = ramp(f.onsetRegularity, 0.3, 0.55) * ramp(f.onsetRate, 0.5, 1.2) * ramp(f.onsetCount, 4, 8);
	const tonal = ramp(f.tonalPersistence, 0.35, 0.6) * ramp(f.tonalFrameRatio, 0.25, 0.55);
	const steady = ramp(f.pitchSteadiness, 0.25, 0.5);
	const stationary = (1 - ramp(f.spectralChangeDb, 1.5, 4)) * (1 - ramp(f.levelStdDb, 3, 8));
	const continuous = ramp(f.audibleRatio, 0.6, 0.9);
	// one event: the level swings or dies away (not a steady bed), and few onsets for its length
	const evolving = Math.max(
		ramp(f.tailDropDb, 10, 25),
		ramp(f.levelStdDb, 3, 8),
		ramp(f.dynamicRangeDb, 15, 30),
	);

	const dialogue = voice * mod * ((glide + shortRuns + pauses) / 3) * (1 - 0.8 * beat) * ramp(D, 0.4, 1);
	const music =
		ramp(D, 3, 6) *
		Math.max(beat * (0.6 + 0.4 * Math.max(tonal, steady)), tonal * (0.5 + 0.5 * steady)) *
		(1 - 0.5 * voice * mod);
	const ambience =
		ramp(D, 2.5, 6) * continuous * stationary * (1 - beat) * (1 - 0.7 * tonal) * (1 - 0.8 * voice * mod);
	const short = 1 - ramp(D, 1, 6);
	const sfx =
		Math.max(short, 0.8 * evolving * (1 - stationary) * (1 - ramp(D, 10, 30))) *
		(1 - 0.6 * Math.max(dialogue, music, ambience));
	const scores: Record<AudioCategory, number> = {
		dialogue: q3(dialogue),
		music: q3(music),
		sfx: q3(sfx),
		ambience: q3(ambience),
	};
	let best: AudioCategory = 'sfx';
	for (const c of AUDIO_CATEGORIES) if (scores[c] > scores[best]) best = c;
	const sq = AUDIO_CATEGORIES.reduce((a, c) => a + scores[c] ** 2, 0);
	// the winner's share of the squared scores, scaled down when even the winner's evidence is weak (< 0.5)
	const confidence = sq > 0 ? (scores[best] ** 2 / sq) * clamp01(scores[best] / 0.5) : 0;
	const reasons: string[] = [];
	const why: Record<AudioCategory, () => string[]> = {
		dialogue: () => [
			`voiced ${fmt(f.voicedRatio * 100, 0)} % of the active time, pitch in the speech range (${fmt(f.speechPitchRatio * 100, 0)} %)`,
			`syllabic modulation ${fmt(f.syllabicModulation)}`,
			`pitch glides (${fmt(f.pitchSteadiness * 100, 0)} % steady), voiced runs ${fmt(f.voicedRunSec)} s`,
		],
		music: () => [
			beat >= tonal
				? `a steady pulse (onset periodicity ${fmt(f.onsetRegularity)}, ${fmt(f.onsetRate, 1)} onsets/s)`
				: `sustained tones (${fmt(f.tonalPersistence * 100, 0)} % of partials held 0.2 s)`,
			`pitch steady ${fmt(f.pitchSteadiness * 100, 0)} %`,
		],
		sfx: () => [
			D < 1.5
				? `short (${fmt(D)} s)`
				: `one event (${f.onsetCount} onsets, ${fmt(f.dynamicRangeDb, 0)} dB range)`,
			f.tailDropDb > 10 ? `dies away (${fmt(f.tailDropDb, 0)} dB)` : `no speech, beat or steady bed`,
		],
		ambience: () => [
			`steady bed over ${fmt(D, 1)} s (level ±${fmt(f.levelStdDb, 1)} dB, colour change ${fmt(f.spectralChangeDb, 1)} dB/s)`,
			`no beat, speech or held tones`,
		],
	};
	reasons.push(...why[best]());
	return { category: best, confidence: q3(confidence), scores, reasons, silent: false };
}
