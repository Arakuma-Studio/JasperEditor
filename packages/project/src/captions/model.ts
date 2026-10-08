// Caption clips: style resolution, presets, the words a caption shows, its pages (on-screen captions) with line
// layout, the export cues of a caption track, and the ownership rule of caption transcripts.
//
// Model (docs/wp-notes/captions.md): a `captions` clip on a caption track is one caption block. Its text is a
// transcript the clip owns (`mediaId: null`, words in clip content time starting at CAPTION_CONTENT_ORIGIN, S04:
// TR-052 "caption clips hold their own copy of the words"). A clip shows every word of its owned transcript; words
// with `breakBefore: 'segment'` start a new page (a multi-page clip pages through them in time), `'line'` forces a
// line break. Word times drive the active-word highlight and splits. A clip that references a media transcript
// (`mediaId` set) shows the words whose midpoint lies in its content range.
import type { Draft } from 'immer';
import { latest, peekIn } from '../commands/draft-read.ts';
import type { RGBA } from '../schema/common.ts';
import type { ProjectDocument } from '../schema/document.ts';
import type { Transcript, TranscriptWord } from '../schema/media.ts';
import type { CaptionStyle, CaptionsClip, Clip, Sequence, Track } from '../schema/sequence.ts';
import { FLICKS_PER_SECOND, flicksPerFrame, type Rational } from '../time.ts';
import type { Cue } from './formats/core.ts';
import { plainCaptionText } from './formats/core.ts';
import { speakerName } from './sequence-transcript.ts';
import { attachesToPrevious } from './words.ts';

/** Content time of the first word of a new caption: one hour, so a caption's head can be extended (CLP-005). */
export const CAPTION_CONTENT_ORIGIN = 3600 * FLICKS_PER_SECOND;
/** Default length of a new caption (Premiere: about three seconds). */
export const DEFAULT_CAPTION_SECONDS = 3;
/** Title-safe area: 80 % of the frame (10 % margins), Premiere's default safe margins. */
export const TITLE_SAFE_MARGIN = 0.1;

export type ResolvedCaptionStyle = CaptionStyle & {
	placement: 'bottom' | 'middle' | 'top';
	marginPct: number;
	linePct: number | null;
	positionPct: number | null;
};

const WHITE: RGBA = [1, 1, 1, 1];

/** The default caption style for a frame height (sizes scale with the frame; 1080 lines = the reference). */
export function defaultCaptionStyle(fontId: string, frameHeight = 1080): ResolvedCaptionStyle {
	const k = Math.max(1, frameHeight) / 1080;
	return {
		fontId,
		weight: 600,
		italic: false,
		sizePx: Math.max(8, Math.round(48 * k)),
		lineHeight: 1.25,
		trackingEm: 0,
		align: 'center',
		direction: 'auto',
		fill: [...WHITE],
		strokes: [],
		background: { color: [0, 0, 0, 0.6], paddingPx: Math.max(1, Math.round(12 * k)), radiusPx: 0 },
		shadow: null,
		allCaps: false,
		highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
		maxLines: 2,
		maxCharsPerLine: 42,
		maxSegmentMs: 7000,
		minGapMs: 80,
		boxWidthPct: 80,
		placement: 'bottom',
		marginPct: 0,
		linePct: null,
		positionPct: null,
	};
}

/** Track defaults ← clip overrides, with the optional fields defaulted (read-time defaults). */
export function resolveCaptionStyle(
	trackStyle: Partial<CaptionStyle> | undefined | null,
	clipStyle: Partial<CaptionStyle> | undefined | null,
	fallbackFontId: string,
	frameHeight: number,
): ResolvedCaptionStyle {
	const base = defaultCaptionStyle(trackStyle?.fontId ?? clipStyle?.fontId ?? fallbackFontId, frameHeight);
	const out = { ...base, ...(trackStyle ?? {}), ...(clipStyle ?? {}) } as ResolvedCaptionStyle;
	out.placement ??= 'bottom';
	out.marginPct ??= 0;
	out.linePct ??= null;
	out.positionPct ??= null;
	out.highlight = { ...base.highlight, ...(trackStyle?.highlight ?? {}), ...(clipStyle?.highlight ?? {}) };
	return out;
}

/** Built-in caption style presets (CAP-024). Values are partial styles applied over the track style. */
export type CaptionStylePreset = { id: string; name: string; style: Partial<CaptionStyle> };

export const BUILTIN_CAPTION_PRESETS: readonly CaptionStylePreset[] = [
	{
		id: 'builtin:default',
		name: 'Default (white on box)',
		style: {
			fill: [1, 1, 1, 1],
			weight: 600,
			italic: false,
			strokes: [],
			background: { color: [0, 0, 0, 0.6], paddingPx: 12, radiusPx: 0 },
			shadow: null,
			allCaps: false,
			highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
			placement: 'bottom',
		},
	},
	{
		id: 'builtin:broadcast',
		name: 'Broadcast (opaque box)',
		style: {
			fill: [1, 1, 1, 1],
			weight: 500,
			strokes: [],
			background: { color: [0, 0, 0, 1], paddingPx: 10, radiusPx: 0 },
			shadow: null,
			allCaps: false,
			highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
		},
	},
	{
		id: 'builtin:outline',
		name: 'Outline',
		style: {
			fill: [1, 1, 1, 1],
			weight: 700,
			strokes: [{ color: [0, 0, 0, 1], widthPx: 4, position: 'outside' }],
			background: null,
			shadow: { color: [0, 0, 0, 0.6], angleDeg: 135, distancePx: 3, blurPx: 4 },
			highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
		},
	},
	{
		id: 'builtin:yellow',
		name: 'Yellow',
		style: {
			fill: [1, 0.92, 0.2, 1],
			weight: 600,
			strokes: [{ color: [0, 0, 0, 1], widthPx: 3, position: 'outside' }],
			background: null,
			shadow: null,
			highlight: { mode: 'none', color: [1, 1, 1, 1] },
		},
	},
	{
		id: 'builtin:social',
		name: 'Social (bold, karaoke)',
		style: {
			fill: [1, 1, 1, 1],
			weight: 800,
			allCaps: true,
			strokes: [{ color: [0, 0, 0, 1], widthPx: 5, position: 'outside' }],
			background: null,
			shadow: { color: [0, 0, 0, 0.5], angleDeg: 135, distancePx: 4, blurPx: 6 },
			highlight: { mode: 'karaoke', color: [1, 0.84, 0, 1] },
			placement: 'middle',
			maxLines: 2,
			maxCharsPerLine: 24,
		},
	},
	{
		id: 'builtin:minimal',
		name: 'Minimal (shadow)',
		style: {
			fill: [1, 1, 1, 1],
			weight: 500,
			strokes: [],
			background: null,
			shadow: { color: [0, 0, 0, 0.85], angleDeg: 90, distancePx: 2, blurPx: 6 },
			highlight: { mode: 'none', color: [1, 0.84, 0, 1] },
		},
	},
];

/** A preset by id: built-ins, then the project's saved presets. */
export function findCaptionPreset(
	doc: Pick<ProjectDocument, 'settings'>,
	id: string,
): CaptionStylePreset | null {
	return (
		BUILTIN_CAPTION_PRESETS.find((p) => p.id === id) ??
		(doc.settings.captionStylePresets as CaptionStylePreset[] | undefined)?.find((p) => p.id === id) ??
		null
	);
}

// ---------------------------------------------------------------- words and pages

/** Whether a transcript belongs to the caption clips that show it (no media). */
export function isCaptionTranscript(t: Pick<Transcript, 'mediaId'>): boolean {
	return t.mediaId === null;
}

/** Content range `[a, b)` of a clip in flicks. */
export function clipContentRange(
	clip: Pick<Clip, 'sourceIn' | 'duration' | 'speed'>,
	rate: Rational,
): [number, number] {
	return [clip.sourceIn, clip.sourceIn + Math.round(clip.duration * flicksPerFrame(rate) * clip.speed.rate)];
}

/** The words a caption clip shows (see the module docs). */
export function captionClipWords(
	doc: Pick<ProjectDocument, 'transcripts'>,
	clip: Pick<CaptionsClip, 'transcriptId' | 'sourceIn' | 'duration' | 'speed'>,
	rate: Rational,
): TranscriptWord[] {
	const t = doc.transcripts[clip.transcriptId];
	if (!t) return [];
	if (isCaptionTranscript(t)) return t.words;
	const [a, b] = clipContentRange(clip, rate);
	return t.words.filter((w) => {
		const mid = w.start + Math.floor((w.end - w.start) / 2);
		return mid >= a && mid < b;
	});
}

/** One word as drawn: text (markup kept), sequence frames `[start, end)`, and whether a space precedes it. */
export type CaptionPageWord = { text: string; start: number; end: number; space: boolean };
/** An on-screen caption: sequence frames `[start, end)` and its lines of words. */
export type CaptionPage = {
	start: number;
	end: number;
	lines: CaptionPageWord[][];
	speaker: string | null;
	/** Wrapped line count exceeds the style's `maxLines` or a line exceeds `maxCharsPerLine` (shown as a warning). */
	overflow: boolean;
};

const plainLen = (s: string) => [...plainCaptionText(s)].length;

/** Lines of words: breaks at `breakBefore: 'line'` and greedy wrapping at `maxChars` characters. */
export function wrapCaptionWords<W extends { text: string; breakBefore?: string }>(
	words: readonly W[],
	maxChars: number,
): W[][] {
	const lines: W[][] = [];
	let cur: W[] = [];
	let len = 0;
	words.forEach((w, i) => {
		const l = plainLen(w.text);
		const space = cur.length > 0 && !attachesToPrevious(w.text) ? 1 : 0;
		if (cur.length && ((i > 0 && w.breakBefore === 'line') || len + space + l > maxChars)) {
			lines.push(cur);
			cur = [];
			len = 0;
		}
		len += (cur.length && !attachesToPrevious(w.text) ? 1 : 0) + l;
		cur.push(w);
	});
	if (cur.length) lines.push(cur);
	return lines;
}

const LINGER = FLICKS_PER_SECOND / 2;
const MIN_PAGE = Math.round(0.7 * FLICKS_PER_SECOND);

/**
 * The pages of a caption clip in sequence frames (the same function feeds preview, burn-in, sidecar and embedded
 * export, so they agree). A single-page caption shows for the whole clip; a multi-page caption shows each page from
 * its first word (the first page from the clip start) until the next page's start or its last word's end + 0.5 s
 * (at least 0.7 s), whichever is sooner, and the last page until the clip ends (S04:TR-053).
 */
export function captionPages(
	doc: Pick<ProjectDocument, 'transcripts'>,
	seq: Pick<Sequence, 'settings'>,
	clip: CaptionsClip,
	style: Pick<CaptionStyle, 'maxCharsPerLine' | 'maxLines' | 'allCaps'>,
): CaptionPage[] {
	const rate = seq.settings.frameRate;
	const words = captionClipWords(doc, clip, rate);
	if (!words.length) return [];
	const t = doc.transcripts[clip.transcriptId]!;
	const step = flicksPerFrame(rate) * clip.speed.rate;
	const clipEnd = clip.start + clip.duration;
	const toFrame = (c: number) => clip.start + Math.round((c - clip.sourceIn) / step);
	const groups: TranscriptWord[][] = [];
	for (const w of words) {
		if (!groups.length || (w.breakBefore === 'segment' && groups[groups.length - 1]!.length)) groups.push([]);
		groups[groups.length - 1]!.push(w);
	}
	type Raw = { start: number; words: TranscriptWord[] };
	const raw: Raw[] = [];
	groups.forEach((g, k) => {
		const s = k === 0 ? clip.start : Math.min(clipEnd, Math.max(clip.start, toFrame(g[0]!.start)));
		if (s >= clipEnd) return;
		while (raw.length && raw[raw.length - 1]!.start >= s) raw.pop();
		raw.push({ start: s, words: g });
	});
	const minFrames = Math.max(1, Math.round(MIN_PAGE / step));
	return raw.map((p, k) => {
		const next = raw[k + 1];
		let end = clipEnd;
		if (next) {
			const last = p.words[p.words.length - 1]!;
			end = Math.min(next.start, Math.max(toFrame(last.end + LINGER), p.start + minFrames));
			end = Math.max(end, p.start + 1);
		}
		const lines = wrapCaptionWords(p.words, Math.max(1, style.maxCharsPerLine)).map((line) =>
			line.map(
				(w, i): CaptionPageWord => ({
					text: style.allCaps ? w.text.toUpperCase() : w.text,
					start: Math.max(p.start, toFrame(w.start)),
					end: Math.max(p.start + 1, Math.min(end, toFrame(w.end))),
					space: i > 0 && !attachesToPrevious(w.text),
				}),
			),
		);
		const overflow =
			lines.length > Math.max(1, style.maxLines) ||
			lines.some(
				(l) => plainLen(l.map((w) => (w.space ? ` ${w.text}` : w.text)).join('')) > style.maxCharsPerLine,
			);
		return { start: p.start, end, lines, speaker: speakerName(t, p.words[0]!.speaker), overflow };
	});
}

/** A page's text: lines joined by `\n` (markup kept). */
export function captionPageText(p: Pick<CaptionPage, 'lines'>): string {
	return p.lines.map((l) => l.map((w) => (w.space ? ` ${w.text}` : w.text)).join('')).join('\n');
}

/** The full text of a caption clip as the user edits it: words joined, `\n` at line breaks, blank line at pages. */
export function captionClipText(
	doc: Pick<ProjectDocument, 'transcripts'>,
	clip: CaptionsClip,
	rate: Rational,
): string {
	const words = captionClipWords(doc, clip, rate);
	let out = '';
	words.forEach((w, i) => {
		if (i > 0)
			out +=
				w.breakBefore === 'segment'
					? '\n\n'
					: w.breakBefore === 'line'
						? '\n'
						: attachesToPrevious(w.text)
							? ''
							: ' ';
		out += w.text;
	});
	return out;
}

/** The speaker shown for a caption clip (its first word's). */
export function captionClipSpeaker(
	doc: Pick<ProjectDocument, 'transcripts'>,
	clip: CaptionsClip,
	rate: Rational,
): string | null {
	const t = doc.transcripts[clip.transcriptId];
	const w = captionClipWords(doc, clip, rate)[0];
	return t && w ? speakerName(t, w.speaker) : null;
}

// ---------------------------------------------------------------- tracks and export cues

/** Caption clips of a track, sorted by start. */
export function captionClipsOf(seq: Sequence, trackId: string): CaptionsClip[] {
	return Object.values(seq.clips)
		.filter((c): c is CaptionsClip => c.kind === 'captions' && c.trackId === trackId)
		.sort((a, b) => a.start - b.start);
}

/** The active caption track: `activeCaptionTrackId` if it exists, else C1 (null without caption tracks). */
export function activeCaptionTrack(seq: Sequence): Track | null {
	const id = (seq as { activeCaptionTrackId?: string | null }).activeCaptionTrackId;
	return seq.captionTracks.find((t) => t.id === id) ?? seq.captionTracks[0] ?? null;
}

/** WebVTT cue settings for a caption: the imported settings with the clip's placement overrides applied. */
export function vttSettingsFor(clip: Pick<CaptionsClip, 'style' | 'cue'>): string {
	const kv = new Map<string, string>();
	for (const part of (clip.cue?.settings ?? '').split(/\s+/).filter(Boolean)) {
		const i = part.indexOf(':');
		if (i > 0) kv.set(part.slice(0, i), part.slice(i + 1));
	}
	const st = clip.style as Partial<CaptionStyle>;
	if (st.linePct !== undefined) {
		if (st.linePct === null) kv.delete('line');
		else kv.set('line', `${round2(st.linePct)}%`);
	}
	if (st.positionPct !== undefined) {
		if (st.positionPct === null) kv.delete('position');
		else kv.set('position', `${round2(st.positionPct)}%`);
	}
	if (st.align !== undefined)
		kv.set('align', st.align === 'left' ? 'left' : st.align === 'right' ? 'right' : 'center');
	return [...kv].map(([k, v]) => `${k}:${v}`).join(' ');
}

const round2 = (x: number) => Math.round(x * 100) / 100;

/** Placement overrides from WebVTT cue settings (`line:N%`, `position:N%`, `align:`), as a partial style. */
export function styleFromVttSettings(settings: string): Partial<CaptionStyle> {
	const out: Partial<CaptionStyle> = {};
	for (const part of settings.split(/\s+/)) {
		const i = part.indexOf(':');
		if (i <= 0) continue;
		const k = part.slice(0, i);
		const v = part.slice(i + 1).split(',')[0] ?? '';
		const pct = /^(\d+(?:\.\d+)?)%$/.exec(v);
		if (k === 'line' && pct) out.linePct = Math.min(100, Number(pct[1]));
		else if (k === 'position' && pct) out.positionPct = Math.min(100, Number(pct[1]));
		else if (k === 'align') {
			if (v === 'start' || v === 'left') out.align = 'left';
			else if (v === 'end' || v === 'right') out.align = 'right';
			else if (v === 'center' || v === 'middle') out.align = 'center';
		}
	}
	return out;
}

/**
 * The cues of a caption track for export, in output time: flicks from `range.start` (sequence frames). Disabled
 * clips are skipped; pages are clipped to the range. Speakers become WebVTT voices / TTML agents.
 */
export function captionCuesForTrack(
	doc: ProjectDocument,
	seq: Sequence,
	trackId: string,
	range?: { start: number; end: number },
): Cue[] {
	const F = flicksPerFrame(seq.settings.frameRate);
	const r = range ?? { start: 0, end: Number.POSITIVE_INFINITY };
	const track = seq.captionTracks.find((t) => t.id === trackId);
	const fallbackFont = Object.values(doc.fonts)[0]?.id ?? '';
	const out: Cue[] = [];
	for (const c of captionClipsOf(seq, trackId)) {
		if (!c.enabled) continue;
		const style = resolveCaptionStyle(track?.styleDefaults, c.style, fallbackFont, seq.settings.height);
		const pages = captionPages(doc, seq, c, style);
		pages.forEach((p) => {
			const a = Math.max(p.start, r.start);
			const b = Math.min(p.end, r.end);
			if (b <= a) return;
			const settings = vttSettingsFor(c);
			out.push({
				start: (a - r.start) * F,
				end: (b - r.start) * F,
				text: captionPageText(p),
				speaker: p.speaker,
				id: pages.length === 1 ? (c.cue?.id ?? null) : null,
				...(settings ? { settings } : {}),
			});
		});
	}
	return out.sort((x, y) => x.start - y.start);
}

// ---------------------------------------------------------------- ownership

/**
 * Caption transcripts belong to one clip. When an edit leaves several captions clips referencing the same caption
 * transcript (split, duplicate, paste, an insert across a caption, a range cut), each gets its own copy holding the
 * words whose midpoint falls in its content range (a word outside every range goes to the nearest clip); a clip
 * left without words gets all of them, so both halves of a split keep the text when no word boundary lies between
 * them. Runs once per transaction, before orphans are collected.
 */
export function normalizeCaptionOwnership(doc: Draft<ProjectDocument>, newId: () => string): void {
	// perf-core: found on current values (draft-read.ts); only clips sharing a transcript are drafted.
	const found = new Map<string, Array<{ seqId: string; key: string }>>();
	const seqs = latest(doc.sequences);
	for (const seqId of Object.keys(seqs)) {
		const clips = latest(latest(seqs[seqId]!).clips);
		for (const key of Object.keys(clips)) {
			const c = latest(clips[key]!);
			if (c.kind !== 'captions') continue;
			const t = peekIn(doc.transcripts, (c as CaptionsClip).transcriptId);
			if (!t || !isCaptionTranscript(t)) continue;
			const list = found.get(t.id) ?? [];
			list.push({ seqId, key });
			found.set(t.id, list);
		}
	}
	const refs = new Map<string, Array<{ seqId: string; clip: Draft<CaptionsClip> }>>();
	for (const [tid, keys] of found) {
		if (keys.length < 2) continue;
		refs.set(
			tid,
			keys.map(({ seqId, key }) => ({
				seqId,
				clip: doc.sequences[seqId]!.clips[key] as Draft<CaptionsClip>,
			})),
		);
	}
	for (const [tid, list] of refs) {
		if (list.length < 2) continue;
		list.sort((a, b) =>
			a.seqId === b.seqId
				? a.clip.start - b.clip.start || a.clip.id.localeCompare(b.clip.id)
				: a.seqId.localeCompare(b.seqId),
		);
		// A ripple cut through a caption (extract, ripple trim, a removed range on a sync-locked caption track) leaves
		// two abutting pieces whose content is not continuous: they are one caption again, shortened (Premiere).
		for (let i = 0; i + 1 < list.length; i++) {
			const a = list[i]!;
			const b = list[i + 1]!;
			if (a.seqId !== b.seqId || a.clip.trackId !== b.clip.trackId) continue;
			const seq = doc.sequences[a.seqId]!;
			const contentEnd = clipContentRange(a.clip, seq.settings.frameRate)[1];
			if (a.clip.start + a.clip.duration !== b.clip.start || b.clip.sourceIn <= contentEnd) continue;
			a.clip.duration += b.clip.duration;
			delete seq.clips[b.clip.id];
			for (const g of [...Object.values(seq.links), ...Object.values(seq.groups)])
				g.members = g.members.filter((m) => m !== b.clip.id);
			list.splice(i + 1, 1);
			i--;
		}
		if (list.length < 2) continue;
		const t = doc.transcripts[tid]!;
		const words = JSON.parse(JSON.stringify(t.words)) as TranscriptWord[];
		const ranges = list.map(({ seqId, clip }) =>
			clipContentRange(clip, doc.sequences[seqId]!.settings.frameRate),
		);
		const parts: TranscriptWord[][] = list.map(() => []);
		for (const w of words) {
			const mid = w.start + Math.floor((w.end - w.start) / 2);
			let best = 0;
			let bestDist = Number.POSITIVE_INFINITY;
			ranges.forEach(([a, b], i) => {
				const d = mid < a ? a - mid : mid >= b ? mid - b + 1 : 0;
				if (d < bestDist) {
					bestDist = d;
					best = i;
				}
			});
			parts[best]!.push(w);
		}
		list.forEach(({ clip }, i) => {
			let mine = parts[i]!;
			if (!mine.length) mine = JSON.parse(JSON.stringify(words)) as TranscriptWord[];
			else
				mine = mine.map((w, k) =>
					k === 0 && w.breakBefore !== 'none' ? { ...w, breakBefore: 'none' as const } : w,
				);
			if (i === 0) {
				t.words = mine as Draft<TranscriptWord>[];
				return;
			}
			const id = newId();
			doc.transcripts[id] = {
				...(JSON.parse(JSON.stringify(t)) as Transcript),
				id,
				words: mine,
			} as Draft<Transcript>;
			clip.transcriptId = id;
		});
	}
}

/**
 * Per-transaction normalisation of caption data: caption transcript ownership, and an active caption track that
 * no longer exists falls back to C1.
 */
export function normalizeCaptionData(doc: Draft<ProjectDocument>, newTranscriptId: () => string): void {
	normalizeCaptionOwnership(doc, newTranscriptId);
	for (const [id, seq] of Object.entries(latest(doc.sequences))) {
		const s = latest(seq) as { activeCaptionTrackId?: string | null; captionTracks: Track[] };
		if (s.activeCaptionTrackId && !latest(s.captionTracks).some((t) => t.id === s.activeCaptionTrackId))
			(doc.sequences[id] as { activeCaptionTrackId?: string | null }).activeCaptionTrackId =
				latest(s.captionTracks)[0]?.id ?? null;
	}
}
