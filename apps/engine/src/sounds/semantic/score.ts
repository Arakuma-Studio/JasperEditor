// Calibrated audio-text matching (spec 12 P6-E14, WP-E9; the idea is earshot's, the vocabulary and the maths here are
// ours): a raw CLAP cosine means little on its own (some sounds are close to every text, some texts to every sound), so
// a description's match to a sound is the z of its similarity among the similarities of our vocabulary (vocab.ts, ≈ 300
// descriptions) to that sound, after "hub-phrase damping": every phrase's (and the query's) mean similarity to the
// library is subtracted first, so a phrase that is near every sound does not win everywhere.
//
//   s(a, x) = a·x − λ ā·x            (ā = mean library embedding; λ = min(1, n / 32) for n embedded sounds)
//   z(a, q) = (s(a, q) − mean_i s(a, v_i)) / std_i s(a, v_i)
//
// mean_i and std_i are computed without the 300 dot products per sound: mean_i s = a·v̄ − λ ā·v̄ and
// var_i s = aᵀCa − 2λ aᵀCā + λ² āᵀCā, with v̄ and C the vocabulary's mean and covariance; aᵀC is cached per embedding
// (`audioStats`), and Cā = mean(Ca) because it is linear. Pure and deterministic (fixed summation order).
import { SOUND_MATCH_VERDICTS, type SoundMatchVerdict } from '@jasper/api';
import { CLAP_EMBED_DIM, type ClapWindow } from './frontend.ts';

const D = CLAP_EMBED_DIM;
/** Embedded sounds at which hub damping is at full strength (fewer: weaker, the library mean is less sure). */
export const HUB_DAMPING_FULL_AT = 32;
/** Lowest standard deviation used (a degenerate vocabulary must not divide by zero). */
const MIN_STD = 1e-4;

/**
 * Verdict bands of a z (strong ≥ 3, plausible ≥ 2.5, weak ≥ 2): earshot's published bands, kept after we measured
 * them on our library (wp-note "Phase 6 → WP-E9", "Verdict bands": the method and the numbers).
 */
export const VERDICT_BANDS = { strong: 3, plausible: 2.5, weak: 2 } as const;

export function verdictOf(z: number): SoundMatchVerdict {
	if (!Number.isFinite(z)) return 'none';
	if (z >= VERDICT_BANDS.strong) return SOUND_MATCH_VERDICTS[0];
	if (z >= VERDICT_BANDS.plausible) return SOUND_MATCH_VERDICTS[1];
	if (z >= VERDICT_BANDS.weak) return SOUND_MATCH_VERDICTS[2];
	return SOUND_MATCH_VERDICTS[3];
}

/** The 0…1 describe part of the ranking (`SoundRankRequest.semantic`): z / 4, clamped (z ≤ 0 → 0: filtered out). */
export function semanticScoreOf(z: number): number {
	if (!Number.isFinite(z) || z <= 0) return 0;
	return Math.round(Math.min(1, z / 4) * 1e6) / 1e6;
}

export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
	let s = 0;
	for (let i = 0; i < D; i++) s += a[i]! * b[i]!;
	return s;
}

/** The vocabulary's mean and covariance (population), from its unit embeddings. */
export type Calibration = { mean: Float64Array; cov: Float64Array; size: number };

export function calibrationOf(vocab: readonly Float32Array[]): Calibration {
	const n = vocab.length;
	const mean = new Float64Array(D);
	const cov = new Float64Array(D * D);
	if (n === 0) return { mean, cov, size: 0 };
	for (const v of vocab) for (let i = 0; i < D; i++) mean[i]! += v[i]! / n;
	const c = new Float64Array(D);
	for (const v of vocab) {
		for (let i = 0; i < D; i++) c[i] = v[i]! - mean[i]!;
		for (let i = 0; i < D; i++) {
			const ci = c[i]! / n;
			if (ci === 0) continue;
			const row = i * D;
			for (let j = i; j < D; j++) cov[row + j]! += ci * c[j]!;
		}
	}
	for (let i = 0; i < D; i++) for (let j = 0; j < i; j++) cov[i * D + j] = cov[j * D + i]!;
	return { mean, cov, size: n };
}

/** What a sound's z needs of its embedding a: a·v̄, aᵀCa and Ca. */
export type AudioStats = { aMean: number; aCa: number; Ca: Float64Array };

export function audioStats(a: Float32Array, cal: Calibration): AudioStats {
	const Ca = new Float64Array(D);
	for (let i = 0; i < D; i++) {
		let s = 0;
		const row = i * D;
		for (let j = 0; j < D; j++) s += cal.cov[row + j]! * a[j]!;
		Ca[i] = s;
	}
	return { aMean: dot(a, cal.mean), aCa: dot(a, Ca), Ca };
}

/** The library reference of hub damping: ā, Cā (= mean Ca), λ and the scalars every z reuses. */
export type Reference = { mean: Float64Array; Cmean: Float64Array; lambda: number; meanVbar: number; meanCmean: number };

export function referenceOf(items: readonly { a: Float32Array; stats: AudioStats }[], cal: Calibration): Reference {
	const n = items.length;
	const mean = new Float64Array(D);
	const Cmean = new Float64Array(D);
	for (const { a, stats } of items)
		for (let i = 0; i < D; i++) {
			mean[i]! += a[i]! / n;
			Cmean[i]! += stats.Ca[i]! / n;
		}
	const lambda = n === 0 ? 0 : Math.min(1, n / HUB_DAMPING_FULL_AT);
	return { mean, Cmean, lambda, meanVbar: dot(mean, cal.mean), meanCmean: dot(mean, Cmean) };
}

/** A description's calibrated match to one embedding (`q` and `a` unit length). */
export function matchOf(
	a: Float32Array,
	stats: AudioStats,
	q: Float32Array,
	qBias: number,
	ref: Reference,
): { z: number; cosine: number } {
	const l = ref.lambda;
	const cosine = dot(a, q);
	const s = cosine - l * qBias;
	const mu = stats.aMean - l * ref.meanVbar;
	const variance = stats.aCa - 2 * l * dot(stats.Ca, ref.mean) + l * l * ref.meanCmean;
	const sd = Math.sqrt(Math.max(variance, MIN_STD * MIN_STD));
	const z = (s - mu) / sd;
	return { z: round4(z), cosine: round4(cosine) };
}

/** The query's bias: its mean similarity to the library (ā·q). */
export function queryBias(q: Float32Array, ref: Reference): number {
	return dot(ref.mean, q);
}

const round4 = (x: number) => (Number.isFinite(x) ? Math.round(x * 10_000) / 10_000 : 0);

// ---------------------------------------------------------------------------------------------------------------
// Find Moment: which windows to embed, and which to keep

/**
 * Coarse pass: 10 s windows every 5 s over the range (the last one ends at its end); every 10 s over ranges longer
 * than `COARSE_DENSE_MAX_SEC` (one window costs ≈ 0.56 s on 8 threads, measured: wp-note).
 */
export const COARSE_SEC = 10;
export const COARSE_HOP_SEC = 5;
export const COARSE_DENSE_MAX_SEC = 1800;
/** Coarse windows refined. */
export const REFINED_REGIONS = 3;

const r4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** Windows of `lengthSec` every `hopSec` covering `[startSec, endSec]` (the last one ends at `endSec`). */
export function slidingWindows(startSec: number, endSec: number, lengthSec: number, hopSec: number): ClapWindow[] {
	if (!(endSec > startSec) || !(lengthSec > 0) || !(hopSec > 0)) return [];
	if (endSec - startSec <= lengthSec) return [{ startSec: r4(startSec), endSec: r4(endSec) }];
	const out: ClapWindow[] = [];
	const last = endSec - lengthSec;
	for (let t = startSec; t < last - 1e-9; t += hopSec) out.push({ startSec: r4(t), endSec: r4(t + lengthSec) });
	out.push({ startSec: r4(last), endSec: r4(endSec) });
	return out;
}

/** The coarse windows of a range (none when the range is no longer than one coarse window: it is refined directly). */
export function coarseWindows(startSec: number, endSec: number): ClapWindow[] {
	if (endSec - startSec <= COARSE_SEC) return [];
	const hop = endSec - startSec > COARSE_DENSE_MAX_SEC ? COARSE_SEC : COARSE_HOP_SEC;
	return slidingWindows(startSec, endSec, COARSE_SEC, hop);
}

/**
 * Fine windows of `lengthSec` (hop half of it) over each region, widened by half a window on each side within the
 * range; distinct, in time order.
 */
export function fineWindows(
	regions: readonly ClapWindow[],
	lengthSec: number,
	range: ClapWindow,
): ClapWindow[] {
	const seen = new Set<string>();
	const out: ClapWindow[] = [];
	const hop = Math.max(0.125, lengthSec / 2);
	for (const r of regions) {
		const a = Math.max(range.startSec, r.startSec - lengthSec / 2);
		const b = Math.min(range.endSec, r.endSec + lengthSec / 2);
		for (const w of slidingWindows(a, b, lengthSec, hop)) {
			const k = `${w.startSec}-${w.endSec}`;
			if (seen.has(k)) continue;
			seen.add(k);
			out.push(w);
		}
	}
	return out.sort((x, y) => x.startSec - y.startSec || x.endSec - y.endSec);
}

/** The best `count` scored windows that do not overlap (z descending, then earlier first). */
export function pickMoments<T extends { window: ClapWindow; z: number }>(scored: readonly T[], count: number): T[] {
	const sorted = [...scored].sort(
		(a, b) => b.z - a.z || a.window.startSec - b.window.startSec || a.window.endSec - b.window.endSec,
	);
	const out: T[] = [];
	for (const s of sorted) {
		if (out.length >= count) break;
		if (out.some((o) => s.window.startSec < o.window.endSec && o.window.startSec < s.window.endSec)) continue;
		out.push(s);
	}
	return out;
}

/** The coarse regions to refine: the best REFINED_REGIONS windows by z (overlap allowed: neighbours both refine). */
export function regionsToRefine<T extends { window: ClapWindow; z: number }>(scored: readonly T[]): ClapWindow[] {
	return [...scored]
		.sort((a, b) => b.z - a.z || a.window.startSec - b.window.startSec)
		.slice(0, REFINED_REGIONS)
		.map((s) => s.window);
}
