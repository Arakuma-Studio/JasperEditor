// Entry points of Process Clip… (timeline clip menu, Project item menu, Clip menu, palette, Media Version
// section) and the version switch (`clip.replaceSource`, one undo entry).
import { type Command, type MediaAsset, originalMediaId, type ProjectDocument } from '@jasper/project';
import type { EditorSession } from '@jasper/session';
import { confirmDialog, openDialog } from '@jasper/ui';
import { PROCESS_DIALOG, type ProcessDialogProps } from './ProcessDialog.tsx';
import { REPLACE_FOOTAGE_DIALOG, type ReplaceFootageDialogProps } from './ReplaceFootageDialog.tsx';

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

type SwitchResult =
	| { ok: true; changed: number; trimmed: number }
	| { ok: false; code: string; message: string };

/**
 * Switches clips to another version of their original (one transaction of `clip.replaceSource`): the clips keep
 * showing the same source frames (S07:PRC-016). `fit` decides what happens with clips the version does not
 * cover (S07:PRC-017; default `refuse`).
 */
function switchMediaVersion(
	session: EditorSession,
	clipIds: readonly string[],
	mediaId: string,
	fit: 'refuse' | 'trim' | 'skip' = 'refuse',
): SwitchResult {
	const doc = session.getCommitted();
	const target = originalMediaId(doc, mediaId);
	const commands: Command[] = [];
	for (const id of clipIds) {
		const c = findClip(doc, id);
		if (c?.kind !== 'video' || !c.mediaId || c.mediaId === mediaId) continue;
		if (originalMediaId(doc, c.mediaId) !== target) continue;
		commands.push({
			type: 'clip.replaceSource',
			clipId: id,
			mediaId,
			...(fit !== 'refuse' ? { fit } : {}),
		} as unknown as Command);
	}
	if (!commands.length) return { ok: true, changed: 0, trimmed: 0 };
	const label =
		target === mediaId
			? 'Use Original Version'
			: (doc.media[mediaId] as MediaAsset | undefined)?.derivation
				? 'Use Processed Version'
				: 'Use Media Version';
	const r = session.apply({ label, origin: 'user', commands });
	if (!r.ok)
		return {
			ok: false,
			code: r.errors[0]?.code ?? 'E_INTERNAL',
			message: r.errors[0]?.message ?? `${label} failed`,
		};
	const results = r.results as { changed?: boolean; trimmed?: unknown }[];
	return {
		ok: true,
		changed: results.filter((x) => x?.changed).length,
		trimmed: results.filter((x) => x?.trimmed).length,
	};
}

/**
 * The version switch of the Media Version section and menu: when the version does not hold every frame of the
 * clips, asks whether to trim them to the frames it holds (one undo entry either way).
 */
export async function switchMediaVersionInteractive(
	session: EditorSession,
	clipIds: readonly string[],
	mediaId: string,
	ask: typeof confirmDialog = confirmDialog,
): Promise<SwitchResult | null> {
	const r = switchMediaVersion(session, clipIds, mediaId);
	if (r.ok || r.code !== 'E_OUT_OF_MEDIA') return r;
	const yes = await ask({
		title: 'Trim to the version’s frames?',
		body: `${r.message.replace(/\.? Trim the clip first.*$/, '')}. Trim the clip${clipIds.length > 1 ? 's' : ''} to the frames this version holds? You can undo this.`,
		confirmLabel: 'Trim and Switch',
	});
	if (!yes) return null;
	return switchMediaVersion(session, clipIds, mediaId, 'trim');
}

/**
 * Why Replace Footage… is not available for a media (null = it is): only files (video, audio, images), not
 * processed versions (process again instead), LUTs, fonts or motion-graphics bundles.
 */
export function replaceFootageBlocker(doc: ProjectDocument, mediaId: string): string | null {
	const m = doc.media[mediaId] as MediaAsset | undefined;
	if (!m) return 'Media not found';
	if (m.kind !== 'video' && m.kind !== 'audio' && m.kind !== 'image')
		return 'Only video, audio and image files can be replaced';
	if (m.derivation?.recipe.op === 'process') return 'Processed versions are replaced by processing again';
	return null;
}

export function openReplaceFootage(session: EditorSession, mediaId: string): boolean {
	if (replaceFootageBlocker(session.getCommitted(), mediaId)) return false;
	void openDialog(REPLACE_FOOTAGE_DIALOG, { session, mediaId } satisfies ReplaceFootageDialogProps);
	return true;
}
