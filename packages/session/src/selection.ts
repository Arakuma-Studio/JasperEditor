// Selection helpers (S01 §15).
import type { ProjectDocument, Sequence } from '@jasper/project';
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
		for (const seq of Object.values(doc.sequences) as Sequence[]) {
			const c = seq.clips[id];
			if (!c) continue;
			if (linked && c.linkId) for (const m of seq.links[c.linkId]?.members ?? []) out.add(m);
			if (c.groupId) for (const m of seq.groups[c.groupId]?.members ?? []) out.add(m);
		}
	}
	return [...out];
}

function allClipIds(doc: ProjectDocument): Set<string> {
	const s = new Set<string>();
	for (const seq of Object.values(doc.sequences)) for (const id of Object.keys(seq.clips)) s.add(id);
	return s;
}

/** Drops ids that no longer exist (S01:SEL-002). Returns the same object when nothing changed. */
export function filterSelection(sel: Selection, doc: ProjectDocument): Selection {
	const clips = allClipIds(doc);
	const transitions = new Set<string>();
	const markers = new Set<string>();
	const tracks = new Set<string>();
	for (const seq of Object.values(doc.sequences)) {
		for (const id of Object.keys(seq.transitions)) transitions.add(id);
		for (const m of seq.markers) markers.add(m.id);
		for (const t of [...seq.videoTracks, ...seq.audioTracks, ...seq.captionTracks]) tracks.add(t.id);
	}
	const keep = (list: string[], set: Set<string>) =>
		list.every((x) => set.has(x)) ? list : list.filter((x) => set.has(x));
	const tClips = keep(sel.timeline.clips, clips);
	const tTrans = keep(sel.timeline.transitions, transitions);
	const primary =
		sel.timeline.primaryClip && clips.has(sel.timeline.primaryClip) ? sel.timeline.primaryClip : null;
	const items = keep(sel.project.items, new Set(Object.keys(doc.items)));
	const pPrimary = sel.project.primary && doc.items[sel.project.primary] ? sel.project.primary : null;
	const gaps = sel.timeline.gaps.filter((g) => {
		for (const seq of Object.values(doc.sequences)) {
			if (!tracks.has(g.trackId)) continue;
			const occupied = Object.values(seq.clips).some(
				(c) => c.trackId === g.trackId && c.start < g.end && c.start + c.duration > g.start,
			);
			if (!occupied) return true;
		}
		return false;
	});
	const kf =
		sel.keyframes && (clips.has(sel.keyframes.clipOrTrackId) || tracks.has(sel.keyframes.clipOrTrackId))
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
		markers: keep(sel.markers, markers),
		project: { items, primary: pPrimary },
		tracks: keep(sel.tracks, tracks),
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
