// Punch-in start on a caption (`start: 'caption'`): the user's zooms that are not at the clip midpoint mostly start on
// a caption's first frame. The measured rule (docs/wp-notes/edit-automation.md "Caption start", with its agreement):
//   window: caption starts from max(0.8 s, 25 % of the clip) after the clip start to 0.6 s before the cut;
//   1. the first caption in the window opening with a contrast connector (pero / aunque / sino) → start on it;
//   2. else a clause start (the previous caption ends in punctuation, or this one opens with a connector or a capital)
//      at 40–80 % of the clip, nearest 60 %;
//   3. else the caption start nearest 60 % of the clip.
// The captions are the sequence's subtitle text clips (the largest subtitle group), else the transcript words grouped
// the way the user's subtitles group them (the Pixel Pop rules: ≤ 13 characters, ≤ 3 words, a break at punctuation and
// at 0.3 s pauses). Pure.

import { frameAt } from '../captions/formats/rate.ts';
import { sequenceWords } from '../captions/sequence-transcript.ts';
import { joinWords } from '../captions/subtitles/clips.ts';
import { groupSubtitleWords, type LayoutWord } from '../captions/subtitles/layout.ts';
import { resolveSubtitleRules } from '../captions/subtitles/rules.ts';
import { PIXEL_POP_RULES } from '../captions/subtitles/templates.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';

/** A caption as the punch-in start reads it: its first frame (sequence) and its text. */
export type CaptionCue = { frame: number; text: string };

/** Which tier of the rule chose the start. */
export type CaptionStartRule = 'contrast' | 'clause' | 'nearest';

const MIN_LEAD_SECONDS = 0.8;
const MIN_LEAD_SHARE = 0.25;
const MIN_TAIL_SECONDS = 0.6;
const CLAUSE_FROM = 0.4;
const CLAUSE_TO = 0.8;
const TARGET = 0.6;

const CONTRAST = new Set(['pero', 'aunque', 'sino']);
/** Openers of a clause in the user's Spanish (with the contrast connectors). */
const CONNECTORS = new Set(
	(
		'y e entonces luego después ahora también además porque pues o bueno cuando hasta ya así como si ' +
		'literalmente obviamente básicamente incluso encima'
	).split(' '),
);
const ENDS_IN_PUNCTUATION = /[,.!?…;:]$/u;
const tokens = (s: string): string[] => s.match(/[\p{L}\p{N}_]+/gu) ?? [];
const isUpper = (ch: string) => ch !== ch.toLowerCase() && ch === ch.toUpperCase();

function contrastAt(cues: readonly CaptionCue[], i: number): boolean {
	const w = tokens(cues[i]!.text);
	return w.length > 0 && CONTRAST.has(w[0]!.toLowerCase());
}

function clauseAt(cues: readonly CaptionCue[], i: number): boolean {
	const w = tokens(cues[i]!.text);
	if (!w.length) return false;
	const first = w[0]!.toLowerCase();
	const prev = i > 0 ? cues[i - 1]!.text.trimEnd() : '';
	return ENDS_IN_PUNCTUATION.test(prev) || CONNECTORS.has(first) || CONTRAST.has(first) || isUpper(w[0]![0]!);
}

/**
 * The caption start a punch-in on the clip `[start, start + duration)` starts on (see the file comment), not after
 * `latest` (the last frame its ramp fits from); null when no caption with words starts in the window. `cues` sorted by
 * frame; `fps` the sequence rate.
 */
export function captionStart(
	clip: { start: number; duration: number },
	cues: readonly CaptionCue[],
	fps: number,
	latest: number,
): { frame: number; rule: CaptionStartRule } | null {
	const d = clip.duration;
	if (!(fps > 0) || !Number.isFinite(fps) || !(d > 0)) return null;
	const eps = 1e-6;
	const lo = clip.start + Math.max(MIN_LEAD_SECONDS * fps, MIN_LEAD_SHARE * d);
	const hi = Math.min(clip.start + d - MIN_TAIL_SECONDS * fps, latest);
	// first cue at or after lo (cues are sorted)
	let i = 0;
	let j = cues.length;
	while (i < j) {
		const m = (i + j) >> 1;
		if (cues[m]!.frame < lo - eps) i = m + 1;
		else j = m;
	}
	const inWindow: number[] = [];
	for (let k = i; k < cues.length && cues[k]!.frame <= hi + eps; k++)
		if (tokens(cues[k]!.text).length) inWindow.push(k);
	if (!inWindow.length) return null;
	const contrast = inWindow.find((k) => contrastAt(cues, k));
	if (contrast !== undefined) return { frame: cues[contrast]!.frame, rule: 'contrast' };
	const target = clip.start + TARGET * d;
	const nearest = (ks: readonly number[]) => {
		let best = ks[0]!;
		for (const k of ks)
			if (Math.abs(cues[k]!.frame - target) < Math.abs(cues[best]!.frame - target)) best = k;
		return cues[best]!.frame;
	};
	const clauses = inWindow.filter((k) => {
		const f = cues[k]!.frame;
		return (
			f >= clip.start + CLAUSE_FROM * d - eps && f <= clip.start + CLAUSE_TO * d + eps && clauseAt(cues, k)
		);
	});
	if (clauses.length) return { frame: nearest(clauses), rule: 'clause' };
	return { frame: nearest(inWindow), rule: 'nearest' };
}

type SubtitleClip = {
	kind: string;
	start: number;
	enabled?: boolean;
	content?: { text?: unknown };
	caption?: { groupId?: unknown; words?: { text: string }[] };
};

/** The captions of a sequence: its largest subtitle group, else the transcript words grouped like the user's subtitles. */
export function captionCues(doc: ProjectDocument, seq: Sequence): CaptionCue[] {
	const groups = new Map<string, CaptionCue[]>();
	for (const raw of Object.values(seq.clips)) {
		const c = raw as unknown as SubtitleClip;
		if (c.kind !== 'text' || c.enabled === false || !c.caption || typeof c.caption.groupId !== 'string')
			continue;
		const text =
			typeof c.content?.text === 'string'
				? c.content.text
				: joinWords(Array.isArray(c.caption.words) ? c.caption.words : []);
		const list = groups.get(c.caption.groupId) ?? [];
		list.push({ frame: c.start, text });
		groups.set(c.caption.groupId, list);
	}
	let best: CaptionCue[] = [];
	for (const g of groups.values()) if (g.length > best.length) best = g;
	if (best.length) return best.sort((a, b) => a.frame - b.frame);
	let words: ReturnType<typeof sequenceWords>;
	try {
		words = sequenceWords(doc, seq);
	} catch {
		return [];
	}
	if (!words.length) return [];
	const rate = seq.settings.frameRate;
	const layout: LayoutWord[] = words.map((w) => ({
		text: w.text,
		start: w.start,
		end: w.end,
		speaker: w.speakerKey,
	}));
	const language = doc.transcripts[words[0]!.transcriptId]?.language ?? null;
	const groupsOf = groupSubtitleWords(
		layout,
		layout.map((w) => w.text),
		resolveSubtitleRules(PIXEL_POP_RULES),
		rate,
		language,
	);
	return groupsOf.map(([a, b]) => ({
		frame: frameAt(words[a]!.start, rate),
		text: joinWords(words.slice(a, b)),
	}));
}
