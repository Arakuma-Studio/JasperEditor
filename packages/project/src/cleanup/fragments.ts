// Short kept pieces between cuts (docs/wp-notes/transcript-cleanup.md "Stray fragments and A / V slivers"): a kept
// span of at most `FRAGMENT_MAX_S` with a cut on both sides that holds no script word — a filler, a laugh or a breath
// heard as a word, a syllable of another take, voice without words, or sound whose picture was taken away — is offered
// as a `fragment` finding. Round 12's sliver rule (`resolveSlivers`) covers pieces under `minSliverFrames` inside one
// clip; this one covers every short piece, whole short clips included (an already cut sequence keeps each piece as its
// own clip). Removed by default only when it is clearly a filler, a piece of another take (removed words on both
// sides), sound without its picture that the script does not hold or that is too short to hold a word of the takes
// beside it, or voice without words the script runs on across; else for review. Pure.
import type { Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import type { CleanupVoice } from './detector.ts';
import { edgeInsideWord, edgeLevelsOf, edgeThresholds } from './edge-snap.ts';
import type { AWord } from './rules.ts';
import type { ScriptAligner } from './script.ts';

/**
 * Longest kept piece (s) judged here. The review's 47 stray pieces of rev 152 lasted 0.02–0.68 s, its kept
 * scripted short pieces ("Eso es todo.", "Mis juegos,") 0.42–0.68 s: script alignment, not length, separates them.
 */
export const FRAGMENT_MAX_S = 0.7;

/** Words of a piece whose script alignment in the output reaches this support (of 6 neighbours) are on script. */
const ON_SCRIPT_SUPPORT = 3;

/**
 * Longest sound without its picture (s) that cannot hold a word on its own: it goes when its words are not said next to
 * the kept words beside it. *Assumption*, labelled: half a syllable (Spanish read speech runs at ≈ 5–7 syllables per
 * second, 0.14–0.2 s each). The four-frame slivers of the user's v7 review ("Y", "Aunque", "Me" at 60 fps, 0.067 s)
 * held a word only as the recogniser wrote it; rev 549 removed them, and kept the one said on from the shot before.
 */
const SUB_SYLLABLE_S = 0.1;

export type FragmentWhy = 'voice' | 'filler' | 'orphan' | 'off-script';

export type ShortPiece = {
	/** Normalised tokens of the kept words whose midpoint lies in the piece (`AWord.n`). */
	tokens: readonly string[];
	/** Where the piece's first token sits in `output` (the kept words of the media in sequence order). */
	at: number;
	/** Speech or voiced sound in the piece. */
	voice: boolean;
	/** Removed words' times lie in the cuts on both sides (a piece of another take). */
	betweenWords: boolean;
	/**
	 * The sound plays without its own picture: the media's picture is in the sequence, but no linked picture clip shows
	 * that moment (a picture sliver deleted or covered after the cut).
	 */
	orphan: boolean;
	/** Breath-like sound after a dip at the end (`tail`) or start (`head`) of a longer kept piece next to a cut. */
	edge?: 'head' | 'tail';
	/** Length (s). */
	seconds: number;
	/** Where the first kept word after the piece sits in `output` (`output.length` when none follows). */
	next: number;
	/**
	 * The piece is said apart from the kept words beside it in the output: the transcript has other words, or a pause of
	 * a take (`takeGapS`), between them — for a piece without words, between its voice and those words (voice that close
	 * may be a word whose timestamps the recogniser put beside it: "Una tortura. tortura." with the second word's voice
	 * in the next 0.27 s shot).
	 */
	detached: boolean;
	/**
	 * The piece's clip is itself a short shot between cuts: the edit left it alone, not this plan's cuts (a cough between
	 * two pauses this plan removes stays for its own finding, round 8 H5).
	 */
	ownShot: boolean;
};

export type FragmentContext = {
	/** The language's vocalic fillers (normalised). */
	fillers: ReadonlySet<string>;
	/** The attached script, or null. */
	aligner: ScriptAligner | null;
	/** Normalised tokens of the media's kept words in output order. */
	output: readonly string[];
};

/** Whether most of a piece's words sit in the script in the order the output plays them. */
function onScript(p: ShortPiece, c: FragmentContext): boolean {
	if (!c.aligner || !p.tokens.length) return false;
	let n = 0;
	for (let k = 0; k < p.tokens.length; k++)
		if (c.aligner.support(c.output, p.at + k) >= ON_SCRIPT_SUPPORT) n++;
	return n * 2 >= p.tokens.length;
}

/**
 * Whether the piece is a shot of its own whose neighbours' kept words the script says in a row: removing it loses no
 * script word.
 */
function scriptRunsOn(p: ShortPiece, c: FragmentContext): boolean {
	return (
		p.ownShot &&
		p.detached &&
		!!c.aligner &&
		p.next > 0 &&
		c.aligner.joins(c.output, p.next) >= ON_SCRIPT_SUPPORT
	);
}

/**
 * The finding a short piece between cuts deserves (see the module comment), or null to keep it. `waits`: the piece's
 * voice without words has its own finding left for review, which only the script running on across it overrides.
 */
export function shortPieceFinding(
	p: ShortPiece,
	c: FragmentContext,
	waits = false,
): { why: FragmentWhy; suggested: 'remove' | 'review' } | null {
	// a breath-like burst at a piece's end next to a cut (v8: "Appstore! | Y si", a fragment of another take written "Y")
	if (p.edge) return waits ? null : { why: 'voice', suggested: 'review' };
	if (!p.tokens.length) {
		if (waits) return p.voice && scriptRunsOn(p, c) ? { why: 'voice', suggested: 'remove' } : null;
		if (p.voice)
			return {
				why: 'voice',
				suggested: p.betweenWords || p.orphan || scriptRunsOn(p, c) ? 'remove' : 'review',
			};
		return p.orphan ? { why: 'orphan', suggested: 'remove' } : null;
	}
	if (p.tokens.every((t) => c.fillers.has(t))) return { why: 'filler', suggested: 'remove' };
	const scripted = onScript(p, c);
	// sound under another moment's picture: removed when the script does not hold it (without a script, reviewed), or
	// when it is too short to hold a word and its words are said apart from the kept words beside it: the recogniser's
	// word for a fragment of another take aligns with the script as well as the word itself
	if (p.orphan)
		return {
			why: 'orphan',
			suggested:
				(c.aligner && !scripted) || (p.detached && p.seconds <= SUB_SYLLABLE_S + 1e-9) ? 'remove' : 'review',
		};
	if (c.aligner && !scripted) return { why: 'off-script', suggested: p.betweenWords ? 'remove' : 'review' };
	return null;
}

type Span = [number, number];

/** Media seconds of a word (`i`: its transcript index) or of a piece's voice without words. */
export type Timed = { s: number; e: number; i?: number };

/** One speech clip's plan as the sequence planner leaves it (sequence frames; media seconds for words and times). */
export type ClipPieces = {
	clip: Sequence['clips'][string];
	/** The clip's part inside the scope (sequence frames). */
	extent: readonly [number, number];
	/** Kept pieces (sequence frames, sorted). */
	kept: ReadonlyArray<readonly [number, number]>;
	/** The clip's kept words. */
	words: readonly AWord[];
	/** The clip's removed words' times. */
	removedTimes: readonly Span[];
};

export type ShortPieceAt = ShortPiece & {
	/** Index into the `clips` given and the piece's index in its `kept`. */
	clip: number;
	piece: number;
	/** Media seconds. */
	start: number;
	end: number;
	frames: number;
	words: AWord[];
	/** For a head / tail burst: the sequence frames it removes from its piece. */
	cut?: [number, number];
};

/**
 * The short kept pieces between cuts of one media's speech clips (`clips`, every clip of the media in the plan), with
 * the output order of their kept words. A side of a piece is a cut when it ends inside the clip's extent (a removed
 * range), or at a clip edge that is not a through edit with the clip beside it on the track (same media, the source
 * running on) and not the edge of the scope. `voiceIn(t0, t1)` = speech or voiced sound in media seconds.
 */
export function findShortPieces(o: {
	seq: Pick<Sequence, 'clips' | 'links'>;
	rate: Rational;
	clips: readonly ClipPieces[];
	scope: { from: number; to: number } | null;
	voiceIn: (t0: number, t1: number) => boolean;
	/** The media's voice analysis: breath-like bursts at the ends of longer pieces (none without). */
	voice?: CleanupVoice | null;
	/**
	 * Whether the transcript says `b` right after `a` in one take (a piece's voice without words: no `i`, times only;
	 * without it, no piece is `detached`).
	 */
	saidNext?: (a: Timed, b: Timed) => boolean;
}): { pieces: ShortPieceAt[]; output: string[] } {
	const F = flicksPerFrame(o.rate);
	const fps = o.rate.num / o.rate.den;
	const mediaAt = (c: ClipPieces['clip'], f: number) => (c.sourceIn + (f - c.start) * F) / FLICKS_PER_SECOND;
	// the output order of the kept words
	const placed: Array<{ at: number; w: AWord; clip: number }> = [];
	o.clips.forEach((cp, ci) => {
		for (const [a, b] of cp.kept) {
			const [t0, t1] = [mediaAt(cp.clip, a), mediaAt(cp.clip, b)];
			for (const w of cp.words) {
				const mid = (w.s + w.e) / 2;
				if (mid >= t0 && mid < t1) placed.push({ at: a + (mid - t0) * fps, w, clip: ci });
			}
		}
	});
	placed.sort((x, y) => x.at - y.at);
	const output = placed.map((x) => x.w.n);
	const indexOf = new Map<AWord, number>();
	placed.forEach((x, k) => {
		if (!indexOf.has(x.w)) indexOf.set(x.w, k);
	});
	/** The output position of the first kept word at or after sequence frame `f`. */
	const nextAt = (f: number) => {
		const k = placed.findIndex((x) => x.at >= f);
		return k < 0 ? placed.length : k;
	};
	/** Whether a piece's words are said apart from the kept words played before and after them. */
	const detachedOf = (ws: readonly AWord[], next: number, t0: number, t1: number) => {
		if (!o.saidNext) return false;
		const [first, last]: Timed[] = ws.length
			? [ws[0]!, ws[ws.length - 1]!]
			: [
					{ s: t0, e: t1 },
					{ s: t0, e: t1 },
				];
		const before = placed[(ws.length ? (indexOf.get(ws[0]!) ?? 0) : next) - 1]?.w;
		const after = placed[next]?.w;
		return !(before && o.saidNext(before, first!)) && !(after && o.saidNext(last!, after));
	};
	const others = Object.values(o.seq.clips);
	/** A clip edge (`side`) continued by the clip beside it on the same track: the same media, the source running on. */
	const through = (c: ClipPieces['clip'], side: 'in' | 'out') =>
		others.some((d) => {
			if (d.id === c.id || d.trackId !== c.trackId || !d.enabled) return false;
			if (!('mediaId' in d) || !('mediaId' in c) || d.mediaId !== c.mediaId) return false;
			if (side === 'out')
				return (
					d.start === c.start + c.duration && Math.abs(d.sourceIn - (c.sourceIn + c.duration * F)) < F / 2
				);
			return d.start + d.duration === c.start && Math.abs(d.sourceIn + d.duration * F - c.sourceIn) < F / 2;
		});
	/** Whether a linked picture clip shows frames `[a, b)` of this clip at the same moment of the source. */
	const pictured = (c: ClipPieces['clip'], a: number, b: number) => {
		const link = c.linkId ? o.seq.links[c.linkId] : undefined;
		for (const id of link?.members ?? []) {
			const d = o.seq.clips[id];
			if (!d || d.id === c.id || !d.enabled || d.kind !== 'video') continue;
			if (
				d.start <= a &&
				d.start + d.duration >= b &&
				Math.abs(d.sourceIn - d.start * F - (c.sourceIn - c.start * F)) < F / 2
			)
				return true;
		}
		return false;
	};
	// sound can lose its picture only where the media's picture is in the sequence (never in an audio-only edit)
	const pictureOf = new Set(
		others.filter((d) => d.kind === 'video' && d.enabled).map((d) => (d as { mediaId: string }).mediaId),
	);
	const pieces: ShortPieceAt[] = [];
	o.clips.forEach((cp, ci) => {
		cp.kept.forEach(([a, b], pi) => {
			const frames = b - a;
			const atScope = (f: number) => !!o.scope && (f === o.scope.from || f === o.scope.to);
			const cutL =
				a > cp.extent[0] ||
				(a === cp.clip.start && !atScope(a) && cp.clip.sourceIn > 0 && !through(cp.clip, 'in'));
			const cutR =
				b < cp.extent[1] ||
				(b === cp.clip.start + cp.clip.duration && !atScope(b) && !through(cp.clip, 'out'));
			if (frames > 0 && frames / fps > FRAGMENT_MAX_S + 1e-9) {
				// a longer piece: a breath-like burst after a dip at an end next to a cut
				for (const edge of ['tail', 'head'] as const) {
					if (!o.voice || !(edge === 'tail' ? cutR : cutL)) continue;
					const burst = edgeBurst(o.voice, mediaAt(cp.clip, a), mediaAt(cp.clip, b), edge, cp.words);
					if (!burst) continue;
					const f = Math.round(cp.clip.start + (burst * FLICKS_PER_SECOND - cp.clip.sourceIn) / F);
					const [x, y] = edge === 'tail' ? [f, b] : [a, f];
					if (y - x <= 0 || x <= a - (edge === 'head' ? 1 : 0) - 1) continue;
					const [u0, u1] = [mediaAt(cp.clip, x), mediaAt(cp.clip, y)];
					const ws = cp.words.filter((w) => (w.s + w.e) / 2 >= u0 && (w.s + w.e) / 2 < u1);
					pieces.push({
						clip: ci,
						piece: pi,
						start: u0,
						end: u1,
						frames: y - x,
						words: ws,
						tokens: ws.map((w) => w.n),
						at: ws.length ? (indexOf.get(ws[0]!) ?? 0) : 0,
						voice: true,
						betweenWords: false,
						orphan: false,
						edge,
						cut: [x, y],
						seconds: u1 - u0,
						next: nextAt(y),
						detached: false,
						ownShot: false,
					});
				}
				return;
			}
			if (frames <= 0 || !cutL || !cutR) return;
			const [c0, c1] = [cp.clip.start, cp.clip.start + cp.clip.duration];
			const ownShot =
				cp.extent[0] === c0 &&
				cp.extent[1] === c1 &&
				(c1 - c0) / fps <= FRAGMENT_MAX_S + 1e-9 &&
				!atScope(c0) &&
				!atScope(c1) &&
				cp.clip.sourceIn > 0 &&
				!through(cp.clip, 'in') &&
				!through(cp.clip, 'out');
			const [t0, t1] = [mediaAt(cp.clip, a), mediaAt(cp.clip, b)];
			const words = cp.words.filter((w) => (w.s + w.e) / 2 >= t0 && (w.s + w.e) / 2 < t1);
			const lo = pi > 0 ? cp.kept[pi - 1]![1] : cp.extent[0];
			const hi = pi + 1 < cp.kept.length ? cp.kept[pi + 1]![0] : cp.extent[1];
			const next = nextAt(b);
			const removedIn = (x: number, y: number) =>
				cp.removedTimes.some(([p, q]) => p < y - 1e-9 && q > x + 1e-9);
			pieces.push({
				clip: ci,
				piece: pi,
				start: t0,
				end: t1,
				frames,
				words,
				tokens: words.map((w) => w.n),
				at: words.length ? (indexOf.get(words[0]!) ?? 0) : 0,
				voice: o.voiceIn(t0, t1),
				betweenWords:
					lo < a && hi > b && removedIn(mediaAt(cp.clip, lo), t0) && removedIn(t1, mediaAt(cp.clip, hi)),
				orphan: 'mediaId' in cp.clip && pictureOf.has(cp.clip.mediaId) && !pictured(cp.clip, a, b),
				seconds: t1 - t0,
				next,
				detached: detachedOf(words, next, t0, t1),
				ownShot,
			});
		});
	});
	return { pieces, output };
}

/** Longest breath-like burst at a piece's end judged (s). */
const BURST_MAX_S = 0.3;

/**
 * Where a breath-like burst at the `edge` of a kept piece `[t0, t1)` (media seconds) begins (tail) or ends (head): the
 * sound after (before) the last (first) dip of ≥ 20 ms within 2 dB of the quiet level, at most `BURST_MAX_S` long,
 * mostly unvoiced (mean voicing under 0.5), not quiet, and not after a closure inside a word (`edgeInsideWord`); null
 * when there is none.
 */
function edgeBurst(
	v: CleanupVoice,
	t0: number,
	t1: number,
	edge: 'head' | 'tail',
	words: readonly AWord[],
): number | null {
	if (!v.voicing) return null;
	const L = edgeLevelsOf(v);
	const { quiet } = edgeThresholds(L);
	const n = Math.round(BURST_MAX_S / 0.01);
	const k0 = Math.round(t0 / 0.01);
	const k1 = Math.round(t1 / 0.01);
	const dip = (k: number) => L.db(k) <= quiet + 2;
	for (let i = 2; i <= n && k1 - i - 2 > k0; i++) {
		// the burst: frames [k1 - i, k1) (tail) or [k0, k0 + i) (head); the dip: the two frames beyond it
		const [b0, b1] = edge === 'tail' ? [k1 - i, k1] : [k0, k0 + i];
		const [d0, d1] = edge === 'tail' ? [b0 - 2, b0] : [b1, b1 + 2];
		if (!dip(d0) || !dip(d1 - 1)) continue;
		let voicing = 0;
		let loud = -120;
		for (let k = b0; k < b1; k++) {
			voicing += (v.voicing[k] ?? 0) / 255;
			loud = Math.max(loud, L.db(k));
		}
		// only the decay so far: look further for the burst; a voiced syllable is no breath
		if (loud <= quiet + 6) continue;
		if (voicing / (b1 - b0) >= 0.5) return null;
		// a closure inside a word is that word's ("pa|tas.", "espa|cio."): its last syllable, no burst
		const at = (edge === 'tail' ? b0 : b1) * 0.01;
		if (edgeInsideWord(L, words, at)) return null;
		return at;
	}
	return null;
}
