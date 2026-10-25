// Spec 13 AS-005 / AS-006: operations on subtitle text clips — their words in sequence time, the razor (words
// divided by midpoint, each half's text rebuilt with its styled runs), text edits re-timing unchanged words (LCS),
// the highlight drawn with Source Text keys, template keys re-anchored to the In, and SRT / VTT cues of a group.
import type { Cue } from '../formats/core.ts';
import type { Keyframe } from '../../schema/common.ts';
import type { Clip, Sequence, TextContent, TextStyle } from '../../schema/sequence.ts';
import { flicksPerFrame, type Rational } from '../../time.ts';
import { retimeText } from '../retime.ts';
import { normalizeWord, tokenizeText } from '../words.ts';
import {
	type CaptionWord,
	captionOf,
	groupClips,
	type SubtitleHighlight,
	type TextClipCaption,
} from './model.ts';

type Timing = Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'speed'>;
type TextClip = Extract<Clip, { kind: 'text' }>;

/** Content time (flicks) of a sequence time (flicks) on a clip. */
export function contentOfSequenceTime(c: Timing, t: number, rate: Rational): number {
	const F = flicksPerFrame(rate);
	const s = c.speed.rate > 0 ? c.speed.rate : 1;
	const local = (t - c.start * F) * s;
	return Math.round(c.speed.reverse ? c.sourceIn + c.duration * F * s - local : c.sourceIn + local);
}

/** Sequence time (flicks) of a content time on a clip. */
export function sequenceOfContentTime(c: Timing, x: number, rate: Rational): number {
	const F = flicksPerFrame(rate);
	const s = c.speed.rate > 0 ? c.speed.rate : 1;
	const local = c.speed.reverse ? c.sourceIn + c.duration * F * s - x : x - c.sourceIn;
	return Math.round(c.start * F + local / s);
}

/** A subtitle's words in sequence time (flicks), sorted. */
export function wordsInSequence(c: Timing & { caption?: unknown }, rate: Rational): CaptionWord[] {
	const cap = (c as { caption?: TextClipCaption }).caption;
	if (!cap || !Array.isArray(cap.words)) return [];
	const out = cap.words.map((w) => {
		const a = sequenceOfContentTime(c, w.start, rate);
		const b = sequenceOfContentTime(c, w.end, rate);
		return { text: w.text, start: Math.min(a, b), end: Math.max(a, b) };
	});
	return c.speed.reverse ? out.reverse() : out;
}

/** Words given in sequence time → content time of a clip (sorted by content time). */
export function wordsToContent(c: Timing, words: readonly CaptionWord[], rate: Rational): CaptionWord[] {
	const out = words.map((w) => {
		const a = contentOfSequenceTime(c, w.start, rate);
		const b = contentOfSequenceTime(c, w.end, rate);
		return { text: w.text, start: Math.max(0, Math.min(a, b)), end: Math.max(0, Math.max(a, b)) };
	});
	out.sort((x, y) => x.start - y.start || x.end - y.end);
	for (let i = 0; i + 1 < out.length; i++)
		if (out[i]!.end > out[i + 1]!.start) out[i]!.end = Math.max(out[i]!.start, out[i + 1]!.start);
	return out;
}

/**
 * UTF-16 offsets of each word in `text` (matched in order, case and punctuation ignored); null when the words cannot
 * all be found in order (the text was rewritten).
 */
export function locateWords(text: string, words: readonly { text: string }[]): Array<[number, number]> | null {
	const toks: Array<[number, number, string]> = [];
	const re = /\S+/g;
	for (let m = re.exec(text); m; m = re.exec(text)) toks.push([m.index, m.index + m[0].length, m[0]]);
	const out: Array<[number, number]> = [];
	let k = 0;
	for (const w of words) {
		const want = normalizeWord(w.text);
		let found = -1;
		for (let j = k; j < toks.length; j++) {
			const n = normalizeWord(toks[j]![2]);
			if (n === want || toks[j]![2] === w.text) {
				found = j;
				break;
			}
		}
		if (found < 0) return null;
		out.push([toks[found]![0], toks[found]![1]]);
		k = found + 1;
	}
	return out;
}

/** The runs of a text cut to `[from, to)` and shifted to start at 0. */
function sliceRuns(runs: TextContent['runs'], from: number, to: number): TextContent['runs'] {
	if (!runs?.length) return undefined;
	const out = runs
		.map((r) => ({ ...r, from: Math.max(r.from, from) - from, to: Math.min(r.to, to) - from }))
		.filter((r) => r.to > r.from);
	return out.length ? out : undefined;
}

/** A text content cut to `[from, to)` (whitespace trimmed; runs and paragraphs follow). */
export function sliceContent(content: TextContent, from: number, to: number): TextContent {
	let a = from;
	let b = to;
	while (a < b && /\s/.test(content.text[a]!)) a++;
	while (b > a && /\s/.test(content.text[b - 1]!)) b--;
	const next: TextContent = { ...content, text: content.text.slice(a, b) };
	const runs = sliceRuns(content.runs, a, b);
	if (runs) next.runs = runs;
	else delete next.runs;
	// paragraph settings are per paragraph index: keep those of the paragraphs inside the slice, renumbered
	if (content.paragraphs?.length) {
		const before = content.text.slice(0, a).split('\n').length - 1;
		const count = next.text.split('\n').length;
		const paras = content.paragraphs
			.filter((p) => p.index >= before && p.index < before + count)
			.map((p) => ({ ...p, index: p.index - before }));
		if (paras.length) next.paragraphs = paras;
		else delete next.paragraphs;
	}
	return next;
}

/** The text of words (spaces between, lines kept from `lineStarts`). */
export function joinWords(words: readonly { text: string }[]): string {
	return words.map((w) => w.text).join(' ');
}

/**
 * Razor through a subtitle (AS-006): `left` is the original clip (already shortened), `right` the new piece. Words
 * go to the piece holding their midpoint and each piece's text keeps its own words (styled runs included); when no
 * word boundary lies between the pieces, both keep every word and the whole text (a cut inside one word).
 */
export function splitCaptionWords(left: TextClip, right: TextClip, rate: Rational): void {
	const cap = captionOf(left as Clip);
	if (!cap || !(right as { caption?: unknown }).caption) return;
	const words = cap.words;
	const F = flicksPerFrame(rate);
	// the boundary in content time: the left piece's content end
	const boundary = left.speed.reverse
		? left.sourceIn
		: left.sourceIn + Math.round(left.duration * F * (left.speed.rate > 0 ? left.speed.rate : 1));
	const midOf = (w: CaptionWord) => w.start + Math.floor((w.end - w.start) / 2);
	const before = words.filter((w) => (left.speed.reverse ? midOf(w) >= boundary : midOf(w) < boundary));
	const after = words.filter((w) => !before.includes(w));
	if (!before.length || !after.length) return;
	const leftCap = left as { caption: TextClipCaption };
	const rightCap = right as { caption: TextClipCaption };
	leftCap.caption = { ...cap, words: before.map((w) => ({ ...w })) };
	rightCap.caption = { ...(rightCap.caption as TextClipCaption), words: after.map((w) => ({ ...w })) };
	// rebuild each piece's text: the words in display order (forward clips: before = first)
	const firstWords = left.speed.reverse ? after : before;
	const pos = locateWords(left.content.text, words);
	const content = left.content as TextContent;
	if (pos) {
		const cut = pos[firstWords.length]![0];
		const lc = sliceContent(content, 0, cut);
		const rc = sliceContent(content, cut, content.text.length);
		(left as { content: TextContent }).content = left.speed.reverse ? rc : lc;
		(right as { content: TextContent }).content = left.speed.reverse ? lc : rc;
	} else {
		(left as { content: TextContent }).content = { ...content, text: joinWords(before), runs: undefined };
		(right as { content: TextContent }).content = { ...content, text: joinWords(after), runs: undefined };
		delete (left.content as { runs?: unknown }).runs;
		delete (right.content as { runs?: unknown }).runs;
	}
	left.name = nameOf(left.content.text);
	right.name = nameOf(right.content.text);
}

export function nameOf(text: string): string {
	return text.replace(/\s+/g, ' ').trim().slice(0, 40) || 'Subtitle';
}

/**
 * New words for an edited subtitle text (AS-006): unchanged words keep their times (LCS), changed spans share the
 * time of the words they replace in proportion to their characters; `span` = the clip's content range.
 */
export function retimeCaptionWords(
	old: readonly CaptionWord[],
	text: string,
	span: { start: number; end: number },
): CaptionWord[] {
	const toks = tokenizeText(text);
	if (!toks.length) return [];
	const next = retimeText(
		old.map((w) => ({ ...w, confidence: null, speaker: null, breakBefore: 'none' as const })),
		toks,
		old.length ? { start: Math.min(span.start, old[0]!.start), end: Math.max(span.end, old[old.length - 1]!.end) } : span,
	);
	return next.map((w) => ({ text: w.text, start: Math.max(0, w.start), end: Math.max(0, w.end) }));
}

/** The content-time range `[start, end)` a clip shows. */
export function clipContentSpan(c: Timing, rate: Rational): { start: number; end: number } {
	const F = flicksPerFrame(rate);
	const len = Math.round(c.duration * F * (c.speed.rate > 0 ? c.speed.rate : 1));
	return { start: c.sourceIn, end: c.sourceIn + len };
}

// ---------------------------------------------------------------------------------------------------------------
// Highlight (AS-020): Source Text keys at each word's start whose runs colour the active word ("word"), every word
// spoken so far ("karaoke"); "keywords" = static runs on the listed words (the longest word when none are listed).

const STYLE_KEY = 'jasper:subtitle-highlight';

/** Whether a clip's Source Text keys were made by the subtitle highlight (and may be rebuilt). */
export function isHighlightKeys(clip: Clip): boolean {
	const keys = (clip as { sourceTextKeyframes?: Keyframe<TextContent>[] }).sourceTextKeyframes;
	return !!keys?.length && keys.every((k) => (k as { tag?: string }).tag === STYLE_KEY);
}

function highlightRuns(
	content: TextContent,
	pos: ReadonlyArray<[number, number]>,
	pick: (i: number) => boolean,
	color: SubtitleHighlight['color'],
): TextContent['runs'] {
	const base = (content.runs ?? []).filter((r) => !(r as { tag?: string }).tag);
	const hl = pos
		.map(([a, b], i) => (pick(i) ? { from: a, to: b, style: { fill: [...color] as TextStyle['fill'] }, tag: STYLE_KEY } : null))
		.filter((r): r is NonNullable<typeof r> => !!r);
	const all = [...base, ...hl];
	return all.length ? (all as TextContent['runs']) : undefined;
}

/**
 * Rebuilds a subtitle's highlight from its words (mutates the clip): Source Text keys for `word` / `karaoke`, tagged
 * runs for `keywords`, nothing for `none` (tagged runs and keys removed). Hand-made Source Text keys are kept: the
 * highlight is then not drawn.
 */
export function applyHighlight(
	clip: TextClip,
	hl: SubtitleHighlight | undefined,
	newKeyId: () => string,
): void {
	const r = clip as TextClip & { sourceTextKeyframes?: Keyframe<TextContent>[] };
	const own = isHighlightKeys(clip as Clip);
	const hand = !!r.sourceTextKeyframes?.length && !own;
	// drop previous highlight data
	if (own) delete r.sourceTextKeyframes;
	const content = r.content as TextContent;
	if (content.runs?.some((x) => (x as { tag?: string }).tag === STYLE_KEY)) {
		const kept = content.runs.filter((x) => (x as { tag?: string }).tag !== STYLE_KEY);
		if (kept.length) content.runs = kept;
		else delete content.runs;
	}
	if (!hl || hl.mode === 'none' || hand) return;
	const cap = captionOf(clip as Clip);
	if (!cap?.words.length) return;
	const pos = locateWords(content.text, cap.words);
	if (!pos) return;
	if (hl.mode === 'keywords') {
		const list = new Set((hl.keywords ?? []).map(normalizeWord).filter(Boolean));
		let pick: (i: number) => boolean;
		if (list.size) pick = (i) => list.has(normalizeWord(cap.words[i]!.text));
		else {
			let best = 0;
			cap.words.forEach((w, i) => {
				if (normalizeWord(w.text).length > normalizeWord(cap.words[best]!.text).length) best = i;
			});
			pick = (i) => i === best;
		}
		const runs = highlightRuns(content, pos, pick, hl.color);
		if (runs) content.runs = runs;
		return;
	}
	const keys: Keyframe<TextContent>[] = [];
	const base = JSON.parse(JSON.stringify(content)) as TextContent;
	const at = (t: number, active: number) => {
		const runs = highlightRuns(
			base,
			pos,
			(i) => (hl.mode === 'word' ? i === active : i <= active),
			hl.color,
		);
		const value: TextContent = { ...base, ...(runs ? { runs } : {}) };
		if (!runs) delete value.runs;
		keys.push({
			id: newKeyId(),
			time: t,
			value,
			interpolation: 'hold',
			easeIn: { influence: 1 / 3, slope: 0 },
			easeOut: { influence: 1 / 3, slope: 0 },
			tag: STYLE_KEY,
		} as Keyframe<TextContent>);
	};
	// before the first word: nothing highlighted (karaoke) / nothing (word)
	at(clip.sourceIn, -1);
	cap.words.forEach((w, i) => {
		const t = Math.max(clip.sourceIn, w.start);
		if (keys.length && keys[keys.length - 1]!.time === t) keys.pop();
		at(t, i);
	});
	r.sourceTextKeyframes = keys;
}

// ---------------------------------------------------------------------------------------------------------------
// Template keys anchored to the In (AS-020): the effect instances a template added keep their keys at the same
// distance from the clip's In after a trim or a razor cut.

type Animish = { value: unknown; keyframes?: { time: number }[] };

/** Whether an effect instance was added by a subtitle template. */
export const isTemplateEffect = (fx: { subtitleTemplate?: unknown }) => typeof fx.subtitleTemplate === 'string';

/** Shifts the keys of the template's effect instances by the In's move since they were laid out (mutates). */
export function reanchorTemplateKeys(clip: TextClip): boolean {
	const cap = captionOf(clip as Clip);
	if (!cap || cap.anchorIn === undefined) return false;
	const delta = clip.speed.reverse ? 0 : clip.sourceIn - cap.anchorIn;
	if (delta === 0) return false;
	for (const fx of clip.effects) {
		if (!isTemplateEffect(fx as { subtitleTemplate?: unknown })) continue;
		for (const p of Object.values(fx.params) as Animish[])
			for (const k of p.keyframes ?? []) k.time = Math.max(0, k.time + delta);
	}
	(clip as { caption: TextClipCaption }).caption = { ...cap, anchorIn: clip.sourceIn };
	return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Subtitle export (AS-005): cues of a text-clip group in output time, for SRT / VTT and the other caption formats.

/**
 * Cues of a subtitle group (enabled clips on shown tracks, sorted), times in flicks relative to `range.start`
 * (output time). Overlapping clips (two tracks) are kept as separate cues.
 */
export function captionCuesForGroup(
	seq: Sequence,
	groupId: string,
	range?: { start: number; end: number },
): Cue[] {
	const rate = seq.settings.frameRate;
	const F = flicksPerFrame(rate);
	const hidden = new Set(seq.videoTracks.filter((t) => t.output === false).map((t) => t.id));
	const lo = range?.start ?? 0;
	const hi = range?.end ?? Number.POSITIVE_INFINITY;
	const out: Cue[] = [];
	for (const c of groupClips(seq, groupId)) {
		if (c.kind !== 'text' || !c.enabled || hidden.has(c.trackId)) continue;
		const a = Math.max(c.start, lo);
		const b = Math.min(c.start + c.duration, hi);
		if (b <= a) continue;
		const text = (c.content.text ?? '').replace(/\r\n?/g, '\n').trim();
		if (!text) continue;
		const cap = captionOf(c);
		out.push({
			start: (a - lo) * F,
			end: (b - lo) * F,
			text,
			...(cap?.speaker ? { speaker: cap.speaker } : {}),
		});
	}
	return out;
}
