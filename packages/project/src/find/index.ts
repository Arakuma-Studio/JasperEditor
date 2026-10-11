// Edit ▸ Find… (docs/wp-notes/gaps.md §UI-5): Premiere's Find dialog over the Project panel (items)
// and a sequence (clips and markers). Two criteria rows (column, operator, text) combined with Match All / Any and
// Match Case, as Premiere's Project panel Find; the timeline variant searches clip names, source names, text clip
// content and marker names / comments. Pure: the web dialog, the Find Next stepping and the MCP `find` tool use it.
import type { ProjectDocument, ProjectItem } from '../schema/document.ts';
import type { Clip, Sequence } from '../schema/sequence.ts';
import { flicksPerFrame } from '../time.ts';

export const FIND_OPERATORS = ['contains', 'matches', 'begins', 'ends', 'notContains'] as const;
export type FindOperator = (typeof FIND_OPERATORS)[number];
export const FIND_OPERATOR_LABELS: Record<FindOperator, string> = {
	contains: 'Contains',
	matches: 'Matches Exactly',
	begins: 'Begins With',
	ends: 'Ends With',
	notContains: 'Does Not Contain',
};

/** Project panel columns Find can search (Premiere: Name, Label, Media Type, File Path, Video Info…). */
export const PROJECT_FIND_FIELDS = ['name', 'label', 'type', 'path', 'codec', 'frameSize', 'any'] as const;
export type ProjectFindField = (typeof PROJECT_FIND_FIELDS)[number];
export const PROJECT_FIND_FIELD_LABELS: Record<ProjectFindField, string> = {
	name: 'Name',
	label: 'Label',
	type: 'Media Type',
	path: 'File Path',
	codec: 'Video Codec',
	frameSize: 'Frame Size',
	any: 'Any Column',
};

/** Timeline fields (Premiere's Find in a sequence: clip names, marker names and comments). */
export const TIMELINE_FIND_FIELDS = ['clipName', 'sourceName', 'text', 'marker', 'any'] as const;
export type TimelineFindField = (typeof TIMELINE_FIND_FIELDS)[number];
export const TIMELINE_FIND_FIELD_LABELS: Record<TimelineFindField, string> = {
	clipName: 'Clip Name',
	sourceName: 'Source Name',
	text: 'Text Content',
	marker: 'Marker Name / Comment',
	any: 'Any Field',
};

export type FindCriterion<F extends string> = { field: F; operator: FindOperator; value: string };
export type FindQuery<F extends string> = {
	criteria: FindCriterion<F>[];
	/** `all` = every criterion matches (AND), `any` = one does (OR). Criteria with an empty value are ignored. */
	match?: 'all' | 'any';
	matchCase?: boolean;
};

const MAX_TEXT = 10_000;

/** Whether `text` satisfies one operator (`value` already non-empty). */
export function matchesOperator(text: string, op: FindOperator, value: string, matchCase = false): boolean {
	const a = (matchCase ? text : text.toLowerCase()).slice(0, MAX_TEXT);
	const b = matchCase ? value : value.toLowerCase();
	switch (op) {
		case 'contains':
			return a.includes(b);
		case 'matches':
			return a === b;
		case 'begins':
			return a.startsWith(b);
		case 'ends':
			return a.endsWith(b);
		case 'notContains':
			return !a.includes(b);
		default:
			return false;
	}
}

/** Combines criteria over the candidate texts of each field. `notContains` holds when no text of the field contains it. */
function evaluate<F extends string>(query: FindQuery<F>, textsOf: (field: F) => string[]): boolean {
	const active = query.criteria.filter((c) => typeof c.value === 'string' && c.value.length > 0);
	if (!active.length) return false;
	const test = (c: FindCriterion<F>) => {
		const texts = textsOf(c.field).filter((t) => typeof t === 'string');
		if (c.operator === 'notContains')
			return texts.every((t) => matchesOperator(t, 'notContains', c.value, query.matchCase));
		return texts.some((t) => matchesOperator(t, c.operator, c.value, query.matchCase));
	};
	return query.match === 'any' ? active.some(test) : active.every(test);
}

function itemTexts(doc: ProjectDocument, it: ProjectItem, field: ProjectFindField): string[] {
	const media = 'mediaId' in it && typeof it.mediaId === 'string' ? doc.media[it.mediaId] : undefined;
	const vs = media?.probe.streams.find((s) => s.type === 'video');
	switch (field) {
		case 'name':
			return [it.name];
		case 'label':
			return [it.label];
		case 'type':
			return [it.kind === 'media' ? (media?.kind ?? 'media') : it.kind];
		case 'path':
			return (media?.locators ?? []).flatMap((l) =>
				l.type === 'path' ? [l.path] : l.type === 'url' ? [l.url] : [],
			);
		case 'codec':
			return vs?.type === 'video' ? [vs.codec] : [];
		case 'frameSize':
			return vs?.type === 'video' ? [`${vs.width}x${vs.height}`, `${vs.width} x ${vs.height}`] : [];
		default:
			return (['name', 'label', 'type', 'path', 'codec', 'frameSize'] as const).flatMap((f) =>
				itemTexts(doc, it, f),
			);
	}
}

/** Project items matching the query, in the Project panel's tree order (bins depth-first). */
export function findProjectItems(doc: ProjectDocument, query: FindQuery<ProjectFindField>): string[] {
	const out: string[] = [];
	const seen = new Set<string>();
	const walk = (ids: readonly string[], depth: number) => {
		if (depth > 64) return;
		for (const id of ids) {
			if (seen.has(id)) continue;
			seen.add(id);
			const it = doc.items[id];
			if (!it) continue;
			if (evaluate(query, (f) => itemTexts(doc, it, f))) out.push(id);
			if (it.kind === 'bin') walk(it.children, depth + 1);
		}
	};
	walk(doc.rootItems, 0);
	// Items not reachable from the root (repair leftovers) still count.
	for (const id of Object.keys(doc.items)) if (!seen.has(id)) walk([id], 0);
	return out;
}

export type TimelineFindHit =
	| { kind: 'clip'; clipId: string; trackId: string; frame: number }
	| { kind: 'marker'; markerId: string; frame: number; clipId?: string };

function sourceNameOf(doc: ProjectDocument, clip: Clip): string[] {
	const c = clip as Clip & { mediaId?: string; sequenceId?: string };
	if (typeof c.mediaId === 'string') {
		const m = doc.media[c.mediaId];
		const item = Object.values(doc.items).find((i) => i.kind === 'media' && i.mediaId === c.mediaId);
		return [item?.name, m?.originalName].filter((x): x is string => typeof x === 'string');
	}
	if (typeof c.sequenceId === 'string') {
		const item = Object.values(doc.items).find((i) => i.kind === 'sequence' && i.sequenceId === c.sequenceId);
		return item ? [item.name] : [];
	}
	return [];
}

function clipTexts(doc: ProjectDocument, clip: Clip, field: TimelineFindField): string[] {
	switch (field) {
		case 'clipName':
			return [clip.name];
		case 'sourceName':
			return sourceNameOf(doc, clip);
		case 'text':
			return clip.kind === 'text' ? [(clip as { content: { text: string } }).content.text] : [];
		case 'marker':
			return (clip.markers ?? []).flatMap((m) => [m.name, m.comment]);
		default:
			return (['clipName', 'sourceName', 'text', 'marker'] as const).flatMap((f) => clipTexts(doc, clip, f));
	}
}

/** Sequence frame showing a clip's content time `flicks` (the inverse of `contentTimeAt`), clamped into the clip. */
function clipFlicksToFrame(seq: Sequence, clip: Clip, flicks: number): number {
	const F = flicksPerFrame(seq.settings.frameRate);
	const rate = clip.speed?.rate > 0 ? clip.speed.rate : 1;
	const i = Math.round((flicks - clip.sourceIn) / (F * rate));
	const offset = clip.speed?.reverse ? clip.duration - 1 - i : i;
	return Math.max(clip.start, Math.min(clip.start + clip.duration - 1, clip.start + offset));
}

/**
 * Clips and markers of a sequence matching the query, sorted by frame then track order (video top-down, then audio,
 * then captions). Sequence markers match `marker` / `any` criteria by name and comment.
 */
export function findTimelineHits(
	doc: ProjectDocument,
	sequenceId: string,
	query: FindQuery<TimelineFindField>,
): TimelineFindHit[] {
	const seq = doc.sequences[sequenceId];
	if (!seq) return [];
	const trackOrder = [...seq.videoTracks].reverse().concat(seq.audioTracks, seq.captionTracks);
	const rank = new Map(trackOrder.map((t, i) => [t.id, i]));
	const hits: (TimelineFindHit & { rank: number })[] = [];
	for (const clip of Object.values(seq.clips)) {
		if (evaluate(query, (f) => clipTexts(doc, clip, f)))
			hits.push({
				kind: 'clip',
				clipId: clip.id,
				trackId: clip.trackId,
				frame: clip.start,
				rank: rank.get(clip.trackId) ?? 999,
			});
		const markerOnly = query.criteria.every((c) => c.field === 'marker' || !c.value);
		if (markerOnly)
			for (const m of clip.markers ?? [])
				if (evaluate(query, () => [m.name, m.comment]))
					hits.push({
						kind: 'marker',
						markerId: m.id,
						clipId: clip.id,
						frame: clipFlicksToFrame(seq, clip, m.flicks),
						rank: rank.get(clip.trackId) ?? 999,
					});
	}
	const markerFields = query.criteria.every((c) => !c.value || c.field === 'marker' || c.field === 'any');
	if (markerFields)
		for (const m of seq.markers)
			if (evaluate(query, () => [m.name, m.comment]))
				hits.push({ kind: 'marker', markerId: m.id, frame: m.frame, rank: -1 });
	hits.sort((a, b) => a.frame - b.frame || a.rank - b.rank);
	return hits.map(({ rank: _r, ...h }) => h as TimelineFindHit);
}

/** The first hit strictly after `afterFrame` (wrapping to the first); `afterKey` skips past the current hit at the same frame. */
export function nextFindHit(
	hits: readonly TimelineFindHit[],
	afterFrame: number,
	currentKey?: string | null,
): TimelineFindHit | null {
	if (!hits.length) return null;
	const key = (h: TimelineFindHit) => (h.kind === 'clip' ? `c:${h.clipId}` : `m:${h.markerId}`);
	const cur = currentKey ? hits.findIndex((h) => key(h) === currentKey) : -1;
	if (cur >= 0) return hits[(cur + 1) % hits.length] ?? null;
	return hits.find((h) => h.frame >= afterFrame) ?? hits[0] ?? null;
}

export function findHitKey(h: TimelineFindHit): string {
	return h.kind === 'clip' ? `c:${h.clipId}` : `m:${h.markerId}`;
}
