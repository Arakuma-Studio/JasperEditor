// Text-based editing: the sequence transcript and the edits made through it. Ported from FilmCraft
// `crates/edit/src/transcript.rs`; see licenses/ported/captions.md.
//
// Media transcripts hold words in media content time (flicks). The sequence transcript (`sequenceWords`) maps
// them through the audio clips that play them:
// - audio tracks are read top first (A1, A2…); a word is taken from the first track whose transcribed clip covers
//   the word's midpoint, so dialogue duplicated on two tracks (or a stereo pair split over two mono tracks) reads
//   once;
// - a word belongs to a clip when its midpoint, mapped through the clip's speed, falls inside the clip; its
//   timeline bounds are clamped to the clip, so a word cut by an edit is shown cut;
// - a word whose start a clip's In cuts off also belongs to that clip when the cut-off part (holding its midpoint) is
//   played by no clip of the track and the clip plays at least `CUT_START_MIN_SHARE` of it (`heardFromCutStart`):
//   speech to text starts a word after a pause early (it takes in the silence or breath before it), so the In a cut
//   puts at the voice onset of a kept take often lands past the word's midpoint and the take lost its first word
//   (the reporter's cut: "Y si alguno…" read "si alguno…"; measured on that cut, docs/wp-notes/captions.md);
// - a word shorter than `MIN_HEARD_WORD_SECONDS` (a zero-length leftover of an edit) is heard through no clip;
// - a short word stranded at a clip's tail right after the clip's sentence end, when the next clip on the track follows
//   straight on and speaks, is not heard through that clip (`tailFragmentIndex`): a fragment of another take, a breath written as
//   a word, or the start of the next scene's phrase ("Appstore! | Y si alguno…": "Y" showed in the previous scene);
// - disabled clips and reversed clips contribute no words.
// Word ranges become timeline ranges (`wordRangeFrames`) snapped outward to frames; pause and filler removal
// produce many ranges that are ripple-deleted in one pass, right to left. Captions come from `captionBlocks`.
import type { ProjectDocument } from '../schema/document.ts';
import type { Transcript } from '../schema/media.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, type Rational } from '../time.ts';
import { frameAt, frameDuration, snapDown, snapNearest, tickOf } from './formats/rate.ts';
import { normalizeWord } from './words.ts';

/** A word of the sequence transcript. Times are sequence time in flicks. */
export type SeqWord = {
	text: string;
	start: number;
	end: number;
	/** The clip it is heard through, that clip's media and transcript, and the word's index there. */
	clipId: string;
	mediaId: string;
	transcriptId: string;
	index: number;
	/** Audio track index (0 = A1). */
	track: number;
	/** Speaker key in the transcript (`speakers`) and its display name. */
	speakerKey: string | null;
	speaker: string | null;
	confidence: number | null;
};

/**
 * Share of a word a clip must play for the word to follow the clip when the clip's In cuts off its start and nothing
 * plays the cut-off part (see `heardFromCutStart`). Measured on the reporter's cut (rev 144 → rev 267, 33 kept-take
 * first words straddling an In): every word kept at ≥ 20 % was the take's own; the removed takes' words reaching into
 * a kept clip did so by ≤ 10 %. An assumption beyond that recording.
 */
export const CUT_START_MIN_SHARE = 0.2;

/**
 * Whether a word (media flicks) cut off at a clip's In (`clipIn`) is heard through that clip although its midpoint lies
 * before the In: the clip plays at least `CUT_START_MIN_SHARE` of it and `playedElsewhere(midpoint)` is false (no other
 * clip of the track plays the cut-off part). Words cut at a clip's Out keep the midpoint rule: there the early start of
 * the next take's first word reaches into the clip.
 */
export function heardFromCutStart(
	w: { start: number; end: number },
	clipIn: number,
	clipOut: number,
	playedElsewhere: (mediaTime: number) => boolean,
): boolean {
	const len = w.end - w.start;
	if (!(len > 0) || !(w.start < clipIn) || !(w.end > clipIn)) return false;
	const mid = w.start + len / 2;
	if (mid >= clipIn) return false;
	const inside = Math.min(w.end, clipOut) - clipIn;
	return inside >= CUT_START_MIN_SHARE * len && !playedElsewhere(mid);
}

/** Words shorter than this (seconds) are no sound: zero-length leftovers of edits ("En" 7 ms, "tortura." 10 ms). */
export const MIN_HEARD_WORD_SECONDS = 0.02;
/** A clip's last word this short (seconds, played)… */
const TAIL_FRAGMENT_SECONDS = 0.25;
/** …ending this close to the clip's Out (seconds), after a sentence end, is a fragment when the next clip speaks. */
const TAIL_GAP_SECONDS = 0.15;
/**
 * …and follows that sentence end this closely (seconds): speech to text squeezed it against the sentence end. A
 * sentence really started there has a pause before it ("…me. I uh love" with the filler cut keeps "I").
 */
const TAIL_SQUEEZE_SECONDS = 0.12;
/** A tail word this short is a fragment even with its own sentence end ("y." 60 ms). */
const FRAGMENT_SECONDS = 0.1;
/** A word that ends a sentence: . ! ? (an ellipsis suspends it: "de todas… es que"). */
const endsSentence = (t: string) => {
	const x = t.trim();
	return /[.!?]["'»”’)\]]*$/u.test(x) && !/(\.\.\.|…)["'»”’)\]]*$/u.test(x);
};

/**
 * The transcript index of a clip's last heard word when it is a tail fragment (see the file comment), else −1. `words`
 * are the clip's transcript words; `clipIn` / `clipOut` its media range; `speed` its rate.
 */
function tailFragmentIndex(
	words: Transcript['words'],
	clipIn: number,
	clipOut: number,
	speed: number,
): number {
	const fps = FLICKS_PER_SECOND;
	const minLen = MIN_HEARD_WORD_SECONDS * fps;
	const inClip = (k: number) => {
		const w = words[k];
		if (!w || w.end - w.start < minLen) return false;
		const mid = w.start + (w.end - w.start) / 2;
		return mid >= clipIn && mid < clipOut;
	};
	let k = Math.min(words.length - 1, firstEndingAfter(words, clipOut));
	while (k >= 0 && words[k]!.end > clipIn && !inClip(k)) k--;
	if (k < 0 || !inClip(k)) return -1;
	const w = words[k]!;
	const played = (Math.min(w.end, clipOut) - Math.max(w.start, clipIn)) / speed;
	if (played >= TAIL_FRAGMENT_SECONDS * fps) return -1;
	if ((clipOut - Math.min(w.end, clipOut)) / speed > TAIL_GAP_SECONDS * fps) return -1;
	let p = k - 1;
	while (p >= 0 && words[p]!.end - words[p]!.start < minLen) p--;
	// the clip says something before it that ends a sentence (a clip that is only this word is its own scene)
	if (p < 0 || !inClip(p) || !endsSentence(words[p]!.text)) return -1;
	if ((w.start - words[p]!.end) / speed > TAIL_SQUEEZE_SECONDS * fps) return -1;
	if (endsSentence(w.text) && played >= FRAGMENT_SECONDS * fps) return -1;
	return k;
}

/** The transcript used for a media: the most recently added one with that `mediaId`. */
export function transcriptForMedia(
	doc: Pick<ProjectDocument, 'transcripts'>,
	mediaId: string,
): Transcript | null {
	let found: Transcript | null = null;
	for (const t of Object.values(doc.transcripts)) if (t.mediaId === mediaId) found = t;
	return found;
}

/** Display name of a word's speaker (`Speaker N` for a key without a name). */
export function speakerName(t: Transcript, key: string | null): string | null {
	if (key === null) return null;
	const s = t.speakers[key];
	if (s?.name) return s.name;
	const keys = Object.keys(t.speakers);
	const i = keys.indexOf(key);
	return `Speaker ${i >= 0 ? i + 1 : key}`;
}

/** Index of the first word whose end is after `t` (words sorted). */
function firstEndingAfter(words: Transcript['words'], t: number): number {
	let lo = 0;
	let hi = words.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (words[mid]!.end <= t) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

/**
 * The sequence transcript: words of every transcribed audio clip, in sequence time order. `only` restricts the words
 * returned to word indices `[from, to)` of one transcript (the same mapping and claims: spec 17 SC-051 patches the
 * subtitles of exactly the words an edit replaced).
 */
export function sequenceWords(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Sequence,
	only?: { transcriptId: string; from: number; to: number },
): SeqWord[] {
	const rate = seq.settings.frameRate;
	const F = tickOf(1, rate);
	const out: SeqWord[] = [];
	// timeline ranges (flicks) already served by a higher track's transcribed clips
	const claimed: Array<[number, number]> = [];
	const byTrack = new Map<string, Clip[]>();
	for (const c of Object.values(seq.clips)) {
		const list = byTrack.get(c.trackId);
		if (list) list.push(c);
		else byTrack.set(c.trackId, [c]);
	}
	const plays = (c: Clip) => c.kind === 'audio' && c.enabled && !c.speed.reverse && c.speed.rate > 0;
	seq.audioTracks.forEach((track, ti) => {
		const mine: Array<[number, number]> = [];
		const clips = (byTrack.get(track.id) ?? []).sort((a, b) => a.start - b.start);
		// media ranges each media's clips on this track play (for words cut off at an In)
		const played = new Map<string, Array<[number, number]>>();
		for (const c of clips) {
			if (c.kind !== 'audio' || !plays(c)) continue;
			const list = played.get(c.mediaId) ?? [];
			list.push([c.sourceIn, c.sourceIn + Math.round(c.duration * F * c.speed.rate)]);
			played.set(c.mediaId, list);
		}
		// a clip's tail fragment is not heard when the next clip on the track follows straight on and speaks
		const speaks = (c: Clip | undefined): boolean => {
			if (c?.kind !== 'audio' || !plays(c)) return false;
			const t = transcriptForMedia(doc, c.mediaId);
			if (!t) return false;
			const a = c.sourceIn;
			const b = c.sourceIn + Math.round(c.duration * F * c.speed.rate);
			for (let k = firstEndingAfter(t.words, a); k < t.words.length && t.words[k]!.start < b; k++) {
				const w = t.words[k]!;
				const mid = w.start + (w.end - w.start) / 2;
				if (w.end - w.start >= MIN_HEARD_WORD_SECONDS * FLICKS_PER_SECOND && mid >= a && mid < b) return true;
			}
			return false;
		};
		for (const [ci, c] of clips.entries()) {
			if (c.kind !== 'audio' || !plays(c)) continue;
			const tr = transcriptForMedia(doc, c.mediaId);
			if (!tr) continue;
			const speed = c.speed.rate;
			const clipStart = tickOf(c.start, rate);
			const clipEnd = tickOf(c.start + c.duration, rate);
			mine.push([clipStart, clipEnd]);
			const mediaEnd = c.sourceIn + Math.round(c.duration * F * speed);
			const toTl = (m: number) => clipStart + Math.round((m - c.sourceIn) / speed);
			if (only && only.transcriptId !== tr.id) continue;
			const next = clips[ci + 1];
			const fragment =
				next && next.start === c.start + c.duration && speaks(next)
					? tailFragmentIndex(tr.words, c.sourceIn, mediaEnd, speed)
					: -1;
			const last = only ? Math.min(only.to, tr.words.length) : tr.words.length;
			for (let wi = Math.max(firstEndingAfter(tr.words, c.sourceIn), only?.from ?? 0); wi < last; wi++) {
				const w = tr.words[wi]!;
				if (w.start >= mediaEnd) break;
				if (wi === fragment || w.end - w.start < MIN_HEARD_WORD_SECONDS * FLICKS_PER_SECOND) continue;
				const a = toTl(w.start);
				const b = toTl(Math.max(w.end, w.start));
				let mid = a + Math.floor((b - a) / 2);
				if (
					mid < clipStart &&
					heardFromCutStart(w, c.sourceIn, mediaEnd, (m) =>
						(played.get(c.mediaId) ?? []).some(([s, e]) => m >= s && m < e),
					)
				)
					mid = clipStart + Math.floor((Math.min(b, clipEnd) - clipStart) / 2);
				if (mid < clipStart || mid >= clipEnd || claimed.some(([s, e]) => mid >= s && mid < e)) continue;
				const s = Math.max(a, clipStart);
				out.push({
					text: w.text,
					start: s,
					end: Math.max(s, Math.min(b, clipEnd)),
					clipId: c.id,
					mediaId: c.mediaId,
					transcriptId: tr.id,
					index: wi,
					track: ti,
					speakerKey: w.speaker,
					speaker: speakerName(tr, w.speaker),
					confidence: w.confidence,
				});
			}
		}
		claimed.push(...mine);
	});
	out.sort((a, b) => a.start - b.start || a.track - b.track);
	return out;
}

/** Index of the word being spoken at `t` (flicks): the last word starting at or before `t` that ends after it. */
export function wordAt(words: readonly { start: number; end: number }[], t: number): number | null {
	let lo = 0;
	let hi = words.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (words[mid]!.start <= t) lo = mid + 1;
		else hi = mid;
	}
	const i = lo - 1;
	return i >= 0 && t < words[i]!.end ? i : null;
}

/** Paragraphs: runs of words split where the speaker changes or at a pause of at least `gap` flicks. */
export function paragraphs(words: readonly SeqWord[], gap: number): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	let a = 0;
	for (let i = 1; i <= words.length; i++) {
		if (
			i === words.length ||
			words[i]!.speaker !== words[i - 1]!.speaker ||
			words[i]!.start - words[i - 1]!.end >= gap
		) {
			if (a < i) out.push([a, i]);
			a = i;
		}
	}
	return out;
}

/**
 * Matches of `query` (one or more words, case and punctuation ignored; the last query word may be a prefix) as
 * half-open word index ranges.
 */
export function searchWords(words: readonly { text: string }[], query: string): Array<[number, number]> {
	const q = query
		.split(/\s+/)
		.map(normalizeWord)
		.filter((s) => s.length > 0);
	if (!q.length) return [];
	const norm = words.map((w) => normalizeWord(w.text));
	const out: Array<[number, number]> = [];
	for (let i = 0; i + q.length <= norm.length; i++) {
		let ok = true;
		for (let k = 0; k < q.length && ok; k++)
			ok = k + 1 === q.length ? norm[i + k]!.startsWith(q[k]!) : norm[i + k] === q[k];
		if (ok) out.push([i, i + q.length]);
	}
	return out;
}

/** Timeline range of words `a..=b` (flicks), snapped outward to frames: `[startFrame, endFrame)`. */
export function wordRangeFrames(
	words: readonly { start: number; end: number }[],
	a: number,
	b: number,
	rate: Rational,
): [number, number] | null {
	const lo = Math.min(a, b);
	const hi = Math.max(a, b);
	const wa = words[lo];
	const wb = words[hi];
	if (!wa || !wb || lo < 0) return null;
	const s = frameAt(wa.start, rate);
	let e = frameAt(wb.end, rate);
	if (tickOf(e, rate) < wb.end || e <= s) e += 1;
	return [s, e];
}

/** Media range (flicks) of transcript words `a..=b` snapped outward to frames of `rate`. */
export function mediaWordRange(t: Transcript, a: number, b: number, rate: Rational): [number, number] | null {
	const r = wordRangeFrames(t.words, a, b, rate);
	return r ? [tickOf(r[0], rate), tickOf(r[1], rate)] : null;
}

/**
 * Pauses between consecutive words of at least `min` flicks, as frame ranges to remove: each keeps `keep` flicks
 * of silence after the previous word and `keepBefore` (default `keep`) before the next one, and is snapped inward to
 * frames (pauses shorter than a frame after that are skipped).
 */
export function findPauses(
	words: readonly { start: number; end: number }[],
	min: number,
	keep: number,
	rate: Rational,
	keepBefore: number = keep,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (let i = 0; i + 1 < words.length; i++) {
		const a = words[i]!.end;
		const b = words[i + 1]!.start;
		if (b - a < min || b <= a) continue;
		const s = a + keep;
		const e = b - keepBefore;
		let s2 = frameAt(s, rate);
		if (tickOf(s2, rate) < s) s2 += 1;
		const e2 = frameAt(e, rate);
		if (e2 > s2) out.push([s2, e2]);
	}
	return out;
}

/** The default filler words (configurable per command and in preferences). FilmCraft's list plus "uhm". */
export const DEFAULT_FILLERS: readonly string[] = [
	'um',
	'uh',
	'umm',
	'uhm',
	'erm',
	'er',
	'ah',
	'hmm',
	'mm',
	'mhm',
];

/**
 * Filler words: half-open word index ranges matching one of `fillers` (a word or a phrase such as "you know";
 * case and punctuation ignored). Longest phrases win ("you know" before "you").
 */
export function findFillers(
	words: readonly { text: string }[],
	fillers: readonly string[],
): Array<[number, number]> {
	const norm = words.map((w) => normalizeWord(w.text));
	const phrases = fillers
		.map((f) =>
			f
				.split(/\s+/)
				.map(normalizeWord)
				.filter((s) => s.length > 0),
		)
		.filter((p) => p.length > 0)
		.sort((x, y) => y.length - x.length);
	const out: Array<[number, number]> = [];
	let i = 0;
	while (i < norm.length) {
		const hit = phrases.find((p) => i + p.length <= norm.length && p.every((w, k) => norm[i + k] === w));
		if (hit) {
			out.push([i, i + hit.length]);
			i += hit.length;
		} else i++;
	}
	return out;
}

/**
 * Frame ranges removing the filler words `hits`: each word range snapped to the nearest frames, never into the
 * neighbouring words' frames.
 */
export function fillerRanges(
	words: readonly { start: number; end: number }[],
	hits: ReadonlyArray<[number, number]>,
	rate: Rational,
): Array<[number, number]> {
	const out: Array<[number, number]> = [];
	for (const [ha, hb] of hits) {
		const a = ha;
		const b = hb - 1;
		let s = frameAt(snapNearest(words[a]!.start, rate), rate);
		let e = frameAt(snapNearest(words[b]!.end, rate), rate);
		if (a > 0 && tickOf(s, rate) < words[a - 1]!.end) s = frameAt(words[a - 1]!.end, rate) + 1;
		const n = words[b + 1];
		if (n && tickOf(e, rate) > n.start) e = frameAt(n.start, rate);
		if (e > s) out.push([s, e]);
	}
	return out;
}

/** Sort and merge frame ranges (overlapping or touching). */
export function mergeRanges(r: ReadonlyArray<[number, number]>): Array<[number, number]> {
	const sorted = [...r].sort((a, b) => a[0] - b[0]);
	const out: Array<[number, number]> = [];
	for (const x of sorted) {
		const l = out[out.length - 1];
		if (l && x[0] <= l[1]) l[1] = Math.max(l[1], x[1]);
		else out.push([x[0], x[1]]);
	}
	return out;
}

/** Rules for Create Captions from a transcript (Premiere's dialog defaults). */
export type CaptionRules = {
	/** Maximum characters per line. */
	maxChars: number;
	/** Lines per caption (1 = single, 2 = double). */
	lines: number;
	/** Minimum caption duration (flicks); a short caption extends into the following silence, never over the next. */
	minDuration: number;
	/** Longest caption (flicks). */
	maxDuration: number;
	/** Frames left empty between consecutive captions. */
	gapFrames: number;
	/** A pause at least this long (flicks) starts a new caption. */
	breakPause: number;
};

export const DEFAULT_CAPTION_RULES: CaptionRules = {
	maxChars: 42,
	lines: 2,
	minDuration: FLICKS_PER_SECOND,
	maxDuration: 7 * FLICKS_PER_SECOND,
	gapFrames: 0,
	breakPause: FLICKS_PER_SECOND,
};

/** A caption block made from words. Times are flicks on the frame grid. */
export type CaptionBlock = {
	start: number;
	end: number;
	/** Lines joined by `\n`. */
	text: string;
	speaker: string | null;
	/** Half-open word index range it shows. */
	words: [number, number];
	/** Index (within `words`) of the first word of each line after the first. */
	lineStarts: number[];
};

const charCount = (s: string) => [...s].length;

/**
 * Lay words out as caption blocks: words fill lines of at most `maxChars` (a longer single word gets a line of
 * its own) and blocks of `lines` lines; a new block starts at a speaker change, at a pause of `breakPause`, after
 * `maxDuration`, after sentence-ending punctuation once the block is past half full, or at a word with
 * `breakBefore: 'segment'`. Times are snapped to frames, blocks never overlap and keep `gapFrames` between them.
 */
export function captionBlocks(
	words: ReadonlyArray<{
		text: string;
		start: number;
		end: number;
		speaker?: string | null;
		breakBefore?: string;
	}>,
	rules: CaptionRules,
	rate: Rational,
): CaptionBlock[] {
	const maxChars = Math.max(1, Math.floor(rules.maxChars));
	const maxLines = Math.max(1, Math.floor(rules.lines));
	const capChars = maxChars * maxLines;
	const groups: Array<[number, number]> = [];
	let a = 0;
	let lines: number[] = [0];
	for (let i = 0; i < words.length; i++) {
		const w = words[i]!;
		const len = charCount(w.text);
		if (i > a) {
			const prev = words[i - 1]!;
			const cur = lines[lines.length - 1] ?? 0;
			const fitsLine = cur + 1 + len <= maxChars;
			const fits = fitsLine || lines.length < maxLines;
			const used = lines.reduce((x, y) => x + y, 0) + lines.length - 1;
			const sentenceEnd = /[.?!]$/.test(prev.text) && used * 2 >= capChars;
			const brk =
				!fits ||
				(w.speaker ?? null) !== (prev.speaker ?? null) ||
				w.start - prev.end >= rules.breakPause ||
				w.end - words[a]!.start > rules.maxDuration ||
				sentenceEnd ||
				w.breakBefore === 'segment';
			if (brk) {
				groups.push([a, i]);
				a = i;
				lines = [len];
				continue;
			}
			if (fitsLine) lines[lines.length - 1] = cur + 1 + len;
			else lines.push(len);
		} else lines = [len];
	}
	if (a < words.length) groups.push([a, words.length]);
	const fd = frameDuration(rate);
	const gap = fd * Math.max(0, Math.floor(rules.gapFrames));
	const out: CaptionBlock[] = [];
	for (const [g0, g1] of groups) {
		const textLines: string[] = [''];
		const lineStarts: number[] = [];
		for (let k = g0; k < g1; k++) {
			const w = words[k]!;
			const l = textLines[textLines.length - 1]!;
			if (!l) textLines[textLines.length - 1] = w.text;
			else if (charCount(l) + 1 + charCount(w.text) <= maxChars)
				textLines[textLines.length - 1] = `${l} ${w.text}`;
			else {
				textLines.push(w.text);
				lineStarts.push(k - g0);
			}
		}
		const start = snapDown(words[g0]!.start, rate);
		let end = snapDown(words[g1 - 1]!.end, rate);
		if (end < words[g1 - 1]!.end) end += fd;
		out.push({
			start,
			end: Math.max(end, start + fd),
			text: textLines.join('\n'),
			speaker: words[g0]!.speaker ?? null,
			words: [g0, g1],
			lineStarts,
		});
	}
	// no overlaps, minimum duration (into the silence after a block, never over the next one)
	for (let i = 0; i < out.length; i++) {
		if (i > 0) {
			const minStart = out[i - 1]!.end + gap;
			if (out[i]!.start < minStart) {
				out[i]!.start = minStart;
				out[i]!.end = Math.max(out[i]!.end, minStart + fd);
			}
		}
		const next = out[i + 1]?.start;
		const b = out[i]!;
		if (b.end - b.start < rules.minDuration) {
			const want = b.start + rules.minDuration;
			let e = snapDown(want, rate);
			if (e < want) e += fd;
			b.end = e;
		}
		if (next !== undefined) b.end = Math.max(Math.min(b.end, next - gap), b.start + fd);
	}
	return out;
}
