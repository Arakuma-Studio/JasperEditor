// CLAP audio front end (spec 12 P6-E14, WP-E9): the log-mel input of LAION CLAP `larger_clap_general`, written from its
// published feature-extractor settings (`preprocessor_config.json` of the pinned revision; the Hugging Face
// `ClapFeatureExtractor` with `truncation: rand_trunc`, `padding: repeatpad`): mono 48 kHz, one 10 s window (480 000
// samples; a shorter sound is repeated whole as often as it fits, then zero-padded), centred frames (reflect padding of
// 512 samples), 1024-point periodic Hann window, hop 480 (1001 frames), power spectrum, a 64-band Slaney mel filterbank
// with Slaney area normalisation over 50 Hz … 14 kHz, `10·log10(max(x, 1e-10))` (no floor, no normalisation).
// Checked against the reference implementation on the build server (wp-note "Phase 6 → WP-E9": max |Δ| in dB).
// Pure: no I/O.
import { Fft } from '@jasper/audio-dsp';

export const CLAP_RATE = 48_000;
export const CLAP_WINDOW_SAMPLES = 480_000;
export const CLAP_WINDOW_SEC = CLAP_WINDOW_SAMPLES / CLAP_RATE;
export const CLAP_N_FFT = 1024;
export const CLAP_HOP = 480;
export const CLAP_MELS = 64;
export const CLAP_FRAMES = 1 + Math.floor(CLAP_WINDOW_SAMPLES / CLAP_HOP); // 1001
export const CLAP_EMBED_DIM = 512;
const N_BINS = CLAP_N_FFT / 2 + 1;
const F_MIN = 50;
const F_MAX = 14_000;
const MEL_FLOOR = 1e-10;

/** Slaney mel scale (linear below 1 kHz, logarithmic above), as librosa / Hugging Face define it. */
function hzToMelSlaney(f: number): number {
	if (f < 1000) return (3 * f) / 200;
	return 15 + Math.log(f / 1000) * (27 / Math.log(6.4));
}

function melToHzSlaney(m: number): number {
	if (m < 15) return (200 * m) / 3;
	return 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15));
}

let filters: Float64Array | null = null;

/** The filterbank, `N_BINS × CLAP_MELS` row-major (bin-major), Slaney-normalised. */
function clapMelFilters(): Float64Array {
	if (filters) return filters;
	const melMin = hzToMelSlaney(F_MIN);
	const melMax = hzToMelSlaney(F_MAX);
	const points = new Float64Array(CLAP_MELS + 2);
	for (let i = 0; i < points.length; i++)
		points[i] = melToHzSlaney(melMin + ((melMax - melMin) * i) / (CLAP_MELS + 1));
	const out = new Float64Array(N_BINS * CLAP_MELS);
	for (let b = 0; b < N_BINS; b++) {
		// fft bin frequencies: linspace(0, sr // 2, N_BINS)
		const f = ((CLAP_RATE / 2) * b) / (N_BINS - 1);
		for (let m = 0; m < CLAP_MELS; m++) {
			const lo = points[m]!;
			const mid = points[m + 1]!;
			const hi = points[m + 2]!;
			const down = (f - lo) / (mid - lo);
			const up = (hi - f) / (hi - mid);
			const w = Math.max(0, Math.min(down, up));
			out[b * CLAP_MELS + m] = w * (2 / (hi - lo));
		}
	}
	filters = out;
	return out;
}

let hann: Float64Array | null = null;
function hannWindow(): Float64Array {
	if (hann) return hann;
	const w = new Float64Array(CLAP_N_FFT);
	for (let i = 0; i < CLAP_N_FFT; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / CLAP_N_FFT);
	hann = w;
	return w;
}

/**
 * The model's 10 s input from a sound: its first 10 s, or the whole sound repeated as many whole times as fit and
 * zero-padded (`repeatpad`). Empty or non-finite input gives silence (non-finite samples are zeroed).
 */
export function repeatPad(samples: Float32Array): Float32Array {
	const out = new Float32Array(CLAP_WINDOW_SAMPLES);
	const n = Math.min(samples.length, CLAP_WINDOW_SAMPLES);
	if (n === 0) return out;
	const src = samples.length > CLAP_WINDOW_SAMPLES ? samples.subarray(0, CLAP_WINDOW_SAMPLES) : samples;
	const repeats = samples.length >= CLAP_WINDOW_SAMPLES ? 1 : Math.floor(CLAP_WINDOW_SAMPLES / n);
	for (let r = 0; r < repeats; r++) out.set(src, r * n);
	for (let i = 0; i < out.length; i++) if (!Number.isFinite(out[i]!)) out[i] = 0;
	return out;
}

const fft = { inst: null as Fft | null };

/**
 * Log-mel features of one 10 s window (`repeatPad` applied first): `CLAP_FRAMES × CLAP_MELS` frame-major, the layout of
 * the model's `input_features[b, 0]`. Writes into `out` when given (length CLAP_FRAMES × CLAP_MELS).
 */
export function clapLogMel(samples: Float32Array, out?: Float32Array): Float32Array {
	const x = repeatPad(samples);
	const res = out ?? new Float32Array(CLAP_FRAMES * CLAP_MELS);
	if (res.length !== CLAP_FRAMES * CLAP_MELS) throw new RangeError('clapLogMel: wrong output length');
	const pad = CLAP_N_FFT / 2;
	const n = x.length;
	// reflect padding (numpy "reflect": the edge sample is not repeated)
	const at = (i: number): number => {
		if (i < 0) return x[-i]!;
		if (i >= n) return x[2 * n - 2 - i]!;
		return x[i]!;
	};
	const w = hannWindow();
	const fb = clapMelFilters();
	fft.inst ??= new Fft(CLAP_N_FFT);
	const re = new Float64Array(CLAP_N_FFT);
	const im = new Float64Array(CLAP_N_FFT);
	const power = new Float64Array(N_BINS);
	const mel = new Float64Array(CLAP_MELS);
	for (let t = 0; t < CLAP_FRAMES; t++) {
		const start = t * CLAP_HOP - pad;
		for (let i = 0; i < CLAP_N_FFT; i++) {
			re[i] = at(start + i) * w[i]!;
			im[i] = 0;
		}
		fft.inst.forward(re, im);
		for (let b = 0; b < N_BINS; b++) power[b] = re[b]! * re[b]! + im[b]! * im[b]!;
		mel.fill(0);
		for (let b = 0; b < N_BINS; b++) {
			const p = power[b]!;
			if (p === 0) continue;
			const row = b * CLAP_MELS;
			for (let m = 0; m < CLAP_MELS; m++) mel[m]! += p * fb[row + m]!;
		}
		for (let m = 0; m < CLAP_MELS; m++)
			res[t * CLAP_MELS + m] = 10 * Math.log10(Math.max(MEL_FLOOR, mel[m]!));
	}
	return res;
}

/** A window of a sound, seconds from its start. */
export type ClapWindow = { startSec: number; endSec: number };

/** Windows of a whole-sound embedding: at most this many 10 s windows, averaged (long files are sampled evenly). */
export const WHOLE_SOUND_WINDOWS = 6;

/**
 * The windows a whole sound is embedded from (spec 12 P6-E14 "one repeat-padded 10 s window per sound"): the whole
 * sound when it is at most 10 s long; else up to `WHOLE_SOUND_WINDOWS` 10 s windows spread evenly from its start to its
 * end (their embeddings are averaged). Nothing for a sound without a positive finite length.
 */
export function wholeSoundWindows(durationSec: number): ClapWindow[] {
	if (!(durationSec > 0) || !Number.isFinite(durationSec)) return [];
	if (durationSec <= CLAP_WINDOW_SEC) return [{ startSec: 0, endSec: durationSec }];
	const n = Math.min(WHOLE_SOUND_WINDOWS, Math.ceil(durationSec / CLAP_WINDOW_SEC));
	const span = durationSec - CLAP_WINDOW_SEC;
	const out: ClapWindow[] = [];
	for (let i = 0; i < n; i++) {
		const startSec = n === 1 ? 0 : round4((span * i) / (n - 1));
		out.push({ startSec, endSec: round4(startSec + CLAP_WINDOW_SEC) });
	}
	return out;
}

const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** L2-normalises `v` in place (a zero vector stays zero); returns it. */
export function normalize(v: Float32Array): Float32Array {
	let s = 0;
	for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
	const n = Math.sqrt(s);
	if (n > 0 && Number.isFinite(n)) for (let i = 0; i < v.length; i++) v[i] = v[i]! / n;
	else v.fill(0);
	return v;
}

/** The normalised mean of embeddings (one window's own when there is one). */
export function meanEmbedding(list: readonly Float32Array[]): Float32Array {
	const out = new Float32Array(CLAP_EMBED_DIM);
	for (const v of list) for (let i = 0; i < out.length; i++) out[i]! += v[i] ?? 0;
	return normalize(out);
}
