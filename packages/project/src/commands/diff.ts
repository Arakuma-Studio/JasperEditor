// Entity-level diff between two document versions, cheap thanks to structural sharing (Immer).
import type { ProjectDocument } from '../schema/document.ts';
import type { Sequence } from '../schema/sequence.ts';
import { keyDiff } from './draft-read.ts';

export type DocDiff = { created: string[]; changed: string[]; deleted: string[] };

function diffRecord(a: Record<string, unknown>, b: Record<string, unknown>, out: DocDiff): void {
	if (a === b) return;
	for (const [id, v] of Object.entries(b)) {
		const prev = a[id];
		if (prev === undefined) out.created.push(id);
		else if (prev !== v) out.changed.push(id);
	}
	for (const id of Object.keys(a)) if (!(id in b)) out.deleted.push(id);
}

function diffList(a: readonly { id: string }[], b: readonly { id: string }[], out: DocDiff): void {
	if (a === b) return;
	diffRecord(Object.fromEntries(a.map((x) => [x.id, x])), Object.fromEntries(b.map((x) => [x.id, x])), out);
}

function seqOwnChanged(a: Sequence, b: Sequence): boolean {
	const ids = (s: Sequence) =>
		[...s.videoTracks, ...s.audioTracks, ...s.captionTracks].map((t) => t.id).join(',');
	return (
		a.settings !== b.settings ||
		a.master !== b.master ||
		a.inPoint !== b.inPoint ||
		a.outPoint !== b.outPoint ||
		a.workArea !== b.workArea ||
		ids(a) !== ids(b)
	);
}

/**
 * Created/changed/deleted entity ids. Sequences count as changed only when their own fields change
 * (settings, master, In/Out, work area, track order); clips, tracks, markers, transitions, link and
 * clip groups are reported individually. The project id stands for name/settings/bin-order changes.
 */
export function diffDocuments(before: ProjectDocument, after: ProjectDocument): DocDiff {
	const out: DocDiff = { created: [], changed: [], deleted: [] };
	if (before === after) return out;
	if (
		before.name !== after.name ||
		before.settings !== after.settings ||
		before.rootItems !== after.rootItems ||
		before.extensions !== after.extensions
	) {
		out.changed.push(after.projectId);
	}
	diffRecord(before.items, after.items, out);
	diffRecord(before.media, after.media, out);
	diffRecord(before.synthetics, after.synthetics, out);
	diffRecord(before.transcripts, after.transcripts, out);
	diffRecord(before.fonts, after.fonts, out);
	if (before.sequences !== after.sequences) {
		for (const [id, seq] of Object.entries(after.sequences)) {
			const prev = before.sequences[id];
			if (!prev) {
				out.created.push(id, ...Object.keys(seq.clips));
				continue;
			}
			if (prev === seq) continue;
			if (seqOwnChanged(prev, seq)) out.changed.push(id);
			if (prev.clips !== seq.clips) {
				const d = keyDiff(prev.clips, seq.clips);
				for (const id of d.changed) (prev.clips[id] === undefined ? out.created : out.changed).push(id);
				out.deleted.push(...d.deleted);
			}
			diffRecord(prev.transitions, seq.transitions, out);
			diffRecord(prev.links, seq.links, out);
			diffRecord(prev.groups, seq.groups, out);
			diffList(prev.markers, seq.markers, out);
			diffList(
				[...prev.videoTracks, ...prev.audioTracks, ...prev.captionTracks],
				[...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks],
				out,
			);
		}
		for (const id of Object.keys(before.sequences)) {
			if (!after.sequences[id]) {
				out.deleted.push(id);
				out.deleted.push(...Object.keys(before.sequences[id]!.clips));
			}
		}
	}
	return out;
}
