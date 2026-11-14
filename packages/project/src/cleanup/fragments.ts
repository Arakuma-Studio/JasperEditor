// Short kept pieces between cuts (docs/wp-notes/transcript-cleanup.md "Stray fragments and A / V slivers"): a kept
// span of at most `FRAGMENT_MAX_S` with a cut on both sides that holds no script word — a filler, a laugh or a breath
// heard as a word, a syllable of another take, voice without words, or sound whose picture was taken away — is offered
// as a `fragment` finding. Round 12's sliver rule (`resolveSlivers`) covers pieces under `minSliverFrames` inside one
// clip; this one covers every short piece, whole short clips included (an already cut sequence keeps each piece as its
// own clip). Removed by default only when it is clearly a filler, a piece of another take (removed words on both
// sides) or sound without its picture that the script does not hold; else for review. Pure.
import type { Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import type { AWord } from './rules.ts';
import type { ScriptAligner } from './script.ts';

/**
 * Longest kept piece (s) judged here. The review's 47 stray pieces of rev 152 lasted 0.02–0.68 s, its kept
 * scripted short pieces ("Eso es todo.", "Mis juegos,") 0.42–0.68 s: script alignment, not length, separates them.
 */
export const FRAGMENT_MAX_S = 0.7;

/** Words of a piece whose script alignment in the output reaches this support (of 6 neighbours) are on script. */
const ON_SCRIPT_SUPPORT = 3;

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

/** The finding a short piece between cuts deserves (see the module comment), or null to keep it. */
export function shortPieceFinding(
	p: ShortPiece,
	c: FragmentContext,
): { why: FragmentWhy; suggested: 'remove' | 'review' } | null {
	if (!p.tokens.length) {
		if (p.voice) return { why: 'voice', suggested: p.betweenWords || p.orphan ? 'remove' : 'review' };
		return p.orphan ? { why: 'orphan', suggested: 'remove' } : null;
	}
	if (p.tokens.every((t) => c.fillers.has(t))) return { why: 'filler', suggested: 'remove' };
	const scripted = onScript(p, c);
	// sound under another moment's picture: removed when the script does not hold it (without a script, reviewed)
	if (p.orphan) return { why: 'orphan', suggested: c.aligner && !scripted ? 'remove' : 'review' };
	if (c.aligner && !scripted) return { why: 'off-script', suggested: p.betweenWords ? 'remove' : 'review' };
	return null;
}

type Span = [number, number];

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
			if (frames <= 0 || frames / fps > FRAGMENT_MAX_S + 1e-9) return;
			const atScope = (f: number) => !!o.scope && (f === o.scope.from || f === o.scope.to);
			const cutL =
				a > cp.extent[0] ||
				(a === cp.clip.start && !atScope(a) && cp.clip.sourceIn > 0 && !through(cp.clip, 'in'));
			const cutR =
				b < cp.extent[1] ||
				(b === cp.clip.start + cp.clip.duration && !atScope(b) && !through(cp.clip, 'out'));
			if (!cutL || !cutR) return;
			const [t0, t1] = [mediaAt(cp.clip, a), mediaAt(cp.clip, b)];
			const words = cp.words.filter((w) => (w.s + w.e) / 2 >= t0 && (w.s + w.e) / 2 < t1);
			const lo = pi > 0 ? cp.kept[pi - 1]![1] : cp.extent[0];
			const hi = pi + 1 < cp.kept.length ? cp.kept[pi + 1]![0] : cp.extent[1];
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
			});
		});
	});
	return { pieces, output };
}
