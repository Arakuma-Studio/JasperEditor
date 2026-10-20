// Cut edges of audio clips for Sound Check (spec 12 §4 P6-E1 `EDGE`; wp-note "Phase 6 → WP-E1"). Pure measurements
// on decoded source audio around a clip edge, and the judgements. Total: never throws, any input.
//
// Adapted from earshot `skills/real-sound/scripts/qa.py` `sample_edges` / `judge_edges` / `check_splices` (MIT,
// Copyright (c) 2026 Leon Lin; licenses/ported/earshot.md):
//   abrupt entry   the source in the 20 ms before the In point within 20 dB of the clip's peak (RMS re peak), no fade-in
//                  ≥ 5 ms, and no attack within 10 ms of the In point covering it (an attack covers it unless the source
//                  before is within 10 dB of the peak). The attack is the first 1 ms whose peak is within 20 dB of the
//                  clip's peak.
//   chopped decay  the clip's last 1 ms RMS over −35 dB re its peak, the source's 20 ms after the Out point over −35 dB
//                  re the same peak, and a fade-out under 30 ms.
//   chopped music  a music piece followed by another: the source's 50 ms after the Out point within 6 dB of the piece's
//                  last 50 ms and over 6 dB above the next piece's first 50 ms (all RMS, dBFS), crossfade under 100 ms.
// Signals here are mono (any layout folded by the caller) at the timeline's rate.

export const EDGE_LIMITS = {
	/** Head / tail level windows (ms): earshot's first / last 48 samples at 48 kHz. */
	levelMs: 1,
	/** Attack blocks (ms). */
	attackBlockMs: 1,
} as const;

const fin = (x: number) => x - x === 0;
const db = (v: number) => (v > 0 && fin(v) ? Math.max(-120, 20 * Math.log10(v)) : -120);

/** Largest |x| over `[from, to)` (non-finite samples count as 0). */
export function peakOf(x: ArrayLike<number>, from = 0, to = x.length): number {
	let p = 0;
	const a = Math.max(0, Math.floor(from));
	const b = Math.min(x.length, Math.floor(to));
	for (let i = a; i < b; i++) {
		const v = x[i]!;
		const m = fin(v) ? (v < 0 ? -v : v) : 0;
		if (m > p) p = m;
	}
	return p;
}

/** RMS over `[from, to)` (0 for an empty span; non-finite samples count as 0). */
export function rmsOf(x: ArrayLike<number>, from = 0, to = x.length): number {
	const a = Math.max(0, Math.floor(from));
	const b = Math.min(x.length, Math.floor(to));
	if (b <= a) return 0;
	let e = 0;
	for (let i = a; i < b; i++) {
		const v = x[i]!;
		if (fin(v)) e += v * v;
	}
	return Math.sqrt(e / (b - a));
}

/** RMS of a span in dBFS (−120 for silence). */
export function rmsDbfs(x: ArrayLike<number>, from = 0, to = x.length): number {
	return db(rmsOf(x, from, to));
}

/**
 * Milliseconds from the start of `x` to its attack: the first 1 ms block whose peak is within 20 dB of the peak of `x`
 * (earshot `env_index(…, 'attack')`); 0 for silence.
 */
export function attackMs(x: ArrayLike<number>, sampleRate: number): number {
	const sr = fin(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;
	const w = Math.max(1, Math.round((EDGE_LIMITS.attackBlockMs / 1000) * sr));
	const pk = peakOf(x);
	if (!(pk > 0)) return 0;
	for (let i = 0; i < x.length; i += w) if (peakOf(x, i, i + w) >= pk * 0.1) return (i / sr) * 1000;
	return 0;
}

export type EntryMeasure = {
	/** Peak of the clip's content measured (linear). */
	peak: number;
	/** RMS of the source in the window before the In point, dB re `peak` (−120 when there is none). */
	preDb: number;
	/** RMS of the clip's first ms, dB re `peak`. */
	headDb: number;
	/** The clip's attack after its In point (ms). */
	attackMs: number;
};

/** Measures a clip's head: `inside` starts at the In point, `before` is the source just before it (may be empty). */
export function measureEntry(
	inside: ArrayLike<number>,
	before: ArrayLike<number>,
	sampleRate: number,
): EntryMeasure {
	const sr = fin(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;
	const peak = peakOf(inside);
	const head = Math.max(1, Math.round((EDGE_LIMITS.levelMs / 1000) * sr));
	const rel = (v: number) => (peak > 0 ? db(v / peak) : -120);
	return {
		peak,
		preDb: before.length ? rel(rmsOf(before)) : -120,
		headDb: rel(rmsOf(inside, 0, head)),
		attackMs: attackMs(inside, sr),
	};
}

export type EntryRules = { preDb: number; fadeMs: number; attackMs: number; exposedDb: number };

/** Whether a measured head is an abrupt entry (see the module docs), given its fade-in (ms). */
export function isAbruptEntry(m: EntryMeasure, fadeInMs: number, r: EntryRules): boolean {
	if (!(m.peak > 0) || !(m.preDb > r.preDb)) return false;
	if (fin(fadeInMs) && fadeInMs >= r.fadeMs) return false;
	return m.attackMs > r.attackMs || m.preDb > r.exposedDb;
}

export type ExitMeasure = {
	peak: number;
	/** RMS of the clip's last ms, dB re `peak`. */
	tailDb: number;
	/** RMS of the source in the window after the Out point, dB re `peak` (−120 when there is none). */
	postDb: number;
};

/** Measures a clip's tail: `inside` ends at the Out point, `after` is the source just after it (may be empty). */
export function measureExit(
	inside: ArrayLike<number>,
	after: ArrayLike<number>,
	sampleRate: number,
): ExitMeasure {
	const sr = fin(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;
	const peak = peakOf(inside);
	const w = Math.max(1, Math.round((EDGE_LIMITS.levelMs / 1000) * sr));
	const rel = (v: number) => (peak > 0 ? db(v / peak) : -120);
	return {
		peak,
		tailDb: rel(rmsOf(inside, inside.length - w, inside.length)),
		postDb: after.length ? rel(rmsOf(after)) : -120,
	};
}

export type ExitRules = { tailDb: number; postDb: number; fadeMs: number };

/** Whether a measured tail is a chopped decay, given its fade-out (ms). */
export function isChoppedDecay(m: ExitMeasure, fadeOutMs: number, r: ExitRules): boolean {
	if (!(m.peak > 0)) return false;
	if (fin(fadeOutMs) && fadeOutMs >= r.fadeMs) return false;
	return m.tailDb > r.tailDb && m.postDb > r.postDb;
}

/**
 * Where the source after an Out point has decayed: the first window of `windowMs` (from the Out point) whose RMS is
 * under `belowDb` re `peak`, in ms after the Out point; null when it has not within `after`.
 */
export function decayAfterMs(
	after: ArrayLike<number>,
	peak: number,
	belowDb: number,
	sampleRate: number,
	windowMs = 10,
): number | null {
	const sr = fin(sampleRate) && sampleRate > 0 ? sampleRate : 48_000;
	if (!(peak > 0)) return 0;
	const w = Math.max(1, Math.round((windowMs / 1000) * sr));
	for (let i = 0; i + w <= after.length; i += w)
		if (db(rmsOf(after, i, i + w) / peak) < belowDb) return (i / sr) * 1000;
	return null;
}

export type SpliceMeasure = {
	/** The piece's last window before its Out point, RMS dBFS. */
	outDb: number;
	/** The source's window after the Out point (what the cut removes), RMS dBFS. */
	cutOffDb: number;
	/** The next piece's first window (what enters), RMS dBFS. */
	nextInDb: number;
};

/** Levels of a music joint (each window RMS in dBFS, gains applied by the caller). */
export function measureSplice(
	pieceEnd: ArrayLike<number>,
	sourceAfter: ArrayLike<number>,
	nextStart: ArrayLike<number>,
): SpliceMeasure {
	return { outDb: rmsDbfs(pieceEnd), cutOffDb: rmsDbfs(sourceAfter), nextInDb: rmsDbfs(nextStart) };
}

export type SpliceRules = { sustainDb: number; overNextDb: number; crossfadeMs: number };

/** Whether a measured joint chops the music, given its crossfade (ms). */
export function isChoppedMusic(m: SpliceMeasure, crossfadeMs: number, r: SpliceRules): boolean {
	if (fin(crossfadeMs) && crossfadeMs >= r.crossfadeMs) return false;
	if (!(m.cutOffDb > -100)) return false;
	return m.cutOffDb > m.outDb - r.sustainDb && m.cutOffDb > m.nextInDb + r.overNextDb;
}
