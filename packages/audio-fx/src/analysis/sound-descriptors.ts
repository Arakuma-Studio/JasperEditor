// Sound descriptors (spec 12 §2.1, docs/wp-notes/sound-design.md "WP1.1b"): a fixed set of measured, quantised
// numbers that describe one sound effect for agents that cannot hear it, for the judge (`sound-judge.ts`), ranking and
// placement (peak alignment). Pure and deterministic: the same samples and rate always give the same object.
//
//   level envelope   2 ms RMS windows every 0.5 ms (mean power over channels)
//                    → peakSec, onsetSec (−30 dB re peak), riseMs (10 → 90 % amplitude of the loudest 10 ms),
//                      decayMs / decays (→ −20 dB),
//                      tailSec (→ −60 dB), the active span (first … last point within 60 dB of the peak)
//   samples          headQuietSec (first sample ≥ 1 % = −40 dB of the sample peak), stereoWidth, loopable
//   spectrum         Welch average of Hann frames (≈ 40 ms, 50 % overlap) over the active span, channels summed
//                    → power-weighted centroidHz, rolloff85Hz and rolloff95Hz, below150Share, above6kShare,
//                      octaveBandsDb, flatness (50 Hz … 16 kHz)
//   floor / DC       floorDb: 10th percentile of 20 ms RMS windows (the level between events; earshot's real-sound
//                    `analyze.py` rule), dcDb: the largest channel mean (both version 2, P6-E9)
//   onsets           SuperFlux-style band flux (Böck & Widmer 2013): third-octave log band energies, rise against
//                    the max of the two previous frames, per-band rise capped at 30 dB, peak-picked
//   pitch            YIN (de Cheveigné & Kawahara 2002) on up to 16 frames from the onset
//   loudness         BS.1770-4 via @jasper/audio-dsp's LoudnessMeter (input padded with silence to whole 100 ms
//                    blocks and at least 400 ms, so a short sound still has a momentary loudness)
//
// Robustness (AGENTS.md §0.2): `channels` and `sampleRate` are validated (`SoundAnalysisError`, code
// `E_INVALID_PARAM`); non-finite samples (NaN, ±Infinity) are SANITISED to 0, never propagated; empty, silent,
// one-sample, mono, stereo and multichannel input all give a fully defined result. Input longer than
// `MAX_ANALYSIS_SECONDS` is analysed over its first `MAX_ANALYSIS_SECONDS` (durationSec stays the real length), the
// onset count over at most `MAX_ONSET_SECONDS` of the active span, and the spectrum over at most `MAX_SPECTRAL_FRAMES`
// evenly spaced frames, so analysis time is bounded.
import { LoudnessMeter } from '@jasper/audio-dsp';
import {
	FramePower,
	fftLength,
	MAX_BAND_FRAMES,
	OCTAVE_BAND_CENTRES_HZ,
	octaveBandsFromPower,
	welchPower,
} from './bands.ts';

/** Bumped whenever a definition or quantisation changes (library indexes re-analyse older entries). */
export const SOUND_DESCRIPTORS_VERSION = 2;
/** Longest stretch analysed (seconds); later audio only counts towards `durationSec`. */
export const MAX_ANALYSIS_SECONDS = 120;
/** Longest stretch of the active span searched for onsets (seconds). */
export const MAX_ONSET_SECONDS = 30;
/** Most spectral frames averaged (evenly spaced over the active span beyond that). */
export const MAX_SPECTRAL_FRAMES = MAX_BAND_FRAMES;
/** Most channels accepted. */
export const MAX_SOUND_CHANNELS = 32;
/** Accepted sample rates (Hz). */
export const MIN_SOUND_SAMPLE_RATE = 1000;
export const MAX_SOUND_SAMPLE_RATE = 768_000;
/** Octave band centres of `octaveBandsDb` (Hz): `OCTAVE_BAND_CENTRES_HZ`, exported from `./bands.ts`. */
/** Lowest analysis rate whose `rolloff95Hz` is reported (a file can only hold air above 12 kHz from 44.1 kHz on). */
export const AIR_MIN_SAMPLE_RATE = 44_100;
/** Level reported for an empty band or silence (dB). */
export const DESCRIPTOR_FLOOR_DB = -120;
/** Highest level a descriptor reports (dB / LUFS): huge finite input (±3.4e38) would read ≈ +730. */
export const DESCRIPTOR_CEILING_DB = 200;

export interface SoundDescriptors {
	/** Length of the input (s, 0.1 ms). */
	durationSec: number;
	/** Centre of the loudest 2 ms RMS window, 0.5 ms hop (s). */
	peakSec: number;
	/** First point of the envelope within 30 dB of the peak (s). */
	onsetSec: number;
	/** Rise time from 10 % to 90 % of the loudest 10 ms (amplitude), on the first rise to that level (ms). */
	riseMs: number;
	/** Peak → first point 20 dB below it (ms); without such a point, peak → end of the sound. */
	decayMs: number;
	/** Whether the envelope falls 20 dB below the peak after it. */
	decays: boolean;
	/** Peak → last point within 60 dB of the peak (s). */
	tailSec: number;
	/** Spectral centroid of the average power spectrum (Hz). */
	centroidHz: number;
	/** Frequency below which 85 % of the average power lies (Hz). */
	rolloff85Hz: number;
	/**
	 * Frequency below which 95 % of the average power lies (Hz); null when the analysis rate is under 44.1 kHz (the file
	 * cannot hold the air above 12 kHz the judge's `lowpassed` looks for) or for silence. Absent in version-1 analyses.
	 */
	rolloff95Hz?: number | null;
	/**
	 * Noise floor between events (dBFS): the 10th percentile of the 20 ms RMS windows (mean power over channels; a
	 * full-scale sine reads −3.01), −120 for digital silence. Null when there are fewer than 10 windows (under 0.2 s) or
	 * the percentile is within 12 dB of the loudest window (the sound fills the file: there is no "between"). Absent in
	 * version-1 analyses.
	 */
	floorDb?: number | null;
	/** DC offset: 20·log10 of the largest |mean| of a channel (dBFS); null when every mean is 0. Absent in version 1. */
	dcDb?: number | null;
	/** Share of the power below 150 Hz (0…1). */
	below150Share: number;
	/** Share of the power above 6 kHz (0…1). */
	above6kShare: number;
	/** Wiener entropy of the average power spectrum over 50 Hz … 16 kHz: ≈ 1 white noise, ≈ 0 a pure tone. */
	flatness: number;
	/** Mean-square level of the 7 octave bands 125 Hz … 8 kHz over the active span (dBFS; a full-scale sine reads −3.01). */
	octaveBandsDb: number[];
	/** YIN pitch as a MIDI note number (A4 = 69, 0.01 = 1 cent); null when aperiodic. */
	pitchMidi: number | null;
	/** 1 − the median YIN aperiodicity (0…1); also given when `pitchMidi` is null. */
	pitchConfidence: number;
	/** Number of onsets (spectral flux peaks); 0 for silence or a sound that only swells. */
	onsetCount: number;
	/** BS.1770-4 integrated loudness (LUFS); null when nothing passes the gates. */
	integratedLufs: number | null;
	/** Highest 400 ms momentary loudness (LUFS); null for silence. */
	maxMomentaryLufs: number | null;
	/** True peak (dBTP, 4× oversampled); null for digital silence. */
	truePeakDb: number | null;
	/** Side / (mid + side) energy of the first two channels: 0 mono, 0.5 uncorrelated or one-sided, 1 anti-phase. */
	stereoWidth: number;
	/** Length of the head below −40 dB re the sample peak (s, rounded down: never claims more than is quiet). */
	headQuietSec: number;
	/** ≥ 1 s, level of the first and last 100 ms within 3 dB and not faded, and no click at the wrap. */
	loopable: boolean;
}

/** Thrown for invalid arguments (not for odd audio: odd audio gives a defined result). */
export class SoundAnalysisError extends Error {
	readonly code = 'E_INVALID_PARAM';
	constructor(message: string) {
		super(message);
		this.name = 'SoundAnalysisError';
	}
}

// ── quantisation ────────────────────────────────────────────────────────────────────────────────────────────────

const finite = (x: number, fallback = 0): number => (Number.isFinite(x) ? x : fallback);
/** Round to 1/scale, never −0. */
const quant = (x: number, scale: number): number => {
	const v = Math.round(finite(x) * scale) / scale;
	return v === 0 ? 0 : v;
};
const qSec = (x: number): number => quant(x, 10_000);
const qMs = (x: number): number => quant(x, 10);
const qHz = (x: number): number => quant(x, 1);
const qDb = (x: number): number => quant(x, 100);
const qUnit = (x: number): number => quant(Math.min(1, Math.max(0, finite(x))), 1000);
/** Loudness levels: null for −∞ and for anything under the floor (a sub-normal "signal" is silence); capped above. */
const qDbOrNull = (x: number): number | null =>
	Number.isFinite(x) && x >= DESCRIPTOR_FLOOR_DB ? qDb(Math.min(x, DESCRIPTOR_CEILING_DB)) : null;

const dbPow = (p: number): number => (p > 0 ? 10 * Math.log10(p) : Number.NEGATIVE_INFINITY);

// ── input ───────────────────────────────────────────────────────────────────────────────────────────────────────

type Prepared = { ch: Float32Array[]; n: number; total: number; sr: number };

function prepare(channels: Float32Array[], sampleRate: number): Prepared {
	if (!Array.isArray(channels)) throw new SoundAnalysisError('channels must be an array of Float32Array');
	if (channels.length > MAX_SOUND_CHANNELS)
		throw new SoundAnalysisError(
			`at most ${MAX_SOUND_CHANNELS} channels are analysed (got ${channels.length})`,
		);
	for (const c of channels)
		if (!(c instanceof Float32Array)) throw new SoundAnalysisError('every channel must be a Float32Array');
	if (
		typeof sampleRate !== 'number' ||
		!Number.isFinite(sampleRate) ||
		sampleRate < MIN_SOUND_SAMPLE_RATE ||
		sampleRate > MAX_SOUND_SAMPLE_RATE
	)
		throw new SoundAnalysisError(
			`sampleRate must be a number from ${MIN_SOUND_SAMPLE_RATE} to ${MAX_SOUND_SAMPLE_RATE} Hz`,
		);
	let total = 0;
	for (const c of channels) total = Math.max(total, c.length);
	const n = Math.min(total, Math.floor(MAX_ANALYSIS_SECONDS * sampleRate));
	const ch = channels.map((c) => {
		let bad = c.length < n;
		if (!bad)
			for (let i = 0; i < n; i++) {
				const x = c[i]!;
				if (x - x !== 0) {
					bad = true;
					break;
				}
			}
		if (!bad) return c.length === n ? c : c.subarray(0, n);
		// sanitise: NaN / ±Infinity → 0; a shorter channel is padded with silence
		const out = new Float32Array(n);
		const m = Math.min(n, c.length);
		for (let i = 0; i < m; i++) {
			const x = c[i]!;
			out[i] = x - x === 0 ? x : 0;
		}
		return out;
	});
	return { ch, n, total, sr: sampleRate };
}

// ── level envelope ──────────────────────────────────────────────────────────────────────────────────────────────

/** Blocks per RMS window (window = 4 hops = 2 ms). */
const ENV_BLOCKS = 4;

type Envelope = {
	/** Mean power per window, windows j = 0 … len−1. */
	p: Float64Array;
	hop: number;
	/** Window j covers samples [(j − 3)·hop, (j + 1)·hop). */
	time: (j: number) => number;
	max: number;
};

function envelope(pr: Prepared): Envelope {
	const { ch, n, sr } = pr;
	const hop = Math.max(1, Math.round(sr * 0.0005));
	const nb = Math.ceil(n / hop);
	const blocks = new Float64Array(nb);
	for (const c of ch) {
		for (let b = 0; b < nb; b++) {
			const end = Math.min(n, (b + 1) * hop);
			let s = 0;
			for (let i = b * hop; i < end; i++) {
				const x = c[i]!;
				s += x * x;
			}
			blocks[b] += s;
		}
	}
	const len = nb > 0 ? nb + ENV_BLOCKS - 1 : 0;
	const p = new Float64Array(len);
	const norm = 1 / (ENV_BLOCKS * hop * Math.max(1, ch.length));
	let max = 0;
	for (let j = 0; j < len; j++) {
		let s = 0;
		for (let k = j - ENV_BLOCKS + 1; k <= j; k++) if (k >= 0 && k < nb) s += blocks[k]!;
		const v = s * norm;
		p[j] = v;
		if (v > max) max = v;
	}
	const dur = n / sr;
	const time = (j: number): number =>
		Math.min(dur, Math.max(0, ((j - ENV_BLOCKS + 1) * hop + (ENV_BLOCKS * hop) / 2 - 0.5) / sr));
	return { p, hop, time, max };
}

/** Points of the moving average whose maximum is the rise reference (20 × 0.5 ms = 10 ms). */
const RISE_REF_POINTS = 20;

/** Largest mean of `w` consecutive values (the plain max when there are fewer). */
function smoothedMax(p: Float64Array, w: number): number {
	if (p.length <= w) {
		let m = 0;
		for (const v of p) m = Math.max(m, v);
		return m;
	}
	let s = 0;
	for (let i = 0; i < w; i++) s += p[i]!;
	let best = s;
	for (let i = w; i < p.length; i++) {
		s += p[i]! - p[i - w]!;
		if (s > best) best = s;
	}
	return best / w;
}

/** Time where the envelope (in dB re its max) crosses `thrDb` between points j0 and j1, interpolated in dB. */
function crossing(env: Envelope, j0: number, j1: number, thrDb: number): number {
	return crossingRef(env, env.max, j0, j1, thrDb);
}

/** Time where the envelope (in dB re `ref`) crosses `thrDb` between points j0 and j1, interpolated in dB. */
function crossingRef(env: Envelope, ref: number, j0: number, j1: number, thrDb: number): number {
	const d0 = Math.max(DESCRIPTOR_FLOOR_DB, dbPow(env.p[j0]! / ref));
	const d1 = Math.max(DESCRIPTOR_FLOOR_DB, dbPow(env.p[j1]! / ref));
	const t0 = env.time(j0);
	const t1 = env.time(j1);
	if (d1 === d0) return t1;
	const f = Math.min(1, Math.max(0, (thrDb - d0) / (d1 - d0)));
	return t0 + f * (t1 - t0);
}

// ── spectrum ────────────────────────────────────────────────────────────────────────────────────────────────────

type Spectral = {
	centroidHz: number;
	rolloff85Hz: number;
	rolloff95Hz: number;
	below150Share: number;
	above6kShare: number;
	flatness: number;
	octaveBandsDb: number[];
};

const EMPTY_SPECTRAL: Spectral = {
	centroidHz: 0,
	rolloff85Hz: 0,
	rolloff95Hz: 0,
	below150Share: 0,
	above6kShare: 0,
	flatness: 0,
	octaveBandsDb: /* @__PURE__ */ OCTAVE_BAND_CENTRES_HZ.map(() => DESCRIPTOR_FLOOR_DB),
};

function spectral(pr: Prepared, s0: number, s1: number): Spectral {
	const { ch, n: len, sr } = pr;
	if (ch.length === 0 || s1 <= s0)
		return { ...EMPTY_SPECTRAL, octaveBandsDb: [...EMPTY_SPECTRAL.octaveBandsDb] };
	// Welch frames centred from s0 to s1 (inclusive of both edges); mean square per bin over frames and channels
	const w = welchPower(ch, len, sr, s0, s1);
	if (!w) return { ...EMPTY_SPECTRAL, octaveBandsDb: [...EMPTY_SPECTRAL.octaveBandsDb] };
	const acc = w.power;
	const binHz = w.binHz;
	let total = 0;
	let low = 0;
	let high = 0;
	let powF = 0;
	for (let k = 0; k < acc.length; k++) {
		const p = acc[k]!;
		const f = k * binHz;
		total += p;
		if (f < 150) low += p;
		if (f > 6000) high += p;
		powF += p * f;
	}
	if (!(total > 0) || !Number.isFinite(total))
		return { ...EMPTY_SPECTRAL, octaveBandsDb: [...EMPTY_SPECTRAL.octaveBandsDb] };
	let rolloff = 0;
	let rolloff95 = 0;
	const target = 0.85 * total;
	const target95 = 0.95 * total;
	let run = 0;
	let found85 = false;
	for (let k = 0; k < acc.length; k++) {
		run += acc[k]!;
		if (!found85 && run >= target) {
			rolloff = k * binHz;
			found85 = true;
		}
		if (run >= target95) {
			rolloff95 = k * binHz;
			break;
		}
	}
	// flatness over 50 Hz … min(16 kHz, 0.45·sr), bins floored 120 dB under the strongest
	const kLo = Math.max(1, Math.ceil(50 / binHz));
	const kHi = Math.min(acc.length - 2, Math.floor(Math.min(16_000, 0.45 * sr) / binHz));
	let flatness = 0;
	if (kHi >= kLo) {
		let pmax = 0;
		for (let k = kLo; k <= kHi; k++) pmax = Math.max(pmax, acc[k]!);
		if (pmax > 0) {
			const floor = pmax * 1e-12;
			let logSum = 0;
			let linSum = 0;
			for (let k = kLo; k <= kHi; k++) {
				const p = Math.max(acc[k]!, floor);
				logSum += Math.log(p);
				linSum += p;
			}
			const cnt = kHi - kLo + 1;
			flatness = Math.exp(logSum / cnt) / (linSum / cnt);
		}
	}
	const octaveBandsDb = octaveBandsFromPower(acc, binHz);
	return {
		centroidHz: powF / total,
		rolloff85Hz: rolloff,
		rolloff95Hz: rolloff95,
		below150Share: low / total,
		above6kShare: high / total,
		flatness,
		octaveBandsDb,
	};
}

// ── onsets ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Most a band may contribute to the flux of one frame (dB). */
const FLUX_BAND_CAP_DB = 30;
/** Smallest flux peak counted (sum of band rises, dB). */
const FLUX_MIN_DB = 12;
/** A flux peak must reach this share of the largest one. */
const FLUX_REL = 0.25;
/** Frames quieter than the loudest by more than this are not searched (dB). */
const ONSET_GATE_DB = 40;
/** Energy ratio an onset frame must reach over the frames before it (+3 dB). */
const ONSET_ENERGY_RISE = 10 ** (3 / 10);
/** Shortest gap between two onsets (s). */
const ONSET_MIN_GAP_S = 0.05;

function onsetCount(pr: Prepared, s0: number, s1: number): number {
	return onsetPositions(pr, s0, s1, MAX_ONSET_SECONDS).length;
}

/**
 * Onsets of [s0, s1) (at most `maxSec` of it): the sample at the centre of each onset frame (≈ 21 ms frames, half
 * overlapping, so within about one hop of the attack), ascending. `onsetCount` is their number over
 * `MAX_ONSET_SECONDS`; takes (takes.ts) search up to `MAX_ANALYSIS_SECONDS`.
 */
function onsetPositions(pr: Prepared, s0: number, s1: number, maxSec: number): number[] {
	const { ch, n: len, sr } = pr;
	const out: number[] = [];
	if (ch.length === 0 || s1 <= s0) return out;
	const N = fftLength(sr, 0.02);
	const hop = N / 2;
	const binHz = sr / N;
	// third-octave bands from 60 Hz, each at least 4 bins wide
	const top = Math.min(16_000, 0.45 * sr);
	const edges: number[] = [];
	let k = Math.max(1, Math.floor(60 / binHz));
	while (k * binHz < top) {
		edges.push(k);
		let next = Math.max(k + 4, Math.ceil(k * 2 ** (1 / 3)));
		if (next * binHz > top) next = Math.floor(top / binHz) + 1;
		if (next <= k) break;
		k = next;
	}
	edges.push(Math.min(N / 2 + 1, Math.max(k, (edges[edges.length - 1] ?? 0) + 1)));
	const nb = edges.length - 1;
	if (nb < 1) return out;
	const end = Math.min(s1, s0 + Math.floor(maxSec * sr));
	const first = s0 - N;
	const frames = Math.max(1, Math.ceil((end - first) / hop) + 1);
	const fp = new FramePower(N);
	const spec = new Float64Array(N / 2 + 1);
	const bandE = new Float64Array(frames * nb);
	const frameE = new Float64Array(frames);
	let ref = 0;
	for (let t = 0; t < frames; t++) {
		spec.fill(0);
		fp.add(ch, len, first + t * hop, spec);
		let fe = 0;
		for (let b = 0; b < nb; b++) {
			let e = 0;
			for (let i = edges[b]!; i < edges[b + 1]!; i++) e += spec[i]!;
			bandE[t * nb + b] = e;
			fe += e;
			if (e > ref) ref = e;
		}
		frameE[t] = fe;
	}
	if (!(ref > 0)) return out;
	const floorDb = dbPow(ref) - 80;
	const bandDb = (t: number, b: number): number =>
		t < 0 ? floorDb : Math.max(floorDb, dbPow(bandE[t * nb + b]!));
	const flux = new Float64Array(frames);
	let maxFlux = 0;
	let maxFrame = 0;
	for (let t = 0; t < frames; t++) maxFrame = Math.max(maxFrame, frameE[t]!);
	for (let t = 0; t < frames; t++) {
		let s = 0;
		for (let b = 0; b < nb; b++) {
			const rise = bandDb(t, b) - Math.max(bandDb(t - 1, b), bandDb(t - 2, b));
			if (rise > 0) s += Math.min(FLUX_BAND_CAP_DB, rise);
		}
		flux[t] = s;
		if (s > maxFlux) maxFlux = s;
	}
	const thr = Math.max(FLUX_MIN_DB, FLUX_REL * maxFlux);
	const gate = maxFrame * 10 ** (-ONSET_GATE_DB / 10);
	const minGap = Math.max(1, Math.round((ONSET_MIN_GAP_S * sr) / hop));
	let last = Number.NEGATIVE_INFINITY;
	for (let t = 0; t < frames; t++) {
		const f = flux[t]!;
		if (f < thr) continue;
		// level gate: the onset frame or the next one must be within 40 dB of the loudest frame
		if (frameE[t]! < gate && (t + 1 >= frames || frameE[t + 1]! < gate)) continue;
		// an onset adds energy: the frame (or the next) is ≥ 3 dB above the two before it (an abrupt stop splatters the
		// spectrum into empty bands but loses energy; a filter sweep or a tremolo moves energy between bands but adds
		// little)
		const before = Math.max(t >= 1 ? frameE[t - 1]! : 0, t >= 2 ? frameE[t - 2]! : 0);
		const after = Math.max(frameE[t]!, t + 1 < frames ? frameE[t + 1]! : 0);
		if (after < before * ONSET_ENERGY_RISE) continue;
		let isPeak = true;
		for (let u = Math.max(0, t - 2); u <= Math.min(frames - 1, t + 2); u++)
			if (flux[u]! > f || (flux[u]! === f && u < t)) {
				isPeak = false;
				break;
			}
		if (!isPeak || t - last < minGap) continue;
		// frame t spans [first + t·hop, first + t·hop + N): its centre is s0 + (t − 1)·hop (N = 2·hop)
		out.push(Math.min(len - 1, Math.max(0, first + t * hop + N / 2)));
		last = t;
	}
	return out;
}

// ── pitch (YIN) ─────────────────────────────────────────────────────────────────────────────────────────────────

const YIN_FMIN = 50;
const YIN_FMAX = 4200;
const YIN_THRESHOLD = 0.15;
const YIN_VOICED = 0.2;
const YIN_FRAMES = 16;
/** Minimum confidence and voiced share for a pitch. */
const PITCH_MIN_CONFIDENCE = 0.7;

function pitch(
	pr: Prepared,
	s0: number,
	s1: number,
	env: Envelope,
): { midi: number | null; confidence: number } {
	const { ch, n: len, sr } = pr;
	const none = { midi: null, confidence: 0 };
	if (ch.length === 0 || s1 <= s0) return none;
	const dec = Math.max(1, Math.floor(sr / 32_000));
	const rate = sr / dec;
	const tauMax = Math.floor(rate / YIN_FMIN);
	const tauMin = Math.max(2, Math.floor(rate / YIN_FMAX));
	const W = tauMax;
	const need = (W + tauMax + 2) * dec;
	// frames start from the active span's start up to 1 s later (zeros past the end of a short sound)
	const regionEnd = Math.min(s1, s0 + Math.floor(sr));
	const span = Math.max(0, regionEnd - need - s0);
	const frames = span === 0 ? 1 : YIN_FRAMES;
	const x = new Float64Array(W + tauMax + 2);
	const d = new Float64Array(tauMax + 2);
	const gate = env.max * 1e-4; // frames 40 dB under the peak are not analysed
	const f0s: number[] = [];
	const aps: number[] = [];
	for (let f = 0; f < frames; f++) {
		const start = Math.min(
			Math.max(0, s0 + Math.round((f * span) / Math.max(1, frames - 1))),
			Math.max(0, len - need),
		);
		// mono, decimated (box average of `dec` samples)
		let energy = 0;
		for (let i = 0; i < x.length; i++) {
			let s = 0;
			const base = start + i * dec;
			for (let c = 0; c < ch.length; c++) {
				const a = ch[c]!;
				for (let q = 0; q < dec; q++) {
					const idx = base + q;
					if (idx < len) s += a[idx]!;
				}
			}
			const v = s / (ch.length * dec);
			x[i] = v;
			energy += v * v;
		}
		if (energy / x.length < gate || energy === 0) continue;
		// difference function and cumulative mean normalised difference
		d[0] = 1;
		let run = 0;
		for (let tau = 1; tau <= tauMax; tau++) {
			let s = 0;
			for (let j = 0; j < W; j++) {
				const v = x[j]! - x[j + tau]!;
				s += v * v;
			}
			run += s;
			d[tau] = run > 0 ? (s * tau) / run : 1;
		}
		let best = -1;
		for (let tau = tauMin; tau <= tauMax; tau++) {
			if (d[tau]! < YIN_THRESHOLD) {
				while (tau + 1 <= tauMax && d[tau + 1]! < d[tau]!) tau++;
				best = tau;
				break;
			}
		}
		if (best < 0) {
			let m = Number.POSITIVE_INFINITY;
			for (let tau = tauMin; tau <= tauMax; tau++)
				if (d[tau]! < m) {
					m = d[tau]!;
					best = tau;
				}
		}
		if (best < 0) continue;
		const ap = Math.min(1, Math.max(0, d[best]!));
		let tauF = best;
		if (best > tauMin && best < tauMax) {
			const a = d[best - 1]!;
			const b = d[best]!;
			const c = d[best + 1]!;
			const den = a - 2 * b + c;
			if (den > 0) tauF = best + Math.max(-0.5, Math.min(0.5, (a - c) / (2 * den)));
		}
		aps.push(ap);
		if (ap < YIN_VOICED) f0s.push(rate / tauF);
	}
	if (aps.length === 0) return none;
	const median = (v: number[]): number => {
		const s = [...v].sort((a, b) => a - b);
		const m = s.length >> 1;
		return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
	};
	const confidence = 1 - median(aps);
	if (confidence < PITCH_MIN_CONFIDENCE || f0s.length * 2 < aps.length) return { midi: null, confidence };
	const f0 = median(f0s);
	return { midi: 69 + 12 * Math.log2(f0 / 440), confidence };
}

// ── loudness ────────────────────────────────────────────────────────────────────────────────────────────────────

function loudness(pr: Prepared): { integrated: number; maxMomentary: number; truePeak: number } {
	const { ch, n, sr } = pr;
	if (ch.length === 0 || n === 0)
		return {
			integrated: Number.NEGATIVE_INFINITY,
			maxMomentary: Number.NEGATIVE_INFINITY,
			truePeak: Number.NEGATIVE_INFINITY,
		};
	const meter = new LoudnessMeter(sr, ch.length);
	meter.process(ch, 0, n);
	// pad with silence to whole 100 ms blocks and at least 400 ms, so the end (and a short sound) is measured
	const sub = Math.max(1, Math.round(sr * 0.1));
	const padded = Math.max(Math.ceil(n / sub) * sub, 4 * sub);
	const pad = padded - n;
	if (pad > 0) {
		const z = new Float32Array(Math.min(pad, sub));
		const zs = ch.map(() => z);
		for (let left = pad; left > 0; left -= z.length) meter.process(zs, 0, Math.min(left, z.length));
	}
	meter.flush();
	return { integrated: meter.integrated(), maxMomentary: meter.maxMomentary(), truePeak: meter.truePeakDb() };
}

// ── loopable ────────────────────────────────────────────────────────────────────────────────────────────────────

function isLoopable(pr: Prepared, headQuietSec: number): boolean {
	const { ch, n, sr } = pr;
	if (ch.length === 0 || n < sr) return false;
	if (headQuietSec >= 0.005) return false;
	const w = Math.max(1, Math.round(sr * 0.1));
	const level = (a: number, b: number): number => {
		let s = 0;
		for (const c of ch) for (let i = a; i < b; i++) s += c[i]! * c[i]!;
		return s / Math.max(1, (b - a) * ch.length);
	};
	const head = level(0, w);
	const tail = level(n - w, n);
	const all = level(0, n);
	if (!(head > 0) || !(tail > 0) || !(all > 0)) return false;
	if (Math.abs(dbPow(head) - dbPow(tail)) > 3) return false;
	if (dbPow(head) < dbPow(all) - 10 || dbPow(tail) < dbPow(all) - 10) return false;
	// no click at the wrap: the jump from the last sample to the first is within 4× the RMS step size
	for (const c of ch) {
		let s = 0;
		let m = 0;
		for (let i = 1; i < w; i++) {
			const a = c[i]! - c[i - 1]!;
			const b = c[n - w + i]! - c[n - w + i - 1]!;
			s += a * a + b * b;
			m += 2;
		}
		const step = Math.sqrt(s / Math.max(1, m));
		if (Math.abs(c[0]! - c[n - 1]!) > Math.max(4 * step, 1e-4)) return false;
	}
	return true;
}

// ── floor and DC ────────────────────────────────────────────────────────────────────────────────────────────────

/** Window of the floor measurement (20 ms) and the percentile taken (10th). */
const FLOOR_WINDOW_SEC = 0.02;
const FLOOR_PERCENTILE = 0.1;
/** Fewer windows than this (0.2 s) give no floor. */
const FLOOR_MIN_WINDOWS = 10;
/** The floor must be this far under the loudest window, else the sound fills the file and has no floor (dB). */
const FLOOR_MIN_CONTRAST_DB = 12;

/**
 * Noise floor between events (dBFS; `SoundDescriptors.floorDb`): the 10th percentile of non-overlapping 20 ms windows
 * of the mean power over channels. Pure; never throws (non-finite samples must already be sanitised).
 */
function floorOf(ch: readonly Float32Array[], n: number, sr: number): number | null {
	if (ch.length === 0) return null;
	const w = Math.max(1, Math.round(sr * FLOOR_WINDOW_SEC));
	const k = Math.floor(n / w);
	if (k < FLOOR_MIN_WINDOWS) return null;
	const pw = new Float64Array(k);
	for (const c of ch)
		for (let j = 0; j < k; j++) {
			let s = 0;
			const end = (j + 1) * w;
			for (let i = j * w; i < end; i++) {
				const x = c[i]!;
				s += x * x;
			}
			pw[j] += s;
		}
	const norm = 1 / (w * ch.length);
	for (let j = 0; j < k; j++) pw[j] *= norm;
	const sorted = Float64Array.from(pw).sort();
	const max = sorted[k - 1]!;
	if (!(max > 0)) return null;
	const p = sorted[Math.floor(FLOOR_PERCENTILE * (k - 1))]!;
	if (!(p > 0)) return DESCRIPTOR_FLOOR_DB;
	const db = dbPow(p);
	if (dbPow(max) - db < FLOOR_MIN_CONTRAST_DB) return null;
	return qDb(Math.max(DESCRIPTOR_FLOOR_DB, Math.min(DESCRIPTOR_CEILING_DB, db)));
}

/** DC offset (dBFS; `SoundDescriptors.dcDb`): the largest |mean| over channels; null when every mean is 0. */
function dcOf(ch: readonly Float32Array[], n: number): number | null {
	if (n === 0) return null;
	let worst = 0;
	for (const c of ch) {
		let s = 0;
		for (let i = 0; i < n; i++) s += c[i]!;
		worst = Math.max(worst, Math.abs(s / n));
	}
	if (!(worst > 0) || !Number.isFinite(worst)) return null;
	const db = 20 * Math.log10(worst);
	return db < DESCRIPTOR_FLOOR_DB ? null : qDb(Math.min(DESCRIPTOR_CEILING_DB, db));
}

/** Input checked and sanitised like {@link analyzeSound} does (shared with takes.ts). */
export type PreparedSound = { channels: Float32Array[]; frames: number; totalFrames: number; sampleRate: number };

/**
 * Validates and sanitises analysis input exactly like {@link analyzeSound} (throws `SoundAnalysisError` for invalid
 * arguments; non-finite samples → 0; at most `MAX_ANALYSIS_SECONDS`).
 */
export function prepareSound(channels: Float32Array[], sampleRate: number): PreparedSound {
	const pr = prepare(channels, sampleRate);
	return { channels: pr.ch, frames: pr.n, totalFrames: pr.total, sampleRate: pr.sr };
}

/** The recording's noise floor between events ({@link SoundDescriptors.floorDb}) of prepared input. */
export function soundFloorDb(p: PreparedSound): number | null {
	return floorOf(p.channels, p.frames, p.sampleRate);
}

/**
 * Onset positions (samples, ascending) of prepared input over at most `maxSec` of its active span: the detector behind
 * `onsetCount`, each within about one 10 ms hop of its attack. Empty for silence.
 */
export function soundOnsets(p: PreparedSound, maxSec = MAX_ANALYSIS_SECONDS): number[] {
	const pr: Prepared = { ch: p.channels, n: p.frames, total: p.totalFrames, sr: p.sampleRate };
	if (pr.ch.length === 0 || pr.n === 0) return [];
	const env = envelope(pr);
	if (!(env.max > 0)) return [];
	const span = activeSpan(env, pr.n);
	return onsetPositions(pr, span.s0, span.s1, maxSec);
}

/** The first run of maximal envelope windows [a, b] and the active span (samples within 60 dB of the peak). */
function activeSpan(env: Envelope, n: number): { a: number; b: number; jFirst: number; jLast: number; s0: number; s1: number } {
	const len = env.p.length;
	const rel = (j: number): number => dbPow(env.p[j]! / env.max);
	const tie = env.max * (1 - 1e-9);
	let a = 0;
	while (a < len && env.p[a]! < tie) a++;
	let b = a;
	while (b + 1 < len && env.p[b + 1]! >= tie) b++;
	let jLast = len - 1;
	while (jLast > b && rel(jLast) < -60) jLast--;
	let jFirst = 0;
	while (jFirst < a && rel(jFirst) < -60) jFirst++;
	const s0 = Math.max(0, (jFirst - ENV_BLOCKS + 1) * env.hop);
	const s1 = Math.min(n, (jLast + 1) * env.hop);
	return { a, b, jFirst, jLast, s0, s1 };
}

// ── entry point ─────────────────────────────────────────────────────────────────────────────────────────────────

function silentResult(durationSec: number): SoundDescriptors {
	return {
		durationSec: qSec(durationSec),
		peakSec: 0,
		onsetSec: 0,
		riseMs: 0,
		decayMs: 0,
		decays: false,
		tailSec: 0,
		centroidHz: 0,
		rolloff85Hz: 0,
		rolloff95Hz: null,
		below150Share: 0,
		above6kShare: 0,
		flatness: 0,
		octaveBandsDb: OCTAVE_BAND_CENTRES_HZ.map(() => DESCRIPTOR_FLOOR_DB),
		pitchMidi: null,
		pitchConfidence: 0,
		onsetCount: 0,
		integratedLufs: null,
		maxMomentaryLufs: null,
		truePeakDb: null,
		stereoWidth: 0,
		headQuietSec: Math.floor(finite(durationSec) * 10_000) / 10_000,
		loopable: false,
		floorDb: null,
		dcDb: null,
	};
}

/**
 * Measure a sound. `channels` are planar samples (any count up to {@link MAX_SOUND_CHANNELS}, lengths may differ:
 * shorter ones are padded with silence), `sampleRate` in Hz. Throws {@link SoundAnalysisError} only for invalid
 * arguments; non-finite samples are treated as 0.
 */
export function analyzeSound(channels: Float32Array[], sampleRate: number): SoundDescriptors {
	const pr = prepare(channels, sampleRate);
	const { ch, n, total, sr } = pr;
	const durationSec = total / sr;
	if (ch.length === 0 || n === 0) return silentResult(durationSec);
	const env = envelope(pr);
	if (!(env.max > 0)) return silentResult(durationSec);
	const len = env.p.length;
	const rel = (j: number): number => dbPow(env.p[j]! / env.max);

	// peak: centre of the first run of maximal windows; active span: first … last point within 60 dB of the peak
	const { a, b, jLast, s0, s1 } = activeSpan(env, n);
	const peakSec = (env.time(a) + env.time(b)) / 2;

	// onset: first point within 30 dB of the peak
	let jOn = 0;
	while (jOn < a && rel(jOn) < -30) jOn++;
	const onsetSec = jOn > 0 ? crossing(env, jOn - 1, jOn, -30) : env.time(0);

	// rise 10 → 90 % amplitude (−20 dB → −0.915 dB) of a reference level: the loudest 10 ms (20 points) of the
	// envelope, so a fluctuating sustain (noise) does not move the 90 % point to its loudest 2 ms instant. t90 is the
	// first point reaching it, t10 the last point before t90 under −20 dB of it.
	const ref = smoothedMax(env.p, RISE_REF_POINTS);
	const relRef = (k: number): number => dbPow(env.p[k]! / ref);
	const thr90 = 20 * Math.log10(0.9);
	let j = 0;
	while (j < len - 1 && relRef(j) < thr90) j++;
	const t90 = j > 0 ? crossingRef(env, ref, j - 1, j, thr90) : env.time(0);
	while (j > 0 && relRef(j - 1) >= -20) j--;
	const t10 = j > 0 ? crossingRef(env, ref, j - 1, j, -20) : env.time(0);
	const riseMs = Math.max(0, (t90 - t10) * 1000);

	// decay: peak → −20 dB
	let jd = b;
	while (jd < len && rel(jd) > -20) jd++;
	const decays = jd < len;
	const decayEnd = decays ? crossing(env, jd - 1, jd, -20) : durationSec;
	const decayMs = Math.max(0, (Math.min(decayEnd, durationSec) - peakSec) * 1000);

	// tail: the last point within 60 dB of the peak
	const tailEnd = jLast + 1 < len ? crossing(env, jLast, jLast + 1, -60) : env.time(jLast);
	const tailSec = Math.max(0, tailEnd - peakSec);

	// head below −40 dB of the sample peak (sample-exact)
	let samplePeak = 0;
	for (const c of ch)
		for (let i = 0; i < n; i++) {
			const v = Math.abs(c[i]!);
			if (v > samplePeak) samplePeak = v;
		}
	const quietThr = samplePeak * 0.01;
	let head = n;
	for (const c of ch) {
		for (let i = 0; i < head; i++)
			if (Math.abs(c[i]!) >= quietThr) {
				head = i;
				break;
			}
	}
	const headQuietSec = Math.floor((head / sr) * 10_000) / 10_000;

	// stereo width over the active span
	let stereoWidth = 0;
	if (ch.length >= 2) {
		const l = ch[0]!;
		const r = ch[1]!;
		let em = 0;
		let es = 0;
		for (let i = s0; i < s1; i++) {
			const m = (l[i]! + r[i]!) / 2;
			const s = (l[i]! - r[i]!) / 2;
			em += m * m;
			es += s * s;
		}
		stereoWidth = em + es > 0 ? es / (em + es) : 0;
	}

	const spec = spectral(pr, s0, s1);
	const p = pitch(pr, s0, s1, env);
	const loud = loudness(pr);

	return {
		durationSec: qSec(durationSec),
		peakSec: qSec(peakSec),
		onsetSec: qSec(onsetSec),
		riseMs: qMs(riseMs),
		decayMs: qMs(decayMs),
		decays,
		tailSec: qSec(tailSec),
		centroidHz: qHz(Math.min(sr / 2, spec.centroidHz)),
		rolloff85Hz: qHz(Math.min(sr / 2, spec.rolloff85Hz)),
		rolloff95Hz: sr >= AIR_MIN_SAMPLE_RATE ? qHz(Math.min(sr / 2, spec.rolloff95Hz)) : null,
		below150Share: qUnit(spec.below150Share),
		above6kShare: qUnit(spec.above6kShare),
		flatness: qUnit(spec.flatness),
		octaveBandsDb: spec.octaveBandsDb.map((v) =>
			qDb(Math.max(DESCRIPTOR_FLOOR_DB, finite(v, DESCRIPTOR_FLOOR_DB))),
		),
		pitchMidi: p.midi === null || !Number.isFinite(p.midi) ? null : quant(p.midi, 100),
		pitchConfidence: qUnit(p.confidence),
		onsetCount: onsetCount(pr, s0, s1),
		integratedLufs: qDbOrNull(loud.integrated),
		maxMomentaryLufs: qDbOrNull(loud.maxMomentary),
		truePeakDb: qDbOrNull(loud.truePeak),
		stereoWidth: qUnit(stereoWidth),
		headQuietSec,
		loopable: isLoopable(pr, headQuietSec),
		floorDb: floorOf(ch, n, sr),
		dcDb: dcOf(ch, n),
	};
}
