// Cut-edge snapping (docs/wp-notes/transcript-cleanup.md "Cut edges outside speech"): one rule for every cut of a
// recording — Clean Up's planner, text-based cuts, restart / stutter removal, and manual cuts that opt in — so no kept
// span ends while the sound it cuts away is still speech, and none starts while the sound before it is. A cut edge at
// media second `t` is either an **out** edge (the kept span ends at `t`, the cut-away sound follows) or an **in**
// edge (the kept span starts at `t`, the cut-away sound precedes). The edge is *clean* when the level at the cut is
// quiet and the `EDGE_AWAY_S` of cut-away sound beside it holds no speech. Snapping moves an edge, inside caller
// bounds that never cross a word to keep or remove, to the nearest clean boundary; with none it keeps the edge's
// position or moves it towards keeping more (a word's decay at an out edge, its attack at an in edge) to the least bad
// boundary — it never shortens the kept span onto a boundary that still cuts speech. Pure.
import { type CleanupVoice, levelDbAt } from './detector.ts';

/** 10 ms frames of the level envelope. */
const FR = 0.01;

/**
 * Quiet at a cut: at most this far under the speech level (95th percentile). On the reporter's 57-minute source
 * (speech level −9 dBFS) that is −40 dBFS, the level the by-ear review asked a cut to sit under.
 */
export const EDGE_QUIET_UNDER_SPEECH_DB = 31;
/**
 * Speech on the cut-away side: louder than this far under the speech level (−28 dBFS on the reporter's source: the
 * level over which the review heard a word go on after the cut).
 */
export const EDGE_LOUD_UNDER_SPEECH_DB = 19;
/** Without a speech level (no voice analysis levels): absolute quiet / speech levels. */
export const EDGE_QUIET_DB = -40;
export const EDGE_LOUD_DB = -28;
/** Where the floor is high (a loudness-normalised mixdown), quiet is at least measured silence: floor + 6 dB. */
const EDGE_FLOOR_MARGIN_DB = 6;
/** The cut-away sound judged beside an edge (s). */
export const EDGE_AWAY_S = 0.05;
/** How far an edge may move in either direction (s). */
export const EDGE_SEARCH_S = 0.15;
/** How far an out edge may follow a word's decay (s): fading ends ran up to 0.4 s past the timestamp on the source. */
export const EDGE_DECAY_S = 0.3;
/** How far into a neighbouring word's time an edge may move to keep the kept word's attack or decay (s). */
export const EDGE_INTO_WORD_S = 0.08;
/**
 * Without a clean boundary, an edge enters the cut-away word's time only for a dip at least this much (dB) better than
 * the best boundary outside it: a real gap between two words said into each other, not a level wobble.
 */
export const EDGE_DIP_GAIN_DB = 6;

/** A level envelope in 10 ms frames (dB per frame; −120 beyond it) with the levels the thresholds use. */
export type EdgeLevels = {
	readonly frameCount: number;
	db(k: number): number;
	readonly floorDb: number | null;
	readonly speechDb: number | null;
};

export function edgeLevelsOf(voice: CleanupVoice): EdgeLevels {
	return {
		frameCount: voice.frameCount,
		db: (k) => levelDbAt(voice, k),
		floorDb: voice.levels.floorDb,
		speechDb: voice.levels.speechDb,
	};
}

/** The quiet and speech levels of an envelope (dBFS). */
export function edgeThresholds(l: Pick<EdgeLevels, 'floorDb' | 'speechDb'>): { quiet: number; loud: number } {
	let quiet = l.speechDb === null ? EDGE_QUIET_DB : l.speechDb - EDGE_QUIET_UNDER_SPEECH_DB;
	let loud = l.speechDb === null ? EDGE_LOUD_DB : l.speechDb - EDGE_LOUD_UNDER_SPEECH_DB;
	if (l.floorDb !== null && quiet < l.floorDb + EDGE_FLOOR_MARGIN_DB)
		quiet = l.floorDb + EDGE_FLOOR_MARGIN_DB;
	if (loud < quiet + EDGE_FLOOR_MARGIN_DB) loud = quiet + EDGE_FLOOR_MARGIN_DB;
	return { quiet, loud };
}

export type EdgeSide = 'out' | 'in';

const AWAY_FRAMES = Math.round(EDGE_AWAY_S / FR);

/** The 10 ms frame a boundary at second `b` starts. */
const frameAt = (b: number) => Math.round(b / FR - 1e-9);

/** The loudest level of the cut-away sound beside an edge at `b` (dBFS). */
export function awayLevel(l: EdgeLevels, b: number, side: EdgeSide): number {
	const k = frameAt(b);
	let m = -120;
	if (side === 'out') for (let q = k; q < k + AWAY_FRAMES; q++) m = Math.max(m, l.db(q));
	else for (let q = k - AWAY_FRAMES; q < k; q++) m = Math.max(m, l.db(q));
	return m;
}

/**
 * How badly an edge at `b` cuts (≤ 0: clean): the worse of the level at the cut over the quiet level and the
 * cut-away sound over the speech level, in dB.
 */
export function edgeScore(l: EdgeLevels, b: number, side: EdgeSide): number {
	const { quiet, loud } = edgeThresholds(l);
	const k = frameAt(b);
	const at = Math.max(l.db(k - 1), l.db(k));
	return Math.max(at - quiet, awayLevel(l, b, side) - loud);
}

/** Whether an edge at `b` cuts speech: the cut-away sound beside it is louder than the speech level. */
export function edgeCutsSpeech(l: EdgeLevels, b: number, side: EdgeSide): boolean {
	return awayLevel(l, b, side) > edgeThresholds(l).loud;
}

export type SnapInput = {
	/** The edge (media seconds). */
	t: number;
	side: EdgeSide;
	/**
	 * Hard bounds (media seconds): towards keeping more (an out edge later, an in edge earlier) the edge may go to
	 * `keepMore`, towards cutting more to `cutMore` (only onto a clean boundary). Each is clamped to `EDGE_SEARCH_S`
	 * (an out edge's decay to `EDGE_DECAY_S`).
	 */
	keepMore: number;
	cutMore: number;
	/**
	 * Towards keeping more, past this point (between `t` and `keepMore`: inside the cut-away word's time) a boundary that
	 * is not clean is taken only when it is `EDGE_DIP_GAIN_DB` better than the best one before it. Default `keepMore`.
	 */
	keepSoft?: number;
	/** The boundaries an edge may take (media seconds, e.g. a clip's frame boundaries); default every 10 ms. */
	candidates?: readonly number[];
};

export type SnapResult = { t: number; clean: boolean; score: number };

/**
 * Snaps a cut edge (see the module comment): `t` itself when clean; else the nearest clean boundary within the bounds
 * (ties towards keeping more); else, towards keeping more only (`t` included), the boundary with the least score
 * (ties nearest `t`).
 */
export function snapCut(l: EdgeLevels, o: SnapInput): SnapResult {
	const out = o.side === 'out';
	const reachKeep = out ? EDGE_DECAY_S : EDGE_SEARCH_S;
	const keepB = out ? Math.min(o.keepMore, o.t + reachKeep) : Math.max(o.keepMore, o.t - reachKeep);
	const cutB = out ? Math.max(o.cutMore, o.t - EDGE_SEARCH_S) : Math.min(o.cutMore, o.t + EDGE_SEARCH_S);
	const lo = Math.min(o.t, out ? cutB : keepB);
	const hi = Math.max(o.t, out ? keepB : cutB);
	const own = edgeScore(l, o.t, o.side);
	if (own <= 0) return { t: o.t, clean: true, score: own };
	const cands: number[] = [];
	if (o.candidates) {
		for (const c of o.candidates)
			if (c >= lo - 1e-9 && c <= hi + 1e-9 && Math.abs(c - o.t) > 1e-9) cands.push(c);
	} else
		for (let k = Math.ceil(lo / FR - 1e-9); k * FR <= hi + 1e-9; k++)
			if (Math.abs(k * FR - o.t) > 1e-9) cands.push(k * FR);
	const keeps = (c: number) => (out ? c > o.t : c < o.t);
	const soft = o.keepSoft ?? o.keepMore;
	const pastSoft = (c: number) => (out ? c > soft + 1e-9 : c < soft - 1e-9);
	let clean: { t: number; score: number } | null = null;
	const least = { t: o.t, score: own };
	let dip: { t: number; score: number } | null = null;
	const better = (best: { t: number; score: number } | null, c: number, s: number) => {
		if (!best) return true;
		const d = Math.abs(c - o.t);
		const bd = Math.abs(best.t - o.t);
		return s < best.score - 1e-9 || (Math.abs(s - best.score) <= 1e-9 && d < bd - 1e-9);
	};
	for (const c of cands) {
		const s = edgeScore(l, c, o.side);
		const d = Math.abs(c - o.t);
		if (s <= 0) {
			const cd = clean ? Math.abs(clean.t - o.t) : Number.POSITIVE_INFINITY;
			if (d < cd - 1e-9 || (Math.abs(d - cd) <= 1e-9 && keeps(c))) clean = { t: c, score: s };
		}
		if (!keeps(c)) continue;
		if (pastSoft(c)) {
			if (better(dip, c, s)) dip = { t: c, score: s };
		} else if (better(least, c, s)) {
			least.t = c;
			least.score = s;
		}
	}
	if (clean) return { t: clean.t, clean: true, score: clean.score };
	if (dip && dip.score <= least.score - EDGE_DIP_GAIN_DB) return { t: dip.t, clean: false, score: dip.score };
	return { t: least.t, clean: false, score: least.score };
}

type BoundWord = { s: number; e: number };

/**
 * The bounds of an edge at `t` from the words around it (media seconds, sorted by start): towards cutting more the
 * edge never passes the edge of the nearest word on the kept side (its end for an out edge, its start for an in edge);
 * towards keeping more it enters the nearest word on the cut-away side by at most `EDGE_INTO_WORD_S` and half that
 * word (a late timestamp may cover the kept word's attack, an early one its decay) — onto a clean boundary or a real
 * dip (`keepSoft` = that word's edge). A word counts on the kept side when its midpoint lies there.
 */
export function edgeBounds(
	words: readonly BoundWord[],
	t: number,
	side: EdgeSide,
): { keepMore: number; keepSoft: number; cutMore: number } {
	const into = (w: BoundWord) => Math.min(EDGE_INTO_WORD_S, (w.e - w.s) / 2);
	let keptSide: BoundWord | null = null;
	let awaySide: BoundWord | null = null;
	for (const w of words) {
		const mid = (w.s + w.e) / 2;
		if (side === 'out') {
			if (mid < t) keptSide = w;
			else if (!awaySide) awaySide = w;
		} else if (mid < t) awaySide = w;
		else if (!keptSide) keptSide = w;
	}
	if (side === 'out')
		return {
			cutMore: keptSide ? Math.min(t, keptSide.e) : Number.NEGATIVE_INFINITY,
			keepMore: awaySide ? Math.max(t, awaySide.s + into(awaySide)) : Number.POSITIVE_INFINITY,
			keepSoft: awaySide ? Math.max(t, awaySide.s) : Number.POSITIVE_INFINITY,
		};
	return {
		cutMore: keptSide ? Math.max(t, keptSide.s) : Number.POSITIVE_INFINITY,
		keepMore: awaySide ? Math.min(t, awaySide.e - into(awaySide)) : Number.NEGATIVE_INFINITY,
		keepSoft: awaySide ? Math.min(t, awaySide.e) : Number.NEGATIVE_INFINITY,
	};
}
