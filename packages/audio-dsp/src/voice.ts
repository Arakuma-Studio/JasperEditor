// Voice analysis frames (spec 14 TC-001 / TC-002, docs/wp-notes/transcript-cleanup.md "Voice analysis"): 10 ms
// frames of 16 kHz mono audio with
//   level    RMS level in dBFS over a 25 ms window centred on the frame (samples [k·160 − 120, k·160 + 280));
//   voicing  the normalised autocorrelation peak over pitch lags 70–400 Hz (lags 40…227 samples) of the
//            mean-removed window: max r(l) / r(0) — high for voiced speech, low for breaths, hiss and silence;
//   flatness the spectral flatness (geometric / arithmetic mean of the power spectrum) of the Hann-windowed window
//            over 300 Hz–6 kHz (512-point bins 9…191): near 1 for noise (breaths), low for tonal sound;
// quantised to one byte each, and the frame classes speech / breath-like / silence. The definitions port the
// research prototype that reproduced the user's cuts (`.prproj-analysis/research/edits/mac/feats.py`,
// `common.py frame_classes`; FINDINGS §6.1), except that windows are centred on their frame (the prototype started
// them at the frame: its frames sit 7.5 ms later).
//
// The noise floor / speech level / threshold rule is shared with the speech worker's energy VAD
// (`apps/engine/src/speech/core/vad.ts` `vadThreshold`, TC-002): `levelStats` + `speechThresholdDb`.
//
// Pure and deterministic; `VoiceFeatureExtractor.compute` works on any block of samples (with the samples around it),
// so the engine can split a long file over worker threads and get the same bytes as one pass.
import { Fft } from './fft.ts';

/** Analysis sample rate (Hz). */
export const VOICE_SAMPLE_RATE = 16_000;
/** Frame step: 10 ms. */
export const VOICE_HOP = 160;
/** Level / feature window: 25 ms. */
export const VOICE_WINDOW = 400;
/** Samples of the window before the frame's first sample (the window is centred on the frame). */
export const VOICE_WINDOW_LEAD = (VOICE_WINDOW - VOICE_HOP) / 2;
/** Samples of the window after the frame's first sample. */
export const VOICE_WINDOW_TAIL = VOICE_WINDOW - VOICE_WINDOW_LEAD;
/** Frames below this level are digital silence: they never count towards the floor or speech level. */
export const DIGITAL_SILENCE_DB = -100;

/** Byte quantisation of the level: dB = MIN + q × STEP, q 0…255 (−120 … +7.5 dBFS in 0.5 dB steps). */
export const VOICE_LEVEL_MIN_DB = -120;
export const VOICE_LEVEL_STEP_DB = 0.5;

/** Frame classes. */
export const VOICE_CLASS_SILENCE = 0;
export const VOICE_CLASS_BREATH = 1;
export const VOICE_CLASS_SPEECH = 2;

/** Classification constants (TC-001; the prototype's values where the spec leaves them open). */
export const VOICE_CLASS_RULES = {
	/** Speech needs at least this voicing unless it is `loudAboveDb` over the threshold (prototype 0.45). */
	voicedMin: 0.45,
	/** dB over the speech threshold from which a frame is speech whatever its voicing. */
	loudAboveDb: 10,
	/** Breath-like: dB over the noise floor. */
	breathAboveFloorDb: 5,
	/** Breath-like: voicing below this. */
	breathVoicingMax: 0.5,
	/** Breath-like: spectral flatness above this. */
	breathFlatnessMin: 0.15,
	/** Breath-like runs last 120–900 ms; shorter and longer ones are silence. */
	breathMinFrames: 12,
	breathMaxFrames: 90,
	/** Gaps shorter than this (frames) inside speech are closed (prototype: < 60 ms). */
	speechHoleFrames: 6,
	/** Speech runs shorter than this (frames) are dropped (prototype: < 40 ms). */
	speechBlipFrames: 4,
	/** Gaps shorter than this (frames) inside breath-like runs are closed (prototype: < 30 ms). */
	breathHoleFrames: 3,
} as const;

/** Frames of `samples` samples (the last frame may be partial). */
export function voiceFrameCount(samples: number): number {
	return samples > 0 ? Math.ceil(samples / VOICE_HOP) : 0;
}

export function quantiseVoiceLevel(db: number): number {
	if (!(db > VOICE_LEVEL_MIN_DB)) return 0;
	const q = Math.round((db - VOICE_LEVEL_MIN_DB) / VOICE_LEVEL_STEP_DB);
	return q > 255 ? 255 : q;
}

export function voiceLevelDb(q: number): number {
	return VOICE_LEVEL_MIN_DB + q * VOICE_LEVEL_STEP_DB;
}

/** 0…1 → 0…255 (NaN and negatives → 0). */
export function quantiseUnit(x: number): number {
	if (!(x > 0)) return 0;
	const q = Math.round(x * 255);
	return q > 255 ? 255 : q;
}

export function unitOf(q: number): number {
	return q / 255;
}

export type LevelStats = {
	/** Noise floor: 10th percentile of the levels above digital silence. */
	floorDb: number;
	/** Speech level: 95th percentile. */
	speechDb: number;
	/** Frames above digital silence. */
	frames: number;
};

/**
 * Noise floor and speech level of `db[from, to)` (frames above −100 dBFS; lower nearest-rank percentiles), or null
 * when every frame is digital silence. Shared by the speech worker's VAD and the voice analysis (TC-002).
 */
export function levelStats(db: ArrayLike<number>, from = 0, to = db.length): LevelStats | null {
	// digital silence (< −100 dBFS) would drag the floor far below the recording's own noise
	const s: number[] = [];
	for (let i = Math.max(0, from); i < Math.min(to, db.length); i++)
		if (db[i]! > DIGITAL_SILENCE_DB) s.push(db[i]!);
	if (!s.length) return null;
	s.sort((a, b) => a - b);
	const q = (p: number) => s[Math.floor((s.length - 1) * p)]!;
	return { floorDb: q(0.1), speechDb: q(0.95), frames: s.length };
}

/** The speech/silence threshold: 30 % of the way from the floor to the speech level, at least 6 dB over the floor. */
export function speechThresholdDb(floorDb: number, speechDb: number): number {
	return Math.max(floorDb + 0.3 * (speechDb - floorDb), floorDb + 6);
}

/** Byte planes of frames (see the module docs). */
export type VoiceFeaturePlanes = { level: Uint8Array; voicing: Uint8Array; flatness: Uint8Array };

const NFFT = 1024;
const LAG_MIN = VOICE_SAMPLE_RATE / 400; // 40
const LAG_END = Math.floor(VOICE_SAMPLE_RATE / 70); // 228 (exclusive)
// 512-point spectrum bins 300 Hz … 6 kHz (int(300·512/16000) = 9, int(6000·512/16000) = 192, exclusive); they are the
// even bins of the 1024-point transform of the same (zero-padded) window.
const FLAT_K0 = Math.floor((300 * 512) / VOICE_SAMPLE_RATE);
const FLAT_K1 = Math.floor((6000 * 512) / VOICE_SAMPLE_RATE);

/**
 * Computes the feature planes of frames. One instance per thread (it owns its FFT buffers); `compute` has no other
 * state, so any split of a file into blocks gives the same bytes.
 */
export class VoiceFeatureExtractor {
	private readonly fft = new Fft(NFFT);
	private readonly re = new Float64Array(NFFT);
	private readonly im = new Float64Array(NFFT);
	private readonly acRe = new Float64Array(NFFT);
	private readonly acIm = new Float64Array(NFFT);
	private readonly hann = new Float64Array(VOICE_WINDOW);
	private readonly x = new Float64Array(VOICE_WINDOW);

	constructor() {
		// numpy.hanning (symmetric)
		for (let n = 0; n < VOICE_WINDOW; n++)
			this.hann[n] = 0.5 - 0.5 * Math.cos((2 * Math.PI * n) / (VOICE_WINDOW - 1));
	}

	/**
	 * Features of frames `[firstFrame, firstFrame + count)` into `out` at `outOffset`. `signal` holds samples
	 * `[signalStart, signalStart + signal.length)` of the stream; samples outside it count as zero (the file's edges),
	 * so pass the `VOICE_WINDOW_LEAD` samples before and `VOICE_WINDOW_TAIL` after the frames where they exist.
	 */
	compute(
		signal: Float32Array,
		signalStart: number,
		firstFrame: number,
		count: number,
		out: VoiceFeaturePlanes,
		outOffset = 0,
	): void {
		if (!Number.isSafeInteger(firstFrame) || !Number.isSafeInteger(count) || count < 0)
			throw new RangeError('compute: firstFrame and count must be non-negative integers');
		if (outOffset < 0 || outOffset + count > out.level.length)
			throw new RangeError('compute: output planes too short');
		// frames are processed in pairs: one inverse transform gives both autocorrelations
		let pendingSlot = -1;
		for (let i = 0; i < count; i++) {
			const slot = outOffset + i;
			this.forward(signal, signalStart, firstFrame + i, out, slot, pendingSlot < 0 ? this.acRe : this.acIm);
			if (pendingSlot < 0) {
				pendingSlot = slot;
				if (i === count - 1) {
					this.acIm.fill(0);
					this.inverse(out, pendingSlot, -1);
				}
			} else {
				this.inverse(out, pendingSlot, slot);
				pendingSlot = -1;
			}
		}
	}

	/** Level and flatness of one frame; its power spectrum for the autocorrelation goes to `power`. */
	private forward(
		signal: Float32Array,
		signalStart: number,
		frame: number,
		out: VoiceFeaturePlanes,
		slot: number,
		power: Float64Array,
	): void {
		const { re, im, x, hann } = this;
		const a = frame * VOICE_HOP - VOICE_WINDOW_LEAD - signalStart;
		let sum = 0;
		let energy = 0;
		for (let n = 0; n < VOICE_WINDOW; n++) {
			const j = a + n;
			const v = j >= 0 && j < signal.length ? signal[j]! : 0;
			// a non-finite decoder sample would poison every feature of the frame
			const s = Number.isFinite(v) ? v : 0;
			x[n] = s;
			sum += s;
			energy += s * s;
		}
		out.level[slot] = quantiseVoiceLevel(10 * Math.log10(energy / VOICE_WINDOW + 1e-12));
		const mean = sum / VOICE_WINDOW;
		// two real transforms in one complex FFT: windowed (flatness) in re, mean-removed (autocorrelation) in im
		for (let n = 0; n < VOICE_WINDOW; n++) {
			re[n] = hann[n]! * x[n]!;
			im[n] = x[n]! - mean;
		}
		re.fill(0, VOICE_WINDOW);
		im.fill(0, VOICE_WINDOW);
		this.fft.forward(re, im);
		// Z = A + iB (A, B the spectra of the two real inputs): A[k] = (Z[k] + conj Z[N−k]) / 2,
		// B[k] = (Z[k] − conj Z[N−k]) / 2i.
		for (let k = 0; k <= NFFT / 2; k++) {
			const nk = (NFFT - k) & (NFFT - 1);
			const br = (im[k]! + im[nk]!) / 2;
			const bi = (re[nk]! - re[k]!) / 2;
			const p = br * br + bi * bi;
			power[k] = p;
			if (k > 0 && k < NFFT / 2) power[NFFT - k] = p;
		}
		let logSum = 0;
		let lin = 0;
		for (let j = FLAT_K0; j < FLAT_K1; j++) {
			const k = 2 * j;
			const nk = NFFT - k;
			const ar = (re[k]! + re[nk]!) / 2;
			const ai = (im[k]! - im[nk]!) / 2;
			const p = ar * ar + ai * ai + 1e-12;
			logSum += Math.log(p);
			lin += p;
		}
		const nb = FLAT_K1 - FLAT_K0;
		out.flatness[slot] = quantiseUnit(Math.exp(logSum / nb) / (lin / nb));
	}

	/**
	 * Autocorrelations of the frame(s) whose power spectra are in acRe (and acIm): the inverse transform of
	 * P1 + iP2 is r1 + i·r2 (both real and even). `slotB` < 0: only acRe holds a frame.
	 */
	private inverse(out: VoiceFeaturePlanes, slotA: number, slotB: number): void {
		const { acRe, acIm } = this;
		this.fft.inverse(acRe, acIm);
		out.voicing[slotA] = quantiseUnit(voicingOf(acRe));
		if (slotB >= 0) out.voicing[slotB] = quantiseUnit(voicingOf(acIm));
	}
}

/** max r(l) over the pitch lags / r(0), from an unscaled inverse transform (the 1/N scale is applied here). */
function voicingOf(r: Float64Array): number {
	let best = Number.NEGATIVE_INFINITY;
	for (let l = LAG_MIN; l < LAG_END; l++) if (r[l]! > best) best = r[l]!;
	return best / NFFT / (r[0]! / NFFT + 1e-9);
}

/** Feature planes of a whole signal in one pass (tests, short media). */
export function voiceFeatures(signal: Float32Array): VoiceFeaturePlanes {
	const n = voiceFrameCount(signal.length);
	const out: VoiceFeaturePlanes = {
		level: new Uint8Array(n),
		voicing: new Uint8Array(n),
		flatness: new Uint8Array(n),
	};
	new VoiceFeatureExtractor().compute(signal, 0, 0, n, out);
	return out;
}

export type VoiceLevels = {
	floorDb: number;
	speechDb: number;
	speechThresholdDb: number;
	/** Breath-like frames are above this (floor + 5 dB). */
	breathFloorDb: number;
	/** Frames above digital silence. */
	frames: number;
};

/** Floor, speech level and thresholds of quantised levels `[from, to)`, or null when all is digital silence. */
export function voiceLevels(level: Uint8Array, from = 0, to = level.length): VoiceLevels | null {
	const db = new Float32Array(Math.max(0, Math.min(to, level.length) - Math.max(0, from)));
	for (let i = 0; i < db.length; i++) db[i] = voiceLevelDb(level[from + i]!);
	const s = levelStats(db);
	if (!s) return null;
	return {
		floorDb: s.floorDb,
		speechDb: s.speechDb,
		speechThresholdDb: speechThresholdDb(s.floorDb, s.speechDb),
		breathFloorDb: s.floorDb + VOICE_CLASS_RULES.breathAboveFloorDb,
		frames: s.frames,
	};
}

/** Closes false runs shorter than `n` between true frames (not at the edges). In place. */
function closeRuns(mask: Uint8Array, n: number): void {
	let i = 0;
	const len = mask.length;
	while (i < len) {
		if (mask[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < len && !mask[j]) j++;
		if (i > 0 && j < len && j - i < n) mask.fill(1, i, j);
		i = j;
	}
}

/** Drops true runs shorter than `n`. In place. */
function openRuns(mask: Uint8Array, n: number): void {
	let i = 0;
	const len = mask.length;
	while (i < len) {
		if (!mask[i]) {
			i++;
			continue;
		}
		let j = i;
		while (j < len && mask[j]) j++;
		if (j - i < n) mask.fill(0, i, j);
		i = j;
	}
}

/**
 * Frame classes (TC-001) of quantised planes, against the levels of the whole file:
 * - speech: level > threshold (`speechThresholdDb`) and voiced (≥ 0.45), or ≥ 10 dB above the threshold; gaps under
 *   60 ms inside speech are closed, then speech runs under 40 ms dropped;
 * - breath-like: not speech, level > floor + 5 dB, voicing < 0.5, flatness > 0.15; gaps under 30 ms closed; only runs
 *   of 120–900 ms stay breath-like;
 * - silence: the rest (everything when the file is digital silence).
 */
export function classifyVoiceFrames(planes: VoiceFeaturePlanes): {
	classes: Uint8Array;
	levels: VoiceLevels | null;
} {
	const n = planes.level.length;
	if (planes.voicing.length !== n || planes.flatness.length !== n)
		throw new RangeError('classifyVoiceFrames: planes differ in length');
	const classes = new Uint8Array(n);
	const levels = voiceLevels(planes.level);
	if (!levels) return { classes, levels: null };
	const R = VOICE_CLASS_RULES;
	const sp = new Uint8Array(n);
	const br = new Uint8Array(n);
	for (let i = 0; i < n; i++) {
		const db = voiceLevelDb(planes.level[i]!);
		const v = unitOf(planes.voicing[i]!);
		if (db > levels.speechThresholdDb && (v >= R.voicedMin || db >= levels.speechThresholdDb + R.loudAboveDb))
			sp[i] = 1;
	}
	closeRuns(sp, R.speechHoleFrames);
	openRuns(sp, R.speechBlipFrames);
	for (let i = 0; i < n; i++) {
		if (sp[i]) continue;
		const db = voiceLevelDb(planes.level[i]!);
		if (
			db > levels.breathFloorDb &&
			unitOf(planes.voicing[i]!) < R.breathVoicingMax &&
			unitOf(planes.flatness[i]!) > R.breathFlatnessMin
		)
			br[i] = 1;
	}
	closeRuns(br, R.breathHoleFrames);
	for (let i = 0; i < n; i++) classes[i] = sp[i] ? VOICE_CLASS_SPEECH : br[i] ? VOICE_CLASS_BREATH : 0;
	// breath-like runs outside 120–900 ms are silence
	let i = 0;
	while (i < n) {
		if (classes[i] !== VOICE_CLASS_BREATH) {
			i++;
			continue;
		}
		let j = i;
		while (j < n && classes[j] === VOICE_CLASS_BREATH) j++;
		if (j - i < R.breathMinFrames || j - i > R.breathMaxFrames) classes.fill(VOICE_CLASS_SILENCE, i, j);
		i = j;
	}
	return { classes, levels };
}
