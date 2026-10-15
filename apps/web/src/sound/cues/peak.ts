// Peak handle registration (spec 12 §2.7 "Peak handle"): a `clipDecorations` overlay on audio clips whose sound has a
// known peak (clips placed by sound design, and clips of library media). `appliesTo` must be O(1) and cannot see the
// document, so the timeline keeps the set of library media ids of its session here (`useLibraryMediaTracking`) and the
// decoration is re-registered when it changes (the memoised clip views re-evaluate `appliesTo` then).
import type { Clip, MediaAsset } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { useEffect } from 'react';
import { clipDecorations } from '../../extensions/index.ts';
import { PeakHandle } from './PeakHandle.tsx';

let libraryMedia: ReadonlySet<string> = new Set();

const hasLibrary = (m: MediaAsset | undefined) => {
	const lib = (m as { library?: unknown } | undefined)?.library;
	return !!lib && typeof lib === 'object';
};

/** Whether a clip can show a peak handle (cheap: the overlay itself hides when the peak is unknown or off the clip). */
export function peakHandleApplies(clip: Clip, media: ReadonlySet<string> = libraryMedia): boolean {
	if (clip.kind !== 'audio') return false;
	if ((clip as { sfx?: unknown }).sfx) return true;
	const id = (clip as { mediaId?: string }).mediaId;
	return !!id && media.has(id);
}

const decoration = () => ({
	id: 'sound.peakHandle',
	order: 40,
	appliesTo: (c: Clip) => peakHandleApplies(c),
	overlay: PeakHandle,
});
clipDecorations.register(decoration());

function sameSet(a: ReadonlySet<string>, b: ReadonlySet<string>): boolean {
	if (a.size !== b.size) return false;
	for (const x of a) if (!b.has(x)) return false;
	return true;
}

/** Recomputes the library media of a document; re-registers the decoration when the set changed. */
export function trackLibraryMedia(media: Record<string, MediaAsset>): void {
	const next = new Set<string>();
	for (const [id, m] of Object.entries(media)) if (hasLibrary(m)) next.add(id);
	if (sameSet(next, libraryMedia)) return;
	libraryMedia = next;
	clipDecorations.register(decoration());
}

/** Keeps the library media set in step with the session's document (media identity changes only). */
export function useLibraryMediaTracking(session: EditorSession): void {
	useEffect(() => {
		let last: unknown = null;
		const update = () => {
			const media = session.getCommitted().media;
			if (media === last) return;
			last = media;
			trackLibraryMedia(media as Record<string, MediaAsset>);
		};
		update();
		return session.on('doc.changed', update);
	}, [session]);
}
