// Clean Up Voice review model (spec 14 TC-040…TC-043; docs/wp-notes/transcript-cleanup.md "Clean Up UI"): pure helpers
// the panel, the keyboard commands and the timeline overlay share — kind names and colours, the review decisions
// (per item, per kind, retake choices) and what they mean for each finding, the marks of the transcript words (what
// the plan removes, coloured by why; review findings; lexical fillers), the findings list grouped by kind (virtualised
// geometry), where a finding sits on the timeline, the overlay bands (cut / kept pause / padding), the commands of
// Apply and of the two derived previews ("Play result", "Play removed").
import {
	type CleanupAnalysis,
	type CleanupDecisions,
	type CleanupFinding,
	type CleanupScope,
	type CleanupVoice,
	type Command,
	cleanupFindingFrames,
	cleanupFindingMedia,
	type FindingKind,
	FLICKS_PER_SECOND,
	flicksPerFrame,
	isAccepted,
	type ProjectDocument,
	type Sequence,
	type SeqWord,
	sequenceDuration,
} from '@jasper/project';
import { t } from '../../../i18n/runtime.ts';

/** Kinds in the order the findings list shows them (what removes most first, review-only kinds last). */
export const KIND_ORDER: readonly FindingKind[] = [
	'retake',
	'hidden-retake',
	'restart',
	'false-start',
	'stutter',
	'filler-vocalic',
	'filler-phrase',
	'filler-lexical',
	'off-script',
	'head-tail',
	'pause',
	'breath',
	'untranscribed',
	'asr-suspect',
	'hallucination',
];

/** Display names of the finding kinds. */
export const KIND_LABELS: Record<FindingKind, string> = {
	retake: 'Retakes',
	'hidden-retake': 'Hidden retakes',
	restart: 'Restarts',
	'false-start': 'False starts',
	stutter: 'Repeats',
	'filler-vocalic': 'Fillers',
	'filler-phrase': 'Filler phrases',
	'filler-lexical': 'Discourse markers',
	'off-script': 'Off-script talk',
	'head-tail': 'Head and tail',
	pause: 'Pauses',
	breath: 'Breaths',
	untranscribed: 'Voice without words',
	'asr-suspect': 'Transcription suspects',
	hallucination: 'Hallucinations',
};

/** Strike-through / marker colour per kind (design tokens). */
export const KIND_COLOR: Record<FindingKind, string> = {
	retake: 'var(--pr-marker-red)',
	'hidden-retake': 'var(--pr-label-iris)',
	restart: 'var(--pr-marker-orange)',
	'false-start': 'var(--pr-label-mango)',
	stutter: 'var(--pr-label-rose)',
	'filler-vocalic': 'var(--pr-marker-purple)',
	'filler-phrase': 'var(--pr-label-violet)',
	'filler-lexical': 'var(--pr-label-lavender)',
	'off-script': 'var(--pr-marker-cyan)',
	'head-tail': 'var(--pr-label-teal)',
	pause: 'var(--pr-marker-blue)',
	breath: 'var(--pr-label-cerulean)',
	untranscribed: 'var(--pr-marker-yellow)',
	'asr-suspect': 'var(--pr-warning)',
	hallucination: 'var(--pr-label-magenta)',
};

/** The user's decisions in a review (finding ids of one analysis; retake group id → kept take). */
export type UiDecisions = {
	accept: readonly string[];
	reject: readonly string[];
	acceptKinds: readonly FindingKind[];
	rejectKinds: readonly FindingKind[];
	retakes: Readonly<Record<string, number>>;
};

export const EMPTY_DECISIONS: UiDecisions = {
	accept: [],
	reject: [],
	acceptKinds: [],
	rejectKinds: [],
	retakes: {},
};

export function toCleanupDecisions(d: UiDecisions): CleanupDecisions {
	return {
		...(d.accept.length ? { accept: d.accept } : {}),
		...(d.reject.length ? { reject: d.reject } : {}),
		...(d.acceptKinds.length ? { acceptKinds: d.acceptKinds } : {}),
		...(d.rejectKinds.length ? { rejectKinds: d.rejectKinds } : {}),
		...(Object.keys(d.retakes).length ? { retakes: d.retakes } : {}),
	};
}

/** Whether a finding is removed under the decisions (and the sequence's remembered rejections). */
export function findingAccepted(f: CleanupFinding, d: UiDecisions, rejected: ReadonlySet<string>): boolean {
	return isAccepted(f, toCleanupDecisions(d), rejected);
}

const without = (xs: readonly string[], id: string) => xs.filter((x) => x !== id);

/** Accept / reject / clear one finding (an item decision wins over its kind's). */
export function decideItem(d: UiDecisions, id: string, what: 'accept' | 'reject' | 'clear'): UiDecisions {
	const accept = without(d.accept, id);
	const reject = without(d.reject, id);
	if (what === 'accept') accept.push(id);
	if (what === 'reject') reject.push(id);
	return { ...d, accept, reject };
}

/** Accept / reject / clear a whole kind: its item decisions are cleared so the kind applies to every item. */
export function decideKind(
	d: UiDecisions,
	kind: FindingKind,
	what: 'accept' | 'reject' | 'clear',
	findings: readonly CleanupFinding[],
): UiDecisions {
	const ofKind = new Set(findings.filter((f) => f.kind === kind).map((f) => f.id));
	const acceptKinds = d.acceptKinds.filter((k) => k !== kind);
	const rejectKinds = d.rejectKinds.filter((k) => k !== kind);
	if (what === 'accept') acceptKinds.push(kind);
	if (what === 'reject') rejectKinds.push(kind);
	return {
		...d,
		accept: d.accept.filter((id) => !ofKind.has(id)),
		reject: d.reject.filter((id) => !ofKind.has(id)),
		acceptKinds,
		rejectKinds,
	};
}

/** Keep take `index` of a retake group (the others are removed). */
export function chooseTake(d: UiDecisions, groupId: string, index: number): UiDecisions {
	return { ...d, retakes: { ...d.retakes, [groupId]: index } };
}

/** Index of the range containing `frame` in sorted disjoint ranges, or −1. */
export function rangeIndexAt(ranges: ReadonlyArray<{ start: number; end: number }>, frame: number): number {
	let lo = 0;
	let hi = ranges.length;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (ranges[mid]!.end <= frame) lo = mid + 1;
		else hi = mid;
	}
	const r = ranges[lo];
	return r && r.start <= frame ? lo : -1;
}

export type WordMark = {
	/** The plan removes the word (what Apply will cut). */
	removed: boolean;
	/** Why (the accepted finding's kind, else the retake group's), null when only the planner removes it. */
	kind: FindingKind | null;
	/** A review finding covers it and is not accepted (dotted underline). */
	review: boolean;
	/** A lexical filler (lighter). */
	lexical: boolean;
	/** The finding a click on the word selects. */
	findingId: string | null;
};

const KIND_RANK = new Map(KIND_ORDER.map((k, i) => [k, i]));

/** The marks of the sequence words (index-aligned with `words`). */
export function wordMarks(
	words: readonly SeqWord[],
	seq: Sequence,
	analysis: CleanupAnalysis,
	d: UiDecisions,
	rejected: ReadonlySet<string>,
): WordMark[] {
	const F = flicksPerFrame(seq.settings.frameRate);
	const byWord = new Map<string, CleanupFinding[]>();
	for (const f of analysis.findings) {
		if (!f.words) continue;
		const m = cleanupFindingMedia(analysis, f);
		if (!m) continue;
		for (let i = f.words[0]; i <= f.words[1]; i++) {
			const k = `${m.transcriptId}:${i}`;
			const list = byWord.get(k);
			if (list) list.push(f);
			else byWord.set(k, [f]);
		}
	}
	const inTake = new Set<string>();
	for (const g of analysis.groups) {
		const f = analysis.findings.find((x) => x.group === g.id);
		const m = f ? cleanupFindingMedia(analysis, f) : null;
		if (!m) continue;
		g.takes.forEach((take, ti) => {
			if (ti === g.chosen) return;
			for (let i = take.words[0]; i <= take.words[1]; i++) inTake.add(`${m.transcriptId}:${i}`);
		});
	}
	const ranges = analysis.plan.ranges;
	return words.map((w) => {
		const key = `${w.transcriptId}:${w.index}`;
		const fs = byWord.get(key) ?? [];
		const mid = Math.floor((w.start + (w.end - w.start) / 2) / F);
		const removed = rangeIndexAt(ranges, mid) >= 0;
		let acc: CleanupFinding | null = null;
		let review = false;
		let lexical = false;
		for (const f of fs) {
			const on = findingAccepted(f, d, rejected);
			if (on && (!acc || (KIND_RANK.get(f.kind) ?? 99) < (KIND_RANK.get(acc.kind) ?? 99))) acc = f;
			if (!on && f.suggested === 'review') review = true;
			if (f.kind === 'filler-lexical') lexical = true;
		}
		const kind = removed ? (acc?.kind ?? (inTake.has(key) ? 'retake' : null)) : null;
		return { removed, kind, review, lexical, findingId: acc?.id ?? fs[0]?.id ?? null };
	});
}

/** Frame-run findings (pauses, breaths, voice without words) by the sequence word they come before. */
export function inlineFindings(
	words: readonly SeqWord[],
	seq: Sequence,
	analysis: CleanupAnalysis,
): { before: Map<number, CleanupFinding[]>; after: CleanupFinding[] } {
	const F = flicksPerFrame(seq.settings.frameRate);
	const before = new Map<number, CleanupFinding[]>();
	const after: CleanupFinding[] = [];
	const starts = words.map((w) => w.start);
	for (const f of analysis.findings) {
		if (f.words) continue;
		const at = cleanupFindingFrames(seq, analysis, f);
		if (!at) continue;
		const fl = at.start * F;
		let lo = 0;
		let hi = starts.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (starts[mid]! < fl) lo = mid + 1;
			else hi = mid;
		}
		if (lo >= words.length) after.push(f);
		else {
			const list = before.get(lo);
			if (list) list.push(f);
			else before.set(lo, [f]);
		}
	}
	return { before, after };
}

// ---------------------------------------------------------------------------------------------------------------
// Findings list (grouped by kind, virtualised with fixed row heights)

export type FindingGroup = {
	kind: FindingKind;
	findings: CleanupFinding[];
	/** How many of them are removed under the decisions. */
	accepted: number;
};

export function groupFindings(
	analysis: Pick<CleanupAnalysis, 'findings'>,
	d: UiDecisions,
	rejected: ReadonlySet<string>,
): FindingGroup[] {
	const by = new Map<FindingKind, CleanupFinding[]>();
	for (const f of analysis.findings) {
		const l = by.get(f.kind);
		if (l) l.push(f);
		else by.set(f.kind, [f]);
	}
	const out: FindingGroup[] = [];
	for (const kind of KIND_ORDER) {
		const findings = by.get(kind);
		if (!findings?.length) continue;
		findings.sort((a, b) => a.range.start - b.range.start);
		out.push({ kind, findings, accepted: findings.filter((f) => findingAccepted(f, d, rejected)).length });
	}
	return out;
}

export type ListEntry =
	| { type: 'header'; group: FindingGroup; top: number }
	| { type: 'row'; group: FindingGroup; finding: CleanupFinding; top: number; position: number };

export type ListLayout = {
	entries: ListEntry[];
	total: number;
	/** Entry index by finding id. */
	rowIndex: Map<string, number>;
	/** Finding ids in list order (next / previous). */
	order: string[];
	header: number;
	row: number;
};

export function listLayout(
	groups: readonly FindingGroup[],
	collapsed: ReadonlySet<FindingKind>,
	metrics: { header: number; row: number },
): ListLayout {
	const entries: ListEntry[] = [];
	const rowIndex = new Map<string, number>();
	const order: string[] = [];
	let top = 0;
	let position = 0;
	for (const group of groups) {
		entries.push({ type: 'header', group, top });
		top += metrics.header;
		if (collapsed.has(group.kind)) continue;
		for (const finding of group.findings) {
			rowIndex.set(finding.id, entries.length);
			order.push(finding.id);
			entries.push({ type: 'row', group, finding, top, position: position++ });
			top += metrics.row;
		}
	}
	return { entries, total: top, rowIndex, order, ...metrics };
}

/** The entries [start, end) a scroll position shows (with overscan). */
export function visibleEntries(
	layout: ListLayout,
	scrollTop: number,
	viewport: number,
	overscan = 240,
): { start: number; end: number } {
	const from = Math.max(0, scrollTop - overscan);
	const to = scrollTop + Math.max(0, viewport) + overscan;
	let lo = 0;
	let hi = layout.entries.length;
	const height = (e: ListEntry) => (e.type === 'header' ? layout.header : layout.row);
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		const e = layout.entries[mid]!;
		if (e.top + height(e) <= from) lo = mid + 1;
		else hi = mid;
	}
	let end = lo;
	while (end < layout.entries.length && layout.entries[end]!.top < to) end++;
	return { start: lo, end };
}

/** The next / previous finding id in list order (wrapping), from `current` (or the first / last). */
export function stepFinding(order: readonly string[], current: string | null, dir: 1 | -1): string | null {
	if (!order.length) return null;
	const i = current ? order.indexOf(current) : -1;
	if (i < 0) return dir > 0 ? order[0]! : order[order.length - 1]!;
	return order[(i + dir + order.length) % order.length]!;
}

// ---------------------------------------------------------------------------------------------------------------
// Apply and previews

/** The History label of an Apply ("Clean Up Voice: 214 cuts"). */
export function applyLabel(cuts: number): string {
	return cuts === 1 ? t('Clean Up Voice: 1 cut') : t('Clean Up Voice: {0} cuts', cuts);
}

/** The derived timeline of "Play result": the plan applied exactly as Apply would cut it. */
export function resultPreview(
	seq: Sequence,
	analysis: CleanupAnalysis,
): { commands: Command[]; omitted: Array<[number, number]> } | null {
	const plan = analysis.plan;
	if (!plan.ranges.length) return null;
	return {
		commands: [
			{
				type: 'cleanup.apply',
				sequenceId: seq.id,
				clipIds: plan.clipIds,
				ranges: plan.ranges.map((r) => ({ start: r.start, end: r.end })),
				mode: 'extract',
				fadeMs: plan.fadeMs,
				jlFrames: plan.jlFrames,
			} as Command,
		],
		omitted: plan.ranges.map((r) => [r.start, r.end]),
	};
}

/** The derived timeline of "Play removed": everything but the removed ranges cut away. */
export function removedPreview(
	seq: Sequence,
	analysis: CleanupAnalysis,
): { commands: Command[]; omitted: Array<[number, number]>; start: number } | null {
	const plan = analysis.plan;
	if (!plan.ranges.length) return null;
	const end = sequenceDuration(seq);
	const keep: Array<[number, number]> = [];
	let at = 0;
	for (const r of plan.ranges) {
		if (r.start > at) keep.push([at, r.start]);
		at = Math.max(at, r.end);
	}
	if (end > at) keep.push([at, end]);
	if (!keep.length) return null;
	return {
		commands: [
			{
				type: 'cleanup.apply',
				sequenceId: seq.id,
				clipIds: plan.clipIds,
				ranges: keep.map(([start, e]) => ({ start, end: e })),
				mode: 'extract',
				fadeMs: plan.fadeMs,
			} as Command,
		],
		omitted: keep,
		start: plan.ranges[0]!.start,
	};
}

// ---------------------------------------------------------------------------------------------------------------
// Timeline overlay (TC-041): cut ranges, kept pauses and padding during review

export type OverlayBand = { trackId: string | null; start: number; end: number };
export type OverlayBands = { cuts: OverlayBand[]; pauses: OverlayBand[]; padding: OverlayBand[] };

/** A kept non-speech run inside a piece at least this long is drawn as a kept pause (s). */
export const KEPT_PAUSE_MIN_S = 0.1;

/**
 * The bands the timeline draws: every removed range (all tracks), and per kept piece of a speech clip its leading /
 * trailing non-speech (padding) and the non-speech runs inside it of at least `KEPT_PAUSE_MIN_S` (kept pauses), from
 * the voice analysis of its media (none without one).
 */
export function overlayBands(
	seq: Sequence,
	analysis: CleanupAnalysis,
	voiceOf: (mediaId: string, stream: number) => CleanupVoice | null,
): OverlayBands {
	const cuts: OverlayBand[] = analysis.plan.ranges.map((r) => ({
		trackId: null,
		start: r.start,
		end: r.end,
	}));
	const pauses: OverlayBand[] = [];
	const padding: OverlayBand[] = [];
	const F = flicksPerFrame(seq.settings.frameRate);
	const minRun = Math.max(1, Math.round(KEPT_PAUSE_MIN_S * 100));
	for (const k of analysis.plan.kept) {
		const c = seq.clips[k.clipId];
		if (c?.kind !== 'audio') continue;
		const voice = voiceOf(c.mediaId, c.channels.streamIndex);
		if (!voice || voice.frameCount === 0) continue;
		// 10 ms voice frames of the piece
		const vf = (frame: number) => (c.sourceIn + (frame - c.start) * F) / FLICKS_PER_SECOND / 0.01;
		const a = Math.max(0, Math.floor(vf(k.start)));
		const b = Math.min(voice.frameCount, Math.ceil(vf(k.end)));
		if (b <= a) continue;
		const toSeq = (v: number) => c.start + (v * 0.01 * FLICKS_PER_SECOND - c.sourceIn) / F;
		let first = -1;
		let last = -1;
		for (let i = a; i < b; i++)
			if (voice.classes[i] === 2) {
				if (first < 0) first = i;
				last = i;
			}
		if (first < 0) {
			padding.push({ trackId: c.trackId, start: k.start, end: k.end });
			continue;
		}
		if (first > a) padding.push({ trackId: c.trackId, start: k.start, end: Math.min(k.end, toSeq(first)) });
		if (last + 1 < b)
			padding.push({ trackId: c.trackId, start: Math.max(k.start, toSeq(last + 1)), end: k.end });
		let run = -1;
		for (let i = first; i <= last + 1; i++) {
			const speech = i > last || voice.classes[i] === 2;
			if (!speech && run < 0) run = i;
			else if (speech && run >= 0) {
				if (i - run >= minRun) pauses.push({ trackId: c.trackId, start: toSeq(run), end: toSeq(i) });
				run = -1;
			}
		}
	}
	return { cuts, pauses, padding };
}

// ---------------------------------------------------------------------------------------------------------------
// Words

/** The localised explanation of a finding (its reason key + params, TC-010). */
export function reasonText(f: CleanupFinding): string {
	const p = f.reason.params;
	const text = String(p.text ?? '');
	const s = typeof p.seconds === 'number' ? p.seconds.toFixed(2) : String(p.seconds ?? '');
	switch (f.kind) {
		case 'pause':
			return t('Pause of {0} s', s);
		case 'breath':
			return t('Breath of {0} s', s);
		case 'untranscribed':
			return t('Voice without words ({0} s): a dropped filler, a laugh or a mumble', s);
		case 'filler-vocalic':
			return t('Filler “{0}”', text);
		case 'filler-phrase':
			return t('Filler phrase “{0}” between pauses', text);
		case 'filler-lexical':
			return t('Discourse marker “{0}” at the start of a clause', text);
		case 'restart':
			return t('Restart: “{0}” is said again right after', text);
		case 'false-start':
			return t('False start “{0}”', text);
		case 'retake':
			return p.kept !== undefined
				? p.line !== undefined
					? t(
							'Earlier take “{0}” of script line {1} ({2} takes; keeping “{3}”)',
							text,
							p.line,
							p.takes,
							p.kept,
						)
					: t('Earlier take “{0}” ({1} takes; keeping “{2}”)', text, p.takes, p.kept)
				: t('Earlier take “{0}”', text);
		case 'hidden-retake':
			return p.kept !== undefined
				? t('Hidden retake “{0}”, said again as “{1}” (found by decoding this part again)', text, p.kept)
				: t('Hidden retake “{0}” (found by decoding this part again)', text);
		case 'stutter':
			return t('Repeat “{0}”', text);
		case 'off-script':
			return t('Not in the script: “{0}”', text);
		case 'head-tail':
			return t('Before the first or after the last scripted line: “{0}”', text);
		case 'asr-suspect':
			return t('The transcription may be wrong here: “{0}”', text);
		case 'hallucination':
			return t('Likely invented by speech to text: “{0}”', text);
	}
}

/** Seconds as "m:ss.s" (review rows and statistics). */
export function clockText(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return '0:00.0';
	const m = Math.floor(seconds / 60);
	const s = seconds - m * 60;
	return `${m}:${s < 10 ? '0' : ''}${s.toFixed(1)}`;
}

/** The scope of an analysis from the UI choice: the sequence, its In / Out, or the selected clips. */
export function scopeOf(
	seq: Pick<Sequence, 'inPoint' | 'outPoint'>,
	choice: 'sequence' | 'inout' | 'clips',
	selectedClipIds: readonly string[],
): { ok: true; scope: CleanupScope } | { ok: false; reason: string } {
	if (choice === 'sequence') return { ok: true, scope: {} };
	if (choice === 'inout') {
		if (seq.inPoint === null || seq.outPoint === null || seq.outPoint <= seq.inPoint)
			return { ok: false, reason: t('Mark an In and an Out point first') };
		return { ok: true, scope: { range: { from: seq.inPoint, to: seq.outPoint } } };
	}
	if (!selectedClipIds.length) return { ok: false, reason: t('Select clips in the Timeline first') };
	return { ok: true, scope: { clipIds: [...selectedClipIds] } };
}

/**
 * Whether the parts of the document an analysis depends on changed (clips, tracks, links, groups, frame rate,
 * transcripts, media): then the review is stale. Settings, script, lists and rejections (`Sequence.cleanup`) are not
 * among them — the review re-plans with them.
 */
export function analysisInputsChanged(
	a: Pick<ProjectDocument, 'transcripts' | 'media' | 'sequences'>,
	b: Pick<ProjectDocument, 'transcripts' | 'media' | 'sequences'>,
	sequenceId: string,
): boolean {
	if (a === b) return false;
	if (a.transcripts !== b.transcripts || a.media !== b.media) return true;
	const x = a.sequences[sequenceId];
	const y = b.sequences[sequenceId];
	if (!x || !y) return true;
	if (x === y) return false;
	return (
		x.clips !== y.clips ||
		x.audioTracks !== y.audioTracks ||
		x.videoTracks !== y.videoTracks ||
		x.links !== y.links ||
		x.groups !== y.groups ||
		x.settings !== y.settings
	);
}
