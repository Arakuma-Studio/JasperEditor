// source patching (Premiere "Source patching and track targeting", helpx.adobe.com). Insert and Overwrite
// from the Source monitor place each source track (V1, A1, A2…) on the sequence track it is patched to; a source
// track patched off is left out. Track targeting (the track name toggles) is separate: it drives paste, Match Frame,
// Add Edit and edit-point navigation, not source edits.
//
// Stored per sequence in the session view (`SequenceViewState.sourcePatching`): source label → destination track
// id, or null = off. A label with no entry is patched to the sequence track with the same label (V1 → V1, A2 → A2),
// which is Premiere's default.
import { type ProjectDocument, type ProjectItem, type Sequence, syntheticSound } from '@jasper/project';
import type { EditorSession, SequenceViewState } from '@jasper/session';

type SourceTracks = { video: number; audio: number };
type ResolvedPatch = {
	/** Per source video track: destination track id (or a label for a track to create), null = off. */
	video: (string | null)[];
	audio: (string | null)[];
};

/** Source tracks of a project item as Insert/Overwrite would place them. */
export function sourceTracksOf(doc: ProjectDocument, item: ProjectItem | null, asNests = true): SourceTracks {
	if (!item) return { video: 0, audio: 0 };
	if (item.kind === 'media' || item.kind === 'subclip') {
		const asset = doc.media[item.mediaId];
		if (!asset) return { video: 0, audio: 0 };
		const hasVideo =
			asset.kind === 'image' ||
			asset.kind === 'animated-image' ||
			(asset.kind === 'video' && asset.probe.streams.some((s) => s.type === 'video'));
		const hasAudio =
			(asset.kind === 'video' || asset.kind === 'audio') &&
			asset.probe.streams.some((s) => s.type === 'audio');
		return { video: hasVideo ? 1 : 0, audio: hasAudio ? 1 : 0 };
	}
	if (item.kind === 'synthetic') {
		const syn = doc.synthetics[item.syntheticId];
		return { video: syn ? 1 : 0, audio: syntheticSound(syn) ? 1 : 0 };
	}
	if (item.kind === 'sequence') {
		const seq = doc.sequences[item.sequenceId];
		if (!seq) return { video: 0, audio: 0 };
		const used = (tracks: Sequence['videoTracks']) =>
			tracks.filter((t) => Object.values(seq.clips).some((c) => c.trackId === t.id)).length;
		if (asNests)
			return { video: used(seq.videoTracks) > 0 ? 1 : 0, audio: used(seq.audioTracks) > 0 ? 1 : 0 };
		return { video: seq.videoTracks.length, audio: seq.audioTracks.length };
	}
	return { video: 0, audio: 0 };
}

export const sourceLabel = (kind: 'video' | 'audio', index: number) =>
	`${kind === 'video' ? 'V' : 'A'}${index + 1}`;

/** Destination of every source track of `counts` in `seq` under `view`'s patching. */
export function resolvePatch(
	seq: Sequence,
	view: SequenceViewState | undefined,
	counts: SourceTracks,
): ResolvedPatch {
	const patch = view?.sourcePatching ?? {};
	const exists = (id: string) => [...seq.videoTracks, ...seq.audioTracks].some((t) => t.id === id);
	const one = (kind: 'video' | 'audio', i: number): string | null => {
		const label = sourceLabel(kind, i);
		if (label in patch) {
			const v = patch[label];
			if (v === null || v === undefined) return null;
			if (exists(v)) return v;
		}
		const list = kind === 'video' ? seq.videoTracks : seq.audioTracks;
		return list[i]?.id ?? label;
	};
	return {
		video: Array.from({ length: counts.video }, (_, i) => one('video', i)),
		audio: Array.from({ length: counts.audio }, (_, i) => one('audio', i)),
	};
}

/** Source label patched to `trackId`, if any (for the track header's source patch column). */
export function patchedLabelOn(
	seq: Sequence,
	view: SequenceViewState | undefined,
	counts: SourceTracks,
	trackId: string,
): { label: string; on: boolean } | null {
	const kind = seq.videoTracks.some((t) => t.id === trackId) ? 'video' : 'audio';
	const r = resolvePatch(seq, view, counts);
	const list = kind === 'video' ? r.video : r.audio;
	const i = list.indexOf(trackId);
	if (i >= 0) return { label: sourceLabel(kind, i), on: true };
	// A source track switched off keeps showing (dimmed) on the track it would default to.
	const patch = view?.sourcePatching ?? {};
	const tracks = kind === 'video' ? seq.videoTracks : seq.audioTracks;
	for (let j = 0; j < list.length; j++) {
		const label = sourceLabel(kind, j);
		if (patch[label] === null && tracks[j]?.id === trackId) return { label, on: false };
	}
	return null;
}

/** Patches source `label` to `trackId` (or toggles it off/on when it is already there). */
export function setPatch(
	session: EditorSession,
	sequenceId: string,
	label: string,
	trackId: string | null,
): void {
	const view = session.getState().views[sequenceId];
	session.setView(sequenceId, { sourcePatching: { ...(view?.sourcePatching ?? {}), [label]: trackId } });
}
