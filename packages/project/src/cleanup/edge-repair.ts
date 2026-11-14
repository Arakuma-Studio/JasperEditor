// Repairing a cut edge that cuts a word (docs/wp-notes/transcript-cleanup.md "Edge repair"): where an existing cut —
// made by hand, by a text cut or by an earlier pass — ends a kept span while the cut word still sounds, or starts it
// after the word's attack began, the edge moves to the word's full decay / onset (an extension into the media's
// handle) or back off another word's onset (a trim), through the same snapper as every new cut (`snapCut`). Three
// differences from snapping a new cut, each from the by-ear review of a real cut (the 57-minute Spanish source):
// - tokens without a letter or a digit ("…", "%") bound nothing: the recogniser wrote "es …" with "…" over the decay
//   of "es" (242.88–242.95), which held the out edge at 242.90 inside the decay;
// - a word whose time holds the edge belongs to the side that holds most of its sound, not the side of its midpoint:
//   "No" at 1155.40–1155.79 (an early timestamp over a breath) holds the in edge at 1155.68 with all its sound after
//   it, so it is the kept word and its attack (from 1155.65) may be kept;
// - a run of breath-class frames shorter than `REPAIR_BREATH_MIN_S` right after / before the word is the word's own
//   unvoiced decay or attack, not a breath ("el" at 1191.67: two breath-class frames at −35 dBFS, then silence).
// A repair is *safe* (accepted by default) when it lands on a clean boundary and adds only the cut word's own sound —
// no other word's time, no breath, no onset after a dip (`snapCut` refuses those) — or trims only sound outside every
// kept word; an extension that lands on a boundary still cutting speech but at least `EDGE_DIP_GAIN_DB` better is
// offered for review. Pure.
import {
	awayLevel,
	EDGE_DECAY_S,
	EDGE_DIP_GAIN_DB,
	EDGE_ONSET_RISE_DB,
	type EdgeLevels,
	type EdgeSide,
	edgeBounds,
	edgeScore,
	edgeThresholds,
	snapCut,
} from './edge-snap.ts';

/** A breath-class run shorter than this (s) beside a word is the word's unvoiced decay or attack (`EDGE_QUIET_RUN_S` … ). */
export const REPAIR_BREATH_MIN_S = 0.05;
/** A word holding at least this share of its time inside a repair's added span is pulled in by it (another word). */
const FOREIGN_WORD_SHARE = 0.5;

const FR = 0.01;
/** A dip this close (dB) to the quiet level separates two words (`onsetBound`'s). */
const FOREIGN_DIP_DB = 3;

type Word = { s: number; e: number; text?: string };

/** Whether a token has a letter or a digit (a word that bounds edges), not punctuation alone. */
export function boundingToken(text: string | undefined): boolean {
	return text === undefined || /[\p{L}\p{N}]/u.test(text);
}

/**
 * `l` with breath-class runs shorter than `REPAIR_BREATH_MIN_S` read as no breath; and where a kept span would start or
 * end with a breath or keep one (`keptBreath`), the breath's frame right beside other sound over the quiet level
 * reads as that sound's: the frame grid (16.7 ms at 60 fps) cuts 10 ms frames whole, and the breath before "No
 * había" (1155.20–1155.65) ends one 10 ms frame before the attack — no frame boundary between them.
 */
export function repairLevels(l: EdgeLevels): EdgeLevels {
	const b = l.breath;
	if (!b) return l;
	const min = Math.round(REPAIR_BREATH_MIN_S / FR);
	const { quiet } = edgeThresholds(l);
	const breath = (k: number) => {
		if (!b(k)) return false;
		let n = 1;
		for (let q = k - 1; q >= 0 && b(q) && n < min; q--) n++;
		for (let q = k + 1; q < l.frameCount && b(q) && n < min; q++) n++;
		return n >= min;
	};
	const sound = (q: number) => q >= 0 && q < l.frameCount && !b(q) && l.db(q) > quiet;
	return {
		frameCount: l.frameCount,
		db: (k) => l.db(k),
		floorDb: l.floorDb,
		speechDb: l.speechDb,
		breath,
		keptBreath: (k) => breath(k) && !sound(k - 1) && !sound(k + 1),
	};
}

const power = (db: number) => 10 ** (db / 10);

/**
 * The words around an edge for its bounds (`edgeBounds`): bounding tokens only, and a word whose time holds the edge
 * clipped to the side holding most of its sound (so the midpoint rule puts it there).
 */
export function repairBoundWords(l: EdgeLevels, words: readonly Word[], t: number): Word[] {
	const out: Word[] = [];
	for (const w of words) {
		if (!boundingToken(w.text)) continue;
		if (!(w.s < t - 1e-9 && w.e > t + 1e-9)) {
			out.push(w);
			continue;
		}
		let before = 0;
		let after = 0;
		for (let k = Math.floor(w.s / FR + 1e-9); k * FR < w.e - 1e-9; k++) {
			const p = power(l.db(k));
			if ((k + 0.5) * FR < t) before += p;
			else after += p;
		}
		out.push(before >= after ? { ...w, e: t } : { ...w, s: t });
	}
	return out.sort((a, b) => a.s - b.s);
}

/**
 * How far a repair may keep more before another word's sound (media seconds): walking away from the kept side within
 * `EDGE_DECAY_S`, the boundary before a frame that lies in the time of a word on the cut-away side (one that begins after
 * an out edge / ends before an in edge, ±30 ms) and rises `EDGE_ONSET_RISE_DB` over a dip within `FOREIGN_DIP_DB` of
 * the quiet level — however soft that word is (`onsetBound` asks a rise over the speech level there; the soft "y" of
 * "y | y que", 764.53–764.58 at −27 dBFS after a dip to −39, was pulled back in front of the kept "y").
 */
export function foreignSoundBound(l: EdgeLevels, t: number, side: EdgeSide, words: readonly Word[]): number {
	const { quiet } = edgeThresholds(l);
	const out = side === 'out';
	const away = words.filter((w) => (out ? w.s >= t - 0.03 : w.e <= t + 0.03));
	const inAway = (k: number) => away.some((w) => (k + 1) * FR > w.s - 0.03 && k * FR < w.e + 0.03);
	const k0 = Math.round(t / FR - 1e-9);
	let min = Number.POSITIVE_INFINITY;
	for (let i = 0; i < Math.round(EDGE_DECAY_S / FR); i++) {
		const k = out ? k0 + i : k0 - 1 - i;
		if (k < 0 || k >= l.frameCount) break;
		const d = l.db(k);
		if (d < min) min = d;
		else if (min <= quiet + FOREIGN_DIP_DB && d >= min + EDGE_ONSET_RISE_DB && inAway(k))
			return out ? k * FR : (k + 1) * FR;
	}
	return out ? Number.POSITIVE_INFINITY : Number.NEGATIVE_INFINITY;
}

/**
 * Whether the span `[a, b)` an in edge's extension adds holds a sound of its own before the kept word's attack: a
 * frame under the speech level with a frame `EDGE_DIP_GAIN_DB` louder before it. An attack rises from quiet into the
 * word; a separate burst before it is another syllable — another word, a restart the transcript wrote once ("y | y
 * que": 764.53–764.57 at −24.5 dBFS on the voice analysis, a dip to −32.5, then the kept "y"), or the word's own first
 * syllable before a closure ("e|xtremadamente") — for review.
 */
function separateSound(l: EdgeLevels, a: number, b: number): boolean {
	const { loud } = edgeThresholds(l);
	let max = Number.NEGATIVE_INFINITY;
	for (let k = Math.round(a / FR - 1e-9); k < Math.round(b / FR - 1e-9); k++) {
		const d = l.db(k);
		if (d <= loud && max >= d + EDGE_DIP_GAIN_DB) return true;
		max = Math.max(max, d);
	}
	return false;
}

/** The kept sound beside an edge judged for `faded` (s): the review's "last 40 ms before the out point". */
const KEPT_S = 0.04;

/**
 * Whether the edge cuts only a faded word: the 50 ms cut away stay under the speech level and so do the `KEPT_S` kept
 * beside the edge. The by-ear review heard cut words where the kept side was still loud (its criterion for the 145
 * out points extended between revisions 323 and 475: the last 40 ms before over −26 dBFS); a soft tail under a faded
 * word is kept only when the reviewer asks (an extension adds time at every such join).
 */
function faded(l: EdgeLevels, t: number, side: EdgeSide): boolean {
	const { loud } = edgeThresholds(l);
	if (awayLevel(l, t, side) > loud) return false;
	const k = Math.round(t / FR - 1e-9);
	const n = Math.round(KEPT_S / FR);
	for (let i = 0; i < n; i++) if (l.db(side === 'out' ? k - 1 - i : k + i) > loud) return false;
	return true;
}

export type EdgeRepair = {
	/** The repaired edge (media seconds). */
	t: number;
	/** `extend`: the kept span grows into the media (keeps more); `trim`: it shrinks. */
	kind: 'extend' | 'trim';
	/** Whether it lands on a clean boundary and adds (or removes) only the cut word's own sound. */
	safe: boolean;
	/** Why a repair is left for review (absent when safe). */
	review?: 'speech-left' | 'word' | 'sound' | 'faded';
};

/**
 * The repair of a cut edge at media second `t` (see the module comment), or null when the edge is clean, has no
 * better boundary within reach, or its move would only change it within a frame. `candidates`: the boundaries it may
 * take (the clip's frame boundaries inside the media); `words`: the transcript words around it (media seconds).
 */
export function repairCut(
	levels: EdgeLevels,
	o: { t: number; side: EdgeSide; candidates: readonly number[]; words: readonly Word[] },
): EdgeRepair | null {
	const l = repairLevels(levels);
	const out = o.side === 'out';
	const own = edgeScore(l, o.t, o.side);
	if (own <= 0) return null;
	// closures stay inside the words as timed (`edgeInsideWord`); the bounds follow where the sound lies
	const words = o.words.filter((w) => boundingToken(w.text));
	const b0 = edgeBounds(repairBoundWords(l, words, o.t), o.t, o.side);
	const stop = foreignSoundBound(l, o.t, o.side, words);
	const bounds = {
		...b0,
		keepMore: out ? Math.min(b0.keepMore, stop) : Math.max(b0.keepMore, stop),
		keepSoft: out ? Math.min(b0.keepSoft, stop) : Math.max(b0.keepSoft, stop),
	};
	const s = snapCut(l, { t: o.t, side: o.side, ...bounds, candidates: o.candidates, words });
	if (Math.abs(s.t - o.t) < 1e-6) return null;
	const kind = (out ? s.t > o.t : s.t < o.t) ? 'extend' : 'trim';
	const [a, b] = o.t < s.t ? [o.t, s.t] : [s.t, o.t];
	// a word with most of its time inside the span: pulled in by an extension, cut by a trim
	const inside = words.some((w) => {
		const d = w.e - w.s;
		if (d <= 0) return false;
		if (kind === 'extend' && w.s - 0.03 <= o.t && o.t <= w.e + 0.03) return false;
		return (Math.min(w.e, b) - Math.max(w.s, a)) / d >= FOREIGN_WORD_SHARE - 1e-9;
	});
	if (s.clean) {
		if (inside) return { t: s.t, kind, safe: false, review: 'word' };
		if (kind === 'extend' && !out && separateSound(l, s.t, o.t))
			return { t: s.t, kind, safe: false, review: 'sound' };
		if (kind === 'extend' && faded(l, o.t, o.side)) return { t: s.t, kind, safe: false, review: 'faded' };
		return { t: s.t, kind, safe: true };
	}
	// no clean boundary within reach: an extension that is much better is offered for review
	if (kind !== 'extend' || s.score > own - EDGE_DIP_GAIN_DB || Math.abs(s.t - o.t) > EDGE_DECAY_S + 1e-9)
		return null;
	return { t: s.t, kind, safe: false, review: inside ? 'word' : 'speech-left' };
}
