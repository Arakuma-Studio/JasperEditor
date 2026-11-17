// Offline media for Link Media (docs/wp-notes/link-media.md §5): which media are offline, whether the edit uses them
// (only used ones open the dialog when a project opens; unused ones get the Project panel's quiet badge), and which
// were re-rendered in place ("changed": their file is still at the recorded path with another size or mtime).
import { type MediaAsset, mediaUsage, type ProjectDocument, projectLookMediaIds } from '@jasper/project';
import type { EditorSession } from '@jasper/session';

/** Media that is offline: an imported placeholder (no file yet) or a file the engine cannot find. */
export function offlineMedia(session: EditorSession): MediaAsset[] {
	const st = session.getState();
	const doc = session.getCommitted();
	return (Object.values(doc.media) as MediaAsset[]).filter(
		(m) =>
			(m.kind === 'video' || m.kind === 'audio' || m.kind === 'image' || m.kind === 'animated-image') &&
			(m.fingerprint.startsWith('pending:interchange:') || st.media[m.id]?.availability === 'offline'),
	);
}

/**
 * Media the edit uses: the source of a clip in any sequence (nested and multicam source sequences are sequences of
 * the document too), media a clip's template or effect parameters show, and media of project looks.
 */
export function usedMediaIds(doc: ProjectDocument): Set<string> {
	const used = new Set(Object.keys(mediaUsage(doc)));
	for (const id of projectLookMediaIds(doc)) used.add(id);
	return used;
}

/** Offline media split by use, with the ones whose file changed in place. */
export function offlineSummary(session: EditorSession): {
	used: MediaAsset[];
	unused: MediaAsset[];
	changed: MediaAsset[];
} {
	const all = offlineMedia(session);
	if (!all.length) return { used: [], unused: [], changed: [] };
	const usedIds = usedMediaIds(session.getCommitted());
	const media = session.getState().media;
	return {
		used: all.filter((m) => usedIds.has(m.id)),
		unused: all.filter((m) => !usedIds.has(m.id)),
		changed: all.filter((m) => media[m.id]?.offlineReason === 'changed'),
	};
}
