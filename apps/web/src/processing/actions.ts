// Entry points of Process Clip… (timeline clip menu, Project item menu, Clip menu, palette, Media Version
// section) and the version switch (`clip.replaceSource`, one undo entry).
import type { Command, MediaAsset, ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { openDialog } from '@jasper/ui';
import { originalOf } from './model.ts';
import { PROCESS_DIALOG, type ProcessDialogProps } from './ProcessDialog.tsx';

type VideoClipLike = { id: string; kind: string; mediaId?: string };

function findClip(doc: ProjectDocument, clipId: string): VideoClipLike | undefined {
	for (const seq of Object.values(doc.sequences)) {
		const c = seq.clips[clipId] as VideoClipLike | undefined;
		if (c) return c;
	}
	return undefined;
}

/** The media and clips a clip selection processes: video clips sharing the first video clip's media. */
export function targetsForClips(
	doc: ProjectDocument,
	clipIds: readonly string[],
): { mediaId: string; clipIds: string[] } | null {
	const video = clipIds
		.map((id) => findClip(doc, id))
		.filter((c): c is VideoClipLike & { mediaId: string } => c?.kind === 'video' && !!c.mediaId);
	const first = video[0];
	if (!first) return null;
	const m = doc.media[first.mediaId] as MediaAsset | undefined;
	if (m?.kind !== 'video') return null;
	return {
		mediaId: first.mediaId,
		clipIds: video.filter((c) => c.mediaId === first.mediaId).map((c) => c.id),
	};
}

/** Every video clip (any sequence) that uses `mediaId`. */
function clipsUsingMedia(doc: ProjectDocument, mediaId: string): string[] {
	const out: string[] = [];
	for (const seq of Object.values(doc.sequences))
		for (const c of Object.values(seq.clips) as VideoClipLike[])
			if (c.kind === 'video' && c.mediaId === mediaId) out.push(c.id);
	return out;
}

export function openProcessForClips(session: EditorSession, clipIds: readonly string[]): boolean {
	const t = targetsForClips(session.getCommitted(), clipIds);
	if (!t) return false;
	void openDialog(PROCESS_DIALOG, {
		session,
		mediaId: t.mediaId,
		clipIds: t.clipIds,
		replaceDefault: true,
		origin: 'clip',
	} satisfies ProcessDialogProps);
	return true;
}

export function openProcessForMedia(session: EditorSession, mediaId: string): boolean {
	const doc = session.getCommitted();
	const m = doc.media[mediaId] as MediaAsset | undefined;
	if (m?.kind !== 'video') return false;
	void openDialog(PROCESS_DIALOG, {
		session,
		mediaId,
		clipIds: clipsUsingMedia(doc, mediaId),
		replaceDefault: false,
		origin: 'project',
	} satisfies ProcessDialogProps);
	return true;
}

/** Switches clips to another version of their original (one transaction of `clip.replaceSource`). */
export function switchMediaVersion(
	session: EditorSession,
	clipIds: readonly string[],
	mediaId: string,
): { ok: true; changed: number } | { ok: false; message: string } {
	const doc = session.getCommitted();
	const target = originalOf(doc, mediaId);
	const commands: Command[] = [];
	for (const id of clipIds) {
		const c = findClip(doc, id);
		if (c?.kind !== 'video' || !c.mediaId || c.mediaId === mediaId) continue;
		if (originalOf(doc, c.mediaId) !== target) continue;
		commands.push({ type: 'clip.replaceSource', clipId: id, mediaId } as unknown as Command);
	}
	if (!commands.length) return { ok: true, changed: 0 };
	const m = doc.media[mediaId] as MediaAsset | undefined;
	const label = m?.derivation ? 'Use Processed Version' : 'Use Original Version';
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok) return { ok: false, message: r.errors[0]?.message ?? `${label} failed` };
	return { ok: true, changed: commands.length };
}
