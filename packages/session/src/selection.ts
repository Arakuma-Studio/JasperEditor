// Selection helpers (S01 §15).
import type { ProjectDocument } from '@jasper/project';
import type { Selection, SelectMode } from './types.ts';

export function emptySelection(): Selection {
	return {
		timeline: { clips: [], transitions: [], gaps: [], primaryClip: null },
		keyframes: null,
		markers: [],
		project: { items: [], primary: null },
		tracks: [],
	};
}

export function combine(current: readonly string[], ids: readonly string[], mode: SelectMode): string[] {
	switch (mode) {
		case 'replace':
			return [...new Set(ids)];
		case 'add':
			return [...new Set([...current, ...ids])];
		case 'remove':
			return current.filter((x) => !ids.includes(x));
		case 'toggle': {
			const set = new Set(current);
			for (const id of ids) {
				if (set.has(id)) set.delete(id);
				else set.add(id);
			}
			return [...set];
		}
	}
}

/** Link-group and clip-group expansion (S01:SEL-004). Groups always expand; links only when enabled. */
export function expandClipSelection(
	doc: ProjectDocument,
	clipIds: readonly string[],
	linked: boolean,
): string[] {
	const out = new Set<string>();
	for (const id of clipIds) {
		out.add(id);
		for (const seq of Object.values(doc.sequences)) {
			const c = seq.clips[id];
			if (!c) continue;
			if (linked && c.linkId) for (const m of seq.links[c.linkId]?.members ?? []) out.add(m);
			if (c.groupId) for (const m of seq.groups[c.groupId]?.members ?? []) out.add(m);
		}
	}
	return [...out];
}

/** Drops ids that no longer exist (S01:SEL-002). Returns the same object when nothing changed. */
export function filterSelection(sel: Selection, doc: ProjectDocument): Selection {
	// Transactions usually keep a small selection. Probe the selected ids instead of
	// allocating indexes for every entity in the document on every commit/undo.
	const sequences = Object.values(doc.sequences);
	const membership = (kind: 'clips' | 'transitions', selected: number) => {
		// Bulk selections spread across many sequences are cheaper to index once.
		if (sequences.length > 1 && selected > 64) {
			const ids = new Set<string>();
			for (const seq of sequences) for (const id of Object.keys(seq[kind])) ids.add(id);
			return (id: string) => ids.has(id);
		}
		return (id: string) => sequences.some((seq) => Object.hasOwn(seq[kind], id));
	};
	const hasClip = membership('clips', sel.timeline.clips.length);
	const hasTransition = membership('transitions', sel.timeline.transitions.length);
	let markers: Set<string> | undefined;
	const hasMarker = (id: string) => {
		if (!markers) {
			markers = new Set();
			for (const seq of sequences) for (const marker of seq.markers) markers.add(marker.id);
		}
		return markers.has(id);
	};
	let tracks: Set<string> | undefined;
	const hasTrack = (id: string) => {
		if (!tracks) {
			tracks = new Set();
			for (const seq of sequences) {
				for (const track of seq.videoTracks) tracks.add(track.id);
				for (const track of seq.audioTracks) tracks.add(track.id);
				for (const track of seq.captionTracks) tracks.add(track.id);
			}
		}
		return tracks.has(id);
	};
	const keep = (list: string[], exists: (id: string) => boolean) =>
		list.every(exists) ? list : list.filter(exists);
	const tClips = keep(sel.timeline.clips, hasClip);
	const tTrans = keep(sel.timeline.transitions, hasTransition);
	const primary =
		sel.timeline.primaryClip && hasClip(sel.timeline.primaryClip) ? sel.timeline.primaryClip : null;
	const items = keep(sel.project.items, (id) => Object.hasOwn(doc.items, id));
	const pPrimary = sel.project.primary && doc.items[sel.project.primary] ? sel.project.primary : null;
	const gaps = sel.timeline.gaps.filter((g) => {
		for (const seq of sequences) {
			if (!hasTrack(g.trackId)) continue;
			const occupied = Object.values(seq.clips).some(
				(c) => c.trackId === g.trackId && c.start < g.end && c.start + c.duration > g.start,
			);
			if (!occupied) return true;
		}
		return false;
	});
	const kf =
		sel.keyframes && (hasClip(sel.keyframes.clipOrTrackId) || hasTrack(sel.keyframes.clipOrTrackId))
			? sel.keyframes
			: null;
	const next: Selection = {
		timeline: {
			clips: tClips,
			transitions: tTrans,
			gaps: gaps.length === sel.timeline.gaps.length ? sel.timeline.gaps : gaps,
			primaryClip: primary,
		},
		keyframes: kf,
		markers: keep(sel.markers, hasMarker),
		project: { items, primary: pPrimary },
		tracks: keep(sel.tracks, hasTrack),
	};
	const same =
		next.timeline.clips === sel.timeline.clips &&
		next.timeline.transitions === sel.timeline.transitions &&
		next.timeline.gaps === sel.timeline.gaps &&
		next.timeline.primaryClip === sel.timeline.primaryClip &&
		next.keyframes === sel.keyframes &&
		next.markers === sel.markers &&
		next.project.items === sel.project.items &&
		next.project.primary === sel.project.primary &&
		next.tracks === sel.tracks;
	return same ? sel : next;
}
