// Sound judge (spec 12 §2.1): checks a sound's descriptors against the plain numeric profile of the type it is meant
// to be, and names what is wrong. Pure. The profile shape is duplicated, field for field, by the project-side
// taxonomy (`packages/project/src/sound/taxonomy.ts`), which passes its own profiles in; `DEFAULT_TYPE_PROFILES` is
// this package's copy (justified in docs/wp-notes/sound-design.md "WP1.1b").
import type { SoundDescriptors } from './sound-descriptors.ts';

/** The 19 sound-effect types plus ambience and room tone (spec 12 §2.1 taxonomy). */
export const SOUND_TYPE_IDS = [
	'hit',
	'boom',
	'riser',
	'reverse',
	'transition',
	'whoosh',
	'swish',
	'glitch',
	'ui',
	'click',
	'key',
	'tick',
	'tap',
	'pop',
	'thump',
	'paper',
	'chime',
	'shimmer',
	'zap',
	'ambience',
	'roomtone',
] as const;
export type SoundTypeId = (typeof SOUND_TYPE_IDS)[number];

/** Judge thresholds for one type. Plain numbers so the project taxonomy can carry the same shape. */
export interface SoundTypeProfile {
	/** Shortest acceptable `durationSec`. */
	minDurSec: number;
	/** Longest acceptable `durationSec`. */
	maxDurSec: number;
	/** Slowest acceptable `riseMs`; null = any. */
	maxRiseMs: number | null;
	/** The sound must fall 20 dB below its peak (`decays`). */
	mustDecay: boolean;
	/** Largest acceptable `below150Share` (more is boomy). */
	maxBelow150Share: number;
	/** Largest acceptable `above6kShare` (more is hissy). */
	maxAbove6kShare: number;
	/** Largest acceptable `flatness` (more is noisy); null = any. */
	maxFlatness: number | null;
	/** One onset only (`onsetCount` ≤ 1). */
	singleHit: boolean;
	/** Smallest acceptable `maxMomentaryLufs` (less is quiet). */
	minMaxMomentaryLufs: number;
}

export type JudgeReason =
	| 'boomy'
	| 'hissy'
	| 'noisy'
	| 'soft-attack'
	| 'non-decaying'
	| 'too-long'
	| 'too-short'
	| 'clipped'
	| 'multi-hit'
	| 'quiet';

export const JUDGE_REASONS: readonly JudgeReason[] = /* @__PURE__ */ Object.freeze([
	'boomy',
	'hissy',
	'noisy',
	'soft-attack',
	'non-decaying',
	'too-long',
	'too-short',
	'clipped',
	'multi-hit',
	'quiet',
]);

export interface JudgeResult {
	/** No reason applies. */
	ok: boolean;
	/** 1 when ok; each reason multiplies it by (1 − weight × severity), severity 0.25…1 by how far out it is. */
	score: number;
	/** In the order of {@link JUDGE_REASONS}. */
	reasons: JudgeReason[];
}

/**
 * True peak above this (dBTP) reads as clipped: PCM samples never exceed 0 dBFS, so inter-sample overs this large
 * mean a waveform squared off at full scale (hard clipping or brick-wall limiting).
 */
export const CLIPPED_TRUE_PEAK_DB = 0.3;

/** How much each reason costs at full severity. */
const WEIGHT: Record<JudgeReason, number> = {
	boomy: 0.5,
	hissy: 0.4,
	noisy: 0.4,
	'soft-attack': 0.5,
	'non-decaying': 0.4,
	'too-long': 0.5,
	'too-short': 0.6,
	clipped: 0.6,
	'multi-hit': 0.5,
	quiet: 0.5,
};

const severity = (excess: number, scale: number): number =>
	Math.min(1, Math.max(0.25, Number.isFinite(excess / scale) ? excess / scale : 1));

const fin = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** Judge descriptors against a type profile. Never throws; missing or non-finite profile limits are not checked. */
export function judgeSound(d: SoundDescriptors, profile: SoundTypeProfile): JudgeResult {
	// Nothing to judge (missing descriptors or profile from hostile input): not accepted, never a throw.
	if (!d || typeof d !== 'object' || !profile || typeof profile !== 'object')
		return { ok: false, score: 0, reasons: [] };
	const sev = new Map<JudgeReason, number>();
	const dur = d.durationSec;
	if (fin(profile.minDurSec) && dur < profile.minDurSec)
		sev.set('too-short', severity(profile.minDurSec - dur, Math.max(profile.minDurSec, 1e-3)));
	if (fin(profile.maxDurSec) && dur > profile.maxDurSec)
		sev.set('too-long', severity(dur - profile.maxDurSec, Math.max(profile.maxDurSec, 1e-3)));
	if (fin(profile.maxRiseMs) && d.riseMs > profile.maxRiseMs)
		sev.set('soft-attack', severity(d.riseMs - profile.maxRiseMs, Math.max(profile.maxRiseMs, 1) * 3));
	if (profile.mustDecay && !d.decays) sev.set('non-decaying', 1);
	if (fin(profile.maxBelow150Share) && d.below150Share > profile.maxBelow150Share)
		sev.set('boomy', severity(d.below150Share - profile.maxBelow150Share, 0.3));
	if (fin(profile.maxAbove6kShare) && d.above6kShare > profile.maxAbove6kShare)
		sev.set('hissy', severity(d.above6kShare - profile.maxAbove6kShare, 0.3));
	if (fin(profile.maxFlatness) && d.flatness > profile.maxFlatness)
		sev.set('noisy', severity(d.flatness - profile.maxFlatness, 0.3));
	if (d.truePeakDb !== null && d.truePeakDb > CLIPPED_TRUE_PEAK_DB)
		sev.set('clipped', severity(d.truePeakDb - CLIPPED_TRUE_PEAK_DB, 2));
	if (profile.singleHit && d.onsetCount > 1) sev.set('multi-hit', severity(d.onsetCount - 1, 3));
	if (fin(profile.minMaxMomentaryLufs)) {
		const m = d.maxMomentaryLufs;
		if (m === null || m < profile.minMaxMomentaryLufs)
			sev.set('quiet', m === null ? 1 : severity(profile.minMaxMomentaryLufs - m, 20));
	}
	const reasons = JUDGE_REASONS.filter((r) => sev.has(r));
	let score = 1;
	for (const r of reasons) score *= 1 - WEIGHT[r] * sev.get(r)!;
	return { ok: reasons.length === 0, score: Math.round(Math.max(0, score) * 1000) / 1000, reasons };
}

const P = /* @__NO_SIDE_EFFECTS__ */ (
	minDurSec: number,
	maxDurSec: number,
	maxRiseMs: number | null,
	mustDecay: boolean,
	maxBelow150Share: number,
	maxAbove6kShare: number,
	maxFlatness: number | null,
	singleHit: boolean,
	minMaxMomentaryLufs: number,
): SoundTypeProfile =>
	Object.freeze({
		minDurSec,
		maxDurSec,
		maxRiseMs,
		mustDecay,
		maxBelow150Share,
		maxAbove6kShare,
		maxFlatness,
		singleHit,
		minMaxMomentaryLufs,
	});

/**
 * Default judge profiles. Durations are whole files (real library files carry some silence); rise limits are on the
 * 2 ms RMS envelope (≈ 0.5 ms resolution); shares are of the power over the active span; loudness floors are the
 * highest 400 ms momentary loudness, so short sounds (whose energy is averaged over 400 ms) get lower floors.
 */
export const DEFAULT_TYPE_PROFILES: Readonly<Record<SoundTypeId, SoundTypeProfile>> =
	/* @__PURE__ */ Object.freeze({
		//              minDur maxDur rise   decay  <150  >6k   flat  single momentary
		hit: P(0.05, 6, 25, true, 0.6, 0.5, null, true, -40),
		boom: P(0.2, 10, 60, true, 1, 0.25, null, true, -45),
		riser: P(0.5, 30, null, false, 0.6, 0.6, null, false, -45),
		reverse: P(0.3, 12, null, false, 0.6, 0.6, null, false, -45),
		transition: P(0.2, 12, null, false, 0.7, 0.6, null, false, -45),
		whoosh: P(0.15, 6, null, false, 0.5, 0.7, null, false, -45),
		swish: P(0.05, 3, null, false, 0.3, 0.85, null, false, -45),
		glitch: P(0.03, 5, null, false, 0.5, 0.7, null, false, -45),
		ui: P(0.01, 2, 30, true, 0.3, 0.6, null, false, -50),
		click: P(0.002, 1, 6, true, 0.3, 0.85, null, true, -55),
		key: P(0.005, 1, 10, true, 0.4, 0.7, null, true, -55),
		tick: P(0.002, 1, 6, true, 0.3, 0.85, null, true, -55),
		tap: P(0.01, 1.5, 12, true, 0.5, 0.6, null, true, -55),
		pop: P(0.01, 1.5, 15, true, 0.5, 0.5, null, true, -50),
		thump: P(0.05, 3, 25, true, 0.95, 0.25, null, true, -45),
		paper: P(0.05, 6, null, false, 0.3, 0.85, null, false, -50),
		chime: P(0.2, 10, 40, true, 0.3, 0.5, 0.3, false, -45),
		shimmer: P(0.3, 12, null, false, 0.2, 0.85, 0.5, false, -50),
		zap: P(0.05, 3, 30, false, 0.5, 0.6, null, false, -45),
		ambience: P(2, 3600, null, false, 0.8, 0.6, null, false, -60),
		roomtone: P(2, 3600, null, false, 0.9, 0.6, null, false, -75),
	});
