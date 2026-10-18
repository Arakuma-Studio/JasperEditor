// Ambience and room-tone beds (spec 12 §4 P6-E12; wp-note "Phase 6 → WP-E8"): where to loop a bed recording and how
// well a room tone matches a dialogue's noise floor. Pure and deterministic; every function takes mono samples at one
// rate and never throws for any argument (hostile input gives null / a neutral result).
//
//   findCleanWindow     the CLEAN WINDOW of a recording: the stretch with the lowest onset activity and level variance,
//                       with no spike (a 100 ms frame ≥ 10 dB over the median of its 1 s neighbourhood) and no digital
//                       silence. Candidate lengths from 60 s down to 3 s slide in 0.2 s steps; each is scored
//                       `levelStdDb + 4 dB · onsets per second`; the longest length whose best window scores within
//                       1 dB of the best of all lengths wins (fewer loop joints). Adapted from earshot
//                       (`skills/real-sound/scripts/analyze.py` spikes and `level_std_db_100ms`; `references/
//                       sound-design.md` "one bed per location, from clean windows"; MIT, licenses/ported/earshot.md).
//   findLoopPoints      the LOOP POINTS inside a window for an equal-power crossfade of X seconds: loop-in a near the
//                       window's start and loop-out b near its end, b − a a whole number of timeline frames, chosen
//                       so the head [a, a + X] and the tail [b − X, b] that the crossfade blends match — the same level
//                       (dB), the same octave-band shape (dB) and a crossfade that keeps the level (an equal-power fade
//                       of two signals with correlation ρ changes the power at its midpoint by 10·log10(1 + ρ) dB).
//                       Cost = |ΔL| + 0.5 · spectral distance + |midpoint change|, searched over a and b in 50 ms /
//                       one-frame steps within 1 s of the window's edges. The
//                       crossfade law follows ρ (`crossfadeLaw`): equal power, or equal gain for a head and tail that
//                       repeat in phase (ρ > 0.41: a hum).
//   quietestStretch     the quietest 0.5–3 s of a recording outside given (speech) ranges: the room tone a dialogue
//                       clip carries (spec: "the quietest 0.5–3 s stretch without speech in the dialogue's own media").
//   noiseFloorProfile   level and octave bands of the quietest 20 % of 100 ms frames outside speech: the dialogue's
//                       noise floor a room tone should match.
//   spectralDistanceDb  how far two octave-band spectra differ in SHAPE (dB): the mean absolute deviation of their
//                       band-by-band difference from its median, over the bands within 40 dB of the reference's loudest.
import { Fft } from '../core/fft.ts';
import { hann } from '../core/stft.ts';
import { BAND_FLOOR_DB, OCTAVE_BAND_CENTRES_HZ } from './bands.ts';

/** Clean-window search (spec 12 P6-E12; numbers marked earshot are adapted from `analyze.py`, the rest are ours). */
export const LOOP_WINDOW = {
	/** Level frames (s): earshot's 100 ms RMS for spikes and level variance. */
	levelFrameSec: 0.1,
	/** A spike: a frame this far over the median of its neighbourhood (dB; spec 12, earshot uses 12 dB). */
	spikeDb: 10,
	/** The neighbourhood a spike is judged against (s, centred). */
	neighbourhoodSec: 1,
	/** Onsets: 20 ms frames rising this far over the median of the 200 ms before (dB), 100 ms apart at least. */
	onsetFrameSec: 0.02,
	onsetRiseDb: 6,
	onsetLookbackSec: 0.2,
	onsetRefractorySec: 0.1,
	/** Onsets quieter than this (dBFS) are noise, not events. */
	onsetFloorDb: -70,
	/** A frame under this (dBFS) is digital silence: never inside a clean window. */
	silenceDb: -90,
	/** Window lengths (s): tried from the longest down; a recording shorter than the shortest is its own window. */
	lengthsSec: [60, 45, 30, 20, 15, 10, 8, 6, 4, 3] as readonly number[],
	minWindowSec: 3,
	/** Sliding step of the window search (s). */
	stepSec: 0.2,
	/** Score of one onset per second (dB of level standard deviation). */
	onsetCostDb: 4,
	/** A longer window is preferred while its best score is within this of the best of every length (dB). */
	longerToleranceDb: 1,
	/** Longest stretch analysed (s); the window lies in it. */
	maxSeconds: 1800,
} as const;

/** Loop-point search (spec 12 P6-E12: "looped with equal-power crossfades (≥ 1.5 s)"). */
export const LOOP_CROSSFADE = {
	/** The bed's loop crossfade (s; spec ≥ 1.5 s; earshot `mix.py` uses 1.5 s). */
	defaultSec: 1.5,
	/** How far from the window's edges the loop points may move (s). */
	searchSec: 1,
	/** Step of the loop-in search (s); the loop-out moves in whole timeline frames. */
	stepSec: 0.05,
	/** Weight of the spectral distance in the cost. */
	spectralWeight: 0.5,
} as const;

/** Room-tone search (spec 12 P6-E12 room tone). */
export const ROOM_TONE_STRETCH = {
	minSec: 0.5,
	maxSec: 3,
	/** Share of the quietest 100 ms frames that make the noise-floor profile. */
	floorQuantile: 0.2,
	/** Bands more than this under the reference's loudest band do not count in the spectral distance (dB). */
	distanceRangeDb: 40,
} as const;

export type CleanWindow = {
	startSec: number;
	endSec: number;
	/** Mean level of the window (dBFS, energy mean of its 100 ms frames). */
	levelDb: number;
	/** Standard deviation of its 100 ms levels (dB). */
	levelStdDb: number;
	onsets: number;
	onsetsPerMin: number;
	/** Spikes inside the window (0 for a clean window). */
	spikes: number;
	score: number;
	/** No window without a spike exists: this is the least bad one (spikes counted). */
	clean: boolean;
	/** The recording is shorter than the shortest window length: the whole recording. */
	whole: boolean;
	/** Seconds analysed. */
	analysedSec: number;
};

export type LoopPoints = {
	inSec: number;
	outSec: number;
	crossfadeSec: number;
	/** Level of the tail minus the head (dB). */
	levelDiffDb: number;
	spectralDistanceDb: number;
	/** The crossfade law (`crossfadeLaw`): equal power, or equal gain for material that repeats in phase. */
	fade: 'equal-power' | 'equal-gain';
	/** Zero-lag correlation of the head and the tail. */
	correlation: number;
	/** Power change at the crossfade's midpoint with that law (dB). */
	midpointDb: number;
	cost: number;
};

export type NoiseFloor = { levelDb: number; bandsDb: number[]; seconds: number };

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const validRate = (sr: unknown): sr is number => fin(sr) && sr >= 1000 && sr <= 768_000;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
const r2 = (x: number) => Math.round(x * 100) / 100;
const db = (p: number) => (p > 0 ? 10 * Math.log10(p) : Number.NEGATIVE_INFINITY);
const dbFloor = (p: number) => Math.max(-200, db(p + 1e-20));

function usable(x: unknown, sr: unknown): x is Float32Array {
	return x instanceof Float32Array && validRate(sr) && x.length > 0;
}

/** Mean square of `x[a, b)` (non-finite samples as 0). */
function meanSquare(x: Float32Array, a: number, b: number): number {
	let e = 0;
	const lo = Math.max(0, a);
	const hi = Math.min(x.length, b);
	for (let i = lo; i < hi; i++) {
		const v = x[i]!;
		if (v - v === 0) e += v * v;
	}
	return hi > lo ? e / (hi - lo) : 0;
}

/** Levels (dBFS) of consecutive frames of `frameSec` over the first `maxSec`. */
function frameLevels(x: Float32Array, sr: number, frameSec: number, maxSec: number): Float64Array {
	const n = Math.max(1, Math.round(frameSec * sr));
	const len = Math.min(x.length, Math.floor(maxSec * sr));
	const count = Math.floor(len / n);
	const out = new Float64Array(count);
	for (let i = 0; i < count; i++) out[i] = dbFloor(meanSquare(x, i * n, (i + 1) * n));
	return out;
}

function median(values: number[]): number {
	if (!values.length) return Number.NEGATIVE_INFINITY;
	const s = [...values].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Frames that are spikes: ≥ `spikeDb` over the median of their centred neighbourhood. */
function spikeFrames(L: Float64Array, frameSec: number): Uint8Array {
	const half = Math.max(1, Math.round(LOOP_WINDOW.neighbourhoodSec / frameSec / 2));
	const out = new Uint8Array(L.length);
	for (let i = 0; i < L.length; i++) {
		const around: number[] = [];
		for (let j = Math.max(0, i - half); j <= Math.min(L.length - 1, i + half); j++) around.push(L[j]!);
		if (L[i]! >= median(around) + LOOP_WINDOW.spikeDb && L[i]! > LOOP_WINDOW.silenceDb) out[i] = 1;
	}
	return out;
}

/** Onsets per level frame: 20 ms frames rising ≥ 6 dB over the median of the 200 ms before, ≥ 100 ms apart. */
function onsetCounts(x: Float32Array, sr: number, levelFrames: number, maxSec: number): Uint16Array {
	const l = frameLevels(x, sr, LOOP_WINDOW.onsetFrameSec, maxSec);
	const per = Math.round(LOOP_WINDOW.levelFrameSec / LOOP_WINDOW.onsetFrameSec);
	const back = Math.round(LOOP_WINDOW.onsetLookbackSec / LOOP_WINDOW.onsetFrameSec);
	const refractory = Math.round(LOOP_WINDOW.onsetRefractorySec / LOOP_WINDOW.onsetFrameSec);
	const out = new Uint16Array(levelFrames);
	let last = -refractory - 1;
	for (let j = back; j < l.length; j++) {
		if (j - last <= refractory || l[j]! < LOOP_WINDOW.onsetFloorDb) continue;
		const before: number[] = [];
		for (let k = j - back; k < j; k++) before.push(l[k]!);
		if (l[j]! - median(before) >= LOOP_WINDOW.onsetRiseDb) {
			last = j;
			const f = Math.floor(j / per);
			if (f < levelFrames) out[f] = Math.min(65535, out[f]! + 1);
		}
	}
	return out;
}

/**
 * The clean window of a bed recording (mono `x` at `sr`): see the module docs. `opts.maxSec` / `minSec` bound the
 * window length. Null when there is nothing to loop (no audio, under 0.5 s, all digital silence, invalid input).
 */
export function findCleanWindow(
	x: Float32Array,
	sr: number,
	opts: { maxSec?: number; minSec?: number } = {},
): CleanWindow | null {
	if (!usable(x, sr)) return null;
	const fs = LOOP_WINDOW.levelFrameSec;
	const analysedSec = Math.min(x.length / sr, LOOP_WINDOW.maxSeconds);
	const L = frameLevels(x, sr, fs, analysedSec);
	const n = L.length;
	if (n < 5) return null;
	const spikes = spikeFrames(L, fs);
	const onsets = onsetCounts(x, sr, n, analysedSec);
	const silent = new Uint8Array(n);
	let audible = 0;
	for (let i = 0; i < n; i++) {
		if (L[i]! < LOOP_WINDOW.silenceDb) silent[i] = 1;
		else audible++;
	}
	if (audible === 0) return null;
	// prefix sums: levels, squares, energy, onsets, spikes, silence
	const pL = new Float64Array(n + 1);
	const pL2 = new Float64Array(n + 1);
	const pE = new Float64Array(n + 1);
	const pO = new Float64Array(n + 1);
	const pS = new Float64Array(n + 1);
	const pZ = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) {
		const l = Math.max(-120, L[i]!);
		pL[i + 1] = pL[i]! + l;
		pL2[i + 1] = pL2[i]! + l * l;
		pE[i + 1] = pE[i]! + 10 ** (L[i]! / 10);
		pO[i + 1] = pO[i]! + onsets[i]!;
		pS[i + 1] = pS[i]! + spikes[i]!;
		pZ[i + 1] = pZ[i]! + silent[i]!;
	}
	const maxSec = fin(opts.maxSec) && opts.maxSec > 0 ? opts.maxSec : Number.POSITIVE_INFINITY;
	const minSec = fin(opts.minSec) && opts.minSec > 0 ? opts.minSec : LOOP_WINDOW.minWindowSec;
	const total = n * fs;
	const lengths = LOOP_WINDOW.lengthsSec.filter((s) => s <= maxSec && s >= minSec && s <= total + 1e-9);
	const whole = lengths.length === 0;
	const frameCounts = whole ? [n] : lengths.map((s) => Math.round(s / fs));
	const step = Math.max(1, Math.round(LOOP_WINDOW.stepSec / fs));
	type Best = { s: number; w: number; score: number; std: number; on: number; sp: number };
	const bestOf = (allowSpikes: boolean): Best[] => {
		const out: Best[] = [];
		for (const w of frameCounts) {
			let best: Best | null = null;
			const starts: number[] = [];
			for (let s = 0; s + w <= n; s += step) starts.push(s);
			if (starts[starts.length - 1] !== n - w) starts.push(n - w);
			for (const s of starts) {
				if (pZ[s + w]! - pZ[s]! > 0) continue;
				const sp = pS[s + w]! - pS[s]!;
				if (sp > 0 && !allowSpikes) continue;
				const mean = (pL[s + w]! - pL[s]!) / w;
				const std = Math.sqrt(Math.max(0, (pL2[s + w]! - pL2[s]!) / w - mean * mean));
				const on = pO[s + w]! - pO[s]!;
				const score = std + (LOOP_WINDOW.onsetCostDb * on) / (w * fs) + (allowSpikes ? 100 * sp : 0);
				if (!best || score < best.score - 1e-9) best = { s, w, score, std, on, sp };
			}
			if (best) out.push(best);
		}
		return out;
	};
	let cands = bestOf(false);
	const clean = cands.length > 0;
	if (!clean) cands = bestOf(true);
	if (!cands.length) return null;
	const top = Math.min(...cands.map((c) => c.score));
	// candidates are in decreasing length: the first within tolerance is the longest good one
	const pick = cands.find((c) => c.score <= top + LOOP_WINDOW.longerToleranceDb) ?? cands[0]!;
	const e = (pE[pick.s + pick.w]! - pE[pick.s]!) / pick.w;
	return {
		startSec: r3(pick.s * fs),
		endSec: r3((pick.s + pick.w) * fs),
		levelDb: r2(dbFloor(e)),
		levelStdDb: r2(pick.std),
		onsets: pick.on,
		onsetsPerMin: r2((pick.on * 60) / (pick.w * fs)),
		spikes: pick.sp,
		score: r2(pick.score),
		clean,
		whole,
		analysedSec: r3(analysedSec),
	};
}

// ── spectra ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** Per-frame octave-band powers (7 bands, linear) and total power of Hann frames of ≈ 43 ms, half overlap. */
type FrameSpectra = { hop: number; size: number; bands: Float64Array[]; total: Float64Array };

function frameSpectra(x: Float32Array, sr: number, from: number, to: number): FrameSpectra {
	let size = 256;
	while (size < sr * 0.043 && size < 8192) size *= 2;
	const hop = size / 2;
	const fft = new Fft(size);
	const win = hann(size);
	let w2 = 0;
	for (let i = 0; i < size; i++) w2 += win[i]! * win[i]!;
	const scale = 1 / (size * w2);
	const re = new Float64Array(size);
	const im = new Float64Array(size);
	const binHz = sr / size;
	const edges = OCTAVE_BAND_CENTRES_HZ.map((fc) => [fc / Math.SQRT2, fc * Math.SQRT2] as const);
	const lo = Math.max(0, from);
	const hi = Math.min(x.length, to);
	const count = Math.max(0, Math.floor((hi - lo - size) / hop) + 1);
	const bands: Float64Array[] = [];
	const total = new Float64Array(count);
	for (let f = 0; f < count; f++) {
		const s = lo + f * hop;
		for (let i = 0; i < size; i++) {
			const v = x[s + i]!;
			re[i] = (v - v === 0 ? v : 0) * win[i]!;
			im[i] = 0;
		}
		fft.forward(re, im);
		const b = new Float64Array(edges.length);
		let t = 0;
		for (let k = 0; k <= size / 2; k++) {
			const p = (k === 0 || k === size / 2 ? 1 : 2) * scale * (re[k]! * re[k]! + im[k]! * im[k]!);
			t += p;
			const fk = k * binHz;
			for (let j = 0; j < edges.length; j++) if (fk >= edges[j]![0] && fk < edges[j]![1]) b[j] += p;
		}
		bands.push(b);
		total[f] = t;
	}
	return { hop, size, bands, total };
}

/** Octave levels (dB, floored) of the frames whose centre lies in `[a, b)` samples (relative to the analysed start). */
function segmentBands(sp: FrameSpectra, from: number, a: number, b: number): { bands: number[]; level: number } {
	const acc = new Float64Array(OCTAVE_BAND_CENTRES_HZ.length);
	let t = 0;
	let k = 0;
	for (let f = 0; f < sp.total.length; f++) {
		const c = from + f * sp.hop + sp.size / 2;
		if (c < a || c >= b) continue;
		const fb = sp.bands[f]!;
		for (let j = 0; j < acc.length; j++) acc[j] += fb[j]!;
		t += sp.total[f]!;
		k++;
	}
	if (k === 0) return { bands: OCTAVE_BAND_CENTRES_HZ.map(() => BAND_FLOOR_DB), level: BAND_FLOOR_DB };
	return {
		bands: [...acc].map((v) => Math.max(BAND_FLOOR_DB, dbFloor(v / k))),
		level: Math.max(BAND_FLOOR_DB, dbFloor(t / k)),
	};
}

/**
 * How far two octave spectra differ in shape (dB): the mean absolute deviation of `a − b` from its median over the
 * bands within 40 dB of `ref`'s loudest band (`ref` default `a`). 0 for identical shapes at any level; never NaN.
 */
export function spectralDistanceDb(
	a: readonly number[],
	b: readonly number[],
	ref: readonly number[] = a,
): number {
	if (!Array.isArray(a) || !Array.isArray(b) || !Array.isArray(ref)) return 0;
	const n = Math.min(a.length, b.length, ref.length);
	const top = Math.max(...ref.slice(0, n).filter(fin), BAND_FLOOR_DB);
	const diffs: number[] = [];
	for (let i = 0; i < n; i++) {
		const x = a[i];
		const y = b[i];
		const r = ref[i];
		if (!fin(x) || !fin(y) || !fin(r) || r < top - ROOM_TONE_STRETCH.distanceRangeDb) continue;
		diffs.push(x - y);
	}
	if (!diffs.length) return 0;
	const m = median(diffs);
	return r2(diffs.reduce((s, d) => s + Math.abs(d - m), 0) / diffs.length);
}

/**
 * The loop points of a window for an equal-power crossfade of `crossfadeSec` (see the module docs). `frameSec` (the
 * timeline's frame, default 10 ms) makes `outSec − inSec` a whole number of frames. The crossfade is shortened to 40 % of the
 * window when the window is shorter than 2.5 crossfades. Null for invalid input or a window under 3 frames.
 */
export function findLoopPoints(
	x: Float32Array,
	sr: number,
	window: { startSec: number; endSec: number },
	opts: { crossfadeSec?: number; frameSec?: number } = {},
): LoopPoints | null {
	if (!usable(x, sr) || !window || !fin(window.startSec) || !fin(window.endSec)) return null;
	const dur = x.length / sr;
	const ws = Math.max(0, Math.min(dur, window.startSec));
	const we = Math.max(0, Math.min(dur, window.endSec));
	const frame = fin(opts.frameSec) && opts.frameSec >= 0.001 && opts.frameSec < 1 ? opts.frameSec : 0.01;
	if (we - ws < 3 * frame) return null;
	let X = fin(opts.crossfadeSec) && opts.crossfadeSec > 0 ? opts.crossfadeSec : LOOP_CROSSFADE.defaultSec;
	X = Math.min(X, (we - ws) / 2.5);
	// the timeline's crossfade is a whole number of frames
	X = Math.max(frame, Math.floor(X / frame + 1e-9) * frame);
	const S = Math.min(LOOP_CROSSFADE.searchSec, Math.max(0, (we - ws - 2 * X) / 4));
	const Xn = Math.max(1, Math.round(X * sr));
	// spectra of the head and tail regions the search reads
	const headFrom = Math.floor(ws * sr);
	const headTo = Math.ceil((ws + S + X) * sr);
	const tailFrom = Math.floor((we - S - X) * sr);
	const tailTo = Math.ceil(we * sr);
	const headSp = frameSpectra(x, sr, headFrom, headTo);
	const tailSp = frameSpectra(x, sr, tailFrom, tailTo);
	const segment = (sp: FrameSpectra, from: number, t0: number) => {
		const a = Math.round(t0 * sr);
		const r = segmentBands(sp, from, a, a + Xn);
		// too short for a spectral frame: the level from the samples
		return r.level <= BAND_FLOOR_DB ? { ...r, level: Math.max(BAND_FLOOR_DB, dbFloor(meanSquare(x, a, a + Xn))) } : r;
	};
	const corr = (a0: number, b0: number): number => {
		let ab = 0;
		let aa = 0;
		let bb = 0;
		for (let i = 0; i < Xn; i++) {
			const u = x[a0 + i] ?? 0;
			const v = x[b0 + i] ?? 0;
			const uu = u - u === 0 ? u : 0;
			const vv = v - v === 0 ? v : 0;
			ab += uu * vv;
			aa += uu * uu;
			bb += vv * vv;
		}
		return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
	};
	const heads = new Map<number, { bands: number[]; level: number }>();
	let best: LoopPoints | null = null;
	const aSteps = Math.max(0, Math.floor(S / LOOP_CROSSFADE.stepSec + 1e-9));
	for (let i = 0; i <= aSteps; i++) {
		const a = ws + i * LOOP_CROSSFADE.stepSec;
		let head = heads.get(i);
		if (!head) {
			head = segment(headSp, headFrom, a);
			heads.set(i, head);
		}
		const kMax = Math.floor((we - a) / frame + 1e-9);
		const kMin = Math.max(Math.ceil((we - S - a) / frame - 1e-9), Math.ceil((2 * X) / frame - 1e-9));
		for (let k = kMax; k >= kMin; k--) {
			const b = a + k * frame;
			if (b > we + 1e-9 || b - X < a + X - 1e-9) continue;
			const tail = segment(tailSp, tailFrom, b - X);
			const levelDiffDb = tail.level - head.level;
			const spectral = spectralDistanceDb(head.bands, tail.bands);
			const rho = corr(Math.round(a * sr), Math.round((b - X) * sr));
			const law = crossfadeLaw(rho);
			const cost = Math.abs(levelDiffDb) + LOOP_CROSSFADE.spectralWeight * spectral + Math.abs(law.midpointDb);
			if (!best || cost < best.cost - 1e-9)
				best = {
					inSec: Math.round(a * 1000) / 1000,
					outSec: Math.round(a * 1000) / 1000 + k * frame,
					crossfadeSec: r3(X),
					fade: law.fade,
					levelDiffDb: r2(levelDiffDb),
					spectralDistanceDb: spectral,
					correlation: r3(rho),
					midpointDb: r2(law.midpointDb),
					cost,
				};
		}
	}
	return best ? { ...best, cost: r2(best.cost) } : null;
}

/**
 * The crossfade law for a head and tail with zero-lag correlation ρ, and the power change it gives at the fade's
 * midpoint: equal power (10·log10(1 + ρ)) for uncorrelated material — noise, most ambiences —, equal gain
 * (10·log10((1 + ρ) / 2)) once ρ > √2 − 1, where it is the smaller change (a hum or tone that repeats in phase: the
 * loop length is a whole number of frames, so a mains hum at 25 / 30 fps always does).
 */
export function crossfadeLaw(rho: number): { fade: 'equal-power' | 'equal-gain'; midpointDb: number } {
	const p = fin(rho) ? Math.max(-1, Math.min(1, rho)) : 0;
	const power = 10 * Math.log10(Math.max(1e-6, 1 + p));
	const gain = 10 * Math.log10(Math.max(1e-6, (1 + p) / 2));
	return Math.abs(gain) < Math.abs(power) ? { fade: 'equal-gain', midpointDb: gain } : { fade: 'equal-power', midpointDb: power };
}

// ── room tone ────────────────────────────────────────────────────────────────────────────────────────────────────

type Range = readonly [number, number];

/** Whether level frame `i` (of `frameSec`) touches one of the excluded ranges (seconds). */
function excludedFrames(n: number, frameSec: number, exclude: readonly Range[] | undefined): Uint8Array {
	const out = new Uint8Array(n);
	for (const r of Array.isArray(exclude) ? exclude : []) {
		if (!Array.isArray(r) || !fin(r[0]) || !fin(r[1]) || r[1] <= r[0]) continue;
		const a = Math.max(0, Math.floor(r[0] / frameSec));
		const b = Math.min(n, Math.ceil(r[1] / frameSec));
		for (let i = a; i < b; i++) out[i] = 1;
	}
	return out;
}

/**
 * The quietest stretch of `minSec`…`maxSec` (default 0.5–3 s) outside `exclude` (speech, seconds), as long as it can
 * be, without digital silence: the stretch of `maxSec` (or the longest that fits between exclusions, ≥ `minSec`) with
 * the lowest mean level. Null when none fits.
 */
export function quietestStretch(
	x: Float32Array,
	sr: number,
	opts: { exclude?: readonly Range[]; minSec?: number; maxSec?: number } = {},
): { startSec: number; endSec: number; levelDb: number } | null {
	if (!usable(x, sr)) return null;
	const fs = LOOP_WINDOW.levelFrameSec;
	const L = frameLevels(x, sr, fs, Math.min(x.length / sr, LOOP_WINDOW.maxSeconds));
	const n = L.length;
	const ex = excludedFrames(n, fs, opts.exclude);
	const minF = Math.max(
		1,
		Math.round((fin(opts.minSec) && opts.minSec > 0 ? opts.minSec : ROOM_TONE_STRETCH.minSec) / fs),
	);
	const maxF = Math.max(
		minF,
		Math.round((fin(opts.maxSec) && opts.maxSec > 0 ? opts.maxSec : ROOM_TONE_STRETCH.maxSec) / fs),
	);
	let best: { s: number; w: number; level: number } | null = null;
	// free runs (no exclusion, no digital silence)
	let i = 0;
	while (i < n) {
		if (ex[i] || L[i]! < LOOP_WINDOW.silenceDb) {
			i++;
			continue;
		}
		let j = i;
		while (j < n && !ex[j] && L[j]! >= LOOP_WINDOW.silenceDb) j++;
		const run = j - i;
		if (run >= minF) {
			const w = Math.min(maxF, run);
			for (let s = i; s + w <= j; s++) {
				let e = 0;
				for (let k = s; k < s + w; k++) e += 10 ** (L[k]! / 10);
				const level = dbFloor(e / w);
				// longer first, then quieter
				if (!best || w > best.w || (w === best.w && level < best.level - 1e-9)) best = { s, w, level };
			}
		}
		i = j;
	}
	if (!best) return null;
	return { startSec: r3(best.s * fs), endSec: r3((best.s + best.w) * fs), levelDb: r2(best.level) };
}

/**
 * The noise floor of a recording outside `exclude` (speech, seconds): the quietest 20 % of its 100 ms frames (at least
 * one), their level (energy mean, dBFS) and octave bands (dB). Null without such frames.
 */
export function noiseFloorProfile(
	x: Float32Array,
	sr: number,
	opts: { exclude?: readonly Range[] } = {},
): NoiseFloor | null {
	if (!usable(x, sr)) return null;
	const fs = LOOP_WINDOW.levelFrameSec;
	const L = frameLevels(x, sr, fs, Math.min(x.length / sr, LOOP_WINDOW.maxSeconds));
	const ex = excludedFrames(L.length, fs, opts.exclude);
	const free: number[] = [];
	for (let i = 0; i < L.length; i++) if (!ex[i] && L[i]! >= LOOP_WINDOW.silenceDb) free.push(i);
	if (!free.length) return null;
	free.sort((a, b) => L[a]! - L[b]! || a - b);
	const take = free.slice(0, Math.max(1, Math.ceil(free.length * ROOM_TONE_STRETCH.floorQuantile)));
	take.sort((a, b) => a - b);
	const n = Math.round(fs * sr);
	const acc = new Float64Array(OCTAVE_BAND_CENTRES_HZ.length);
	let e = 0;
	let frames = 0;
	for (const f of take) {
		e += 10 ** (L[f]! / 10);
		const sp = frameSpectra(x, sr, f * n, (f + 1) * n + Math.round(0.05 * sr));
		const seg = segmentBands(sp, f * n, f * n, (f + 1) * n + Math.round(0.05 * sr));
		if (seg.level > BAND_FLOOR_DB) {
			for (let j = 0; j < acc.length; j++) acc[j] += 10 ** (seg.bands[j]! / 10);
			frames++;
		}
	}
	return {
		levelDb: r2(dbFloor(e / take.length)),
		bandsDb: [...acc].map((v) => r2(frames ? Math.max(BAND_FLOOR_DB, dbFloor(v / frames)) : BAND_FLOOR_DB)),
		seconds: r3(take.length * fs),
	};
}

/** Octave bands (dB) and level (dBFS) of `x` over `[startSec, endSec)`: a candidate's window. */
export function windowSpectrum(
	x: Float32Array,
	sr: number,
	startSec: number,
	endSec: number,
): { levelDb: number; bandsDb: number[] } | null {
	if (!usable(x, sr) || !fin(startSec) || !fin(endSec) || endSec <= startSec) return null;
	const a = Math.max(0, Math.floor(startSec * sr));
	const b = Math.min(x.length, Math.ceil(endSec * sr));
	if (b <= a) return null;
	const sp = frameSpectra(x, sr, a, b);
	const seg = segmentBands(sp, a, a, b);
	return {
		levelDb: r2(Math.max(BAND_FLOOR_DB, dbFloor(meanSquare(x, a, b)))),
		bandsDb: seg.bands.map(r2),
	};
}
