// Repeats in the edit (docs/wp-notes/transcript-cleanup.md "Repeats at cuts"): a phrase the listener hears twice
// because a cut joined an abandoned start of it to the take that says it again ("y si | y si buscas", "No | no
// había"), or a stutter left inside one kept span ("tiene que… tiene que"). The stored transcript often holds one copy
// (Whisper merges back-to-back takes), so the words come from a VAD-chunked transcription of each kept span (padded
// `EDIT_SPAN_PAD_S`, decoded on its own) or of the sequence's mixdown (the closed loop), supplied by the caller (the
// engine's speech service). Pure.
//
// The words of the kept spans, in sequence order, form the edit's word stream (sequence time). Two passes find repeats
// in it:
//   1. At every position (each cut, and inside a span where the recogniser wrote a restart), the last ≤ 5 words before
//      it (the attempt) are compared with the first ≤ 6 after it (the retry) with the detector's ASR-tolerant word match
//      (`sameWord`: variants, digits ≡ number words, a cut-off "jue…" / "jue-" as a prefix): every attempt word must be
//      said again, in order, the first among the retry's first two words. Inside a span it needs the recogniser's trace
//      of a restart — the attempt's last word written cut off, or two or more words repeated verbatim.
//   2. The detector's own rules (`detectCleanup`: restarts, false starts, retakes, stutters with their guards) over the
//      stream, for longer takes.
// The earlier copy is proposed for removal — the later take is kept whole — from its first word to the cut (whole
// spans in between) or to the retry's onset. Precision first: removed by default only when the attempt is said again in
// full, right before the retry (only fillers between), the retry goes on after it, and it does not end a sentence;
// else for review. A deliberate repetition — words of the allow list ("no, no"), a reduplication ("boing, boing",
// "Guiño, guiño."), or what the script itself says twice — is never proposed when its copies were said one after the
// other in the recording; when a cut joined copies said apart, it is only reviewed. Closed-loop findings (mixdown
// words) are always for review.
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import {
	type CleanupVoice,
	type CleanupWordIn,
	detectCleanup,
	effectiveLists,
	findingFingerprint,
} from './detector.ts';
import { cleanupLanguageOf, cleanupNorm, sameWord } from './lists.ts';
import { CUT_OFF, SENTENCE_END } from './rules.ts';
import type { CleanupFinding, CleanupLists, CleanupSettings, FindingKind } from './schema.ts';

/** Seconds of audio decoded on each side of a kept span (Whisper loses a word cut at the very edge of its input). */
export const EDIT_SPAN_PAD_S = 0.2;
/**
 * The padding of the second, confirming decode of each span: other audio around the span moves the VAD chunk
 * boundaries and the decoder's context, so the two decodes are independent where it matters (a doubled word one decode
 * writes alone is not confirmed).
 */
export const EDIT_SPAN_CONFIRM_PAD_S = 0.6;
/** At most this many words before a position form an attempt… */
const ATTEMPT_WORDS = 5;
/** …and this many after it the retry they are compared with. */
const RETRY_WORDS = 6;
/** An attempt lies within this many seconds (edit time) before the position. */
const ATTEMPT_WINDOW_S = 3;
/** Words of one attempt or retry follow each other within this many seconds (edit time). */
const WORD_GAP_S = 1.5;
/** Inside a span, a verbatim repeat or a cut-off attempt is followed by its retry within this many seconds. */
const SPAN_RETRY_GAP_S = 1.0;
/** Two spans are adjacent when the sequence gap between them is at most this many seconds. */
const ADJACENT_GAP_S = 2;
/**
 * The copies of a phrase were said one after the other in the recording when the later one starts at most this many
 * seconds after the earlier one ends (same media): a deliberate repetition is possible; farther apart, a cut joined
 * two moments.
 */
const SAID_TOGETHER_S = 1;

/** A word of a chunked transcription (flicks: media time for span words, sequence time for mixdown words). */
export type EditWord = Pick<CleanupWordIn, 'text' | 'start' | 'end' | 'confidence'>;

/**
 * An edge of a removal inside a span lies in a pause at least this long (seconds): a dip shorter than this is a
 * consonant closure inside one word (the user's v7 review: "mos|trar" cut at a 30 ms closure).
 */
export const MIN_CUT_PAUSE_S = 0.08;
/** A cut-edge pause is also looked for this far (seconds) into the words that go (loose timestamps). */
const EDGE_SLACK_S = 0.05;
const VOICE_FRAME_S = 0.01;
const SPEECH_CLASS = 2;

/** A kept span of the dialogue track: one clip's extent (sequence frames) and the media time it plays (flicks). */
export type EditSpan = {
	clipId: string;
	mediaId: string;
	stream: number;
	seqStart: number;
	seqEnd: number;
	mediaStart: number;
	mediaEnd: number;
};

/** One repeat in the edit and the removal of its earlier copy. */
export type EditRepeat = {
	/** Where the words came from: chunked transcriptions of the kept spans, or of the mixdown (closed loop). */
	source: 'spans' | 'mix';
	/** `cut`: the copies lie on both sides of a cut; `span`: inside one kept span. */
	where: 'cut' | 'span';
	kind: Extract<FindingKind, 'restart' | 'false-start' | 'retake' | 'stutter'>;
	suggested: 'remove' | 'review';
	/** The earlier copy (removed) and the start of the take that stays. */
	text: string;
	kept: string;
	/** Sequence frames `[attempt start, retry start)`. */
	range: [number, number];
	/** What goes: media time (flicks) of each clip, in sequence order. */
	cuts: Array<{ clipId: string; mediaId: string; stream: number; start: number; end: number }>;
	confidence: number;
	/**
	 * Why a repeat the matcher would remove is only reviewed: `decode` — no second, independent decode says the words
	 * twice; `closure` — an edge inside the span has no pause of `MIN_CUT_PAUSE_S` (a consonant closure inside one word,
	 * or no voice analysis to tell).
	 */
	held?: 'decode' | 'closure';
	/**
	 * `later`: the retry's word-for-word copy of the attempt at its clip's start goes instead of the earlier copy (whose
	 * removal had no clean edge); the earlier copy plays with the rest of the retry.
	 */
	copy?: 'later';
};

/** Words of the chunked transcription of one padded span (`editSpanRequest`), media flicks; null when unavailable. */
export type EditWordsLookup = (span: EditSpan) => readonly EditWord[] | null | undefined;

export type EditRepeatsInput = {
	spans: readonly EditSpan[];
	rate: Rational;
	/** Chunked words per kept span (span-based check). */
	words?: EditWordsLookup;
	/**
	 * Other independent decodes of the same spans (a chunked decode with other chunk boundaries, the stored transcript):
	 * a repeat is removed by default only when one of them, or the mixdown, says the words twice too.
	 */
	confirm?: ReadonlyArray<EditWordsLookup>;
	/** Chunked words of the sequence's mixdown, sequence flicks (closed loop). */
	mix?: readonly EditWord[] | null;
	/**
	 * Decodes of `restartWindows` (each from inside a dip right after a phrase's onset): a restart the span decodes merged
	 * ("Lo… Lo reescribieron" written "Lo reescribí") shows as the fragment before the dip said again from the dip.
	 */
	windows?: ReadonlyArray<RestartWindow & { words: readonly EditWord[] | null | undefined }>;
	/** Voice analysis of a media (10 ms classes): an edge inside a span must lie in a pause of `MIN_CUT_PAUSE_S`. */
	voice?: (mediaId: string, stream: number) => CleanupVoice | null | undefined;
	settings: CleanupSettings;
	language?: string | null;
	lists?: CleanupLists | null;
	script?: string | null;
};

/** The media range (flicks) to transcribe for a span: padded by `EDIT_SPAN_PAD_S`, never before the media's start. */
export function editSpanRequest(
	span: EditSpan,
	padS = EDIT_SPAN_PAD_S,
): {
	mediaId: string;
	stream: number;
	start: number;
	end: number;
} {
	const pad = Math.round(padS * FLICKS_PER_SECOND);
	return {
		mediaId: span.mediaId,
		stream: span.stream,
		start: Math.max(0, span.mediaStart - pad),
		end: span.mediaEnd + pad,
	};
}

/** One word of the edit's stream. */
type SWord = {
	text: string;
	n: string;
	/** Edit (sequence) time, seconds. */
	s: number;
	e: number;
	/** Media time, flicks. */
	ms: number;
	me: number;
	span: number;
	conf: number | null;
	filler: boolean;
};

const toSec = (f: number) => f / FLICKS_PER_SECOND;
const finite = (x: number) => Number.isFinite(x);

/** The edit's word stream from chunked words per span (media time) or from mixdown words (sequence time). */
type Source = { lookup: EditWordsLookup } | { mix: readonly EditWord[] };

function streamOf(
	input: EditRepeatsInput,
	fillers: ReadonlySet<string>,
	src: Source,
): { words: SWord[]; known: boolean[] } {
	const mix = 'mix' in src;
	const F = flicksPerFrame(input.rate);
	const spans = input.spans;
	const out: SWord[] = [];
	const known = spans.map(() => mix);
	const push = (w: EditWord, span: number, ms: number, me: number, s: number, e: number) => {
		const n = cleanupNorm(w.text);
		if (!n) return;
		out.push({ text: w.text, n, s, e, ms, me, span, conf: w.confidence, filler: fillers.has(n) });
	};
	if (!mix) {
		spans.forEach((sp, i) => {
			const ws = (src as { lookup: EditWordsLookup }).lookup(sp);
			if (!ws) return;
			known[i] = true;
			const at = sp.seqStart * F - sp.mediaStart; // media flicks → sequence flicks
			const own = ws
				.filter((w) => finite(w.start) && finite(w.end) && w.end >= w.start)
				.filter((w) => {
					const mid = (w.start + w.end) / 2;
					return mid >= sp.mediaStart && mid < sp.mediaEnd;
				})
				.sort((a, b) => a.start - b.start);
			for (const w of own) push(w, i, w.start, w.end, toSec(w.start + at), toSec(w.end + at));
		});
		return { words: out, known };
	}
	const ws = (src as { mix: readonly EditWord[] }).mix
		.filter((w) => finite(w.start) && finite(w.end) && w.end >= w.start)
		.sort((a, b) => a.start - b.start);
	let i = 0;
	for (const w of ws) {
		const mid = (w.start + w.end) / 2;
		while (i < spans.length && spans[i]!.seqEnd * F <= mid) i++;
		const sp = spans[i];
		if (!sp || sp.seqStart * F > mid) continue; // between spans (silence, another track's sound)
		const at = sp.mediaStart - sp.seqStart * F; // sequence flicks → media flicks
		push(w, i, w.start + at, w.end + at, toSec(w.start), toSec(w.end));
	}
	return { words: out, known };
}

/**
 * Finds the repeats of the edit (both passes, see the file comment), in every decode on its own. A repeat of the span
 * decode (or of the mixdown) is removed by default only when another decode — `confirm`, the mixdown, the span decode
 * — finds a repeat over the same media time (two decodes agree the words are said twice) and every edge inside a span
 * lies in a pause of `MIN_CUT_PAUSE_S`; else it is reviewed (`held`). Mixdown repeats are always reviewed.
 */
export function findEditRepeats(input: EditRepeatsInput): EditRepeat[] {
	const primary = input.words ? repeatsOf(input, { lookup: input.words }) : [];
	const mix = input.mix ? repeatsOf(input, { mix: input.mix }) : [];
	const others = (input.confirm ?? []).map((lookup) => repeatsOf(input, { lookup }));
	const agree = (r: EditRepeat, pool: readonly EditRepeat[]) => pool.some((x) => sameRemoval(r, x));
	const out: EditRepeat[] = [];
	for (const r of primary) {
		if (r.suggested === 'remove' && !r.held && !agree(r, mix) && !others.some((o) => agree(r, o)))
			out.push({ ...r, suggested: 'review', confidence: 0.5, held: 'decode' });
		else out.push(r);
	}
	// mixdown repeats the span decode did not find (the same removal once)
	for (const r of mix) if (!agree(r, primary)) out.push(r);
	// restarts at a phrase's start that only a decode from the dip shows
	if (input.words && input.windows?.length)
		for (const r of windowRepeats(input, input.words)) if (!out.some((x) => sameRemoval(r, x))) out.push(r);
	return out;
}

/**
 * A window to decode for a restart at a phrase's start: from the middle of a level dip within 1 s after the phrase's
 * onset (a span's start, or speech after ≥ 0.3 s without), `RESTART_WINDOW_S` long. Media flicks.
 */
export type RestartWindow = {
	clipId: string;
	mediaId: string;
	stream: number;
	/** The dip `[start, end)`. */
	dip: [number, number];
	start: number;
	end: number;
};

/** Seconds decoded from a restart dip. */
export const RESTART_WINDOW_S = 3;
/** A phrase starts at a span's start or after this many frames (0.3 s) without speech. */
const ONSET_PAUSE_FRAMES = 30;
/** The dip lies within this many frames (1 s) after the onset. */
const ONSET_SEARCH_FRAMES = 100;
/**
 * A dip frame lies this many dB under the louder of the quieter side — the loudest frame of the `DIP_SIDE_FRAMES` before
 * it and of those after it, both over the speech threshold — for `DIP_MIN_FRAMES` … `DIP_MAX_FRAMES` frames. Loose on
 * purpose: a window only costs a decode; the decode must re-say the fragment for any finding.
 */
const DIP_DEPTH_DB = 15;
const DIP_SIDE_FRAMES = 15;
const DIP_MIN_FRAMES = 4;
const DIP_MAX_FRAMES = 25;

const frameFlicks = (k: number) => Math.round(k * VOICE_FRAME_S * FLICKS_PER_SECOND);

/** The restart windows of the spans (the first qualifying dip after each phrase onset). */
export function restartWindows(
	spans: readonly EditSpan[],
	voice: (mediaId: string, stream: number) => CleanupVoice | null | undefined,
): RestartWindow[] {
	const out: RestartWindow[] = [];
	for (const sp of spans) {
		const v = voice(sp.mediaId, sp.stream);
		if (!v?.level) continue;
		const f0 = Math.max(0, Math.ceil(toSec(sp.mediaStart) / VOICE_FRAME_S));
		const f1 = Math.min(v.frameCount, Math.floor(toSec(sp.mediaEnd) / VOICE_FRAME_S));
		const thr = v.levels.speechThresholdDb ?? Number.NEGATIVE_INFINITY;
		const db = (k: number) => (k >= 0 && k < v.frameCount ? -120 + v.level[k]! / 2 : -120);
		const speech = (k: number) => v.classes[k] === SPEECH_CLASS;
		const sideMax = (a: number, b: number) => {
			let m = Number.NEGATIVE_INFINITY;
			for (let k = Math.max(f0, a); k < Math.min(f1, b); k++) m = Math.max(m, db(k));
			return m;
		};
		const dipFrame = (k: number) => {
			const before = sideMax(k - DIP_SIDE_FRAMES, k);
			const after = sideMax(k + 1, k + 1 + DIP_SIDE_FRAMES);
			return before > thr && after > thr && db(k) <= Math.min(before, after) - DIP_DEPTH_DB;
		};
		const onsets: number[] = [];
		for (let k = f0; k < f1; k++) {
			if (!speech(k)) continue;
			let quiet = 0;
			while (quiet < ONSET_PAUSE_FRAMES && k - 1 - quiet >= 0 && !speech(k - 1 - quiet)) quiet++;
			if (k === f0 || quiet >= ONSET_PAUSE_FRAMES || (onsets.length === 0 && k - f0 < ONSET_PAUSE_FRAMES))
				if (onsets[onsets.length - 1] !== k) onsets.push(k);
		}
		for (const o of onsets) {
			for (let k = o + 1; k < Math.min(f1 - DIP_MIN_FRAMES, o + ONSET_SEARCH_FRAMES); k++) {
				if (!dipFrame(k)) continue;
				let e = k;
				while (e < f1 && dipFrame(e)) e++;
				if (e - k >= DIP_MIN_FRAMES && e - k <= DIP_MAX_FRAMES) {
					const start = frameFlicks(Math.floor((k + e) / 2));
					out.push({
						clipId: sp.clipId,
						mediaId: sp.mediaId,
						stream: sp.stream,
						dip: [frameFlicks(k), frameFlicks(e)],
						start,
						end: Math.min(sp.mediaEnd, start + Math.round(RESTART_WINDOW_S * FLICKS_PER_SECOND)),
					});
					break;
				}
				k = e;
			}
		}
	}
	return out;
}

/**
 * Restarts at a phrase's start from a window decode: the last ≤ 3 words of the span decode before the dip (none of its
 * words over the dip — a dip inside a word is a closure) said again word for word from the start of the window's words,
 * which begin right at the dip's end ("Lo | Lo reescribieron"). Two decodes, but neither writes the words twice: the
 * fragment goes by default only when the dip is a measured pause (`MIN_CUT_PAUSE_S` of non-speech); else it is
 * reviewed (`held: 'decode'`), its cut ending at the dip's quietest frame.
 */
function windowRepeats(input: EditRepeatsInput, lookup: EditWordsLookup): EditRepeat[] {
	const lang = cleanupLanguageOf(input.language ?? null);
	const lists = effectiveLists(lang, input.lists ?? null);
	const fillers = new Set(lists.fillers);
	const stop = new Set(lists.stopWords);
	const allow = new Set(lists.allow);
	const scriptToks = scriptTokenList(input.script ?? null);
	const { words } = streamOf(input, fillers, { lookup });
	const F = flicksPerFrame(input.rate);
	const out: EditRepeat[] = [];
	const near = 0.03 * FLICKS_PER_SECOND;
	for (const w of input.windows ?? []) {
		const si = input.spans.findIndex((s) => s.clipId === w.clipId);
		const sp = input.spans[si];
		if (!sp || !w.words) continue;
		const [d0, d1] = w.dip;
		const own = words.map((x, k) => [x, k] as const).filter(([x]) => x.span === si);
		if (own.some(([x]) => x.ms < d0 && x.me > d1)) continue; // a word over the dip: a closure inside it
		const before = own.filter(
			([x]) => !x.filler && x.ms < d0 && x.me <= d0 + near && x.ms >= d0 - FLICKS_PER_SECOND,
		);
		const X = before.slice(-3);
		if (!X.length) continue;
		const at = sp.seqStart * F - sp.mediaStart;
		const Q: SWord[] = w.words
			.filter((x) => Number.isFinite(x.start) && Number.isFinite(x.end) && x.start >= d0 - near)
			.sort((a, b) => a.start - b.start)
			.flatMap((x) => {
				const n = cleanupNorm(x.text);
				return n && !fillers.has(n)
					? [
							{
								text: x.text,
								n,
								s: toSec(x.start + at),
								e: toSec(x.end + at),
								ms: x.start,
								me: x.end,
								span: si,
								conf: x.confidence,
								filler: false,
							},
						]
					: [];
			})
			.slice(0, RETRY_WORDS);
		if (!Q.length || Q[0]!.ms > d1 + 0.15 * FLICKS_PER_SECOND) continue;
		for (let k = X.length; k >= 1; k--) {
			const att = X.slice(X.length - k).map(([x]) => x);
			const tmp = [...att, ...Q];
			const ai = att.map((_, i) => i);
			const qi = Q.map((_, i) => att.length + i);
			const m = reSaid(tmp, ai, qi, stop);
			if (m?.first !== 0) continue;
			if (
				deliberateRepeat(tmp, ai, qi, {
					allow,
					stop,
					scriptToks,
					phraseGapS: input.settings.thresholds.phraseGapS,
				})
			)
				break;
			const voice = input.voice?.(sp.mediaId, sp.stream) ?? null;
			// a measured pause between the fragment and the re-onset (the dip itself may be shorter than the gap)
			const pause = voice
				? pauseIn(voice, att[att.length - 1]!.me - EDGE_SLACK_S * FLICKS_PER_SECOND, Q[0]!.ms)
				: null;
			const remove = Array.isArray(pause);
			// the cut: from the fragment's onset (the kept word before it, or the start of its voice) to the re-onset
			const firstK = X[X.length - k]![1];
			const prev = firstK > 0 && words[firstK - 1]!.span === si ? words[firstK - 1]! : null;
			let start = sp.mediaStart;
			if (prev) start = Math.max(att[0]!.ms, prev.me);
			else if (voice) {
				let f = Math.floor(toSec(att[0]!.ms) / VOICE_FRAME_S);
				while (f > 0 && voice.classes[f - 1] === SPEECH_CLASS && frameFlicks(f - 1) >= sp.mediaStart) f--;
				start = Math.max(sp.mediaStart, frameFlicks(f));
			}
			let end = remove ? (pause as [number, number])[1] : d1;
			if (!remove && voice?.level) {
				// the dip's quietest frame (the latest of equals): where the hand fix cut
				let best = Math.floor(toSec(d0) / VOICE_FRAME_S);
				for (let f = best; f < Math.ceil(toSec(d1) / VOICE_FRAME_S); f++)
					if (voice.level[f]! <= voice.level[best]!) best = f;
				end = frameFlicks(best);
			}
			end = Math.min(sp.mediaEnd, Math.max(end, start));
			if (end <= start) break;
			const frameOf = (m0: number) => Math.floor((m0 + at) / F + 1e-6);
			out.push({
				source: 'spans',
				where: 'span',
				kind: 'stutter',
				suggested: remove ? 'remove' : 'review',
				...(remove ? {} : { held: 'decode' as const }),
				text: att.map((x) => x.text.trim()).join(' '),
				kept: Q.slice(0, Math.max(3, k + 1))
					.map((x) => x.text.trim())
					.join(' '),
				range: [frameOf(start), Math.max(frameOf(start), frameOf(end))],
				cuts: [
					{
						clipId: sp.clipId,
						mediaId: sp.mediaId,
						stream: sp.stream,
						start: Math.round(start),
						end: Math.round(end),
					},
				],
				confidence: remove ? 0.8 : 0.5,
			});
			break;
		}
	}
	return out;
}

/**
 * Whether two repeats are the same: their sequence ranges (attempt to retry) overlap, or on a common clip half of the
 * shorter removal overlaps.
 */
function sameRemoval(a: EditRepeat, b: EditRepeat): boolean {
	if (Math.min(a.range[1], b.range[1]) > Math.max(a.range[0], b.range[0])) return true;
	const total = (r: EditRepeat) => r.cuts.reduce((t, c) => t + c.end - c.start, 0);
	let both = 0;
	for (const x of a.cuts)
		for (const y of b.cuts)
			if (x.clipId === y.clipId) both += Math.max(0, Math.min(x.end, y.end) - Math.max(x.start, y.start));
	return both > 0 && both >= Math.min(total(a), total(b)) / 2;
}

/**
 * Where an edge between two words may go, from the voice analysis over the media range `[a, b]` (flicks, the gap
 * between the words, with `EDGE_SLACK_S` into the removed word): the longest run of non-speech frames when it lasts at least
 * `MIN_CUT_PAUSE_S` (media flicks `[start, end)`); `continuous` when every frame is speech (connected speech: the edge
 * goes at the word boundary the decodes agree on); null when the only dips are shorter — a closure, possibly inside one
 * word ("mos|trar": 60 ms of non-speech at 1646.31 s), where no cut may go.
 */
function pauseIn(voice: CleanupVoice, a: number, b: number): [number, number] | 'continuous' | null {
	const f0 = Math.max(0, Math.floor(toSec(a) / VOICE_FRAME_S));
	const f1 = Math.min(voice.frameCount, Math.ceil(toSec(b) / VOICE_FRAME_S));
	let best: [number, number] | null = null;
	for (let k = f0; k < f1; ) {
		if (voice.classes[k] === SPEECH_CLASS) {
			k++;
			continue;
		}
		let e = k;
		while (e < f1 && voice.classes[e] !== SPEECH_CLASS) e++;
		if (!best || e - k > best[1] - best[0]) best = [k, e];
		k = e;
	}
	if (!best) return 'continuous';
	if ((best[1] - best[0]) * VOICE_FRAME_S < MIN_CUT_PAUSE_S - 1e-9) return null;
	return [
		Math.round(best[0] * VOICE_FRAME_S * FLICKS_PER_SECOND),
		Math.round(best[1] * VOICE_FRAME_S * FLICKS_PER_SECOND),
	];
}

function repeatsOf(input: EditRepeatsInput, src: Source): EditRepeat[] {
	const mix = 'mix' in src;
	const lang = cleanupLanguageOf(input.language ?? null);
	const lists = effectiveLists(lang, input.lists ?? null);
	const fillers = new Set(lists.fillers);
	const allow = new Set(lists.allow);
	const stop = new Set(lists.stopWords);
	const { words, known } = streamOf(input, fillers, src);
	if (words.length < 2) return [];
	const spans = input.spans;
	const F = flicksPerFrame(input.rate);
	const scriptToks = scriptTokenList(input.script ?? null);
	const t = input.settings.thresholds;
	const removed = new Array<boolean>(words.length).fill(false);
	const found: Array<{
		a: number;
		b: number;
		kind: EditRepeat['kind'];
		tier: 'remove' | 'review';
		/** Across a cut, the retry's copy of the attempt word for word at its start (stream positions `[a, b)`). */
		later?: { a: number; b: number };
	}> = [];

	// ---- pass 1: the attempt before a position said again by the retry after it
	// spans i < j follow each other: short sequence gaps, and every span between them transcribed (a span without
	// words is silence or a sliver between takes, not a transcription that failed)
	const adjacent = (i: number, j: number) => {
		for (let k = i; k < j; k++) {
			if (!known[k + 1] || toSec((spans[k + 1]!.seqStart - spans[k]!.seqEnd) * F) > ADJACENT_GAP_S)
				return false;
		}
		return true;
	};
	for (let p = 1; p < words.length; p++) {
		if (words[p]!.filler) continue;
		const cut = words[p]!.span !== words[p - 1]!.span;
		if (cut && !adjacent(words[p - 1]!.span, words[p]!.span)) continue;
		// the retry: up to RETRY_WORDS non-filler words from p, one after another
		const Q: number[] = [];
		for (let q = p; q < words.length && Q.length < RETRY_WORDS; q++) {
			if (Q.length && words[q]!.s - words[Q[Q.length - 1]!]!.e > WORD_GAP_S) break;
			if (!words[q]!.filler) Q.push(q);
		}
		// the attempt candidates: non-filler words before p, one after another, within the window
		const X: number[] = [];
		for (let q = p - 1; q >= 0 && X.length < ATTEMPT_WORDS; q--) {
			if (removed[q]) break;
			const next = X.length ? X[0]! : p;
			if (words[next]!.s - words[q]!.e > WORD_GAP_S || words[p]!.s - words[q]!.s > ATTEMPT_WINDOW_S) break;
			if (!words[q]!.filler) X.unshift(q);
		}
		for (let k = X.length; k >= 1; k--) {
			const att = X.slice(X.length - k);
			const m = reSaid(words, att, Q, stop);
			if (!m) continue;
			const last = words[att[att.length - 1]!]!;
			const verbatim = att.every((a, x) => words[a]!.n === words[Q[x]!]?.n) && m.first === 0;
			if (!cut) {
				// inside a span: the recogniser's trace of a restart, right before the retry
				const trace = CUT_OFF.test(last.text.trim()) || (k >= 2 && verbatim);
				if (!trace || words[p]!.s - last.e > SPAN_RETRY_GAP_S) continue;
			}
			// one word across a cut is an attempt only where a clause starts (the span's first word, after a sentence
			// mark or a comma, or after a pause): "Bueno, no lo | Lo reescribieron" cut a phrase, it restarted nothing
			if (cut && k === 1 && !clauseStart(words, att[0]!, t.phraseGapS)) continue;
			const lastMatched = Q.indexOf(m.pairs[m.pairs.length - 1]!);
			const goesOn = Q.length - 1 - lastMatched; // retry words after the re-said ones
			const togetherInSource =
				words[p]!.span === last.span ||
				(spans[words[p]!.span]!.mediaId === spans[last.span]!.mediaId &&
					words[Q[0]!]!.ms >= last.me - FLICKS_PER_SECOND * 0.05 &&
					toSec(words[Q[0]!]!.ms - last.me) <= SAID_TOGETHER_S);
			const deliberate = deliberateRepeat(words, att, Q, {
				allow,
				stop,
				scriptToks,
				phraseGapS: t.phraseGapS,
			});
			// said twice on purpose: never an attempt — what the script says, and emphasis or a reduplication said one
			// after the other; a reduplication a cut joined from two moments is reviewed
			if (deliberate === 'script' || (deliberate && togetherInSource)) break;
			let tier: 'remove' | 'review' =
				deliberate !== 'reduplication' &&
				goesOn >= (k === 1 ? 2 : 1) &&
				!(SENTENCE_END.test(last.text.trim()) && !CUT_OFF.test(last.text.trim()))
					? 'remove'
					: 'review';
			if (mix) tier = 'review';
			const a = att[0]!;
			const verbatimStart = m.first === 0 && m.pairs.every((q, x) => q === Q[x]);
			found.push({
				a,
				b: p,
				kind: cut ? 'restart' : 'stutter',
				tier,
				...(cut && verbatimStart ? { later: { a: p, b: m.pairs[m.pairs.length - 1]! + 1 } } : {}),
			});
			for (let q = a; q < p; q++) removed[q] = true;
			break;
		}
	}

	// ---- pass 2: the detector's rules over the stream (longer takes, its guards)
	const det = detectCleanup({
		mediaId: 'edit',
		words: words.map((w) => ({
			text: w.text,
			start: Math.round(w.s * FLICKS_PER_SECOND),
			end: Math.round(w.e * FLICKS_PER_SECOND),
			confidence: w.conf,
		})),
		script: input.script ?? null,
		language: input.language ?? null,
		lists: input.lists ?? null,
		settings: input.settings,
	});
	for (const f of det.findings) {
		if (!f.words) continue;
		if (f.kind !== 'restart' && f.kind !== 'false-start' && f.kind !== 'retake' && f.kind !== 'stutter')
			continue;
		const [wa, wz] = f.words; // transcript indices = stream positions
		let overlap = false;
		for (let q = wa; q <= wz && !overlap; q++) overlap = removed[q]!;
		if (overlap || wz + 1 >= words.length) continue;
		if (words[wz + 1]!.span !== words[wa]!.span) {
			// across a cut the first pass owns the short repeats (its clause and deliberate checks); here only takes of
			// three or more words
			if (!adjacent(words[wa]!.span, words[wz + 1]!.span) || wz - wa < 2) continue;
			if (f.kind !== 'restart' && f.kind !== 'retake') continue;
		}
		if (f.suggested !== 'remove') continue; // its review tier (reduplications, partial takes) is the stored detection's
		const tier: 'remove' | 'review' = mix ? 'review' : 'remove';
		found.push({ a: wa, b: wz + 1, kind: f.kind, tier });
		for (let q = wa; q <= wz; q++) removed[q] = true;
	}

	found.sort((x, y) => x.a - y.a);
	return found.map((r): EditRepeat => {
		const first = words[r.a]!;
		const retry = words[r.b]!; // the word right after the attempt: what follows the cut
		const att = words.slice(r.a, r.b);
		const where = first.span === retry.span ? 'span' : 'cut';
		// what goes: from the attempt's first word (never before the kept word before it ends) to the cut — every span in
		// between whole — or, inside a span, to the retry's onset
		// (from the span's start when no word of it comes before: a clip that opens with the attempt goes from its start)
		const prev = r.a > 0 && words[r.a - 1]!.span === first.span ? words[r.a - 1]! : null;
		let start = prev ? Math.max(first.ms, prev.me) : spans[first.span]!.mediaStart;
		let end = retry.ms;
		// an edge inside a span goes into a pause of MIN_CUT_PAUSE_S between the words around it (start: where the voice
		// before stops; end: where the retry's voice starts), or at their boundary in connected speech; never through a
		// shorter dip (a closure, maybe inside one word). Without a voice analysis it cannot be told: only reviewed
		let closure = false;
		const sp0 = spans[first.span]!;
		const voice = input.voice?.(sp0.mediaId, sp0.stream) ?? null;
		const slack = EDGE_SLACK_S * FLICKS_PER_SECOND;
		if (prev) {
			const p = voice ? pauseIn(voice, prev.me, first.ms + slack) : null;
			if (Array.isArray(p)) start = Math.max(sp0.mediaStart, p[0]);
			else if (p !== 'continuous') closure = true;
		}
		if (where === 'span') {
			const lastAtt = words[r.b - 1]!;
			const p = voice ? pauseIn(voice, lastAtt.me - slack, retry.ms) : null;
			if (Array.isArray(p)) end = p[1];
			else if (p !== 'continuous') closure = true;
		}
		// across a cut the take after it stays whole: everything from the attempt to the end of the span before the retry's
		const lastSpan = where === 'cut' ? retry.span - 1 : retry.span;
		const cuts: EditRepeat['cuts'] = [];
		for (let k = first.span; k <= lastSpan; k++) {
			const sp = spans[k]!;
			const a = k === first.span ? Math.max(sp.mediaStart, start) : sp.mediaStart;
			const b = where === 'span' ? Math.min(sp.mediaEnd, end) : sp.mediaEnd;
			if (b > a)
				cuts.push({
					clipId: sp.clipId,
					mediaId: sp.mediaId,
					stream: sp.stream,
					start: Math.round(a),
					end: Math.round(b),
				});
		}
		const keptWords = words.slice(r.b, Math.min(words.length, r.b + Math.max(3, att.length + 1)));
		const frameOf = (sec: number) => Math.floor((sec * FLICKS_PER_SECOND) / F + 1e-6);
		// the earlier copy has no clean edge, but the retry repeats it word for word at its clip's start: its copy goes
		// instead when that has one (the words after it in its clip start after a pause, or it fills its clips) — the
		// phrase plays once either way ("hacer, y | y si buscas" → "hacer, y | si buscas", as the user fixed it)
		if (closure && r.later && !mix) {
			const la = words[r.later.a]!;
			const lz = words[r.later.b - 1]!;
			const next = words[r.later.b];
			const spL = spans[lz.span]!;
			const vL = input.voice?.(spL.mediaId, spL.stream) ?? null;
			let endL: number | null = spL.mediaEnd;
			if (next && next.span === lz.span) {
				const p = vL ? pauseIn(vL, lz.me - slack, next.ms) : null;
				endL = Array.isArray(p) ? p[1] : p === 'continuous' ? next.ms : null;
			}
			if (endL !== null) {
				const laterCuts: EditRepeat['cuts'] = [];
				for (let k = la.span; k <= lz.span; k++) {
					const sp = spans[k]!;
					const b = k === lz.span ? Math.min(sp.mediaEnd, endL) : sp.mediaEnd;
					if (b > sp.mediaStart)
						laterCuts.push({
							clipId: sp.clipId,
							mediaId: sp.mediaId,
							stream: sp.stream,
							start: Math.round(sp.mediaStart),
							end: Math.round(b),
						});
				}
				const lw = words.slice(r.later.a, r.later.b);
				return {
					source: 'spans',
					where,
					kind: r.kind,
					suggested: r.tier,
					copy: 'later',
					text: lw.map((w) => w.text.trim()).join(' '),
					kept: [...att, ...words.slice(r.later.b, r.later.b + 2)].map((w) => w.text.trim()).join(' '),
					range: [frameOf(first.s), Math.max(frameOf(first.s), frameOf(next?.s ?? lz.e))],
					cuts: laterCuts,
					confidence: r.tier === 'remove' ? 0.8 : 0.5,
				};
			}
		}
		const held = r.tier === 'remove' && closure && !mix;
		return {
			source: mix ? 'mix' : 'spans',
			where,
			kind: r.kind,
			suggested: held ? 'review' : r.tier,
			...(held ? { held: 'closure' as const } : {}),
			text: att.map((w) => w.text.trim()).join(' '),
			kept: keptWords.map((w) => w.text.trim()).join(' '),
			range: [frameOf(first.s), Math.max(frameOf(first.s), frameOf(retry.s))],
			cuts,
			confidence: r.tier === 'remove' && !held ? 0.8 : 0.5,
		};
	});
}

/**
 * Whether every word of the attempt `att` is said again by the retry `Q` (stream positions), in order, the first among
 * the retry's first two words (or the first, for a one-word attempt): the matched retry positions and the retry index
 * of the first; null when not. The attempt's last word may be cut off ("most…" / "mostrar", "jue-" / "juego").
 */
function reSaid(
	words: readonly SWord[],
	att: readonly number[],
	Q: readonly number[],
	stop: ReadonlySet<string>,
): { pairs: number[]; first: number } | null {
	const maxFirst = att.length === 1 ? 0 : 1;
	for (let first = 0; first <= Math.min(maxFirst, Q.length - 1); first++) {
		const pairs: number[] = [];
		let q = first;
		for (let x = 0; x < att.length; x++) {
			const a = words[att[x]!]!;
			const lastOne = x === att.length - 1;
			// a cut-off word is the start of the word said whole — from 3 letters, all but its last from 4 (the recogniser
			// guesses a fragment's last sound) — but a stop word before an ellipsis is a hesitation ("lo que… quedó")
			const cut = lastOne && CUT_OFF.test(a.text.trim()) && a.n.length >= 3 && !stop.has(a.n);
			const eq = (b: SWord) =>
				sameWord(a.n, b.n) ||
				(cut &&
					b.n.length > a.n.length &&
					(b.n.startsWith(a.n) || (a.n.length >= 4 && b.n.startsWith(a.n.slice(0, -1)))));
			// the attempt's first word is the retry's `first`; later ones may skip retry words (a rephrased retry)
			if (x === 0) {
				if (!eq(words[Q[q]!]!)) break;
				pairs.push(Q[q]!);
				q++;
				continue;
			}
			while (q < Q.length && !eq(words[Q[q]!]!)) q++;
			if (q >= Q.length) break;
			pairs.push(Q[q]!);
			q++;
		}
		if (pairs.length === att.length) return { pairs, first };
	}
	return null;
}

/**
 * How the attempt and its retry make a deliberate repetition, if they do: allowed emphasis ("no, no", "sí, sí"), a reduplication
 * — one content word said again, the run ending its phrase or of three or more ("Guiño, guiño.", "boing, boing,
 * boing") — or a repetition the script itself says (the attempt followed by the retry's words, in a row).
 */
function deliberateRepeat(
	words: readonly SWord[],
	att: readonly number[],
	Q: readonly number[],
	o: {
		allow: ReadonlySet<string>;
		stop: ReadonlySet<string>;
		scriptToks: readonly string[];
		phraseGapS: number;
	},
): 'script' | 'allowed' | 'reduplication' | null {
	const ns = att.map((a) => words[a]!.n);
	if (o.scriptToks.length) {
		// the attempt, its copy and the word after it in a row (a one-word pair alone occurs in any long script)
		const seqToks = [...ns, ...Q.slice(0, att.length + 1).map((q) => words[q]!.n)];
		outer: for (let i = 0; i + seqToks.length <= o.scriptToks.length; i++) {
			for (let k = 0; k < seqToks.length; k++) if (o.scriptToks[i + k] !== seqToks[k]) continue outer;
			return 'script';
		}
	}
	if (ns.every((n) => o.allow.has(n))) return 'allowed';
	if (att.length === 1) {
		const x = ns[0]!;
		const content = (!o.stop.has(x) && (x.length >= 3 || /\d/.test(x))) || o.allow.has(x);
		if (content && words[Q[0]!]!.n === x) {
			let e = 0;
			while (e + 1 < Q.length && words[Q[e + 1]!]!.n === x) e++;
			const end = words[Q[e]!]!;
			const next = Q[e + 1] !== undefined ? words[Q[e + 1]!]! : null;
			if (e >= 1 || !next || SENTENCE_END.test(end.text.trim()) || next.s - end.e >= o.phraseGapS)
				return 'reduplication';
		}
	}
	return null;
}

/** Whether stream word k starts a clause: its span's first word, after ". ? ! … , ; :" or after a pause. */
function clauseStart(words: readonly SWord[], k: number, phraseGapS: number): boolean {
	const prev = words[k - 1];
	if (!prev || prev.span !== words[k]!.span) return true;
	return /[.?!…,;:]["'»”’)]*$/u.test(prev.text.trim()) || toSec(words[k]!.ms - prev.me) >= phraseGapS;
}

/** The script as normalised tokens. */
function scriptTokenList(script: string | null): string[] {
	if (!script) return [];
	return script
		.split(/\s+/)
		.map(cleanupNorm)
		.filter((x) => x.length > 0);
}

/** Kinds of the detector whose removal of words already takes a repeat the edit check finds again. */
const SAME_KINDS: ReadonlySet<FindingKind> = new Set([
	'restart',
	'false-start',
	'retake',
	'hidden-retake',
	'stutter',
	'filler-vocalic',
	'filler-phrase',
]);

/**
 * The findings of the repeats in the edit, each with the media time it cuts per clip (ids `e<index>`; the caller
 * renumbers): kind and action of the repeat, range = the media time of its cuts in the first cut's media, no transcript
 * words (the chunked words are not the stored transcript's), the reason's `text` (what goes), `kept` (the take that
 * stays), `seconds`, `cut: 1` across a cut, `mix: 1` from the closed loop. A repeat whose cuts lie mostly (≥ 50 %)
 * inside a word finding of the detector that removes repeats or fillers in the same media (`existing`) is left out:
 * the stored transcript found it already.
 */
export function editRepeatCuts(
	repeats: readonly EditRepeat[],
	existing: readonly CleanupFinding[],
): Array<{ finding: CleanupFinding; cuts: EditRepeat['cuts'] }> {
	const seen = new Map<string, number>();
	const out: Array<{ finding: CleanupFinding; cuts: EditRepeat['cuts'] }> = [];
	repeats.forEach((r, i) => {
		const c0 = r.cuts[0];
		if (!c0) return;
		const total = r.cuts.reduce((s, c) => s + c.end - c.start, 0);
		let inside = 0;
		for (const c of r.cuts)
			for (const f of existing) {
				if (!f.words || !SAME_KINDS.has(f.kind) || !f.fingerprint.startsWith(fpMedia(c.mediaId, c.stream)))
					continue;
				inside += Math.max(0, Math.min(c.end, f.range.end) - Math.max(c.start, f.range.start));
			}
		if (total > 0 && inside >= total / 2) return;
		const same = r.cuts.filter((c) => c.mediaId === c0.mediaId && c.stream === c0.stream);
		const start = Math.min(...same.map((c) => c.start));
		const end = Math.max(...same.map((c) => c.end));
		let fp = findingFingerprint(c0.mediaId, c0.stream, r.kind, toSec(start), toSec(end), `edit ${r.text}`);
		const n = (seen.get(fp) ?? 0) + 1;
		seen.set(fp, n);
		if (n > 1) fp = `${fp}~${n}`;
		out.push({
			cuts: r.cuts,
			finding: {
				id: `e${i}`,
				kind: r.kind,
				range: { start, end: Math.max(start, end) },
				words: null,
				confidence: r.confidence,
				reason: {
					key: `cleanup.reason.${r.kind}`,
					params: {
						text: r.text,
						kept: r.kept,
						seconds: Math.round(toSec(total) * 1000) / 1000,
						...(r.where === 'cut' ? { cut: 1 } : {}),
						...(r.source === 'mix' ? { mix: 1 } : {}),
					},
				},
				suggested: r.suggested,
				fingerprint: fp,
			},
		});
	});
	return out;
}

/** The media part of a finding fingerprint (`findingFingerprint`). */
const fpMedia = (mediaId: string, stream: number) =>
	`${mediaId.replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120)}~${stream}~`;
